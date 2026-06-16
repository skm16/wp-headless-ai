/**
 * Draft-runtime browser entry. Boot config comes from window.__JAB_DRAFT__
 * (written by the /draft HTML shell):
 *   { projectId, token, apiBase, initialPath }
 * Responsibilities: fetch page JSON → render via BlockDispatcher between the
 * build's Header/Footer; intercept same-site link clicks → pushState + refetch
 * (fully navigable, spec §2); render loud inline errors (spec §10).
 */
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
// virtual modules — resolved by the esbuild plugin in lib/draft/bundle.ts
import { BlockDispatcher } from "virtual:dispatcher";
import { Header } from "virtual:shell-header";
import { Footer } from "virtual:shell-footer";

interface DraftBootConfig {
  projectId: string;
  token: string;
  apiBase: string; // e.g. "/api/draft/<projectId>"
  initialPath: string;
}

interface RenderableBlockLike {
  blockName: string | null;
  attrs: Record<string, unknown>;
  innerBlocks?: RenderableBlockLike[];
  innerHTML?: string;
  _key: string;
}

type PageState =
  | { phase: "loading"; path: string }
  | { phase: "ready"; path: string; blocks: RenderableBlockLike[] }
  | { phase: "error"; path: string; message: string };

declare global {
  interface Window {
    __JAB_DRAFT__: DraftBootConfig;
  }
}

const cfg = window.__JAB_DRAFT__;

async function fetchPage(path: string): Promise<PageState> {
  try {
    const res = await fetch(
      `${cfg.apiBase}/page?path=${encodeURIComponent(path)}&token=${encodeURIComponent(cfg.token)}`,
    );
    if (res.status === 401) {
      // Token expired (2h TTL). Tell the workspace pane so it can refresh
      // the RSC and mint a fresh token into the iframe URL (spec §10).
      window.parent.postMessage({ type: "jab:draft-token-expired" }, "*");
      return { phase: "error", path, message: "Draft session expired — refreshing…" };
    }
    const body = (await res.json()) as
      | { kind: "page"; blocks: RenderableBlockLike[] }
      | { kind: "redirect"; to: string }
      | { kind: "not_found" }
      | { kind: "error"; message: string };
    if (body.kind === "redirect") return fetchPage(body.to);
    if (body.kind === "page") return { phase: "ready", path, blocks: body.blocks };
    if (body.kind === "not_found") return { phase: "error", path, message: `No page at ${path} (404 on the published site too).` };
    return { phase: "error", path, message: body.kind === "error" ? body.message : `Unexpected response (${res.status})` };
  } catch (err) {
    return { phase: "error", path, message: err instanceof Error ? err.message : String(err) };
  }
}

function DraftApp() {
  const [page, setPage] = useState<PageState>({ phase: "loading", path: cfg.initialPath });

  const navigate = useCallback((path: string, push: boolean) => {
    setPage({ phase: "loading", path });
    if (push) window.history.pushState({}, "", path);
    void fetchPage(path).then(setPage);
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    void fetchPage(cfg.initialPath).then(setPage);
    const onPop = () => navigate(window.location.pathname, false);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [navigate]);

  useEffect(() => {
    // Same-site navigation: any root-relative href renders in-draft. Absolute
    // URLs (WP media, external) keep default behavior.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      if (!href.startsWith("/") || href.startsWith("//")) return;
      e.preventDefault();
      navigate(href, true);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [navigate]);

  // Wrap the WHOLE tree (Header + main + Footer) in `.jab-theme`, mirroring the
  // deployed layout's `<body className="...jab-theme">`. The captured source
  // theme CSS and the brand-typography overrides (emitThemeCss / brandTypographyCss
  // in compose-site-emit) are all scoped under `.jab-theme`; scoping only `<main>`
  // left the Header and Footer outside that ancestor, so they lost the source
  // theme's fonts/colors/list styles (the deployed body class covers them there).
  return (
    <div className="jab-theme">
      <Header />
      <main>
        {page.phase === "loading" && (
          <div style={{ padding: "4rem", textAlign: "center", fontFamily: "monospace" }}>Loading draft…</div>
        )}
        {page.phase === "error" && (
          <div role="alert" style={{ margin: "2rem", padding: "1.5rem", border: "2px solid #dc2626", color: "#dc2626", fontFamily: "monospace" }}>
            <strong>Draft preview error</strong>
            <div>{page.message}</div>
          </div>
        )}
        {page.phase === "ready" &&
          page.blocks.map((b) => <BlockDispatcher key={b._key} block={b as never} />)}
      </main>
      <Footer />
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <DraftApp />
    </StrictMode>,
  );
}
