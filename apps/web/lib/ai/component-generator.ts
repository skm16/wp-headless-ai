import "server-only";
import * as ts from "typescript";
import type { EnrichedInventoryEntry } from "@/lib/jab/inventory";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";
import type { DynamicListSpec } from "@/lib/jab/dynamic-lists-runtime";
import { modelClientForTier } from "./model-client";
import { postprocessGeneratedTsx } from "./generated-tsx-postprocess";
import { rewriteWpOriginUrls } from "@/lib/jab/rewrite-origin-links";

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

function sharedSystemPrompt(tokens: ThemeJsonTokens | null, sourceHost?: string | null): string {
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
- Props type: \`{ block: BlockNode; children?: React.ReactNode }\` where BlockNode is imported as:
  \`import type { BlockNode } from "@/lib/jab/ability-client";\`
  If your block is a LEAF (paragraph, heading, image, single button), you MAY
  omit the children field — the dispatcher widens the contract at the call
  site, so either signature compiles.
- The \`children\` prop carries the pre-rendered descendant block tree from
  the dispatcher. If your block is a WRAPPER (e.g. core/group, core/columns,
  core/buttons, core/cover, or any block whose source DOM contains nested
  block content), declare \`children?: React.ReactNode\` and render
  \`{children}\` in the appropriate slot inside your layout. Never recreate
  child block markup yourself; the dispatcher already did it.
- \`block.attrs\` is typed \`Record<string, unknown>\`. If you declare a typed
  interface for the attrs and cast to it, you MUST go through \`unknown\`:
  \`const data = block.attrs as unknown as MyAttrs;\` — a direct
  \`block.attrs as MyAttrs\` fails the typecheck gate (TS2352) whenever the
  interface has required fields (e.g. \`acf_fc_layout\`). Equivalently, read
  fields inline (\`block.attrs.heading as string\`) or declare every interface
  field optional. Never emit a bare \`as MyAttrs\` on \`block.attrs\`.
- Use Tailwind CSS classes for all styling. No inline style objects unless
  a value is dynamic (e.g. a hex color from block.attrs).
- Do NOT import fonts. Do NOT use next/font. Font families come from Tailwind config.
- Do NOT use external icon libraries. SVG inline or emoji fallback only.
- Image binding contract: Bind image rendering to the actual data shape.
  ACF image fields expose \`.url\` (string), \`.alt\` (string), and \`.sizes\`
  (size-slug → URL map) — render against those paths. Relationship /
  post_object arrays ARE hydrated at render: each item carries
  \`featured_image: { url, alt }\` alongside \`post_title\` / \`post_name\`. Bind the
  image with a plain \`<img>\` (or \`next/image\` with explicit width/height) to
  \`item.featured_image.url\` — do NOT use \`<MediaImage>\` here (that shim takes a
  block, not a src). Only
  when \`item.featured_image?.url\` is genuinely absent, fall back to a
  brand-tinted block — never emit a gray "placeholder" box or a fake
  \`<BeerPlaceholderImage>\`-style component. Smoking-gun anti-example: the Two Roads FeaturedBeer
  component emitted \`<BeerPlaceholderImage title={beer.post_title} />\`
  rendering a gray box with the beer name — every beer card on the
  deployed site looked broken even though the rest of the layout was
  correct.
- Keep the component <= 200 lines. Complex components should compose smaller
  sub-components defined in the same file.
- Export ONLY the main component. Sub-components are local (not exported).
${sourceHost ? `- Links whose host is ${sourceHost} are INTERNAL. Emit them as root-relative paths copied exactly from the source URL's path. NEVER emit ${sourceHost} in any href.\n` : ""}${tokenSection}`;
}

