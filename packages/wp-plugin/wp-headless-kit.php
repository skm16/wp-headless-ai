<?php
/**
 * Plugin Name:       JAB WP
 * Plugin URI:        https://github.com/jab-wp/wp-headless-kit
 * Description:       Exposes WordPress content as MCP abilities so headless, AI-iterable frontends can read this site through the Model Context Protocol.
 * Version:           0.7.0
 * Requires at least: 6.9
 * Requires PHP:      7.4
 * Author:            Sean Roberts
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       wp-headless-kit
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit;

defined( 'ABSPATH' ) || exit;

const VERSION = '0.7.0';

define( 'JAB_WPHK_FILE', __FILE__ );
define( 'JAB_WPHK_DIR', plugin_dir_path( __FILE__ ) );

$jab_wphk_autoloader = JAB_WPHK_DIR . 'vendor/autoload_packages.php';

if ( ! file_exists( $jab_wphk_autoloader ) ) {
	add_action(
		'admin_notices',
		static function () {
			printf(
				'<div class="notice notice-error"><p><strong>%s</strong> %s</p></div>',
				esc_html__( 'wp-headless-kit:', 'wp-headless-kit' ),
				esc_html__( 'Composer dependencies are missing. Run "composer install" inside the plugin directory.', 'wp-headless-kit' )
			);
		}
	);
	return;
}

require_once $jab_wphk_autoloader;

add_action( 'plugins_loaded', static function (): void {
	if ( ! class_exists( \WP\MCP\Core\McpAdapter::class ) ) {
		add_action(
			'admin_notices',
			static function () {
				printf(
					'<div class="notice notice-error"><p><strong>%s</strong> %s</p></div>',
					esc_html__( 'wp-headless-kit:', 'wp-headless-kit' ),
					esc_html__( 'WP\\MCP\\Core\\McpAdapter is not available. Verify wordpress/mcp-adapter is installed and that no other plugin is loading an incompatible version.', 'wp-headless-kit' )
				);
			}
		);
		return;
	}

	\WP\MCP\Core\McpAdapter::instance();

	add_action( 'wp_abilities_api_categories_init', [ Registry::class, 'register_categories' ] );
	add_action( 'wp_abilities_api_init', [ Registry::class, 'register_abilities' ] );

	/*
	 * REST namespace at `/wp-json/jab/v1/`. Four routes:
	 *   - `/`               — Health probe for the wizard's Verify install button.
	 *   - `/content-types`  — Auth'd catalog of post types + real counts,
	 *                         consumed by the wizard's ownership picker.
	 *   - `/manifest`       — Auth'd full ability roster (names + schemas)
	 *                         for the CLI's `jab sync` type generator.
	 *   - `/site`           — Auth'd site shape (front page, branding,
	 *                         menu locations, image sizes, theme) for the
	 *                         SaaS onboarding flow and CLI scaffold.
	 */
	add_action(
		'rest_api_init',
		static function (): void {
			Rest\Health::register();
			Rest\ContentTypes::register();
			Rest\Manifest::register();
			Rest\SiteManifest::register();
		}
	);
} );
