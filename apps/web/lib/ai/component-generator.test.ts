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
  buildRetryUserSuffix,
  buildComponentRequestParts,
  finalizeBatchGeneration,
  failedBatchComponent,
  addUsage,
  mergeUsageIntoComponent,
  ZERO_GENERATE_USAGE,
} from "./component-generator";
import type { EnrichedInventoryEntry } from "@/lib/jab/inventory";
import { modelClientForTier, type ModelClient } from "./model-client";

// Hoisted file-wide by Vitest; the origin-rewrite suite reinstalls per test via beforeEach.
vi.mock("./model-client", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./model-client")>();
  return {
    ...orig,
    modelClientForTier: vi.fn(),
  };
});

// Delegating wrappers: tests that never throw are unaffected; the Phase 2
// retry-loop suite overrides per test to drive fail-fast vs retry decisions.
vi.mock("./errors", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./errors")>();
  return {
    ...orig,
    classifyAiError: vi.fn(orig.classifyAiError),
    isRetryableAiFailure: vi.fn(orig.isRetryableAiFailure),
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

describe("generateComponent — Classic-content (__null__) wrapper", () => {
  it("emits an editable ClassicContent component for the __null__ block", async () => {
    const result = await generateComponent({
      entry: {
        blockName: null,
        tier: "classic",
        occurrenceCount: 3,
        pageSlugs: ["about"],
        attrSamples: [],
      } as never,
      tokens: null,
    });
    expect(result.blockName).toBe("__null__");
    expect(result.compileStatus).toBe("ok");
    expect(result.tsx).toContain("export function ClassicContent");
    expect(result.tsx).toContain("<Passthrough");
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
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
    // never carry build-specific markers: the per-build token-section HEADER
    // ("## Build-specific design tokens") and the sourceHost INTERNAL-links
    // rule are the two leak candidates. Note: the core legitimately contains
    // the lowercase prose "build-specific design-token section" as a forward
    // reference to the next system block — only the header is banned.
    expect(COMPONENT_SYSTEM_CORE).not.toContain("## Build-specific design tokens");
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

  it("COMPONENT_PROMPT_VERSION is 3 (feeds the Phase 4 carry-forward hash)", () => {
    expect(COMPONENT_PROMPT_VERSION).toBe(3);
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
    // Entry shapes mirror the existing cptTemplatePrompt / acfFlexPrompt suites.
    const cptEntry: EnrichedInventoryEntry = {
      blockName: "cpt_template/beer",
      occurrenceCount: 1,
      pageSlugs: ["beer/example"],
      attrSamples: [{}],
      tier: "standard",
      kind: "cpt_template",
      spec: { blockNames: ["core/paragraph"], acfSchema: null },
    };
    const flexEntry = {
      blockName: "acf_flex/page/builder/hero",
      occurrenceCount: 2,
      pageSlugs: ["home"],
      attrSamples: [{ heading: "Hi" }],
      tier: "visual",
      kind: "acf_flex",
      spec: { heading: "Hi" },
    } as unknown as EnrichedInventoryEntry;
    const prompts = [
      visualPrompt(makeVisualEntry(), null),
      standardPrompt({ ...makeVisualEntry(), tier: "standard" }, null),
      cptTemplatePrompt(cptEntry, null),
      acfFlexPrompt(flexEntry, null),
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

describe("buildRetryUserSuffix (Phase 2 corrective retry)", () => {
  it("renders the header, at most 3 diagnostics, and the output tail", () => {
    const s = buildRetryUserSuffix(["e1", "e2", "e3", "e4", "e5"], "x".repeat(800));
    expect(s).toContain("## Previous attempt failed validation");
    expect(s).toContain("- e1");
    expect(s).toContain("- e3");
    expect(s).not.toContain("- e4");
    // tail clamped to the LAST ~500 chars
    expect(s).toContain("x".repeat(500));
    expect(s).not.toContain("x".repeat(501));
  });

  it("handles an empty diagnostics list and empty tail without throwing", () => {
    const s = buildRetryUserSuffix([], "");
    expect(s).toContain("## Previous attempt failed validation");
    expect(s).toContain("no parser diagnostics");
  });

  it("takes the tail from the END of the output, not the head", () => {
    // 508 chars total: a head-anchored slice(0, 500) would keep HEAD and
    // drop TAIL; the end-anchored slice(-500) must do the opposite.
    const s = buildRetryUserSuffix(["e1"], "HEAD" + "m".repeat(500) + "TAIL");
    expect(s).toContain("TAIL");
    expect(s).not.toContain("HEAD");
  });

  it("strips standalone fence lines from the tail so the embedded block stays intact", () => {
    const s = buildRetryUserSuffix([], "const x = 1;\n```\nexport default x;");
    expect(s).toContain("const x = 1;");
    expect(s).toContain("export default x;");
    // the only fences present are the suffix's own opening/closing pair
    expect(s.match(/^```/gm)?.length).toBe(2);
  });
});

describe("generateComponent — Phase 2 retry loop", () => {
  const VALID_TSX = `import type { BlockNode } from "@/lib/jab/ability-client";
export function CoreButton({ block }: { block: BlockNode }) { return <a>ok</a>; }`;
  const BROKEN_TSX = `export function CoreButton() { return <div>unclosed; }`;

  type StopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "pause_turn" | "refusal" | null;
  function res(text: string, stopReason: StopReason = "end_turn", model = "fake-model-id") {
    return {
      text,
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason,
      model,
    };
  }

  let modelClientMod: typeof import("./model-client");
  let errorsMod: typeof import("./errors");
  let generateSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    modelClientMod = await import("./model-client");
    errorsMod = await import("./errors");
    generateSpy = vi.fn();
    vi.mocked(modelClientMod.modelClientForTier).mockReturnValue({ generate: generateSpy } as unknown as ModelClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the cached prefix on EVERY attempt and appends corrective feedback to attempt 2", async () => {
    generateSpy.mockResolvedValueOnce(res(BROKEN_TSX)).mockResolvedValueOnce(res(VALID_TSX));
    const out = await generateComponent({ entry: makeVisualEntry(), tokens: null });
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(generateSpy.mock.calls[0][0].cachedSystemPrefix).toBe(COMPONENT_SYSTEM_CORE);
    expect(generateSpy.mock.calls[1][0].cachedSystemPrefix).toBe(COMPONENT_SYSTEM_CORE);
    expect(generateSpy.mock.calls[0][0].userPrompt).not.toContain("## Previous attempt failed validation");
    expect(generateSpy.mock.calls[1][0].userPrompt).toContain("## Previous attempt failed validation");
    expect(out.compileStatus).toBe("ok");
    expect(out.compileAttemptCount).toBe(2);
    expect(out.failureKind).toBeNull();
  });

  it("max_tokens truncation retries ONCE with the cap raised 1.5x (visual: 8192 → 12288)", async () => {
    generateSpy
      .mockResolvedValueOnce(res("export function CoreButton() { return <div", "max_tokens"))
      .mockResolvedValueOnce(res(VALID_TSX));
    const out = await generateComponent({ entry: makeVisualEntry(), tokens: null });
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(generateSpy.mock.calls[0][0].maxTokens).toBeUndefined();
    expect(generateSpy.mock.calls[1][0].maxTokens).toBe(12288);
    expect(generateSpy.mock.calls[1][0].userPrompt).toContain("truncated");
    expect(out.compileStatus).toBe("ok");
  });

  it("max_tokens twice → passthrough with failureKind 'max_tokens', exactly 2 calls", async () => {
    generateSpy.mockResolvedValue(res("export function X() { return <div", "max_tokens"));
    const out = await generateComponent({ entry: makeVisualEntry(), tokens: null });
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(out.compileStatus).toBe("failed");
    expect(out.failureKind).toBe("max_tokens");
    expect(out.tsx).toContain("wp-block-passthrough");
  });

  it("max_tokens attempt 0 then validation-fail attempt 1 → failureKind 'invalid_tsx', raised cap applied", async () => {
    generateSpy
      .mockResolvedValueOnce(res("export function CoreButton() { return <div", "max_tokens"))
      .mockResolvedValueOnce(res(BROKEN_TSX));
    const out = await generateComponent({ entry: makeVisualEntry(), tokens: null });
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(generateSpy.mock.calls[1][0].maxTokens).toBe(12288);
    expect(out.compileStatus).toBe("failed");
    expect(out.failureKind).toBe("invalid_tsx");
  });

  it("bad_request fails fast — NO second attempt", async () => {
    generateSpy.mockRejectedValue(new Error("400 invalid image"));
    vi.mocked(errorsMod.classifyAiError).mockReturnValue("bad_request");
    vi.mocked(errorsMod.isRetryableAiFailure).mockReturnValue(false);
    const out = await generateComponent({ entry: makeVisualEntry(), tokens: null });
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(out.compileStatus).toBe("failed");
    expect(out.failureKind).toBe("bad_request");
    expect(out.modelUsed).toBeNull(); // nothing answered — no fictional model id
  });

  it("retryable API error (rate_limit) gets the second attempt", async () => {
    generateSpy.mockRejectedValueOnce(new Error("429")).mockResolvedValueOnce(res(VALID_TSX));
    vi.mocked(errorsMod.classifyAiError).mockReturnValue("rate_limit");
    vi.mocked(errorsMod.isRetryableAiFailure).mockReturnValue(true);
    const out = await generateComponent({ entry: makeVisualEntry(), tokens: null });
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(out.compileStatus).toBe("ok");
    expect(out.failureKind).toBeNull();
  });

  it("records the ground-truth model from the response, never a hardcoded constant", async () => {
    generateSpy.mockResolvedValue(res(VALID_TSX));
    const out = await generateComponent({ entry: makeVisualEntry(), tokens: null });
    expect(out.modelUsed).toBe("fake-model-id");
  });

  it("trivial tier passes NO cached prefix (Haiku 4096-token minimum — do not pad)", async () => {
    generateSpy.mockResolvedValue(res(VALID_TSX));
    await generateComponent({
      entry: { ...makeVisualEntry("core/heading"), tier: "trivial" },
      tokens: null,
    });
    expect(generateSpy.mock.calls[0][0].cachedSystemPrefix).toBeUndefined();
  });

  it("invalid TSX twice → failureKind 'invalid_tsx'", async () => {
    generateSpy.mockResolvedValue(res(BROKEN_TSX));
    const out = await generateComponent({ entry: makeVisualEntry(), tokens: null });
    expect(out.compileStatus).toBe("failed");
    expect(out.failureKind).toBe("invalid_tsx");
  });

  // -------------------------------------------------------------------------
  // Carried review tests (raised-cap scope, failed-row ground truth, last-model
  // wins). The raised-value half of the cap rule is pinned by the
  // "max_tokens truncation retries ONCE…" test above (calls[1][0].maxTokens
  // === 12288); this one pins the inverse: no raise without a truncation.
  // -------------------------------------------------------------------------

  it("a non-max_tokens failure does NOT raise maxTokens on the retry (raised cap is max_tokens-only)", async () => {
    generateSpy.mockResolvedValueOnce(res(BROKEN_TSX)).mockResolvedValueOnce(res(VALID_TSX));
    const out = await generateComponent({ entry: makeVisualEntry(), tokens: null });
    expect(generateSpy).toHaveBeenCalledTimes(2);
    expect(generateSpy.mock.calls[0][0].maxTokens).toBeUndefined();
    expect(generateSpy.mock.calls[1][0].maxTokens).toBeUndefined();
    expect(out.compileStatus).toBe("ok");
  });

  it("all-attempts-failed row still records the LAST response's model (ground truth) and providerUsed 'anthropic'", async () => {
    generateSpy
      .mockResolvedValueOnce(res(BROKEN_TSX, "end_turn", "claude-sonnet-4-6"))
      .mockResolvedValueOnce(res(BROKEN_TSX, "end_turn", "claude-sonnet-4-7"));
    const out = await generateComponent({ entry: makeVisualEntry(), tokens: null });
    expect(out.compileStatus).toBe("failed");
    expect(out.modelUsed).toBe("claude-sonnet-4-7");
    expect(out.providerUsed).toBe("anthropic");
  });

  it("a retry that answers with a DIFFERENT model records the retry's model, not the first attempt's", async () => {
    generateSpy
      .mockResolvedValueOnce(res(BROKEN_TSX, "end_turn", "claude-sonnet-4-6"))
      .mockResolvedValueOnce(res(VALID_TSX, "end_turn", "claude-sonnet-4-7"));
    const out = await generateComponent({ entry: makeVisualEntry(), tokens: null });
    expect(out.compileStatus).toBe("ok");
    expect(out.modelUsed).toBe("claude-sonnet-4-7");
  });
});

describe("buildComponentRequestParts — extraction equivalence", () => {
  it("returns exactly the prompt parts generateComponent passes to the client", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const fake: ModelClient = {
      async generate(opts) {
        captured.push(opts as unknown as Record<string, unknown>);
        return {
          text: `import type { BlockNode } from "@/lib/jab/ability-client";\n\nexport function CoreButton({ block }: { block: BlockNode }) {\n  return <a>{String(block.attrs.text ?? "")}</a>;\n}\n`,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
          stopReason: "end_turn",
          model: "claude-sonnet-4-6",
        };
      },
    };
    vi.mocked(modelClientForTier).mockReturnValue(fake);

    const opts = {
      entry: makeVisualEntry(),
      tokens: null,
      screenshotBase64: undefined,
      dynamicList: null,
      sourceHosts: ["tworoadsbrewing.com"],
    };
    await generateComponent(opts);
    expect(captured).toHaveLength(1);

    const parts = buildComponentRequestParts(opts);
    expect(captured[0].cachedSystemPrefix).toBe(parts.cachedSystemPrefix);
    expect(captured[0].systemPrompt).toBe(parts.systemPrompt);
    expect(captured[0].userPrompt).toBe(parts.userPrompt);
  });

  it("passes cachedSystemPrefix for Sonnet tiers and undefined for trivial (Phase 2 contract)", () => {
    const visual = buildComponentRequestParts({ entry: makeVisualEntry(), tokens: null });
    expect(typeof visual.cachedSystemPrefix).toBe("string");
    expect((visual.cachedSystemPrefix ?? "").length).toBeGreaterThanOrEqual(10_000);

    const trivialEntry = { ...makeVisualEntry("core/paragraph"), tier: "trivial" as const };
    const trivial = buildComponentRequestParts({ entry: trivialEntry, tokens: null });
    expect(trivial.cachedSystemPrefix).toBeUndefined();
  });

  it("screenshotBase64 is NOT part of ComponentRequestParts — batch consumers forward it separately", () => {
    const parts = buildComponentRequestParts({
      entry: makeVisualEntry(),
      tokens: null,
      screenshotBase64: "abc123",
    });
    expect(parts).not.toHaveProperty("screenshotBase64");
  });
});

// ---------------------------------------------------------------------------
// Phase 3 (batch): finalizeBatchGeneration + usage helpers
// ---------------------------------------------------------------------------

const VALID_TSX = `import type { BlockNode } from "@/lib/jab/ability-client";

export function CoreButton({ block }: { block: BlockNode }) {
  return <a className="btn">{String(block.attrs.text ?? "")}</a>;
}
`;

// Same shape as VALID_TSX but with a quoted source-origin URL so the
// rewrite-path identity test below exercises a rewrite that actually fires.
const VALID_TSX_WITH_ORIGIN_LINK = `import type { BlockNode } from "@/lib/jab/ability-client";

export function CoreButton({ block }: { block: BlockNode }) {
  return (
    <a className="btn" href="https://tworoadsbrewing.com/contact/">
      {String(block.attrs.text ?? "")}
    </a>
  );
}
`;

const USAGE = { inputTokens: 1200, outputTokens: 600, cacheReadTokens: 0, cacheCreationTokens: 0 };

describe("finalizeBatchGeneration", () => {
  it("produces a GeneratedComponent DEEP-EQUAL to the sync path's for the same model output (persisted-row identity)", async () => {
    // Sync side: generateComponent with a fake client returning VALID_TSX.
    const fake: ModelClient = {
      async generate() {
        return { text: VALID_TSX, usage: { ...USAGE }, stopReason: "end_turn", model: "claude-sonnet-4-6" };
      },
    };
    vi.mocked(modelClientForTier).mockReturnValue(fake);
    const opts = { entry: makeVisualEntry(), tokens: null, sourceHosts: ["tworoadsbrewing.com"] };
    const syncComponent = await generateComponent(opts);
    expect(syncComponent.compileStatus).toBe("ok");

    // Batch side: identical inputs through finalizeBatchGeneration.
    const outcome = finalizeBatchGeneration({
      entry: opts.entry,
      text: VALID_TSX,
      usage: { ...USAGE },
      stopReason: "end_turn",
      model: "claude-sonnet-4-6",
      attemptCount: 1,
      sourceHosts: opts.sourceHosts,
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");

    // Field-for-field identity — persistGeneration maps this object 1:1 into
    // the block_inventory row, so object identity ⇒ persisted-row identity.
    expect(Object.keys(outcome.component).sort()).toEqual(Object.keys(syncComponent).sort());
    expect(outcome.component).toEqual(syncComponent);
  });

  it("stays deep-equal to the sync path when the origin rewrite ACTUALLY fires (source-origin URL in the TSX)", async () => {
    // Sync side: generateComponent with a fake client returning TSX that
    // contains a quoted source-origin URL — rewriteWpOriginUrls must transform
    // it on both paths, not no-op as in the fixture above.
    const fake: ModelClient = {
      async generate() {
        return {
          text: VALID_TSX_WITH_ORIGIN_LINK,
          usage: { ...USAGE },
          stopReason: "end_turn",
          model: "claude-sonnet-4-6",
        };
      },
    };
    vi.mocked(modelClientForTier).mockReturnValue(fake);
    const opts = { entry: makeVisualEntry(), tokens: null, sourceHosts: ["tworoadsbrewing.com"] };
    const syncComponent = await generateComponent(opts);
    expect(syncComponent.compileStatus).toBe("ok");

    // Batch side: identical inputs through finalizeBatchGeneration.
    const outcome = finalizeBatchGeneration({
      entry: opts.entry,
      text: VALID_TSX_WITH_ORIGIN_LINK,
      usage: { ...USAGE },
      stopReason: "end_turn",
      model: "claude-sonnet-4-6",
      attemptCount: 1,
      sourceHosts: opts.sourceHosts,
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");

    // The rewrite genuinely fired on BOTH sides: the source origin is gone
    // and the href is now root-relative (trailing slash normalized away).
    expect(syncComponent.tsx).not.toContain("tworoadsbrewing.com");
    expect(outcome.component.tsx).not.toContain("tworoadsbrewing.com");
    expect(outcome.component.tsx).toContain(`href="/contact"`);

    expect(outcome.component).toEqual(syncComponent);
  });

  it("returns a retry descriptor with diagnostics + tail on TSX validation failure", () => {
    const outcome = finalizeBatchGeneration({
      entry: makeVisualEntry(),
      text: "export function CoreButton() { return <div>unclosed; }",
      usage: { ...USAGE },
      stopReason: "end_turn",
      model: "claude-sonnet-4-6",
      attemptCount: 1,
    });
    expect(outcome.kind).toBe("retry");
    if (outcome.kind !== "retry") throw new Error("unreachable");
    expect(outcome.reason).toBe("validation");
    expect(outcome.errors.length).toBeGreaterThan(0);
    expect(outcome.errors.length).toBeLessThanOrEqual(3);
    expect(outcome.outputTail.length).toBeLessThanOrEqual(500);
  });

  it("returns reason 'max_tokens' on a truncated stop_reason without attempting validation", () => {
    const outcome = finalizeBatchGeneration({
      entry: makeVisualEntry(),
      text: VALID_TSX,
      usage: { ...USAGE },
      stopReason: "max_tokens",
      model: "claude-sonnet-4-6",
      attemptCount: 1,
    });
    expect(outcome).toMatchObject({ kind: "retry", reason: "max_tokens" });
  });

  it("merges priorUsage into the ok component's accumulated usage", () => {
    const outcome = finalizeBatchGeneration({
      entry: makeVisualEntry(),
      text: VALID_TSX,
      usage: { ...USAGE },
      stopReason: "end_turn",
      model: "claude-sonnet-4-6",
      attemptCount: 2,
      priorUsage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5 },
    });
    if (outcome.kind !== "ok") throw new Error("expected ok");
    expect(outcome.component.inputTokens).toBe(1300);
    expect(outcome.component.outputTokens).toBe(650);
    expect(outcome.component.cacheReadTokens).toBe(10);
    expect(outcome.component.cacheCreationTokens).toBe(5);
    expect(outcome.component.compileAttemptCount).toBe(2);
  });
});

describe("failedBatchComponent / mergeUsageIntoComponent", () => {
  it("builds a failed passthrough component carrying usage + failureKind", () => {
    const c = failedBatchComponent({
      entry: makeVisualEntry(),
      usage: { ...USAGE },
      attemptCount: 1,
      failureKind: "bad_request",
      model: "claude-sonnet-4-6",
    });
    expect(c.compileStatus).toBe("failed");
    expect(c.tsx).toMatch(/wp-block-passthrough/); // passthroughFallback marker class
    expect(c.inputTokens).toBe(1200);
    expect(c.failureKind).toBe("bad_request");
    // A real model id means Anthropic actually processed the request.
    expect(c.providerUsed).toBe("anthropic");
  });

  it("does NOT attribute providerUsed to Anthropic when no model answered (canceled/expired rows)", () => {
    // mapBatchRow yields model "" for errored AND canceled/expired rows;
    // canceled/expired were never processed by Anthropic, so attribution
    // must gate on a real model id — mirroring the sync tail's
    // `modelUsed ? "anthropic" : null`.
    const noModel = failedBatchComponent({
      entry: makeVisualEntry(),
      usage: { ...ZERO_GENERATE_USAGE },
      attemptCount: 1,
      failureKind: "unknown",
      model: null,
    });
    expect(noModel.providerUsed).toBeNull();
    expect(noModel.modelUsed).toBeNull();

    const emptyModel = failedBatchComponent({
      entry: makeVisualEntry(),
      usage: { ...ZERO_GENERATE_USAGE },
      attemptCount: 1,
      failureKind: "unknown",
      model: "",
    });
    expect(emptyModel.providerUsed).toBeNull();
  });

  it("mergeUsageIntoComponent adds prior wave spend + attempts onto a sync-fallback result", async () => {
    const fake: ModelClient = {
      async generate() {
        return { text: VALID_TSX, usage: { ...USAGE }, stopReason: "end_turn", model: "claude-sonnet-4-6" };
      },
    };
    vi.mocked(modelClientForTier).mockReturnValue(fake);
    const sync = await generateComponent({ entry: makeVisualEntry(), tokens: null });
    const merged = mergeUsageIntoComponent(
      sync,
      { inputTokens: 7, outputTokens: 3, cacheReadTokens: 1, cacheCreationTokens: 1 },
      2,
    );
    expect(merged.inputTokens).toBe(sync.inputTokens + 7);
    expect(merged.compileAttemptCount).toBe(sync.compileAttemptCount + 2);
    expect(merged.compileStatus).toBe(sync.compileStatus);
  });
});

describe("block prompt — theme-class inventory + softened DOM directive + hex rule", () => {
  const entry = {
    blockName: "core/cover",
    kind: "block",
    tier: "visual",
    occurrenceCount: 3,
    pageSlugs: ["home"],
    attrSamples: [{}],
    sourceDomSample: `<div class="wp-block-cover hero-banner">x</div>`,
    computedStyles: null,
    spec: null,
  } as unknown as import("@/lib/jab/inventory").EnrichedInventoryEntry;

  const tokens = { colorPalette: [{ slug: "primary", color: "#ffc72c" }] };

  it("renders the SOFT theme-class inventory in the system half", () => {
    const p = visualPrompt(entry, tokens, undefined, null, ["hero-banner", "wp-block-cover"]);
    expect(p).toMatch(/hero-banner/);
    expect(p).toMatch(/PREFER/);
    expect(p).not.toMatch(/Inventing class names that appear in neither list is an error/);
  });

  it("no longer instructs the model to translate source classes to Tailwind", () => {
    const p = visualPrompt(entry, tokens, undefined, null, ["hero-banner"]);
    expect(p).not.toMatch(/Translate source class names to corresponding Tailwind classes/);
  });

  it("ports the shell's hex-match directive into the block token section", () => {
    const p = visualPrompt(entry, tokens, undefined, null, ["hero-banner"]);
    expect(p).toMatch(/Match by hex value, not by semantic name/);
  });
});
