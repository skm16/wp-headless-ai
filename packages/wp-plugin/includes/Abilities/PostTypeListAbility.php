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
use Jab\WpHeadlessKit\Schema\AcfValueWalker;
use Jab\WpHeadlessKit\Schema\BlockParser;
use Jab\WpHeadlessKit\Schema\BlockSchema;
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
	 * @param array<string, mixed>      $input              Already validated against the input schema.
	 * @param array<string, mixed>|null $acf_schema
	 * @param bool                      $supports_thumbnail
	 * @param string[]                  $taxonomies         Taxonomy slugs registered to this post type.
	 * @return array<string, mixed>
	 */
	private static function execute( array $config, array $input, ?array $acf_schema, bool $supports_thumbnail, array $taxonomies ): array {
		$post_type        = (string) $config['post_type'];
		$requested_status = isset( $input['post_status'] ) ? (string) $input['post_status'] : null;
		// SEC-1: a Subscriber requesting `draft` / `any` must not see other people's
		// unpublished work. Permissions::sanitize_post_status() downgrades the
		// requested status to `publish` unless the caller can edit this post type.
		$status        = Permissions::sanitize_post_status( $requested_status, $post_type );
		$include_flags = self::resolve_include( $input );

		$query_args = self::build_query_args( $config, $input, $status, $taxonomies );
		$rows       = get_posts( $query_args );

		// Batch-fetch taxonomy terms for all posts in one query per taxonomy group,
		// then group results by post ID so shape_row() gets an O(1) lookup.
		$terms_by_post = self::batch_terms( $rows, $taxonomies );

		return [
			$config['wrapper_key'] => array_map(
				static function ( \WP_Post $post ) use ( $acf_schema, $supports_thumbnail, $terms_by_post, $taxonomies, $include_flags ): array {
					return self::shape_row( $post, $acf_schema, $supports_thumbnail, $terms_by_post[ $post->ID ] ?? [], $taxonomies, $include_flags );
				},
				$rows
			),
		];
	}

	/**
	 * Build the WP_Query argument map from validated ability input.
	 *
	 * Extracted from `execute()` so the input → query-args mapping can be
	 * unit-tested by reflection without booting WP_Query. Every Phase 2
	 * sync feature (pagination, deterministic ordering, incremental-sync
	 * windows, ID / slug / taxonomy filters) flows through here, which
	 * also keeps `execute()` readable.
	 *
	 * SEC-1 invariant: `$status` must come from `Permissions::sanitize_post_status`
	 * BEFORE this method is called. We do not re-sanitize here so the caller
	 * cannot accidentally pass a raw user-supplied status.
	 *
	 * Determinism invariant: every emitted `orderby` carries a secondary
	 * `ID => DESC` clause unless the primary already sorts on ID. WP_Query
	 * with ties under a `date` sort is implementation-defined; the tiebreaker
	 * means a paged sync sees every record exactly once.
	 *
	 * @param array<string, mixed> $config
	 * @param array<string, mixed> $input       Validated input.
	 * @param string               $status      Already-sanitized post_status.
	 * @param string[]             $taxonomies  Taxonomies actually registered to this post type.
	 * @return array<string, mixed>
	 */
	private static function build_query_args( array $config, array $input, string $status, array $taxonomies ): array {
		$post_type = (string) $config['post_type'];

		// Page-size resolution. Explicit numberposts always wins — a caller
		// deliberately paging through 80 IDs with numberposts=10 gets exactly
		// that. Otherwise, when an ID/slug filter is present, raise the page
		// size to the filter set's cardinality so "re-fetch this known set"
		// actually returns the whole set; the default page size silently
		// truncating otherwise was the failure mode the post-implementation
		// review caught. Otherwise, default_count.
		//
		// The filter schemas (include_ids, slug_in, etc.) are already capped
		// at FILTER_MAX_ITEMS, which equals the numberposts maximum — so the
		// auto-raise can never exceed the documented row cap.
		if ( isset( $input['numberposts'] ) ) {
			$count = (int) $input['numberposts'];
		} else {
			$count = self::filter_set_size( $input );
			if ( 0 === $count ) {
				$count = (int) $config['default_count'];
			}
		}

		$args = [
			'numberposts'      => $count,
			'post_status'      => $status,
			'post_type'        => $post_type,
			'suppress_filters' => false,
			'no_found_rows'    => true,
		];

		// SEC-1 defence-in-depth: only apply `perm => readable` for non-public
		// statuses. For `publish` queries it's a no-op on standard CPTs but can
		// add an unintended cap-check on private post types — scoping it here
		// keeps the public-content path identical to pre-0.4.0 behavior.
		if ( 'publish' !== $status ) {
			$args['perm'] = 'readable';
		}

		// Pagination: explicit offset wins over page-computed offset. Either
		// resolves to WP_Query's `offset` arg, which bypasses the paged
		// arithmetic entirely — easier to reason about under sync.
		if ( isset( $input['offset'] ) ) {
			$args['offset'] = (int) $input['offset'];
		} elseif ( isset( $input['page'] ) && (int) $input['page'] > 1 ) {
			$args['offset'] = ( (int) $input['page'] - 1 ) * $count;
		}

		// Deterministic ordering. WP_Query supports `orderby` as an array of
		// column => direction; that's how we layer the ID tiebreaker without
		// dropping the primary sort.
		$orderby = isset( $input['orderby'] ) ? (string) $input['orderby'] : 'date';
		$order   = isset( $input['order'] ) && 'asc' === strtolower( (string) $input['order'] ) ? 'ASC' : 'DESC';
		$column  = self::orderby_column( $orderby );
		if ( 'ID' === $column ) {
			$args['orderby'] = [ 'ID' => $order ];
		} else {
			// Tiebreaker direction follows the primary direction so the visible
			// sort feels natural (DESC date → newer IDs first within a tie,
			// ASC date → older IDs first within a tie). Stability is preserved
			// either way; matching directions just avoids surprising the caller.
			$args['orderby'] = [
				$column => $order,
				'ID'    => $order,
			];
		}

		// Incremental sync windows. Each window targets either post_date_gmt
		// (publish) or post_modified_gmt (touched). All windows are emitted
		// as separate date_query clauses with `inclusive => true` so a
		// caller asking for `modified_after = T` sees records modified at
		// T as well as after — friendly to "since last sync at T" callers.
		$date_query = [];
		if ( isset( $input['modified_after'] ) && '' !== (string) $input['modified_after'] ) {
			$date_query[] = [
				'column'    => 'post_modified_gmt',
				'after'     => (string) $input['modified_after'],
				'inclusive' => true,
			];
		}
		if ( isset( $input['modified_before'] ) && '' !== (string) $input['modified_before'] ) {
			$date_query[] = [
				'column'    => 'post_modified_gmt',
				'before'    => (string) $input['modified_before'],
				'inclusive' => true,
			];
		}
		if ( isset( $input['date_after'] ) && '' !== (string) $input['date_after'] ) {
			$date_query[] = [
				'column'    => 'post_date_gmt',
				'after'     => (string) $input['date_after'],
				'inclusive' => true,
			];
		}
		if ( isset( $input['date_before'] ) && '' !== (string) $input['date_before'] ) {
			$date_query[] = [
				'column'    => 'post_date_gmt',
				'before'    => (string) $input['date_before'],
				'inclusive' => true,
			];
		}
		if ( ! empty( $date_query ) ) {
			$args['date_query'] = $date_query;
		}

		// ID / slug filters. Cast IDs through int() because callers occasionally
		// push string IDs in via MCP transport, and WP_Query mixes string-int
		// quietly. Belt-and-braces.
		if ( isset( $input['include_ids'] ) && is_array( $input['include_ids'] ) && ! empty( $input['include_ids'] ) ) {
			$args['post__in'] = array_values( array_map( 'intval', $input['include_ids'] ) );
		}
		if ( isset( $input['exclude_ids'] ) && is_array( $input['exclude_ids'] ) && ! empty( $input['exclude_ids'] ) ) {
			$args['post__not_in'] = array_values( array_map( 'intval', $input['exclude_ids'] ) );
		}
		if ( isset( $input['slug_in'] ) && is_array( $input['slug_in'] ) && ! empty( $input['slug_in'] ) ) {
			$args['post_name__in'] = array_values( array_map( 'strval', $input['slug_in'] ) );
		}

		// Taxonomy filter. Only honor keys that match a public taxonomy
		// registered to this post type — unknown keys are dropped silently
		// so a curious caller can't probe for private taxonomies by
		// watching which inputs WP_Query reflects in the row set.
		if ( isset( $input['taxonomy'] ) && is_array( $input['taxonomy'] ) && ! empty( $taxonomies ) ) {
			$tax_query = [];
			foreach ( $input['taxonomy'] as $tax_slug => $term_slugs ) {
				$tax_slug = (string) $tax_slug;
				if ( ! in_array( $tax_slug, $taxonomies, true ) ) {
					continue;
				}
				if ( ! is_array( $term_slugs ) || empty( $term_slugs ) ) {
					continue;
				}
				$tax_query[] = [
					'taxonomy' => $tax_slug,
					'field'    => 'slug',
					'terms'    => array_values( array_map( 'strval', $term_slugs ) ),
					'operator' => 'IN',
				];
			}
			if ( ! empty( $tax_query ) ) {
				$tax_query['relation'] = 'AND';
				// phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_tax_query -- Taxonomy filtering is a core sync feature; the slow-query lint is a generic precaution and the SaaS sync layer caps the term-slug count at FILTER_MAX_ITEMS.
				$args['tax_query'] = $tax_query;
			}
		}

		return $args;
	}

	/**
	 * Return the largest cardinality across the ID/slug filter inputs, or 0
	 * when no such filter is present. Used by build_query_args() to size
	 * the page so a "re-fetch this known set" call returns the whole set.
	 *
	 * Taxonomy filters are deliberately excluded: a caller asking for posts
	 * tagged `category=news` is asking for "however many posts are tagged
	 * news", not "exactly 80 posts". That's pagination's job.
	 *
	 * @param array<string, mixed> $input
	 */
	private static function filter_set_size( array $input ): int {
		$max = 0;
		foreach ( [ 'include_ids', 'slug_in' ] as $field ) {
			if ( isset( $input[ $field ] ) && is_array( $input[ $field ] ) ) {
				$size = count( $input[ $field ] );
				if ( $size > $max ) {
					$max = $size;
				}
			}
		}
		return $max;
	}

	/**
	 * Map the input-schema-enum `orderby` value to the WP_Query column name.
	 * WP_Query is case-sensitive on `ID`; everything else stays lowercase.
	 */
	private static function orderby_column( string $orderby ): string {
		switch ( strtolower( $orderby ) ) {
			case 'id':
				return 'ID';
			case 'modified':
				return 'modified';
			case 'title':
				return 'title';
			case 'menu_order':
				return 'menu_order';
			case 'date':
			default:
				return 'date';
		}
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
	 * The $include_flags map gates the optional v0.5.0 fields. Each emitted field
	 * is OPTIONAL in output_schema (not in `required`), so when its flag is
	 * false the field is simply absent from the row.
	 *
	 * @param array<string, mixed>|null    $acf_schema
	 * @param array<string, WP_Term[]>     $post_terms  Pre-fetched terms for this post, keyed by taxonomy slug.
	 * @param string[]                     $taxonomies  Full set of public taxonomies registered to this post type.
	 * @param array<string, bool>          $include_flags { content, blocks, render } — each defaults false when absent.
	 * @return array<string, mixed>
	 */
	public static function shape_row( \WP_Post $post, ?array $acf_schema, bool $supports_thumbnail = false, array $post_terms = [], array $taxonomies = [], array $include_flags = [] ): array {
		$modified = self::resolve_modified_date( $post );
		$row      = [
			'id'           => (int) $post->ID,
			'title'        => html_entity_decode( get_the_title( $post ), ENT_QUOTES | ENT_HTML5, 'UTF-8' ),
			'excerpt'      => html_entity_decode( wp_strip_all_tags( get_the_excerpt( $post ) ), ENT_QUOTES | ENT_HTML5, 'UTF-8' ),
			'date'         => self::resolve_date( $post ),
			'slug'         => (string) $post->post_name,
			'link'         => (string) get_permalink( $post ),
			// `modified` is the canonical "last touched" timestamp the SaaS
			// sync layer keys on. Emitting both `modified` and `modified_gmt`
			// matches WP REST's own envelope so existing clients don't have
			// to special-case JAB output.
			'modified'     => $modified,
			'modified_gmt' => $modified,
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
			$walked     = AcfValueWalker::walk( $all_fields, $acf_schema );
			$row['acf'] = is_array( $walked ) ? $walked : [];
		}

		$post_content = (string) $post->post_content;

		if ( ! empty( $include_flags['content'] ) ) {
			$row['content'] = $post_content;
		}

		if ( ! empty( $include_flags['blocks'] ) ) {
			$row['blocks'] = BlockExpander::expand( BlockParser::parse( $post_content ) );
		}

		if ( ! empty( $include_flags['render'] ) ) {
			$row['rendered_content'] = self::render_post_content( $post, $post_content );
		}

		return $row;
	}

	/**
	 * Run post_content through the `the_content` filter chain (block rendering,
	 * shortcode expansion, embed handling) with setup_postdata() bracketing so
	 * dynamic blocks that depend on the global $post (core/post-title,
	 * core/query, etc.) render correctly. wp_reset_postdata() always runs even
	 * if the filter throws, so the global state isn't left polluted.
	 *
	 * Known limitation: setup_postdata()/wp_reset_postdata() are normally used
	 * inside a `WP_Query` loop and operate on `$wp_query->post`. Outside a loop
	 * the reset can leave `$wp_query` in a slightly unexpected state if some
	 * other plugin re-enters its own loop after this call. In practice MCP
	 * abilities execute on a REST request, not inside an archive loop, so this
	 * is theoretical. If it surfaces, the fix is to swap global $post manually
	 * around the apply_filters() call instead of using setup_postdata().
	 */
	private static function render_post_content( \WP_Post $post, string $post_content ): string {
		setup_postdata( $post );
		try {
			return (string) apply_filters( 'the_content', $post_content );
		} finally {
			wp_reset_postdata();
		}
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
	 * Resolve a WP_Post's publish date to an RFC3339 string the output schema
	 * (`format: date-time`) will accept.
	 *
	 * BUG-1: drafts can carry `post_date_gmt = '0000-00-00 00:00:00'`, and
	 * scheduled or future posts may carry a non-GMT-zero but still-unusable
	 * value. `mysql_to_rfc3339()` on a zero-date yields `0000-00-00T00:00:00`,
	 * which REST output validation rejects. Strategy: prefer `post_date_gmt`
	 * when usable, fall back to `post_date` (also a MySQL datetime) before
	 * giving up and emitting the post's modified date.
	 */
	private static function resolve_date( \WP_Post $post ): string {
		foreach ( [ $post->post_date_gmt, $post->post_date, $post->post_modified_gmt, $post->post_modified ] as $candidate ) {
			$candidate = (string) $candidate;
			if ( '' === $candidate || 0 === strpos( $candidate, '0000' ) ) {
				continue;
			}
			$rfc = mysql_to_rfc3339( $candidate );
			if ( is_string( $rfc ) && '' !== $rfc && 0 !== strpos( $rfc, '0000' ) ) {
				return $rfc;
			}
		}
		// Final fallback: Unix epoch (1970-01-01T00:00:00+00:00). We never want
		// to fail the whole output for a missing publish date, but synthesizing
		// "right now" would corrupt downstream sort/display logic. Epoch is
		// schema-valid AND obviously sentinel-shaped — easy to detect in UIs.
		return gmdate( 'c', 0 );
	}

	/**
	 * Resolve a WP_Post's modified timestamp to an RFC3339 string.
	 *
	 * Mirrors resolve_date()'s zero-date handling (BUG-1) but walks the
	 * modified-first candidate list: a never-edited post has zero modified
	 * fields and should fall back to its publish date, not the 1970 sentinel.
	 * "Modified" for an untouched post is conceptually "published" — that's
	 * what every CMS surfaces — so the fallback chain ends at the publish
	 * dates, with epoch only as the last-resort sentinel.
	 */
	private static function resolve_modified_date( \WP_Post $post ): string {
		foreach ( [ $post->post_modified_gmt, $post->post_modified, $post->post_date_gmt, $post->post_date ] as $candidate ) {
			$candidate = (string) $candidate;
			if ( '' === $candidate || 0 === strpos( $candidate, '0000' ) ) {
				continue;
			}
			$rfc = mysql_to_rfc3339( $candidate );
			if ( is_string( $rfc ) && '' !== $rfc && 0 !== strpos( $rfc, '0000' ) ) {
				return $rfc;
			}
		}
		return gmdate( 'c', 0 );
	}

	/**
	 * Hard cap on the number of IDs / slugs / term slugs accepted in a single
	 * call. Mirrors the `numberposts` maximum so a caller never lands in the
	 * "you sent 150 IDs but only 100 rows fit" silent-truncation trap. The
	 * symmetry also pairs with build_query_args()'s auto-raise: when a
	 * filter is present without an explicit `numberposts`, the row cap
	 * tracks the filter set size up to this same maximum.
	 */
	private const FILTER_MAX_ITEMS = 100;

	/**
	 * @param array<string, mixed> $config
	 * @return array<string, mixed>
	 */
	private static function input_schema( array $config ): array {
		return [
			'type'                 => 'object',
			'additionalProperties' => false,
			'properties'           => [
				'numberposts'     => [
					'type'        => 'integer',
					'description' => sprintf(
						/* translators: %s: noun for the items returned (e.g. "posts", "beers"). */
						__( 'Number of %s to return per page.', 'wp-headless-kit' ),
						$config['noun']
					),
					'minimum'     => 1,
					'maximum'     => 100,
					'default'     => (int) $config['default_count'],
				],
				'post_status'     => [
					'type'        => 'string',
					'description' => __( 'Post status filter.', 'wp-headless-kit' ),
					'enum'        => [ 'publish', 'draft', 'any' ],
					'default'     => 'publish',
				],
				'page'            => [
					'type'        => 'integer',
					'description' => __( '1-based page number. Combined with numberposts to compute an offset. Ignored if offset is also provided. Stable only when orderby + the implicit ID tiebreaker leave no ambiguity.', 'wp-headless-kit' ),
					'minimum'     => 1,
					'maximum'     => 1000,
					'default'     => 1,
				],
				'offset'          => [
					'type'        => 'integer',
					'description' => __( 'Direct record offset. When provided, overrides page. Use for cursor-shaped sync ("give me records N..N+per_page").', 'wp-headless-kit' ),
					'minimum'     => 0,
					'maximum'     => 100000,
				],
				'orderby'         => [
					'type'        => 'string',
					'description' => __( 'Sort column. Every order is tie-broken by ID in the same direction as `order` (DESC primary → DESC ID tiebreaker, ASC → ASC) so paged sync sees each record exactly once.', 'wp-headless-kit' ),
					'enum'        => [ 'date', 'modified', 'title', 'menu_order', 'id' ],
					'default'     => 'date',
				],
				'order'           => [
					'type'        => 'string',
					'description' => __( 'Sort direction.', 'wp-headless-kit' ),
					'enum'        => [ 'asc', 'desc' ],
					'default'     => 'desc',
				],
				'modified_after'  => [
					'type'        => 'string',
					'description' => __( 'Return only records modified at or after this RFC3339 instant (UTC). Pairs with orderby=modified for incremental sync.', 'wp-headless-kit' ),
				],
				'modified_before' => [
					'type'        => 'string',
					'description' => __( 'Return only records modified at or before this RFC3339 instant (UTC).', 'wp-headless-kit' ),
				],
				'date_after'      => [
					'type'        => 'string',
					'description' => __( 'Return only records published at or after this RFC3339 instant (UTC).', 'wp-headless-kit' ),
				],
				'date_before'     => [
					'type'        => 'string',
					'description' => __( 'Return only records published at or before this RFC3339 instant (UTC).', 'wp-headless-kit' ),
				],
				'include_ids'     => [
					'type'        => 'array',
					'description' => __( 'Return only records whose ID is in this set. Use to re-fetch a known set without scanning the whole CPT.', 'wp-headless-kit' ),
					'items'       => [
						'type'    => 'integer',
						'minimum' => 1,
					],
					'maxItems'    => self::FILTER_MAX_ITEMS,
				],
				'exclude_ids'     => [
					'type'        => 'array',
					'description' => __( 'Exclude records whose ID is in this set.', 'wp-headless-kit' ),
					'items'       => [
						'type'    => 'integer',
						'minimum' => 1,
					],
					'maxItems'    => self::FILTER_MAX_ITEMS,
				],
				'slug_in'         => [
					'type'        => 'array',
					'description' => __( 'Return only records whose slug is in this set.', 'wp-headless-kit' ),
					'items'       => [
						'type'      => 'string',
						'minLength' => 1,
					],
					'maxItems'    => self::FILTER_MAX_ITEMS,
				],
				'taxonomy'        => [
					'type'                 => 'object',
					'description'          => __( 'Map of taxonomy slug => array of term slugs. Only public taxonomies registered to this post type are honored; unknown keys are silently dropped.', 'wp-headless-kit' ),
					'additionalProperties' => [
						'type'     => 'array',
						'items'    => [
							'type'      => 'string',
							'minLength' => 1,
						],
						'maxItems' => self::FILTER_MAX_ITEMS,
					],
				],
				'include'         => self::include_schema( false ),
			],
		];
	}

	/**
	 * Shared include-flag schema. List abilities default everything off
	 * (`$defaults_on = false`) to protect payload size; by-slug abilities
	 * default content + blocks on (`$defaults_on = true`) since the caller
	 * is fetching a single record by name.
	 *
	 * @return array<string, mixed>
	 */
	public static function include_schema( bool $defaults_on ): array {
		return [
			'type'                 => 'object',
			'additionalProperties' => false,
			'description'          => __( 'Optional fields to include in each item. Defaults are tuned for payload size on list endpoints; by-slug endpoints default content + blocks on.', 'wp-headless-kit' ),
			'properties'           => [
				'content' => [
					'type'        => 'boolean',
					'description' => __( 'Include raw post_content as a string.', 'wp-headless-kit' ),
					'default'     => $defaults_on,
				],
				'blocks'  => [
					'type'        => 'boolean',
					'description' => __( 'Include parsed block tree (recursively expanded core/block references).', 'wp-headless-kit' ),
					'default'     => $defaults_on,
				],
				'render'  => [
					'type'        => 'boolean',
					'description' => __( 'Include rendered_content: post_content run through the the_content filter (block rendering, shortcodes, embeds).', 'wp-headless-kit' ),
					'default'     => false,
				],
			],
		];
	}

	/**
	 * Normalize the caller's `include` input into a fully-populated bool map.
	 * Missing keys default to false — this mirrors the schema-side defaults
	 * declared in include_schema(false). If the list-side schema defaults
	 * ever change (e.g. enabling content by default), update both this
	 * method AND the include_schema(false) call together — they're coupled
	 * by convention, not enforcement.
	 *
	 * PostTypeBySlugAbility has its own resolve_include() with content +
	 * blocks defaulting on; the two are intentionally different.
	 *
	 * @param array<string, mixed> $input
	 * @return array<string, bool>
	 */
	private static function resolve_include( array $input ): array {
		$include_flags = isset( $input['include'] ) && is_array( $input['include'] ) ? $input['include'] : [];
		return [
			'content' => ! empty( $include_flags['content'] ),
			'blocks'  => ! empty( $include_flags['blocks'] ),
			'render'  => ! empty( $include_flags['render'] ),
		];
	}

	/**
	 * @param array<string, mixed>|null $acf_schema
	 * @param string[]                  $taxonomies
	 * @return array<string, mixed>
	 */
	private static function output_schema( string $wrapper_key, ?array $acf_schema, bool $supports_thumbnail, array $taxonomies ): array {
		$item_properties = [
			'id'           => [ 'type' => 'integer' ],
			'title'        => [ 'type' => 'string' ],
			'excerpt'      => [ 'type' => 'string' ],
			'date'         => [
				'type'        => 'string',
				'description' => __( 'Published date in RFC3339 (UTC). Stored as a string, not validated as date-time — legacy posts may carry non-ISO timestamps and we treat date validation as informational.', 'wp-headless-kit' ),
			],
			'modified'     => [
				'type'        => 'string',
				'description' => __( 'Last-modified date in RFC3339 (UTC). Falls back to the publish date for never-edited posts. Stored as a string for the same legacy-timestamp reason as `date`.', 'wp-headless-kit' ),
			],
			'modified_gmt' => [
				'type'        => 'string',
				'description' => __( 'Mirror of `modified` for WP REST envelope parity; the JAB plugin always emits the GMT value in both.', 'wp-headless-kit' ),
			],
			'slug'         => [ 'type' => 'string' ],
			'link'         => [
				'type' => 'string',
			],
		];
		$required        = [ 'id', 'title', 'excerpt', 'date', 'modified', 'modified_gmt', 'slug', 'link' ];

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

		// v0.5.0: optional block-emission fields. Declared in `properties`
		// so json-schema-to-typescript emits the optional keys; deliberately
		// NOT in `required` — runtime emission is gated by input.include.
		$item_properties['content']          = [ 'type' => 'string' ];
		$item_properties['blocks']           = BlockSchema::block_array_schema();
		$item_properties['rendered_content'] = BlockSchema::rendered_content_schema();

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
