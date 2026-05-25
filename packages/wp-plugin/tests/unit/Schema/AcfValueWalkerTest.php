<?php
/**
 * AcfValueWalkerTest — smoke test that the extracted walker behaves
 * identically to the private walk_and_enrich path it replaced. Heavy
 * coverage of edge cases lives in PostTypeListAbilityTest (resolve_date,
 * format validation) — this file only verifies the extraction is
 * behavior-preserving.
 *
 * @package Jab\WpHeadlessKit\Tests
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Schema;

use Jab\WpHeadlessKit\Schema\AcfValueWalker;
use PHPUnit\Framework\TestCase;

final class AcfValueWalkerTest extends TestCase {

	protected function setUp(): void {
		\jab_wphk_reset_stubs();
	}

	public function test_passes_scalar_value_through_when_type_matches(): void {
		$schema = [ 'type' => 'string' ];
		$this->assertSame( 'hello', AcfValueWalker::walk( 'hello', $schema ) );
	}

	public function test_drops_scalar_value_when_type_does_not_match(): void {
		$schema = [ 'type' => 'integer' ];
		$this->assertNull( AcfValueWalker::walk( 'not-an-int', $schema ) );
	}

	public function test_walks_object_properties_against_schema(): void {
		$schema = [
			'type'       => 'object',
			'properties' => [
				'a' => [ 'type' => 'string' ],
				'b' => [ 'type' => 'integer' ],
			],
		];
		$value = [ 'a' => 'x', 'b' => 7, 'extra' => 'kept-if-allowed' ];
		$out   = AcfValueWalker::walk( $value, $schema );
		$this->assertSame( 'x', $out['a'] );
		$this->assertSame( 7, $out['b'] );
		// additionalProperties defaults to allowed when unset.
		$this->assertSame( 'kept-if-allowed', $out['extra'] );
	}

	public function test_object_with_additional_properties_false_drops_unknown_keys(): void {
		$schema = [
			'type'                 => 'object',
			'additionalProperties' => false,
			'properties'           => [ 'a' => [ 'type' => 'string' ] ],
		];
		$out = AcfValueWalker::walk( [ 'a' => 'x', 'extra' => 'dropped' ], $schema );
		$this->assertArrayHasKey( 'a', $out );
		$this->assertArrayNotHasKey( 'extra', $out );
	}

	public function test_picks_oneof_variant_via_acf_fc_layout_discriminator(): void {
		$schema = [
			'oneOf' => [
				[
					'type'       => 'object',
					'required'   => [ 'acf_fc_layout' ],
					'properties' => [
						'acf_fc_layout' => [ 'type' => 'string', 'enum' => [ 'hero' ] ],
						'headline'      => [ 'type' => 'string' ],
					],
				],
				[
					'type'       => 'object',
					'required'   => [ 'acf_fc_layout' ],
					'properties' => [
						'acf_fc_layout' => [ 'type' => 'string', 'enum' => [ 'footer' ] ],
						'links'         => [ 'type' => 'array', 'items' => [ 'type' => 'string' ] ],
					],
				],
			],
		];
		$out = AcfValueWalker::walk( [ 'acf_fc_layout' => 'hero', 'headline' => 'hi' ], $schema );
		$this->assertSame( 'hero', $out['acf_fc_layout'] );
		$this->assertSame( 'hi', $out['headline'] );
	}

	public function test_drops_empty_string_when_format_constrained(): void {
		// BUG-1: a format-constrained string fails REST validation when empty
		// or malformed; the walker drops it.
		$schema = [ 'type' => 'string', 'format' => 'uri' ];
		$this->assertNull( AcfValueWalker::walk( '', $schema ) );
		$this->assertNull( AcfValueWalker::walk( 'not-a-url', $schema ) );
		$this->assertSame( 'https://example.com', AcfValueWalker::walk( 'https://example.com', $schema ) );
	}

	// ------------------------------------------------------------------
	// value_matches_format — extracted from PostTypeListAbility in v0.6.
	// These tests exercise the format-validation branch of walk() by
	// passing a format-constrained schema and asserting the walker keeps
	// matching values + drops non-matching ones. BUG-1 regression coverage.
	// ------------------------------------------------------------------

	/**
	 * @dataProvider format_uri_cases
	 *
	 * @param mixed $value
	 */
	public function test_format_uri( $value, bool $expected ): void {
		$schema = [ 'type' => 'string', 'format' => 'uri' ];
		$result = AcfValueWalker::walk( $value, $schema );
		if ( $expected ) {
			$this->assertSame( $value, $result );
		} else {
			$this->assertNull( $result );
		}
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
		$schema = [ 'type' => 'string', 'format' => 'email' ];
		$result = AcfValueWalker::walk( $value, $schema );
		if ( $expected ) {
			$this->assertSame( $value, $result );
		} else {
			$this->assertNull( $result );
		}
	}

	public function format_email_cases(): array {
		return [
			'valid email'     => [ 'sean@example.com', true ],
			'subdomain email' => [ 'a@b.co.uk', true ],
			'empty string'    => [ '', false ],
			'missing at-sign' => [ 'sean.example.com', false ],
		];
	}

	/**
	 * @dataProvider format_date_cases
	 *
	 * @param mixed $value
	 */
	public function test_format_date( $value, bool $expected ): void {
		$schema = [ 'type' => 'string', 'format' => 'date' ];
		$result = AcfValueWalker::walk( $value, $schema );
		if ( $expected ) {
			$this->assertSame( $value, $result );
		} else {
			$this->assertNull( $result );
		}
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
		$schema = [ 'type' => 'string', 'format' => 'date-time' ];
		$result = AcfValueWalker::walk( $value, $schema );
		if ( $expected ) {
			$this->assertSame( $value, $result );
		} else {
			$this->assertNull( $result );
		}
	}

	public function format_datetime_cases(): array {
		return [
			'rfc 3339 with offset' => [ '2026-05-23T10:00:00+00:00', true ],
			'rfc 3339 zulu'        => [ '2026-05-23T10:00:00Z', true ],
			'no offset'            => [ '2026-05-23T10:00:00', true ],
			'date only'            => [ '2026-05-23', false ],
			// "all zeros" omitted — that's PostTypeListAbility's resolve_date
			// concern, not the format-validation concern.
			'empty'                => [ '', false ],
		];
	}

	public function test_unknown_format_passes_through(): void {
		// Permissive on unknown formats so adding a new schema emitter doesn't
		// silently start dropping values that this validator hasn't learned.
		$schema = [ 'type' => 'string', 'format' => 'uuid' ];
		$this->assertSame( 'anything', AcfValueWalker::walk( 'anything', $schema ) );
	}
}
