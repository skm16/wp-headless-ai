import "server-only";
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";

/**
 * Cheerio-based extractor — the deterministic layer between the raw HTML
 * fetch and the LLM passes. Everything that can be derived without inference
 * (titles, headings, image URLs, palette samples from inline styles) is
 * done here so the LLM doesn't burn tokens re-deriving them.
 *
 * Two important non-goals:
 *   - This does not classify "is this the logo." That's the design-pass LLM
 *     call, which gets the candidate images from here + screenshots / page
 *     position from the DOM.
 *   - This does not infer brand personality or button hierarchy. Same
 *     reason — those are inference tasks; this is parsing.
 */

export interface ScrapeExtract {
  /** Final URL (after redirects, from the fetch result). */
  url: string;
  /** Document title (from `<title>` or `og:title`). */
  title: string | null;
  /** Meta description / og:description. */
  description: string | null;
  /** All `<h1>` text content, in document order, deduped. */
  h1: string[];
  /** All `<h2>` text content, in document order, deduped. */
  h2: string[];
  /** Sectional text blocks — `<section>`, `<article>`, top-level `<main>` children. */
  sections: ExtractedSection[];
  /** Anchors that look like primary navigation. */
  navLinks: ExtractedLink[];
  /** Footer plain-text (collapsed whitespace). */
  footerText: string | null;
  /** All `<img>` URLs, absolutized. Filtered to candidates that could be logos / heroes / OG. */
  images: ExtractedImage[];
  /** og:image (or twitter:image) if present, absolutized. */
  socialImage: string | null;
  /** `<link rel="icon">` URL, absolutized. */
  faviconUrl: string | null;
  /** Hex/rgb colors found in inline `<style>` and `style=` attributes, deduped. */
  paletteSamples: string[];
  /** font-family values found in inline `<style>` / `style=` attributes, deduped. */
  fontSamples: string[];
  /** Anchors / buttons that look like CTAs (limited count). */
  buttons: ExtractedButton[];
}

export interface ExtractedSection {
  /** Inferred section role — `<header>` / `<section>` / `<article>` / `<main>` direct child. */
  role: string;
  /** First heading inside the section (h1/h2/h3), if any. */
  heading: string | null;
  /** Collapsed plain text. Truncated. */
  text: string;
}

export interface ExtractedLink {
  text: string;
  href: string;
}

export interface ExtractedImage {
  src: string;
  alt: string | null;
  /** Where in the page the image lives — `header` / `nav` / `main` / `footer`. */
  region: "header" | "nav" | "main" | "footer" | "other";
}

export interface ExtractedButton {
  text: string;
  /** Anchor href if applicable; null for `<button>`. */
  href: string | null;
  region: "header" | "nav" | "main" | "footer" | "other";
}

const MAX_SECTIONS = 12;
const MAX_NAV_LINKS = 12;
const MAX_IMAGES = 20;
const MAX_BUTTONS = 12;
const MAX_TEXT_PER_SECTION = 1200;
const MAX_PALETTE = 16;

export function extractFromHtml(html: string, finalUrl: string): ScrapeExtract {
  const $ = cheerio.load(html);
  const baseUrl = new URL(finalUrl);

  const title =
    text($("title").first()) ||
    attr($('meta[property="og:title"]'), "content") ||
    null;

  const description =
    attr($('meta[name="description"]'), "content") ||
    attr($('meta[property="og:description"]'), "content") ||
    null;

  const h1 = uniq(
    $("h1")
      .map((_, el) => text($(el)))
      .get()
      .filter(Boolean),
  );

  const h2 = uniq(
    $("h2")
      .map((_, el) => text($(el)))
      .get()
      .filter(Boolean),
  );

  const sections = extractSections($);

  const navLinks = extractNavLinks($, baseUrl);

  const footerText = collapseWhitespace($("footer").first().text()).slice(0, 800) || null;

  const images = extractImages($, baseUrl);

  const socialImage =
    absolutize(attr($('meta[property="og:image"]'), "content"), baseUrl) ||
    absolutize(attr($('meta[name="twitter:image"]'), "content"), baseUrl);

  const faviconUrl =
    absolutize(attr($('link[rel="icon"]'), "href"), baseUrl) ||
    absolutize(attr($('link[rel="shortcut icon"]'), "href"), baseUrl) ||
    absolutize(attr($('link[rel="apple-touch-icon"]'), "href"), baseUrl);

  const { palette, fonts } = extractStyleSignals($);

  const buttons = extractButtons($);

  return {
    url: finalUrl,
    title,
    description,
    h1,
    h2,
    sections,
    navLinks,
    footerText,
    images,
    socialImage,
    faviconUrl,
    paletteSamples: palette,
    fontSamples: fonts,
    buttons,
  };
}

