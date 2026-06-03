<?php
/**
 * PostsWithZeroTermsTest — required-taxonomy-array regression.
 *
 * Every public taxonomy registered to a post type is `required` in the
 * row schema. Posts with zero terms in a given taxonomy must still
 * include the (empty) array — pre-fix omission failed output validation.
 * The fix layers every public taxonomy as an empty array first, then
 * merges any actual terms over the empty defaults.
 *
 * @package Jab\WpHeadlessKit\Tests\Integration\Abilities
 */

declare( strict_types=1 );

final class PostsWithZeroTermsTest extends IntegrationTestCase {

    public function test_posts_with_zero_terms_still_include_required_taxonomy_arrays(): void {
        $post_id = (int) $this->factory()->post->create( [
            'post_status' => 'publish',
            'post_title'  => 'Untermed post',
        ] );

        // WP auto-applies the default category — strip it so this post
        // has zero terms across both registered post taxonomies.
        wp_set_post_terms( $post_id, [], 'category' );
        wp_set_post_terms( $post_id, [], 'post_tag' );

        // Switch to a Subscriber so the read-cap gate on jab/get-posts
        // is satisfied. The test framework defaults to user 0 (anonymous);
        // current_user_can('read') is false for user 0 so execute_ability
        // would WP_Error on permission.
        $this->as_subscriber();

        $result = (array) $this->execute_ability( 'jab/get-posts' );
        $rows   = (array) ( $result['posts'] ?? [] );

        $row = null;
        foreach ( $rows as $candidate ) {
            if ( (int) ( $candidate['id'] ?? 0 ) === $post_id ) {
                $row = (array) $candidate;
                break;
            }
        }
        $this->assertNotNull( $row, 'Untermed post missing from response.' );

        $this->assertArrayHasKey( 'category', $row, 'category key absent — schema requires it even on zero-terms rows.' );
        $this->assertArrayHasKey( 'post_tag', $row, 'post_tag key absent — schema requires it even on zero-terms rows.' );
        $this->assertSame( [], $row['category'] );
        $this->assertSame( [], $row['post_tag'] );
    }
}
