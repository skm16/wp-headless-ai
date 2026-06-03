# wp-plugin Phase 1.1 — Deferred Regression Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the seven historical regression-fix entries in `packages/wp-plugin/tests/README.md` lines 102–119 into eight new integration tests (5 non-ACF + 2 ACF + 1 diagnostics ledger), and land the ACF free-version slot in `.wp-env.json` plus four ACF field groups in the fixtures mu-plugin to make the ACF-dependent tests runnable.

**Architecture:** Pure test-harness expansion. Zero production source changes, no version bump. `.wp-env.json` gets `"advanced-custom-fields"` appended to its `plugins` array; `jab-test-fixtures.php` gets four `acf_add_local_field_group()` calls under one `function_exists` guard; eight new test files extend the existing `IntegrationTestCase` patterns (seed → `execute_ability()` or `Report::generate()` → assert).

**Tech Stack:** PHP 7.4+ on the host runner, PHP 7.4 / 8.3 inside the container via the existing `WP_ENV_PHP_VERSION` matrix. PHPUnit 9.6, WordPress latest, wp-env. ACF free (Advanced Custom Fields by Delicious Brains) pulled from WordPress.org on `wp-env start`. Spec at [`docs/superpowers/specs/2026-06-03-wp-plugin-phase-1-1-deferred-regressions-design.md`](../specs/2026-06-03-wp-plugin-phase-1-1-deferred-regressions-design.md).

**TDD inversion** — important for the implementer: this is a "lock in existing fixes" PR, so the conventional red-then-green ordering inverts. Each test task is:

1. Write the test against the existing (already-fixed) source.
2. Run it — **expected: PASS** against current source.
3. **Spot-check that the test would have failed pre-fix** by temporarily editing the source-side fix to its pre-fix shape, re-running, confirming the test fails with the documented bug signature, then `git checkout`ing the source change. This is the "would-have-caught" verification. Do it for at least the first test in each task family (FIX-2 in Task 2, FIX-5 in Task 8); for the others, follow the per-task "would-have-caught recipe" inline.
4. Re-run to confirm PASS after the source revert is undone.
5. Commit.

The spot-check is a one-time gut-check; it is **not** part of the committed test artifact. Do not commit a temporarily-broken source file.

---

## Pre-flight (do this BEFORE Task 1)

- [ ] **PF-1: Set up an isolated worktree**

   Per project convention, isolated feature work goes in a worktree. Verify via `git rev-parse --git-dir`: a path NOT equal to `git rev-parse --git-common-dir` means we're already isolated. If not isolated, use `superpowers:using-git-worktrees` skill to create one. The Phase 5 work used `.claude/worktrees/wp-plugin-phase-5-connector-diagnostics/`; Phase 1.1 should use a sibling like `.claude/worktrees/wp-plugin-phase-1-1-deferred-regressions/`.

- [ ] **PF-2: Verify Docker is available**

   Run: `docker --version && docker ps`

   Expected: a Docker version string, and `docker ps` exits 0. If `docker ps` fails with a permission error, start Docker Desktop (Windows/macOS) or `sudo systemctl start docker` (Linux). wp-env will NOT work without Docker.

- [ ] **PF-3: Confirm starting baseline**

   Run from the worktree root:

   ```bash
   cd packages/wp-plugin
   composer install --quiet
   composer lint
   composer test:unit
   ```

   Expected:
   - `composer lint` → `26 / 26 (100%)`
   - `composer test:unit` → `OK (210 tests, 477 assertions)`

   Then start wp-env and run the integration baseline (this is the slow step — first start can take 3–5 minutes):

   ```bash
   pnpm -w exec wp-env start
   composer test:integration
   ```

   Expected: `OK (20 tests, 54 assertions)`.

   If the integration count is anything other than 20, master has changed since this plan was written; re-baseline before continuing.

---

## File Structure

**Modified (workspace root):**
- `.wp-env.json` — append `"advanced-custom-fields"` to `plugins` array.

**Modified (plugin):**
- `packages/wp-plugin/tests/integration/fixtures/jab-test-fixtures.php` — append one ACF-guarded `add_action('init')` block registering four field groups (A: empty values, B: flex content, C: unsupported location, D: password).
- `packages/wp-plugin/tests/README.md` — move the seven deferred regressions into the Phase 1 covered list; add a one-line note about the ACF slot; drop the "tracking-off branch only" qualifier on `acf_no_schema_skips`.

**Created (under `packages/wp-plugin/tests/integration/`):**
- `Abilities/MenuLabelOnlyParentTest.php` — label-only nav menu parent doesn't fail `jab/get-menus` output validation.
- `Abilities/DraftZeroDatePostTest.php` — draft with `post_date_gmt = '0000-00-00 00:00:00'` doesn't emit an invalid `date-time` field.
- `Abilities/ObjectTermsGroupingTest.php` — `wp_get_object_terms()` grouping returns terms under the correct post IDs.
- `Abilities/PostsWithZeroTermsTest.php` — posts with zero terms still include required taxonomy arrays.
- `Abilities/BlocksIncludeRegisteredTest.php` — FIX-5 (v0.6.3): `include.blocks=true` succeeds for posts containing registered blocks.
- `Acf/AcfEmptyValueOutputTest.php` — FIX-2 (v0.6.1): empty `url`/`email`/`date_picker` values don't fail output validation.
- `Acf/AcfFlexContentDiscriminatorTest.php` — Flex Content `acf_fc_layout` validates as `enum`, not `const`.
- `Diagnostics/AcfDiagnosticsLedgerTest.php` — Phase 5 deferred populated-ledger branch of `acf_no_schema_skips`.

**Untouched (deliberate):**
- All `packages/wp-plugin/includes/` source — this PR adds no behavior change.
- All `packages/wp-plugin/tests/unit/` — pure unit suite remains as-is.
- `.github/workflows/ci-plugin.yml` — wp-env reads `.wp-env.json:plugins` on container install; no workflow changes needed.

---

## Task 1: ACF wp-env slot + fixture mu-plugin field groups

**Files:**
- Modify: `.wp-env.json`
- Modify: `packages/wp-plugin/tests/integration/fixtures/jab-test-fixtures.php`

Goal: install ACF into the tests-cli container and register the four field groups used by Tasks 2, 3, and 9. After this task, `class_exists('ACF')` is true inside the container and `acf_add_local_field_group()` is callable.

- [ ] **Step 1: Append the ACF slot to `.wp-env.json`**

  Edit the file at the workspace root:

  ```json
  {
    "core": null,
    "phpVersion": "8.3",
    "plugins": [
      "./packages/wp-plugin",
      "advanced-custom-fields"
    ],
    "mappings": {
      "wp-content/mu-plugins/jab-test-fixtures.php": "./packages/wp-plugin/tests/integration/fixtures/jab-test-fixtures.php"
    },
    "config": {
      "WP_DEBUG": true,
      "WP_DEBUG_LOG": true,
      "WP_DEBUG_DISPLAY": false
    }
  }
  ```

  The only diff is the second entry in `plugins`. `"advanced-custom-fields"` is the WordPress.org slug; wp-env downloads from `downloads.wordpress.org/plugin/advanced-custom-fields.latest-stable.zip`.

