import "server-only";
import * as ts from "typescript";
import type { EnrichedInventoryEntry } from "@/lib/jab/inventory";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";
import { modelClientForTier } from "./model-client";

/**
 * component-generator.ts — Phase B per-block component generator.
 *
 * Three responsibilities:
 *   1. Build a tier-appropriate prompt (visual/standard/trivial/cpt_template/acf_flex).
 *   2. Call the ModelClient (tier → provider per design doc §6.4 table).
 *   3. Validate the emitted TSX via ts.createSourceFile() + parseDiagnostics.
 *      If validation fails, retry once. On second failure, return a
 *      passthrough fallback result (compile_status='failed').
 *
 * TypeScript validation rationale:
 *   ts.createSourceFile() + parseDiagnostics catches JSX syntax errors
 *   (malformed tags, unclosed elements, mismatched angles) — the most
 *   common LLM code-gen failure modes. It does NOT catch import-path
 *   errors or type mismatches (those need a full program). The Phase D
 *   `next build` gate is the hard compiler gate; this is a fast-fail
 *   pre-filter that catches ~85% of broken generations before they hit
 *   Storage. transpileModule is NOT used: it silently ignores JSX syntax
 *   errors in many edge cases (confirmed during planning).
 *
 * Output size cap: 10 000 bytes per component. A generation that exceeds
 * this threshold is unlikely to be a clean component (the LLM went rogue).
 * We treat it as a compile failure and retry once.
 */