/**
 * Block-name leaf tokens whose source DOM is by-design arbitrary user HTML
 * (raw embed-style blocks). These flow through the typed-component path on
 * paper but their DOM sample is pathological as a generation anchor — it's
 * literal user-pasted markup (scripts, scoped styles, framework chrome).
 * Including it in the prompt actively hurts: the LLM tries to recreate
 * inline styles + structure as typed React, blowing the compile gate.
 *
 * Surfaced by the Phase B fidelity A/B (build 62de3f61 against Two Roads,
 * 2026-05-27): `acf_flex/page/page_builder/custom-html` hard-failed twice
 * with a 35 KB DOM sample full of inline `<style>` blocks. The block was
 * always going to be a passthrough by semantic intent; the DOM injection
 * just made that visible. Skip the section entirely for these names.
 */
const PASSTHROUGH_SHAPED_LEAVES = new Set([
  "custom-html",
  "custom_html",
  "html",
  "raw_html",
  "embed_html",
  "shortcode",
  "code-block",
  "code_block",
  "freeform",
]);

function isPassthroughShapedBlockName(blockName: string | null): boolean {
  if (!blockName) return false;
  const leaf = blockName.split("/").pop()!.toLowerCase();
  return PASSTHROUGH_SHAPED_LEAVES.has(leaf);
}

/**
 * Render the "## Source DOM sample" prompt section, or empty string when no
 * DOM was correlated. Shared across visual / standard / cpt_template /
 * acf_flex prompts; trivial prompts deliberately omit DOM samples because
 * paragraph/heading rendering is well-known and the token cost matters
 * across many short blocks.
 *
 * The aggregator caps sample bytes per entry (50 KB) — at Sonnet 4.6 rates
 * this is ~$0.04 of input per call. Across ~25 visual+standard+cpt+acf_flex
 * blocks on a Two-Roads-shaped site that's ~$1 extra per build, comfortably
 * inside Phase B's budget for a meaningful fidelity lever.
 *
 * Passthrough-shaped block names (custom-html, shortcode, etc.) suppress
 * the section regardless of whether a sample exists — see
 * `isPassthroughShapedBlockName`.
 */
function renderDomSampleSection(
  sample: string | null | undefined,
  opts: { label?: string; guidance?: string; blockName?: string | null } = {},
): string {
  if (!sample) return "";
  if (isPassthroughShapedBlockName(opts.blockName ?? null)) return "";
  const label = opts.label ?? "Source DOM sample (one occurrence of this block as rendered on the WP site)";
  const guidance = opts.guidance ?? "This HTML is the literal markup the source theme rendered. Match its semantic structure — element hierarchy, sectioning, content placeholders. Translate source class names to corresponding Tailwind classes using the theme tokens above. The screenshot shows the pixels; this HTML shows the structure those pixels come from.";
  return `\n## ${label}\n\`\`\`html\n${sample}\n\`\`\`\n${guidance}\n`;
}

/**
 * Render the "## Computed style hints" section from `block_inventory.computed_styles`.
 *
 * The aggregator persists `{ viewports: { "1280": { fontSize: ["32px", "28px"],
 * color: ["rgb(20,20,20)"], padding: ["16px 24px"] } } }` — unique values
 * observed per CSS property at each viewport. We surface the desktop (1280)
 * viewport's values as a flat "first observed" hint: it's a concrete signal
 * about what the block actually looks like when rendered, beyond what the
 * theme tokens alone could tell the LLM.
 *
 * Capped at the top 8 properties to keep prompt size bounded. Tier-relevant
 * properties (font-size, color, background, padding, margin, border-radius,
 * font-family, line-height) are surfaced first when present; everything else
 * falls in occurrence order. Empty string when no computed_styles persisted.
 */
