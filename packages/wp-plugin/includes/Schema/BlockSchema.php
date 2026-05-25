<?php
/**
 * BlockSchema — JSON Schema fragments for parsed-block emission.
 *
 * Produces the shape PostTypeListAbility/PostTypeBySlugAbility return when
 * the caller opts into `include.blocks` or `include.render`. The block-tree
 * fragment intentionally avoids `$ref` (WP core's REST schema validator does
 * not handle it reliably) and accepts loose object shape for nested blocks —
 * the per-block-type discriminated-union work is a v0.6 follow-up.
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Schema;

defined( 'ABSPATH' ) || exit;

final class BlockSchema {

	/**
	 * Top-level shape: an array of block nodes, each with WP's canonical
	 * parse_blocks() output keys.
	 *
	 * @return array<string, mixed>
	 */
	public static function block_array_schema(): array {
		return [
			'type'  => 'array',
			'items' => self::block_node_schema(),
		];
	}

	/**
	 * A single block node. Mirrors parse_blocks()'s per-entry shape:
	 * - blockName: namespaced name (`core/paragraph`) or null for the
	 *   "freeform" wrapper around classic / page-builder content.
	 * - attrs:    block attributes as a permissive object.
	 * - innerBlocks: nested block tree (loose object shape — see class docblock).
	 * - innerHTML: pre-rendered HTML for this block (placeholder for dynamic blocks).
	 * - innerContent: literal strings interleaved with nulls marking child-block slots.
	 *
	 * @return array<string, mixed>
	 */
	public static function block_node_schema(): array {
		return [
			'type'                 => 'object',
			'additionalProperties' => false,
			'required'             => [ 'blockName', 'attrs', 'innerBlocks', 'innerHTML', 'innerContent' ],
			'properties'           => [
				'blockName'    => [
					'oneOf' => [
						[ 'type' => 'string' ],
						[ 'type' => 'null' ],
					],
				],
				'attrs'        => [
					'type'                 => 'object',
					'additionalProperties' => true,
				],
				'innerBlocks'  => [
					'type'  => 'array',
					'items' => [
						'type'                 => 'object',
						'additionalProperties' => true,
					],
				],
				'innerHTML'    => [ 'type' => 'string' ],
				'innerContent' => [
					'type'  => 'array',
					'items' => [
						'oneOf' => [
							[ 'type' => 'string' ],
							[ 'type' => 'null' ],
						],
					],
				],
			],
		];
	}

	/**
	 * Fragment for the top-level rendered HTML field emitted when
	 * include.render is true. Plain string; no length constraint
	 * (page-builder output can be tens of KB).
	 *
	 * @return array<string, mixed>
	 */
	public static function rendered_content_schema(): array {
		return [ 'type' => 'string' ];
	}
}
