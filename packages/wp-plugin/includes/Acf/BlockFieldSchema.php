<?php
/**
 * BlockFieldSchema — schema for ACF field groups bound to a block via
 * `block==<name>` location rules. Parallel to Acf\Schema's post-type path.
 *
 * Returns the same `{ type: object, properties, additionalProperties: false }`
 * fragment Acf\Schema::for_post_type() produces, so consumers (BlockTypeSchema
 * for emission, BlockParser for runtime enrichment) can treat both shapes
 * identically.
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Acf;

defined( 'ABSPATH' ) || exit;

final class BlockFieldSchema {

	/**
	 * Return a JSON Schema fragment for the merged ACF fields of every group
	 * whose location rules target this block. Returns null when ACF is
	 * inactive or no group targets the block.
	 *
	 * @return array<string, mixed>|null
	 */
	public static function for_block_name( string $block_name ): ?array {
		if ( ! Schema::is_active() ) {
			return null;
		}

		$properties = self::collect_fields( $block_name );
		if ( empty( $properties ) ) {
			return null;
		}

		return [
			'type'                 => 'object',
			'additionalProperties' => false,
			'properties'           => $properties,
		];
	}

	/**
	 * Walk every loaded ACF field group; collect property schemas for any
	 * group whose location rules include a `block==<block_name>` clause.
	 *
	 * @return array<string, array<string, mixed>>
	 */
	private static function collect_fields( string $block_name ): array {
		$groups = acf_get_field_groups();
		if ( ! is_array( $groups ) ) {
			return [];
		}

		$properties = [];
		foreach ( $groups as $group ) {
			if ( ! is_array( $group ) ) {
				continue;
			}
			if ( ! self::group_applies_to_block( $group, $block_name ) ) {
				continue;
			}
			$fields = acf_get_fields( $group );
			if ( ! is_array( $fields ) ) {
				continue;
			}
			foreach ( $fields as $field ) {
				if ( ! is_array( $field ) ) {
					continue;
				}
				$name = isset( $field['name'] ) ? (string) $field['name'] : '';
				if ( '' === $name ) {
					continue;
				}
				$schema = Schema::to_field_schema_for_block( $field );
				if ( null === $schema ) {
					continue;
				}
				// Last-write-wins on duplicate field names, matching ACF
				// runtime semantics (later-loaded groups override earlier).
				$properties[ $name ] = $schema;
			}
		}
		return $properties;
	}

	/**
	 * Returns true if any OR-clause / AND-rule in the group's location set
	 * is `block == <block_name>`. ACF location is nested: outer = OR,
	 * inner = AND. We honor only `==` operator (not `!=`, etc.).
	 *
	 * @param array<string, mixed> $group
	 */
	private static function group_applies_to_block( array $group, string $block_name ): bool {
		$location = $group['location'] ?? [];
		if ( ! is_array( $location ) ) {
			return false;
		}
		foreach ( $location as $or_clause ) {
			if ( ! is_array( $or_clause ) ) {
				continue;
			}
			foreach ( $or_clause as $rule ) {
				if ( ! isset( $rule['param'], $rule['operator'], $rule['value'] ) ) {
					continue;
				}
				if ( '==' !== $rule['operator'] ) {
					continue;
				}
				if ( 'block' === $rule['param'] && $block_name === (string) $rule['value'] ) {
					return true;
				}
			}
		}
		return false;
	}
}
