<?php
/**
 * BlockExpander — inline expansion of `core/block` reusable-block references.
 *
 * When walking a parsed block tree, every `core/block { ref: N }` node has
 * its `innerBlocks` populated from the referenced wp_block post's parsed
 * content. The envelope is preserved so consumers can still tell "this slot
 * was a reusable block." A visited-set bounds recursion against circular
 * references; missing posts, drafts, and posts of the wrong type all leave
 * `innerBlocks` empty rather than crashing.
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Abilities;

use Jab\WpHeadlessKit\Schema\BlockParser;

defined( 'ABSPATH' ) || exit;

final class BlockExpander {

	/**
	 * Walk a parsed block tree, expanding every `core/block` reference inline.
	 *
	 * @param array<int, array<string, mixed>> $blocks
	 * @return array<int, array<string, mixed>>
	 */
	public static function expand( array $blocks ): array {
		return self::walk( $blocks, [] );
	}

	/**
	 * Recursive walker. `$visited` is a map of wp_block IDs already expanded
	 * higher in the tree; a node referencing one of them is left with empty
	 * innerBlocks to terminate the cycle.
	 *
	 * @param array<int, array<string, mixed>> $blocks
	 * @param array<int, bool>                 $visited
	 * @return array<int, array<string, mixed>>
	 */
	private static function walk( array $blocks, array $visited ): array {
		$out = [];
		foreach ( $blocks as $block ) {
			if ( ! is_array( $block ) ) {
				continue;
			}
			$name = isset( $block['blockName'] ) ? (string) $block['blockName'] : '';
			if ( 'core/block' === $name ) {
				$ref = isset( $block['attrs']['ref'] ) ? (int) $block['attrs']['ref'] : 0;
				if ( $ref > 0 && empty( $visited[ $ref ] ) ) {
					$expanded             = self::load_reusable_blocks( $ref );
					$next_visited         = $visited;
					$next_visited[ $ref ] = true;
					$block['innerBlocks'] = self::walk( $expanded, $next_visited );
				}
				$out[] = $block;
				continue;
			}
			// Always descend into innerBlocks for non-core/block nodes —
			// matches the core/block branch's unconditional recursion above,
			// and walk() is a no-op on empty arrays.
			if ( isset( $block['innerBlocks'] ) && is_array( $block['innerBlocks'] ) ) {
				$block['innerBlocks'] = self::walk( $block['innerBlocks'], $visited );
			}
			$out[] = $block;
		}
		return $out;
	}

	/**
	 * Load a wp_block post by ID and return its parsed block tree.
	 * Returns [] for missing, draft, or wrong-type posts.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private static function load_reusable_blocks( int $post_id ): array {
		$post = get_post( $post_id );
		if ( ! ( $post instanceof \WP_Post ) ) {
			return [];
		}
		if ( 'wp_block' !== (string) $post->post_type ) {
			return [];
		}
		if ( 'publish' !== (string) $post->post_status ) {
			return [];
		}
		return BlockParser::parse( (string) $post->post_content );
	}
}
