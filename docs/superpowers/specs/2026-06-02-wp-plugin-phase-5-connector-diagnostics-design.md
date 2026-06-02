# wp-plugin Phase 5 — Connector Diagnostics (`wp jab doctor` + `/jab/v1/diagnostics`)

**Status:** Draft (2026-06-02)
**Author:** Sean Roberts
**Plan reference:** [`docs/2026-06-01-jab-wp-plugin-connector-hardening-plan.md`](../../2026-06-01-jab-wp-plugin-connector-hardening-plan.md) §Phase 5
**Target release:** plugin v0.7.1

---

## 1. Problem

There is no first-class way to ask the plugin "is this install healthy and configured correctly?" from either an agency-developer terminal or the SaaS onboarding wizard. Today:

- The SaaS wizard's `verifyPluginAction` hits the public `/wp-json/jab/v1/` health probe, which only confirms the plugin's REST namespace exists. It cannot distinguish "plugin installed but mcp-adapter missing" from "plugin installed and fully functional" — both return 200. When the wizard surfaces a problem, the user sees a generic message with no actionable next step.
- An agency developer triaging "the AI can't see field X" or "MCP calls are failing" has no single surface to consult. They piece state together from `wp plugin list`, `wp db query`, `WP_DEBUG` logs, and direct PHP inspection. The only structured plugin-internal data they have access to is `Acf\Schema::diagnostics()`, which is gated by `WP_DEBUG` and not exposed anywhere.
- The plugin already has multiple capability-filterable surfaces (`manifest_capability`, `site_manifest_capability`, `ability_capability`) that an agency can override but cannot easily inspect the current resolved value of.

Phase 5 closes all three gaps with one structured introspection surface, exposed as both a WP-CLI command and a REST endpoint.

## 2. Goals and non-goals

**Goals**
- Single source of truth for "what is the current health of this install?" — facts + checks.
- Same shape across CLI and REST so SaaS and CLI consumers can share parsing logic.
- Actionable severity model that supports two consumer flows: an agency developer reading text in a terminal, and a wizard surfacing fix-this items.
- Stable contract: stable check IDs and field names that downstream consumers can rely on.

**Non-goals (v0.7.1)**
- `wp jab repair` or any auto-fix functionality. Diagnostics observes; remediation is manual.
- Surfacing the mcp-adapter default-server load-ordering quirk. We proved it is a real upstream bug; surfacing it as a check on every agency install leaks platform-team noise the agency cannot act on. Revisit if upstream does not fix it.
- WP / PHP minimum-version checks. The plugin's `Requires WP` and `Requires PHP` headers prevent it loading on unsupported floors; if `wp jab doctor` runs at all, both are fine. Reported as facts only.
- WP_DEBUG-in-production detection. Requires environment introspection we cannot do reliably.
- ACF-active integration test coverage. Deferred to Phase 1.1 alongside the broader ACF `.wp-env.json` slot.
- WP-CLI runtime tests in CI. Brittle and slow; the meaningful logic is covered without them (see §7).

## 3. Architecture

One pure data-collection service, two thin adapters.

```
includes/
├── Diagnostics/
│   ├── Report.php          ::generate(): array — facts + checks. Side-effect-free.
│   ├── Check.php           value object: { id, label, severity, message, detail? }
│   └── Fact.php            value object: { id, label, value, detail? }
│
├── Cli/
│   ├── DoctorCommand.php   `wp jab doctor` (registered IFF defined('WP_CLI'))
│   │                       Flags: --format=table|json|yaml · --strict · --debug-acf
│   └── TextRenderer.php    pure: render( array $report ): string
│                           Extracted so unit tests can compare against a
│                           known-expected text block without invoking WP-CLI.
│
└── Rest/
    └── Diagnostics.php     GET /wp-json/jab/v1/diagnostics
                            cap: manage_options (filterable)
```

Three principles:

1. **`Diagnostics\Report` is side-effect-free.** It reads WP / plugin state, builds value objects, returns an array. It never flushes caches, writes filters, or touches transients. Both adapters call it as `Report::generate()` and serialize identically.
2. **`--debug-acf` is a CLI-only concern.** ACF diagnostics are populated at schema-generation time. To populate them without restarting the WP request, the CLI adapter wraps `Report::generate()` in a temporary `add_filter('jab/headless_kit/acf_diagnostics', '__return_true')` and calls a new `Acf\Schema::flush_cache()` to force a rebuild on the next schema query. This is too heavy for the REST endpoint to do on every onboarding probe and is deliberately not available there.
3. **REST never has side effects.** The REST handler is pure read.

## 4. Report shape (the public contract)

