<?php
/**
 * PostTypeBySlugAbility — factory for "fetch a single CPT entry by slug" abilities.
 *
 * Mirrors PostTypeListAbility's per-CPT registration, but produces a single-record
 * read instead of a list. Returned object is the same canonical shape — id, title,
 * excerpt, date, slug, link, plus `acf` when the post type has fields — so
 * consumers get one shared `<PascalName>` interface across both call styles.
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
	 * @param array<string, mixed>|null $acf_schema  ACF schema fragment, or null if ACF inactive / no fields apply.
	 * @return array<string, mixed>
	 */
	private static function execute( array $config, array $input, ?array $acf_schema ): array {
		$wrapper = (string) $config['wrapper_key'];
		$slug    = isset( $input['slug'] ) ? (string) $input['slug'] : '';

		if ( '' === $slug ) {
			return [ $wrapper => null ];
		}

		$status = isset( $input['post_status'] ) ? (string) $input['post_status'] : 'publish';

		// `name` is WP_Query's slug filter; combined with post_type and status,
		// it matches exactly the post the consumer named — no broader scan,
		// no fuzzy matching.
		$rows = get_posts(
			[
				'name'             => $slug,
				'post_type'        => (string) $config['post_type'],
				'post_status'      => $status,
				'numberposts'      => 1,
				'suppress_filters' => false,
				'no_found_rows'    => true,
			]
		);

		if ( empty( $rows ) || ! ( $rows[0] instanceof \WP_Post ) ) {
			return [ $wrapper => null ];
		}

		return [ $wrapper => PostTypeListAbility::shape_row( $rows[0], $acf_schema ) ];
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
	 * Output schema — a wrapper object with one key (the singular wrapper),
	 * whose value is `Item | null`. Encoded as `oneOf<itemSchema | nullSchema>`
	 * so json-schema-to-typescript emits `T | null`, forcing consumer code to
	 * handle the not-found case at compile time.
	 *
	 * The item shape is identical to PostTypeListAbility's — same fields,
	 * same ACF schema injection point — so the generated TS interfaces for
	 * list and by-slug abilities describe structurally equivalent rows.
	 *
	 * @param array<string, mixed>|null $acf_schema
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
