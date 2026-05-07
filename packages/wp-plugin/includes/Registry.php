<?php
/**
 * Registry — declares the abilities this plugin exposes and orchestrates registration.
 *
 * This is where the "what abilities does this site offer?" list lives. Adding a new
 * CPT-list ability is a one-entry addition to {@see self::ability_configs()}; no new
 * file required. Other ability shapes (menus, ACF field groups) will get their own
 * factories alongside PostTypeListAbility and dispatch from this same registry.
 *
 * @package Skm\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Skm\WpHeadlessKit;

use Skm\WpHeadlessKit\Abilities\MenusAbility;
use Skm\WpHeadlessKit\Abilities\PostTypeListAbility;

defined( 'ABSPATH' ) || exit;

final class Registry {

	/**
	 * Hooked to `wp_abilities_api_categories_init`.
	 */
	public static function register_categories(): void {
		wp_register_ability_category(
			PostTypeListAbility::CATEGORY,
			[
				'label'       => __( 'SKM — Content', 'wp-headless-kit' ),
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
		}

		// Non-CPT-list abilities. Each has its own self-contained class for
		// now; we'll factor common shapes out only when a second ability of
		// the same shape appears.
		MenusAbility::register();
	}

	/**
	 * The full list of CPT-list abilities this plugin exposes.
	 *
	 * To add a new CPT-list ability, add an entry here. Required keys are documented
	 * on {@see PostTypeListAbility::register()}.
	 *
	 * Method (not constant) so the translatable strings get resolved at call time.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	private static function ability_configs(): array {
		return [
			[
				'name'          => 'skm/get-posts',
				'post_type'     => 'post',
				'label'         => __( 'Get Posts', 'wp-headless-kit' ),
				'description'   => __( 'Retrieves recent published posts as id, title, excerpt, date, slug, and link.', 'wp-headless-kit' ),
				'wrapper_key'   => 'posts',
				'noun'          => 'posts',
				'default_count' => 5,
			],
			[
				'name'          => 'skm/get-beers',
				'post_type'     => 'beer',
				'label'         => __( 'Get Beers', 'wp-headless-kit' ),
				'description'   => __( 'Retrieves entries from the Two Roads `beer` custom post type as id, title, excerpt, date, slug, and link.', 'wp-headless-kit' ),
				'wrapper_key'   => 'beers',
				'noun'          => 'beers',
				'default_count' => 12,
			],
			[
				'name'          => 'skm/get-events',
				'post_type'     => 'event',
				'label'         => __( 'Get Events', 'wp-headless-kit' ),
				'description'   => __( 'Retrieves entries from the Two Roads `event` custom post type as id, title, excerpt, date, slug, and link.', 'wp-headless-kit' ),
				'wrapper_key'   => 'events',
				'noun'          => 'events',
				'default_count' => 10,
			],
			[
				'name'          => 'skm/get-locations',
				'post_type'     => 'location',
				'label'         => __( 'Get Locations', 'wp-headless-kit' ),
				'description'   => __( 'Retrieves entries from the Two Roads `location` custom post type as id, title, excerpt, date, slug, and link.', 'wp-headless-kit' ),
				'wrapper_key'   => 'locations',
				'noun'          => 'locations',
				'default_count' => 25,
			],
			[
				'name'          => 'skm/get-team',
				'post_type'     => 'team',
				'label'         => __( 'Get Team', 'wp-headless-kit' ),
				'description'   => __( 'Retrieves entries from the Two Roads `team` custom post type as id, title, excerpt, date, slug, and link.', 'wp-headless-kit' ),
				'wrapper_key'   => 'team',
				'noun'          => 'team members',
				'default_count' => 25,
			],
			[
				'name'          => 'skm/get-distributors',
				'post_type'     => 'distributor',
				'label'         => __( 'Get Distributors', 'wp-headless-kit' ),
				'description'   => __( 'Retrieves entries from the Two Roads `distributor` custom post type as id, title, excerpt, date, slug, and link.', 'wp-headless-kit' ),
				'wrapper_key'   => 'distributors',
				'noun'          => 'distributors',
				'default_count' => 25,
			],
			[
				'name'          => 'skm/get-food',
				'post_type'     => 'food',
				'label'         => __( 'Get Food', 'wp-headless-kit' ),
				'description'   => __( 'Retrieves entries from the Two Roads `food` custom post type (labeled "Food Trucks" in admin) as id, title, excerpt, date, slug, and link.', 'wp-headless-kit' ),
				'wrapper_key'   => 'food',
				'noun'          => 'food items',
				'default_count' => 25,
			],
			[
				'name'          => 'skm/get-food-truck-events',
				'post_type'     => 'food-truck-event',
				'label'         => __( 'Get Food Truck Events', 'wp-headless-kit' ),
				'description'   => __( 'Retrieves entries from the Two Roads `food-truck-event` custom post type. ACF fields cover recurrence (is_reoccurring, days_of_the_week), dates (start_date, end_date, reoccurring_start_date, reoccurring_end_date), display color, and external URL.', 'wp-headless-kit' ),
				'wrapper_key'   => 'food_truck_events',
				'noun'          => 'food truck events',
				'default_count' => 25,
			],
			[
				'name'          => 'skm/get-flavors',
				'post_type'     => 'flavor',
				'label'         => __( 'Get Flavors', 'wp-headless-kit' ),
				'description'   => __( 'Retrieves entries from the Two Roads `flavor` custom post type (NewRoads Flavors). Shares the Beers ACF field group, so the same product fields (abv, ibu, srm, description, etc.) apply.', 'wp-headless-kit' ),
				'wrapper_key'   => 'flavors',
				'noun'          => 'flavors',
				'default_count' => 25,
			],
			[
				'name'          => 'skm/get-coas',
				'post_type'     => 'coa',
				'label'         => __( 'Get Certificates of Analysis', 'wp-headless-kit' ),
				'description'   => __( 'Retrieves entries from the Two Roads `coa` custom post type (Certificates of Analysis).', 'wp-headless-kit' ),
				'wrapper_key'   => 'coas',
				'noun'          => 'certificates of analysis',
				'default_count' => 25,
			],
		];
	}
}
