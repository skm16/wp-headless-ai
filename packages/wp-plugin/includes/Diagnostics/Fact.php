<?php
/**
 * Fact — value object for a single diagnostics fact row.
 *
 * Phase 5 spec §4. Facts carry no severity — they are observational data
 * (plugin version, post-type universe, etc.). Pair with Check value objects.
 *
 * @package Jab\WpHeadlessKit\Diagnostics
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Diagnostics;

defined( 'ABSPATH' ) || exit;

final class Fact {

	/**
	 * Stable identifier slug for this fact (e.g., 'plugin_version').
	 *
	 * @var string
	 */
	private string $id;

	/**
	 * Human-readable label for display.
	 *
	 * @var string
	 */
	private string $label;

	/**
	 * The fact's value — anything JSON-serializable.
	 *
	 * @var mixed
	 */
	private $value;

	/**
	 * Optional additional detail (e.g., list of ability names, debug info).
	 *
	 * @var array<int, mixed>|string|null
	 * Untyped property declaration: union types on properties require PHP 8.0+;
	 * plugin floor is PHP 7.4. The docblock carries the type contract.
	 */
	private $detail;

	/**
	 * @param mixed                          $value  Anything JSON-serializable.
	 * @param array<int, mixed>|string|null  $detail
	 */
	public function __construct( string $id, string $label, $value, $detail = null ) {
		$this->id     = $id;
		$this->label  = $label;
		$this->value  = $value;
		$this->detail = $detail;
	}

	/**
	 * @return array<string, mixed>
	 */
	public function to_array(): array {
		$out = [
			'id'    => $this->id,
			'label' => $this->label,
			'value' => $this->value,
		];
		if ( null !== $this->detail ) {
			$out['detail'] = $this->detail;
		}
		return $out;
	}
}
