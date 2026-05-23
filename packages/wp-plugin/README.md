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
