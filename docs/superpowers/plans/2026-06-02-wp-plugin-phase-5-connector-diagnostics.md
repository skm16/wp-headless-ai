# wp-plugin Phase 5 — Connector Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a structured diagnostics surface on the WP plugin — exposed as `wp jab doctor` (WP-CLI) and `GET /wp-json/jab/v1/diagnostics` (REST) — that both return the same `{ facts, checks }` report from a single shared service. Spec at [`docs/superpowers/specs/2026-06-02-wp-plugin-phase-5-connector-diagnostics-design.md`](../specs/2026-06-02-wp-plugin-phase-5-connector-diagnostics-design.md).

**Architecture:** One pure data-collection service (`Diagnostics\Report`) is consumed by two thin adapters (`Cli\DoctorCommand`, `Rest\Diagnostics`). `Report::generate()` returns a deterministically-ordered array with `facts` (no severity) and `checks` (pass / warn / fail). The CLI renders text via a pure `Cli\TextRenderer` or emits JSON / YAML via `WP_CLI\Formatter`; the REST endpoint serializes the same array via `wp_json_encode`. `Report::from_environment( $env )` is a pure function over a snapshot array (heavily unit-tested); `Report::collect_environment()` is the WP-bound boundary (integration-tested). `--debug-acf` is CLI-only: it temporarily enables the existing `jab/headless_kit/acf_diagnostics` filter and calls a new `Acf\Schema::flush_cache()` (generation-salt invalidation) before generating the report.

**Tech Stack:** PHP 7.4+ (existing floor). PHPUnit 9.6 (unit + integration). WordPress 6.9+ via wp-env (existing harness). New `Registry::discovered_post_types()` and `Registry::discovered_taxonomies()` public helpers (single source of truth for facts + existing registration). New `jab_acf_schema_generation` WP option (generation salt). One new REST route, one new WP-CLI command. No new vendor dependencies. Ships as plugin v0.7.1.

---

## Pre-flight (do this BEFORE Task 1)

- [ ] **PF-1: Set up an isolated worktree**

   Per project convention, isolated feature work goes in a worktree. If working through a subagent, the subagent's environment may already be a worktree; verify via `git rev-parse --git-dir` (a path NOT equal to `git rev-parse --git-common-dir` means we're already isolated). If not isolated, use the `superpowers:using-git-worktrees` skill to create one.

- [ ] **PF-2: Confirm starting state**

   Run from `packages/wp-plugin`:

   ```bash
   composer install --quiet && composer lint && composer test:unit
   ```

   Expected:
   - `composer lint` exits 0 with `20/20 (100%)`.
   - `composer test:unit` exits 0 with `OK (173 tests, 422 assertions)`.

   Then run from the workspace root:

   ```bash
   pnpm install --silent && pnpm -w exec wp-env start
   ```

   Expected: wp-env reports tests-cli ready. From `packages/wp-plugin`:

   ```bash
   composer test:integration
   ```

   Expected: `OK (8 tests, 26 assertions)` with zero notice lines in the output.

   If any of the above fails, stop and resolve before starting Task 1. Phase 5 is purely additive but the baseline must be green.

- [ ] **PF-3: Read the spec**

   Read `docs/superpowers/specs/2026-06-02-wp-plugin-phase-5-connector-diagnostics-design.md` end-to-end before touching code. The report shape (§4), check catalog (§5), ordering rules (§4), and `--debug-acf` flow (§6) are the contract every task implements.

---

## File Structure

**Created (plugin source):**
- `packages/wp-plugin/includes/Diagnostics/Fact.php` — value object: `{ id, label, value, detail? }` with `to_array()`.
- `packages/wp-plugin/includes/Diagnostics/Check.php` — value object: `{ id, label, severity, message, detail? }` with `to_array()` and `pass()` / `warn()` / `fail()` named constructors.
- `packages/wp-plugin/includes/Diagnostics/Report.php` — `collect_environment(): array` (WP-bound) + `from_environment( array $env ): array` (pure) + `generate(): array` orchestrator.
- `packages/wp-plugin/includes/Rest/Diagnostics.php` — `register`, `capability`, `authorize`, `respond`. Mirrors the `Manifest` / `SiteManifest` filterable-cap pattern.
- `packages/wp-plugin/includes/Cli/DoctorCommand.php` — `wp jab doctor` registration + flag handling (`--format`, `--strict`, `--debug-acf`).
- `packages/wp-plugin/includes/Cli/TextRenderer.php` — `render( array $report ): string`. Pure.

**Created (tests — unit):**
- `packages/wp-plugin/tests/unit/Diagnostics/FactTest.php`
- `packages/wp-plugin/tests/unit/Diagnostics/CheckTest.php`
- `packages/wp-plugin/tests/unit/Diagnostics/ReportFromEnvironmentTest.php`
- `packages/wp-plugin/tests/unit/Acf/SchemaFlushCacheTest.php`
- `packages/wp-plugin/tests/unit/RegistryDiscoveredTypesTest.php`
- `packages/wp-plugin/tests/unit/Cli/TextRendererTest.php`
- `packages/wp-plugin/tests/unit/Cli/ExitCodeMappingTest.php`
- `packages/wp-plugin/tests/unit/Rest/DiagnosticsCapabilityTest.php`

**Created (tests — integration):**
- `packages/wp-plugin/tests/integration/Diagnostics/ReportSmokeTest.php`
- `packages/wp-plugin/tests/integration/Rest/DiagnosticsAuthTest.php`
- `packages/wp-plugin/tests/integration/Rest/DiagnosticsCapabilityFilterTest.php`

