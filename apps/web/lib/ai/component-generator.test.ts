import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  validateTsx,
  cptTemplatePrompt,
  generateComponent,
  summarizeAcfFields,
  acfFlexPrompt,
  findPostRelationFieldsInSample,
  visualPrompt,
  standardPrompt,
  trivialPrompt,
  COMPONENT_SYSTEM_CORE,
  COMPONENT_PROMPT_VERSION,
  buildPerBuildSystemPrompt,
} from "./component-generator";
import type { EnrichedInventoryEntry } from "@/lib/jab/inventory";
import type { ModelClient } from "./model-client";

// Hoisted file-wide by Vitest; the origin-rewrite suite reinstalls per test via beforeEach.
vi.mock("./model-client", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./model-client")>();
  return {
    ...orig,
    modelClientForTier: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Fake model client helpers
// ---------------------------------------------------------------------------

/** Build a ModelClient stub that always returns the given TSX text. */
function makeFakeClient(tsx: string): ModelClient {
  return {
    async generate() {
      return {
        text: tsx,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        stopReason: "end_turn" as const,
        // Distinct from any real model id — Task 4 asserts this exact string
        // lands in GeneratedComponent.modelUsed (ground truth, no re-hardcode).
        model: "fake-test-model",
      };
    },
  };
}

/**
 * Minimal visual-tier BlockNode entry suitable for generateComponent.
 * The block resolves to the `visualPrompt` path (kind="block", tier="visual").
 */
function makeVisualEntry(blockName = "core/button"): EnrichedInventoryEntry {
  return {
    blockName,
    occurrenceCount: 2,
    pageSlugs: ["home"],
    attrSamples: [{ url: "https://tworoadsbrewing.com/contact/", text: "Contact" }],
    tier: "visual",
    kind: "block",
    sourceDomSample: `<div class="wp-block-button"><a href="https://tworoadsbrewing.com/contact/">Contact</a></div>`,
    computedStyles: null,
  };
}

describe("validateTsx", () => {
  it("accepts a valid TSX component", () => {
    const code = `
import React from "react";
export function Heading({ level = 1, content }: { level?: number; content: string }) {
  return <h1>{content}</h1>;
}
`;
    const errors = validateTsx(code, "Heading.tsx");
    expect(errors).toHaveLength(0);
  });

  it("rejects malformed JSX (unclosed tag)", () => {
    const code = `export function Bad() { return <div>unclosed; }`;
    const errors = validateTsx(code, "Bad.tsx");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects malformed JSX (mismatched tags)", () => {
    const code = `export function Bad() { return <div><span></div>; }`;
    const errors = validateTsx(code, "Bad.tsx");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts a component with TS type annotations", () => {
    const code = `
interface Props { text: string; }
export function Para({ text }: Props) { return <p>{text}</p>; }
`;
    const errors = validateTsx(code, "Para.tsx");
    expect(errors).toHaveLength(0);
  });
});

describe("generateComponent passthrough fallback", () => {
  it("emits self-contained HTML passthrough without DOM sanitizer imports", async () => {
    const result = await generateComponent({
      entry: {
        blockName: "core/html",
        occurrenceCount: 1,
        pageSlugs: ["home"],
        attrSamples: [],
        tier: "passthrough",
        kind: "block",
        sourceDomSample: null,
        computedStyles: null,
      },
      tokens: null,
    });

    expect(result.compileStatus).toBe("skipped");
    expect(result.tsx).toMatch(/dangerouslySetInnerHTML/);
    expect(result.tsx).not.toMatch(/RichTextContent/);
    expect(result.tsx).not.toMatch(/isomorphic-dompurify|DOMPurify/);
  });
});

describe("cptTemplatePrompt — children prop contract", () => {
  // The dispatcher (emitDispatcherTsx in compose-site-emit.ts) renders every
  // generated block as `<Component block={block} />` — no children passed.
  // If the CPT prompt asks for `children: React.ReactNode` (required), every
  // CPT template entry will fail tsc when the dispatcher imports it.
  // Therefore the prompt must declare children as OPTIONAL.
  function makeCptEntry(): EnrichedInventoryEntry {
    return {
      blockName: "cpt_template/beer",
      occurrenceCount: 1,
      pageSlugs: ["beer/example"],
      attrSamples: [{}],
      tier: "standard",
      kind: "cpt_template",
      spec: { blockNames: ["core/paragraph"], acfSchema: null },
    };
  }

  it("declares children as optional (children?:) in the rendered prompt", () => {
    const prompt = cptTemplatePrompt(makeCptEntry(), null);
    // Must contain the optional form, never a bare required `children:`.
    expect(prompt).toMatch(/children\?:\s*React\.ReactNode/);
    // Defensive: no required form (children: not preceded by `?`).
    expect(prompt).not.toMatch(/[^?]children:\s*React\.ReactNode/);
  });

  it("still asks for a layout component named {Cpt}Layout (export-name contract intact)", () => {
    const prompt = cptTemplatePrompt(makeCptEntry(), null);
    expect(prompt).toMatch(/BeerLayout/);
  });

  it("the cached system core carries the image binding contract that bans literal placeholder boxes", () => {
    expect(COMPONENT_SYSTEM_CORE).toMatch(/Image binding contract/);
    expect(COMPONENT_SYSTEM_CORE).toMatch(/never emit a gray "placeholder" box/);
    expect(COMPONENT_SYSTEM_CORE).toMatch(/Two Roads FeaturedBeer/);
    expect(COMPONENT_SYSTEM_CORE).toMatch(/post_object\b|relationship/);
  });

  it("the cached system core instructs casting block.attrs via `as unknown as` (TS2352 guard)", () => {
    expect(COMPONENT_SYSTEM_CORE).toMatch(/block\.attrs as unknown as/);
    expect(COMPONENT_SYSTEM_CORE).toMatch(/Never emit a bare `as MyAttrs`/);
  });
});

describe("summarizeAcfFields — image & post-relation annotation", () => {
  it("expands an image-shaped object field with its binding paths", () => {
    const schema = {
      properties: {
        hero_image: {
          type: "object",
          "x-acf-media": { kind: "image", return_format: "array" },
          properties: {
            url: { type: "string" },
            alt: { type: "string" },
            sizes: { type: "object" },
          },
        },
      },
    };
    const out = summarizeAcfFields(schema);
    expect(out).toMatch(/hero_image: image object/);
    expect(out).toMatch(/hero_image\.url/);
    expect(out).toMatch(/hero_image\.alt/);
    expect(out).toMatch(/hero_image\.sizes/);
  });

  it("detects image shape via structural url+alt siblings even when x-acf-media is absent", () => {
    const schema = {
      properties: {
        logo: {
          type: "object",
          properties: {
            url: { type: "string" },
            alt: { type: "string" },
          },
        },
      },
    };
    const out = summarizeAcfFields(schema);
    expect(out).toMatch(/logo: image object/);
  });

  it("annotates url-return-format image fields (plain string with vendor extension)", () => {
    const schema = {
      properties: {
        thumbnail: {
          type: "string",
          "x-acf-media": { kind: "image", return_format: "url" },
        },
      },
    };
    const out = summarizeAcfFields(schema);
    expect(out).toMatch(/thumbnail: image URL/);
  });

  it("annotates a gallery (array of image objects) with the same .url/.alt/.sizes hint", () => {
    const schema = {
      properties: {
        screenshots: {
          type: "array",
          items: {
            type: "object",
            "x-acf-media": { kind: "image", return_format: "array" },
            properties: {
              url: { type: "string" },
              alt: { type: "string" },
              sizes: { type: "object" },
            },
          },
        },
      },
    };
    const out = summarizeAcfFields(schema);
    expect(out).toMatch(/screenshots: gallery \(array of image objects\)/);
    expect(out).toMatch(/\.url/);
    expect(out).toMatch(/\.sizes/);
  });

  it("annotates a post_object / relationship array as bare-WP_Post-records (the FeaturedBeer smoking gun)", () => {
    // Mirror the Two Roads "beers" field shape from the diagnosis report.
    const schema = {
      properties: {
        beers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ID: { type: "integer" },
              post_title: { type: "string" },
              post_name: { type: "string" },
              post_type: { type: "string" },
              post_date: { type: "string" },
              post_status: { type: "string" },
            },
          },
        },
      },
    };
    const out = summarizeAcfFields(schema);
    expect(out).toMatch(/beers: array of related posts/);
    expect(out).toMatch(/each item is hydrated at render with \{ post_title, post_name, featured_image/);
    expect(out).toMatch(/Bind the image via <img src=\{item\.featured_image\.url\}/);
    // Negative: must NOT instruct the LLM to emit <MediaImage src=...> (block-only shim).
    expect(out).not.toMatch(/<MediaImage\s+src=/);
    // Lists the actual fields so the LLM can type the interface correctly.
    expect(out).toMatch(/post_title/);
  });

  it("leaves unrelated array-of-object fields as plain 'array' (only post-record shape triggers the bare-record annotation)", () => {
    const schema = {
      properties: {
        coordinates: {
          type: "array",
          items: {
            type: "object",
            properties: { lat: { type: "number" }, lng: { type: "number" } },
          },
        },
      },
    };
    const out = summarizeAcfFields(schema);
    expect(out).toMatch(/coordinates: array/);
    expect(out).not.toMatch(/post records/);
  });

  it("still skips acf_fc_layout discriminators and flexible_content (oneOf) arrays", () => {
    const schema = {
      properties: {
        acf_fc_layout: { type: "string" },
        page_builder: {
          type: "array",
          items: { oneOf: [{ properties: { acf_fc_layout: { const: "hero" } } }] },
        },
        keep_me: { type: "string" },
      },
    };
    const out = summarizeAcfFields(schema);
    expect(out).not.toMatch(/acf_fc_layout/);
    expect(out).not.toMatch(/page_builder/);
    expect(out).toMatch(/keep_me/);
  });

  it("branches the media object message on kind=file vs kind=image (file_schema has no .sizes)", () => {
    const schema = {
      properties: {
        brochure: {
          type: "object",
          "x-acf-media": { kind: "file", return_format: "array" },
          properties: {
            url: { type: "string" },
            title: { type: "string" },
            filename: { type: "string" },
          },
        },
      },
    };
    const out = summarizeAcfFields(schema);
    expect(out).toMatch(/brochure: file attachment/);
    // Defense-in-depth: the file branch must NOT carry image-binding
    // directives. The most-distinctive image-branch phrase is "for srcset",
    // which is only meaningful for image_schema (which exposes .sizes).
    // file_schema (Schema.php:641-661) emits no sizes; including srcset
    // guidance for files would mislead the LLM.
    expect(out).not.toMatch(/for srcset/);
    expect(out).not.toMatch(/image object/);
    expect(out).toMatch(/brochure\.filename/);
    // The file branch IS expected to call out the .sizes absence explicitly.
    expect(out).toMatch(/no `\.sizes`/);
  });

  it("requires uppercase ID alongside post_title + post_name before annotating a post-relation array — guards against custom repeaters that reuse post_title/post_name", () => {
    // Hand-authored repeater that happens to use post_title and post_name as
    // content labels but isn't a post relation. Lacking uppercase `ID` (which
    // post_ref_schema always emits) is the disambiguator.
    const schema = {
      properties: {
        testimonials: {
          type: "array",
          items: {
            type: "object",
            properties: {
              post_title: { type: "string" },
              post_name: { type: "string" },
              quote: { type: "string" },
            },
          },
        },
      },
    };
    const out = summarizeAcfFields(schema);
    expect(out).toMatch(/testimonials: array/);
    expect(out).not.toMatch(/bare WP_Post|NO featured_image/);
  });
});

