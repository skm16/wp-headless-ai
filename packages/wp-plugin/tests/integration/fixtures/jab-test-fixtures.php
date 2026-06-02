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
add_action( 'init', static function (): void {
    register_post_type( 'book', [
        'label'        => 'Books',
        'public'       => true,
        'show_in_rest' => true,
        // No rest_base — WP defaults to the slug.
        'supports'     => [ 'title', 'editor', 'excerpt' ],
    ] );
}, 5 );
