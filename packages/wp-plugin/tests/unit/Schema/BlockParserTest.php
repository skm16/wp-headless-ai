<?php
/**
 * BlockParserTest — wraps WP's parse_blocks() and normalizes the output.
 *
 * @package Jab\WpHeadlessKit\Tests
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Schema;

use Jab\WpHeadlessKit\Schema\BlockParser;
use PHPUnit\Framework\TestCase;

final class BlockParserTest extends TestCase {

	protected function setUp(): void {
		\jab_wphk_reset_stubs();
	}

	public function test_empty_content_returns_empty_array(): void {
		$this->assertSame( [], BlockParser::parse( '' ) );
	}

	public function test_classic_content_returns_freeform_block(): void {
		// parse_blocks() emits one block with blockName=null wrapping
		// non-block content. The wrapper must preserve this shape.
		$result = BlockParser::parse( '<p>Hello</p>' );
		$this->assertCount( 1, $result );
		$this->assertNull( $result[0]['blockName'] );
		$this->assertSame( '<p>Hello</p>', $result[0]['innerHTML'] );
	}

	public function test_canonical_keys_always_present(): void {
		// Even when parse_blocks returns a sparse entry, every emitted node
		// must carry all five keys so downstream schema validation passes.
		$GLOBALS['_jab_test_parse_blocks_map']['<!-- wp:thin /-->'] = [
			[ 'blockName' => 'plugin/thin' ],
		];
		$result = BlockParser::parse( '<!-- wp:thin /-->' );
		$this->assertSame( 'plugin/thin', $result[0]['blockName'] );
		$this->assertSame( [], $result[0]['attrs'] );
		$this->assertSame( [], $result[0]['innerBlocks'] );
		$this->assertSame( '', $result[0]['innerHTML'] );
		$this->assertSame( [], $result[0]['innerContent'] );
	}

	public function test_nested_inner_blocks_are_normalized_recursively(): void {
		$GLOBALS['_jab_test_parse_blocks_map']['<!-- wp:group --><!-- /wp:group -->'] = [
			[
				'blockName'   => 'core/group',
				'innerBlocks' => [
					[ 'blockName' => 'core/paragraph', 'innerHTML' => '<p>x</p>' ],
				],
			],
		];
		$result = BlockParser::parse( '<!-- wp:group --><!-- /wp:group -->' );
		$this->assertSame( 'core/group', $result[0]['blockName'] );
		$this->assertSame( 'core/paragraph', $result[0]['innerBlocks'][0]['blockName'] );
		$this->assertSame( '<p>x</p>', $result[0]['innerBlocks'][0]['innerHTML'] );
		$this->assertSame( [], $result[0]['innerBlocks'][0]['attrs'] );
		$this->assertSame( [], $result[0]['innerBlocks'][0]['innerContent'] );
	}

	public function test_non_array_entries_are_dropped(): void {
		// Defensive: a malformed plugin filter could pollute parse_blocks
		// output. Drop garbage rather than crashing downstream.
		$GLOBALS['_jab_test_parse_blocks_map']['mixed'] = [
			[ 'blockName' => 'core/heading', 'innerHTML' => '<h1>ok</h1>' ],
			'this should not be here',
			null,
		];
		$result = BlockParser::parse( 'mixed' );
		$this->assertCount( 1, $result );
		$this->assertSame( 'core/heading', $result[0]['blockName'] );
	}

	// ------------------------------------------------------------------
	// ACF Block (acf/*) runtime enrichment (v0.6.0)
	// ------------------------------------------------------------------

	public function test_non_acf_block_attrs_pass_through_unchanged(): void {
		$GLOBALS['_jab_test_parse_blocks_map']['<x>'] = [
			[
				'blockName' => 'core/paragraph',
				'attrs'     => [ 'align' => 'center' ],
			],
		];
		$result = BlockParser::parse( '<x>' );
		$this->assertSame( 'center', $result[0]['attrs']['align'] );
	}

	public function test_acf_block_data_is_walked_through_acf_value_walker(): void {
		// Bind a field group to the block so BlockFieldSchema returns a schema.
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
			],
		];
		$GLOBALS['_jab_test_parse_blocks_map']['<hero>'] = [
			[
				'blockName' => 'acf/hero',
				'attrs'     => [
					'data' => [ 'headline' => 'Welcome' ],
					'mode' => 'edit',   // ACF meta — not in the schema, should still pass through
				],
			],
		];

		$result = BlockParser::parse( '<hero>' );
		$this->assertSame( 'Welcome', $result[0]['attrs']['data']['headline'] );
		$this->assertSame( 'edit', $result[0]['attrs']['mode'] );
	}

	public function test_acf_block_with_unknown_field_drops_value_per_walker_rules(): void {
		// AcfValueWalker drops object props not in the schema when
		// additionalProperties is false. BlockFieldSchema emits with
		// additionalProperties:false, so a stray data key gets dropped.
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
			],
		];
		$GLOBALS['_jab_test_parse_blocks_map']['<hero>'] = [
			[
				'blockName' => 'acf/hero',
				'attrs'     => [
					'data' => [ 'headline' => 'X', 'stray' => 'gone' ],
				],
			],
		];

		$result = BlockParser::parse( '<hero>' );
		$this->assertArrayHasKey( 'headline', $result[0]['attrs']['data'] );
		$this->assertArrayNotHasKey( 'stray', $result[0]['attrs']['data'] );
	}

	public function test_acf_block_with_no_bound_field_group_passes_through_unchanged(): void {
		// No field group → BlockFieldSchema::for_block_name returns null.
		// BlockParser should pass attrs through without enrichment.
		$GLOBALS['_jab_test_parse_blocks_map']['<orphan>'] = [
			[
				'blockName' => 'acf/orphan',
				'attrs'     => [ 'data' => [ 'foo' => 'bar' ] ],
			],
		];
		$result = BlockParser::parse( '<orphan>' );
		$this->assertSame( 'bar', $result[0]['attrs']['data']['foo'] );
	}

	public function test_acf_block_with_acf_inactive_passes_through_unchanged(): void {
		$GLOBALS['_jab_test_acf_inactive'] = true;
		$GLOBALS['_jab_test_parse_blocks_map']['<hero>'] = [
			[
				'blockName' => 'acf/hero',
				'attrs'     => [ 'data' => [ 'headline' => 'no-walker' ] ],
			],
		];
		$result = BlockParser::parse( '<hero>' );
		$this->assertSame( 'no-walker', $result[0]['attrs']['data']['headline'] );
	}

	public function test_acf_block_data_not_an_array_is_left_as_is(): void {
		// Defensive: if attrs.data is missing or a non-array, do nothing.
		$GLOBALS['_jab_test_acf_field_groups'] = [
			[
				'key'      => 'group_hero',
				'location' => [
					[ [ 'param' => 'block', 'operator' => '==', 'value' => 'acf/hero' ] ],
				],
			],
		];
		$GLOBALS['_jab_test_acf_fields_by_group'] = [
			'group_hero' => [ [ 'name' => 'headline', 'type' => 'text' ] ],
		];
		$GLOBALS['_jab_test_parse_blocks_map']['<hero>'] = [
			[
				'blockName' => 'acf/hero',
				'attrs'     => [],   // no data key at all
			],
		];
		$result = BlockParser::parse( '<hero>' );
		$this->assertSame( [], $result[0]['attrs'] );
	}
}
