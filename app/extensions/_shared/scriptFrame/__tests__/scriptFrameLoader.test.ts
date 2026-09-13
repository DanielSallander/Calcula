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

/* eslint-disable @typescript-eslint/naming-convention --
 * The theme contract's keys are CSS custom properties (`--calcula-bg`), which
 * cannot be camelCase and are the literal strings the product emits; the same
 * exception `scriptFrame.test.ts` beside this file takes, for the same keys. */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SCRIPT_FRAME_MESSAGE_TAG,
  SCRIPT_FRAME_SIZE_MESSAGE,
  SCRIPT_FRAME_READY_MESSAGE,
  SCRIPT_FRAME_SET_CONTENT_MESSAGE,
  SCRIPT_FRAME_LOADER_ORIGIN,
  scriptFrameLoaderUrl,
  scriptFrameThemeCss,
  buildScriptFrameContent,
} from "../frameDocument";
import {
  createScriptFrameRouter,
  markScriptFrameReady,
  setScriptFrameContent,
  releaseScriptFrameContent,
  isScriptFrameReady,
  resetScriptFrameContentState,
} from "../frameBridge";

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
    const origin = SCRIPT_FRAME_LOADER_ORIGIN;
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
  it("does NOT carry the id — the envelope and the URL already do", () => {
    const p = buildScriptFrameContent("<b>hi</b>");
    expect(p.html).toBe("<b>hi</b>");
    // No instanceId: the push rides postToScriptFrame's envelope, which puts
    // one in, and the frame already knows its own from its URL.
    expect("instanceId" in p).toBe(false);
  });

  it("omits minHeightPx unless the host asked for one", () => {
    expect(buildScriptFrameContent("").minHeightPx).toBeUndefined();
    expect(buildScriptFrameContent("", { minHeightPx: 56 }).minHeightPx).toBe(56);
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


describe("scriptFrameLoaderUrl", () => {
  it("puts the instance id in the query, so the frame can name itself", () => {
    expect(scriptFrameLoaderUrl("shape-7")).toBe(
      `${SCRIPT_FRAME_LOADER_ORIGIN}/?id=shape-7`,
    );
  });

  it("encodes an id that would otherwise change the URL's shape", () => {
    // Instance ids are app-generated, but an id carrying & or # would silently
    // truncate what the frame reads back and it would then answer to the wrong
    // name — or to none, which reads as a frame that loaded and died.
    const url = scriptFrameLoaderUrl("a&b#c d");
    expect(url).toBe(`${SCRIPT_FRAME_LOADER_ORIGIN}/?id=a%26b%23c%20d`);
    expect(new URL(url).searchParams.get("id")).toBe("a&b#c d");
  });

  it("is on the origin the app's frame-src permits", () => {
    expect(new URL(scriptFrameLoaderUrl("x")).origin).toBe(SCRIPT_FRAME_LOADER_ORIGIN);
  });

  it("the loader reads the id back from exactly this query key", () => {
    // Pins the two sides of the same key. The Rust loader parses `id=`; if this
    // builder ever spelled it differently the frame would have no id, stay
    // silent, and paint nothing — with no error anywhere.
    expect(loaderRs).toContain("/[?&]id=([^&]*)/");
  });
});

describe("ready-gated content delivery", () => {
  const makeFrame = (): { el: HTMLIFrameElement; posted: unknown[] } => {
    const posted: unknown[] = [];
    const el = {
      contentWindow: { postMessage: (m: unknown) => posted.push(m) },
    } as unknown as HTMLIFrameElement;
    return { el, posted };
  };

  beforeEach(() => resetScriptFrameContentState());

  it("HOLDS content pushed before the loader says it is listening", () => {
    // The whole reason the gate exists: the bridge is fetched now, so there is
    // a real gap after `src` is assigned in which a push is dropped in silence.
    const { el, posted } = makeFrame();
    const sent = setScriptFrameContent("f1", el, buildScriptFrameContent("<b>one</b>"));
    expect(sent).toBe(false);
    expect(posted).toHaveLength(0);
  });

  it("flushes the held content when the loader announces itself", () => {
    const { el, posted } = makeFrame();
    setScriptFrameContent("f1", el, buildScriptFrameContent("<b>one</b>"));
    markScriptFrameReady("f1", el);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      target: SCRIPT_FRAME_MESSAGE_TAG,
      instanceId: "f1",
      type: SCRIPT_FRAME_SET_CONTENT_MESSAGE,
      data: { html: "<b>one</b>" },
    });
  });

  it("holds only the NEWEST payload, not a replay of every edit", () => {
    const { el, posted } = makeFrame();
    for (const html of ["<i>1</i>", "<i>2</i>", "<i>3</i>"]) {
      setScriptFrameContent("f1", el, buildScriptFrameContent(html));
    }
    markScriptFrameReady("f1", el);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ data: { html: "<i>3</i>" } });
  });

  it("pushes immediately once ready, with nothing left pending", () => {
    const { el, posted } = makeFrame();
    markScriptFrameReady("f1", el);
    expect(posted).toHaveLength(0); // nothing was waiting
    expect(setScriptFrameContent("f1", el, buildScriptFrameContent("<b>now</b>"))).toBe(true);
    expect(posted).toHaveLength(1);
  });

  it("re-sends on a SECOND ready, because that means a second document", () => {
    // A ready fires once per NAVIGATION. Hearing one twice for the same id
    // means the element was replaced — React re-creating a card's iframe when a
    // budget refusal lifts, or a document swap that leaves the card mounted —
    // and the new document has never been fed. Treating the second ready as a
    // duplicate and staying silent is how a card goes permanently blank: the
    // host already believed its content was delivered, so nothing would ever
    // push again.
    const { el, posted } = makeFrame();
    markScriptFrameReady("f1", el);
    setScriptFrameContent("f1", el, buildScriptFrameContent("<b>one</b>"));
    expect(posted).toHaveLength(1);

    markScriptFrameReady("f1", el);
    expect(posted).toHaveLength(2);
    expect(posted[1]).toMatchObject({ data: { html: "<b>one</b>" } });
  });

  it("re-sends nothing for an id it was never given content for", () => {
    const { el, posted } = makeFrame();
    markScriptFrameReady("f1", el);
    markScriptFrameReady("f1", el);
    expect(posted).toHaveLength(0);
  });

  it("release forgets the remembered content, so a dead id is not re-fed", () => {
    // The fallback must not outlive the host's interest in the instance: a
    // script's html can reach megabytes, and holding one per deleted control is
    // the leak the frame budget exists to prevent.
    const { el, posted } = makeFrame();
    markScriptFrameReady("f1", el);
    setScriptFrameContent("f1", el, buildScriptFrameContent("<b>one</b>"));
    releaseScriptFrameContent("f1");
    markScriptFrameReady("f1", el);
    expect(posted).toHaveLength(1);
  });

  it("release makes a frame not-ready again, because a reload re-announces", () => {
    // A host that re-points `src` gets a NEW document with no listener yet. If
    // readiness survived that, the next push would land in the gap and the
    // frame would stay blank with nothing logged.
    const { el, posted } = makeFrame();
    markScriptFrameReady("f1", el);
    releaseScriptFrameContent("f1");
    expect(isScriptFrameReady("f1")).toBe(false);
    expect(setScriptFrameContent("f1", el, buildScriptFrameContent("<b>x</b>"))).toBe(false);
    expect(posted).toHaveLength(0);
  });

  it("keeps frames separate — one going ready does not flush another's", () => {
    const a = makeFrame();
    const b = makeFrame();
    setScriptFrameContent("f1", a.el, buildScriptFrameContent("<b>A</b>"));
    setScriptFrameContent("f2", b.el, buildScriptFrameContent("<b>B</b>"));
    markScriptFrameReady("f1", a.el);
    expect(a.posted).toHaveLength(1);
    expect(b.posted).toHaveLength(0);
  });

  it("a frame with no contentWindow keeps its payload rather than losing it", () => {
    // React can commit a ref before the element has a window, and a teardown
    // can take it away mid-flight. Dropping the payload there would be a blank
    // card that never recovers.
    const detached = { contentWindow: null } as unknown as HTMLIFrameElement;
    markScriptFrameReady("f1", detached);
    expect(setScriptFrameContent("f1", detached, buildScriptFrameContent("<b>x</b>"))).toBe(false);
    const { el, posted } = makeFrame();
    markScriptFrameReady("f1", el);
    expect(posted).toHaveLength(1);
  });
});

