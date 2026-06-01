<?php
/**
 * ManifestTest — covers the /wp-json/jab/v1/manifest endpoint.
 *
 * @package Jab\WpHeadlessKit\Tests
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Rest;

use Jab\WpHeadlessKit\Rest\Manifest;
use PHPUnit\Framework\TestCase;

final class ManifestTest extends TestCase {

	protected function setUp(): void {
		\jab_wphk_reset_stubs();
	}

	/**
	 * Real WP_Ability has PROTECTED properties and PUBLIC getters
	 * (get_name, get_label, get_description, get_category, get_input_schema,
	 * get_output_schema, get_meta). The production code MUST call the
	 * getters, not read properties directly. This anonymous-class stub
	 * mimics the same interface so the test fails fast if production
	 * regresses to property access.
	 */
	private function fake_ability( string $name, string $category, array $extras = [] ): object {
		return new class( $name, $category, $extras ) {
			private $name;
			private $category;
			private $extras;
			public function __construct( string $name, string $category, array $extras ) {
				$this->name     = $name;
				$this->category = $category;
				$this->extras   = $extras;
			}
			public function get_name(): string { return $this->name; }
			public function get_category(): string { return $this->category; }
			public function get_label(): string { return (string) ( $this->extras['label'] ?? '' ); }
			public function get_description(): string { return (string) ( $this->extras['description'] ?? '' ); }
			public function get_input_schema(): array { return (array) ( $this->extras['input_schema'] ?? [] ); }
			public function get_output_schema(): array { return (array) ( $this->extras['output_schema'] ?? [] ); }
			public function get_meta(): array { return (array) ( $this->extras['meta'] ?? [] ); }
		};
	}

	public function test_register_adds_the_manifest_route(): void {
		Manifest::register();
		$routes = $GLOBALS['_jab_test_rest_routes'];
		$this->assertCount( 1, $routes );
		$this->assertSame( 'jab/v1', $routes[0]['namespace'] );
		$this->assertSame( '/manifest', $routes[0]['route'] );
		$this->assertSame( 'GET', $routes[0]['args']['methods'] );
		$this->assertIsCallable( $routes[0]['args']['callback'] );
		$this->assertIsCallable( $routes[0]['args']['permission_callback'] );
	}

	public function test_authorize_rejects_unauthenticated_user(): void {
		$GLOBALS['_jab_test_user_caps']['read'] = false;
		$this->assertFalse( Manifest::authorize() );
	}

	public function test_authorize_accepts_user_with_read_capability(): void {
		$GLOBALS['_jab_test_user_caps']['read'] = true;
		$this->assertTrue( Manifest::authorize() );
	}

	// ------------------------------------------------------------------
	// v0.7.0 — capability is filterable via jab/headless_kit/manifest_capability
	// ------------------------------------------------------------------

	public function test_default_capability_is_read_preserving_pre_0_7_contract(): void {
		// The CLI's `jab sync` authenticates with a least-privilege service
		// user's Application Password. Bumping this default would break
		// existing installs — agencies that want it tighter use the filter.
		$this->assertSame( 'read', Manifest::capability() );
	}

	public function test_filter_can_tighten_capability(): void {
		$GLOBALS['_jab_test_filters']['jab/headless_kit/manifest_capability'] =
			static fn( $cap ) => 'edit_posts';

		$this->assertSame( 'edit_posts', Manifest::capability() );

		$GLOBALS['_jab_test_user_caps']['read']       = true;
		$GLOBALS['_jab_test_user_caps']['edit_posts'] = false;
		$this->assertFalse( Manifest::authorize() );

		$GLOBALS['_jab_test_user_caps']['edit_posts'] = true;
		$this->assertTrue( Manifest::authorize() );
	}

	public function test_filter_returning_empty_locks_endpoint_with_do_not_allow(): void {
		// Same SEC-1 contract as Permissions::ability_capability and
		// SiteManifest::capability: a typo in a mu-plugin filter must not
		// silently revert to the default cap.
		$GLOBALS['_jab_test_filters']['jab/headless_kit/manifest_capability'] =
			static fn( $cap ) => '';

		$this->assertSame( 'do_not_allow', Manifest::capability() );
		$this->assertNotEmpty( $GLOBALS['_jab_test_doing_it_wrong'] );
	}

	public function test_filter_returning_non_string_locks_endpoint(): void {
		$GLOBALS['_jab_test_filters']['jab/headless_kit/manifest_capability'] =
			static fn( $cap ) => null;

		$this->assertSame( 'do_not_allow', Manifest::capability() );
	}

	public function test_response_envelope_carries_plugin_version_and_timestamp(): void {
		$response = Manifest::respond( new \WP_REST_Request() );
		$payload  = $response->get_data();

		$this->assertArrayHasKey( 'plugin_version', $payload );
		$this->assertArrayHasKey( 'generated_at', $payload );
		$this->assertArrayHasKey( 'abilities', $payload );
		$this->assertIsArray( $payload['abilities'] );

		// RFC3339 timestamp with trailing Z — the CLI parser depends on this format.
		$this->assertMatchesRegularExpression( '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/', (string) $payload['generated_at'] );
	}

	public function test_response_includes_jab_abilities_only(): void {
		$GLOBALS['_jab_test_abilities'] = [
			'jab/get-posts' => $this->fake_ability(
				'jab/get-posts',
				'jab-content',
				[ 'label' => 'Get Posts', 'description' => 'desc', 'input_schema' => [ 'type' => 'object' ], 'output_schema' => [ 'type' => 'object' ], 'meta' => [ 'mcp' => [ 'public' => true ] ] ]
			),
			'mcp-adapter/discover-abilities' => $this->fake_ability( 'mcp-adapter/discover-abilities', 'mcp' ),
		];

		$response = Manifest::respond( new \WP_REST_Request() );
		$payload  = $response->get_data();

		$names = array_map( static fn( array $a ): string => (string) $a['name'], $payload['abilities'] );
		$this->assertContains( 'jab/get-posts', $names );
		$this->assertNotContains( 'mcp-adapter/discover-abilities', $names );
	}

	public function test_each_ability_entry_carries_full_metadata(): void {
		$GLOBALS['_jab_test_abilities'] = [
			'jab/get-posts' => $this->fake_ability(
				'jab/get-posts',
				'jab-content',
				[
					'label'         => 'Get Posts',
					'description'   => 'desc',
					'input_schema'  => [ 'type' => 'object', 'properties' => [] ],
					'output_schema' => [ 'type' => 'object', 'properties' => [] ],
					'meta'          => [ 'mcp' => [ 'public' => true ] ],
				]
			),
		];

		$response = Manifest::respond( new \WP_REST_Request() );
		$entry    = $response->get_data()['abilities'][0];

		$this->assertSame( 'jab/get-posts', $entry['name'] );
		$this->assertSame( 'jab-content', $entry['category'] );
		$this->assertSame( 'Get Posts', $entry['label'] );
		$this->assertSame( 'desc', $entry['description'] );
		$this->assertSame( [ 'type' => 'object', 'properties' => [] ], $entry['input_schema'] );
		$this->assertSame( [ 'type' => 'object', 'properties' => [] ], $entry['output_schema'] );
		$this->assertSame( [ 'mcp' => [ 'public' => true ] ], $entry['meta'] );
	}

	public function test_abilities_are_sorted_by_name(): void {
		$GLOBALS['_jab_test_abilities'] = [
			'jab/get-posts' => $this->fake_ability( 'jab/get-posts', 'jab-content' ),
			'jab/get-beers' => $this->fake_ability( 'jab/get-beers', 'jab-content' ),
			'jab/get-menus' => $this->fake_ability( 'jab/get-menus', 'jab-content' ),
		];
		$response = Manifest::respond( new \WP_REST_Request() );
		$names    = array_map( static fn( array $a ): string => (string) $a['name'], $response->get_data()['abilities'] );
		$this->assertSame( [ 'jab/get-beers', 'jab/get-menus', 'jab/get-posts' ], $names );
	}

	public function test_ability_with_empty_name_is_skipped(): void {
		// Defensive: a misregistered ability with empty get_name() must
		// not be included in the manifest. The strpos guard alone has
		// PHP-version-dependent semantics on empty haystacks, so the
		// production code adds an explicit '' === $name pre-guard.
		$GLOBALS['_jab_test_abilities'] = [
			'empty' => $this->fake_ability( '', 'jab-content' ),
			'good'  => $this->fake_ability( 'jab/get-posts', 'jab-content' ),
		];
		$response = Manifest::respond( new \WP_REST_Request() );
		$names    = array_map( static fn( array $a ): string => (string) $a['name'], $response->get_data()['abilities'] );
		$this->assertSame( [ 'jab/get-posts' ], $names );
	}
}
