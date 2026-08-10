//! FILENAME: app/src/shell/__tests__/sheetDisplayFlagsBridge.test.ts
// PURPOSE: The RENDERER must follow the per-sheet display flags however the
//          authority was moved -- and it must be reset when the document is.
// CONTEXT: `displayZeros`, `showFormulas`, `viewMode` and `displayHeadings` are
//          per-sheet BACKEND state (.cala v6). What draws them is frontend Core
//          state, fed by the `DISPLAY_*_TOGGLED` intents the View menu emits, so
//          the two halves only agreed when the change came from that menu.
//          Anything else that wrote them -- a script, an MCP tool, a package
//          pull, an E2E spec, and `new_file` / `open_file` -- left the renderer
//          painting the previous document. Measured live: after one journey spec
//          restored the flags through `set_sheet_display_flags`, the rest of the
//          run painted with the headings OFF while the backend reported them ON.
//
//          The last describe block is the one that matters most: a bridge whose
//          event nobody subscribes to is a silent no-op, so the Core
//          subscription and the Rust reset are asserted too.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../../api/backend", () => ({
  listenTauriEvent: vi.fn(),
}));

import {
  bridgeSheetDisplayFlagsAnnouncement,
  BACKEND_SHEET_DISPLAY_FLAGS_EVENT,
} from "../sheetDisplayFlagsBridge";
import { listenTauriEvent } from "../../api/backend";
import { AppEvents } from "../../api/events";

const mockListen = vi.mocked(listenTauriEvent);

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(resolve(HERE, relative), "utf8");

/** Deliver a payload through whatever callback the bridge registered. */
function deliver(payload: unknown): void {
  const registered = mockListen.mock.calls[0];
  expect(registered, "the bridge registered no Tauri listener").toBeDefined();
  (registered[1] as (p: unknown) => void)(payload);
}

let received: unknown[];
const record = (e: Event) => received.push((e as CustomEvent).detail);

beforeEach(() => {
  received = [];
  mockListen.mockReset();
  mockListen.mockResolvedValue(() => undefined);
  window.addEventListener(AppEvents.SHEET_DISPLAY_FLAGS_CHANGED, record);
});

afterEach(() => {
  window.removeEventListener(AppEvents.SHEET_DISPLAY_FLAGS_CHANGED, record);
});

describe("backend sheet-display-flags bridge", () => {
  it("subscribes to the event name the Rust setter emits", async () => {
    await bridgeSheetDisplayFlagsAnnouncement();

    expect(mockListen).toHaveBeenCalledTimes(1);
    expect(mockListen.mock.calls[0][0]).toBe(BACKEND_SHEET_DISPLAY_FLAGS_EVENT);

    // The literal contract with the emitter. A rename on either side that is not
    // mirrored produces a bridge listening for an event nobody sends.
    const rust = read("../../../src-tauri/src/sheets.rs");
    expect(rust).toContain(
      `pub const SHEET_DISPLAY_FLAGS_EVENT: &str = "${BACKEND_SHEET_DISPLAY_FLAGS_EVENT}"`,
    );
  });

  it("the Rust setter actually emits it, after dropping the write guard", async () => {
    const rust = read("../../../src-tauri/src/sheets.rs");
    const setter = rust.slice(rust.indexOf("pub fn set_sheet_display_flags"));
    const body = setter.slice(0, setter.indexOf("\n}\n"));
    expect(body).toContain("app.emit(SHEET_DISPLAY_FLAGS_EVENT");
    // The emit must be OUTSIDE the block holding `sheet_display_flags.write()`:
    // a subscriber that answers by calling `get_sheet_display_flags` would
    // otherwise deadlock against a still-held write lock.
    const emitAt = body.indexOf("app.emit(SHEET_DISPLAY_FLAGS_EVENT");
    const guardCloseAt = body.indexOf("entry.clone()");
    expect(guardCloseAt).toBeGreaterThan(-1);
    expect(emitAt).toBeGreaterThan(guardCloseAt);
  });

  it("re-emits as SHEET_DISPLAY_FLAGS_CHANGED, carrying no payload", async () => {
    await bridgeSheetDisplayFlagsAnnouncement();
    deliver({ displayHeadings: false, displayZeros: true, showFormulas: false, viewMode: "normal" });

    // Deliberately payload-free: the one hydration path re-reads the authority,
    // so no subscriber can act on a copy that has since gone stale.
    // (CustomEvent normalises an absent `detail` to null.)
    expect(received).toEqual([null]);
  });

  it("announces every write, including one that changes nothing", async () => {
    await bridgeSheetDisplayFlagsAnnouncement();
    deliver({});
    deliver(undefined);

    // The backend emits once per write; swallowing a "looks like a no-op" event
    // would be a guess about state this bridge does not hold.
    expect(received).toHaveLength(2);
  });

  it("is a no-op, not a throw, when there is no Tauri runtime", async () => {
    mockListen.mockRejectedValue(new Error("no tauri"));

    await expect(bridgeSheetDisplayFlagsAnnouncement()).resolves.toBeUndefined();
    expect(received).toEqual([]);
  });
});