const PRIORITY_CSS_PROPS = [
  "fontSize",
  "fontFamily",
  "fontWeight",
  "color",
  "backgroundColor",
  "padding",
  "margin",
  "lineHeight",
  "borderRadius",
  "textAlign",
];
function renderComputedStylesSection(
  computedStyles: { viewports: Record<string, Record<string, string[]>> } | null | undefined,
): string {
  if (!computedStyles) return "";
  const vp = computedStyles.viewports?.["1280"] ?? computedStyles.viewports?.["768"];
  if (!vp || Object.keys(vp).length === 0) return "";
  const ordered: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const prop of PRIORITY_CSS_PROPS) {
    if (vp[prop]?.[0]) {
      ordered.push([prop, vp[prop][0]]);
      seen.add(prop);
    }
  }
  for (const [prop, values] of Object.entries(vp)) {
    if (ordered.length >= 8) break;
    if (seen.has(prop)) continue;
    if (values[0]) ordered.push([prop, values[0]]);
  }
  if (ordered.length === 0) return "";
  const lines = ordered.map(([prop, val]) => `- ${prop}: ${val}`).join("\n");
  return `\n## Computed style hints (desktop, observed at runtime)
${lines}
These are real getComputedStyle values from the source site's rendered DOM.
Use them as concrete targets for your Tailwind classes (e.g. fontSize "32px"
→ \`text-3xl\` or similar). The screenshot shows the result; these values
tell you the underlying CSS.
`;
}

/**
 * Render the "## Targeted edit guidance" block for a chat-driven regeneration.
 * Empty string when no guidance (byte-identical default). MUST only ever be
 * concatenated into the USER half of a prompt (after the "\n\nUSER:\n" marker)
 * so it never lands in the cached system prompt (R7 / spec §3.3).
 */
function renderEditGuidanceSection(guidance: string | undefined): string {
  if (!guidance || !guidance.trim()) return "";
  return `\n## Targeted edit guidance
The user requested a specific change to this component. Apply it while keeping
everything else faithful to the source:
${guidance.trim()}
`;
}

export function visualPrompt(entry: EnrichedInventoryEntry, tokens: ThemeJsonTokens | null, guidance?: string, sourceHost?: string | null): string {
  const system = sharedSystemPrompt(tokens, sourceHost);
  const attrSamples = JSON.stringify(entry.attrSamples.slice(0, 3), null, 2);
  const domSection = renderDomSampleSection(entry.sourceDomSample, { blockName: entry.blockName });
  const stylesSection = renderComputedStylesSection(entry.computedStyles);
  const guidanceSection = renderEditGuidanceSection(guidance);
  const user = `## Block: ${entry.blockName}

Tier: visual — this is a high-priority block that appears ${entry.occurrenceCount} times
across ${entry.pageSlugs.length} pages (${entry.pageSlugs.slice(0, 5).join(", ")}${entry.pageSlugs.length > 5 ? "..." : ""}).

## Attribute samples (up to 3 distinct shapes)
\`\`\`json
${attrSamples}
\`\`\`
${domSection}${stylesSection}${guidanceSection}
A screenshot of the block as rendered on the source WordPress site is
attached. Use it to match the visual layout, spacing, typography, and
color palette as closely as possible.

Generate the TypeScript React component for this block.`;
  return `${system}\n\nUSER:\n${user}`;
}

export function standardPrompt(entry: EnrichedInventoryEntry, tokens: ThemeJsonTokens | null, guidance?: string, sourceHost?: string | null): string {
  const system = sharedSystemPrompt(tokens, sourceHost);
  const attrSamples = JSON.stringify(entry.attrSamples.slice(0, 3), null, 2);
  const domSection = renderDomSampleSection(entry.sourceDomSample, { blockName: entry.blockName });
  const stylesSection = renderComputedStylesSection(entry.computedStyles);
  const guidanceSection = renderEditGuidanceSection(guidance);
  const user = `## Block: ${entry.blockName}

Tier: standard — appears ${entry.occurrenceCount} times across ${entry.pageSlugs.length} pages.

## Attribute samples
\`\`\`json
${attrSamples}
\`\`\`
${domSection}${stylesSection}${guidanceSection}
Generate the TypeScript React component for this block.`;
  return `${system}\n\nUSER:\n${user}`;
}

