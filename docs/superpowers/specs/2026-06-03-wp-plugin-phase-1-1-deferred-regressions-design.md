# WP Plugin Phase 1.1 — Deferred Regression Tests + ACF wp-env Slot Design

> Date: 2026-06-03
> Scope: `packages/wp-plugin`
> Driver: [2026-06-01 connector hardening plan](../../../2026-06-01-jab-wp-plugin-connector-hardening-plan.md), Phase 1.2 follow-up
> Predecessors: [Phase 1 spec](./2026-06-01-wp-plugin-phase-1-integration-harness-design.md), [Phase 5 spec](./2026-06-02-wp-plugin-phase-5-connector-diagnostics-design.md)
> Status: brainstormed, approved, ready for implementation plan

## Context

Phase 1 landed the WordPress integration test harness (2026-06-01) with three test files: `HarnessSmokeTest`, `Sec1SubscriberDraftTest`, `RegistryRestBaseSlugCollisionTest`. Two design decisions were explicit Phase 1 deferrals:

- **Seven historical schema-correctness fixes** (FIX-1 through FIX-5 plus two more from `packages/wp-plugin/tests/README.md` lines 102–119) ship in source but have **no integration test asserting they remain fixed**. Reverting any one of them today would not surface a test failure. The Phase 1 spec called this out as a Phase 1.1 PR: "each is a small, mechanical conversion against the harness this PR lands. Smaller diffs ship faster and let the harness design iterate before piling on test code."
- **ACF wp-env slot was not landed** in Phase 1. The plugin's two ACF-touching regressions (empty `url`/`email`/`date_picker` values, Flex Content discriminator) and the Phase 5 `acf_no_schema_skips` populated-ledger integration branch all blocked on having ACF available in the `tests-cli` container.

Phase 5 (Connector Diagnostics, 2026-06-02, v0.7.1) shipped six health checks but explicitly deferred the `acf_no_schema_skips` populated-ledger branch with the note: "integration coverage arrives with the ACF wp-env slot in Phase 1.1." Today's post-merge fix to `Diagnostics\Report::collect_environment()` (commit `a163d56`) reinforces the same lesson Phase 1.1 is built around: smokes can't catch what they don't exercise, and the team's instinct to keep harness coverage growing per phase is correct.

This phase is a pure test-harness expansion against existing source. **No plugin source changes. No version bump.** The deliverable is integration coverage that locks in fixes already shipped.

## Goals

- **Land the ACF free-version wp-env slot** in `.wp-env.json` so ACF-touching tests are runnable in the tests-cli container.
- **Convert all seven deferred regression-fix entries** from `tests/README.md` into real integration tests, one file per regression following the `IntegrationTestCase` patterns established in Phase 1.
- **Fill the Phase 5 deferred populated-ledger branch** of the `acf_no_schema_skips` diagnostic check with an integration test that drives both the `skipped_groups` and `dropped_fields` ledger sides.
- **Update `packages/wp-plugin/tests/README.md`** to move the seven regressions from "deferred to Phase 1.1" into the Phase 1 covered list, and to note the ACF slot now exists.

## Non-goals

- **No plugin source changes.** Every test must catch a regression IF its existing source-side fix were reverted; the existing source-side fix stays as-is.
- **No version bump.** The team's pattern is to bump version when plugin behavior changes; tests-only PRs update the changelog footnote at most. v0.7.1 stays at v0.7.1.
- **No ACF PRO.** The free version covers the field types in the regression set (`url`, `email`, `date_picker`, `flexible_content`, `password`, `text`).
- **No new abilities, no schema changes, no REST routes.** Phase 4 (ACF Options Pages) is a separate spec; this phase intentionally lands only what the regression set needs.
- **No CI workflow changes.** The integration job already runs against the wp-env container; adding a plugin to `.wp-env.json:plugins` is picked up automatically.
- **No new `IntegrationTestCase` helpers.** Existing `execute_ability()`, `dispatch_rest()`, `as_subscriber()`, `as_admin()` cover every test in this phase.

## Architecture

Three additive moves, each independently reviewable:

