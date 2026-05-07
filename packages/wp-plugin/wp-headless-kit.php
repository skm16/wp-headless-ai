<?php
/**
 * Plugin Name:       wp-headless-kit
 * Plugin URI:        https://github.com/seankylemanley/wp-headless-kit
 * Description:       Exposes WordPress content as MCP abilities so headless, AI-iterable frontends can read this site through the Model Context Protocol.
 * Version:           0.1.0
 * Requires at least: 6.6
 * Requires PHP:      7.4
 * Author:            SKM
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       wp-headless-kit
 *
 * @package Skm\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Skm\WpHeadlessKit;

defined( 'ABSPATH' ) || exit;

const VERSION = '0.1.0';

define( 'SKM_WPHK_FILE', __FILE__ );
define( 'SKM_WPHK_DIR', plugin_dir_path( __FILE__ ) );

$skm_wphk_autoloader = SKM_WPHK_DIR . 'vendor/autoload_packages.php';

if ( ! file_exists( $skm_wphk_autoloader ) ) {
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

require_once $skm_wphk_autoloader;

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
} );
