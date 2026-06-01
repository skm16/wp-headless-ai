# WP Plugin Phase 1 — Integration Test Harness Design

> Date: 2026-06-01
> Scope: `packages/wp-plugin`
> Driver: [2026-06-01 connector hardening plan](../../../2026-06-01-jab-wp-plugin-connector-hardening-plan.md), Phase 1
> Status: brainstormed, approved, ready for implementation plan

## Context

`packages/wp-plugin` v0.7.0 shipped 122 → 173 unit tests with WP-function stubs. Every silent bug surfaced during the SaaS v2 pilot smoke against Two Roads (FIX-1 through FIX-5 across v0.6.0–v0.6.3) was a real WordPress runtime behavior the unit-test stubs structurally could not reach: `rest_validate_value_from_schema` silently ignoring `not` inside `oneOf`, transient cache keys missing the plugin VERSION, `wp_get_object_terms()` defaulting to `fields=all` and deduping across the input set. The unit tests document the *intended* input/output contracts; only a real-WordPress harness proves the plugin *honors* those contracts against `WP_Query`, REST validation, the Application Password capability gate, and the ACF + block runtime.

The plugin's `tests/README.md` has flagged the integration harness as "follow-up" since v0.4.0; the v0.7.0 release surfaced enough of its own validation-correctness fixes during pilot smoke to make this the highest-leverage next plugin investment.

## Goals

- **Land the harness scaffolding** (wp-env config, integration-test bootstrap, base TestCase, composer scripts, CI workflow job).
- **Prove the harness end-to-end** by including two real regression tests that exercise different layers of the plugin:
  - **SEC-1**: Subscriber-authenticated caller requesting `post_status=draft` must see zero drafts (security regression, Permissions layer).
  - **FIX-4 (v0.6.2)**: `jab/get-<cpt>-by-slug` ability name must remain stable when a CPT has `rest_base == slug` (registration regression, Registry layer).
- **Defer the remaining 7 regressions to a Phase 1.1 follow-up PR**: each is a small, mechanical conversion against the harness this PR lands. Smaller diffs ship faster and let the harness design iterate before piling on test code.

## Non-goals

- **No ACF in Phase 1.** Two ACF-touching regressions (empty url/email/date, flex content discriminator) belong in Phase 1.1 alongside an ACF slot added to the wp-env config.
- **No Gravity Forms slot.** Phase 7 (Forms) is its own design.
- **No WP-version matrix.** Only the latest WP in Phase 1. Adding WP 6.9 (the documented `Requires at least` floor) is an obvious follow-up; doing it now doubles CI runtime for marginal value.
- **No code coverage from the integration job.** Most paths are already covered by units; integration tests would slow CI further without much new line coverage.

## Architecture

Three layers, each independently understandable:

1. **wp-env config layer** (`.wp-env.json` at the plugin root) — declares which WordPress version to boot, which plugins to map in, which CPTs/ACF fixtures to seed via a mu-plugin. Edited rarely; tests don't touch it.
2. **Integration test base** (`tests/integration/IntegrationTestCase.php`) — extends WordPress core's `WP_UnitTestCase` (which wp-env exposes inside the container). Uses WP's built-in factories (`factory()->post`, `factory()->user`, `factory()->term`) directly — no custom factory wrappers in Phase 1. Adds **two** independent helpers:

   - `execute_ability( string $name, array $input = [] ): WP_Ability_Result` — looks up an ability via `wp_get_ability( $name )` and calls `->execute( $input )`. This is the path SEC-1 and any other ability-level regression goes through; it exercises input validation, the `permission_callback`, the `execute_callback`, and output schema validation. **NOT a REST route.**
   - `dispatch_rest( string $route, string $method = 'GET', array $params = [] ): WP_REST_Response` — builds a `WP_REST_Request` and dispatches via `rest_get_server()->dispatch()`. Used for the `jab/v1/manifest` smoke and any future REST-route regression. The plugin's only `jab/v1/*` REST routes are `/`, `/content-types`, `/manifest`, and `/site` — the abilities themselves are NOT REST routes.

   Plus `as_subscriber()` / `as_admin()` user-switch helpers and a `setUp()` that resets the abilities registry between tests.

