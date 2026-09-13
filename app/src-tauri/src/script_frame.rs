//! FILENAME: app/src-tauri/src/script_frame.rs
//! PURPOSE: Serve the script-frame LOADER over a custom URI scheme, so the
//!          `ui.html` postMessage bridge gets a policy container of its own
//!          instead of inheriting the app's.
//!
//! CONTEXT: BUG-0113. `render.setHtml` paints a script's HTML into an
//!          `allow-scripts` `srcdoc` iframe and injects an INLINE `<script>` as
//!          the bridge. A `srcdoc` child gets a CLONE of its embedder's policy
//!          container (HTML's "determine navigation params policy container"
//!          returns the initiator's when the response URL is `about:srcdoc`),
//!          so the app's `script-src 'self' blob:` — which carries no
//!          `'unsafe-inline'`, no nonce and no hash — lands inside the frame and
//!          refuses the bridge. The frame still PAINTS, so a display-only
//!          template looks perfect and only the ones that talk back are dead.
//!          Measured against a real release build: `window.calcula` absent,
//!          violations `["script-src-elem blocked inline"]`.
//!
//!          Nobody saw it because tauri attaches the CSP in exactly one place,
//!          the `tauri://` asset protocol, and `tauri dev` navigates straight to
//!          `build.devUrl` instead — so every dev run and every functional E2E
//!          run has exercised an unprotected build.
//!
//! WHY A CUSTOM SCHEME AND NOT A NONCE. There is no nonce-shaped fix: the
//! shipped "Interactive Counter" template and the default custom-pane scaffold
//! drive the bridge from inline `onclick=` ATTRIBUTES, which a nonce cannot
//! rescue even in principle. A real fetch response, by contrast, carries its own
//! `Content-Security-Policy` header, so the frame document gets its OWN policy
//! container rather than a clone of ours — and the app's policy stays exactly as
//! tight as it is.
//!
//! THE ISOLATION IS UNCHANGED, and it is worth being precise about what was ever
//! protecting the user here: not the app's CSP, but the OPAQUE ORIGIN. The frame
//! stays `sandbox="allow-scripts"` with no `allow-same-origin`, so it still has
//! no reach to the parent, no app-origin storage, no `__TAURI__`, and postMessage
//! remains the only channel. The frame's own policy is about constraining its
//! NETWORK reach, which sandboxing does not constrain at all — hence
//! `default-src 'none'` and `connect-src 'none'` below.
//!
//! THE LOADER IS THE BRIDGE, and that is load-bearing rather than stylistic.
//! An earlier design had the loader receive a full document and install it with
//! `document.open()/write()/close()`. That is fatal: HTML's document-open steps
//! erase all event listeners on the Window (step 10), so the loader's own
//! `message` listener dies with the first push and every later one is dropped in
//! silence. Both shipped interactive surfaces re-render on interaction, so the
//! counter would paint "0", the click would reach the script, and the display
//! would never update — BUG-0113's exact user-visible symptom, reproduced with a
//! protocol handler added. Content therefore arrives as a BODY SWAP
//! (`innerHTML`), which never executes `<script>` (irrelevant: the bridge is
//! already installed, and no shipped template carries a script tag) but DOES
//! install inline `onclick=` handlers, which this document's own
//! `script-src 'unsafe-inline'` permits. The frame also keeps its JS state
//! across content changes, which the hosts' content-hash gate was built around.

/// The scheme the loader is served on. Windows spells a custom scheme
/// `http://<scheme>.localhost`; other platforms use `<scheme>://localhost`
/// (tauri's `manager/webview.rs`). Stated here rather than discovered later —
/// this project is Windows-native, but the constant is the one place that
/// assumption lives.
pub const SCRIPT_FRAME_SCHEME: &str = "calcula-frame";

