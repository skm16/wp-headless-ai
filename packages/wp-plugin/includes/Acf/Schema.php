<?php
/**
 * ACF schema generator — turns ACF field group definitions into JSON Schema
 * fragments so PostTypeListAbility can inject `acf` properties into its
 * output schemas at registration time.
 *
 * Scope:
 *   Scalars
 *     - text, textarea, wysiwyg, oembed              -> string
 *     - number, range                                 -> number
 *     - true_false                                    -> boolean
 *     - url, email                                    -> string
 *     - date_picker, date_time_picker, time_picker   -> string
 *     - color_picker                                  -> string
 *     - select, radio, button_group                  -> string  (choices in x-acf-choices)
 *     - checkbox                                      -> array<string>  (choices in x-acf-choices)
 *
 * Output validation policy (v0.6.1+):
 *   Output schemas intentionally OMIT `enum` and `format` constraints even
 *   when ACF defines choices or a format-typed field (url/email/date/etc.).
 *   The reason: real DB data drifts from ACF declarations (admin edits the
 *   choice list, an import pastes legacy values, a url field holds an
 *   empty string, a date is "YYYY-MM-DD" vs "YYYY-MM-DDTHH:MM:SSZ", etc.)
 *   and the mcp-adapter validates outputs strictly — a single bad row
 *   hard-fails the whole `jab/get-{cpt}` list call. Choices are preserved
 *   under the `x-acf-choices` vendor extension so the manifest still
 *   carries the intent for SDK example generation; format hints are
 *   dropped because JSON Schema `format` is too strict for runtime data.
 *   Input schemas (caller-supplied parameters) keep their strict bounds.
 *
 *   Media (return_format-aware)
 *     - image, file       -> object | string (uri) | integer
 *     - gallery           -> array<image>
 *
 *   Links / URLs
 *     - link              -> object | string (uri)
 *     - page_link         -> string (uri)        (array when multiple)
 *
 *   Post relations (return_format-aware, multiple-aware)
 *     - post_object       -> WP_Post-shaped object | integer
 *     - relationship      -> array<post_object>
 *
 *   Composite (recursive)
 *     - group             -> nested object of sub_fields
 *     - repeater          -> array of nested objects
 *
 *   Other
 *     - google_map        -> { address, lat, lng }
 *     - flexible_content  -> array<oneOf<layout1 | layout2 | ...>>
 *                            Each layout becomes an object schema with an
 *                            `acf_fc_layout` const discriminator, producing
 *                            a discriminated TypeScript union downstream.
 *
 * Skipped (return null — silently dropped from the schema):
 *   - tab / message / accordion / clone           (no value or deep copying)
 *   - taxonomy / user                             (relational, different shape)
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Acf;

defined( 'ABSPATH' ) || exit;

final class Schema {

	/**
	 * Diagnostic ledger — every field group skipped (location rule too complex)
	 * and every field dropped (unsupported type) gets recorded here per request
	 * for inspection via `Schema::diagnostics()`. DX-1: turns the silent
	 * `continue` / `return null` into something the agency dev can find when
	 * "the AI can't see field X" reports come in.
	 *
	 * Logged through `error_log()` when WP_DEBUG is on so it also lands in
	 * `wp-content/debug.log` without needing a separate CLI command.
	 *
	 * @var array{groups: array<int, array{post_type:string, group_key:string, reason:string}>, fields: array<int, array{post_type:string, field_name:string, field_type:string, reason:string}>}
	 */
	private static $diagnostics = [
		'groups' => [],
		'fields' => [],
	];

	/**
	 * Return the per-request diagnostic ledger. Useful from a mu-plugin or
	 * a future `wp jab doctor` command:
	 *
	 *   $diag = \Jab\WpHeadlessKit\Acf\Schema::diagnostics();
	 *   foreach ( $diag['fields'] as $row ) { ... }
	 *
	 * @return array{groups: array<int, array{post_type:string, group_key:string, reason:string}>, fields: array<int, array{post_type:string, field_name:string, field_type:string, reason:string}>}
	 */
	public static function diagnostics(): array {
		return self::$diagnostics;
	}

	/**
	 * Record a skipped field group. No-op outside of debug environments to
	 * keep production memory flat.
	 */
	private static function record_skipped_group( string $post_type, string $group_key, string $reason ): void {
		if ( ! self::diagnostics_enabled() ) {
			return;
		}
		self::$diagnostics['groups'][] = [
			'post_type' => $post_type,
			'group_key' => $group_key,
			'reason'    => $reason,
		];
		if ( defined( 'WP_DEBUG' ) && WP_DEBUG ) {
			error_log( sprintf( '[jab/headless_kit] ACF group "%s" skipped for post_type "%s" — %s', $group_key, $post_type, $reason ) );
		}
	}

	/**
	 * Record a dropped field. Same gating as record_skipped_group().
	 */
	private static function record_dropped_field( string $post_type, string $field_name, string $field_type, string $reason ): void {
		if ( ! self::diagnostics_enabled() ) {
			return;
		}
		self::$diagnostics['fields'][] = [
			'post_type'  => $post_type,
			'field_name' => $field_name,
			'field_type' => $field_type,
			'reason'     => $reason,
		];
		if ( defined( 'WP_DEBUG' ) && WP_DEBUG ) {
			error_log( sprintf( '[jab/headless_kit] ACF field "%s" (type %s) dropped for post_type "%s" — %s', $field_name, $field_type, $post_type, $reason ) );
		}
	}

	/**
	 * Diagnostics are kept on WP_DEBUG sites and any site that filters
	 * `jab/headless_kit/acf_diagnostics` to true (e.g. an agency runbook
	 * that wants the data without site-wide debug logging).
	 */
	private static function diagnostics_enabled(): bool {
		$enabled = ( defined( 'WP_DEBUG' ) && WP_DEBUG );
		if ( function_exists( 'apply_filters' ) ) {
			$enabled = (bool) apply_filters( 'jab/headless_kit/acf_diagnostics', $enabled );
		}
		return $enabled;
	}

	/**
	 * Is the ACF plugin (free or pro) loaded?
	 *
	 * Used to gate the entire integration; sites without ACF behave exactly
	 * as before — no `acf` property in any output schema.
	 */
	public static function is_active(): bool {
		return function_exists( 'acf_get_field_groups' )
			&& function_exists( 'acf_get_fields' )
			&& function_exists( 'get_fields' );
	}

	/**
	 * Return a JSON Schema fragment for a given post_type's merged ACF fields,
	 * or null if ACF is inactive / no fields apply.
	 *
	 * Shape:
	 *   [ 'type' => 'object', 'properties' => [...], 'additionalProperties' => false ]
	 *
	 * Image/file/gallery property schemas carry an `x-acf-media` vendor
	 * extension keyword so the runtime layer can find them — at any nesting
	 * depth — and enrich integer attachment IDs into the rich object shape
	 * the schema declares. Standard JSON Schema validators and
	 * json-schema-to-typescript both ignore unknown keywords, so the marker
	 * is invisible to consumers but powers the recursive enrichment walk.
	 *
	 * @return array<string, mixed>|null
	 */
	public static function for_post_type( string $post_type ): ?array {
		if ( ! self::is_active() ) {
			return null;
		}

		// PERF-1: abilities register on `wp_abilities_api_init` (every request
		// that touches the abilities registry, including front-end pages on
		// some MCP-aware stacks). Walking every ACF field group on every
		// request is O(CPTs × groups × fields) of wasted work. Cache the
		// derived schema in a transient keyed by a content fingerprint of
		// the field group definitions — when an admin saves a field group,
		// the fingerprint changes and the cache regenerates lazily.
		$fingerprint = self::field_groups_fingerprint();
		$cache_key   = 'jab_acf_schema_' . md5( $post_type . '|' . $fingerprint );
		$cached      = function_exists( 'get_transient' ) ? get_transient( $cache_key ) : false;
		if ( is_array( $cached ) ) {
			return $cached;
		}
		if ( '__jab_null__' === $cached ) {
			return null;
		}

		$properties = self::collect_fields( $post_type );
		if ( empty( $properties ) ) {
			if ( function_exists( 'set_transient' ) ) {
				// Sentinel — distinguishes "no fields apply" from "cache miss".
				set_transient( $cache_key, '__jab_null__', HOUR_IN_SECONDS );
			}
			return null;
		}

		$schema = [
			'type'                 => 'object',
			'additionalProperties' => false,
			'properties'           => $properties,
		];

		if ( function_exists( 'set_transient' ) ) {
			set_transient( $cache_key, $schema, HOUR_IN_SECONDS );
		}

		return $schema;
	}

	/**
	 * Public adapter so `Acf\BlockFieldSchema` (v0.6.0) can convert a single
	 * ACF field definition to its JSON Schema fragment without reimplementing
	 * the type-mapping walker. Mirrors the private `to_field_schema()` path
	 * that `collect_fields()` uses, minus the post_type-scoped diagnostics
	 * (those don't apply to block-bound groups).
	 *
	 * @param array<string, mixed> $field
	 * @return array<string, mixed>|null
	 */
	public static function to_field_schema_for_block( array $field ): ?array {
		return self::to_field_schema( $field );
	}

	/**
	 * Content fingerprint of every loaded ACF field group. Changes when an
	 * admin saves any group, since `acf_get_field_groups()` reflects the
	 * post-update state. Hashing the keys + modified timestamps is enough —
	 * we don't need to walk sub_fields to invalidate (ACF's own caching
	 * already bumps the group's modified timestamp on any descendant edit).
	 */
	private static function field_groups_fingerprint(): string {
		if ( ! function_exists( 'acf_get_field_groups' ) ) {
			return '';
		}
		$groups = acf_get_field_groups();
		if ( ! is_array( $groups ) ) {
			return '';
		}
		$parts = [];
		foreach ( $groups as $group ) {
			$parts[] = (string) ( $group['key'] ?? '' );
			$parts[] = (string) ( $group['modified'] ?? $group['ID'] ?? '' );
		}
		return md5( implode( '|', $parts ) );
	}

	/**
	 * Walk every ACF field group and collect property schemas for those that
	 * apply (by simple location rule) to the given post_type.
	 *
	 * @return array<string, array<string, mixed>>
	 */
	private static function collect_fields( string $post_type ): array {
		$properties = [];
		$groups     = acf_get_field_groups();
		if ( ! is_array( $groups ) ) {
			return $properties;
		}

		foreach ( $groups as $group ) {
			$group_key = (string) ( $group['key'] ?? '' );
			if ( ! self::group_applies_to_post_type( $group, $post_type ) ) {
				// DX-1: only record groups that *target some post type via a
				// location rule we don't support* — not groups that simply
				// don't apply to this CPT. The heuristic: a group with a
				// non-empty `location` that didn't match is "skipped".
				if ( ! empty( $group['location'] ) ) {
					self::record_skipped_group( $post_type, $group_key, 'location rule not supported (only simple post_type==X and page-implying rules are matched)' );
				}
				continue;
			}
			$fields = acf_get_fields( $group['key'] ?? $group );
			if ( ! is_array( $fields ) ) {
				continue;
			}
			foreach ( $fields as $field ) {
				$schema = self::to_field_schema( $field );
				$name   = isset( $field['name'] ) ? (string) $field['name'] : '';
				$type   = isset( $field['type'] ) ? (string) $field['type'] : '';
				if ( null === $schema ) {
					// DX-1: tab/message/accordion/clone/taxonomy/user are *expected*
					// drops; we record everything else so the agency dev sees the
					// long tail of unsupported types.
					// `password` is dropped intentionally for SEC-3 — surface it
					// loudly so an agency that genuinely wanted that text knows
					// why it's missing (and can override via a custom filter).
					$expected_silent_drops = [ 'tab', 'message', 'accordion', 'clone', 'taxonomy', 'user' ];
					if ( '' !== $name && ! in_array( $type, $expected_silent_drops, true ) ) {
						$reason = 'password' === $type
							? 'password fields are not exposed via the headless API (SEC-3)'
							: 'unsupported field type or no usable sub_fields';
						self::record_dropped_field( $post_type, $name, $type, $reason );
					}
					continue;
				}
				if ( '' === $name ) {
					continue;
				}
				// Last-write-wins on duplicate field names. This matches ACF
				// runtime behavior — later-loaded groups override earlier ones.
				$properties[ $name ] = $schema;
			}
		}
		return $properties;
	}

	/**
	 * Does the given field group's location rules indicate it applies to
	 * the given post_type?
	 *
	 * ACF location rules are nested arrays: outer = OR, inner = AND. We
	 * accept the field group if ANY rule, in any clause, satisfies one of:
	 *
	 *   - Direct:    `post_type == <post_type>`
	 *   - Implicit:  `page_template == X` / `page_type == X` / `page_parent == X`
	 *                — these page-only rules imply `post_type == page`,
	 *                  matching the WP convention. Page-builder field
	 *                  groups in the wild almost always use page_template
	 *                  rather than post_type.
	 *
	 * The schema generator marks the field as available on the whole
	 * post_type (e.g. all pages get `page_builder?` even though only
	 * template-X pages populate it). The runtime already filters out
	 * null/empty fields, so pages not using the template simply omit
	 * the key from their `acf` object — the schema permits that.
	 *
	 * @param array<string, mixed> $group
	 */
	private static function group_applies_to_post_type( array $group, string $post_type ): bool {
		$location = $group['location'] ?? [];
		if ( ! is_array( $location ) ) {
			return false;
		}

		$page_implying_params = [ 'page_template', 'page_type', 'page_parent' ];

		foreach ( $location as $or_clause ) {
			if ( ! is_array( $or_clause ) ) {
				continue;
			}
			foreach ( $or_clause as $rule ) {
				if ( ! isset( $rule['param'], $rule['operator'], $rule['value'] ) ) {
					continue;
				}
				if ( '==' !== $rule['operator'] ) {
					continue;
				}
				if ( 'post_type' === $rule['param'] && $post_type === $rule['value'] ) {
					return true;
				}
				if ( 'page' === $post_type && in_array( (string) $rule['param'], $page_implying_params, true ) ) {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * Translate a single ACF field array to a JSON Schema property, or null
	 * if the field type is unsupported / has no value (tabs etc.).
	 *
	 * @param array<string, mixed> $field
	 * @return array<string, mixed>|null
	 */
	private static function to_field_schema( array $field ): ?array {
		$type         = (string) ( $field['type'] ?? '' );
		$label        = isset( $field['label'] ) ? (string) $field['label'] : '';
		$instructions = isset( $field['instructions'] ) ? (string) $field['instructions'] : '';
		$description  = trim( $label . ( '' !== $instructions ? ' — ' . $instructions : '' ) );

		switch ( $type ) {
			case 'text':
			case 'textarea':
			case 'wysiwyg':
			case 'oembed':
				return self::with_description( [ 'type' => 'string' ], $description );

			case 'password':
				// SEC-3: never emit ACF password fields into the public schema.
				// ACF stores them in plaintext, and any agency that puts a secret
				// in one would leak it through the headless API. Falls through to
				// `default: return null`, which DX-1 records as a dropped field —
				// agencies that genuinely want password text in the API can opt
				// back in via a `jab/headless_kit/ability_configs`-style mu-plugin.
				return null;

			case 'number':
			case 'range':
				return self::with_description( [ 'type' => 'number' ], $description );

			case 'true_false':
				return self::with_description( [ 'type' => 'boolean' ], $description );

			case 'url':
				return self::with_description( [ 'type' => 'string' ], $description );

			case 'email':
				return self::with_description( [ 'type' => 'string' ], $description );

			case 'date_picker':
				return self::with_description( [ 'type' => 'string' ], $description );

			case 'date_time_picker':
				return self::with_description( [ 'type' => 'string' ], $description );

			case 'time_picker':
				return self::with_description( [ 'type' => 'string' ], $description );

			case 'color_picker':
				return self::with_description( [ 'type' => 'string' ], $description );

			case 'select':
			case 'radio':
			case 'button_group':
				return self::with_description( self::enum_string( $field ), $description );

			case 'checkbox':
				return self::with_description(
					[
						'type'  => 'array',
						'items' => self::enum_string( $field ),
					],
					$description
				);

			case 'image':
				return self::with_description(
					self::image_schema( self::return_format( $field, 'array' ) ),
					$description
				);

			case 'file':
				return self::with_description(
					self::file_schema( self::return_format( $field, 'array' ) ),
					$description
				);

			case 'gallery':
				// Gallery's per-item return_format is fixed to 'array' in ACF;
				// we follow that shape unconditionally.
				return self::with_description(
					[
						'type'  => 'array',
						'items' => self::image_schema( 'array' ),
					],
					$description
				);

			case 'link':
				return self::with_description(
					self::link_schema( self::return_format( $field, 'array' ) ),
					$description
				);

			case 'page_link':
				$inner = [ 'type' => 'string' ];
				return self::with_description(
					! empty( $field['multiple'] )
						? [ 'type' => 'array', 'items' => $inner ]
						: $inner,
					$description
				);

			case 'post_object':
				$item = self::post_ref_schema( self::return_format( $field, 'object' ) );
				return self::with_description(
					! empty( $field['multiple'] )
						? [ 'type' => 'array', 'items' => $item ]
						: $item,
					$description
				);

			case 'relationship':
				return self::with_description(
					[
						'type'  => 'array',
						'items' => self::post_ref_schema( self::return_format( $field, 'object' ) ),
					],
					$description
				);

			case 'group':
				$nested = self::nested_object_schema( $field['sub_fields'] ?? [] );
				if ( null === $nested ) {
					return null;
				}
				return self::with_description( $nested, $description );

			case 'repeater':
				$nested = self::nested_object_schema( $field['sub_fields'] ?? [] );
				if ( null === $nested ) {
					return null;
				}
				return self::with_description(
					[ 'type' => 'array', 'items' => $nested ],
					$description
				);

			case 'google_map':
				return self::with_description( self::google_map_schema(), $description );

			case 'flexible_content':
				$variants = self::flexible_content_variants( $field['layouts'] ?? [] );
				if ( empty( $variants ) ) {
					return null;
				}
				return self::with_description(
					[
						'type'  => 'array',
						'items' => 1 === count( $variants ) ? $variants[0] : [ 'oneOf' => $variants ],
					],
					$description
				);

			default:
				// Unsupported in v0 — skip silently.
				return null;
		}
	}

	/**
	 * @param array<string, mixed> $field
	 * @return array<string, mixed>
	 */
	private static function enum_string( array $field ): array {
		// v0.6.1: dropped `enum` constraint on output schemas (was: choice
		// keys → `enum`). Live DB data routinely drifts from current ACF
		// choices (admin edited the field, value pasted in from import, a
		// choice was removed, etc.) and a single bad row was hard-failing
		// the whole `jab/get-{cpt}` list call via mcp-adapter's output
		// validation. Preserve the choice list under a vendor extension so
		// the manifest still carries the intent (and a future SDK
		// generator can use it for example values / docs) without making
		// the schema brittle.
		$schema  = [ 'type' => 'string' ];
		$choices = $field['choices'] ?? null;
		if ( is_array( $choices ) && ! empty( $choices ) ) {
			$schema['x-acf-choices'] = array_values( array_map( 'strval', array_keys( $choices ) ) );
		}
		return $schema;
	}

	/**
	 * Read the field's `return_format`, falling back to a per-type default.
	 *
	 * ACF's UI defaults vary across field types; the field config always
	 * carries the chosen format, but on legacy / programmatic groups it can
	 * be missing. The fallback keeps schemas predictable.
	 *
	 * @param array<string, mixed> $field
	 */
	private static function return_format( array $field, string $fallback ): string {
		$format = $field['return_format'] ?? null;
		return is_string( $format ) && '' !== $format ? $format : $fallback;
	}

	/**
	 * Schema for an ACF image field, branching on return_format.
	 *
	 *   url    -> string (uri)
	 *   array  -> WordPress attachment array (id, url, sizes, etc.)
	 *   id     -> same as array — the runtime walker enriches integer IDs
	 *             into the same shape via acf_get_attachment(), guided by
	 *             the `x-acf-media` marker on this schema.
	 *
	 * The object shape uses additionalProperties: true because ACF includes a
	 * long tail of attachment metadata (mime sub-types, modified date, etc.)
	 * that varies by site — high-value fields are typed concretely and the
	 * rest passes through as `unknown`.
	 *
	 * The `x-acf-media` marker is a vendor extension keyword. JSON Schema
	 * validators and json-schema-to-typescript both ignore unknown keywords,
	 * so the marker is invisible to consumers but lets the runtime walker
	 * find media nodes at any nesting depth (top-level, inside repeaters,
	 * inside flexible_content layouts, etc.).
	 *
	 * @return array<string, mixed>
	 */
	private static function image_schema( string $return_format ): array {
		if ( 'url' === $return_format ) {
			return [ 'type' => 'string' ];
		}
		return [
			'type'                 => 'object',
			'additionalProperties' => true,
			'properties'           => [
				'ID'          => [ 'type' => 'integer' ],
				'id'          => [ 'type' => 'integer' ],
				'url'         => [ 'type' => 'string' ],
				'alt'         => [ 'type' => 'string' ],
				'title'       => [ 'type' => 'string' ],
				'caption'     => [ 'type' => 'string' ],
				'description' => [ 'type' => 'string' ],
				'filename'    => [ 'type' => 'string' ],
				'mime_type'   => [ 'type' => 'string' ],
				'width'       => [ 'type' => 'integer' ],
				'height'      => [ 'type' => 'integer' ],
				'sizes'       => [
					'type'                 => 'object',
					'additionalProperties' => true,
					'description'          => 'Map of registered image-size slug -> URL (and -width / -height keys per size).',
				],
			],
			'x-acf-media'          => [
				'kind'          => 'image',
				'return_format' => $return_format,
			],
		];
	}

	/**
	 * Schema for an ACF file field. Same Return Format normalization as
	 * image_schema — `id` is enriched at runtime to match `array`. The
	 * object shape omits image-only properties (width/height/sizes).
	 *
	 * Carries the same `x-acf-media` marker so the runtime walker
	 * normalizes integer IDs and file arrays into a uniform attachment
	 * shape regardless of nesting depth.
	 *
	 * @return array<string, mixed>
	 */
	private static function file_schema( string $return_format ): array {
		if ( 'url' === $return_format ) {
			return [ 'type' => 'string' ];
		}
		return [
			'type'                 => 'object',
			'additionalProperties' => true,
			'properties'           => [
				'ID'          => [ 'type' => 'integer' ],
				'id'          => [ 'type' => 'integer' ],
				'url'         => [ 'type' => 'string' ],
				'title'       => [ 'type' => 'string' ],
				'filename'    => [ 'type' => 'string' ],
				'mime_type'   => [ 'type' => 'string' ],
				'description' => [ 'type' => 'string' ],
			],
			'x-acf-media'          => [
				'kind'          => 'file',
				'return_format' => $return_format,
			],
		];
	}

	/**
	 * Schema for an ACF link field.
	 *
	 *   array  -> { title, url, target }
	 *   url    -> string (uri)
	 *
	 * @return array<string, mixed>
	 */
	private static function link_schema( string $return_format ): array {
		if ( 'url' === $return_format ) {
			return [ 'type' => 'string' ];
		}
		return [
			'type'                 => 'object',
			'additionalProperties' => false,
			'properties'           => [
				'title'  => [ 'type' => 'string' ],
				'url'    => [ 'type' => 'string' ],
				'target' => [ 'type' => 'string', 'description' => 'Anchor target (e.g. _blank). May be empty.' ],
			],
		];
	}

	/**
	 * Schema for a single post relation, branching on return_format.
	 *
	 *   object  -> WP_Post-shaped object (subset of well-known properties)
	 *   id      -> integer
	 *
	 * `additionalProperties: true` lets the full WP_Post tail through; we
	 * surface the fields agencies actually consume (id, title, slug, link).
	 *
	 * @return array<string, mixed>
	 */
	private static function post_ref_schema( string $return_format ): array {
		if ( 'id' === $return_format ) {
			return [ 'type' => 'integer' ];
		}
		return [
			'type'                 => 'object',
			'additionalProperties' => true,
			'properties'           => [
				'ID'          => [ 'type' => 'integer' ],
				'post_title'  => [ 'type' => 'string' ],
				'post_name'   => [ 'type' => 'string', 'description' => 'URL slug.' ],
				'post_type'   => [ 'type' => 'string' ],
				'post_date'   => [ 'type' => 'string', 'description' => 'WP-format datetime; not RFC3339.' ],
				'post_status' => [ 'type' => 'string' ],
			],
		];
	}

	/**
	 * Schema for a google_map field. ACF stores additional metadata
	 * (place_id, name, etc.) but address/lat/lng are the stable subset.
	 *
	 * @return array<string, mixed>
	 */
	private static function google_map_schema(): array {
		return [
			'type'                 => 'object',
			'additionalProperties' => true,
			'properties'           => [
				'address' => [ 'type' => 'string' ],
				'lat'     => [ 'type' => 'number' ],
				'lng'     => [ 'type' => 'number' ],
			],
		];
	}

	/**
	 * Build the variant object schemas for an ACF flexible_content field,
	 * one per declared layout. Each variant gets an `acf_fc_layout` property
	 * with a JSON Schema single-value `enum`, so json-schema-to-typescript
	 * still emits a discriminated union (`acf_fc_layout: "hero"`) and
	 * consumers can narrow with
	 *   if (block.acf_fc_layout === "hero") { ... }
	 *
	 * `enum: ["x"]` is used instead of `const: "x"` because WP core's
	 * rest_validate_value_from_schema silently ignores `const` — every
	 * variant ends up accepting every value, and rest_find_one_matching_schema
	 * then rejects the response with "matches more than one of the expected
	 * formats". `enum` is in WP's supported keyword set and validates correctly.
	 *
	 * Layouts with no usable sub_fields still produce a variant — they're
	 * legitimate "marker" blocks (think a "<hr/>"-style divider with no
	 * config). Layouts with no `name` are dropped because the discriminator
	 * would be unusable.
	 *
	 * @param array<int|string, array<string, mixed>> $layouts
	 * @return array<int, array<string, mixed>>
	 */
	private static function flexible_content_variants( array $layouts ): array {
		$variants = [];
		foreach ( $layouts as $layout ) {
			if ( ! is_array( $layout ) ) {
				continue;
			}
			$layout_name = isset( $layout['name'] ) ? (string) $layout['name'] : '';
			if ( '' === $layout_name ) {
				continue;
			}

			$layout_label = isset( $layout['label'] ) ? (string) $layout['label'] : $layout_name;

			$properties = [
				'acf_fc_layout' => [
					'type'        => 'string',
					'enum'        => [ $layout_name ],
					'description' => $layout_label,
				],
			];

			$sub_fields = $layout['sub_fields'] ?? [];
			if ( is_array( $sub_fields ) ) {
				foreach ( $sub_fields as $sub ) {
					if ( ! is_array( $sub ) ) {
						continue;
					}
					$sub_schema = self::to_field_schema( $sub );
					if ( null === $sub_schema ) {
						continue;
					}
					$sub_name = isset( $sub['name'] ) ? (string) $sub['name'] : '';
					if ( '' === $sub_name ) {
						continue;
					}
					$properties[ $sub_name ] = $sub_schema;
				}
			}

			$variants[] = [
				'type'                 => 'object',
				'additionalProperties' => false,
				'required'             => [ 'acf_fc_layout' ],
				'properties'           => $properties,
			];
		}
		return $variants;
	}

	/**
	 * Build an object schema from a list of ACF sub_fields. Used by both
	 * `group` (returns the object directly) and `repeater` (wraps it in an
	 * array). Returns null when no sub_fields produced a usable schema, so
	 * the caller can drop the property entirely.
	 *
	 * Recursion: each sub_field goes back through to_field_schema. ACF
	 * doesn't allow infinite nesting (the editor caps depth via UX), so
	 * we don't guard with a manual depth limit.
	 *
	 * @param array<int, array<string, mixed>> $sub_fields
	 * @return array<string, mixed>|null
	 */
	private static function nested_object_schema( array $sub_fields ): ?array {
		$properties = [];
		foreach ( $sub_fields as $sub ) {
			if ( ! is_array( $sub ) ) {
				continue;
			}
			$sub_schema = self::to_field_schema( $sub );
			if ( null === $sub_schema ) {
				continue;
			}
			$name = isset( $sub['name'] ) ? (string) $sub['name'] : '';
			if ( '' === $name ) {
				continue;
			}
			$properties[ $name ] = $sub_schema;
		}
		if ( empty( $properties ) ) {
			return null;
		}
		return [
			'type'                 => 'object',
			'additionalProperties' => false,
			'properties'           => $properties,
		];
	}

	/**
	 * @param array<string, mixed> $schema
	 * @return array<string, mixed>
	 */
	private static function with_description( array $schema, string $description ): array {
		if ( '' !== $description ) {
			$schema['description'] = $description;
		}
		return $schema;
	}
}
