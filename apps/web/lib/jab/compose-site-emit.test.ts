import { describe, it, expect } from "vitest";
import {
  emitTsconfigJson,
  emitGitignore,
  emitPostcssConfig,
  emitNotFoundTsx,
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
