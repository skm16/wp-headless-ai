<?php
/**
 * PostTypeBySlugAbilityTest — covers the v0.5.0 include defaults and the
 * pass-through to shape_row.
 *
 * @package Jab\WpHeadlessKit\Tests
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Abilities;

use Jab\WpHeadlessKit\Abilities\PostTypeBySlugAbility;
use PHPUnit\Framework\TestCase;
use ReflectionMethod;

final class PostTypeBySlugAbilityTest extends TestCase {

	protected function setUp(): void {
		\jab_wphk_reset_stubs();
	}

	/**
	 * @return mixed
	 */
	private function invoke_private( string $method_name, array $args ) {
		$method = new ReflectionMethod( PostTypeBySlugAbility::class, $method_name );
		$method->setAccessible( true );
		return $method->invokeArgs( null, $args );
	}

	public function test_input_schema_defaults_content_and_blocks_on(): void {
		$schema = $this->invoke_private( 'input_schema', [ [ 'noun' => 'page' ] ] );

		$include = $schema['properties']['include'];
		$this->assertTrue( $include['properties']['content']['default'] );
		$this->assertTrue( $include['properties']['blocks']['default'] );
		// render still defaults off — opt-in only.
		$this->assertFalse( $include['properties']['render']['default'] );
	}

	public function test_output_schema_declares_same_optional_block_fields(): void {
		$schema = $this->invoke_private( 'output_schema', [ 'page', null, false, [] ] );

		$item_props    = $schema['properties']['page']['oneOf'][0]['properties'];
		$item_required = $schema['properties']['page']['oneOf'][0]['required'];

		$this->assertArrayHasKey( 'content', $item_props );
		$this->assertArrayHasKey( 'blocks', $item_props );
		$this->assertArrayHasKey( 'rendered_content', $item_props );
		$this->assertNotContains( 'content', $item_required );
		$this->assertNotContains( 'blocks', $item_required );
		$this->assertNotContains( 'rendered_content', $item_required );
	}

	public function test_resolve_include_defaults_to_content_and_blocks_on(): void {
		$resolved = $this->invoke_private( 'resolve_include', [ [] ] );
		$this->assertTrue( $resolved['content'] );
		$this->assertTrue( $resolved['blocks'] );
		$this->assertFalse( $resolved['render'] );
	}

	public function test_resolve_include_respects_explicit_false(): void {
		$resolved = $this->invoke_private( 'resolve_include', [ [ 'include' => [ 'content' => false, 'blocks' => false ] ] ] );
		$this->assertFalse( $resolved['content'] );
		$this->assertFalse( $resolved['blocks'] );
	}
}
