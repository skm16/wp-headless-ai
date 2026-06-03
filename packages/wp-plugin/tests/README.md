# wp-plugin tests

Two layers of test coverage (PROC-1 in `docs/wp-plugin-audit.md`):

1. **Pure unit tests** — exercise pure functions that don't need a WordPress
   runtime (e.g. ACF schema generation from a fixture field group, ability-name
   derivation from a fake `WP_Post_Type` shape). Run with plain PHPUnit, no
   harness required. This directory's `unit/` folder is the home for these.
2. **WordPress integration tests** — exercise the JAB plugin against a real
   WordPress runtime via wp-env. The `integration/` folder is the home for
   these. Phase 1 (landed 2026-06-01) ships the harness scaffolding plus
   three test files: `HarnessSmokeTest`, `Abilities/Sec1SubscriberDraftTest`,
   and `Abilities/RegistryRestBaseSlugCollisionTest`. See
   `docs/superpowers/specs/2026-06-01-wp-plugin-phase-1-integration-harness-design.md`
   for the design and the Phase 1.1 follow-up scope.

## Running the unit tests locally

```bash
cd packages/wp-plugin
composer install
composer test:unit
```

The unit suite has zero runtime dependencies and runs in ~1 second.

## Running the integration tests locally

Requires Docker (for wp-env) and pnpm (workspace-root).

```bash
# From the workspace root (one-time):
pnpm install
pnpm -w exec wp-env start  # ~3-5 min first time, ~30s thereafter

# From packages/wp-plugin (one-time — installs yoast/phpunit-polyfills,
# which the WP test framework's bootstrap requires):
cd packages/wp-plugin
composer install

# From packages/wp-plugin (every run):
composer test:integration
```

To stop wp-env when done: `pnpm -w exec wp-env stop` from the workspace root.

To run a single test file: `composer test:integration -- --filter HarnessSmokeTest`.

## CI

The GitHub Actions workflow at `.github/workflows/ci-plugin.yml` runs:

- `lint` — phpcs, on PHP 7.4 only (matches the plugin's `Requires PHP` floor)
- `unit-tests` — phpunit unit suite, on PHP 7.4 / 8.2 / 8.3
- `integration-tests` — phpunit integration suite via wp-env, on PHP 7.4 / 8.3

The integration job sets `WP_ENV_PHP_VERSION` per matrix cell so the container
PHP version actually varies; a "Verify container PHP version" step confirms it.

## What the integration suite does and doesn't cover

**Covered (Phase 1):**

- Real `WP_Query`, `wp_get_object_terms`, post / user / term factories.
- Real Abilities API execution path: `wp_get_ability( $name )->execute( $input )`
  exercises input validation → permission_callback → execute_callback →
  output schema validation.
- Real REST routing for `/jab/v1/*` routes (currently only the manifest
  smoke; SiteManifest and ContentTypes follow in Phase 1.x).
- Post-auth capability gate via `current_user_can` after `wp_set_current_user`.
- Diagnostics report envelope, catalog ordering, default capability
  resolution, auth matrix (anonymous → 401, subscriber → 403, admin →
  200), and the `jab/headless_kit/diagnostics_capability` filter
  contract including the `do_not_allow` fallback. Six check IDs covered:
  `abilities_api`, `mcp_adapter`, `rest_routes_registered`,
  `post_types_discovered`, `application_passwords_enabled`,
  `acf_no_schema_skips`.

**Covered (Phase 1.1):**

- ACF free-version slot is installed in the tests-cli container via `.wp-env.json:plugins`.
  ACF-touching tests live under `tests/integration/Acf/`. The fixtures mu-plugin registers
  four ACF field groups: A (empty url/email/date), B (two-layout flex content), C
  (unsupported location rule), D (password field bound to `book`).
- **Empty ACF `url` / `email` / `date_picker` values** do not fail ability output
  validation (FIX-2 v0.6.1) — `AcfEmptyValueOutputTest`.
- **Flex Content discriminator** (`acf_fc_layout`) validates as `enum` rather than `const`
  — `AcfFlexContentDiscriminatorTest`.
- **Nav menu with label-only parent item** returns valid `jab/get-menus` output —
  `MenuLabelOnlyParentTest`.
- **Draft post with `0000-00-00 00:00:00` `post_date_gmt`** does not emit an invalid
  `date-time` field — `DraftZeroDatePostTest`.
- **`wp_get_object_terms()` grouping** returns taxonomy terms under the correct post
  IDs — `ObjectTermsGroupingTest`.
- **Posts with zero terms** still include required taxonomy arrays —
  `PostsWithZeroTermsTest`.
- **`include.blocks=true`** succeeds for posts containing registered blocks (FIX-5
  v0.6.3) — `BlocksIncludeRegisteredTest`.
- **`acf_no_schema_skips` populated-ledger branch** — both `skipped_groups` (Group C)
  and `dropped_fields` (Group D, SEC-3 password drop) sides exercised end-to-end via
  `AcfDiagnosticsLedgerTest`.

**NOT covered (deliberate Phase 1 deferrals):**

- **Application Password HTTP transport.** Using `wp_set_current_user()` in
  test helpers short-circuits the auth layer; only the post-auth capability
  check is exercised. A separate HTTP-layer App Password smoke is a
  Phase 1.x follow-up if a regression in that path ever surfaces.
- **WP-version matrix.** Only latest WP. WP 6.9 floor coverage is a
  Phase 1.x follow-up.
- **The mcp-adapter default MCP server.** The integration bootstrap filters
  `mcp_adapter_create_default_server` to `false` to dodge a load-ordering
  bug where `McpAdapter::init()` hooks `rest_api_init` (priority 15) and
  only THEN registers its `wp_abilities_api_init` callback — by which time
  that action has already fired, so `mcp-adapter/discover-abilities` and
  siblings never register. The subsequent `DefaultServerFactory::create()`
  call looks them up by name and trips `_doing_it_wrong` notices that
  WP_UnitTestCase escalates into failures. In production those notices are
  non-fatal but a real upstream bug. A Phase 1.x MCP-surface test will need
  to remove the filter and either drive registration order deliberately or
  mark the notices expected.