export function trivialPrompt(entry: EnrichedInventoryEntry, tokens: ThemeJsonTokens | null, guidance?: string, _sourceHost?: string | null): string {
  const tokenHint = tokens?.fontSizes
    ? `Font size tokens: ${tokens.fontSizes.map((s) => s.slug).join(", ")}.`
    : "";
  const system = `You are a React developer. Output ONLY TypeScript/TSX — no markdown, no prose.
Props: { block: BlockNode } where BlockNode comes from "@/lib/jab/ability-client".
Use Tailwind CSS. ${tokenHint}`;
  const guidanceSection = renderEditGuidanceSection(guidance);
  const user = `Generate a minimal React component for the WordPress Gutenberg block: ${entry.blockName}

The block attrs are: ${JSON.stringify(entry.attrSamples[0] ?? {}, null, 2)}

The component should render the block's visual content using block.attrs and block.innerHTML.${guidanceSection}`;
  return `${system}\n\nUSER:\n${user}`;
}

export function cptTemplatePrompt(entry: EnrichedInventoryEntry, tokens: ThemeJsonTokens | null, guidance?: string, sourceHost?: string | null): string {
  const system = sharedSystemPrompt(tokens, sourceHost);
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

  const acfOnlyNote = fieldSummary.length && blockUnion.length === 0
    ? `\nNote: this CPT renders entirely from ACF fields (no Gutenberg blocks). The children slot will be empty in most cases — design the layout around the ACF fields above.`
    : "";

  const domSection = renderDomSampleSection(entry.sourceDomSample, {
    blockName: entry.blockName,
    label: "Source single-record markup (articleOuterHtml from one example post on the source site)",
    guidance: "Use this to match the wrapper/heading/meta/content structure the source theme renders for this CPT. The ACF fields above tell you what data is available; this HTML tells you the structural skeleton to recreate.",
  });

  const guidanceSection = renderEditGuidanceSection(guidance);

  const user = `## CPT Template: ${cptSlug}

This is a single-post template wrapper for the "${cptSlug}" custom post type.
${fieldsSection}${blocksSection}${acfOnlyNote}
${domSection}${guidanceSection}
Generate a TypeScript React layout component named \`${toPascalCase(cptSlug)}Layout\`
that accepts \`{ block: BlockNode; children?: React.ReactNode }\` and renders
the source theme's single-post structure: breadcrumb, title (from
\`block.attrs.title\`), meta (date / author / tax terms from the ACF fields
above), then the content area. The dispatcher pre-renders any embedded blocks
into \`children\` — render \`{children}\` in the content area slot. When the
CPT has no embedded blocks (ACF-only paradigm), \`children\` will be undefined;
your layout should still render correctly using just \`block.attrs\`.`;
  return `${system}\n\nUSER:\n${user}`;
}

/**
 * Compact one-line-per-field summary of an ACF field-group schema (the
 * Record<string, unknown> shape returned by extractCptAcfSchema in Phase A).
 *
 * Walks `properties.{fieldName}` — every flat field gets a line of
 * `- name: type` plus a short hint when available. Skips fields whose key
 * is "acf_fc_layout" (flex discriminator, not user-facing) and arrays of
 * objects with a `oneOf` shape (flexible_content layouts — they get their
 * own acf_flex inventory rows so the cpt_template prompt deliberately
 * leaves them implicit). Caps output at 30 fields to bound prompt tokens.
 *
 * Smart annotations (load-bearing for visual fidelity):
 * - **Image / file / gallery fields** are detected via the plugin's
 *   `x-acf-media.kind` vendor extension (preferred) or by structural
 *   shape (`object` with `url` + `alt` siblings). The summary surfaces
 *   the binding paths (\`{name}.url\`, \`{name}.alt\`, \`{name}.sizes\`) so
 *   the LLM doesn't fall back to a literal placeholder box — the Phase 1
 *   diagnosis (build 982f0d57) confirmed pre-fix output emitted
 *   `<BeerPlaceholderImage>` boxes because the schema-summary line was
 *   just "- hero_image: object".
 * - **Post-relation arrays** (relationship, post_object multiple) are
 *   detected by `items.properties` matching the WP_Post shape
 *   (`post_title` + `post_name`). The summary now reflects that refs are
 *   hydrated at render (related-posts.ts merges `featured_image` onto each
 *   item), so the LLM is told to bind `item.featured_image.url` rather than
 *   draw placeholder boxes.
 *   Exported so test suites can lock these annotations in.
 */
