# JAB WP Plugin Connector Hardening Plan

> Date: 2026-06-01  
> Scope: `packages/wp-plugin`  
> Audience: senior WordPress/PHP developer  
> Goal: mature the JAB WordPress connector from pilot-ready to production connector-ready for JAB SaaS.

## Context

The JAB WP plugin is already architecturally sound: a thin WordPress plugin that exposes public WordPress content as MCP abilities, with transport delegated to `wordpress/mcp-adapter`. It has strong zero-config discovery, stable ability naming, ACF-aware schemas, typed Gutenberg block emission, and a good history of fixing real WordPress REST schema edge cases.

The next step is not a rewrite. The highest leverage work is production hardening: green CI, integration tests against real WordPress behavior, better sync semantics, stronger diagnostics, and a broader site manifest for SaaS onboarding/generation.

## Current Verification Snapshot

Commands run during audit:

```bash
cd packages/wp-plugin
composer test:unit
composer lint
```

Results:

- `composer test:unit` passed: 122 tests, 264 assertions.
- `composer lint` failed on one PHPCS warning in `includes/Acf/Schema.php` line 198: assignment alignment.

## Principles

- Keep the plugin thin. Do not move MCP transport, JSON-RPC session behavior, or SaaS orchestration into the plugin.
- Treat WordPress runtime behavior as the source of truth. Add integration tests for behavior that depends on `WP_Query`, roles/caps, REST validation, ACF runtime values, menus, and blocks.
- Prefer additive, filterable capabilities. Agencies should customize via mu-plugins, not forks.
- Make silent connector failures visible. Missing fields, skipped schemas, auth failures, and incomplete manifests should be diagnosable.
- Preserve generated SDK stability. Ability names and wrapper keys are public contracts.

## Phase 0: Restore Green CI

### Task 0.1: Fix PHPCS Alignment Warning

File:

- `packages/wp-plugin/includes/Acf/Schema.php`

Issue:

- `$cached` assignment is not aligned with nearby assignments.

Expected change:

```php
$cached         = function_exists( 'get_transient' ) ? get_transient( $cache_key ) : false;
```

Verification:

```bash
cd packages/wp-plugin
composer lint
composer test:unit
```

Acceptance:

- PHPCS exits 0.
- Unit suite remains green.

## Phase 1: WordPress Integration Test Harness

### Task 1.1: Add Real WordPress Integration Test Layer

Files likely involved:

- `packages/wp-plugin/tests/`
- `packages/wp-plugin/composer.json`
- `.github/workflows/ci-plugin.yml`

Implement a real WordPress test harness using either `WP_PHPUnit` or `wp-env`. The unit suite is useful but cannot prove the connector behavior that matters most.

Minimum coverage:

- Plugin activates cleanly with bundled dependencies.
- Abilities register on `wp_abilities_api_init`.
- REST routes register under `/wp-json/jab/v1/`.
- Application Password or authenticated REST requests satisfy expected capability gates.

Acceptance:

- CI runs unit tests and integration tests.
- Integration suite can seed posts, pages, menus, taxonomies, and users.
- Tests run on PHP 7.4 plus at least one modern PHP version.

### Task 1.2: Convert Known Schema Regressions Into Integration Tests

Use `packages/wp-plugin/tests/README.md` as the seed list.

Required tests:

- Empty ACF `url`, `email`, and `date_picker` values do not fail ability output validation.
- Nav menu with label-only parent item returns valid `jab/get-menus` output.
- Draft or malformed-date post does not emit invalid date output.
- Subscriber/authenticated reader requesting `post_status=draft` does not receive drafts.
- `wp_get_object_terms()` grouping returns taxonomy terms under the correct post IDs.
- Flexible Content discriminator validates correctly.
- Posts with zero terms still include required taxonomy arrays.
- By-slug ability names remain stable when `rest_base === slug`.
- `include.blocks=true` succeeds for posts containing registered blocks.

Acceptance:

- Reverting any historical fix causes at least one integration test to fail.

## Phase 2: Production Sync Semantics

