<?php
/**
 * TextRenderer — pure function that turns a Report array into the human
 * text block documented in spec §6. Used by Cli\DoctorCommand when the
 * default `table` format is selected.
 *
 * Extracted so unit tests can compare against a known heredoc without
 * invoking WP-CLI (which would require an entire CLI runtime test rig).
 *
 * @package Jab\WpHeadlessKit\Cli
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Cli;

defined( 'ABSPATH' ) || exit;

final class TextRenderer {

	private const FACT_LABEL_WIDTH  = 22;
	private const CHECK_LABEL_WIDTH = 38;

	/**
	 * @param array<string, mixed> $report Output of Diagnostics\Report::generate().
	 */
	public static function render( array $report ): string {
		$lines   = [];
		$lines[] = 'JAB Headless Kit — Diagnostics';
		$lines[] = '';

		foreach ( (array) ( $report['facts'] ?? [] ) as $fact ) {
			$lines = array_merge( $lines, self::render_fact( (array) $fact ) );
		}

		$lines[] = '';
		$lines[] = 'Checks';
		foreach ( (array) ( $report['checks'] ?? [] ) as $check ) {
			$lines = array_merge( $lines, self::render_check( (array) $check ) );
		}

		$lines[] = '';
		$s       = (array) ( $report['summary'] ?? [] );
		$lines[] = self::pad_label( 'Summary' )
			. sprintf( '%d pass · %d warn · %d fail', (int) ( $s['pass'] ?? 0 ), (int) ( $s['warn'] ?? 0 ), (int) ( $s['fail'] ?? 0 ) );

		return implode( "\n", $lines );
	}

	/**
	 * @return string[]
	 */
	private static function render_fact( array $fact ): array {
		$id    = (string) ( $fact['id'] ?? '' );
		$value = $fact['value'] ?? null;

		switch ( $id ) {
			case 'registered_abilities':
				$names = (array) ( $fact['detail'] ?? [] );
				$shown = $names ? ' (' . implode( ', ', $names ) . ')' : '';
				return [ self::pad_label( 'Registered abilities' ) . (int) $value . $shown ];

			case 'post_types':
			case 'taxonomies':
				$included = (array) ( $value['included'] ?? [] );
				$excluded = (array) ( $value['excluded'] ?? [] );
				$label    = ( 'post_types' === $id ) ? 'Public post types' : 'Public taxonomies';
				$line     = sprintf(
					'%d included (%s) · %d excluded (%s)',
					count( $included ),
					implode( ', ', $included ),
					count( $excluded ),
					implode( ', ', $excluded )
				);
				return [ self::pad_label( $label ) . $line ];

			case 'capability_filters':
				$out   = [ 'Capability filters' ];
				$pairs = (array) $value;
				foreach ( $pairs as $filter_name => $cap ) {
					$short = self::short_filter_name( (string) $filter_name );
					$out[] = '  ' . str_pad( $short, 28 ) . $cap;
				}
				return $out;

			case 'acf':
				$active = (bool) ( $value['active'] ?? false );
				$pro    = (bool) ( $value['pro'] ?? false );
				$ver    = $value['version'] ?? null;
				$trk    = (bool) ( $value['diagnostics_enabled'] ?? false );
				if ( ! $active ) {
					$head = 'inactive';
				} else {
					$head = 'active · v' . (string) $ver . ' (' . ( $pro ? 'pro' : 'free' ) . ') · diagnostics tracking ' . ( $trk ? 'on' : 'off' );
				}
				$out = [ self::pad_label( 'ACF' ) . $head ];
				if ( isset( $fact['detail'] ) ) {
					$out[] = self::pad_label( '' ) . (string) $fact['detail'];
				}
				return $out;

			case 'plugin_version':
				return [ self::pad_label( 'Plugin' ) . (string) $value ];

			case 'wp_version':
				return [ self::pad_label( 'WordPress' ) . (string) $value ];

			case 'php_version':
				return [ self::pad_label( 'PHP' ) . (string) $value ];

			default:
				return [ self::pad_label( (string) ( $fact['label'] ?? $id ) ) . (string) $value ];
		}
	}

	/**
	 * @return string[]
	 */
	private static function render_check( array $check ): array {
		$sev   = (string) ( $check['severity'] ?? 'pass' );
		$label = (string) ( $check['label'] ?? '' );
		$msg   = (string) ( $check['message'] ?? '' );

		$pad = max( self::CHECK_LABEL_WIDTH, strlen( $label ) + 2 );
		$out = [ sprintf( '  %s  %s%s', $sev, str_pad( $label, $pad ), $msg ) ];

		if ( isset( $check['detail'] ) ) {
			$detail = $check['detail'];
			if ( is_array( $detail ) ) {
				foreach ( $detail as $entry ) {
					$out[] = '        ' . (string) $entry;
				}
			} else {
				$out[] = '        ' . (string) $detail;
			}
		}

		return $out;
	}

	private static function pad_label( string $label ): string {
		return str_pad( $label, self::FACT_LABEL_WIDTH );
	}

	/**
	 * Strip the `jab/headless_kit/` namespace prefix so the text view stays
	 * narrow. JSON view keeps the full filter name.
	 */
	private static function short_filter_name( string $filter ): string {
		$prefix = 'jab/headless_kit/';
		return 0 === strpos( $filter, $prefix ) ? substr( $filter, strlen( $prefix ) ) : $filter;
	}
}
