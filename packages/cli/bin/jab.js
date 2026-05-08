#!/usr/bin/env node
// Thin shim: defers to the compiled entry point so `pnpm exec jab`
// works after a build. For dev iteration without building, use:
//   pnpm --filter @jab/wp-headless-cli dev <args>
import "../dist/index.js";
