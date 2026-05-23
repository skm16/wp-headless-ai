"use client";

import { useState } from "react";
import {
  FidelityReport,
  type FidelityCheck,
} from "@/components/fidelity-report";

const ORIGINAL_MOCK = `<!doctype html>
<html><head><meta charset="utf-8" /><title>Acme Coffee — original</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Georgia,"Times New Roman",serif;color:#1e293b}
  nav{display:flex;justify-content:space-between;align-items:center;padding:1rem 1.5rem;background:#f8fafc;border-bottom:1px solid #e2e8f0}
  nav .brand{font-weight:700;color:#1e293b;font-family:Georgia,serif}
  nav ul{display:flex;gap:1rem;list-style:none;font-size:.875rem;font-family:Georgia,serif}
  nav a{color:#475569;text-decoration:none}
  .hero{padding:4rem 1.5rem 3rem;background:#fff}
  .hero h1{font-size:2.25rem;line-height:1.15;margin-bottom:1rem;color:#0f172a;font-family:Georgia,serif}
  .hero p{color:#475569;max-width:34rem;margin-bottom:1.5rem;font-size:1rem}
  .hero a{display:inline-block;background:#1e293b;color:#fff;padding:.65rem 1.25rem;text-decoration:none;font-family:Georgia,serif}
</style></head>
<body>
  <nav><span class="brand">Acme Coffee</span><ul><li><a href="#">Menu</a></li><li><a href="#">Shops</a></li><li><a href="#">About</a></li></ul></nav>
  <section class="hero">
    <h1>Brooklyn-roasted coffee, served in your neighborhood.</h1>
    <p>Small-batch coffee from a family-run roaster. Three shops, one promise: better mornings.</p>
    <a href="#">Find a shop</a>
  </section>
</body></html>`;

const GENERATED_MOCK = `<!doctype html>
<html><head><meta charset="utf-8" /><title>Acme Coffee — generated</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1e293b}
  nav{display:flex;justify-content:space-between;align-items:center;padding:1rem 2rem;border-bottom:1px solid #e2e8f0}
  nav .brand{font-weight:800;color:#4f46e5;letter-spacing:-.01em}
  nav ul{display:flex;gap:1.5rem;list-style:none;font-size:.875rem}
  nav a{color:#475569;text-decoration:none}
  .hero{padding:5rem 2rem 4rem;background:linear-gradient(180deg,#eef2ff 0%,#fff 100%)}
  .hero h1{font-size:2.5rem;line-height:1.1;letter-spacing:-.025em;margin-bottom:1rem;color:#0f172a;font-weight:700}
  .hero p{color:#64748b;max-width:34rem;margin-bottom:2rem}
  .hero a{display:inline-block;background:#4f46e5;color:#fff;padding:.75rem 1.5rem;border-radius:.5rem;text-decoration:none;font-weight:500}
</style></head>
<body>
  <nav><span class="brand">Acme Coffee</span><ul><li><a href="#">Menu</a></li><li><a href="#">Shops</a></li><li><a href="#">About</a></li></ul></nav>
  <section class="hero">
    <h1>Brooklyn-roasted coffee, served in your neighborhood.</h1>
    <p>Small-batch coffee from a family-run roaster. Three shops, one promise: better mornings.</p>
    <a href="#">Find a shop</a>
  </section>
</body></html>`;

const CHECKS: FidelityCheck[] = [
  {
    id: "structure",
    label: "Hero structure",
    status: "matched",
    detail: "Headline, supporting copy, and primary CTA preserved in order.",
  },
  {
    id: "section-order",
    label: "Section order",
    status: "matched",
    detail: "Nav → hero → CTA matches the original's content flow.",
  },
  {
    id: "nav",
    label: "Navigation links",
    status: "matched",
    detail: "All 3 primary nav items preserved.",
  },
  {
    id: "palette",
    label: "Color palette",
    status: "near-match",
    detail:
      "Switched to brand indigo. Original was monochrome-on-white — closer to the Refresh intent.",
  },
  {
    id: "typography",
    label: "Typography",
    status: "miss",
    detail:
      "Original used Georgia (serif). Generated output uses the system sans stack — flag if Faithful intent matters here.",
  },
];

export function FidelityReportDemo() {
  const [highlight, setHighlight] = useState(false);

  return (
    <FidelityReport
      original={{
        srcDoc: ORIGINAL_MOCK,
        url: "https://acmecoffee.wp/",
        label: "Original",
        sublabel: "WP-rendered",
      }}
      generated={{
        srcDoc: GENERATED_MOCK,
        url: "https://acme-coffee-preview-d7a.jabwp.app/",
        label: "Generated",
        sublabel: "Faithful intent · v3",
      }}
      checks={CHECKS}
      highlightActive={highlight}
      onToggleHighlight={() => setHighlight((v) => !v)}
      onIterate={() => alert("Mock: queue iteration with diff context")}
      onAccept={() => alert("Mock: open PublishConfirmModal")}
    />
  );
}
