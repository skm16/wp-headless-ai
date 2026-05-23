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
use Jab\WpHeadlessKit\Abilities\TaxonomyTermsAbility;

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
	 * WP taxonomy slugs that should never get standalone term-list abilities.
	 * post_format is presentation-only; the rest are WP navigation internals.
	 *
	 * Override via the `jab/headless_kit/taxonomy_excludes` filter.
	 */
	private const DEFAULT_TAXONOMY_EXCLUDES = [
		'post_format',
		'nav_menu',
		'link_category',
		'wp_pattern_category',
	];

	/**
	 * Names already claimed in this request. Used by ensure_unique_name() to
	 * resolve BUG-2 collisions deterministically (suffix `-2`, `-3`, …).
	 *
	 * @var array<string, bool>
	 */
	private static $claimed_names = [];

	/**
	 * Hooked to `wp_abilities_api_init`.
	 */
	public static function register_abilities(): void {
		self::$claimed_names = [];

		foreach ( self::ability_configs() as $config ) {
			$config['name']        = self::ensure_unique_name( (string) ( $config['name'] ?? '' ) );
			$config['name_single'] = self::ensure_unique_name( (string) ( $config['name_single'] ?? '' ) );
			PostTypeListAbility::register( $config );

			$by_slug_config         = self::derive_by_slug_config( $config );
			$by_slug_config['name'] = self::ensure_unique_name( (string) ( $by_slug_config['name'] ?? '' ) );
			PostTypeBySlugAbility::register( $by_slug_config );
		}

		self::register_taxonomy_abilities();
		MenusAbility::register();
	}

	/**
	 * Reserve an ability name, suffixing `-2`, `-3`, … on collision so two
	 * configs that resolve to the same name don't silently overwrite each
	 * other in the abilities registry.
	 *
	 * The collision itself is almost always an agency-side mistake (two
	 * CPTs sharing a `rest_base`, or an ability_configs filter that doesn't
	 * differentiate), so we _doing_it_wrong() to surface it loudly while
	 * keeping the site functional.
	 */
	public static function ensure_unique_name( string $name ): string {
		if ( '' === $name ) {
			return $name;
		}
		if ( empty( self::$claimed_names[ $name ] ) ) {
			self::$claimed_names[ $name ] = true;
			return $name;
		}
		$suffix    = 2;
		$candidate = $name . '-' . $suffix;
		while ( ! empty( self::$claimed_names[ $candidate ] ) ) {
			++$suffix;
			$candidate = $name . '-' . $suffix;
		}
		self::$claimed_names[ $candidate ] = true;

		if ( function_exists( '_doing_it_wrong' ) ) {
			_doing_it_wrong(
				'Jab\\WpHeadlessKit\\Registry::register_abilities',
				esc_html( sprintf(
					/* translators: 1: colliding ability name, 2: deduplicated name. */
					__( 'Ability name "%1$s" was already registered this request; using "%2$s" instead. Check your jab/headless_kit/ability_configs filter and your CPT/taxonomy rest_base values.', 'wp-headless-kit' ),
					$name,
					$candidate
				) ),
				'0.4.0'
			);
		}

		return $candidate;
	}

	/**
	 * Auto-discover every public taxonomy and register a TaxonomyTermsAbility
	 * for each one. Mirrors the CPT discovery pattern.
	 *
	 * Agencies can exclude taxonomies via:
	 *
	 *   add_filter( 'jab/headless_kit/taxonomy_excludes', function ( $excludes ) {
	 *       $excludes[] = 'private_tax';
	 *       return $excludes;
	 *   } );
	 */
	private static function register_taxonomy_abilities(): void {
		/**
		 * Filter the list of taxonomy slugs to skip during auto-discovery.
		 *
		 * @param string[] $excludes Default exclusion list.
		 */
		$excludes = (array) apply_filters(
			'jab/headless_kit/taxonomy_excludes',
			self::DEFAULT_TAXONOMY_EXCLUDES
		);

		$taxonomies = get_taxonomies( [ 'public' => true ], 'objects' );

		foreach ( $taxonomies as $slug => $taxonomy ) {
			if ( in_array( (string) $slug, $excludes, true ) ) {
				continue;
			}
			TaxonomyTermsAbility::register( $taxonomy, [ self::class, 'ensure_unique_name' ] );
		}
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
	private static function derive_config_from_post_type( \WP_Post_Type $post_type_object ): array {
		$slug   = (string) $post_type_object->name;
		$labels = $post_type_object->labels ?? null;

		// API-1: ability NAME + wrapper_key derive from the post type's slug
		// (and WP's own `rest_base`), not from editor-editable labels. Labels
		// stay label-derived because they're human-facing — they're allowed
		// to be locale-specific and to change. Names are the stable public
		// contract MCP clients call against.
		//
		// `rest_base` is WP's canonical pluralization of the post type for
		// REST routes (e.g. `post` → `posts`, `coa` → `coas`). When it's not
		// set (rare; some legacy CPTs), fall back to the slug itself —
		// `jab/get-<slug>` is semantically clear enough and never collides.
		$rest_base      = ! empty( $post_type_object->rest_base ) ? (string) $post_type_object->rest_base : $slug;
		$plural_kebab   = self::to_kebab_case( $rest_base );
		$singular_kebab = self::to_kebab_case( $slug );
		$wrapper_plural = self::to_snake_case( $rest_base );
		$wrapper_single = self::to_snake_case( $slug );

		$plural_label   = is_object( $labels ) && ! empty( $labels->name ) ? (string) $labels->name : ucwords( str_replace( [ '-', '_' ], ' ', $slug ) );
		$singular_label = is_object( $labels ) && ! empty( $labels->singular_name ) ? (string) $labels->singular_name : $plural_label;

		return [
			'name'               => 'jab/get-' . $plural_kebab,
			'name_single'        => 'jab/get-' . $singular_kebab,
			'post_type'          => $slug,
			'label'              => sprintf(
				/* translators: %s: post type plural label (e.g. "Posts", "Beers"). */
				__( 'Get %s', 'wp-headless-kit' ),
				$plural_label
			),
			'description'        => sprintf(
				/* translators: %s: post type singular label (e.g. "post", "beer"). */
				__( 'Retrieves entries from the %s post type as id, title, excerpt, date, slug, link, and (when ACF fields apply) acf.', 'wp-headless-kit' ),
				strtolower( $singular_label )
			),
			'wrapper_key'        => $wrapper_plural,
			'wrapper_key_single' => $wrapper_single,
			'noun'               => strtolower( $plural_label ),
			'noun_single'        => strtolower( $singular_label ),
			'default_count'      => self::DEFAULT_LIST_COUNT,
		];
	}

	/**
	 * Lowercase, replace whitespace and dashes with underscores. Used to
	 * produce JSON-friendly wrapper keys ("food trucks" → "food_trucks",
	 * "food-trucks" → "food_trucks").
	 */
	private static function to_snake_case( string $s ): string {
		$s = preg_replace( '/[\s\-]+/', '_', strtolower( $s ) );
		return is_string( $s ) ? $s : '';
	}

	/**
	 * Lowercase, replace whitespace and underscores with dashes. Used to
	 * produce slugified ability-name segments ("food_trucks" → "food-trucks").
	 */
	private static function to_kebab_case( string $s ): string {
		$s = preg_replace( '/[\s_]+/', '-', strtolower( $s ) );
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
		// Prefer the pre-derived singular ability name from
		// derive_config_from_post_type(); fall back to a slug-only derivation
		// for any agency-injected configs that don't carry `name_single`.
		$name_base = isset( $config['name_single'] ) && '' !== $config['name_single']
			? (string) $config['name_single']
			: 'jab/get-' . self::to_kebab_case( $post_type );

		return [
			'name'        => $name_base . '-by-slug',
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
