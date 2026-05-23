"use client";

import { cn } from "@/lib/utils";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "@/components/ui/icons";

export interface SiteUrlBarProps {
  url: string;
  /** Visible label prefix (e.g. "Site URL"). Hidden in compact mode. */
  label?: string;
  /** Compact rendering for top-nav contexts — drops the label, tightens spacing. */
  compact?: boolean;
  className?: string;
}

/**
 * Production-URL surface with copy-to-clipboard and open-in-new-tab actions.
 * Lives in the workspace top nav (compact) and could be reused on the project
 * list and connections page.
 *
 * The agency points their client at this URL — treat it as the unit of value.
 * Copy and Open are first-class, not buried in a menu.
 */
export function SiteUrlBar({
  url,
  label = "Site URL",
  compact = false,
  className,
}: SiteUrlBarProps) {
  const { copied, copy } = useCopyToClipboard();
  const copyUrl = () => void copy(url);

  if (compact) {
    return (
      <div
        className={cn(
          "flex min-w-0 items-center gap-1 rounded-md border border-slate-200 bg-slate-50 py-1 pl-2.5 pr-1 text-xs",
          className,
        )}
      >
        <span className="min-w-0 max-w-[28ch] truncate font-mono text-slate-700">
          {url}
        </span>
        <button
          type="button"
          onClick={copyUrl}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          aria-label={copied ? "Copied URL" : "Copy URL"}
        >
          {copied ? <CheckIcon className="h-3.5 w-3.5 text-success" /> : <CopyIcon />}
        </button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          aria-label="Open site in new tab"
        >
          <ExternalLinkIcon />
        </a>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm",
        className,
      )}
    >
      <span className="shrink-0 text-xs font-medium uppercase tracking-wider text-slate-500">
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-slate-700">
        {url}
      </span>
      <button
        type="button"
        onClick={copyUrl}
        className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        aria-label="Copy URL"
      >
        {copied ? <CheckIcon className="h-3.5 w-3.5 text-success" /> : <CopyIcon />}
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <ExternalLinkIcon />
        <span>Open site</span>
      </a>
    </div>
  );
}

