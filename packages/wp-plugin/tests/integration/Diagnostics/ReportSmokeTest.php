<?php
/**
 * ReportSmokeTest — exercises Diagnostics\Report::generate() end-to-end.
 *
 * Asserts the full report envelope, the catalog of facts and checks, and
 * that the harness fixture state produces six passes. ACF-active branch
 * coverage is deferred to Phase 1.1.
 *
 * @package Jab\WpHeadlessKit\Tests\Integration\Diagnostics
 */

declare( strict_types=1 );

final class ReportSmokeTest extends IntegrationTestCase {

    /**
     * Prime the WP REST server before each test so that rest_api_init has fired
     * and Report::collect_environment() can read the registered route table.
     *
     * WP_UnitTestCase::tearDown() restores $wp_actions to the snapshot taken at
     * setUp() time, which resets did_action('rest_api_init') back to 0.
     * collect_environment() guards its route-table read on that counter, so we
     * must force rest_api_init to re-fire on every setUp rather than relying on
     * it having fired in a previous test.
     *
     * Pattern mirrors WP_REST_Controller_TestCase::set_up(): null the global so
     * rest_get_server() treats this as a cold start and fires do_action('rest_api_init').
     */
    protected function setUp(): void {
        parent::setUp();
        global $wp_rest_server;
        $wp_rest_server = null;         // force a clean server + rest_api_init re-fire.
        rest_get_server();              // instantiate + fire rest_api_init → routes registered.
    }

    public function test_generate_returns_documented_envelope_keys(): void {
        $report = \Jab\WpHeadlessKit\Diagnostics\Report::generate();

        $this->assertArrayHasKey( 'plugin_version', $report, 'plugin_version envelope key missing.' );
        $this->assertArrayHasKey( 'generated_at',   $report, 'generated_at envelope key missing.' );
        $this->assertArrayHasKey( 'summary',        $report, 'summary envelope key missing.' );
        $this->assertArrayHasKey( 'facts',          $report, 'facts array missing.' );
        $this->assertArrayHasKey( 'checks',         $report, 'checks array missing.' );
    }

    public function test_all_six_check_ids_are_present_in_catalog_order(): void {
        $report = \Jab\WpHeadlessKit\Diagnostics\Report::generate();
        $ids    = array_column( $report['checks'], 'id' );

        $this->assertSame(
            [
                'abilities_api',
                'mcp_adapter',
                'rest_routes_registered',
                'post_types_discovered',
                'application_passwords_enabled',
                'acf_no_schema_skips',
            ],
            $ids,
            'Check ids must appear in the spec §5 catalog order.'
        );
    }

    public function test_eight_facts_are_present_in_catalog_order(): void {
        $report = \Jab\WpHeadlessKit\Diagnostics\Report::generate();
        $ids    = array_column( $report['facts'], 'id' );

        $this->assertSame(
            [
                'plugin_version',
                'wp_version',
                'php_version',
                'registered_abilities',
                'post_types',
                'taxonomies',
                'capability_filters',
                'acf',
            ],
            $ids,
            'Fact ids must appear in the spec §4 catalog order.'
        );
    }

    public function test_capability_filters_resolved_to_documented_defaults(): void {
        $report = \Jab\WpHeadlessKit\Diagnostics\Report::generate();
        $facts  = array_values( array_filter( $report['facts'], static fn ( array $f ) => 'capability_filters' === $f['id'] ) );
        $caps   = $facts[0]['value'];

        $this->assertSame( 'read',            $caps['jab/headless_kit/manifest_capability'] );
        $this->assertSame( 'edit_posts',      $caps['jab/headless_kit/site_manifest_capability'] );
        $this->assertSame( 'manage_options',  $caps['jab/headless_kit/diagnostics_capability'] );
    }

    public function test_harness_state_produces_summary_with_zero_fails(): void {
        $report = \Jab\WpHeadlessKit\Diagnostics\Report::generate();
        $this->assertSame( 0, $report['summary']['fail'], 'Harness state should fail no checks; spec §5 catalog assumes everything healthy.' );
    }

    public function test_rest_routes_registered_check_passes_with_all_five_routes(): void {
        $report = \Jab\WpHeadlessKit\Diagnostics\Report::generate();
        $check  = array_values( array_filter( $report['checks'], static fn ( array $c ) => 'rest_routes_registered' === $c['id'] ) )[0];

        $this->assertSame( 'pass', $check['severity'] );
        $this->assertSame(
            [ '/jab/v1/', '/jab/v1/content-types', '/jab/v1/diagnostics', '/jab/v1/manifest', '/jab/v1/site' ],
            $check['detail']
        );
    }
}
