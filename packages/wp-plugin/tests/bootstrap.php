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

if ( ! class_exists( 'WP_Post_Type' ) ) {
	/**
	 * Stub. Mirrors WP_Post for the same reason — tests just need a type that
	 * passes the type hint on Registry::derive_config_from_post_type() and
	 * lets the test set arbitrary properties (name, rest_base, labels) the
	 * derivation reads.
	 */
	class WP_Post_Type extends \stdClass {}
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
	$GLOBALS['_jab_test_rest_routes']             = [];
	$GLOBALS['_jab_test_current_user_id']         = 0;
	$GLOBALS['_jab_test_abilities']               = [];
	$GLOBALS['_jab_test_options']                 = [];
	$GLOBALS['_jab_test_theme_mods']              = [];
	$GLOBALS['_jab_test_bloginfo']                = [];
	$GLOBALS['_jab_test_site_icon_url']           = '';
	$GLOBALS['_jab_test_attachment_urls']         = [];
	$GLOBALS['_jab_test_nav_menus']               = [];
	$GLOBALS['_jab_test_additional_image_sizes']  = [];
	$GLOBALS['_jab_test_theme']                   = null;
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

if ( ! function_exists( 'get_post_types' ) ) {
	/**
	 * Stub. Test cases populate `$GLOBALS['_jab_test_post_types']` with
	 * `[ <post_type> => (object) [ 'name' => '...' ] ]`.
	 *
	 * @param array<string, mixed> $args
	 * @param string $output 'names'|'objects'
	 * @return string[]|object[]
	 */
	function get_post_types( $args = [], $output = 'names' ) {
		$map = $GLOBALS['_jab_test_post_types'] ?? [];
		if ( 'objects' === $output ) {
			return array_values( $map );
		}
		return array_keys( $map );
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

// ---------------------------------------------------------------------
// REST infrastructure stubs (v0.6.0)
// ---------------------------------------------------------------------

if ( ! class_exists( 'WP_REST_Server' ) ) {
	final class WP_REST_Server {
		const READABLE = 'GET';
	}
}

if ( ! class_exists( 'WP_REST_Request' ) ) {
	class WP_REST_Request {}
}

if ( ! class_exists( 'WP_REST_Response' ) ) {
	class WP_REST_Response {
		public $data;
		public $status;
		public function __construct( $data = null, $status = 200 ) {
			$this->data   = $data;
			$this->status = $status;
		}
		public function get_data() {
			return $this->data;
		}
		public function get_status(): int {
			return (int) $this->status;
		}
	}
}

if ( ! function_exists( 'register_rest_route' ) ) {
	/**
	 * Stub. Tests inspect $GLOBALS['_jab_test_rest_routes'] to assert
	 * registration arguments.
	 *
	 * @param string $namespace
	 * @param string $route
	 * @param array<string, mixed> $args
	 */
	function register_rest_route( $namespace, $route, $args ): bool {
		$GLOBALS['_jab_test_rest_routes'][] = [
			'namespace' => (string) $namespace,
			'route'     => (string) $route,
			'args'      => $args,
		];
		return true;
	}
}

if ( ! function_exists( 'wp_get_abilities' ) ) {
	/**
	 * Stub of WP Abilities API discovery. Tests populate
	 * $GLOBALS['_jab_test_abilities'] = [ <name> => <Ability stdClass> ].
	 *
	 * @return array<int, object>
	 */
	function wp_get_abilities(): array {
		$map = $GLOBALS['_jab_test_abilities'] ?? [];
		return array_values( is_array( $map ) ? $map : [] );
	}
}

// ---------------------------------------------------------------------
// Site-shape stubs (v0.7.0). Used by SiteManifestTest. Each stub is a
// trivial getter on a $GLOBALS slot so tests can drive every field in
// the response envelope without booting WP.
// ---------------------------------------------------------------------

if ( ! function_exists( 'get_option' ) ) {
	/**
	 * @param string $key
	 * @param mixed  $default_value
	 * @return mixed
	 */
	function get_option( $key, $default_value = false ) {
		$map = $GLOBALS['_jab_test_options'] ?? [];
		return array_key_exists( (string) $key, $map ) ? $map[ (string) $key ] : $default_value;
	}
}

if ( ! function_exists( 'get_bloginfo' ) ) {
	/**
	 * @param string $key
	 */
	function get_bloginfo( $key = '' ): string {
		$map = $GLOBALS['_jab_test_bloginfo'] ?? [];
		return (string) ( $map[ (string) $key ] ?? '' );
	}
}

if ( ! function_exists( 'home_url' ) ) {
	function home_url(): string {
		return (string) ( $GLOBALS['_jab_test_bloginfo']['home_url'] ?? '' );
	}
}

if ( ! function_exists( 'site_url' ) ) {
	function site_url(): string {
		return (string) ( $GLOBALS['_jab_test_bloginfo']['site_url'] ?? '' );
	}
}

if ( ! function_exists( 'wp_timezone_string' ) ) {
	function wp_timezone_string(): string {
		return (string) ( $GLOBALS['_jab_test_bloginfo']['timezone'] ?? 'UTC' );
	}
}

if ( ! function_exists( 'get_locale' ) ) {
	function get_locale(): string {
		return (string) ( $GLOBALS['_jab_test_bloginfo']['locale'] ?? 'en_US' );
	}
}

if ( ! function_exists( 'get_site_icon_url' ) ) {
	function get_site_icon_url(): string {
		return (string) ( $GLOBALS['_jab_test_site_icon_url'] ?? '' );
	}
}

if ( ! function_exists( 'get_theme_mod' ) ) {
	/**
	 * @param string $key
	 * @return mixed
	 */
	function get_theme_mod( $key ) {
		$map = $GLOBALS['_jab_test_theme_mods'] ?? [];
		return $map[ (string) $key ] ?? false;
	}
}

if ( ! function_exists( 'wp_get_attachment_image_url' ) ) {
	/**
	 * @param int    $id
	 * @param string $size
	 * @return string|false
	 */
	function wp_get_attachment_image_url( $id, $size = 'thumbnail' ) {
		$map = $GLOBALS['_jab_test_attachment_urls'] ?? [];
		$row = $map[ (int) $id ] ?? null;
		if ( ! is_array( $row ) ) {
			return false;
		}
		return $row[ (string) $size ] ?? ( $row['full'] ?? false );
	}
}

if ( ! function_exists( 'get_registered_nav_menus' ) ) {
	/**
	 * @return array<string, string>
	 */
	function get_registered_nav_menus(): array {
		$map = $GLOBALS['_jab_test_nav_menus'] ?? [];
		return is_array( $map ) ? $map : [];
	}
}

if ( ! function_exists( 'wp_get_additional_image_sizes' ) ) {
	/**
	 * @return array<string, array<string, mixed>>
	 */
	function wp_get_additional_image_sizes(): array {
		$map = $GLOBALS['_jab_test_additional_image_sizes'] ?? [];
		return is_array( $map ) ? $map : [];
	}
}

if ( ! function_exists( 'wp_get_theme' ) ) {
	/**
	 * Returns whatever the test set in $GLOBALS['_jab_test_theme']. The real
	 * WP_Theme is too complex to stub; tests supply an anonymous class with
	 * the methods SiteManifest::theme_section() reads.
	 */
	function wp_get_theme() {
		$theme = $GLOBALS['_jab_test_theme'] ?? null;
		if ( null === $theme ) {
			// Synthesize a default theme stub so the production path doesn't
			// have to special-case "no theme" — there is always an active
			// theme in real WP.
			return new class() {
				public function get_stylesheet(): string {
					return '';
				}
				public function get( $header ) {
					unset( $header );
					return '';
				}
			};
		}
		return $theme;
	}
}

if ( ! function_exists( 'esc_html__' ) ) {
	/**
	 * @param string $text
	 * @param string $domain
	 */
	function esc_html__( $text, $domain = '' ): string {
		unset( $domain );
		return (string) $text;
	}
}
