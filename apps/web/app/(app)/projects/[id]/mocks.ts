/**
 * Mocked data for the Site Detail page. Each field here represents a value
 * the JAB dashboard mockup shows but that doesn't exist in the `projects`
 * schema yet — Lighthouse scores, deploy history, WordPress sync status,
 * AI prompt history. Wired to typed object literals so the page can render
 * faithfully today, and so a future PR can replace each block with a real
 * query without restructuring the JSX.
 *
 * Every block carries a `// TODO(phase 2):` pointer noting which table or
 * service replaces it.
 */

export interface LighthouseScores {
  performance: number;
  accessibility: number;
  bestPractices: number;
  seo: number;
}

export interface QuickStat {
  label: string;
  value: string;
}

export type DeployEnv = "prod" | "preview";
export type DeployStatus = "live" | "ready" | "failed";

export interface DeployRow {
  id: string;
  env: DeployEnv;
  message: string;
  status: DeployStatus;
  /** Human-readable relative timestamp, e.g. "2m ago". */
  when: string;
}

export interface WpConnection {
  endpoint: string;
  lastSyncRelative: string;
  contentTypes: string[];
  hiddenContentTypeCount: number;
  autoSyncDescription: string;
}

export interface AiPromptHistoryRow {
  prompt: string;
  /** "Deployed" | "Failed" | "Pending" — drives chip tone. */
  status: "deployed" | "failed" | "pending";
  when: string;
  deployId: string;
}

export interface SiteDetailMocks {
  lighthouse: LighthouseScores;
  quickStats: QuickStat[];
  deploys: DeployRow[];
  wpConnection: WpConnection;
  aiHistory: AiPromptHistoryRow[];
  aiCreditsRemaining: number;
  /** Human-readable timestamp shown next to the live chip. */
  lastDeployedRelative: string;
}

// TODO(phase 2): replace with a real Lighthouse run stored alongside each
// production deploy. For now these match the mockup so the visual lands
// exactly.
const lighthouse: LighthouseScores = {
  performance: 94,
  accessibility: 98,
  bestPractices: 100,
  seo: 82,
};

// TODO(phase 2): derive from real measurements once the hosting layer
// records them. Lighthouse maps 1:1 above; the others come from the
// build pipeline + manifest.
const quickStats: QuickStat[] = [
  { label: "Lighthouse", value: "94" },
  { label: "TTFB", value: "38ms" },
  { label: "Build time", value: "2.1s" },
  { label: "Content items", value: "47" },
  { label: "Content types", value: "8" },
];

// TODO(phase 2): replace with a query of the (not-yet-existing)
// `deployments` table. Shape is intentionally close to what the design
// implies so the swap is mechanical.
const deploys: DeployRow[] = [
  { id: "#d-042", env: "prod", message: "Content sync auto-deploy", status: "live", when: "2m ago" },
  { id: "#d-041", env: "prod", message: 'AI: "Update hero copy"', status: "live", when: "3d ago" },
  { id: "#d-040", env: "preview", message: "Design iteration v3", status: "ready", when: "4d ago" },
  { id: "#d-039", env: "prod", message: "Custom domain connected", status: "live", when: "1w ago" },
  { id: "#d-038", env: "prod", message: "Initial site generation", status: "failed", when: "2w ago" },
];

// TODO(phase 2): pull from the WP MCP probe metadata + the per-project
// auto-sync setting (will move from the WP plugin into our DB).
const wpConnection: WpConnection = {
  endpoint: "wordpress.tworoadsbrewing.com",
  lastSyncRelative: "2 minutes ago",
  contentTypes: ["posts", "pages", "beers", "events"],
  hiddenContentTypeCount: 4,
  autoSyncDescription: "Enabled — triggers on WP publish",
};

// TODO(phase 2): pull from a future `ai_prompts` table — generation_jobs
// is the closest existing analogue but its shape is GitHub-flow specific.
const aiHistory: AiPromptHistoryRow[] = [
  {
    prompt: '"Update hero copy to highlight the Stratford facility"',
    status: "deployed",
    when: "3d ago",
    deployId: "#d-041",
  },
  {
    prompt: '"Make the nav sticky on scroll and add a CTA button"',
    status: "deployed",
    when: "6d ago",
    deployId: "#d-037",
  },
  {
    prompt: '"Use a darker background for the beer cards section"',
    status: "deployed",
    when: "1w ago",
    deployId: "#d-036",
  },
];

export const SITE_DETAIL_MOCKS: SiteDetailMocks = {
  lighthouse,
  quickStats,
  deploys,
  wpConnection,
  aiHistory,
  aiCreditsRemaining: 1588,
  lastDeployedRelative: "2m ago",
};
