<?php
/**
 * DiagnosticsAuthTest — exercises the /jab/v1/diagnostics auth matrix:
 * anonymous → 401, subscriber → 403, admin → 200 with envelope.
 *
 * @package Jab\WpHeadlessKit\Tests\Integration\Rest
 */

declare( strict_types=1 );

final class DiagnosticsAuthTest extends IntegrationTestCase {

    public function test_anonymous_request_returns_401(): void {
        wp_set_current_user( 0 );
        $response = $this->dispatch_rest( '/jab/v1/diagnostics' );

        $this->assertSame( 401, $response->get_status() );
    }

    public function test_subscriber_returns_403(): void {
        $this->as_subscriber();
        $response = $this->dispatch_rest( '/jab/v1/diagnostics' );

        $this->assertSame( 403, $response->get_status() );
    }

    public function test_administrator_returns_200_with_envelope(): void {
        $this->as_admin();
        $response = $this->dispatch_rest( '/jab/v1/diagnostics' );

        $this->assertSame( 200, $response->get_status() );

        $data = (array) $response->get_data();
        $this->assertArrayHasKey( 'plugin_version', $data );
        $this->assertArrayHasKey( 'summary',        $data );
        $this->assertArrayHasKey( 'facts',          $data );
        $this->assertArrayHasKey( 'checks',         $data );
        $this->assertCount( 6, $data['checks'] );
    }
}
