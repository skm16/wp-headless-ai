"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copy-to-clipboard hook with a transient `copied` indicator. Shared by
 * PreviewFrame's URL pill, SiteUrlBar, and any other surface that wants the
 * "Copy → Copied!" feedback pattern. Centralizes:
 *
 *   - the silent-fail behavior (Clipboard API throws in sandboxed contexts
 *     and on non-secure origins — we don't surface that to the user; the
 *     visual check-mark just doesn't fire).
 *   - timeout cleanup on unmount so we don't setState on an unmounted node
 *     after the user navigates away mid-copy.
 *
 * @param resetMs how long the `copied` flag stays true. Default 1500ms.
 */
export function useCopyToClipboard(resetMs = 1500): {
  copied: boolean;
  copy: (text: string) => Promise<void>;
} {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setCopied(false), resetMs);
      } catch {
        // Clipboard API can fail silently in sandboxed contexts or on
        // non-secure origins. Acceptable — the visual feedback simply
        // doesn't fire.
      }
    },
    [resetMs],
  );

  return { copied, copy };
}