The data structure returned by `Report::generate()` and serialized verbatim by both adapters:

```json
{
  "plugin_version": "0.7.1",
  "generated_at": "2026-06-02T20:15:00Z",
  "summary": { "pass": 6, "warn": 0, "fail": 0 },

  "facts": [
    { "id": "plugin_version",        "label": "Plugin version",        "value": "0.7.1" },
    { "id": "wp_version",            "label": "WordPress version",     "value": "6.9.0" },
    { "id": "php_version",           "label": "PHP version",           "value": "8.3.7" },
    { "id": "registered_abilities",  "label": "Registered JAB abilities",
      "value": 14,
      "detail": ["jab/get-posts", "jab/get-pages", "jab/get-beers", "..."] },
    { "id": "post_types", "label": "Public post types",
      "value": { "included": ["post","page","beer"], "excluded": ["attachment","acf-field-group"] } },
    { "id": "taxonomies", "label": "Public taxonomies",
      "value": { "included": ["category","beer_style"], "excluded": ["nav_menu","post_format"] } },
    { "id": "capability_filters", "label": "Capability filter values",
      "value": {
        "jab/headless_kit/ability_capability":       "read",
        "jab/headless_kit/manifest_capability":      "read",
        "jab/headless_kit/site_manifest_capability": "edit_posts",
        "jab/headless_kit/diagnostics_capability":   "manage_options"
      } },
    { "id": "acf", "label": "ACF",
      "value": {
        "active": true,
        "pro": false,
        "version": "6.3.4",
        "diagnostics_enabled": false,
        "skipped_groups": [],
        "dropped_fields": []
      },
      "detail": "Diagnostics ledger is empty because WP_DEBUG is off and the jab/headless_kit/acf_diagnostics filter is not set to true. Run `wp jab doctor --debug-acf` or set WP_DEBUG=true to populate." }
  ],

  "checks": [
    { "id": "abilities_api",              "label": "Abilities API loaded",                    "severity": "pass", "message": "wp_register_ability() is available." },
    { "id": "mcp_adapter",                "label": "MCP Adapter loaded",                      "severity": "pass", "message": "wordpress/mcp-adapter v0.5.0 detected." },
    { "id": "rest_routes_registered",     "label": "JAB REST routes registered",              "severity": "pass", "message": "5/5 routes present.",
      "detail": ["/jab/v1/","/jab/v1/manifest","/jab/v1/site","/jab/v1/content-types","/jab/v1/diagnostics"] },
    { "id": "post_types_discovered",      "label": "At least one public post type discovered","severity": "pass", "message": "3 discovered." },
    { "id": "application_passwords_enabled", "label": "Application Passwords enabled",        "severity": "pass", "message": "wp_is_application_passwords_available() true." },
    { "id": "acf_no_schema_skips",        "label": "No ACF schema skips",                     "severity": "pass", "message": "Tracking off — no data to report." }
  ]
}
```

**Stability rules** (the contract the SaaS wizard, CLI, and any future Phase 5 consumer relies on):

- `id` slugs on facts and checks are stable; **never renamed or reordered** once shipped. Adding new facts/checks is non-breaking; removing or renaming is breaking and requires a plugin major bump.
- `severity` is always one of `"pass" | "warn" | "fail"`. No silent introduction of new values.
- `detail` is optional. May be a string, an array of strings, or absent.
- `summary` always contains `pass`, `warn`, `fail` numeric counts that sum to `checks.length`.
- `generated_at` is RFC 3339 UTC matching the `/manifest` envelope.
- `plugin_version` is the current plugin VERSION constant, never null when the plugin is active.

## 5. The check catalog

Six checks. Each `id` is a public-contract slug.

| ID | Asserts | Severity when failing | Rationale |
|---|---|---|---|
| `abilities_api` | `function_exists('wp_register_ability')` | **fail** | Plugin requires WP 6.9+ core. Foundational. |
| `mcp_adapter` | `class_exists('WP\\MCP\\Core\\McpAdapter')` | **fail** | The kit's headline value prop is MCP-iterable headless. Without the adapter, the plugin is half-dead. |
| `rest_routes_registered` | All five `/jab/v1/*` routes (`/`, `/manifest`, `/site`, `/content-types`, `/diagnostics`) appear in `rest_get_server()->get_routes()` | **fail** | Missing routes mean something interfered with `rest_api_init`. `detail` lists which ones are missing. |
| `post_types_discovered` | After exclusions (`Registry::DEFAULT_POST_TYPE_EXCLUDES` + filter), at least one public post type remains | **fail** | `post` and `page` should always be present. Zero discovered means filters are over-excluding or core is in a broken state. |
| `application_passwords_enabled` | `wp_is_application_passwords_available()` returns true | **fail** | Application Passwords is the auth path for CLI and SaaS. If the site has them disabled, the integration path is dead. |
| `acf_no_schema_skips` | When `Acf\Schema::diagnostics_enabled()` is true: ledger groups + fields arrays are empty. When tracking is off: pass with note. | **warn** | A non-empty ledger means specific fields/groups are not appearing to the AI. Message includes counts; `detail` lists names. |

