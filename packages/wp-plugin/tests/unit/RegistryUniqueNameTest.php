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

	public function test_distinct_names_never_collide(): void {
		$this->assertSame( 'jab/get-posts', Registry::ensure_unique_name( 'jab/get-posts' ) );
		$this->assertSame( 'jab/get-beers', Registry::ensure_unique_name( 'jab/get-beers' ) );
		$this->assertSame( 'jab/get-events', Registry::ensure_unique_name( 'jab/get-events' ) );
		$this->assertEmpty( $GLOBALS['_jab_test_doing_it_wrong'] );
	}
}
