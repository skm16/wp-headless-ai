# wp-headless-kit (WordPress plugin)

Thin WordPress plugin that exposes content as MCP (Model Context Protocol) abilities, so AI-iterable headless frontends can read this site through the official WordPress MCP Adapter.

## Requirements

- WordPress **6.9+** — the Abilities API has been in core since 6.9; the plugin still bundles `wordpress/abilities-api` as a safety net (the bundled package detects core and stays out of the way), but the supported floor is now 6.9.
- PHP **7.4+**
- Composer (only for dev install — release zip ships with `vendor/` bundled)

## Install

There are two install paths — pick the one that matches what you're doing.

### Drop-in (production / agency hand-off)

Use the pre-built zip. No PHP / Composer required on the target site.

1. **Download** the latest zip from the project's GitHub Releases page (look for the latest `plugin-v*` tag), **or** build locally:
   ```bash
   cd packages/wp-plugin
   ./bin/build-release.sh
   # → dist/wp-headless-kit-<version>.zip
   ```
2. WP Admin → **Plugins → Add New → Upload Plugin** → choose the zip → **Install** → **Activate**.

> Maintainers: push a tag matching `plugin-v*` (e.g. `plugin-v0.2.0`) to trigger the release workflow. CI builds the zip on PHP 7.4 (matching the plugin's minimum) and attaches it to the GitHub Release automatically. See [`.github/workflows/release-plugin.yml`](../../.github/workflows/release-plugin.yml).

### Dev install (iterating on the plugin source)

Use a junction so edits in the monorepo are live in your local WP install.

```bash
# From inside your LocalWP install's plugins dir
cd "/c/Users/you/Local Sites/<site>/app/public/wp-content/plugins"
cmd //c mklink /J wp-headless-kit "C:\Projects\wp-headless\packages\wp-plugin"

# Install dev dependencies (phpcs etc.)
cd wp-headless-kit
composer install
```

Activate in `Plugins → Installed Plugins`. The plugin will register a single ability — `jab/get-posts` — under the default MCP server (`mcp-adapter-default-server`).

## What it does

Auto-discovers every public WordPress post type and registers two abilities per type — list and by-slug — under the `jab-content` category. Drop the plugin onto a WP site and every CPT registered with `public => true` is exposed by default; no edits required.

**Per post type, you get:**

| Ability                                          | Returns                                        | Default count |
| ------------------------------------------------ | ---------------------------------------------- | ------------- |
| `jab/get-<rest_base>` (e.g. `get-posts`, `get-beers`) | `{ <rest_base>: Item[] }`                  | 25            |
| `jab/get-<slug>-by-slug` (e.g. `get-beer-by-slug`)    | `{ <slug>: Item \| null }`                 | n/a           |

> Ability names derive from the post type's `rest_base` (and `slug` for the by-slug variant), not from the editor-editable plural label — so a Spanish admin renaming "Posts" to "Entradas" never breaks an MCP client. Override per-CPT via the `jab/headless_kit/ability_configs` filter.

When ACF is active, both abilities return an `acf` property per item, populated from any field groups declared on the post_type via simple `post_type==X` location rules (or page-implying rules like `page_template==X` for pages).

### Sync inputs on list abilities (v0.7.0)

Every `jab/get-<rest_base>` accepts these inputs in addition to the existing `numberposts` / `post_status` / `include`. All are optional with deterministic defaults; pre-0.7.0 callers see no behavior change (modulo a stable ID tiebreaker that newly disambiguates date ties).

| Input | Type | Default | Purpose |
| --- | --- | --- | --- |
| `page` | int (1–1000) | 1 | 1-based page number. Combined with `numberposts` to compute an offset. Ignored if `offset` is also provided. |
| `offset` | int (0–100000) | — | Direct record offset. Overrides `page` when both are present. Use for cursor-shaped sync. |
| `orderby` | enum | `date` | `date` \| `modified` \| `title` \| `menu_order` \| `id`. Always tie-broken by ID in the same direction as `order` (DESC primary → DESC ID tiebreaker, ASC → ASC) for deterministic paging. |
| `order` | enum | `desc` | `asc` \| `desc`. Tiebreaker direction follows. |
| `modified_after` / `modified_before` | string (RFC3339 UTC) | — | Window over `post_modified_gmt`, inclusive. Pair with `orderby=modified` for incremental sync. |
| `date_after` / `date_before` | string (RFC3339 UTC) | — | Window over `post_date_gmt`, inclusive. |
| `include_ids` | int[] (max 100) | — | Maps to `post__in`. Re-fetch a known set without scanning the CPT. When `numberposts` is omitted, the row cap auto-raises to the filter set size — no silent truncation. |
| `exclude_ids` | int[] (max 100) | — | Maps to `post__not_in`. |
| `slug_in` | string[] (max 100) | — | Maps to `post_name__in`. Same auto-raise behavior as `include_ids` when `numberposts` is omitted. |
| `taxonomy` | object | — | `{ <slug>: [term_slug, …], … }`. Only public taxonomies actually registered to the post type are honored; unknown keys are silently dropped. Capped at 100 term slugs per taxonomy. |

The filter array caps (`include_ids`, `exclude_ids`, `slug_in`, and each taxonomy's term list) match `numberposts`'s maximum of 100, so a filter set never asks for more rows than the page can return. An explicit `numberposts` always wins — a caller deliberately paging through 80 IDs with `numberposts=10` still gets a 10-record page.

Every row from both list and by-slug abilities now carries `modified` and `modified_gmt` (RFC3339, UTC). They are REQUIRED fields — run `jab sync` after upgrading.

### REST routes

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /wp-json/jab/v1/` | public | Health probe — the wizard's "Verify install" button. |
| `GET /wp-json/jab/v1/content-types` | `edit_posts` | Catalog of post types + real counts for the wizard's ownership picker. |
| `GET /wp-json/jab/v1/manifest` | `read` (filterable via `jab/headless_kit/manifest_capability`) | Full ability roster + schemas for the CLI's `jab sync` type generator. |
| `GET /wp-json/jab/v1/site` | `edit_posts` (filterable via `jab/headless_kit/site_manifest_capability`) | Site shape — identity, URLs, timezone, locale, front-page mode, branding (icon + logo), nav menu locations, image sizes, active theme. Used by the SaaS onboarding flow and CLI scaffold. |
| `GET /wp-json/jab/v1/diagnostics` | `manage_options` (filterable via `jab/headless_kit/diagnostics_capability`) | Diagnostic report — plugin/WP/PHP versions, JAB ability roster, resolved capability filters, ACF state, six health checks. Consumed by `wp jab doctor` and the SaaS onboarding wizard. |

All three REST capability filters share the same SEC-1-derived contract: returning a non-string or empty value resolves to WordPress's `do_not_allow` rather than silently reverting to the default. A typo in a mu-plugin shows up as a 403, not as a permissive default.

### Default exclusions

Auto-discovery skips the obvious internals: `attachment`, `revision`, `nav_menu_item`, `custom_css`, `customize_changeset`, `oembed_cache`, `user_request`, `wp_block`, `wp_template`, `wp_template_part`, `wp_global_styles`, `wp_navigation`, `acf-field-group`, `acf-field`. Override with the `jab/headless_kit/post_type_excludes` filter (see below).

### Customizing for a specific site

Drop a single mu-plugin file in `wp-content/mu-plugins/` to customize without forking:

```php
<?php
// mu-plugins/headless-customizations.php

// Skip an additional post type:
add_filter( 'jab/headless_kit/post_type_excludes', function ( $excludes ) {
    $excludes[] = 'private_internal_cpt';
    return $excludes;
} );

// Override a specific ability's labels, description, or count:
add_filter( 'jab/headless_kit/ability_configs', function ( $configs ) {
    foreach ( $configs as &$cfg ) {
        if ( 'coa' === $cfg['post_type'] ) {
            $cfg['noun_single']  = 'certificate of analysis';
            $cfg['noun']         = 'certificates of analysis';
            $cfg['description']  = 'Retrieves entries from the Certificates of Analysis (`coa`) custom post type.';
            $cfg['default_count'] = 50;
        }
        if ( 'post' === $cfg['post_type'] ) {
            $cfg['default_count'] = 5; // recent posts, not all
        }
    }
    return $configs;
} );
```

Filter hooks fire at `wp_abilities_api_init`, so they apply the next time WP boots — no cache to flush, no admin action needed.

**Supported ACF field types:**

| Category | Types |
| --- | --- |
| Scalars | text, textarea, wysiwyg, oembed, number, range, true_false, url, email, date_picker, date_time_picker, time_picker, color_picker |
| Choice | select, radio, button_group, checkbox |
| Media | image, file, gallery (`return_format`-aware: `array` / `url` / `id`) |
| Links | link (`array`/`url`), page_link (single or `multiple`) |
| Relations | post_object, relationship (`return_format`-aware: `object` / `id`, `multiple`) |
| Composite | group (recursive), repeater (recursive), flexible_content (emitted as `oneOf` discriminated by `acf_fc_layout`) |
| Geo | google_map (`{ address, lat, lng }`) |

**Skipped** (dropped from the schema): tab, message, accordion, clone, taxonomy, user (silent — these have no value to emit). Also **password** — ACF stores password fields in plaintext, so they are never exposed via the headless API. Field groups whose location rules are anything more complex than a single `post_type==<name>` clause are also ignored.

When `WP_DEBUG` is on, every skipped group and dropped field is logged to `wp-content/debug.log` and is also available programmatically via `\Jab\WpHeadlessKit\Acf\Schema::diagnostics()` — useful when an AI agent reports "I can't see field X" and you need a fast answer.

**Other abilities:**

| Ability          | Returns                                                 |
| ---------------- | ------------------------------------------------------- |
| `jab/get-menus`  | All registered nav menus + items + theme locations      |
| `jab/get-<rest_base>-terms` (per public taxonomy, e.g. `jab/get-categories-terms`) | `{ <rest_base_snake>: Term[] }` — flat list of `{ id, name, slug, description, count, parent_id }` |

**Taxonomy abilities — wrapper key vs slug.** Both the ability name and the wrapper key derive from the taxonomy's `rest_base` (e.g. `category` → ability `jab/get-categories-terms`, wrapper `categories`). The per-post taxonomy field on CPT-list rows is keyed by the **slug** (e.g. `category`). These can differ when a taxonomy's `rest_base` is customized. The plugin surfaces the slug via `meta.jab.taxonomy_slug` on each taxonomy ability so the generated SDK emits a `@taxonomy <slug>` JSDoc tying the two together at consumer call sites. The `-terms` suffix is structural — it guarantees a taxonomy ability never collides with a CPT-list ability of the same name.

Marked `meta.mcp.public => true`, so it flows through the default MCP server and is callable via:

- `mcp-adapter/discover-abilities` (list)
- `mcp-adapter/execute-ability` (invoke with `name=jab/get-posts`)

## Verifying the integration

```bash
# List available MCP servers (should include mcp-adapter-default-server)
wp mcp-adapter list

# Open a stdio session against the default server
wp mcp-adapter serve --user=admin --server=mcp-adapter-default-server
```

Send a `tools/list` JSON-RPC payload to confirm `mcp-adapter/discover-abilities` and `mcp-adapter/execute-ability` are exposed. Then call:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "mcp-adapter/execute-ability",
    "arguments": { "name": "jab/get-posts", "arguments": { "numberposts": 3 } }
  }
}
```

## What's new in 0.7.0

Production-sync hardening: the CPT-list abilities gain a real pagination / ordering / incremental-sync / filter surface, every row now exposes a canonical `modified` timestamp, and a new `/wp-json/jab/v1/site` endpoint hands the SaaS onboarding flow and CLI generator the structural site facts (front page, branding, menus, image sizes, theme) without crawling. Two existing capabilities — `/manifest` auth and the new `/site` auth — route through filters so an agency can tighten access without forking.

**Type-only breaking change.** `modified` and `modified_gmt` are REQUIRED on every list and by-slug item, so the generated SDK's `Item` shape gains two non-optional keys. Run `jab sync` after upgrading.

| ID | Severity | What changed |
| --- | --- | --- |
| **SYNC-1** | Medium (additive) | `jab/get-<rest_base>` list abilities accept four new pagination/ordering inputs: `page` (1-based, max 1000), `offset` (direct cursor, overrides `page` when both are given), `orderby` (`date` / `modified` / `title` / `menu_order` / `id`, defaults `date`), and `order` (`asc` / `desc`, defaults `desc`). Every sort gets a secondary `ID` clause matching the primary direction so paged sync sees every record exactly once — without the tiebreaker, WP_Query's natural ordering for ties is implementation-defined and a SaaS sync can double-count or skip rows. |
| **SYNC-2** | Medium (additive) | Four new incremental-sync window inputs: `modified_after`, `modified_before` (apply to `post_modified_gmt`), `date_after`, `date_before` (apply to `post_date_gmt`). All windows are `inclusive`, so a caller passing "since last sync at T" sees records at T as well as after. SaaS use case: "give me everything that changed since the last sync run." |
| **SYNC-3** | Medium (additive) | Three new ID/slug filters: `include_ids: int[]` → `post__in`, `exclude_ids: int[]` → `post__not_in`, `slug_in: string[]` → `post_name__in`. All capped at 100 items per call — matching the `numberposts` maximum so a filter set never asks for more rows than the page can return. When a filter is present without an explicit `numberposts`, the row cap auto-raises to the filter set size (no silent truncation; an explicit `numberposts` still wins). SaaS use case: "re-fetch a known set without scanning the whole CPT." |
| **SYNC-4** | Medium (additive) | New `taxonomy` input: an object whose keys are taxonomy slugs and values are arrays of term slugs to filter by. Only public taxonomies actually registered to the post type are honored — unknown keys are silently dropped so a caller can't probe for private taxonomies by watching which inputs WP_Query reflects in the row set. |
| **SYNC-5** | High (type-only) | Every list and by-slug item now carries `modified` and `modified_gmt` (RFC3339, UTC). Both keys are REQUIRED in `output_schema`. The plugin emits the GMT value in both keys (`modified` ≡ `modified_gmt`) for WP REST envelope parity. Never-edited posts fall back to the publish date rather than the 1970 epoch sentinel — "modified" for an untouched post is conceptually "published" in every CMS. **SDK regen required.** |
| **MANIFEST-1** | Medium (additive) | New REST route at `/wp-json/jab/v1/site` exposes the site shape the SaaS onboarding flow and CLI scaffold need: identity (title, tagline, home/site URL, timezone, locale, permalink structure), front page mode (`posts` vs `page`) with resolved IDs/slugs for the static front + posts page, branding (site icon URL, custom logo attachment + URL), registered nav menu locations, image sizes (built-in + theme/plugin-registered), and active theme (slug, name, version). Auth: `edit_posts` by default — one step tighter than `/manifest` because the response includes theme + static-page slugs that aren't already public. Filterable via `jab/headless_kit/site_manifest_capability`. |
| **AUTH-1** | Low (additive) | `/wp-json/jab/v1/manifest` capability is now filterable via `jab/headless_kit/manifest_capability` (default still `read` — bumping it would break Application Password sync flows the CLI relies on). The new filter mirrors `Permissions::ability_capability()` and `SiteManifest::capability()`: a non-string or empty return resolves to `do_not_allow` rather than silently falling back to the default — the SEC-1 lesson is that silent fall-back to a permissive default is the failure mode worth designing against. |
| **LINT-1** | Trivial | One PHPCS alignment warning in `Acf\Schema::for_post_type()` fixed. Restores `composer lint` to a clean 0-warning baseline. |

**Migration:**

1. Run `jab sync` after upgrading. The required `modified` / `modified_gmt` fields will land in the generated SDK's item shape; calling code that destructures the item with the old shape continues to type-check (extra fields are fine), but a `Item` value built by hand in a test fixture or mock will fail until the new fields are added.
2. No runtime breaking changes — the new input fields are all optional with backward-compatible defaults, and existing callers that don't pass them get pre-0.7.0 behavior (modulo the deterministic-ID-tiebreaker on `orderby`, which can change the ordering of ties for callers that previously relied on WP_Query's implementation-defined behavior).
3. To take advantage of incremental sync, the SaaS sync layer should switch to `orderby=modified` + `modified_after=<last_run_iso>` and page with `page` + `numberposts`. There is no `per_page` alias — the input has always been `numberposts`, and v0.7.0 keeps that name for backward compatibility.

**Known limitations (carried to v0.7.1+):**

- No `total_count` in the response envelope. List abilities still run with `no_found_rows => true` for perf; surfacing a count would require an extra COUNT(*) per call. A future `include.total_count` flag could opt callers in.
- `orderby` doesn't yet accept arbitrary `meta_key`-based sorts. Out of scope for v0.7.0 because the safe-surface set requires schema discovery of which meta keys are queryable.
- No `status` field on the row output for edit-capable users. Deferred — every existing consumer reads `post_status` only via the input filter, and adding a row-side field requires the same per-call permission check the input filter already does.

## What's new in 0.7.1 — Connector Diagnostics (2026-06-02)

**New surfaces:**

- `wp jab doctor` WP-CLI command. Three formats (`table`, `json`, `yaml`), three flags (`--strict`, `--debug-acf`, `--format`). Reports plugin / WP / PHP versions, JAB ability roster, post-type and taxonomy universe (after exclusions), every resolved `jab/headless_kit/*_capability` value, ACF state including the per-CPT skipped-group ledger, plus six health checks (Abilities API, MCP Adapter, REST routes, post type discovery, Application Passwords availability, ACF schema-skip ledger). Exits 1 on any `fail`; `--strict` also exits 1 on any `warn`.
- `GET /wp-json/jab/v1/diagnostics` REST endpoint. Returns the same report shape. Default capability `manage_options`, filterable via `jab/headless_kit/diagnostics_capability` with the same `do_not_allow` fallback for non-string / empty returns that the existing `manifest_capability` and `site_manifest_capability` filters use.

**Underlying changes:**

- `Jab\WpHeadlessKit\Registry::discovered_post_types()` and `discovered_taxonomies()` are now public — single source of truth for the diagnostics facts and the existing private registration callers.
- `Jab\WpHeadlessKit\Acf\Schema::flush_cache()` is now public. Bumps a new `jab_acf_schema_generation` option that mixes into the per-CPT ACF schema transient key as an invalidation salt. The `--debug-acf` CLI flow uses it.

**Type-only breaking changes:** none.

**Post-merge fixes (2026-06-02):**

- `Diagnostics\Report::collect_environment()` now calls `rest_get_server()` itself rather than gating route discovery on `did_action( 'rest_api_init' ) > 0`. In WP-CLI boot the gate is false at command time, so `wp jab doctor` previously false-failed with `0/5 routes present` on healthy installs. `rest_get_server()` is idempotent: in REST request context it returns the cached server, and in WP-CLI it instantiates the server and fires `rest_api_init`, which registers the JAB routes.
- The MCP Adapter version now reads `WP\MCP\Core\McpAdapter::VERSION` (the class constant), falling back to the global `WP_MCP_VERSION` only when the class is missing. The global constant is only defined when the adapter loads as a standalone plugin via its `mcp-adapter.php` bootstrap — with our Composer + Jetpack Autoloader setup only the class autoloads, so the global was always undefined and `wp jab doctor` reported `wordpress/mcp-adapter vunknown detected.`

**Deferred to v0.7.x:** the `acf_no_schema_skips` check's populated-ledger branch is unit-tested but not integration-tested — integration coverage arrives with the ACF wp-env slot in Phase 1.1.

## What's new in 0.6.3

Fixes the third silent bug from the SaaS v2 pilot smoke — output-schema validation hard-failing on every page that contained a registered Gutenberg block. **No type or runtime JSON change** for consumers; purely a validator-compatibility fix to the block-items schema.

| ID | Severity | What changed |
| --- | --- | --- |
| **FIX-5** | High (silent, every-page) | `BlockSchema::block_items_one_of()` emits the top-level discriminated union over per-block-type variants as `anyOf` instead of `oneOf`. The v0.6.0 design relied on the unknown-fallback variant carrying `not: { enum: known_block_names }` to exclude blocks already covered by a typed variant — so that, under `oneOf`, exactly one variant would match each block. In practice, WP core's `rest_validate_value_from_schema` **does not honor `not` inside `oneOf` alternatives** (it is not in the supported-keyword set for combining operators), so the exclusion is silently ignored. Every registered block then matched BOTH its typed variant AND the permissive fallback, and `rest_find_one_matching_schema` rejected the response with "output[...][blocks][N] matches more than one of the expected formats" — breaking every `jab/get-{cpt}-by-slug` call with `include.blocks=true` (which is the default on by-slug) for any post containing a registered block. The fix is to switch the top-level to `anyOf`, which tolerates multi-match. At the type-system level, `json-schema-to-typescript` emits identical unions for `oneOf` and `anyOf`, and SDK consumers narrow with `block.blockName === "core/paragraph"` at the application level — runtime exclusivity isn't required for the discriminated-union ergonomic. The nested `oneOf<string, null>` on `blockName` and `innerContent` items stays as `oneOf`: those are type-discriminated (string vs null), mutually exclusive by definition, and not subject to the `not`-ignore issue. |

## What's new in 0.6.2

Two silent bugs discovered during the SaaS v2 pilot smoke against Two Roads Brewing. No runtime JSON change for working consumers; one fix unblocks broken by-slug calls on sites that don't set a plural `rest_base`.

| ID | Severity | What changed |
| --- | --- | --- |
| **FIX-3** | High (silent, upgrade-only) | `Acf\Schema::for_post_type()` caches the derived ACF schema in a WP transient keyed by ACF field group fingerprint (group key + modified timestamp). v0.6.0–v0.6.1 did **not** include the plugin version in the cache key, so any upgrade that changed how `to_field_schema()` emits a field type (e.g. v0.6.1 dropped `enum` from select/checkbox and `format` from url/email/date) silently read back the OLD schema shape from the previous version's transient — until the 1-hour TTL expired or an admin re-saved a field group. Symptom: output-validation failures hard-fail `jab/get-*` list calls because the strict cached schema no longer matches relaxed runtime data. v0.6.2 mixes `Jab\WpHeadlessKit\VERSION` into the cache-key MD5 so any plugin upgrade is a guaranteed cache bust. Sites stuck on the stale cache from a prior version need a one-time transient flush (delete options matching `_transient_jab_acf_schema_%` and `_transient_timeout_jab_acf_schema_%`) — afterwards the cache rebuilds correctly on the next request. |
| **FIX-4** | High (silent, common case) | When a CPT has `rest_base` equal to its slug (the default for plugin-registered CPTs that don't bother setting a plural rest_base — e.g. Two Roads' `beer`, `event`, `flavor`, `location`, `team`), `Registry::register_abilities()` was running `ensure_unique_name()` on both `name` and `name_single` in the same iteration. Since both derive identically when rest_base == slug, the second call falsely flagged a collision and renamed `name_single` to `<name>-2`. The mangled base flowed into `derive_by_slug_config()` and produced by-slug names like **`jab/get-beer-2-by-slug`** instead of the expected `jab/get-beer-by-slug` — silently breaking every consumer that derives by-slug names from the CPT slug (the documented convention in `resolveCptAbilityMeta`). v0.6.2 removes the `ensure_unique_name()` call on `name_single`: it's a derivation base, not a registered ability name, so the collision pool shouldn't contain it. The final by-slug name is still dedupe-checked, so genuine cross-CPT collisions still surface via `_doing_it_wrong()`. |

## What's new in 0.6.1

Output schemas relax field-level constraints (`enum`, `format`) to tolerate real-world data drift. **Type-only breaking change**: SDK consumers that previously narrowed select/radio/button_group/checkbox values to the field's choice list will now see `string` / `string[]` — the choices are preserved under the new `x-acf-choices` vendor extension on the schema for documentation and example-generation, but no longer constrain the type.

| ID | Severity | What changed |
| --- | --- | --- |
| **FIX-1** | High (silent) | `Acf\Schema::enum_string()` (used by select / radio / button_group / checkbox) drops `enum` and emits `x-acf-choices` instead. Reason: admin edits to a choice list, a CSV import pasting legacy values, a removed choice — any of these can produce a single bad row that hard-fails the entire `jab/get-{cpt}` list call via mcp-adapter's strict output validation. The vendor-extension keeps the intent visible to the manifest. |
| **FIX-2** | Medium | `url`, `email`, `date_picker`, `date_time_picker`, `page_link` ACF fields, plus `MediaSchema::image_object().url`, `PostTypeListAbility` / `PostTypeBySlugAbility` `link`, and `date`, no longer carry `format: uri/email/date/date-time`. Same rationale — real data routinely fails strict JSON-Schema `format` (legacy posts with non-ISO dates, empty url fields, etc.). Input schemas are unchanged. |

## What's new in 0.6.0

Typed-block moat: the v0.5.0 generic `BlockNode[]` schema tightens into a per-block-type discriminated union, ACF Blocks (`acf/*`) get the full ACF enrichment treatment, and a new manifest endpoint exposes ability schemas to the CLI's `jab sync` type generator. **Type-only breaking change** for SDK consumers — regenerate types after upgrading.

| ID | Severity | What changed |
| --- | --- | --- |
| **TYPED-1** | Medium | The `blocks` field's per-item schema becomes a `oneOf` discriminated union over one variant per registered block type (derived from `WP_Block_Type_Registry`) plus a permissive fallback for unknown blocks. The generated SDK's `BlockNode` becomes `ParagraphBlock \| HeadingBlock \| ... \| UnknownBlock`, and code that does `block.attrs.foo` for a known block type must now narrow via `block.blockName === 'core/paragraph'` first. Runtime JSON is unchanged. |
| **TYPED-2** | Medium | ACF Blocks (`acf/*`) now get the full ACF enrichment treatment. Bound field groups (via `block==<name>` location rules) type `attrs.data` end-to-end — image fields resolve to attachment objects, Flex Content gets the discriminated `oneOf` shape, format-constrained strings drop when malformed. Closes the v0.5.0 known limitation. |
| **CLI-1** | Low | New REST route at `/wp-json/jab/v1/manifest` returns the full ability roster (names, categories, input/output schemas, meta) for CLI consumption. Auth: `read` capability via Application Password. The CLI's `jab sync` will consume this to regenerate `lib/sdk/types.ts`. Note: schemas may include internal field names; gated on `read` (Subscriber+), not anonymous. |
| **DX-3** | Low | New `Schema\AcfValueWalker` extracted from `PostTypeListAbility::walk_and_enrich()` so both post-meta-bound ACF and ACF Block enrichment reuse the same recursive walker. No behavior change for existing consumers. |
| **FIX-1** | High (silent) | The fallback block-node variant's `blockName` string branch carries `not: { enum: [...known names] }` so a known block like `core/paragraph` doesn't dual-match its typed variant **and** the fallback. Without this exclusion WP's `rest_find_one_matching_schema` rejects responses with "matches more than one of the expected formats." Caught in the post-implementation code review; would have surfaced the moment any consumer with registered block types enabled `include.blocks=true`. |
| **FIX-2** | Low | `Rest\Manifest::collect_abilities()` pre-guards empty ability names before the `strpos` prefix check. `strpos('', 'jab/')` returns `false` in PHP 7.4 and `0` in PHP 8.0+ — without the pre-guard, an empty-named ability would silently leak into the manifest on PHP 8+. |

**Migration:** Run `jab sync` after upgrading to regenerate type definitions. Existing SDK code that didn't narrow `BlockNode.attrs` will get TypeScript errors pointing to exactly the lines that need narrowing — this is the intended ergonomic. No runtime breaking changes; JSON responses are byte-identical for non-ACF blocks, and ACF Blocks gain enrichment without changing shape.

**Carried over from v0.5.0 known limitations (still pending v0.7+):**

- `innerBlocks` schema remains loose. WP core's REST validator doesn't support `$ref` for recursive shapes; tightening the inner shape would break validation for any tree more than one level deep.
- `BlockExpander::load_reusable_blocks` still does an uncached `get_post()` + `parse_blocks()` per `core/block` reference. Memoize when profile data shows it's hot.
- `jab/get-page-schema` aggregator still deferred until pilot evidence demands fewer round-trips.

## What's new in 0.5.0

Adds block-aware emission so Gutenberg / page-builder / classic-editor sites can be reconstructed faithfully from MCP responses, not just from titles + excerpts. No breaking changes — existing callers see no behavior difference unless they opt in via the new `include` input field.

| ID | Severity | What changed |
| --- | --- | --- |
| **CONTENT-1** | High | Each item from `jab/get-<rest_base>` and `jab/get-<slug>-by-slug` can now include raw `post_content` (string), a parsed `blocks` tree (`parse_blocks()` shape, normalized), and a fully `rendered_content` string (post_content run through `the_content` filters). All three are gated by a new `include` input flag. Item types in your generated SDK now expose `content?: string`, `blocks?: BlockNode[]`, `rendered_content?: string` as optional keys. |
| **CONTENT-2** | Medium | `core/block` reusable-block references are expanded inline. When `include.blocks=true`, every `core/block { ref: N }` node has its `innerBlocks` populated from the referenced `wp_block` post (publish-status only). The `core/block` envelope is preserved so consumers can still detect "this was a reusable block." Circular references are bounded by a visited-set. |
| **API-2** | Medium (additive) | New `include` object input on list and by-slug abilities: `{ content?: bool, blocks?: bool, render?: bool }`. **List abilities default everything off** to protect payload size on long content type lists. **By-slug abilities default `content` + `blocks` on** since they're single-record fetches. `render` defaults off everywhere (opt-in for dynamic block rendering / shortcode execution). |
| **DX-2** | Low | New `BlockParser` + `BlockExpander` + `BlockSchema` classes under `includes/Schema/` and `includes/Abilities/`. Designed for extension: when the v0.6 per-block-type discriminated-union work lands, the typing tightens for known blocks without changing the include-flag API. |

**Migration for SDK consumers:** existing generated clients are unaffected — the new optional fields don't appear in responses unless the caller opts in. Run `jab sync` to regenerate type definitions and pick up the new optional `content`/`blocks`/`rendered_content` keys. Existing app code that ignores them still type-checks cleanly.

**Known limitations (deferred to v0.6+):**

- **`innerBlocks` schema is loose.** WP core's REST schema validator doesn't support `$ref`, so we can't self-reference for recursive shapes. The top-level `BlockNode` is strictly typed; nested `innerBlocks` items are declared `additionalProperties: true` with no `required`. The SDK can layer a recursive TS type on top.
- **Block attributes are generic.** Every block's `attrs` is `Record<string, unknown>`. The v0.6 per-block-type schema work (synthesized from `WP_Block_Type_Registry`) will tighten this into a discriminated union, the same way `flexible_content` already produces one.
- **ACF Blocks (`acf/*`) attribute payloads are raw.** Block-level ACF field values aren't run through the existing `walk_and_enrich()` enrichment — image fields ship as attachment IDs, nested Flex Content as raw arrays. Fix path is `AcfSchema::for_block_name()` walking `block==<name>` location rules, v0.6.
- **`include.render=true` executes the `the_content` filter chain.** That includes block rendering, shortcode expansion (`do_shortcode` attaches at priority 11), oEmbed handling, and any plugin-registered filters. The SEC-1 status filter still applies — Subscriber-tier callers only see published posts — but be aware this is the shortcode execution surface. Use defensively on shared multi-tenant sites.
- **`innerHTML` is not sanitized.** `parse_blocks()` returns markup verbatim; the SDK is responsible for sanitization at the rendering layer.
- **The CLI's `jab sync` doesn't yet expose `include` defaults.** Per-call usage is fine via the SDK; the manifest endpoint for surfacing input-schema defaults to the type generator is a v0.6 follow-up.

## What's new in 0.4.0

Audit-driven hardening release. **Includes one breaking change to ability names** — see API-1 below.

| ID | Severity | What changed |
| --- | --- | --- |
| SEC-1 | Critical | Subscriber-authenticated callers can no longer request `post_status=draft` and enumerate every unpublished post. `execute()` now downgrades the requested status to `publish` unless the caller has `edit_posts` on the CPT, and `get_posts()` runs with `perm => readable` as defence in depth. |
| SEC-2 | Medium | The `read` capability gate is now routed through a `jab/headless_kit/ability_capability` filter so agencies can tighten (or loosen) access without forking. |
| SEC-3 | Low | ACF `password` field type is no longer emitted into the schema or the response. Plaintext password fields in ACF will never leak through the headless API. |
| BUG-1 | High | Empty `format`-constrained strings (uri / email / date / date-time) no longer fail REST output validation. The ACF walker drops empty `format` values, `shape_row()` falls back through `post_date_gmt → post_date → modified → now`, and nav menu items no longer require `format: uri` on `url` (so label-only parent dropdowns work). |
| BUG-2 | Medium | `Registry::ensure_unique_name()` reserves each ability name and suffixes `-2`, `-3`, … on collision, with a `_doing_it_wrong()` breadcrumb. |
| ERR-1 | Medium | `TaxonomyTermsAbility` no longer throws `\RuntimeException` on a `get_terms()` failure — it returns an empty list and logs a breadcrumb. Every ability now has the same failure contract. |
| **API-1** | **High (breaking)** | Ability **names** + wrapper keys now derive from the post type's `rest_base` (and `WP_Taxonomy->rest_base`), not from editor-editable labels. Taxonomy abilities now end in `-terms` to structurally separate from CPT-list abilities. **Regenerate your SDK** after upgrading: `jab sync`. |
| PERF-1 | Medium | `AcfSchema::for_post_type()` caches its output in a transient keyed by a content fingerprint of every loaded ACF field group. Schema invalidates lazily when an admin saves a group. |
| DX-1 | Medium | Skipped ACF groups + dropped fields are recorded in a per-request ledger (`Schema::diagnostics()`), and — when `WP_DEBUG` is on — logged to `wp-content/debug.log`. Resolves "the AI can't see field X" debugging cycles. |
| META-1 | Low | `Requires at least` is now `6.9` everywhere (plugin header, README, `phpcs.xml.dist`) — the Abilities API has been in core since 6.9. The plugin still bundles `wordpress/abilities-api` as a safety net; that bundle drop is a future strategic call (audit WP7-1). |

**Migration for SDK consumers (API-1):** existing generated clients reference the old label-derived ability names (e.g. `jab/get-beers`). After upgrading the plugin, run `jab sync` to regenerate the type definitions and re-export the SDK. Any custom code in your Next.js project that calls `getBeers(...)` will continue to compile; if you'd locked the underlying ability name with a `jab/headless_kit/ability_configs` mu-plugin override, that override still wins.

## Schema-correctness fixes baked into source

A few subtle correctness traps live at the intersection of ACF, WP-REST schema validation, and `wp_get_object_terms()`. All four are fixed in this plugin's source — you don't need to patch your install, you just need to be running **v0.3.0 or later** (the release that introduced these fixes). To check, look at the `Version:` header in `wp-headless-kit.php` or call `wp plugin list --name=wp-headless-kit --field=version`.

| Symptom | Root cause | Where the fix lives |
| --- | --- | --- |
| CPT-list responses return empty taxonomy arrays even though posts ARE tagged | `wp_get_object_terms( $ids, $taxonomies )` defaults to `fields=all`, which dedupes term rows across the input set and leaves `WP_Term->object_id` unset — the grouping loop then buckets every term under post 0 | [`PostTypeListAbility::batch_terms()`](includes/Abilities/PostTypeListAbility.php) — explicitly passes `[ 'fields' => 'all_with_object_id' ]` |
| Flex-content responses fail with `Ability "..." has invalid output. Reason: ... matches more than one of the expected formats.` | WP core's `rest_validate_value_from_schema` silently ignores JSON Schema `const`, so every `oneOf` variant accepts every value | [`Schema::flexible_content_variants()`](includes/Acf/Schema.php) — emits `enum: [<name>]` for the `acf_fc_layout` discriminator instead of `const: <name>`; [`PostTypeListAbility::pick_variant()`](includes/Abilities/PostTypeListAbility.php) accepts either shape for runtime walking |
| Block-aware responses (v0.6+ with `include.blocks=true`) fail with `... matches more than one of the expected formats.` whenever a known block (`core/paragraph`, `acf/hero`, …) is present | The fallback variant in the `blocks` `oneOf` accepted any `blockName: string`, so a known block name satisfied both its typed variant and the fallback — and `rest_find_one_matching_schema` requires exactly one match | [`BlockSchema::block_node_schema()`](includes/Schema/BlockSchema.php) — fallback's string branch carries `not: { enum: [...known names] }` built from [`BlockSchema::known_block_names()`](includes/Schema/BlockSchema.php); walks `BlockTypeSchema::all_variants()` to enumerate every typed-variant name |
| Posts with zero terms in a public taxonomy break the entire endpoint with `<taxonomy> is a required property` | `output_schema` marked every taxonomy `required`, but `shape_row()` only set the field when terms existed | [`PostTypeListAbility::shape_row()`](includes/Abilities/PostTypeListAbility.php) — seeds every taxonomy slot to `[]` before merging actual terms |
| SDK's first concurrent calls (e.g. `Promise.all([getX, getY])` on a cold client) fail with `Session not found` | Two parallel callers both POST `initialize`, both write to module-level `sessionId`, and the second `notifications/initialized` races the first session's lifetime | [`packages/core/src/emit/client.ts`](../core/src/emit/client.ts) — `ensureInitialized()` is a singleton in-flight promise; concurrent callers all await the same handshake |

If your jab-generated frontend shows symptoms above, `composer install` (or download the latest release zip) — every fix is in upstream source.

## Architecture notes

The plugin is intentionally thin. Transport, error handling, and observability are entirely the responsibility of [`wordpress/mcp-adapter`](https://github.com/WordPress/mcp-adapter). This package only:

1. Boots Jetpack Autoloader (so we coexist with other MCP-aware plugins).
2. Verifies `WP\MCP\Core\McpAdapter` is loaded.
3. Registers an ability category and one ability.

Everything else — JSON-RPC, stdio transport, the default MCP server, WP-CLI integration — comes from the adapter.

## Linting

```bash
composer lint        # phpcs
composer lint:fix    # phpcbf
```

## Building a release

```bash
./bin/build-release.sh
```

Produces `dist/wp-headless-kit-<version>.zip` with `vendor/` bundled (production deps only). The version is parsed from the `Version:` header in `wp-headless-kit.php` — bump it there before building.

Requires `composer` and `zip` on `PATH`. Both are present in standard Git Bash on Windows; on Linux/macOS install via your package manager.
