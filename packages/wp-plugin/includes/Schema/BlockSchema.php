<?php
/**
 * BlockSchema — JSON Schema fragments for parsed-block emission.
 *
 * Produces the shape PostTypeListAbility/PostTypeBySlugAbility return when
 * the caller opts into `include.blocks` or `include.render`. v0.6.0: the
 * per-item shape is a `oneOf` discriminated union composed from
 * BlockTypeSchema variants (one per registered block type) plus an
 * unknown-fallback variant emitted by block_node_schema().
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Schema;

defined( 'ABSPATH' ) || exit;

final class BlockSchema {

	/**
	 * Top-level shape: an array of block nodes. v0.6.0: the items schema is
	 * a oneOf discriminated union composed from BlockTypeSchema variants
	 * plus the unknown-fallback variant from block_node_schema().
	 *
	 * @return array<string, mixed>
	 */
	public static function block_array_schema(): array {
		return [
			'type'  => 'array',
			'items' => self::block_items_one_of(),
		];
	}

	/**
	 * The per-item `oneOf` discriminated union. Known block variants from
	 * WP_Block_Type_Registry come first; the unknown-fallback variant
	 * (which accepts `blockName: string | null` with permissive attrs) is
	 * appended LAST. WP's rest_validate_value_from_schema walks variants
	 * in order; the fallback only matches when no known variant did.
	 *
	 * @return array<string, mixed>
	 */
	public static function block_items_one_of(): array {
		$variants   = BlockTypeSchema::all_variants();
		$variants[] = self::block_node_schema();   // fallback, must be last
		return [ 'oneOf' => $variants ];
	}

	/**
	 * The unknown-block fallback variant. Single canonical node shape with
	 * a nullable blockName (covers parse_blocks's freeform wrapper) and a
	 * permissive attrs object (covers third-party blocks not in the
	 * registry at request time + blocks with no declared attributes).
	 *
	 * IMPORTANT: `innerBlocks` items are declared with `type: object,
	 * additionalProperties: true` and no `required` keys. This is intentional
	 * — WP core's `rest_validate_value_from_schema` does not support `$ref`,
	 * so we cannot self-reference. Tightening the inner shape (e.g. setting
	 * `additionalProperties: false` or adding `required`) WILL break REST
	 * output validation for any block tree more than one level deep. The
	 * top-level node stays strict; only the recursive children are loose.
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
