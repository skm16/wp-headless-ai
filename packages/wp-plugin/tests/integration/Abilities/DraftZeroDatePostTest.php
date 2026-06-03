<?php
/**
 * DraftZeroDatePostTest — zero-date post regression coverage.
 *
 * Real-world WP installs contain rows where post_date_gmt is exactly
 * '0000-00-00 00:00:00' (drafts written before scheduling logic ran,
 * old import artifacts, etc.). Pre-fix mysql_to_rfc3339() on the
 * zero string yielded "0000-00-00T00:00:00", which failed strict
 * date-time validation on the entire jab/get-posts response.
 *
 * The fix in PostTypeListAbility::resolve_date() walks a candidate
 * chain (post_date_gmt → post_date → post_modified_gmt → post_modified)
 * and falls back to the Unix epoch ("1970-01-01T00:00:00+00:00") as a
 * schema-valid sentinel.
 *
 * @package Jab\WpHeadlessKit\Tests\Integration\Abilities
 */

declare( strict_types=1 );

final class DraftZeroDatePostTest extends IntegrationTestCase {

    public function test_draft_with_zero_post_date_gmt_does_not_fail_output_validation(): void {
        global $wpdb;

        // Factory rejects malformed dates at the API layer, so we create
        // a normal draft first and then update the row directly.
        $author_id = (int) $this->factory()->user->create( [ 'role' => 'editor' ] );
        $post_id   = (int) $this->factory()->post->create( [
            'post_status' => 'draft',
            'post_author' => $author_id,
            'post_title'  => 'Zero-date draft',
        ] );

        $wpdb->update(
            $wpdb->posts,
            [
                'post_date'         => '0000-00-00 00:00:00',
                'post_date_gmt'     => '0000-00-00 00:00:00',
                'post_modified'     => '0000-00-00 00:00:00',
                'post_modified_gmt' => '0000-00-00 00:00:00',
            ],
            [ 'ID' => $post_id ]
        );
        clean_post_cache( $post_id );

        // Editor sees drafts; SEC-1 keeps Subscribers out of this path.
        // wp_set_current_user satisfies both: it covers the read-cap gate
        // (Editor has read) AND it gives Permissions::sanitize_post_status
        // an authenticated identity with edit_posts so the draft status
        // isn't downgraded to publish.
        wp_set_current_user( $author_id );

        $result = (array) $this->execute_ability(
            'jab/get-posts',
            [ 'post_status' => 'draft' ]
        );

        $this->assertArrayHasKey( 'posts', $result );
        $posts = (array) $result['posts'];

        // Find the zero-date draft.
        $zero_draft = null;
        foreach ( $posts as $row ) {
            if ( (int) ( $row['id'] ?? 0 ) === $post_id ) {
                $zero_draft = (array) $row;
                break;
            }
        }
        $this->assertNotNull( $zero_draft, 'Zero-date draft missing from response.' );

        // The regression assertion: date is a non-zero string. The exact
        // fallback today is the Unix epoch sentinel — pin it explicitly so
        // a future regression that returns a different non-zero string
        // (e.g. "null", "N/A", or "now") would fail this test rather than
        // pass on the broader "anything non-zero" check.
        $this->assertIsString( $zero_draft['date'] );
        $this->assertNotSame( '', $zero_draft['date'] );
        $this->assertStringStartsNotWith( '0000', $zero_draft['date'], 'date must not emit a zero-prefixed string.' );
        $this->assertStringStartsWith( '1970-01-01', $zero_draft['date'], 'zero-date fallback must be the Unix epoch sentinel.' );
    }
}
