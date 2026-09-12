//! FILENAME: app/extensions/_shared/scriptFrame/__tests__/scriptFrameLoader.test.ts
// PURPOSE: Keep the two halves of the script-frame loader contract in step. The
//          bridge now lives in Rust (`app/src-tauri/src/script_frame.rs`, served
//          over a custom URI scheme so it carries its own CSP) and the host half
//          lives here. They talk by literal string, across a language boundary
//          no compiler checks.
//
// CONTEXT: BUG-0113. Written because the drift it catches ALREADY HAPPENED
//          during the fix: the loader was first authored with a freshly-invented
//          message tag, and the Rust unit test asserted that same invented
//          spelling — self-consistent, and wrong. `SCRIPT_FRAME_MESSAGE_TAG` is
//          "shape-html", the spelling a mounted script's own HTML already posts,
//          so it is a compatibility constraint rather than a name anyone is free
//          to choose. A test that reads only one side cannot see that; this one
//          reads BOTH files and compares them.
//
//          The failure it prevents is silent in the worst way: a frame that
//          loads, paints nothing, and never answers. No exception, no console
//          error, nothing in the audit ring.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SCRIPT_FRAME_MESSAGE_TAG,
  SCRIPT_FRAME_SIZE_MESSAGE,
  SCRIPT_FRAME_READY_MESSAGE,
  SCRIPT_FRAME_SET_CONTENT_MESSAGE,
  SCRIPT_FRAME_LOADER_URL,
  scriptFrameThemeCss,
  buildScriptFrameContent,
  isScriptFrameReadyMessage,
} from "../frameDocument";

const APP_ROOT = process.cwd();
const scriptFrameRs = readFileSync(join(APP_ROOT, "src-tauri/src/script_frame.rs"), "utf8");

/**
 * The BODY of the `SCRIPT_FRAME_LOADER` raw string, not the file around it.
 *
 * Scoping matters and the first draft of this file got it wrong: asserting
 * `not.toContain("document.open")` over the whole file failed, because that
 * file's own doc comment and unit test DISCUSS document.open in prose. This
 * project has the same defect on record one layer over — a `word(` inside a
 * comment fabricating a call edge in the store census — and the lesson is the
 * same: a textual guard must be given the text it actually governs.
 */
const loaderRs = (() => {
  const open = scriptFrameRs.indexOf('SCRIPT_FRAME_LOADER: &str = r#"');
  if (open < 0) throw new Error("SCRIPT_FRAME_LOADER literal not found in script_frame.rs");
  const start = scriptFrameRs.indexOf('r#"', open) + 3;
  const end = scriptFrameRs.indexOf('"#', start);
  if (end < 0) throw new Error("SCRIPT_FRAME_LOADER literal is unterminated");
  return scriptFrameRs.slice(start, end);
})();