**Execution semantics:** all six checks run regardless of prior failures. Output is deterministic; "abilities_api fails AND rest_routes_registered fails" surfaces both.

**Deliberate exclusions:** see §2 (mcp-adapter default-server quirk; WP / PHP version checks; WP_DEBUG-in-prod detection).

## 6. CLI surface

**Command:** `wp jab doctor`
**Registration:** in `wp-headless-kit.php`, guarded by `if ( defined('WP_CLI') && WP_CLI ) { Cli\DoctorCommand::register(); }`. WP-CLI class file is autoloaded but is never required outside the CLI context.

**Flags:**
- `--format=<table|json|yaml>` (default `table`). `csv` is intentionally not supported because the report is a nested object.
- `--strict` — when set, warnings also cause non-zero exit.
- `--debug-acf` — temporarily force-enables ACF diagnostics tracking and rebuilds the schema (flushes the ACF schema transient) so the report includes skipped-group / dropped-field detail even on a production install. Emits a one-line notice to stderr indicating the side effect happened.

**Exit-code logic:**

```
any fail                       → exit 1
any warn AND --strict          → exit 1
otherwise                      → exit 0
```

**Default text format** (`table`):

```
JAB Headless Kit — Diagnostics

Plugin                v0.7.1
WordPress             6.9.0
PHP                   8.3.7
Registered abilities  14
Public post types     3 included (post, page, beer) · 2 excluded (attachment, acf-field-group)
Public taxonomies     2 included (category, beer_style) · 2 excluded (nav_menu, post_format)
Capability filters
  manifest_capability         read
  site_manifest_capability    edit_posts
  diagnostics_capability      manage_options
  ability_capability          read
ACF                   active · v6.3.4 (free) · diagnostics tracking off
                      Run `wp jab doctor --debug-acf` for a full rebuild
                      with skipped-groups/dropped-fields detail.

Checks
  ✓ pass  Abilities API loaded            wp_register_ability() is available.
  ✓ pass  MCP Adapter loaded              wordpress/mcp-adapter v0.5.0 detected.
  ✓ pass  JAB REST routes registered      5/5 routes present.
  ✓ pass  At least one public post type   3 discovered.
  ✓ pass  Application Passwords enabled   wp_is_application_passwords_available() true.
  ✓ pass  No ACF schema skips             Tracking off — no data to report.

Summary               6 pass · 0 warn · 0 fail
```

**JSON / YAML formats:** emit `Report::generate()` verbatim (same shape REST returns).

**`--debug-acf` flow inside `DoctorCommand`:**

1. `add_filter('jab/headless_kit/acf_diagnostics', '__return_true')`
2. `Acf\Schema::flush_cache()` (new method — clears the VERSION-keyed transient introduced in v0.6.2)
3. Force a schema rebuild by iterating `Registry::ability_configs()` and querying each CPT's schema (this re-runs the ACF pass with tracking on)
4. Call `Report::generate()`
5. Emit `--debug-acf rebuilt ACF schema with diagnostics enabled` to stderr

The REST endpoint has no equivalent path; it always reports whatever the ledger currently holds.

## 7. REST surface

```
Route       GET /wp-json/jab/v1/diagnostics
Auth        current_user_can( capability() )
Capability  default 'manage_options', filterable via
            jab/headless_kit/diagnostics_capability with the
            do_not_allow fallback pattern from Manifest::capability()
Response    200 with Report::generate() JSON
Errors      401 (rest_login_required) if anonymous
            403 (rest_forbidden_context) if logged in but missing cap
Caching     send_nocache_headers()
```

**`Diagnostics::capability()`** mirrors the existing helper on `Manifest` and `SiteManifest`: a filter returning a non-string or empty value coerces to `'do_not_allow'` and emits a `_doing_it_wrong` notice. This is the SEC-1-driven hardening pattern already standardized across the plugin's filterable capabilities.

**Privacy notes:**
- PHP version is the only data point in the response not already public elsewhere. Behind `manage_options` (admin-tier) by default — fine.
- ACF group / field names (when the ledger is populated) could reveal site structure but are also behind `manage_options`.
- Capability filter values reveal an agency's security configuration. Same gate.

