<?php
/**
 * PostTypeListAbilityTest — covers BUG-1 (resolve_date, value_matches_format).
 *
 * Both methods are private — exercised through reflection. They're pure
 * logic with no WP dependencies beyond `mysql_to_rfc3339`, which the
 * bootstrap stubs.
 *
 * @package Jab\WpHeadlessKit\Tests
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Abilities;

use Jab\WpHeadlessKit\Abilities\PostTypeListAbility;
use PHPUnit\Framework\TestCase;
use ReflectionMethod;

final class PostTypeListAbilityTest extends TestCase {

	protected function setUp(): void {
		\jab_wphk_reset_stubs();
	}

	/**
	 * @return mixed
	 */
	private function invoke_private( string $method_name, array $args ) {
		$method = new ReflectionMethod( PostTypeListAbility::class, $method_name );
		$method->setAccessible( true );
		return $method->invokeArgs( null, $args );
	}

	private function fake_post( array $overrides = [] ): \WP_Post {
		// WP_Post is stubbed in bootstrap.php as a stdClass-extending shell so
		// the production type hint `\WP_Post` is satisfied without booting WP.
		$post = new \WP_Post();
		$defaults = [
			'post_date_gmt'     => '',
			'post_date'         => '',
			'post_modified_gmt' => '',
			'post_modified'     => '',
		];
		foreach ( array_merge( $defaults, $overrides ) as $key => $value ) {
			$post->{$key} = $value;
		}
		return $post;
	}

	// ------------------------------------------------------------------
	// resolve_date — BUG-1
	// ------------------------------------------------------------------

	public function test_resolve_date_prefers_post_date_gmt_when_valid(): void {
		$post = $this->fake_post( [
			'post_date_gmt'     => '2026-05-23 10:00:00',
			'post_date'         => '2026-05-23 06:00:00',
			'post_modified_gmt' => '2026-05-24 10:00:00',
		] );

		$this->assertSame(
			'2026-05-23T10:00:00',
			$this->invoke_private( 'resolve_date', [ $post ] )
		);
	}

	public function test_resolve_date_falls_back_to_post_date_when_gmt_is_zero(): void {
		// BUG-1 regression: drafts often have post_date_gmt = '0000-00-00 00:00:00'
		// while post_date carries the user's local-time draft creation stamp.
		$post = $this->fake_post( [
			'post_date_gmt' => '0000-00-00 00:00:00',
			'post_date'     => '2026-05-23 06:00:00',
		] );

		$result = $this->invoke_private( 'resolve_date', [ $post ] );
		$this->assertStringStartsWith( '2026-05-23', $result );
	}

	public function test_resolve_date_falls_back_to_modified_when_both_dates_zero(): void {
		$post = $this->fake_post( [
			'post_date_gmt'     => '0000-00-00 00:00:00',
			'post_date'         => '0000-00-00 00:00:00',
			'post_modified_gmt' => '2026-05-23 10:00:00',
		] );

		$this->assertSame(
			'2026-05-23T10:00:00',
			$this->invoke_private( 'resolve_date', [ $post ] )
		);
	}

	public function test_resolve_date_returns_unix_epoch_when_all_candidates_unusable(): void {
		// M4 regression: a missing-date fallback must NOT synthesize "now",
		// which would corrupt downstream sort logic. Epoch is schema-valid
		// AND obviously sentinel-shaped.
		$post = $this->fake_post( [
			'post_date_gmt'     => '0000-00-00 00:00:00',
			'post_date'         => '0000-00-00 00:00:00',
			'post_modified_gmt' => '0000-00-00 00:00:00',
			'post_modified'     => '0000-00-00 00:00:00',
		] );

		$this->assertSame(
			'1970-01-01T00:00:00+00:00',
			$this->invoke_private( 'resolve_date', [ $post ] )
		);
	}

	public function test_resolve_date_skips_empty_strings(): void {
		$post = $this->fake_post( [
			'post_date_gmt' => '',
			'post_date'     => '2026-05-23 06:00:00',
		] );

		$result = $this->invoke_private( 'resolve_date', [ $post ] );
		$this->assertStringStartsWith( '2026-05-23', $result );
	}

	// value_matches_format tests moved to AcfValueWalkerTest in v0.6
	// when the walker was extracted from PostTypeListAbility.
}
