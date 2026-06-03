<?php
declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Acf;

use Jab\WpHeadlessKit\Acf\Schema;
use PHPUnit\Framework\TestCase;

final class SchemaFlushCacheTest extends TestCase {

	protected function setUp(): void {
		\jab_wphk_reset_stubs();
	}

	public function test_flush_cache_from_cold_start_writes_one(): void {
		// No pre-existing option — generation defaults to 0; flush bumps it to 1.
		Schema::flush_cache();
		$this->assertSame( 1, (int) get_option( 'jab_acf_schema_generation', 0 ) );
	}

	public function test_flush_cache_increments_existing_generation_option(): void {
		// Pre-seed the option to a non-zero value to exercise N → N+1, not
		// the cold-start 0 → 1 path (covered by from_cold_start_writes_one).
		update_option( 'jab_acf_schema_generation', 5 );

		Schema::flush_cache();
		$this->assertSame( 6, (int) get_option( 'jab_acf_schema_generation', 0 ) );
	}

	public function test_flush_cache_is_idempotently_callable(): void {
		Schema::flush_cache();
		Schema::flush_cache();
		Schema::flush_cache();
		$this->assertSame( 3, (int) get_option( 'jab_acf_schema_generation', 0 ) );
	}
}
