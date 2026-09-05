//! FILENAME: app/extensions/_shared/scriptFrame/frameDocument.ts
// PURPOSE: The ONE definition of the sandboxed script-frame document — the
//          `srcdoc` a `ui.html` frame is loaded with, the postMessage protocol
//          spellings both hosts speak, and the theme tokens the frame is
//          allowed to see.
// CONTEXT: Until M6b this document was built twice, byte-for-byte, by
//          `Controls/Shape/shapeRenderer.ts` (on-grid overlay) and by
//          `ControlsPane/components/CustomControlHost.tsx` (pane card). That
//          duplication was DECLARED in the pane host's header CONTEXT note and
//          pinned by `Controls/__tests__/srcdocBridgeCsp.test.ts`, which
//          compared the two `<script>` blocks and found them identical to the
//          byte. Two copies of one protocol is a fork waiting to happen: the
//          promise a script author is given is that their HTML works unchanged
//          in both hosts, and nothing but a byte comparison was keeping it.
//
//          WHAT DID **NOT** MOVE HERE, and why it must not: the on-grid
//          wrapper is welded to canvas-viewport overlay math (header clipping,
//          absolute positioning over the canvas parent, `pointer-events: none`
//          click-through, the hit-region shims placed ABOVE the frame) that a
//          pane card must not inherit. Only the DOCUMENT and the PROTOCOL are
//          shared. Each host still owns its own element.
//
//          ***THE BRIDGE IN THIS FILE ALMOST CERTAINLY DOES NOT EXECUTE IN A
//          SHIPPED BUILD.*** It is an inline `<script>`, an `about:srcdoc`
//          child inherits its embedder's policy container, and the app ships
//          `script-src 'self' blob:` — no 'unsafe-inline', no nonce, no hash
//          (`app/src-tauri/tauri.conf.json`). Nobody noticed because
//          `tauri dev` on Windows desktop enforces NO CSP at all (tauri 2.9.5:
//          the only header-setting path is the `tauri://` asset protocol, and
//          dev navigates straight to `devUrl` because
//          `PROXY_DEV_SERVER = cfg!(all(dev, mobile))`), so every E2E run this
//          project has ever done ran unprotected. The measurement lives in
//          `app/e2e/tests/csp-srcdoc-bridge.spec.ts` and the collision is
//          pinned by `Controls/__tests__/srcdocBridgeCsp.test.ts`.
//
//          So this file is deliberately written to be RE-TARGETABLE rather
//          than rescued in place: `buildScriptFrameDocument` returns a complete
//          HTML document, which is exactly what a Rust custom URI scheme would
//          serve with its own `Content-Security-Policy` response header. The
//          fix is to change WHERE the document is delivered from, never to add
//          'unsafe-inline' to the app's own policy — that would re-open in-page
//          script injection for the entire renderer to rescue one iframe.
//
//          The frame is `sandbox="allow-scripts"` in both hosts (never
//          `allow-same-origin`), so it has an opaque origin: its scripts cannot
//          reach the parent window, app-origin storage, or __TAURI__. The
//          postMessage protocol below is the only communication path, and the
//          host end applies an `e.source` identity check (frameBridge.ts).

/**
 * The `source` tag on every frame -> host message, and the `target` tag on
 * every host -> frame message. One spelling, named once: the two used to be
 * two string literals in two files, and a listener that stops agreeing with a
 * poster fails SILENTLY — the message is simply never delivered.
 *
 * THAT CLAIM WAS FALSE FOR A MILESTONE, in this very file. The constant
 * existed and nothing but `frameBridge.ts` read it: the document below wrote
 * the value as raw text in BOTH directions, and the on-grid host hand-rolled
 * the host -> frame envelope in two more places (`Controls/index.ts`'s
 * `shape:sendMessage` forwarder and `shapeHitRegions.ts`'s pointer post) —
 * four spellings of a two-ended protocol. Renaming the constant would have
 * left the frame's inbound listener and every claimed click posting the old
 * tag into a listener checking the new one, silently, with the whole suite
 * green. The document now INTERPOLATES this constant (`${tagLiteral}`,
 * resolved once per build) and every poster goes through
 * `postToScriptFrame`; the census in
 * `Controls/__tests__/srcdocBridgeCsp.test.ts` refuses the value's text
 * anywhere outside this directory, and the round trip in
 * `__tests__/scriptFrame.test.ts` runs the built document's own bridge against
 * the real router so the two ends have to agree by execution, not by comment.
 *
 * The value is historical ("shape-html", from when the only host was an
 * on-grid shape) and is deliberately NOT being renamed: it is the wire
 * spelling a mounted script's own HTML already posts, so changing it would
 * break every shipped template and every user's saved app for cosmetics.
 */
