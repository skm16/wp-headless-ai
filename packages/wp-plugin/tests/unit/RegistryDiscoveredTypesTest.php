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
	}

	public function test_discovered_post_types_separates_included_and_excluded_alphabetically(): void {
		$result = Registry::discovered_post_types();

		$this->assertSame( [ 'beer', 'page', 'post' ], $result['included'] );
		$this->assertContains( 'attachment',      $result['excluded'] );
		$this->assertContains( 'acf-field-group', $result['excluded'] );
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
}
