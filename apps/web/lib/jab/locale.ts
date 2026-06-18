// PURE module: WordPress locale → BCP-47 lang + text direction for the
// generated site's <html> tag. WP locales look like "en_US" / "de_DE" / "ar" /
// "ckb"; we take the language subtag only (region dropped — see plan), which is
// what matters for SEO/screen-readers and all RTL detection needs.

/**
 * Language subtags whose script is right-to-left. Covers the RTL locales
 * WordPress ships (Arabic + variants, Hebrew, Persian, Urdu, Pashto, Sindhi,
 * Uyghur, Yiddish, Divehi, Sorani Kurdish, South Azerbaijani, Hazaragi).
 * Region is stripped before lookup, so "fa_IR" and "fa" both resolve.
 */
export const RTL_LANGUAGE_SUBTAGS: ReadonlySet<string> = new Set([
  "ar", "ary", "azb", "ckb", "dv", "fa", "haz", "he", "ps", "sd", "ug", "ur", "yi",
]);

/** Language subtag, lowercased; "" when absent/blank. */
function languageSubtag(wpLocale: string | null | undefined): string {
  if (!wpLocale) return "";
  const trimmed = wpLocale.trim();
  if (!trimmed) return "";
  return trimmed.split(/[_-]/)[0].toLowerCase();
}

/** BCP-47 lang for `<html lang>`. Region dropped; defaults to "en". */
export function localeToBcp47(wpLocale: string | null | undefined): string {
  return languageSubtag(wpLocale) || "en";
}

/** Text direction for `<html dir>`. "rtl" for known RTL languages, else "ltr". */
export function localeDir(wpLocale: string | null | undefined): "ltr" | "rtl" {
  const subtag = languageSubtag(wpLocale);
  return subtag && RTL_LANGUAGE_SUBTAGS.has(subtag) ? "rtl" : "ltr";
}