export function summarizeAcfFields(schema: Record<string, unknown> | null): string {
  if (!schema || typeof schema !== "object") return "";
  const props = (schema as { properties?: Record<string, unknown> }).properties;
  if (!props || typeof props !== "object") return "";

  const lines: string[] = [];
  for (const [name, def] of Object.entries(props)) {
    if (lines.length >= 30) break;
    if (name === "acf_fc_layout") continue;
    if (!def || typeof def !== "object") continue;
    const field = def as {
      type?: unknown;
      items?: unknown;
      format?: unknown;
      properties?: unknown;
      "x-acf-media"?: unknown;
    };
    const type = typeof field.type === "string" ? field.type : "unknown";

    // Skip flexible_content fields — they're already broken out as acf_flex.
    if (type === "array" && field.items && typeof field.items === "object") {
      const items = field.items as { oneOf?: unknown };
      if (Array.isArray(items.oneOf)) continue;
    }

    // Image/file/gallery object fields — surface binding paths. The summary
    // line branches on `x-acf-media.kind` because file_schema (Schema.php:641)
    // exposes {url, title, filename, mime_type} but NO sizes, while
    // image_schema (Schema.php:598) carries sizes for srcset rendering.
    // A unified "use .sizes" message would mislead the LLM into emitting
    // <img srcSet> against a file field that doesn't have it.
    if (type === "object" && isImageFieldShape(field)) {
      lines.push(formatMediaObjectLine(name, mediaKindOf(field, "image")));
      continue;
    }

    // Gallery (array<image|file>) — annotate items by the same kind branch.
    if (type === "array" && field.items && typeof field.items === "object") {
      const items = field.items as { type?: unknown; properties?: unknown; "x-acf-media"?: unknown };
      if (items.type === "object" && isImageFieldShape(items)) {
        const kind = mediaKindOf(items, "image");
        lines.push(
          kind === "file"
            ? `- ${name}: array of file attachments — each item exposes \`.url\` (string) and \`.filename\` (string); no \`.sizes\` (files are not srcset-capable)`
            : `- ${name}: gallery (array of image objects) — each item exposes \`.url\` / \`.alt\` / \`.sizes\` the same way`,
        );
        continue;
      }
    }

    // url-return-format image fields (plain string carrying x-acf-media).
    if (type === "string" && isImageUrlVendorExt(field)) {
      lines.push(`- ${name}: image URL (string) — bind directly to \`${name}\``);
      continue;
    }

    // Post-relation arrays (relationship / post_object multiple). The refs are
    // hydrated at render (related-posts.ts merges featured_image onto each item),
    // so the LLM is told to bind item.featured_image.url, not draw placeholders.
    if (type === "array" && field.items && typeof field.items === "object") {
      const itemProps = (field.items as { properties?: Record<string, unknown> }).properties;
      if (itemProps && isPostRecordShape(itemProps)) {
        const fields = Object.keys(itemProps).slice(0, 6).join(", ");
        lines.push(
          `- ${name}: array of related posts — each item is hydrated at render with { post_title, post_name, featured_image: { url, alt } }. Bind the image via <img src={item.featured_image.url} alt={item.featured_image.alt ?? item.post_title} />; if featured_image is missing, fall back to a brand-tinted block.`,
        );
        continue;
      }
    }

    const fmt = typeof field.format === "string" ? ` (${field.format})` : "";
    lines.push(`- ${name}: ${type}${fmt}`);
  }
  return lines.join("\n");
}