export const SCRIPT_FRAME_MESSAGE_TAG = "shape-html";

/**
 * The prefix reserved for messages the BRIDGE itself sends on the frame's
 * behalf (today: the intrinsic-size report). Reserved types are consumed by
 * the host router and never forwarded to the script, so a script cannot be
 * confused by frame plumbing arriving as if the page had sent it — and cannot
 * be fooled by another frame's plumbing either, because the router's
 * `e.source` check runs first.
 */
export const SCRIPT_FRAME_RESERVED_TYPE_PREFIX = "calcula.";

/** The reserved message the bridge posts when the document's size settles. */
export const SCRIPT_FRAME_SIZE_MESSAGE = "calcula.size";

/**
 * The theme the frame is allowed to see: a FIXED, SMALL contract of
 * `--calcula-*` custom properties, each fed from one app skin token.
 *
 * Deliberately a curated map and not `getSkinTokens(getActiveSkin())` in bulk.
 * The app's token vocabulary is ~120 names covering the ribbon, the sheet tabs,
 * the formula bar and every dialog; handing all of it to a distributed app
 * would publish the app's internal styling surface as a de-facto API that no
 * skin author could then change. Eight names are enough for "look like the app
 * you live in", and each one is a promise somebody can keep.
 */
export const SCRIPT_FRAME_THEME_TOKENS: readonly { frameVar: string; hostVar: string }[] = [
  { frameVar: "--calcula-bg", hostVar: "--bg-surface" },
  { frameVar: "--calcula-text", hostVar: "--text-primary" },
  { frameVar: "--calcula-text-secondary", hostVar: "--text-secondary" },
  { frameVar: "--calcula-border", hostVar: "--border-default" },
  { frameVar: "--calcula-accent", hostVar: "--accent-primary" },
  { frameVar: "--calcula-button-bg", hostVar: "--button-bg" },
  { frameVar: "--calcula-button-hover-bg", hostVar: "--button-hover-bg" },
  { frameVar: "--calcula-font-family", hostVar: "--font-family-sans" },
];

/**
 * Characters a token value may contain before it is written into the frame's
 * stylesheet. A skin is CONTRIBUTABLE (`registerSkin`, including by a
 * third-party extension), so a token value is not trusted input just because it
 * came from the host side: a value of `red; } * { } </style><script>…` would
 * close the declaration, close the block AND close the style element. The
 * allowlist admits colours (`#rgb`, `rgb()`, `hsl()`, named), font stacks
 * (quotes, commas, spaces) and lengths — and nothing that can terminate a
 * declaration, a block or an element.
 */
const SAFE_TOKEN_VALUE_RE = /^[A-Za-z0-9 ,.#%()'"_-]{1,200}$/;

/**
 * A token value is dropped whole if it is not obviously inert.
 *
 * Applied where the value becomes CSS (`buildScriptFrameDocument`), NOT only
 * where it is read: a caller may hand the builder a token map from anywhere,
 * and a check that lives at the reader is a check the builder does not have.
 */
export function isSafeScriptFrameTokenValue(value: string): boolean {
  if (!SAFE_TOKEN_VALUE_RE.test(value)) return false;
  // Belt and braces on the two sequences that matter even inside the allowlist:
  // `url(` can fetch, and a comment can splice two declarations together.
  const lowered = value.toLowerCase();
  return !lowered.includes("url(") && !lowered.includes("/*") && !lowered.includes("*/");
}

/**
 * Read the curated theme contract off the host document.
 *
 * A token the active skin does not define is OMITTED rather than defaulted —
 * the frame's own stylesheet carries a fallback in every `var()`, so an
 * omission degrades to a sensible colour instead of to an empty string that
 * paints nothing. Values are sanitized by the builder, not here.
 */
export function readScriptFrameThemeTokens(
  root: HTMLElement | null = typeof document === "undefined" ? null : document.documentElement,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!root || typeof getComputedStyle !== "function") return out;
  const computed = getComputedStyle(root);
  for (const { frameVar, hostVar } of SCRIPT_FRAME_THEME_TOKENS) {
    const value = computed.getPropertyValue(hostVar).trim();
    if (value.length > 0) out[frameVar] = value;
  }
  return out;
}