3. **Test cases** (`tests/integration/Abilities/*.php`, `tests/integration/Rest/*.php`) — one file per behavior, mirroring the unit tree's structure. Phase 1 ships three test files: one `HarnessSmokeTest` and two regression tests (`Sec1SubscriberDraftTest`, `RegistryRestBaseSlugCollisionTest`).

## Components

### 1. `packages/wp-plugin/.wp-env.json`

```json
{
  "core": null,
  "phpVersion": "8.3",
  "plugins": [
    "."
  ],
  "mappings": {
    "wp-content/mu-plugins/jab-test-fixtures.php": "./tests/integration/fixtures/jab-test-fixtures.php"
  },
  "config": {
    "WP_DEBUG": true,
    "WP_DEBUG_LOG": true,
    "WP_DEBUG_DISPLAY": false
  }
}
```

- `"core": null` resolves to the latest stable WordPress release at boot time. Aligns with the Non-goals decision ("only the latest WP in Phase 1"); WP 6.9 floor coverage is a Phase 1.x follow-up.
- `"phpVersion": "8.3"` is the **local-dev default**. In CI, the `WP_ENV_PHP_VERSION` env var is set per matrix cell (`'7.4'` or `'8.3'`), which wp-env honors over the file value — that's how the matrix actually exercises both PHP versions inside the container. Without that env override, both matrix cells would silently run on 8.3.
- The mu-plugin at `tests/integration/fixtures/jab-test-fixtures.php` registers a `book` CPT with `rest_base == slug == "book"` (the FIX-4 regression target) plus any other test-only fixtures Phase 1 needs. Kept deterministic and reusable across tests.

### 2. Workspace-root `package.json` (new file)

The repo currently has `pnpm-workspace.yaml` but no root `package.json`. Phase 1 lands a minimal one so `@wordpress/env` has a home as workspace-level devDep:

```json
{
  "name": "wp-headless-monorepo",
  "private": true,
  "devDependencies": {
    "@wordpress/env": "^10.0.0"
  },
  "scripts": {
    "wp-env": "wp-env"
  }
}
```

Reason for workspace-root placement over the plugin package: wp-env is Node tooling, and the plugin package's `composer.json` shouldn't sprout Node tooling. The plugin's composer scripts invoke `wp-env` via `pnpm -w exec` from the plugin directory.

### 3. `packages/wp-plugin/composer.json` script additions

Existing `test:unit` stays as-is. New scripts:

```json
"scripts": {
  "test:unit": "phpunit --configuration tests/phpunit-unit.xml.dist",
  "test:integration": "pnpm --silent -w exec wp-env run tests-cli --env-cwd=wp-content/plugins/wp-plugin vendor/bin/phpunit --configuration tests/phpunit-integration.xml.dist",
  "test": ["@test:unit", "@test:integration"],
  "wp-env:start": "pnpm --silent -w exec wp-env start",
  "wp-env:stop": "pnpm --silent -w exec wp-env stop"
}
```

**Plugin slug note:** wp-env derives the in-container plugin directory name from the basename of the path listed in `plugins`. Since we list `.` and the package directory is `packages/wp-plugin`, wp-env mounts the plugin at `wp-content/plugins/wp-plugin` — NOT at the production install slug (`wp-headless-kit`, which the production zip ships as). The dev slug differs from prod by design here; WP treats the plugin as `<dir>/<main-file>.php` and auto-activates regardless of the directory name. The integration test script references the dev slug consistently. If a future test ever shells out to `wp plugin` or hard-codes the slug, that's a Phase 1.1 cleanup.

### 4. `packages/wp-plugin/tests/phpunit-integration.xml.dist`

Sibling of the existing `phpunit-unit.xml.dist`. Points at `tests/integration/`, uses a different bootstrap. PHPUnit 9.x (matches the existing unit suite).

### 5. `packages/wp-plugin/tests/integration/bootstrap.php`

