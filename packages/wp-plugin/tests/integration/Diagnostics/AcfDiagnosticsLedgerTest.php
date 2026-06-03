<?php
/**
 * AcfDiagnosticsLedgerTest — Phase 5 deferred populated-ledger branch.
 *
 * The acf_no_schema_skips check has three branches:
 *   1. Diagnostics filter off → severity=pass, message "Tracking off — no data to report."
 *   2. Diagnostics filter on, ledger empty → severity=pass, message "Tracking on — ledger empty."
 *   3. Diagnostics filter on, ledger populated → severity=warn, detail is a string[] of
 *      formatted "group ..." and "field ..." lines.
 *
 * Phase 5 ReportSmokeTest covered branch 1 (the harness baseline). Two
 * unit tests in ReportFromEnvironmentTest cover branches 2 and 3 against
 * a synthetic env array. This test covers branch 3 end-to-end: real ACF
 * groups with unsupported shapes (Group C: unsupported location rule;
 * Group D: password field), real Schema::for_post_type() execution
 * driving record_skipped_group + record_dropped_field, real
 * Diagnostics\Report::generate() reading the ledger.
 *
 * @package Jab\WpHeadlessKit\Tests\Integration\Diagnostics
 */

declare( strict_types=1 );

final class AcfDiagnosticsLedgerTest extends IntegrationTestCase {

    protected function setUp(): void {
        parent::setUp();
        if ( ! class_exists( 'ACF' ) ) {
            $this->markTestSkipped( 'ACF not loaded — run `pnpm -w exec wp-env start --update` to install the slot.' );
        }

        // Cold-start REST so collect_environment() reads routes (same
        // pattern as Phase 5 post-merge fix in ReportSmokeTest).
        global $wp_rest_server;
        $wp_rest_server = null;

        // Enable the diagnostics ledger and force a fresh schema build
        // so record_skipped_group + record_dropped_field actually run.
        // Without flush_cache the in-memory ledger stays empty because
        // for_post_type would hit the transient cache instead of
        // walking the field groups.
        add_filter( 'jab/headless_kit/acf_diagnostics', '__return_true' );
        \Jab\WpHeadlessKit\Acf\Schema::flush_cache();
        \Jab\WpHeadlessKit\Acf\Schema::for_post_type( 'book' );
    }

    public function test_acf_no_schema_skips_warn_branch_fires_with_both_ledger_sides_populated(): void {
        $report = \Jab\WpHeadlessKit\Diagnostics\Report::generate();

        $this->assertGreaterThanOrEqual( 1, (int) ( $report['summary']['warn'] ?? 0 ), 'summary.warn must be >= 1' );

        $check = null;
        foreach ( (array) ( $report['checks'] ?? [] ) as $candidate ) {
            if ( 'acf_no_schema_skips' === ( $candidate['id'] ?? '' ) ) {
                $check = (array) $candidate;
                break;
            }
        }
        $this->assertNotNull( $check, 'acf_no_schema_skips check missing from report.' );
        $this->assertSame( 'warn', (string) ( $check['severity'] ?? '' ) );

        $detail = (array) ( $check['detail'] ?? [] );

        $has_group_line = false;
        $has_field_line = false;
        foreach ( $detail as $line ) {
            $text = (string) $line;
            if ( false !== strpos( $text, 'group group_jab_test_unsupported_location' ) ) {
                $has_group_line = true;
            }
            if ( false !== strpos( $text, 'field jab_test_password' ) ) {
                $has_field_line = true;
            }
        }
        $this->assertTrue( $has_group_line, 'detail must include a line for group_jab_test_unsupported_location.' );
        $this->assertTrue( $has_field_line, 'detail must include a line for jab_test_password field drop.' );
    }
}
