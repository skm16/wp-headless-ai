"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import { StatusDot } from "@/components/ui/status-dot";
import {
  CheckIcon,
  CopyIcon,
  DesktopIcon,
  ExternalLinkIcon,
  MobileIcon,
  TabletIcon,
} from "@/components/ui/icons";
import { ScaledIframe, type PreviewDevice } from "@/components/scaled-iframe";

type Device = PreviewDevice;
type Status = "idle" | "deploying" | "live" | "failed";

export interface PreviewFrameProps {
  /** Used when iframing an external URL. Prefer srcDoc for inline mocks. */
  src?: string;
  /** Inline HTML rendered in the iframe. Use this for mocks and pre-deploy states. */
  srcDoc?: string;
  /** The canonical URL shown in the chrome bar. Falls back to src if omitted. */
  url?: string;
  status?: Status;
  caption?: string;
  className?: string;
  /** Title used for iframe accessibility. */
  title?: string;
  /**
   * Fill the parent's height instead of using the intrinsic
   * `calc(100vh-260px)` default. When true the frame becomes a flex column and
   * the iframe stretches to whatever vertical space the (flex) parent grants —
   * use inside a `flex-1` slot like the workspace preview pane. When false
   * (default) the frame keeps a fixed, viewport-derived height so standalone
   * uses (e.g. the /ui-kit showcase grids) render at a sensible size with no
   * flex parent.
   */
  fill?: boolean;
}

const statusMeta: Record<
  Status,
  { tone: "neutral" | "warning" | "success" | "danger"; label: string }
> = {
  idle: { tone: "neutral", label: "Preview" },
  deploying: { tone: "warning", label: "Deploying" },
  live: { tone: "success", label: "Live" },
  failed: { tone: "danger", label: "Failed" },
};

export function PreviewFrame({
  src,
  srcDoc,
  url,
  status = "idle",
  caption,
  className,
  title = "Preview",
  fill = false,
}: PreviewFrameProps) {
  const [device, setDevice] = useState<Device>("desktop");
  const { copied, copy } = useCopyToClipboard();
  const displayUrl = url ?? src ?? "";
  const meta = statusMeta[status];

  function copyUrl() {
    if (displayUrl) void copy(displayUrl);
  }

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-bord bg-bg shadow-sm",
        // In fill mode the frame is a flex column so the iframe body can claim
        // the leftover height; min-h-0 lets it shrink (e.g. when the Code panel
        // opens beneath it) instead of overflowing.
        fill && "flex min-h-0 flex-col",
        className,
      )}
    >
      <div className="flex items-center gap-3 border-b border-bord bg-surf px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-bord" />
          <span className="h-2.5 w-2.5 rounded-full bg-bord" />
          <span className="h-2.5 w-2.5 rounded-full bg-bord" />
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-bg px-3 py-1 text-xs">
          <StatusDot tone={meta.tone} pulse={status === "deploying"} />
          <span className="font-medium text-gry">{meta.label}</span>
          <span className="text-gry-d">·</span>
          <span className="min-w-0 flex-1 truncate text-gry-d">
            {displayUrl || "—"}
          </span>
          {displayUrl && (
            <button
              type="button"
              onClick={copyUrl}
              className="rounded p-1 text-gry-d hover:bg-elev hover:text-gry focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
              aria-label="Copy URL"
            >
              {copied ? <CheckIcon className="h-3.5 w-3.5 text-teal" /> : <CopyIcon />}
            </button>
          )}
        </div>

        <DeviceToggle device={device} onChange={setDevice} />

        {displayUrl && status === "live" && (
          <a
            href={displayUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded p-1 text-gry-d hover:bg-elev hover:text-gry focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
            aria-label="Open in new tab"
          >
            <ExternalLinkIcon />
          </a>
        )}
      </div>

      <div className={cn("bg-elev p-3", fill && "min-h-0 flex-1")}>
        <div
          className={cn(
            "w-full overflow-hidden rounded-md border border-bord bg-bg",
            // Fill: stretch to the flex-1 body height. Default: the original
            // viewport-derived fixed height for standalone (non-flex) uses.
            fill ? "h-full" : "h-[calc(100vh-260px)] min-h-[480px]",
          )}
        >
          {status === "deploying" ? (
            <DeployingPlaceholder />
          ) : status === "failed" ? (
            <FailedPlaceholder />
          ) : srcDoc ? (
            // srcDoc inherits the parent origin in Chrome — `allow-same-origin`
            // would grant the sandboxed document access to parent cookies and
            // storage. We need scripts for any interactive mock; we don't need
            // same-origin. allow-scripts alone keeps the iframe origin opaque.
            <ScaledIframe
              device={device}
              srcDoc={srcDoc}
              title={title}
              sandbox="allow-scripts"
            />
          ) : src ? (
            // External URLs (e.g. customer WordPress sites) get the full
            // sandbox treatment: an unsandboxed iframe can frame-bust via
            // window.top.location and access window.opener. We grant enough
            // to render a real site (scripts, forms, popups, same-origin for
            // its own assets) but block top-navigation by omission.
            <ScaledIframe
              device={device}
              src={src}
              title={title}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              referrerPolicy="no-referrer"
              loading="lazy"
            />
          ) : (
            <IdlePlaceholder />
          )}
        </div>
      </div>

      {caption && (
        <p className="border-t border-bord bg-bg px-4 py-2 text-center text-xs text-gry-d">
          {caption}
        </p>
      )}
    </div>
  );
}

function DeviceToggle({
  device,
  onChange,
}: {
  device: Device;
  onChange: (next: Device) => void;
}) {
  const buttons: Array<{ value: Device; label: string; icon: React.ReactNode }> = [
    { value: "mobile", label: "Mobile preview", icon: <MobileIcon /> },
    { value: "tablet", label: "Tablet preview", icon: <TabletIcon /> },
    { value: "desktop", label: "Desktop preview", icon: <DesktopIcon /> },
  ];
  return (
    <div
      role="group"
      aria-label="Device size"
      className="flex items-center gap-0.5 rounded-md bg-elev p-0.5"
    >
      {buttons.map((b) => (
        <button
          key={b.value}
          type="button"
          aria-label={b.label}
          aria-pressed={device === b.value}
          onClick={() => onChange(b.value)}
          className={cn(
            "rounded p-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal",
            device === b.value
              ? "bg-bg text-wht shadow-sm"
              : "text-gry-d hover:text-gry",
          )}
        >
          {b.icon}
        </button>
      ))}
    </div>
  );
}

function IdlePlaceholder() {
  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-br from-teal/10 via-bg to-surf">
      <p className="text-sm text-gry-d">Preview will render here</p>
    </div>
  );
}

function DeployingPlaceholder() {
  return (
    <div className="flex h-full items-center justify-center bg-surf">
      <div className="space-y-3 text-center">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-bord border-t-teal" />
        <p className="text-sm text-gry">Building your site…</p>
      </div>
    </div>
  );
}

function FailedPlaceholder() {
  return (
    <div className="flex h-full items-center justify-center bg-red/10">
      <p className="text-sm text-red">
        Preview couldn&apos;t load. Retry from the action above.
      </p>
    </div>
  );
}

