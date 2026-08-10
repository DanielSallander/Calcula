//! FILENAME: app/src/shell/__tests__/undoStateBridge.test.ts
// PURPOSE: The Undo/Redo AFFORDANCES must reflect the undo STACK.
// CONTEXT: Measured 2026-08-10 (register §3ax(1)): the Home tab rendered
//          undo/redo as plain buttons with no binding to `get_undo_state`, the
//          Edit menu item had no enablement, and nothing in `app/src` or
//          `app/extensions` read `canUndo` for a UI state at all — so the app
//          permanently invited a press it might not be able to honour.
//
//          The backend now announces the availability TRANSITION from inside
//          the undo store's lock guard (`undo_history::UndoHistory`). These
//          tests pin the frontend half, including the two consumers — because a
//          bridge whose event nobody subscribes to is a silent no-op of exactly
//          the kind this program keeps finding.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../../api/backend", () => ({
  listenTauriEvent: vi.fn(),
}));

import {
  bridgeUndoStateAnnouncement,
  BACKEND_UNDO_STATE_EVENT,
} from "../undoStateBridge";
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
  window.addEventListener(AppEvents.UNDO_STATE_CHANGED, record);
});

afterEach(() => {
  window.removeEventListener(AppEvents.UNDO_STATE_CHANGED, record);
});

describe("backend undo-availability announcement bridge", () => {
  it("subscribes to the event name the Rust UndoHistory emits", async () => {
    await bridgeUndoStateAnnouncement();

    expect(mockListen).toHaveBeenCalledTimes(1);
    expect(mockListen.mock.calls[0][0]).toBe(BACKEND_UNDO_STATE_EVENT);

    // The literal contract with the emitter. A rename on either side that is
    // not mirrored produces a bridge that listens for an event nobody sends.
    const rust = read("../../../src-tauri/src/undo_history.rs");
    expect(rust).toContain(
      `pub const UNDO_STATE_EVENT: &str = "${BACKEND_UNDO_STATE_EVENT}"`,
    );
  });

  it("re-emits the first edit — Undo becomes available", async () => {
    await bridgeUndoStateAnnouncement();
    deliver({ canUndo: true, canRedo: false });

    expect(received).toEqual([{ canUndo: true, canRedo: false }]);
  });

  it("re-emits the other direction — File > New empties the stack", async () => {
    await bridgeUndoStateAnnouncement();
    deliver({ canUndo: false, canRedo: false });

    expect(received).toEqual([{ canUndo: false, canRedo: false }]);
  });

  it("fails OPEN on a malformed payload rather than locking the user out", async () => {
    await bridgeUndoStateAnnouncement();
    deliver(undefined);
    deliver({});

    // A wrongly-enabled button costs a press that does nothing, which is the
    // behaviour that shipped until now. A wrongly-disabled one takes away an
    // undo the user really has, with no way to argue with it.
    expect(received).toEqual([
      { canUndo: true, canRedo: true },
      { canUndo: true, canRedo: true },
    ]);
  });

  it("is a no-op, not a throw, when there is no Tauri runtime", async () => {
    mockListen.mockRejectedValue(new Error("no tauri"));

    await expect(bridgeUndoStateAnnouncement()).resolves.toBeUndefined();
    expect(received).toEqual([]);
  });

  it("emits an event that is installed AND consumed", () => {
    // Three halves of the wiring, read from source rather than assumed:
    //  1. bootstrapShell installs the bridge at all;
    //  2. the Home tab's buttons bind to the store the bridge feeds;
    //  3. the Edit menu's items do too.
    // Without (2) and (3) the whole path is a silent no-op — which is exactly
    // what the product did before this change.
    const bootstrap = read("../bootstrap.ts");
    expect(bootstrap).toContain("bridgeUndoStateAnnouncement");

    const homeTab = read(
      "../../../extensions/BuiltIn/HomeTab/components/HomeTabGroupComponent.tsx",
    );
    expect(homeTab).toContain("useUndoAvailability");
    expect(homeTab).toMatch(/disabled=\{unavailable\}/);

    const menus = read("../../../extensions/BuiltIn/StandardMenus/index.ts");
    expect(menus).toContain("subscribeToUndoAvailability");
    expect(menus).toMatch(/updateMenuItem\("edit",\s*"edit:undo"/);
    expect(menus).toMatch(/updateMenuItem\("edit",\s*"edit:redo"/);
  });
});