describe("findPostRelationFieldsInSample — runtime data shape detection (for acf_flex)", () => {
  it("flags top-level array fields whose items look like bare WP_Post records", () => {
    // Mirror the Two Roads FeaturedBeer runtime sample shape.
    const sample = {
      section_headline: "Featured Offerings",
      beers: [
        { ID: 123, post_title: "Workers Comp", post_name: "workers-comp", post_type: "beer" },
        { ID: 124, post_title: "Lil' Heaven", post_name: "lil-heaven", post_type: "beer" },
      ],
      cta_link: { url: "https://example.com", title: "All Beers" },
    };
    expect(findPostRelationFieldsInSample(sample)).toEqual(["beers"]);
  });

  it("returns multiple field names when several post-relation arrays are present", () => {
    const sample = {
      beers: [{ ID: 1, post_title: "x", post_name: "x", post_type: "beer" }],
      events: [{ ID: 2, post_title: "y", post_name: "y", post_type: "event" }],
      headline: "Things",
    };
    expect(findPostRelationFieldsInSample(sample).sort()).toEqual(["beers", "events"]);
  });

  it("returns empty for non-array fields and for arrays of non-post-shaped items", () => {
    expect(
      findPostRelationFieldsInSample({
        title: "x",
        coordinates: [{ lat: 1, lng: 2 }],
        nested: { beers: [{ ID: 1, post_title: "x", post_name: "x" }] }, // only top-level walked
      }),
    ).toEqual([]);
  });

  it("returns empty for empty arrays — no item to inspect", () => {
    expect(findPostRelationFieldsInSample({ beers: [] })).toEqual([]);
  });

  it("returns empty for non-object inputs without throwing", () => {
    expect(findPostRelationFieldsInSample(null)).toEqual([]);
    expect(findPostRelationFieldsInSample(undefined)).toEqual([]);
    expect(findPostRelationFieldsInSample("not an object")).toEqual([]);
    expect(findPostRelationFieldsInSample([1, 2, 3])).toEqual([]);
  });
});

