<?php
/**
 * BlockFieldSchemaTest — covers location-rule walking for `block==<name>` rules.
 *
 * Schema generation itself is delegated to Acf\Schema (already heavily tested
 * via existing AcfSchemaTest if present, or via PostTypeListAbilityTest in
 * practice). These tests verify the location-rule resolution path only.
 *
 * @package Jab\WpHeadlessKit\Tests
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Acf;

use Jab\WpHeadlessKit\Acf\BlockFieldSchema;
use PHPUnit\Framework\TestCase;

final class BlockFieldSchemaTest extends TestCase {

	protected function setUp(): void {
		\jab_wphk_reset_stubs();
	}

	public function test_returns_null_when_acf_inactive(): void {
		// acf_get_field_groups not stubbed in this test → ACF inactive path.
		unset( $GLOBALS['_jab_test_acf_field_groups'] );
		$GLOBALS['_jab_test_acf_inactive'] = true;
		$this->assertNull( BlockFieldSchema::for_block_name( 'acf/hero' ) );
	}

	public function test_returns_null_when_no_group_targets_block(): void {
		$GLOBALS['_jab_test_acf_field_groups'] = [
			[
				'key'      => 'group_1',
				'location' => [
					[ [ 'param' => 'post_type', 'operator' => '==', 'value' => 'page' ] ],
				],
			],
		];
		$GLOBALS['_jab_test_acf_fields_by_group'] = [
			'group_1' => [
				[ 'name' => 'headline', 'type' => 'text' ],
			],
		];
		$this->assertNull( BlockFieldSchema::for_block_name( 'acf/hero' ) );
	}

	public function test_returns_schema_when_group_targets_block(): void {
		$GLOBALS['_jab_test_acf_field_groups'] = [
			[
				'key'      => 'group_hero',
				'location' => [
					[ [ 'param' => 'block', 'operator' => '==', 'value' => 'acf/hero' ] ],
				],
			],
		];
		$GLOBALS['_jab_test_acf_fields_by_group'] = [
			'group_hero' => [
				[ 'name' => 'headline', 'type' => 'text' ],
				[ 'name' => 'subhead',  'type' => 'textarea' ],
			],
		];
		$schema = BlockFieldSchema::for_block_name( 'acf/hero' );
		$this->assertIsArray( $schema );
		$this->assertSame( 'object', $schema['type'] );
		$this->assertFalse( $schema['additionalProperties'] );
		$this->assertArrayHasKey( 'headline', $schema['properties'] );
		$this->assertArrayHasKey( 'subhead', $schema['properties'] );
	}

	public function test_or_clause_with_one_matching_rule_returns_schema(): void {
		// ACF location: outer = OR, inner = AND. A group targeting either of
		// two blocks should match for both block-name lookups.
		$GLOBALS['_jab_test_acf_field_groups'] = [
			[
				'key'      => 'group_shared',
				'location' => [
					[ [ 'param' => 'block', 'operator' => '==', 'value' => 'acf/hero' ] ],
					[ [ 'param' => 'block', 'operator' => '==', 'value' => 'acf/banner' ] ],
				],
			],
		];
		$GLOBALS['_jab_test_acf_fields_by_group'] = [
			'group_shared' => [ [ 'name' => 'shared_text', 'type' => 'text' ] ],
		];
		$hero   = BlockFieldSchema::for_block_name( 'acf/hero' );
		$banner = BlockFieldSchema::for_block_name( 'acf/banner' );
		$this->assertArrayHasKey( 'shared_text', $hero['properties'] );
		$this->assertArrayHasKey( 'shared_text', $banner['properties'] );
	}

	public function test_non_equal_operators_are_ignored(): void {
		// ACF supports != and other operators; we only honor == for block names.
		$GLOBALS['_jab_test_acf_field_groups'] = [
			[
				'key'      => 'group_negated',
				'location' => [
					[ [ 'param' => 'block', 'operator' => '!=', 'value' => 'acf/other' ] ],
				],
			],
		];
		$GLOBALS['_jab_test_acf_fields_by_group'] = [
			'group_negated' => [ [ 'name' => 'x', 'type' => 'text' ] ],
		];
		$this->assertNull( BlockFieldSchema::for_block_name( 'acf/hero' ) );
	}
}
