<?php
/**
 * ACF schema generator — turns ACF field group definitions into JSON Schema
 * fragments so PostTypeListAbility can inject `acf` properties into its
 * output schemas at registration time.
 *
 * Scope (v0):
 *   - text, textarea, wysiwyg, oembed       -> string
 *   - number                                 -> number
 *   - true_false                             -> boolean
 *   - url, email                             -> string with format
 *   - date_picker, date_time_picker, time   -> string with format
 *   - color_picker                           -> string
 *   - select, radio, button_group           -> string [+ enum]
 *   - checkbox                               -> array<string> [+ enum]
 *
 * Skipped for v0 (return null from to_field_schema, dropped from output):
 *   - tab / message / accordion / clone     (no value — UI only)
 *   - image / file / gallery                 (return_format complications)
 *   - link / page_link / post_object         (object shapes / relational)
 *   - relationship / taxonomy / user        (relational unwrapping)
 *   - flexible_content / group / repeater   (complex / recursive)
 *   - google_map                             (object shape)
 *
 * Anything skipped is silently omitted from the schema so callers see a
 * clean subset rather than an error. Agencies can extend per-field-type
 * support incrementally without breaking existing schemas.
 *
 * @package Skm\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Skm\WpHeadlessKit\Acf;

defined( 'ABSPATH' ) || exit;

final class Schema {

	/**
	 * Is the ACF plugin (free or pro) loaded?
	 *
	 * Used to gate the entire integration; sites without ACF behave exactly
	 * as before — no `acf` property in any output schema.
	 */
	public static function is_active(): bool {
		return function_exists( 'acf_get_field_groups' )
			&& function_exists( 'acf_get_fields' )
			&& function_exists( 'get_fields' );
	}

	/**
	 * Return a JSON Schema fragment describing the merged ACF fields for a
	 * given post_type, or null if ACF is inactive / no fields apply.
	 *
	 * Shape:
	 *   [ 'type' => 'object', 'properties' => [...], 'additionalProperties' => false ]
	 *
	 * @return array<string, mixed>|null
	 */
	public static function for_post_type( string $post_type ): ?array {
		if ( ! self::is_active() ) {
			return null;
		}

		$properties = self::collect_fields( $post_type );
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
	 * Walk every ACF field group and collect property schemas for those that
	 * apply (by simple location rule) to the given post_type.
	 *
	 * @return array<string, array<string, mixed>>
	 */
	private static function collect_fields( string $post_type ): array {
		$properties = [];

		$groups = acf_get_field_groups();
		if ( ! is_array( $groups ) ) {
			return $properties;
		}

		foreach ( $groups as $group ) {
			if ( ! self::group_applies_to_post_type( $group, $post_type ) ) {
				continue;
			}
			$fields = acf_get_fields( $group['key'] ?? $group );
			if ( ! is_array( $fields ) ) {
				continue;
			}
			foreach ( $fields as $field ) {
				$schema = self::to_field_schema( $field );
				if ( null === $schema ) {
					continue;
				}
				$name = isset( $field['name'] ) ? (string) $field['name'] : '';
				if ( '' === $name ) {
					continue;
				}
				// Last-write-wins on duplicate field names. This matches ACF
				// runtime behavior — later-loaded groups override earlier ones.
				$properties[ $name ] = $schema;
			}
		}

		return $properties;
	}

	/**
	 * Does the given field group's location rules contain a simple
	 * `post_type == <post_type>` clause?
	 *
	 * ACF location rules are nested arrays: outer = OR, inner = AND. We
	 * accept the field group if ANY OR-clause contains a single AND-rule
	 * matching `post_type == <post_type>`. Field groups with more complex
	 * rules (template + post_type, taxonomy + post_type, etc.) are
	 * intentionally not matched in v0 — they'd bring schema-generation
	 * complexity that doesn't justify itself yet.
	 *
	 * @param array<string, mixed> $group
	 */
	private static function group_applies_to_post_type( array $group, string $post_type ): bool {
		$location = $group['location'] ?? [];
		if ( ! is_array( $location ) ) {
			return false;
		}
		foreach ( $location as $or_clause ) {
			if ( ! is_array( $or_clause ) ) {
				continue;
			}
			foreach ( $or_clause as $rule ) {
				if (
					isset( $rule['param'], $rule['operator'], $rule['value'] )
					&& 'post_type' === $rule['param']
					&& '==' === $rule['operator']
					&& $post_type === $rule['value']
				) {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * Translate a single ACF field array to a JSON Schema property, or null
	 * if the field type is unsupported / has no value (tabs etc.).
	 *
	 * @param array<string, mixed> $field
	 * @return array<string, mixed>|null
	 */
	private static function to_field_schema( array $field ): ?array {
		$type        = (string) ( $field['type'] ?? '' );
		$label       = isset( $field['label'] ) ? (string) $field['label'] : '';
		$instructions = isset( $field['instructions'] ) ? (string) $field['instructions'] : '';
		$description = trim( $label . ( '' !== $instructions ? ' — ' . $instructions : '' ) );

		switch ( $type ) {
			case 'text':
			case 'textarea':
			case 'wysiwyg':
			case 'oembed':
			case 'password':
				return self::with_description( [ 'type' => 'string' ], $description );

			case 'number':
			case 'range':
				return self::with_description( [ 'type' => 'number' ], $description );

			case 'true_false':
				return self::with_description( [ 'type' => 'boolean' ], $description );

			case 'url':
				return self::with_description( [ 'type' => 'string', 'format' => 'uri' ], $description );

			case 'email':
				return self::with_description( [ 'type' => 'string', 'format' => 'email' ], $description );

			case 'date_picker':
				return self::with_description( [ 'type' => 'string', 'format' => 'date' ], $description );

			case 'date_time_picker':
				return self::with_description( [ 'type' => 'string', 'format' => 'date-time' ], $description );

			case 'time_picker':
				return self::with_description( [ 'type' => 'string' ], $description );

			case 'color_picker':
				return self::with_description( [ 'type' => 'string' ], $description );

			case 'select':
			case 'radio':
			case 'button_group':
				return self::with_description( self::enum_string( $field ), $description );

			case 'checkbox':
				return self::with_description(
					[
						'type'  => 'array',
						'items' => self::enum_string( $field ),
					],
					$description
				);

			default:
				// Unsupported in v0 — skip silently.
				return null;
		}
	}

	/**
	 * @param array<string, mixed> $field
	 * @return array<string, mixed>
	 */
	private static function enum_string( array $field ): array {
		$schema  = [ 'type' => 'string' ];
		$choices = $field['choices'] ?? null;
		if ( is_array( $choices ) && ! empty( $choices ) ) {
			$schema['enum'] = array_values( array_map( 'strval', array_keys( $choices ) ) );
		}
		return $schema;
	}

	/**
	 * @param array<string, mixed> $schema
	 * @return array<string, mixed>
	 */
	private static function with_description( array $schema, string $description ): array {
		if ( '' !== $description ) {
			$schema['description'] = $description;
		}
		return $schema;
	}
}