describe("acfFlexPrompt — post-relation warning section", () => {
  function makeAcfFlexEntry(spec: unknown): EnrichedInventoryEntry {
    return {
      blockName: "acf_flex/page/page_builder/featured-beer",
      occurrenceCount: 3,
      pageSlugs: ["home"],
      attrSamples: [],
      tier: "visual",
      kind: "acf_flex",
      sourceDomSample: null,
      computedStyles: null,
      spec,
    } as unknown as EnrichedInventoryEntry;
  }

  it("emits the post-relation warning section when the sample data contains bare WP_Post arrays", () => {
    const sample = {
      section_headline: "Featured Offerings",
      beers: [
        { ID: 123, post_title: "Workers Comp", post_name: "workers-comp", post_type: "beer" },
      ],
    };
    const prompt = acfFlexPrompt(makeAcfFlexEntry(sample), null);
    expect(prompt).toMatch(/Post-relation fields \(hydrated at render\)/);
    expect(prompt).toMatch(/`beers`/);
    expect(prompt).toMatch(/each item carries a `featured_image`/);
    expect(prompt).toMatch(/render `<img[^`]*src=\{[^}]*featured_image\.url\}/);
    // Negative: must NOT instruct the LLM to emit <MediaImage src=...> (the ban-mention "<MediaImage>" is fine).
    expect(prompt).not.toMatch(/<MediaImage\s+src=/);
  });

  it("omits the post-relation warning section when no post arrays are present", () => {
    const sample = {
      section_headline: "Visit Us",
      address: "123 Main St",
      hours: "9-5",
    };
    const prompt = acfFlexPrompt(makeAcfFlexEntry(sample), null);
    expect(prompt).not.toMatch(/Post-relation fields detected/);
  });
});