Uses the canonical WordPress integration-test bootstrap pattern (load the test library's `functions.php`, register a plugin-loader via the `muplugins_loaded` action, THEN require the test bootstrap — NOT a direct `wp-load.php` call). The order matters: requiring `wp-load.php` before the test framework's bootstrap bypasses its install / reset lifecycle and produces "Cannot modify header information" + dirty-state cross-test bleed.

```php
<?php
$wp_tests_dir = getenv( 'WP_TESTS_DIR' ) ?: '/var/www/html/wp-content/plugins/wordpress-develop/tests/phpunit';

require_once $wp_tests_dir . '/includes/functions.php';

// Register a plugin loader BEFORE the test framework bootstrap loads WP.
tests_add_filter( 'muplugins_loaded', function () {
    require dirname( __DIR__, 2 ) . '/wp-headless-kit.php';
} );

// Load the test framework's bootstrap (which loads WP under controlled conditions).
require $wp_tests_dir . '/includes/bootstrap.php';

// Plugin composer autoloader for test-only classes (IntegrationTestCase, etc.).
require dirname( __DIR__, 2 ) . '/vendor/autoload.php';
```

`WP_TESTS_DIR` is set by wp-env's `tests-cli` environment; the fallback is a guess for non-wp-env runs. Bootstrap is one file, ~30 lines once formatted with the comments.

### 6. `packages/wp-plugin/tests/integration/IntegrationTestCase.php`

Shared base for every integration test. Extends `WP_UnitTestCase` (which itself provides `factory()->post`, `factory()->user`, `factory()->term`, etc. — we use those directly, no custom factory wrapper). Responsibilities:

- **`setUp()`**: clears the singleton `WP_Abilities_Registry`'s registrations and re-fires the `wp_abilities_api_init` action. This is necessary because the plugin's `Registry::register_abilities()` reads the post-type universe via `get_post_types()`, and tests may register/unregister CPTs between methods. Without the re-fire, the second test in a class sees stale ability registrations from the first.
- **`execute_ability( string $name, array $input = [] )`**: looks up an ability via `wp_get_ability( $name )` and calls `->execute( $input )`. Returns the `WP_Ability_Result` (or whatever the Abilities API returns at runtime — adapt to the actual signature). Exercises input validation → `permission_callback` → `execute_callback` → output schema validation. **This is the path SEC-1 and every other ability-level regression goes through.** Abilities are NOT REST routes.
- **`dispatch_rest( string $route, string $method = 'GET', array $params = [] )`**: builds a `WP_REST_Request` and dispatches via `rest_get_server()->dispatch()`. Returns the `WP_REST_Response`. Reserved for actual REST routes (`/jab/v1/manifest`, `/jab/v1/site`, etc.). The Phase 1 smoke uses this once against `/jab/v1/manifest`; SEC-1 and FIX-4 do not.
- **`as_subscriber()` / `as_admin()`**: user-switch helpers wrapping `wp_set_current_user()` after creating the user via `$this->factory()->user->create([ 'role' => 'subscriber' ])`. Note: this gates capability behavior, NOT the HTTP-layer Application Password transport — see "Risks consciously accepted" below.

Target ~70 lines (slightly more than original estimate to host both helpers).

### 7. `packages/wp-plugin/tests/integration/fixtures/jab-test-fixtures.php`

The mu-plugin wp-env mounts at `wp-content/mu-plugins/`. Registers test-only post types and any other fixtures the test files need at load time. The `book` CPT (rest_base == slug == "book") is the FIX-4 regression target. File-level comment makes clear this is a test fixture, not production code — necessary clarity since it lives under `tests/` but executes inside WP.

### 8. Three test files

#### `tests/integration/HarnessSmokeTest.php` (smoke)

Two test methods (no fixtures needed):

- `test_wordpress_is_loaded` — asserts `function_exists( 'wp_get_abilities' )` and `class_exists( 'WP_REST_Server' )`. If this fails, the wp-env or bootstrap is broken; every other integration test would fail uselessly.
- `test_jab_abilities_register_under_wp_abilities_api_init` — asserts `wp_get_abilities()` returns at least one ability whose name starts with `jab/`. Exercises the harness's ability-registry reset in `setUp()` plus the plugin's full registration path.

Also adds one REST-route assertion as the integration's use of `dispatch_rest()`:

- `test_jab_v1_manifest_responds_with_envelope` — calls `$this->as_subscriber(); $this->dispatch_rest( '/jab/v1/manifest' )` and asserts the response status is 200 and the body has the documented envelope keys (`plugin_version`, `generated_at`, `abilities`). Validates the REST path end-to-end.

(That's actually 3 methods. Updating the DoD count below to match.)

#### `tests/integration/Abilities/Sec1SubscriberDraftTest.php` (SEC-1 regression)

Uses `execute_ability()`, NOT `dispatch_rest()` — `jab/get-posts` is an ability, not a REST route. Three test methods:

- `test_subscriber_executing_get_posts_with_draft_status_sees_zero_drafts` — seeds 1 published post + 2 drafts (different authors); `as_subscriber()`; calls `execute_ability( 'jab/get-posts', [ 'post_status' => 'draft' ] )`; asserts the returned `posts` array contains zero rows.
- `test_subscriber_executing_get_posts_with_any_status_sees_only_published` — same seed; subscriber executes with `post_status=any`; asserts only the published post is returned.
- `test_editor_executing_get_posts_with_draft_status_sees_drafts` — seeds same; user with `edit_posts` on the test post type executes with `post_status=draft`; asserts the drafts are returned.

#### `tests/integration/Abilities/RegistryRestBaseSlugCollisionTest.php` (FIX-4 regression)

Uses `wp_get_abilities()` / `wp_get_ability()` directly (no REST dispatch, no execution — purely a registration-state assertion). Path: `tests/integration/Abilities/` rather than `tests/integration/Rest/`, since the bug was in the Abilities registry, not REST routing. Two test methods:

- `test_by_slug_ability_name_is_stable_when_rest_base_equals_slug` — after the `book` CPT is registered (via the mu-plugin), assert `wp_get_ability( 'jab/get-book-by-slug' )` returns a non-null Ability and `wp_get_ability( 'jab/get-book-2-by-slug' )` returns null. The v0.6.2 regression produced the `-2-by-slug` shape; this asserts the original name is reachable AND the regression's shape is not.
- `test_list_ability_name_is_stable_when_rest_base_equals_slug` — asserts the same for `jab/get-book` (present) vs `jab/get-book-2` (absent).

### 9. `.github/workflows/ci-plugin.yml` — new `integration-tests` job

Adds one new job alongside `lint` and `unit-tests`. Matrix: PHP 7.4 + 8.3 on ubuntu-latest, latest WP. Steps:

1. Checkout
2. Setup PHP (matrix version — this is the **host** PHP that runs `composer test:integration`'s pnpm/composer commands, NOT the in-container PHP)
3. Setup Node 20
4. `pnpm install --frozen-lockfile`
5. Set `WP_ENV_PHP_VERSION=${{ matrix.php }}` for the rest of the job — this is what wp-env reads to choose the **container** PHP version. Without this env override, both matrix cells silently run their integration tests on the `.wp-env.json` default (8.3), and the 7.4 cell's coverage is a lie.
6. `pnpm -w exec wp-env start` (workspace-root devDep; no package-name filter needed)
7. `composer install --no-progress --prefer-dist` (in `packages/wp-plugin`)
8. `composer test:integration` (in `packages/wp-plugin`)
9. Upload `wp-content/debug.log` as an artifact on failure (`if: failure()` step)

Docker layer cache via `docker/setup-buildx-action` so subsequent runs hit the cache.

## Data flow

Two parallel paths, depending on whether the test exercises an Ability or a REST route. SEC-1 takes the Ability path; FIX-4 takes neither (pure registration-state assertion via `wp_get_abilities()`); the smoke takes the REST path against `/jab/v1/manifest`.

**Boot (shared by both paths):**

```
PHPUnit (host)
  → composer test:integration
  → pnpm -w exec wp-env run tests-cli vendor/bin/phpunit
  → Docker container (wp-env tests-cli service)
    → tests/integration/bootstrap.php
      → tests_add_filter( 'muplugins_loaded', load_plugin )
      → require WP test framework bootstrap (loads WP under controlled conditions)
      → 'plugins_loaded' fires → JAB plugin boots
      → 'wp_abilities_api_init' fires → Registry::register_abilities()
    → IntegrationTestCase::setUp()
      → resets the abilities registry (so test ordering doesn't matter)
      → re-fires 'wp_abilities_api_init' against the current post-type universe
```

**Ability execution (SEC-1):**

```
    → test method
      → seeds posts + a subscriber via WP_UnitTest_Factory
      → $this->as_subscriber()
      → $this->execute_ability( 'jab/get-posts', [ 'post_status' => 'draft' ] )
        → wp_get_ability( 'jab/get-posts' )->execute( $input )
          → input schema validation
          → Permissions::gate( ... )() → current_user_can( 'read' ) → true (Subscriber has 'read')
          → execute_callback → Permissions::sanitize_post_status( 'draft', 'post' )
                            → current_user_can( 'edit_posts' ) → false
                            → downgrades to 'publish'
          → get_posts() against real WP_Query
          → output schema validation
      → assert response['posts'] === []
```

**REST dispatch (smoke):**

```
    → test method
      → $this->as_subscriber()
      → $this->dispatch_rest( '/jab/v1/manifest' )
        → rest_get_server()->dispatch( WP_REST_Request )
          → Manifest::authorize() → current_user_can( Manifest::capability() ) → true
          → Manifest::respond() → wp_get_abilities() → envelope
          → WP REST output validation against the schema
      → assert response.status === 200 and envelope shape
```

Two non-obvious beats:

- **Abilities are NOT REST routes.** The plugin's REST surface is four routes (`/`, `/content-types`, `/manifest`, `/site`) — discovery and health. The CPT-list and by-slug abilities (`jab/get-posts`, `jab/get-book-by-slug`, etc.) are invoked through WordPress's Abilities API via `wp_get_ability( $name )->execute( $input )`. The split between `execute_ability()` and `dispatch_rest()` in the test base mirrors that runtime split.
- **Registry reset between tests** is the only setUp-level subtlety. The Abilities API stores registrations on a singleton. Without an explicit reset, the second test sees the first test's registrations and `Permissions::sanitize_post_status()` starts seeing CPTs the test under test hasn't registered. Base class handles this once; test files never think about it.

## Error handling

Three classes of failure, each with a clear surface:

1. **Test failures** (assertion mismatch) — standard PHPUnit output, exits non-zero. CI fails the job.
2. **WP integration-layer failures** (REST validation rejection, fatal during plugin boot) — surface as PHPUnit errors with the WP error message in the stack. The bootstrap sets `WP_DEBUG=true` and `WP_DEBUG_LOG=true`, so any `_doing_it_wrong` or PHP notice gets written to `wp-content/debug.log` and is grep-able post-run. The CI job uploads `debug.log` as an artifact on failure.
3. **wp-env infra failures** (Docker pull timeout, MySQL not ready) — `wp-env start` exits non-zero before PHPUnit runs. CI step shows the wp-env stdout, which is verbose enough to diagnose.

## Testing strategy for the harness itself

The harness has to prove four things on its own (separate from the regressions it enables):

- **It actually boots WP.** `HarnessSmokeTest::test_wordpress_is_loaded` asserts `function_exists('wp_get_abilities')` and `class_exists('WP_REST_Server')`. If this fails, every other integration test would fail uselessly.
- **It actually loads the JAB plugin.** `HarnessSmokeTest::test_jab_abilities_register_under_wp_abilities_api_init` calls `wp_get_abilities()` and asserts at least one ability whose name starts with `jab/` is registered.
- **The REST layer dispatches correctly.** `HarnessSmokeTest::test_jab_v1_manifest_responds_with_envelope` exercises `dispatch_rest( '/jab/v1/manifest' )` end-to-end and asserts the response envelope shape. This is the only Phase 1 use of the REST helper — the regression tests use `execute_ability()` directly.
- **It exercises the full layer.** SEC-1 and FIX-4 collectively touch Permissions, Registry, the Abilities API execution path, and REST dispatch. If either passes for the wrong reason (e.g. the registry never reset, so the test saw last test's state), the assertions catch that.

## Tradeoffs and known limitations

### What this design buys

- Real `WP_Query`, real Abilities API execution, real REST validation, real capability gate (via `current_user_can` after `wp_set_current_user`), real Gutenberg block runtime — every layer the unit tests stub.
- Two regression tests means reverting the v0.4.0 SEC-1 fix OR the v0.6.2 FIX-4 fix actually fails CI, meeting the plan's Task 1.2 acceptance criterion ("Reverting any historical fix causes at least one integration test to fail").
- CI workflow stays declarative — one new job, one matrix, no custom setup scripts beyond `pnpm install && pnpm -w exec wp-env start`.

### What it deliberately defers

- The remaining 7 regressions move to a Phase 1.1 follow-up PR. Each is a mechanical conversion against the harness this PR lands; safer split than one giant PR.
- ACF (Pro is commercial, free version adds a wp-env plugin slot we don't need yet). Phase 1.1 adds the ACF free-version slot alongside the ACF-touching regressions.
- WP-version matrix (only latest WP in Phase 1).
- Code coverage from the integration job.

### Risks consciously accepted

- **wp-env cold-start time on CI.** First-run Docker pulls add ~30–60s per matrix cell. GitHub Actions caches layers across runs after that. Unit suite stays the fast feedback loop; integration is the slower-but-thorough one.
- **`WP_REST_Server::dispatch()` skips HTTP middleware.** Anything wired through `rest_pre_dispatch` filters or actual HTTP headers (CORS, custom auth headers) wouldn't be exercised. None of the JAB plugin's current behavior depends on those — pure ability registration + REST callbacks — so this is fine for v0.7.0.
- **Application Password transport is NOT exercised.** Using `wp_set_current_user()` short-circuits the HTTP auth layer and tests only the post-auth capability check (`current_user_can( $cap )`). The Application Password flow itself (HTTP Basic header parsing, the `application_passwords_check_password_for_application_request` filter chain) is unexercised in Phase 1. This is the right tradeoff for SEC-1 (the bug was a capability check, not an auth-transport bug) but means a separate HTTP-layer App Password smoke is its own Phase 1.x follow-up if we ever need it. Document this in `tests/README.md` so future readers don't assume the transport is covered.
- **No code coverage from integration job.** Defer; most paths already hit by units.

### One non-obvious detail worth flagging

The mu-plugin fixture file at `tests/integration/fixtures/jab-test-fixtures.php` is a *production-style* registration sitting under `tests/`. It has to be, because wp-env mounts it at `wp-content/mu-plugins/`. A clear file-level comment prevents a future reader from mistaking it for plugin source.

## Definition of done

- A workspace-root `package.json` exists, pinning `@wordpress/env` as a devDep.
- `pnpm install && composer install && composer test:integration` runs locally on Windows and Linux without hand-holding.
- `composer lint` still exits 0 (no regression on the existing baseline).
- `composer test:unit` still exits 0 (173 tests, 422 assertions).
- The new `composer test:integration` exits 0 with at least 8 test methods passing across 3 files: 3 in `HarnessSmokeTest` (WP-is-loaded + abilities-register + manifest REST envelope), 3 in `Sec1SubscriberDraftTest` (via `execute_ability()`), 2 in `RegistryRestBaseSlugCollisionTest` (via `wp_get_ability()` directly).
- The CI matrix actually exercises BOTH PHP versions inside the wp-env container — verifiable by running `php -v` from the `tests-cli` service and confirming it reflects `WP_ENV_PHP_VERSION` per matrix cell.
- Reverting the v0.4.0 SEC-1 fix (in `Permissions::sanitize_post_status`) makes ≥1 integration test fail.
- Reverting the v0.6.2 FIX-4 fix (in `Registry::register_abilities`) makes ≥1 integration test fail.
- CI's new `integration-tests` job passes on PHP 7.4 + 8.3.
- `tests/README.md` is updated to point at this design doc and to mark the integration layer as "landed (Phase 1)" with a clear pointer to the Phase 1.1 follow-up for the remaining 7 regressions.

## Out of scope (carried to Phase 1.1)

- Empty ACF `url` / `email` / `date_picker` values do not fail ability output validation.
- Nav menu with label-only parent item returns valid `jab/get-menus` output.
- Draft or malformed-date post does not emit invalid date output.
- `wp_get_object_terms()` grouping returns taxonomy terms under the correct post IDs.
- Flexible Content discriminator validates correctly.
- Posts with zero terms still include required taxonomy arrays.
- `include.blocks=true` succeeds for posts containing registered blocks.

## Open questions

None at design time. If implementation surfaces friction (e.g. wp-env's Docker layer cache being slower than expected in GHA, or `WP_UnitTestCase`'s factory needing a wrapper for ACF fields when Phase 1.1 lands), capture under "Out of scope" in the implementation plan and decide whether to in-scope it or follow up.
