import "server-only";
import { inngest } from "../client";
import {
  createJabMcpClient,
  loadJabCredentials,
  getMenus,
  listPostTypes,
  listPostType,
  getPostBySlug,
  getGlobalStyles,
  resolveCptAbilityMeta,
  type PageBySlugRecord,
  type PostListRow,
  type PostTypeRow,
  type Menu,
  type BlockNode,
  type GlobalStylesResponse,
  type CptAbilityMeta,
} from "@/lib/jab/ability-client";
import { extractThemeJsonTokens } from "@/lib/jab/global-styles";
import { buildInventory, type PageBlocksInput } from "@/lib/jab/inventory";
import { aggregateComputedStyles } from "@/lib/jab/aggregate-computed-styles";
import { InProcessRunner, type DiscoveryRunner } from "@/lib/jab/discovery-runner";
import { capturePage } from "@/lib/jab/playwright-discovery";
import {
  ensureSiteScreenshotsBucket,
} from "@/lib/storage/bucket";
import { persistInventory, persistPages } from "@/lib/jab/persist-discovery";
import { selectSeedPages } from "@/lib/jab/seed-pages";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Manifest } from "@jab/core";
import type { PageDescriptor, PageDiscoveryResult } from "@/lib/jab/discovery-types";

/**
 * discoverSite — Phase A worker.
 *
 * Triggered by `site/discover.requested` (Stage 7 will also dispatch from
 * the top-level `site/build.requested` orchestrator; v1 supports direct
 * dispatch for the smoke test in Task 22).
 *
 * Steps (each `step.run` is a separate retry-able + traced boundary):
 *
 *   1. load-creds         — decrypt project WP creds (service-role read)
 *   2. probe-bucket       — idempotent site-screenshots bucket bootstrap
 *   3. load-manifest      — read projects.manifest JSONB for ability-meta
 *                           resolution (already populated by onboarding)
 *   4. enumerate-content  — REST + MCP: menus + post types + per-CPT lists
 *   5. fetch-page-blocks  — per page, jab/get-{singular}-by-slug with
 *                           includeBlocks=true; result is PageBlocksInput[]
 *   6. capture-screenshots — DiscoveryRunner.run() — Playwright pass
 *   7. build-inventory    — pure reducer (no I/O)
 *   8. persist            — block_inventory + page_inventory + site_builds
 *                           counts update
 *   9. warn-design-tokens — fail-soft: dispatch project/design.requested
 *                           if design_tokens is null. Existing
 *                           extractProjectDesign worker handles it.
 *
 * retries: 0 — same rationale as extractProjectDesign. Re-trigger via
 * a fresh `site/discover.requested` is the recovery path.
 *
 * Failure handling: any step throw flips site_builds.status to 'failed'
 * with the error captured in error_text. The next-attempt UI surfaces
 * this so the agency can re-trigger.
 */

