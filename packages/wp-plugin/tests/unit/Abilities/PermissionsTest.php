<?php
/**
 * PermissionsTest — covers SEC-1 (sanitize_post_status) and SEC-2 / H3
 * (ability_capability filter handling).
 *
 * @package Jab\WpHeadlessKit\Tests
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Abilities;

use Jab\WpHeadlessKit\Abilities\Permissions;
use PHPUnit\Framework\TestCase;

final class PermissionsTest extends TestCase {

	protected function setUp(): void {
		\jab_wphk_reset_stubs();
		// Register a `post` post type with the standard cap mapping. Tests
		// override `current_user_can` per-case via the stub globals.
		$GLOBALS['_jab_test_post_types']['post'] = (object) [
			'cap' => (object) [ 'edit_posts' => 'edit_posts' ],
		];
	}

	// ------------------------------------------------------------------
	// SEC-1: sanitize_post_status
	// ------------------------------------------------------------------

	public function test_publish_passes_through_for_any_caller(): void {
		// Subscriber (no caps) and editor (full caps) both get `publish` back.
		$this->assertSame( 'publish', Permissions::sanitize_post_status( 'publish', 'post' ) );
		$GLOBALS['_jab_test_user_caps']['edit_posts'] = true;
		$this->assertSame( 'publish', Permissions::sanitize_post_status( 'publish', 'post' ) );
	}

	public function test_null_input_defaults_to_publish(): void {
		$this->assertSame( 'publish', Permissions::sanitize_post_status( null, 'post' ) );
	}

	public function test_empty_string_input_defaults_to_publish(): void {
		$this->assertSame( 'publish', Permissions::sanitize_post_status( '', 'post' ) );
	}

	public function test_draft_downgrades_to_publish_for_subscriber(): void {
		// SEC-1 regression: this is the leak. A Subscriber asking for drafts
		// must get `publish` back regardless of what they passed in.
		$GLOBALS['_jab_test_user_caps']['edit_posts'] = false;
		$this->assertSame( 'publish', Permissions::sanitize_post_status( 'draft', 'post' ) );
	}

	public function test_any_downgrades_to_publish_for_subscriber(): void {
		$GLOBALS['_jab_test_user_caps']['edit_posts'] = false;
		$this->assertSame( 'publish', Permissions::sanitize_post_status( 'any', 'post' ) );
	}

	public function test_draft_passes_through_for_editor(): void {
		// An editor SHOULD get drafts when they ask for them — that's the
		// behavior the API promises in its schema.
		$GLOBALS['_jab_test_user_caps']['edit_posts'] = true;
		$this->assertSame( 'draft', Permissions::sanitize_post_status( 'draft', 'post' ) );
	}

	public function test_any_passes_through_for_editor(): void {
		$GLOBALS['_jab_test_user_caps']['edit_posts'] = true;
		$this->assertSame( 'any', Permissions::sanitize_post_status( 'any', 'post' ) );
	}

	public function test_uses_custom_edit_cap_when_post_type_remaps(): void {
		// A CPT with `capability_type = 'beer'` produces `edit_beers`, not
		// the default `edit_posts`. The gate must follow the CPT's own caps.
		$GLOBALS['_jab_test_post_types']['beer'] = (object) [
			'cap' => (object) [ 'edit_posts' => 'edit_beers' ],
		];
		$GLOBALS['_jab_test_user_caps']['edit_posts'] = true;
		$GLOBALS['_jab_test_user_caps']['edit_beers'] = false;

		$this->assertSame(
			'publish',
			Permissions::sanitize_post_status( 'draft', 'beer' ),
			'A user who can edit_posts but not edit_beers must NOT see draft beers.'
		);
	}

	public function test_unknown_post_type_falls_back_to_edit_posts(): void {
		// get_post_type_object() returns null for an unknown CPT. We should
		// still gate on something — `edit_posts` is the safest default.
		$GLOBALS['_jab_test_user_caps']['edit_posts'] = false;
		$this->assertSame(
			'publish',
			Permissions::sanitize_post_status( 'draft', 'nonexistent' )
		);
	}

	// ------------------------------------------------------------------
	// SEC-2 + H3: ability_capability filter handling
	// ------------------------------------------------------------------

	public function test_returns_default_capability_when_no_filter_is_registered(): void {
		$this->assertSame( 'read', Permissions::ability_capability( 'jab/get-posts', 'post' ) );
	}

	public function test_filter_can_override_capability(): void {
		$GLOBALS['_jab_test_filters']['jab/headless_kit/ability_capability'] =
			static function ( $default, $name, $post_type ) {
				return 'edit_posts';
			};

		$this->assertSame(
			'edit_posts',
			Permissions::ability_capability( 'jab/get-posts', 'post' )
		);
	}

	public function test_filter_receives_ability_name_and_post_type(): void {
		$captured = [];
		$GLOBALS['_jab_test_filters']['jab/headless_kit/ability_capability'] =
			static function ( $default, $name, $post_type ) use ( &$captured ) {
				$captured = compact( 'default', 'name', 'post_type' );
				return $default;
			};

		Permissions::ability_capability( 'jab/get-beers', 'beer' );

		$this->assertSame( 'read', $captured['default'] );
		$this->assertSame( 'jab/get-beers', $captured['name'] );
		$this->assertSame( 'beer', $captured['post_type'] );
	}

	/**
	 * H3 regression: a filter returning a non-string or empty value must lock
	 * the ability down (`do_not_allow`), not silently revert to `read`. The
	 * old behavior was the same bug class as SEC-1 — quietly permissive on
	 * misconfiguration.
	 *
	 * @dataProvider falsy_filter_returns
	 *
	 * @param mixed $filter_return
	 */
	public function test_falsy_filter_return_locks_down_the_ability( $filter_return ): void {
		$GLOBALS['_jab_test_filters']['jab/headless_kit/ability_capability'] =
			static function () use ( $filter_return ) {
				return $filter_return;
			};

		$this->assertSame(
			'do_not_allow',
			Permissions::ability_capability( 'jab/get-posts', 'post' )
		);
		$this->assertNotEmpty(
			$GLOBALS['_jab_test_doing_it_wrong'],
			'A falsy filter return must surface via _doing_it_wrong() so the agency dev notices.'
		);
	}

	/**
	 * @return array<string, array{0: mixed}>
	 */
	public function falsy_filter_returns(): array {
		return [
			'null'         => [ null ],
			'false'        => [ false ],
			'empty string' => [ '' ],
			'integer zero' => [ 0 ],
			'array'        => [ [] ],
		];
	}
}
