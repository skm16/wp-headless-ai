<?php
/**
 * ContentTypes — REST route exposing the post-type catalog the plugin
 * considers "owned content" for ownership-picker purposes.
 *
 * Why this exists: the Jab SaaS onboarding wizard needs to ask the agency
 * "for each content type, who owns it — WP or Jab?" The MCP-ability list
 * is the wrong source for that question because:
 *
 *   - It double-lists every post type (one ability for `jab/get-{plural}`
 *     and another for `jab/get-{singular}-by-slug`).
 *   - It includes ability collisions deduped with `-2-` infixes.
 *   - It carries no post counts.
 *   - It includes taxonomy + menus abilities that aren't user-ownable
 *     content types in the spec sense.
 *
 * This endpoint returns the same set Registry.php considers when registering
 * post-type abilities (matches `Registry::post_type_excludes()`), plus real
 * counts via `wp_count_posts()` so the picker shows accurate per-type item
 * counts.
 *
 * Auth: required (`edit_posts`). Counts include drafts/private/pending —
 * sensitive enough to warrant authentication. The onboarding wizard submits
 * Basic auth with an admin app password, so the caller has the cap.
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Rest;

use Jab\WpHeadlessKit\Registry;

defined( 'ABSPATH' ) || exit;

final class ContentTypes {

	private const NAMESPACE = 'jab/v1';
	private const ROUTE     = '/content-types';

	/**
	 * Post status set whose counts are summed into a type's `count`. Excludes
	 * `trash` and `auto-draft` — neither is editor-visible content. Each
	 * status added here is a deliberate choice about what "content the
	 * agency owns" means.
	 */
	private const COUNTED_STATUSES = [
		'publish',
		'future',
		'draft',
		'pending',
		'private',
	];

	public static function register(): void {
		register_rest_route(
			self::NAMESPACE,
			self::ROUTE,
			[
				'methods'             => \WP_REST_Server::READABLE,
				'callback'            => [ self::class, 'respond' ],
				'permission_callback' => [ self::class, 'authorize' ],
			]
		);
	}

	/**
	 * Allow any user with `edit_posts`. The counts include drafts +
	 * private + pending, which would leak unpublished-content metadata
	 * to readers without this cap.
	 */
	public static function authorize(): bool {
		return current_user_can( 'edit_posts' );
	}

	/**
	 * GET handler. Returns the post-type catalog as a flat array.
	 */
	public static function respond( \WP_REST_Request $request ): \WP_REST_Response {
		unset( $request );

		$excludes   = Registry::post_type_excludes();
		$post_types = get_post_types( [ 'public' => true ], 'objects' );

		$payload = [];
		foreach ( $post_types as $slug => $pt ) {
			if ( ! ( $pt instanceof \WP_Post_Type ) ) {
				continue;
			}
			if ( in_array( (string) $slug, $excludes, true ) ) {
				continue;
			}

			$payload[] = self::describe_post_type( $pt );
		}

		// Stable sort by slug so consumers can compare diffs across calls
		// without seeing arbitrary reordering.
		usort(
			$payload,
			static function ( array $a, array $b ): int {
				return strcmp( (string) $a['slug'], (string) $b['slug'] );
			}
		);

		return new \WP_REST_Response(
			[
				'ok'         => true,
				'post_types' => $payload,
			],
			200
		);
	}

	/**
	 * Flatten a registered WP post type into the catalog row shape the
	 * onboarding wizard consumes.
	 *
	 * @return array<string, mixed>
	 */
	private static function describe_post_type( \WP_Post_Type $pt ): array {
		$slug      = (string) $pt->name;
		$rest_base = ! empty( $pt->rest_base ) ? (string) $pt->rest_base : $slug;

		// Labels can be absent on weirdly-registered types. Fall back to
		// the slug rather than null, matching Registry::derive_config_from_post_type.
		$labels         = $pt->labels;
		$plural_label   = is_object( $labels ) && ! empty( $labels->name )
			? (string) $labels->name
			: ucwords( str_replace( [ '-', '_' ], ' ', $slug ) );
		$singular_label = is_object( $labels ) && ! empty( $labels->singular_name )
			? (string) $labels->singular_name
			: $plural_label;

		return [
			'slug'           => $slug,
			'rest_base'      => $rest_base,
			'plural_label'   => $plural_label,
			'singular_label' => $singular_label,
			'is_builtin'     => (bool) $pt->_builtin,
			'hierarchical'   => (bool) $pt->hierarchical,
			'count'          => self::count_for( $slug ),
		];
	}

	/**
	 * Sum the editor-visible post statuses for a given post type.
	 *
	 * `wp_count_posts()` returns an object keyed by status; we sum a fixed
	 * set rather than `array_sum(get_object_vars($counts))` because that
	 * would include `trash` and `auto-draft`, neither of which represent
	 * content the agency would consider "owned."
	 */
	private static function count_for( string $slug ): int {
		$counts = wp_count_posts( $slug );
		if ( ! is_object( $counts ) ) {
			return 0;
		}
		$total = 0;
		foreach ( self::COUNTED_STATUSES as $status ) {
			if ( isset( $counts->$status ) ) {
				$total += (int) $counts->$status;
			}
		}
		return $total;
	}
}
