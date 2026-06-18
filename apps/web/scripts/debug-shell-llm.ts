// apps/web/scripts/debug-shell-llm.ts
//
// Re-runs a shell (Header or Footer) LLM call with the SAME inputs the
// Phase C worker uses for a given project, captures the raw response, and
// reports the FULL production gate verdict (postprocess → origin rewrite →
// byte cap → TSX parse) — bypassing generate-shell.ts's "discard on
// failure" behaviour.
//
// De-forked 2026-06-10 (AI-call optimization campaign, Phase 7): prompt
// builders, postprocess, size cap, max_tokens, and model resolution are
// IMPORTED from the production modules. Do NOT re-inline production logic
// here — the previous fork drifted (12KB vs 24KB cap, missing prompt
// sections) and misdiagnosed paid runs. scripts/lib/script-source-pins.test.ts
// pins this.
//
// Usage:
//   pnpm tsx scripts/debug-shell-llm.ts <projectId> <tenantId> [header|footer]
//
// Outputs (c:/tmp/shell-debug/<ts>-<kind>/):
//   prompt.md           — the system + user prompt sent to the model
//   response-raw.txt    — the model's text reply, unmodified
//   response-final.tsx  — after postprocess + origin-link rewrite (what production would persist)
//   diagnostics.json    — ts.createSourceFile parseDiagnostics output
//   meta.json           — token usage + stop_reason + model + gate verdict
//
// This is a debug tool, not part of the production worker. It uses the
// real Anthropic API — ~$0.05 per run on the Sonnet-tier shell model.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import * as ts from "typescript";

import {
  headerPrompt,
  footerPrompt,
  extractThemeClassNames,
  MAX_SHELL_BYTES,
  SHELL_MAX_TOKENS,
  type ShellMenu,
  type ShellPromptInput,
} from "@/lib/ai/shell-prompts";
import { postprocessGeneratedTsx } from "@/lib/ai/generated-tsx-postprocess";
import { getModelFor } from "@/lib/ai/model";
import { isResponsiveGenEnabled } from "@/lib/ai/generation-flags";
import { getAnthropicClient } from "@/lib/ai/client";
import {
  resolveThemeTokens,
  type ThemeJsonTokens,
  type ScrapedBrandTokens,
} from "@/lib/jab/global-styles";
import { rewriteWpOriginUrls, hostVariants } from "@/lib/jab/rewrite-origin-links";

