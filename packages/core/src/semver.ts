/**
 * Tiny semver helper — major.minor.patch only. Used to gate plugin-version
 * staleness in the CLI and (canonically) anywhere in the kit that needs to
 * compare plugin versions. No dependency on the npm `semver` package; the
 * plugin only ever emits simple X.Y.Z strings.
 */

/** Parse "1.2.3" → [1,2,3]. Tolerates a leading "v" and a pre-release suffix
 *  (e.g. "0.7.1-beta.2" → [0,7,1]). Returns null on anything unparseable. */
export function parseSemver(v: string): [number, number, number] | null {
  const cleaned = v.trim().replace(/^v/i, "");
  const m = cleaned.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1 if a<b, 0 if equal, 1 if a>b (by major.minor.patch). Unparseable sorts
 *  low: a null-parse compares less than any parseable version; two equal. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** True when a is at or above b. */
export function gteSemver(a: string, b: string): boolean {
  return compareSemver(a, b) >= 0;
}

export type PluginVersionChangeKind = "upgrade" | "downgrade" | "same" | "unknown";

export interface PluginVersionChange {
  kind: PluginVersionChangeKind;
  previous: string | null;
  next: string | null;
  message: string;
}

/**
 * Describe how the plugin version moved between two manifest fetches — for the
 * `jab sync` console summary. `unknown` when the live side reports no version
 * (the WP plugin predates v0.7.0's `plugin_version` field) or there was no
 * prior recorded version to compare against.
 */
export function describePluginVersionChange(
  previous: string | null | undefined,
  next: string | null | undefined,
): PluginVersionChange {
  const prev = previous ?? null;
  const nxt = next ?? null;
  if (!nxt) {
    return {
      kind: "unknown",
      previous: prev,
      next: nxt,
      message:
        "Plugin version unknown — the WP plugin predates v0.7.0 or did not report a version. Upgrade the plugin to v0.7.0+ to unlock production-sync types.",
    };
  }
  if (!prev) {
    return {
      kind: "unknown",
      previous: prev,
      next: nxt,
      message: `Plugin version is now v${nxt} (no prior version was recorded for this SDK).`,
    };
  }
  const cmp = compareSemver(nxt, prev);
  if (cmp > 0) {
    return {
      kind: "upgrade",
      previous: prev,
      next: nxt,
      message: `Plugin upgraded v${prev} → v${nxt}; SDK regenerated to match.`,
    };
  }
  if (cmp < 0) {
    return {
      kind: "downgrade",
      previous: prev,
      next: nxt,
      message: `Plugin DOWNGRADED v${prev} → v${nxt}; SDK regenerated. Confirm the WP plugin version is intentional.`,
    };
  }
  return {
    kind: "same",
    previous: prev,
    next: nxt,
    message: `Plugin unchanged at v${nxt}.`,
  };
}
