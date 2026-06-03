<?php
/**
 * Diagnostics — REST route at /wp-json/jab/v1/diagnostics. Returns the
 * structured diagnostics Report consumed by the SaaS onboarding wizard
 * and any operator with an admin-grade Application Password.
 *
 * Auth contract mirrors Manifest::capability() and SiteManifest::capability():
 * a filter returning a non-string or empty value falls back to do_not_allow
 * (the SEC-1 hardening pattern).
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Rest;

use Jab\WpHeadlessKit\Diagnostics\Report;

defined( 'ABSPATH' ) || exit;

final class Diagnostics {

	private const NAMESPACE = 'jab/v1';
	private const ROUTE     = '/diagnostics';

	/**
	 * Default capability gating /jab/v1/diagnostics. Stricter than /manifest
	 * (read) and /site (edit_posts) because the response surfaces PHP
	 * version, capability filter values, and (when populated) ACF group /
	 * field names.
	 */
	public const DEFAULT_CAPABILITY = 'manage_options';

	public static function register(): void {
		register_rest_route(
			self::NAMESPACE,
			self::ROUTE,
			[
				'methods'             => \WP_REST_Server::READABLE,
				'callback'            => [ self::class, 'respond' ],
				'permission_callback' => [ self::class, 'authorize' ],
			]
		);
	}

	/**
	 * Resolve the required capability. Filter contract matches Manifest::capability():
	 * non-string / empty returns coerce to `do_not_allow` and emit _doing_it_wrong.
	 */
	public static function capability(): string {
		/**
		 * Filter the capability required to read /jab/v1/diagnostics.
		 *
		 * @param string $capability Default capability slug.
		 */
		$capability = apply_filters(
			'jab/headless_kit/diagnostics_capability',
			self::DEFAULT_CAPABILITY
		);

		if ( ! is_string( $capability ) || '' === $capability ) {
			if ( function_exists( '_doing_it_wrong' ) ) {
				_doing_it_wrong(
					'Jab\\WpHeadlessKit\\Rest\\Diagnostics::capability',
					esc_html__( 'jab/headless_kit/diagnostics_capability filter returned a non-string / empty value; denying access. Return a valid capability slug (e.g. "manage_options", "edit_posts") to permit access.', 'wp-headless-kit' ),
					'0.7.1'
				);
			}
			return 'do_not_allow';
		}

		return $capability;
	}

	public static function authorize(): bool {
		return current_user_can( self::capability() );
	}

	/**
	 * GET handler. Returns the diagnostics Report and sets nocache headers
	 * — the report state changes with every plugin / site config change.
	 */
	public static function respond( \WP_REST_Request $request ): \WP_REST_Response {
		unset( $request );

		if ( function_exists( 'nocache_headers' ) ) {
			nocache_headers();
		}

		return new \WP_REST_Response( Report::generate(), 200 );
	}
}