/// The policy the loader document carries, as its own response header.
///
/// `'self'` is deliberately absent from every directive. It would in fact
/// RESOLVE here — CSP3 §2.2 gives an inherited policy a self-origin precisely so
/// local-scheme documents with an opaque origin can still match it — but this
/// document needs no same-origin fetches at all, and a scheme-source list says
/// what is actually permitted without depending on that subtlety.
///
/// `frame-ancestors` is deliberately absent too. The obvious value,
/// `http://tauri.localhost`, would break `tauri dev` for every developer AND the
/// whole functional E2E suite, because in dev the embedder is
/// `http://localhost:5173` — i.e. it would fail in the one configuration where
/// the defect being fixed is invisible, which is where the fix gets developed.
/// Nothing outside the app can reach this scheme anyway, and the sandbox already
/// denies the frame anything worth stealing.
///
/// `img-src data:` is PROVISIONING, not permission for something that works
/// today: `vHtml` refuses every `data:` URI in a script's HTML, and the
/// `media:{sha256}` handle is never resolved on this path (filed open).
pub const SCRIPT_FRAME_CSP: &str = "default-src 'none'; \
     script-src 'unsafe-inline'; \
     style-src 'unsafe-inline'; \
     img-src data:; \
     connect-src 'none'; \
     form-action 'none'; \
     base-uri 'none'";

