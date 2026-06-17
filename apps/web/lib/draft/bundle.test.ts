import { describe, it, expect } from "vitest";
import { bundleDraftRuntime, draftComponentName } from "./bundle";
import { emitDispatcherTsx, emitPassthroughTsx } from "@/lib/jab/compose-site-emit";
import { CLASSIC_COMPONENT_NAME } from "@/lib/jab/classic-content";

const HERO_TSX = `import type { BlockNode } from "@/lib/sdk/types";
import Image from "next/image";

export function AcfHero({ block }: { block: BlockNode }) {
  const title = (block.attrs.title as string) ?? "Untitled";
  return (
    <section className="bg-primary px-4 py-16 text-4xl font-bold">
      <h1>{title}</h1>
      <Image src="/wp-content/uploads/hero.jpg" alt="" width={1200} height={600} />
    </section>
  );
}
`;

function input(over: Partial<Parameters<typeof bundleDraftRuntime>[0]> = {}) {
  return {
    componentSources: { AcfHero: HERO_TSX },
    dispatcherSource: emitDispatcherTsx([
      { blockName: "acf/hero", tier: "visual", compileStatus: "ok" },
    ]),
    passthroughSource: emitPassthroughTsx(),
    headerSource: `export function Header() { return <header className="p-4">site</header>; }`,
    footerSource: null,
    wpUrl: "https://tworoadsbrewing.com",
    ...over,
  };
}

describe("draftComponentName", () => {
  it("matches the dispatcher's PascalCase convention", () => {
    expect(draftComponentName("acf/hero")).toBe("AcfHero");
    expect(draftComponentName("core/heading")).toBe("CoreHeading");
  });

  it("maps the __null__ sentinel to the ClassicContent component name", () => {
    expect(draftComponentName("__null__")).toBe(CLASSIC_COMPONENT_NAME);
  });

  it("still pascal-cases real block names", () => {
    expect(draftComponentName("acf/hero")).toBe("AcfHero");
  });
});

describe("bundleDraftRuntime", () => {
  it("produces a self-contained browser bundle (no unresolved next/* or server imports)", async () => {
    const { js } = await bundleDraftRuntime(input());
    expect(js.length).toBeGreaterThan(10_000); // React is bundled in
    expect(js).not.toMatch(/from\s*["']next\/image["']/);
    expect(js).toContain("AcfHero");
  }, 30_000);

  it("substitutes a null shell component when a shell source is absent", async () => {
    const { js } = await bundleDraftRuntime(input({ headerSource: null }));
    expect(js.length).toBeGreaterThan(10_000);
  }, 30_000);

  it("rejects loudly when a component fails to compile (this IS the per-edit compile gate)", async () => {
    await expect(
      bundleDraftRuntime(input({ componentSources: { AcfHero: "export function AcfHero({ <<<garbage" } })),
    ).rejects.toThrow();
  }, 30_000);
});
