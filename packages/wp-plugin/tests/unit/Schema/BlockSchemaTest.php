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
		$variants = $schema['items']['anyOf'];
		return $variants[ count( $variants ) - 1 ];
	}

	public function test_block_array_schema_is_an_array_of_any_of_variants(): void {
		$schema = BlockSchema::block_array_schema();
		$this->assertSame( 'array', $schema['type'] );
		// v0.6.3 BUG-5: top-level discriminator MUST be `anyOf`, not `oneOf`.
		// WP REST validator's `rest_find_one_matching_schema` rejects multi-
		// match, and the fallback's `not: { enum: known_names }` exclusion
		// is silently ignored by WP — so every known block matches both its
		// typed variant and the fallback, causing "matches more than one of
		// the expected formats" on every page that contains a registered block.
		$this->assertArrayHasKey( 'anyOf', $schema['items'] );
		$this->assertArrayNotHasKey( 'oneOf', $schema['items'] );
		$this->assertIsArray( $schema['items']['anyOf'] );
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
		$variants = $schema['items']['anyOf'];
		$this->assertCount( 2, $variants, 'one known + one fallback' );
		$this->assertSame( [ 'core/paragraph' ], $variants[0]['properties']['blockName']['enum'] );
		// Fallback is last and has the nullable blockName.
		$this->assertArrayHasKey( 'oneOf', $variants[1]['properties']['blockName'] );
	}

	public function test_no_registered_blocks_emits_only_fallback(): void {
		$schema   = BlockSchema::block_array_schema();
		$variants = $schema['items']['anyOf'];
		$this->assertCount( 1, $variants );
		$this->assertArrayHasKey( 'oneOf', $variants[0]['properties']['blockName'] );
	}

	public function test_rendered_content_is_a_string(): void {
		$schema = BlockSchema::rendered_content_schema();
		$this->assertSame( 'string', $schema['type'] );
	}

	public function test_fallback_excludes_known_block_names_via_not_keyword(): void {
		// Regression: without the `not: { enum: [...] }` on the fallback's
		// blockName string branch, a known block name would match both its
		// typed variant AND the fallback — and WP's rest_find_one_matching_schema
		// rejects responses with multiple matches.
		$paragraph             = new \stdClass();
		$paragraph->name       = 'core/paragraph';
		$paragraph->attributes = [];
		$heading               = new \stdClass();
		$heading->name         = 'core/heading';
		$heading->attributes   = [];
		$GLOBALS['_jab_test_block_types']['core/paragraph'] = $paragraph;
		$GLOBALS['_jab_test_block_types']['core/heading']   = $heading;

		$schema   = BlockSchema::block_array_schema();
		$variants = $schema['items']['anyOf'];
		$fallback = $variants[ count( $variants ) - 1 ];

		// The fallback's blockName string branch carries `not: { enum: ... }`
		// listing every typed-variant name.
		$string_branch = $fallback['properties']['blockName']['oneOf'][0];
		$this->assertSame( 'string', $string_branch['type'] );
		$this->assertArrayHasKey( 'not', $string_branch );
		$this->assertContains( 'core/paragraph', $string_branch['not']['enum'] );
		$this->assertContains( 'core/heading', $string_branch['not']['enum'] );
	}

	public function test_fallback_string_branch_omits_not_when_no_blocks_registered(): void {
		// Empty known-names list means no exclusion is needed (no typed
		// variants to collide with). The `not` key should be absent rather
		// than present-with-empty-enum, which is a no-op but unnecessary noise.
		$schema   = BlockSchema::block_array_schema();
		$variants = $schema['items']['anyOf'];
		$fallback = $variants[ count( $variants ) - 1 ];
		$string_branch = $fallback['properties']['blockName']['oneOf'][0];
		$this->assertSame( 'string', $string_branch['type'] );
		$this->assertArrayNotHasKey( 'not', $string_branch );
	}
}