- [ ] **Step 2: Reload the wp-env container with the new plugin**

  From the worktree root:

  ```bash
  pnpm -w exec wp-env start --update
  ```

  Expected: wp-env logs "Installing plugin advanced-custom-fields" and finishes with "WordPress development site started". This downloads ACF on first run; subsequent `--update` runs are fast.

  Verify ACF activated:

  ```bash
  pnpm -w exec wp-env run tests-cli wp plugin list --status=active --format=csv
  ```

  Expected output includes a line for `advanced-custom-fields`.

- [ ] **Step 3: Append the four ACF field groups to the fixtures mu-plugin**

  Open `packages/wp-plugin/tests/integration/fixtures/jab-test-fixtures.php`. After the existing closing `}, 5 );` of the `book` CPT block, append:

  ```php

  /**
   * ACF field groups for Phase 1.1 regression tests.
   *
   * Gated by function_exists() so the non-ACF integration tests still boot
   * when ACF is absent (e.g. a developer running the suite without yet
   * pulling the ACF wp-env slot). ACF's plugin loader runs at plugins_loaded;
   * by init @ priority 5 (matching the book CPT registration) the function
   * is reliably available when present.
   *
   * Group keying: `group_jab_test_*` namespace so test-side assertions can
   * match deterministically without colliding with anything a real ACF user
   * might register.
   */
  add_action( 'init', static function (): void {
      if ( ! function_exists( 'acf_add_local_field_group' ) ) {
          return;
      }

      // Group A: regression target for AcfEmptyValueOutputTest (FIX-2 v0.6.1).
      // Bound to `book` CPT. Carries url/email/date_picker fields whose empty
      // values used to fail output-schema validation when the schema emitted
      // format=uri/email/date. v0.6.1 dropped format from these types; this
      // group's empty values are how the regression test locks that in.
      acf_add_local_field_group( [
          'key'      => 'group_jab_test_empty_values',
          'title'    => 'Jab Test — Empty Values',
          'location' => [ [ [ 'param' => 'post_type', 'operator' => '==', 'value' => 'book' ] ] ],
          'fields'   => [
              [ 'key' => 'field_jab_test_url',   'name' => 'jab_test_url',   'label' => 'URL',   'type' => 'url' ],
              [ 'key' => 'field_jab_test_email', 'name' => 'jab_test_email', 'label' => 'Email', 'type' => 'email' ],
              [
                  'key'            => 'field_jab_test_date',
                  'name'           => 'jab_test_date',
                  'label'          => 'Date',
                  'type'           => 'date_picker',
                  'return_format'  => 'Y-m-d',
                  'display_format' => 'Y-m-d',
              ],
          ],
      ] );

      // Group B: regression target for AcfFlexContentDiscriminatorTest.
      // Two layouts so the discriminator enum has >1 value — the
      // const-vs-enum bug only surfaces when there is a second layout
      // that the first-only const cannot accept.
      acf_add_local_field_group( [
          'key'      => 'group_jab_test_flex',
          'title'    => 'Jab Test — Flex Content',
          'location' => [ [ [ 'param' => 'post_type', 'operator' => '==', 'value' => 'book' ] ] ],
          'fields'   => [
              [
                  'key'     => 'field_jab_test_flex',
                  'name'    => 'jab_test_flex',
                  'label'   => 'Flex',
                  'type'    => 'flexible_content',
                  'layouts' => [
                      'layout_a' => [
                          'key'        => 'layout_jab_a',
                          'name'       => 'layout_a',
                          'label'      => 'A',
                          'sub_fields' => [ [ 'key' => 'field_jab_a_text', 'name' => 'a_text', 'label' => 'A text', 'type' => 'text' ] ],
                      ],
                      'layout_b' => [
                          'key'        => 'layout_jab_b',
                          'name'       => 'layout_b',
                          'label'      => 'B',
                          'sub_fields' => [ [ 'key' => 'field_jab_b_text', 'name' => 'b_text', 'label' => 'B text', 'type' => 'text' ] ],
                      ],
                  ],
              ],
          ],
      ] );

      // Group C: regression target for AcfDiagnosticsLedgerTest (group skip).
      // Unsupported location rule (user_form == all) — the Schema generator
      // only matches post_type==X and page-implying rules, so this group
      // lands in the skipped_groups ledger with the documented reason.
      acf_add_local_field_group( [
          'key'      => 'group_jab_test_unsupported_location',
          'title'    => 'Jab Test — Unsupported Location',
          'location' => [ [ [ 'param' => 'user_form', 'operator' => '==', 'value' => 'all' ] ] ],
          'fields'   => [
              [ 'key' => 'field_jab_test_unused', 'name' => 'jab_test_unused', 'label' => 'Unused', 'type' => 'text' ],
          ],
      ] );

      // Group D: regression target for AcfDiagnosticsLedgerTest (field drop).
      // Bound to `book`; carries a password field which the schema generator
      // drops with the documented SEC-3 reason. Separated from Group A so
      // empty-value tests don't see a field that's intentionally absent.
      acf_add_local_field_group( [
          'key'      => 'group_jab_test_password',
          'title'    => 'Jab Test — Password Field',
          'location' => [ [ [ 'param' => 'post_type', 'operator' => '==', 'value' => 'book' ] ] ],
          'fields'   => [
              [ 'key' => 'field_jab_test_password', 'name' => 'jab_test_password', 'label' => 'Password', 'type' => 'password' ],
          ],
      ] );
  }, 5 );
  ```

- [ ] **Step 4: Verify the existing integration suite still passes with ACF in the container**

  ```bash
  cd packages/wp-plugin
  composer test:integration
  ```

  Expected: `OK (20 tests, 54 assertions)`.

  This proves the ACF slot didn't break any pre-Phase-1.1 test. If anything fails, the most likely culprit is `Diagnostics/ReportSmokeTest::test_harness_state_produces_summary_with_zero_fails`, which now sees an ACF-active facts row. The Phase 5 design intentionally accommodates this — the `acf` fact carries active=true detail with an empty ledger because the new field groups aren't materialized until something calls `Schema::for_post_type()`. If that test fails, read the inline comment and adjust the fact assertion before continuing.

  Also run lint:

  ```bash
  composer lint
  ```

  Expected: `26 / 26 (100%)`.

- [ ] **Step 5: Commit**

  ```bash
  git add ../../.wp-env.json tests/integration/fixtures/jab-test-fixtures.php
  git commit -m "test(wp-plugin): add ACF wp-env slot + Phase 1.1 ACF fixture groups

  Append \"advanced-custom-fields\" to .wp-env.json:plugins so the tests-cli
  container has ACF free available. Register four ACF field groups in the
  fixtures mu-plugin under a function_exists guard — Groups A and B target
  the FIX-2 (v0.6.1) and Flex Content discriminator regressions; Groups C
  and D drive the Phase 5 deferred acf_no_schema_skips populated-ledger
  branch (group skip via unsupported location rule; field drop via SEC-3
  password type).

  No production source changes. Integration baseline holds at 20 tests."
  ```

