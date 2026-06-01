<?php
/**
 * Manifest — REST route at /wp-json/jab/v1/manifest exposing the full ability
 * roster for CLI consumption.
 *
 * The CLI's `jab sync` GETs this endpoint and runs each ability's
 * output_schema through json-schema-to-typescript to regenerate
 * `lib/sdk/types.ts`. Separate from the MCP `tools/list` path because:
 *
 *   - MCP requires session initialization (build-time type generation
 *     shouldn't speak JSON-RPC for a static read).
 *   - The agency dev wants schemas, not RPC discovery — keep them separate
 *     so each surface stays focused.
 *
 * Auth: Application Password authentication with `read` capability.
 * Schemas may include internal field names; not a public-anonymous surface.
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Rest;

defined( 'ABSPATH' ) || exit;

final class Manifest {

	private const NAMESPACE = 'jab/v1';
	private const ROUTE     = '/manifest';
	private const PREFIX    = 'jab/';

	/**
	 * Default capability gating the manifest endpoint.
	 *
	 * Kept at `read` (Subscriber+) so the CLI's `jab sync` can authenticate
	 * with the Application Password of a least-privilege service user — the
	 * pre-v0.7 contract. Agencies that consider their schema names
	 * sensitive should tighten via the `jab/headless_kit/manifest_capability`
	 * filter (e.g. `edit_posts` or `manage_options`).
	 */
	public const DEFAULT_CAPABILITY = 'read';

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
	 * Resolve the required capability for the manifest endpoint.
	 *
	 * Mirrors Permissions::ability_capability() and SiteManifest::capability():
	 * a filter returning a non-string or empty value resolves to `do_not_allow`
	 * (the WP-core "no role may pass" convention) rather than silently
	 * reverting to the permissive default. Silent fall-back is the SEC-1
	 * failure mode this whole helper layer was designed against.
	 */
	public static function capability(): string {
		/**
		 * Filter the capability required to read the manifest.
		 *
		 * @param string $capability Default capability slug.
		 */
		$capability = apply_filters(
			'jab/headless_kit/manifest_capability',
			self::DEFAULT_CAPABILITY
		);

		if ( ! is_string( $capability ) || '' === $capability ) {
			if ( function_exists( '_doing_it_wrong' ) ) {
				_doing_it_wrong(
					'Jab\\WpHeadlessKit\\Rest\\Manifest::capability',
					esc_html__( 'jab/headless_kit/manifest_capability filter returned a non-string / empty value; denying access. Return a valid capability slug (e.g. "read", "edit_posts") to permit access.', 'wp-headless-kit' ),
					'0.7.0'
				);
			}
			return 'do_not_allow';
		}

		return $capability;
	}

	/**
	 * Require a logged-in user with the resolved manifest capability.
	 * Anonymous callers cannot enumerate the schemas.
	 */
	public static function authorize(): bool {
		return current_user_can( self::capability() );
	}

	/**
	 * GET handler. Returns plugin version + timestamp + serialized
	 * `jab/*` abilities sorted by name.
	 */
	public static function respond( \WP_REST_Request $request ): \WP_REST_Response {
		unset( $request );

		$abilities = self::collect_abilities();

		usort(
			$abilities,
			static function ( array $a, array $b ): int {
				return strcmp( (string) $a['name'], (string) $b['name'] );
			}
		);

		return new \WP_REST_Response(
			[
				'plugin_version' => defined( 'Jab\\WpHeadlessKit\\VERSION' ) ? \Jab\WpHeadlessKit\VERSION : null,
				'generated_at'   => gmdate( 'Y-m-d\TH:i:s\Z' ),
				'abilities'      => $abilities,
			],
			200
		);
	}

	/**
	 * Query the WP Abilities API for every registered ability whose name
	 * begins with `jab/`. Each entry is serialized into the manifest row
	 * shape the CLI consumes.
	 *
	 * IMPORTANT: `WP_Ability`'s internal properties are PROTECTED, not public.
	 * Reading $ability->name (etc.) directly would silently return null/empty.
	 * Always use the public getters (get_name, get_label, get_description,
	 * get_category, get_input_schema, get_output_schema, get_meta).
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private static function collect_abilities(): array {
		if ( ! function_exists( 'wp_get_abilities' ) ) {
			return [];
		}
		$abilities = wp_get_abilities();
		if ( ! is_array( $abilities ) ) {
			return [];
		}
		$out = [];
		foreach ( $abilities as $ability ) {
			if ( ! is_object( $ability ) || ! method_exists( $ability, 'get_name' ) ) {
				continue;
			}
			$name = (string) $ability->get_name();
			// Explicit empty-string guard: strpos('', 'jab/') is false in
			// PHP 7.4 and 0 in PHP 8+ — pre-guard removes the ambiguity.
			if ( '' === $name || 0 !== strpos( $name, self::PREFIX ) ) {
				continue;
			}
			$out[] = [
				'name'          => $name,
				'category'      => (string) $ability->get_category(),
				'label'         => (string) $ability->get_label(),
				'description'   => (string) $ability->get_description(),
				'input_schema'  => (array) $ability->get_input_schema(),
				'output_schema' => (array) $ability->get_output_schema(),
				'meta'          => (array) $ability->get_meta(),
			];
		}
		return $out;
	}
}