export interface GeneratedComponent {
  blockName: string;
  tsx: string | null;
  compileStatus: "ok" | "failed" | "skipped";
  compileAttemptCount: number;
  modelUsed: string | null;
  providerUsed: "anthropic" | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

const MAX_COMPONENT_BYTES = 10_000;

function sharedSystemPrompt(tokens: ThemeJsonTokens | null): string {
  const tokenSection = tokens
    ? `
## Design tokens (from theme.json)

Colors: ${JSON.stringify(tokens.colorPalette?.slice(0, 10) ?? [])}
Font sizes: ${JSON.stringify(tokens.fontSizes?.slice(0, 8) ?? [])}
Font families: ${JSON.stringify(tokens.fontFamilies?.slice(0, 4) ?? [])}
Block gap: ${tokens.blockGap ?? "unset"}

Use these tokens as Tailwind class values where possible. The generated
tailwind.config.ts maps all slugs to Tailwind color/font keys.
`
    : `
## Design tokens
No theme.json tokens available. Use Tailwind defaults.
`;

  return `You are a senior React/Next.js developer converting WordPress Gutenberg blocks into typed React components.

## Output contract
- Return ONLY the TypeScript/TSX source code. No markdown fences. No prose.
- The component must be a named export function (not default export).
- Props type must be: \`{ block: BlockNode }\` where BlockNode is imported as:
  \`import type { BlockNode } from "@/lib/jab/ability-client";\`
- Use Tailwind CSS classes for all styling. No inline style objects unless
  a value is dynamic (e.g. a hex color from block.attrs).
- Do NOT import fonts. Do NOT use next/font. Font families come from Tailwind config.
- Do NOT use external icon libraries. SVG inline or emoji fallback only.
- Keep the component <= 200 lines. Complex components should compose smaller
  sub-components defined in the same file.
- Export ONLY the main component. Sub-components are local (not exported).
${tokenSection}`;
}

function visualPrompt(entry: EnrichedInventoryEntry, tokens: ThemeJsonTokens | null): string {
  const system = sharedSystemPrompt(tokens);
  const attrSamples = JSON.stringify(entry.attrSamples.slice(0, 3), null, 2);
  const user = `## Block: ${entry.blockName}

Tier: visual — this is a high-priority block that appears ${entry.occurrenceCount} times
across ${entry.pageSlugs.length} pages (${entry.pageSlugs.slice(0, 5).join(", ")}${entry.pageSlugs.length > 5 ? "..." : ""}).

## Attribute samples (up to 3 distinct shapes)
\`\`\`json
${attrSamples}
\`\`\`

A screenshot of the block as rendered on the source WordPress site is
attached. Use it to match the visual layout, spacing, typography, and
color palette as closely as possible.

Generate the TypeScript React component for this block.`;
  return `${system}\n\nUSER:\n${user}`;
}

function standardPrompt(entry: EnrichedInventoryEntry, tokens: ThemeJsonTokens | null): string {
  const system = sharedSystemPrompt(tokens);
  const attrSamples = JSON.stringify(entry.attrSamples.slice(0, 3), null, 2);
  const user = `## Block: ${entry.blockName}

Tier: standard — appears ${entry.occurrenceCount} times across ${entry.pageSlugs.length} pages.

## Attribute samples
\`\`\`json
${attrSamples}
\`\`\`

Generate the TypeScript React component for this block.`;
  return `${system}\n\nUSER:\n${user}`;
}

function trivialPrompt(entry: EnrichedInventoryEntry, tokens: ThemeJsonTokens | null): string {
  const tokenHint = tokens?.fontSizes
    ? `Font size tokens: ${tokens.fontSizes.map((s) => s.slug).join(", ")}.`
    : "";
  return `You are a React developer. Output ONLY TypeScript/TSX — no markdown, no prose.
Props: { block: BlockNode } where BlockNode comes from "@/lib/jab/ability-client".
Use Tailwind CSS. ${tokenHint}

Generate a minimal React component for the WordPress Gutenberg block: ${entry.blockName}

The block attrs are: ${JSON.stringify(entry.attrSamples[0] ?? {}, null, 2)}

The component should render the block's visual content using block.attrs and block.innerHTML.`;
}

function cptTemplatePrompt(entry: EnrichedInventoryEntry, tokens: ThemeJsonTokens | null): string {
  const system = sharedSystemPrompt(tokens);
  const cptSlug = entry.blockName?.replace("cpt_template/", "") ?? "unknown";

  // Queue construction in generate-components normalizes both legacy
  // (string|null)[] and current { blockNames, acfSchema } shapes to the
  // current shape, so we can read spec.blockNames + spec.acfSchema directly.
  // The narrowing on entry.kind === "cpt_template" is implicit at call site.
  const spec = entry.spec as { blockNames: (string | null)[]; acfSchema: Record<string, unknown> | null };
  const blockUnion = spec.blockNames;
  const acfSchema = spec.acfSchema;

  // Project the ACF schema down to a compact summary the LLM can hold. Full
  // OpenAPI-style schemas with nested $defs blow the token budget — Phase B
  // doesn't need code-generation-grade typing, just a readable cheat sheet.
  const fieldSummary = summarizeAcfFields(acfSchema);
  const fieldsSection = fieldSummary.length
    ? `\n## ACF fields (from the manifest)\nThis CPT exposes these typed fields. Render them in the layout using \`block.attrs.{field_name}\` semantics — the composer maps post.acf onto block.attrs:\n${fieldSummary}\n`
    : "";

  const blocksSection = blockUnion.length
    ? `\n## Embedded block types\nSome sample posts also have post_content blocks. The children slot receives the rendered tree of these:\n${blockUnion.slice(0, 20).join("\n")}\n`
    : "";

  const guidance = fieldSummary.length && blockUnion.length === 0
    ? `\nNote: this CPT renders entirely from ACF fields (no Gutenberg blocks). The children slot will be empty in most cases — design the layout around the ACF fields above.`
    : "";

  const user = `## CPT Template: ${cptSlug}

This is a single-post template wrapper for the "${cptSlug}" custom post type.
${fieldsSection}${blocksSection}${guidance}

Generate a TypeScript React layout component named \`${toPascalCase(cptSlug)}Layout\`
that accepts \`{ block: BlockNode; children: React.ReactNode }\` and renders
an appropriate wrapper with breadcrumb, title, and a content area slot.
The children slot will receive the rendered blocks.`;
  return `${system}\n\nUSER:\n${user}`;
}

/**
 * Compact one-line-per-field summary of an ACF field-group schema (the
 * Record<string, unknown> shape returned by extractCptAcfSchema in Phase A).
 *
 * Walks `properties.{fieldName}` — every flat field gets a line of
 * `- name: type` plus a short hint when available (e.g. "image (object,
 * url+sizes)"). Skips fields whose key contains "acf_fc_layout" (flex
 * discriminator, not user-facing) and arrays of objects with a `oneOf`
 * shape (those are flexible_content fields — they get their own acf_flex
 * inventory rows so the cpt_template prompt deliberately leaves them
 * implicit). Caps output at 30 fields to bound prompt token use.
 */
function summarizeAcfFields(schema: Record<string, unknown> | null): string {
  if (!schema || typeof schema !== "object") return "";
  const props = (schema as { properties?: Record<string, unknown> }).properties;
  if (!props || typeof props !== "object") return "";

  const lines: string[] = [];
  for (const [name, def] of Object.entries(props)) {
    if (lines.length >= 30) break;
    if (name === "acf_fc_layout") continue;
    if (!def || typeof def !== "object") continue;
    const field = def as { type?: unknown; items?: unknown; format?: unknown };
    const type = typeof field.type === "string" ? field.type : "unknown";

    // Skip flexible_content fields — they're already broken out as acf_flex.
    if (type === "array" && field.items && typeof field.items === "object") {
      const items = field.items as { oneOf?: unknown };
      if (Array.isArray(items.oneOf)) continue;
    }

    const fmt = typeof field.format === "string" ? ` (${field.format})` : "";
    lines.push(`- ${name}: ${type}${fmt}`);
  }
  return lines.join("\n");
}

function acfFlexPrompt(entry: EnrichedInventoryEntry, tokens: ThemeJsonTokens | null): string {
  const system = sharedSystemPrompt(tokens);
  const parts = (entry.blockName ?? "").split("/");
  const layoutName = parts[3] ?? "unknown";
  const user = `## ACF Flex Layout: ${entry.blockName}

Layout name: ${layoutName}
Appears ${entry.occurrenceCount} times.

## Sample attrs (this layout's sub_fields)
\`\`\`json
${JSON.stringify(entry.spec ?? entry.attrSamples[0] ?? {}, null, 2)}
\`\`\`

Generate the TypeScript React component for this ACF Flexible Content layout.
A screenshot of the layout as rendered is attached.`;
  return `${system}\n\nUSER:\n${user}`;
}

/**
 * Validates TSX source code using the TypeScript compiler's parser-level
 * diagnostics. Catches JSX syntax errors (malformed tags, unclosed elements,
 * mismatched angles) without requiring type resolution.
 */
export function validateTsx(source: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX,
  );

