<?php
/**
 * BlockParser — wraps WP's parse_blocks() and normalizes each entry.
 *
 * WP's parse_blocks emits sparse entries (missing keys, plugin filters can
 * inject malformed rows) — this wrapper ensures every emitted node has the
 * full canonical key set so downstream JSON Schema validation never trips.
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Schema;

use Jab\WpHeadlessKit\Acf\BlockFieldSchema;
use Jab\WpHeadlessKit\Acf\Schema as AcfSchema;

defined( 'ABSPATH' ) || exit;

final class BlockParser {

	/**
	 * Parse a post_content string into the canonical BlockNode[] shape.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public static function parse( string $content ): array {
		if ( '' === $content ) {
			return [];
		}
		$raw = parse_blocks( $content );
		if ( ! is_array( $raw ) ) {
			return [];
		}
		$out = [];
		foreach ( $raw as $node ) {
			if ( ! is_array( $node ) ) {
				continue;
			}
			$out[] = self::normalize( $node );
		}
		return $out;
	}

	/**
	 * Coerce a single parse_blocks() entry into the canonical shape.
	 *
	 * @param array<string, mixed> $node
	 * @return array<string, mixed>
	 */
	private static function normalize( array $node ): array {
		$inner_blocks = [];
		if ( isset( $node['innerBlocks'] ) && is_array( $node['innerBlocks'] ) ) {
			foreach ( $node['innerBlocks'] as $child ) {
				if ( is_array( $child ) ) {
					$inner_blocks[] = self::normalize( $child );
				}
			}
		}
		$block_name = $node['blockName'] ?? null;
		if ( null !== $block_name && ! is_string( $block_name ) ) {
			$block_name = null;
		}
		$attrs = $node['attrs'] ?? [];
		if ( ! is_array( $attrs ) ) {
			$attrs = [];
		}
		$inner_html = $node['innerHTML'] ?? '';
		if ( ! is_string( $inner_html ) ) {
			$inner_html = '';
		}
		$inner_content = $node['innerContent'] ?? [];
		if ( ! is_array( $inner_content ) ) {
			$inner_content = [];
		}

		// v0.6.0: ACF Blocks (acf/*) carry their field values inside
		// attrs.data. When a field group is bound to the block, walk that
		// payload through AcfValueWalker so image IDs become attachment
		// objects, Flex Content gets the discriminated-union shape, etc.
		// Gated by ACF active + the field group exists. Block-level data
		// not in the schema is dropped per the walker's normal rules.
		if ( is_string( $block_name )
			&& 0 === strpos( $block_name, 'acf/' )
			&& isset( $attrs['data'] ) && is_array( $attrs['data'] )
			&& AcfSchema::is_active()
		) {
			$data_schema = BlockFieldSchema::for_block_name( $block_name );
			if ( is_array( $data_schema ) ) {
				$walked = AcfValueWalker::walk( $attrs['data'], $data_schema );
				if ( is_array( $walked ) ) {
					$attrs['data'] = $walked;
				}
			}
		}

		return [
			'blockName'    => $block_name,
			'attrs'        => $attrs,
			'innerBlocks'  => $inner_blocks,
			'innerHTML'    => $inner_html,
			'innerContent' => array_values( $inner_content ),
		];
	}
}
