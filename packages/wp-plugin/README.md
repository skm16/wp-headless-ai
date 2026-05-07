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

## What it does (v0.1.0)

Registers content-read abilities under the `skm-content` category:

**CPT-list abilities** (factory: `Abilities\PostTypeListAbility`):

| Ability                       | CPT                | Default count |
| ----------------------------- | ------------------ | ------------- |
| `skm/get-posts`               | `post`             | 5             |
| `skm/get-beers`               | `beer`             | 12            |
| `skm/get-events`              | `event`            | 10            |
| `skm/get-locations`           | `location`         | 25            |
| `skm/get-team`                | `team`             | 25            |
| `skm/get-distributors`        | `distributor`      | 25            |
| `skm/get-food`                | `food`             | 25            |
| `skm/get-food-truck-events`   | `food-truck-event` | 25            |
| `skm/get-flavors`             | `flavor`           | 25            |
| `skm/get-coas`                | `coa`              | 25            |

When ACF is active, every ability above also returns an `acf` property per item, populated from any field groups declared on the post_type via simple `post_type==X` location rules.

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