/// The loader document. CONSTANT — it carries no per-frame content, so one
/// cached response serves every script frame in the app and the response can be
/// a `&'static str`.
///
/// It must stay in step with the host half (`extensions/_shared/scriptFrame`):
/// the message tag, the ready signal and the content-push shape are one
/// contract. `scriptFrameLoader.test.ts` reads THIS file's text and asserts the
/// three spellings match the TypeScript constants, so a change to one side that
/// forgets the other fails a test rather than blanking every script frame.
pub const SCRIPT_FRAME_LOADER: &str = r#"<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<style id="calcula-frame-theme"></style>
<style>
  body { margin: 0; font-family: var(--calcula-font-family, 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif); font-size: 12px; overflow: hidden; color: var(--calcula-text, #1a1a1a); background: var(--calcula-bg, transparent); }
  * { box-sizing: border-box; }
</style>
<script>
(function () {
  // MUST equal SCRIPT_FRAME_MESSAGE_TAG in
  // extensions/_shared/scriptFrame/frameDocument.ts. It is the spelling a
  // mounted script's own HTML already posts, so it is a compatibility
  // constraint rather than a name anyone is free to pick.
  var TAG = 'shape-html';
  var RESERVED = 'calcula.';

  // The id arrives in the URL rather than in the first message, and that is
  // what lets BOTH directions keep the envelopes the host already has. The
  // host's router refuses any message without a string `instanceId` and then
  // checks `event.source === frame.contentWindow`; a frame that had to be TOLD
  // its id could not satisfy that on its own ready announcement, so it would
  // have needed a second, unchecked channel. Reading it here means the ready
  // message is an ordinary frame message and gets the ordinary source check.
  //
  // The response body is still one constant for every frame -- the scheme
  // handler ignores the request -- so this costs no per-frame work in Rust.
  var instanceId = (function () {
    var m = /[?&]id=([^&]*)/.exec(window.location.search);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch (err) { return null; }
  })();

  // Installed ONCE, on this Window, and never replaced. Content arrives as a
  // body swap precisely so this listener survives every push.
  window.calcula = {
    sendMessage: function (type, data) {
      if (instanceId === null) return;
      parent.postMessage({ source: TAG, instanceId: instanceId, type: type, data: data }, '*');
    }
  };

  var lastW = -1, lastH = -1;
  function reportSize() {
    var w = Math.ceil(document.documentElement.scrollWidth);
    var h = Math.ceil(document.documentElement.scrollHeight);
    if (w === lastW && h === lastH) return;
    lastW = w; lastH = h;
    window.calcula.sendMessage('calcula.size', { width: w, height: h });
  }

  function applyContent(payload) {
    if (!payload) return;
    if (typeof payload.themeCss === 'string') {
      var themeEl = document.getElementById('calcula-frame-theme');
      if (themeEl) themeEl.textContent = payload.themeCss;
    }
    if (typeof payload.minHeightPx === 'number') {
      document.body.style.minHeight = payload.minHeightPx + 'px';
    }
    if (typeof payload.html === 'string') {
      // A BODY SWAP, never a document rewrite: rewriting would erase every
      // listener on this Window -- including the one below -- and the frame
      // would then accept exactly one push per load. (The forbidden spellings
      // are deliberately not written out even in this comment: the guard in
      // scriptFrameLoader.test.ts is textual over this literal, and prose that
      // names what it forbids is how a textual guard reds on itself.)
      document.body.innerHTML = payload.html;
    }
    lastW = -1; lastH = -1;
    reportSize();
  }

  // The host -> frame envelope is `postToScriptFrame`'s, unchanged:
  // { target, instanceId, type, data }.
  window.addEventListener('message', function (e) {
    // THE IDENTITY CHECK, and it is the mirror of the host router's own
    // (`event.source !== frame.contentWindow` in frameBridge.ts). `e.data` is
    // attacker-controlled: a sandboxed sibling can reach `parent[i]` -- indexed
    // child WindowProxies stay cross-origin-accessible even from an opaque
    // origin -- and instance ids are derived from the anchor cell, so they are
    // guessable rather than secret. `e.source` is not forgeable; the browser
    // sets it.
    //
    // Without this, one script's frame could post `calcula.setContent` at
    // ANOTHER script's frame and have its HTML installed there by the body swap
    // below: markup that passed neither that script's `ui.html` grant nor
    // `vHtml`, painted inside a control the user trusts, and able to call the
    // victim frame's own `window.calcula.sendMessage` -- which posts under the
    // VICTIM's id from the VICTIM's window, so the host's source check passes
    // and the message is delivered to the victim's script as if its own UI had
    // sent it. Every legitimate message comes from the embedder, so the test is
    // exact rather than a heuristic.
    if (e.source !== parent) return;
    var d = e.data;
    if (!d || d.target !== TAG || instanceId === null || d.instanceId !== instanceId) return;
    var type = typeof d.type === 'string' ? d.type : '';
    if (type.indexOf(RESERVED) === 0) {
      // Plumbing, never handed to the script -- the mirror of the host router's
      // own rule, so a template cannot be confused by frame machinery arriving
      // as if the app had sent it.
      if (type === 'calcula.setContent') applyContent(d.data);
      return;
    }
    window.dispatchEvent(new CustomEvent('shape-message', { detail: d }));
  });

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(reportSize).observe(document.documentElement);
  }

  // The host cannot push until this document exists, and it has no other way to
  // learn that: a sandboxed frame's load event is not reliably observable from
  // the embedder. So the loader announces itself, and the host holds the newest
  // pending content until it hears this. Sent through `sendMessage` so it
  // carries the instanceId and passes the host router's source check like any
  // other frame message.
  window.calcula.sendMessage('calcula.frameReady', null);
})();
</script>
</head><body></body></html>
"#;

#[cfg(test)]
mod tests {
    use super::*;

    /// The three spellings the host half depends on. A drift here does not fail
    /// loudly at runtime — it produces a frame that loads, paints nothing, and
    /// never answers — so it is pinned on both sides.
    #[test]
    fn the_loader_carries_the_contract_the_host_half_expects() {
        // The tag is the compatibility constraint: it is what a mounted
        // script's own HTML already posts. Writing a new one here self-
        // consistently (this file agreeing with itself) is exactly the drift
        // `scriptFrameLoader.test.ts` exists to catch, because it reads THIS
        // file and `frameDocument.ts` and compares them.
        assert!(SCRIPT_FRAME_LOADER.contains("'shape-html'"));
        assert!(SCRIPT_FRAME_LOADER.contains("calcula.frameReady"));
        assert!(SCRIPT_FRAME_LOADER.contains("calcula.setContent"));
        assert!(SCRIPT_FRAME_LOADER.contains("calcula.size"));
    }

    /// `document.open`/`write` erase the Window's event listeners, which would
    /// cost the loader its own `message` handler after the first push and
    /// reproduce the exact symptom BUG-0113 describes. The body swap is the
    /// whole reason this design works, so its absence is asserted rather than
    /// left to review.
    #[test]
    fn the_loader_never_rewrites_its_own_document() {
        assert!(!SCRIPT_FRAME_LOADER.contains("document.open"));
        assert!(!SCRIPT_FRAME_LOADER.contains("document.write"));
        assert!(SCRIPT_FRAME_LOADER.contains("document.body.innerHTML"));
    }

    /// The policy must permit the inline bridge and the inline `onclick=`
    /// attributes the shipped templates use, and must not quietly permit
    /// network reach that the sandbox does not constrain.
    #[test]
    fn the_policy_permits_the_bridge_and_nothing_on_the_network() {
        assert!(SCRIPT_FRAME_CSP.contains("script-src 'unsafe-inline'"));
        assert!(SCRIPT_FRAME_CSP.contains("default-src 'none'"));
        assert!(SCRIPT_FRAME_CSP.contains("connect-src 'none'"));
        // Would break `tauri dev` and the functional E2E suite, where the
        // embedder is http://localhost:5173 rather than http://tauri.localhost.
        assert!(!SCRIPT_FRAME_CSP.contains("frame-ancestors"));
    }
}
