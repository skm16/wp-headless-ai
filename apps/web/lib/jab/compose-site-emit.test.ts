import { describe, it, expect } from "vitest";
import {
  emitTsconfigJson,
  emitGitignore,
  emitPostcssConfig,
  emitNotFoundTsx,
  emitPackageJson,
  emitNextConfigTs,
  emitEnvExample,
  emitJabClientTs,
} from "./compose-site-emit";

describe("compose-site-emit — static templates", () => {
  it("emitTsconfigJson returns valid JSON with strict + jsx:preserve", () => {
    const src = emitTsconfigJson();
    const parsed = JSON.parse(src);
    expect(parsed.compilerOptions.strict).toBe(true);
    expect(parsed.compilerOptions.jsx).toBe("preserve");
    expect(parsed.compilerOptions.paths["@/*"]).toEqual(["./*"]);
  });

  it("emitGitignore covers node_modules + .next + .env files", () => {
    const src = emitGitignore();
    expect(src).toMatch(/node_modules/);
    expect(src).toMatch(/\.next/);
    expect(src).toMatch(/\.env\.local/);
  });

  it("emitPostcssConfig is valid mjs exporting tailwindcss + autoprefixer", () => {
    const src = emitPostcssConfig();
    expect(src).toMatch(/tailwindcss/);
    expect(src).toMatch(/autoprefixer/);
    expect(src).toMatch(/export default/);
  });

  it("emitNotFoundTsx is a default-export React component", () => {
    const src = emitNotFoundTsx();
    expect(src).toMatch(/export default function NotFound/);
    expect(src).toMatch(/404/);
  });
});

describe("compose-site-emit — package.json", () => {
  it("emits valid JSON with isomorphic-dompurify in dependencies", () => {
    const src = emitPackageJson("Two Roads Brewing");
    const parsed = JSON.parse(src);
    expect(parsed.name).toBe("two-roads-brewing");
    expect(parsed.private).toBe(true);
    expect(parsed.dependencies["isomorphic-dompurify"]).toBeTruthy();
    expect(parsed.dependencies.next).toBeTruthy();
    expect(parsed.scripts.build).toBe("next build");
  });

  it("slug-cases the project name", () => {
    const parsed = JSON.parse(emitPackageJson("My Client's WP Site!!"));
    expect(parsed.name).toBe("my-client-s-wp-site");
  });

  it("falls back to 'headless-site' on degenerate input", () => {
    expect(JSON.parse(emitPackageJson("@@@")).name).toBe("headless-site");
  });
});

describe("compose-site-emit — @jab/core delegations", () => {
  it("emitNextConfigTs returns the @jab/core renderNextConfig output", () => {
    expect(emitNextConfigTs()).toMatch(/export default/);
  });
  it("emitEnvExample returns the @jab/core renderEnvExample output", () => {
    expect(emitEnvExample()).toMatch(/WP_URL/);
  });
  it("emitJabClientTs returns the @jab/core renderJabClient output", () => {
    expect(emitJabClientTs()).toMatch(/createClient/);
  });
});