1. **`.wp-env.json` adds ACF** (one entry to the `plugins` array — `"advanced-custom-fields"`, the WordPress.org slug). wp-env downloads from WP.org on container install, caches between runs. Rationale captured below in [§Risks](#risks).
2. **`jab-test-fixtures.php` mu-plugin adds four ACF field groups** under one `function_exists('acf_add_local_field_group')` guard. Existing non-ACF tests boot unchanged when ACF is absent.
3. **Eight new integration test files** added under existing subdirectories (`tests/integration/Abilities/`, `tests/integration/Acf/`, `tests/integration/Diagnostics/`). Each extends `IntegrationTestCase` and follows seed → exercise → assert.

Test files use existing patterns end-to-end: no new bootstrap, no new helpers, no new harness state. The cost of Phase 1.1 is fixture mass and assertion code — exactly the right tax for a "lock in what's already shipped" PR.

## Components

### 1. `.wp-env.json` change

Before (current):

```json
{
  "plugins": [
    "./packages/wp-plugin"
  ]
}
```

After:

```json
{
  "plugins": [
    "./packages/wp-plugin",
    "advanced-custom-fields"
  ]
}
```

No other keys change. `phpVersion`, `mappings`, and `config` are untouched.

### 2. `jab-test-fixtures.php` ACF additions

Four ACF field groups, all registered inside one `add_action('init', ..., 5)` block gated by `function_exists('acf_add_local_field_group')`. The function-exists guard means the harness still boots without ACF — non-ACF tests are unaffected. The `init` priority 5 hook is the existing `book` CPT registration point; ACF's plugin loader runs at `plugins_loaded`, so `acf_add_local_field_group` is reliably available by `init`.

**Group A — `group_jab_test_empty_values`** (bound to `book`): three fields (`url`, `email`, `date_picker`) carrying the field types whose empty-value validation FIX-2 (v0.6.1) addressed. Minimal field set so the empty-value test's assertions stay focused.

**Group B — `group_jab_test_flex`** (bound to `book`): one `flexible_content` field with **two layouts** (`layout_a`, `layout_b`) each carrying a single text sub-field. The two-layout shape is the precondition for catching the pre-fix `const` discriminator bug — a single-layout flex field would pass both pre- and post-fix because `const === enum[0]` when there's only one value.

**Group C — `group_jab_test_unsupported_location`** (location rule `user_form == all`): the Schema generator only matches `post_type == X` and "page-implying" rules, so this group lands in the `skipped_groups` ledger. Field list is one inert `text` field — never read.

**Group D — `group_jab_test_password`** (bound to `book`): one `password` field. The Schema generator drops password fields with the documented SEC-3 reason, so this lands in the `dropped_fields` ledger. Separated from Group A so the empty-value test doesn't deal with a field that's intentionally absent from output.

Group keying uses the `group_jab_test_*` namespace so test-side assertions can match by key without colliding with anything a real ACF user might have. Field keys follow the same convention.

### 3. Eight new test files

#### Non-ACF tests (under `tests/integration/Abilities/`)

**`MenuLabelOnlyParentTest`** — Nav menu with label-only parent item produces a valid `jab/get-menus` response.

- Fixture: `wp_create_nav_menu( 'jab-test-menu' )` + `register_nav_menu( 'jab_test_location' )` (called via a one-shot `add_action('init')` inside the test, since this needs to happen at runtime, not boot). Add one custom-type item with empty URL and label "Parent" (the label-only parent), then one child link with `menu-item-parent-id` referencing the parent.
- Exercise: `execute_ability( 'jab/get-menus', [ 'location' => 'jab_test_location' ] )`.
- Assert: result is not WP_Error (the regression is that schema validation failed on the label-only parent), output tree contains the parent with safe/empty url and the child nested under it.

**`DraftZeroDatePostTest`** — Draft with `post_date_gmt = '0000-00-00 00:00:00'` doesn't emit an invalid `date-time` field.

- Fixture: Factory-create a draft post. WP's factory rejects malformed dates, so the test issues a raw `$wpdb->update( $wpdb->posts, [ 'post_date_gmt' => '0000-00-00 00:00:00' ], [ 'ID' => $id ] )` and clears the post cache via `clean_post_cache( $id )`. Switch to an Editor user (drafts must be visible).
- Exercise: `execute_ability( 'jab/get-posts', [ 'post_status' => 'draft' ] )`.
- Assert: result is not WP_Error (the regression is that strict `format: date-time` validation rejected `'0000-00-00T00:00:00Z'`), draft is present in `posts[]`.

**`ObjectTermsGroupingTest`** — `wp_get_object_terms()` `fields=all_with_object_id` grouping returns terms under the correct post IDs.

- Fixture: Two published posts. Assign tag `red` to post A only; tag `blue` to post B only.
- Exercise: `execute_ability( 'jab/get-posts' )`.
- Assert: Row for A has `tags: ['red']` and not `'blue'`; row for B has `tags: ['blue']` and not `'red'`. Pre-fix the same set of terms appeared under every row.

**`PostsWithZeroTermsTest`** — Posts with zero terms still include required taxonomy arrays.

- Fixture: Factory-create a post; call `wp_set_post_terms( $id, [], 'category' )` to strip the default "Uncategorized" assignment; do not assign any tag.
- Exercise: `execute_ability( 'jab/get-posts' )`.
- Assert: Row contains `categories` and `tags` keys, both with empty-array values (not absent — the output schema marks these required arrays).

**`BlocksIncludeRegisteredTest`** — FIX-5 (v0.6.3): `include.blocks=true` succeeds for posts containing registered blocks.

- Fixture: Factory-create a post with `post_content` set to a registered core block: `'<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->'`. Use a deterministic slug so by-slug lookup is stable.
- Exercise: `execute_ability( 'jab/get-post-by-slug', [ 'slug' => $slug, 'include' => [ 'blocks' => true ] ] )`.
- Assert: result is not WP_Error (this is the assertion that catches the pre-fix `oneOf`/`not`-ignore "matches more than one of the expected formats" failure), `blocks[0].blockName === 'core/paragraph'`.

#### ACF regression tests (under `tests/integration/Acf/`)

Both files start with `if ( ! class_exists( 'ACF' ) ) { $this->markTestSkipped( 'ACF not loaded' ); }` in setUp. In CI the wp-env slot guarantees ACF is present, so this is purely a legibility move for developer laptops without the slot installed.

**`AcfEmptyValueOutputTest`** — FIX-2 (v0.6.1): empty `url` / `email` / `date_picker` values don't fail output schema validation.

- Fixture: Group A is pre-registered via the mu-plugin. Create a `book` post. `update_field( 'jab_test_url', '', $id )`; same for `jab_test_email` and `jab_test_date`.
- Exercise: `execute_ability( 'jab/get-book-by-slug', [ 'slug' => $slug ] )`.
- Assert: result is not WP_Error (pre-fix schema's `format: uri|email|date` rejected empty strings); `acf.jab_test_url === ''`, `acf.jab_test_email === ''`, `acf.jab_test_date === ''`.

**`AcfFlexContentDiscriminatorTest`** — Flex Content `acf_fc_layout` validates as `enum`, not `const`.

- Fixture: Group B is pre-registered. Create a `book` post. `update_field( 'jab_test_flex', [ [ 'acf_fc_layout' => 'layout_a', 'a_text' => 'A' ], [ 'acf_fc_layout' => 'layout_b', 'b_text' => 'B' ] ], $id )`.
- Exercise: `execute_ability( 'jab/get-book-by-slug', [ 'slug' => $slug ] )`.
- Assert: result is not WP_Error (pre-fix a `const: 'layout_a'` discriminator rejected the second-layout row); `acf.jab_test_flex[0].acf_fc_layout === 'layout_a'`; `acf.jab_test_flex[1].acf_fc_layout === 'layout_b'`. The two-layout fixture is load-bearing: a single-layout fixture would not catch the const-vs-enum bug.

#### Diagnostics test (under `tests/integration/Diagnostics/`)

**`AcfDiagnosticsLedgerTest`** — `acf_no_schema_skips` warn branch fires with both ledger sides populated. Fills the Phase 5 deferred populated-ledger integration coverage.

- Fixture: Groups C and D are pre-registered via the mu-plugin. The `book` CPT is the existing fixture.
- setUp side effects (in this order):
  1. `parent::setUp();`
  2. `global $wp_rest_server; $wp_rest_server = null;` (matches the [Phase 5 post-merge fix](../../../packages/wp-plugin/tests/integration/Diagnostics/ReportSmokeTest.php) pattern so `Diagnostics\Report::collect_environment()` cold-starts REST itself).
  3. `add_filter( 'jab/headless_kit/acf_diagnostics', '__return_true' );` — enables the diagnostics ledger.
  4. `\Jab\WpHeadlessKit\Acf\Schema::flush_cache();` — bumps the generation salt so the next `for_post_type()` call doesn't hit a stale empty-ledger transient.
  5. `\Jab\WpHeadlessKit\Acf\Schema::for_post_type( 'book' );` — drives a fresh per-CPT schema generation, which is what walks the ACF groups and populates the in-memory ledger.
- Exercise: `\Jab\WpHeadlessKit\Diagnostics\Report::generate()`.
- Assertions:
  - `summary.warn >= 1`.
  - The `acf_no_schema_skips` check exists, `severity === 'warn'`, `message` contains the count.
  - `detail` (a `string[]` of flat formatted lines per the Phase 5 fix) contains one entry beginning with `'group group_jab_test_unsupported_location'` (skipped_groups side) and one entry beginning with `'field jab_test_password'` (dropped_fields side).

### 4. `tests/README.md` updates

Two changes:

- Move the seven regressions from the **"Regression tests deferred to Phase 1.1"** list into the **"Covered (Phase 1)"** list.
- Add a one-line note: "ACF free is installed in the tests-cli container as of Phase 1.1; ACF-touching tests live under `tests/integration/Acf/`."
- Update the `acf_no_schema_skips` line under "Covered (Phase 1)" to drop the "tracking-off branch only" qualifier, since Phase 1.1 covers both branches.

## Cross-cutting concerns

### Test isolation and DB state

- WP_UnitTestCase wraps each test in a transaction that rolls back, so `wp_posts`, `wp_options`, `wp_term_relationships`, and ACF transient rows self-clear between tests.
- ACF field groups registered via `acf_add_local_field_group()` are process-level, not DB-level. The mu-plugin registers them once at boot and they persist across the entire suite — no per-test re-registration needed.
- `Acf\Schema`'s in-memory `$diagnostics` array IS process-level. The `AcfDiagnosticsLedgerTest` is the only test that drives a schema build with the diagnostics filter on, so cross-test contamination is structurally not possible — other tests don't enable the filter, don't call `flush_cache()`, and aren't asserting on ledger state.

### Test ordering

No test depends on test execution order. Each test seeds its own posts/users; each ACF test sets its own `update_field` values on a fresh `book` post created in setUp. The diagnostics test nulls `$wp_rest_server` in setUp to force the cold-start REST path — same pattern today's `a163d56` fix established and `ReportSmokeTest` follows.

### ACF presence gate

Tests under `tests/integration/Acf/` and the diagnostics ledger test call `markTestSkipped` if `class_exists('ACF')` is false. CI never hits the skip path — the wp-env slot guarantees ACF is loaded. The skip is for the developer who runs the suite locally without yet having spun up the slot, so the failure mode is "9 tests skipped" rather than "9 tests fatal-erroring with `Class 'ACF' not found`."

### CI matrix

No workflow file changes. `.github/workflows/ci-plugin.yml` runs integration tests on PHP 7.4 and 8.3; wp-env reads `.wp-env.json:plugins` on container install and downloads ACF for both cells. ACF free supports PHP 7.0+ (we're at 7.4 floor), so both matrix cells are valid.

## Risks

- **WP.org availability.** The first wp-env install in a given CI cell downloads ACF from WP.org. Outage during fresh install would fail the integration job until the next run. Mitigation: this risk is asymmetric — once installed, wp-env caches the ACF directory in the container layer, so subsequent runs are immune. The wp-env-managed-plugins approach is the standard idiom and is acceptable for our cadence. Escape valve: switching to a pinned GitHub tarball URL is a one-line change in `.wp-env.json`.
- **ACF version drift.** wp-env pulls the latest ACF release. A future ACF release that changes the `acf_add_local_field_group()` API or the field-key schema could surface here first. Mitigation: ACF has had a stable schema for years; if drift bites, we pin a version (one-line change).
- **The `book` CPT inherits more ACF groups.** Groups A, B, and D all bind to `book`. The `book` CPT is now ACF-rich. Tests that previously asserted "the `book` CPT's output has zero ACF fields" would fail. **No existing test makes that assertion** — verified during context exploration. New tests that rely on the `book` CPT and want zero ACF noise can use a fresh CPT, but the regression set in this phase doesn't need that.
- **Flex Content fixture brittleness.** ACF's flex content `update_field` shape (`acf_fc_layout` + sub-field names) is undocumented in places. If ACF changes how it accepts flex values via `update_field`, the test would need a fixture adjustment. The two-layout shape with text sub-fields is the simplest possible setup and has been stable across ACF 5.x and 6.x.
- **`$wpdb->update` for the zero-date fixture is a tight coupling to WP's posts schema.** If WP ever changes the `post_date_gmt` column type to disallow `'0000-00-00 00:00:00'` at the schema level, the fixture would need a different approach. Real-world WP installs still contain such rows (drafts and scheduled posts), so the schema accepts them today and likely will indefinitely.

## Out of scope (deferred)

- **WP-version matrix** (Phase 1.x deferral, carried forward). Only the latest WP. WP 6.9 floor coverage stays a Phase 1.x follow-up.
- **Application Password HTTP transport smoke** (Phase 1.x deferral, carried forward). `wp_set_current_user()` short-circuits the auth layer in `IntegrationTestCase`; only post-auth capability gates are exercised.
- **mcp-adapter default MCP server.** Phase 1 bootstrap filter `mcp_adapter_create_default_server` to false stays in place. A Phase 1.x MCP-surface test will deal with the load-ordering issue separately.
- **Phase 4 — ACF Options Pages.** The ACF wp-env slot Phase 1.1 lands is the precondition; the Options Pages feature is its own spec.

## Acceptance

- `composer lint` exits 0.
- `composer test:unit` is unchanged (no new unit tests; production source untouched).
- `composer test:integration` runs **28** tests (current 20 + 5 non-ACF regression tests + 2 ACF regression tests + 1 diagnostics ledger test).
- Every new test passes against current source.
- Reverting any of the seven deferred-regression source-side fixes causes at least one new integration test to fail with a legible error. The seven fixes, restated for the implementer's reference:
  - FIX-2 (v0.6.1) — removing `format: uri|email|date` from `url`/`email`/`date_picker` schemas → caught by `AcfEmptyValueOutputTest`.
  - FIX-5 (v0.6.3) — `anyOf` instead of `oneOf` at the block-items top-level discriminated union → caught by `BlocksIncludeRegisteredTest`.
  - Flex Content discriminator emitted as `enum` instead of `const` → caught by `AcfFlexContentDiscriminatorTest`.
  - `wp_get_object_terms()` `fields=all_with_object_id` grouping → caught by `ObjectTermsGroupingTest`.
  - Required taxonomy arrays present on posts with zero terms → caught by `PostsWithZeroTermsTest`.
  - Zero-date tolerance on `post_date_gmt = '0000-00-00 00:00:00'` rows → caught by `DraftZeroDatePostTest`.
  - Label-only nav menu parent items survive `jab/get-menus` schema validation → caught by `MenuLabelOnlyParentTest`.
- The Phase 5 deferred `acf_no_schema_skips` populated-ledger branch is integration-covered.
- `packages/wp-plugin/tests/README.md` reflects the new coverage.

## Verification

Pre-merge:

```bash
cd packages/wp-plugin
composer lint
composer test:unit
composer test:integration
```

Expected: lint 26/26, unit 210/210, integration 28/28 (20 prior + 5 non-ACF + 2 ACF + 1 diagnostics ledger).

Spot-check that one test would catch its target regression (pick one — e.g., `BlocksIncludeRegisteredTest`):

```bash
# Temporarily revert v0.6.3's anyOf-vs-oneOf fix locally,
# re-run BlocksIncludeRegisteredTest, confirm it fails with
# "matches more than one of the expected formats". Then `git checkout` to undo.
```

This verification step is documented in the spec but does NOT run in CI — it's a one-time gut-check the implementer does for each test as the plan executes, to confirm the test would have actually caught the bug.