---

## Task 2: AcfEmptyValueOutputTest (FIX-2 v0.6.1)

**Files:**
- Create: `packages/wp-plugin/tests/integration/Acf/AcfEmptyValueOutputTest.php`

Regression target: FIX-2 (v0.6.1) — removing `format: uri|email|date` from `url`/`email`/`date_picker` ACF field schemas. Pre-fix, an empty string on any of these three field types triggered strict-format output-validation failure on the entire `jab/get-book-by-slug` call.

- [ ] **Step 1: Create the test file with the regression assertion**

  Create `packages/wp-plugin/tests/integration/Acf/AcfEmptyValueOutputTest.php`:

  ```php
  <?php
  /**
   * AcfEmptyValueOutputTest — FIX-2 (v0.6.1) regression coverage.
   *
   * FIX-2 dropped `format: uri|email|date` from ACF url/email/date_picker
   * field schemas because real-world content frequently includes empty
   * values that fail strict format validation. Pre-fix an empty ACF
   * url field hard-failed the entire jab/get-{cpt}-by-slug response
   * with "Value must be a valid URI" or similar.
   *
   * Fixture: Group A (registered in jab-test-fixtures.php) binds three
   * fields (jab_test_url, jab_test_email, jab_test_date) to the `book`
   * CPT. The test creates a book post, sets each field to empty string
   * via update_field(), and asserts the ability returns the post with
   * empty values present (not a WP_Error and not field omission).
   *
   * @package Jab\WpHeadlessKit\Tests\Integration\Acf
   */

  declare( strict_types=1 );

  final class AcfEmptyValueOutputTest extends IntegrationTestCase {

      protected function setUp(): void {
          parent::setUp();
          if ( ! class_exists( 'ACF' ) ) {
              $this->markTestSkipped( 'ACF not loaded — run `pnpm -w exec wp-env start --update` to install the slot.' );
          }
      }

      public function test_empty_url_email_date_acf_values_do_not_fail_output_validation(): void {
          $post_id = (int) $this->factory()->post->create( [
              'post_type'   => 'book',
              'post_status' => 'publish',
              'post_title'  => 'Empty values book',
              'post_name'   => 'empty-values-book',
          ] );

          // Empty values across the three regression-target field types.
          update_field( 'jab_test_url',   '', $post_id );
          update_field( 'jab_test_email', '', $post_id );
          update_field( 'jab_test_date',  '', $post_id );

          $result = (array) $this->execute_ability(
              'jab/get-book-by-slug',
              [ 'slug' => 'empty-values-book' ]
          );

          $this->assertNotNull( $result['book'] ?? null, 'by-slug ability returned null book — slug mismatch?' );
          $book = (array) $result['book'];

          $this->assertArrayHasKey( 'acf', $book, 'book row missing acf payload — fixture group not bound to `book`?' );
          $acf = (array) $book['acf'];

          $this->assertArrayHasKey( 'jab_test_url',   $acf );
          $this->assertArrayHasKey( 'jab_test_email', $acf );
          $this->assertArrayHasKey( 'jab_test_date',  $acf );

          // Pre-FIX-2 each of these would either WP_Error the whole call
          // (format validation) or be coerced; today they're preserved as
          // empty strings.
          $this->assertSame( '', (string) $acf['jab_test_url'] );
          $this->assertSame( '', (string) $acf['jab_test_email'] );
          $this->assertSame( '', (string) $acf['jab_test_date'] );
      }
  }
  ```

- [ ] **Step 2: Run the test — expect PASS against current source**

  ```bash
  cd packages/wp-plugin
  composer test:integration -- --filter AcfEmptyValueOutputTest
  ```

  Expected: `OK (1 test, 8 assertions)`.

- [ ] **Step 3: Would-have-caught spot-check (revert FIX-2 locally, re-run, expect FAIL)**

  This is the proof the test would have caught the original bug. Open `packages/wp-plugin/includes/Acf/Schema.php` and find the schema emission for the `url` field type (search for `'type' => 'url'` or `case 'url':` in the field-type switch). Add `'format' => 'uri',` to the emitted schema. Then in the test container, flush the ACF schema transient cache so the modified emitter actually runs:

  ```bash
  pnpm -w exec wp-env run tests-cli --env-cwd=wp-content/plugins/wp-plugin wp jab doctor --debug-acf
  ```

  Then re-run:

  ```bash
  composer test:integration -- --filter AcfEmptyValueOutputTest
  ```

  Expected: FAIL with a WP_Error message including `"format"` or `"valid URI"`.

  **Now restore the source:** `git checkout includes/Acf/Schema.php`. Re-run the test, expect PASS.

  If `git checkout` doesn't revert (e.g., you edited multiple files), use `git diff includes/Acf/Schema.php` to confirm the file is clean before continuing.

- [ ] **Step 4: Commit**

  ```bash
  git add tests/integration/Acf/AcfEmptyValueOutputTest.php
  git commit -m "test(wp-plugin): AcfEmptyValueOutputTest — FIX-2 v0.6.1 regression

  Empty values on url/email/date_picker ACF fields no longer fail output
  schema validation. The fixture's Group A binds three fields to the book
  CPT; the test creates a post with each field set to empty string and
  asserts the by-slug ability returns the post with all three empty
  values preserved. Pre-FIX-2 the format=uri/email/date keywords on these
  schemas hard-failed validation on the entire response.

  Would-have-caught spot-check confirmed locally."
  ```

---

## Task 3: AcfFlexContentDiscriminatorTest

**Files:**
- Create: `packages/wp-plugin/tests/integration/Acf/AcfFlexContentDiscriminatorTest.php`

Regression target: ACF Flex Content `acf_fc_layout` discriminator must emit as `enum: [layout_a, layout_b, ...]` not `const: layout_a`. Pre-fix a const-valued discriminator only accepted the first layout name; rows using `layout_b` failed validation.

