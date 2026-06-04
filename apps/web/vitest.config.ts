import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "scripts/**/*.test.ts", "components/**/*.test.ts", "components/**/*.test.tsx", "app/**/*.test.ts", "app/**/*.test.tsx"],
    // The `server-only` import marker throws when evaluated outside an RSC
    // bundler. Mock it so unit tests of server-only modules can import them.
    setupFiles: ["./vitest.setup.ts"],
  },
  // Use React 17+ automatic JSX runtime so component tests can render
  // JSX without an explicit `import React from "react"` (next.js's
  // build pipeline injects it automatically; vitest doesn't, so the
  // classic transform would fail with `React is not defined` for any
  // .tsx file under test).
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
