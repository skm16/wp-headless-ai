<?php
declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Diagnostics;

use Jab\WpHeadlessKit\Diagnostics\Fact;
use PHPUnit\Framework\TestCase;

final class FactTest extends TestCase {

	public function test_minimal_fact_serializes_without_detail(): void {
		$fact = new Fact( 'plugin_version', 'Plugin version', '0.7.1' );
		$this->assertSame(
			[ 'id' => 'plugin_version', 'label' => 'Plugin version', 'value' => '0.7.1' ],
			$fact->to_array()
		);
	}

	public function test_fact_with_detail_includes_detail_key(): void {
		$fact = new Fact(
			'registered_abilities',
			'Registered JAB abilities',
			14,
			[ 'jab/get-posts', 'jab/get-pages' ]
		);
		$this->assertSame(
			[
				'id'     => 'registered_abilities',
				'label'  => 'Registered JAB abilities',
				'value'  => 14,
				'detail' => [ 'jab/get-posts', 'jab/get-pages' ],
			],
			$fact->to_array()
		);
	}

	public function test_fact_value_can_be_a_nested_array(): void {
		$fact = new Fact(
			'post_types',
			'Public post types',
			[ 'included' => [ 'post', 'page' ], 'excluded' => [ 'attachment' ] ]
		);
		$array = $fact->to_array();
		$this->assertSame( [ 'post', 'page' ], $array['value']['included'] );
	}
}
