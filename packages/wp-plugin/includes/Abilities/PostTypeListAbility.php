<?php
/**
 * PostTypeListAbility — factory for "list entries from a public CPT" abilities.
 *
 * Every CPT-list ability we expose (jab/get-posts, jab/get-beers, etc.) shares
 * the same input shape (numberposts + post_status), the same output shape
 * (id/title/excerpt/date/slug/link [+ acf] per item), the same permission
 * gate, and the same `meta.mcp.public => true` flag. Only the post_type,
 * ability name, label, description, response wrapper key, and default count
 * vary.
 *
 * If ACF is active and the post_type has at least one supported ACF field
 * declared via a simple `post_type==<name>` location rule, an `acf` property
 * is injected into the output schema and populated at execute time.
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Abilities;

use Jab\WpHeadlessKit\Acf\Schema as AcfSchema;

defined( 'ABSPATH' ) || exit;

final class PostTypeListAbility {

	public const CATEGORY = 'jab-content';

	/**
	 * Register a CPT-list ability with the abilities API.
	 *
	 * @param array{
	 *     name: string,
	 *     post_type: string,
	 *     label: string,
	 *     description: string,
	 *     wrapper_key: string,
	 *     noun: string,
	 *     default_count: int,
	 * } $config Ability configuration.
	 */
	public static function register( array $config ): void {
		// Resolve ACF schema once at registration time. If ACF is inactive or
		// no field groups apply, $acf_schema is null and the ability behaves
		// exactly as before — no `acf` property anywhere.
		$acf_schema = AcfSchema::for_post_type( (string) $config['post_type'] );

		wp_register_ability(
			$config['name'],
			[
				'label'               => $config['label'],
				'description'         => $config['description'],
				'category'            => self::CATEGORY,
				'input_schema'        => self::input_schema( $config ),
				'output_schema'       => self::output_schema( (string) $config['wrapper_key'], $acf_schema ),
				'execute_callback'    => static function ( array $input ) use ( $config, $acf_schema ): array {
					return self::execute( $config, $input, $acf_schema );
				},
				'permission_callback' => static function (): bool {
					return current_user_can( 'read' );
				},
				'meta'                => [
					'mcp' => [
						'public' => true,
					],
				],
			]
		);
	}

	/**
	 * @param array<string, mixed>      $config
	 * @param array<string, mixed>      $input       Already validated against the input schema.
	 * @param array<string, mixed>|null $acf_schema  ACF schema fragment, or null if ACF is inactive / no fields apply.
	 * @return array<string, mixed>
	 */
	private static function execute( array $config, array $input, ?array $acf_schema ): array {
		$count  = isset( $input['numberposts'] ) ? (int) $input['numberposts'] : (int) $config['default_count'];
		$status = isset( $input['post_status'] ) ? (string) $input['post_status'] : 'publish';

		$rows = get_posts(
			[
				'numberposts'      => $count,
				'post_status'      => $status,
				'post_type'        => (string) $config['post_type'],
				'suppress_filters' => false,
				'no_found_rows'    => true,
			]
		);

		return [
			$config['wrapper_key'] => array_map(
				static function ( \WP_Post $post ) use ( $acf_schema ): array {
					return self::shape_row( $post, $acf_schema );
				},
				$rows
			),
		];
	}

	/**
	 * Render a WP_Post into the canonical headless shape — id/title/excerpt/
	 * date/slug/link, plus an `acf` object when an ACF schema is provided.
	 *
	 * Public so PostTypeBySlugAbility (and any future single-record factory)
	 * can produce the same shape from the same recursive walker without
	 * duplicating the rendering or enrichment logic. The walker, attachment
	 * resolver, and FC variant picker are all internal to this class.
	 *
	 * @param array<string, mixed>|null $acf_schema
	 * @return array<string, mixed>
	 */
	public static function shape_row( \WP_Post $post, ?array $acf_schema ): array {
		// Decode HTML entities so headless consumers get clean strings.
		// `get_the_title()` runs WP's `the_title` filter, which texturizes
		// apostrophes/quotes into named/numeric entities (e.g. "Worker's"
		// becomes "Worker&#8217;s"). That formatting belongs in PHP-rendered
		// HTML, not in a JSON payload — every JS consumer would otherwise
		// have to re-decode it.
		$row = [
			'id'      => (int) $post->ID,
			'title'   => html_entity_decode( get_the_title( $post ), ENT_QUOTES | ENT_HTML5, 'UTF-8' ),
			'excerpt' => html_entity_decode( wp_strip_all_tags( get_the_excerpt( $post ) ), ENT_QUOTES | ENT_HTML5, 'UTF-8' ),
			'date'    => mysql_to_rfc3339( $post->post_date_gmt ),
			'slug'    => (string) $post->post_name,
			'link'    => (string) get_permalink( $post ),
		];

		if ( null !== $acf_schema && function_exists( 'get_fields' ) ) {
			$all_fields = get_fields( $post->ID );
			$all_fields = is_array( $all_fields ) ? $all_fields : [];
			$walked     = self::walk_and_enrich( $all_fields, $acf_schema );
			$row['acf'] = is_array( $walked ) ? $walked : [];
		}

		return $row;
	}

	/**
	 * Recursively walk a runtime value alongside its JSON Schema, applying
	 * media enrichment at every `x-acf-media`-marked node, picking the
	 * matching `oneOf` variant for ACF flexible_content layouts via the
	 * `acf_fc_layout` discriminator, and dropping values that don't match
	 * their declared type.
	 *
	 * Returns the walked value, or null when the value should be dropped
	 * from its parent (type mismatch, unresolvable media, unknown FC
	 * layout, etc.). Empty objects and empty arrays are NOT dropped — they
	 * are valid concrete values per the schema.
	 *
	 * The walker is the single place runtime+schema meet. Adding a new
	 * vendor extension keyword (e.g. `x-acf-link` for relational
	 * normalization) means adding one branch here, not threading another
	 * map through every call site.
	 *
	 * @param mixed                $value
	 * @param array<string, mixed> $schema
	 * @return mixed
	 */
	private static function walk_and_enrich( $value, array $schema ) {
		// Vendor-extension: media node. Resolve regardless of the value's
		// current shape (int ID, attachment array, even false-sentinel) into
		// the rich attachment object the schema declares.
		if ( isset( $schema['x-acf-media'] ) && is_array( $schema['x-acf-media'] ) ) {
			return self::resolve_attachment( $value );
		}

		if ( null === $value ) {
			return null;
		}

		// Discriminated union (ACF flexible_content). Pick the variant whose
		// `acf_fc_layout` const matches the runtime value, then recurse.
		if ( isset( $schema['oneOf'] ) && is_array( $schema['oneOf'] ) ) {
			$variant = self::pick_variant( $value, $schema['oneOf'] );
			if ( null === $variant ) {
				return null;
			}
			return self::walk_and_enrich( $value, $variant );
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
				$walked = self::walk_and_enrich( $item, $items_schema );
				if ( null !== $walked ) {
					$out[] = $walked;
				}
			}
			return $out;
		}

		if ( 'object' === $type ) {
			// ACF post_object with return_format=object hands us a WP_Post
			// instance. Cast to array so property access works uniformly.
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
					$walked = self::walk_and_enrich( $sub_value, $properties[ $key ] );
					if ( null !== $walked ) {
						$out[ $key ] = $walked;
					}
				} elseif ( $additional_allowed && null !== $sub_value ) {
					// No declared schema for this key, but additionalProperties
					// isn't false — pass through (e.g. extra WP_Post fields).
					$out[ $key ] = $sub_value;
				}
				// Otherwise: drop — schema says this key shouldn't exist.
			}
			return $out;
		}

		// Scalar leaf — type-check against the declared scalar type.
		if ( '' !== $type && ! self::value_matches_scalar_type( $value, (string) $type ) ) {
			return null;
		}
		return $value;
	}

	/**
	 * Pick the oneOf variant whose `acf_fc_layout` const property matches
	 * the runtime value's `acf_fc_layout` field. Returns null when no
	 * variant matches (unknown layout name, malformed value, etc.) so the
	 * caller can drop the whole layout from the output array.
	 *
	 * @param mixed                              $value
	 * @param array<int, array<string, mixed>>   $variants
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
			if ( is_array( $discriminator ) && ( $discriminator['const'] ?? null ) === $layout ) {
				return $variant;
			}
		}
		return null;
	}

	/**
	 * Resolve a single ACF media value to the rich attachment array shape.
	 * Integer IDs go through ACF's acf_get_attachment() (which produces the
	 * canonical shape image_schema/file_schema declare). Already-array values
	 * pass through. Anything else returns null so the caller can drop it.
	 *
	 * @param mixed $value
	 * @return array<int|string, mixed>|null
	 */
	private static function resolve_attachment( $value ): ?array {
		if ( is_array( $value ) ) {
			// Already an attachment array (Return Format = Array). Pass through.
			return $value;
		}
		if ( ! is_int( $value ) || $value <= 0 ) {
			return null;
		}
		if ( function_exists( 'acf_get_attachment' ) ) {
			$attachment = acf_get_attachment( $value );
			return is_array( $attachment ) ? $attachment : null;
		}
		// ACF unexpectedly missing despite is_active() — fall back to a
		// minimal core-WP shape so the page still gets a URL.
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
	 * Does a runtime PHP value match a scalar JSON Schema type? Used by
	 * the recursive walker to drop ACF's "empty" sentinel values (false
	 * for empty boolean-typed fields would still be valid, but `''` for
	 * empty number / `false` for empty url-string are not). Only handles
	 * scalar types — array and object are dispatched by the walker
	 * before reaching here.
	 *
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

	/**
	 * @param array<string, mixed> $config
	 * @return array<string, mixed>
	 */
	private static function input_schema( array $config ): array {
		return [
			'type'                 => 'object',
			'additionalProperties' => false,
			'properties'           => [
				'numberposts' => [
					'type'        => 'integer',
					'description' => sprintf(
						/* translators: %s: noun for the items returned (e.g. "posts", "beers"). */
						__( 'Number of %s to return.', 'wp-headless-kit' ),
						$config['noun']
					),
					'minimum'     => 1,
					'maximum'     => 100,
					'default'     => (int) $config['default_count'],
				],
				'post_status' => [
					'type'        => 'string',
					'description' => __( 'Post status filter.', 'wp-headless-kit' ),
					'enum'        => [ 'publish', 'draft', 'any' ],
					'default'     => 'publish',
				],
			],
		];
	}

	/**
	 * @param array<string, mixed>|null $acf_schema  When non-null, an `acf`
	 *                                              property is included in
	 *                                              the per-item shape.
	 * @return array<string, mixed>
	 */
	private static function output_schema( string $wrapper_key, ?array $acf_schema ): array {
		$item_properties = [
			'id'      => [ 'type' => 'integer' ],
			'title'   => [ 'type' => 'string' ],
			'excerpt' => [ 'type' => 'string' ],
			'date'    => [
				'type'        => 'string',
				'format'      => 'date-time',
				'description' => __( 'Published date in RFC3339 (UTC).', 'wp-headless-kit' ),
			],
			'slug'    => [ 'type' => 'string' ],
			'link'    => [
				'type'   => 'string',
				'format' => 'uri',
			],
		];
		$required = [ 'id', 'title', 'excerpt', 'date', 'slug', 'link' ];

		if ( null !== $acf_schema ) {
			$item_properties['acf'] = $acf_schema;
			$required[]             = 'acf';
		}

		return [
			'type'       => 'object',
			'required'   => [ $wrapper_key ],
			'properties' => [
				$wrapper_key => [
					'type'  => 'array',
					'items' => [
						'type'       => 'object',
						'required'   => $required,
						'properties' => $item_properties,
					],
				],
			],
		];
	}
}
