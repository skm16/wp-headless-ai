<?php
/**
 * AcfValueWalker — recursive JSON-Schema-aware enrichment of ACF runtime values.
 *
 * Walks a value alongside its declared schema, applying media enrichment at
 * every `x-acf-media`-marked node, picking the matching `oneOf` variant for
 * ACF flexible_content layouts via the `acf_fc_layout` discriminator, and
 * dropping values that don't match their declared type or format.
 *
 * Extracted from `PostTypeListAbility::walk_and_enrich()` in v0.6 so both
 * post-meta-bound ACF (the original caller) and ACF Block `attrs.data`
 * enrichment (BlockParser, new in v0.6) can share the same recursion.
 *
 * Returns the walked value, or null when the value should be dropped from
 * its parent (type mismatch, unresolvable media, unknown FC layout, etc.).
 * Empty objects and empty arrays are NOT dropped — they're valid concrete
 * values per the schema.
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Schema;

defined( 'ABSPATH' ) || exit;

final class AcfValueWalker {

	/**
	 * Walk a runtime value alongside its JSON Schema fragment.
	 *
	 * @param mixed                $value
	 * @param array<string, mixed> $schema
	 * @return mixed
	 */
	public static function walk( $value, array $schema ) {
		if ( isset( $schema['x-acf-media'] ) && is_array( $schema['x-acf-media'] ) ) {
			return self::resolve_attachment( $value );
		}

		if ( null === $value ) {
			return null;
		}

		if ( isset( $schema['oneOf'] ) && is_array( $schema['oneOf'] ) ) {
			$variant = self::pick_variant( $value, $schema['oneOf'] );
			if ( null === $variant ) {
				return null;
			}
			return self::walk( $value, $variant );
		}

		$type = $schema['type'] ?? '';

		if ( 'array' === $type ) {
			if ( ! is_array( $value ) ) {
				return null;
			}
			$items_schema = $schema['items'] ?? null;
			if ( ! is_array( $items_schema ) ) {
				return $value;
			}
			$out = [];
			foreach ( $value as $item ) {
				$walked = self::walk( $item, $items_schema );
				if ( null !== $walked ) {
					$out[] = $walked;
				}
			}
			return $out;
		}

		if ( 'object' === $type ) {
			if ( is_object( $value ) ) {
				$value = (array) $value;
			}
			if ( ! is_array( $value ) ) {
				return null;
			}
			$properties         = isset( $schema['properties'] ) && is_array( $schema['properties'] ) ? $schema['properties'] : [];
			$additional_allowed = ( $schema['additionalProperties'] ?? null ) !== false;
			$out                = [];
			foreach ( $value as $key => $sub_value ) {
				$key = (string) $key;
				if ( isset( $properties[ $key ] ) && is_array( $properties[ $key ] ) ) {
					$walked = self::walk( $sub_value, $properties[ $key ] );
					if ( null !== $walked ) {
						$out[ $key ] = $walked;
					}
				} elseif ( $additional_allowed && null !== $sub_value ) {
					$out[ $key ] = $sub_value;
				}
			}
			return $out;
		}

		if ( '' !== $type && ! self::value_matches_scalar_type( $value, (string) $type ) ) {
			return null;
		}

		// BUG-1: format-constrained strings (uri / email / date / date-time)
		// fail REST output validation when empty OR malformed (e.g. ACF
		// date_picker stores Ymd by default — "20260523" — which fails
		// JSON Schema `format: date`). ACF fields aren't in any `required`
		// list, so dropping is safe.
		if ( 'string' === $type && isset( $schema['format'] ) ) {
			if ( '' === $value || ! self::value_matches_format( $value, (string) $schema['format'] ) ) {
				return null;
			}
		}

		return $value;
	}

	/**
	 * Pick the matching variant from a oneOf array using the
	 * `acf_fc_layout` discriminator. Accepts either `const` or single-value
	 * `enum` — historical schemas may use either.
	 *
	 * @param mixed                            $value
	 * @param array<int, array<string, mixed>> $variants
	 * @return array<string, mixed>|null
	 */
	private static function pick_variant( $value, array $variants ): ?array {
		if ( ! is_array( $value ) ) {
			return null;
		}
		$layout = $value['acf_fc_layout'] ?? null;
		if ( ! is_string( $layout ) ) {
			return null;
		}
		foreach ( $variants as $variant ) {
			if ( ! is_array( $variant ) ) {
				continue;
			}
			$properties = $variant['properties'] ?? null;
			if ( ! is_array( $properties ) ) {
				continue;
			}
			$discriminator = $properties['acf_fc_layout'] ?? null;
			if ( ! is_array( $discriminator ) ) {
				continue;
			}
			if ( ( $discriminator['const'] ?? null ) === $layout ) {
				return $variant;
			}
			$enum = $discriminator['enum'] ?? null;
			if ( is_array( $enum ) && in_array( $layout, $enum, true ) ) {
				return $variant;
			}
		}
		return null;
	}

	/**
	 * Resolve an attachment value (integer ID or already-array) to the
	 * canonical attachment shape via ACF's `acf_get_attachment()` when
	 * available, falling back to `wp_get_attachment_url()`.
	 *
	 * @param mixed $value
	 * @return array<int|string, mixed>|null
	 */
	private static function resolve_attachment( $value ): ?array {
		if ( is_array( $value ) ) {
			return $value;
		}
		if ( ! is_int( $value ) || $value <= 0 ) {
			return null;
		}
		if ( function_exists( 'acf_get_attachment' ) ) {
			$attachment = acf_get_attachment( $value );
			return is_array( $attachment ) ? $attachment : null;
		}
		$url = wp_get_attachment_url( $value );
		if ( false === $url ) {
			return null;
		}
		return [
			'ID'  => $value,
			'id'  => $value,
			'url' => (string) $url,
			'alt' => (string) get_post_meta( $value, '_wp_attachment_image_alt', true ),
		];
	}

	/**
	 * Lightweight JSON Schema format check. Permissive on unknown formats.
	 *
	 * @param mixed $value
	 */
	private static function value_matches_format( $value, string $format ): bool {
		if ( ! is_string( $value ) ) {
			return false;
		}
		switch ( $format ) {
			case 'uri':
				return false !== filter_var( $value, FILTER_VALIDATE_URL );
			case 'email':
				return false !== filter_var( $value, FILTER_VALIDATE_EMAIL );
			case 'date':
				return (bool) preg_match( '/^\d{4}-\d{2}-\d{2}$/', $value );
			case 'date-time':
				return (bool) preg_match( '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/', $value );
			default:
				return true;
		}
	}

	/**
	 * @param mixed $value
	 */
	private static function value_matches_scalar_type( $value, string $expected_type ): bool {
		switch ( $expected_type ) {
			case 'string':
				return is_string( $value );
			case 'number':
				return is_int( $value ) || is_float( $value );
			case 'integer':
				return is_int( $value );
			case 'boolean':
				return is_bool( $value );
			default:
				return true;
		}
	}
}
