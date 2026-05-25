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
}
