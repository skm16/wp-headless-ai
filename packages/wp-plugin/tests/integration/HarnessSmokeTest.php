<?php
/**
 * HarnessSmokeTest — proves the wp-env + bootstrap + base TestCase stack
 * actually works before regression tests assert anything plugin-specific.
 *
 * Three checks:
 *   1. WP is loaded (function_exists / class_exists probes).
 *   2. The JAB plugin's Registry::register_abilities() ran (wp_get_abilities
 *      returns at least one ability whose name starts with jab/).
 *   3. The REST layer dispatches /jab/v1/manifest end-to-end.
 *
 * @package Jab\WpHeadlessKit\Tests\Integration
 */

declare( strict_types=1 );

final class HarnessSmokeTest extends IntegrationTestCase {

    public function test_wordpress_is_loaded(): void {
        $this->assertTrue( function_exists( 'wp_get_abilities' ), 'wp_get_abilities() is missing — the Abilities API did not load.' );
        $this->assertTrue( class_exists( 'WP_REST_Server' ), 'WP_REST_Server is missing — the REST layer did not load.' );
        $this->assertTrue( class_exists( 'WP_REST_Request' ), 'WP_REST_Request is missing.' );
        $this->assertTrue( class_exists( 'WP_REST_Response' ), 'WP_REST_Response is missing.' );
    }

    public function test_jab_abilities_register_under_wp_abilities_api_init(): void {
        $abilities = wp_get_abilities();
        $names     = array_map(
            static function ( $ability ): string {
                return is_object( $ability ) && method_exists( $ability, 'get_name' )
                    ? (string) $ability->get_name()
                    : '';
            },
            $abilities
        );
        $jab_names = array_filter(
            $names,
            static fn( string $n ): bool => 0 === strpos( $n, 'jab/' )
        );

        $this->assertNotEmpty( $jab_names, 'No abilities with the jab/ prefix were registered.' );
    }

    public function test_jab_v1_manifest_responds_with_envelope(): void {
        // The mcp-adapter registers its own abilities (discover-abilities,
        // get-ability-info, execute-ability) but the Abilities API's registry
        // emits a WP_Doing_It_Wrong notice when those are looked up via
        // WP_Abilities_Registry::get_registered during the manifest build.
        // Mark them as expected so WP_UnitTestCase does not turn them into
        // assertion failures.
        $this->setExpectedIncorrectUsage( 'WP_Abilities_Registry::get_registered' );

        $this->as_subscriber();
        $response = $this->dispatch_rest( '/jab/v1/manifest' );

        $this->assertSame( 200, $response->get_status() );

        $data = (array) $response->get_data();
        $this->assertArrayHasKey( 'plugin_version', $data );
        $this->assertArrayHasKey( 'generated_at', $data );
        $this->assertArrayHasKey( 'abilities', $data );
        $this->assertIsArray( $data['abilities'] );
    }
}