function extractSections($: cheerio.CheerioAPI): ExtractedSection[] {
  const selectors = ["header", "main > *", "section", "article"];
  const seen = new Set<unknown>();
  const out: ExtractedSection[] = [];

  for (const sel of selectors) {
    $(sel).each((_, el) => {
      if (seen.has(el)) return;
      seen.add(el);
      const $el = $(el);
      const heading =
        text($el.find("h1, h2, h3").first()) || null;
      const collapsed = collapseWhitespace($el.text());
      if (!collapsed) return;
      out.push({
        role: el.type === "tag" ? (el as { name?: string }).name ?? "section" : "section",
        heading,
        text: collapsed.slice(0, MAX_TEXT_PER_SECTION),
      });
      if (out.length >= MAX_SECTIONS) return false;
      return undefined;
    });
    if (out.length >= MAX_SECTIONS) break;
  }

  return out;
}

function extractNavLinks(
  $: cheerio.CheerioAPI,
  baseUrl: URL,
): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const seenHref = new Set<string>();

  $('nav a, header a, [role="navigation"] a').each((_, el) => {
    if (links.length >= MAX_NAV_LINKS) return false;
    const $a = $(el);
    const href = absolutize(attr($a, "href"), baseUrl);
    const linkText = text($a);
    if (!href || !linkText) return;
    if (seenHref.has(href)) return;
    seenHref.add(href);
    links.push({ text: linkText, href });
    return undefined;
  });

  return links;
}

function extractImages(
  $: cheerio.CheerioAPI,
  baseUrl: URL,
): ExtractedImage[] {
  const images: ExtractedImage[] = [];
  const seenSrc = new Set<string>();

  $("img").each((_, el) => {
    if (images.length >= MAX_IMAGES) return false;
    const $img = $(el);
    const rawSrc = attr($img, "src") || attr($img, "data-src");
    // Skip inline data URIs — they're typically tracker pixels or inline
    // SVG that would bloat the design prompt (up to ~50KB each). The LLM
    // can't usefully classify a data: URI as "the logo" without rendering
    // it anyway, so the loss is nil.
    if (/^data:/i.test(rawSrc)) return;
    const src = absolutize(rawSrc, baseUrl);
    if (!src) return;
    if (seenSrc.has(src)) return;
    seenSrc.add(src);
    // Skip 1x1 trackers (a common pattern).
    const width = Number(attr($img, "width"));
    const height = Number(attr($img, "height"));
    if (Number.isFinite(width) && Number.isFinite(height) && width <= 4 && height <= 4) return;
    images.push({
      src,
      alt: attr($img, "alt") || null,
      region: inferRegion($, el),
    });
    return undefined;
  });

  return images;
}

function extractButtons($: cheerio.CheerioAPI): ExtractedButton[] {
  const buttons: ExtractedButton[] = [];

  // Real <button>s.
  $("button").each((_, el) => {
    if (buttons.length >= MAX_BUTTONS) return false;
    const $b = $(el);
    const btnText = text($b);
    if (!btnText) return;
    buttons.push({ text: btnText, href: null, region: inferRegion($, el) });
    return undefined;
  });

  // Anchors that look CTA-like — class names contain "btn"/"button"/"cta",
  // or have a role="button". Cheap heuristic.
  $('a[role="button"], a[class*="btn" i], a[class*="button" i], a[class*="cta" i]').each(
    (_, el) => {
      if (buttons.length >= MAX_BUTTONS) return false;
      const $a = $(el);
      const linkText = text($a);
      const href = attr($a, "href");
      if (!linkText) return;
      buttons.push({
        text: linkText,
        href: href || null,
        region: inferRegion($, el),
      });
      return undefined;
    },
  );

  return buttons;
}

