<?php
declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Diagnostics;

use Jab\WpHeadlessKit\Diagnostics\Check;
use PHPUnit\Framework\TestCase;

final class CheckTest extends TestCase {

	public function test_pass_factory_produces_pass_severity(): void {
		$check = Check::pass( 'abilities_api', 'Abilities API loaded', 'wp_register_ability() is available.' );
		$this->assertSame(
			[
				'id'       => 'abilities_api',
				'label'    => 'Abilities API loaded',
				'severity' => 'pass',
				'message'  => 'wp_register_ability() is available.',
			],
			$check->to_array()
		);
	}

	public function test_warn_factory_includes_detail_when_supplied(): void {
		$check = Check::warn(
			'application_passwords_enabled',
			'Application Passwords enabled',
			'Disabled — agencies cannot authenticate against this site.',
			'is_ssl()=false'
		);
		$this->assertSame(
			[
				'id'       => 'application_passwords_enabled',
				'label'    => 'Application Passwords enabled',
				'severity' => 'warn',
				'message'  => 'Disabled — agencies cannot authenticate against this site.',
				'detail'   => 'is_ssl()=false',
			],
			$check->to_array()
		);
	}

	public function test_fail_factory_supports_array_detail(): void {
		$check = Check::fail(
			'rest_routes_registered',
			'JAB REST routes registered',
			'3/5 routes present.',
			[ '/jab/v1/site', '/jab/v1/diagnostics' ]
		);
		$this->assertSame(
			[
				'id'       => 'rest_routes_registered',
				'label'    => 'JAB REST routes registered',
				'severity' => 'fail',
				'message'  => '3/5 routes present.',
				'detail'   => [ '/jab/v1/site', '/jab/v1/diagnostics' ],
			],
			$check->to_array()
		);
	}

	public function test_severity_accessor_returns_the_string(): void {
		$this->assertSame( 'pass', Check::pass( 'x', 'y', 'z' )->severity() );
		$this->assertSame( 'warn', Check::warn( 'x', 'y', 'z' )->severity() );
		$this->assertSame( 'fail', Check::fail( 'x', 'y', 'z' )->severity() );
	}
}
