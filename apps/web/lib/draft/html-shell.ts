/**
 * html-shell — the static document served at /draft/<projectId>/<path>.
 * Pure string template (unit-tested); the route handler adds headers.
 * <html id="jab-app"> matches Tailwind's `important: "#jab-app"` scope and
 * body.jab-theme matches the captured theme css — same as emitLayoutTsx.
 */
export interface DraftShellInput {
  projectId: string;
  token: string;
  initialPath: string;
  fontLinkHrefs: string[];
  /** Artifact version discriminator for cache busting (Phase 1: "base-<buildId>"). */
  version: string;
}

export function renderDraftShellHtml(input: DraftShellInput): string {
  const q = `token=${encodeURIComponent(input.token)}&v=${encodeURIComponent(input.version)}`;
  const apiBase = `/api/draft/${input.projectId}`;
  const boot = JSON.stringify({
    projectId: input.projectId,
    token: input.token,
    apiBase,
    initialPath: input.initialPath,
  });
  const fonts = input.fontLinkHrefs
    .map((href) => `<link rel="stylesheet" href="${href}">`)
    .join("\n    ");
  return `<!doctype html>
<html id="jab-app" lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>Draft preview</title>
    ${fonts}
    <link rel="stylesheet" href="${apiBase}/asset/draft.css?${q}">
  </head>
  <body class="jab-theme">
    <div id="root"></div>
    <script>window.__JAB_DRAFT__ = ${boot};</script>
    <script type="module" src="${apiBase}/asset/bundle.js?${q}"></script>
  </body>
</html>
`;
}