/** Options that differ between the two hosts. Everything else is shared. */
export interface ScriptFrameDocumentOptions {
  /**
   * A floor on the body's height, in CSS pixels. The pane card wants one (rich
   * content renders badly in the ribbon band's 56px); the on-grid overlay does
   * not, because the shape's own box is the size the user drew.
   */
  minHeightPx?: number;
  /**
   * The `--calcula-*` contract to publish into the document, normally from
   * `readScriptFrameThemeTokens()`. Injected at BUILD time: a skin change after
   * the frame is loaded does not repaint it, because re-assigning `srcdoc`
   * reloads the document and would throw away whatever state the app had built
   * up. The next content change picks the new theme up.
   */
  themeTokens?: Record<string, string>;
}

/**
 * Build the complete document for a script frame: the theme contract, the base
 * stylesheet, the postMessage bridge, and the script's own HTML in the body.
 *
 * The returned string is a whole document on purpose — see the header: the
 * delivery mechanism is the part that has to change, not the content.
 */
export function buildScriptFrameDocument(
  instanceId: string,
  userHtml: string,
  options: ScriptFrameDocumentOptions = {},
): string {
  // JSON.stringify yields a safe JS string literal; escaping "<" additionally
  // prevents "</script>" inside the id from terminating the script block.
  const idLiteral = JSON.stringify(instanceId).replace(/</g, "\\u003c");
  // The protocol tag, resolved ONCE and interpolated into both halves of the
  // bridge below. It used to be typed out as raw text down there, a hundred and
  // forty lines under the constant that claimed to be its only spelling.
  // `app/e2e/tests/csp-srcdoc-bridge.spec.ts` resolves these two named
  // placeholders out of this file's TEXT and refuses any it does not know, so a
  // third interpolation must be taught to that spec as well.
  const tagLiteral = JSON.stringify(SCRIPT_FRAME_MESSAGE_TAG);
  const minHeight = options.minHeightPx !== undefined ? ` min-height: ${options.minHeightPx}px;` : "";
  const themeTokens = options.themeTokens ?? {};
  const themeDecls = SCRIPT_FRAME_THEME_TOKENS
    // Emitted in the CONTRACT's order, not the caller's, so the same skin
    // always produces the same document and the content-hash comparison both
    // hosts do can never see a spurious change.
    .filter(
      ({ frameVar }) =>
        Object.prototype.hasOwnProperty.call(themeTokens, frameVar) &&
        typeof themeTokens[frameVar] === "string" &&
        isSafeScriptFrameTokenValue(themeTokens[frameVar]),
    )
    .map(({ frameVar }) => `\n    ${frameVar}: ${themeTokens[frameVar]};`)
    .join("");
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<style>
  :root {${themeDecls}
  }
  body { margin: 0; font-family: var(--calcula-font-family, 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif); font-size: 12px; overflow: hidden;${minHeight} color: var(--calcula-text, #1a1a1a); background: var(--calcula-bg, transparent); }
  * { box-sizing: border-box; }
</style>
<script>
  var SHAPE_ID = ${idLiteral};
  window.calcula = {
    sendMessage: function(type, data) {
      parent.postMessage({ source: ${tagLiteral}, instanceId: SHAPE_ID, type: type, data: data }, '*');
    }
  };
  window.addEventListener('message', function(e) {
    if (e.data && e.data.target === ${tagLiteral} && e.data.instanceId === SHAPE_ID) {
      window.dispatchEvent(new CustomEvent('shape-message', { detail: e.data }));
    }
  });
  var lastW = -1, lastH = -1;
  function reportSize() {
    var w = Math.ceil(document.documentElement.scrollWidth);
    var h = Math.ceil(document.documentElement.scrollHeight);
    if (w === lastW && h === lastH) return;
    lastW = w; lastH = h;
    window.calcula.sendMessage('calcula.size', { width: w, height: h });
  }
  if (typeof ResizeObserver === 'function') { new ResizeObserver(reportSize).observe(document.documentElement); }
  window.addEventListener('load', reportSize);
</script>
</head><body>${userHtml}</body></html>`;
}
