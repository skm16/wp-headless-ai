<?php
/**
 * MenuLabelOnlyParentTest — nav menu label-only parent regression.
 *
 * A "label-only parent" is the WP menu pattern for a top-level dropdown
 * wrapper that has no URL of its own — only sub-items are clickable.
 * The menu UI lets users add these via the "Custom Links" panel with
 * the URL field left blank. Pre-fix MenusAbility's output schema marked
 * url with format=uri, which rejected the empty string and hard-failed
 * the entire jab/get-menus response. The fix dropped format=uri and
 * documented the empty-url contract.
 *
 * @package Jab\WpHeadlessKit\Tests\Integration\Abilities
 */

declare( strict_types=1 );

final class MenuLabelOnlyParentTest extends IntegrationTestCase {

    public function test_label_only_parent_menu_item_does_not_fail_output_validation(): void {
        // Register a test location and create a menu attached to it.
        register_nav_menu( 'jab_test_location', 'Jab Test Location' );
        $menu_id = (int) wp_create_nav_menu( 'jab-test-menu' );
        set_theme_mod( 'nav_menu_locations', [ 'jab_test_location' => $menu_id ] );

        // The label-only parent: object='custom', empty URL, non-empty title.
        $parent_item_id = (int) wp_update_nav_menu_item( $menu_id, 0, [
            'menu-item-title'   => 'Parent (label only)',
            'menu-item-url'     => '',
            'menu-item-status'  => 'publish',
            'menu-item-type'    => 'custom',
            'menu-item-object'  => 'custom',
        ] );

        // A child link beneath the label-only parent.
        (int) wp_update_nav_menu_item( $menu_id, 0, [
            'menu-item-title'     => 'Child link',
            'menu-item-url'       => 'https://example.test/child',
            'menu-item-status'    => 'publish',
            'menu-item-type'      => 'custom',
            'menu-item-object'    => 'custom',
            'menu-item-parent-id' => $parent_item_id,
        ] );

        // Switch to a Subscriber so the read-cap gate on jab/get-menus
        // is satisfied. The test framework defaults to user 0 (anonymous);
        // current_user_can('read') is false for user 0 so execute_ability
        // would WP_Error on permission.
        $this->as_subscriber();

        $result = (array) $this->execute_ability( 'jab/get-menus' );

        $this->assertArrayHasKey( 'menus', $result );
        $menus = (array) $result['menus'];
        $this->assertNotEmpty( $menus, 'Test menu was not returned.' );

        // Find our menu in the response (other menus may exist).
        $jab_menu = null;
        foreach ( $menus as $menu ) {
            if ( 'jab-test-menu' === ( $menu['slug'] ?? '' ) ) {
                $jab_menu = (array) $menu;
                break;
            }
        }
        $this->assertNotNull( $jab_menu, 'jab-test-menu missing from response.' );

        $items = (array) ( $jab_menu['items'] ?? [] );
        $this->assertCount( 2, $items, 'Both parent and child should be present.' );

        // Find the parent (empty url + matching title).
        $parent = null;
        $child  = null;
        foreach ( $items as $item ) {
            if ( 'Parent (label only)' === ( $item['title'] ?? '' ) ) {
                $parent = (array) $item;
            } elseif ( 'Child link' === ( $item['title'] ?? '' ) ) {
                $child = (array) $item;
            }
        }
        $this->assertNotNull( $parent, 'Label-only parent missing from response.' );
        $this->assertNotNull( $child, 'Child link missing from response.' );

        // The regression assertion: parent.url is empty (not omitted, not coerced).
        $this->assertSame( '', (string) $parent['url'], 'Label-only parent.url must be the empty string.' );
        $this->assertSame( (int) $parent['id'], (int) $child['parent_id'], 'Child.parent_id must point at the label-only parent.' );
    }
}