**SaaS integration contract:** after the wizard's `verifyPluginAction` succeeds and the user supplies Application Password credentials, the wizard makes a follow-up call to `/jab/v1/diagnostics` and renders:

- `summary` as a coloured chip (green if all pass, yellow if any warn, red if any fail)
- failing / warning `checks` as an actionable list (`message` as headline, `detail` as expandable note)
- the `facts` block in a collapsed "Site details" panel

If the SaaS-side call returns 403, the wizard surfaces (exact wording, part of the contract):

> The supplied Application Password user needs `manage_options`. Use an admin account for onboarding, or filter `jab/headless_kit/diagnostics_capability` to a less-privileged cap if your security model requires it.

The SaaS-side wizard UX work is a separate follow-up ticket on the `apps/web` track; Phase 5 only ships the API contract above.

## 8. Testing strategy

**Unit tests** (`composer test:unit` — no WP runtime):
- Each check resolver tested in isolation with stubbed inputs (`function_exists`, `class_exists`, `rest_get_server()->get_routes()`, etc. mocked or wrapped). One small test per check (6).
- `Cli\TextRenderer::render( array $report ): string` is a pure function. Unit test builds a fixture report array, calls `render()`, and `assertSame`s against the expected text block stored as a heredoc in the test file (a golden-output comparison, not a snapshot file).
- Severity rollup (`summary` counts).
- Exit-code mapping (fail → 1, warn+strict → 1, warn → 0, pass → 0).

**Integration tests** (`composer test:integration` — Phase 1 harness, real WP):

- `tests/integration/Diagnostics/ReportSmokeTest.php` — boot WP, call `Report::generate()`, assert: all six check IDs present; abilities API + MCP adapter both pass in the fixture environment; `rest_routes_registered` finds all 5; facts contain `plugin_version` + `capability_filters` keys; `summary` math matches.
- `tests/integration/Rest/DiagnosticsAuthTest.php` — anonymous returns 401; freshly-created Subscriber returns 403; freshly-created Admin returns 200 with envelope.
- `tests/integration/Rest/DiagnosticsCapabilityFilterTest.php` — filter `jab/headless_kit/diagnostics_capability` to `'read'`; Subscriber now 200. Filter to `''`; Admin gets 403 with `_doing_it_wrong` notice (`setExpectedIncorrectUsage`).

**Deliberately NOT tested in CI:**

- **`wp jab doctor` via the wp-env `cli` container.** WP-CLI runtime tests are slow and brittle; the meaningful logic — report generation, renderer output, exit-code mapping — is covered as unit tests. Manual smoke when the v0.7.1 zip is built is sufficient for the WP-CLI registration layer itself.
- **`acf_no_schema_skips` non-empty branch.** Requires ACF active in `.wp-env.json`. Deferred to Phase 1.1 alongside the ACF slot. v0.7.1 ships with unit coverage (mock `Acf\Schema::diagnostics()` return) + integration coverage of the "ACF inactive, tracking off → pass with note" branch, which is the most common production state.

**Lint:** new code lands lint-clean against the existing `phpcs.xml.dist`. Same baseline as Phase 1.

## 9. Definition of done

- `Report::generate()` returns the documented shape with all six checks and seven facts populated under the integration harness.
- `wp jab doctor` registers under WP-CLI and produces the documented text output for the integration-harness fixture state.
- `wp jab doctor --format=json` output equals `wp jab doctor` JSON-encoded equals the REST endpoint's JSON output (byte-identical modulo `generated_at`).
- `/wp-json/jab/v1/diagnostics` enforces `manage_options` by default, honours the filter, and uses the do_not_allow fallback for non-string / empty filter returns.
- `--strict` causes warnings to exit non-zero.
- `--debug-acf` populates the ACF ledger on a WP_DEBUG=false install (manual smoke against the pilot, since CI does not include ACF).
- `composer lint` passes.
- `composer test:unit` passes with the new unit tests.
- `composer test:integration` passes with the three new integration test files.
- `README.md` documents the new endpoint, the new CLI command (with the three flags), and the new `jab/headless_kit/diagnostics_capability` filter under v0.7.1.
- `tests/README.md` lists the new check IDs as part of the integration coverage table.

## 10. Out of scope / future work

- `wp jab repair` auto-fix command.
- Surfacing the mcp-adapter default-server load-ordering quirk.
- Cache-plugin / CDN-plugin detection.
- Multi-site / multilingual diagnostics (Phase 8).
- A `--check=<slug>` flag for the CLI. With six checks running in milliseconds, "run the whole thing and grep" is enough; revisit if the catalog grows to 15+.
