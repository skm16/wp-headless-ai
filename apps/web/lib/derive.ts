/**
 * Project-level derivations that map raw `projects` columns onto the
 * shapes the JAB site-detail UI expects (status chip, icon initials,
 * domain display). Centralized here so the dashboard tile-grid migration
 * and the Site Detail page share one source of truth — when the
 * deployment-derived status fields land in Phase 2, only this file changes.
 */

export type DeploymentStatusTone = "live" | "building" | "error" | "draft";

export interface DeploymentStatus {
  tone: DeploymentStatusTone;
  label: string;
  pulse: boolean;
}

const STATUS_MAP: Record<string, DeploymentStatus> = {
  ready: { tone: "live", label: "Live", pulse: false },
  onboarding: { tone: "building", label: "Building", pulse: true },
  draft: { tone: "draft", label: "Draft", pulse: false },
  archived: { tone: "draft", label: "Archived", pulse: false },
};

/**
 * Today's `projects.status` is the project-lifecycle column
 * (draft / onboarding / ready / archived). The richer deployment-derived
 * status (Live / Building / Failed) lives one schema-decision away —
 * this helper is the abstraction boundary so when the real status arrives
 * the dashboard and site-detail UIs swap in lockstep.
 */
export function deploymentStatusFrom(status: string | null | undefined): DeploymentStatus {
  if (!status) return STATUS_MAP.draft!;
  return STATUS_MAP[status] ?? STATUS_MAP.draft!;
}

/**
 * Two-letter initials for the site-icon block (the 48×48 square in the
 * site header, the 32×32 avatar in the sidebar). First letter of the
 * first two words; falls back to the first two letters if there's only
 * one word, then "?" as a last resort.
 */
export function siteIconInitials(name: string | null | undefined): string {
  if (!name) return "?";
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const words = trimmed.split(/\s+/);
  if (words.length >= 2) {
    return ((words[0]![0] ?? "") + (words[1]![0] ?? "")).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

/**
 * Strip protocol + trailing slash so the URL renders compactly under the
 * site name. Returns the raw input on any URL-parse failure — that's
 * better than a blank cell when a project has a malformed WP URL stored.
 */
export function displayDomainFrom(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return (u.host + (u.pathname === "/" ? "" : u.pathname)).replace(/\/$/, "");
  } catch {
    return url;
  }
}
