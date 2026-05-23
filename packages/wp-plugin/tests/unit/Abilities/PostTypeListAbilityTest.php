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

	// ------------------------------------------------------------------
	// value_matches_format — BUG-1 (H1 follow-up)
	// ------------------------------------------------------------------

	/**
	 * @dataProvider format_uri_cases
	 *
	 * @param mixed $value
	 */
	public function test_format_uri( $value, bool $expected ): void {
		$this->assertSame(
			$expected,
			$this->invoke_private( 'value_matches_format', [ $value, 'uri' ] )
		);
	}

	public function format_uri_cases(): array {
		return [
			'absolute https' => [ 'https://example.com/path', true ],
			'absolute http'  => [ 'http://example.com', true ],
			'empty string'   => [ '', false ],
			'plain word'     => [ 'not-a-url', false ],
			'non-string'     => [ 42, false ],
		];
	}

	/**
	 * @dataProvider format_email_cases
	 *
	 * @param mixed $value
	 */
	public function test_format_email( $value, bool $expected ): void {
		$this->assertSame(
			$expected,
			$this->invoke_private( 'value_matches_format', [ $value, 'email' ] )
		);
	}

	public function format_email_cases(): array {
		return [
			'valid email'      => [ 'sean@example.com', true ],
			'subdomain email'  => [ 'a@b.co.uk', true ],
			'empty string'    => [ '', false ],
			'missing at-sign' => [ 'sean.example.com', false ],
		];
	}

	/**
	 * H1 regression: a non-empty but malformed `format: date` value used to
	 * pass through the walker and crash REST output validation downstream.
	 * The most common case in the wild is ACF date_picker's default Ymd
	 * storage format.
	 *
	 * @dataProvider format_date_cases
	 *
	 * @param mixed $value
	 */
	public function test_format_date( $value, bool $expected ): void {
		$this->assertSame(
			$expected,
			$this->invoke_private( 'value_matches_format', [ $value, 'date' ] )
		);
	}

	public function format_date_cases(): array {
		return [
			'iso 8601 date'   => [ '2026-05-23', true ],
			'acf default Ymd' => [ '20260523', false ],
			'datetime form'   => [ '2026-05-23T10:00:00', false ],
			'empty string'    => [ '', false ],
		];
	}

	/**
	 * @dataProvider format_datetime_cases
	 *
	 * @param mixed $value
	 */
	public function test_format_date_time( $value, bool $expected ): void {
		$this->assertSame(
			$expected,
			$this->invoke_private( 'value_matches_format', [ $value, 'date-time' ] )
		);
	}

	public function format_datetime_cases(): array {
		return [
			'rfc 3339 with offset' => [ '2026-05-23T10:00:00+00:00', true ],
			'rfc 3339 zulu'        => [ '2026-05-23T10:00:00Z', true ],
			'no offset'            => [ '2026-05-23T10:00:00', true ],
			'date only'            => [ '2026-05-23', false ],
			'all zeros'            => [ '0000-00-00T00:00:00', true ],
			// Note: '0000-00-00T00:00:00' matches the regex but is semantically
			// invalid. resolve_date() filters these *before* they reach this
			// function — the responsibility split is intentional and tested in
			// test_resolve_date_falls_back_to_modified_when_both_dates_zero().
			'empty'                => [ '', false ],
		];
	}

	public function test_unknown_format_passes_through(): void {
		// Permissive on unknown formats so adding a new schema emitter doesn't
		// silently start dropping values that this validator hasn't learned.
		$this->assertTrue(
			$this->invoke_private( 'value_matches_format', [ 'anything', 'uuid' ] )
		);
	}
}
