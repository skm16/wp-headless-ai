<?php
/**
 * PostTypeListAbilityBlockEmissionTest — covers the v0.5.0 include-gated
 * emission path for content / blocks / rendered_content.
 *
 * @package Jab\WpHeadlessKit\Tests
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Abilities;

use Jab\WpHeadlessKit\Abilities\PostTypeListAbility;
use PHPUnit\Framework\TestCase;
use ReflectionMethod;

final class PostTypeListAbilityBlockEmissionTest extends TestCase {

	protected function setUp(): void {
		\jab_wphk_reset_stubs();
	}

	/**
	 * Mirrors the helper in PostTypeListAbilityTest — keep both files using
	 * the same convention so the executing engineer can copy idioms freely.
	 *
	 * @return mixed
	 */
	private function invoke_private( string $method_name, array $args ) {
		$method = new ReflectionMethod( PostTypeListAbility::class, $method_name );
		$method->setAccessible( true );
		return $method->invokeArgs( null, $args );
	}

	private function fake_post( int $id, string $content ): \WP_Post {
		$post                     = new \WP_Post();
		$post->ID                 = $id;
		$post->post_name          = 'p-' . $id;
		$post->post_content       = $content;
		$post->post_title         = '';
		$post->post_excerpt       = '';
		$post->post_date_gmt      = '2026-05-24 10:00:00';
		$post->post_date          = '2026-05-24 10:00:00';
		$post->post_modified_gmt  = '2026-05-24 10:00:00';
		$post->post_modified      = '2026-05-24 10:00:00';
		return $post;
	}

	public function test_no_include_flags_omits_all_optional_fields(): void {
		$post = $this->fake_post( 1, '<p>hello</p>' );
		$row  = PostTypeListAbility::shape_row(
			$post,
			null,
			false,
			[],
			[],
			[ 'content' => false, 'blocks' => false, 'render' => false ]
		);
		$this->assertArrayNotHasKey( 'content', $row );
		$this->assertArrayNotHasKey( 'blocks', $row );
		$this->assertArrayNotHasKey( 'rendered_content', $row );
	}

	public function test_content_flag_emits_raw_post_content(): void {
		$post = $this->fake_post( 1, '<p>hello world</p>' );
		$row  = PostTypeListAbility::shape_row(
			$post,
			null,
			false,
			[],
			[],
			[ 'content' => true, 'blocks' => false, 'render' => false ]
		);
		$this->assertSame( '<p>hello world</p>', $row['content'] );
	}

	public function test_blocks_flag_emits_parsed_block_tree(): void {
		$post = $this->fake_post( 1, '<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->' );
		$GLOBALS['_jab_test_parse_blocks_map']['<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->'] = [
			[
				'blockName'    => 'core/paragraph',
				'attrs'        => [],
				'innerBlocks'  => [],
				'innerHTML'    => '<p>x</p>',
				'innerContent' => [ '<p>x</p>' ],
			],
		];
		$row = PostTypeListAbility::shape_row(
			$post,
			null,
			false,
			[],
			[],
			[ 'content' => false, 'blocks' => true, 'render' => false ]
		);
		$this->assertIsArray( $row['blocks'] );
		$this->assertSame( 'core/paragraph', $row['blocks'][0]['blockName'] );
	}

	public function test_blocks_flag_expands_core_block_references(): void {
		$post = $this->fake_post( 1, '<!-- wp:block {"ref":42} /-->' );
		$GLOBALS['_jab_test_parse_blocks_map']['<!-- wp:block {"ref":42} /-->'] = [
			[
				'blockName'    => 'core/block',
				'attrs'        => [ 'ref' => 42 ],
				'innerBlocks'  => [],
				'innerHTML'    => '',
				'innerContent' => [],
			],
		];
		$reusable                         = new \WP_Post();
		$reusable->ID                     = 42;
		$reusable->post_type              = 'wp_block';
		$reusable->post_status            = 'publish';
		$reusable->post_content           = '<reusable-content/>';
		$GLOBALS['_jab_test_posts'][ 42 ] = $reusable;
		$GLOBALS['_jab_test_parse_blocks_map']['<reusable-content/>'] = [
			[
				'blockName'    => 'core/paragraph',
				'attrs'        => [],
				'innerBlocks'  => [],
				'innerHTML'    => '<p>reused</p>',
				'innerContent' => [ '<p>reused</p>' ],
			],
		];
		$row = PostTypeListAbility::shape_row(
			$post,
			null,
			false,
			[],
			[],
			[ 'content' => false, 'blocks' => true, 'render' => false ]
		);
		$this->assertSame( 'core/block', $row['blocks'][0]['blockName'] );
		$this->assertSame( '<p>reused</p>', $row['blocks'][0]['innerBlocks'][0]['innerHTML'] );
	}

	public function test_render_flag_emits_rendered_content_via_the_content_filter(): void {
		$post                                        = $this->fake_post( 1, '<!-- wp:dynamic /-->' );
		$GLOBALS['_jab_test_filters']['the_content'] = static function ( $value ) {
			return '<rendered>' . $value . '</rendered>';
		};
		$row = PostTypeListAbility::shape_row(
			$post,
			null,
			false,
			[],
			[],
			[ 'content' => false, 'blocks' => false, 'render' => true ]
		);
		$this->assertSame( '<rendered><!-- wp:dynamic /--></rendered>', $row['rendered_content'] );
	}

	public function test_render_flag_wraps_with_setup_postdata(): void {
		// Dynamic blocks rely on the global $post being set. Without
		// setup_postdata()/wp_reset_postdata() the rendered output of
		// blocks like core/post-title or core/query is unreliable.
		$post = $this->fake_post( 7, 'whatever' );
		PostTypeListAbility::shape_row(
			$post,
			null,
			false,
			[],
			[],
			[ 'content' => false, 'blocks' => false, 'render' => true ]
		);
		$this->assertCount( 1, $GLOBALS['_jab_test_setup_postdata_calls'] );
		$this->assertSame( 1, $GLOBALS['_jab_test_wp_reset_postdata_calls'] );
	}
}
