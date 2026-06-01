<?php
/**
 * SiteManifestTest — covers /wp-json/jab/v1/site.
 *
 * Why every section has its own test rather than one giant snapshot:
 * the field names in this response are part of the public SaaS contract,
 * and a snapshot would let me silently rename a field as long as the
 * snapshot was updated. Per-section assertions catch that case loudly.
 *
 * @package Jab\WpHeadlessKit\Tests
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Rest;

use Jab\WpHeadlessKit\Rest\SiteManifest;
use PHPUnit\Framework\TestCase;

final class SiteManifestTest extends TestCase {

	protected function setUp(): void {
		\jab_wphk_reset_stubs();
	}

	private function respond(): array {
		$response = SiteManifest::respond( new \WP_REST_Request() );
		return (array) $response->get_data();
	}

	// ------------------------------------------------------------------
	// Route registration + auth
	// ------------------------------------------------------------------

	public function test_register_adds_the_site_route(): void {
		SiteManifest::register();

		$routes = $GLOBALS['_jab_test_rest_routes'];
		$this->assertCount( 1, $routes );
		$this->assertSame( 'jab/v1', $routes[0]['namespace'] );
		$this->assertSame( '/site', $routes[0]['route'] );
		$this->assertSame( 'GET', $routes[0]['args']['methods'] );
	}

	public function test_default_capability_is_edit_posts(): void {
		// Stricter than /manifest's `read` default. Site structure includes
		// theme + static front page references — one step above schema-only.
		$this->assertSame( 'edit_posts', SiteManifest::capability() );
	}

	public function test_filter_can_override_capability(): void {
		$GLOBALS['_jab_test_filters']['jab/headless_kit/site_manifest_capability'] =
			static fn( $cap ) => 'manage_options';

		$this->assertSame( 'manage_options', SiteManifest::capability() );
	}

	public function test_filter_returning_empty_locks_endpoint_with_do_not_allow(): void {
		// SEC parity with Permissions::ability_capability — a typo in a
		// mu-plugin filter must not silently fall back to a permissive cap.
		$GLOBALS['_jab_test_filters']['jab/headless_kit/site_manifest_capability'] =
			static fn( $cap ) => '';

		$this->assertSame( 'do_not_allow', SiteManifest::capability() );
		$this->assertNotEmpty( $GLOBALS['_jab_test_doing_it_wrong'] );
	}

	public function test_filter_returning_non_string_locks_endpoint(): void {
		$GLOBALS['_jab_test_filters']['jab/headless_kit/site_manifest_capability'] =
			static fn( $cap ) => null;

		$this->assertSame( 'do_not_allow', SiteManifest::capability() );
	}

	public function test_authorize_uses_resolved_capability(): void {
		$GLOBALS['_jab_test_user_caps']['edit_posts'] = true;
		$this->assertTrue( SiteManifest::authorize() );

		$GLOBALS['_jab_test_user_caps']['edit_posts'] = false;
		$this->assertFalse( SiteManifest::authorize() );
	}

	// ------------------------------------------------------------------
	// Envelope
	// ------------------------------------------------------------------

	public function test_response_envelope_carries_expected_top_level_keys(): void {
		$payload = $this->respond();

		foreach ( [ 'plugin_version', 'generated_at', 'site', 'front_page', 'branding', 'menus', 'image_sizes', 'theme' ] as $key ) {
			$this->assertArrayHasKey( $key, $payload, "Missing top-level key: {$key}" );
		}
		$this->assertMatchesRegularExpression( '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/', (string) $payload['generated_at'] );
	}

	// ------------------------------------------------------------------
	// site section
	// ------------------------------------------------------------------

	public function test_site_section_carries_identity_urls_locale_and_permalinks(): void {
		$GLOBALS['_jab_test_bloginfo'] = [
			'name'        => 'Two Roads &amp; Co.',
			'description' => 'Brewery &amp; Taproom',
			'home_url'    => 'https://example.test',
			'site_url'    => 'https://example.test/wp',
			'timezone'    => 'America/New_York',
			'locale'      => 'en_US',
		];
		$GLOBALS['_jab_test_options']['permalink_structure'] = '/%postname%/';

		$site = $this->respond()['site'];

		// HTML entities are decoded so generated frontend doesn't double-encode.
		$this->assertSame( 'Two Roads & Co.', $site['title'] );
		$this->assertSame( 'Brewery & Taproom', $site['tagline'] );
		$this->assertSame( 'https://example.test', $site['home_url'] );
		$this->assertSame( 'https://example.test/wp', $site['site_url'] );
		$this->assertSame( 'America/New_York', $site['timezone'] );
		$this->assertSame( 'en_US', $site['locale'] );
		$this->assertSame( '/%postname%/', $site['permalink_structure'] );
	}

	// ------------------------------------------------------------------
	// front_page section
	// ------------------------------------------------------------------

	public function test_front_page_defaults_to_posts_mode_with_null_refs(): void {
		$front = $this->respond()['front_page'];

		$this->assertSame( 'posts', $front['show_on_front'] );
		$this->assertNull( $front['static_front']['id'] );
		$this->assertNull( $front['posts_page']['id'] );
	}

	public function test_front_page_resolves_static_front_and_posts_page(): void {
		$GLOBALS['_jab_test_options'] = [
			'show_on_front'  => 'page',
			'page_on_front'  => 12,
			'page_for_posts' => 14,
		];
		$front_post                       = new \WP_Post();
		$front_post->ID                   = 12;
		$front_post->post_name            = 'home';
		$front_post->post_title           = 'Home';
		$blog_post                        = new \WP_Post();
		$blog_post->ID                    = 14;
		$blog_post->post_name             = 'blog';
		$blog_post->post_title            = 'Blog';
		$GLOBALS['_jab_test_posts'][ 12 ] = $front_post;
		$GLOBALS['_jab_test_posts'][ 14 ] = $blog_post;

		$front = $this->respond()['front_page'];

		$this->assertSame( 'page', $front['show_on_front'] );
		$this->assertSame( 12, $front['static_front']['id'] );
		$this->assertSame( 'home', $front['static_front']['slug'] );
		$this->assertSame( 'Home', $front['static_front']['title'] );
		$this->assertSame( 14, $front['posts_page']['id'] );
		$this->assertSame( 'blog', $front['posts_page']['slug'] );
	}

	public function test_front_page_handles_missing_page_post_gracefully(): void {
		// Edge: option points to a page ID that no longer resolves (deleted).
		// Don't 500 — emit the ID we have and null the rest.
		$GLOBALS['_jab_test_options'] = [
			'show_on_front' => 'page',
			'page_on_front' => 999,
		];

		$front = $this->respond()['front_page'];

		$this->assertSame( 999, $front['static_front']['id'] );
		$this->assertNull( $front['static_front']['slug'] );
		$this->assertNull( $front['static_front']['title'] );
	}

	// ------------------------------------------------------------------
	// branding section
	// ------------------------------------------------------------------

	public function test_branding_emits_nulls_when_unconfigured(): void {
		$branding = $this->respond()['branding'];

		$this->assertNull( $branding['site_icon_url'] );
		$this->assertNull( $branding['custom_logo_id'] );
		$this->assertNull( $branding['custom_logo_url'] );
	}

	public function test_branding_resolves_site_icon_and_custom_logo(): void {
		$GLOBALS['_jab_test_site_icon_url']             = 'https://example.test/icon.png';
		$GLOBALS['_jab_test_theme_mods']['custom_logo'] = 42;
		$GLOBALS['_jab_test_attachment_urls'][ 42 ]     = [ 'full' => 'https://example.test/logo.png' ];

		$branding = $this->respond()['branding'];

		$this->assertSame( 'https://example.test/icon.png', $branding['site_icon_url'] );
		$this->assertSame( 42, $branding['custom_logo_id'] );
		$this->assertSame( 'https://example.test/logo.png', $branding['custom_logo_url'] );
	}

	// ------------------------------------------------------------------
	// menus section
	// ------------------------------------------------------------------

	public function test_menus_lists_registered_locations(): void {
		$GLOBALS['_jab_test_nav_menus'] = [
			'primary' => 'Primary Menu',
			'footer'  => 'Footer Menu &amp; Social',
		];

		$menus = $this->respond()['menus'];

		$this->assertCount( 2, $menus );
		$slugs = array_column( $menus, 'slug' );
		$this->assertContains( 'primary', $slugs );
		$this->assertContains( 'footer', $slugs );
		// Labels are HTML-entity-decoded.
		$labels = array_column( $menus, 'label' );
		$this->assertContains( 'Footer Menu & Social', $labels );
	}

	// ------------------------------------------------------------------
	// image_sizes section
	// ------------------------------------------------------------------

	public function test_image_sizes_includes_builtin_and_additional_sizes(): void {
		$GLOBALS['_jab_test_options'] = [
			'thumbnail_size_w'    => 150,
			'thumbnail_size_h'    => 150,
			'thumbnail_crop'      => true,
			'medium_size_w'       => 300,
			'medium_size_h'       => 300,
			'medium_large_size_w' => 768,
			'medium_large_size_h' => 0,
			'large_size_w'        => 1024,
			'large_size_h'        => 1024,
		];
		$GLOBALS['_jab_test_additional_image_sizes'] = [
			'hero' => [ 'width' => 1600, 'height' => 900, 'crop' => true ],
		];

		$sizes = $this->respond()['image_sizes'];
		$names = array_column( $sizes, 'name' );

		foreach ( [ 'thumbnail', 'medium', 'medium_large', 'large', 'hero' ] as $expected ) {
			$this->assertContains( $expected, $names, "Missing size: {$expected}" );
		}

		// Spot-check the hero size carries the full triple.
		foreach ( $sizes as $size ) {
			if ( 'hero' === $size['name'] ) {
				$this->assertSame( 1600, $size['width'] );
				$this->assertSame( 900, $size['height'] );
				$this->assertTrue( $size['crop'] );
			}
		}
	}

	// ------------------------------------------------------------------
	// theme section
	// ------------------------------------------------------------------

	public function test_theme_returns_nulls_when_wp_get_theme_unavailable(): void {
		// Default stub returns an empty theme. The fields should be present
		// (the SaaS expects stable keys) but with empty-string values.
		$theme = $this->respond()['theme'];

		$this->assertArrayHasKey( 'slug', $theme );
		$this->assertArrayHasKey( 'name', $theme );
		$this->assertArrayHasKey( 'version', $theme );
	}

	public function test_theme_returns_active_theme_metadata(): void {
		$GLOBALS['_jab_test_theme'] = new class() {
			public function get_stylesheet(): string {
				return 'understrap-child';
			}
			public function get( $header ): string {
				switch ( $header ) {
					case 'Name':
						return 'Understrap Child';
					case 'Version':
						return '1.4.2';
					default:
						return '';
				}
			}
		};

		$theme = $this->respond()['theme'];

		$this->assertSame( 'understrap-child', $theme['slug'] );
		$this->assertSame( 'Understrap Child', $theme['name'] );
		$this->assertSame( '1.4.2', $theme['version'] );
	}
}
