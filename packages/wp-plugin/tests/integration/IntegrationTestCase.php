<?php
/**
 * IntegrationTestCase — base for every wp-plugin integration test.
 *
 * Extends WP_UnitTestCase (provided by the WP test framework inside the
 * wp-env tests-cli container). The class IS NOT covered by composer.json's
 * autoload-dev mapping (which targets tests/unit/ only); the integration
 * bootstrap requires this file directly.
 *
 * Three behaviors that test files lean on:
 *
 *   1. setUp() deliberately does NOT reset the abilities registry. The
 *      Phase 1 tests are all read-only over the boot-time registry, and any
 *      reset path that re-fires wp_abilities_api_init also re-runs
 *      mcp-adapter's callbacks — which surfaces spurious "ability does not
 *      exist" notices that WP_UnitTestCase converts into failures. See the
 *      inline comment in setUp() for the recipe a future "mutate-and-observe"
 *      test should follow.
 *
 *   2. execute_ability( $name, $input ) is the path for ability-level
 *      regressions (SEC-1, etc.). Looks up the ability via wp_get_ability(),
 *      fails fast on null lookup or WP_Error return.
 *
 *   3. dispatch_rest( $route, $method, $params ) is the path for REST-route
 *      regressions (the manifest smoke). Builds a WP_REST_Request and
 *      dispatches via rest_get_server()->dispatch(). NO HTTP layer — that
 *      means Application Password transport is NOT exercised here.
 *
 * @package Jab\WpHeadlessKit\Tests\Integration
 */

declare( strict_types=1 );

abstract class IntegrationTestCase extends WP_UnitTestCase {

    protected function setUp(): void {
        parent::setUp();

        // No abilities-registry reset here. Two reasons:
        //
        //   1. The Phase 1 tests are pure reads — none of them registers,
        //      unregisters, or mutates an ability mid-test. The Registry's
        //      one boot-time pass over the post-type universe (including the
        //      fixture-supplied `book` CPT) is sufficient for every assertion.
        //
        //   2. Anything that re-fires `wp_abilities_api_init` triggers
        //      mcp-adapter's callback chain a second time. Re-registration
        //      churn there surfaces "ability '...' does not exist" notices
        //      from McpComponentRegistry::register_ability_tool when the
        //      manifest/REST path subsequently builds the MCP server — and
        //      WP_UnitTestCase converts those into failures.
        //
        // If a future test genuinely needs to add a CPT mid-test and observe
        // the resulting ability, it should call wp_register_post_type() and
        // then invoke \Jab\WpHeadlessKit\Registry::register_abilities() inside
        // a do_action('wp_abilities_api_init') wrapper of its own.
    }

    /**
     * Invoke a JAB ability end-to-end.
     *
     * Exercises input validation → permission_callback → execute_callback →
     * output schema validation. Returns whatever the ability's execute()
     * returned (signature is `mixed|WP_Error`); fails the test fast on null
     * lookup or a WP_Error return so tests don't have to defensively type-check.
     *
     * @param string                $name  Fully-qualified ability name (e.g. "jab/get-posts").
     * @param array<string, mixed>  $input
     * @return mixed
     */
    protected function execute_ability( string $name, array $input = [] ) {
        $ability = function_exists( 'wp_get_ability' ) ? wp_get_ability( $name ) : null;

        $this->assertNotNull(
            $ability,
            sprintf( 'Ability "%s" is not registered. Did setUp() reset the registry, and did the fixture or test register the CPT?', $name )
        );

        $result = $ability->execute( $input );

        $this->assertFalse(
            is_wp_error( $result ),
            sprintf(
                'Ability "%s" returned WP_Error: %s',
                $name,
                is_wp_error( $result ) ? $result->get_error_message() : ''
            )
        );

        return $result;
    }

    /**
     * Dispatch a REST request against an already-registered route.
     *
     * Reserved for actual REST routes (`/jab/v1/*`). NOT for invoking JAB
     * abilities — those are wp_get_ability()->execute() targets.
     *
     * @param string                $route   e.g. "/jab/v1/manifest"
     * @param string                $method  HTTP method (GET, POST, ...)
     * @param array<string, mixed>  $params  Query params (GET) or body (POST).
     */
    protected function dispatch_rest( string $route, string $method = 'GET', array $params = [] ): WP_REST_Response {
        $request = new WP_REST_Request( $method, $route );
        foreach ( $params as $key => $value ) {
            $request->set_param( $key, $value );
        }
        return rest_get_server()->dispatch( $request );
    }

    /**
     * Switch the current user to a freshly-created Subscriber and return
     * the user ID for follow-up factory work.
     */
    protected function as_subscriber(): int {
        $user_id = $this->factory()->user->create( [ 'role' => 'subscriber' ] );
        wp_set_current_user( (int) $user_id );
        return (int) $user_id;
    }

    /**
     * Switch the current user to a freshly-created Administrator and return
     * the user ID for follow-up factory work.
     */
    protected function as_admin(): int {
        $user_id = $this->factory()->user->create( [ 'role' => 'administrator' ] );
        wp_set_current_user( (int) $user_id );
        return (int) $user_id;
    }
}
