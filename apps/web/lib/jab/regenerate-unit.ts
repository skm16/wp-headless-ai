import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  generateComponent,
  type GeneratedComponent,
  type GenerateComponentOptions,
} from "@/lib/ai/component-generator";
import { persistGeneration, type PersistGenerationInput } from "@/lib/ai/persist-generation";
import { EDIT_COST_CAP_TOKENS, EditBudgetError, estimateTokens } from "@/lib/ai/edit-cost-guard";
import {
  blockRowToEnrichedEntry,
  loadHomeOrSlugScreenshotBase64,
  BLOCK_ENTRY_COLUMNS,
  type BlockInventoryRowForEntry,
} from "@/lib/jab/inventory-entry-from-row";
import {
  resolveThemeTokens,
  type ThemeJsonTokens,
  type ScrapedBrandTokens,
} from "@/lib/jab/global-styles";

/**
 * regenerate-unit — guidance-driven regeneration of ONE targeted unit
 * (spec §3.3). Component scope re-runs generateComponent with guidance and
 * overwrites the cloned tsx + cost cols. Shell scope is a no-op here: compose
 * re-runs the shell LLMs anyway, so guidance is threaded via config into
 * compose's generate-header/footer (avoids double-generation).
 *
 * Asserts the target row exists in the cloned inventory before generating
 * (verifier major): a validated-but-missing target fails loudly instead of
 * deploying an identical no-op preview.
 */

export class RegenCompileError extends Error {
  constructor(public readonly target: string, message: string) {
    super(message);
    this.name = "RegenCompileError";
  }
}

export interface RegenComponentInput {
  buildId: string;
  projectId: string;
  target: string;
  guidance: string;
  /** Slug whose 1280 screenshot anchors the visual-tier prompt (typically the home/front slug). */
  screenshotSlug: string;
  /**
   * Source-WP host variants for origin-rewriting, built by the caller via
   * `hostVariants(project.wp_url)`. Absent → no rewrite (safe for tests and
   * paths where wp_url is unavailable). Same fail-soft posture as
   * generate-components.ts: the caller wraps hostVariants in try/catch → [].
   */
  sourceHosts?: string[];
}

export interface RegenResult {
  compileStatus: GeneratedComponent["compileStatus"];
  cost: { inputTokens: number; outputTokens: number };
}

/** Injectable seams for unit testing (no real LLM / Storage / DB in tests). */
export interface RegenComponentDeps {
  loadTargetRow(input: RegenComponentInput): Promise<BlockInventoryRowForEntry | null>;
  loadTokens(input: RegenComponentInput): Promise<ThemeJsonTokens | null>;
  loadScreenshot(input: RegenComponentInput): Promise<string | null>;
  generate(args: GenerateComponentOptions): Promise<GeneratedComponent>;
  persist(args: PersistGenerationInput): Promise<{ storagePath: string | null }>;
}

function defaultDeps(): RegenComponentDeps {
  return {
    async loadTargetRow(input) {
      const supabase = createAdminClient();
      const { data } = await supabase
        .from("block_inventory")
        .select(BLOCK_ENTRY_COLUMNS)
        .eq("site_build_id", input.buildId)
        .eq("project_id", input.projectId)
        .eq("block_name", input.target)
        .maybeSingle();
      return (data as BlockInventoryRowForEntry | null) ?? null;
    },
    async loadTokens(input) {
      const supabase = createAdminClient();
      // projectId is the UUID primary key, so this PK lookup is unambiguous on
      // its own. The full-build path also filters tenant_id as RLS defence-in-depth,
      // but this regen path runs under the service-role admin client (no RLS), and
      // RegenComponentInput intentionally does not carry tenantId.
      const { data } = await supabase
        .from("projects")
        .select("design_tokens")
        .eq("id", input.projectId)
        .single<{ design_tokens: unknown }>();
      const container = (data?.design_tokens ?? null) as {
        themeJson?: ThemeJsonTokens;
        colors?: ScrapedBrandTokens["colors"];
        typography?: ScrapedBrandTokens["typography"];
      } | null;
      return resolveThemeTokens(container?.themeJson, {
        colors: container?.colors,
        typography: container?.typography,
      });
    },
    async loadScreenshot(input) {
      const supabase = createAdminClient();
      return loadHomeOrSlugScreenshotBase64(supabase, input.buildId, input.screenshotSlug);
    },
    generate: generateComponent,
    persist: persistGeneration,
  };
}

