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
	 * The per-item discriminated union over block-type variants. Known block
	 * variants from WP_Block_Type_Registry come first; the unknown-fallback
	 * variant (which accepts `blockName: string | null` with permissive
	 * attrs) is appended LAST.
	 *
	 * v0.6.3: switched from `oneOf` to `anyOf` at this top level. The
	 * fallback variant relies on `not: { enum: known_names }` to exclude
	 * blocks that are already covered by a typed variant — but WP core's
	 * `rest_validate_value_from_schema` does NOT honor the `not` keyword
	 * inside oneOf alternatives in practice (it's not in the supported-keyword
	 * set for combining operators), so `not` is silently ignored. With `oneOf`
	 * that caused every known block to match BOTH its typed variant AND the
	 * permissive fallback → `rest_find_one_matching_schema` rejected the
	 * response with "matches more than one of the expected formats" for every
	 * page containing any registered block. `anyOf` tolerates multi-match,
	 * which is the correct semantic anyway: at the type-system level,
	 * json-schema-to-typescript emits the same union for both oneOf and anyOf,
	 * and consumers narrow on `block.blockName === "core/paragraph"` at the
	 * application level — runtime exclusivity isn't required.
	 *
	 * @return array<string, mixed>
	 */
	public static function block_items_one_of(): array {
		$variants   = BlockTypeSchema::all_variants();
		$variants[] = self::block_node_schema();   // fallback, must be last
		return [ 'anyOf' => $variants ];
	}

	/**
	 * The unknown-block fallback variant. Single canonical node shape that
	 * matches blocks whose name is NOT in any typed variant (third-party
	 * blocks not registered at request time) or is null (parse_blocks's
	 * "freeform" wrapper around classic / page-builder content).
	 *
	 * CRITICAL: the blockName's string variant uses `not: { enum: [...] }`
	 * excluding every known block name. Without this exclusion, a known
	 * block like `core/paragraph` would match BOTH its typed variant AND
	 * this fallback, and WP's `rest_find_one_matching_schema` rejects
	 * responses with "matches more than one of the expected formats."
	 * WP REST schema validator supports `not` since 5.6; the floor is 6.9.
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
		$known_names   = self::known_block_names();
		$string_branch = [ 'type' => 'string' ];
		if ( ! empty( $known_names ) ) {
			$string_branch['not'] = [ 'enum' => $known_names ];
		}

		return [
			'type'                 => 'object',
			'additionalProperties' => false,
			'required'             => [ 'blockName', 'attrs', 'innerBlocks', 'innerHTML', 'innerContent' ],
			'properties'           => [
				'blockName'    => [
					'oneOf' => [
						$string_branch,
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
	 * Collect every blockName already claimed by a BlockTypeSchema typed
	 * variant. Used to build the fallback's `not: { enum: [...] }` exclusion
	 * so a known block name never dual-matches.
	 *
	 * @return array<int, string>
	 */
	private static function known_block_names(): array {
		$names = [];
		foreach ( BlockTypeSchema::all_variants() as $variant ) {
			$enum = $variant['properties']['blockName']['enum'] ?? [];
			if ( ! is_array( $enum ) ) {
				continue;
			}
			foreach ( $enum as $name ) {
				$names[] = (string) $name;
			}
		}
		return $names;
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
