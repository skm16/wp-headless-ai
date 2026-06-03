<?php
declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Cli;

use Jab\WpHeadlessKit\Cli\DoctorCommand;
use PHPUnit\Framework\TestCase;

final class ExitCodeMappingTest extends TestCase {

	public function test_all_pass_exits_zero(): void {
		$this->assertSame( 0, DoctorCommand::compute_exit_code( [ 'pass' => 6, 'warn' => 0, 'fail' => 0 ], false ) );
	}

	public function test_any_fail_exits_one_without_strict(): void {
		$this->assertSame( 1, DoctorCommand::compute_exit_code( [ 'pass' => 5, 'warn' => 0, 'fail' => 1 ], false ) );
	}

	public function test_any_fail_exits_one_with_strict(): void {
		$this->assertSame( 1, DoctorCommand::compute_exit_code( [ 'pass' => 5, 'warn' => 0, 'fail' => 1 ], true ) );
	}

	public function test_warn_without_strict_exits_zero(): void {
		$this->assertSame( 0, DoctorCommand::compute_exit_code( [ 'pass' => 5, 'warn' => 1, 'fail' => 0 ], false ) );
	}

	public function test_warn_with_strict_exits_one(): void {
		$this->assertSame( 1, DoctorCommand::compute_exit_code( [ 'pass' => 5, 'warn' => 1, 'fail' => 0 ], true ) );
	}

	public function test_warn_and_fail_with_strict_exits_one(): void {
		$this->assertSame( 1, DoctorCommand::compute_exit_code( [ 'pass' => 4, 'warn' => 1, 'fail' => 1 ], true ) );
	}
}
