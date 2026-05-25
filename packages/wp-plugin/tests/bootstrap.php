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
	$GLOBALS['_jab_test_user_caps']               = [];
	$GLOBALS['_jab_test_post_types']              = [];
	$GLOBALS['_jab_test_doing_it_wrong']          = [];
	$GLOBALS['_jab_test_filters']                 = [];
	$GLOBALS['_jab_test_parse_blocks_map']        = [];
	$GLOBALS['_jab_test_posts']                   = [];
	$GLOBALS['_jab_test_setup_postdata_calls']    = [];
	$GLOBALS['_jab_test_wp_reset_postdata_calls'] = 0;
	$GLOBALS['_jab_test_acf_inactive']            = false;
	$GLOBALS['_jab_test_acf_field_groups']        = [];
	$GLOBALS['_jab_test_acf_fields_by_group']     = [];
	$GLOBALS['_jab_test_acf_post_fields']         = [];
	$GLOBALS['_jab_test_block_types']             = [];
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

// ---------------------------------------------------------------------
// Block-aware abilities (v0.5.0) — parse_blocks / post lookup / postdata.
//
// All use $GLOBALS slots so individual tests can shape behavior per-case
// without re-stubbing functions. Reset state is added to
// jab_wphk_reset_stubs() above so cross-test bleed is impossible.
// ---------------------------------------------------------------------

if ( ! function_exists( 'parse_blocks' ) ) {
	/**
	 * Stub. Tests populate `$GLOBALS['_jab_test_parse_blocks_map']` with
	 * `[ <input string> => <canned tree array> ]`. Unmapped inputs return
	 * the WP-default freeform wrapper, which is what real parse_blocks
	 * returns for non-block content.
	 *
	 * @param string $content
	 * @return array<int, array<string, mixed>>
	 */
	function parse_blocks( $content ) {
		$content = (string) $content;
		$map     = $GLOBALS['_jab_test_parse_blocks_map'] ?? [];
		if ( array_key_exists( $content, $map ) ) {
			return $map[ $content ];
		}
		if ( '' === $content ) {
			return [];
		}
		return [
			[
				'blockName'    => null,
				'attrs'        => [],
				'innerBlocks'  => [],
				'innerHTML'    => $content,
				'innerContent' => [ $content ],
			],
		];
	}
}

if ( ! function_exists( 'get_post' ) ) {
	/**
	 * Stub. Tests populate `$GLOBALS['_jab_test_posts']` with
	 * `[ <post_id> => WP_Post-shaped stdClass ]`. Returns null on miss,
	 * matching real WP behavior.
	 *
	 * @param int $post_id
	 * @return \WP_Post|null
	 */
	function get_post( $post_id ) {
		$posts = $GLOBALS['_jab_test_posts'] ?? [];
		return $posts[ (int) $post_id ] ?? null;
	}
}

if ( ! function_exists( 'setup_postdata' ) ) {
	/**
	 * Stub. Records calls so tests can verify the wrap was applied around
	 * render filtering, but has no other behavior.
	 *
	 * @param mixed $post
	 */
	function setup_postdata( $post ): bool {
		$GLOBALS['_jab_test_setup_postdata_calls'][] = $post;
		return true;
	}
}

if ( ! function_exists( 'wp_reset_postdata' ) ) {
	/**
	 * Stub. Records calls so tests can verify the wrap was closed.
	 */
	function wp_reset_postdata(): void {
		$GLOBALS['_jab_test_wp_reset_postdata_calls'] = ( $GLOBALS['_jab_test_wp_reset_postdata_calls'] ?? 0 ) + 1;
	}
}

// ---------------------------------------------------------------------
// Post-shape helpers shape_row() depends on. The pre-v0.5.0 tests never
// exercised shape_row() directly (only resolve_date/value_matches_format
// via reflection), so these never needed stubbing before.
// ---------------------------------------------------------------------

if ( ! function_exists( 'get_the_title' ) ) {
	/**
	 * Stub. Real WP runs the_title filters and decodes; the test post just
	 * needs its `post_title` reflected back so assertions can check it.
	 *
	 * @param mixed $post
	 */
	function get_the_title( $post ): string {
		if ( is_object( $post ) && isset( $post->post_title ) ) {
			return (string) $post->post_title;
		}
		return '';
	}
}