function loadDotEnvLocal(): void {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

// Local copy of compose-site.ts's non-exported extractPrimaryMenu (verified
// byte-identical behaviour, compose-site.ts:822-836). compose-site.ts is a
// server-only worker module and cannot be imported here. If menus
// persistence lands and compose changes its menu source, update this copy.
function extractPrimaryMenu(manifest: unknown): ShellMenu | null {
  if (!manifest || typeof manifest !== "object") return null;
  const m = manifest as { menus?: unknown };
  if (!Array.isArray(m.menus) || m.menus.length === 0) return null;
  const first = m.menus[0] as { name?: unknown; items?: unknown };
  if (typeof first.name !== "string" || !Array.isArray(first.items)) return null;
  const items = first.items
    .filter((i): i is { title: string; url: string } => {
      if (!i || typeof i !== "object") return false;
      const o = i as { title?: unknown; url?: unknown };
      return typeof o.title === "string" && typeof o.url === "string";
    })
    .slice(0, 30);
  return { name: first.name, items };
}

// Local parse-level TSX gate. Equivalent check to component-generator.ts's
// validateTsx (same ts.createSourceFile + parseDiagnostics), kept local
// because component-generator.ts is server-only + worker-heavy; this copy
// reports line/character detail the production string-formatter drops.
interface Diagnostic {
  line: number;
  character: number;
  code: number;
  category: string;
  messageText: string;
}

function validateTsx(source: string, fileName: string): Diagnostic[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const diags = (sf as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics ?? [];
  return diags.map((d) => {
    const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
    return {
      line: pos.line + 1,
      character: pos.character + 1,
      code: d.code,
      category: ts.DiagnosticCategory[d.category],
      messageText: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    };
  });
}

async function main() {
  loadDotEnvLocal();

  const [, , projectId, tenantId, kindArg] = process.argv;
  if (!projectId || !tenantId) {
    console.error("Usage: pnpm tsx scripts/debug-shell-llm.ts <projectId> <tenantId> [header|footer]");
    process.exit(1);
  }
  const kind: "header" | "footer" = kindArg === "header" ? "header" : "footer";

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY.");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  console.log(`[debug-shell] loading project ${projectId} (tenant ${tenantId})…`);
  // Same columns compose-site's load-project step selects (compose-site.ts:239).
  const { data: project, error } = await supabase
    .from("projects")
    .select("name, wp_url, design_tokens, manifest, logo_storage_path")
    .eq("id", projectId)
    .eq("tenant_id", tenantId)
    .single();
  if (error || !project) {
    console.error(`load-project failed: ${error?.message ?? "no row"}`);
    process.exit(1);
  }

  // Mirror compose-site.ts's design_tokens decode (compose-site.ts:264-294).
  const designTokens = (project.design_tokens ?? {}) as {
    themeJson?: ThemeJsonTokens;
    themeStylesheets?: Array<{ css: string }>;
    shellDom?: { header: string | null; footer: string | null };
    shellStyles?: {
      header: { backgroundColor?: string; color?: string } | null;
      footer: { backgroundColor?: string; color?: string } | null;
    };
    personality?: { description?: string | null };
    colors?: ScrapedBrandTokens["colors"];
    typography?: ScrapedBrandTokens["typography"];
  };
  const shellDom = designTokens.shellDom?.[kind] ?? "";
  if (!shellDom) {
    console.error(`No ${kind} DOM captured in design_tokens.shellDom.${kind} — nothing to debug.`);
    process.exit(1);
  }

  // Composite token resolution exactly as compose-site does it: prefer
  // themeJson (FSE/block themes), fall back to the scrape-agent's brand
  // inference (classic themes — Two Roads). Reading themeJson alone regresses
  // classic-theme repros to "Colors: (none)".
  const themeTokens = resolveThemeTokens(designTokens.themeJson, {
    colors: designTokens.colors,
    typography: designTokens.typography,
  });

  // Production passes the BUNDLED public logo path, not the storage path
  // (compose-site.ts:610-626). Mirror the filename derivation.
  const logoExt =
    (project.logo_storage_path?.split(".").pop() ?? "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
  const logoUrl = project.logo_storage_path ? `/logo.${logoExt}` : null;

  const input: ShellPromptInput = {
    shellDom,
    themeTokens,
    themeClassNames: extractThemeClassNames(designTokens.themeStylesheets ?? []),
    shellColors: designTokens.shellStyles?.[kind] ?? null,
    menu: extractPrimaryMenu(project.manifest),
    logoUrl,
    siteName: project.name,
    siteDescription: designTokens.personality?.description ?? null,
    sourceHost: new URL(project.wp_url).hostname,
    // Mirror production: buildShellRequestParts reads this flag, so the debug
    // script must too or it would show the off-path prompt under JAB_RESPONSIVE_GEN=1.
    responsive: isResponsiveGenEnabled(),
  };

  // Post-Phase-2 builders return { system, user } — no sentinel round-trip.
  const { system, user } = kind === "header" ? headerPrompt(input) : footerPrompt(input);
  const model = getModelFor("shell");

  console.log(`[debug-shell] shellDom: ${shellDom.length} chars`);
  console.log(`[debug-shell] menu items: ${input.menu?.items.length ?? 0}`);
  console.log(`[debug-shell] system: ${system.length} chars  user: ${user.length} chars`);
  console.log(`[debug-shell] dispatching to ${model} (max_tokens ${SHELL_MAX_TOKENS})…`);

  const sdk = getAnthropicClient();
  const t0 = Date.now();
  // One-shot operator run: no cache_control. A 5-min ephemeral entry could
  // never be re-read by a later manual run, so the write premium is pure
  // waste; the prompt TEXT is identical to production's, so the repro holds.
  const response = await sdk.messages.create({
    model,
    max_tokens: SHELL_MAX_TOKENS,
    system: [{ type: "text", text: system }],
    messages: [{ role: "user", content: [{ type: "text", text: user }] }],
  });
  const elapsed = Date.now() - t0;
  console.log(`[debug-shell] response received in ${elapsed}ms (stop_reason=${response.stop_reason})`);

  const rawText = response.content.find((b) => b.type === "text")?.text ?? "";
  const expectedName = kind === "header" ? "Header" : "Footer";
  const fileName = kind === "header" ? "Header.tsx" : "Footer.tsx";

  // ── Production gate, in production order (generate-shell.ts):
  //    postprocess → origin-link rewrite → byte cap → TSX parse.
  let finalTsx: string | null = null;
  let postprocessError: string | null = null;
  try {
    finalTsx = postprocessGeneratedTsx(rawText.trim(), { expectedExportName: expectedName });
  } catch (err) {
    postprocessError = err instanceof Error ? err.message : String(err);
  }
  if (finalTsx !== null) {
    // routePathMap omitted: it needs a build's page_inventory; without it the
    // rewriter falls back to plain origin-stripping (same as pre-0033 builds).
    finalTsx = rewriteWpOriginUrls(finalTsx, { sourceHosts: hostVariants(project.wp_url) });
  }
  const sizeRaw = Buffer.byteLength(rawText, "utf8");
  const sizeFinal = finalTsx !== null ? Buffer.byteLength(finalTsx, "utf8") : 0;
  const overCap = finalTsx !== null && sizeFinal > MAX_SHELL_BYTES;
  const diagnostics = finalTsx !== null ? validateTsx(finalTsx, fileName) : [];
  const truncated = response.stop_reason === "max_tokens";
  const wouldPass = postprocessError === null && !overCap && diagnostics.length === 0;

  const ts2 = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = `c:/tmp/shell-debug/${ts2}-${kind}`;
  mkdirSync(outDir, { recursive: true });

  writeFileSync(join(outDir, "prompt.md"), `# SYSTEM\n\n${system}\n\n# USER\n\n${user}\n`, "utf8");
  writeFileSync(join(outDir, "response-raw.txt"), rawText, "utf8");
  writeFileSync(join(outDir, "response-final.tsx"), finalTsx ?? "", "utf8");
  writeFileSync(join(outDir, "diagnostics.json"), JSON.stringify(diagnostics, null, 2), "utf8");
  writeFileSync(
    join(outDir, "meta.json"),
    JSON.stringify(
      {
        kind,
        model,
        elapsedMs: elapsed,
        usage: response.usage,
        stopReason: response.stop_reason,
        sizeBytes: { raw: sizeRaw, final: sizeFinal, cap: MAX_SHELL_BYTES, overCap },
        gate: { postprocessError, overCap, truncated, diagnosticsCount: diagnostics.length, wouldPass },
        inputs: {
          shellDomChars: shellDom.length,
          themeClassNames: input.themeClassNames?.length ?? 0,
          menuItems: input.menu?.items.length ?? 0,
          siteName: input.siteName,
          siteDescription: input.siteDescription,
          logoUrl,
          sourceHost: input.sourceHost,
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`\n[debug-shell] wrote artifacts → ${outDir}`);
  console.log(
    `[debug-shell] raw: ${sizeRaw}B  final: ${sizeFinal}B  (cap ${MAX_SHELL_BYTES}B)${overCap ? "  ⚠ OVER CAP" : ""}`,
  );
  if (truncated) {
    console.log(`[debug-shell] ⚠ stop_reason=max_tokens — output truncated at ${SHELL_MAX_TOKENS} tokens; the gate verdict below reflects a truncated artifact.`);
  }
  if (postprocessError) console.log(`[debug-shell] ✗ postprocess failed: ${postprocessError}`);
  console.log(`[debug-shell] diagnostics: ${diagnostics.length}`);
  for (const d of diagnostics.slice(0, 5)) {
    console.log(`  ${fileName}:${d.line}:${d.character}  TS${d.code} ${d.category}: ${d.messageText}`);
  }
  console.log(
    wouldPass
      ? `[debug-shell] ✓ would have PASSED the production gate (postprocess + cap + parse)`
      : `[debug-shell] ✗ would have FAILED the production gate — postprocess=${postprocessError ? "fail" : "ok"} cap=${overCap ? "over" : "ok"} parse=${diagnostics.length === 0 ? "ok" : `${diagnostics.length} diagnostics`}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
