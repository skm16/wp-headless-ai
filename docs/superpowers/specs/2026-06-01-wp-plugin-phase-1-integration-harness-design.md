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
2. **Integration test base** (`tests/integration/IntegrationTestCase.php`) — extends WordPress core's `WP_UnitTestCase` (which wp-env exposes inside the container). Uses WP's built-in factories (`factory()->post`, `factory()->user`, `factory()->term`) directly — no custom factory wrappers in Phase 1. Adds a `dispatch_jab( $route, $method, $params )` helper that hits a `jab/v1/*` REST route via `WP_REST_Server::dispatch()` instead of a real HTTP request, plus `as_subscriber()` / `as_admin()` user-switch helpers and a `setUp()` that resets the abilities registry between tests.
3. **Test cases** (`tests/integration/Abilities/*.php`, `tests/integration/Rest/*.php`) — one file per behavior, mirroring the unit tree's structure. Phase 1 ships exactly two test files: `Sec1SubscriberDraftTest` and `RegistryRestBaseSlugCollisionTest`.

## Components

### 1. `packages/wp-plugin/.wp-env.json`

```json
{
  "core": "WordPress/WordPress#6.9",
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

The mu-plugin at `tests/integration/fixtures/jab-test-fixtures.php` registers a `book` CPT with `rest_base == slug == "book"` (the FIX-4 regression target) plus any other test-only fixtures Phase 1 needs. Kept deterministic and reusable across tests.

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

Loads in this order:

1. The wp-env-mounted `wp-tests-config.php` (provides DB config and `WP_TESTS_CONFIG_FILE_PATH`).
2. WordPress core's `wp-load.php`.
3. The plugin's composer autoloader.
4. WP's own test framework bootstrap (which sets up `WP_UnitTestCase`'s factories and DB transactions).

Bootstrap is one file, ~30 lines.

### 6. `packages/wp-plugin/tests/integration/IntegrationTestCase.php`

Shared base for every integration test. Extends `WP_UnitTestCase` (which itself provides `factory()->post`, `factory()->user`, `factory()->term`, etc. — we use those directly, no custom factory wrapper). Responsibilities:

- **`setUp()`**: clears the singleton `WP_Abilities_Registry`'s registrations and re-fires the `wp_abilities_api_init` action. This is necessary because the plugin's `Registry::register_abilities()` reads the post-type universe via `get_post_types()`, and tests may register/unregister CPTs between methods. Without the re-fire, the second test in a class sees stale ability registrations from the first.
- **`dispatch_jab( $route, $method = 'GET', $params = [] )`**: helper that builds a `WP_REST_Request` and dispatches via `rest_get_server()->dispatch()`. Returns the `WP_REST_Response`. No HTTP, but exercises every layer the real request would (permission_callback, REST output schema validation, the works).
- **`as_subscriber()` / `as_admin()`**: user-switch helpers wrapping `wp_set_current_user()` after creating the user via `$this->factory()->user->create([ 'role' => 'subscriber' ])`.

Target ~50 lines.

### 7. `packages/wp-plugin/tests/integration/fixtures/jab-test-fixtures.php`

The mu-plugin wp-env mounts at `wp-content/mu-plugins/`. Registers test-only post types and any other fixtures the test files need at load time. The `book` CPT (rest_base == slug == "book") is the FIX-4 regression target. File-level comment makes clear this is a test fixture, not production code — necessary clarity since it lives under `tests/` but executes inside WP.

### 8. Two test files

#### `tests/integration/Abilities/Sec1SubscriberDraftTest.php`

Three test methods:

- `test_subscriber_requesting_draft_status_sees_zero_drafts` — seeds 1 published post + 2 drafts (different authors); subscriber dispatches `jab/get-posts` with `post_status=draft`; asserts 0 draft posts in response.
- `test_subscriber_requesting_any_status_sees_only_published` — same seed; subscriber dispatches with `post_status=any`; asserts only published returned.
- `test_editor_requesting_draft_status_sees_their_drafts` — seeds same; editor of the test post type dispatches with `post_status=draft`; asserts the drafts they have `edit_posts` for are returned.

#### `tests/integration/Rest/RegistryRestBaseSlugCollisionTest.php`

Two test methods:

- `test_by_slug_ability_name_is_stable_when_rest_base_equals_slug` — after the `book` CPT is registered (via the mu-plugin), assert `wp_get_abilities()` contains an ability named exactly `jab/get-book-by-slug` (NOT `jab/get-book-2-by-slug` as the v0.6.2 regression produced).
- `test_list_ability_name_is_stable_when_rest_base_equals_slug` — asserts `jab/get-book` (NOT `jab/get-book-2`).

### 9. `.github/workflows/ci-plugin.yml` — new `integration-tests` job

Adds one new job alongside `lint` and `unit-tests`. Matrix: PHP 7.4 + 8.3 on ubuntu-latest, latest WP. Steps:

1. Checkout
2. Setup PHP (matrix version)
3. Setup Node 20
4. `pnpm install --frozen-lockfile`
5. `pnpm --filter @jab/repo exec wp-env start`
6. `composer install --no-progress --prefer-dist` (in `packages/wp-plugin`)
7. `composer test:integration` (in `packages/wp-plugin`)
8. Upload `wp-content/debug.log` as an artifact on failure (`if: failure()` step)

Docker layer cache via `docker/setup-buildx-action` so subsequent runs hit the cache.

## Data flow

A single integration test request:

```
PHPUnit (host)
  → composer test:integration
  → pnpm exec wp-env run tests-cli vendor/bin/phpunit
  → Docker container (wp-env tests-cli service)
    → tests/integration/bootstrap.php
      → wp-load.php (boots full WP)
      → plugin autoloader
      → 'plugins_loaded' fires → JAB plugin boots
      → 'wp_abilities_api_init' fires → Registry::register_abilities()
    → IntegrationTestCase::setUp()
      → resets the abilities registry (so test ordering doesn't matter)
      → re-fires Registry::register_abilities() with test fixtures
    → test method
      → seeds posts/users via WP factories (WP_UnitTest_Factory)
      → calls $this->dispatch_jab( '/jab/v1/...', 'GET', [...] )
        → rest_get_server()->dispatch( WP_REST_Request )
          → Manifest::authorize() (real current_user_can)
          → Manifest::respond() (real wp_get_abilities)
          → WP REST output validation against the response schema
      → assertions on response body + status code
```

Two non-obvious beats:

- **No HTTP, but everything else is real.** `WP_REST_Server::dispatch()` runs every layer the real request would — permission_callback, schema validation, the works — minus the network/cookie layer. Right tradeoff: we're testing the plugin's contract with WP, not WP's HTTP stack.
- **Registry reset between tests** is the only non-obvious bit. The Abilities API stores registrations on the singleton `WP_Abilities_Registry`. Without an explicit reset, the second test sees the first test's registrations and `Permissions::sanitize_post_status()` starts seeing CPTs that the test under test hasn't registered. Base class handles this once; test files never think about it.

## Error handling

Three classes of failure, each with a clear surface:

1. **Test failures** (assertion mismatch) — standard PHPUnit output, exits non-zero. CI fails the job.
2. **WP integration-layer failures** (REST validation rejection, fatal during plugin boot) — surface as PHPUnit errors with the WP error message in the stack. The bootstrap sets `WP_DEBUG=true` and `WP_DEBUG_LOG=true`, so any `_doing_it_wrong` or PHP notice gets written to `wp-content/debug.log` and is grep-able post-run. The CI job uploads `debug.log` as an artifact on failure.
3. **wp-env infra failures** (Docker pull timeout, MySQL not ready) — `wp-env start` exits non-zero before PHPUnit runs. CI step shows the wp-env stdout, which is verbose enough to diagnose.

## Testing strategy for the harness itself

The harness has to prove three things on its own (separate from the regressions it enables):

- **It actually boots WP.** A trivial smoke test that asserts `function_exists('wp_get_abilities')` runs first in the integration suite. If this fails, every other integration test would fail uselessly. Lives at `tests/integration/HarnessSmokeTest.php`.
- **It actually loads the JAB plugin.** A second smoke method in the same file that calls `wp_get_abilities()` and asserts at least one ability whose name starts with `jab/` is registered.
- **It exercises the full layer.** The two real regression tests collectively touch Permissions + Registry + REST dispatch. If either passes for the wrong reason (e.g. the registry never reset, so the test saw last test's state), the assertions catch that.

## Tradeoffs and known limitations

### What this design buys

- Real `WP_Query`, real REST validation, real Application Password capability gate, real Gutenberg block runtime — every layer the unit tests stub.
- Two regression tests means reverting the v0.4.0 SEC-1 fix OR the v0.6.2 FIX-4 fix actually fails CI, meeting the plan's Task 1.2 acceptance criterion ("Reverting any historical fix causes at least one integration test to fail").
- CI workflow stays declarative — one new job, one matrix, no custom setup scripts beyond `pnpm install && pnpm wp-env start`.

### What it deliberately defers

- The remaining 7 regressions move to a Phase 1.1 follow-up PR. Each is a mechanical conversion against the harness this PR lands; safer split than one giant PR.
- ACF (Pro is commercial, free version adds a wp-env plugin slot we don't need yet). Phase 1.1 adds the ACF free-version slot alongside the ACF-touching regressions.
- WP-version matrix (only latest WP in Phase 1).
- Code coverage from the integration job.

### Risks consciously accepted

- **wp-env cold-start time on CI.** First-run Docker pulls add ~30–60s per matrix cell. GitHub Actions caches layers across runs after that. Unit suite stays the fast feedback loop; integration is the slower-but-thorough one.
- **`WP_REST_Server::dispatch()` skips HTTP middleware.** Anything wired through `rest_pre_dispatch` filters or actual HTTP headers (CORS, custom auth headers besides Application Passwords) wouldn't be exercised. None of the JAB plugin's current behavior depends on those — pure ability registration + REST callbacks — so this is fine for v0.7.0.
- **No code coverage from integration job.** Defer; most paths already hit by units.

### One non-obvious detail worth flagging

The mu-plugin fixture file at `tests/integration/fixtures/jab-test-fixtures.php` is a *production-style* registration sitting under `tests/`. It has to be, because wp-env mounts it at `wp-content/mu-plugins/`. A clear file-level comment prevents a future reader from mistaking it for plugin source.

## Definition of done

- A workspace-root `package.json` exists, pinning `@wordpress/env` as a devDep.
- `pnpm install && composer install && composer test:integration` runs locally on Windows and Linux without hand-holding.
- `composer lint` still exits 0 (no regression on the existing baseline).
- `composer test:unit` still exits 0 (173 tests, 422 assertions).
- The new `composer test:integration` exits 0 with at least 7 test methods passing across 3 files: 2 in `HarnessSmokeTest`, 3 in `Sec1SubscriberDraftTest`, 2 in `RegistryRestBaseSlugCollisionTest`.
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
