<?php
/**
 * Pure-unit test bootstrap.
 *
 * Stubs a minimal subset of WordPress functions so the plugin's pure-logic
 * helpers (capability gating, name dedupe, format validation, date
 * resolution) can be tested without booting WP. Each stub is configurable
 * via globals so test cases can shape behavior per-test.
 *
 * This is intentionally NOT a full WP polyfill — it covers exactly what the
 * tests under tests/unit/ need. Extending the stub set is a deliberate act;
 * if a test needs a new WP function, add it here so the cost stays visible.
 *
 * @package Jab\WpHeadlessKit\Tests
 */

declare( strict_types=1 );

defined( 'ABSPATH' ) || define( 'ABSPATH', dirname( __DIR__ ) . '/' );
defined( 'HOUR_IN_SECONDS' ) || define( 'HOUR_IN_SECONDS', 3600 );

require_once dirname( __DIR__ ) . '/vendor/autoload.php';

if ( ! class_exists( 'WP_Post' ) ) {
	/**
	 * Stub. Real WP_Post is a value object with public properties; tests just
	 * need something that satisfies the type hint and lets them set the same
	 * property names. Extending stdClass keeps property access permissive.
	 */
	class WP_Post extends \stdClass {}
}

if ( ! class_exists( 'WP_Taxonomy' ) ) {
	class WP_Taxonomy extends \stdClass {}
}

if ( ! class_exists( 'WP_Term' ) ) {
	class WP_Term extends \stdClass {}
}

/**
 * Reset the stub state at the start of every test. Tests should call this in
 * setUp() so cross-test bleed doesn't masquerade as a real signal.
 */
function jab_wphk_reset_stubs(): void {
	$GLOBALS['_jab_test_user_caps']     = [];
	$GLOBALS['_jab_test_post_types']    = [];
	$GLOBALS['_jab_test_doing_it_wrong'] = [];
	$GLOBALS['_jab_test_filters']       = [];
}
jab_wphk_reset_stubs();

if ( ! function_exists( 'current_user_can' ) ) {
	/**
	 * Stub. Test cases populate `$GLOBALS['_jab_test_user_caps']` with a map
	 * of capability => bool.
	 *
	 * @param string $capability
	 */
	function current_user_can( $capability ): bool {
		return (bool) ( $GLOBALS['_jab_test_user_caps'][ $capability ] ?? false );
	}
}

if ( ! function_exists( 'get_post_type_object' ) ) {
	/**
	 * Stub. Test cases populate `$GLOBALS['_jab_test_post_types']` with
	 * `[ <post_type> => (object) [ 'cap' => (object) [ 'edit_posts' => 'edit_x' ] ] ]`.
	 *
	 * @param string $post_type
	 * @return object|null
	 */
	function get_post_type_object( $post_type ) {
		return $GLOBALS['_jab_test_post_types'][ $post_type ] ?? null;
	}
}

if ( ! function_exists( 'apply_filters' ) ) {
	/**
	 * Stub. Test cases populate `$GLOBALS['_jab_test_filters']` with a map of
	 * filter name => callable(value, ...args). Unregistered filters pass the
	 * value through unchanged — matching WP behavior.
	 *
	 * @param string $hook
	 * @param mixed  $value
	 */
	function apply_filters( $hook, $value ) {
		$args = func_get_args();
		array_shift( $args ); // drop hook
		$callback = $GLOBALS['_jab_test_filters'][ $hook ] ?? null;
		if ( null === $callback ) {
			return $value;
		}
		return $callback( ...$args );
	}
}

if ( ! function_exists( '_doing_it_wrong' ) ) {
	/**
	 * Stub. Records calls in `$GLOBALS['_jab_test_doing_it_wrong']` so tests
	 * can assert that misuse is surfaced.
	 *
	 * @param string $function_name
	 * @param string $message
	 * @param string $version
	 */
	function _doing_it_wrong( $function_name, $message, $version ): void {
		$GLOBALS['_jab_test_doing_it_wrong'][] = [
			'function' => $function_name,
			'message'  => $message,
			'version'  => $version,
		];
	}
}

if ( ! function_exists( 'esc_html' ) ) {
	/**
	 * Stub. Trivial passthrough; tests don't care about HTML escaping.
	 *
	 * @param string $text
	 */
	function esc_html( $text ): string {
		return (string) $text;
	}
}

if ( ! function_exists( '__' ) ) {
	/**
	 * Stub. Identity passthrough — i18n is irrelevant under test.
	 *
	 * @param string $text
	 * @param string $domain
	 */
	function __( $text, $domain = '' ): string {
		return (string) $text;
	}
}

if ( ! function_exists( 'mysql_to_rfc3339' ) ) {
	/**
	 * Stub of WP's own helper. The real implementation lives in
	 * wp-includes/functions.php and converts MySQL DATETIME → RFC 3339.
	 * Returns the input on parse failure; we mirror that.
	 *
	 * @param string $date_string
	 */
	function mysql_to_rfc3339( $date_string ): string {
		$date_string = (string) $date_string;
		if ( '' === $date_string ) {
			return '';
		}
		$ts = strtotime( $date_string );
		if ( false === $ts ) {
			return $date_string;
		}
		return gmdate( 'Y-m-d\TH:i:s', $ts );
	}
}
