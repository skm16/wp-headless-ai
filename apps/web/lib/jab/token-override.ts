// PURE module: structured brand-token deltas and how they merge/apply onto the
// ThemeJsonTokens object the draft + (future) build derive CSS from. No
// server-only — imported by the planner schema validation + the draft worker.

import type { ThemeJsonTokens } from "./global-styles";

export interface TokenDelta {
  colors?: Array<{ slug: string; color: string }>;
  fontFamilies?: Array<{ slug: string; fontFamily: string }>;
  fontSizes?: Array<{ slug: string; size: string }>;
}

export function isEmptyTokenDelta(d: TokenDelta | null | undefined): boolean {
  if (!d) return true;
  return !(d.colors?.length || d.fontFamilies?.length || d.fontSizes?.length);
}

/** Upsert-by-slug within one category; later entries win. */
function upsertBySlug<T extends { slug: string }>(existing: T[], incoming: T[]): T[] {
  const out = [...existing];
  for (const item of incoming) {
    const i = out.findIndex((e) => e.slug === item.slug);
    if (i >= 0) out[i] = item;
    else out.push(item);
  }
  return out;
}

/** Merge deltas in order (last wins per slug per category). */
export function mergeTokenDeltas(deltas: TokenDelta[]): TokenDelta {
  const merged: Required<TokenDelta> = { colors: [], fontFamilies: [], fontSizes: [] };
  for (const d of deltas) {
    if (d.colors?.length) merged.colors = upsertBySlug(merged.colors, d.colors);
    if (d.fontFamilies?.length) merged.fontFamilies = upsertBySlug(merged.fontFamilies, d.fontFamilies);
    if (d.fontSizes?.length) merged.fontSizes = upsertBySlug(merged.fontSizes, d.fontSizes);
  }
  const out: TokenDelta = {};
  if (merged.colors.length) out.colors = merged.colors;
  if (merged.fontFamilies.length) out.fontFamilies = merged.fontFamilies;
  if (merged.fontSizes.length) out.fontSizes = merged.fontSizes;
  return out;
}

/** Apply a delta onto base tokens (upsert by slug per category). */
export function applyTokenOverride(
  base: ThemeJsonTokens | null,
  delta: TokenDelta,
): ThemeJsonTokens {
  const out: ThemeJsonTokens = { ...(base ?? {}) };
  if (delta.colors?.length) out.colorPalette = upsertBySlug(out.colorPalette ?? [], delta.colors);
  if (delta.fontFamilies?.length) out.fontFamilies = upsertBySlug(out.fontFamilies ?? [], delta.fontFamilies);
  if (delta.fontSizes?.length) out.fontSizes = upsertBySlug(out.fontSizes ?? [], delta.fontSizes);
  return out;
}

// ── validation (injection-safe) ───────────────────────────────────────────────

// Strict CSS color: #rgb/#rgba/#rrggbb/#rrggbbaa, rgb()/rgba()/hsl()/hsla(),
// or a plain lowercase keyword (letters only). NO url(), no semicolons/braces.
const COLOR_RE =
  /^(#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\([0-9.,\s%]+\)|hsla?\([0-9.,\s%]+\)|[a-zA-Z]+)$/;
// Font family / size: no CSS-breaking chars. Sizes legitimately use parens
// (clamp/calc/min/max), so parens are allowed; braces/semicolons/angle-brackets
// and quotes-that-could-break-out are not.
const SAFE_VALUE_RE = /^[^{};<>]+$/;
const MAX_VALUE_LEN = 120;

function isSafeValue(v: string): boolean {
  return v.length > 0 && v.length <= MAX_VALUE_LEN && SAFE_VALUE_RE.test(v) && !/url\s*\(/i.test(v);
}

export function validateTokenDelta(
  d: unknown,
): { ok: true; delta: TokenDelta } | { ok: false; reason: string } {
  if (!d || typeof d !== "object" || Array.isArray(d)) {
    return { ok: false, reason: "Token change is empty." };
  }
  const raw = d as TokenDelta;
  const delta: TokenDelta = {};

  if (raw.colors?.length) {
    for (const c of raw.colors) {
      if (!c || typeof c.slug !== "string" || !c.slug.trim()) return { ok: false, reason: "A color is missing its slug." };
      if (typeof c.color !== "string" || !COLOR_RE.test(c.color.trim()) || /url\s*\(/i.test(c.color)) {
        return { ok: false, reason: `"${c.color}" is not a valid CSS color.` };
      }
    }
    delta.colors = raw.colors.map((c) => ({ slug: c.slug.trim(), color: c.color.trim() }));
  }
  if (raw.fontFamilies?.length) {
    for (const f of raw.fontFamilies) {
      if (!f || typeof f.slug !== "string" || !f.slug.trim()) return { ok: false, reason: "A font is missing its slug." };
      if (typeof f.fontFamily !== "string" || !isSafeValue(f.fontFamily.trim())) {
        return { ok: false, reason: `"${f.fontFamily}" is not a valid font family.` };
      }
    }
    delta.fontFamilies = raw.fontFamilies.map((f) => ({ slug: f.slug.trim(), fontFamily: f.fontFamily.trim() }));
  }
  if (raw.fontSizes?.length) {
    for (const s of raw.fontSizes) {
      if (!s || typeof s.slug !== "string" || !s.slug.trim()) return { ok: false, reason: "A size is missing its slug." };
      if (typeof s.size !== "string" || !isSafeValue(s.size.trim())) {
        return { ok: false, reason: `"${s.size}" is not a valid font size.` };
      }
    }
    delta.fontSizes = raw.fontSizes.map((s) => ({ slug: s.slug.trim(), size: s.size.trim() }));
  }

  if (isEmptyTokenDelta(delta)) return { ok: false, reason: "Token change has no colors, fonts, or sizes." };
  return { ok: true, delta };
}

/**
 * Apply-time defense-in-depth: filter a list of (possibly untrusted) deltas to
 * only the valid, sanitized ones. validateTokenDelta runs at plan time, but the
 * worker reads `data.tokenDelta` from the event and loadActiveTokenDeltas reads
 * persisted rows — a legacy/tampered row or a direct server-action call could
 * carry an unvalidated delta whose font-family value would otherwise pass
 * through Tailwind into the emitted draft CSS verbatim (Tailwind sanitizes color
 * values but NOT font-family). Dropping (not throwing) keeps a single bad row
 * from blanking the whole preview; the dropped delta is logged by the caller.
 * Returns the trimmed/sanitized deltas (validateTokenDelta's normalized output).
 */
export function sanitizeTokenDeltas(deltas: Array<TokenDelta | null | undefined>): TokenDelta[] {
  const out: TokenDelta[] = [];
  for (const d of deltas) {
    if (isEmptyTokenDelta(d)) continue;
    const v = validateTokenDelta(d);
    if (v.ok) out.push(v.delta);
  }
  return out;
}