**Modified:**
- `packages/wp-plugin/includes/Registry.php` — new public `discovered_post_types()` + `discovered_taxonomies()`. Existing private `ability_configs()` and `register_taxonomy_abilities()` refactored to call the new public helpers.
- `packages/wp-plugin/includes/Acf/Schema.php` — new public `flush_cache()`. The existing `for_post_type()` cache key incorporates a new `jab_acf_schema_generation` option as a salt.
- `packages/wp-plugin/wp-headless-kit.php` — VERSION bump 0.7.0 → 0.7.1; register `Rest\Diagnostics` on `rest_api_init`; conditionally register `Cli\DoctorCommand` when `WP_CLI` is defined.
- `packages/wp-plugin/tests/bootstrap.php` — add `update_option` stub (mirrors existing `get_option` stub's `$_jab_test_options` global).
- `packages/wp-plugin/README.md` — v0.7.1 changelog entry.
- `packages/wp-plugin/tests/README.md` — list new check IDs.

**Untouched (deliberate):**
- The mcp-adapter default-server check is NOT included in v0.7.1 per spec §2.
- ACF integration coverage for the populated-ledger branch is NOT included — deferred to Phase 1.1 alongside the ACF wp-env slot.
- No SaaS-side changes (`apps/web`) — Phase 5 ships only the API contract.

---

## Task 1: Public `Registry::discovered_post_types()`

**Files:**
- Test: `packages/wp-plugin/tests/unit/RegistryDiscoveredTypesTest.php` (new)
- Modify: `packages/wp-plugin/includes/Registry.php`

The existing private `Registry::ability_configs()` (Registry.php:248) does post-type discovery + exclusion-filter application + alphabetical iteration. Extract that into a public `discovered_post_types(): array{ included: string[], excluded: string[] }` and make the private caller route through it. This is the single source of truth Phase 5 facts will read.

- [ ] **Step 1: Write the failing test**

Create `packages/wp-plugin/tests/unit/RegistryDiscoveredTypesTest.php`:

```php
<?php
declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests;

use Jab\WpHeadlessKit\Registry;
use PHPUnit\Framework\TestCase;

final class RegistryDiscoveredTypesTest extends TestCase {

    protected function setUp(): void {
        \jab_wphk_reset_stubs();
        $GLOBALS['_jab_test_post_types'] = [
            'post'             => (object) [ 'name' => 'post' ],
            'page'             => (object) [ 'name' => 'page' ],
            'beer'             => (object) [ 'name' => 'beer' ],
            'attachment'       => (object) [ 'name' => 'attachment' ],
            'acf-field-group'  => (object) [ 'name' => 'acf-field-group' ],
        ];
    }

    public function test_discovered_post_types_separates_included_and_excluded_alphabetically(): void {
        $result = Registry::discovered_post_types();

        $this->assertSame( [ 'beer', 'page', 'post' ], $result['included'] );
        $this->assertContains( 'attachment',      $result['excluded'] );
        $this->assertContains( 'acf-field-group', $result['excluded'] );
    }

    public function test_filter_can_extend_excludes(): void {
        $GLOBALS['_jab_test_filters']['jab/headless_kit/post_type_excludes'] = static function ( array $defaults ): array {
            $defaults[] = 'beer';
            return $defaults;
        };

        $result = Registry::discovered_post_types();

        $this->assertNotContains( 'beer', $result['included'] );
        $this->assertContains( 'beer',    $result['excluded'] );
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/wp-plugin && vendor/bin/phpunit --configuration tests/phpunit-unit.xml.dist --filter RegistryDiscoveredTypesTest
```

Expected: FAIL with `Error: Call to undefined method Jab\WpHeadlessKit\Registry::discovered_post_types()`.

Note: the test depends on a `_jab_test_post_types` stub global that `get_post_types()` reads. If it doesn't exist yet in `tests/bootstrap.php`, also add this stub in Step 3 (it likely already does — check first):

```bash
grep -n "get_post_types" packages/wp-plugin/tests/bootstrap.php
```

If `get_post_types` is not stubbed, add to `tests/bootstrap.php` (above the closing PHP tag if any):

```php
if ( ! function_exists( 'get_post_types' ) ) {
    /**
     * @param array<string, mixed> $args
     * @param string $output 'names'|'objects'
     * @return string[]|object[]
     */
    function get_post_types( $args = [], $output = 'names' ): array {
        $map = $GLOBALS['_jab_test_post_types'] ?? [];
        if ( 'objects' === $output ) {
            return $map;
        }
        return array_keys( $map );
    }
}
```

Also confirm `apply_filters` stub reads from `_jab_test_filters` (it does at bootstrap.php:108).

- [ ] **Step 3: Add the public method to Registry**

Open `packages/wp-plugin/includes/Registry.php`. Locate `DEFAULT_POST_TYPE_EXCLUDES` (the constant array of slugs near the top of the class). Add a new public method directly below the constants block:

```php
/**
 * Public discovery surface. Returns the post types JAB would register
 * abilities for, partitioned into `included` (after exclusions applied)
 * and `excluded` (the rest of the public post-type universe that matched
 * the default + filter-supplied exclusion list).
 *
 * Used by Diagnostics\Report and by the existing private ability_configs()
 * path — single source of truth for "what post types does JAB see?".
 *
 * Both arrays are sorted alphabetically so downstream output is
 * deterministic (Diagnostics spec §4 ordering rule).
 *
 * @return array{ included: string[], excluded: string[] }
 */
public static function discovered_post_types(): array {
    /**
     * Filter the list of post type slugs to skip during auto-discovery.
     *
     * @param string[] $excludes Default exclusion list.
     */
    $excludes = (array) apply_filters(
        'jab/headless_kit/post_type_excludes',
        self::DEFAULT_POST_TYPE_EXCLUDES
    );

    $public_types = function_exists( 'get_post_types' )
        ? (array) get_post_types( [ 'public' => true ], 'names' )
        : [];

    $included = [];
    $excluded = [];
    foreach ( $public_types as $slug ) {
        if ( in_array( (string) $slug, $excludes, true ) ) {
            $excluded[] = (string) $slug;
            continue;
        }
        $included[] = (string) $slug;
    }
    sort( $included );
    sort( $excluded );
    return [ 'included' => $included, 'excluded' => $excluded ];
}
```

- [ ] **Step 4: Refactor the existing private caller to use the new helper**

Locate `private static function ability_configs()` (Registry.php:248). It currently calls `get_post_types`, applies the filter, and iterates. Replace the discovery prelude with a call to `discovered_post_types()`. Find the existing block:

```php
$excludes = (array) apply_filters(
    'jab/headless_kit/post_type_excludes',
    self::DEFAULT_POST_TYPE_EXCLUDES
);

$configs    = [];
```

(plus the surrounding `get_post_types` call and the in_array exclude check). Replace the discovery prelude (the `$excludes = …` + `get_post_types(…)` + the per-slug `in_array($excludes)` skip) so the loop now iterates `self::discovered_post_types()['included']`. The body of the loop (config building per post type) is unchanged. Concretely the function becomes:

```php
private static function ability_configs(): array {
    $configs = [];

    foreach ( self::discovered_post_types()['included'] as $slug ) {
        $post_type = function_exists( 'get_post_type_object' )
            ? get_post_type_object( $slug )
            : null;
        if ( ! $post_type ) {
            continue;
        }
        $configs[] = self::derive_config_from_post_type( $post_type );
    }

    /**
     * Filter the derived ability config list before registration.
     *
     * @param array<int, array<string, mixed>> $configs
     */
    return (array) apply_filters( 'jab/headless_kit/ability_configs', $configs );
}
```

(Confirm `derive_config_from_post_type` and the `jab/headless_kit/ability_configs` filter already exist by reading the current Registry.php. If the existing body differs, preserve any logic this paraphrase missed — the goal is "discovery via discovered_post_types(), per-CPT config building unchanged".)

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd packages/wp-plugin && composer test:unit
```

Expected: the 2 new tests bring the count to 175. Exact assertion count varies slightly; the load-bearing signal is "0 failures, 175 tests run." If `RegistryUniqueNameTest` or any existing test now fails, the refactor of `ability_configs()` changed observable behavior — revert and reconsider.

- [ ] **Step 6: Commit**

```bash
git add packages/wp-plugin/includes/Registry.php packages/wp-plugin/tests/unit/RegistryDiscoveredTypesTest.php packages/wp-plugin/tests/bootstrap.php
git commit -m "$(cat <<'EOF'
feat(wp-plugin): public Registry::discovered_post_types()

Phase 5 needs a public surface for post-type discovery so diagnostics
facts and the existing registration logic share one source of truth.
discovered_post_types() returns alphabetically-sorted included/excluded
slug arrays after applying the jab/headless_kit/post_type_excludes
filter. ability_configs() routed through it; no behavior change for
the registration path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Public `Registry::discovered_taxonomies()`

**Files:**
- Test: `packages/wp-plugin/tests/unit/RegistryDiscoveredTypesTest.php` (extend)
- Modify: `packages/wp-plugin/includes/Registry.php`

Mirrors Task 1 for taxonomies. The existing private `register_taxonomy_abilities()` (Registry.php:221) contains the discovery + exclusion logic. Extract.

- [ ] **Step 1: Add failing test cases**

Append to `packages/wp-plugin/tests/unit/RegistryDiscoveredTypesTest.php`:

```php
    public function test_discovered_taxonomies_separates_included_and_excluded_alphabetically(): void {
        $GLOBALS['_jab_test_taxonomies'] = [
            'category'           => (object) [ 'name' => 'category' ],
            'beer_style'         => (object) [ 'name' => 'beer_style' ],
            'nav_menu'           => (object) [ 'name' => 'nav_menu' ],
            'post_format'        => (object) [ 'name' => 'post_format' ],
            'wp_pattern_category'=> (object) [ 'name' => 'wp_pattern_category' ],
        ];

        $result = Registry::discovered_taxonomies();

        $this->assertSame( [ 'beer_style', 'category' ], $result['included'] );
        $this->assertContains( 'nav_menu',            $result['excluded'] );
        $this->assertContains( 'post_format',         $result['excluded'] );
        $this->assertContains( 'wp_pattern_category', $result['excluded'] );
    }

    public function test_taxonomy_filter_can_extend_excludes(): void {
        $GLOBALS['_jab_test_taxonomies'] = [
            'category'   => (object) [ 'name' => 'category' ],
            'beer_style' => (object) [ 'name' => 'beer_style' ],
        ];
        $GLOBALS['_jab_test_filters']['jab/headless_kit/taxonomy_excludes'] = static function ( array $defaults ): array {
            $defaults[] = 'beer_style';
            return $defaults;
        };

        $result = Registry::discovered_taxonomies();

        $this->assertNotContains( 'beer_style', $result['included'] );
        $this->assertContains( 'beer_style',    $result['excluded'] );
    }
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/wp-plugin && vendor/bin/phpunit --configuration tests/phpunit-unit.xml.dist --filter RegistryDiscoveredTypesTest
```

Expected: FAIL with `Error: Call to undefined method Jab\WpHeadlessKit\Registry::discovered_taxonomies()`.

If `get_taxonomies` is not stubbed in `tests/bootstrap.php`, add (mirrors `get_post_types`):

```php
if ( ! function_exists( 'get_taxonomies' ) ) {
    /**
     * @param array<string, mixed> $args
     * @param string $output 'names'|'objects'
     * @return string[]|object[]
     */
    function get_taxonomies( $args = [], $output = 'names' ): array {
        $map = $GLOBALS['_jab_test_taxonomies'] ?? [];
        if ( 'objects' === $output ) {
            return $map;
        }
        return array_keys( $map );
    }
}
```

- [ ] **Step 3: Add the public method to Registry**

After `discovered_post_types()`, add:

```php
/**
 * Same shape as discovered_post_types() but for taxonomies. See
 * jab/headless_kit/taxonomy_excludes for the filter contract.
 *
 * @return array{ included: string[], excluded: string[] }
 */
public static function discovered_taxonomies(): array {
    /**
     * Filter the list of taxonomy slugs to skip during auto-discovery.
     *
     * @param string[] $excludes Default exclusion list.
     */
    $excludes = (array) apply_filters(
        'jab/headless_kit/taxonomy_excludes',
        self::DEFAULT_TAXONOMY_EXCLUDES
    );

    $public = function_exists( 'get_taxonomies' )
        ? (array) get_taxonomies( [ 'public' => true ], 'names' )
        : [];

    $included = [];
    $excluded = [];
    foreach ( $public as $slug ) {
        if ( in_array( (string) $slug, $excludes, true ) ) {
            $excluded[] = (string) $slug;
            continue;
        }
        $included[] = (string) $slug;
    }
    sort( $included );
    sort( $excluded );
    return [ 'included' => $included, 'excluded' => $excluded ];
}
```

- [ ] **Step 4: Refactor `register_taxonomy_abilities()`**

The existing method (Registry.php:221) does `apply_filters` + `get_taxonomies( [ 'public' => true ], 'objects' )` + per-slug iteration. Replace the discovery prelude with the new helper. Concretely:

```php
private static function register_taxonomy_abilities(): void {
    foreach ( self::discovered_taxonomies()['included'] as $slug ) {
        $taxonomy = function_exists( 'get_taxonomy' )
            ? get_taxonomy( $slug )
            : null;
        if ( ! $taxonomy ) {
            continue;
        }
        TaxonomyTermsAbility::register( $taxonomy, [ self::class, 'ensure_unique_name' ] );
    }
}
```

If `get_taxonomy` is not yet referenced elsewhere in the plugin, the body above uses it because `discovered_taxonomies()` only returns slug strings (the previous code worked with the `'objects'` form). This swap is small but real — if the call site needs the WP_Taxonomy object, retrieve it via `get_taxonomy()`. Verify by reading the current `TaxonomyTermsAbility::register()` signature; it accepts a taxonomy object. Add a `get_taxonomy` stub to `tests/bootstrap.php` if any unit test triggers this path:

```php
if ( ! function_exists( 'get_taxonomy' ) ) {
    function get_taxonomy( string $slug ) {
        $map = $GLOBALS['_jab_test_taxonomies'] ?? [];
        return $map[ $slug ] ?? false;
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd packages/wp-plugin && composer test:unit
```

Expected: `OK (177 tests, 432 assertions)` — the previous 175 + 2 new tests + 6 new assertions.

- [ ] **Step 6: Commit**

```bash
git add packages/wp-plugin/includes/Registry.php packages/wp-plugin/tests/unit/RegistryDiscoveredTypesTest.php packages/wp-plugin/tests/bootstrap.php
git commit -m "$(cat <<'EOF'
feat(wp-plugin): public Registry::discovered_taxonomies()

Mirrors discovered_post_types() for taxonomies. Routes
register_taxonomy_abilities() through the new public helper so
diagnostics facts and the existing taxonomy registration share one
source of truth.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `Acf\Schema::flush_cache()` + generation-salt invalidation

**Files:**
- Test: `packages/wp-plugin/tests/unit/Acf/SchemaFlushCacheTest.php` (new)
- Modify: `packages/wp-plugin/includes/Acf/Schema.php`
- Modify: `packages/wp-plugin/tests/bootstrap.php` (add `update_option` stub)

`for_post_type()` (Schema.php:176) currently keys transients on `md5(VERSION | post_type | fingerprint)`. Phase 5 needs a way to invalidate **all** of those keys for the `--debug-acf` CLI flow. Approach: mix a `jab_acf_schema_generation` integer option into the key as a generation salt; `flush_cache()` increments the option. Cache reads of old keys naturally miss after a flush.

- [ ] **Step 1: Add `update_option` stub**

Append to `packages/wp-plugin/tests/bootstrap.php` (just below the existing `get_option` stub at line 477):

```php
if ( ! function_exists( 'update_option' ) ) {
    /**
     * Stub. Writes to the same $_jab_test_options global the get_option
     * stub reads from. Returns true on a value change, false if unchanged,
     * matching real WP's update_option signature.
     *
     * @param string $key
     * @param mixed $value
     * @return bool
     */
    function update_option( $key, $value ): bool {
        $key = (string) $key;
        if ( ! isset( $GLOBALS['_jab_test_options'] ) || ! is_array( $GLOBALS['_jab_test_options'] ) ) {
            $GLOBALS['_jab_test_options'] = [];
        }
        $prior = $GLOBALS['_jab_test_options'][ $key ] ?? null;
        $GLOBALS['_jab_test_options'][ $key ] = $value;
        return $prior !== $value;
    }
}
```

Also confirm `\jab_wphk_reset_stubs()` clears `$GLOBALS['_jab_test_options']`. Read the function (around tests/bootstrap.php:55) and add the line if missing:

```php
$GLOBALS['_jab_test_options'] = [];
```

- [ ] **Step 2: Write failing tests**

Create `packages/wp-plugin/tests/unit/Acf/SchemaFlushCacheTest.php`:

```php
<?php
declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Acf;

use Jab\WpHeadlessKit\Acf\Schema;
use PHPUnit\Framework\TestCase;

final class SchemaFlushCacheTest extends TestCase {

    protected function setUp(): void {
        \jab_wphk_reset_stubs();
    }

    public function test_flush_cache_starts_from_zero(): void {
        $this->assertSame( 0, (int) get_option( 'jab_acf_schema_generation', 0 ) );
    }

    public function test_flush_cache_increments_generation_option(): void {
        Schema::flush_cache();
        $this->assertSame( 1, (int) get_option( 'jab_acf_schema_generation', 0 ) );
    }

    public function test_flush_cache_is_idempotently_callable(): void {
        Schema::flush_cache();
        Schema::flush_cache();
        Schema::flush_cache();
        $this->assertSame( 3, (int) get_option( 'jab_acf_schema_generation', 0 ) );
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd packages/wp-plugin && vendor/bin/phpunit --configuration tests/phpunit-unit.xml.dist --filter SchemaFlushCacheTest
```

Expected: FAIL with `Error: Call to undefined method Jab\WpHeadlessKit\Acf\Schema::flush_cache()`.

- [ ] **Step 4: Implement `flush_cache()` and modify the cache key**

Open `packages/wp-plugin/includes/Acf/Schema.php`. Below the existing `diagnostics_enabled()` method, add:

```php
/**
 * Bump the generation salt mixed into ACF schema transient keys. Future
 * for_post_type() lookups will compute a fresh key and miss the cache.
 * Old transients remain in the DB until their HOUR_IN_SECONDS TTL
 * expires and WP cleans them up.
 *
 * Public surface for the Phase 5 --debug-acf CLI flow. Spec §3.
 */
public static function flush_cache(): void {
    if ( ! function_exists( 'get_option' ) || ! function_exists( 'update_option' ) ) {
        return;
    }
    $current = (int) get_option( 'jab_acf_schema_generation', 0 );
    update_option( 'jab_acf_schema_generation', $current + 1 );
}
```

In `for_post_type()`, locate the cache-key computation (Schema.php:195-197):

```php
$plugin_version = defined( 'Jab\\WpHeadlessKit\\VERSION' ) ? \Jab\WpHeadlessKit\VERSION : 'unknown';
$fingerprint    = self::field_groups_fingerprint();
$cache_key      = 'jab_acf_schema_' . md5( $plugin_version . '|' . $post_type . '|' . $fingerprint );
```

Replace with:

```php
$plugin_version = defined( 'Jab\\WpHeadlessKit\\VERSION' ) ? \Jab\WpHeadlessKit\VERSION : 'unknown';
$generation     = function_exists( 'get_option' ) ? (int) get_option( 'jab_acf_schema_generation', 0 ) : 0;
$fingerprint    = self::field_groups_fingerprint();
$cache_key      = 'jab_acf_schema_' . md5( $plugin_version . '|' . $generation . '|' . $post_type . '|' . $fingerprint );
```

- [ ] **Step 5: Run tests to verify they pass + unit suite is green**

```bash
cd packages/wp-plugin && composer test:unit
```

Expected: `OK (180 tests, 435 assertions)` — 177 + 3 new tests + 3 new assertions.

- [ ] **Step 6: Commit**

```bash
git add packages/wp-plugin/includes/Acf/Schema.php packages/wp-plugin/tests/unit/Acf/SchemaFlushCacheTest.php packages/wp-plugin/tests/bootstrap.php
git commit -m "$(cat <<'EOF'
feat(wp-plugin): Acf\\Schema::flush_cache() via generation salt

Phase 5's --debug-acf CLI flow needs to invalidate every per-CPT ACF
schema transient before rebuilding. WP transients have no key index
and no prefix scan, so flush_cache() bumps a new jab_acf_schema_
generation option that the cache key mixes in. Future for_post_type()
lookups compute a new key and miss; stale transients expire via the
existing HOUR_IN_SECONDS TTL.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `Diagnostics\Fact` and `Diagnostics\Check` value objects

**Files:**
- Create: `packages/wp-plugin/includes/Diagnostics/Fact.php`
- Create: `packages/wp-plugin/includes/Diagnostics/Check.php`
- Test: `packages/wp-plugin/tests/unit/Diagnostics/FactTest.php`
- Test: `packages/wp-plugin/tests/unit/Diagnostics/CheckTest.php`

Pure value objects. Build via constructor (Fact) or named static factories (Check — one per severity). `to_array()` serializes for JSON.

- [ ] **Step 1: Write the failing tests**

`packages/wp-plugin/tests/unit/Diagnostics/FactTest.php`:

```php
<?php
declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Diagnostics;

use Jab\WpHeadlessKit\Diagnostics\Fact;
use PHPUnit\Framework\TestCase;

final class FactTest extends TestCase {

    public function test_minimal_fact_serializes_without_detail(): void {
        $fact = new Fact( 'plugin_version', 'Plugin version', '0.7.1' );
        $this->assertSame(
            [ 'id' => 'plugin_version', 'label' => 'Plugin version', 'value' => '0.7.1' ],
            $fact->to_array()
        );
    }

    public function test_fact_with_detail_includes_detail_key(): void {
        $fact = new Fact(
            'registered_abilities',
            'Registered JAB abilities',
            14,
            [ 'jab/get-posts', 'jab/get-pages' ]
        );
        $this->assertSame(
            [
                'id'     => 'registered_abilities',
                'label'  => 'Registered JAB abilities',
                'value'  => 14,
                'detail' => [ 'jab/get-posts', 'jab/get-pages' ],
            ],
            $fact->to_array()
        );
    }

    public function test_fact_value_can_be_a_nested_array(): void {
        $fact = new Fact(
            'post_types',
            'Public post types',
            [ 'included' => [ 'post', 'page' ], 'excluded' => [ 'attachment' ] ]
        );
        $array = $fact->to_array();
        $this->assertSame( [ 'post', 'page' ], $array['value']['included'] );
    }
}
```

`packages/wp-plugin/tests/unit/Diagnostics/CheckTest.php`:

```php
<?php
declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Diagnostics;

use Jab\WpHeadlessKit\Diagnostics\Check;
use PHPUnit\Framework\TestCase;

final class CheckTest extends TestCase {

    public function test_pass_factory_produces_pass_severity(): void {
        $check = Check::pass( 'abilities_api', 'Abilities API loaded', 'wp_register_ability() is available.' );
        $this->assertSame(
            [
                'id'       => 'abilities_api',
                'label'    => 'Abilities API loaded',
                'severity' => 'pass',
                'message'  => 'wp_register_ability() is available.',
            ],
            $check->to_array()
        );
    }

    public function test_warn_factory_includes_detail_when_supplied(): void {
        $check = Check::warn(
            'application_passwords_enabled',
            'Application Passwords enabled',
            'Disabled — agencies cannot authenticate against this site.',
            'is_ssl()=false'
        );
        $this->assertSame( 'warn',                $check->to_array()['severity'] );
        $this->assertSame( 'is_ssl()=false',      $check->to_array()['detail'] );
    }

    public function test_fail_factory_supports_array_detail(): void {
        $check = Check::fail(
            'rest_routes_registered',
            'JAB REST routes registered',
            '3/5 routes present.',
            [ '/jab/v1/site', '/jab/v1/diagnostics' ]
        );
        $this->assertSame( 'fail', $check->to_array()['severity'] );
        $this->assertSame( [ '/jab/v1/site', '/jab/v1/diagnostics' ], $check->to_array()['detail'] );
    }

    public function test_severity_accessor_returns_the_string(): void {
        $this->assertSame( 'pass', Check::pass( 'x', 'y', 'z' )->severity() );
        $this->assertSame( 'warn', Check::warn( 'x', 'y', 'z' )->severity() );
        $this->assertSame( 'fail', Check::fail( 'x', 'y', 'z' )->severity() );
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/wp-plugin && vendor/bin/phpunit --configuration tests/phpunit-unit.xml.dist --filter "FactTest|CheckTest"
```

Expected: FAIL with `Class "Jab\WpHeadlessKit\Diagnostics\Fact" not found`.

- [ ] **Step 3: Implement Fact**

Create `packages/wp-plugin/includes/Diagnostics/Fact.php`:

```php
<?php
/**
 * Fact — value object for a single diagnostics fact row.
 *
 * Phase 5 spec §4. Facts carry no severity — they are observational data
 * (plugin version, post-type universe, etc.). Pair with Check value objects.
 *
 * @package Jab\WpHeadlessKit\Diagnostics
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Diagnostics;

defined( 'ABSPATH' ) || exit;

final class Fact {

    private string $id;
    private string $label;

    /** @var mixed */
    private $value;

    /** @var array<int, mixed>|string|null */
    private $detail;

    /**
     * @param mixed                          $value  Anything JSON-serializable.
     * @param array<int, mixed>|string|null  $detail
     */
    public function __construct( string $id, string $label, $value, $detail = null ) {
        $this->id     = $id;
        $this->label  = $label;
        $this->value  = $value;
        $this->detail = $detail;
    }

    /**
     * @return array<string, mixed>
     */
    public function to_array(): array {
        $out = [
            'id'    => $this->id,
            'label' => $this->label,
            'value' => $this->value,
        ];
        if ( null !== $this->detail ) {
            $out['detail'] = $this->detail;
        }
        return $out;
    }
}
```

- [ ] **Step 4: Implement Check**

Create `packages/wp-plugin/includes/Diagnostics/Check.php`:

```php
<?php
/**
 * Check — value object for a single diagnostics check row.
 *
 * Phase 5 spec §4. severity is one of pass | warn | fail. Stable id slug.
 *
 * @package Jab\WpHeadlessKit\Diagnostics
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Diagnostics;

defined( 'ABSPATH' ) || exit;

final class Check {

    public const PASS = 'pass';
    public const WARN = 'warn';
    public const FAIL = 'fail';

    private string $id;
    private string $label;
    private string $severity;
    private string $message;

    /** @var array<int, string>|string|null */
    private $detail;

    /**
     * @param array<int, string>|string|null $detail
     */
    private function __construct( string $id, string $label, string $severity, string $message, $detail ) {
        $this->id       = $id;
        $this->label    = $label;
        $this->severity = $severity;
        $this->message  = $message;
        $this->detail   = $detail;
    }

    /**
     * @param array<int, string>|string|null $detail
     */
    public static function pass( string $id, string $label, string $message, $detail = null ): self {
        return new self( $id, $label, self::PASS, $message, $detail );
    }

    /**
     * @param array<int, string>|string|null $detail
     */
    public static function warn( string $id, string $label, string $message, $detail = null ): self {
        return new self( $id, $label, self::WARN, $message, $detail );
    }

    /**
     * @param array<int, string>|string|null $detail
     */
    public static function fail( string $id, string $label, string $message, $detail = null ): self {
        return new self( $id, $label, self::FAIL, $message, $detail );
    }

    public function severity(): string {
        return $this->severity;
    }

    /**
     * @return array<string, mixed>
     */
    public function to_array(): array {
        $out = [
            'id'       => $this->id,
            'label'    => $this->label,
            'severity' => $this->severity,
            'message'  => $this->message,
        ];
        if ( null !== $this->detail ) {
            $out['detail'] = $this->detail;
        }
        return $out;
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd packages/wp-plugin && composer test:unit
```

Expected: `OK (187 tests, 442 assertions)` — 180 + 7 new tests + 7 new assertions.

- [ ] **Step 6: Commit**

```bash
git add packages/wp-plugin/includes/Diagnostics/ packages/wp-plugin/tests/unit/Diagnostics/
git commit -m "$(cat <<'EOF'
feat(wp-plugin): Diagnostics\\Fact and Diagnostics\\Check value objects

Phase 5 foundation: small immutable value objects for the report's
facts (observational) and checks (with pass/warn/fail severity). Each
carries a stable id slug per the spec's public-contract rule (§4).
Named static factories on Check pin severity at construction.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `Diagnostics\Report::from_environment()` (pure renderer)

**Files:**
- Create: `packages/wp-plugin/includes/Diagnostics/Report.php`
- Test: `packages/wp-plugin/tests/unit/Diagnostics/ReportFromEnvironmentTest.php`

The pure half of the service. Takes a snapshot array of facts about the WP install and returns the report dictionary documented in spec §4. Heavily unit-tested because all the deterministic-ordering, severity-rollup, and check-catalog logic lives here.

- [ ] **Step 1: Write the failing test**

Create `packages/wp-plugin/tests/unit/Diagnostics/ReportFromEnvironmentTest.php`:

```php
<?php
declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Diagnostics;

use Jab\WpHeadlessKit\Diagnostics\Report;
use PHPUnit\Framework\TestCase;

final class ReportFromEnvironmentTest extends TestCase {

    /**
     * Builds a "happy path" environment snapshot where every check passes.
     */
    private function happy_env(): array {
        return [
            'plugin_version'              => '0.7.1',
            'wp_version'                  => '6.9.0',
            'php_version'                 => '8.3.7',
            'has_abilities_api'           => true,
            'has_mcp_adapter'             => true,
            'mcp_adapter_version'         => '0.5.0',
            'registered_jab_ability_names'=> [ 'jab/get-pages', 'jab/get-posts' ],
            'post_types'                  => [ 'included' => [ 'page', 'post' ], 'excluded' => [ 'attachment' ] ],
            'taxonomies'                  => [ 'included' => [ 'category' ],     'excluded' => [ 'nav_menu' ] ],
            'capability_filters'          => [
                'jab/headless_kit/ability_capability'        => 'read',
                'jab/headless_kit/manifest_capability'       => 'read',
                'jab/headless_kit/site_manifest_capability'  => 'edit_posts',
                'jab/headless_kit/diagnostics_capability'    => 'manage_options',
            ],
            'acf' => [
                'active'              => false,
                'pro'                 => false,
                'version'             => null,
                'diagnostics_enabled' => false,
                'skipped_groups'      => [],
                'dropped_fields'      => [],
            ],
            'expected_rest_routes'        => [ '/jab/v1/', '/jab/v1/content-types', '/jab/v1/diagnostics', '/jab/v1/manifest', '/jab/v1/site' ],
            'registered_rest_routes'      => [ '/jab/v1/', '/jab/v1/content-types', '/jab/v1/diagnostics', '/jab/v1/manifest', '/jab/v1/site' ],
            'application_passwords_available' => true,
            'is_ssl'                      => true,
            'generated_at'                => '2026-06-02T20:15:00Z',
        ];
    }

    public function test_happy_path_envelope_contains_required_top_level_keys(): void {
        $report = Report::from_environment( $this->happy_env() );

        $this->assertSame( '0.7.1',                  $report['plugin_version'] );
        $this->assertSame( '2026-06-02T20:15:00Z',   $report['generated_at'] );
        $this->assertArrayHasKey( 'summary', $report );
        $this->assertArrayHasKey( 'facts',   $report );
        $this->assertArrayHasKey( 'checks',  $report );
    }

    public function test_summary_counts_match_check_severities(): void {
        $report = Report::from_environment( $this->happy_env() );

        $this->assertSame( 6, $report['summary']['pass'] );
        $this->assertSame( 0, $report['summary']['warn'] );
        $this->assertSame( 0, $report['summary']['fail'] );
    }

    public function test_checks_appear_in_catalog_order(): void {
        $report = Report::from_environment( $this->happy_env() );
        $ids    = array_column( $report['checks'], 'id' );

        $this->assertSame(
            [
                'abilities_api',
                'mcp_adapter',
                'rest_routes_registered',
                'post_types_discovered',
                'application_passwords_enabled',
                'acf_no_schema_skips',
            ],
            $ids
        );
    }

    public function test_facts_appear_in_catalog_order(): void {
        $report = Report::from_environment( $this->happy_env() );
        $ids    = array_column( $report['facts'], 'id' );

        $this->assertSame(
            [
                'plugin_version',
                'wp_version',
                'php_version',
                'registered_abilities',
                'post_types',
                'taxonomies',
                'capability_filters',
                'acf',
            ],
            $ids
        );
    }

    public function test_missing_abilities_api_marks_check_as_fail(): void {
        $env                       = $this->happy_env();
        $env['has_abilities_api']  = false;

        $report = Report::from_environment( $env );
        $check  = array_values( array_filter( $report['checks'], static fn ( array $c ) => 'abilities_api' === $c['id'] ) )[0];

        $this->assertSame( 'fail', $check['severity'] );
        $this->assertSame( 1, $report['summary']['fail'] );
    }

    public function test_missing_mcp_adapter_marks_check_as_fail(): void {
        $env                  = $this->happy_env();
        $env['has_mcp_adapter']     = false;
        $env['mcp_adapter_version'] = null;

        $report = Report::from_environment( $env );
        $check  = array_values( array_filter( $report['checks'], static fn ( array $c ) => 'mcp_adapter' === $c['id'] ) )[0];

        $this->assertSame( 'fail', $check['severity'] );
    }

    public function test_missing_rest_route_reports_fail_with_missing_detail(): void {
        $env                            = $this->happy_env();
        $env['registered_rest_routes']  = [ '/jab/v1/', '/jab/v1/manifest' ];

        $report = Report::from_environment( $env );
        $check  = array_values( array_filter( $report['checks'], static fn ( array $c ) => 'rest_routes_registered' === $c['id'] ) )[0];

        $this->assertSame( 'fail', $check['severity'] );
        $this->assertSame(
            [ '/jab/v1/content-types', '/jab/v1/diagnostics', '/jab/v1/site' ],
            $check['detail']
        );
    }

    public function test_zero_post_types_discovered_reports_fail(): void {
        $env                  = $this->happy_env();
        $env['post_types']    = [ 'included' => [], 'excluded' => [ 'attachment' ] ];

        $report = Report::from_environment( $env );
        $check  = array_values( array_filter( $report['checks'], static fn ( array $c ) => 'post_types_discovered' === $c['id'] ) )[0];

        $this->assertSame( 'fail', $check['severity'] );
    }

    public function test_application_passwords_unavailable_reports_warn_with_ssl_detail(): void {
        $env                                      = $this->happy_env();
        $env['application_passwords_available']   = false;
        $env['is_ssl']                            = false;

        $report = Report::from_environment( $env );
        $check  = array_values( array_filter( $report['checks'], static fn ( array $c ) => 'application_passwords_enabled' === $c['id'] ) )[0];

        $this->assertSame( 'warn', $check['severity'] );
        $this->assertSame( 'is_ssl()=false', $check['detail'] );
    }

    public function test_acf_skipped_groups_with_tracking_on_reports_warn(): void {
        $env                                  = $this->happy_env();
        $env['acf']['active']                 = true;
        $env['acf']['version']                = '6.3.4';
        $env['acf']['diagnostics_enabled']    = true;
        $env['acf']['skipped_groups']         = [
            [ 'post_type' => 'beer', 'group_key' => 'group_xyz', 'reason' => 'unsupported location' ],
        ];

        $report = Report::from_environment( $env );
        $check  = array_values( array_filter( $report['checks'], static fn ( array $c ) => 'acf_no_schema_skips' === $c['id'] ) )[0];

        $this->assertSame( 'warn', $check['severity'] );
    }

    public function test_acf_diagnostics_tracking_off_reports_pass_with_note(): void {
        $env = $this->happy_env(); // acf inactive + tracking off
        $report = Report::from_environment( $env );
        $check  = array_values( array_filter( $report['checks'], static fn ( array $c ) => 'acf_no_schema_skips' === $c['id'] ) )[0];

        $this->assertSame( 'pass', $check['severity'] );
    }

    public function test_capability_filters_keys_alphabetically_sorted_in_output(): void {
        $report = Report::from_environment( $this->happy_env() );
        $facts  = array_values( array_filter( $report['facts'], static fn ( array $f ) => 'capability_filters' === $f['id'] ) );
        $keys   = array_keys( $facts[0]['value'] );

        $this->assertSame(
            [
                'jab/headless_kit/ability_capability',
                'jab/headless_kit/diagnostics_capability',
                'jab/headless_kit/manifest_capability',
                'jab/headless_kit/site_manifest_capability',
            ],
            $keys
        );
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/wp-plugin && vendor/bin/phpunit --configuration tests/phpunit-unit.xml.dist --filter ReportFromEnvironmentTest
```

Expected: FAIL with `Class "Jab\WpHeadlessKit\Diagnostics\Report" not found`.

- [ ] **Step 3: Implement `Report::from_environment()`**

Create `packages/wp-plugin/includes/Diagnostics/Report.php`:

```php
<?php
/**
 * Report — Phase 5 diagnostics service.
 *
 * Two halves with one public surface (generate()):
 *   - collect_environment(): WP-bound. Reads filter values, registry state,
 *     REST routes, plugin/PHP/WP versions, ACF state. Integration-tested.
 *   - from_environment( $env ): pure. Builds the documented report shape
 *     from the snapshot. Unit-tested.
 *
 * The deterministic ordering rules (spec §4) and full check catalog (§5)
 * live in from_environment().
 *
 * @package Jab\WpHeadlessKit\Diagnostics
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Diagnostics;

defined( 'ABSPATH' ) || exit;

final class Report {

    /**
     * Routes the spec requires the plugin to register. Order is the contract
     * for the rest_routes_registered detail array — sorted alphabetically.
     */
    public const EXPECTED_REST_ROUTES = [
        '/jab/v1/',
        '/jab/v1/content-types',
        '/jab/v1/diagnostics',
        '/jab/v1/manifest',
        '/jab/v1/site',
    ];

    /**
     * Build the full report from a pre-collected environment snapshot.
     * Pure. No WP calls.
     *
     * @param array<string, mixed> $env Snapshot produced by collect_environment().
     * @return array<string, mixed>
     */
    public static function from_environment( array $env ): array {
        $facts  = self::build_facts( $env );
        $checks = self::build_checks( $env );

        return [
            'plugin_version' => (string) ( $env['plugin_version'] ?? '' ),
            'generated_at'   => (string) ( $env['generated_at']   ?? '' ),
            'summary'        => self::summarize( $checks ),
            'facts'          => array_map( static fn ( Fact $f ): array  => $f->to_array(), $facts ),
            'checks'         => array_map( static fn ( Check $c ): array => $c->to_array(), $checks ),
        ];
    }

    /**
     * @return Fact[]
     */
    private static function build_facts( array $env ): array {
        $cap_filters = (array) ( $env['capability_filters'] ?? [] );
        ksort( $cap_filters );

        $ability_names = (array) ( $env['registered_jab_ability_names'] ?? [] );
        sort( $ability_names );

        $post_types = (array) ( $env['post_types'] ?? [ 'included' => [], 'excluded' => [] ] );
        $taxonomies = (array) ( $env['taxonomies'] ?? [ 'included' => [], 'excluded' => [] ] );

        $acf = (array) ( $env['acf'] ?? [] );

        return [
            new Fact( 'plugin_version',       'Plugin version',          (string) ( $env['plugin_version'] ?? '' ) ),
            new Fact( 'wp_version',           'WordPress version',       (string) ( $env['wp_version']     ?? '' ) ),
            new Fact( 'php_version',          'PHP version',             (string) ( $env['php_version']    ?? '' ) ),
            new Fact( 'registered_abilities', 'Registered JAB abilities', count( $ability_names ), $ability_names ),
            new Fact( 'post_types',           'Public post types',       $post_types ),
            new Fact( 'taxonomies',           'Public taxonomies',       $taxonomies ),
            new Fact( 'capability_filters',   'Capability filter values', $cap_filters ),
            new Fact( 'acf',                  'ACF',                     $acf, self::acf_detail_note( $acf ) ),
        ];
    }

    /**
     * @return Check[]
     */
    private static function build_checks( array $env ): array {
        return [
            self::check_abilities_api( $env ),
            self::check_mcp_adapter( $env ),
            self::check_rest_routes_registered( $env ),
            self::check_post_types_discovered( $env ),
            self::check_application_passwords_enabled( $env ),
            self::check_acf_no_schema_skips( $env ),
        ];
    }

    private static function check_abilities_api( array $env ): Check {
        if ( true === ( $env['has_abilities_api'] ?? false ) ) {
            return Check::pass( 'abilities_api', 'Abilities API loaded', 'wp_register_ability() is available.' );
        }
        return Check::fail( 'abilities_api', 'Abilities API loaded',
            'wp_register_ability() is not available. The plugin requires WordPress 6.9 or later.' );
    }

    private static function check_mcp_adapter( array $env ): Check {
        if ( true === ( $env['has_mcp_adapter'] ?? false ) ) {
            $version = (string) ( $env['mcp_adapter_version'] ?? 'unknown' );
            return Check::pass( 'mcp_adapter', 'MCP Adapter loaded', "wordpress/mcp-adapter v{$version} detected." );
        }
        return Check::fail( 'mcp_adapter', 'MCP Adapter loaded',
            'wordpress/mcp-adapter is not loaded. The plugin requires it for MCP-iterable headless use.' );
    }

    private static function check_rest_routes_registered( array $env ): Check {
        $registered = (array) ( $env['registered_rest_routes'] ?? [] );
        $expected   = self::EXPECTED_REST_ROUTES;
        $missing    = array_values( array_diff( $expected, $registered ) );
        sort( $missing );

        $registered_present = array_values( array_intersect( $expected, $registered ) );
        sort( $registered_present );

        $total   = count( $expected );
        $present = count( $registered_present );
        $msg     = "{$present}/{$total} routes present.";

        if ( $present === $total ) {
            return Check::pass( 'rest_routes_registered', 'JAB REST routes registered', $msg, $registered_present );
        }
        return Check::fail( 'rest_routes_registered', 'JAB REST routes registered', $msg, $missing );
    }

    private static function check_post_types_discovered( array $env ): Check {
        $included = (array) ( $env['post_types']['included'] ?? [] );
        $count    = count( $included );
        if ( $count > 0 ) {
            return Check::pass( 'post_types_discovered', 'At least one public post type discovered', "{$count} discovered." );
        }
        return Check::fail( 'post_types_discovered', 'At least one public post type discovered',
            'No public post types after exclusions. Either the post_type_excludes filter is over-restrictive, or WP core is in a broken state.' );
    }

    private static function check_application_passwords_enabled( array $env ): Check {
        $available = (bool) ( $env['application_passwords_available'] ?? false );
        $is_ssl    = (bool) ( $env['is_ssl'] ?? false );
        if ( $available ) {
            return Check::pass(
                'application_passwords_enabled',
                'Application Passwords enabled',
                'wp_is_application_passwords_available() true.'
            );
        }
        return Check::warn(
            'application_passwords_enabled',
            'Application Passwords enabled',
            'Disabled — agencies cannot authenticate against this site via the CLI or SaaS until re-enabled.',
            'is_ssl()=' . ( $is_ssl ? 'true' : 'false' )
        );
    }

    private static function check_acf_no_schema_skips( array $env ): Check {
        $acf = (array) ( $env['acf'] ?? [] );
        $diagnostics_on = (bool) ( $acf['diagnostics_enabled'] ?? false );

        if ( ! $diagnostics_on ) {
            return Check::pass(
                'acf_no_schema_skips',
                'No ACF schema skips',
                'Tracking off — no data to report.'
            );
        }

        $groups = (array) ( $acf['skipped_groups'] ?? [] );
        $fields = (array) ( $acf['dropped_fields'] ?? [] );
        $total  = count( $groups ) + count( $fields );

        if ( 0 === $total ) {
            return Check::pass(
                'acf_no_schema_skips',
                'No ACF schema skips',
                'Tracking on — ledger empty.'
            );
        }

        return Check::warn(
            'acf_no_schema_skips',
            'No ACF schema skips',
            sprintf( '%d ACF group(s) or field(s) were skipped during schema generation.', $total ),
            [
                'skipped_groups' => $groups,
                'dropped_fields' => $fields,
            ]
        );
    }

    private static function acf_detail_note( array $acf ): ?string {
        if ( true === ( $acf['diagnostics_enabled'] ?? false ) ) {
            return null;
        }
        return 'Diagnostics ledger is empty because WP_DEBUG is off and the jab/headless_kit/acf_diagnostics filter is not set to true. Run `wp jab doctor --debug-acf` or set WP_DEBUG=true to populate.';
    }

    /**
     * @param Check[] $checks
     * @return array{ pass: int, warn: int, fail: int }
     */
    private static function summarize( array $checks ): array {
        $counts = [ Check::PASS => 0, Check::WARN => 0, Check::FAIL => 0 ];
        foreach ( $checks as $check ) {
            $counts[ $check->severity() ] = ( $counts[ $check->severity() ] ?? 0 ) + 1;
        }
        return [
            'pass' => $counts[ Check::PASS ],
            'warn' => $counts[ Check::WARN ],
            'fail' => $counts[ Check::FAIL ],
        ];
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/wp-plugin && composer test:unit
```

Expected: `OK (198 tests, 460 assertions)` — 187 + 11 new tests, plus the corresponding new assertions.

- [ ] **Step 5: Commit**

```bash
git add packages/wp-plugin/includes/Diagnostics/Report.php packages/wp-plugin/tests/unit/Diagnostics/ReportFromEnvironmentTest.php
git commit -m "$(cat <<'EOF'
feat(wp-plugin): Diagnostics\\Report::from_environment() pure renderer

The pure half of the Phase 5 diagnostics service. Takes a snapshot of
WP / plugin state and returns the documented report shape (spec §4) with
deterministic ordering: facts in catalog order, checks in catalog order,
nested slug lists alphabetically sorted, capability_filters keys
alphabetically sorted, and a summary pass/warn/fail rollup. All six
checks implemented per the spec §5 catalog. collect_environment() (the
WP-bound boundary) follows in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `Diagnostics\Report::collect_environment()` + `generate()`

**Files:**
- Modify: `packages/wp-plugin/includes/Diagnostics/Report.php`

The WP-bound boundary. Reads filter resolutions, registry state, REST routes, ACF state, and PHP / WP version metadata into the environment snapshot `from_environment()` consumes. Plus the public `generate()` orchestrator that composes the two halves.

This task does not introduce new unit tests — the boundary code is unit-mocked input to from_environment() (already tested) and the WP-side calls are integration-tested in Task 13.

- [ ] **Step 1: Add `collect_environment()` and `generate()`**

Open `packages/wp-plugin/includes/Diagnostics/Report.php`. Above the `private static function build_facts(...)` line, add:

```php
/**
 * Public entry point. Collects current WP / plugin state, hands the
 * snapshot to from_environment(), returns the report.
 *
 * @return array<string, mixed>
 */
public static function generate(): array {
    return self::from_environment( self::collect_environment() );
}

/**
 * Snapshot the bits of WP / plugin state every check / fact needs.
 * The WP-bound boundary. Integration-tested.
 *
 * @return array<string, mixed>
 */
public static function collect_environment(): array {
    $registered_routes = [];
    if ( function_exists( 'rest_get_server' ) ) {
        $registered_routes = array_keys( (array) rest_get_server()->get_routes() );
    }

    $ability_names = [];
    if ( function_exists( 'wp_get_abilities' ) ) {
        foreach ( (array) wp_get_abilities() as $ability ) {
            if ( is_object( $ability ) && method_exists( $ability, 'get_name' ) ) {
                $name = (string) $ability->get_name();
                if ( '' !== $name && 0 === strpos( $name, 'jab/' ) ) {
                    $ability_names[] = $name;
                }
            }
        }
    }

    $post_types = class_exists( \Jab\WpHeadlessKit\Registry::class )
        ? \Jab\WpHeadlessKit\Registry::discovered_post_types()
        : [ 'included' => [], 'excluded' => [] ];

    $taxonomies = class_exists( \Jab\WpHeadlessKit\Registry::class )
        ? \Jab\WpHeadlessKit\Registry::discovered_taxonomies()
        : [ 'included' => [], 'excluded' => [] ];

    $acf_active = class_exists( \Jab\WpHeadlessKit\Acf\Schema::class )
        && \Jab\WpHeadlessKit\Acf\Schema::is_active();

    $acf_version = defined( 'ACF_VERSION' ) ? (string) ACF_VERSION : null;
    $acf_pro     = defined( 'ACF_PRO' ) ? (bool) ACF_PRO : false;

    $acf_diag = [
        'active'              => $acf_active,
        'pro'                 => $acf_pro,
        'version'             => $acf_version,
        'diagnostics_enabled' => self::acf_diagnostics_enabled(),
        'skipped_groups'      => [],
        'dropped_fields'      => [],
    ];
    if ( class_exists( \Jab\WpHeadlessKit\Acf\Schema::class ) ) {
        $ledger = (array) \Jab\WpHeadlessKit\Acf\Schema::diagnostics();
        $acf_diag['skipped_groups'] = (array) ( $ledger['groups'] ?? [] );
        $acf_diag['dropped_fields'] = (array) ( $ledger['fields'] ?? [] );
    }

    $plugin_version = defined( 'Jab\\WpHeadlessKit\\VERSION' ) ? (string) \Jab\WpHeadlessKit\VERSION : '';
    $wp_version     = function_exists( 'get_bloginfo' ) ? (string) get_bloginfo( 'version' ) : '';

    return [
        'plugin_version'                  => $plugin_version,
        'wp_version'                      => $wp_version,
        'php_version'                     => PHP_VERSION,
        'has_abilities_api'               => function_exists( 'wp_register_ability' ),
        'has_mcp_adapter'                 => class_exists( 'WP\\MCP\\Core\\McpAdapter' ),
        'mcp_adapter_version'             => defined( 'WP_MCP_VERSION' ) ? (string) WP_MCP_VERSION : null,
        'registered_jab_ability_names'    => $ability_names,
        'post_types'                      => $post_types,
        'taxonomies'                      => $taxonomies,
        'capability_filters'              => self::collect_capability_filters(),
        'acf'                             => $acf_diag,
        'expected_rest_routes'            => self::EXPECTED_REST_ROUTES,
        'registered_rest_routes'          => $registered_routes,
        'application_passwords_available' => function_exists( 'wp_is_application_passwords_available' )
            ? (bool) wp_is_application_passwords_available()
            : false,
        'is_ssl'                          => function_exists( 'is_ssl' ) ? (bool) is_ssl() : false,
        'generated_at'                    => gmdate( 'Y-m-d\TH:i:s\Z' ),
    ];
}

/**
 * Resolve every filterable capability surface to its current value.
 * Returns slug => resolved-capability map.
 *
 * @return array<string, string>
 */
private static function collect_capability_filters(): array {
    $resolvers = [
        'jab/headless_kit/manifest_capability'       => [ \Jab\WpHeadlessKit\Rest\Manifest::class,      'capability' ],
        'jab/headless_kit/site_manifest_capability'  => [ \Jab\WpHeadlessKit\Rest\SiteManifest::class,  'capability' ],
        'jab/headless_kit/diagnostics_capability'    => [ \Jab\WpHeadlessKit\Rest\Diagnostics::class,   'capability' ],
        'jab/headless_kit/ability_capability'        => [ \Jab\WpHeadlessKit\Permissions::class,        'ability_capability' ],
    ];
    $out = [];
    foreach ( $resolvers as $filter_name => $resolver ) {
        [ $class, $method ] = $resolver;
        if ( class_exists( $class ) && method_exists( $class, $method ) ) {
            $out[ $filter_name ] = (string) call_user_func( [ $class, $method ] );
        } else {
            $out[ $filter_name ] = '';
        }
    }
    return $out;
}

private static function acf_diagnostics_enabled(): bool {
    if ( defined( 'WP_DEBUG' ) && WP_DEBUG ) {
        return true;
    }
    if ( function_exists( 'apply_filters' ) ) {
        return (bool) apply_filters( 'jab/headless_kit/acf_diagnostics', false );
    }
    return false;
}
```

Note: `Jab\WpHeadlessKit\Rest\Diagnostics::capability` is referenced before that class exists; the next task creates it. Until then, the `class_exists` guard inside `collect_capability_filters()` returns `''` for the diagnostics row. The unit tests for `from_environment()` already pass the resolved cap map explicitly so they are unaffected; the integration tests in Task 13 will assert the real value.

- [ ] **Step 2: Run unit suite to confirm no regression**

```bash
cd packages/wp-plugin && composer test:unit
```

Expected: still `OK (198 tests, 460 assertions)`. The new methods aren't called by any unit test, so the count is unchanged.

- [ ] **Step 3: Run lint to confirm new code is PHPCS-clean**

```bash
cd packages/wp-plugin && composer lint
```

Expected: `20/20 (100%)` exits 0. Diagnostics/ files are auto-detected via the existing source-path glob in `phpcs.xml.dist`.

- [ ] **Step 4: Commit**

```bash
git add packages/wp-plugin/includes/Diagnostics/Report.php
git commit -m "$(cat <<'EOF'
feat(wp-plugin): Diagnostics\\Report::collect_environment() + generate()

The WP-bound boundary that snapshots filter resolutions, registry state,
REST routes, ACF state, PHP and WP versions. Composes with the existing
from_environment() pure renderer via generate(). Integration-tested in
Task 13.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `Rest\Diagnostics` endpoint + registration

**Files:**
- Create: `packages/wp-plugin/includes/Rest/Diagnostics.php`
- Modify: `packages/wp-plugin/wp-headless-kit.php`
- Test: `packages/wp-plugin/tests/unit/Rest/DiagnosticsCapabilityTest.php`

Mirrors `Rest\Manifest::capability()` and `Rest\SiteManifest::capability()`. Default cap `manage_options`, filterable via `jab/headless_kit/diagnostics_capability`, with the SEC-1-style `do_not_allow` fallback on non-string / empty return.

- [ ] **Step 1: Write the failing unit test for capability resolution**

Create `packages/wp-plugin/tests/unit/Rest/DiagnosticsCapabilityTest.php`:

```php
<?php
declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Rest;

use Jab\WpHeadlessKit\Rest\Diagnostics;
use PHPUnit\Framework\TestCase;

final class DiagnosticsCapabilityTest extends TestCase {

    protected function setUp(): void {
        \jab_wphk_reset_stubs();
    }

    public function test_default_capability_is_manage_options(): void {
        $this->assertSame( 'manage_options', Diagnostics::capability() );
    }

    public function test_filter_can_lower_capability(): void {
        $GLOBALS['_jab_test_filters']['jab/headless_kit/diagnostics_capability'] = static fn ( string $cap ): string => 'read';
        $this->assertSame( 'read', Diagnostics::capability() );
    }

    public function test_non_string_filter_return_falls_back_to_do_not_allow(): void {
        $GLOBALS['_jab_test_filters']['jab/headless_kit/diagnostics_capability'] = static fn ( $cap ): int => 42;
        $this->assertSame( 'do_not_allow', Diagnostics::capability() );
    }

    public function test_empty_string_filter_return_falls_back_to_do_not_allow(): void {
        $GLOBALS['_jab_test_filters']['jab/headless_kit/diagnostics_capability'] = static fn ( $cap ): string => '';
        $this->assertSame( 'do_not_allow', Diagnostics::capability() );
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/wp-plugin && vendor/bin/phpunit --configuration tests/phpunit-unit.xml.dist --filter DiagnosticsCapabilityTest
```

Expected: FAIL with `Class "Jab\WpHeadlessKit\Rest\Diagnostics" not found`.

- [ ] **Step 3: Implement `Rest\Diagnostics`**

Create `packages/wp-plugin/includes/Rest/Diagnostics.php`:

```php
<?php
/**
 * Diagnostics — REST route at /wp-json/jab/v1/diagnostics. Returns the
 * structured diagnostics Report consumed by the SaaS onboarding wizard
 * and any operator with an admin-grade Application Password.
 *
 * Auth contract mirrors Manifest::capability() and SiteManifest::capability():
 * a filter returning a non-string or empty value falls back to do_not_allow
 * (the SEC-1 hardening pattern).
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Rest;

use Jab\WpHeadlessKit\Diagnostics\Report;

defined( 'ABSPATH' ) || exit;

final class Diagnostics {

    private const NAMESPACE = 'jab/v1';
    private const ROUTE     = '/diagnostics';

    /**
     * Default capability gating /jab/v1/diagnostics. Stricter than /manifest
     * (read) and /site (edit_posts) because the response surfaces PHP
     * version, capability filter values, and (when populated) ACF group /
     * field names.
     */
    public const DEFAULT_CAPABILITY = 'manage_options';

    public static function register(): void {
        register_rest_route(
            self::NAMESPACE,
            self::ROUTE,
            [
                'methods'             => \WP_REST_Server::READABLE,
                'callback'            => [ self::class, 'respond' ],
                'permission_callback' => [ self::class, 'authorize' ],
            ]
        );
    }

    /**
     * Resolve the required capability. Filter contract matches Manifest::capability():
     * non-string / empty returns coerce to `do_not_allow` and emit _doing_it_wrong.
     */
    public static function capability(): string {
        /**
         * Filter the capability required to read /jab/v1/diagnostics.
         *
         * @param string $capability Default capability slug.
         */
        $capability = apply_filters(
            'jab/headless_kit/diagnostics_capability',
            self::DEFAULT_CAPABILITY
        );

        if ( ! is_string( $capability ) || '' === $capability ) {
            if ( function_exists( '_doing_it_wrong' ) ) {
                _doing_it_wrong(
                    'Jab\\WpHeadlessKit\\Rest\\Diagnostics::capability',
                    esc_html__( 'jab/headless_kit/diagnostics_capability filter returned a non-string / empty value; denying access. Return a valid capability slug (e.g. "manage_options", "edit_posts") to permit access.', 'wp-headless-kit' ),
                    '0.7.1'
                );
            }
            return 'do_not_allow';
        }

        return $capability;
    }

    public static function authorize(): bool {
        return current_user_can( self::capability() );
    }

    /**
     * GET handler. Returns the diagnostics Report and sets nocache headers
     * — the report state changes with every plugin / site config change.
     */
    public static function respond( \WP_REST_Request $request ): \WP_REST_Response {
        unset( $request );

        if ( function_exists( 'nocache_headers' ) ) {
            nocache_headers();
        }

        return new \WP_REST_Response( Report::generate(), 200 );
    }
}
```

- [ ] **Step 4: Wire registration in the main plugin file**

Open `packages/wp-plugin/wp-headless-kit.php`. Locate the existing line that registers `Rest\Manifest::register` on `rest_api_init` (around line 60-70 — there will be several). Below the existing diagnostic / manifest / site / content-types registrations, add:

```php
add_action( 'rest_api_init', [ \Jab\WpHeadlessKit\Rest\Diagnostics::class, 'register' ] );
```

Confirm the file ends without trailing whitespace. Read the affected block to ensure the new line fits the existing format (each registration is a one-liner on its own line, with matching indentation).

- [ ] **Step 5: Run tests to verify they pass + lint**

```bash
cd packages/wp-plugin && composer test:unit && composer lint
```

Expected: `OK (202 tests, 464 assertions)` and `20/20 (100%)`.

- [ ] **Step 6: Commit**

```bash
git add packages/wp-plugin/includes/Rest/Diagnostics.php packages/wp-plugin/tests/unit/Rest/DiagnosticsCapabilityTest.php packages/wp-plugin/wp-headless-kit.php
git commit -m "$(cat <<'EOF'
feat(wp-plugin): Rest\\Diagnostics endpoint (/jab/v1/diagnostics)

Default cap manage_options (filterable via
jab/headless_kit/diagnostics_capability with the SEC-1 do_not_allow
fallback). Returns Diagnostics\\Report::generate() as JSON. Sends
nocache_headers since the report reflects current state. Registered
in the main plugin file alongside the existing /jab/v1/* surfaces.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `Cli\TextRenderer` — pure golden-output renderer

**Files:**
- Create: `packages/wp-plugin/includes/Cli/TextRenderer.php`
- Test: `packages/wp-plugin/tests/unit/Cli/TextRendererTest.php`

The pure text-format renderer. Takes a report array, returns the formatted block documented in spec §6. Pure function — unit-tested by comparing against a known heredoc.

- [ ] **Step 1: Write the failing golden-output test**

Create `packages/wp-plugin/tests/unit/Cli/TextRendererTest.php`:

```php
<?php
declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Cli;

use Jab\WpHeadlessKit\Cli\TextRenderer;
use PHPUnit\Framework\TestCase;

final class TextRendererTest extends TestCase {

    /**
     * Single golden-output test fixture. Exercises every section of the
     * renderer — facts (including post_types object value and the ACF
     * detail note), checks (one of each severity), and the summary line.
     */
    public function test_renders_report_as_the_specified_text_block(): void {
        $report = [
            'plugin_version' => '0.7.1',
            'generated_at'   => '2026-06-02T20:15:00Z',
            'summary'        => [ 'pass' => 4, 'warn' => 1, 'fail' => 1 ],
            'facts' => [
                [ 'id' => 'plugin_version',       'label' => 'Plugin version',         'value' => '0.7.1' ],
                [ 'id' => 'wp_version',           'label' => 'WordPress version',      'value' => '6.9.0' ],
                [ 'id' => 'php_version',          'label' => 'PHP version',            'value' => '8.3.7' ],
                [ 'id' => 'registered_abilities', 'label' => 'Registered JAB abilities', 'value' => 2, 'detail' => [ 'jab/get-pages', 'jab/get-posts' ] ],
                [ 'id' => 'post_types',           'label' => 'Public post types',      'value' => [ 'included' => [ 'page', 'post' ], 'excluded' => [ 'attachment' ] ] ],
                [ 'id' => 'taxonomies',           'label' => 'Public taxonomies',      'value' => [ 'included' => [ 'category' ],     'excluded' => [ 'nav_menu' ] ] ],
                [ 'id' => 'capability_filters',   'label' => 'Capability filter values', 'value' => [
                    'jab/headless_kit/ability_capability'       => 'read',
                    'jab/headless_kit/diagnostics_capability'   => 'manage_options',
                    'jab/headless_kit/manifest_capability'      => 'read',
                    'jab/headless_kit/site_manifest_capability' => 'edit_posts',
                ] ],
                [ 'id' => 'acf', 'label' => 'ACF', 'value' => [
                    'active' => false, 'pro' => false, 'version' => null,
                    'diagnostics_enabled' => false, 'skipped_groups' => [], 'dropped_fields' => [],
                ], 'detail' => 'Run `wp jab doctor --debug-acf` to populate.' ],
            ],
            'checks' => [
                [ 'id' => 'abilities_api',                 'label' => 'Abilities API loaded',                  'severity' => 'pass', 'message' => 'wp_register_ability() is available.' ],
                [ 'id' => 'mcp_adapter',                   'label' => 'MCP Adapter loaded',                    'severity' => 'fail', 'message' => 'wordpress/mcp-adapter is not loaded.' ],
                [ 'id' => 'rest_routes_registered',        'label' => 'JAB REST routes registered',            'severity' => 'pass', 'message' => '5/5 routes present.' ],
                [ 'id' => 'post_types_discovered',         'label' => 'At least one public post type discovered', 'severity' => 'pass', 'message' => '2 discovered.' ],
                [ 'id' => 'application_passwords_enabled', 'label' => 'Application Passwords enabled',         'severity' => 'warn', 'message' => 'Disabled.', 'detail' => 'is_ssl()=false' ],
                [ 'id' => 'acf_no_schema_skips',           'label' => 'No ACF schema skips',                   'severity' => 'pass', 'message' => 'Tracking off — no data to report.' ],
            ],
        ];

        $expected = <<<TEXT
JAB Headless Kit — Diagnostics

Plugin                0.7.1
WordPress             6.9.0
PHP                   8.3.7
Registered abilities  2 (jab/get-pages, jab/get-posts)
Public post types     2 included (page, post) · 1 excluded (attachment)
Public taxonomies     1 included (category) · 1 excluded (nav_menu)
Capability filters
  ability_capability          read
  diagnostics_capability      manage_options
  manifest_capability         read
  site_manifest_capability    edit_posts
ACF                   inactive
                      Run `wp jab doctor --debug-acf` to populate.

Checks
  pass  Abilities API loaded                  wp_register_ability() is available.
  fail  MCP Adapter loaded                    wordpress/mcp-adapter is not loaded.
  pass  JAB REST routes registered            5/5 routes present.
  pass  At least one public post type discovered  2 discovered.
  warn  Application Passwords enabled         Disabled.
        is_ssl()=false
  pass  No ACF schema skips                   Tracking off — no data to report.

Summary               4 pass · 1 warn · 1 fail
TEXT;

        $this->assertSame( $expected, TextRenderer::render( $report ) );
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/wp-plugin && vendor/bin/phpunit --configuration tests/phpunit-unit.xml.dist --filter TextRendererTest
```

Expected: FAIL with `Class "Jab\WpHeadlessKit\Cli\TextRenderer" not found`.

- [ ] **Step 3: Implement `Cli\TextRenderer`**

Create `packages/wp-plugin/includes/Cli/TextRenderer.php`:

```php
<?php
/**
 * TextRenderer — pure function that turns a Report array into the human
 * text block documented in spec §6. Used by Cli\DoctorCommand when the
 * default `table` format is selected.
 *
 * Extracted so unit tests can compare against a known heredoc without
 * invoking WP-CLI (which would require an entire CLI runtime test rig).
 *
 * @package Jab\WpHeadlessKit\Cli
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Cli;

defined( 'ABSPATH' ) || exit;

final class TextRenderer {

    private const FACT_LABEL_WIDTH  = 22;
    private const CHECK_LABEL_WIDTH = 38;

    /**
     * @param array<string, mixed> $report Output of Diagnostics\Report::generate().
     */
    public static function render( array $report ): string {
        $lines = [];
        $lines[] = 'JAB Headless Kit — Diagnostics';
        $lines[] = '';

        foreach ( (array) ( $report['facts'] ?? [] ) as $fact ) {
            $lines = array_merge( $lines, self::render_fact( (array) $fact ) );
        }

        $lines[] = '';
        $lines[] = 'Checks';
        foreach ( (array) ( $report['checks'] ?? [] ) as $check ) {
            $lines = array_merge( $lines, self::render_check( (array) $check ) );
        }

        $lines[] = '';
        $s = (array) ( $report['summary'] ?? [] );
        $lines[] = self::pad_label( 'Summary' )
            . sprintf( '%d pass · %d warn · %d fail', (int) ( $s['pass'] ?? 0 ), (int) ( $s['warn'] ?? 0 ), (int) ( $s['fail'] ?? 0 ) );

        return implode( "\n", $lines );
    }

    /**
     * @return string[]
     */
    private static function render_fact( array $fact ): array {
        $id    = (string) ( $fact['id'] ?? '' );
        $value = $fact['value'] ?? null;

        switch ( $id ) {
            case 'registered_abilities':
                $names = (array) ( $fact['detail'] ?? [] );
                $shown = $names ? ' (' . implode( ', ', $names ) . ')' : '';
                return [ self::pad_label( 'Registered abilities' ) . (int) $value . $shown ];

            case 'post_types':
            case 'taxonomies':
                $included = (array) ( $value['included'] ?? [] );
                $excluded = (array) ( $value['excluded'] ?? [] );
                $label    = ( 'post_types' === $id ) ? 'Public post types' : 'Public taxonomies';
                $line     = sprintf(
                    '%d included (%s) · %d excluded (%s)',
                    count( $included ),
                    implode( ', ', $included ),
                    count( $excluded ),
                    implode( ', ', $excluded )
                );
                return [ self::pad_label( $label ) . $line ];

            case 'capability_filters':
                $out   = [ self::pad_label( 'Capability filters' ) ];
                $pairs = (array) $value;
                foreach ( $pairs as $filter_name => $cap ) {
                    $short = self::short_filter_name( (string) $filter_name );
                    $out[] = '  ' . str_pad( $short, 28 ) . $cap;
                }
                return $out;

            case 'acf':
                $active = (bool) ( $value['active'] ?? false );
                $pro    = (bool) ( $value['pro']    ?? false );
                $ver    = $value['version'] ?? null;
                $trk    = (bool) ( $value['diagnostics_enabled'] ?? false );
                if ( ! $active ) {
                    $head = 'inactive';
                } else {
                    $head = 'active · v' . (string) $ver . ' (' . ( $pro ? 'pro' : 'free' ) . ') · diagnostics tracking ' . ( $trk ? 'on' : 'off' );
                }
                $out = [ self::pad_label( 'ACF' ) . $head ];
                if ( isset( $fact['detail'] ) ) {
                    $out[] = self::pad_label( '' ) . (string) $fact['detail'];
                }
                return $out;

            case 'plugin_version':
                return [ self::pad_label( 'Plugin' ) . (string) $value ];

            case 'wp_version':
                return [ self::pad_label( 'WordPress' ) . (string) $value ];

            case 'php_version':
                return [ self::pad_label( 'PHP' ) . (string) $value ];

            default:
                return [ self::pad_label( (string) ( $fact['label'] ?? $id ) ) . (string) $value ];
        }
    }

    /**
     * @return string[]
     */
    private static function render_check( array $check ): array {
        $sev   = (string) ( $check['severity'] ?? 'pass' );
        $label = (string) ( $check['label']    ?? '' );
        $msg   = (string) ( $check['message']  ?? '' );

        $out = [ sprintf( '  %s  %s%s', $sev, str_pad( $label, self::CHECK_LABEL_WIDTH ), $msg ) ];

        if ( isset( $check['detail'] ) ) {
            $detail = $check['detail'];
            if ( is_array( $detail ) ) {
                foreach ( $detail as $entry ) {
                    $out[] = '        ' . (string) $entry;
                }
            } else {
                $out[] = '        ' . (string) $detail;
            }
        }

        return $out;
    }

    private static function pad_label( string $label ): string {
        return str_pad( $label, self::FACT_LABEL_WIDTH );
    }

    /**
     * Strip the `jab/headless_kit/` namespace prefix so the text view stays
     * narrow. JSON view keeps the full filter name.
     */
    private static function short_filter_name( string $filter ): string {
        $prefix = 'jab/headless_kit/';
        return 0 === strpos( $filter, $prefix ) ? substr( $filter, strlen( $prefix ) ) : $filter;
    }
}
```

- [ ] **Step 4: Run the test**

```bash
cd packages/wp-plugin && vendor/bin/phpunit --configuration tests/phpunit-unit.xml.dist --filter TextRendererTest
```

Expected: PASS. If FAIL with output diff, the implementation does not match the heredoc. Fix the renderer; the heredoc IS the contract.

- [ ] **Step 5: Lint + full unit suite**

```bash
cd packages/wp-plugin && composer lint && composer test:unit
```

Expected: lint clean, `OK (203 tests, 465 assertions)`.

- [ ] **Step 6: Commit**

```bash
git add packages/wp-plugin/includes/Cli/TextRenderer.php packages/wp-plugin/tests/unit/Cli/TextRendererTest.php
git commit -m "$(cat <<'EOF'
feat(wp-plugin): Cli\\TextRenderer for wp jab doctor table output

Pure function taking a Diagnostics\\Report array and producing the
human-readable text block documented in spec §6. Extracted so the
golden-output unit test can run without invoking WP-CLI. Capability
filter names are short-formed (stripped of jab/headless_kit/ prefix)
in the text view to keep lines narrow; the JSON view keeps full names.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `Cli\DoctorCommand` skeleton + `--format` flag

**Files:**
- Create: `packages/wp-plugin/includes/Cli/DoctorCommand.php`

WP-CLI command class. Registered conditionally on `defined('WP_CLI')`. v1 supports `--format=table|json|yaml`. `--strict` and `--debug-acf` arrive in Tasks 10 and 11.

This task does not include a unit test for the command class itself — exercising WP-CLI registration / argv parsing requires the WP-CLI runtime. We unit-test the pure pieces (`TextRenderer`, exit-code mapping in Task 10) and integration-test the registration via manual smoke when the v0.7.1 zip is built (see spec §8). The skeleton task here lands the code that Tasks 10–12 build on.

- [ ] **Step 1: Create `Cli\DoctorCommand`**

Create `packages/wp-plugin/includes/Cli/DoctorCommand.php`:

```php
<?php
/**
 * DoctorCommand — registers `wp jab doctor`.
 *
 * Renders Diagnostics\Report output in one of three formats:
 *   - table (default, human-readable via TextRenderer)
 *   - json  (machine-readable, same shape as REST endpoint)
 *   - yaml  (machine-readable, alternative)
 *
 * --strict and --debug-acf flags land in subsequent commits.
 *
 * @package Jab\WpHeadlessKit\Cli
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Cli;

use Jab\WpHeadlessKit\Diagnostics\Report;

defined( 'ABSPATH' ) || exit;

final class DoctorCommand {

    /**
     * Hook to register the WP-CLI subcommand. Called from the main plugin
     * file ONLY when defined('WP_CLI') && WP_CLI is true.
     */
    public static function register(): void {
        if ( ! class_exists( '\\WP_CLI' ) ) {
            return;
        }
        \WP_CLI::add_command( 'jab doctor', self::class );
    }

    /**
     * Run diagnostics against the current site.
     *
     * ## OPTIONS
     *
     * [--format=<format>]
     * : Output format. Default: table.
     * ---
     * default: table
     * options:
     *   - table
     *   - json
     *   - yaml
     * ---
     *
     * ## EXAMPLES
     *
     *     wp jab doctor
     *     wp jab doctor --format=json
     */
    public function __invoke( array $args, array $assoc_args ): void {
        $format = (string) ( $assoc_args['format'] ?? 'table' );

        $report = Report::generate();

        if ( 'table' === $format ) {
            \WP_CLI::line( TextRenderer::render( $report ) );
            return;
        }

        // JSON / YAML formats: emit the report verbatim. WP_CLI\Utils\format_items
        // does not handle nested associative objects, so we hand-encode for json/yaml.
        if ( 'json' === $format ) {
            \WP_CLI::line( (string) wp_json_encode( $report, JSON_UNESCAPED_SLASHES ) );
            return;
        }
        if ( 'yaml' === $format ) {
            if ( function_exists( 'yaml_emit' ) ) {
                \WP_CLI::line( (string) yaml_emit( $report ) );
                return;
            }
            \WP_CLI::error( 'YAML format requires the PHP yaml extension. Install ext-yaml or use --format=json.' );
        }
    }
}
```

- [ ] **Step 2: Lint to confirm new file is PHPCS-clean**

```bash
cd packages/wp-plugin && composer lint
```

Expected: `20/20 (100%)`.

- [ ] **Step 3: Commit**

```bash
git add packages/wp-plugin/includes/Cli/DoctorCommand.php
git commit -m "$(cat <<'EOF'
feat(wp-plugin): Cli\\DoctorCommand skeleton with --format flag

wp jab doctor in three formats: table (default, via TextRenderer),
json (matches REST output), yaml (via ext-yaml if present, else
errors with a clear remediation hint). --strict and --debug-acf land
in subsequent commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: `--strict` flag + exit code mapping

**Files:**
- Create: `packages/wp-plugin/tests/unit/Cli/ExitCodeMappingTest.php`
- Modify: `packages/wp-plugin/includes/Cli/DoctorCommand.php` (extract pure mapper, add --strict)

Exit code rules (spec §6):
- Any `fail` → exit 1
- Any `warn` AND `--strict` → exit 1
- Otherwise → exit 0

Extract a static `DoctorCommand::compute_exit_code( array $summary, bool $strict ): int` so the rule is unit-testable without invoking WP-CLI.

- [ ] **Step 1: Write the failing test**

Create `packages/wp-plugin/tests/unit/Cli/ExitCodeMappingTest.php`:

```php
<?php
declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Cli;

use Jab\WpHeadlessKit\Cli\DoctorCommand;
use PHPUnit\Framework\TestCase;

final class ExitCodeMappingTest extends TestCase {

    public function test_all_pass_exits_zero(): void {
        $this->assertSame( 0, DoctorCommand::compute_exit_code( [ 'pass' => 6, 'warn' => 0, 'fail' => 0 ], false ) );
    }

    public function test_any_fail_exits_one_without_strict(): void {
        $this->assertSame( 1, DoctorCommand::compute_exit_code( [ 'pass' => 5, 'warn' => 0, 'fail' => 1 ], false ) );
    }

    public function test_any_fail_exits_one_with_strict(): void {
        $this->assertSame( 1, DoctorCommand::compute_exit_code( [ 'pass' => 5, 'warn' => 0, 'fail' => 1 ], true ) );
    }

    public function test_warn_without_strict_exits_zero(): void {
        $this->assertSame( 0, DoctorCommand::compute_exit_code( [ 'pass' => 5, 'warn' => 1, 'fail' => 0 ], false ) );
    }

    public function test_warn_with_strict_exits_one(): void {
        $this->assertSame( 1, DoctorCommand::compute_exit_code( [ 'pass' => 5, 'warn' => 1, 'fail' => 0 ], true ) );
    }

    public function test_warn_and_fail_with_strict_exits_one(): void {
        $this->assertSame( 1, DoctorCommand::compute_exit_code( [ 'pass' => 4, 'warn' => 1, 'fail' => 1 ], true ) );
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/wp-plugin && vendor/bin/phpunit --configuration tests/phpunit-unit.xml.dist --filter ExitCodeMappingTest
```

Expected: FAIL with `Error: Call to undefined method ...::compute_exit_code()`.

- [ ] **Step 3: Add `compute_exit_code` and `--strict` to DoctorCommand**

Edit `packages/wp-plugin/includes/Cli/DoctorCommand.php`. In the `## OPTIONS` block, after the `[--format=<format>]` option, add:

```php
     *
     * [--strict]
     * : Exit with code 1 if any check has severity `warn` (in addition to
     *   the default behaviour of exiting 1 on `fail`). Useful for CI gates.
```

In the `__invoke()` method, replace the bare emit lines with the strict-aware exit. Concretely, after the format block produces its output, append at the end of `__invoke`:

```php
        $strict = ! empty( $assoc_args['strict'] );
        $code   = self::compute_exit_code( (array) ( $report['summary'] ?? [] ), $strict );
        if ( 0 !== $code ) {
            \WP_CLI::halt( $code );
        }
```

And add the pure mapper as a public static method on the class:

```php
/**
 * Map a summary count block + strict flag to an exit code. Pure — unit
 * tested without WP-CLI.
 *
 * @param array<string, int> $summary
 */
public static function compute_exit_code( array $summary, bool $strict ): int {
    if ( ( $summary['fail'] ?? 0 ) > 0 ) {
        return 1;
    }
    if ( $strict && ( $summary['warn'] ?? 0 ) > 0 ) {
        return 1;
    }
    return 0;
}
```

The `__invoke` method should now end with the strict / exit-code logic above. Read the final file to verify the structure flows: format dispatch → render → exit-code check.

- [ ] **Step 4: Run tests + lint**

```bash
cd packages/wp-plugin && composer test:unit && composer lint
```

Expected: `OK (209 tests, 471 assertions)` + lint clean.

- [ ] **Step 5: Commit**

```bash
git add packages/wp-plugin/includes/Cli/DoctorCommand.php packages/wp-plugin/tests/unit/Cli/ExitCodeMappingTest.php
git commit -m "$(cat <<'EOF'
feat(wp-plugin): wp jab doctor --strict + exit code mapping

Spec §6 exit-code rule: any fail exits 1; any warn with --strict exits 1;
otherwise 0. Extracted DoctorCommand::compute_exit_code( $summary, $strict )
as a pure static so the rule is unit-tested without invoking WP-CLI.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: `--debug-acf` flag

**Files:**
- Modify: `packages/wp-plugin/includes/Cli/DoctorCommand.php`

Implements the CLI-only ACF rebuild dance (spec §6):
1. Add filter `jab/headless_kit/acf_diagnostics` → true (closure scope, applied only for this invocation)
2. `Acf\Schema::flush_cache()` (bumps the generation salt added in Task 3)
3. Iterate `Registry::discovered_post_types()['included']` and call `Acf\Schema::for_post_type( $cpt )` on each (forces the rebuild with diagnostics tracking on)
4. Emit a stderr notice indicating the side effect happened

No unit test for the flag itself — the components it composes (`flush_cache`, `discovered_post_types`, `for_post_type`) are each independently tested. Behavior validation is the spec's "manual smoke against the pilot" item.

- [ ] **Step 1: Add `--debug-acf` to the `## OPTIONS` block**

After `[--strict]`, append:

```php
     *
     * [--debug-acf]
     * : Force-rebuild the ACF schema with the diagnostics ledger temporarily
     *   enabled, so the report's `acf` fact includes skipped-group and
     *   dropped-field entries even on a WP_DEBUG=false install. Side effect:
     *   bumps the jab_acf_schema_generation option, invalidating all cached
     *   ACF schemas (they regenerate lazily on next access).
```

- [ ] **Step 2: Add the rebuild path before `Report::generate()`**

In `__invoke()`, immediately before the `$report = Report::generate();` line, insert:

```php
        if ( ! empty( $assoc_args['debug-acf'] ) ) {
            self::rebuild_acf_with_diagnostics();
            \WP_CLI::warning( '--debug-acf rebuilt ACF schema with diagnostics enabled.' );
        }
```

Then add the helper method:

```php
/**
 * --debug-acf implementation. Temporarily flips the ACF diagnostics
 * filter on, flushes the ACF schema cache, and forces a per-CPT rebuild
 * so the diagnostics ledger is populated before Report::generate() reads it.
 */
private static function rebuild_acf_with_diagnostics(): void {
    if ( ! class_exists( \Jab\WpHeadlessKit\Acf\Schema::class )
        || ! class_exists( \Jab\WpHeadlessKit\Registry::class ) ) {
        return;
    }
    add_filter( 'jab/headless_kit/acf_diagnostics', '__return_true' );

    \Jab\WpHeadlessKit\Acf\Schema::flush_cache();

    $included = \Jab\WpHeadlessKit\Registry::discovered_post_types()['included'];
    foreach ( $included as $cpt ) {
        \Jab\WpHeadlessKit\Acf\Schema::for_post_type( (string) $cpt );
    }
}
```

- [ ] **Step 3: Lint + full unit suite**

```bash
cd packages/wp-plugin && composer lint && composer test:unit
```

Expected: lint clean, `OK (209 tests, 471 assertions)` (no new tests).

- [ ] **Step 4: Commit**

```bash
git add packages/wp-plugin/includes/Cli/DoctorCommand.php
git commit -m "$(cat <<'EOF'
feat(wp-plugin): wp jab doctor --debug-acf flag

Forces an ACF schema rebuild with diagnostics tracking on so the
report's acf fact carries skipped-group / dropped-field entries even
on WP_DEBUG=false installs. Composes flush_cache() + discovered_post_
types() + for_post_type() — components individually unit-tested.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Conditional WP-CLI registration in the main plugin file

**Files:**
- Modify: `packages/wp-plugin/wp-headless-kit.php`

Wire `Cli\DoctorCommand::register()` so the command exists when WP-CLI is active and is a no-op otherwise. This is the single line that flips Phase 5's CLI surface on.

- [ ] **Step 1: Add the conditional registration**

Open `packages/wp-plugin/wp-headless-kit.php`. After the existing `add_action( 'rest_api_init', … )` registrations (added in Task 7), append:

```php
if ( defined( 'WP_CLI' ) && constant( 'WP_CLI' ) ) {
    \Jab\WpHeadlessKit\Cli\DoctorCommand::register();
}
```

Note: `constant( 'WP_CLI' )` rather than the bare `WP_CLI` constant lookup so the conditional is robust to constant-defined-as-false edge cases and to lint rules that prefer one form. Read the existing file to confirm one style is preferred and follow it; the substantive check is just `defined() && truthy`.

- [ ] **Step 2: Sanity check the file**

Run unit suite and lint:

```bash
cd packages/wp-plugin && composer test:unit && composer lint
```

Expected: still `OK (209 tests, 471 assertions)` and lint clean. The conditional adds no behavior unless WP_CLI is defined (which it isn't during PHPUnit runs).

- [ ] **Step 3: Commit**

```bash
git add packages/wp-plugin/wp-headless-kit.php
git commit -m "$(cat <<'EOF'
feat(wp-plugin): conditionally register Cli\\DoctorCommand under WP-CLI

Single-line bootstrap: when defined('WP_CLI') is true, register
`wp jab doctor`. No-op otherwise (PHPUnit, web requests, REST).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Integration tests

**Files:**
- Create: `packages/wp-plugin/tests/integration/Diagnostics/ReportSmokeTest.php`
- Create: `packages/wp-plugin/tests/integration/Rest/DiagnosticsAuthTest.php`
- Create: `packages/wp-plugin/tests/integration/Rest/DiagnosticsCapabilityFilterTest.php`

Three integration test files exercising the real WP runtime via the Phase 1 harness. ReportSmokeTest asserts the full envelope flows; the two Rest tests assert the auth gate and the filter contract.

- [ ] **Step 1: Create `Diagnostics/ReportSmokeTest.php`**

```php
<?php
/**
 * ReportSmokeTest — exercises Diagnostics\Report::generate() end-to-end.
 *
 * Asserts the full report envelope, the catalog of facts and checks, and
 * that the harness fixture state produces six passes. ACF-active branch
 * coverage is deferred to Phase 1.1.
 *
 * @package Jab\WpHeadlessKit\Tests\Integration\Diagnostics
 */

declare( strict_types=1 );

final class ReportSmokeTest extends IntegrationTestCase {

    public function test_generate_returns_documented_envelope_keys(): void {
        $report = \Jab\WpHeadlessKit\Diagnostics\Report::generate();

        $this->assertArrayHasKey( 'plugin_version', $report, 'plugin_version envelope key missing.' );
        $this->assertArrayHasKey( 'generated_at',   $report, 'generated_at envelope key missing.' );
        $this->assertArrayHasKey( 'summary',        $report, 'summary envelope key missing.' );
        $this->assertArrayHasKey( 'facts',          $report, 'facts array missing.' );
        $this->assertArrayHasKey( 'checks',         $report, 'checks array missing.' );
    }

    public function test_all_six_check_ids_are_present_in_catalog_order(): void {
        $report = \Jab\WpHeadlessKit\Diagnostics\Report::generate();
        $ids    = array_column( $report['checks'], 'id' );

        $this->assertSame(
            [
                'abilities_api',
                'mcp_adapter',
                'rest_routes_registered',
                'post_types_discovered',
                'application_passwords_enabled',
                'acf_no_schema_skips',
            ],
            $ids,
            'Check ids must appear in the spec §5 catalog order.'
        );
    }

    public function test_eight_facts_are_present_in_catalog_order(): void {
        $report = \Jab\WpHeadlessKit\Diagnostics\Report::generate();
        $ids    = array_column( $report['facts'], 'id' );

        $this->assertSame(
            [
                'plugin_version',
                'wp_version',
                'php_version',
                'registered_abilities',
                'post_types',
                'taxonomies',
                'capability_filters',
                'acf',
            ],
            $ids,
            'Fact ids must appear in the spec §4 catalog order.'
        );
    }

    public function test_capability_filters_resolved_to_documented_defaults(): void {
        $report = \Jab\WpHeadlessKit\Diagnostics\Report::generate();
        $facts  = array_values( array_filter( $report['facts'], static fn ( array $f ) => 'capability_filters' === $f['id'] ) );
        $caps   = $facts[0]['value'];

        $this->assertSame( 'read',            $caps['jab/headless_kit/manifest_capability'] );
        $this->assertSame( 'edit_posts',      $caps['jab/headless_kit/site_manifest_capability'] );
        $this->assertSame( 'manage_options',  $caps['jab/headless_kit/diagnostics_capability'] );
    }

    public function test_harness_state_produces_summary_with_zero_fails(): void {
        $report = \Jab\WpHeadlessKit\Diagnostics\Report::generate();
        $this->assertSame( 0, $report['summary']['fail'], 'Harness state should fail no checks; spec §5 catalog assumes everything healthy.' );
    }

    public function test_rest_routes_registered_check_passes_with_all_five_routes(): void {
        $report = \Jab\WpHeadlessKit\Diagnostics\Report::generate();
        $check  = array_values( array_filter( $report['checks'], static fn ( array $c ) => 'rest_routes_registered' === $c['id'] ) )[0];

        $this->assertSame( 'pass', $check['severity'] );
        $this->assertSame(
            [ '/jab/v1/', '/jab/v1/content-types', '/jab/v1/diagnostics', '/jab/v1/manifest', '/jab/v1/site' ],
            $check['detail']
        );
    }
}
```

- [ ] **Step 2: Create `Rest/DiagnosticsAuthTest.php`**

```php
<?php
/**
 * DiagnosticsAuthTest — exercises the /jab/v1/diagnostics auth matrix:
 * anonymous → 401, subscriber → 403, admin → 200 with envelope.
 *
 * @package Jab\WpHeadlessKit\Tests\Integration\Rest
 */

declare( strict_types=1 );

final class DiagnosticsAuthTest extends IntegrationTestCase {

    public function test_anonymous_request_returns_401(): void {
        wp_set_current_user( 0 );
        $response = $this->dispatch_rest( '/jab/v1/diagnostics' );

        $this->assertSame( 401, $response->get_status() );
    }

    public function test_subscriber_returns_403(): void {
        $this->as_subscriber();
        $response = $this->dispatch_rest( '/jab/v1/diagnostics' );

        $this->assertSame( 403, $response->get_status() );
    }

    public function test_administrator_returns_200_with_envelope(): void {
        $this->as_admin();
        $response = $this->dispatch_rest( '/jab/v1/diagnostics' );

        $this->assertSame( 200, $response->get_status() );

        $data = (array) $response->get_data();
        $this->assertArrayHasKey( 'plugin_version', $data );
        $this->assertArrayHasKey( 'summary',        $data );
        $this->assertArrayHasKey( 'facts',          $data );
        $this->assertArrayHasKey( 'checks',         $data );
        $this->assertCount( 6, $data['checks'] );
    }
}
```

- [ ] **Step 3: Create `Rest/DiagnosticsCapabilityFilterTest.php`**

```php
<?php
/**
 * DiagnosticsCapabilityFilterTest — exercises
 * `jab/headless_kit/diagnostics_capability` filter contract:
 *   1. Filter to a lower cap → that role passes.
 *   2. Filter returning empty string → do_not_allow fallback + notice.
 *
 * @package Jab\WpHeadlessKit\Tests\Integration\Rest
 */

declare( strict_types=1 );

final class DiagnosticsCapabilityFilterTest extends IntegrationTestCase {

    public function test_lowered_capability_filter_lets_a_subscriber_pass(): void {
        add_filter( 'jab/headless_kit/diagnostics_capability', static fn ( $cap ): string => 'read' );

        $this->as_subscriber();
        $response = $this->dispatch_rest( '/jab/v1/diagnostics' );

        $this->assertSame( 200, $response->get_status() );
        $this->assertArrayHasKey( 'summary', (array) $response->get_data() );
    }

    public function test_empty_string_filter_falls_back_to_do_not_allow(): void {
        $this->setExpectedIncorrectUsage( 'Jab\\WpHeadlessKit\\Rest\\Diagnostics::capability' );
        add_filter( 'jab/headless_kit/diagnostics_capability', static fn ( $cap ): string => '' );

        $this->as_admin();
        $response = $this->dispatch_rest( '/jab/v1/diagnostics' );

        $this->assertSame( 403, $response->get_status() );
    }
}
```

- [ ] **Step 4: Run the integration suite**

```bash
cd packages/wp-plugin && composer test:integration
```

Expected: `OK (17 tests, ~53 assertions)` — the existing 8 Phase 1 tests + 11 new tests. If any test fails:
- ReportSmokeTest failures usually mean a check resolver returns the wrong severity for the harness state — read the actual report via a temporary `print_r` debug and reconcile against the spec §5 catalog.
- Auth test failures: confirm `Rest\Diagnostics::register` is wired in `wp-headless-kit.php` (Task 7) and that the harness's `setExpectedIncorrectUsage` plumbing works (it was exercised in Phase 1).

- [ ] **Step 5: Commit**

```bash
git add packages/wp-plugin/tests/integration/Diagnostics/ packages/wp-plugin/tests/integration/Rest/DiagnosticsAuthTest.php packages/wp-plugin/tests/integration/Rest/DiagnosticsCapabilityFilterTest.php
git commit -m "$(cat <<'EOF'
test(wp-plugin): integration coverage for Phase 5 diagnostics

Three integration test files via the Phase 1 wp-env harness:
- ReportSmokeTest asserts envelope, catalog order, default cap values,
  and that the harness fixture produces zero fails.
- DiagnosticsAuthTest covers anonymous→401, subscriber→403, admin→200.
- DiagnosticsCapabilityFilterTest covers the lowered-cap branch and
  the do_not_allow / setExpectedIncorrectUsage fallback.

ACF-active branch is deferred to Phase 1.1.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Docs + VERSION bump + final verification

**Files:**
- Modify: `packages/wp-plugin/wp-headless-kit.php` (VERSION constant 0.7.0 → 0.7.1)
- Modify: `packages/wp-plugin/README.md` (new v0.7.1 changelog entry)
- Modify: `packages/wp-plugin/tests/README.md` (list new check IDs)

The release-prep task. After this commit, the plugin is shippable as v0.7.1.

- [ ] **Step 1: Bump VERSION constant**

Open `packages/wp-plugin/wp-headless-kit.php`. Locate the `VERSION` constant declaration (near the top of the file, defining `Jab\WpHeadlessKit\VERSION`). Change `'0.7.0'` to `'0.7.1'`. Also update the plugin header comment's `Version:` line and `Stable tag:` if present from `0.7.0` to `0.7.1`.

- [ ] **Step 2: Add v0.7.1 changelog entry to README.md**

Open `packages/wp-plugin/README.md`. Locate the `## Changelog` (or equivalent) section's most recent entry (`## v0.7.0`). Above it, insert:

```markdown
## v0.7.1 — Connector Diagnostics (2026-06-02)

**New surfaces:**

- `wp jab doctor` WP-CLI command. Three formats (`table`, `json`, `yaml`),
  three flags (`--strict`, `--debug-acf`, `--format`). Reports plugin /
  WP / PHP versions, JAB ability roster, post-type and taxonomy universe
  (after exclusions), every resolved `jab/headless_kit/*_capability`
  value, ACF state including the per-CPT skipped-group ledger, plus six
  health checks (Abilities API, MCP Adapter, REST routes, post type
  discovery, Application Passwords availability, ACF schema-skip
  ledger). Exits 1 on any `fail`; `--strict` also exits 1 on any `warn`.
- `GET /wp-json/jab/v1/diagnostics` REST endpoint. Returns the same
  report shape. Default capability `manage_options`, filterable via
  `jab/headless_kit/diagnostics_capability` with the same `do_not_allow`
  fallback for non-string / empty returns that the existing
  `manifest_capability` and `site_manifest_capability` filters use.

**Underlying changes:**

- `Jab\WpHeadlessKit\Registry::discovered_post_types()` and
  `discovered_taxonomies()` are now public — single source of truth for
  the diagnostics facts and the existing private registration callers.
- `Jab\WpHeadlessKit\Acf\Schema::flush_cache()` is now public. Bumps a
  new `jab_acf_schema_generation` option that mixes into the per-CPT
  ACF schema transient key as an invalidation salt. The `--debug-acf`
  CLI flow uses it.

**Type-only breaking changes:** none.

**Deferred to v0.7.x:** the `acf_no_schema_skips` check's populated-ledger
branch is unit-tested but not integration-tested — integration coverage
arrives with the ACF wp-env slot in Phase 1.1.
```

(Match the existing changelog style if the README uses a different heading depth.)

- [ ] **Step 3: Update tests/README.md**

Open `packages/wp-plugin/tests/README.md`. In the "What the integration suite does and doesn't cover" section's **Covered** list, add a line:

```markdown
- Diagnostics report envelope, catalog ordering, default capability
  resolution, auth matrix (anonymous → 401, subscriber → 403, admin →
  200), and the `jab/headless_kit/diagnostics_capability` filter
  contract including the `do_not_allow` fallback. Six check IDs covered:
  `abilities_api`, `mcp_adapter`, `rest_routes_registered`,
  `post_types_discovered`, `application_passwords_enabled`,
  `acf_no_schema_skips` (tracking-off branch only — populated-ledger
  branch is a Phase 1.1 ACF-slot follow-up).
```

- [ ] **Step 4: Final verification**

```bash
cd packages/wp-plugin && composer lint && composer test:unit && composer test:integration
```

Expected:
- `composer lint`: `20/20 (100%)`.
- `composer test:unit`: `OK (209 tests, 471 assertions)`.
- `composer test:integration`: `OK (17 tests, ~53 assertions)`.

- [ ] **Step 5: Commit**

```bash
git add packages/wp-plugin/wp-headless-kit.php packages/wp-plugin/README.md packages/wp-plugin/tests/README.md
git commit -m "$(cat <<'EOF'
chore(wp-plugin): v0.7.1 — Connector Diagnostics release prep

VERSION 0.7.0 → 0.7.1. README v0.7.1 changelog entry. tests/README
documents the new diagnostics integration coverage and the Phase 1.1
ACF deferral.

Lint clean, 209 unit / 17 integration green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Done

After Task 14 commits, the branch is shippable. Next step is the `superpowers:finishing-a-development-branch` skill — choose merge into master or open a PR.

**Spec sections covered by this plan:**
- §1 (Problem), §2 (Goals/non-goals): documented context; no implementation.
- §3 (Architecture): Tasks 1–6 (public helpers, value objects, Report split).
- §4 (Report shape + stability + ordering): Tasks 4, 5 (from_environment + ordering tests).
- §5 (Check catalog): Task 5 (each of the six checks implemented + unit-tested).
- §6 (CLI surface): Tasks 8–12 (TextRenderer, DoctorCommand, flags).
- §7 (REST surface): Task 7.
- §8 (Testing strategy): Tasks 1–13 across unit / integration; Task 13 integration cluster; ACF populated-ledger deferral honoured.
- §9 (Definition of done): Task 14 (final verification) + each task's `composer lint && composer test:unit` gate.
- §10 (Out of scope): respected throughout — no `wp jab repair`, no mcp-adapter quirk check, no environment detection.

**Cumulative test counts after each implementation task:**

| Task | Unit | Integration |
|---|---|---|
| Baseline (PF-2) | 173 | 8 |
| Task 1 (discovered_post_types) | 175 | 8 |
| Task 2 (discovered_taxonomies) | 177 | 8 |
| Task 3 (flush_cache) | 180 | 8 |
| Task 4 (Fact + Check) | 187 | 8 |
| Task 5 (Report::from_environment) | 198 | 8 |
| Task 6 (collect_environment + generate) | 198 | 8 |
| Task 7 (Rest\Diagnostics) | 202 | 8 |
| Task 8 (TextRenderer) | 203 | 8 |
| Task 9 (DoctorCommand skeleton) | 203 | 8 |
| Task 10 (--strict) | 209 | 8 |
| Task 11 (--debug-acf) | 209 | 8 |
| Task 12 (CLI wiring) | 209 | 8 |
| Task 13 (integration tests) | 209 | 17 |
| Task 14 (release prep) | 209 | 17 |

If a task's actual count differs by more than ±1, something quietly regressed — investigate before moving on.