- [ ] **Step 1: Create the test file**

  Create `packages/wp-plugin/tests/integration/Acf/AcfFlexContentDiscriminatorTest.php`:

  ```php
  <?php
  /**
   * AcfFlexContentDiscriminatorTest — Flex Content discriminator regression.
   *
   * ACF Flex Content fields are emitted as a oneOf<layout_a, layout_b, ...>
   * union, with each variant's `acf_fc_layout` property identifying which
   * layout it is. Pre-fix the discriminator was `const: <first_layout>`,
   * which meant only the first layout's rows validated; any row using a
   * second layout WP_Error'd the entire response. Today the discriminator
   * is an enum over every registered layout name.
   *
   * The two-layout fixture (Group B) is load-bearing: a single-layout
   * fixture would pass both pre- and post-fix because const === enum[0]
   * when there is only one value.
   *
   * @package Jab\WpHeadlessKit\Tests\Integration\Acf
   */

  declare( strict_types=1 );

  final class AcfFlexContentDiscriminatorTest extends IntegrationTestCase {

      protected function setUp(): void {
          parent::setUp();
          if ( ! class_exists( 'ACF' ) ) {
              $this->markTestSkipped( 'ACF not loaded — run `pnpm -w exec wp-env start --update` to install the slot.' );
          }
      }

      public function test_flex_content_discriminator_accepts_multiple_layout_names(): void {
          $post_id = (int) $this->factory()->post->create( [
              'post_type'   => 'book',
              'post_status' => 'publish',
              'post_title'  => 'Flex content book',
              'post_name'   => 'flex-content-book',
          ] );

          // One row of each layout. The second-layout row is what catches
          // the pre-fix const discriminator bug.
          update_field( 'jab_test_flex', [
              [ 'acf_fc_layout' => 'layout_a', 'a_text' => 'A' ],
              [ 'acf_fc_layout' => 'layout_b', 'b_text' => 'B' ],
          ], $post_id );

          $result = (array) $this->execute_ability(
              'jab/get-book-by-slug',
              [ 'slug' => 'flex-content-book' ]
          );

          $this->assertNotNull( $result['book'] ?? null );
          $book = (array) $result['book'];
          $this->assertArrayHasKey( 'acf', $book );

          $flex = (array) ( $book['acf']['jab_test_flex'] ?? [] );
          $this->assertCount(
              2,
              $flex,
              'Flex field should carry both layout rows; pre-fix the second was dropped by validation.'
          );
          $this->assertSame( 'layout_a', (string) ( $flex[0]['acf_fc_layout'] ?? '' ) );
          $this->assertSame( 'layout_b', (string) ( $flex[1]['acf_fc_layout'] ?? '' ) );
      }
  }
  ```

- [ ] **Step 2: Run the test — expect PASS**

  ```bash
  cd packages/wp-plugin
  composer test:integration -- --filter AcfFlexContentDiscriminatorTest
  ```

  Expected: `OK (1 test, 5 assertions)`.

- [ ] **Step 3: Would-have-caught recipe**

  In `Acf/Schema.php`, find the flex_content schema emission (search for `acf_fc_layout`). Change the discriminator from `enum` to `const` with only the first layout's name. Flush schema cache via `wp jab doctor --debug-acf`, re-run, expect FAIL. Then `git checkout` to restore.

- [ ] **Step 4: Commit**

  ```bash
  git add tests/integration/Acf/AcfFlexContentDiscriminatorTest.php
  git commit -m "test(wp-plugin): AcfFlexContentDiscriminatorTest — flex layout enum

  ACF Flex Content acf_fc_layout discriminator emits as enum over every
  registered layout name, not as a const fixed to the first. The fixture's
  Group B carries two layouts (layout_a, layout_b); the test seeds a book
  post with one row of each and asserts both layout-named rows survive
  output validation. Pre-fix the second-layout row hard-failed the call."
  ```

---

## Task 4: MenuLabelOnlyParentTest

**Files:**
- Create: `packages/wp-plugin/tests/integration/Abilities/MenuLabelOnlyParentTest.php`

Regression target: `MenusAbility` output schema's `url` field on menu items must not carry `format: uri`. Label-only parent items (dropdown wrappers in WP menu UI) carry empty `url`, which pre-fix failed format validation and broke the entire `jab/get-menus` response. The fix is documented in [`MenusAbility.php`](../../../packages/wp-plugin/includes/Abilities/MenusAbility.php#L152-L161).

- [ ] **Step 1: Create the test file**

  Create `packages/wp-plugin/tests/integration/Abilities/MenuLabelOnlyParentTest.php`:

  ```php
  <?php
  /**
   * MenuLabelOnlyParentTest — nav menu label-only parent regression.
   *
   * A "label-only parent" is the WP menu pattern for a top-level dropdown
   * wrapper that has no URL of its own — only sub-items are clickable.
   * The menu UI lets users add these via the "Custom Links" panel with
   * the URL field left blank. Pre-fix MenusAbility's output schema marked
   * url with format=uri, which rejected the empty string and hard-failed
   * the entire jab/get-menus response. The fix dropped format=uri and
   * documented the empty-url contract.
   *
   * @package Jab\WpHeadlessKit\Tests\Integration\Abilities
   */

  declare( strict_types=1 );

  final class MenuLabelOnlyParentTest extends IntegrationTestCase {

      public function test_label_only_parent_menu_item_does_not_fail_output_validation(): void {
          // Register a test location and create a menu attached to it.
          register_nav_menu( 'jab_test_location', 'Jab Test Location' );
          $menu_id = (int) wp_create_nav_menu( 'jab-test-menu' );
          set_theme_mod( 'nav_menu_locations', [ 'jab_test_location' => $menu_id ] );

          // The label-only parent: object='custom', empty URL, non-empty title.
          $parent_item_id = (int) wp_update_nav_menu_item( $menu_id, 0, [
              'menu-item-title'   => 'Parent (label only)',
              'menu-item-url'     => '',
              'menu-item-status'  => 'publish',
              'menu-item-type'    => 'custom',
              'menu-item-object'  => 'custom',
          ] );

          // A child link beneath the label-only parent.
          (int) wp_update_nav_menu_item( $menu_id, 0, [
              'menu-item-title'     => 'Child link',
              'menu-item-url'       => 'https://example.test/child',
              'menu-item-status'    => 'publish',
              'menu-item-type'      => 'custom',
              'menu-item-object'    => 'custom',
              'menu-item-parent-id' => $parent_item_id,
          ] );

          $result = (array) $this->execute_ability( 'jab/get-menus' );

          $this->assertArrayHasKey( 'menus', $result );
          $menus = (array) $result['menus'];
          $this->assertNotEmpty( $menus, 'Test menu was not returned.' );

          // Find our menu in the response (other menus may exist).
          $jab_menu = null;
          foreach ( $menus as $menu ) {
              if ( 'jab-test-menu' === ( $menu['slug'] ?? '' ) ) {
                  $jab_menu = (array) $menu;
                  break;
              }
          }
          $this->assertNotNull( $jab_menu, 'jab-test-menu missing from response.' );

          $items = (array) ( $jab_menu['items'] ?? [] );
          $this->assertCount( 2, $items, 'Both parent and child should be present.' );

          // Find the parent (empty url + matching title).
          $parent = null;
          $child  = null;
          foreach ( $items as $item ) {
              if ( 'Parent (label only)' === ( $item['title'] ?? '' ) ) {
                  $parent = (array) $item;
              } elseif ( 'Child link' === ( $item['title'] ?? '' ) ) {
                  $child = (array) $item;
              }
          }
          $this->assertNotNull( $parent, 'Label-only parent missing from response.' );
          $this->assertNotNull( $child, 'Child link missing from response.' );

          // The regression assertion: parent.url is empty (not omitted, not coerced).
          $this->assertSame( '', (string) $parent['url'], 'Label-only parent.url must be the empty string.' );
          $this->assertSame( (int) $parent['id'], (int) $child['parent_id'], 'Child.parent_id must point at the label-only parent.' );
      }
  }
  ```

