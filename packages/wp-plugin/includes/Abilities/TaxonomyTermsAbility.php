<?php
/**
 * TaxonomyTermsAbility — factory for "list all terms in a taxonomy" abilities.
 *
 * One instance is registered per public taxonomy (categories, tags, custom
 * taxonomies). Produces a flat list of { id, name, slug, description, count,
 * parent_id } objects, useful for building filter UIs, navigation, and
 * taxonomy archive pages.
 *
 * Discovery and registration are handled by Registry::register_taxonomy_abilities().
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Abilities;

use Jab\WpHeadlessKit\Schema\TaxonomySchema;

defined( 'ABSPATH' ) || exit;

final class TaxonomyTermsAbility {

	public const CATEGORY = 'jab-content';

	/**
	 * Register a taxonomy-terms ability for the given WP_Taxonomy object.
	 */
	/**
	 * @param callable|null $name_resolver Optional callable(string $candidate): string
	 *                                     that returns a collision-free name. Pass
	 *                                     Registry::ensure_unique_name when wiring up
	 *                                     the default auto-discovery; tests can pass
	 *                                     a passthrough.
	 */
	public static function register( \WP_Taxonomy $taxonomy, ?callable $name_resolver = null ): void {
		$slug   = (string) $taxonomy->name;
		$labels = $taxonomy->labels ?? null;
		$plural = is_object( $labels ) && ! empty( $labels->name ) ? (string) $labels->name : ucwords( str_replace( [ '-', '_' ], ' ', $slug ) );

		// API-1 + BUG-2: name + wrapper_key derive from the taxonomy's
		// `rest_base` (or slug fallback), NOT from the editor-editable plural
		// label. The `-terms` suffix structurally separates taxonomy abilities
		// from CPT-list abilities so the two namespaces can never collide
		// (e.g. a CPT named `tag` and the built-in `tag` taxonomy).
		$rest_base    = ! empty( $taxonomy->rest_base ) ? (string) $taxonomy->rest_base : $slug;
		$slug_kebab   = strtolower( str_replace( [ ' ', '_' ], '-', $rest_base ) );
		$wrapper_key  = strtolower( str_replace( [ '-', ' ' ], '_', $rest_base ) );
		$ability_name = 'jab/get-' . $slug_kebab . '-terms';
		if ( null !== $name_resolver ) {
			$ability_name = (string) call_user_func( $name_resolver, $ability_name );
		}

		wp_register_ability(
			$ability_name,
			[
				'label'               => sprintf(
					/* translators: %s: taxonomy plural label (e.g. "Categories", "Beer Styles"). */
					__( 'Get %s', 'wp-headless-kit' ),
					$plural
				),
				'description'         => sprintf(
					/* translators: %s: taxonomy plural label. */
					__( 'Retrieves all %s as a flat list of term objects.', 'wp-headless-kit' ),
					strtolower( $plural )
				),
				'category'            => self::CATEGORY,
				'input_schema'        => self::input_schema(),
				'output_schema'       => self::output_schema( $wrapper_key ),
				'execute_callback'    => static function ( array $input ) use ( $slug, $wrapper_key ): array {
					return self::execute( $slug, $wrapper_key, $input );
				},
				'permission_callback' => Permissions::gate( $ability_name ),
				'meta'                => [
					'mcp' => [
						'public' => true,
					],
					// Surface the underlying taxonomy slug so the generator can
					// emit a `@taxonomy <slug>` JSDoc on the ability's wrapper.
					// The wrapper key is derived from the plural label and may
					// diverge from the slug (e.g. label "Work Type" → wrapper
					// `work_type` while the slug is `work`), and per-post
					// taxonomy fields on CPT-list responses are keyed by the
					// slug, not the wrapper. Without this hint, consumers have
					// no compile-time signal that the two names differ.
					'jab' => [
						'taxonomy_slug' => $slug,
					],
				],
			]
		);
	}

	/**
	 * @param array<string, mixed> $input
	 * @return array<string, mixed>
	 */
	private static function execute( string $taxonomy_slug, string $wrapper_key, array $input ): array {
		$args = [
			'taxonomy'   => $taxonomy_slug,
			'hide_empty' => isset( $input['hide_empty'] ) ? (bool) $input['hide_empty'] : true,
			'number'     => isset( $input['number'] ) ? (int) $input['number'] : 100,
		];

		$terms = get_terms( $args );

		if ( is_wp_error( $terms ) || ! is_array( $terms ) ) {
			// ERR-1: do NOT throw out of the ability callback — the mcp-adapter
			// hands these back as a fatal, not a clean error response. Matches
			// the contract every other ability in this plugin follows: empty
			// payload + a _doing_it_wrong() breadcrumb so site owners notice.
			if ( is_wp_error( $terms ) && function_exists( '_doing_it_wrong' ) ) {
				_doing_it_wrong(
					'Jab\\WpHeadlessKit\\Abilities\\TaxonomyTermsAbility::execute',
					esc_html( sprintf(
						/* translators: 1: taxonomy slug, 2: error message. */
						__( 'get_terms() failed for taxonomy "%1$s": %2$s. Returning empty list.', 'wp-headless-kit' ),
						$taxonomy_slug,
						$terms->get_error_message()
					) ),
					'0.4.0'
				);
			}
			return [ $wrapper_key => [] ];
		}

		return [
			$wrapper_key => array_map(
				[ TaxonomySchema::class, 'shape_term' ],
				array_filter( $terms, static fn( $t ): bool => $t instanceof \WP_Term )
			),
		];
	}

	/**
	 * @return array<string, mixed>
	 */
	private static function input_schema(): array {
		return [
			'type'                 => 'object',
			'additionalProperties' => false,
			'properties'           => [
				'hide_empty' => [
					'type'        => 'boolean',
					'description' => __( 'Exclude terms with no published posts.', 'wp-headless-kit' ),
					'default'     => true,
				],
				'number'     => [
					'type'        => 'integer',
					'description' => __( 'Maximum number of terms to return.', 'wp-headless-kit' ),
					'minimum'     => 1,
					'maximum'     => 500,
					'default'     => 100,
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
					'items' => TaxonomySchema::term_object(),
				],
			],
		];
	}
}
