<?php
/**
 * Shared schema fragment for featured images.
 *
 * Produces the tight { ID, url, alt, width, height } | null shape used in the
 * `featured_image` property of every CPT ability that supports thumbnails.
 * Kept intentionally narrower than AcfSchema's image_schema() — the ACF
 * variant passes through the full attachment object with additionalProperties
 * because ACF consumers often need sizes/caption/etc.; the featured image
 * slot just needs the canonical display data.
 *
 * @package Jab\WpHeadlessKit
 */

declare( strict_types=1 );

namespace Jab\WpHeadlessKit\Schema;

defined( 'ABSPATH' ) || exit;

final class MediaSchema {

	/**
	 * JSON Schema fragment for a nullable featured image.
	 *
	 * Schema-side: oneOf<imageObject | null> so json-schema-to-typescript emits
	 * `{ ID: number; url: string; alt: string; width: number; height: number } | null`.
	 * Runtime-side: the execute callback resolves get_post_thumbnail_id() +
	 * wp_get_attachment_image_src() into this exact shape, or returns null.
	 *
	 * @return array<string, mixed>
	 */
	public static function nullable_image(): array {
		return [
			'oneOf' => [
				self::image_object(),
				[ 'type' => 'null' ],
			],
		];
	}

	/**
	 * The concrete image object schema (non-nullable).
	 *
	 * @return array<string, mixed>
	 */
	public static function image_object(): array {
		return [
			'type'                 => 'object',
			'additionalProperties' => false,
			'required'             => [ 'ID', 'url', 'alt', 'width', 'height' ],
			'properties'           => [
				'ID'     => [ 'type' => 'integer' ],
				'url'    => [ 'type' => 'string' ],
				'alt'    => [ 'type' => 'string' ],
				'width'  => [ 'type' => 'integer' ],
				'height' => [ 'type' => 'integer' ],
			],
		];
	}

	/**
	 * Resolve a post's featured image to the image_object shape, or null.
	 *
	 * @return array<string, mixed>|null
	 */
	public static function resolve_for_post( int $post_id ): ?array {
		$thumb_id = (int) get_post_thumbnail_id( $post_id );
		if ( $thumb_id <= 0 ) {
			return null;
		}

		$src = wp_get_attachment_image_src( $thumb_id, 'full' );
		if ( ! is_array( $src ) || empty( $src[0] ) ) {
			return null;
		}

		return [
			'ID'     => $thumb_id,
			'url'    => (string) $src[0],
			'width'  => (int) $src[1],
			'height' => (int) $src[2],
			'alt'    => (string) get_post_meta( $thumb_id, '_wp_attachment_image_alt', true ),
		];
	}
}
