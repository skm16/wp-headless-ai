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

type Device = "mobile" | "tablet" | "desktop";
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
}

const deviceWidths: Record<Device, string> = {
  mobile: "max-w-[375px]",
  tablet: "max-w-[768px]",
  desktop: "max-w-none",
};

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
        "overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm",
        className,
      )}
    >
      <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-white px-3 py-1 text-xs">
          <StatusDot tone={meta.tone} pulse={status === "deploying"} />
          <span className="font-medium text-slate-700">{meta.label}</span>
          <span className="text-slate-300">·</span>
          <span className="min-w-0 flex-1 truncate text-slate-500">
            {displayUrl || "—"}
          </span>
          {displayUrl && (
            <button
              type="button"
              onClick={copyUrl}
              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              aria-label="Copy URL"
            >
              {copied ? <CheckIcon className="h-3.5 w-3.5 text-success" /> : <CopyIcon />}
            </button>
          )}
        </div>

        <DeviceToggle device={device} onChange={setDevice} />

        {displayUrl && status === "live" && (
          <a
            href={displayUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            aria-label="Open in new tab"
          >
            <ExternalLinkIcon />
          </a>
        )}
      </div>

      <div className="flex justify-center bg-slate-100 p-3">
        <div
          className={cn(
            "h-[calc(100vh-260px)] min-h-[480px] w-full overflow-hidden rounded-md border border-slate-200 bg-white transition-[max-width]",
            deviceWidths[device],
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
            <iframe
              srcDoc={srcDoc}
              title={title}
              className="h-full w-full"
              sandbox="allow-scripts"
            />
          ) : src ? (
            // External URLs (e.g. customer WordPress sites) get the full
            // sandbox treatment: an unsandboxed iframe can frame-bust via
            // window.top.location and access window.opener. We grant enough
            // to render a real site (scripts, forms, popups, same-origin for
            // its own assets) but block top-navigation by omission.
            <iframe
              src={src}
              title={title}
              className="h-full w-full"
              loading="lazy"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              referrerPolicy="no-referrer"
            />
          ) : (
            <IdlePlaceholder />
          )}
        </div>
      </div>

      {caption && (
        <p className="border-t border-slate-200 bg-white px-4 py-2 text-center text-xs text-slate-500">
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
      className="flex items-center gap-0.5 rounded-md bg-slate-100 p-0.5"
    >
      {buttons.map((b) => (
        <button
          key={b.value}
          type="button"
          aria-label={b.label}
          aria-pressed={device === b.value}
          onClick={() => onChange(b.value)}
          className={cn(
            "rounded p-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
            device === b.value
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-500 hover:text-slate-700",
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
    <div className="flex h-full items-center justify-center bg-gradient-to-br from-brand-muted via-white to-slate-50">
      <p className="text-sm text-slate-500">Preview will render here</p>
    </div>
  );
}

function DeployingPlaceholder() {
  return (
    <div className="flex h-full items-center justify-center bg-slate-50">
      <div className="space-y-3 text-center">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-brand" />
        <p className="text-sm text-slate-600">Building your site…</p>
      </div>
    </div>
  );
}

function FailedPlaceholder() {
  return (
    <div className="flex h-full items-center justify-center bg-danger-muted">
      <p className="text-sm text-danger-strong">
        Preview couldn&apos;t load. Retry from the action above.
      </p>
    </div>
  );
}

