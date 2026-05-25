<?php
/**
 * BlockSchemaTest — covers the JSON Schema fragment used by block-aware abilities.
 *
 * v0.6.0: the top-level items schema is a `oneOf` discriminated union composed
 * from BlockTypeSchema variants + an unknown-fallback variant.
 *
 * @package Jab\WpHeadlessKit\Tests
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Schema;

use Jab\WpHeadlessKit\Schema\BlockSchema;
use Jab\WpHeadlessKit\Schema\BlockTypeSchema;
use PHPUnit\Framework\TestCase;

final class BlockSchemaTest extends TestCase {

	protected function setUp(): void {
		\jab_wphk_reset_stubs();
		BlockTypeSchema::flush_cache();
	}

	private function fallback_variant(): array {
		$schema   = BlockSchema::block_array_schema();
		$variants = $schema['items']['oneOf'];
		return $variants[ count( $variants ) - 1 ];
	}

	public function test_block_array_schema_is_an_array_of_one_of_variants(): void {
		$schema = BlockSchema::block_array_schema();
		$this->assertSame( 'array', $schema['type'] );
		$this->assertArrayHasKey( 'oneOf', $schema['items'] );
		$this->assertIsArray( $schema['items']['oneOf'] );
	}

	public function test_fallback_variant_has_canonical_keys(): void {
		$fallback = $this->fallback_variant();
		$required = $fallback['required'];
		$this->assertContains( 'blockName', $required );
		$this->assertContains( 'attrs', $required );
		$this->assertContains( 'innerBlocks', $required );
		$this->assertContains( 'innerHTML', $required );
		$this->assertContains( 'innerContent', $required );
	}

	public function test_fallback_variant_block_name_is_nullable(): void {
		$block_name = $this->fallback_variant()['properties']['blockName'];
		$this->assertArrayHasKey( 'oneOf', $block_name );
		$types = array_map( static fn( array $variant ): string => (string) ( $variant['type'] ?? '' ), $block_name['oneOf'] );
		$this->assertContains( 'string', $types );
		$this->assertContains( 'null', $types );
	}

	public function test_fallback_variant_attrs_is_permissive_object(): void {
		$attrs = $this->fallback_variant()['properties']['attrs'];
		$this->assertSame( 'object', $attrs['type'] );
		$this->assertTrue( $attrs['additionalProperties'] );
	}

	public function test_fallback_variant_inner_blocks_is_array(): void {
		$inner = $this->fallback_variant()['properties']['innerBlocks'];
		$this->assertSame( 'array', $inner['type'] );
	}

	public function test_fallback_variant_inner_content_allows_nulls(): void {
		$inner_content = $this->fallback_variant()['properties']['innerContent'];
		$this->assertSame( 'array', $inner_content['type'] );
		$item_one_of = $inner_content['items']['oneOf'] ?? [];
		$types       = array_map( static fn( array $variant ): string => (string) ( $variant['type'] ?? '' ), $item_one_of );
		$this->assertContains( 'string', $types );
		$this->assertContains( 'null', $types );
	}

	public function test_known_block_variants_appear_before_fallback(): void {
		$bt             = new \stdClass();
		$bt->name       = 'core/paragraph';
		$bt->attributes = [];
		$GLOBALS['_jab_test_block_types']['core/paragraph'] = $bt;

		$schema   = BlockSchema::block_array_schema();
		$variants = $schema['items']['oneOf'];
		$this->assertCount( 2, $variants, 'one known + one fallback' );
		$this->assertSame( [ 'core/paragraph' ], $variants[0]['properties']['blockName']['enum'] );
		// Fallback is last and has the nullable blockName.
		$this->assertArrayHasKey( 'oneOf', $variants[1]['properties']['blockName'] );
	}

	public function test_no_registered_blocks_emits_only_fallback(): void {
		$schema   = BlockSchema::block_array_schema();
		$variants = $schema['items']['oneOf'];
		$this->assertCount( 1, $variants );
		$this->assertArrayHasKey( 'oneOf', $variants[0]['properties']['blockName'] );
	}

	public function test_rendered_content_is_a_string(): void {
		$schema = BlockSchema::rendered_content_schema();
		$this->assertSame( 'string', $schema['type'] );
	}
}