- [ ] **Step 2: Run the test — expect PASS**

  ```bash
  cd packages/wp-plugin
  composer test:integration -- --filter MenuLabelOnlyParentTest
  ```

  Expected: `OK (1 test, 8 assertions)`.

- [ ] **Step 3: Would-have-caught recipe**

  In `includes/Abilities/MenusAbility.php` line 152, change the url property from a plain `type => string` to `[ 'type' => 'string', 'format' => 'uri' ]`. Re-run the test, expect FAIL with the WP_Error message about invalid URI. `git checkout` to restore.

- [ ] **Step 4: Commit**

  ```bash
  git add tests/integration/Abilities/MenuLabelOnlyParentTest.php
  git commit -m "test(wp-plugin): MenuLabelOnlyParentTest — empty-url parent item

  Nav menu items with empty url (the label-only parent dropdown-wrapper
  pattern) no longer fail jab/get-menus output validation. The test
  registers a menu at a test theme location, adds a label-only parent
  plus a child link, executes the ability, and asserts the parent's url
  is the empty string (not coerced, not absent) and the child's
  parent_id correctly references the label-only parent."
  ```

---

## Task 5: DraftZeroDatePostTest

**Files:**
- Create: `packages/wp-plugin/tests/integration/Abilities/DraftZeroDatePostTest.php`

