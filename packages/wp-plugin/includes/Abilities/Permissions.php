<?php
/**
 * Permissions — shared permission helpers for every jab ability.
 *
 * Centralises two things every ability factory needs:
 *
 *   1. The capability check that gates the ability call (filterable so an
 *      agency can tighten access without forking the plugin).
 *   2. The post_status guardrail: a Subscriber-authenticated caller who asks
 *      for `post_status=draft` must not see other people's drafts.
 *
 * Why this lives in one place: SEC-1 was a latent leak across both
 * PostTypeListAbility and PostTypeBySlugAbility. Inlining the check in both
 * is how the original bug happened. Single helper, single regression test.
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Abilities;

defined( 'ABSPATH' ) || exit;

final class Permissions {

	/**
	 * Default capability gating every public ability call. `read` matches the
	 * Subscriber role — i.e. "any authenticated user can call this ability,
	 * but execute() still has to enforce per-record visibility."
	 */
	public const DEFAULT_CAPABILITY = 'read';

	/**
	 * Resolve the required capability for an ability call. Filterable via
	 * `jab/headless_kit/ability_capability`, with the ability name and
	 * the originating post type (when applicable) passed as context so an
	 * agency can tighten per-ability or per-CPT.
	 */
	public static function ability_capability( string $ability_name, string $post_type = '' ): string {
		/**
		 * Filter the capability required to invoke a jab ability.
		 *
		 * Default is `read` (Subscriber+). Override in a mu-plugin to require
		 * a stricter cap (e.g. `edit_posts` for an admin-only headless surface)
		 * or a custom capability mapped via a membership plugin.
		 *
		 * @param string $capability  Default capability slug.
		 * @param string $ability_name e.g. 'jab/get-posts'.
		 * @param string $post_type    e.g. 'post' or '' for non-CPT abilities (menus, taxonomies).
		 */
		$capability = apply_filters(
			'jab/headless_kit/ability_capability',
			self::DEFAULT_CAPABILITY,
			$ability_name,
			$post_type
		);

		return is_string( $capability ) && '' !== $capability ? $capability : self::DEFAULT_CAPABILITY;
	}

	/**
	 * Boolean form for use as a `permission_callback`. Closes over the ability
	 * name + post type so each registration captures its own context.
	 *
	 * @return callable(): bool
	 */
	public static function gate( string $ability_name, string $post_type = '' ): callable {
		return static function () use ( $ability_name, $post_type ): bool {
			return current_user_can( self::ability_capability( $ability_name, $post_type ) );
		};
	}

	/**
	 * Sanitize a caller-requested `post_status` against the caller's actual
	 * capabilities for a given post type.
	 *
	 * Non-public statuses (`draft`, `pending`, `private`, `future`, `any`,
	 * `trash`) are gated behind the post type's `edit_posts` capability. A
	 * Subscriber asking for `post_status=draft` silently falls back to
	 * `publish` — the conservative choice for a public content API.
	 *
	 * Return value is always one of the schema-allowed values; callers can
	 * pass it straight into `get_posts()`.
	 */
	public static function sanitize_post_status( ?string $requested, string $post_type ): string {
		$status = ( null === $requested || '' === $requested ) ? 'publish' : $requested;

		if ( 'publish' === $status ) {
			return 'publish';
		}

		$pt_object = get_post_type_object( $post_type );
		$edit_cap  = is_object( $pt_object ) && isset( $pt_object->cap->edit_posts )
			? (string) $pt_object->cap->edit_posts
			: 'edit_posts';

		return current_user_can( $edit_cap ) ? $status : 'publish';
	}
}
