//! FILENAME: app/extensions/_shared/scriptFrame/__tests__/scriptFrame.test.ts
// PURPOSE: The behaviour of the ONE script-frame module both `ui.html` hosts
//          now share (M6b) — the host-side router's identity check, the
//          reserved-type isolation, the theme contract, the live-frame budget,
//          and (M6b-fix) the ROUND TRIP that runs the built document's own
//          bridge against that router and that poster, so the protocol's two
//          ends have to agree by execution rather than by docstring.
// CONTEXT: `Controls/__tests__/srcdocBridgeCsp.test.ts` pins the SHAPE of the
//          document against the shipped CSP by reading the source text. This
//          file pins BEHAVIOUR by running it. They are complementary: the other
//          one would still pass if the router accepted a message from the wrong
//          frame, and this one would still pass if the bridge grew a nonce.
//
//          The router half is worth testing on its own even while the frame's
//          own bridge cannot execute under the shipped CSP (see frameDocument.ts
//          header): the host end is ordinary app-realm code, it runs today, and
//          it is the half that decides whether one frame can impersonate
//          another.

/* eslint-disable @typescript-eslint/naming-convention --
 * The theme contract's keys are CSS custom properties (`--calcula-bg`), which
 * cannot be camelCase and are the literal strings the product emits; the same
 * repo-wide exception vite.config.ts takes for its `'@api'` alias key. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import {
  buildScriptFrameDocument,
  claimScriptFrameSlot,
  createScriptFrameRouter,
  isSafeScriptFrameTokenValue,
  migrateScriptFrameSlot,
  parkScriptFrameSlot,
  parkedScriptFrameCount,
  postToScriptFrame,
  readScriptFrameThemeTokens,
  releaseScriptFrameSlot,
  resetScriptFrameBudget,
  scriptFrameBudgetUsage,
  unparkScriptFrameSlot,
  MAX_LIVE_SCRIPT_FRAMES,
  MAX_LIVE_SCRIPT_FRAME_BYTES,
  SCRIPT_FRAME_MESSAGE_TAG,
  SCRIPT_FRAME_SIZE_MESSAGE,
  SCRIPT_FRAME_SET_CONTENT_MESSAGE,
  SCRIPT_FRAME_THEME_TOKENS,
  type ScriptFrameIntrinsicSize,
  type ScriptFrameMessage,
} from "..";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** A stand-in for a frame's `contentWindow`. Identity is all the router uses,
 *  and jsdom will not give an unattached iframe a real one. */
function fakeWindow(name: string): Window {
  return { __name: name } as unknown as Window;
}

/** A stand-in for the iframe element the host registered. */
function fakeFrame(contentWindow: Window | null): HTMLIFrameElement {
  return { contentWindow } as unknown as HTMLIFrameElement;
}

/** A `message` event carrying the frame->host envelope. */
function frameMessage(
  source: Window | null,
  body: Record<string, unknown>,
): MessageEvent {
  return { source, data: body } as unknown as MessageEvent;
}

// ---------------------------------------------------------------------------
// The identity check
// ---------------------------------------------------------------------------

