<?php
/**
 * ObjectTermsGroupingTest — wp_get_object_terms() grouping regression.
 *
 * batch_terms() must pass fields=all_with_object_id so each returned
 * WP_Term carries its source post's ID. With the default fields=all
 * mode, WP dedupes term rows across the input post set and drops
 * object_id, which collapses every term under post 0 downstream and
 * leaves every post emitting empty taxonomy arrays. The fix is to
 * use all_with_object_id and group by WP_Term->object_id.
 *
 * Fixture: two posts. Post A gets tag `red` only; post B gets tag
 * `blue` only. Pre-fix both rows would have empty post_tag arrays
 * (term rows dedup'd, object_id missing, everything under post 0).
 *
 * @package Jab\WpHeadlessKit\Tests\Integration\Abilities
 */

declare( strict_types=1 );

final class ObjectTermsGroupingTest extends IntegrationTestCase {

    public function test_object_terms_grouping_returns_terms_under_correct_post_ids(): void {
        $post_a = (int) $this->factory()->post->create( [ 'post_status' => 'publish', 'post_title' => 'Post A' ] );
        $post_b = (int) $this->factory()->post->create( [ 'post_status' => 'publish', 'post_title' => 'Post B' ] );

        wp_set_post_terms( $post_a, [ 'red' ],  'post_tag' );
        wp_set_post_terms( $post_b, [ 'blue' ], 'post_tag' );

        // Switch to a Subscriber so the read-cap gate on jab/get-posts
        // is satisfied. The test framework defaults to user 0 (anonymous);
        // current_user_can('read') is false for user 0 so execute_ability
        // would WP_Error on permission.
        $this->as_subscriber();

        $result = (array) $this->execute_ability( 'jab/get-posts' );
        $rows   = (array) ( $result['posts'] ?? [] );

        $row_by_id = [];
        foreach ( $rows as $row ) {
            $row_by_id[ (int) ( $row['id'] ?? 0 ) ] = (array) $row;
        }

        $this->assertArrayHasKey( $post_a, $row_by_id, 'Post A missing from response.' );
        $this->assertArrayHasKey( $post_b, $row_by_id, 'Post B missing from response.' );

        $tags_a = array_map(
            static fn( array $term ): string => (string) $term['slug'],
            (array) ( $row_by_id[ $post_a ]['post_tag'] ?? [] )
        );
        $tags_b = array_map(
            static fn( array $term ): string => (string) $term['slug'],
            (array) ( $row_by_id[ $post_b ]['post_tag'] ?? [] )
        );

        $this->assertSame( [ 'red' ],  $tags_a, 'Post A must carry only its own tag (red).' );
        $this->assertSame( [ 'blue' ], $tags_b, 'Post B must carry only its own tag (blue).' );
    }
}
