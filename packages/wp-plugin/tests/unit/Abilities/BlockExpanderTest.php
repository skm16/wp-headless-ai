<?php
/**
 * BlockExpanderTest — covers inline expansion of `core/block` references.
 *
 * @package Jab\WpHeadlessKit\Tests
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Abilities;

use Jab\WpHeadlessKit\Abilities\BlockExpander;
use PHPUnit\Framework\TestCase;

final class BlockExpanderTest extends TestCase {

	protected function setUp(): void {
		\jab_wphk_reset_stubs();
	}

	private function freeform( string $html ): array {
		return [
			'blockName'    => null,
			'attrs'        => [],
			'innerBlocks'  => [],
			'innerHTML'    => $html,
			'innerContent' => [ $html ],
		];
	}

	private function seed_reusable_block( int $id, string $post_content, array $parsed_tree ): void {
		$post                              = new \WP_Post();
		$post->ID                          = $id;
		$post->post_type                   = 'wp_block';
		$post->post_status                 = 'publish';
		$post->post_content                = $post_content;
		$GLOBALS['_jab_test_posts'][ $id ] = $post;

		$GLOBALS['_jab_test_parse_blocks_map'][ $post_content ] = $parsed_tree;
	}

	public function test_blocks_without_core_block_references_pass_through(): void {
		$tree = [
			[
				'blockName'    => 'core/paragraph',
				'attrs'        => [],
				'innerBlocks'  => [],
				'innerHTML'    => '<p>x</p>',
				'innerContent' => [ '<p>x</p>' ],
			],
		];
		$this->assertSame( $tree, BlockExpander::expand( $tree ) );
	}

	public function test_core_block_reference_populates_inner_blocks(): void {
		$this->seed_reusable_block(
			123,
			'<!-- wp:paragraph --><p>reused</p><!-- /wp:paragraph -->',
			[ $this->freeform( '<p>reused</p>' ) ]
		);
		$tree = [
			[
				'blockName'    => 'core/block',
				'attrs'        => [ 'ref' => 123 ],
				'innerBlocks'  => [],
				'innerHTML'    => '',
				'innerContent' => [],
			],
		];
		$result = BlockExpander::expand( $tree );
		$this->assertSame( 'core/block', $result[0]['blockName'] );
		$this->assertCount( 1, $result[0]['innerBlocks'] );
		$this->assertSame( '<p>reused</p>', $result[0]['innerBlocks'][0]['innerHTML'] );
	}

	public function test_missing_reusable_block_leaves_inner_blocks_empty(): void {
		// Deleted reusable block → ref points to nothing. The envelope stays
		// but innerBlocks remains empty so consumers can see the dangling ref.
		$tree = [
			[
				'blockName'    => 'core/block',
				'attrs'        => [ 'ref' => 9999 ],
				'innerBlocks'  => [],
				'innerHTML'    => '',
				'innerContent' => [],
			],
		];
		$result = BlockExpander::expand( $tree );
		$this->assertSame( 'core/block', $result[0]['blockName'] );
		$this->assertSame( [], $result[0]['innerBlocks'] );
	}

	public function test_non_published_reusable_block_is_not_expanded(): void {
		// Drafts of wp_block posts must not leak through expansion.
		$post                              = new \WP_Post();
		$post->ID                          = 200;
		$post->post_type                   = 'wp_block';
		$post->post_status                 = 'draft';
		$post->post_content                = '<!-- wp:paragraph --><p>draft</p><!-- /wp:paragraph -->';
		$GLOBALS['_jab_test_posts'][ 200 ] = $post;

		$tree = [
			[
				'blockName'    => 'core/block',
				'attrs'        => [ 'ref' => 200 ],
				'innerBlocks'  => [],
				'innerHTML'    => '',
				'innerContent' => [],
			],
		];
		$result = BlockExpander::expand( $tree );
		$this->assertSame( [], $result[0]['innerBlocks'] );
	}

	public function test_wrong_post_type_is_ignored(): void {
		// Defensive: ref pointing to a non-wp_block post must not expand
		// arbitrary content as if it were a reusable block.
		$post                              = new \WP_Post();
		$post->ID                          = 300;
		$post->post_type                   = 'post';
		$post->post_status                 = 'publish';
		$post->post_content                = '<p>not a reusable block</p>';
		$GLOBALS['_jab_test_posts'][ 300 ] = $post;

		$tree = [
			[
				'blockName'    => 'core/block',
				'attrs'        => [ 'ref' => 300 ],
				'innerBlocks'  => [],
				'innerHTML'    => '',
				'innerContent' => [],
			],
		];
		$result = BlockExpander::expand( $tree );
		$this->assertSame( [], $result[0]['innerBlocks'] );
	}

	public function test_circular_reference_does_not_infinite_loop(): void {
		// wp_block 1 references itself. Without a visited-set this would
		// recurse until the PHP stack overflows.
		$this->seed_reusable_block(
			1,
			'<!-- wp:block {"ref":1} /-->',
			[
				[
					'blockName'    => 'core/block',
					'attrs'        => [ 'ref' => 1 ],
					'innerBlocks'  => [],
					'innerHTML'    => '',
					'innerContent' => [],
				],
			]
		);
		$tree = [
			[
				'blockName'    => 'core/block',
				'attrs'        => [ 'ref' => 1 ],
				'innerBlocks'  => [],
				'innerHTML'    => '',
				'innerContent' => [],
			],
		];
		$result = BlockExpander::expand( $tree );
		// First level expands into the nested block. The nested block sees
		// that 1 is already in the visited-set and leaves innerBlocks empty.
		$this->assertSame( 'core/block', $result[0]['blockName'] );
		$this->assertCount( 1, $result[0]['innerBlocks'] );
		$this->assertSame( 'core/block', $result[0]['innerBlocks'][0]['blockName'] );
		$this->assertSame( [], $result[0]['innerBlocks'][0]['innerBlocks'] );
	}

	public function test_nested_non_reference_blocks_recurse(): void {
		// A core/group wrapping a core/block reference: expansion must
		// descend into innerBlocks too, not just top-level entries.
		$this->seed_reusable_block(
			500,
			'<!-- wp:paragraph --><p>cta</p><!-- /wp:paragraph -->',
			[ $this->freeform( '<p>cta</p>' ) ]
		);
		$tree = [
			[
				'blockName'    => 'core/group',
				'attrs'        => [],
				'innerBlocks'  => [
					[
						'blockName'    => 'core/block',
						'attrs'        => [ 'ref' => 500 ],
						'innerBlocks'  => [],
						'innerHTML'    => '',
						'innerContent' => [],
					],
				],
				'innerHTML'    => '',
				'innerContent' => [],
			],
		];
		$result   = BlockExpander::expand( $tree );
		$expanded = $result[0]['innerBlocks'][0];
		$this->assertSame( 'core/block', $expanded['blockName'] );
		$this->assertCount( 1, $expanded['innerBlocks'] );
		$this->assertSame( '<p>cta</p>', $expanded['innerBlocks'][0]['innerHTML'] );
	}
}
