# wp-headless-kit (WordPress plugin)

Thin WordPress plugin that exposes content as MCP (Model Context Protocol) abilities, so AI-iterable headless frontends can read this site through the official WordPress MCP Adapter.

## Requirements

- WordPress **6.6+** — the plugin bundles `wordpress/abilities-api` so it works pre-6.9. On WP 6.9+ the bundled package detects core and stays out of the way.
- PHP **7.4+**
- Composer (only for dev install — release zip ships with `vendor/` bundled)

## Install

There are two install paths — pick the one that matches what you're doing.

### Drop-in (production / agency hand-off)

Use the pre-built zip. No PHP / Composer required on the target site.

1. Build (or download a release):
   ```bash
   ./bin/build-release.sh
   # → dist/wp-headless-kit-<version>.zip
   ```
2. WP Admin → **Plugins → Add New → Upload Plugin** → choose the zip → **Install** → **Activate**.

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

Activate in `Plugins → Installed Plugins`. The plugin will register a single ability — `skm/get-posts` — under the default MCP server (`mcp-adapter-default-server`).

## What it does

Auto-discovers every public WordPress post type and registers two abilities per type — list and by-slug — under the `skm-content` category. Drop the plugin onto a WP site and every CPT registered with `public => true` is exposed by default; no edits required.

**Per post type, you get:**

| Ability                                | Returns                                      | Default count |
| -------------------------------------- | -------------------------------------------- | ------------- |
| `skm/get-<plural>` (e.g. `get-beers`)  | `{ <plural>: Item[] }`                       | 25            |
| `skm/get-<singular>-by-slug`           | `{ <singular>: Item \| null }`               | n/a           |

When ACF is active, both abilities return an `acf` property per item, populated from any field groups declared on the post_type via simple `post_type==X` location rules (or page-implying rules like `page_template==X` for pages).

### Default exclusions

Auto-discovery skips the obvious internals: `attachment`, `revision`, `nav_menu_item`, `custom_css`, `customize_changeset`, `oembed_cache`, `user_request`, `wp_block`, `wp_template`, `wp_template_part`, `wp_global_styles`, `wp_navigation`, `acf-field-group`, `acf-field`. Override with the `skm/headless_kit/post_type_excludes` filter (see below).

### Customizing for a specific site

Drop a single mu-plugin file in `wp-content/mu-plugins/` to customize without forking:

```php
<?php
// mu-plugins/headless-customizations.php

// Skip an additional post type:
add_filter( 'skm/headless_kit/post_type_excludes', function ( $excludes ) {
    $excludes[] = 'private_internal_cpt';
    return $excludes;
} );

// Override a specific ability's labels, description, or count:
add_filter( 'skm/headless_kit/ability_configs', function ( $configs ) {
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
| Scalars | text, textarea, wysiwyg, oembed, password, number, range, true_false, url, email, date_picker, date_time_picker, time_picker, color_picker |
| Choice | select, radio, button_group, checkbox |
| Media | image, file, gallery (`return_format`-aware: `array` / `url` / `id`) |
| Links | link (`array`/`url`), page_link (single or `multiple`) |
| Relations | post_object, relationship (`return_format`-aware: `object` / `id`, `multiple`) |
| Composite | group (recursive), repeater (recursive) |
| Geo | google_map (`{ address, lat, lng }`) |

**Skipped** (silently dropped from the schema): tab, message, accordion, clone, flexible_content, taxonomy, user. Field groups whose location rules are anything more complex than a single `post_type==<name>` clause are also ignored.

**Other abilities:**

| Ability          | Returns                                                 |
| ---------------- | ------------------------------------------------------- |
| `skm/get-menus`  | All registered nav menus + items + theme locations      |

Marked `meta.mcp.public => true`, so it flows through the default MCP server and is callable via:

- `mcp-adapter/discover-abilities` (list)
- `mcp-adapter/execute-ability` (invoke with `name=skm/get-posts`)

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
    "arguments": { "name": "skm/get-posts", "arguments": { "numberposts": 3 } }
  }
}
```

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
