<?php
declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests;

use Jab\WpHeadlessKit\Registry;
use PHPUnit\Framework\TestCase;

final class RegistryDiscoveredTypesTest extends TestCase {

	protected function setUp(): void {
		\jab_wphk_reset_stubs();
		$GLOBALS['_jab_test_post_types'] = [
			'post'             => (object) [ 'name' => 'post' ],
			'page'             => (object) [ 'name' => 'page' ],
			'beer'             => (object) [ 'name' => 'beer' ],
			'attachment'       => (object) [ 'name' => 'attachment' ],
			'acf-field-group'  => (object) [ 'name' => 'acf-field-group' ],
		];
		$GLOBALS['_jab_test_taxonomies'] = [];
	}

	public function test_discovered_post_types_separates_included_and_excluded_alphabetically(): void {
		$result = Registry::discovered_post_types();

		$this->assertSame( [ 'beer', 'page', 'post' ], $result['included'] );
		$this->assertSame( [ 'acf-field-group', 'attachment' ], $result['excluded'] );
	}

	public function test_filter_can_extend_excludes(): void {
		$GLOBALS['_jab_test_filters']['jab/headless_kit/post_type_excludes'] = static function ( array $defaults ): array {
			$defaults[] = 'beer';
			return $defaults;
		};

		$result = Registry::discovered_post_types();

		$this->assertNotContains( 'beer', $result['included'] );
		$this->assertContains( 'beer',    $result['excluded'] );
	}

	public function test_discovered_taxonomies_separates_included_and_excluded_alphabetically(): void {
		$GLOBALS['_jab_test_taxonomies'] = [
			'category'           => (object) [ 'name' => 'category' ],
			'beer_style'         => (object) [ 'name' => 'beer_style' ],
			'nav_menu'           => (object) [ 'name' => 'nav_menu' ],
			'post_format'        => (object) [ 'name' => 'post_format' ],
			'wp_pattern_category'=> (object) [ 'name' => 'wp_pattern_category' ],
		];

		$result = Registry::discovered_taxonomies();

		$this->assertSame( [ 'beer_style', 'category' ], $result['included'] );
		$this->assertSame( [ 'nav_menu', 'post_format', 'wp_pattern_category' ], $result['excluded'] );
	}

	public function test_taxonomy_filter_can_extend_excludes(): void {
		$GLOBALS['_jab_test_taxonomies'] = [
			'category'   => (object) [ 'name' => 'category' ],
			'beer_style' => (object) [ 'name' => 'beer_style' ],
		];
		$GLOBALS['_jab_test_filters']['jab/headless_kit/taxonomy_excludes'] = static function ( array $defaults ): array {
			$defaults[] = 'beer_style';
			return $defaults;
		};

		$result = Registry::discovered_taxonomies();

		$this->assertNotContains( 'beer_style', $result['included'] );
		$this->assertContains( 'beer_style',    $result['excluded'] );
	}
}
