# Featured Images + Taxonomy Support — Design Spec

**Date:** 2026-05-11
**Status:** Approved

## Problem

The WP plugin's post/CPT abilities return `id, title, excerpt, date, slug, link, acf` per post. Two capabilities needed for real agency work are missing:

1. **Featured images** — no thumbnail URL or metadata in any ability output.
2. **Taxonomy terms** — no categories, tags, or custom taxonomy terms inline in post output, and no way to fetch all terms for a given taxonomy (needed for filter UIs).

## Approach

Compose via shared schema fragments (Approach A). Extract a `MediaSchema` helper and a `TaxonomySchema` helper so the featured-image schema and the term-object schema each have a single source of truth. All ability classes call these helpers.

No CLI or TypeScript changes are needed — the manifest auto-includes new fields and abilities, and `json-schema-to-typescript` handles the generated types automatically.

## Architecture

```
packages/wp-plugin/includes/
├── Schema/
│   ├── MediaSchema.php        ← NEW: featured-image schema fragment
│   └── TaxonomySchema.php     ← NEW: term-object schema fragment
├── Abilities/
│   ├── PostTypeListAbility.php    ← MODIFIED
│   ├── PostTypeBySlugAbility.php  ← MODIFIED
│   └── TaxonomyTermsAbility.php   ← NEW
└── Registry.php               ← MODIFIED
```

## Schema fragments

### MediaSchema::imageObject()

Used for `featured_image` in every CPT that supports thumbnails. Tight schema — no ACF metadata tail.

```json
{
  "oneOf": [
    {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "ID":     { "type": "integer" },
        "url":    { "type": "string", "format": "uri" },
        "alt":    { "type": "string" },
        "width":  { "type": "integer" },
        "height": { "type": "integer" }
      },
      "required": ["ID", "url", "alt", "width", "height"]
    },
    { "type": "null" }
  ]
}
```

### TaxonomySchema::termObject()

Used for both inline taxonomy arrays in post output and standalone `TaxonomyTermsAbility` output.

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "id":          { "type": "integer" },
    "name":        { "type": "string" },
    "slug":        { "type": "string" },
    "description": { "type": "string" },
    "count":       { "type": "integer" },
    "parent_id":   { "type": "integer" }
  },
  "required": ["id", "name", "slug", "description", "count", "parent_id"]
}
```

## Post/CPT output changes

Every CPT list and by-slug ability gains two new field groups:

**`featured_image`** — Added when `post_type_supports($type, 'thumbnail')` is true. Uses `MediaSchema::imageObject()` (nullable). Never breaks existing CPTs — the schema property is added at registration time, the data is fetched at execute time.

**Taxonomy arrays** — One property per taxonomy registered to the post type, discovered via `get_object_taxonomies($post_type, 'objects')`. Each is `{ type: array, items: TaxonomySchema::termObject() }`. Empty array when untagged, never null.

TypeScript output after `jab sync`:

```typescript
{
  id: number;
  title: string;
  excerpt: string;
  date: string;
  slug: string;
  link: string;
  featured_image: { ID: number; url: string; alt: string; width: number; height: number } | null;
  categories: { id: number; name: string; slug: string; description: string; count: number; parent_id: number }[];
  tags: { id: number; name: string; slug: string; description: string; count: number; parent_id: number }[];
  beer_style: { id: number; name: string; slug: string; description: string; count: number; parent_id: number }[];
  acf?: { ... };
}
```

## TaxonomyTermsAbility

One instance registered per public taxonomy. Auto-discovered alongside CPT abilities in `Registry`.

**Ability name:** `jab/get-{kebab-plural}` e.g. `jab/get-categories`, `jab/get-beer-styles`

**Input:**

```json
{
  "hide_empty": { "type": "boolean", "default": true },
  "number":     { "type": "integer", "minimum": 1, "maximum": 500, "default": 100 }
}
```

**Output:**

```json
{
  "$taxonomy_name": [TaxonomySchema::termObject()]
}
```

## Data fetching

**Featured image** (per post inside execute):

```php
$thumb_id = get_post_thumbnail_id($post->ID);
if ($thumb_id) {
    $src = wp_get_attachment_image_src($thumb_id, 'full');
    $featured_image = [
        'ID' => $thumb_id, 'url' => $src[0],
        'width' => $src[1], 'height' => $src[2],
        'alt' => get_post_meta($thumb_id, '_wp_attachment_image_alt', true) ?: '',
    ];
} else {
    $featured_image = null;
}
```

**Taxonomy terms — batched** (list ability, N+1 avoided):

```php
$taxonomies = get_object_taxonomies($post_type);
$all_ids    = wp_list_pluck($posts, 'ID');
$all_terms  = wp_get_object_terms($all_ids, $taxonomies);
// Group by post_id + taxonomy, then pass per-post slice to shape_row()
```

**Taxonomy terms — single** (by-slug ability): `wp_get_object_terms([$post->ID], $taxonomies)` — no batching needed for one post.

**`TaxonomyTermsAbility` fetch:** `get_terms(['taxonomy' => $slug, 'hide_empty' => ..., 'number' => ...])`. Returns `WP_Error` → ability throws rather than silently returning empty.

## Registry changes

```php
public static function register_abilities(): void {
    foreach (self::ability_configs() as $config) {
        PostTypeListAbility::register($config);
        PostTypeBySlugAbility::register(self::derive_by_slug_config($config));
    }
    self::register_taxonomy_abilities();  // NEW
    MenusAbility::register();
}
```

`register_taxonomy_abilities()` queries `get_taxonomies(['public' => true])`, applies `jab/headless_kit/taxonomy_excludes` filter (default excludes: `post_format`, `nav_menu`, `link_category`, `wp_pattern_category`), registers one `TaxonomyTermsAbility` per remaining taxonomy.

## CLI / TypeScript impact

None. New fields and abilities are standard JSON Schema and flow through `json-schema-to-typescript` automatically after `jab sync`. The `oneOf<object|null>` pattern for `featured_image` is identical to the existing by-slug nullable pattern.