if ( ! function_exists( 'get_the_excerpt' ) ) {
	/**
	 * Stub. Returns the post's `post_excerpt` field as-is. Real WP
	 * synthesizes an excerpt from post_content when empty; tests don't
	 * exercise that path.
	 *
	 * @param mixed $post
	 */
	function get_the_excerpt( $post ): string {
		if ( is_object( $post ) && isset( $post->post_excerpt ) ) {
			return (string) $post->post_excerpt;
		}
		return '';
	}
}

if ( ! function_exists( 'wp_strip_all_tags' ) ) {
	/**
	 * Stub. PHP's strip_tags is close enough for tests; the real WP helper
	 * also collapses whitespace but that's not asserted.
	 *
	 * @param mixed $value
	 */
	function wp_strip_all_tags( $value ): string {
		return strip_tags( (string) $value );
	}
}

if ( ! function_exists( 'get_permalink' ) ) {
	/**
	 * Stub. Returns a synthetic permalink based on post ID so tests can
	 * assert presence without booting WP's rewrite system.
	 *
	 * @param mixed $post
	 */
	function get_permalink( $post ): string {
		$id = is_object( $post ) && isset( $post->ID ) ? (int) $post->ID : 0;
		return 'https://example.test/?p=' . $id;
	}
}

// ---------------------------------------------------------------------
// ACF field-group stubs (v0.6.0). Tests populate
// $GLOBALS['_jab_test_acf_field_groups'] and
// $GLOBALS['_jab_test_acf_fields_by_group'] to shape the field-group
// universe per case. $GLOBALS['_jab_test_acf_inactive'] = true skips
// ACF detection.
// ---------------------------------------------------------------------

if ( ! function_exists( 'acf_get_field_groups' ) ) {
	/**
	 * @return array<int, array<string, mixed>>|false
	 */
	function acf_get_field_groups() {
		if ( ! empty( $GLOBALS['_jab_test_acf_inactive'] ) ) {
			return false;
		}
		return $GLOBALS['_jab_test_acf_field_groups'] ?? [];
	}
}

if ( ! function_exists( 'acf_get_fields' ) ) {
	/**
	 * @param mixed $group_key  Either a group array (with `key`) or a string key.
	 * @return array<int, array<string, mixed>>|false
	 */
	function acf_get_fields( $group_key ) {
		if ( ! empty( $GLOBALS['_jab_test_acf_inactive'] ) ) {
			return false;
		}
		$key = is_array( $group_key ) ? (string) ( $group_key['key'] ?? '' ) : (string) $group_key;
		$map = $GLOBALS['_jab_test_acf_fields_by_group'] ?? [];
		return $map[ $key ] ?? [];
	}
}

if ( ! function_exists( 'get_fields' ) ) {
	/**
	 * Stub of ACF's getter. Tests populate
	 * $GLOBALS['_jab_test_acf_post_fields'][ post_id ] with the field map.
	 *
	 * @param int $post_id
	 * @return array<string, mixed>|false
	 */
	function get_fields( $post_id ) {
		if ( ! empty( $GLOBALS['_jab_test_acf_inactive'] ) ) {
			return false;
		}
		$map = $GLOBALS['_jab_test_acf_post_fields'] ?? [];
		return $map[ (int) $post_id ] ?? [];
	}
}

// ---------------------------------------------------------------------
// WP_Block_Type_Registry stub (v0.6.0). Tests populate
// $GLOBALS['_jab_test_block_types'] as
// `[ <name> => <WP_Block_Type-shaped stdClass with name+attributes> ]`
// and the stub returns the contents from get_all_registered().
// ---------------------------------------------------------------------

if ( ! class_exists( 'WP_Block_Type_Registry' ) ) {
	final class WP_Block_Type_Registry {
		private static $instance = null;

		public static function get_instance(): self {
			if ( null === self::$instance ) {
				self::$instance = new self();
			}
			return self::$instance;
		}

		/**
		 * @return array<string, object>
		 */
		public function get_all_registered(): array {
			$map = $GLOBALS['_jab_test_block_types'] ?? [];
			return is_array( $map ) ? $map : [];
		}
	}
}