/**
 * Walks ancestors to find the nearest landmark element. Used as a coarse
 * "where on the page does this thing live?" signal for the design-pass
 * LLM call — a candidate logo image inside `<header>` is way more likely
 * to actually be the logo than one inside `<footer>`.
 */
function inferRegion(
  $: cheerio.CheerioAPI,
  el: AnyNode,
): ExtractedImage["region"] {
  let current: AnyNode | undefined = el;
  for (let i = 0; i < 20 && current; i++) {
    const $node: cheerio.Cheerio<AnyNode> = $(current);
    const tag =
      current.type === "tag" ? (current.name ?? "").toLowerCase() : "";
    if (tag === "header" || $node.attr("role") === "banner") return "header";
    if (tag === "nav" || $node.attr("role") === "navigation") return "nav";
    if (tag === "main" || $node.attr("role") === "main") return "main";
    if (tag === "footer" || $node.attr("role") === "contentinfo") return "footer";
    current = $node.parent().get(0);
  }
  return "other";
}

function extractStyleSignals($: cheerio.CheerioAPI): {
  palette: string[];
  fonts: string[];
} {
  // Frequency-ranked: count every occurrence of a hex/rgb across all
  // styles, then return the most-common N. Without this, a WP theme reset
  // CSS at the top of the doc means #fff/#000/#333 always rank first by
  // insertion order, pushing the actual brand accent out of the top 16.
  const paletteCounts = new Map<string, number>();
  const fontCounts = new Map<string, number>();

  const bumpPalette = (hex: string) => {
    paletteCounts.set(hex, (paletteCounts.get(hex) ?? 0) + 1);
  };
  const bumpFont = (family: string) => {
    fontCounts.set(family, (fontCounts.get(family) ?? 0) + 1);
  };

  const consumeCss = (css: string) => {
    for (const match of css.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
      bumpPalette(normalizeHex(match[1]!));
    }
    for (const match of css.matchAll(/rgba?\(([^)]+)\)/gi)) {
      const parts = match[1]!.split(",").map((p) => p.trim());
      if (parts.length < 3) continue;
      const [r, g, b] = parts.map((p) => Number(p));
      if (![r, g, b].every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) continue;
      bumpPalette(rgbToHex(r!, g!, b!));
    }
    for (const match of css.matchAll(/font-family\s*:\s*([^;{}\n]+)/gi)) {
      const value = match[1]!.replace(/!important/gi, "").trim().replace(/['"]+/g, "");
      const first = value.split(",")[0]?.trim();
      if (first && !/^(inherit|initial|unset|revert|sans-serif|serif|monospace|system-ui|-apple-system)$/i.test(first)) {
        bumpFont(first);
      }
    }
  };

  $("style").each((_, el) => {
    consumeCss($(el).text() || "");
  });

  $("[style]").each((_, el) => {
    const inline = $(el).attr("style") || "";
    consumeCss(inline);
  });

  // Sort by count desc, take top N. Ties broken by insertion order (Map
  // preserves it), which is fine — the LLM doesn't see counts, only the
  // ranked list.
  const sortByCount = <K>(m: Map<K, number>): K[] =>
    Array.from(m.entries())
      .sort(([, a], [, b]) => b - a)
      .map(([k]) => k);

  return {
    palette: sortByCount(paletteCounts).slice(0, MAX_PALETTE),
    fonts: sortByCount(fontCounts).slice(0, 8),
  };
}

function text($el: cheerio.Cheerio<AnyNode>): string {
  return collapseWhitespace($el.text());
}

function attr($el: cheerio.Cheerio<AnyNode>, name: string): string {
  const v = $el.attr(name);
  return typeof v === "string" ? v.trim() : "";
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function uniq(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

function absolutize(raw: string | undefined, base: URL): string | null {
  if (!raw) return null;
  try {
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
}

function normalizeHex(input: string): string {
  const v = input.toLowerCase();
  if (v.length === 3) {
    return `#${v[0]}${v[0]}${v[1]}${v[1]}${v[2]}${v[2]}`;
  }
  return `#${v}`;
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
