<?php
/**
 * PostTypeListAbility — factory for "list entries from a public CPT" abilities.
 *
 * Every CPT-list ability we expose (skm/get-posts, skm/get-beers, etc.) shares
 * the same input shape (numberposts + post_status), the same output shape
 * (id/title/excerpt/date/slug/link per item), the same permission gate, and
 * the same `meta.mcp.public => true` flag. Only the post_type, ability name,
 * label, description, response wrapper key, and default count vary.
 *
 * This factory takes a config array and registers an ability of that shape,
 * collapsing what was ~140 lines of duplicated code per CPT.
 *
 * @package Skm\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Skm\WpHeadlessKit\Abilities;

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
		wp_register_ability(
			$config['name'],
			[
				'label'               => $config['label'],
				'description'         => $config['description'],
				'category'            => self::CATEGORY,
				'input_schema'        => self::input_schema( $config ),
				'output_schema'       => self::output_schema( $config['wrapper_key'] ),
				'execute_callback'    => static function ( array $input ) use ( $config ): array {
					return self::execute( $config, $input );
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
	 * @param array<string, mixed> $input  Already validated against the input schema.
	 * @return array<string, mixed>
	 */
	private static function execute( array $config, array $input ): array {
		$count  = isset( $input['numberposts'] ) ? (int) $input['numberposts'] : (int) $config['default_count'];
		$status = isset( $input['post_status'] ) ? (string) $input['post_status'] : 'publish';

		$rows = get_posts(
			[
				'numberposts'      => $count,
				'post_status'      => $status,
				'post_type'        => $config['post_type'],
				'suppress_filters' => false,
				'no_found_rows'    => true,
			]
		);

		return [
			$config['wrapper_key'] => array_map( [ self::class, 'shape_row' ], $rows ),
		];
	}

	/**
	 * @return array<string, mixed>
	 */
	private static function shape_row( \WP_Post $post ): array {
		return [
			'id'      => (int) $post->ID,
			'title'   => get_the_title( $post ),
			'excerpt' => wp_strip_all_tags( get_the_excerpt( $post ) ),
			'date'    => mysql_to_rfc3339( $post->post_date_gmt ),
			'slug'    => (string) $post->post_name,
			'link'    => (string) get_permalink( $post ),
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
	 * @return array<string, mixed>
	 */
	private static function output_schema( string $wrapper_key ): array {
		return [
			'type'       => 'object',
			'required'   => [ $wrapper_key ],
			'properties' => [
				$wrapper_key => [
					'type'  => 'array',
					'items' => [
						'type'       => 'object',
						'required'   => [ 'id', 'title', 'excerpt', 'date', 'slug', 'link' ],
						'properties' => [
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
						],
					],
				],
			],
		];
	}
}
