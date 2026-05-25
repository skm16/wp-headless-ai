<?php
/**
 * BlockSchemaTest — covers the JSON Schema fragment used by block-aware abilities.
 *
 * @package Jab\WpHeadlessKit\Tests
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Schema;

use Jab\WpHeadlessKit\Schema\BlockSchema;
use PHPUnit\Framework\TestCase;

final class BlockSchemaTest extends TestCase {

	public function test_block_array_schema_is_an_array_of_objects(): void {
		$schema = BlockSchema::block_array_schema();
		$this->assertSame( 'array', $schema['type'] );
		$this->assertSame( 'object', $schema['items']['type'] );
	}

	public function test_block_node_requires_canonical_keys(): void {
		$schema   = BlockSchema::block_array_schema();
		$required = $schema['items']['required'];
		$this->assertContains( 'blockName', $required );
		$this->assertContains( 'attrs', $required );
		$this->assertContains( 'innerBlocks', $required );
		$this->assertContains( 'innerHTML', $required );
		$this->assertContains( 'innerContent', $required );
	}

	public function test_block_name_is_nullable_string(): void {
		// parse_blocks() emits blockName = null for the "freeform" wrapper
		// around classic / page-builder content. The schema must accept null.
		$schema     = BlockSchema::block_array_schema();
		$block_name = $schema['items']['properties']['blockName'];
		$this->assertArrayHasKey( 'oneOf', $block_name );
		$types = array_map( static fn( array $variant ): string => (string) ( $variant['type'] ?? '' ), $block_name['oneOf'] );
		$this->assertContains( 'string', $types );
		$this->assertContains( 'null', $types );
	}

	public function test_attrs_is_permissive_object(): void {
		// Block attributes vary wildly across third-party blocks; we don't
		// constrain them at the generic level. The per-block-type schema work
		// (v0.6) will tighten this via WP_Block_Type_Registry.
		$schema = BlockSchema::block_array_schema();
		$attrs  = $schema['items']['properties']['attrs'];
		$this->assertSame( 'object', $attrs['type'] );
		$this->assertTrue( $attrs['additionalProperties'] );
	}

	public function test_inner_blocks_is_array_of_objects(): void {
		$schema = BlockSchema::block_array_schema();
		$inner  = $schema['items']['properties']['innerBlocks'];
		$this->assertSame( 'array', $inner['type'] );
		$this->assertSame( 'object', $inner['items']['type'] );
	}

	public function test_inner_content_allows_null_entries(): void {
		// WP's parse_blocks fills innerContent with strings for literal text
		// and nulls for "this slot is a child block" placeholders. The schema
		// must accept either per entry.
		$schema        = BlockSchema::block_array_schema();
		$inner_content = $schema['items']['properties']['innerContent'];
		$this->assertSame( 'array', $inner_content['type'] );
		$item_one_of = $inner_content['items']['oneOf'] ?? [];
		$types       = array_map( static fn( array $variant ): string => (string) ( $variant['type'] ?? '' ), $item_one_of );
		$this->assertContains( 'string', $types );
		$this->assertContains( 'null', $types );
	}

	public function test_rendered_content_is_a_string(): void {
		$schema = BlockSchema::rendered_content_schema();
		$this->assertSame( 'string', $schema['type'] );
	}
}
