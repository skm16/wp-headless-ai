<?php
/**
 * AcfEmptyValueOutputTest — FIX-2 (v0.6.1) regression coverage.
 *
 * FIX-2 dropped `format: uri|email|date` from ACF url/email/date_picker
 * field schemas because real-world content frequently includes empty
 * values that fail strict format validation. Pre-fix an empty ACF
 * url field hard-failed the entire jab/get-{cpt}-by-slug response
 * with "Value must be a valid URI" or similar.
 *
 * Fixture: Group A (registered in jab-test-fixtures.php) binds three
 * fields (jab_test_url, jab_test_email, jab_test_date) to the `book`
 * CPT. The test creates a book post, sets each field to empty string
 * via update_field(), and asserts the ability returns the post with
 * empty values present (not a WP_Error and not field omission).
 *
 * @package Jab\WpHeadlessKit\Tests\Integration\Acf
 */

declare( strict_types=1 );

final class AcfEmptyValueOutputTest extends IntegrationTestCase {

    protected function setUp(): void {
        parent::setUp();
        if ( ! class_exists( 'ACF' ) ) {
            $this->markTestSkipped( 'ACF not loaded — run `pnpm -w exec wp-env start --update` to install the slot.' );
        }
    }

    public function test_empty_url_email_date_acf_values_do_not_fail_output_validation(): void {
        $post_id = (int) $this->factory()->post->create( [
            'post_type'   => 'book',
            'post_status' => 'publish',
            'post_title'  => 'Empty values book',
            'post_name'   => 'empty-values-book',
        ] );

        // Empty values across the three regression-target field types.
        update_field( 'jab_test_url',   '', $post_id );
        update_field( 'jab_test_email', '', $post_id );
        update_field( 'jab_test_date',  '', $post_id );

        $result = (array) $this->execute_ability(
            'jab/get-book-by-slug',
            [ 'slug' => 'empty-values-book' ]
        );

        $this->assertNotNull( $result['book'] ?? null, 'by-slug ability returned null book — slug mismatch?' );
        $book = (array) $result['book'];

        $this->assertArrayHasKey( 'acf', $book, 'book row missing acf payload — fixture group not bound to `book`?' );
        $acf = (array) $book['acf'];

        $this->assertArrayHasKey( 'jab_test_url',   $acf );
        $this->assertArrayHasKey( 'jab_test_email', $acf );
        $this->assertArrayHasKey( 'jab_test_date',  $acf );

        // Pre-FIX-2 each of these would either WP_Error the whole call
        // (format validation) or be coerced; today they're preserved as
        // empty strings.
        $this->assertSame( '', (string) $acf['jab_test_url'] );
        $this->assertSame( '', (string) $acf['jab_test_email'] );
        $this->assertSame( '', (string) $acf['jab_test_date'] );
    }
}