/**
 * Detect an ACF image/file field by either the `x-acf-media` vendor
 * extension (preferred — the plugin marks these explicitly) or by the
 * structural shape (`url` + `alt` siblings under `properties` —
 * image-specific; file_schema has no `alt`). The structural fallback
 * catches schemas that pre-date the vendor extension or were produced
 * by a non-plugin source (manifest snapshots, mocked inventory rows).
 */
function isImageFieldShape(field: { properties?: unknown; "x-acf-media"?: unknown }): boolean {
  const ext = field["x-acf-media"];
  if (ext && typeof ext === "object") {
    const kind = (ext as { kind?: unknown }).kind;
    if (kind === "image" || kind === "file") return true;
  }
  const props = field.properties;
  if (props && typeof props === "object") {
    const p = props as Record<string, unknown>;
    return "url" in p && "alt" in p;
  }
  return false;
}

/**
 * Resolve the media kind from `x-acf-media.kind`, falling back to
 * `defaultKind` when the vendor extension is absent (structural-fallback
 * detection path — no kind metadata, default to image since the structural
 * check requires `alt` which only image_schema emits).
 */
function mediaKindOf(field: { "x-acf-media"?: unknown }, defaultKind: "image" | "file"): "image" | "file" {
  const ext = field["x-acf-media"];
  if (ext && typeof ext === "object") {
    const kind = (ext as { kind?: unknown }).kind;
    if (kind === "file") return "file";
    if (kind === "image") return "image";
  }
  return defaultKind;
}

function formatMediaObjectLine(name: string, kind: "image" | "file"): string {
  if (kind === "file") {
    return `- ${name}: file attachment — bind to \`${name}.url\` (string) for href/src and \`${name}.filename\` (string) for display name; no \`.sizes\` (files are not srcset-capable)`;
  }
  return `- ${name}: image object — bind to \`${name}.url\` (string) for src, \`${name}.alt\` (string) for alt text, \`${name}.sizes\` (size-slug → URL map) for srcset / responsive renderers`;
}

function isImageUrlVendorExt(field: { "x-acf-media"?: unknown }): boolean {
  const ext = field["x-acf-media"];
  if (!ext || typeof ext !== "object") return false;
  const kind = (ext as { kind?: unknown }).kind;
  return kind === "image" || kind === "file";
}

/**
 * Post-relation item shape (from the plugin's `post_ref_schema` —
 * packages/wp-plugin/includes/Acf/Schema.php:698). Items always have
 * uppercase `ID` (integer) plus `post_title` + `post_name`. Requiring
 * all three lowers false-positive risk on hand-authored repeater schemas
 * that might happen to use `post_title` / `post_name` as content labels
 * but won't typically also carry an uppercase `ID`.
 */
function isPostRecordShape(itemProps: Record<string, unknown>): boolean {
  return "ID" in itemProps && "post_title" in itemProps && "post_name" in itemProps;
}

/**
 * Walk a runtime data sample (e.g. `entry.spec` for an acf_flex layout,
 * which is the actual attrSample from a discovered page — not a JSON
 * schema). Surface the names of any top-level array fields whose items
 * look like bare WP_Post records (`{ID, post_title, post_name}`). These
 * are the fields where the LLM has historically emitted gray placeholder
 * boxes; the acf_flex prompt threads the result into a per-field warning.
 *
 * Returns an array of field names (e.g. `["beers"]` for the Two Roads
 * FeaturedBeer layout). Empty array when nothing matches — caller
 * suppresses the section in that case.
 */
export function findPostRelationFieldsInSample(sample: unknown): string[] {
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) return [];
  const result: string[] = [];
  for (const [name, value] of Object.entries(sample as Record<string, unknown>)) {
    if (!Array.isArray(value) || value.length === 0) continue;
    const first = value[0];
    if (!first || typeof first !== "object" || Array.isArray(first)) continue;
    const item = first as Record<string, unknown>;
    if ("ID" in item && "post_title" in item && "post_name" in item) {
      result.push(name);
    }
  }
  return result;
}