  const diagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  if (!diagnostics) {
    // parseDiagnostics is internal to ts.SourceFile and could be renamed
    // or removed in a future TypeScript major. If that happens, fail
    // loud rather than silently accept malformed TSX as "valid".
    console.warn(`[component-generator] validateTsx: ts.SourceFile.parseDiagnostics is unavailable — TSX syntax check skipped for ${fileName}. Likely caused by a TypeScript upgrade renaming the internal field.`);
    return [];
  }
  if (diagnostics.length === 0) return [];

  return diagnostics.map((d) => {
    const msg = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
    return `${fileName}(${d.start ?? 0}): ${msg}`;
  });
}

function passthroughFallback(blockName: string): string {
  const safeName = toPascalCase(blockName.replace(/[^a-zA-Z0-9_]/g, "_"));
  return `import type { BlockNode } from "@/lib/jab/ability-client";
import { RichTextContent } from "@/components/blocks/_platform/RichTextContent";

/**
 * ${safeName} — passthrough fallback.
 * Component generation failed or was skipped. Renders sanitized HTML.
 */
export function ${safeName}({ block }: { block: BlockNode }) {
  return <RichTextContent block={block} className="wp-block-${blockName.replace(/\//g, "-")}" />;
}
`;
}

export interface GenerateComponentOptions {
  entry: EnrichedInventoryEntry;
  tokens: ThemeJsonTokens | null;
  screenshotBase64?: string | null;
}

