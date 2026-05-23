<?php
/**
 * PostTypeBySlugAbility — factory for "fetch a single CPT entry by slug" abilities.
 *
 * Mirrors PostTypeListAbility's per-CPT registration, but produces a single-record
 * read instead of a list. Returned object is the same canonical shape — id, title,
 * excerpt, date, slug, link, featured_image (when supported), taxonomy arrays, and
 * `acf` when the post type has fields — so consumers get one shared `<PascalName>`
 * interface across both call styles.
 *
 * On miss (no post matching the slug + post_status filter), the wrapper key is
 * `null`. Schema-side this is a `oneOf<object | null>`, which json-schema-to-
 * typescript turns into a clean `T | null`, forcing consumers to null-check
 * before rendering — exactly what app/[slug]/page.tsx wants for 404 handling.
 *
 * Row rendering and ACF enrichment are delegated to PostTypeListAbility::shape_row
 * to avoid duplicating the recursive walker.
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Abilities;

use Jab\WpHeadlessKit\Acf\Schema as AcfSchema;
use Jab\WpHeadlessKit\Schema\MediaSchema;
use Jab\WpHeadlessKit\Schema\TaxonomySchema;

defined( 'ABSPATH' ) || exit;

final class PostTypeBySlugAbility {

	public const CATEGORY = 'jab-content';

	/**
	 * Register a by-slug ability with the abilities API.
	 *
	 * @param array{
	 *     name: string,
	 *     post_type: string,
	 *     label: string,
	 *     description: string,
	 *     wrapper_key: string,
	 *     noun: string,
	 * } $config Ability configuration. `wrapper_key` and `noun` are the
	 *           SINGULAR forms (e.g. "page", "beer") so the output shape is
	 *           `{ page: Page | null }` not `{ pages: Page[] }`.
	 */
	public static function register( array $config ): void {
		$acf_schema         = AcfSchema::for_post_type( (string) $config['post_type'] );
		$supports_thumbnail = post_type_supports( (string) $config['post_type'], 'thumbnail' );
		$taxonomies         = PostTypeListAbility::public_taxonomies_for( (string) $config['post_type'] );

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
				'permission_callback' => Permissions::gate( (string) $config['name'], (string) $config['post_type'] ),
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
	 * @param array<string, mixed>      $input
	 * @param array<string, mixed>|null $acf_schema
	 * @param bool                      $supports_thumbnail
	 * @param string[]                  $taxonomies
	 * @return array<string, mixed>
	 */
	private static function execute( array $config, array $input, ?array $acf_schema, bool $supports_thumbnail, array $taxonomies ): array {
		$wrapper = (string) $config['wrapper_key'];
		$slug    = isset( $input['slug'] ) ? (string) $input['slug'] : '';

		if ( '' === $slug ) {
			return [ $wrapper => null ];
		}

		$post_type        = (string) $config['post_type'];
		$requested_status = isset( $input['post_status'] ) ? (string) $input['post_status'] : null;
		// SEC-1: same guardrail as PostTypeListAbility::execute(). A caller without
		// edit access on this CPT gets `publish` only, regardless of what they ask for.
		$status = Permissions::sanitize_post_status( $requested_status, $post_type );

		$query_args = [
			'name'             => $slug,
			'post_type'        => $post_type,
			'post_status'      => $status,
			'numberposts'      => 1,
			'suppress_filters' => false,
			'no_found_rows'    => true,
		];
		// SEC-1 defence-in-depth — see PostTypeListAbility::execute() for the
		// reason this is scoped to non-publish queries.
		if ( 'publish' !== $status ) {
			$query_args['perm'] = 'readable';
		}
		$rows = get_posts( $query_args );

		if ( empty( $rows ) || ! ( $rows[0] instanceof \WP_Post ) ) {
			return [ $wrapper => null ];
		}

		$post       = $rows[0];
		$post_terms = PostTypeListAbility::batch_terms( [ $post ], $taxonomies );

		return [
			$wrapper => PostTypeListAbility::shape_row(
				$post,
				$acf_schema,
				$supports_thumbnail,
				$post_terms[ $post->ID ] ?? [],
				$taxonomies
			),
		];
	}

	/**
	 * @param array<string, mixed> $config
	 * @return array<string, mixed>
	 */
	private static function input_schema( array $config ): array {
		return [
			'type'                 => 'object',
			'additionalProperties' => false,
			'required'             => [ 'slug' ],
			'properties'           => [
				'slug'        => [
					'type'        => 'string',
					'description' => sprintf(
						/* translators: %s: singular noun (e.g. "page", "beer"). */
						__( 'Slug of the %s to retrieve.', 'wp-headless-kit' ),
						$config['noun']
					),
					'minLength'   => 1,
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
	 * @param bool                      $supports_thumbnail
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
		$required        = [ 'id', 'title', 'excerpt', 'date', 'slug', 'link' ];

		if ( $supports_thumbnail ) {
			$item_properties['featured_image'] = MediaSchema::nullable_image();
			$required[]                        = 'featured_image';
		}

		foreach ( $taxonomies as $taxonomy ) {
			$item_properties[ $taxonomy ] = [
				'type'  => 'array',
				'items' => TaxonomySchema::term_object(),
			];
			$required[]                   = $taxonomy;
		}

		if ( null !== $acf_schema ) {
			$item_properties['acf'] = $acf_schema;
			$required[]             = 'acf';
		}

		$item_schema = [
			'type'       => 'object',
			'required'   => $required,
			'properties' => $item_properties,
		];

		return [
			'type'       => 'object',
			'required'   => [ $wrapper_key ],
			'properties' => [
				$wrapper_key => [
					'oneOf' => [
						$item_schema,
						[ 'type' => 'null' ],
					],
				],
			],
		];
	}
}
