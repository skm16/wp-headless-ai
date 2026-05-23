<?php
/**
 * Shared schema fragment for taxonomy terms.
 *
 * Produces the { id, name, slug, description, count, parent_id } shape used in
 * two places:
 *   1. Inline taxonomy arrays on CPT list/by-slug ability output.
 *   2. The items schema for standalone TaxonomyTermsAbility output.
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Schema;

defined( 'ABSPATH' ) || exit;

final class TaxonomySchema {

	/**
	 * JSON Schema for a single taxonomy term.
	 *
	 * parent_id is 0 for top-level terms, mirroring WP_Term->parent.
	 *
	 * @return array<string, mixed>
	 */
	public static function term_object(): array {
		return [
			'type'                 => 'object',
			'additionalProperties' => false,
			'required'             => [ 'id', 'name', 'slug', 'description', 'count', 'parent_id' ],
			'properties'           => [
				'id'          => [ 'type' => 'integer' ],
				'name'        => [ 'type' => 'string' ],
				'slug'        => [ 'type' => 'string' ],
				'description' => [ 'type' => 'string' ],
				'count'       => [ 'type' => 'integer' ],
				'parent_id'   => [
					'type'        => 'integer',
					'description' => __( '0 for top-level terms; parent term_id otherwise.', 'wp-headless-kit' ),
				],
			],
		];
	}

	/**
	 * Map a WP_Term to the term_object shape.
	 *
	 * @return array<string, mixed>
	 */
	public static function shape_term( \WP_Term $term ): array {
		return [
			'id'          => (int) $term->term_id,
			'name'        => html_entity_decode( (string) $term->name, ENT_QUOTES | ENT_HTML5, 'UTF-8' ),
			'slug'        => (string) $term->slug,
			'description' => (string) $term->description,
			'count'       => (int) $term->count,
			'parent_id'   => (int) $term->parent,
		];
	}
}
