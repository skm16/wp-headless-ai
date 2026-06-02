<?php
/**
 * Sec1SubscriberDraftTest — SEC-1 (v0.4.0) regression coverage.
 *
 * SEC-1: a Subscriber-authenticated caller used to be able to enumerate
 * draft posts by asking for post_status=draft (or post_status=any). The
 * fix in Permissions::sanitize_post_status downgrades any non-publish
 * status to publish unless the caller has edit_posts on the post type.
 *
 * THE CORRECT ASSERTION IS NOT "zero rows" — the downgrade returns the
 * published rows, just not the drafts. Asserting the response equals
 * exactly the public set is what proves the security invariant.
 *
 * @package Jab\WpHeadlessKit\Tests\Integration\Abilities
 */

declare( strict_types=1 );

final class Sec1SubscriberDraftTest extends IntegrationTestCase {

    /**
     * @return array{published: int, drafts: int[]} Post IDs by status.
     */
    private function seed_posts(): array {
        $author_a = (int) $this->factory()->user->create( [ 'role' => 'author' ] );
        $author_b = (int) $this->factory()->user->create( [ 'role' => 'author' ] );

        $published = (int) $this->factory()->post->create( [
            'post_status' => 'publish',
            'post_author' => $author_a,
            'post_title'  => 'Published post',
        ] );
        $draft_a = (int) $this->factory()->post->create( [
            'post_status' => 'draft',
            'post_author' => $author_a,
            'post_title'  => 'Draft by A',
        ] );
        $draft_b = (int) $this->factory()->post->create( [
            'post_status' => 'draft',
            'post_author' => $author_b,
            'post_title'  => 'Draft by B',
        ] );

        return [
            'published' => $published,
            'drafts'    => [ $draft_a, $draft_b ],
        ];
    }

    public function test_subscriber_executing_get_posts_with_draft_status_sees_only_published(): void {
        $seed = $this->seed_posts();
        $this->as_subscriber();

        $result   = (array) $this->execute_ability( 'jab/get-posts', [ 'post_status' => 'draft' ] );
        $post_ids = array_map(
            static fn( array $row ): int => (int) ( $row['id'] ?? 0 ),
            (array) ( $result['posts'] ?? [] )
        );

        $this->assertContains( $seed['published'], $post_ids, 'The published post should be in the response.' );
        foreach ( $seed['drafts'] as $draft_id ) {
            $this->assertNotContains( $draft_id, $post_ids, sprintf( 'Draft post %d leaked into the Subscriber response.', $draft_id ) );
        }
    }

    public function test_subscriber_executing_get_posts_with_any_status_sees_only_published(): void {
        $seed = $this->seed_posts();
        $this->as_subscriber();

        $result   = (array) $this->execute_ability( 'jab/get-posts', [ 'post_status' => 'any' ] );
        $post_ids = array_map(
            static fn( array $row ): int => (int) ( $row['id'] ?? 0 ),
            (array) ( $result['posts'] ?? [] )
        );

        $this->assertContains( $seed['published'], $post_ids, 'The published post should be in the response.' );
        foreach ( $seed['drafts'] as $draft_id ) {
            $this->assertNotContains( $draft_id, $post_ids, sprintf( 'Draft post %d leaked into the Subscriber any-status response.', $draft_id ) );
        }
    }

    public function test_editor_executing_get_posts_with_draft_status_sees_drafts(): void {
        $seed    = $this->seed_posts();
        $user_id = (int) $this->factory()->user->create( [ 'role' => 'editor' ] );
        wp_set_current_user( $user_id );

        $result   = (array) $this->execute_ability( 'jab/get-posts', [ 'post_status' => 'draft' ] );
        $post_ids = array_map(
            static fn( array $row ): int => (int) ( $row['id'] ?? 0 ),
            (array) ( $result['posts'] ?? [] )
        );

        foreach ( $seed['drafts'] as $draft_id ) {
            $this->assertContains( $draft_id, $post_ids, sprintf( 'Editor should see draft %d.', $draft_id ) );
        }
    }
}
