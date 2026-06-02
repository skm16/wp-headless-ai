<?php
/**
 * Report — Phase 5 diagnostics service.
 *
 * Two halves with one public surface (generate()):
 *   - collect_environment(): WP-bound. Reads filter values, registry state,
 *     REST routes, plugin/PHP/WP versions, ACF state. Integration-tested.
 *   - from_environment( $env ): pure. Builds the documented report shape
 *     from the snapshot. Unit-tested.
 *
 * The deterministic ordering rules (spec §4) and full check catalog (§5)
 * live in from_environment().
 *
 * @package Jab\WpHeadlessKit\Diagnostics
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Diagnostics;

defined( 'ABSPATH' ) || exit;

final class Report {

	/**
	 * Routes the spec requires the plugin to register. Order is the contract
	 * for the rest_routes_registered detail array — sorted alphabetically.
	 */
	public const EXPECTED_REST_ROUTES = [
		'/jab/v1/',
		'/jab/v1/content-types',
		'/jab/v1/diagnostics',
		'/jab/v1/manifest',
		'/jab/v1/site',
	];

	/**
	 * Build the full report from a pre-collected environment snapshot.
	 * Pure. No WP calls.
	 *
	 * @param array<string, mixed> $env Snapshot produced by collect_environment().
	 * @return array<string, mixed>
	 */
	public static function from_environment( array $env ): array {
		$facts  = self::build_facts( $env );
		$checks = self::build_checks( $env );

		return [
			'plugin_version' => (string) ( $env['plugin_version'] ?? '' ),
			'generated_at'   => (string) ( $env['generated_at'] ?? '' ),
			'summary'        => self::summarize( $checks ),
			'facts'          => array_map( static fn ( Fact $f ): array  => $f->to_array(), $facts ),
			'checks'         => array_map( static fn ( Check $c ): array => $c->to_array(), $checks ),
		];
	}

	/**
	 * Public entry point. Collects current WP / plugin state, hands the
	 * snapshot to from_environment(), returns the report.
	 *
	 * @return array<string, mixed>
	 */
	public static function generate(): array {
		return self::from_environment( self::collect_environment() );
	}

	/**
	 * Snapshot the bits of WP / plugin state every check / fact needs.
	 * The WP-bound boundary. Integration-tested.
	 *
	 * @return array<string, mixed>
	 */
	public static function collect_environment(): array {
		$registered_routes = [];
		if ( function_exists( 'rest_get_server' ) ) {
			$registered_routes = array_keys( (array) rest_get_server()->get_routes() );
		}

		$ability_names = [];
		if ( function_exists( 'wp_get_abilities' ) ) {
			foreach ( (array) wp_get_abilities() as $ability ) {
				if ( is_object( $ability ) && method_exists( $ability, 'get_name' ) ) {
					$name = (string) $ability->get_name();
					if ( '' !== $name && 0 === strpos( $name, 'jab/' ) ) {
						$ability_names[] = $name;
					}
				}
			}
		}

		$post_types = class_exists( \Jab\WpHeadlessKit\Registry::class )
			? \Jab\WpHeadlessKit\Registry::discovered_post_types()
			: [ 'included' => [], 'excluded' => [] ];

		$taxonomies = class_exists( \Jab\WpHeadlessKit\Registry::class )
			? \Jab\WpHeadlessKit\Registry::discovered_taxonomies()
			: [ 'included' => [], 'excluded' => [] ];

		$acf_active = class_exists( \Jab\WpHeadlessKit\Acf\Schema::class )
			&& \Jab\WpHeadlessKit\Acf\Schema::is_active();

		$acf_version = defined( 'ACF_VERSION' ) ? (string) ACF_VERSION : null;
		$acf_pro     = defined( 'ACF_PRO' ) ? (bool) ACF_PRO : false;

		$acf_diag = [
			'active'              => $acf_active,
			'pro'                 => $acf_pro,
			'version'             => $acf_version,
			'diagnostics_enabled' => self::acf_diagnostics_enabled(),
			'skipped_groups'      => [],
			'dropped_fields'      => [],
		];
		if ( class_exists( \Jab\WpHeadlessKit\Acf\Schema::class ) ) {
			$ledger                     = (array) \Jab\WpHeadlessKit\Acf\Schema::diagnostics();
			$acf_diag['skipped_groups'] = (array) ( $ledger['groups'] ?? [] );
			$acf_diag['dropped_fields'] = (array) ( $ledger['fields'] ?? [] );
		}

		$plugin_version = defined( 'Jab\\WpHeadlessKit\\VERSION' ) ? (string) \Jab\WpHeadlessKit\VERSION : '';
		$wp_version     = function_exists( 'get_bloginfo' ) ? (string) get_bloginfo( 'version' ) : '';

		return [
			'plugin_version'                  => $plugin_version,
			'wp_version'                      => $wp_version,
			'php_version'                     => PHP_VERSION,
			'has_abilities_api'               => function_exists( 'wp_register_ability' ),
			'has_mcp_adapter'                 => class_exists( 'WP\\MCP\\Core\\McpAdapter' ),
			'mcp_adapter_version'             => defined( 'WP_MCP_VERSION' ) ? (string) WP_MCP_VERSION : null,
			'registered_jab_ability_names'    => $ability_names,
			'post_types'                      => $post_types,
			'taxonomies'                      => $taxonomies,
			'capability_filters'              => self::collect_capability_filters(),
			'acf'                             => $acf_diag,
			'expected_rest_routes'            => self::EXPECTED_REST_ROUTES,
			'registered_rest_routes'          => $registered_routes,
			'application_passwords_available' => function_exists( 'wp_is_application_passwords_available' )
				? (bool) wp_is_application_passwords_available()
				: false,
			'is_ssl'                          => function_exists( 'is_ssl' ) ? (bool) is_ssl() : false,
			'generated_at'                    => gmdate( 'Y-m-d\TH:i:s\Z' ),
		];
	}

	/**
	 * Resolve every filterable capability surface to its current value.
	 * Returns slug => resolved-capability map.
	 *
	 * @return array<string, string>
	 */
	private static function collect_capability_filters(): array {
		$resolvers = [
			'jab/headless_kit/manifest_capability'      => [ \Jab\WpHeadlessKit\Rest\Manifest::class, 'capability' ],
			'jab/headless_kit/site_manifest_capability' => [ \Jab\WpHeadlessKit\Rest\SiteManifest::class, 'capability' ],
			'jab/headless_kit/diagnostics_capability'   => [ \Jab\WpHeadlessKit\Rest\Diagnostics::class, 'capability' ],
			'jab/headless_kit/ability_capability'       => [ \Jab\WpHeadlessKit\Abilities\Permissions::class, 'ability_capability' ],
		];
		$out       = [];
		foreach ( $resolvers as $filter_name => $resolver ) {
			list( $class, $method ) = $resolver;
			if ( class_exists( $class ) && method_exists( $class, $method ) ) {
				$out[ $filter_name ] = (string) call_user_func( [ $class, $method ] );
			} else {
				$out[ $filter_name ] = '';
			}
		}
		return $out;
	}

	private static function acf_diagnostics_enabled(): bool {
		if ( defined( 'WP_DEBUG' ) && WP_DEBUG ) {
			return true;
		}
		if ( function_exists( 'apply_filters' ) ) {
			return (bool) apply_filters( 'jab/headless_kit/acf_diagnostics', false );
		}
		return false;
	}

	/**
	 * @return Fact[]
	 */
	private static function build_facts( array $env ): array {
		$cap_filters = (array) ( $env['capability_filters'] ?? [] );
		ksort( $cap_filters );

		$ability_names = (array) ( $env['registered_jab_ability_names'] ?? [] );
		sort( $ability_names );

		$post_types = (array) ( $env['post_types'] ?? [ 'included' => [], 'excluded' => [] ] );
		$taxonomies = (array) ( $env['taxonomies'] ?? [ 'included' => [], 'excluded' => [] ] );

		$acf = (array) ( $env['acf'] ?? [] );

		return [
			new Fact( 'plugin_version', 'Plugin version', (string) ( $env['plugin_version'] ?? '' ) ),
			new Fact( 'wp_version', 'WordPress version', (string) ( $env['wp_version'] ?? '' ) ),
			new Fact( 'php_version', 'PHP version', (string) ( $env['php_version'] ?? '' ) ),
			new Fact( 'registered_abilities', 'Registered JAB abilities', count( $ability_names ), $ability_names ),
			new Fact( 'post_types', 'Public post types', $post_types ),
			new Fact( 'taxonomies', 'Public taxonomies', $taxonomies ),
			new Fact( 'capability_filters', 'Capability filter values', $cap_filters ),
			new Fact( 'acf', 'ACF', $acf, self::acf_detail_note( $acf ) ),
		];
	}

	/**
	 * @return Check[]
	 */
	private static function build_checks( array $env ): array {
		return [
			self::check_abilities_api( $env ),
			self::check_mcp_adapter( $env ),
			self::check_rest_routes_registered( $env ),
			self::check_post_types_discovered( $env ),
			self::check_application_passwords_enabled( $env ),
			self::check_acf_no_schema_skips( $env ),
		];
	}

	private static function check_abilities_api( array $env ): Check {
		if ( true === ( $env['has_abilities_api'] ?? false ) ) {
			return Check::pass( 'abilities_api', 'Abilities API loaded', 'wp_register_ability() is available.' );
		}
		return Check::fail(
			'abilities_api',
			'Abilities API loaded',
			'wp_register_ability() is not available. The plugin requires WordPress 6.9 or later.'
		);
	}

	private static function check_mcp_adapter( array $env ): Check {
		if ( true === ( $env['has_mcp_adapter'] ?? false ) ) {
			$version = (string) ( $env['mcp_adapter_version'] ?? 'unknown' );
			return Check::pass( 'mcp_adapter', 'MCP Adapter loaded', "wordpress/mcp-adapter v{$version} detected." );
		}
		return Check::fail(
			'mcp_adapter',
			'MCP Adapter loaded',
			'wordpress/mcp-adapter is not loaded. The plugin requires it for MCP-iterable headless use.'
		);
	}

	private static function check_rest_routes_registered( array $env ): Check {
		$registered = (array) ( $env['registered_rest_routes'] ?? [] );
		$expected   = self::EXPECTED_REST_ROUTES;
		$missing    = array_values( array_diff( $expected, $registered ) );
		sort( $missing );

		$registered_present = array_values( array_intersect( $expected, $registered ) );
		sort( $registered_present );

		$total   = count( $expected );
		$present = count( $registered_present );
		$msg     = "{$present}/{$total} routes present.";

		if ( $present === $total ) {
			return Check::pass( 'rest_routes_registered', 'JAB REST routes registered', $msg, $registered_present );
		}
		return Check::fail( 'rest_routes_registered', 'JAB REST routes registered', $msg, $missing );
	}

	private static function check_post_types_discovered( array $env ): Check {
		$included = (array) ( $env['post_types']['included'] ?? [] );
		$count    = count( $included );
		if ( $count > 0 ) {
			return Check::pass( 'post_types_discovered', 'At least one public post type discovered', "{$count} discovered." );
		}
		return Check::fail(
			'post_types_discovered',
			'At least one public post type discovered',
			'No public post types after exclusions. Either the post_type_excludes filter is over-restrictive, or WP core is in a broken state.'
		);
	}

	private static function check_application_passwords_enabled( array $env ): Check {
		$available = (bool) ( $env['application_passwords_available'] ?? false );
		$is_ssl    = (bool) ( $env['is_ssl'] ?? false );
		if ( $available ) {
			return Check::pass(
				'application_passwords_enabled',
				'Application Passwords enabled',
				'wp_is_application_passwords_available() true.'
			);
		}
		return Check::warn(
			'application_passwords_enabled',
			'Application Passwords enabled',
			'Disabled — agencies cannot authenticate against this site via the CLI or SaaS until re-enabled.',
			'is_ssl()=' . ( $is_ssl ? 'true' : 'false' )
		);
	}

	private static function check_acf_no_schema_skips( array $env ): Check {
		$acf            = (array) ( $env['acf'] ?? [] );
		$diagnostics_on = (bool) ( $acf['diagnostics_enabled'] ?? false );

		if ( ! $diagnostics_on ) {
			return Check::pass(
				'acf_no_schema_skips',
				'No ACF schema skips',
				'Tracking off — no data to report.'
			);
		}

		$groups = (array) ( $acf['skipped_groups'] ?? [] );
		$fields = (array) ( $acf['dropped_fields'] ?? [] );
		$total  = count( $groups ) + count( $fields );

		if ( 0 === $total ) {
			return Check::pass(
				'acf_no_schema_skips',
				'No ACF schema skips',
				'Tracking on — ledger empty.'
			);
		}

		return Check::warn(
			'acf_no_schema_skips',
			'No ACF schema skips',
			sprintf( '%d ACF group(s) or field(s) were skipped during schema generation.', $total ),
			[
				'skipped_groups' => $groups,
				'dropped_fields' => $fields,
			]
		);
	}

	private static function acf_detail_note( array $acf ): ?string {
		if ( true === ( $acf['diagnostics_enabled'] ?? false ) ) {
			return null;
		}
		return 'Diagnostics ledger is empty because WP_DEBUG is off and the jab/headless_kit/acf_diagnostics filter is not set to true. Run `wp jab doctor --debug-acf` or set WP_DEBUG=true to populate.';
	}

	/**
	 * @param Check[] $checks
	 * @return array{ pass: int, warn: int, fail: int }
	 */
	private static function summarize( array $checks ): array {
		$counts = [ Check::PASS => 0, Check::WARN => 0, Check::FAIL => 0 ];
		foreach ( $checks as $check ) {
			$severity = $check->severity();
			if ( isset( $counts[ $severity ] ) ) {
				++$counts[ $severity ];
			}
		}
		return [
			'pass' => $counts[ Check::PASS ],
			'warn' => $counts[ Check::WARN ],
			'fail' => $counts[ Check::FAIL ],
		];
	}
}
