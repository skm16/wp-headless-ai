import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Operator scripts (scripts/debug-shell-llm.ts) import these modules under
 * tsx, where the `server-only` marker package is unresolvable (it is not
 * installed — Next's bundler aliases it). Re-adding the marker to any of
 * them silently re-breaks the debug tooling, so pin its absence here.
 */
const SCRIPT_IMPORTED_PURE_MODULES = [
  "lib/ai/shell-prompts.ts",
  "lib/ai/generated-tsx-postprocess.ts",
  "lib/ai/model.ts",
  "lib/jab/global-styles.ts",
  "lib/ai/client.ts",
  "lib/jab/sanitize-shell-dom.ts",
];

describe("script-importable modules carry no server-only marker", () => {
  for (const rel of SCRIPT_IMPORTED_PURE_MODULES) {
    it(rel, () => {
      const src = readFileSync(resolve(process.cwd(), rel), "utf8");
      expect(src).not.toMatch(/import\s+"server-only"/);
    });
  }
});