Regression target: Drafts (and some scheduled posts) carry `post_date_gmt = '0000-00-00 00:00:00'`. Pre-fix the date emission ran the string through `mysql_to_rfc3339()` which yielded `0000-00-00T00:00:00`, failing strict `date-time` validation. The fix in [`PostTypeListAbility::resolve_date()`](../../../packages/wp-plugin/includes/Abilities/PostTypeListAbility.php#L496-L512) walks a candidate chain and falls back to the Unix epoch sentinel.

- [ ] **Step 1: Create the test file**

  Create `packages/wp-plugin/tests/integration/Abilities/DraftZeroDatePostTest.php`:

  ```php
  <?php
  /**
   * DraftZeroDatePostTest — zero-date post regression coverage.
   *
   * Real-world WP installs contain rows where post_date_gmt is exactly
   * '0000-00-00 00:00:00' (drafts written before scheduling logic ran,
   * old import artifacts, etc.). Pre-fix mysql_to_rfc3339() on the
   * zero string yielded "0000-00-00T00:00:00", which failed strict
   * date-time validation on the entire jab/get-posts response.
   *
   * The fix in PostTypeListAbility::resolve_date() walks a candidate
   * chain (post_date_gmt → post_date → post_modified_gmt → post_modified)
   * and falls back to the Unix epoch ("1970-01-01T00:00:00+00:00") as a
   * schema-valid sentinel.
   *
   * @package Jab\WpHeadlessKit\Tests\Integration\Abilities
   */

  declare( strict_types=1 );

  final class DraftZeroDatePostTest extends IntegrationTestCase {

      public function test_draft_with_zero_post_date_gmt_does_not_fail_output_validation(): void {
          global $wpdb;

          // Factory rejects malformed dates at the API layer, so we create
          // a normal draft first and then update the row directly.
          $author_id = (int) $this->factory()->user->create( [ 'role' => 'editor' ] );
          $post_id   = (int) $this->factory()->post->create( [
              'post_status' => 'draft',
              'post_author' => $author_id,
              'post_title'  => 'Zero-date draft',
          ] );

          $wpdb->update(
              $wpdb->posts,
              [
                  'post_date'         => '0000-00-00 00:00:00',
                  'post_date_gmt'     => '0000-00-00 00:00:00',
                  'post_modified'     => '0000-00-00 00:00:00',
                  'post_modified_gmt' => '0000-00-00 00:00:00',
              ],
              [ 'ID' => $post_id ]
          );
          clean_post_cache( $post_id );

          // Editor sees drafts; SEC-1 keeps Subscribers out of this path.
          wp_set_current_user( $author_id );

          $result = (array) $this->execute_ability(
              'jab/get-posts',
              [ 'post_status' => 'draft' ]
          );

          $this->assertArrayHasKey( 'posts', $result );
          $posts = (array) $result['posts'];

          // Find the zero-date draft.
          $zero_draft = null;
          foreach ( $posts as $row ) {
              if ( (int) ( $row['id'] ?? 0 ) === $post_id ) {
                  $zero_draft = (array) $row;
                  break;
              }
          }
          $this->assertNotNull( $zero_draft, 'Zero-date draft missing from response.' );

          // The regression assertion: date is a non-zero string. The exact
          // fallback today is the Unix epoch sentinel.
          $this->assertIsString( $zero_draft['date'] );
          $this->assertNotSame( '', $zero_draft['date'] );
          $this->assertStringStartsNotWith( '0000', $zero_draft['date'], 'date must not emit a zero-prefixed string.' );
      }
  }
  ```

- [ ] **Step 2: Run the test — expect PASS**

  ```bash
  composer test:integration -- --filter DraftZeroDatePostTest
  ```

  Expected: `OK (1 test, 5 assertions)`.

- [ ] **Step 3: Would-have-caught recipe**

  In `PostTypeListAbility::resolve_date()` (around line 496), replace the function body with `return mysql_to_rfc3339( (string) $post->post_date_gmt );` (the pre-fix shape — no candidate chain, no zero-prefix guard). Re-run, expect FAIL with WP_Error about invalid date-time. `git checkout` to restore.

- [ ] **Step 4: Commit**

  ```bash
  git add tests/integration/Abilities/DraftZeroDatePostTest.php
  git commit -m "test(wp-plugin): DraftZeroDatePostTest — zero-date row tolerance

  Posts with post_date_gmt = '0000-00-00 00:00:00' (drafts, legacy
  import artifacts) no longer fail jab/get-posts output validation.
  The test direct-writes a zero-date row via \$wpdb->update (factory
  rejects malformed dates at the API layer), executes the ability as
  an Editor (SEC-1 keeps Subscribers out), and asserts the emitted
  date field is a non-zero-prefixed string. The fix's epoch fallback
  is schema-valid AND sentinel-shaped for downstream UI detection."
  ```

---

## Task 6: ObjectTermsGroupingTest

**Files:**
- Create: `packages/wp-plugin/tests/integration/Abilities/ObjectTermsGroupingTest.php`

Regression target: `PostTypeListAbility::batch_terms()` must call `wp_get_object_terms()` with `fields => all_with_object_id`. The default `all` mode dedups term rows across the input post set and leaves `WP_Term->object_id` unset — every term ends up grouped under post 0 downstream, and every post emits empty taxonomy arrays. The fix is documented in [`PostTypeListAbility::batch_terms()`](../../../packages/wp-plugin/includes/Abilities/PostTypeListAbility.php#L443-L463).

- [ ] **Step 1: Create the test file**

  Create `packages/wp-plugin/tests/integration/Abilities/ObjectTermsGroupingTest.php`:

  ```php
  <?php
  /**
   * ObjectTermsGroupingTest — wp_get_object_terms() grouping regression.
   *
   * batch_terms() must pass fields=all_with_object_id so each returned
   * WP_Term carries its source post's ID. With the default fields=all
   * mode, WP dedupes term rows across the input post set and drops
   * object_id, which collapses every term under post 0 downstream and
   * leaves every post emitting empty taxonomy arrays. The fix is to
   * use all_with_object_id and group by WP_Term->object_id.
   *
   * Fixture: two posts. Post A gets tag `red` only; post B gets tag
   * `blue` only. Pre-fix both rows would have empty post_tag arrays
   * (term rows dedup'd, object_id missing, everything under post 0).
   *
   * @package Jab\WpHeadlessKit\Tests\Integration\Abilities
   */

  declare( strict_types=1 );

  final class ObjectTermsGroupingTest extends IntegrationTestCase {

      public function test_object_terms_grouping_returns_terms_under_correct_post_ids(): void {
          $post_a = (int) $this->factory()->post->create( [ 'post_status' => 'publish', 'post_title' => 'Post A' ] );
          $post_b = (int) $this->factory()->post->create( [ 'post_status' => 'publish', 'post_title' => 'Post B' ] );

          wp_set_post_terms( $post_a, [ 'red' ],  'post_tag' );
          wp_set_post_terms( $post_b, [ 'blue' ], 'post_tag' );

          $result = (array) $this->execute_ability( 'jab/get-posts' );
          $rows   = (array) ( $result['posts'] ?? [] );

          $row_by_id = [];
          foreach ( $rows as $row ) {
              $row_by_id[ (int) ( $row['id'] ?? 0 ) ] = (array) $row;
          }

          $this->assertArrayHasKey( $post_a, $row_by_id, 'Post A missing from response.' );
          $this->assertArrayHasKey( $post_b, $row_by_id, 'Post B missing from response.' );

          $tags_a = array_map(
              static fn( array $term ): string => (string) $term['slug'],
              (array) ( $row_by_id[ $post_a ]['post_tag'] ?? [] )
          );
          $tags_b = array_map(
              static fn( array $term ): string => (string) $term['slug'],
              (array) ( $row_by_id[ $post_b ]['post_tag'] ?? [] )
          );

          $this->assertSame( [ 'red' ],  $tags_a, 'Post A must carry only its own tag (red).' );
          $this->assertSame( [ 'blue' ], $tags_b, 'Post B must carry only its own tag (blue).' );
      }
  }
  ```

- [ ] **Step 2: Run the test — expect PASS**

  ```bash
  composer test:integration -- --filter ObjectTermsGroupingTest
  ```

  Expected: `OK (1 test, 4 assertions)`.

- [ ] **Step 3: Would-have-caught recipe**

  In `PostTypeListAbility::batch_terms()` line 449, change `'fields' => 'all_with_object_id'` to `'fields' => 'all'`. Re-run, expect FAIL — both posts emit empty `post_tag` arrays. `git checkout` to restore.

- [ ] **Step 4: Commit**

  ```bash
  git add tests/integration/Abilities/ObjectTermsGroupingTest.php
  git commit -m "test(wp-plugin): ObjectTermsGroupingTest — wp_get_object_terms grouping

  PostTypeListAbility::batch_terms calls wp_get_object_terms with
  fields=all_with_object_id so each returned term carries its source
  post's ID. The test seeds two posts each tagged with a different
  single tag (red, blue), executes jab/get-posts, and asserts each
  post's post_tag array contains only its own tag. Pre-fix the default
  fields=all mode dedup'd term rows and emitted empty taxonomy arrays
  on every post."
  ```

---

## Task 7: PostsWithZeroTermsTest

**Files:**
- Create: `packages/wp-plugin/tests/integration/Abilities/PostsWithZeroTermsTest.php`

Regression target: Posts with zero terms in a given taxonomy must still include that taxonomy array (empty) in the row. The schema marks each taxonomy key as required, so omitting it fails validation. The fix is in [`PostTypeListAbility::shape_row()`](../../../packages/wp-plugin/includes/Abilities/PostTypeListAbility.php#L372-L374) — every public taxonomy gets an empty default slot before any actual terms get layered in.

- [ ] **Step 1: Create the test file**

  Create `packages/wp-plugin/tests/integration/Abilities/PostsWithZeroTermsTest.php`:

  ```php
  <?php
  /**
   * PostsWithZeroTermsTest — required-taxonomy-array regression.
   *
   * Every public taxonomy registered to a post type is `required` in the
   * row schema. Posts with zero terms in a given taxonomy must still
   * include the (empty) array — pre-fix omission failed output validation.
   * The fix layers every public taxonomy as an empty array first, then
   * merges any actual terms over the empty defaults.
   *
   * @package Jab\WpHeadlessKit\Tests\Integration\Abilities
   */

  declare( strict_types=1 );

  final class PostsWithZeroTermsTest extends IntegrationTestCase {

      public function test_posts_with_zero_terms_still_include_required_taxonomy_arrays(): void {
          $post_id = (int) $this->factory()->post->create( [
              'post_status' => 'publish',
              'post_title'  => 'Untermed post',
          ] );

          // WP auto-applies the default category — strip it so this post
          // has zero terms across both registered post taxonomies.
          wp_set_post_terms( $post_id, [], 'category' );
          wp_set_post_terms( $post_id, [], 'post_tag' );

          $result = (array) $this->execute_ability( 'jab/get-posts' );
          $rows   = (array) ( $result['posts'] ?? [] );

          $row = null;
          foreach ( $rows as $candidate ) {
              if ( (int) ( $candidate['id'] ?? 0 ) === $post_id ) {
                  $row = (array) $candidate;
                  break;
              }
          }
          $this->assertNotNull( $row, 'Untermed post missing from response.' );

          $this->assertArrayHasKey( 'category', $row, 'category key absent — schema requires it even on zero-terms rows.' );
          $this->assertArrayHasKey( 'post_tag', $row, 'post_tag key absent — schema requires it even on zero-terms rows.' );
          $this->assertSame( [], $row['category'] );
          $this->assertSame( [], $row['post_tag'] );
      }
  }
  ```

- [ ] **Step 2: Run the test — expect PASS**

  ```bash
  composer test:integration -- --filter PostsWithZeroTermsTest
  ```

  Expected: `OK (1 test, 5 assertions)`.

- [ ] **Step 3: Would-have-caught recipe**

  In `PostTypeListAbility::shape_row()` lines 372–374, comment out the `foreach ( $taxonomies as $taxonomy )` empty-default loop. Re-run, expect FAIL — schema rejects rows missing the required `category` and `post_tag` keys. `git checkout` to restore.

- [ ] **Step 4: Commit**

  ```bash
  git add tests/integration/Abilities/PostsWithZeroTermsTest.php
  git commit -m "test(wp-plugin): PostsWithZeroTermsTest — required taxonomy arrays

  Posts with zero terms in a given taxonomy still emit the empty array
  rather than omitting the key, which the output schema requires. The
  test creates a post, strips the auto-applied default category, ensures
  no tags, executes jab/get-posts, and asserts both category and post_tag
  keys are present with empty-array values."
  ```

---

## Task 8: BlocksIncludeRegisteredTest (FIX-5 v0.6.3)

**Files:**
- Create: `packages/wp-plugin/tests/integration/Abilities/BlocksIncludeRegisteredTest.php`

Regression target: FIX-5 (v0.6.3) — `BlockSchema::block_items_one_of()` emits `anyOf` instead of `oneOf` at the top-level discriminated union over per-block-type variants. WP REST's `rest_validate_value_from_schema` silently ignores `not` inside `oneOf` alternatives, so the fallback variant's `not: { enum: known_names }` exclusion was a no-op — every known block matched both its typed variant and the fallback, and the response failed with "matches more than one of the expected formats." See [`packages/wp-plugin/README.md`](../../../packages/wp-plugin/README.md) for the full FIX-5 changelog entry.

- [ ] **Step 1: Create the test file**

  Create `packages/wp-plugin/tests/integration/Abilities/BlocksIncludeRegisteredTest.php`:

  ```php
  <?php
  /**
   * BlocksIncludeRegisteredTest — FIX-5 (v0.6.3) regression coverage.
   *
   * Posts containing registered Gutenberg blocks no longer fail
   * jab/get-post-by-slug with include.blocks=true. The pre-fix shape
   * used oneOf at the top-level discriminated union over per-block-type
   * variants, with a permissive fallback carrying not:{enum:known_names}.
   * WP REST's rest_validate_value_from_schema ignores `not` inside oneOf
   * alternatives, so every known block matched BOTH its typed variant
   * AND the fallback — rest_find_one_matching_schema rejected the
   * response with "matches more than one of the expected formats."
   *
   * The fix switched to anyOf, which tolerates multi-match. SDK typing
   * is unaffected (json-schema-to-typescript emits identical unions).
   *
   * @package Jab\WpHeadlessKit\Tests\Integration\Abilities
   */

  declare( strict_types=1 );

  final class BlocksIncludeRegisteredTest extends IntegrationTestCase {

      public function test_include_blocks_true_succeeds_for_post_with_registered_block(): void {
          $post_id = (int) $this->factory()->post->create( [
              'post_status'  => 'publish',
              'post_title'   => 'Blocks regression post',
              'post_name'    => 'blocks-regression-post',
              'post_content' => '<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->',
          ] );

          $result = (array) $this->execute_ability(
              'jab/get-post-by-slug',
              [
                  'slug'    => 'blocks-regression-post',
                  'include' => [ 'blocks' => true ],
              ]
          );

          $this->assertNotNull( $result['post'] ?? null, 'by-slug ability returned null — slug mismatch?' );
          $post = (array) $result['post'];

          $this->assertArrayHasKey( 'blocks', $post, 'include.blocks=true should populate the blocks key.' );
          $blocks = (array) $post['blocks'];
          $this->assertNotEmpty( $blocks, 'Parsed blocks should be present for a post with paragraph content.' );
          $this->assertSame( 'core/paragraph', (string) ( $blocks[0]['blockName'] ?? '' ) );
      }
  }
  ```

- [ ] **Step 2: Run the test — expect PASS**

  ```bash
  composer test:integration -- --filter BlocksIncludeRegisteredTest
  ```

  Expected: `OK (1 test, 4 assertions)`.

- [ ] **Step 3: Would-have-caught spot-check (this is the canonical FIX-5 revert)**

  Find `BlockSchema::block_items_one_of()` in `includes/Schema/BlockSchema.php`. Change the top-level `'anyOf' => ...` to `'oneOf' => ...`. Re-run, expect FAIL with the WP_Error message "matches more than one of the expected formats". `git checkout` to restore. The implementer should perform this revert because FIX-5 is the headline silent bug from v0.6.3 and the revert is one line.

- [ ] **Step 4: Commit**

  ```bash
  git add tests/integration/Abilities/BlocksIncludeRegisteredTest.php
  git commit -m "test(wp-plugin): BlocksIncludeRegisteredTest — FIX-5 v0.6.3 anyOf

  Posts containing registered core blocks no longer fail
  jab/get-post-by-slug with include.blocks=true. The test creates a post
  with a core/paragraph block, executes the by-slug ability with
  include.blocks=true, and asserts blocks[0].blockName is 'core/paragraph'.
  Pre-FIX-5 the response hard-failed with 'matches more than one of the
  expected formats' because WP REST's rest_validate_value_from_schema
  ignores `not` inside oneOf alternatives."
  ```

---

## Task 9: AcfDiagnosticsLedgerTest (Phase 5 deferral)

**Files:**
- Create: `packages/wp-plugin/tests/integration/Diagnostics/AcfDiagnosticsLedgerTest.php`

Regression target: the Phase 5 `acf_no_schema_skips` check's `warn` branch (populated ledger). Phase 5 unit-tested both branches but only integration-tested the tracking-off branch because no ACF was available in the harness. Now that Groups C and D exist, this test drives the populated path.

- [ ] **Step 1: Create the test file**

  Create `packages/wp-plugin/tests/integration/Diagnostics/AcfDiagnosticsLedgerTest.php`:

  ```php
  <?php
  /**
   * AcfDiagnosticsLedgerTest — Phase 5 deferred populated-ledger branch.
   *
   * The acf_no_schema_skips check has three branches:
   *   1. Diagnostics filter off → severity=pass, message "Tracking off — no data to report."
   *   2. Diagnostics filter on, ledger empty → severity=pass, message "Tracking on — ledger empty."
   *   3. Diagnostics filter on, ledger populated → severity=warn, detail is a string[] of
   *      formatted "group ..." and "field ..." lines.
   *
   * Phase 5 ReportSmokeTest covered branch 1 (the harness baseline). Two
   * unit tests in ReportFromEnvironmentTest cover branches 2 and 3 against
   * a synthetic env array. This test covers branch 3 end-to-end: real ACF
   * groups with unsupported shapes (Group C: unsupported location rule;
   * Group D: password field), real Schema::for_post_type() execution
   * driving record_skipped_group + record_dropped_field, real
   * Diagnostics\Report::generate() reading the ledger.
   *
   * @package Jab\WpHeadlessKit\Tests\Integration\Diagnostics
   */

  declare( strict_types=1 );

  final class AcfDiagnosticsLedgerTest extends IntegrationTestCase {

      protected function setUp(): void {
          parent::setUp();
          if ( ! class_exists( 'ACF' ) ) {
              $this->markTestSkipped( 'ACF not loaded — run `pnpm -w exec wp-env start --update` to install the slot.' );
          }

          // Cold-start REST so collect_environment() reads routes (same
          // pattern as Phase 5 post-merge fix in ReportSmokeTest).
          global $wp_rest_server;
          $wp_rest_server = null;

          // Enable the diagnostics ledger and force a fresh schema build
          // so record_skipped_group + record_dropped_field actually run.
          // Without flush_cache the in-memory ledger stays empty because
          // for_post_type would hit the transient cache instead of
          // walking the field groups.
          add_filter( 'jab/headless_kit/acf_diagnostics', '__return_true' );
          \Jab\WpHeadlessKit\Acf\Schema::flush_cache();
          \Jab\WpHeadlessKit\Acf\Schema::for_post_type( 'book' );
      }

      public function test_acf_no_schema_skips_warn_branch_fires_with_both_ledger_sides_populated(): void {
          $report = \Jab\WpHeadlessKit\Diagnostics\Report::generate();

          $this->assertGreaterThanOrEqual( 1, (int) ( $report['summary']['warn'] ?? 0 ), 'summary.warn must be >= 1' );

          $check = null;
          foreach ( (array) ( $report['checks'] ?? [] ) as $candidate ) {
              if ( 'acf_no_schema_skips' === ( $candidate['id'] ?? '' ) ) {
                  $check = (array) $candidate;
                  break;
              }
          }
          $this->assertNotNull( $check, 'acf_no_schema_skips check missing from report.' );
          $this->assertSame( 'warn', (string) ( $check['severity'] ?? '' ) );

          $detail = (array) ( $check['detail'] ?? [] );

          $has_group_line = false;
          $has_field_line = false;
          foreach ( $detail as $line ) {
              $text = (string) $line;
              if ( false !== strpos( $text, 'group group_jab_test_unsupported_location' ) ) {
                  $has_group_line = true;
              }
              if ( false !== strpos( $text, 'field jab_test_password' ) ) {
                  $has_field_line = true;
              }
          }
          $this->assertTrue( $has_group_line, 'detail must include a line for group_jab_test_unsupported_location.' );
          $this->assertTrue( $has_field_line, 'detail must include a line for jab_test_password field drop.' );
      }
  }
  ```

- [ ] **Step 2: Run the test — expect PASS**

  ```bash
  composer test:integration -- --filter AcfDiagnosticsLedgerTest
  ```

  Expected: `OK (1 test, 5 assertions)`.

- [ ] **Step 3: Sanity check — confirm ReportSmokeTest still treats baseline as pass**

  ```bash
  composer test:integration -- --filter ReportSmokeTest
  ```

  Expected: `OK (7 tests, 16 assertions)`. (If `test_harness_state_produces_summary_with_zero_fails` now shows a warn from the new ACF groups, see Task 1 Step 4's note — that test asserts `fail === 0`, not `warn === 0`, so the new warns from this test's setUp shouldn't leak there because each test runs in its own transaction with its own filter state. If it does leak, the most likely cause is a missing filter cleanup; the WP_UnitTestCase transactional teardown should handle it, but if not, add `remove_filter('jab/headless_kit/acf_diagnostics', '__return_true');` to `tearDown()` of this test.)

- [ ] **Step 4: Commit**

  ```bash
  git add tests/integration/Diagnostics/AcfDiagnosticsLedgerTest.php
  git commit -m "test(wp-plugin): AcfDiagnosticsLedgerTest — Phase 5 populated ledger

  Fills the Phase 5 deferred integration branch of acf_no_schema_skips.
  The test's setUp enables the jab/headless_kit/acf_diagnostics filter,
  bumps the schema generation salt via Schema::flush_cache(), and runs
  Schema::for_post_type('book') to populate the in-memory ledger from
  Groups C (unsupported user_form location rule → group skip) and D
  (password field type → field drop). Then Diagnostics\\Report::generate()
  emits a warn-severity check whose detail string[] carries both
  ledger sides."
  ```

---

## Task 10: tests/README.md update

**Files:**
- Modify: `packages/wp-plugin/tests/README.md`

Goal: reflect the new coverage. The seven deferred regressions move from "deferred to Phase 1.1" into "Covered (Phase 1)" — actually, the cleanest move is to add a "Covered (Phase 1.1)" subsection so the historical scoping is preserved. Also drop the "tracking-off branch only" qualifier on `acf_no_schema_skips`.

- [ ] **Step 1: Edit the README**

  Open `packages/wp-plugin/tests/README.md`. Find the **"Covered (Phase 1)"** subsection and append after its existing bullet list:

  ```markdown
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
  ```

  Then, in the original "Covered (Phase 1)" list, find the existing `acf_no_schema_skips` line that reads "tracking-off branch only — populated-ledger branch is a Phase 1.1 ACF-slot follow-up" and delete the parenthetical qualifier so it reads simply `acf_no_schema_skips`.

  Then delete the entire **"Regression tests deferred to Phase 1.1"** section at the bottom of the file (it's now obsolete).

- [ ] **Step 2: Verify the file still parses as Markdown**

  Just visually inspect; PHPUnit doesn't care about README content.

- [ ] **Step 3: Commit**

  ```bash
  git add tests/README.md
  git commit -m "docs(wp-plugin): tests/README.md reflects Phase 1.1 coverage

  Move the seven deferred regressions out of the 'deferred to Phase 1.1'
  list and into a new 'Covered (Phase 1.1)' subsection. Drop the
  'tracking-off branch only' qualifier on acf_no_schema_skips now that
  AcfDiagnosticsLedgerTest covers the populated branch end-to-end.
  Document the four fixture ACF field groups."
  ```

---

## Task 11: Final full-suite verification

**Files:**
- None (verification only)

Goal: prove the whole picture is green before merge.

- [ ] **Step 1: Run lint**

  ```bash
  cd packages/wp-plugin
  composer lint
  ```

  Expected: `26 / 26 (100%)`.

- [ ] **Step 2: Run the unit suite**

  ```bash
  composer test:unit
  ```

  Expected: `OK (210 tests, 477 assertions)`. Unchanged from baseline — this phase added no unit tests and touched no production source.

- [ ] **Step 3: Run the full integration suite**

  ```bash
  composer test:integration
  ```

  Expected: `OK (28 tests, ~98 assertions)` (54 prior + 8 + 5 + 8 + 5 + 4 + 5 + 4 + 5 = 98 — approximate; PHPUnit counts some compound assertions differently). The exact assertion count is informational — what matters is the test count: **20 + 8 = 28**.

- [ ] **Step 4: Cross-check the eight new test files are all present**

  ```bash
  ls tests/integration/Abilities/MenuLabelOnlyParentTest.php \
     tests/integration/Abilities/DraftZeroDatePostTest.php \
     tests/integration/Abilities/ObjectTermsGroupingTest.php \
     tests/integration/Abilities/PostsWithZeroTermsTest.php \
     tests/integration/Abilities/BlocksIncludeRegisteredTest.php \
     tests/integration/Acf/AcfEmptyValueOutputTest.php \
     tests/integration/Acf/AcfFlexContentDiscriminatorTest.php \
     tests/integration/Diagnostics/AcfDiagnosticsLedgerTest.php
  ```

  Expected: all eight paths listed with no errors.

- [ ] **Step 5: No-source-change verification**

  ```bash
  git diff master -- includes/
  ```

  Expected: empty output. This phase is purely a test-harness expansion; any change to `includes/` is out of scope and likely a mistake.

- [ ] **Step 6: No-commit if everything is green**

  No commit at this task — verification only. If a discrepancy surfaces, file a follow-up task rather than amending a prior commit.

  Branch is ready for the `superpowers:finishing-a-development-branch` workflow.
