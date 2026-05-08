<?php
/**
 * Registry — declares the abilities this plugin exposes and orchestrates registration.
 *
 * Default behavior is **zero-config auto-discovery**: every WordPress post type
 * registered with `public => true` (minus the obvious internals like attachments,
 * revisions, and ACF's own field-storage types) gets two abilities — list and
 * by-slug — produced from its labels and slug.
 *
 * Agencies customize via filters from a single mu-plugin file:
 *
 *   add_filter( 'jab/headless_kit/post_type_excludes', function ( $excludes ) {
 *       $excludes[] = 'private_cpt';
 *       return $excludes;
 *   } );
 *
 *   add_filter( 'jab/headless_kit/ability_configs', function ( $configs ) {
 *       foreach ( $configs as &$cfg ) {
 *           if ( $cfg['post_type'] === 'coa' ) {
 *               $cfg['noun_single'] = 'certificate of analysis';
 *               $cfg['description'] = '...detailed override...';
 *           }
 *       }
 *       return $configs;
 *   } );
 *
 * Adding a non-CPT-list ability (e.g. menus, ACF options pages) still happens
 * here in `register_abilities()` — those have their own factory classes and
 * don't pass through ability_configs.
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit;

use Jab\WpHeadlessKit\Abilities\MenusAbility;
use Jab\WpHeadlessKit\Abilities\PostTypeBySlugAbility;
use Jab\WpHeadlessKit\Abilities\PostTypeListAbility;

defined( 'ABSPATH' ) || exit;

final class Registry {

	/**
	 * WP-internal post types that should never get headless abilities. These
	 * are the noisy defaults — attachments (covered by media APIs), revisions
	 * (history, not content), nav menu items (covered by jab/get-menus), and
	 * the WordPress 5.8+ block-editor / FSE machinery (templates, parts,
	 * navigations, global styles). ACF's own field-storage post types
	 * (`acf-field-group`, `acf-field`) are excluded too — they're metadata
	 * about ACF, not content authors edit as posts.
	 *
	 * Override via the `jab/headless_kit/post_type_excludes` filter.
	 */
	private const DEFAULT_POST_TYPE_EXCLUDES = [
		'attachment',
		'revision',
		'nav_menu_item',
		'custom_css',
		'customize_changeset',
		'oembed_cache',
		'user_request',
		'wp_block',
		'wp_template',
		'wp_template_part',
		'wp_global_styles',
		'wp_navigation',
		'acf-field-group',
		'acf-field',
	];

	/**
	 * Default cap on items returned by list abilities. Agencies override
	 * per-CPT via the ability_configs filter when a site genuinely needs
	 * a different floor (e.g. blog posts where you want recent-N rather
	 * than all).
	 */
	private const DEFAULT_LIST_COUNT = 25;

	/**
	 * Hooked to `wp_abilities_api_categories_init`.
	 */
	public static function register_categories(): void {
		wp_register_ability_category(
			PostTypeListAbility::CATEGORY,
			[
				'label'       => __( 'Jab — Content', 'wp-headless-kit' ),
				'description' => __( 'Read-only access to WordPress content (posts, CPTs, taxonomies).', 'wp-headless-kit' ),
			]
		);
	}

	/**
	 * Hooked to `wp_abilities_api_init`.
	 */
	public static function register_abilities(): void {
		foreach ( self::ability_configs() as $config ) {
			PostTypeListAbility::register( $config );
			PostTypeBySlugAbility::register( self::derive_by_slug_config( $config ) );
		}

		// Non-CPT-list abilities. Each has its own self-contained class for
		// now; we'll factor common shapes out only when a second ability of
		// the same shape appears.
		MenusAbility::register();
	}

	/**
	 * Auto-discover configs for every public post type, then let agencies
	 * customize via filters.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private static function ability_configs(): array {
		/**
		 * Filter the list of post type slugs to skip during auto-discovery.
		 *
		 * @param string[] $excludes Default exclusion list (WP internals + ACF metadata).
		 */
		$excludes = (array) apply_filters(
			'jab/headless_kit/post_type_excludes',
			self::DEFAULT_POST_TYPE_EXCLUDES
		);

		$configs    = [];
		$post_types = get_post_types( [ 'public' => true ], 'objects' );

		foreach ( $post_types as $slug => $object ) {
			if ( in_array( $slug, $excludes, true ) ) {
				continue;
			}
			$configs[] = self::derive_config_from_post_type( $object );
		}

		/**
		 * Filter the auto-discovered ability configs. Use this to override
		 * descriptions, labels, default_count, or to add/remove individual
		 * post types after the default discovery has run.
		 *
		 * Each config has the keys documented on
		 * {@see PostTypeListAbility::register()}.
		 *
		 * @param array<int, array<string, mixed>> $configs
		 */
		return (array) apply_filters( 'jab/headless_kit/ability_configs', $configs );
	}

	/**
	 * Derive a list-ability config from a registered post type's labels and
	 * slug. Falls back to the slug whenever a label is missing — i.e. this
	 * function never reads from null and never throws on weirdly-registered
	 * CPTs (some plugins skip the labels arg entirely).
	 *
	 * @return array<string, mixed>
	 */
	private static function derive_config_from_post_type( \WP_Post_Type $object ): array {
		$slug   = (string) $object->name;
		$labels = $object->labels ?? null;

		$plural_label   = is_object( $labels ) && ! empty( $labels->name ) ? (string) $labels->name : ucwords( str_replace( [ '-', '_' ], ' ', $slug ) );
		$singular_label = is_object( $labels ) && ! empty( $labels->singular_name ) ? (string) $labels->singular_name : $plural_label;

		$plural_lower   = strtolower( $plural_label );
		$singular_lower = strtolower( $singular_label );

		$wrapper_plural = self::to_snake_case( $plural_lower );
		$wrapper_single = self::to_snake_case( $singular_lower );

		// Ability name uses the plural-derived wrapper (kebab-cased) to match
		// the wrapper key the consumer dereferences. So `jab/get-beers` returns
		// `{ beers: [...] }`, not `jab/get-beer`. The by-slug counterpart
		// (`jab/get-beer-by-slug`) is derived in derive_by_slug_config from
		// the singular form.
		return [
			'name'               => 'jab/get-' . str_replace( '_', '-', $wrapper_plural ),
			'post_type'          => $slug,
			'label'              => sprintf(
				/* translators: %s: post type plural label (e.g. "Posts", "Beers"). */
				__( 'Get %s', 'wp-headless-kit' ),
				$plural_label
			),
			'description'        => sprintf(
				/* translators: %s: post type singular label (e.g. "post", "beer"). */
				__( 'Retrieves entries from the %s post type as id, title, excerpt, date, slug, link, and (when ACF fields apply) acf.', 'wp-headless-kit' ),
				$singular_lower
			),
			'wrapper_key'        => $wrapper_plural,
			'wrapper_key_single' => $wrapper_single,
			'noun'               => $plural_lower,
			'noun_single'        => $singular_lower,
			'default_count'      => self::DEFAULT_LIST_COUNT,
		];
	}

	/**
	 * Lowercase, replace whitespace and dashes with underscores. Used to
	 * produce JSON-friendly wrapper keys ("food trucks" → "food_trucks").
	 */
	private static function to_snake_case( string $s ): string {
		$s = preg_replace( '/[\s\-]+/', '_', $s );
		return is_string( $s ) ? $s : '';
	}

	/**
	 * Derive the by-slug config from a CPT-list config. Keeps the per-CPT
	 * declaration compact — every entry already provides the singular
	 * wrapper key + noun, and this method synthesizes the ability name,
	 * label, and description on the fly.
	 *
	 * @param array<string, mixed> $config
	 * @return array<string, mixed>
	 */
	private static function derive_by_slug_config( array $config ): array {
		$post_type   = (string) $config['post_type'];
		$noun_single = (string) ( $config['noun_single'] ?? $post_type );

		return [
			'name'        => 'jab/get-' . str_replace( '_', '-', $post_type ) . '-by-slug',
			'post_type'   => $post_type,
			'label'       => sprintf(
				/* translators: %s: title-cased singular noun (e.g. "Page", "Beer"). */
				__( 'Get %s By Slug', 'wp-headless-kit' ),
				ucwords( $noun_single )
			),
			'description' => sprintf(
				/* translators: %s: singular noun (e.g. "page", "beer"). */
				__( 'Retrieves a single %s by its slug. Returns the same per-item shape as the list ability for this post type, or null when nothing matches.', 'wp-headless-kit' ),
				$noun_single
			),
			'wrapper_key' => (string) ( $config['wrapper_key_single'] ?? str_replace( '-', '_', $post_type ) ),
			'noun'        => $noun_single,
		];
	}
}
