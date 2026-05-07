#!/usr/bin/env node
// Thin shim: defers to the compiled entry point so `pnpm exec wpheadless`
// works after a build. For dev iteration without building, use:
//   pnpm --filter @skm/wp-headless-cli dev <args>
import "../dist/index.js";
