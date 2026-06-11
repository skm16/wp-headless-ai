import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The web app imports from @jab/core, which TypeScript needs to compile
  // through Next.js's transpiler since core ships TS sources at workspace
  // dev time (compiled to dist/ at build time, but we want HMR over the
  // monorepo without a watch on @jab/core's tsc).
  transpilePackages: ["@jab/core"],

  // esbuild is used at runtime by lib/draft/bundle.ts to compile LLM-generated
  // TSX into the draft browser bundle. It must stay as a Node.js require() —
  // webpack cannot parse esbuild's own .d.ts type declarations.
  serverExternalPackages: ["esbuild"],

  /**
   * Security headers. `frame-ancestors 'self'` prevents the platform from
   * being embedded inside an attacker's iframe (clickjacking defense). The
   * generated client sites at client.jabwp.app/{slug}/ are not affected —
   * they are intentionally embeddable (the PreviewFrame iframes them).
   *
   * X-Content-Type-Options + Referrer-Policy + Permissions-Policy round out
   * the baseline. Adjust the Permissions-Policy allowlist if/when the app
   * needs camera/microphone/etc. (none of those today).
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'self';",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