### Task 2.1: Add Pagination and Deterministic Ordering

Files likely involved:

- `packages/wp-plugin/includes/Abilities/PostTypeListAbility.php`
- `packages/wp-plugin/tests/unit/Abilities/PostTypeListAbilityTest.php`
- New integration tests

Current list abilities support only `numberposts` and `post_status`. That is not enough for reliable SaaS sync.

Add input parameters:

- `page`
- `per_page` or keep `numberposts` while adding `offset`
- `orderby`
- `order`

Recommended default:

- Order by `modified` descending or publish date descending, but document it explicitly.

Acceptance:

- Output order is deterministic.
- Large CPTs can be fetched without missing or duplicating records.
- Input schema has bounded maximums.

### Task 2.2: Add Incremental Sync Filters

Add input parameters:

- `modified_after`
- `modified_before`
- `date_after`
- `date_before`

Output additions:

- `modified`
- `modified_gmt`
- optionally `status` for users with edit capability

Acceptance:

- SaaS can ask “what changed since timestamp X?”
- Subscriber/read-only users do not receive unpublished status metadata unless explicitly allowed.

### Task 2.3: Add ID and Slug Filters

Add input parameters:

- `include_ids`
- `exclude_ids`
- `slug_in`
- taxonomy filters where safe and discoverable

Acceptance:

- SaaS can re-fetch a known set of records without scanning the whole CPT.

## Phase 3: Site Manifest Expansion

### Task 3.1: Add Site Settings Manifest

Files likely involved:

- New `packages/wp-plugin/includes/Rest/SiteManifest.php`
- `packages/wp-plugin/wp-headless-kit.php`
- Unit/integration tests

Expose a new authenticated REST endpoint, for example:

```text
/wp-json/jab/v1/site
```

Recommended fields:

- Site title and tagline
- Home URL and site URL
- Timezone
- Locale
- Permalink structure
- Front page mode: latest posts vs static page
- Static front page ID/slug when configured
- Posts page ID/slug when configured
- Site icon URL
- Custom logo attachment and URL
- Registered nav menu locations
- Registered image sizes
- Active theme slug/name/version

Auth:

- Prefer `edit_posts` or a new filterable capability. This endpoint reveals site structure useful to generation.

Acceptance:

- SaaS onboarding can identify the front page without heuristic crawling.
- Manifest has stable keys and explicit nulls for absent settings.

### Task 3.2: Make Manifest Capability Filterable

File:

- `packages/wp-plugin/includes/Rest/Manifest.php`

Current behavior:

- `/manifest` requires `read`.

Recommended change:

- Route through a dedicated filter, e.g. `jab/headless_kit/manifest_capability`.
- Consider defaulting to `edit_posts` if field names and schemas are considered sensitive.

Acceptance:

- Agencies can independently tighten schema discovery without affecting normal ability calls.

## Phase 4: ACF and Global Content Coverage

### Task 4.1: Support ACF Options Pages

Add an ability or REST manifest section for ACF Options Pages.

Potential ability names:

- `jab/get-options`
- `jab/get-site-options`

Include:

- Option page slug/key
- Field schema
- Runtime values passed through `AcfValueWalker`

Security:

- Default capability should be stricter than `read`, likely `edit_posts` or `manage_options`, and filterable.

Acceptance:

- Header/footer CTAs, social links, global addresses, tracking snippets, and theme-level content are available without custom code.

### Task 4.2: Improve ACF Location Rule Diagnostics

File:

- `packages/wp-plugin/includes/Acf/Schema.php`

Current behavior:

- Diagnostics exist, but complex location rules are still mostly skipped.

Improve:

- Better reason messages for `AND`/`OR` rules.
- Include group title, key, target post type, and unsupported rule.
- Add a surfaced diagnostics endpoint or CLI command in Phase 5.

Acceptance:

- A senior agency dev can answer “why is this ACF field missing?” within one command/request.

## Phase 5: Connector Diagnostics

### Task 5.1: Add `wp jab doctor`

Implement a WP-CLI command if WP-CLI is available.

Report:

- Plugin version
- WordPress version
- PHP version
- MCP Adapter availability
- Abilities API availability
- Registered JAB abilities
- Public CPTs included/excluded
- Public taxonomies included/excluded
- ACF active status
- ACF skipped groups/dropped fields diagnostics
- REST route availability
- Current capability filter values where detectable

Acceptance:

- The command exits non-zero for hard failures.
- The command prints actionable warnings for partial configuration issues.

### Task 5.2: Add Authenticated Diagnostics REST Endpoint

Potential route:

```text
/wp-json/jab/v1/diagnostics
```

Auth:

- Default `manage_options`, filterable.

Use case:

- SaaS onboarding wizard can display precise setup issues without shell access.

Acceptance:

- Missing MCP Adapter, missing dependencies, no discovered content types, and ACF skips are visible in SaaS onboarding.

## Phase 6: Content Mutation Signals

### Task 6.1: Add Change Webhook Hooks

Add optional outgoing webhooks or action hooks when content changes.

Minimum internal hooks:

- `save_post`
- `deleted_post`
- `trashed_post`
- `set_object_terms`
- `acf/save_post` when ACF is active

Implementation approach:

- Start with internal WordPress actions/filters that a mu-plugin can use.
- Defer direct SaaS HTTP callbacks unless product requirements are clear.

Acceptance:

- JAB SaaS can eventually invalidate or re-sync changed content without polling every CPT.

## Phase 7: Forms Capability

### Task 7.1: Execute Existing Forms Design

Reference:

- `docs/superpowers/plans/2026-05-25-wp-plugin-v0.7.0-forms-design.md`

Priority:

- Gravity Forms first if that remains the chosen plugin.
- Preserve add-on compatibility.
- Treat payments/e-commerce as out of scope until explicitly required.

Acceptance:

- SaaS can discover form schemas.
- Frontend can submit forms through WordPress in a way that triggers normal add-ons.
- Auth, nonce, spam, and validation behavior are documented and tested.

## Phase 8: Multilingual and Multisite Strategy

### Task 8.1: Document and Detect Multilingual Plugins

Detect:

- WPML
- Polylang
- TranslatePress if needed

Expose:

- Available languages
- Default language
- Per-record language metadata where available
- Translation relationships where available

Acceptance:

- SaaS can avoid treating translations as duplicate unrelated pages.

### Task 8.2: Multisite Compatibility Review

Decide whether the plugin supports:

- Single site only
- Network activation
- Per-site activation
- Cross-site content discovery

Acceptance:

- README explicitly states support level.
- Tests cover the chosen support level or mark it unsupported.

## Phase 9: Documentation Updates

### Task 9.1: Refresh README Around Production Connector Behavior

File:

- `packages/wp-plugin/README.md`

Update:

- Sync parameters and defaults
- Site manifest endpoint
- Diagnostics commands/routes
- Capability filters
- ACF Options support
- Known limitations
- Integration test instructions

### Task 9.2: Add Agency Runbook

Suggested file:

- `docs/jab-wp-plugin-agency-runbook.md`

Include:

- Installation paths
- Application Password setup
- Recommended service user role/capability
- Verification checklist
- Troubleshooting common failures
- How to customize via mu-plugin filters
- How to run `wp jab doctor`

## Suggested Work Order

1. Phase 0: restore green CI.
2. Phase 1: integration harness and regression tests.
3. Phase 2: pagination and incremental sync.
4. Phase 3: site manifest and manifest capability filter.
5. Phase 5: diagnostics surfaces.
6. Phase 4: ACF Options Pages.
7. Phase 7: forms support.
8. Phase 8: multilingual/multisite.
9. Phase 9: docs and agency runbook.

## Definition of Done

- `composer lint` passes.
- `composer test:unit` passes.
- WordPress integration suite passes in CI.
- New public inputs/endpoints are documented in README.
- New auth surfaces have filterable capabilities.
- SaaS onboarding can verify plugin health and explain failures.
- SaaS sync can page through content and perform incremental updates.
- No existing ability name changes without explicit migration notes.

