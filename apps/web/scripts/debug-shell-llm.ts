// apps/web/scripts/debug-shell-llm.ts
//
// Re-runs a shell (Header or Footer) LLM call with the SAME inputs the
// Phase C worker used for a given project, captures the raw response, and
// dumps the TS compile diagnostics — bypassing the production
// generate-shell.ts's "discard on failure" behaviour.
//
// Usage:
//   pnpm tsx scripts/debug-shell-llm.ts <projectId> <tenantId> [header|footer]
//
// Outputs (c:/tmp/shell-debug/<ts>-<kind>/):
//   prompt.md           — the system + user prompt sent to the model
//   response-raw.txt    — the model's text reply, unmodified
//   response-stripped.tsx — after code-fence stripping
//   diagnostics.json    — ts.createSourceFile + parseDiagnostics output
//   meta.json           — token usage + model + attempt summary
//
// This is a debug tool, not part of the production worker. It uses the
// real Anthropic API — ~$0.05 per run on Sonnet 4.6.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import * as ts from "typescript";

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

interface ShellMenuItem { title: string; url: string }
interface ShellMenu { name: string; items: ShellMenuItem[] }

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

function renderTokenSection(tokens: { colorPalette?: { slug: string }[]; fontFamilies?: { slug: string }[] } | null): string {
  if (!tokens) return "## Tailwind tokens\nUse Tailwind defaults — no custom tokens captured.\n";
  const colors = (tokens.colorPalette ?? []).slice(0, 12).map((c) => c.slug).join(", ");
  const fonts = (tokens.fontFamilies ?? []).slice(0, 6).map((f) => f.slug).join(", ");
  return `## Available Tailwind tokens
Colors: ${colors || "(none)"}
Font families: ${fonts || "(none)"}
Use ONLY these token names — any class outside this set is a generation error.
`;
}

function renderMenuSection(menu: ShellMenu | null): string {
  if (!menu || menu.items.length === 0) return "## Menu\nNo menu data captured.\n";
  const items = menu.items.slice(0, 20).map((i) => `- ${i.title} → ${i.url}`).join("\n");
  return `## Menu: ${menu.name}\n${items}\n`;
}

function sharedShellSystemPrompt(): string {
  return `You are a senior React/Next.js developer producing site-chrome components.

## Output contract
- Return ONLY the TypeScript/TSX source code. No markdown fences. No prose.
- Use Tailwind CSS classes ONLY. Available token list below; any class outside it is an error.
- Do NOT import fonts. Do NOT use next/font.
- No external icon libraries. Inline SVG or emoji only.
- Use Next.js \`<Link>\` for internal nav; \`<a>\` for external.
- Static output — no hooks except mobile menu toggle (useState only).
- Match source DOM's structural hierarchy faithfully.
- EXACT signature required — the wrapping layout depends on it.
`;
}

interface PromptInput {
  shellDom: string;
  themeTokens: { colorPalette?: { slug: string }[]; fontFamilies?: { slug: string }[] } | null;
  menu: ShellMenu | null;
  logoUrl: string | null;
  siteName: string;
  siteDescription: string | null;
}

function headerPrompt(input: PromptInput): string {
  const system = sharedShellSystemPrompt();
  const tokens = renderTokenSection(input.themeTokens);
  const menu = renderMenuSection(input.menu);
  const logo = input.logoUrl ? `## Logo\n${input.logoUrl}\n` : "";
  const user = `## Source header DOM (rendered HTML from the WP site)
\`\`\`html
${input.shellDom}
\`\`\`

${tokens}
${menu}
${logo}
## Site identity
Name: ${input.siteName}
Description: ${input.siteDescription ?? "(none)"}

## Required signature
\`\`\`tsx
export function Header() { ... }
\`\`\`
Generate the Header component matching the source DOM's structure.`;
  return `${system}\n\nUSER:\n${user}`;
}

function footerPrompt(input: PromptInput): string {
  const system = sharedShellSystemPrompt();
  const tokens = renderTokenSection(input.themeTokens);
  const menu = renderMenuSection(input.menu);
  const user = `## Source footer DOM
\`\`\`html
${input.shellDom}
\`\`\`

${tokens}
${menu}
## Site identity
Name: ${input.siteName}
Description: ${input.siteDescription ?? "(none)"}

## Required signature
\`\`\`tsx
export function Footer() { ... }
\`\`\`
Generate the Footer component matching the source DOM's structure.`;
  return `${system}\n\nUSER:\n${user}`;
}