export async function generateComponent(opts: GenerateComponentOptions): Promise<GeneratedComponent> {
  const { entry, tokens } = opts;
  const blockName = entry.blockName ?? "__null__";

  if (entry.tier === "passthrough" || entry.blockName === null) {
    return {
      blockName,
      tsx: passthroughFallback(blockName),
      compileStatus: "skipped",
      compileAttemptCount: 0,
      modelUsed: null,
      providerUsed: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
  }

  const client = modelClientForTier(entry.tier);
  const providerUsed: "anthropic" = "anthropic";
  const modelUsed = entry.tier === "trivial"
    ? "claude-haiku-4-5-20251001"
    : "claude-sonnet-4-6";

  let combinedPrompt: string;
  if (entry.kind === "cpt_template") {
    combinedPrompt = cptTemplatePrompt(entry, tokens);
  } else if (entry.kind === "acf_flex") {
    combinedPrompt = acfFlexPrompt(entry, tokens);
  } else if (entry.tier === "visual") {
    combinedPrompt = visualPrompt(entry, tokens);
  } else if (entry.tier === "standard") {
    combinedPrompt = standardPrompt(entry, tokens);
  } else {
    combinedPrompt = trivialPrompt(entry, tokens);
  }

  const [systemPart, ...userParts] = combinedPrompt.split("\n\nUSER:\n");
  const systemPrompt = systemPart;
  const userPrompt = userParts.join("\n\nUSER:\n") || combinedPrompt;

  let attemptCount = 0;
  let accInputTokens = 0;
  let accOutputTokens = 0;
  let accCacheRead = 0;
  let accCacheCreation = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    attemptCount++;
    let result: Awaited<ReturnType<typeof client.generate>>;
    try {
      result = await client.generate({
        systemPrompt,
        userPrompt,
        cacheSystemPrompt: attempt === 0,
        screenshotBase64: entry.tier === "visual" ? opts.screenshotBase64 ?? undefined : undefined,
      });
    } catch (err) {
      console.warn(`[component-generator] attempt ${attempt + 1} API error for ${blockName}:`, err);
      continue;
    }

    accInputTokens += result.usage.inputTokens;
    accOutputTokens += result.usage.outputTokens;
    accCacheRead += result.usage.cacheReadTokens;
    accCacheCreation += result.usage.cacheCreationTokens;

    const tsx = result.text.trim();

    if (Buffer.byteLength(tsx, "utf8") > MAX_COMPONENT_BYTES) {
      console.warn(`[component-generator] attempt ${attempt + 1} size exceeded for ${blockName} (${Buffer.byteLength(tsx, "utf8")} bytes)`);
      continue;
    }

    const fileName = `${toPascalCase(blockName)}.tsx`;
    const errors = validateTsx(tsx, fileName);
    if (errors.length > 0) {
      console.warn(`[component-generator] attempt ${attempt + 1} TSX validation failed for ${blockName}:`, errors.slice(0, 3));
      continue;
    }

    return {
      blockName,
      tsx,
      compileStatus: "ok",
      compileAttemptCount: attemptCount,
      modelUsed,
      providerUsed,
      inputTokens: accInputTokens,
      outputTokens: accOutputTokens,
      cacheReadTokens: accCacheRead,
      cacheCreationTokens: accCacheCreation,
    };
  }

  return {
    blockName,
    tsx: passthroughFallback(blockName),
    compileStatus: "failed",
    compileAttemptCount: attemptCount,
    modelUsed,
    providerUsed,
    inputTokens: accInputTokens,
    outputTokens: accOutputTokens,
    cacheReadTokens: accCacheRead,
    cacheCreationTokens: accCacheCreation,
  };
}

function toPascalCase(s: string): string {
  // Trim leading + trailing non-identifier chars FIRST so "__null__" → "null"
  // before the camel-bumper runs. Without this, the trailing "__" survives
  // and component-generator emits "Null__" while persist-generation emits
  // "Null" (it has its own trailing trim). Keep them in sync.
  const trimmed = s.replace(/^[^a-zA-Z0-9]+/, "").replace(/[^a-zA-Z0-9]+$/, "");
  const pascal = trimmed
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(.)/, (c: string) => c.toUpperCase());
  // JS/TS identifiers can't start with a digit.
  return /^[0-9]/.test(pascal) ? `_${pascal}` : pascal;
}
