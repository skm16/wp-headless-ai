<?php
/**
 * RegistryUniqueNameTest — covers BUG-2 (ensure_unique_name dedupe).
 *
 * Uses reflection to reset the private `$claimed_names` static between
 * cases so each test starts clean — Registry exposes no public reset to
 * keep its production surface minimal.
 *
 * @package Jab\WpHeadlessKit\Tests
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests;

use Jab\WpHeadlessKit\Registry;
use PHPUnit\Framework\TestCase;
use ReflectionClass;

final class RegistryUniqueNameTest extends TestCase {

	protected function setUp(): void {
		\jab_wphk_reset_stubs();
		// Reset Registry's private static; otherwise the second test sees
		// the first test's claimed names.
		$ref  = new ReflectionClass( Registry::class );
		$prop = $ref->getProperty( 'claimed_names' );
		$prop->setAccessible( true );
		$prop->setValue( null, [] );
	}

	public function test_first_claim_returns_name_unchanged(): void {
		$this->assertSame(
			'jab/get-posts',
			Registry::ensure_unique_name( 'jab/get-posts' )
		);
	}

	public function test_empty_input_passes_through(): void {
		// Edge case — empty names are an upstream bug, but we shouldn't
		// claim them or rewrite them.
		$this->assertSame( '', Registry::ensure_unique_name( '' ) );
	}

	public function test_second_claim_suffixes_with_2(): void {
		Registry::ensure_unique_name( 'jab/get-posts' );

		$this->assertSame(
			'jab/get-posts-2',
			Registry::ensure_unique_name( 'jab/get-posts' )
		);
	}

	public function test_third_claim_suffixes_with_3(): void {
		Registry::ensure_unique_name( 'jab/get-posts' );
		Registry::ensure_unique_name( 'jab/get-posts' );

		$this->assertSame(
			'jab/get-posts-3',
			Registry::ensure_unique_name( 'jab/get-posts' )
		);
	}

	public function test_collision_with_explicitly_registered_suffix(): void {
		// An agency that already claimed jab/get-posts-2 (via ability_configs
		// filter) shouldn't have it overwritten when the auto-discoverer
		// happens to suffix.
		Registry::ensure_unique_name( 'jab/get-posts' );
		Registry::ensure_unique_name( 'jab/get-posts-2' );

		$this->assertSame(
			'jab/get-posts-3',
			Registry::ensure_unique_name( 'jab/get-posts' )
		);
	}

	public function test_collision_emits_doing_it_wrong_breadcrumb(): void {
		Registry::ensure_unique_name( 'jab/get-posts' );
		Registry::ensure_unique_name( 'jab/get-posts' );

		$this->assertNotEmpty(
			$GLOBALS['_jab_test_doing_it_wrong'],
			'A collision must surface via _doing_it_wrong() so the agency dev notices.'
		);
		$last = end( $GLOBALS['_jab_test_doing_it_wrong'] );
		$this->assertStringContainsString( 'jab/get-posts', $last['message'] );
		$this->assertStringContainsString( 'jab/get-posts-2', $last['message'] );
	}

	/**
	 * @param array<string, mixed> $props
	 */
	private static function make_post_type( array $props ): \WP_Post_Type {
		$pt = new \WP_Post_Type();
		foreach ( $props as $k => $v ) {
			$pt->$k = $v;
		}
		return $pt;
	}

	public function test_distinct_names_never_collide(): void {
		$this->assertSame( 'jab/get-posts', Registry::ensure_unique_name( 'jab/get-posts' ) );
		$this->assertSame( 'jab/get-beers', Registry::ensure_unique_name( 'jab/get-beers' ) );
		$this->assertSame( 'jab/get-events', Registry::ensure_unique_name( 'jab/get-events' ) );
		$this->assertEmpty( $GLOBALS['_jab_test_doing_it_wrong'] );
	}

	/**
	 * BUG-3 regression (v0.6.2): when a CPT has rest_base == slug (the common
	 * case for plugin-registered CPTs that don't bother setting an explicit
	 * plural rest_base), `name` and `name_single` derive to the same string.
	 * Pre-fix register_abilities() called ensure_unique_name() on BOTH inside
	 * the same loop iteration, falsely flagging the second as a collision and
	 * renaming `name_single` to `<name>-2`. That mangled base flowed into
	 * derive_by_slug_config(), producing `jab/get-beer-2-by-slug` instead of
	 * the expected `jab/get-beer-by-slug` — breaking every client that derives
	 * by-slug names from the CPT slug (the documented convention).
	 *
	 * This test walks the post-fix claim sequence by reflection, asserting
	 * the derived by-slug name is correct.
	 */
	public function test_by_slug_name_unaffected_when_rest_base_equals_slug(): void {
		$post_type_object = self::make_post_type( [
			'name'      => 'beer',
			'rest_base' => 'beer', // same as slug — collision risk pre-fix
			'labels'    => (object) [ 'name' => 'Beers', 'singular_name' => 'Beer' ],
		] );

		$ref = new ReflectionClass( Registry::class );

		$derive = $ref->getMethod( 'derive_config_from_post_type' );
		$derive->setAccessible( true );
		$config = $derive->invoke( null, $post_type_object );

		// Both names derive identically when rest_base == slug.
		$this->assertSame( 'jab/get-beer', $config['name'] );
		$this->assertSame( 'jab/get-beer', $config['name_single'] );

		// Walk the post-fix claim sequence from register_abilities():
		//   1) claim `name` (the list ability)
		//   2) DO NOT claim `name_single` — it's a derivation base, not an ability name
		//   3) derive and claim the by-slug name
		$config['name'] = Registry::ensure_unique_name( (string) $config['name'] );
		$this->assertSame( 'jab/get-beer', $config['name'] );

		$config['name_single'] = (string) $config['name_single']; // pass-through, no claim

		$derive_by_slug = $ref->getMethod( 'derive_by_slug_config' );
		$derive_by_slug->setAccessible( true );
		$by_slug_config         = $derive_by_slug->invoke( null, $config );
		$by_slug_config['name'] = Registry::ensure_unique_name( (string) $by_slug_config['name'] );

		// Pre-fix this would be 'jab/get-beer-2-by-slug'. Post-fix it is clean.
		$this->assertSame(
			'jab/get-beer-by-slug',
			$by_slug_config['name'],
			'When rest_base == slug, the by-slug ability must NOT inherit a "-2-" suffix from a phantom name_single collision.'
		);

		// Sanity: no _doing_it_wrong was triggered (no real collision occurred).
		$this->assertEmpty(
			$GLOBALS['_jab_test_doing_it_wrong'],
			'A CPT with rest_base == slug is not an agency mistake; it must not produce a _doing_it_wrong breadcrumb.'
		);
	}

	/**
	 * Companion to test_by_slug_name_unaffected_when_rest_base_equals_slug —
	 * verifies the explicit-plural path (rest_base != slug) keeps working
	 * exactly as before. Defends against an over-correction that breaks the
	 * happy path.
	 */
	public function test_by_slug_name_with_explicit_plural_rest_base(): void {
		$post_type_object = self::make_post_type( [
			'name'      => 'page',
			'rest_base' => 'pages',
			'labels'    => (object) [ 'name' => 'Pages', 'singular_name' => 'Page' ],
		] );

		$ref    = new ReflectionClass( Registry::class );
		$derive = $ref->getMethod( 'derive_config_from_post_type' );
		$derive->setAccessible( true );
		$config = $derive->invoke( null, $post_type_object );

		$this->assertSame( 'jab/get-pages', $config['name'] );
		$this->assertSame( 'jab/get-page', $config['name_single'] );

		$config['name']        = Registry::ensure_unique_name( (string) $config['name'] );
		$config['name_single'] = (string) $config['name_single'];

		$derive_by_slug = $ref->getMethod( 'derive_by_slug_config' );
		$derive_by_slug->setAccessible( true );
		$by_slug_config         = $derive_by_slug->invoke( null, $config );
		$by_slug_config['name'] = Registry::ensure_unique_name( (string) $by_slug_config['name'] );

		$this->assertSame( 'jab/get-page-by-slug', $by_slug_config['name'] );
	}
}
