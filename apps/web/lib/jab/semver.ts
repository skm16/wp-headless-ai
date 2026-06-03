/**
 * Minimal semver compare for plugin-version gating. We control both operands
 * (plugin reports x.y.z; we compare against fixed minimums), so a tiny parser
 * beats a dependency. Unparseable input sorts as 0.0.0 (lowest) so a missing
 * version never falsely satisfies a minimum.
 */
function parse(v: string): [number, number, number] {
  const m = v.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return [0, 0, 0];
  return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

export function compareSemver(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i]! > pb[i]!) return 1;
    if (pa[i]! < pb[i]!) return -1;
  }
  return 0;
}

export function gteSemver(a: string, b: string): boolean {
  return compareSemver(a, b) >= 0;
}
