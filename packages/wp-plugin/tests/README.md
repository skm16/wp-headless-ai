# wp-plugin tests

Two layers of test coverage are intended (PROC-1 in `docs/wp-plugin-audit.md`):

1. **Pure unit tests** — exercise pure functions that don't need a WordPress
   runtime (e.g. ACF schema generation from a fixture field group, ability-name
   derivation from a fake `WP_Post_Type` shape). Run with plain PHPUnit, no
   harness required. This directory's `unit/` folder is the home for these.
2. **WordPress integration tests** — exercise `permission_callback` against a
   real `wp_set_current_user()` + Application Password, exercise `execute()`
   end-to-end with seeded posts and ACF groups. These need `wp-env` or
   `WP_PHPUnit` and are a follow-up.

## Running the unit tests locally

```bash
cd packages/wp-plugin
composer install
./vendor/bin/phpunit --configuration tests/phpunit-unit.xml.dist
```

The unit suite is what runs in CI today. The integration suite has yet to
be wired; track that under PROC-1 in `docs/wp-plugin-audit.md`.

## Regression tests to add (priority order)

Each row in `packages/wp-plugin/README.md` §"Schema-correctness fixes baked
into source" should map to one integration test. Plus BUG-1 from the audit:

- Empty ACF `url` / `email` / `date_picker` field → ability call must succeed.
- Nav menu with a label-only parent item → `jab/get-menus` must succeed.
- Draft post with `0000-00-00 00:00:00` post_date_gmt → list ability must not
  emit an invalid `date-time`.
- SEC-1: Subscriber-authenticated call with `post_status=draft` must return zero
  drafts (regression for the cap-check fix in `execute()`).