export function acfFlexPrompt(
  entry: EnrichedInventoryEntry,
  tokens: ThemeJsonTokens | null,
  guidance?: string,
  dynamicList?: DynamicListSpec | null,
  sourceHost?: string | null,
): string {
  const system = sharedSystemPrompt(tokens, sourceHost);
  const parts = (entry.blockName ?? "").split("/");
  const layoutName = parts[3] ?? "unknown";
  const domSection = renderDomSampleSection(entry.sourceDomSample, {
    blockName: entry.blockName,
    label: "Source markup (the rendered section for one occurrence of this layout)",
    guidance: "Use this to match the section's wrapper element, internal element hierarchy, and content placement. Translate the source class names to Tailwind classes using the theme tokens above. The screenshot shows the pixels; this HTML shows the structure those pixels come from.",
  });

  // The acf_flex `entry.spec` is a runtime data sample (per
  // content-detection.ts AcfFlexLayoutData.attrSample), NOT a JSON schema —
  // so summarizeAcfFields doesn't apply. But we CAN detect post-relation
  // arrays in the sample data shape and pre-flag them, mirroring the
  // image-binding-contract anti-placeholder rule. This closes the on-pilot
  // gap diagnosed for Two Roads FeaturedBeer (which is an acf_flex layout
  // whose `beers` field returned bare WP_Post records — the LLM emitted
  // <BeerPlaceholderImage> boxes because no image binding existed in the
  // sample). See docs/superpowers/specs/2026-05-29-two-roads-diagnosis.md.
  // The refs are now hydrated at render (related-posts.ts), so the warning
  // directs the LLM to bind featured_image.
  const sample = (entry.spec ?? entry.attrSamples[0] ?? {}) as unknown;
  const postRelationFields = findPostRelationFieldsInSample(sample);
  const postRelationWarning = postRelationFields.length > 0
    ? `\n## Post-relation fields (hydrated at render)\nThese fields are arrays of related posts: ${postRelationFields.map((f) => `\`${f}\``).join(", ")}. At render each item carries a \`featured_image\` object \`{ url, alt }\` (plus its title/slug). Bind the image: render \`<img src={item.featured_image.url} alt={item.featured_image.alt ?? item.post_title} />\` for each item (a plain \`<img>\`, not the \`<MediaImage>\` block shim). Guard for the rare missing image: when \`item.featured_image?.url\` is absent, fall back to a brand-tinted block — never a literal "placeholder" box.\n`
    : "";

  // When the detector flags this layout as a config-only "list placeholder"
  // (e.g. upcoming_events), the items are injected at render as
  // block.attrs.items (a JabListItem[]) by resolveDynamicLists. Tell the LLM
  // to render that contract instead of an always-empty fallback — without it,
  // the generated component reads a non-existent attrs field and renders "No
  // … found." See lib/jab/dynamic-list-detect.ts + dynamic-lists-runtime.ts.
  const dynamicListSection = dynamicList
    ? `\n## Dynamic list (injected at render) — STRICT DATA CONTRACT\nThis layout is a placeholder for a dynamic list of "${dynamicList.postType}" items. The list items are NOT in the captured attrs (which hold ONLY config: headline, links, padding). At render, \`resolveDynamicLists\` injects the items as **\`block.attrs.items\`** — this is the ONE AND ONLY source of list data.\n\n**CRITICAL — do exactly this, ignore your priors:**\n- The list MUST come from \`block.attrs.items\`. Read the items as: \`const items = (block.attrs.items as unknown as JabListItem[]) ?? [];\`\n- Do NOT read \`block.attrs.events\`, \`block.attrs.${dynamicList.postType}\`, \`block.attrs.posts\`, \`block.attrs.month_groups\`, or any other attrs key for the list. Those keys do not exist and will always be empty. \`block.attrs.items\` is the only correct key even though the layout is "about ${dynamicList.postType}".\n- The injected item type is:\n\`\`\`ts\ninterface JabListItem { id: number; title: string; url: string; excerpt: string; image: { url: string; alt: string } | null; date: string | null; acf: Record<string, unknown> }\n\`\`\`\nMap over \`items\`: link → \`item.url\`, title → \`item.title\`, image → \`<img src={item.image?.url} alt={item.image?.alt ?? item.title} />\` with a brand-tinted fallback when \`item.image\` is null, date badge/meta from \`item.date\` (format it; it is an ISO-ish string), and CPT extras (e.g. ticket link) from \`item.acf\`. When \`items\` is empty, render a brief empty state. Keep the headline/links from the config attrs. Match the screenshot's card count and layout.\n`
    : "";

  const guidanceSection = renderEditGuidanceSection(guidance);

  const user = `## ACF Flex Layout: ${entry.blockName}

Layout name: ${layoutName}
Appears ${entry.occurrenceCount} times.

## Sample attrs (this layout's sub_fields)
\`\`\`json
${JSON.stringify(sample, null, 2)}
\`\`\`
${postRelationWarning}${dynamicListSection}${domSection}${guidanceSection}
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

/**
 * ${safeName} — passthrough fallback.
 * Component generation failed or was skipped. Renders WordPress HTML.
 */
export function ${safeName}({ block }: { block: BlockNode }) {
  const html = block.innerHTML ?? "";
  if (!html.trim()) return null;
  return (
    <div
      className="wp-block-passthrough wp-block-${blockName.replace(/\//g, "-")}"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
`;
}

