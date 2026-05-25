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
