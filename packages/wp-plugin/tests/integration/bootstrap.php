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

$wp_tests_dir = getenv( 'WP_TESTS_DIR' )
    ?: '/var/www/html/wp-content/plugins/wordpress-develop/tests/phpunit';

if ( ! is_dir( $wp_tests_dir ) ) {
    throw new RuntimeException(
        'WP_TESTS_DIR not found at ' . $wp_tests_dir . '. '
        . 'This bootstrap expects to run inside the wp-env tests-cli container.'
    );
}

require_once $wp_tests_dir . '/includes/functions.php';

// Register the plugin loader BEFORE the test framework bootstrap loads WP.
// This is the canonical pattern: tests_add_filter() queues the callback so it
// fires during the muplugins_loaded action, which the test framework triggers
// after it has set up the DB but before plugins activate.
tests_add_filter( 'muplugins_loaded', static function (): void {
    require_once dirname( __DIR__, 2 ) . '/wp-headless-kit.php';
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