export async function regenerateComponentUnit(
  input: RegenComponentInput,
  deps: RegenComponentDeps = defaultDeps(),
): Promise<RegenResult> {
  const row = await deps.loadTargetRow(input);
  if (!row) {
    throw new Error(
      `regenerate-unit: target block '${input.target}' not found in cloned inventory for build ${input.buildId}. ` +
        `Refusing to deploy a no-op identical preview.`,
    );
  }

  const entry = blockRowToEnrichedEntry(row);
  const tokens = await deps.loadTokens(input);

  // EDIT_COST_CAP_TOKENS enforcement (Phase 5 decision: ENFORCE, not delete —
  // the constant was exported-but-unenforced "dead reassurance"). This is the
  // only point that has the regen prompt inputs in hand pre-spend. Estimate
  // covers the TEXT inputs only: the serialized entry (attr samples + DOM
  // sample + computed styles + spec), resolved design tokens, and guidance.
  // The visual-tier screenshot is deliberately excluded — image token cost is
  // resolution-based, not text-length-based, and discovery bounds capture
  // dimensions. Today's structural caps (50KB DOM sample at prompt-build,
  // 4000-char guidance) keep real inputs far under the cap; this is a
  // tripwire against future unbounded growth. The edit-site worker's generic
  // catch converts this throw into a failed edit surfaced to chat.
  const estimatedPromptTokens =
    estimateTokens(JSON.stringify(entry)) +
    estimateTokens(JSON.stringify(tokens ?? null)) +
    estimateTokens(input.guidance);
  if (estimatedPromptTokens > EDIT_COST_CAP_TOKENS) {
    throw new EditBudgetError(
      "edit_cost_cap",
      `regenerate-unit: estimated text prompt inputs for '${input.target}' (~${estimatedPromptTokens} tokens) exceed EDIT_COST_CAP_TOKENS (${EDIT_COST_CAP_TOKENS}). Refusing the generate call.`,
    );
  }

  const screenshotBase64 =
    entry.tier === "visual" ? await deps.loadScreenshot(input) : null;

  const component = await deps.generate({
    entry,
    tokens,
    screenshotBase64: screenshotBase64 ?? undefined,
    guidance: input.guidance,
    // Thread origin-rewriting so chat-edit regen can't reintroduce absolute
    // source-WP links into components the full-build path already cleaned.
    sourceHosts: input.sourceHosts,
  });

  // Persist regardless of compile status so cost telemetry + (failed) status
  // land on the cloned row.
  await deps.persist({ buildId: input.buildId, projectId: input.projectId, component });

  // Only "failed" is an error. "skipped" is the passthrough tier (entry.tier ===
  // "passthrough" / null blockName); it is unreachable for a guidance-driven edit
  // because the planner's siteMap only offers real block types, so we let it return.
  if (component.compileStatus === "failed") {
    throw new RegenCompileError(
      input.target,
      `regenerate-unit: regeneration of '${input.target}' failed the compile gate after retries.`,
    );
  }

  return {
    compileStatus: component.compileStatus,
    cost: { inputTokens: component.inputTokens, outputTokens: component.outputTokens },
  };
}

/**
 * Shell regen is a no-op marker: compose's generate-header/footer re-run the
 * shell LLM and read guidance off the build config. This exists so the worker
 * has a symmetric call site and can assert the kind is valid.
 */
export function regenerateShellUnit(target: string): { deferredToCompose: true } {
  if (target !== "header" && target !== "footer") {
    throw new Error(`regenerate-unit: shell target must be 'header' or 'footer' (got '${target}').`);
  }
  return { deferredToCompose: true };
}
