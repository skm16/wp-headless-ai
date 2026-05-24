<?php
/**
 * Health — small REST route exposed at `/wp-json/jab/v1/` that lets external
 * agents confirm the plugin is installed and active before attempting a
 * full MCP handshake.
 *
 * Used by the Jab SaaS onboarding wizard's "Verify install" button on the
 * `/projects/[id]/onboard` route: the action GETs this endpoint with a 5s
 * timeout and renders "✓ Plugin detected" on 200. Without this route the
 * verify step had no way to distinguish "plugin not installed" from "URL
 * wrong" — WP would return 404 in both cases, so the user got the same
 * unhelpful error either way.
 *
 * Why a dedicated namespace (not piggybacking on the MCP Adapter's
 * `/wp-json/mcp/v1/`):
 *   - The MCP namespace would tell us "the MCP Adapter is installed,"
 *     not "the Jab plugin is installed." Distinguishing the two matters
 *     when an agency installs the MCP Adapter but forgets the Jab plugin.
 *   - A namespace owned by THIS plugin gives the verify check a stable
 *     contract independent of MCP Adapter versioning.
 *
 * Auth: public. The response carries no secrets — only the plugin name
 * and version, both of which are publicly visible to anyone who reads
 * the plugin file on the WP install. Authenticating this endpoint would
 * make the wizard's verify flow require credentials the user hasn't
 * entered yet (the wizard's connect step is what collects them).
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Rest;

defined( 'ABSPATH' ) || exit;

final class Health {

	private const NAMESPACE = 'jab/v1';
	private const ROUTE     = '/';

	/**
	 * Hooked to `rest_api_init`. Registers a single GET route at
	 * `/wp-json/jab/v1/` returning a small status payload.
	 */
	public static function register(): void {
		register_rest_route(
			self::NAMESPACE,
			self::ROUTE,
			[
				'methods'             => \WP_REST_Server::READABLE,
				'callback'            => [ self::class, 'respond' ],
				// Public on purpose — see file-level doc. The handler returns
				// nothing secret. `__return_true` here is the explicit
				// "no permission gate" marker rather than relying on
				// REST API's default.
				'permission_callback' => '__return_true',
			]
		);
	}

	/**
	 * GET handler. Returns the plugin's identity + version so the
	 * verify-install caller can confirm both "the plugin exists" and
	 * "we're running against the version we expect."
	 *
	 * Shape is kept minimal on purpose — adding fields here is part of the
	 * public contract once external tools start parsing the response.
	 */
	public static function respond( \WP_REST_Request $request ): \WP_REST_Response {
		unset( $request ); // Intentionally unused — kept for the WP REST signature.
		return new \WP_REST_Response(
			[
				'ok'      => true,
				'name'    => 'wp-headless-kit',
				'version' => defined( 'Jab\\WpHeadlessKit\\VERSION' ) ? \Jab\WpHeadlessKit\VERSION : null,
			],
			200
		);
	}
}