function stripCodeFences(text: string): string {
  return text
    .replace(/^\s*```(?:tsx|ts|jsx|js)?\s*/i, "")
    .replace(/\s*```\s*$/i, "");
}

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
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }
  if (!anthropicKey) {
    console.error("Missing ANTHROPIC_API_KEY.");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  console.log(`[debug-shell] loading project ${projectId} (tenant ${tenantId})…`);
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

  const designTokens = (project.design_tokens ?? {}) as {
    themeJson?: { colorPalette?: { slug: string }[]; fontFamilies?: { slug: string }[] };
    shellDom?: { header: string | null; footer: string | null };
    personality?: { description?: string | null };
  };
  const shellDom = designTokens.shellDom?.[kind] ?? "";
  if (!shellDom) {
    console.error(`No ${kind} DOM captured in design_tokens.shellDom.${kind} — nothing to debug.`);
    process.exit(1);
  }

  const input: PromptInput = {
    shellDom,
    themeTokens: designTokens.themeJson ?? null,
    menu: extractPrimaryMenu(project.manifest),
    logoUrl: project.logo_storage_path,
    siteName: project.name,
    siteDescription: designTokens.personality?.description ?? null,
  };

  const fullPrompt = kind === "header" ? headerPrompt(input) : footerPrompt(input);
  const [systemPrompt, ...userParts] = fullPrompt.split("\n\nUSER:\n");
  const userPrompt = userParts.join("\n\nUSER:\n") || fullPrompt;

  console.log(`[debug-shell] shellDom: ${shellDom.length} chars`);
  console.log(`[debug-shell] menu items: ${input.menu?.items.length ?? 0}`);
  console.log(`[debug-shell] systemPrompt: ${systemPrompt.length} chars`);
  console.log(`[debug-shell] userPrompt: ${userPrompt.length} chars`);

  // Singleton-invariant exemption: lib/ai/client.ts is `server-only` and
  // cannot be imported from this standalone tsx CLI. A one-shot script has
  // no shared connection-pool/backoff state to protect, so a direct
  // construction here is correct. Runtime modules must use getAnthropicClient().
  const sdk = new Anthropic({ apiKey: anthropicKey });
  const model = "claude-sonnet-4-6";
  console.log(`[debug-shell] dispatching to ${model}…`);
  const t0 = Date.now();
  const response = await sdk.messages.create({
    model,
    max_tokens: 8192,
    system: [{ type: "text", text: systemPrompt }],
    messages: [{ role: "user", content: [{ type: "text", text: userPrompt }] }],
  });
  const elapsed = Date.now() - t0;
  console.log(`[debug-shell] response received in ${elapsed}ms`);

  const rawText = response.content.find((b) => b.type === "text")?.text ?? "";
  const stripped = stripCodeFences(rawText).trim();
  const fileName = kind === "header" ? "Header.tsx" : "Footer.tsx";
  const diagnostics = validateTsx(stripped, fileName);

  const sizeRaw = Buffer.byteLength(rawText, "utf8");
  const sizeStripped = Buffer.byteLength(stripped, "utf8");
  const MAX = 12_000;

  const ts2 = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = `c:/tmp/shell-debug/${ts2}-${kind}`;
  mkdirSync(outDir, { recursive: true });

  writeFileSync(join(outDir, "prompt.md"), `# SYSTEM\n\n${systemPrompt}\n\n# USER\n\n${userPrompt}\n`, "utf8");
  writeFileSync(join(outDir, "response-raw.txt"), rawText, "utf8");
  writeFileSync(join(outDir, "response-stripped.tsx"), stripped, "utf8");
  writeFileSync(join(outDir, "diagnostics.json"), JSON.stringify(diagnostics, null, 2), "utf8");
  writeFileSync(
    join(outDir, "meta.json"),
    JSON.stringify(
      {
        kind,
        model,
        elapsedMs: elapsed,
        usage: response.usage,
        sizeBytes: { raw: sizeRaw, stripped: sizeStripped, cap: MAX, overCap: sizeStripped > MAX },
        diagnosticsCount: diagnostics.length,
        inputs: {
          shellDomChars: shellDom.length,
          menuItems: input.menu?.items.length ?? 0,
          siteName: input.siteName,
          siteDescription: input.siteDescription,
          logoUrl: input.logoUrl,
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`\n[debug-shell] wrote artifacts → ${outDir}`);
  console.log(`[debug-shell] raw: ${sizeRaw}B  stripped: ${sizeStripped}B  (cap ${MAX}B)${sizeStripped > MAX ? "  ⚠ OVER CAP" : ""}`);
  console.log(`[debug-shell] diagnostics: ${diagnostics.length}`);
  if (diagnostics.length > 0) {
    console.log("\n--- first 5 diagnostics ---");
    for (const d of diagnostics.slice(0, 5)) {
      console.log(`  ${fileName}:${d.line}:${d.character}  TS${d.code} ${d.category}: ${d.messageText}`);
    }
  } else {
    console.log(`[debug-shell] ✓ valid TSX — would have passed the gate this run`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
