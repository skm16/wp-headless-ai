<?php
declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Rest;

use Jab\WpHeadlessKit\Rest\Diagnostics;
use PHPUnit\Framework\TestCase;

final class DiagnosticsCapabilityTest extends TestCase {

	protected function setUp(): void {
		\jab_wphk_reset_stubs();
	}

	public function test_default_capability_is_manage_options(): void {
		$this->assertSame( 'manage_options', Diagnostics::capability() );
	}

	public function test_filter_can_lower_capability(): void {
		$GLOBALS['_jab_test_filters']['jab/headless_kit/diagnostics_capability'] = static fn ( string $cap ): string => 'read';
		$this->assertSame( 'read', Diagnostics::capability() );
	}

	public function test_non_string_filter_return_falls_back_to_do_not_allow(): void {
		$GLOBALS['_jab_test_filters']['jab/headless_kit/diagnostics_capability'] = static fn ( $cap ): int => 42;
		$this->assertSame( 'do_not_allow', Diagnostics::capability() );
		$this->assertNotEmpty(
			$GLOBALS['_jab_test_doing_it_wrong'] ?? [],
			'Falling back to do_not_allow must also trigger _doing_it_wrong so the misuse appears in WP debug.log.'
		);
	}

	public function test_empty_string_filter_return_falls_back_to_do_not_allow(): void {
		$GLOBALS['_jab_test_filters']['jab/headless_kit/diagnostics_capability'] = static fn ( $cap ): string => '';
		$this->assertSame( 'do_not_allow', Diagnostics::capability() );
		$this->assertNotEmpty(
			$GLOBALS['_jab_test_doing_it_wrong'] ?? [],
			'Falling back to do_not_allow must also trigger _doing_it_wrong so the misuse appears in WP debug.log.'
		);
	}
}
