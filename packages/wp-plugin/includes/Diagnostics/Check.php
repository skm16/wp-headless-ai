<?php
/**
 * Check — value object for a single diagnostics check row.
 *
 * Phase 5 spec §4. severity is one of pass | warn | fail. Stable id slug.
 *
 * @package Jab\WpHeadlessKit\Diagnostics
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Diagnostics;

defined( 'ABSPATH' ) || exit;

final class Check {

	public const PASS = 'pass';
	public const WARN = 'warn';
	public const FAIL = 'fail';

	/**
	 * Stable identifier slug for this check (e.g., 'abilities_api').
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
	 * Check severity: one of 'pass', 'warn', or 'fail'.
	 *
	 * @var string
	 */
	private string $severity;

	/**
	 * Human-readable message describing the check result.
	 *
	 * @var string
	 */
	private string $message;

	/**
	 * Optional additional detail (e.g., debug info, list of missing routes).
	 *
	 * @var array<int, string>|string|null
	 * Untyped property declaration: union types on properties require PHP 8.0+;
	 * plugin floor is PHP 7.4. The docblock carries the type contract.
	 */
	private $detail;

	/**
	 * @param array<int, string>|string|null $detail
	 */
	private function __construct( string $id, string $label, string $severity, string $message, $detail ) {
		$this->id       = $id;
		$this->label    = $label;
		$this->severity = $severity;
		$this->message  = $message;
		$this->detail   = $detail;
	}

	/**
	 * @param array<int, string>|string|null $detail
	 */
	public static function pass( string $id, string $label, string $message, $detail = null ): self {
		return new self( $id, $label, self::PASS, $message, $detail );
	}

	/**
	 * @param array<int, string>|string|null $detail
	 */
	public static function warn( string $id, string $label, string $message, $detail = null ): self {
		return new self( $id, $label, self::WARN, $message, $detail );
	}

	/**
	 * @param array<int, string>|string|null $detail
	 */
	public static function fail( string $id, string $label, string $message, $detail = null ): self {
		return new self( $id, $label, self::FAIL, $message, $detail );
	}

	public function severity(): string {
		return $this->severity;
	}

	/**
	 * @return array<string, mixed>
	 */
	public function to_array(): array {
		$out = [
			'id'       => $this->id,
			'label'    => $this->label,
			'severity' => $this->severity,
			'message'  => $this->message,
		];
		if ( null !== $this->detail ) {
			$out['detail'] = $this->detail;
		}
		return $out;
	}
}