export const discoverSite = inngest.createFunction(
  { id: "discover-site", retries: 0 },
  { event: "site/discover.requested" },
  async ({ event, step }) => {
    const { projectId, tenantId, buildId, maxPages } = event.data as {
      projectId: string;
      tenantId: string;
      buildId: string;
      // Optional smoke-only cap on the number of pages we pull blocks for
      // and capture screenshots of. When omitted (production trigger),
      // discovery walks every post returned by every CPT list call. The
      // smoke script passes a small value (e.g. 10) so end-to-end Stage 1
      // verification can complete in 1–2 minutes against real sites with
      // hundreds of posts. See path (2) — proper seed-page selection — for
      // the longer-term fix that replaces this with a representative-page
      // picker.
      maxPages?: number;
    };
    const smokePageCap = Number.isFinite(maxPages) && (maxPages ?? 0) > 0 ? Math.floor(maxPages as number) : 0;

    // Single try/catch wraps everything so we can flip site_builds.failed.
    // step.run() boundaries inside are still independently traced + retry-able
    // (per the function-level retries: 0, no retries actually fire).
    try {
      await step.run("mark-discovering", async () => {
        const supabase = createAdminClient();
        const { error } = await supabase
          .from("site_builds")
          .update({ status: "discovering", started_at: new Date().toISOString() })
          .eq("id", buildId)
          .eq("project_id", projectId);
        if (error) throw new Error(`site_builds → discovering update failed: ${error.message}`);
      });

      const creds = await step.run("load-creds", () => loadJabCredentials(projectId, tenantId));

      await step.run("probe-bucket", () => ensureSiteScreenshotsBucket());

      const manifest = await step.run("load-manifest", async () => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .from("projects")
          .select("manifest")
          .eq("id", projectId)
          .eq("tenant_id", tenantId)
          .single<{ manifest: Manifest | null }>();
        if (error) throw new Error(`load manifest failed: ${error.message}`);
        return data?.manifest ?? null;
      });

      const client = createJabMcpClient(creds);

      // ── Enumerate content ──
      const menus: Menu[] = await step.run("get-menus", () => getMenus(client));
      const postTypes: PostTypeRow[] = await step.run("list-post-types", () =>
        listPostTypes(creds),
      );

      // Per-CPT list calls. step.run named per CPT for trace clarity.
      const perCptLists: Array<{ cpt: PostTypeRow; meta: CptAbilityMeta; rows: PostListRow[] }> = [];
      for (const cpt of postTypes) {
        const meta = resolveCptAbilityMeta(manifest, cpt);
        const rows = await step.run(`list-${cpt.slug}`, () =>
          listPostType(client, {
            abilityName: meta.listAbilityName,
            wrapperKey: meta.listWrapperKey,
            // 100 is the hard input-schema max per the plugin. v1 caps here;
            // sites with >100 entries per CPT lose the tail until we add
            // pagination. Two Roads is <100 across the board.
            numberposts: 100,
            postStatus: "publish",
          }),
        );
        perCptLists.push({ cpt, meta, rows });
      }

      // ── Seed-page selection ──
      // Phase A discovery is a TEMPLATE + block-type inventory job, not a
      // content-harvesting job. One representative post per non-page CPT
      // tells us "this CPT's template uses these block types"; pulling all
      // 88 beers or 100+ events adds no inventory signal and turns Stage 1
      // into a 30–60 minute job. selectSeedPages() keeps every page (each
      // is bespoke unique content) and one sample per other CPT. The
      // smokePageCap below further truncates for test budgets.
      const seedCptLists = selectSeedPages(perCptLists);
      console.log(
        `[discoverSite ${buildId}] seed-page selection: ${perCptLists.reduce((n, p) => n + p.rows.length, 0)} → ${seedCptLists.reduce((n, p) => n + p.rows.length, 0)} pages`,
      );

      // ── Fetch per-page block trees ──
      // SMOKE CAP: when smokePageCap > 0 (e.g. test trigger passed maxPages=10),
      // stop both the outer CPT loop and the inner per-post loop once we've
      // collected enough pages. Bounds the slow sequential by-slug MCP calls
      // AND the downstream Playwright capture phase in a single switch.
      const pageBlocks: Array<PageBlocksInput & { title: string; url: string }> = [];
      capLoop: for (const { cpt, meta, rows } of seedCptLists) {
        for (const row of rows) {
          if (smokePageCap > 0 && pageBlocks.length >= smokePageCap) break capLoop;
          const record: PageBySlugRecord | null = await step.run(
            `blocks-${cpt.slug}-${row.slug}`,
            () =>
              getPostBySlug(client, {
                abilityName: meta.bySlugAbilityName,
                wrapperKey: meta.bySlugWrapperKey,
                slug: row.slug,
                includeBlocks: true,
              }),
          );
          if (!record) continue;
          pageBlocks.push({
            slug: row.slug,
            post_type: cpt.slug,
            title: row.title ?? "",
            url: row.link,
            blocks: (record.blocks ?? []) as BlockNode[],
          });
        }
      }
      if (smokePageCap > 0) {
        console.log(
          `[discoverSite ${buildId}] smoke cap active: maxPages=${smokePageCap}, collected=${pageBlocks.length}`,
        );
      }

      // ── Capture screenshots + computed CSS ──
      const runner: DiscoveryRunner = new InProcessRunner((job) =>
        capturePage({
          page: job.pages[0],
          buildId: job.buildId,
          projectId: job.projectId,
          tenantId: job.tenantId,
        }),
      );
      const discoveryResults = await step.run("capture-screenshots", async () => {
        const pageDescriptors: PageDescriptor[] = pageBlocks.map((p) => ({
          slug: p.slug,
          post_type: p.post_type,
          url: p.url,
          topLevelBlockNames: p.blocks.map((b) => b.blockName),
        }));
        return runner.run({ buildId, projectId, tenantId, pages: pageDescriptors });
      });

      // ── Build inventory (pure) ──
      const inventoryInput: PageBlocksInput[] = pageBlocks.map((p) => ({
        slug: p.slug,
        post_type: p.post_type,
        blocks: p.blocks,
      }));
      const inventory = await step.run("build-inventory", async () =>
        buildInventory(inventoryInput),
      );
      const computedStylesByBlockName = await step.run("aggregate-computed-styles", async () =>
        aggregateComputedStyles(discoveryResults),
      );

      // ── Optional: global styles ──
      await step.run("fetch-global-styles", async () => {
        let payload: GlobalStylesResponse | null;
        try {
          payload = await getGlobalStyles(creds);
        } catch (err) {
          console.warn(
            `[discoverSite ${buildId}] global-styles fetch failed (continuing):`,
            err,
          );
          return null;
        }
        const tokens = extractThemeJsonTokens(payload);
        if (!tokens) return null;
        // Persist alongside design_tokens on the project row. Phase B
        // reads from here for tailwind.config emit. Doesn't overwrite
        // existing design_tokens — merges under a `themeJson` key.
        const supabase = createAdminClient();
        const { data: row } = await supabase
          .from("projects")
          .select("design_tokens")
          .eq("id", projectId)
          .eq("tenant_id", tenantId)
          .single<{ design_tokens: Record<string, unknown> | null }>();
        const next = { ...(row?.design_tokens ?? {}), themeJson: tokens };
        await supabase
          .from("projects")
          .update({ design_tokens: next })
          .eq("id", projectId)
          .eq("tenant_id", tenantId);
        return null;
      });

      // ── Persist ──
      await step.run("persist-inventory", () =>
        persistInventory({
          buildId,
          projectId,
          entries: inventory,
          computedStylesByBlockName,
        }),
      );
      await step.run("persist-pages", () =>
        persistPages({
          buildId,
          projectId,
          pages: pageBlocks.map((p) => {
            const discovery = discoveryResults.find((d) => d.slug === p.slug && d.post_type === p.post_type) ?? {
              slug: p.slug,
              post_type: p.post_type,
              screenshotPaths: {},
              blockCapturesByViewport: {},
            };
            return {
              slug: p.slug,
              post_type: p.post_type,
              title: p.title,
              route_path: routePathFor(p.post_type, p.slug),
              block_count: p.blocks.length,
              discovery,
            };
          }),
        }),
      );

      // ── Update site_builds with counts + flip to next phase state ──
      await step.run("finalize-counts", async () => {
        const supabase = createAdminClient();
        const { error } = await supabase
          .from("site_builds")
          .update({
            page_count: pageBlocks.length,
            block_type_count: inventory.length,
            // Status stays 'discovering' — Stage 7's orchestrator will
            // flip to 'components' when Phase B starts. v1 standalone
            // smoke leaves it at 'discovering' for clarity that the next
            // phase hasn't run.
          })
          .eq("id", buildId)
          .eq("project_id", projectId);
        if (error) throw new Error(`finalize-counts update failed: ${error.message}`);
      });

      // ── Chain design-tokens pass if missing (fail-soft) ──
      await step.run("warn-design-tokens", async () => {
        const supabase = createAdminClient();
        const { data: row } = await supabase
          .from("projects")
          .select("design_tokens, wp_url")
          .eq("id", projectId)
          .eq("tenant_id", tenantId)
          .single<{ design_tokens: unknown; wp_url: string | null }>();
        if (row?.design_tokens) return null;
        if (!row?.wp_url) {
          console.warn(
            `[discoverSite ${buildId}] design_tokens null and wp_url missing — skipping design dispatch`,
          );
          return null;
        }
        await inngest.send({
          name: "project/design.requested",
          data: { projectId, tenantId, wpUrl: row.wp_url },
        });
        return null;
      });

      return {
        buildId,
        pages: pageBlocks.length,
        blockTypes: inventory.length,
        menus: menus.length,
      };
    } catch (err) {
      // Flip the build row to failed, captured by Phase F surfaces.
      const supabase = createAdminClient();
      await supabase
        .from("site_builds")
        .update({
          status: "failed",
          failed_phase: "discovering",
          error_text: err instanceof Error ? err.message : String(err),
          finished_at: new Date().toISOString(),
        })
        .eq("id", buildId)
        .eq("project_id", projectId);
      throw err;
    }
  },
);

/**
 * Compute the route_path stored on page_inventory. Pages live at `/<slug>`
 * except for the front-page slug which routes at `/`. CPTs prepend the
 * rest_base or slug. Stage 3 (Phase C) consumes this for emit-time
 * routing; the routing rule lives here because Phase A is the canonical
 * inventory writer.
 */
function routePathFor(postType: string, slug: string): string {
  // Special case the page CPT — the front-page detection lives in
  // resolveFrontPage; downstream code (Stage 3) decides whether THIS
  // slug is the front page and overrides the route. For inventory
  // purposes, "/" is reserved for the front-page-named slug; everything
  // else gets a leading-slash slug.
  if (postType === "page") return `/${slug}`;
  // CPT: /<post_type>/<slug>. Hard-codes post_type rather than rest_base
  // because the smoke test (Task 22) only needs the route_path to be
  // unique per row; Phase C will rewrite this via the manifest if needed.
  return `/${postType}/${slug}`;
}
