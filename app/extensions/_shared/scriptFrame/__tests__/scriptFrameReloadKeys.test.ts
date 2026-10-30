//! FILENAME: app/extensions/_shared/scriptFrame/__tests__/scriptFrameReloadKeys.test.ts
// PURPOSE: A script's `ui.html` frame never lets F5 / Ctrl+R reach WebView2's
//          RELOAD, which reloads the WHOLE app and throws away the open
//          workbook's unsaved session (BUG-0393, review revG#6).
// CONTEXT: The app window's guard (api/keybindings.ts `handleGlobalKeyDown` ->
//          `isUnboundBrowserReloadKey`) runs in the app's own document. A
//          keystroke typed inside a script frame -- an opaque-origin,
//          `sandbox="allow-scripts"` iframe served by the Rust loader
//          (src-tauri/src/script_frame.rs) -- is dispatched in the FRAME's
//          document and is never forwarded, so that guard never saw it, and
//          an unprevented reload key went to the browser. The loader now
//          carries the same guard. This file boots the loader's OWN script
//          text (as scriptFrame.test.ts does) and presses the keys at it, and
//          proves by execution that it agrees with the app window's guard key
//          for key -- two spellings of one rule are kept in step by a run, not
//          by a comment.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleGlobalKeyDown } from "@api/keybindings";

/** The loader document Rust serves, read from source (the raw-string literal only). */
const LOADER = (() => {
  const src = readFileSync(join(process.cwd(), "src-tauri/src/script_frame.rs"), "utf8");
  const at = src.indexOf('SCRIPT_FRAME_LOADER: &str = r#"');
  if (at < 0) throw new Error("script_frame.rs no longer declares SCRIPT_FRAME_LOADER");
  const start = src.indexOf('r#"', at) + 3;
  return src.slice(start, src.indexOf('"#', start));
})();

interface Listener {
  fn: (event: unknown) => void;
  capture: boolean;
}

/** Boot the loader's bridge over a minimal frame window; return its keydown listeners. */
function bootLoader(): Listener[] {
  const body = /<script[^>]*>([\s\S]*?)<\/script>/.exec(LOADER);
  expect(body, "the Rust loader carries no <script>").not.toBeNull();
  const keydown: Listener[] = [];
  const frameWindow: Record<string, unknown> = {
    location: { search: "?id=frame-1" },
    addEventListener(type: string, fn: (event: unknown) => void, options?: boolean | { capture?: boolean }): void {
      const capture = options === true || (typeof options === "object" && options?.capture === true);
      if (type === "keydown") keydown.push({ fn, capture });
    },
    dispatchEvent: () => true,
  };
  const parentWindow = { postMessage: () => undefined };
  const frameDocument = {
    documentElement: { scrollWidth: 10, scrollHeight: 10 },
    body: { innerHTML: "", style: { minHeight: "" } },
    getElementById: () => null,
  };
  const resizeObserver = function ResizeObserverDouble(): { observe: () => void } {
    return { observe: () => undefined };
  };
  // eslint-disable-next-line no-new-func
  new Function("window", "parent", "document", "ResizeObserver", body![1])(
    frameWindow,
    parentWindow,
    frameDocument,
    resizeObserver,
  );
  return keydown;
}

/** A keystroke as the frame's listener sees it; records what the listener did to it. */
function pressInFrame(listeners: Listener[], init: KeyboardEventInit & { keyCode?: number }) {
  let prevented = false;
  let stopped = false;
  const event = {
    key: init.key ?? "",
    keyCode: init.keyCode ?? 0,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    metaKey: init.metaKey ?? false,
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
    stopImmediatePropagation: () => {
      stopped = true;
    },
  };
  for (const l of listeners) l.fn(event);
  return { prevented, stopped };
}

/** The same keystroke at the APP window's guard, with no binding to take it. */
function pressInApp(init: KeyboardEventInit & { keyCode?: number }): boolean {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
  handleGlobalKeyDown(event);
  return event.defaultPrevented;
}

const RELOADS: Array<[string, KeyboardEventInit & { keyCode?: number }]> = [
  ["F5", { key: "F5" }],
  ["Ctrl+F5", { key: "F5", ctrlKey: true }],
  ["Shift+F5", { key: "F5", shiftKey: true }],
  ["Ctrl+R", { key: "r", ctrlKey: true, keyCode: 82 }],
  ["Ctrl+Shift+R", { key: "R", ctrlKey: true, shiftKey: true, keyCode: 82 }],
  ["Ctrl+R on a Cyrillic layout (the virtual key, not the letter)", { key: "к", ctrlKey: true, keyCode: 82 }],
  ["the keyboard's Refresh key", { key: "BrowserRefresh" }],
];

const LEFT_ALONE: Array<[string, KeyboardEventInit & { keyCode?: number }]> = [
  ["a plain r typed in the frame", { key: "r", keyCode: 82 }],
  ["AltGr+R (Ctrl+Alt+R: a typed character on some layouts)", { key: "r", ctrlKey: true, altKey: true, keyCode: 82 }],
  ["F12", { key: "F12" }],
  ["Ctrl+C", { key: "c", ctrlKey: true, keyCode: 67 }],
];

describe("the script frame loader swallows the reload keys", () => {
  it("installs ONE keydown guard, in the CAPTURE phase (ahead of the script's own handlers)", () => {
    const listeners = bootLoader();
    expect(listeners, "the loader installs no keydown guard: F5 in a frame reloads the app").toHaveLength(1);
    expect(listeners[0].capture).toBe(true);
  });

  for (const [what, init] of RELOADS) {
    // SABOTAGE: remove the keydown listener from SCRIPT_FRAME_LOADER
    // (src-tauri/src/script_frame.rs) -> every row here fails.
    it(`${what}: the default is prevented, and the key still propagates to the script`, () => {
      const outcome = pressInFrame(bootLoader(), init);
      expect(outcome.prevented, `${what} inside a script frame reaches the reload`).toBe(true);
      expect(outcome.stopped).toBe(false);
    });
  }

  for (const [what, init] of LEFT_ALONE) {
    it(`control: ${what} is left alone`, () => {
      expect(pressInFrame(bootLoader(), init).prevented).toBe(false);
    });
  }

  it("agrees with the app window's own guard key for key (one rule, run in both documents)", () => {
    const listeners = bootLoader();
    for (const [what, init] of [...RELOADS, ...LEFT_ALONE]) {
      expect(pressInFrame(listeners, init).prevented, what).toBe(pressInApp(init));
    }
  });
});
