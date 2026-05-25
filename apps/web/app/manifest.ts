import type { MetadataRoute } from "next";

// Web App Manifest — served at /manifest.webmanifest with the right
// Content-Type. Next.js auto-injects <link rel="manifest"> into every
// page's <head> from this file. Android's Add-to-Home-Screen reads it
// to install the PWA shell; iOS Safari falls back to apple-icon and
// the marketing <title>.
//
// Icons point at /icons/192 and /icons/512 (route handlers built from
// the shared JAB mark renderer in lib/jab-icon.tsx). Marked `purpose:
// "any"` only — see docs/jab-brand.md before adding maskable variants:
// the chevron sits flush to the right edge and would clip under the
// 10% adaptive-icon mask.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Jab — WordPress to AI-iterable headless",
    short_name: "JAB",
    description:
      "Jab generates a typed Next.js project from any WordPress site exposing the MCP Adapter, page by page, with AI assistance.",
    start_url: "/",
    display: "standalone",
    background_color: "#060d16",
    theme_color: "#00c9a7",
    icons: [
      {
        src: "/icons/192",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/512",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
