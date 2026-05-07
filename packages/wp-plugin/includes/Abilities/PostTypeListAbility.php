<?php
/**
 * PostTypeListAbility — factory for "list entries from a public CPT" abilities.
 *
 * Every CPT-list ability we expose (skm/get-posts, skm/get-beers, etc.) shares
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
 * @package Skm\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Skm\WpHeadlessKit\Abilities;

use Skm\WpHeadlessKit\Acf\Schema as AcfSchema;

defined( 'ABSPATH' ) || exit;

final class PostTypeListAbility {

	public const CATEGORY = 'skm-content';

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
		// Resolve ACF schema once at registration time. If ACF is inactive
		// or no field groups apply, $acf_schema is null and the ability
		// behaves exactly as before — no `acf` property anywhere.
		$acf_schema      = AcfSchema::for_post_type( (string) $config['post_type'] );
		$acf_field_names = ( null !== $acf_schema && isset( $acf_schema['properties'] ) )
			? array_keys( (array) $acf_schema['properties'] )
			: [];

		wp_register_ability(
			$config['name'],
			[
				'label'               => $config['label'],
				'description'         => $config['description'],
				'category'            => self::CATEGORY,
				'input_schema'        => self::input_schema( $config ),
				'output_schema'       => self::output_schema( (string) $config['wrapper_key'], $acf_schema ),
				'execute_callback'    => static function ( array $input ) use ( $config, $acf_field_names ): array {
					return self::execute( $config, $input, $acf_field_names );
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
	 * @param array<string, mixed> $config
	 * @param array<string, mixed> $input             Already validated against the input schema.
	 * @param string[]             $acf_field_names   Empty when ACF is inactive or no fields apply.
	 * @return array<string, mixed>
	 */
	private static function execute( array $config, array $input, array $acf_field_names ): array {
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
				static function ( \WP_Post $post ) use ( $acf_field_names ): array {
					return self::shape_row( $post, $acf_field_names );
				},
				$rows
			),
		];
	}

	/**
	 * @param string[] $acf_field_names
	 * @return array<string, mixed>
	 */
	private static function shape_row( \WP_Post $post, array $acf_field_names ): array {
		$row = [
			'id'      => (int) $post->ID,
			'title'   => get_the_title( $post ),
			'excerpt' => wp_strip_all_tags( get_the_excerpt( $post ) ),
			'date'    => mysql_to_rfc3339( $post->post_date_gmt ),
			'slug'    => (string) $post->post_name,
			'link'    => (string) get_permalink( $post ),
		];

		if ( ! empty( $acf_field_names ) && function_exists( 'get_fields' ) ) {
			$all_fields = get_fields( $post->ID );
			$all_fields = is_array( $all_fields ) ? $all_fields : [];
			$acf_data   = [];
			foreach ( $acf_field_names as $name ) {
				// isset() filters out null AND missing keys, leaving only
				// fields with concrete values. Empty strings, false, 0, and
				// empty arrays survive — they are valid values per the schema.
				if ( isset( $all_fields[ $name ] ) ) {
					$acf_data[ $name ] = $all_fields[ $name ];
				}
			}
			$row['acf'] = $acf_data;
		}

		return $row;
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
