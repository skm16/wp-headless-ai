import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The web app imports from @jab/core, which TypeScript needs to compile
  // through Next.js's transpiler since core ships TS sources at workspace
  // dev time (compiled to dist/ at build time, but we want HMR over the
  // monorepo without a watch on @jab/core's tsc).
  transpilePackages: ["@jab/core"],
};

export default nextConfig;