describe("createScriptFrameRouter: only the registered frame speaks for its id", () => {
  it("delivers a message that came from the frame registered for the id", () => {
    const win = fakeWindow("mine");
    const delivered: ScriptFrameMessage[] = [];
    const route = createScriptFrameRouter({
      resolveFrame: (id) => (id === "shape-1" ? fakeFrame(win) : null),
      deliver: (m) => delivered.push(m),
    });

    const verdict = route(
      frameMessage(win, {
        source: SCRIPT_FRAME_MESSAGE_TAG,
        instanceId: "shape-1",
        type: "increment",
        data: { by: 2 },
      }),
    );

    expect(verdict).toBe("delivered");
    expect(delivered).toEqual([
      { instanceId: "shape-1", type: "increment", data: { by: 2 } },
    ]);
  });

  it("REFUSES a foreign frame claiming another frame's instanceId", () => {
    // The whole reason the check exists. `e.data` is attacker-controlled: any
    // frame in the window can post this exact envelope. `e.source` is not.
    const mine = fakeWindow("mine");
    const foreign = fakeWindow("foreign");
    const delivered: ScriptFrameMessage[] = [];
    const route = createScriptFrameRouter({
      resolveFrame: (id) => (id === "shape-1" ? fakeFrame(mine) : null),
      deliver: (m) => delivered.push(m),
    });

    const verdict = route(
      frameMessage(foreign, {
        source: SCRIPT_FRAME_MESSAGE_TAG,
        instanceId: "shape-1",
        type: "increment",
        data: { by: 2 },
      }),
    );

    expect(verdict).toBe("source-mismatch");
    expect(delivered).toEqual([]);
  });

  it("leaves the other host's ids alone instead of claiming them", () => {
    // Both hosts listen on the SAME window. A router that treated an
    // unrecognised id as an error rather than as "not mine" would either
    // swallow the other host's traffic or log noise on every message.
    const win = fakeWindow("pane");
    const delivered: ScriptFrameMessage[] = [];
    const route = createScriptFrameRouter({
      resolveFrame: (id) => (id.startsWith("pane-") ? fakeFrame(win) : null),
      deliver: (m) => delivered.push(m),
    });

    expect(
      route(
        frameMessage(win, {
          source: SCRIPT_FRAME_MESSAGE_TAG,
          instanceId: "shape-7",
          type: "click",
        }),
      ),
    ).toBe("not-this-host");
    expect(delivered).toEqual([]);
  });

  it("ignores anything that is not the frame envelope", () => {
    const route = createScriptFrameRouter({
      resolveFrame: () => fakeFrame(fakeWindow("w")),
      deliver: () => {
        throw new Error("must not deliver");
      },
    });
    expect(route(frameMessage(null, { hello: "world" }))).toBe("not-a-frame-message");
    expect(route(frameMessage(null, { source: "something-else", instanceId: "x" }))).toBe(
      "not-a-frame-message",
    );
    // An envelope with a non-string instanceId is the shape a fuzzer finds
    // first, and it must not reach `resolveFrame` as `undefined`.
    expect(route(frameMessage(null, { source: SCRIPT_FRAME_MESSAGE_TAG, instanceId: 7 }))).toBe(
      "not-a-frame-message",
    );
  });
});

// ---------------------------------------------------------------------------
// Reserved types: bridge plumbing is not page content
// ---------------------------------------------------------------------------

