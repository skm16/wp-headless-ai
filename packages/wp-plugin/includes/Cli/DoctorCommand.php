<?php
/**
 * DoctorCommand — registers `wp jab doctor`.
 *
 * Renders Diagnostics\Report output in one of three formats:
 *   - table (default, human-readable via TextRenderer)
 *   - json  (machine-readable, same shape as REST endpoint)
 *   - yaml  (machine-readable, alternative)
 *
 * --strict and --debug-acf flags arrive in subsequent commits.
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
	 * ## EXAMPLES
	 *
	 *     wp jab doctor
	 *     wp jab doctor --format=json
	 *
	 * @param array<int, string>   $args
	 * @param array<string, mixed> $assoc_args
	 */
	public function __invoke( array $args, array $assoc_args ): void {
		unset( $args );
		$format = (string) ( $assoc_args['format'] ?? 'table' );

		$report = Report::generate();

		if ( 'table' === $format ) {
			\WP_CLI::line( TextRenderer::render( $report ) );
			return;
		}

		if ( 'json' === $format ) {
			\WP_CLI::line( (string) wp_json_encode( $report, JSON_UNESCAPED_SLASHES ) );
			return;
		}

		if ( 'yaml' === $format ) {
			if ( function_exists( 'yaml_emit' ) ) {
				\WP_CLI::line( (string) yaml_emit( $report ) );
				return;
			}
			\WP_CLI::error( 'YAML format requires the PHP yaml extension. Install ext-yaml or use --format=json.' );
		}
	}
}
