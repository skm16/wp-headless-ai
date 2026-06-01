<?php
/**
 * PostTypeListAbilitySyncInputsTest — covers the Phase 2 sync-input surface
 * added in v0.7.0 (pagination, deterministic ordering, incremental sync
 * windows, and ID/slug/taxonomy filters).
 *
 * The new query-arg mapping lives in `build_query_args()`. Tests reach into
 * it via reflection rather than booting WP_Query, mirroring how
 * resolve_date / resolve_include are exercised elsewhere in this directory.
 *
 * @package Jab\WpHeadlessKit\Tests
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Abilities;

use Jab\WpHeadlessKit\Abilities\PostTypeListAbility;
use PHPUnit\Framework\TestCase;
use ReflectionMethod;

final class PostTypeListAbilitySyncInputsTest extends TestCase {

	protected function setUp(): void {
		\jab_wphk_reset_stubs();
	}

	/**
	 * @return mixed
	 */
	private function invoke_private( string $method_name, array $args ) {
		$method = new ReflectionMethod( PostTypeListAbility::class, $method_name );
		$method->setAccessible( true );
		return $method->invokeArgs( null, $args );
	}

	private function default_config(): array {
		return [
			'noun'          => 'posts',
			'default_count' => 25,
			'post_type'     => 'post',
		];
	}

	private function build( array $input, array $taxonomies = [], string $status = 'publish' ): array {
		return $this->invoke_private( 'build_query_args', [ $this->default_config(), $input, $status, $taxonomies ] );
	}

	// ------------------------------------------------------------------
	// input_schema — new fields are declared with correct constraints
	// ------------------------------------------------------------------

	public function test_input_schema_declares_pagination_fields(): void {
		$schema = $this->invoke_private( 'input_schema', [ $this->default_config() ] );

		$this->assertArrayHasKey( 'page', $schema['properties'] );
		$this->assertSame( 'integer', $schema['properties']['page']['type'] );
		$this->assertSame( 1, $schema['properties']['page']['minimum'] );
		$this->assertGreaterThanOrEqual( 100, $schema['properties']['page']['maximum'] );

		$this->assertArrayHasKey( 'offset', $schema['properties'] );
		$this->assertSame( 'integer', $schema['properties']['offset']['type'] );
		$this->assertSame( 0, $schema['properties']['offset']['minimum'] );
	}

	public function test_input_schema_declares_orderby_with_bounded_enum(): void {
		$schema  = $this->invoke_private( 'input_schema', [ $this->default_config() ] );
		$orderby = $schema['properties']['orderby'];
		$order   = $schema['properties']['order'];

		// Allow-listed sort columns. The exact set may grow, but every value
		// MUST be a column WP_Query can sort on without `meta_query` joins.
		$this->assertSame( 'string', $orderby['type'] );
		$this->assertIsArray( $orderby['enum'] );
		$this->assertContains( 'date', $orderby['enum'] );
		$this->assertContains( 'modified', $orderby['enum'] );
		$this->assertContains( 'id', $orderby['enum'] );
		$this->assertSame( 'date', $orderby['default'] );

		$this->assertSame( [ 'asc', 'desc' ], $order['enum'] );
		$this->assertSame( 'desc', $order['default'] );
	}

	public function test_input_schema_declares_incremental_sync_window_fields(): void {
		$schema = $this->invoke_private( 'input_schema', [ $this->default_config() ] );

		foreach ( [ 'modified_after', 'modified_before', 'date_after', 'date_before' ] as $field ) {
			$this->assertArrayHasKey( $field, $schema['properties'], "Missing field {$field}" );
			$this->assertSame( 'string', $schema['properties'][ $field ]['type'] );
		}
	}

	public function test_input_schema_declares_id_and_slug_filters(): void {
		$schema = $this->invoke_private( 'input_schema', [ $this->default_config() ] );

		foreach ( [ 'include_ids', 'exclude_ids' ] as $field ) {
			$this->assertArrayHasKey( $field, $schema['properties'] );
			$this->assertSame( 'array', $schema['properties'][ $field ]['type'] );
			$this->assertSame( 'integer', $schema['properties'][ $field ]['items']['type'] );
			$this->assertArrayHasKey( 'maxItems', $schema['properties'][ $field ] );
		}

		$slug_in = $schema['properties']['slug_in'];
		$this->assertSame( 'array', $slug_in['type'] );
		$this->assertSame( 'string', $slug_in['items']['type'] );
		$this->assertArrayHasKey( 'maxItems', $slug_in );
	}

	public function test_input_schema_declares_taxonomy_filter_object(): void {
		$schema = $this->invoke_private( 'input_schema', [ $this->default_config() ] );

		$this->assertArrayHasKey( 'taxonomy', $schema['properties'] );
		$tax = $schema['properties']['taxonomy'];
		$this->assertSame( 'object', $tax['type'] );
		// Each taxonomy key maps to an array of term slugs.
		$this->assertSame( 'array', $tax['additionalProperties']['type'] );
		$this->assertSame( 'string', $tax['additionalProperties']['items']['type'] );
	}

	// ------------------------------------------------------------------
	// build_query_args — pagination + ordering
	// ------------------------------------------------------------------

	public function test_build_query_args_defaults_to_config_default_count_and_publish(): void {
		$args = $this->build( [] );

		$this->assertSame( 25, $args['numberposts'] );
		$this->assertSame( 'publish', $args['post_status'] );
		$this->assertSame( 'post', $args['post_type'] );
		$this->assertFalse( $args['suppress_filters'] );
		// no offset / paged when nothing requested
		$this->assertSame( 0, $args['offset'] ?? 0 );
	}

	public function test_build_query_args_uses_explicit_numberposts(): void {
		$args = $this->build( [ 'numberposts' => 5 ] );
		$this->assertSame( 5, $args['numberposts'] );
	}

	public function test_build_query_args_paginates_via_page_field(): void {
		$args = $this->build( [ 'numberposts' => 10, 'page' => 3 ] );
		// page is 1-based; offset = (page - 1) * numberposts.
		$this->assertSame( 20, $args['offset'] );
	}

	public function test_build_query_args_explicit_offset_wins_over_page(): void {
		// Mutually informative — if a caller pins offset, page is ignored. This
		// is the deterministic mode: "give me record N to N+per_page" without
		// the page-size dependence.
		$args = $this->build( [ 'numberposts' => 10, 'page' => 3, 'offset' => 7 ] );
		$this->assertSame( 7, $args['offset'] );
	}

	public function test_build_query_args_emits_orderby_with_id_tiebreaker(): void {
		// Determinism guarantee: even when many posts share the same date,
		// the secondary sort on ID DESC means a paged sync sees each record
		// exactly once. Without the tiebreaker, WP_Query's natural order
		// for ties is implementation-defined.
		$args = $this->build( [ 'orderby' => 'date', 'order' => 'desc' ] );

		$this->assertIsArray( $args['orderby'] );
		$this->assertSame( 'DESC', $args['orderby']['date'] );
		$this->assertSame( 'DESC', $args['orderby']['ID'] );
	}

	public function test_build_query_args_orderby_modified_supported(): void {
		$args = $this->build( [ 'orderby' => 'modified', 'order' => 'asc' ] );

		$this->assertSame( 'ASC', $args['orderby']['modified'] );
		$this->assertSame( 'ASC', $args['orderby']['ID'] );
	}

	public function test_build_query_args_orderby_id_only_does_not_double_emit(): void {
		// When the caller sorts by ID directly, don't add a redundant
		// secondary ID clause — that would be a no-op but it's ugly to emit.
		$args = $this->build( [ 'orderby' => 'id', 'order' => 'desc' ] );

		$this->assertSame( 'DESC', $args['orderby']['ID'] );
		$this->assertCount( 1, $args['orderby'] );
	}

	// ------------------------------------------------------------------
	// build_query_args — incremental sync windows
	// ------------------------------------------------------------------

	public function test_build_query_args_emits_date_query_for_modified_after(): void {
		$args = $this->build( [ 'modified_after' => '2026-05-01T00:00:00Z' ] );

		$this->assertNotEmpty( $args['date_query'] );
		$found = false;
		foreach ( $args['date_query'] as $clause ) {
			if ( ! is_array( $clause ) ) {
				continue;
			}
			if ( 'post_modified_gmt' === ( $clause['column'] ?? null ) && '2026-05-01T00:00:00Z' === ( $clause['after'] ?? null ) ) {
				$this->assertTrue( $clause['inclusive'] );
				$found = true;
			}
		}
		$this->assertTrue( $found, 'date_query missing post_modified_gmt after clause' );
	}

	public function test_build_query_args_emits_date_query_for_combined_windows(): void {
		$args = $this->build( [
			'modified_after'  => '2026-05-01T00:00:00Z',
			'modified_before' => '2026-05-31T23:59:59Z',
			'date_after'      => '2026-04-01T00:00:00Z',
			'date_before'     => '2026-04-30T23:59:59Z',
		] );

		$this->assertNotEmpty( $args['date_query'] );
		$columns = array_filter( array_column( $args['date_query'], 'column' ) );
		$this->assertContains( 'post_modified_gmt', $columns );
		$this->assertContains( 'post_date_gmt', $columns );
	}

	// ------------------------------------------------------------------
	// build_query_args — ID / slug filters
	// ------------------------------------------------------------------

	public function test_build_query_args_emits_post__in_for_include_ids(): void {
		$args = $this->build( [ 'include_ids' => [ 7, 14, 21 ] ] );

		$this->assertSame( [ 7, 14, 21 ], $args['post__in'] );
	}

	public function test_build_query_args_emits_post__not_in_for_exclude_ids(): void {
		$args = $this->build( [ 'exclude_ids' => [ 8, 9 ] ] );

		$this->assertSame( [ 8, 9 ], $args['post__not_in'] );
	}

	public function test_build_query_args_emits_post_name__in_for_slug_in(): void {
		$args = $this->build( [ 'slug_in' => [ 'hello-world', 'about' ] ] );

		$this->assertSame( [ 'hello-world', 'about' ], $args['post_name__in'] );
	}

	public function test_build_query_args_coerces_id_filter_values_to_int(): void {
		// Schema declares items as integer; WP REST would coerce, but a
		// caller pushing string IDs through MCP should still land safely.
		$args = $this->build( [ 'include_ids' => [ '7', '14' ] ] );

		$this->assertSame( [ 7, 14 ], $args['post__in'] );
	}

	// ------------------------------------------------------------------
	// build_query_args — silent-truncation guard
	//
	// `include_ids` / `slug_in` accept up to 100 items but `numberposts`
	// defaults to default_count (often 25). Without the auto-raise, a
	// caller passing 80 IDs would only see the first 25 rows back —
	// silent truncation, exactly the "re-fetch a known set" failure
	// mode the new filters are supposed to solve. The fix is to
	// auto-raise numberposts to the filter set size when numberposts
	// is absent. An explicit numberposts always wins so a caller who
	// really does want a smaller page can still get one.
	// ------------------------------------------------------------------

	public function test_build_query_args_auto_raises_numberposts_to_include_ids_size(): void {
		// 80 IDs requested, no explicit numberposts → page size 80.
		$ids  = range( 1, 80 );
		$args = $this->build( [ 'include_ids' => $ids ] );

		$this->assertSame( 80, $args['numberposts'] );
	}

	public function test_build_query_args_auto_raises_numberposts_to_slug_in_size(): void {
		$slugs = array_map( static fn( $i ) => 'p-' . $i, range( 1, 40 ) );
		$args  = $this->build( [ 'slug_in' => $slugs ] );

		$this->assertSame( 40, $args['numberposts'] );
	}

	public function test_build_query_args_auto_raises_to_larger_of_include_ids_and_slug_in(): void {
		// Mixed filters: take the largest cardinality so the row set has
		// room for either set.
		$args = $this->build( [
			'include_ids' => range( 1, 30 ),
			'slug_in'     => array_map( static fn( $i ) => 'p-' . $i, range( 1, 55 ) ),
		] );

		$this->assertSame( 55, $args['numberposts'] );
	}

	public function test_build_query_args_explicit_numberposts_wins_over_filter_size(): void {
		// Caller deliberately pages: 80 IDs + numberposts=10 → page of 10.
		$args = $this->build( [
			'include_ids' => range( 1, 80 ),
			'numberposts' => 10,
		] );

		$this->assertSame( 10, $args['numberposts'] );
	}

	public function test_build_query_args_default_count_still_applies_without_filters(): void {
		// Regression: the auto-raise must not affect the no-filter case.
		$args = $this->build( [] );

		$this->assertSame( 25, $args['numberposts'] );
	}

	// ------------------------------------------------------------------
	// input_schema — filter array caps match numberposts max
	// ------------------------------------------------------------------

	public function test_filter_array_max_matches_numberposts_max(): void {
		// Symmetry: capping filter arrays at the same max as numberposts
		// keeps the "200 IDs but max 100 rows" inconsistency from
		// resurfacing. The auto-raise handles the up-to-100 range; the
		// schema-level cap prevents callers from exceeding it.
		$schema = $this->invoke_private( 'input_schema', [ $this->default_config() ] );

		$numberposts_max = $schema['properties']['numberposts']['maximum'];
		$this->assertSame( $numberposts_max, $schema['properties']['include_ids']['maxItems'] );
		$this->assertSame( $numberposts_max, $schema['properties']['exclude_ids']['maxItems'] );
		$this->assertSame( $numberposts_max, $schema['properties']['slug_in']['maxItems'] );
		$this->assertSame( $numberposts_max, $schema['properties']['taxonomy']['additionalProperties']['maxItems'] );
	}

	// ------------------------------------------------------------------
	// build_query_args — taxonomy filters
	// ------------------------------------------------------------------

	public function test_build_query_args_emits_tax_query_for_registered_taxonomy(): void {
		$args = $this->build(
			[ 'taxonomy' => [ 'category' => [ 'news', 'updates' ] ] ],
			[ 'category', 'post_tag' ]
		);

		$this->assertNotEmpty( $args['tax_query'] );
		$this->assertSame( 'AND', $args['tax_query']['relation'] );

		$found = false;
		foreach ( $args['tax_query'] as $key => $clause ) {
			if ( 'relation' === $key ) {
				continue;
			}
			if ( 'category' === ( $clause['taxonomy'] ?? null )
				&& 'slug' === ( $clause['field'] ?? null )
				&& [ 'news', 'updates' ] === ( $clause['terms'] ?? null )
				&& 'IN' === ( $clause['operator'] ?? null )
			) {
				$found = true;
			}
		}
		$this->assertTrue( $found, 'tax_query missing expected clause' );
	}

	public function test_build_query_args_drops_unregistered_taxonomy_keys(): void {
		// Defence-in-depth: a caller can ask for any taxonomy slug via input,
		// but build_query_args must filter against the taxonomies actually
		// registered to this post type. Unknown keys are silently dropped to
		// prevent leaking private taxonomies via filter probes.
		$args = $this->build(
			[ 'taxonomy' => [ 'category' => [ 'news' ], 'private_tax' => [ 'leak' ] ] ],
			[ 'category' ]
		);

		$taxonomies_seen = [];
		foreach ( $args['tax_query'] as $key => $clause ) {
			if ( 'relation' === $key ) {
				continue;
			}
			$taxonomies_seen[] = $clause['taxonomy'];
		}

		$this->assertContains( 'category', $taxonomies_seen );
		$this->assertNotContains( 'private_tax', $taxonomies_seen );
	}

	public function test_build_query_args_omits_tax_query_when_no_valid_terms(): void {
		// If the caller asks only for unknown taxonomies, no tax_query at all.
		$args = $this->build(
			[ 'taxonomy' => [ 'unknown' => [ 'x' ] ] ],
			[ 'category' ]
		);

		$this->assertArrayNotHasKey( 'tax_query', $args );
	}

	// ------------------------------------------------------------------
	// shape_row — modified output fields
	// ------------------------------------------------------------------

	public function test_shape_row_emits_modified_and_modified_gmt(): void {
		$post                    = new \WP_Post();
		$post->ID                = 1;
		$post->post_name         = 'p-1';
		$post->post_content      = '';
		$post->post_title        = '';
		$post->post_excerpt      = '';
		$post->post_date_gmt     = '2026-05-01 10:00:00';
		$post->post_date         = '2026-05-01 10:00:00';
		$post->post_modified_gmt = '2026-05-23 15:30:00';
		$post->post_modified     = '2026-05-23 15:30:00';

		$row = PostTypeListAbility::shape_row( $post, null, false );

		$this->assertArrayHasKey( 'modified', $row );
		$this->assertArrayHasKey( 'modified_gmt', $row );
		$this->assertStringStartsWith( '2026-05-23', $row['modified'] );
		$this->assertStringStartsWith( '2026-05-23', $row['modified_gmt'] );
	}

	public function test_shape_row_falls_back_to_post_date_when_modified_is_zero(): void {
		// Mirrors resolve_date's BUG-1 handling: a post with zero modified
		// values should not emit an invalid date. Fall back to publish dates
		// rather than the 1970 epoch sentinel — modified is conceptually
		// "last touched", and for an untouched post that's the publish.
		$post                    = new \WP_Post();
		$post->ID                = 1;
		$post->post_name         = 'p-1';
		$post->post_content      = '';
		$post->post_title        = '';
		$post->post_excerpt      = '';
		$post->post_date_gmt     = '2026-05-01 10:00:00';
		$post->post_date         = '2026-05-01 10:00:00';
		$post->post_modified_gmt = '0000-00-00 00:00:00';
		$post->post_modified     = '0000-00-00 00:00:00';

		$row = PostTypeListAbility::shape_row( $post, null, false );

		$this->assertStringStartsWith( '2026-05-01', $row['modified'] );
	}

	// ------------------------------------------------------------------
	// output_schema — modified fields are declared and required
	// ------------------------------------------------------------------

	public function test_output_schema_requires_modified_and_modified_gmt(): void {
		$schema = $this->invoke_private( 'output_schema', [ 'posts', null, false, [] ] );

		$item_props    = $schema['properties']['posts']['items']['properties'];
		$item_required = $schema['properties']['posts']['items']['required'];

		$this->assertArrayHasKey( 'modified', $item_props );
		$this->assertArrayHasKey( 'modified_gmt', $item_props );
		$this->assertContains( 'modified', $item_required );
		$this->assertContains( 'modified_gmt', $item_required );
	}
}
