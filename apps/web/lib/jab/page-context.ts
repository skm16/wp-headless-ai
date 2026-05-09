import "server-only";
import { emitSdk, type Manifest } from "@jab/core";
import { decryptColumnToString } from "@/lib/crypto/encrypt";
import { createAdminClient } from "@/lib/supabase/admin";

export type { Manifest };

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
const MAX_COLORS = 12;

export interface FrontPageInfo {
  id: number;
  slug: string;
  title: string;
}

export interface PageContext {
  wpUrl: string;
  pageUrl: string;
  pagePath: string;
  pageHtml: string;
  manifest: Manifest;
  abilitiesSummary: string;
  sdkSource: string;
  /**
   * Front-page facts looked up at generation time when pagePath="/".
   * Removes the AI's biggest source of guesswork — without this, the
   * agent picks `slug: "home"` and ships pages that don't render against
   * any real WP install whose front page slug isn't literally "home".
   */
  frontPage: FrontPageInfo | null;
  /**
   * Hex colors extracted from the source page's <style> blocks before we
   * strip them. Gives the agent ground-truth on the brand palette so it
   * doesn't roll the dice on Tailwind colors each generation.
   */
  brandColors: string[];
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
 * Loads + decrypts the GitHub creds for a project. Cheap (one row, a
 * handful of fields) — used in BOTH the prepare-repo step (where we
 * also need manifest + name to scaffold) and the commit-and-push step
 * (where we only need pat + repoFullName).
 *
 * Service-role; the user-context check happened at job creation time.
 * We deliberately decrypt the PAT inside this function rather than
 * round-tripping through Inngest step memo state.
 */
export async function loadGithubCreds(projectId: string): Promise<{
  repoFullName: string;
  pat: string;
  projectName: string;
  manifest: Manifest;
}> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("projects")
    .select(
      "name, github_repo_full_name, github_pat_encrypted, manifest",
    )
    .eq("id", projectId)
    .single<{
      name: string;
      github_repo_full_name: string | null;
      github_pat_encrypted: unknown;
      manifest: unknown;
    }>();
  if (error) throw new Error(`load github creds: ${error.message}`);
  if (!data) throw new Error(`project ${projectId} not found`);
  if (!data.github_repo_full_name || !data.github_pat_encrypted) {
    throw new Error(`project ${projectId} missing GitHub repo or PAT`);
  }
  if (!data.manifest) {
    throw new Error(`project ${projectId} missing manifest snapshot`);
  }
  return {
    repoFullName: data.github_repo_full_name,
    pat: decryptColumnToString(data.github_pat_encrypted),
    projectName: data.name,
    manifest: data.manifest as Manifest,
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
  if (
    !data.wp_url ||
    !data.wp_username ||
    !data.wp_app_password_encrypted ||
    !data.manifest
  ) {
    throw new Error(
      `project ${projectId} is missing WP creds or manifest — re-run onboarding`,
    );
  }
  if (!data.github_repo_full_name || !data.github_pat_encrypted) {
    throw new Error(
      `project ${projectId} is missing GitHub repo or PAT — re-run onboarding`,
    );
  }

  const wpUsername = data.wp_username;
  const wpAppPassword = decryptColumnToString(data.wp_app_password_encrypted);
  const githubPat = decryptColumnToString(data.github_pat_encrypted);

  const manifest = data.manifest as Manifest;
  const sdkFiles = await emitSdk(manifest);
  const sdkSource = bundleSdkSource(sdkFiles);
  const abilitiesSummary = manifest.abilities
    .map((a) => `- ${a.name} — ${a.description ?? a.label ?? "(no description)"}`)
    .join("\n");

  const wpUrl = data.wp_url.replace(/\/+$/, "");
  const pageUrl = `${wpUrl}${
    pagePath.startsWith("/") ? pagePath : `/${pagePath}`
  }`;

  // Fetch the page's raw HTML once, extract colors before stripping
  // styles, then strip for the prompt.
  const rawHtml = await fetchRawHtml(pageUrl);
  const brandColors = extractColors(rawHtml);
  const pageHtml = stripHtmlForPrompt(rawHtml);

  // For homepage generations, ask WP what the actual front page is.
  // Cheap (two REST calls); removes the slug guess that broke this in
  // the wild. For non-root paths we don't probe — caller passed the
  // path explicitly so the AI can use the last segment as the slug.
  const frontPage =
    pagePath === "/" || pagePath === ""
      ? await safeFindFrontPage(wpUrl, wpUsername, wpAppPassword)
      : null;

  return {
    wpUrl,
    pageUrl,
    pagePath,
    pageHtml,
    manifest,
    abilitiesSummary,
    sdkSource,
    frontPage,
    brandColors,
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

async function fetchRawHtml(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  return res.text();
}

function stripHtmlForPrompt(rawHtml: string): string {
  let html = rawHtml
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

/**
 * Pull hex colors out of inline <style> blocks before we strip them
 * for the prompt. Returns the most-frequent N (the rare/utility colors
 * tail off into noise — fonts-of-fonts, accent shadows, etc.).
 *
 * Limits to MAX_COLORS so the prompt stays tight; the goal is "give
 * the AI enough palette signal to pick brand-appropriate Tailwind
 * shades", not "list every shade of slate the theme touched".
 */
function extractColors(rawHtml: string): string[] {
  const styleBlocks = rawHtml.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi) ?? [];
  const counts = new Map<string, number>();
  for (const block of styleBlocks) {
    // Match #RGB, #RRGGBB, #RRGGBBAA. Skip 8-char hex (alpha included)
    // for now — the prompt cares about brand hue, not opacity nuances.
    const matches = block.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g);
    if (!matches) continue;
    for (const raw of matches) {
      const normalized = normalizeHex(raw);
      // Skip black/white/near-grays — too generic to inform brand.
      if (isUninformativeColor(normalized)) continue;
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, MAX_COLORS)
    .map(([hex]) => hex);
}

function normalizeHex(raw: string): string {
  const v = raw.toLowerCase();
  if (v.length === 4) {
    // #abc → #aabbcc
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  }
  return v;
}

function isUninformativeColor(hex: string): boolean {
  // #000, #fff, near-grays where r ≈ g ≈ b. Brand colors have
  // meaningful chroma; pure grays don't help the agent pick a palette.
  if (hex === "#000000" || hex === "#ffffff") return true;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min < 16;
}

/**
 * Find the page WP routes "/" to. Two REST hops:
 *   1. /wp/v2/settings → page_on_front (the page id, or 0 if not set)
 *   2. /wp/v2/pages/<id> → slug + title
 *
 * Wrapped in a try/catch — if WP is misconfigured or the user lacks
 * permission, we fall back to null and the AI still has to guess.
 * Don't fail the whole generation just because settings introspection
 * didn't work; the agent has the source HTML and SDK to work from.
 */
async function safeFindFrontPage(
  wpUrl: string,
  username: string,
  appPassword: string,
): Promise<FrontPageInfo | null> {
  try {
    const settings = await wpFetchJson<{
      page_on_front?: number;
      show_on_front?: string;
    }>(`${wpUrl}/wp-json/wp/v2/settings`, username, appPassword);
    const pageId = settings.page_on_front;
    if (!pageId || settings.show_on_front !== "page") {
      // Either the front page is the latest-posts feed (not a Page) or
      // not configured. AI will still fall back to slug-guessing for
      // the homepage; we don't have ground truth to give it.
      return null;
    }
    const page = await wpFetchJson<{
      id: number;
      slug: string;
      title: { rendered?: string };
    }>(`${wpUrl}/wp-json/wp/v2/pages/${pageId}`, username, appPassword);
    return {
      id: page.id,
      slug: page.slug,
      title: page.title?.rendered ?? "",
    };
  } catch {
    return null;
  }
}

async function wpFetchJson<T>(
  url: string,
  username: string,
  password: string,
): Promise<T> {
  const auth = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}