describe("the router reports readiness instead of forwarding it", () => {
  const frame = { contentWindow: {} } as unknown as HTMLIFrameElement;
  const event = (data: unknown, source: unknown): MessageEvent =>
    ({ data, source }) as MessageEvent;

  it("calls onReady and never delivers the announcement to the script", () => {
    const delivered: unknown[] = [];
    const ready: string[] = [];
    const route = createScriptFrameRouter({
      resolveFrame: () => frame,
      deliver: (m) => delivered.push(m),
      onReady: (id) => ready.push(id),
    });
    const result = route(
      event(
        {
          source: SCRIPT_FRAME_MESSAGE_TAG,
          instanceId: "f1",
          type: SCRIPT_FRAME_READY_MESSAGE,
        },
        frame.contentWindow,
      ),
    );
    expect(result).toBe("ready");
    expect(ready).toEqual(["f1"]);
    expect(delivered).toHaveLength(0);
  });

  it("refuses a ready claimed by a window that is not that frame", () => {
    // Same integrity rule as every other frame message: anything can claim an
    // id, only the frame the host created can BE that id's window.
    const ready: string[] = [];
    const route = createScriptFrameRouter({
      resolveFrame: () => frame,
      deliver: () => {},
      onReady: (id) => ready.push(id),
    });
    const result = route(
      event(
        {
          source: SCRIPT_FRAME_MESSAGE_TAG,
          instanceId: "f1",
          type: SCRIPT_FRAME_READY_MESSAGE,
        },
        { impostor: true },
      ),
    );
    expect(result).toBe("source-mismatch");
    expect(ready).toHaveLength(0);
  });
});