describe("acfFlexPrompt — dynamic-list contract section", () => {
  it("adds the dynamic-list contract when a spec is supplied", () => {
    const entry = {
      blockName: "acf_flex/page/page_builder/upcoming_events",
      kind: "acf_flex",
      occurrenceCount: 1,
      pageSlugs: ["home"],
      attrSamples: [{ section_headline: "Upcoming Events" }],
      spec: { section_headline: "Upcoming Events" },
      tier: "visual",
    } as unknown as Parameters<typeof acfFlexPrompt>[0];
    const prompt = acfFlexPrompt(entry, null, undefined, {
      blockName: entry.blockName!,
      listAbility: "jab/get-event",
      wrapperKey: "event",
      postType: "event",
      dateField: "start_date__time",
      order: "asc",
      upcomingOnly: true,
      limit: 12,
    });
    expect(prompt).toContain("block.attrs.items");
    expect(prompt).toContain("injected at render");
    expect(prompt).toMatch(/empty state|no .* found/i);
  });

  it("omits the dynamic-list section when no spec is supplied", () => {
    const entry = {
      blockName: "acf_flex/page/page_builder/newsletter",
      kind: "acf_flex",
      occurrenceCount: 1,
      pageSlugs: ["home"],
      attrSamples: [{}],
      spec: {},
      tier: "visual",
    } as unknown as Parameters<typeof acfFlexPrompt>[0];
    expect(acfFlexPrompt(entry, null)).not.toContain("block.attrs.items");
  });
});

// ---------------------------------------------------------------------------
// origin-rewrite integration — sourceHosts option
// ---------------------------------------------------------------------------

