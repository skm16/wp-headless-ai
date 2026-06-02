<?php
/**
 * RegistryRestBaseSlugCollisionTest — FIX-4 (v0.6.2) regression coverage.
 *
 * FIX-4: when a CPT has rest_base equal to its slug (the default for
 * plugin-registered CPTs that don't set rest_base), Registry::register_abilities()
 * used to run ensure_unique_name() on both `name` AND `name_single` in the
 * same iteration. Since both derive identically when rest_base == slug, the
 * second call falsely flagged a collision and renamed name_single to
 * `<name>-2`. The mangled base flowed into derive_by_slug_config() and
 * produced jab/get-{slug}-2-by-slug.
 *
 * This test uses the `book` CPT registered by the fixtures mu-plugin
 * (rest_base unset, defaulting to the slug "book"). After the fix, the
 * registered names MUST be jab/get-book and jab/get-book-by-slug; the
 * pre-fix names jab/get-book-2 and jab/get-book-2-by-slug MUST NOT exist.
 *
 * No execute_ability() / dispatch_rest() — this is a pure registration-state
 * assertion via wp_get_ability().
 *
 * @package Jab\WpHeadlessKit\Tests\Integration\Abilities
 */

declare( strict_types=1 );

final class RegistryRestBaseSlugCollisionTest extends IntegrationTestCase {

    public function test_by_slug_ability_name_is_stable_when_rest_base_equals_slug(): void {
        $this->assertNotNull(
            wp_get_ability( 'jab/get-book-by-slug' ),
            'jab/get-book-by-slug should be registered when the `book` CPT has rest_base == slug.'
        );
        // wp_get_ability() fires _doing_it_wrong when the name is absent —
        // declare the expected notice so the test framework doesn't fail on it.
        $this->setExpectedIncorrectUsage( 'WP_Abilities_Registry::get_registered' );
        $this->assertNull(
            wp_get_ability( 'jab/get-book-2-by-slug' ),
            'jab/get-book-2-by-slug is the pre-FIX-4 mangled name and must NOT be registered.'
        );
    }

    public function test_list_ability_name_is_stable_when_rest_base_equals_slug(): void {
        $this->assertNotNull(
            wp_get_ability( 'jab/get-book' ),
            'jab/get-book should be registered.'
        );
        // wp_get_ability() fires _doing_it_wrong when the name is absent —
        // declare the expected notice so the test framework doesn't fail on it.
        $this->setExpectedIncorrectUsage( 'WP_Abilities_Registry::get_registered' );
        $this->assertNull(
            wp_get_ability( 'jab/get-book-2' ),
            'jab/get-book-2 is the pre-FIX-4 mangled name and must NOT be registered.'
        );
    }
}
