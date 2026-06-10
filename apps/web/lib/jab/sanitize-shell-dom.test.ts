import { describe, it, expect } from "vitest";
import { sanitizeShellDom } from "./sanitize-shell-dom";

const BIG = 100_000;

describe("sanitizeShellDom — element stripping", () => {
  it("strips <script> elements including their content and attributes", () => {
    const out = sanitizeShellDom(
      `<header><script type="text/javascript">var x = "</div>";</script><nav>Hi</nav></header>`,
      BIG,
    );
    expect(out).not.toContain("script");
    expect(out).not.toContain("var x");
    expect(out).toContain("<nav>Hi</nav>");
  });

  it("strips <style> and <noscript> elements wholesale", () => {
    const out = sanitizeShellDom(
      `<header><style>.x{color:red}</style><noscript><img src="/t.gif"></noscript><a href="/y">y</a></header>`,
      BIG,
    );
    expect(out).not.toContain("color:red");
    expect(out).not.toContain("noscript");
    expect(out).not.toContain("t.gif");
    expect(out).toContain(`<a href="/y">y</a>`);
  });

  it("strips HTML comments (including conditional comments)", () => {
    const out = sanitizeShellDom(`<header><!--[if IE]>old<![endif]--><!-- nav start --><nav>x</nav></header>`, BIG);
    expect(out).not.toContain("<!--");
    expect(out).not.toContain("nav start");
    expect(out).toContain("<nav>x</nav>");
  });
});

describe("sanitizeShellDom — attribute stripping", () => {
  it("strips data-* attributes in double-quoted, single-quoted, bare, and valueless forms", () => {
    const out = sanitizeShellDom(
      `<div data-elementor-id="123" data-settings='{"a":1}' data-x=foo data-active class="keep" id="k">v</div>`,
      BIG,
    );
    expect(out).not.toContain("data-");
    expect(out).toContain(`class="keep"`);
    expect(out).toContain(`id="k"`);
  });

  it("strips srcset and imagesrcset, keeps src", () => {
    const out = sanitizeShellDom(
      `<img src="/logo.png" srcset="/logo-320.png 320w, /logo-640.png 640w" sizes="100vw">`,
      BIG,
    );
    expect(out).not.toContain("srcset");
    expect(out).not.toContain("320w");
    expect(out).toContain(`src="/logo.png"`);
  });

  it("strips base64 data: URI payloads but keeps the carrying attribute", () => {
    const out = sanitizeShellDom(
      `<img class="lazy" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==">`,
      BIG,
    );
    expect(out).not.toContain("base64");
    expect(out).not.toContain("iVBORw0");
    expect(out).toContain(`class="lazy"`);
  });
});

describe("sanitizeShellDom — whitespace + clipping", () => {
  it("collapses inter-tag whitespace and runs of spaces", () => {
    const out = sanitizeShellDom(`<header>\n   <nav>\n      <a href="/a">A   B</a>\n   </nav>\n</header>`, BIG);
    expect(out).toBe(`<header><nav><a href="/a">A B</a></nav></header>`);
  });

  it("clips on an element boundary, never mid-tag", () => {
    const repeated = `<li class="menu-item"><a href="/page-x">Item label</a></li>`;
    const html = `<ul>${repeated.repeat(200)}</ul>`;
    const out = sanitizeShellDom(html, 500);
    expect(out.length).toBeLessThanOrEqual(500);
    // The cut must land just after a '>' — no dangling partial tag/attribute.
    expect(out.endsWith(">")).toBe(true);
    expect(out).not.toMatch(/<[^>]*$/);
  });

  it("returns input unchanged in length terms when already under the cap", () => {
    const out = sanitizeShellDom(`<header><nav>x</nav></header>`, BIG);
    expect(out).toBe(`<header><nav>x</nav></header>`);
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeShellDom("", BIG)).toBe("");
  });

  it("is idempotent", () => {
    const html = `<header><script>x()</script>  <nav data-x="1"><a href="/a">A</a></nav></header>`;
    const once = sanitizeShellDom(html, BIG);
    expect(sanitizeShellDom(once, BIG)).toBe(once);
  });
});
