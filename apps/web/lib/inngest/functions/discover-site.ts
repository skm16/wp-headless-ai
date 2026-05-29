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
  resolveFrontPage,
  type PageBySlugRecord,
  type PostListRow,
  type PostTypeRow,
  type Menu,
  type BlockNode,
  type GlobalStylesResponse,
  type CptAbilityMeta,
} from "@/lib/jab/ability-client";
import { extractThemeJsonTokens } from "@/lib/jab/global-styles";
import { buildInventory, detectContentKinds, type PageBlocksInput } from "@/lib/jab/inventory";
import {
  detectParadigms,
  extractCptAcfSchema,
  type Paradigm,
} from "@/lib/jab/paradigm-detection";
import {
  collectAcfFlexLayouts,
  collectCptTemplates,
  type CollectablePage,
} from "@/lib/jab/content-detection";
import { aggregateComputedStyles } from "@/lib/jab/aggregate-computed-styles";
import { aggregateDomSamples } from "@/lib/jab/aggregate-dom-samples";
import { InProcessRunner, type DiscoveryRunner } from "@/lib/jab/discovery-runner";
import { capturePage } from "@/lib/jab/playwright-discovery";
import { captureHomepageDesign } from "@/lib/jab/capture-theme-stylesheets";
import {
  ensureSiteScreenshotsBucket,
} from "@/lib/storage/bucket";
import { persistInventory, persistPages } from "@/lib/jab/persist-discovery";
import { selectSeedPages, hoistFrontPage } from "@/lib/jab/seed-pages";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchManifest, type Manifest } from "@jab/core";
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
 *    1. mark-discovering          — flip site_builds.status to 'discovering'
 *    2. load-creds                — decrypt project WP creds
 *    3. refresh-manifest          — fail-soft re-fetch of the manifest from WP;
 *                                   persists to projects.manifest
 *    4. resolve-front-page        — fail-soft resolution of WP's static front
 *                                   page slug
 *    5. probe-bucket              — idempotent site-screenshots bucket bootstrap
 *    6. load-manifest             — read (just-refreshed) manifest from
 *                                   projects.manifest
 *    7. enumerate-content         — get-menus + list-post-types + per-CPT list
 *                                   calls
 *    8. fetch-page-blocks         — per page, jab/get-{singular}-by-slug with
 *                                   paradigm detection inline
 *    9. capture-screenshots       — Playwright pass
 *   10. build-inventory           — pure reducer
 *   11. enrich-inventory          — paradigm classification + collectors →
 *                                   detectContentKinds
 *   12. aggregate-computed-styles — pure reducer over playwright output
 *   13. fetch-global-styles       — fail-soft theme.json fetch
 *   14. persist                   — block_inventory + page_inventory +
 *                                   site_builds counts
 *   15. warn-design-tokens        — fail-soft re-dispatch of
 *                                   project/design.requested
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

      // ── Refresh manifest (best-effort) ──
      // projects.manifest is cached at onboarding and never refreshed. If the
      // client upgraded the plugin after onboarding (e.g. v0.6.1 → v0.6.2 which
      // dropped the -2- collision suffix from by-slug ability names), the cached
      // manifest has stale names. This step overwrites the DB copy with a fresh
      // fetch so the load-manifest step below reads current ability names.
      // Fail-soft: any network or auth error logs a warning and continues —
      // the load-manifest step below still reads whatever is in the DB.
      await step.run("refresh-manifest", async () => {
        try {
          const fresh = await fetchManifest({
            wpUrl: creds.wpUrl,
            user: creds.username,
            password: creds.appPassword,
            prefix: "jab/",
          });
          const supabase = createAdminClient();
          const { error: updateErr } = await supabase
            .from("projects")
            .update({ manifest: fresh })
            .eq("id", projectId)
            .eq("tenant_id", tenantId);
          if (updateErr) {
            console.warn(
              `[discoverSite ${buildId}] manifest refresh DB write failed (using cached):`,
              updateErr.message,
            );
            return { ok: false, abilityCount: 0 };
          }
          console.log(
            `[discoverSite ${buildId}] manifest refreshed: ${fresh.abilities.length} abilities`,
          );
          return { ok: true, abilityCount: fresh.abilities.length };
        } catch (err) {
          // Fail-soft: any error here means we'll use the cached manifest from the
          // load-manifest step that follows. Don't throw — discovery should proceed.
          console.warn(
            `[discoverSite ${buildId}] manifest refresh failed (using cached):`,
            err instanceof Error ? err.message : String(err),
          );
          return { ok: false, abilityCount: 0 };
        }
      });

      // ── Resolve front page (best-effort) ──
      // Supplies the slug for homepage hoisting in seed-page selection below
      // AND for compose-site's frontPage lookup. compose-site reads
      // `site_builds.config.front_page_slug` first, then falls back to a
      // route_path='/' row in page_inventory — but routePathFor never emits
      // '/', so the fallback is dead. Persisting the resolved slug here is
      // the canonical path; the fallback is reserved for operator override.
      // Null on any error (show_on_front='posts', auth gap, or network blip) →
      // hoistFrontPage is a no-op AND the config write is skipped (preserves
      // existing behavior for posts-page sites where compose hard-fails by
      // design).
      const frontPageSlug = await step.run("resolve-front-page", async () => {
        const fp = await resolveFrontPage(creds);
        return fp?.slug ?? null;
      });

      if (frontPageSlug) {
        await step.run("persist-front-page-slug", async () => {
          const supabase = createAdminClient();
          // Read-modify-write into the JSONB config column so we don't clobber
          // operator overrides (e.g. maxPages) the dispatcher set earlier.
          const { data: row, error: readErr } = await supabase
            .from("site_builds")
            .select("config")
            .eq("id", buildId)
            .single<{ config: Record<string, unknown> | null }>();
          if (readErr) throw new Error(`persist-front-page-slug read failed: ${readErr.message}`);
          const nextConfig = { ...(row?.config ?? {}), front_page_slug: frontPageSlug };
          const { error: writeErr } = await supabase
            .from("site_builds")
            .update({ config: nextConfig })
            .eq("id", buildId)
            .eq("project_id", projectId);
          if (writeErr) throw new Error(`persist-front-page-slug write failed: ${writeErr.message}`);
        });
      }

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
      const baseSeedCptLists = selectSeedPages(perCptLists);
      const seedCptLists = hoistFrontPage(baseSeedCptLists, perCptLists, frontPageSlug);
      const hoistedSlug = seedCptLists !== baseSeedCptLists ? frontPageSlug : null;
      console.log(
        `[discoverSite ${buildId}] seed-page selection: ${perCptLists.reduce((n, p) => n + p.rows.length, 0)} → ${seedCptLists.reduce((n, p) => n + p.rows.length, 0)} pages` +
          (hoistedSlug ? ` (front-page hoisted: ${hoistedSlug})` : ""),
      );

      // Build a Map<cptSlug, AcfSchema> from the manifest. Used by paradigm
      // detection per page and by the flex-layouts collector at enrich time.
      // One traversal of the manifest, then constant-time lookups.
      const cptAcfSchemas = new Map<string, Record<string, unknown>>();
      for (const { cpt, meta } of seedCptLists) {
        const schema = extractCptAcfSchema(manifest, meta);
        if (schema) cptAcfSchemas.set(cpt.slug, schema);
      }

      // ── Fetch per-page block trees ──
      // SMOKE CAP: when smokePageCap > 0 (e.g. test trigger passed maxPages=15),
      // stop once we've collected enough pages. Bounds the slow sequential
      // by-slug MCP calls AND the downstream Playwright capture phase.
      //
      // Round-robin flatten BEFORE looping: emit row 0 from each CPT, then row 1
      // from each CPT, etc. This makes the smoke cap fair across CPTs — every
      // CPT gets representation before any CPT contributes a second row.
      // Without this, hoistFrontPage moves page CPT to position 0, and a flat
      // nested loop would burn the entire smoke budget on page rows before
      // touching any other CPT (the bug observed in build 4ef65ab5).
      //
      // Hoisting still applies first: page CPT at index 0 with front-page slug
      // at row 0 means the very first job emitted IS the front page.
      // Production (smokePageCap=0) processes the full flat list — order
      // changes but coverage doesn't.
      const flatJobs: Array<{ cpt: PostTypeRow; meta: CptAbilityMeta; row: PostListRow }> = [];
      const maxDepth = seedCptLists.reduce((m, s) => Math.max(m, s.rows.length), 0);
      for (let depth = 0; depth < maxDepth; depth++) {
        for (const { cpt, meta, rows } of seedCptLists) {
          if (depth < rows.length) flatJobs.push({ cpt, meta, row: rows[depth] });
        }
      }

      const pageBlocks: Array<PageBlocksInput & { title: string; url: string; acf?: Record<string, unknown>; paradigms: Paradigm[] }> = [];
      for (const { cpt, meta, row } of flatJobs) {
        if (smokePageCap > 0 && pageBlocks.length >= smokePageCap) break;
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
        const cptSchema = cptAcfSchemas.get(cpt.slug) ?? null;
        const paradigms = detectParadigms(record, cptSchema);
        pageBlocks.push({
          slug: row.slug,
          post_type: cpt.slug,
          title: row.title ?? "",
          url: row.link,
          blocks: (record.blocks ?? []) as BlockNode[],
          acf: record.acf,
          paradigms,
        });
      }
      if (smokePageCap > 0) {
        console.log(
          `[discoverSite ${buildId}] smoke cap active: maxPages=${smokePageCap}, collected=${pageBlocks.length}`,
        );
      }

      // Diagnostic: paradigm distribution across sampled pages. Helps the
      // agency see at a glance what content shapes their site uses without
      // poking at the DB. One log line per build.
      const paradigmCounts: Record<string, number> = {};
      for (const p of pageBlocks) {
        const key = p.paradigms.join("+") || "(none)";
        paradigmCounts[key] = (paradigmCounts[key] ?? 0) + 1;
      }
      console.log(
        `[discoverSite ${buildId}] paradigm distribution:`,
        Object.entries(paradigmCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `${k}=${n}`)
          .join(", "),
      );

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
      const enrichedInventory = await step.run("enrich-inventory", async () => {
        const collectablePages: CollectablePage[] = pageBlocks.map((p) => ({
          slug: p.slug,
          post_type: p.post_type,
          blocks: p.blocks,
          acf: p.acf,
          paradigms: p.paradigms,
        }));
        const flexLayouts = collectAcfFlexLayouts(collectablePages, cptAcfSchemas);
        const cptTemplates = collectCptTemplates(collectablePages, cptAcfSchemas);
        return detectContentKinds(inventory, flexLayouts, cptTemplates);
      });
      const computedStylesByBlockName = await step.run("aggregate-computed-styles", async () =>
        aggregateComputedStyles(discoveryResults),
      );

      // Per-block DOM samples for downstream LLM prompts. Uses three
      // correlation rules: wp-block-{name} class lookup for `block` kind,
      // positional matching for `acf_flex`, article-wrapper outerHTML for
      // `cpt_template`. Returns Map<blockName, outerHTML | null> — null
      // entries persist as NULL in block_inventory.source_dom_sample,
      // better than emitting a wrong correlation.
      const domSamplesByBlockName = await step.run("aggregate-dom-samples", async () => {
        const pageAcfData = pageBlocks.map((p) => ({
          slug: p.slug,
          post_type: p.post_type,
          acf: p.acf,
        }));
        const samples = aggregateDomSamples(enrichedInventory, pageAcfData, discoveryResults);
        // Inngest serializes step.run output as JSON — Map doesn't survive.
        // Convert to a plain Record on the way out; restore as needed below.
        const record: Record<string, string | null> = {};
        for (const [key, value] of samples) record[key] = value;
        const counts = Array.from(samples.values()).reduce(
          (acc, v) => {
            if (v) acc.withSample++;
            else acc.withoutSample++;
            return acc;
          },
          { withSample: 0, withoutSample: 0 },
        );
        console.log(
          `[discoverSite ${buildId}] DOM samples: ${counts.withSample} of ${counts.withSample + counts.withoutSample} blocks paired`,
        );
        return record;
      });

      // ── Homepage design assets (stylesheets + shell DOM) ──
      // Two project-level signals from one Playwright session against the
      // homepage:
      //   - themeStylesheets: theme CSS (classic-themed sites where /wp-json/
      //     wp/v2/global-styles returns empty — Two Roads is the canonical
      //     example. Two Roads' brand DNA — Anton headings, #ffc72c yellow —
      //     lives in /wp-content/themes/{slug}/*.css, not theme.json.)
      //   - shellDom: outerHTML of <header> and <footer> from the homepage,
      //     for Phase C's shell LLM (Header / Footer components).
      //
      // Both persist under projects.design_tokens.{themeStylesheets,shellDom}.
      // Phase C consumes; Phase B prompts will pick these up in a follow-up.
      //
      // Fail-soft: any error logs a warning and continues. Discovery is
      // already useful without these signals (scraped DesignAnalysis is the
      // other brand-grounding pathway, captured separately by
      // extract-project-design).
      await step.run("capture-homepage-design", async () => {
        try {
          const homepageUrl = frontPageSlug
            ? new URL(`/${frontPageSlug}/`, creds.wpUrl).toString()
            : creds.wpUrl;
          const { stylesheets, shellDom } = await captureHomepageDesign(homepageUrl);
          const totalCssBytes = stylesheets.reduce((sum, s) => sum + s.css.length, 0);
          const headerBytes = shellDom.header?.length ?? 0;
          const footerBytes = shellDom.footer?.length ?? 0;

          if (stylesheets.length === 0 && !shellDom.header && !shellDom.footer) {
            console.log(`[discoverSite ${buildId}] homepage design: nothing captured`);
            return { stylesheets: 0, totalCssBytes: 0, headerBytes: 0, footerBytes: 0 };
          }

          const supabase = createAdminClient();
          const { data: row } = await supabase
            .from("projects")
            .select("design_tokens")
            .eq("id", projectId)
            .eq("tenant_id", tenantId)
            .single<{ design_tokens: Record<string, unknown> | null }>();
          const next = {
            ...(row?.design_tokens ?? {}),
            themeStylesheets: stylesheets,
            shellDom,
          };
          const { error: updateErr } = await supabase
            .from("projects")
            .update({ design_tokens: next })
            .eq("id", projectId)
            .eq("tenant_id", tenantId);
          if (updateErr) {
            console.warn(
              `[discoverSite ${buildId}] homepage design DB write failed (continuing):`,
              updateErr.message,
            );
            return { stylesheets: 0, totalCssBytes: 0, headerBytes: 0, footerBytes: 0, writeError: updateErr.message };
          }
          console.log(
            `[discoverSite ${buildId}] homepage design: ${stylesheets.length} stylesheets (${totalCssBytes}B), header=${headerBytes}B, footer=${footerBytes}B`,
          );
          return { stylesheets: stylesheets.length, totalCssBytes, headerBytes, footerBytes };
        } catch (err) {
          console.warn(
            `[discoverSite ${buildId}] homepage design capture failed (continuing):`,
            err,
          );
          return { stylesheets: 0, totalCssBytes: 0, headerBytes: 0, footerBytes: 0, error: err instanceof Error ? err.message : String(err) };
        }
      });

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
      await step.run("persist-inventory", () => {
        // Re-materialize the Map from the serialized Record that step.run's
        // output cap converted to JSON above. persistInventory accepts
        // Map<string, string | null> as the canonical shape.
        const samplesMap = new Map<string, string | null>(
          Object.entries(domSamplesByBlockName),
        );
        return persistInventory({
          buildId,
          projectId,
          entries: enrichedInventory,
          computedStylesByBlockName,
          domSamplesByBlockName: samplesMap,
        });
      });
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
              paradigms: p.paradigms,
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
