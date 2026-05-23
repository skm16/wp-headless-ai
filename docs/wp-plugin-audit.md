# wp-plugin audit & remediation plan — `wp-headless-kit` v0.3.0

> **For the Claude Code session picking this up:** this is an audit of `packages/wp-plugin`,
> written to be actioned directly. Each finding has a stable ID, a severity, exact
> file locations, the root cause, a suggested fix, and a verification step. Code
> snippets are *illustrative* — confirm against the live source before applying.
> Work the findings in the order given in [§7 Suggested work order](#7-suggested-work-order).
>
> Audit date: 2026-05-23 · Audited commit: `acc7eca` (v0.3.0) · Scope: `packages/wp-plugin` only.
>
> **Remediation status:** all twelve actionable findings (SEC-1 / SEC-2 / SEC-3 / BUG-1 / BUG-2 / API-1 / ERR-1 / PERF-1 / DX-1 / META-1 / PROC-1 / WP7-2) resolved in **v0.4.0**, dated 2026-05-23. Two strategic items (WP7-1, WP7-3) deferred — see notes on each. PROC-1's PHPUnit integration suite scaffolded only (`packages/wp-plugin/tests/README.md`); the CI lint workflow ships now. See `packages/wp-plugin/README.md` §"What's new in 0.4.0" for the per-finding rollup, and `git log --grep="<finding-id>"` for the change.

---

## 1. Context

`wp-headless-kit` is the thin WordPress plugin in the monorepo's three-layer kit
(see root `CLAUDE.md`). It exposes site content as MCP abilities via the core
Abilities API + `wordpress/mcp-adapter`. ~2,170 lines of PHP across 9 files.

The plugin is well-built and on-strategy — see [§5 What's working](#5-whats-working).
This document is about the gaps. Nothing here requires a rewrite; the fixes are
targeted.

---

## 2. Findings summary

| ID | Severity | Status (v0.4.0) | Title |
| --- | --- | --- | --- |
| SEC-1 | **Critical** | ✅ Resolved | Draft / private content leaks through the `read`-only permission gate |
| BUG-1 | **High** | ✅ Resolved | Latent output-validation failures on empty `format`-constrained strings |
| API-1 | **High** | ✅ Resolved (breaking) | List-ability *names* derived from editor-editable, translatable labels |
| PROC-1 | **High** | ⚠️ Partial (CI lint ships; PHPUnit deferred) | No tests; CI does not lint |
| PERF-1 | Medium | ✅ Resolved | ACF schema regenerated on every request, for every CPT |
| DX-1 | Medium | ✅ Resolved | ACF field groups & types dropped silently — no diagnostic |
| SEC-2 | Medium | ✅ Resolved | `permission_callback` is hard-coded, not filterable |
| BUG-2 | Medium | ✅ Resolved | Ability-name collisions possible, no dedupe guard |
| ERR-1 | Medium | ✅ Resolved | Inconsistent error strategy — one ability throws, the rest return |
| SEC-3 | Low | ✅ Resolved | ACF `password` field type is exposed in output |
| META-1 | Low | ✅ Resolved | `Requires at least` floor is inconsistent across files |
| WP7-1 | Strategic | 🟡 Partial (floor raised; bundle retained — strategic call) | Drop the bundled `wordpress/abilities-api`; raise the WP floor |
| WP7-2 | Strategic | ✅ Verified | Verify Abilities API calls against WordPress 7.0 core |
| WP7-3 | Strategic | 🟡 Monitoring | MCP Adapter did **not** merge into core 7.0 — monitor |

---

## 3. Detailed findings

### SEC-1 — Draft / private content leaks through the permission gate (Critical)

**Status:** ✅ Resolved in v0.4.0. `Permissions::sanitize_post_status()` (`includes/Abilities/Permissions.php`) downgrades non-`publish` statuses unless the caller can `edit_posts` on the CPT; both `execute()` paths additionally pass `'perm' => 'readable'` to `get_posts()` as defence in depth.

**Where**
- `includes/Abilities/PostTypeListAbility.php` — `permission_callback` (~L67–69), `input_schema()` `post_status` enum (~L406–411), `execute()` `get_posts()` call (~L91–99)
- `includes/Abilities/PostTypeBySlugAbility.php` — `permission_callback` (~L66–68), `post_status` enum (~L144–149), `execute()` (~L96–105)

**Symptom**
Every ability's `permission_callback` is `current_user_can( 'read' )` — the
Subscriber-level capability. The list/by-slug input schemas accept
`post_status ∈ { publish, draft, any }`, and `execute()` passes that value
straight into `get_posts()` with no `perm` argument.

`get_posts( [ 'post_status' => 'draft' ] )` with no `perm` set returns **every
draft on the site**, regardless of author or the caller's capabilities —
`WP_Query` only applies an author/capability restriction to non-public statuses
when `perm` is `readable`/`editable`, which it never is here. So any account
that can reach the ability (Subscriber and up, authenticated via Application
Password) can enumerate all unpublished posts, pages, and CPT entries.

This matters especially for the target market (rare-disease non-profits), which
commonly run member/community accounts — i.e. real Subscriber-level users exist.

**Root cause**
The `post_status` trust boundary is delegated entirely to `WP_Query` default
behavior, but `WP_Query` does not gate explicitly-requested statuses without
`perm`. The plugin's own gate (`read`) is the lowest capability and does not
compensate.

**Suggested fix**
Enforce in `execute()` (the actual trust boundary — schema-side enums are also
used for discovery and shouldn't be the only guard). For both list and by-slug:

```php
$status = isset( $input['post_status'] ) ? (string) $input['post_status'] : 'publish';

// Non-public statuses require edit capability on the post type.
if ( 'publish' !== $status ) {
    $pt_object = get_post_type_object( (string) $config['post_type'] );
    $edit_cap  = $pt_object->cap->edit_posts ?? 'edit_posts';
    if ( ! current_user_can( $edit_cap ) ) {
        $status = 'publish';
    }
}
```

Alternative / additional hardening: pass `'perm' => 'readable'` to `get_posts()`
so `WP_Query` applies its own capability filtering as defence in depth.

Decide explicitly whether non-editors should see `draft`/`any` at all. For a v1
content API the conservative choice is to restrict the schema enum to
`[ 'publish' ]` and add the wider set back only behind a filter (see SEC-2).

**Verification**
- Add a regression test: a Subscriber-authenticated call with `post_status=draft`
  must return zero drafts (or `WP_Error`).
- Manual: create a draft as Admin, call `jab/get-posts` with `post_status=draft`
  as a Subscriber-scoped Application Password — confirm it is not returned.

---

### BUG-1 — Latent output-validation failures on empty `format`-constrained strings (High)

**Status:** ✅ Resolved in v0.4.0. Three-part fix: (1) `PostTypeListAbility::walk_and_enrich()` drops empty `format`-constrained strings for ACF fields; (2) new `resolve_date()` helper falls back through `post_date_gmt → post_date → post_modified_gmt → post_modified → gmdate('c')`; (3) `MenusAbility` `url` schema no longer carries `format: uri` (label-only parents have empty URLs).

**Where**
- `includes/Acf/Schema.php` — `to_field_schema()` cases for `url`/`email`/`date_picker`/`date_time_picker` (~L219–229)
- `includes/Abilities/MenusAbility.php` — menu item `url` is `required` + `format: uri` (~L137, L156–159)
- `includes/Abilities/PostTypeListAbility.php` — `shape_row()` `date` via `mysql_to_rfc3339( $post->post_date_gmt )` (~L135)

**Symptom**
This is the **next bug in the same family as the four already fixed in 0.3.0**
(see `packages/wp-plugin/README.md` §Schema-correctness fixes). WP core's
`rest_validate_value_from_schema` validates `format` keywords (`uri`, `email`,
`date-time`), and an empty string fails them. The recursive walker
(`walk_and_enrich`) checks *type* only, not *format*, so empty values pass the
walker and then get rejected by the adapter's output validation — failing the
whole ability call with an "invalid output" error.

Concrete triggers:
- An ACF `url` / `email` / `date_picker` field left blank → value is `""` →
  fails `format: uri` / `email` / `date`.
- A label-only nav menu item (a dropdown parent with no link) → `url` is `""` →
  fails `format: uri`, and `url` is in the menu item `required` array.
- A draft with no publish date → `post_date_gmt` is `0000-00-00 00:00:00` →
  `mysql_to_rfc3339()` yields an invalid datetime → fails `format: date-time`.
  (Interacts with SEC-1: only reachable once drafts are returned.)

**Root cause**
`format`-constrained string schemas are emitted unconditionally, but the runtime
values can legitimately be empty. Same class as the `const`-vs-`enum` and
`required`-but-unset bugs already documented.

**Suggested fix**
Pick one consistent strategy and apply it everywhere a `format` is emitted:
1. **Drop the value when empty** — extend `walk_and_enrich` so a node carrying a
   `format` keyword returns `null` (omit) for an empty string. Cleanest; relies
   on the field not being in a `required` list (ACF fields are not — verified).
2. **Don't emit `format` for optional fields** — keep `type: string`, drop
   `format`. Loses a little SDK richness but eliminates the failure mode.
3. For `MenusAbility` specifically: either drop `format: uri` from the menu item
   `url`, or coerce empty `url` to omit (but it's `required` — so prefer
   dropping `format`).
4. For the `date` field: guard `shape_row()` —
   `if ( ! $post->post_date_gmt || str_starts_with( $post->post_date_gmt, '0000' ) ) { … }`
   and either omit or fall back to `post_date`.

**Verification**
Add fixtures: a CPT with a blank ACF `url` field, a nav menu with a label-only
parent item, and a draft post. Each ability call against them must return valid
output. These belong in the test suite from PROC-1.

---

### API-1 — List-ability names derived from editor-editable, translatable labels (High)

**Status:** ✅ Resolved in v0.4.0 (**breaking change to ability names** — bumped minor). `Registry::derive_config_from_post_type()` now uses `WP_Post_Type->rest_base` (or slug fallback); `TaxonomyTermsAbility::register()` uses `WP_Taxonomy->rest_base` plus a `-terms` suffix. Labels still drive human-facing `label` / `description` only. Generated SDKs need `jab sync` after upgrade — flagged in README.

**Where**
- `includes/Registry.php` — `derive_config_from_post_type()` (~L202–239), specifically the `name` key (~L221) built from `$wrapper_plural`, which comes from `$plural_label` = `$object->labels->name`
- `includes/Abilities/TaxonomyTermsAbility.php` — `register()` builds `jab/get-<plural_kebab>` from the taxonomy label (~L31–38)

**Symptom**
The ability **name** — the stable identifier MCP clients call — is derived from
the post type's *plural label*. Labels are admin-editable and translated. So:
- On a non-English site, the `post` type yields `jab/get-articles`, not `jab/get-posts`.
- Any client who edits a CPT's label in wp-admin silently renames the ability
  and breaks every live MCP client and any previously generated SDK.

The by-slug ability (`PostTypeBySlugAbility`) correctly derives its name from
the stable post-type **slug**. The list ability and taxonomy ability do not —
inconsistent and fragile.

**Root cause**
Labels were used because they are conveniently already pluralized (slugs are
singular and would need a pluralizer). Convenience traded against a stable,
locale-independent public contract.

**Suggested fix**
Derive the ability **name** from the slug, not the label:
- List ability: `jab/get-<post_type_slug>` (slug is already stable/kebabbable).
  If a pluralized name is still wanted, pluralize the *slug* deterministically,
  or just accept `jab/get-<slug>` (singular slug, list semantics) — simpler and
  unambiguous.
- Taxonomy ability: `jab/get-<taxonomy_slug>` (or `-terms` suffix).
- Keep `label` / `description` / `wrapper_key` label-derived if desired — those
  are human-facing and may be locale-specific without harm. Only the **name**
  must be slug-stable.
- The existing `ability_configs` filter still lets agencies override names.

This is a **breaking change to ability names** — bump the plugin minor version,
note it in the README, and confirm the CLI generator / `jab sync` regenerates
cleanly against the new names.

**Verification**
Switch a test site's locale (or rename a CPT label) and confirm ability names
are unchanged.

---

### PROC-1 — No tests; CI does not lint (High)

**Status:** ⚠️ Partially resolved in v0.4.0. CI lint workflow ships (`.github/workflows/ci-plugin.yml`) and runs `composer lint` cleanly (the `phpcs.xml.dist` ruleset was tightened to match the codebase's actual house style — short arrays, slash-namespaced hooks, etc. — so CI is green from commit one). `packages/wp-plugin/tests/README.md` scaffolds the future PHPUnit + wp-env integration suite with a prioritized regression-test backlog. Full integration tests deferred — they need validation against a real WP instance.

**Where**
- No PHPUnit suite, no fixtures, no `tests/` directory anywhere in `packages/wp-plugin`.
- `.github/workflows/` contains only `release-cli.yml` and `release-plugin.yml`
  — release builders. `phpcs` exists as a Composer script (`composer lint`) but
  is **not run in CI**.

**Symptom**
The entire 0.3.0 release was correctness fixes discovered the hard way, yet
there is no automated guard against regressions. Every one of the four
documented bugs — plus BUG-1 — is a regression test waiting to be written.

**Root cause**
Pilot-speed scaffolding; tests were deferred.

**Suggested fix**
1. Add a PHPUnit setup using the WordPress test harness (`wp-env` or
   `yoast/wp-test-utils` + `WP_PHPUnit`). The plugin already depends on
   `php-stubs/wordpress-stubs` for static analysis — extend from there.
2. Write regression tests for the four 0.3.0 bugs (README has the
   symptom→cause table — turn each row into a test) and for BUG-1.
3. Add a CI workflow (`.github/workflows/ci-plugin.yml`) that runs
   `composer lint` and the PHPUnit suite on PRs touching `packages/wp-plugin/**`,
   on the PHP 7.4 minimum matched to the plugin's floor.

**Verification**
CI is green on a PR; intentionally reverting one 0.3.0 fix turns CI red.

---

### PERF-1 — ACF schema regenerated on every request, for every CPT (Medium)

**Status:** ✅ Resolved in v0.4.0. `AcfSchema::for_post_type()` caches in a transient keyed by `md5(post_type + field_groups_fingerprint())`, where the fingerprint hashes every field group's `key + modified` timestamp. Cache invalidates lazily when an admin saves a group; a sentinel distinguishes "no fields apply" from "cache miss."

**Where**
- `includes/Acf/Schema.php` — `for_post_type()` (~L84–99) → `collect_fields()` (~L107–137), called from both ability factories' `register()`.

**Symptom**
Abilities register on `wp_abilities_api_init`, which fires on **every** request
(front-end, admin, cron — not just MCP calls). `AcfSchema::for_post_type()` then
walks every ACF field group for every discovered CPT — `O(CPTs × groups × fields)`
of uncached work on requests that will never invoke an ability. On a content-heavy
agency site this is measurable overhead added site-wide.

**Root cause**
Schema generation is eager and uncached; it runs as a side effect of registration.

**Suggested fix**
Cache the generated ACF schema in a transient keyed by a hash of the ACF field
group definitions (so it invalidates when an admin edits a field group). Roughly:

```php
public static function for_post_type( string $post_type ): ?array {
    if ( ! self::is_active() ) {
        return null;
    }
    $cache_key = 'jab_acf_schema_' . md5( $post_type . '|' . self::field_groups_fingerprint() );
    $cached    = get_transient( $cache_key );
    if ( false !== $cached ) {
        return is_array( $cached ) ? $cached : null;
    }
    // … existing collect_fields() work …
    set_transient( $cache_key, $schema ?? '', HOUR_IN_SECONDS );
    return $schema;
}
```

`field_groups_fingerprint()` can hash `acf_get_field_groups()` keys + `modified`
timestamps. Confirm this still satisfies CLAUDE.md's "generated artifacts are
regenerable" expectation — `jab sync` should bust the cache or be unaffected.

**Verification**
Profile a front-end request with many CPTs/field groups before and after; the
ACF walk should not appear on a warm cache.

---

### DX-1 — ACF field groups & types dropped silently (Medium)

**Status:** ✅ Resolved in v0.4.0. `Schema::diagnostics()` returns a per-request ledger of skipped groups + dropped fields with post type, name, type, and reason. Gated on `WP_DEBUG` (or the `jab/headless_kit/acf_diagnostics` filter) so production memory stays flat; when on, also logs to `wp-content/debug.log`. Expected drops (tab/message/clone/etc.) don't generate noise; `password` drops are explicitly tagged with the SEC-3 reason.

**Where**
- `includes/Acf/Schema.php` — `group_applies_to_post_type()` (~L161–189) only
  matches a single `post_type ==` clause (plus page-implying rules);
  `to_field_schema()` `default:` case (~L340–342) returns `null` for unsupported
  types. README documents both as intentional v0 scope.

**Symptom**
Field groups with location rules more complex than one `post_type==` clause, and
unsupported field types, are dropped from the schema with **no diagnostic**.
Since the product's value is a correct generated SDK, this surfaces downstream
as "the AI can't see field X" mysteries with no breadcrumb. This is in tension
with CLAUDE.md's "errors are loud" convention — schema *omissions* are currently
silent.

**Root cause**
Silent `continue` / `return null` with no logging or reporting surface.

**Suggested fix**
Add a diagnostic surface (not a behavior change):
- A WP-CLI command (`wp jab doctor` or similar) or a debug-only ability that
  reports, per post type: which field groups matched, which were skipped and
  why (unsupported location rule), and which individual fields were dropped
  (unsupported type).
- Optionally emit a `_doing_it_wrong`-style admin notice when ACF is active but
  a field group targeting a discovered CPT was skipped.

**Verification**
On a site with a `page_template`-targeted group on a non-page CPT, the doctor
output names the skipped group and the reason.

---

### SEC-2 — `permission_callback` is hard-coded, not filterable (Medium)

**Status:** ✅ Resolved in v0.4.0. New `jab/headless_kit/ability_capability` filter, applied via `Permissions::ability_capability()`. All four ability classes route through `Permissions::gate()` so the filter applies uniformly.

**Where**
- All four ability factories: `PostTypeListAbility` (~L67–69),
  `PostTypeBySlugAbility` (~L66–68), `TaxonomyTermsAbility` (~L56–58),
  `MenusAbility::can_read()` (~L50–52). All return `current_user_can( 'read' )`.

**Symptom**
Every other axis of the plugin is filter-customizable (`post_type_excludes`,
`taxonomy_excludes`, `ability_configs`), but the permission gate — the one
security-relevant knob — is not. An agency cannot tighten it (e.g. require a
custom capability) or loosen it without forking.

**Suggested fix**
Route the capability through a filter, e.g.:

```php
$capability = (string) apply_filters(
    'jab/headless_kit/ability_capability',
    'read',
    $config['name'] ?? '',
    $config['post_type'] ?? ''
);
return current_user_can( $capability );
```

Pairs naturally with SEC-1: ship a conservative default and let agencies opt
into wider access deliberately. Document the new filter in the README.

**Verification**
A mu-plugin filter returning a custom capability changes who can call the ability.

---

### BUG-2 — Ability-name collisions possible, no dedupe guard (Medium)

**Status:** ✅ Resolved in v0.4.0. `Registry::ensure_unique_name()` reserves each name and suffixes `-2`, `-3`, … on collision, with a `_doing_it_wrong()` breadcrumb so the agency dev notices. `TaxonomyTermsAbility::register()` accepts an optional `$name_resolver` callable so the dedupe guard composes cleanly. Largely defused by API-1's structural namespace separation (`-terms` suffix).

**Where**
- `includes/Registry.php` — `register_abilities()` (~L112–120) loops CPT configs
  then registers taxonomy abilities; `TaxonomyTermsAbility::register()` and
  `PostTypeListAbility::register()` both produce `jab/get-<plural>` names.

**Symptom**
List-ability names and taxonomy-ability names both resolve to the pattern
`jab/get-<plural>`. A CPT and a taxonomy whose plural labels collapse to the
same string (or two CPTs with colliding pluralized labels) produce duplicate
ability names. `wp_register_ability()` is called twice with the same name and
the second silently overwrites or triggers `_doing_it_wrong` — with no guard.

**Root cause**
Names are derived independently per source with no global uniqueness check.
Compounded by API-1 (label-derived names are less predictable).

**Suggested fix**
Largely mitigated by fixing API-1 (slug-based names are far less collision-prone
and namespaced by source). Additionally, have `Registry` track registered names
and, on a collision, either suffix deterministically (`-2`) or skip-and-warn via
the DX-1 diagnostic. Taxonomy abilities could also adopt a distinct prefix
(e.g. `jab/get-<slug>-terms`) to structurally separate the namespaces.

**Verification**
Register a CPT and a taxonomy that would collide; confirm both abilities exist
with distinct names.

---

### ERR-1 — Inconsistent error strategy (Medium)

**Status:** ✅ Resolved in v0.4.0. `TaxonomyTermsAbility::execute()` no longer throws `\RuntimeException` — returns `{ <wrapper>: [] }` plus a `_doing_it_wrong()` breadcrumb on `get_terms()` failure. Every ability in the plugin now has the same failure contract: return data, never throw.

**Where**
- `includes/Abilities/TaxonomyTermsAbility.php` — `execute()` throws
  `\RuntimeException` on a `get_terms()` `WP_Error` (~L92–101).
- All other abilities never throw; they return arrays.

**Symptom**
One ability throws a raw exception out of its execute callback while the rest
return data. Depending on how `wordpress/mcp-adapter` wraps callbacks, an
uncaught `RuntimeException` is a potential fatal rather than a clean MCP error
response. Inconsistent contract.

**Suggested fix**
Confirm what the adapter expects from a failing execute callback (a `WP_Error`
return, a specific exception type, or a thrown `\Throwable` it catches) and make
all four abilities consistent. `get_terms()` rarely errors (only on an invalid
taxonomy, which auto-discovery makes unlikely), so a graceful empty-list return
plus the DX-1 diagnostic may be the simplest consistent choice.

**Verification**
Force a `get_terms()` failure and confirm the MCP response is a clean error, not
a 500 / fatal.

---

### SEC-3 — ACF `password` field exposed in output (Low)

**Status:** ✅ Resolved in v0.4.0. `password` was removed from the string-bucket case in `to_field_schema()` and falls through to `default: return null` like `tab` / `message` / `clone`. DX-1 records the drop with an explicit reason ("password fields are not exposed via the headless API (SEC-3)") so admins discover *why* the field disappeared. README updated.

**Where**
- `includes/Acf/Schema.php` — `to_field_schema()` maps `password` → `type: string`
  alongside `text`/`textarea`/etc. (~L209–210).

**Symptom**
An ACF `password` field is emitted into the `acf` output object and populated
via `get_fields()`, which returns it in plaintext. If an agency ever uses an ACF
password field to hold a secret, it is exposed through the headless API.

**Root cause**
`password` is bucketed with ordinary string field types.

**Suggested fix**
Drop `password` from the string group and let it fall through to the
`default: return null` (silently skipped, like `tab`/`message`). If there's a
legitimate need to expose it, gate it behind an explicit filter.

**Verification**
A post type with an ACF `password` field produces no `password` key in `acf`.

---

### META-1 — Inconsistent WP version floor (Low)

**Status:** ✅ Resolved in v0.4.0. All three places now agree on **6.9**: plugin header `Requires at least: 6.9`, `phpcs.xml.dist`'s `minimum_supported_wp_version` (already 6.9), and README "WordPress 6.9+".

**Where**
- `wp-headless-kit.php` header — `Requires at least: 6.6` (~L7)
- `phpcs.xml.dist` — `minimum_supported_wp_version` = `6.9`
- `packages/wp-plugin/README.md` — "WordPress **6.6+**"

**Symptom**
Three sources disagree on the supported WP floor. phpcs will flag use of
6.7–6.9 APIs as too-new while the header claims 6.6.

**Suggested fix**
Pick one floor and align all three. This decision is coupled to WP7-1 below —
resolve them together.

---

## 4. WordPress 7.0 — does it change how the plugin is built?

**Short answer: the WP 7.0 AI Client does not change the design — it points the
opposite direction — but WP 7.0 does justify two concrete changes and reframes
one strategic bet.**

The WP 7.0 **AI Client** (`wp_ai_client_prompt()`) makes WordPress an AI
*consumer*: plugins send prompts to models and receive text/images. This plugin
makes WordPress an AI *data source*: it exposes content as MCP abilities. They
are orthogonal. Nothing in the AI Client's prompt-builder API is something this
plugin should adopt — it does not generate content. The new **Connectors API**
(outbound provider credentials) is likewise irrelevant; inbound auth stays
Application Passwords, which remains correct.

What does matter:

### WP7-1 — Drop the bundled `wordpress/abilities-api`; raise the WP floor (Strategic)

**Status:** 🟡 Partially addressed in v0.4.0. The WP floor was raised to **6.9** (META-1), which is the prerequisite. **The bundled `wordpress/abilities-api` Composer dependency is intentionally retained for now** — dropping it changes how the plugin loads on the pre-6.9 long tail at install time, and the call is a strategic one that needs at-minimum a confirmed pilot-customer survey before committing. Track as a follow-up for v0.5.0.

**Where:** `composer.json` requires `wordpress/abilities-api: ^0.4` (locked at
`v0.4.0`); `wp-headless-kit.php` bundles it via Jetpack Autoloader for pre-6.9
support.

The Abilities API has been in **core since WP 6.9**, and WP 7.0 (released
2026-05-20) expanded it. Bundling `abilities-api` now serves only a shrinking
pre-6.9 long tail, and the WP 7.0 AI Client dev-note explicitly describes the
duplicate-class-definition conflict class that bundling a now-in-core package
creates. Recommendation: raise `Requires at least` to **6.9** (or **7.0**),
remove the `wordpress/abilities-api` Composer dependency, and align META-1.
This makes the plugin thinner and removes a whole dual-load failure mode —
squarely in line with CLAUDE.md's "the plugin should be boring."

*Trade-off:* loses pre-6.9 sites. For new headless builds in mid-2026 that is a
small, shrinking set — but confirm no current/near-term pilot client is pinned
below 6.9 before committing.

### WP7-2 — Verify Abilities API calls against WordPress 7.0 core (Strategic)

**Status:** ✅ Verified in v0.4.0. The bundled `wordpress/abilities-api v0.4.0` declares `@since 6.9.0` on both `wp_register_ability()` and `wp_register_ability_category()`; hook names `wp_abilities_api_init` + `wp_abilities_api_categories_init` are stable since 6.9. No code change needed.

The plugin pins `abilities-api v0.4.0`, but core 7.0 ships its own version of
the API. **Before anything else, confirm the plugin's calls still match core
7.0**: `wp_register_ability()`, `wp_register_ability_category()`, and the
`wp_abilities_api_init` / `wp_abilities_api_categories_init` hook names. If core
renamed a hook or changed a signature, the plugin would silently register
nothing on a 7.0 site. This is a fast check and should gate the next release.

### WP7-3 — MCP Adapter did not merge into core 7.0 — monitor (Strategic)

**Status:** 🟡 Monitoring (no action). Nothing in WP 7.0 changed; revisit when the next WP release notes drop.

The **MCP Adapter remains a separate companion package** in WP 7.0 — it was not
absorbed into core. This validates the plugin's layer-1 reason to exist. But it
is the thing to watch: if a future release folds MCP into core, layer 1 shrinks
to "opinionated abilities + manifest endpoint," which only reinforces CLAUDE.md's
coaching that the moat is the developer experience and agency playbook, not the
plugin code.

*Free tailwind (no action):* because the plugin's abilities register through the
core Abilities API, in 7.0 they are also discoverable by on-site AI features and
the new client-side Abilities API — a second consumer at no code cost. This does
not change how the plugin is built, but it does raise the stakes on the
permission model — another reason SEC-1 is the top priority.

---

## 5. What's working (do not regress)

- **Genuinely thin bootstrap.** `wp-headless-kit.php` does three things and bails
  loudly with admin notices on missing deps. Transport/JSON-RPC/sessions are
  fully delegated to `mcp-adapter`. Keep it this way.
- **Zero-config auto-discovery** of public post types and taxonomies — the
  drop-in-and-it-works experience is the product's strength.
- **Filter-based customization** (`post_type_excludes`, `taxonomy_excludes`,
  `ability_configs`) from a single mu-plugin — the agency playbook done right.
- **The 0.3.0 schema-correctness fixes** are well-reasoned; `pick_variant()`
  accepting both `const` and `enum` for backward compatibility is mature.
- **N+1 avoidance** in `batch_terms()`; **defensive guards** throughout;
  **HTML-entity decoding** of titles/terms for headless consumers.
- **Build tooling** handles the Windows zip-path-separator minefield and fails
  fast on missing tools / missing autoloader output.

Any fix below must preserve these properties — especially the thin-plugin
boundary and the regenerability of generated artifacts.

---

## 6. Cross-cutting note for the implementing session

Several findings are members of one family: **runtime values that don't match
the schema the plugin promised** (BUG-1, and the four already fixed in 0.3.0).
The durable fix is not another point patch — it is the test suite from PROC-1
plus a decision on one consistent strategy for optional/empty values. Treat
PROC-1 as the foundation the other bug fixes land on.

---

## 7. Suggested work order

1. **WP7-2** — verify Abilities API calls against core 7.0. Fast; gates everything else.
2. **PROC-1** — stand up PHPUnit + WP test harness + CI lint. Foundation for the rest.
3. **SEC-1** — close the draft/private content leak. Highest user-facing risk.
4. **BUG-1** — fix the empty-`format`-string failures (write the tests first, per PROC-1).
5. **API-1** — move ability names to slug-based derivation (breaking; bump minor version, coordinate with the CLI generator).
6. **WP7-1 + META-1** — drop the bundled `abilities-api`, raise and align the WP floor.
7. **SEC-2, BUG-2, ERR-1, PERF-1, DX-1, SEC-3** — medium/low items; SEC-2 pairs naturally with SEC-1, BUG-2 is largely resolved by API-1.

Each finding above has its own **Verification** step — satisfy it (ideally as an
automated test) before marking the finding done.
