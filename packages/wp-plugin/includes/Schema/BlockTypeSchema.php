<?php
/**
 * BlockTypeSchema — emits one JSON Schema variant per registered block type,
 * derived from WP_Block_Type_Registry. Feeds BlockSchema::block_node_schema()
 * as the array of `oneOf` variants alongside a permissive fallback.
 *
 * Per-block-type variants give the SDK a discriminated union over `blockName`:
 *
 *   type BlockNode =
 *     | { blockName: "core/paragraph"; attrs: ParagraphAttrs; ... }
 *     | { blockName: "core/heading";   attrs: HeadingAttrs;   ... }
 *     | { blockName: "acf/hero";       attrs: { data: HeroFields }; ... }
 *     | { blockName: string | null;    attrs: object;                ... }  // fallback
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Schema;

use Jab\WpHeadlessKit\Acf\BlockFieldSchema;

defined( 'ABSPATH' ) || exit;

final class BlockTypeSchema {

	/**
	 * Per-request memoization. Walking WP_Block_Type_Registry +
	 * BlockFieldSchema for every variant is cheap (sub-ms on typical sites),
	 * but multiple ability registrations in the same `wp_abilities_api_init`
	 * cycle would otherwise re-walk redundantly.
	 *
	 * @var array<int, array<string, mixed>>|null
	 */
	private static $cached = null;

	/**
	 * Return one variant per registered block type. Order is registry-order;
	 * the unknown-fallback variant is added separately by BlockSchema.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public static function all_variants(): array {
		if ( null !== self::$cached ) {
			return self::$cached;
		}
		$variants = [];
		if ( class_exists( 'WP_Block_Type_Registry' ) ) {
			$registry = \WP_Block_Type_Registry::get_instance();
			$types    = $registry->get_all_registered();
			if ( is_array( $types ) ) {
				foreach ( $types as $block_type ) {
					$variant = self::variant_for( $block_type );
					if ( null !== $variant ) {
						$variants[] = $variant;
					}
				}
			}
		}
		self::$cached = $variants;
		return $variants;
	}

	/**
	 * Reset the per-request cache. Public so tests can force a rebuild after
	 * mutating their canned registry. Not called from production paths.
	 */
	public static function flush_cache(): void {
		self::$cached = null;
	}

	/**
	 * @param mixed $block_type  WP_Block_Type instance (or test stdClass with .name + .attributes).
	 * @return array<string, mixed>|null
	 */
	private static function variant_for( $block_type ): ?array {
		if ( ! is_object( $block_type ) ) {
			return null;
		}
		$name = isset( $block_type->name ) ? (string) $block_type->name : '';
		if ( '' === $name ) {
			return null;
		}
		$attributes = isset( $block_type->attributes ) && is_array( $block_type->attributes )
			? $block_type->attributes
			: [];

		return [
			'type'                 => 'object',
			'additionalProperties' => false,
			'required'             => [ 'blockName', 'attrs', 'innerBlocks', 'innerHTML', 'innerContent' ],
			'properties'           => [
				'blockName'    => [
					'type' => 'string',
					'enum' => [ $name ],
				],
				'attrs'        => self::attrs_schema_for( $name, $attributes ),
				'innerBlocks'  => [
					'type'  => 'array',
					'items' => [ 'type' => 'object', 'additionalProperties' => true ],
				],
				'innerHTML'    => [ 'type' => 'string' ],
				'innerContent' => [
					'type'  => 'array',
					'items' => [ 'oneOf' => [ [ 'type' => 'string' ], [ 'type' => 'null' ] ] ],
				],
			],
		];
	}

	/**
	 * Derive the attrs schema from block.json `attributes`. ACF Blocks
	 * (`acf/*`) get `attrs.data` typed from their bound field group via
	 * BlockFieldSchema. Non-ACF blocks get a strict object schema with one
	 * property per declared attribute; sourced attributes are included but
	 * left out of `required` (their values live in innerHTML, not stored
	 * attrs, so runtime validation must tolerate absence).
	 *
	 * @param array<string, mixed> $attributes
	 * @return array<string, mixed>
	 */
	private static function attrs_schema_for( string $block_name, array $attributes ): array {
		// ACF Blocks: bind attrs.data to the field group schema if one exists.
		if ( 0 === strpos( $block_name, 'acf/' ) ) {
			$data_schema = BlockFieldSchema::for_block_name( $block_name );
			if ( null !== $data_schema ) {
				return [
					'type'                 => 'object',
					'additionalProperties' => true,   // ACF Blocks carry meta keys (mode, name, align, etc.) we don't constrain
					'properties'           => [
						'data' => $data_schema,
					],
				];
			}
			// No bound field group — fall through to the permissive shape.
		}

		if ( empty( $attributes ) ) {
			return [ 'type' => 'object', 'additionalProperties' => true ];
		}

		$properties = [];
		foreach ( $attributes as $attr_name => $attr_def ) {
			if ( ! is_string( $attr_name ) || '' === $attr_name ) {
				continue;
			}
			if ( ! is_array( $attr_def ) ) {
				continue;
			}
			$properties[ $attr_name ] = self::attribute_to_schema( $attr_def );
		}

		return [
			'type'                 => 'object',
			'additionalProperties' => false,
			'required'             => [],   // see attrs_schema_for() docblock
			'properties'           => $properties,
		];
	}

	/**
	 * Map a single block.json attribute definition to a JSON Schema fragment.
	 * Maps `type`, `default`, `enum`. Ignores `source`, `selector`, `query`,
	 * `attribute` (those are extraction directives, not schema).
	 *
	 * @param array<string, mixed> $attr_def
	 * @return array<string, mixed>
	 */
	private static function attribute_to_schema( array $attr_def ): array {
		$schema = [];
		$type   = $attr_def['type'] ?? null;
		if ( is_string( $type ) ) {
			$schema['type'] = $type;
		} elseif ( is_array( $type ) ) {
			// block.json allows array of types; emit as oneOf<scalar>.
			$schema['oneOf'] = array_map(
				static fn( $t ): array => [ 'type' => (string) $t ],
				$type
			);
		} else {
			$schema['type']                 = 'object';
			$schema['additionalProperties'] = true;
		}
		if ( isset( $attr_def['enum'] ) && is_array( $attr_def['enum'] ) ) {
			$schema['enum'] = array_values( $attr_def['enum'] );
		}
		if ( array_key_exists( 'default', $attr_def ) ) {
			$schema['default'] = $attr_def['default'];
		}
		return $schema;
	}
}
