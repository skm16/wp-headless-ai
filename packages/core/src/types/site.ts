/** Faithful mirror of GET /wp-json/jab/v1/site (plugin SiteManifest::respond). */
export interface SiteManifest {
  plugin_version: string | null;
  generated_at: string;
  site: {
    title: string;
    tagline: string;
    home_url: string;
    site_url: string;
    timezone: string;
    locale: string;
    permalink_structure: string;
  };
  front_page: {
    show_on_front: "posts" | "page";
    static_front: SitePageRef;
    posts_page: SitePageRef;
  };
  branding: {
    site_icon_url: string | null;
    custom_logo_id: number | null;
    custom_logo_url: string | null;
  };
  menus: Array<{ slug: string; label: string }>;
  image_sizes: Array<{ name: string; width: number; height: number; crop: boolean }>;
  theme: { slug: string | null; name: string | null; version: string | null };
}

export interface SitePageRef {
  id: number | null;
  slug: string | null;
  title: string | null;
}

/** Structural type-guard. Narrow check only — trusts the plugin's contract. */
export function isSiteManifest(v: unknown): v is SiteManifest {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.site === "object" &&
    o.site !== null &&
    typeof o.front_page === "object" &&
    o.front_page !== null &&
    typeof o.theme === "object" &&
    o.theme !== null &&
    Array.isArray(o.menus) &&
    Array.isArray(o.image_sizes)
  );
}
