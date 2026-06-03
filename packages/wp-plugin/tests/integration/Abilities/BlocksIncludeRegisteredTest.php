<?php
/**
 * BlocksIncludeRegisteredTest — FIX-5 (v0.6.3) regression coverage.
 *
 * Posts containing registered Gutenberg blocks no longer fail
 * jab/get-post-by-slug with include.blocks=true. The pre-fix shape
 * used oneOf at the top-level discriminated union over per-block-type
 * variants, with a permissive fallback carrying not:{enum:known_names}.
 * WP REST's rest_validate_value_from_schema ignores `not` inside oneOf
 * alternatives, so every known block matched BOTH its typed variant
 * AND the fallback — rest_find_one_matching_schema rejected the
 * response with "matches more than one of the expected formats."
 *
 * The fix switched to anyOf, which tolerates multi-match. SDK typing
 * is unaffected (json-schema-to-typescript emits identical unions).
 *
 * @package Jab\WpHeadlessKit\Tests\Integration\Abilities
 */

declare( strict_types=1 );

final class BlocksIncludeRegisteredTest extends IntegrationTestCase {

    public function test_include_blocks_true_succeeds_for_post_with_registered_block(): void {
        $post_id = (int) $this->factory()->post->create( [
            'post_status'  => 'publish',
            'post_title'   => 'Blocks regression post',
            'post_name'    => 'blocks-regression-post',
            'post_content' => '<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->',
        ] );

        // Switch to a Subscriber so the read-cap gate on
        // jab/get-post-by-slug is satisfied. The test framework defaults
        // to user 0 (anonymous); current_user_can('read') is false for
        // user 0 so execute_ability would WP_Error on permission.
        $this->as_subscriber();

        $result = (array) $this->execute_ability(
            'jab/get-post-by-slug',
            [
                'slug'    => 'blocks-regression-post',
                'include' => [ 'blocks' => true ],
            ]
        );

        $this->assertNotNull( $result['post'] ?? null, 'by-slug ability returned null — slug mismatch?' );
        $post = (array) $result['post'];

        $this->assertArrayHasKey( 'blocks', $post, 'include.blocks=true should populate the blocks key.' );
        $blocks = (array) $post['blocks'];
        $this->assertNotEmpty( $blocks, 'Parsed blocks should be present for a post with paragraph content.' );
        $this->assertSame( 'core/paragraph', (string) ( $blocks[0]['blockName'] ?? '' ) );
    }
}