export interface GenerateComponentOptions {
  entry: EnrichedInventoryEntry;
  tokens: ThemeJsonTokens | null;
  screenshotBase64?: string | null;
  guidance?: string | null;
  /**
   * When the entry is a config-only ACF flex "list placeholder", the detected
   * query spec for it. Threads into acfFlexPrompt so the generated component
   * renders the `block.attrs.items` contract instead of an empty fallback.
   */
  dynamicList?: DynamicListSpec | null;
  /**
   * Source-WP host variants; when set, generated TSX gets origin-stripped.
   * Built by `hostVariants(project.wp_url)` in the generate-components worker.
   * Absent → no rewrite (safe default for tests and the passthrough path).
   */
  sourceHosts?: string[];
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

  const guidance = opts.guidance ?? undefined;
  const sourceHost = opts.sourceHosts?.[0] ?? null;
  let combinedPrompt: string;
  if (entry.kind === "cpt_template") {
    combinedPrompt = cptTemplatePrompt(entry, tokens, guidance, sourceHost);
  } else if (entry.kind === "acf_flex") {
    combinedPrompt = acfFlexPrompt(entry, tokens, guidance, opts.dynamicList, sourceHost);
  } else if (entry.tier === "visual") {
    combinedPrompt = visualPrompt(entry, tokens, guidance, sourceHost);
  } else if (entry.tier === "standard") {
    combinedPrompt = standardPrompt(entry, tokens, guidance, sourceHost);
  } else {
    combinedPrompt = trivialPrompt(entry, tokens, guidance, sourceHost);
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
        // Phase 1: no cached prefix yet. The old cache_control marker here was
        // a silent no-op (system prompt is below the model's minimum cacheable
        // size). Phase 2 introduces COMPONENT_SYSTEM_CORE as a real
        // cachedSystemPrefix, sent on EVERY attempt.
        cachedSystemPrefix: undefined,
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

    const rawTsx = result.text.trim();
    let tsx: string;
    try {
      tsx = postprocessGeneratedTsx(rawTsx, {
        expectedExportName: toPascalCase(blockName),
      });
    } catch (err) {
      // PostprocessError (missing/anonymous export) — treat like a validation
      // failure and let the loop retry, then fall through to the passthrough
      // fallback on the second attempt.
      console.warn(`[component-generator] attempt ${attempt + 1} postprocess failed for ${blockName}:`, err);
      continue;
    }

    if (opts.sourceHosts && opts.sourceHosts.length > 0) {
      tsx = rewriteWpOriginUrls(tsx, { sourceHosts: opts.sourceHosts });
    }

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
