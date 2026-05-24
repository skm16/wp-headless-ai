"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Segmented } from "@/components/ui/segmented";
import { ScaledIframe, type PreviewDevice } from "@/components/scaled-iframe";

export type { PreviewDevice };

export interface PreviewPane {
  /** Inline HTML (preferred for mocks). */
  srcDoc?: string;
  /** External URL (used post-deploy). */
  src?: string;
  /** Canonical URL shown below the pane. Falls back to src. */
  url?: string;
  /** Short label above the pane ("Before", "After", or custom). */
  label: string;
  /** Optional secondary label ("Published Mar 10", "Iteration: brighter palette"). */
  sublabel?: string;
}

export interface PreviewCompareProps {
  before: PreviewPane;
  after: PreviewPane;
  caption?: string;
  defaultDevice?: PreviewDevice;
  className?: string;
}

/**
 * Side-by-side comparison of two PreviewPane sources. Shared device toggle
 * controls both iframes simultaneously — agencies comparing iterations need
 * the visual delta, not a debate about which side is "really" mobile.
 *
 * Stacks below `lg` breakpoint so the panes don't squeeze. Each pane keeps
 * its own label + URL caption so users can tell which is which without
 * memorizing left-vs-right.
 *
 * §10 #9. Implemented as a standalone surface (not a PreviewFrame mode) so
 * the chrome stays focused — the existing PreviewFrame keeps its single-pane
 * shape for non-comparison contexts.
 */
export function PreviewCompare({
  before,
  after,
  caption,
  defaultDevice = "desktop",
  className,
}: PreviewCompareProps) {
  const [device, setDevice] = useState<PreviewDevice>(defaultDevice);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-bord bg-bg shadow-sm",
        className,
      )}
    >
      <div className="flex items-center justify-between border-b border-bord bg-surf px-4 py-2.5">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-semibold text-gry">
            Comparing versions
          </span>
          <span className="text-gry-d">·</span>
          <span className="text-gry-d">Shared device size below</span>
        </div>
        <Segmented
          value={device}
          onChange={setDevice}
          size="sm"
          ariaLabel="Device size"
          options={[
            { value: "mobile", label: "Mobile" },
            { value: "tablet", label: "Tablet" },
            { value: "desktop", label: "Desktop" },
          ]}
        />
      </div>

      <div className="grid gap-3 bg-elev p-3 lg:grid-cols-2">
        <PreviewPaneCard pane={before} device={device} />
        <PreviewPaneCard pane={after} device={device} highlight />
      </div>

      {caption && (
        <p className="border-t border-bord bg-bg px-4 py-2 text-center text-xs text-gry-d">
          {caption}
        </p>
      )}
    </div>
  );
}

function PreviewPaneCard({
  pane,
  device,
  highlight = false,
}: {
  pane: PreviewPane;
  device: PreviewDevice;
  highlight?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2 px-1">
        <p
          className={cn(
            "text-xs font-semibold uppercase tracking-wider",
            highlight ? "text-teal" : "text-gry",
          )}
        >
          {pane.label}
        </p>
        {pane.sublabel && (
          <p className="truncate text-xs text-gry-d">{pane.sublabel}</p>
        )}
      </div>
      <div
        className={cn(
          "h-[calc(100vh-320px)] min-h-[420px] w-full overflow-hidden rounded-md border bg-bg",
          highlight ? "border-teal/40 ring-1 ring-teal/20" : "border-bord",
        )}
      >
        {pane.srcDoc ? (
          // See PreviewFrame: allow-scripts alone keeps the srcDoc origin
          // opaque so the sandboxed document can't reach the parent.
          <ScaledIframe
            device={device}
            srcDoc={pane.srcDoc}
            title={pane.label}
            sandbox="allow-scripts"
          />
        ) : pane.src ? (
          <ScaledIframe
            device={device}
            src={pane.src}
            title={pane.label}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            referrerPolicy="no-referrer"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-gry-d">
            No preview
          </div>
        )}
      </div>
      {(pane.url || pane.src) && (
        <p className="truncate px-1 font-mono text-[11px] text-gry-d">
          {pane.url ?? pane.src}
        </p>
      )}
    </div>
  );
}
