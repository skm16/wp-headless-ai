import { ImageResponse } from "next/og";

// Shared renderer for every PNG variant of the JAB brand mark — apple-icon
// (180), Android home-screen (192), and PWA install splash (512). Satori has
// no built-in font, so Syne ExtraBold is fetched from the canonical Google
// Fonts mirror on first render and cached by the Next.js OG layer.
//
// The SVG favicon at app/icon.svg is intentionally NOT routed through this
// helper — browsers serve the static SVG directly, no Satori involved.

const SYNE_EXTRABOLD_URL =
  "https://github.com/google/fonts/raw/main/ofl/syne/static/Syne-ExtraBold.ttf";

let synePromise: Promise<ArrayBuffer> | null = null;

function loadSyne(): Promise<ArrayBuffer> {
  // Memoize across renders in the same lambda — saves a fetch when several
  // icon sizes are requested in close succession (e.g., during PWA install).
  if (!synePromise) {
    synePromise = fetch(new URL(SYNE_EXTRABOLD_URL)).then((res) =>
      res.arrayBuffer()
    );
  }
  return synePromise;
}

export async function renderJabIcon(pixelSize: number): Promise<ImageResponse> {
  const syne = await loadSyne();

  // All paddings/font-sizes scale from the 32-unit reference geometry of
  // JabLogoMark so every size renders as a faithful upscale of the mark.
  const scale = pixelSize / 32;
  const borderWidth = Math.max(1, Math.round(1 * scale));
  const cornerRadius = Math.round(7 * scale);
  const fontSize = Math.round(18 * scale);
  const paddingLeft = Math.round(4 * scale);
  const paddingBottom = Math.round((32 - 23) * scale * 0.15);

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          alignItems: "flex-end",
          background: "#0f2040",
          border: `${borderWidth}px solid #1a3158`,
          borderRadius: cornerRadius,
          paddingLeft,
          paddingBottom,
          fontFamily: "Syne",
          fontWeight: 800,
          fontSize,
          lineHeight: 1,
        }}
      >
        <span style={{ color: "#00c9a7" }}>J</span>
        <span style={{ color: "#f0f4f8", opacity: 0.22 }}>&#8250;</span>
      </div>
    ),
    {
      width: pixelSize,
      height: pixelSize,
      fonts: [
        {
          name: "Syne",
          data: syne,
          style: "normal",
          weight: 800,
        },
      ],
    }
  );
}