describe("createScriptFrameRouter: reserved types never reach the script", () => {
  it("routes calcula.size to the size handler, not to deliver()", () => {
    const win = fakeWindow("mine");
    const delivered: ScriptFrameMessage[] = [];
    const sizes: ScriptFrameIntrinsicSize[] = [];
    const route = createScriptFrameRouter({
      resolveFrame: () => fakeFrame(win),
      deliver: (m) => delivered.push(m),
      onIntrinsicSize: (s) => sizes.push(s),
    });

    const verdict = route(
      frameMessage(win, {
        source: SCRIPT_FRAME_MESSAGE_TAG,
        instanceId: "shape-1",
        type: SCRIPT_FRAME_SIZE_MESSAGE,
        data: { width: 320, height: 180 },
      }),
    );

    expect(verdict).toBe("resized");
    expect(sizes).toEqual([{ instanceId: "shape-1", width: 320, height: 180 }]);
    expect(delivered).toEqual([]);
  });

  it("still withholds a reserved type from a host that has no size handler", () => {
    // The on-grid overlay is the size the user drew the shape, so it passes no
    // handler. The report must still be CONSUMED — forwarding it would hand a
    // script a message its own page never sent.
    const win = fakeWindow("mine");
    const delivered: ScriptFrameMessage[] = [];
    const route = createScriptFrameRouter({
      resolveFrame: () => fakeFrame(win),
      deliver: (m) => delivered.push(m),
    });

    expect(
      route(
        frameMessage(win, {
          source: SCRIPT_FRAME_MESSAGE_TAG,
          instanceId: "shape-1",
          type: "calcula.anythingElse",
          data: 1,
        }),
      ),
    ).toBe("resized");
    expect(delivered).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

describe("buildScriptFrameDocument", () => {
  it("publishes the theme contract, in the contract's own order", () => {
    // Order is fixed by the contract and not by the caller's object, so the
    // same skin always yields the same document — both hosts compare the
    // content they last painted, and a reordered map would look like a change
    // and reload the frame (throwing away its state) for nothing.
    const doc = buildScriptFrameDocument("shape-1", "<b>hi</b>", {
      themeTokens: {
        "--calcula-text": "#101010",
        "--calcula-bg": "#ffffff",
      },
    });
    expect(doc.indexOf("--calcula-bg: #ffffff;")).toBeGreaterThan(-1);
    expect(doc.indexOf("--calcula-bg: #ffffff;")).toBeLessThan(
      doc.indexOf("--calcula-text: #101010;"),
    );
    expect(doc).toContain("<body><b>hi</b></body>");
  });

  it("drops a token value that could break out of the declaration", () => {
    // A skin is CONTRIBUTABLE (registerSkin, including by a third-party
    // extension), so a token value is not trusted just because it arrived from
    // the host side. The frame's var() fallbacks mean a dropped token degrades
    // to a sensible colour rather than to nothing.
    const doc = buildScriptFrameDocument("shape-1", "", {
      themeTokens: {
        "--calcula-bg": "#fff; } * { display: none } /*",
        "--calcula-text": "#222222",
      },
    });
    expect(doc).not.toContain("display: none");
    expect(doc).not.toContain("--calcula-bg:");
    expect(doc).toContain("--calcula-text: #222222;");
    expect(isSafeScriptFrameTokenValue("#fff; } * { display: none } /*")).toBe(false);
    expect(isSafeScriptFrameTokenValue("'Segoe UI Variable', system-ui, sans-serif")).toBe(true);
    expect(isSafeScriptFrameTokenValue("url(https://tracker.example/p.png)")).toBe(false);
  });

  it("applies the pane card's body floor only when asked for one", () => {
    expect(buildScriptFrameDocument("pane-1", "", { minHeightPx: 40 })).toContain(
      "min-height: 40px;",
    );
    expect(buildScriptFrameDocument("shape-1", "")).not.toContain("min-height:");
  });

  it("cannot have its <script> terminated by the instance id", () => {
    const doc = buildScriptFrameDocument('a"</script><script>alert(1)</script>', "");
    expect(doc).not.toContain("alert(1)</script>");
    expect(doc).toContain("\\u003c/script");
  });

  it("reads no theme at all when there is no root to read", () => {
    expect(readScriptFrameThemeTokens(null)).toEqual({});
    // The contract is a fixed, small set on purpose — the app's own token
    // vocabulary is ~120 names, and publishing all of it to distributed apps
    // would freeze the app's internal styling surface as a de-facto API.
    expect(SCRIPT_FRAME_THEME_TOKENS.length).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// The two ends of one protocol, run against each other
//
// Everything above tests ONE end at a time. That is how the protocol tag got to
// be spelled four times while the constant's own docstring claimed it was
// spelled once: the router tests use `SCRIPT_FRAME_MESSAGE_TAG` on BOTH sides of
// their fake, so they agree with themselves no matter what the frame document
// says, and the file-text guard in `Controls/__tests__/srcdocBridgeCsp.test.ts`
// only ever compared source text to source text. A rename of the constant would
// have left the built document posting the old tag at a router checking the new
// one — every message from every frame silently dropped, whole suite green.
//
// So this block boots the REAL document's bridge (extracted from the string
// `buildScriptFrameDocument` actually returns) and runs it against the REAL
// router and the REAL poster. Nothing here restates a spelling; agreement has to
// come out of execution.
// ---------------------------------------------------------------------------

/** A frame's bridge, booted the way a browser boots it, with its effects
 *  recorded instead of performed. */
interface BootedBridge {
  /** Envelopes the bridge posted to its embedder, in order. */
  posted: Record<string, unknown>[];
  /** Events the bridge re-dispatched inside the frame, in order. */
  dispatched: CustomEvent[];
  /** Deliver a host -> frame message, as the browser's `message` event would. */
  receive: (data: unknown) => void;
  /** Deliver a message from a window that is NOT the embedder. */
  fromForeignWindow: (data: unknown) => void;
  /** Push content, as `setScriptFrameContent` does once the loader is ready. */
  setContent: (payload: Record<string, unknown>) => void;
  /** What the body swap actually installed, so a test can see the content land. */
  body: { innerHTML: string; style: { minHeight: string } };
  /** The theme <style>'s text, likewise. */
  themeCss: () => string;
  /** Call `window.calcula.sendMessage`, as the script's own HTML does. */
  send: (type: string, data: unknown) => void;
}

/**
 * Run the bridge out of a document the product would actually serve.
 *
 * The `<script>` body is taken from the built document rather than from the
 * source file, so the template's interpolations are resolved exactly as they
 * are for a real frame. `window`, `parent`, `document` and `ResizeObserver` are
 * parameters, which shadows the globals of the same name — the bridge cannot
 * reach jsdom's real window by accident and quietly pass a test on it.
 */
/**
 * The loader document Rust serves, read from source.
 *
 * Scoped to the raw-string LITERAL, not the whole file: that file DISCUSSES the
 * spellings it forbids in its own prose, and a textual guard handed the file
 * would red on the comments explaining it.
 */
const SCRIPT_FRAME_LOADER_TEXT = (() => {
  const src = readFileSync(join(process.cwd(), "src-tauri/src/script_frame.rs"), "utf8");
  const at = src.indexOf('SCRIPT_FRAME_LOADER: &str = r#"');
  if (at < 0) throw new Error("script_frame.rs no longer declares SCRIPT_FRAME_LOADER");
  const start = src.indexOf('r#"', at) + 3;
  const end = src.indexOf('"#', start);
  return src.slice(start, end);
})();
function bootFrameBridge(
  instanceId: string,
  scroll: { width: number; height: number } = { width: 321, height: 177 },
): BootedBridge {
  // The LOADER, read out of the Rust file that serves it (BUG-0113). It used to
  // be `buildScriptFrameDocument`'s <script>, and that document no longer
  // reaches a user: a srcdoc child inherits the app's CSP, so its inline bridge
  // was refused in every built app. Booting the text that actually ships is the
  // whole point of this block — a harness pointed at the retired builder would
  // have proved the protocol agreed with a bridge nobody runs.
  const body = /<script[^>]*>([\s\S]*?)<\/script>/.exec(SCRIPT_FRAME_LOADER_TEXT);
  expect(body, "the Rust loader carries no <script> bridge").not.toBeNull();

  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const dispatched: CustomEvent[] = [];
  const posted: Record<string, unknown>[] = [];
  const frameWindow: Record<string, unknown> = {
    // The loader reads its own id from the URL rather than waiting to be told,
    // so the ready message it posts can carry one and pass the router's source
    // check like any other frame message.
    location: { search: `?id=${encodeURIComponent(instanceId)}` },
    addEventListener(type: string, fn: (event: unknown) => void): void {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    dispatchEvent(event: CustomEvent): boolean {
      dispatched.push(event);
      return true;
    },
  };
  const parentWindow = {
    postMessage(data: Record<string, unknown>): void {
      posted.push(data);
    },
  };
  // Enough document for the loader's body swap: the theme <style> it fills, the
  // body it writes into, and the element it measures.
  const themeStyle = { textContent: "" };
  const frameBody = { innerHTML: "", style: { minHeight: "" } };
  const frameDocument = {
    documentElement: { scrollWidth: scroll.width, scrollHeight: scroll.height },
    body: frameBody,
    getElementById: (id: string) => (id === "calcula-frame-theme" ? themeStyle : null),
  };
  // A constructor-shaped stand-in: `typeof` must be "function" or the bridge
  // skips the branch, and `new` must yield something with `observe`.
  const resizeObserver = function ResizeObserverDouble(): { observe: () => void } {
    return { observe: () => undefined };
  };

  // Executing the product's OWN bridge text is the point: a paraphrase here
  // would be a fifth copy of the protocol, which is the defect being guarded.
  const boot = new Function("window", "parent", "document", "ResizeObserver", body![1]);
  boot(frameWindow, parentWindow, frameDocument, resizeObserver);

  const fire = (type: string, event: unknown): void => {
    for (const fn of listeners.get(type) ?? []) fn(event);
  };
  const calcula = frameWindow.calcula as { sendMessage: (type: string, data: unknown) => void };
  expect(calcula, "the bridge no longer installs window.calcula").toBeTruthy();
  return {
    posted,
    dispatched,
    receive: (data) => fire("message", { data, source: parentWindow }),
    fromForeignWindow: (data) => fire("message", { data, source: { hostile: true } }),
    setContent: (payload) =>
      fire("message", {
        source: parentWindow,
        data: {
          target: SCRIPT_FRAME_MESSAGE_TAG,
          instanceId,
          type: SCRIPT_FRAME_SET_CONTENT_MESSAGE,
          data: payload,
        },
      }),
    body: frameBody,
    themeCss: () => themeStyle.textContent,
    send: (type, data) => calcula.sendMessage(type, data),
  };
}

describe("the frame's own bridge and the host's router are ONE protocol", () => {
  it("announces itself the moment it boots, so the host can release its content", () => {
    // The loader's FIRST act, and the thing the whole delivery gate turns on:
    // the bridge is fetched now, so the host cannot know when it exists. It is
    // asserted here, against the real text, because a loader that stopped
    // announcing would leave every frame blank with nothing logged.
    const bridge = bootFrameBridge("shape-1");
    const win = fakeWindow("frame-1");
    const ready: string[] = [];
    const route = createScriptFrameRouter({
      resolveFrame: (id) => (id === "shape-1" ? fakeFrame(win) : null),
      deliver: () => {
        throw new Error("the ready announcement must never reach the script");
      },
      onReady: (id) => ready.push(id),
    });

    expect(bridge.posted).toHaveLength(1);
    expect(route(frameMessage(win, bridge.posted[0]))).toBe("ready");
    expect(ready).toEqual(["shape-1"]);
  });

  it("carries a script's message out of the frame and into deliver()", () => {
    const bridge = bootFrameBridge("shape-1");
    bridge.send("increment", { by: 2 });

    const win = fakeWindow("frame-1");
    const delivered: ScriptFrameMessage[] = [];
    const route = createScriptFrameRouter({
      resolveFrame: (id) => (id === "shape-1" ? fakeFrame(win) : null),
      deliver: (m) => delivered.push(m),
      onReady: () => undefined,
    });

    // posted[0] is the loader's ready announcement; the script's own message is
    // the one after it.
    expect(bridge.posted).toHaveLength(2);
    // THE ASSERTION THAT MATTERS: the router's verdict on the envelope the
    // DOCUMENT produced. "not-a-frame-message" here means the two ends stopped
    // agreeing — which in the app is a script whose messages vanish.
    expect(route(frameMessage(win, bridge.posted[1]))).toBe("delivered");
    expect(delivered).toEqual([
      { instanceId: "shape-1", type: "increment", data: { by: 2 } },
    ]);
  });

  it("carries a host post back INTO the frame as a shape-message event", () => {
    const bridge = bootFrameBridge("shape-1");
    const inbound: Record<string, unknown>[] = [];
    const frame = {
      contentWindow: { postMessage: (data: Record<string, unknown>) => inbound.push(data) },
    } as unknown as HTMLIFrameElement;

    // The poster both hosts now use — the on-grid `shape:sendMessage` forwarder,
    // the hit-region pointer message and the pane card's forwarder all end here.
    expect(postToScriptFrame(frame, "shape-1", "refresh", { n: 1 })).toBe(true);
    expect(inbound).toHaveLength(1);
    bridge.receive(inbound[0]);

    expect(bridge.dispatched).toHaveLength(1);
    expect(bridge.dispatched[0].type).toBe("shape-message");
    expect((bridge.dispatched[0].detail as { type: string }).type).toBe("refresh");
    expect((bridge.dispatched[0].detail as { data: unknown }).data).toEqual({ n: 1 });
  });

  it("still ignores a post addressed to another frame, or to nothing", () => {
    // The positive control above would also pass a bridge that dispatched
    // everything it was handed. Both filters have to keep working.
    const bridge = bootFrameBridge("shape-1");
    const other: Record<string, unknown>[] = [];
    const frame = {
      contentWindow: { postMessage: (data: Record<string, unknown>) => other.push(data) },
    } as unknown as HTMLIFrameElement;
    postToScriptFrame(frame, "shape-2", "refresh", null);
    bridge.receive(other[0]);
    bridge.receive({ target: "some-other-protocol", instanceId: "shape-1", type: "refresh" });
    expect(bridge.dispatched).toEqual([]);
  });

  it("carries the bridge's own size report to onIntrinsicSize, never to the script", () => {
    const bridge = bootFrameBridge("shape-1", { width: 321, height: 177 });
    // Reported when CONTENT lands, not on `load`. Under srcdoc the content was
    // in the document at load time, so `load` was the moment its size settled;
    // the loader boots empty and the body swap is the moment now. Reporting on
    // load would measure an empty document and publish 0x0.
    bridge.setContent({ html: "<b>hi</b>", themeCss: ":root {\n  }" });

    const win = fakeWindow("frame-1");
    const delivered: ScriptFrameMessage[] = [];
    const sizes: ScriptFrameIntrinsicSize[] = [];
    const route = createScriptFrameRouter({
      resolveFrame: () => fakeFrame(win),
      deliver: (m) => delivered.push(m),
      onIntrinsicSize: (s) => sizes.push(s),
      onReady: () => undefined,
    });

    // posted[0] is the ready announcement; posted[1] is the size report the
    // body swap triggered.
    expect(bridge.posted).toHaveLength(2);
    expect(route(frameMessage(win, bridge.posted[1]))).toBe("resized");
    expect(sizes).toEqual([{ instanceId: "shape-1", width: 321, height: 177 }]);
    expect(delivered).toEqual([]);
  });

  it("REFUSES a message from a window that is not its embedder", () => {
    // The frame's half of the identity check, and the mirror of the host-side
    // one above. `e.data` is attacker-controlled: a sandboxed sibling can reach
    // `parent[i]` — indexed child WindowProxies stay cross-origin-accessible
    // even from an opaque origin — and instance ids are derived from the anchor
    // cell, so they are guessable rather than secret.
    //
    // Without this check one script's frame could post `calcula.setContent` at
    // ANOTHER script's frame and have its markup installed there by the body
    // swap: HTML that passed neither that script's `ui.html` grant nor `vHtml`,
    // painted inside a control the user trusts — and able to call the victim
    // frame's own `window.calcula.sendMessage`, which posts under the VICTIM's
    // id from the VICTIM's window, so the HOST's source check passes and the
    // message reaches the victim's script as if its own UI had sent it.
    const bridge = bootFrameBridge("shape-1");
    const before = bridge.body.innerHTML;

    bridge.fromForeignWindow({
      target: SCRIPT_FRAME_MESSAGE_TAG,
      instanceId: "shape-1",
      type: SCRIPT_FRAME_SET_CONTENT_MESSAGE,
      data: { html: "<img src=x onerror='stealTheCredential()'>" },
    });
    expect(
      bridge.body.innerHTML,
      "a foreign window replaced this frame's DOM — the body swap ran for a " +
        "message the embedder never sent",
    ).toBe(before);

    // ...and an ordinary message from a foreign window is not re-dispatched to
    // the page either. That half was already reachable before the loader route
    // (the srcdoc bridge had no source check), so it is closed here too.
    bridge.fromForeignWindow({
      target: SCRIPT_FRAME_MESSAGE_TAG,
      instanceId: "shape-1",
      type: "refresh",
      data: null,
    });
    expect(bridge.dispatched).toEqual([]);

    // POSITIVE CONTROL: the same message from the embedder IS applied, so the
    // check is refusing the right thing rather than everything.
    bridge.setContent({ html: "<b>legitimate</b>", themeCss: ":root {\n  }" });
    expect(bridge.body.innerHTML).toBe("<b>legitimate</b>");
  });

});

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

describe("the live-frame budget", () => {
  beforeEach(() => {
    resetScriptFrameBudget();
  });

  it("re-prices an instance instead of counting it twice", () => {
    expect(claimScriptFrameSlot("a", 100).granted).toBe(true);
    expect(claimScriptFrameSlot("a", 250).granted).toBe(true);
    expect(scriptFrameBudgetUsage()).toEqual({ frames: 1, bytes: 250 });
    releaseScriptFrameSlot("a");
    expect(scriptFrameBudgetUsage()).toEqual({ frames: 0, bytes: 0 });
    // Releasing twice must not drive the total negative — the render loop and
    // the teardown path both release, and they do not coordinate.
    releaseScriptFrameSlot("a");
    expect(scriptFrameBudgetUsage()).toEqual({ frames: 0, bytes: 0 });
  });

  it("refuses the frame past the count cap, and says which budget it hit", () => {
    for (let i = 0; i < MAX_LIVE_SCRIPT_FRAMES; i++) {
      expect(claimScriptFrameSlot(`f${i}`, 10).granted).toBe(true);
    }
    const refused = claimScriptFrameSlot("one-too-many", 10);
    expect(refused.granted).toBe(false);
    expect(refused.refusal).toBe("too-many-frames");
    expect(refused.message).toContain(String(MAX_LIVE_SCRIPT_FRAMES));
    // An id that already holds a slot is still served at the cap: refusing it
    // would freeze every live frame's content the moment the cap was reached.
    expect(claimScriptFrameSlot("f0", 20).granted).toBe(true);
  });

  it("refuses on total bytes even when the count is fine", () => {
    expect(claimScriptFrameSlot("big", MAX_LIVE_SCRIPT_FRAME_BYTES - 10).granted).toBe(true);
    const refused = claimScriptFrameSlot("small", 100);
    expect(refused.granted).toBe(false);
    expect(refused.refusal).toBe("too-many-bytes");
    expect(scriptFrameBudgetUsage().frames).toBe(1);
  });

  it("moves the charge when a structural edit re-keys a control", () => {
    claimScriptFrameSlot("old", 500);
    migrateScriptFrameSlot("old", "new");
    expect(scriptFrameBudgetUsage()).toEqual({ frames: 1, bytes: 500 });
    releaseScriptFrameSlot("new");
    expect(scriptFrameBudgetUsage()).toEqual({ frames: 0, bytes: 0 });
  });

  it("takes the destination's charge with it when the re-key lands on an occupied id", () => {
    // Ids are anchor-derived (`control-<sheet>-<row>-<col>`) and re-anchoring
    // does not check for collisions: a FREE shape at row 8 keeps its id when
    // rows 8-9 are deleted, while the PINNED shape at row 10 re-keys onto that
    // very id.
    claimScriptFrameSlot("control-0-8-2", 400_000);
    claimScriptFrameSlot("control-0-10-2", 400_000);
    migrateScriptFrameSlot("control-0-10-2", "control-0-8-2");

    // One entry survived, so the total is one frame's worth. Keeping the
    // displaced charge made the total say 800000 with a single frame live.
    expect(scriptFrameBudgetUsage()).toEqual({ frames: 1, bytes: 400_000 });
    // ...and the books can still reach zero. That is the part nothing could
    // repair: release subtracts only the entry that survived, so the surplus
    // stood for the rest of the session with no live frame to explain it.
    releaseScriptFrameSlot("control-0-8-2");
    expect(scriptFrameBudgetUsage()).toEqual({ frames: 0, bytes: 0 });
  });

  it("leaves an occupied destination alone when the moving id holds no slot", () => {
    // A plain shape being re-keyed over an html one overwrites nothing, so it
    // displaces nothing: only the key the migration actually writes is spent.
    claimScriptFrameSlot("control-0-8-2", 300);
    migrateScriptFrameSlot("control-0-10-2", "control-0-8-2");
    expect(scriptFrameBudgetUsage()).toEqual({ frames: 1, bytes: 300 });
  });
});

// ---------------------------------------------------------------------------
// Parked frames
//
// The on-grid host hides a departing sheet's frames rather than removing them,
// to keep the state their own scripts built. Those frames kept their share of a
// SESSION-wide cap with nothing anywhere ever releasing it, so twenty-four
// frames on a sheet nobody was looking at refused every frame on the sheet the
// user WAS looking at — permanently, and with no way to diagnose it. A parked
// frame is charged (its memory is real) and preemptible (it is what the next
// claim spends).
// ---------------------------------------------------------------------------

describe("parked frames", () => {
  let evicted: string[];

  beforeEach(() => {
    resetScriptFrameBudget();
    evicted = [];
  });

  /** The host's teardown, recorded rather than performed. Releasing the slot is
   *  what a real evictor does on its way out, so it is done here too — the
   *  budget must survive an evictor that touches it. */
  const evictor = (instanceId: string): void => {
    evicted.push(instanceId);
    releaseScriptFrameSlot(instanceId);
  };

  it("keeps charging a parked frame — the memory it holds is real", () => {
    claimScriptFrameSlot("a", 400);
    parkScriptFrameSlot("a", evictor);
    expect(scriptFrameBudgetUsage()).toEqual({ frames: 1, bytes: 400 });
    expect(parkedScriptFrameCount()).toBe(1);
  });

  it("spends parked frames instead of refusing the sheet the user is on", () => {
    for (let i = 0; i < MAX_LIVE_SCRIPT_FRAMES; i++) {
      claimScriptFrameSlot(`sheet1-${i}`, 10);
      parkScriptFrameSlot(`sheet1-${i}`, evictor);
    }
    // Every one of the next sheet's frames is granted, and each costs exactly
    // one parked frame — the cap still holds at 24 live.
    for (let i = 0; i < MAX_LIVE_SCRIPT_FRAMES; i++) {
      expect(claimScriptFrameSlot(`sheet2-${i}`, 10).granted).toBe(true);
      expect(scriptFrameBudgetUsage().frames).toBe(MAX_LIVE_SCRIPT_FRAMES);
    }
    // Oldest parked first, so the frame hidden longest ago is the one that pays.
    expect(evicted).toEqual(
      Array.from({ length: MAX_LIVE_SCRIPT_FRAMES }, (_, i) => `sheet1-${i}`),
    );
    expect(parkedScriptFrameCount()).toBe(0);
    // ...and with nothing left to spend, the budget refuses again for real.
    const refused = claimScriptFrameSlot("one-too-many", 10);
    expect(refused.granted).toBe(false);
    expect(refused.refusal).toBe("too-many-frames");
  });

  it("spends parked frames for the BYTE door too", () => {
    claimScriptFrameSlot("parked-big", MAX_LIVE_SCRIPT_FRAME_BYTES - 100);
    parkScriptFrameSlot("parked-big", evictor);
    expect(claimScriptFrameSlot("wants-room", 1000).granted).toBe(true);
    expect(evicted).toEqual(["parked-big"]);
    expect(scriptFrameBudgetUsage()).toEqual({ frames: 1, bytes: 1000 });
  });

  it("spends nothing for a document that could never fit anyway", () => {
    claimScriptFrameSlot("parked", 500);
    parkScriptFrameSlot("parked", evictor);
    const refused = claimScriptFrameSlot("enormous", MAX_LIVE_SCRIPT_FRAME_BYTES + 1);
    expect(refused.granted).toBe(false);
    expect(refused.refusal).toBe("too-many-bytes");
    // Tearing down another sheet's frames to make room for something that was
    // going to be refused regardless is pure loss.
    expect(evicted).toEqual([]);
    expect(scriptFrameBudgetUsage()).toEqual({ frames: 1, bytes: 500 });
  });

  it("never evicts a frame that is being painted", () => {
    claimScriptFrameSlot("a", 10);
    parkScriptFrameSlot("a", evictor);
    // The shape came back on screen: its own claim must not spend it.
    expect(claimScriptFrameSlot("a", 20).granted).toBe(true);
    expect(evicted).toEqual([]);
    expect(parkedScriptFrameCount()).toBe(0);
  });

  it("takes a frame off the eviction list when it is painted again", () => {
    claimScriptFrameSlot("a", 10);
    parkScriptFrameSlot("a", evictor);
    unparkScriptFrameSlot("a");
    // Fill the budget around it and demand one more: with nothing parked, the
    // claim is refused rather than tearing down the frame the user can see.
    for (let i = 1; i < MAX_LIVE_SCRIPT_FRAMES; i++) claimScriptFrameSlot(`f${i}`, 10);
    expect(claimScriptFrameSlot("late", 10).granted).toBe(false);
    expect(evicted).toEqual([]);
  });

  it("forgets a parked entry when its slot is released", () => {
    claimScriptFrameSlot("a", 10);
    parkScriptFrameSlot("a", evictor);
    releaseScriptFrameSlot("a");
    expect(parkedScriptFrameCount()).toBe(0);
    // Nothing to spend, so this refuses — and, crucially, does not call a
    // teardown for a frame that is already gone.
    for (let i = 0; i < MAX_LIVE_SCRIPT_FRAMES; i++) claimScriptFrameSlot(`f${i}`, 10);
    expect(claimScriptFrameSlot("late", 10).granted).toBe(false);
    expect(evicted).toEqual([]);
  });

  it("will not park an id that holds no slot", () => {
    parkScriptFrameSlot("never-claimed", evictor);
    expect(parkedScriptFrameCount()).toBe(0);
  });

  it("evicts a re-keyed control under its NEW id", () => {
    claimScriptFrameSlot("old", 10);
    parkScriptFrameSlot("old", evictor);
    migrateScriptFrameSlot("old", "new");
    for (let i = 1; i < MAX_LIVE_SCRIPT_FRAMES; i++) claimScriptFrameSlot(`f${i}`, 10);
    expect(claimScriptFrameSlot("late", 10).granted).toBe(true);
    // The evictor is told which id to tear down rather than closing over one:
    // told "old", the host would find nothing to remove and the frame would
    // outlive its charge.
    expect(evicted).toEqual(["new"]);
  });

  it("drops a displaced destination's teardown instead of aiming it at the arrival", () => {
    // The sitting frame is parked (its sheet is not on screen); the one being
    // re-keyed onto its id is painted. After the move the id names the ARRIVING
    // frame, so a parked entry left under it would spend a frame the user is
    // looking at the next time the budget ran short.
    claimScriptFrameSlot("control-0-8-2", 10);
    parkScriptFrameSlot("control-0-8-2", evictor);
    claimScriptFrameSlot("control-0-10-2", 10);
    migrateScriptFrameSlot("control-0-10-2", "control-0-8-2");
    expect(parkedScriptFrameCount()).toBe(0);

    // Nothing left to spend, so the budget refuses for real rather than tearing
    // down the arrival.
    for (let i = 1; i < MAX_LIVE_SCRIPT_FRAMES; i++) claimScriptFrameSlot(`f${i}`, 10);
    expect(claimScriptFrameSlot("late", 10).granted).toBe(false);
    expect(evicted).toEqual([]);
  });
});
