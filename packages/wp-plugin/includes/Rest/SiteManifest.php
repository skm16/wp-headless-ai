<?php
/**
 * SiteManifest — REST route at `/wp-json/jab/v1/site` exposing the WordPress
 * "site shape" the SaaS onboarding flow and CLI generator need to scaffold
 * a useful frontend without guessing.
 *
 * What's in here vs `/manifest`:
 *
 *   - `/manifest` answers "what abilities does this install expose?". It's
 *     the ability roster + schemas, consumed by `jab sync` to regenerate
 *     SDK types.
 *   - `/site` answers "what does this install look like?". Front page mode,
 *     custom logo, menu locations, image sizes, theme — the structural
 *     facts a generation pipeline needs before it can lay out a homepage.
 *
 * Auth: `edit_posts` by default. Schema discovery (`/manifest`) keeps the
 * `read` default; the site manifest reveals more structural detail (theme,
 * static front page slugs, etc.) so the default capability is one step
 * tighter. Override via the `jab/headless_kit/site_manifest_capability`
 * filter — a custom capability, a stricter built-in (`manage_options`),
 * or a falsy value to lock the endpoint down entirely. The fall-back
 * mirrors Permissions::ability_capability(): a non-string / empty return
 * resolves to WordPress's `do_not_allow` so a typo in a mu-plugin is
 * loud, not silently permissive.
 *
 * Stability promise: every field name in the response is part of the
 * public contract. Adding new fields is safe; renaming or removing
 * existing fields is a breaking change for SaaS callers.
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Rest;

defined( 'ABSPATH' ) || exit;

final class SiteManifest {

	private const NAMESPACE = 'jab/v1';
	private const ROUTE     = '/site';

	public const DEFAULT_CAPABILITY = 'edit_posts';

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
	 * Resolve the required capability for the site-manifest endpoint.
	 *
	 * Mirrors Permissions::ability_capability(): a filter returning a non-
	 * string or empty value resolves to `do_not_allow`, the WordPress core
	 * convention for "no role, not even admin, may pass." Falling back to
	 * `edit_posts` on a typo would be exactly the silent-permissive failure
	 * mode the Phase 0 audit calls out.
	 */
	public static function capability(): string {
		/**
		 * Filter the capability required to read the site manifest.
		 *
		 * @param string $capability Default capability slug.
		 */
		$capability = apply_filters(
			'jab/headless_kit/site_manifest_capability',
			self::DEFAULT_CAPABILITY
		);

		if ( ! is_string( $capability ) || '' === $capability ) {
			if ( function_exists( '_doing_it_wrong' ) ) {
				_doing_it_wrong(
					'Jab\\WpHeadlessKit\\Rest\\SiteManifest::capability',
					esc_html__( 'jab/headless_kit/site_manifest_capability filter returned a non-string / empty value; denying access. Return a valid capability slug (e.g. "edit_posts", "manage_options") to permit access.', 'wp-headless-kit' ),
					'0.7.0'
				);
			}
			return 'do_not_allow';
		}

		return $capability;
	}

	public static function authorize(): bool {
		return current_user_can( self::capability() );
	}

	public static function respond( \WP_REST_Request $request ): \WP_REST_Response {
		unset( $request );

		return new \WP_REST_Response(
			[
				'plugin_version' => defined( 'Jab\\WpHeadlessKit\\VERSION' ) ? \Jab\WpHeadlessKit\VERSION : null,
				'generated_at'   => gmdate( 'Y-m-d\TH:i:s\Z' ),
				'site'           => self::site_section(),
				'front_page'     => self::front_page_section(),
				'branding'       => self::branding_section(),
				'menus'          => self::menus_section(),
				'image_sizes'    => self::image_sizes_section(),
				'theme'          => self::theme_section(),
			],
			200
		);
	}

	/**
	 * Identity, URLs, timezone, locale, permalink structure.
	 *
	 * @return array<string, mixed>
	 */
	private static function site_section(): array {
		return [
			'title'               => function_exists( 'get_bloginfo' ) ? html_entity_decode( (string) get_bloginfo( 'name' ), ENT_QUOTES | ENT_HTML5, 'UTF-8' ) : '',
			'tagline'             => function_exists( 'get_bloginfo' ) ? html_entity_decode( (string) get_bloginfo( 'description' ), ENT_QUOTES | ENT_HTML5, 'UTF-8' ) : '',
			'home_url'            => function_exists( 'home_url' ) ? (string) home_url() : '',
			'site_url'            => function_exists( 'site_url' ) ? (string) site_url() : '',
			'timezone'            => function_exists( 'wp_timezone_string' ) ? (string) wp_timezone_string() : '',
			'locale'              => function_exists( 'get_locale' ) ? (string) get_locale() : '',
			'permalink_structure' => function_exists( 'get_option' ) ? (string) get_option( 'permalink_structure', '' ) : '',
		];
	}

	/**
	 * Static vs. blog-style front page + the resolved IDs/slugs.
	 *
	 * SaaS use-case: the generator needs to know which page (if any) WP
	 * treats as the homepage so it can scaffold the right Next.js route.
	 * Without this section, the generator has to crawl /, parse the
	 * response, and guess — fragile.
	 *
	 * @return array<string, mixed>
	 */
	private static function front_page_section(): array {
		$show_on_front = function_exists( 'get_option' ) ? (string) get_option( 'show_on_front', 'posts' ) : 'posts';
		$front_page_id = function_exists( 'get_option' ) ? (int) get_option( 'page_on_front', 0 ) : 0;
		$blog_page_id  = function_exists( 'get_option' ) ? (int) get_option( 'page_for_posts', 0 ) : 0;

		return [
			// 'posts' (latest posts) vs 'page' (static page). Mirrors WP's
			// own option value — easier than synthesizing a new vocab.
			'show_on_front' => 'page' === $show_on_front ? 'page' : 'posts',
			'static_front'  => self::page_ref( $front_page_id ),
			'posts_page'    => self::page_ref( $blog_page_id ),
		];
	}

	/**
	 * Resolve an option-stored page ID to { id, slug, title } or nulls.
	 *
	 * @return array<string, mixed>
	 */
	private static function page_ref( int $page_id ): array {
		if ( $page_id <= 0 ) {
			return [ 'id' => null, 'slug' => null, 'title' => null ];
		}
		$post = function_exists( 'get_post' ) ? get_post( $page_id ) : null;
		if ( ! is_object( $post ) ) {
			return [ 'id' => $page_id, 'slug' => null, 'title' => null ];
		}
		return [
			'id'    => (int) ( $post->ID ?? $page_id ),
			'slug'  => isset( $post->post_name ) ? (string) $post->post_name : null,
			'title' => isset( $post->post_title ) ? (string) $post->post_title : null,
		];
	}

	/**
	 * Site icon + custom logo. Both are surfaces the generator's header
	 * scaffold wants to populate without screen-scraping the live site.
	 *
	 * @return array<string, mixed>
	 */
	private static function branding_section(): array {
		$icon_url = function_exists( 'get_site_icon_url' ) ? (string) get_site_icon_url() : '';

		$logo_attachment_id = 0;
		$logo_url           = '';
		if ( function_exists( 'get_theme_mod' ) ) {
			$mod = get_theme_mod( 'custom_logo' );
			if ( is_numeric( $mod ) && (int) $mod > 0 ) {
				$logo_attachment_id = (int) $mod;
				if ( function_exists( 'wp_get_attachment_image_url' ) ) {
					$candidate = wp_get_attachment_image_url( $logo_attachment_id, 'full' );
					if ( is_string( $candidate ) ) {
						$logo_url = $candidate;
					}
				}
			}
		}

		return [
			'site_icon_url'   => '' !== $icon_url ? $icon_url : null,
			'custom_logo_id'  => $logo_attachment_id > 0 ? $logo_attachment_id : null,
			'custom_logo_url' => '' !== $logo_url ? $logo_url : null,
		];
	}

	/**
	 * Registered nav menu LOCATIONS (not the menus assigned to them — that
	 * is what `jab/get-menus` does). Locations are the slots the theme
	 * declares; SaaS uses them to know which slots a Next.js header should
	 * expose.
	 *
	 * @return array<int, array<string, string>>
	 */
	private static function menus_section(): array {
		if ( ! function_exists( 'get_registered_nav_menus' ) ) {
			return [];
		}
		$locations = get_registered_nav_menus();
		if ( ! is_array( $locations ) ) {
			return [];
		}
		$out = [];
		foreach ( $locations as $slug => $label ) {
			$out[] = [
				'slug'  => (string) $slug,
				'label' => html_entity_decode( (string) $label, ENT_QUOTES | ENT_HTML5, 'UTF-8' ),
			];
		}
		return $out;
	}

	/**
	 * Registered image sizes (built-in + theme- or plugin-registered).
	 *
	 * Returns the width / height / crop triple WP stores internally so the
	 * generator can pick the correct preset when rendering an Image block.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private static function image_sizes_section(): array {
		$builtin_widths = [];
		if ( function_exists( 'get_option' ) ) {
			$builtin_widths['thumbnail']    = [
				'width'  => (int) get_option( 'thumbnail_size_w', 0 ),
				'height' => (int) get_option( 'thumbnail_size_h', 0 ),
				'crop'   => (bool) get_option( 'thumbnail_crop', false ),
			];
			$builtin_widths['medium']       = [
				'width'  => (int) get_option( 'medium_size_w', 0 ),
				'height' => (int) get_option( 'medium_size_h', 0 ),
				'crop'   => false,
			];
			$builtin_widths['medium_large'] = [
				'width'  => (int) get_option( 'medium_large_size_w', 0 ),
				'height' => (int) get_option( 'medium_large_size_h', 0 ),
				'crop'   => false,
			];
			$builtin_widths['large']        = [
				'width'  => (int) get_option( 'large_size_w', 0 ),
				'height' => (int) get_option( 'large_size_h', 0 ),
				'crop'   => false,
			];
		}

		$additional = function_exists( 'wp_get_additional_image_sizes' ) ? wp_get_additional_image_sizes() : [];
		if ( ! is_array( $additional ) ) {
			$additional = [];
		}

		$out = [];
		foreach ( $builtin_widths as $name => $size ) {
			$out[] = [
				'name'   => (string) $name,
				'width'  => (int) $size['width'],
				'height' => (int) $size['height'],
				'crop'   => (bool) $size['crop'],
			];
		}
		foreach ( $additional as $name => $size ) {
			$out[] = [
				'name'   => (string) $name,
				'width'  => isset( $size['width'] ) ? (int) $size['width'] : 0,
				'height' => isset( $size['height'] ) ? (int) $size['height'] : 0,
				'crop'   => isset( $size['crop'] ) ? (bool) $size['crop'] : false,
			];
		}
		return $out;
	}

	/**
	 * Active theme slug + name + version.
	 *
	 * Why this matters: the SaaS pipeline's Phase A discovery walker has
	 * different heuristics for block themes vs. classic themes. Exposing
	 * the theme identity lets the wizard skip detection round-trips.
	 *
	 * @return array<string, mixed>
	 */
	private static function theme_section(): array {
		if ( ! function_exists( 'wp_get_theme' ) ) {
			return [
				'slug'    => null,
				'name'    => null,
				'version' => null,
			];
		}
		$theme = wp_get_theme();
		// WP_Theme exposes the stylesheet slug via get_stylesheet(); name and
		// version via the same `get( $header )` accessor every theme has.
		// Guard with method_exists so a swap-in test double doesn't NPE here.
		return [
			'slug'    => method_exists( $theme, 'get_stylesheet' ) ? (string) $theme->get_stylesheet() : null,
			'name'    => method_exists( $theme, 'get' ) ? (string) $theme->get( 'Name' ) : null,
			'version' => method_exists( $theme, 'get' ) ? (string) $theme->get( 'Version' ) : null,
		];
	}
}
