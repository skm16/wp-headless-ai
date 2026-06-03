<?php
/**
 * jab-test-fixtures — Integration-test fixtures mu-plugin.
 *
 * THIS FILE IS A TEST FIXTURE, NOT PLUGIN SOURCE.
 *
 * It lives under tests/ but executes inside WordPress because wp-env mounts
 * it at wp-content/mu-plugins/jab-test-fixtures.php via the .wp-env.json
 * `mappings` declaration. mu-plugins load on every request, so any post
 * type, taxonomy, or option registered here is available to every
 * integration test.
 *
 * Keep this file minimal and deterministic: each fixture's existence is
 * a public contract that test files depend on by name.
 *
 * @package Jab\WpHeadlessKit\Tests\Integration\Fixtures
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
    return;
}

/**
 * Register a `book` CPT whose `rest_base` is unset, defaulting to the slug
 * `book`. This reproduces the FIX-4 (v0.6.2) regression target: a CPT where
 * rest_base == slug used to make the Registry's collision dedupe rename the
 * by-slug ability to `jab/get-book-2-by-slug` instead of preserving the
 * documented `jab/get-book-by-slug` name. The integration tests assert the
 * post-fix name is reachable.
 */
// Priority 5 is load-bearing: the CPT must be registered BEFORE
// wp_abilities_api_init fires the Registry discovery pass on init @ 10.
add_action( 'init', static function (): void {
    register_post_type( 'book', [
        'label'        => 'Books',
        'public'       => true,
        'show_in_rest' => true,
        // No rest_base — WP defaults to the slug.
        'supports'     => [ 'title', 'editor', 'excerpt' ],
    ] );
}, 5 );

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
