<?php
declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Diagnostics;

use Jab\WpHeadlessKit\Diagnostics\Report;
use PHPUnit\Framework\TestCase;

final class ReportFromEnvironmentTest extends TestCase {

	/**
	 * Builds a "happy path" environment snapshot where every check passes.
	 */
	private function happy_env(): array {
		return [
			'plugin_version'               => '0.7.1',
			'wp_version'                   => '6.9.0',
			'php_version'                  => '8.3.7',
			'has_abilities_api'            => true,
			'has_mcp_adapter'              => true,
			'mcp_adapter_version'          => '0.5.0',
			'registered_jab_ability_names' => [ 'jab/get-pages', 'jab/get-posts' ],
			'post_types'                   => [ 'included' => [ 'page', 'post' ], 'excluded' => [ 'attachment' ] ],
			'taxonomies'                   => [ 'included' => [ 'category' ],     'excluded' => [ 'nav_menu' ] ],
			'capability_filters'           => [
				'jab/headless_kit/ability_capability'       => 'read',
				'jab/headless_kit/manifest_capability'      => 'read',
				'jab/headless_kit/site_manifest_capability' => 'edit_posts',
				'jab/headless_kit/diagnostics_capability'   => 'manage_options',
			],
			'acf' => [
				'active'              => false,
				'pro'                 => false,
				'version'             => null,
				'diagnostics_enabled' => false,
				'skipped_groups'      => [],
				'dropped_fields'      => [],
			],
			'expected_rest_routes'            => [ '/jab/v1/', '/jab/v1/content-types', '/jab/v1/diagnostics', '/jab/v1/manifest', '/jab/v1/site' ],
			'registered_rest_routes'          => [ '/jab/v1/', '/jab/v1/content-types', '/jab/v1/diagnostics', '/jab/v1/manifest', '/jab/v1/site' ],
			'application_passwords_available' => true,
			'is_ssl'                          => true,
			'generated_at'                    => '2026-06-02T20:15:00Z',
		];
	}

	public function test_happy_path_envelope_contains_required_top_level_keys(): void {
		$report = Report::from_environment( $this->happy_env() );

		$this->assertSame( '0.7.1',                $report['plugin_version'] );
		$this->assertSame( '2026-06-02T20:15:00Z', $report['generated_at'] );
		$this->assertArrayHasKey( 'summary', $report );
		$this->assertArrayHasKey( 'facts',   $report );
		$this->assertArrayHasKey( 'checks',  $report );
	}

	public function test_summary_counts_match_check_severities(): void {
		$report = Report::from_environment( $this->happy_env() );

		$this->assertSame( 6, $report['summary']['pass'] );
		$this->assertSame( 0, $report['summary']['warn'] );
		$this->assertSame( 0, $report['summary']['fail'] );
	}

	public function test_checks_appear_in_catalog_order(): void {
		$report = Report::from_environment( $this->happy_env() );
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
			$ids
		);
	}

	public function test_facts_appear_in_catalog_order(): void {
		$report = Report::from_environment( $this->happy_env() );
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
			$ids
		);
	}

	public function test_missing_abilities_api_marks_check_as_fail(): void {
		$env                      = $this->happy_env();
		$env['has_abilities_api'] = false;

		$report = Report::from_environment( $env );
		$check  = array_values( array_filter( $report['checks'], static fn ( array $c ) => 'abilities_api' === $c['id'] ) )[0];

		$this->assertSame( 'fail', $check['severity'] );
		$this->assertSame( 1, $report['summary']['fail'] );
	}

	public function test_missing_mcp_adapter_marks_check_as_fail(): void {
		$env                        = $this->happy_env();
		$env['has_mcp_adapter']     = false;
		$env['mcp_adapter_version'] = null;

		$report = Report::from_environment( $env );
		$check  = array_values( array_filter( $report['checks'], static fn ( array $c ) => 'mcp_adapter' === $c['id'] ) )[0];

		$this->assertSame( 'fail', $check['severity'] );
	}

	public function test_missing_rest_route_reports_fail_with_missing_detail(): void {
		$env                           = $this->happy_env();
		$env['registered_rest_routes'] = [ '/jab/v1/', '/jab/v1/manifest' ];

		$report = Report::from_environment( $env );
		$check  = array_values( array_filter( $report['checks'], static fn ( array $c ) => 'rest_routes_registered' === $c['id'] ) )[0];

		$this->assertSame( 'fail', $check['severity'] );
		$this->assertSame(
			[ '/jab/v1/content-types', '/jab/v1/diagnostics', '/jab/v1/site' ],
			$check['detail']
		);
	}

	public function test_zero_post_types_discovered_reports_fail(): void {
		$env               = $this->happy_env();
		$env['post_types'] = [ 'included' => [], 'excluded' => [ 'attachment' ] ];

		$report = Report::from_environment( $env );
		$check  = array_values( array_filter( $report['checks'], static fn ( array $c ) => 'post_types_discovered' === $c['id'] ) )[0];

		$this->assertSame( 'fail', $check['severity'] );
	}

	public function test_application_passwords_unavailable_reports_warn_with_ssl_detail(): void {
		$env                                    = $this->happy_env();
		$env['application_passwords_available'] = false;
		$env['is_ssl']                          = false;

		$report = Report::from_environment( $env );
		$check  = array_values( array_filter( $report['checks'], static fn ( array $c ) => 'application_passwords_enabled' === $c['id'] ) )[0];

		$this->assertSame( 'warn', $check['severity'] );
		$this->assertSame( 'is_ssl()=false', $check['detail'] );
	}

	public function test_acf_skipped_groups_with_tracking_on_reports_warn(): void {
		$env                               = $this->happy_env();
		$env['acf']['active']              = true;
		$env['acf']['version']             = '6.3.4';
		$env['acf']['diagnostics_enabled'] = true;
		$env['acf']['skipped_groups']      = [
			[ 'post_type' => 'beer', 'group_key' => 'group_xyz', 'reason' => 'unsupported location' ],
		];

		$report = Report::from_environment( $env );
		$check  = array_values( array_filter( $report['checks'], static fn ( array $c ) => 'acf_no_schema_skips' === $c['id'] ) )[0];

		$this->assertSame( 'warn', $check['severity'] );
	}

	public function test_acf_diagnostics_tracking_off_reports_pass_with_note(): void {
		$env    = $this->happy_env(); // acf inactive + tracking off
		$report = Report::from_environment( $env );
		$check  = array_values( array_filter( $report['checks'], static fn ( array $c ) => 'acf_no_schema_skips' === $c['id'] ) )[0];

		$this->assertSame( 'pass', $check['severity'] );
	}

	public function test_capability_filters_keys_alphabetically_sorted_in_output(): void {
		$report = Report::from_environment( $this->happy_env() );
		$facts  = array_values( array_filter( $report['facts'], static fn ( array $f ) => 'capability_filters' === $f['id'] ) );
		$keys   = array_keys( $facts[0]['value'] );

		$this->assertSame(
			[
				'jab/headless_kit/ability_capability',
				'jab/headless_kit/diagnostics_capability',
				'jab/headless_kit/manifest_capability',
				'jab/headless_kit/site_manifest_capability',
			],
			$keys
		);
	}
}