describe("the announcement reaches something that repaints", () => {
  it("bootstrapShell installs the bridge", () => {
    expect(read("../bootstrap.ts")).toContain("bridgeSheetDisplayFlagsAnnouncement()");
  });

  it("Core subscribes and answers by re-reading the authority", () => {
    const sheet = read("../../core/components/Spreadsheet/Spreadsheet.tsx");
    expect(sheet).toMatch(
      /addEventListener\(\s*AppEvents\.SHEET_DISPLAY_FLAGS_CHANGED\s*,\s*handler\s*\)/,
    );
    expect(sheet).toContain("hydrateSheetDisplayFlags");
    // And it is removed again -- a listener leaked per mount would multiply the
    // IPC read on every remount.
    expect(sheet).toMatch(
      /removeEventListener\(\s*AppEvents\.SHEET_DISPLAY_FLAGS_CHANGED\s*,\s*handler\s*\)/,
    );
  });

  it("hydration runs on MOUNT and on SHEET SWITCH as well as on the announcement", () => {
    // Three triggers, one hydration path. Startup-only hydration is the exact
    // bug that made a freeze on sheet 2 show sheet 1's panes.
    const sheet = read("../../core/components/Spreadsheet/Spreadsheet.tsx");
    const calls = sheet.match(/hydrateSheetDisplayFlags\(\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(sheet).toContain('window.addEventListener("sheet:normalSwitch", handleSheetSwitch)');
  });

  it("the two names are the same string in Core and in @api", () => {
    // Core dispatches on its own copy of the map; the bridge emits from @api's.
    // A divergence here is a listener that never fires.
    const core = read("../../core/lib/events.ts");
    expect(core).toContain('SHEET_DISPLAY_FLAGS_CHANGED: "app:sheet-display-flags-changed"');
    expect(AppEvents.SHEET_DISPLAY_FLAGS_CHANGED).toBe("app:sheet-display-flags-changed");
  });
});

describe("replacing the DOCUMENT resets the flags too", () => {
  it("announceBackendStateReplaced carries the display flags", () => {
    const fileApi = read("../../core/lib/file-api.ts");
    const fn = fileApi.slice(fileApi.indexOf("function announceBackendStateReplaced"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("AppEvents.SHEET_DISPLAY_FLAGS_CHANGED");
  });

  it("and both document-replacing paths call it", () => {
    const fileApi = read("../../core/lib/file-api.ts");
    for (const fnName of ["export async function newFile", "export async function openFileAtPath"]) {
      const fn = fileApi.slice(fileApi.indexOf(fnName));
      expect(fn.slice(0, 3000)).toContain("announceBackendStateReplaced()");
    }
  });

  it("the Rust side really does reset them when the document is replaced", () => {
    // Without this the announcement would faithfully re-read a stale authority.
    //
    // THE RESET IS SHARED, so this reads it where it lives. `new_file` used to
    // reset every store inline; that inline block is now
    // `reset_document_scoped_stores`, which `open_file` runs too (the store
    // census in `document_store_census_tests.rs` is what holds that). Following
    // the delegation rather than re-anchoring on `new_file`'s body is the point:
    // the flags must be reset on BOTH document-replacing paths, and only the
    // shared function can say so for both at once.
    const rust = read("../../../src-tauri/src/persistence.rs");
    const reset = rust.slice(rust.indexOf("pub(crate) fn reset_document_scoped_stores("));
    expect(reset.slice(0, 20000)).toMatch(
      /sheet_display_flags\.write\(effect\)[\s\S]{0,400}SheetDisplayFlags::default\(\)/,
    );

    // ...and every path that replaces the document reaches it.
    for (const entry of ["pub fn new_file(", "pub fn open_file("]) {
      const fn = rust.slice(rust.indexOf(entry));
      expect(
        fn.slice(0, 12000).replace(/^\s*\/\/.*$/gm, ""),
        `${entry} must run the shared reset, or it leaves the previous document's display flags live`,
      ).toContain("reset_document_scoped_stores(");
    }
  });
});
