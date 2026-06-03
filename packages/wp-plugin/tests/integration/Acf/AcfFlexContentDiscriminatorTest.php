<?php
/**
 * AcfFlexContentDiscriminatorTest — Flex Content discriminator regression.
 *
 * ACF Flex Content fields are emitted as a oneOf<layout_a, layout_b, ...>
 * union, with each variant's `acf_fc_layout` property identifying which
 * layout it is. Pre-fix the discriminator was `const: <first_layout>`,
 * which meant only the first layout's rows validated; any row using a
 * second layout WP_Error'd the entire response. Today the discriminator
 * is an enum over every registered layout name.
 *
 * The two-layout fixture (Group B) is load-bearing: a single-layout
 * fixture would pass both pre- and post-fix because const === enum[0]
 * when there is only one value.
 *
 * @package Jab\WpHeadlessKit\Tests\Integration\Acf
 */

declare( strict_types=1 );

final class AcfFlexContentDiscriminatorTest extends IntegrationTestCase {

    protected function setUp(): void {
        parent::setUp();
        if ( ! class_exists( 'ACF' ) ) {
            $this->markTestSkipped( 'ACF not loaded — run `pnpm -w exec wp-env start --update` to install the slot.' );
        }
    }

    public function test_flex_content_discriminator_accepts_multiple_layout_names(): void {
        $post_id = (int) $this->factory()->post->create( [
            'post_type'   => 'book',
            'post_status' => 'publish',
            'post_title'  => 'Flex content book',
            'post_name'   => 'flex-content-book',
        ] );

        // One row of each layout. The second-layout row is what catches
        // the pre-fix const discriminator bug.
        update_field( 'jab_test_flex', [
            [ 'acf_fc_layout' => 'layout_a', 'a_text' => 'A' ],
            [ 'acf_fc_layout' => 'layout_b', 'b_text' => 'B' ],
        ], $post_id );

        // Switch to a Subscriber so the read-cap gate on
        // jab/get-{cpt}-by-slug is satisfied. The test framework defaults
        // to user 0 (anonymous); current_user_can('read') is false for
        // user 0 so execute_ability would WP_Error on permission.
        $this->as_subscriber();

        $result = (array) $this->execute_ability(
            'jab/get-book-by-slug',
            [ 'slug' => 'flex-content-book' ]
        );

        $this->assertNotNull( $result['book'] ?? null );
        $book = (array) $result['book'];
        $this->assertArrayHasKey( 'acf', $book );

        $flex = (array) ( $book['acf']['jab_test_flex'] ?? [] );
        $this->assertCount(
            2,
            $flex,
            'Flex field should carry both layout rows; pre-fix the second was dropped by validation.'
        );
        $this->assertSame( 'layout_a', (string) ( $flex[0]['acf_fc_layout'] ?? '' ) );
        $this->assertSame( 'layout_b', (string) ( $flex[1]['acf_fc_layout'] ?? '' ) );
    }
}
