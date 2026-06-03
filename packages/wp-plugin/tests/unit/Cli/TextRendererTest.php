<?php
declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Tests\Cli;

use Jab\WpHeadlessKit\Cli\TextRenderer;
use PHPUnit\Framework\TestCase;

final class TextRendererTest extends TestCase {

    /**
     * Single golden-output test fixture. Exercises every section of the
     * renderer — facts (including post_types object value and the ACF
     * detail note), checks (one of each severity), and the summary line.
     */
    public function test_renders_report_as_the_specified_text_block(): void {
        $report = [
            'plugin_version' => '0.7.1',
            'generated_at'   => '2026-06-02T20:15:00Z',
            'summary'        => [ 'pass' => 4, 'warn' => 1, 'fail' => 1 ],
            'facts' => [
                [ 'id' => 'plugin_version',       'label' => 'Plugin version',         'value' => '0.7.1' ],
                [ 'id' => 'wp_version',           'label' => 'WordPress version',      'value' => '6.9.0' ],
                [ 'id' => 'php_version',          'label' => 'PHP version',            'value' => '8.3.7' ],
                [ 'id' => 'registered_abilities', 'label' => 'Registered JAB abilities', 'value' => 2, 'detail' => [ 'jab/get-pages', 'jab/get-posts' ] ],
                [ 'id' => 'post_types',           'label' => 'Public post types',      'value' => [ 'included' => [ 'page', 'post' ], 'excluded' => [ 'attachment' ] ] ],
                [ 'id' => 'taxonomies',           'label' => 'Public taxonomies',      'value' => [ 'included' => [ 'category' ],     'excluded' => [ 'nav_menu' ] ] ],
                [ 'id' => 'capability_filters',   'label' => 'Capability filter values', 'value' => [
                    'jab/headless_kit/ability_capability'       => 'read',
                    'jab/headless_kit/diagnostics_capability'   => 'manage_options',
                    'jab/headless_kit/manifest_capability'      => 'read',
                    'jab/headless_kit/site_manifest_capability' => 'edit_posts',
                ] ],
                [ 'id' => 'acf', 'label' => 'ACF', 'value' => [
                    'active' => false, 'pro' => false, 'version' => null,
                    'diagnostics_enabled' => false, 'skipped_groups' => [], 'dropped_fields' => [],
                ], 'detail' => 'Run `wp jab doctor --debug-acf` to populate.' ],
            ],
            'checks' => [
                [ 'id' => 'abilities_api',                 'label' => 'Abilities API loaded',                  'severity' => 'pass', 'message' => 'wp_register_ability() is available.' ],
                [ 'id' => 'mcp_adapter',                   'label' => 'MCP Adapter loaded',                    'severity' => 'fail', 'message' => 'wordpress/mcp-adapter is not loaded.' ],
                [ 'id' => 'rest_routes_registered',        'label' => 'JAB REST routes registered',            'severity' => 'pass', 'message' => '5/5 routes present.' ],
                [ 'id' => 'post_types_discovered',         'label' => 'At least one public post type discovered', 'severity' => 'pass', 'message' => '2 discovered.' ],
                [ 'id' => 'application_passwords_enabled', 'label' => 'Application Passwords enabled',         'severity' => 'warn', 'message' => 'Disabled.', 'detail' => 'is_ssl()=false' ],
                [ 'id' => 'acf_no_schema_skips',           'label' => 'No ACF schema skips',                   'severity' => 'pass', 'message' => 'Tracking off — no data to report.' ],
            ],
        ];

        $expected = <<<TEXT
JAB Headless Kit — Diagnostics

Plugin                0.7.1
WordPress             6.9.0
PHP                   8.3.7
Registered abilities  2 (jab/get-pages, jab/get-posts)
Public post types     2 included (page, post) · 1 excluded (attachment)
Public taxonomies     1 included (category) · 1 excluded (nav_menu)
Capability filters
  ability_capability          read
  diagnostics_capability      manage_options
  manifest_capability         read
  site_manifest_capability    edit_posts
ACF                   inactive
                      Run `wp jab doctor --debug-acf` to populate.

Checks
  pass  Abilities API loaded                  wp_register_ability() is available.
  fail  MCP Adapter loaded                    wordpress/mcp-adapter is not loaded.
  pass  JAB REST routes registered            5/5 routes present.
  pass  At least one public post type discovered  2 discovered.
  warn  Application Passwords enabled         Disabled.
        is_ssl()=false
  pass  No ACF schema skips                   Tracking off — no data to report.

Summary               4 pass · 1 warn · 1 fail
TEXT;

        $this->assertSame( $expected, TextRenderer::render( $report ) );
    }
}
