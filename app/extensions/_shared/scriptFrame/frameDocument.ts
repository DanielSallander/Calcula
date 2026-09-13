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
 * **NO PRODUCTION CALLER since BUG-0113 (2026-09-12).** Both hosts moved to the
 * loader route — `scriptFrameLoaderUrl` + a pushed `ScriptFrameContentPayload`
 * — because the `<script>` this builds was refused in every built app: a srcdoc
 * child inherits the embedder's policy container, and the app ships
 * `script-src 'self' blob:` with no `'unsafe-inline'`, no nonce and no hash.
 *
 * It survives ON PURPOSE, and only until one thing happens. It is the harness
 * `app/e2e/tests/csp-srcdoc-bridge.spec.ts` uses to MEASURE the defect against a
 * real bundled build; deleting it before the loader route has been measured the
 * same way would destroy the only before/after this project can point at.
 * Once that measurement exists, delete this function, its options' srcdoc-only
 * prose, and that spec's srcdoc half together.
 *
 * Until then it is what this repo files as a defect elsewhere — a second
 * implementation kept alive by its own tests — so it is named as such here
 * rather than left to look live. `scriptFrame.test.ts` no longer boots ITS
 * bridge; it boots the Rust loader's, because testing the retired one proved
 * the protocol agreed with a bridge nobody runs.
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

// ---------------------------------------------------------------------------
// The LOADER route (BUG-0113)
// ---------------------------------------------------------------------------
//
// `buildScriptFrameDocument` above is the SRCDOC route, and under the shipped
// CSP its bridge never runs: a `srcdoc` child gets a clone of the embedder's
// policy container, and the app ships `script-src 'self' blob:` with no
// `'unsafe-inline'`, no nonce and no hash. The frame paints, so display-only
// templates look perfect and only the ones that talk back are dead.
//
// The replacement serves a CONSTANT loader from a Rust URI-scheme handler
// (`app/src-tauri/src/script_frame.rs`), which carries its own
// `Content-Security-Policy` response header and therefore gets its own policy
// container. The loader IS the bridge, installed once per frame load; content
// arrives afterwards as a message and is applied as a BODY SWAP.
//
// Why a body swap and not a document rewrite: `document.open()` erases every
// event listener on the Window, so a loader that rewrote its own document would
// lose the listener that receives the next push. Both shipped interactive
// surfaces re-render on interaction, so the counter would paint "0", the click
// would reach the script, and the display would never update — which is
// BUG-0113's user-visible symptom, reproduced by its own fix.

/**
 * Where the loader is served. Windows spells a custom scheme
 * `http://<scheme>.localhost`; other platforms use `<scheme>://localhost`. This
 * project is Windows-native (CLAUDE.md), and the assumption lives HERE rather
 * than being discovered in a blank frame on another platform.
 *
 * Must appear in `frame-src` in BOTH `csp` and `devCsp`
 * (`app/src-tauri/tauri.conf.json`), or the PARENT's policy refuses the frame
 * before the frame's own policy is ever consulted.
 */
export const SCRIPT_FRAME_LOADER_ORIGIN = "http://calcula-frame.localhost";

/**
 * The `src` for one frame. The instance id travels in the URL, not in the first
 * message, and that is load-bearing rather than convenient: the host's router
 * refuses any message without a string `instanceId` and then checks
 * `event.source === frame.contentWindow`. A frame that had to be TOLD its id
 * could not satisfy that on its own ready announcement, so it would have needed
 * a second channel with no source check. Reading it from the URL keeps ready an
 * ordinary frame message.
 *
 * The served document is still ONE constant for every frame — the Rust scheme
 * handler ignores the request — so the query costs nothing on that side.
 */
export function scriptFrameLoaderUrl(instanceId: string): string {
  return `${SCRIPT_FRAME_LOADER_ORIGIN}/?id=${encodeURIComponent(instanceId)}`;
}

/**
 * Posted BY the loader, to the host, once its bridge is installed.
 *
 * The host cannot infer this: a sandboxed frame's `load` event is not reliably
 * observable from the embedder, and pushing content before the listener exists
 * drops it silently. So the loader announces itself and the host holds the
 * newest pending content until it hears this.
 */
export const SCRIPT_FRAME_READY_MESSAGE = "calcula.frameReady";

/** Posted BY the host, to the loader, to install or replace the frame's content. */
export const SCRIPT_FRAME_SET_CONTENT_MESSAGE = "calcula.setContent";

/**
 * The `data` of a {@link SCRIPT_FRAME_SET_CONTENT_MESSAGE}.
 *
 * It carries no `instanceId`: the push rides `postToScriptFrame`'s existing
 * envelope, which already puts one in, and the frame already knows its own from
 * its URL. Two spellings of the same id is a thing that can disagree.
 */
export interface ScriptFrameContentPayload {
  /** The script's own HTML, applied with `innerHTML`. */
  html: string;
  /** The `--calcula-*` declarations, as CSS text for the theme `<style>`. */
  themeCss: string;
  /** Optional floor on the body height, in CSS pixels (the pane card wants one). */
  minHeightPx?: number;
}

/**
 * Render the theme contract as the CSS text the loader installs.
 *
 * Split out of `buildScriptFrameDocument`'s inline construction so BOTH routes
 * filter the tokens through `isSafeScriptFrameTokenValue` and emit them in the
 * CONTRACT's order — the same reason that function gives: a skin must always
 * produce the same text, or the hosts' content-hash comparison sees spurious
 * changes.
 */
export function scriptFrameThemeCss(themeTokens: Record<string, string> = {}): string {
  const decls = SCRIPT_FRAME_THEME_TOKENS.filter(
    ({ frameVar }) =>
      Object.prototype.hasOwnProperty.call(themeTokens, frameVar) &&
      typeof themeTokens[frameVar] === "string" &&
      isSafeScriptFrameTokenValue(themeTokens[frameVar]),
  )
    .map(({ frameVar }) => `\n    ${frameVar}: ${themeTokens[frameVar]};`)
    .join("");
  return `:root {${decls}\n  }`;
}

/** Build the content push for a frame. Pure; the host decides when to send it. */
export function buildScriptFrameContent(
  userHtml: string,
  options: ScriptFrameDocumentOptions = {},
): ScriptFrameContentPayload {
  const payload: ScriptFrameContentPayload = {
    html: userHtml,
    themeCss: scriptFrameThemeCss(options.themeTokens),
  };
  if (options.minHeightPx !== undefined) payload.minHeightPx = options.minHeightPx;
  return payload;
}
