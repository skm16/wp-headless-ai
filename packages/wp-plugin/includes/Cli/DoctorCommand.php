<?php
/**
 * DoctorCommand — registers `wp jab doctor`.
 *
 * Renders Diagnostics\Report output in one of three formats:
 *   - table (default, human-readable via TextRenderer)
 *   - json  (machine-readable, same shape as REST endpoint)
 *   - yaml  (machine-readable, alternative)
 *
 * Flags:
 *   --strict: exit 1 on warn (not just fail)
 *   --debug-acf: rebuild ACF schema with diagnostics tracking enabled
 *
 * @package Jab\WpHeadlessKit\Cli
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Cli;

use Jab\WpHeadlessKit\Diagnostics\Report;

defined( 'ABSPATH' ) || exit;

final class DoctorCommand {

	/**
	 * Hook to register the WP-CLI subcommand. Called from the main plugin
	 * file ONLY when defined('WP_CLI') && WP_CLI is true.
	 */
	public static function register(): void {
		if ( ! class_exists( '\\WP_CLI' ) ) {
			return;
		}
		\WP_CLI::add_command( 'jab doctor', self::class );
	}

	/**
	 * Run diagnostics against the current site.
	 *
	 * ## OPTIONS
	 *
	 * [--format=<format>]
	 * : Output format. Default: table.
	 * ---
	 * default: table
	 * options:
	 *   - table
	 *   - json
	 *   - yaml
	 * ---
	 *
	 * [--strict]
	 * : Exit with code 1 if any check has severity `warn` (in addition to
	 *   the default behaviour of exiting 1 on `fail`). Useful for CI gates.
	 *
	 * [--debug-acf]
	 * : Force-rebuild the ACF schema with the diagnostics ledger temporarily
	 *   enabled, so the report's `acf` fact includes skipped-group and
	 *   dropped-field entries even on a WP_DEBUG=false install. Side effect:
	 *   bumps the jab_acf_schema_generation option, invalidating all cached
	 *   ACF schemas (they regenerate lazily on next access).
	 *
	 * ## EXAMPLES
	 *
	 *     wp jab doctor
	 *     wp jab doctor --format=json
	 *     wp jab doctor --strict
	 *     wp jab doctor --debug-acf
	 *
	 * @param array<int, string>   $args
	 * @param array<string, mixed> $assoc_args
	 */
	public function __invoke( array $args, array $assoc_args ): void {
		unset( $args );

		if ( ! empty( $assoc_args['debug-acf'] ) ) {
			self::rebuild_acf_with_diagnostics();
			\WP_CLI::warning( '--debug-acf rebuilt ACF schema with diagnostics enabled.' );
		}

		$format = (string) ( $assoc_args['format'] ?? 'table' );
		$report = Report::generate();

		if ( 'table' === $format ) {
			\WP_CLI::line( TextRenderer::render( $report ) );
		} elseif ( 'json' === $format ) {
			\WP_CLI::line( (string) wp_json_encode( $report, JSON_UNESCAPED_SLASHES ) );
		} elseif ( 'yaml' === $format ) {
			if ( function_exists( 'yaml_emit' ) ) {
				\WP_CLI::line( (string) yaml_emit( $report ) );
			} else {
				\WP_CLI::error( 'YAML format requires the PHP yaml extension. Install ext-yaml or use --format=json.' );
			}
		}

		$strict = ! empty( $assoc_args['strict'] );
		$code   = self::compute_exit_code( (array) ( $report['summary'] ?? [] ), $strict );
		if ( 0 !== $code ) {
			\WP_CLI::halt( $code );
		}
	}

	/**
	 * Map a summary count block + strict flag to an exit code. Pure — unit
	 * tested without WP-CLI.
	 *
	 * @param array<string, int> $summary
	 */
	public static function compute_exit_code( array $summary, bool $strict ): int {
		if ( ( $summary['fail'] ?? 0 ) > 0 ) {
			return 1;
		}
		if ( $strict && ( $summary['warn'] ?? 0 ) > 0 ) {
			return 1;
		}
		return 0;
	}

	/**
	 * --debug-acf implementation. Temporarily flips the ACF diagnostics
	 * filter on, flushes the ACF schema cache, and forces a per-CPT rebuild
	 * so the diagnostics ledger is populated before Report::generate() reads it.
	 */
	private static function rebuild_acf_with_diagnostics(): void {
		if ( ! class_exists( \Jab\WpHeadlessKit\Acf\Schema::class )
			|| ! class_exists( \Jab\WpHeadlessKit\Registry::class ) ) {
			return;
		}
		add_filter( 'jab/headless_kit/acf_diagnostics', '__return_true' );

		\Jab\WpHeadlessKit\Acf\Schema::flush_cache();

		$included = \Jab\WpHeadlessKit\Registry::discovered_post_types()['included'];
		foreach ( $included as $cpt ) {
			\Jab\WpHeadlessKit\Acf\Schema::for_post_type( (string) $cpt );
		}
	}
}