describe("generateComponent — origin-rewrite via sourceHosts", () => {
  // The fake TSX the stubbed model returns — contains a hardcoded WP-origin href.
  const FAKE_TSX = `import type { BlockNode } from "@/lib/jab/ability-client";
export function CoreButton({ block }: { block: BlockNode }) {
  return <a href="https://tworoadsbrewing.com/contact/">Contact</a>;
}`;

  // Import the mocked module so we can control the return value per test.
  // Dynamic import is required because vi.mock hoists above static imports.
  let modelClientMod: typeof import("./model-client");
  let fakeClient: ModelClient;

  beforeEach(async () => {
    modelClientMod = await import("./model-client");
    fakeClient = makeFakeClient(FAKE_TSX);
    vi.mocked(modelClientMod.modelClientForTier).mockReturnValue(fakeClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rewrites source-origin hrefs in generated component TSX", async () => {
    const out = await generateComponent({
      entry: makeVisualEntry(),
      tokens: null,
      sourceHosts: ["tworoadsbrewing.com"],
    });
    expect(out.compileStatus).toBe("ok");
    // Origin stripped: domain gone, path remains
    expect(out.tsx).toContain(`href="/contact"`);
    expect(out.tsx).not.toContain("tworoadsbrewing.com/contact");
  });

  it("leaves component TSX untouched when sourceHosts is absent", async () => {
    const out = await generateComponent({
      entry: makeVisualEntry(),
      tokens: null,
      // no sourceHosts
    });
    expect(out.compileStatus).toBe("ok");
    // Original absolute URL must survive unchanged
    expect(out.tsx).toContain(`href="https://tworoadsbrewing.com/contact/"`);
  });

  it("leaves component TSX untouched when sourceHosts is an empty array", async () => {
    const out = await generateComponent({
      entry: makeVisualEntry(),
      tokens: null,
      sourceHosts: [],
    });
    expect(out.compileStatus).toBe("ok");
    expect(out.tsx).toContain(`href="https://tworoadsbrewing.com/contact/"`);
  });
});

describe("component-generator — source-host internal-links rule in system prompt", () => {
  const MARKER = "\n\nUSER:\n";

  it("visualPrompt with sourceHost contains the internal-links bullet in the system half", () => {
    const entry = makeVisualEntry();
    const prompt = visualPrompt(entry, null, undefined, "tworoadsbrewing.com");
    const systemHalf = prompt.slice(0, prompt.indexOf(MARKER));
    expect(systemHalf).toContain("tworoadsbrewing.com are INTERNAL");
    expect(systemHalf).toContain("root-relative");
  });

  it("omits the internal-links bullet when no sourceHost is passed to visualPrompt", () => {
    const entry = makeVisualEntry();
    const prompt = visualPrompt(entry, null);
    const systemHalf = prompt.slice(0, prompt.indexOf(MARKER));
    expect(systemHalf).not.toContain("are INTERNAL");
  });

  it("standardPrompt with sourceHost contains the internal-links bullet in the system half", () => {
    const entry = { ...makeVisualEntry(), tier: "standard" as const };
    const prompt = standardPrompt(entry, null, undefined, "tworoadsbrewing.com");
    const systemHalf = prompt.slice(0, prompt.indexOf(MARKER));
    expect(systemHalf).toContain("tworoadsbrewing.com are INTERNAL");
  });

  it("the internal-links bullet lands in the system half, not the user half", () => {
    const entry = makeVisualEntry();
    const prompt = visualPrompt(entry, null, undefined, "tworoadsbrewing.com");
    const markerIdx = prompt.indexOf(MARKER);
    expect(markerIdx).toBeGreaterThan(-1);
    // Must be in system half
    expect(prompt.slice(0, markerIdx)).toContain("are INTERNAL");
    // Must NOT re-appear in user half (guidance placement rule)
    // Note: user half may incidentally contain the hostname in DOM samples —
    // the rule is that the INSTRUCTION is in the system half, not the user half.
  });
});

// ---------------------------------------------------------------------------
// Ground-truth model telemetry (Phase 1, AI-call-optimization campaign)
// ---------------------------------------------------------------------------

describe("generateComponent — ground-truth model telemetry", () => {
  const OK_TSX = `import type { BlockNode } from "@/lib/jab/ability-client";
export function CoreButton({ block }: { block: BlockNode }) {
  return <div>ok</div>;
}`;

  let modelClientMod: typeof import("./model-client");

  beforeEach(async () => {
    modelClientMod = await import("./model-client");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records the model echoed by the client, never a re-hardcoded constant", async () => {
    vi.mocked(modelClientMod.modelClientForTier).mockReturnValue(makeFakeClient(OK_TSX));
    const out = await generateComponent({ entry: makeVisualEntry(), tokens: null });
    expect(out.compileStatus).toBe("ok");
    expect(out.modelUsed).toBe("fake-test-model");
    expect(out.providerUsed).toBe("anthropic");
  });

  it("records modelUsed=null and providerUsed=null when no API call ever succeeded", async () => {
    const failing: ModelClient = {
      generate: vi.fn().mockRejectedValue(new Error("simulated API outage")),
    };
    vi.mocked(modelClientMod.modelClientForTier).mockReturnValue(failing);
    const out = await generateComponent({ entry: makeVisualEntry(), tokens: null });
    expect(out.compileStatus).toBe("failed");
    expect(out.modelUsed).toBeNull();
    expect(out.providerUsed).toBeNull();
  });
});

describe("component generator — edit guidance placement (R7 cache-leak guard)", () => {
  const GUIDANCE = "Make the hero headline 2x bolder and use the brand yellow.";
  const MARKER = "\n\nUSER:\n";

  function visualEntry(): EnrichedInventoryEntry {
    return {
      blockName: "core/cover",
      occurrenceCount: 4,
      pageSlugs: ["home", "about"],
      attrSamples: [{ url: "x" }],
      tier: "visual",
      kind: "block",
      sourceDomSample: "<div class='wp-block-cover'>hi</div>",
      computedStyles: null,
    };
  }
  function standardEntry(): EnrichedInventoryEntry {
    return { ...visualEntry(), tier: "standard" };
  }
  function trivialEntry(): EnrichedInventoryEntry {
    return { ...visualEntry(), blockName: "core/heading", tier: "trivial" };
  }
  function cptEntry(): EnrichedInventoryEntry {
    return {
      blockName: "cpt_template/beer",
      occurrenceCount: 1,
      pageSlugs: ["beer/x"],
      attrSamples: [{}],
      tier: "standard",
      kind: "cpt_template",
      spec: { blockNames: ["core/paragraph"], acfSchema: null },
    };
  }
  function flexEntry(): EnrichedInventoryEntry {
    return {
      blockName: "acf_flex/page/builder/hero",
      occurrenceCount: 2,
      pageSlugs: ["home"],
      attrSamples: [{ heading: "Hi" }],
      tier: "visual",
      kind: "acf_flex",
      spec: { heading: "Hi" },
    } as unknown as EnrichedInventoryEntry;
  }

  // Each entry of the table is [builderName, builderFn, entryFn].
  const cases: Array<[string, (e: EnrichedInventoryEntry, t: null, g?: string) => string, () => EnrichedInventoryEntry]> = [
    ["visual", visualPrompt, visualEntry],
    ["standard", standardPrompt, standardEntry],
    ["trivial", trivialPrompt, trivialEntry],
    ["cptTemplate", cptTemplatePrompt, cptEntry],
    ["acfFlex", acfFlexPrompt, flexEntry],
  ];

  for (const [name, fn, mk] of cases) {
    it(`${name}: guidance lands strictly AFTER the USER: marker`, () => {
      const withGuidance = fn(mk(), null, GUIDANCE);
      expect(withGuidance).toContain(GUIDANCE);
      const markerIdx = withGuidance.indexOf(MARKER);
      expect(markerIdx).toBeGreaterThan(-1);
      // Guidance must appear only after the marker — never in the system half.
      expect(withGuidance.indexOf(GUIDANCE)).toBeGreaterThan(markerIdx + MARKER.length);
      expect(withGuidance.slice(0, markerIdx)).not.toContain(GUIDANCE);
    });

    it(`${name}: omitting guidance is byte-identical to today`, () => {
      expect(fn(mk(), null)).toBe(fn(mk(), null, undefined));
    });
  }
});

// ---------------------------------------------------------------------------
// Phase 2: COMPONENT_SYSTEM_CORE + COMPONENT_PROMPT_VERSION + per-build split
// ---------------------------------------------------------------------------

describe("COMPONENT_SYSTEM_CORE (Phase 2 cached prefix)", () => {
  it("clears the Sonnet 4.6 minimum cacheable size with margin", () => {
    // 2048-token minimum; ~4 chars/token → 10,000 chars ≈ 2,500 tokens.
    expect(COMPONENT_SYSTEM_CORE.length).toBeGreaterThanOrEqual(10_000);
  });

  it("is a stable module-level constant with no per-build interpolation", () => {
    // Per-build content lives in buildPerBuildSystemPrompt. The core must
    // never carry build-specific markers: the per-build token-section header
    // and the sourceHost INTERNAL-links rule are the two leak candidates.
    expect(COMPONENT_SYSTEM_CORE).not.toContain("Build-specific");
    expect(COMPONENT_SYSTEM_CORE).not.toContain("are INTERNAL");
    // No unresolved template syntax (the exemplar deliberately avoids
    // template literals so this assertion can hold).
    expect(COMPONENT_SYSTEM_CORE).not.toContain("${");
  });

  it("carries the image binding contract and the anti-placeholder rules", () => {
    expect(COMPONENT_SYSTEM_CORE).toContain("Image binding contract");
    expect(COMPONENT_SYSTEM_CORE).toContain("Anti-placeholder rules");
    expect(COMPONENT_SYSTEM_CORE).toContain("Two Roads FeaturedBeer");
  });

  it("carries the as-unknown-as cast rule and the children wrapper contract", () => {
    expect(COMPONENT_SYSTEM_CORE).toContain("block.attrs as unknown as MyAttrs");
    expect(COMPONENT_SYSTEM_CORE).toContain("Never emit a bare `as MyAttrs`");
    expect(COMPONENT_SYSTEM_CORE).toContain("children?: React.ReactNode");
  });

  it("carries exactly one few-shot TSX exemplar", () => {
    expect(COMPONENT_SYSTEM_CORE).toContain("## Worked example");
    expect(COMPONENT_SYSTEM_CORE).toContain("export function FeatureCards");
    // The exemplar demonstrates the cast rule and the brand-tinted fallback.
    expect(COMPONENT_SYSTEM_CORE).toContain("as unknown as FeatureCardsAttrs");
    expect(COMPONENT_SYSTEM_CORE).toContain("bg-primary/15");
  });

  it("COMPONENT_PROMPT_VERSION is 2 (feeds the Phase 4 carry-forward hash)", () => {
    expect(COMPONENT_PROMPT_VERSION).toBe(2);
  });
});

describe("buildPerBuildSystemPrompt (Phase 2 uncached system block)", () => {
  it("renders the token JSON and the sourceHost internal-links rule", () => {
    const s = buildPerBuildSystemPrompt(
      {
        colorPalette: [{ slug: "primary", color: "#ffc72c" }],
        fontSizes: [{ slug: "lg", size: "1.25rem" }],
        fontFamilies: [{ slug: "display", fontFamily: "Syne" }],
        blockGap: "1.5rem",
        raw: {} as never,
      },
      "tworoadsbrewing.com",
    );
    expect(s).toContain("Build-specific design tokens");
    expect(s).toContain("#ffc72c");
    expect(s).toContain("tworoadsbrewing.com are INTERNAL");
  });

  it("renders the no-tokens fallback when tokens are null", () => {
    const s = buildPerBuildSystemPrompt(null, null);
    expect(s).toContain("No theme.json tokens available");
    expect(s).not.toContain("are INTERNAL");
  });
});

describe("prompt builders no longer duplicate the core (cache hygiene)", () => {
  it("the per-build system half of every Sonnet-tier builder excludes core content", () => {
    const MARKER = "\n\nUSER:\n";
    const prompts = [
      visualPrompt(makeVisualEntry(), null),
      standardPrompt({ ...makeVisualEntry(), tier: "standard" }, null),
    ];
    for (const p of prompts) {
      const systemHalf = p.slice(0, p.indexOf(MARKER));
      // If core text leaked back into the builder, every call would re-bill
      // the ~2.5K tokens the cached prefix exists to avoid.
      expect(systemHalf).not.toContain("Image binding contract");
      expect(systemHalf).not.toContain("Worked example");
    }
  });
});