describe("the Rust loader and the TypeScript host agree on the wire contract", () => {
  it("uses the SAME message tag a mounted script already posts", () => {
    expect(SCRIPT_FRAME_MESSAGE_TAG).toBe("shape-html");
    expect(
      loaderRs.includes(`var TAG = '${SCRIPT_FRAME_MESSAGE_TAG}';`),
      `script_frame.rs does not spell the tag ${SCRIPT_FRAME_MESSAGE_TAG}. Every ` +
        "shipped template posts that tag, so a loader using any other spelling " +
        "produces a frame that loads, paints, and silently never answers.",
    ).toBe(true);
  });

  it.each([
    ["ready", () => SCRIPT_FRAME_READY_MESSAGE],
    ["set-content", () => SCRIPT_FRAME_SET_CONTENT_MESSAGE],
    ["size", () => SCRIPT_FRAME_SIZE_MESSAGE],
  ])("the %s message name appears in the Rust loader", (_label, get) => {
    expect(loaderRs).toContain(get());
  });

  it("keeps every plumbing message under the reserved prefix", () => {
    // Reserved types are consumed by the host router and never forwarded to the
    // script, so a plumbing message outside the prefix would be delivered to
    // the page as if it had been sent by the app.
    for (const m of [SCRIPT_FRAME_READY_MESSAGE, SCRIPT_FRAME_SET_CONTENT_MESSAGE]) {
      expect(m.startsWith("calcula.")).toBe(true);
    }
  });

  it("never rewrites its own document, because that erases its own listener", () => {
    // document.open()'s steps erase all event listeners on the Window. A loader
    // that rewrote itself would accept exactly one push per navigation, so an
    // interactive template would paint its first state and freeze — BUG-0113's
    // symptom, reproduced by its own fix.
    expect(loaderRs).not.toContain("document.open");
    expect(loaderRs).not.toContain("document.write");
    expect(loaderRs).toContain("document.body.innerHTML");
  });

  it("the frame URL is permitted by the app's OWN policy, in both builds", () => {
    // The parent's frame-src is consulted BEFORE the frame's own policy, so a
    // missing entry here refuses the frame outright and the loader never runs.
    const conf = JSON.parse(
      readFileSync(join(APP_ROOT, "src-tauri/tauri.conf.json"), "utf8"),
    ) as { app: { security: { csp: string; devCsp: string } } };
    const origin = new URL(SCRIPT_FRAME_LOADER_URL).origin;
    for (const [name, csp] of [
      ["csp", conf.app.security.csp],
      ["devCsp", conf.app.security.devCsp],
    ] as const) {
      const frameSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("frame-src"));
      expect(frameSrc, `${name} has no frame-src directive`).toBeDefined();
      expect(
        frameSrc!.includes(origin),
        `${name}'s frame-src does not permit ${origin}, so the parent refuses the ` +
          "script frame before its own policy is ever consulted.",
      ).toBe(true);
    }
  });

  it("the fix does not loosen the APP's script-src, which is the whole point", () => {
    const conf = JSON.parse(
      readFileSync(join(APP_ROOT, "src-tauri/tauri.conf.json"), "utf8"),
    ) as { app: { security: { csp: string; devCsp: string } } };
    for (const csp of [conf.app.security.csp, conf.app.security.devCsp]) {
      const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"));
      expect(scriptSrc).toBeDefined();
      expect(scriptSrc).not.toContain("unsafe-inline");
      expect(scriptSrc).not.toContain("unsafe-eval");
    }
  });
});

describe("the content payload", () => {
  it("carries the id, because one constant loader serves every frame", () => {
    const p = buildScriptFrameContent("shape-7", "<b>hi</b>");
    expect(p.instanceId).toBe("shape-7");
    expect(p.html).toBe("<b>hi</b>");
  });

  it("omits minHeightPx unless the host asked for one", () => {
    expect(buildScriptFrameContent("a", "").minHeightPx).toBeUndefined();
    expect(buildScriptFrameContent("a", "", { minHeightPx: 56 }).minHeightPx).toBe(56);
  });

  it("filters theme tokens through the same safety check as the srcdoc route", () => {
    const css = scriptFrameThemeCss({
      "--calcula-text": "#123456",
      // Refused by isSafeScriptFrameTokenValue — it would close the declaration
      // and inject rules of its own.
      "--calcula-bg": "red; } body { display: none } :root {",
    });
    expect(css).toContain("--calcula-text: #123456;");
    expect(css).not.toContain("display: none");
  });

  it("emits tokens in the CONTRACT's order, not the caller's", () => {
    // The hosts gate a push on a content hash, so the same skin must always
    // produce the same text or every paint looks like a change.
    const a = scriptFrameThemeCss({ "--calcula-text": "#111", "--calcula-bg": "#222" });
    const b = scriptFrameThemeCss({ "--calcula-bg": "#222", "--calcula-text": "#111" });
    expect(a).toBe(b);
  });
});

describe("isScriptFrameReadyMessage", () => {
  const ev = (data: unknown): MessageEvent => ({ data }) as MessageEvent;

  it("accepts the loader's announcement", () => {
    expect(
      isScriptFrameReadyMessage(
        ev({ source: SCRIPT_FRAME_MESSAGE_TAG, type: SCRIPT_FRAME_READY_MESSAGE }),
      ),
    ).toBe(true);
  });

  it("refuses another sender's message wearing the same type", () => {
    expect(
      isScriptFrameReadyMessage(ev({ source: "somebody-else", type: SCRIPT_FRAME_READY_MESSAGE })),
    ).toBe(false);
  });

  it("refuses a size report and survives junk", () => {
    expect(
      isScriptFrameReadyMessage(
        ev({ source: SCRIPT_FRAME_MESSAGE_TAG, type: SCRIPT_FRAME_SIZE_MESSAGE }),
      ),
    ).toBe(false);
    expect(isScriptFrameReadyMessage(ev(null))).toBe(false);
    expect(isScriptFrameReadyMessage(ev("nope"))).toBe(false);
  });
});
