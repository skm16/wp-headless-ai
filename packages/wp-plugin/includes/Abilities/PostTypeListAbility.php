<?php
/**
 * PostTypeListAbility — factory for "list entries from a public CPT" abilities.
 *
 * Every CPT-list ability we expose (jab/get-posts, jab/get-beers, etc.) shares
 * the same input shape (numberposts + post_status), the same output shape
 * (id/title/excerpt/date/slug/link [+ featured_image] [+ taxonomy arrays] [+ acf]
 * per item), the same permission gate, and the same `meta.mcp.public => true`
 * flag. Only the post_type, ability name, label, description, response wrapper
 * key, and default count vary.
 *
 * If ACF is active and the post_type has at least one supported ACF field
 * declared via a simple `post_type==<name>` location rule, an `acf` property
 * is injected into the output schema and populated at execute time.
 *
 * `featured_image` is injected when the post type supports thumbnails.
 *
 * Taxonomy arrays (one per registered public taxonomy) are always injected;
 * terms are batch-fetched once per execute call to avoid N+1 queries.
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Abilities;

use Jab\WpHeadlessKit\Acf\Schema as AcfSchema;
use Jab\WpHeadlessKit\Schema\MediaSchema;
use Jab\WpHeadlessKit\Schema\TaxonomySchema;

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
		$acf_schema         = AcfSchema::for_post_type( (string) $config['post_type'] );
		$supports_thumbnail = post_type_supports( (string) $config['post_type'], 'thumbnail' );
		$taxonomies         = self::public_taxonomies_for( (string) $config['post_type'] );

		wp_register_ability(
			$config['name'],
			[
				'label'               => $config['label'],
				'description'         => $config['description'],
				'category'            => self::CATEGORY,
				'input_schema'        => self::input_schema( $config ),
				'output_schema'       => self::output_schema( (string) $config['wrapper_key'], $acf_schema, $supports_thumbnail, $taxonomies ),
				'execute_callback'    => static function ( array $input ) use ( $config, $acf_schema, $supports_thumbnail, $taxonomies ): array {
					return self::execute( $config, $input, $acf_schema, $supports_thumbnail, $taxonomies );
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
	 * @param array<string, mixed>      $input              Already validated against the input schema.
	 * @param array<string, mixed>|null $acf_schema
	 * @param bool                      $supports_thumbnail
	 * @param string[]                  $taxonomies         Taxonomy slugs registered to this post type.
	 * @return array<string, mixed>
	 */
	private static function execute( array $config, array $input, ?array $acf_schema, bool $supports_thumbnail, array $taxonomies ): array {
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

		// Batch-fetch taxonomy terms for all posts in one query per taxonomy group,
		// then group results by post ID so shape_row() gets an O(1) lookup.
		$terms_by_post = self::batch_terms( $rows, $taxonomies );

		return [
			$config['wrapper_key'] => array_map(
				static function ( \WP_Post $post ) use ( $acf_schema, $supports_thumbnail, $terms_by_post, $taxonomies ): array {
					return self::shape_row( $post, $acf_schema, $supports_thumbnail, $terms_by_post[ $post->ID ] ?? [], $taxonomies );
				},
				$rows
			),
		];
	}

	/**
	 * Render a WP_Post into the canonical headless shape.
	 *
	 * Public so PostTypeBySlugAbility (and any future single-record factory) can
	 * reuse the same rendering logic. The $post_terms array is keyed by taxonomy
	 * slug → WP_Term[]; pass an empty array when no terms were fetched. The
	 * $taxonomies list is the full set of public taxonomies for the post type —
	 * any taxonomy listed here that has no terms for this post still gets an
	 * empty array slot, because output_schema marks each taxonomy `required`.
	 *
	 * @param array<string, mixed>|null    $acf_schema
	 * @param array<string, WP_Term[]>     $post_terms  Pre-fetched terms for this post, keyed by taxonomy slug.
	 * @param string[]                     $taxonomies  Full set of public taxonomies registered to this post type.
	 * @return array<string, mixed>
	 */
	public static function shape_row( \WP_Post $post, ?array $acf_schema, bool $supports_thumbnail = false, array $post_terms = [], array $taxonomies = [] ): array {
		$row = [
			'id'      => (int) $post->ID,
			'title'   => html_entity_decode( get_the_title( $post ), ENT_QUOTES | ENT_HTML5, 'UTF-8' ),
			'excerpt' => html_entity_decode( wp_strip_all_tags( get_the_excerpt( $post ) ), ENT_QUOTES | ENT_HTML5, 'UTF-8' ),
			'date'    => mysql_to_rfc3339( $post->post_date_gmt ),
			'slug'    => (string) $post->post_name,
			'link'    => (string) get_permalink( $post ),
		];

		if ( $supports_thumbnail ) {
			$row['featured_image'] = MediaSchema::resolve_for_post( (int) $post->ID );
		}

		foreach ( $taxonomies as $taxonomy ) {
			$row[ (string) $taxonomy ] = [];
		}

		foreach ( $post_terms as $taxonomy => $terms ) {
			$row[ (string) $taxonomy ] = array_map(
				[ TaxonomySchema::class, 'shape_term' ],
				$terms
			);
		}

		if ( null !== $acf_schema && function_exists( 'get_fields' ) ) {
			$all_fields = get_fields( $post->ID );
			$all_fields = is_array( $all_fields ) ? $all_fields : [];
			$walked     = self::walk_and_enrich( $all_fields, $acf_schema );
			$row['acf'] = is_array( $walked ) ? $walked : [];
		}

		return $row;
	}

	/**
	 * Batch-fetch taxonomy terms for a set of posts and group by post ID.
	 *
	 * Must pass `fields => all_with_object_id`: the default `all` mode
	 * deduplicates term rows across the input post set and leaves
	 * WP_Term->object_id unset, which collapses every term under post 0
	 * downstream and produces empty taxonomy arrays on each post.
	 *
	 * @param \WP_Post[] $posts
	 * @param string[]   $taxonomies
	 * @return array<int, array<string, \WP_Term[]>>  [post_id => [taxonomy_slug => WP_Term[]]]
	 */
	public static function batch_terms( array $posts, array $taxonomies ): array {
		if ( empty( $posts ) || empty( $taxonomies ) ) {
			return [];
		}

		$all_ids = array_map( static fn( \WP_Post $p ): int => (int) $p->ID, $posts );
		$result  = wp_get_object_terms( $all_ids, $taxonomies, [ 'fields' => 'all_with_object_id' ] );

		if ( is_wp_error( $result ) || ! is_array( $result ) ) {
			return [];
		}

		$grouped = [];
		foreach ( $result as $term ) {
			if ( ! ( $term instanceof \WP_Term ) ) {
				continue;
			}
			$grouped[ (int) $term->object_id ][ (string) $term->taxonomy ][] = $term;
		}
		return $grouped;
	}

	/**
	 * Return public taxonomy slugs registered for a post type, excluding
	 * WP internals that are already covered by dedicated abilities or
	 * are not meaningful in a headless context.
	 *
	 * @return string[]
	 */
	public static function public_taxonomies_for( string $post_type ): array {
		$exclude    = [ 'post_format', 'nav_menu', 'link_category', 'wp_pattern_category' ];
		$taxonomies = get_object_taxonomies( $post_type, 'objects' );
		$slugs      = [];
		foreach ( $taxonomies as $tax ) {
			if ( ! $tax->public || in_array( $tax->name, $exclude, true ) ) {
				continue;
			}
			$slugs[] = (string) $tax->name;
		}
		return $slugs;
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
	 * @param mixed                $value
	 * @param array<string, mixed> $schema
	 * @return mixed
	 */
	private static function walk_and_enrich( $value, array $schema ) {
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
					$out[ $key ] = $sub_value;
				}
			}
			return $out;
		}

		if ( '' !== $type && ! self::value_matches_scalar_type( $value, (string) $type ) ) {
			return null;
		}
		return $value;
	}

	/**
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
			if ( ! is_array( $discriminator ) ) {
				continue;
			}
			// Accept either `const` or `enum: [name]` — the emitter switched
			// to single-value enum because WP core ignores `const` during
			// schema validation, but historical schemas may still use const.
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
	 * @param array<string, mixed>|null $acf_schema
	 * @param string[]                  $taxonomies
	 * @return array<string, mixed>
	 */
	private static function output_schema( string $wrapper_key, ?array $acf_schema, bool $supports_thumbnail, array $taxonomies ): array {
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

		if ( $supports_thumbnail ) {
			$item_properties['featured_image'] = MediaSchema::nullable_image();
			$required[]                        = 'featured_image';
		}

		foreach ( $taxonomies as $taxonomy ) {
			$item_properties[ $taxonomy ] = [
				'type'  => 'array',
				'items' => TaxonomySchema::term_object(),
			];
			$required[] = $taxonomy;
		}

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
