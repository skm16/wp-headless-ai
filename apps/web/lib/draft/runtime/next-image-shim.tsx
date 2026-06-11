/**
 * Draft-runtime stand-in for next/image. The published site optimizes via
 * next/image; the draft renders the same pixels with a plain <img>
 * (accepted divergence — spec §11). Width/height pass through so layout
 * matches; `fill` approximates with absolute positioning like next/image.
 */
import type { CSSProperties, ReactElement } from "react";

interface ImgProps {
  src: string | { src: string };
  alt?: string;
  width?: number | string;
  height?: number | string;
  fill?: boolean;
  priority?: boolean;
  quality?: number | string;
  sizes?: string;
  className?: string;
  style?: CSSProperties;
  [k: string]: unknown;
}

export default function Image(props: ImgProps): ReactElement {
  const { src, alt, width, height, fill, className, style, priority, quality, sizes, ...rest } = props;
  void priority; void quality; void sizes;
  const resolved = typeof src === "string" ? src : src?.src ?? "";
  const fillStyle: CSSProperties = fill
    ? { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: (style?.objectFit as CSSProperties["objectFit"]) ?? "cover" }
    : {};
  return (
    <img
      src={resolved}
      alt={alt ?? ""}
      width={fill ? undefined : (width as number | undefined)}
      height={fill ? undefined : (height as number | undefined)}
      className={className}
      style={{ ...style, ...fillStyle }}
      {...(rest as Record<string, unknown>)}
    />
  );
}
