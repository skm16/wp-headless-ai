<?php
/**
 * MenusAbility — exposes WordPress nav menus via the Abilities API / MCP Adapter.
 *
 * Returns every registered nav menu plus its items as a flat list with
 * parent_id pointers. The flat shape is intentional: the abilities API
 * JSON Schema validator is a subset of v4 and does not reliably support
 * self-referential `$ref`, so a recursive tree shape is fragile. Consumers
 * can build a tree client-side from `parent_id`.
 *
 * Each menu also carries `locations` — the theme-registered locations
 * (e.g. "primary", "footer") it is assigned to. Without these, a headless
 * frontend cannot tell which menu is "the header" without hard-coding
 * by slug.
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Abilities;

defined( 'ABSPATH' ) || exit;

final class MenusAbility {

	public const CATEGORY = 'jab-content';
	public const NAME     = 'jab/get-menus';

	public static function register(): void {
		wp_register_ability(
			self::NAME,
			[
				'label'               => __( 'Get Nav Menus', 'wp-headless-kit' ),
				'description'         => __( 'Returns every registered WordPress nav menu with its items as a flat list and the theme locations each menu is assigned to. Items carry parent_id so consumers can rebuild the tree client-side.', 'wp-headless-kit' ),
				'category'            => self::CATEGORY,
				'input_schema'        => self::input_schema(),
				'output_schema'       => self::output_schema(),
				'execute_callback'    => [ self::class, 'execute' ],
				'permission_callback' => [ self::class, 'can_read' ],
				'meta'                => [
					'mcp' => [
						'public' => true,
					],
				],
			]
		);
	}

	public static function can_read(): bool {
		return current_user_can( 'read' );
	}

	/**
	 * @param array<string, mixed> $input
	 * @return array{menus: array<int, array<string, mixed>>}
	 */
	public static function execute( array $input ): array { // phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter.Found -- input intentionally empty for v1
		// Flip the wp_get_nav_menu_locations() map (location => menu_id) to
		// (menu_id => string[]) so each menu can list its locations directly.
		$locations_by_menu = [];
		foreach ( (array) get_nav_menu_locations() as $location => $menu_id ) {
			$locations_by_menu[ (int) $menu_id ][] = (string) $location;
		}

		$menus = wp_get_nav_menus();

		return [
			'menus' => array_map(
				static function ( \WP_Term $menu ) use ( $locations_by_menu ): array {
					return self::shape_menu( $menu, $locations_by_menu[ (int) $menu->term_id ] ?? [] );
				},
				is_array( $menus ) ? $menus : []
			),
		];
	}

	/**
	 * @param string[] $locations Theme locations this menu is assigned to.
	 * @return array<string, mixed>
	 */
	private static function shape_menu( \WP_Term $menu, array $locations ): array {
		$raw_items = wp_get_nav_menu_items( $menu->term_id );

		return [
			'id'        => (int) $menu->term_id,
			'slug'      => (string) $menu->slug,
			'name'      => (string) $menu->name,
			'locations' => array_values( $locations ),
			'items'     => is_array( $raw_items )
				? array_map( [ self::class, 'shape_item' ], $raw_items )
				: [],
		];
	}

	/**
	 * @param object $item Menu item — a WP_Post-shaped object enriched by WP with menu fields.
	 * @return array<string, mixed>
	 */
	private static function shape_item( $item ): array {
		return [
			'id'          => (int) $item->ID,
			'title'       => (string) $item->title,
			'url'         => (string) $item->url,
			'target'      => (string) ( $item->target ?? '' ),
			'object_type' => (string) ( $item->object ?? '' ),
			'object_id'   => isset( $item->object_id ) ? (int) $item->object_id : 0,
			'parent_id'   => isset( $item->menu_item_parent ) ? (int) $item->menu_item_parent : 0,
			'order'       => isset( $item->menu_order ) ? (int) $item->menu_order : 0,
		];
	}

	/**
	 * @return array<string, mixed>
	 */
	private static function input_schema(): array {
		// No input parameters in v1. With additionalProperties: false and no
		// `properties` key, only the empty object {} satisfies this schema.
		return [
			'type'                 => 'object',
			'additionalProperties' => false,
		];
	}

	/**
	 * @return array<string, mixed>
	 */
	private static function output_schema(): array {
		return [
			'type'       => 'object',
			'required'   => [ 'menus' ],
			'properties' => [
				'menus' => [
					'type'  => 'array',
					'items' => [
						'type'       => 'object',
						'required'   => [ 'id', 'slug', 'name', 'locations', 'items' ],
						'properties' => [
							'id'        => [ 'type' => 'integer' ],
							'slug'      => [ 'type' => 'string' ],
							'name'      => [ 'type' => 'string' ],
							'locations' => [
								'type'        => 'array',
								'description' => __( 'Theme-registered menu locations (e.g. "primary", "footer") this menu is assigned to.', 'wp-headless-kit' ),
								'items'       => [ 'type' => 'string' ],
							],
							'items'     => [
								'type'        => 'array',
								'description' => __( 'Flat list of menu items. Use parent_id to reconstruct the tree.', 'wp-headless-kit' ),
								'items'       => [
									'type'       => 'object',
									'required'   => [ 'id', 'title', 'url', 'target', 'object_type', 'object_id', 'parent_id', 'order' ],
									'properties' => [
										'id'          => [ 'type' => 'integer' ],
										'title'       => [ 'type' => 'string' ],
										'url'         => [
											'type'   => 'string',
											'format' => 'uri',
										],
										'target'      => [
											'type'        => 'string',
											'description' => __( 'Link target. Empty string for same-window, "_blank" for new window.', 'wp-headless-kit' ),
										],
										'object_type' => [
											'type'        => 'string',
											'description' => __( 'WP object kind: "post", "page", "category", "custom", etc.', 'wp-headless-kit' ),
										],
										'object_id'   => [
											'type'        => 'integer',
											'description' => __( 'ID of the linked WP object, when applicable. 0 for custom URLs.', 'wp-headless-kit' ),
										],
										'parent_id'   => [
											'type'        => 'integer',
											'description' => __( 'ID of the parent menu item. 0 for top-level items.', 'wp-headless-kit' ),
										],
										'order'       => [
											'type'        => 'integer',
											'description' => __( 'Item order within its parent.', 'wp-headless-kit' ),
										],
									],
								],
							],
						],
					],
				],
			],
		];
	}
}
