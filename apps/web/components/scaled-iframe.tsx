"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type PreviewDevice = "mobile" | "tablet" | "desktop";

/**
 * Real device viewports we render at. The iframe is sized to these dimensions
 * so its own responsive CSS fires at the correct breakpoints — then scaled to
 * fit. Heights pick a representative portrait/landscape that gives the user
 * enough vertical content to judge layout without being absurd.
 */
export const DEVICE_DIMENSIONS: Record<
  PreviewDevice,
  { width: number; height: number }
> = {
  mobile: { width: 375, height: 667 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 },
};

export interface ScaledIframeProps {
  device: PreviewDevice;
  src?: string;
  srcDoc?: string;
  title: string;
  /**
   * Sandbox attribute. Caller picks based on src vs srcDoc origin model —
   * srcDoc keeps `allow-same-origin` off (otherwise it inherits parent
   * origin); external src needs same-origin for its own assets to load.
   */
  sandbox: string;
  referrerPolicy?: React.HTMLAttributeReferrerPolicy;
  loading?: "lazy" | "eager";
  className?: string;
}

/**
 * Renders an iframe at the true device viewport (1280×800 / 768×1024 / 375×667)
 * and scales it down via `transform: scale()` to fit the available container
 * width. Without this, picking "Desktop" on a narrow container just shows the
 * container width — so the iframe's own `@media` queries fire at the wrong
 * breakpoints and you see the *mobile* layout in the desktop tab.
 *
 * Scale is clamped to ≤1 (no upscaling — we never blow up content above its
 * native device size). The visible viewport height stays equal to the
 * container height: `iframe_height = container_height / scale`, so at 50%
 * scale the user sees a 2× taller slice of the page; they scroll inside the
 * iframe for the rest.
 */
export function ScaledIframe({
  device,
  src,
  srcDoc,
  title,
  sandbox,
  referrerPolicy,
  loading,
  className,
}: ScaledIframeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const { width: deviceWidth, height: deviceHeight } = DEVICE_DIMENSIONS[device];

  // useLayoutEffect for the initial measurement avoids a paint at scale=0.
  // ResizeObserver picks up subsequent container changes (window resize,
  // sidebar toggle, segmented control reflow).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setSize({ width: el.clientWidth, height: el.clientHeight });
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = size.width > 0 ? Math.min(1, size.width / deviceWidth) : 1;
  // Iframe is rendered taller than the device's nominal viewport so that the
  // scaled-down visible portion fills the container vertically. Falls back to
  // the device's native height before the container is measured.
  const renderHeight =
    scale > 0 && size.height > 0 ? size.height / scale : deviceHeight;
  // Center horizontally when the scaled width is narrower than the container
  // (mobile in a wide pane, post-clamp). Otherwise pinned to the left edge.
  const offsetX = Math.max(0, (size.width - deviceWidth * scale) / 2);

  return (
    <div
      ref={containerRef}
      className={cn("relative h-full w-full overflow-hidden bg-white", className)}
    >
      <div
        className="absolute top-0"
        style={{
          left: offsetX,
          width: deviceWidth,
          height: renderHeight,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        {srcDoc ? (
          <iframe
            srcDoc={srcDoc}
            title={title}
            sandbox={sandbox}
            className="block h-full w-full border-0"
          />
        ) : src ? (
          <iframe
            src={src}
            title={title}
            sandbox={sandbox}
            referrerPolicy={referrerPolicy}
            loading={loading}
            className="block h-full w-full border-0"
          />
        ) : null}
      </div>
    </div>
  );
}
