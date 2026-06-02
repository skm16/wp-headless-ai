<?php
/**
 * Integration test bootstrap for the wp-plugin integration suite.
 *
 * Runs INSIDE the wp-env tests-cli container. The container provides:
 *   - WordPress core at /var/www/html
 *   - The plugin mounted at /var/www/html/wp-content/plugins/wp-plugin
 *   - The WP PHPUnit test library at $WP_TESTS_DIR (env var)
 *   - The mu-plugin fixture at /var/www/html/wp-content/mu-plugins/jab-test-fixtures.php
 *
 * Bootstrap ORDER matters: requiring wp-load.php directly bypasses the test
 * framework's install / reset lifecycle and produces dirty-state cross-test
 * bleed plus "Cannot modify header information" warnings. The pattern below
 * is what WordPress core's own test suite uses.
 *
 * @package Jab\WpHeadlessKit\Tests\Integration
 */

declare( strict_types=1 );

// wp-env's tests-cli container places the WP PHPUnit test suite at /wordpress-phpunit.
// The legacy path (wordpress-develop plugin) is a fallback for non-wp-env setups.
$wp_tests_dir = getenv( 'WP_TESTS_DIR' ) ?: '/wordpress-phpunit';
if ( ! is_dir( $wp_tests_dir ) ) {
    $wp_tests_dir = '/var/www/html/wp-content/plugins/wordpress-develop/tests/phpunit';
}

if ( ! is_dir( $wp_tests_dir ) ) {
    throw new RuntimeException(
        'WP_TESTS_DIR not found. '
        . 'This bootstrap expects to run inside the wp-env tests-cli container.'
    );
}

// Tell the WP test bootstrap where our copy of PHPUnit Polyfills lives so it
// does not have to search for it relative to /wordpress-phpunit (which is a
// standalone library, not part of the develop tree).
if ( ! defined( 'WP_TESTS_PHPUNIT_POLYFILLS_PATH' ) ) {
    define(
        'WP_TESTS_PHPUNIT_POLYFILLS_PATH',
        dirname( __DIR__, 2 ) . '/vendor/yoast/phpunit-polyfills'
    );
}

require_once $wp_tests_dir . '/includes/functions.php';

// Register the plugin loader BEFORE the test framework bootstrap loads WP.
// This is the canonical pattern: tests_add_filter() queues the callback so it
// fires during the muplugins_loaded action, which the test framework triggers
// after it has set up the DB but before plugins activate.
tests_add_filter( 'muplugins_loaded', static function (): void {
    require_once dirname( __DIR__, 2 ) . '/wp-headless-kit.php';

    // Suppress mcp-adapter's default MCP server in the integration suite.
    //
    // McpAdapter::init() hooks `rest_api_init` (priority 15) and only THEN
    // adds its `wp_abilities_api_init` callback that registers
    // `mcp-adapter/discover-abilities` and siblings. By that point
    // `wp_abilities_api_init` has already fired during `init`, so those
    // abilities never register. The subsequent `mcp_adapter_init` action
    // (fired by McpAdapter::init() one line later) calls
    // DefaultServerFactory::create() → McpComponentRegistry::register_tools(),
    // which looks the missing abilities up by name and triggers
    // `WP_Abilities_Registry::get_registered` _doing_it_wrong notices.
    //
    // In production those notices are non-fatal (mcp-adapter logs them and
    // skips tool registration). Inside WP_UnitTestCase the framework
    // converts unexpected `_doing_it_wrong` calls into test failures. Phase
    // 1 has no test that exercises the MCP server, so we skip building it.
    // Phase 1.x MCP-surface tests will need to remove this filter and
    // either drive registration order deliberately or expect the notices.
    add_filter( 'mcp_adapter_create_default_server', '__return_false' );
} );

// Load the test framework's bootstrap. This is what actually loads WordPress,
// runs the install/upgrade lifecycle, and fires the action chain.
require_once $wp_tests_dir . '/includes/bootstrap.php';

// Plugin composer autoloader for production classes (Jab\WpHeadlessKit\*).
require_once dirname( __DIR__, 2 ) . '/vendor/autoload.php';

// Integration test base class is NOT picked up by composer.json's autoload-dev
// (which maps Jab\WpHeadlessKit\Tests\ to tests/unit/ only). Two options were
// considered: (a) extend autoload-dev to cover tests/integration/, or
// (b) require the base class directly from this bootstrap. Picked (b) because
// it keeps composer.json's psr-4 mapping focused on the unit suite and makes
// the integration-side classpath explicit.
require_once __DIR__ . '/IntegrationTestCase.php';
