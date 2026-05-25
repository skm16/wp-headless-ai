<?php
/**
 * BlockTypeSchemaTest — covers per-block-type variant generation from
 * WP_Block_Type_Registry. ACF Block integration is covered further down.
 *
 * @package Jab\WpHeadlessKit\Tests
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Schema;

use Jab\WpHeadlessKit\Schema\BlockTypeSchema;
use PHPUnit\Framework\TestCase;

final class BlockTypeSchemaTest extends TestCase {

	protected function setUp(): void {
		\jab_wphk_reset_stubs();
		BlockTypeSchema::flush_cache();
	}

	private function block_type( string $name, array $attributes = [] ): object {
		$bt             = new \stdClass();
		$bt->name       = $name;
		$bt->attributes = $attributes;
		return $bt;
	}

	public function test_no_registered_blocks_returns_empty_array(): void {
		$this->assertSame( [], BlockTypeSchema::all_variants() );
	}

	public function test_one_block_with_no_attributes_yields_permissive_variant(): void {
		$GLOBALS['_jab_test_block_types']['core/spacer'] = $this->block_type( 'core/spacer' );

		$variants = BlockTypeSchema::all_variants();
		$this->assertCount( 1, $variants );
		$variant = $variants[0];
		$this->assertSame( [ 'core/spacer' ], $variant['properties']['blockName']['enum'] );
		$this->assertTrue( $variant['properties']['attrs']['additionalProperties'] );
	}

	public function test_block_with_typed_attributes_emits_typed_attrs_properties(): void {
		$GLOBALS['_jab_test_block_types']['core/heading'] = $this->block_type(
			'core/heading',
			[
				'level'   => [ 'type' => 'number', 'default' => 2 ],
				'content' => [ 'type' => 'string', 'source' => 'html', 'selector' => 'h2' ],
			]
		);
		$variants = BlockTypeSchema::all_variants();
		$variant  = $variants[0];
		$this->assertSame( 'object', $variant['properties']['attrs']['type'] );
		$this->assertSame( 'number', $variant['properties']['attrs']['properties']['level']['type'] );
		$this->assertSame( 'string', $variant['properties']['attrs']['properties']['content']['type'] );
	}

	public function test_source_based_attributes_are_in_properties_but_not_required(): void {
		// Per spec: source-attribute values come from HTML extraction, not
		// stored attrs. They go into properties so TypeScript types them,
		// but stay out of required so runtime validation tolerates absence.
		$GLOBALS['_jab_test_block_types']['core/quote'] = $this->block_type(
			'core/quote',
			[
				'value'    => [ 'type' => 'string', 'source' => 'html', 'selector' => 'blockquote' ],
				'citation' => [ 'type' => 'string', 'source' => 'html', 'selector' => 'cite' ],
				'align'    => [ 'type' => 'string' ],   // stored attr, no source
			]
		);
		$variants = BlockTypeSchema::all_variants();
		$attrs    = $variants[0]['properties']['attrs'];

		$this->assertArrayHasKey( 'value', $attrs['properties'] );
		$this->assertArrayHasKey( 'citation', $attrs['properties'] );
		$this->assertArrayHasKey( 'align', $attrs['properties'] );
		// None of these are required — block attrs are inherently optional.
		$this->assertSame( [], $attrs['required'] ?? [] );
	}

	public function test_block_with_no_name_is_skipped(): void {
		$bt             = new \stdClass();
		$bt->name       = '';   // pathological registration
		$bt->attributes = [];
		$GLOBALS['_jab_test_block_types']['bogus'] = $bt;

		$this->assertSame( [], BlockTypeSchema::all_variants() );
	}

	public function test_canonical_keys_present_on_every_variant(): void {
		$GLOBALS['_jab_test_block_types']['core/paragraph'] = $this->block_type( 'core/paragraph' );
		$variants = BlockTypeSchema::all_variants();
		$variant  = $variants[0];
		foreach ( [ 'blockName', 'attrs', 'innerBlocks', 'innerHTML', 'innerContent' ] as $key ) {
			$this->assertArrayHasKey( $key, $variant['properties'], "missing $key" );
		}
		$this->assertSame( [ 'blockName', 'attrs', 'innerBlocks', 'innerHTML', 'innerContent' ], $variant['required'] );
		$this->assertFalse( $variant['additionalProperties'] );
	}

	public function test_cache_is_used_across_calls(): void {
		// Cache hit: changing the registry after the first call shouldn't
		// affect the second call (until flush).
		$GLOBALS['_jab_test_block_types']['core/paragraph'] = $this->block_type( 'core/paragraph' );
		$first = BlockTypeSchema::all_variants();
		$this->assertCount( 1, $first );

		$GLOBALS['_jab_test_block_types']['core/heading'] = $this->block_type( 'core/heading' );
		$second = BlockTypeSchema::all_variants();
		$this->assertCount( 1, $second, 'should hit cache and not pick up the new block' );

		BlockTypeSchema::flush_cache();
		$third = BlockTypeSchema::all_variants();
		$this->assertCount( 2, $third );
	}

	// ------------------------------------------------------------------
	// ACF Block integration (acf/*) — attrs.data typed from BlockFieldSchema
	// ------------------------------------------------------------------

	public function test_acf_block_with_bound_field_group_types_attrs_data(): void {
		$GLOBALS['_jab_test_block_types']['acf/hero'] = $this->block_type(
			'acf/hero',
			[ 'mode' => [ 'type' => 'string' ], 'name' => [ 'type' => 'string' ] ]
		);
		$GLOBALS['_jab_test_acf_field_groups'] = [
			[
				'key'      => 'group_hero',
				'location' => [
					[ [ 'param' => 'block', 'operator' => '==', 'value' => 'acf/hero' ] ],
				],
			],
		];
		$GLOBALS['_jab_test_acf_fields_by_group'] = [
			'group_hero' => [
				[ 'name' => 'headline', 'type' => 'text' ],
				[ 'name' => 'subhead',  'type' => 'textarea' ],
			],
		];

		$variants = BlockTypeSchema::all_variants();
		$attrs    = $variants[0]['properties']['attrs'];

		// ACF Block attrs.data is typed via BlockFieldSchema.
		$this->assertArrayHasKey( 'data', $attrs['properties'] );
		$this->assertArrayHasKey( 'headline', $attrs['properties']['data']['properties'] );
		$this->assertArrayHasKey( 'subhead', $attrs['properties']['data']['properties'] );

		// attrs.additionalProperties: true so ACF's mode/name/align/etc.
		// flow through without breaking validation.
		$this->assertTrue( $attrs['additionalProperties'] );
	}

	public function test_acf_block_without_bound_field_group_falls_back_to_declared_attrs(): void {
		$GLOBALS['_jab_test_block_types']['acf/orphan'] = $this->block_type(
			'acf/orphan',
			[ 'mode' => [ 'type' => 'string' ] ]
		);
		// No field groups at all → BlockFieldSchema returns null.

		$variants = BlockTypeSchema::all_variants();
		$attrs    = $variants[0]['properties']['attrs'];

		// Falls through to the "no ACF schema" branch — declared attributes
		// shape (additionalProperties: false, `mode` in properties).
		$this->assertArrayHasKey( 'mode', $attrs['properties'] );
		$this->assertFalse( $attrs['additionalProperties'] );
	}

	public function test_acf_block_with_acf_inactive_skips_field_group_lookup(): void {
		$GLOBALS['_jab_test_acf_inactive'] = true;
		$GLOBALS['_jab_test_block_types']['acf/hero'] = $this->block_type( 'acf/hero' );

		// Should not crash; should produce a variant with permissive attrs.
		$variants = BlockTypeSchema::all_variants();
		$this->assertCount( 1, $variants );
		$attrs = $variants[0]['properties']['attrs'];
		$this->assertTrue( $attrs['additionalProperties'] );
	}
}
