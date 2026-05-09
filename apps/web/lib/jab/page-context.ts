import "server-only";
import { emitSdk, type Manifest } from "@jab/core";
import { decryptColumnToString } from "@/lib/crypto/encrypt";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Loads everything the AI agent needs to generate a page:
 *   - The project row (with decrypted WP creds and the manifest snapshot)
 *   - The typed SDK source (regenerated from the stored manifest — same
 *     code path the CLI uses, so the agent sees what would actually ship)
 *   - The live page HTML (DOM-only design extraction; v0)
 *
 * Service-role client because Inngest workers don't carry user sessions.
 * The user-context check happened in /api/projects/[id]/generate when the
 * generation_jobs row was created — by the time we're here, the jobId
 * itself is the authorization token.
 */

const MAX_HTML_BYTES = 60_000;

export interface PageContext {
  wpUrl: string;
  pageUrl: string;
  pagePath: string;
  pageHtml: string;
  manifest: Manifest;
  abilitiesSummary: string;
  sdkSource: string;
  githubRepoFullName: string;
  githubPat: string;
}

interface ProjectRow {
  wp_url: string | null;
  wp_username: string | null;
  wp_app_password_encrypted: unknown;
  github_repo_full_name: string | null;
  github_pat_encrypted: unknown;
  manifest: unknown;
  status: string;
}

/**
 * Loads + decrypts the GitHub creds for a project. Cheap (one row, two
 * fields) — used in the push-to-github step where we deliberately avoid
 * round-tripping the PAT through Inngest step memoization (which stores
 * step return values for replay; we don't want PATs persisted there).
 */
export async function loadGithubCreds(
  projectId: string,
): Promise<{ repoFullName: string; pat: string }> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("projects")
    .select("github_repo_full_name, github_pat_encrypted")
    .eq("id", projectId)
    .single<Pick<ProjectRow, "github_repo_full_name" | "github_pat_encrypted">>();
  if (error) throw new Error(`load github creds: ${error.message}`);
  if (!data) throw new Error(`project ${projectId} not found`);
  if (!data.github_repo_full_name || !data.github_pat_encrypted) {
    throw new Error(`project ${projectId} missing GitHub repo or PAT`);
  }
  return {
    repoFullName: data.github_repo_full_name,
    pat: decryptColumnToString(data.github_pat_encrypted),
  };
}

export async function loadPageContext(
  projectId: string,
  pagePath: string,
): Promise<PageContext> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("projects")
    .select(
      "wp_url, wp_username, wp_app_password_encrypted, github_repo_full_name, github_pat_encrypted, manifest, status",
    )
    .eq("id", projectId)
    .single<ProjectRow>();
  if (error) throw new Error(`load project: ${error.message}`);
  if (!data) throw new Error(`project ${projectId} not found`);
  if (data.status !== "ready") {
    throw new Error(
      `project ${projectId} is in status '${data.status}'; expected 'ready'`,
    );
  }
  if (!data.wp_url || !data.manifest) {
    throw new Error(
      `project ${projectId} is missing wp_url or manifest — re-run onboarding`,
    );
  }
  if (!data.github_repo_full_name || !data.github_pat_encrypted) {
    throw new Error(
      `project ${projectId} is missing GitHub repo or PAT — re-run onboarding`,
    );
  }

  const githubPat = decryptColumnToString(data.github_pat_encrypted);

  const manifest = data.manifest as Manifest;
  const sdkFiles = await emitSdk(manifest);
  const sdkSource = bundleSdkSource(sdkFiles);
  const abilitiesSummary = manifest.abilities
    .map((a) => `- ${a.name} — ${a.description ?? a.label ?? "(no description)"}`)
    .join("\n");

  const pageUrl = `${data.wp_url.replace(/\/+$/, "")}${
    pagePath.startsWith("/") ? pagePath : `/${pagePath}`
  }`;
  const pageHtml = await fetchPageHtml(pageUrl);

  return {
    wpUrl: data.wp_url,
    pageUrl,
    pagePath,
    pageHtml,
    manifest,
    abilitiesSummary,
    sdkSource,
    githubRepoFullName: data.github_repo_full_name,
    githubPat,
  };
}

function bundleSdkSource(files: Map<string, string>): string {
  const wanted = ["types.ts", "client.ts", "abilities.ts", "index.ts"];
  return wanted
    .filter((f) => files.has(f))
    .map((f) => `// ===== ${f} =====\n${files.get(f)!.trimEnd()}\n`)
    .join("\n");
}

async function fetchPageHtml(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  let html = await res.text();
  // Strip the parts of the page least useful for layout inference, in
  // priority order. Same heuristics validate-ai used.
  html = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "<!-- svg -->")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (html.length > MAX_HTML_BYTES) {
    html = `${html.slice(0, MAX_HTML_BYTES)}\n<!-- truncated at ${MAX_HTML_BYTES} chars -->`;
  }
  return html;
}
