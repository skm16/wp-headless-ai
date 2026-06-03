<?php
/**
 * DiagnosticsCapabilityFilterTest — exercises
 * `jab/headless_kit/diagnostics_capability` filter contract:
 *   1. Filter to a lower cap → that role passes.
 *   2. Filter returning empty string → do_not_allow fallback + notice.
 *
 * @package Jab\WpHeadlessKit\Tests\Integration\Rest
 */

declare( strict_types=1 );

final class DiagnosticsCapabilityFilterTest extends IntegrationTestCase {

    public function test_lowered_capability_filter_lets_a_subscriber_pass(): void {
        add_filter( 'jab/headless_kit/diagnostics_capability', static fn ( $cap ): string => 'read' );

        $this->as_subscriber();
        $response = $this->dispatch_rest( '/jab/v1/diagnostics' );

        $this->assertSame( 200, $response->get_status() );
        $this->assertArrayHasKey( 'summary', (array) $response->get_data() );
    }

    public function test_empty_string_filter_falls_back_to_do_not_allow(): void {
        $this->setExpectedIncorrectUsage( 'Jab\\WpHeadlessKit\\Rest\\Diagnostics::capability' );
        add_filter( 'jab/headless_kit/diagnostics_capability', static fn ( $cap ): string => '' );

        $this->as_admin();
        $response = $this->dispatch_rest( '/jab/v1/diagnostics' );

        $this->assertSame( 403, $response->get_status() );
    }
}
