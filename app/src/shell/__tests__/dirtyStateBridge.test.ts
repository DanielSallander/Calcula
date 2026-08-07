//! FILENAME: app/src/shell/__tests__/dirtyStateBridge.test.ts
// PURPOSE: The dirty INDICATOR must not lag the dirty FLAG.
// CONTEXT: A backend-only mutation (MCP tool, script, package pull, writeback)
//          set `is_modified` and emitted none of the six frontend events
//          Layout.tsx re-titles on, so the title bar showed no asterisk while
//          the flag was true. The backend now announces the clean<->dirty
//          TRANSITION from `DirtyFlag`; these tests pin the frontend half.
//
//          The last test is the one that matters most: a bridge whose event
//          nobody subscribes to is a silent no-op of exactly the kind this
//          program keeps finding, so the Layout subscription is asserted too.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../../api/backend", () => ({
  listenTauriEvent: vi.fn(),
}));

vi.mock("../../utils/bridge", () => ({
  tracedInvoke: vi.fn(),
}));

import {
  bridgeDirtyStateAnnouncement,
  BACKEND_DIRTY_STATE_EVENT,
} from "../dirtyStateBridge";
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
  window.addEventListener(AppEvents.DIRTY_STATE_CHANGED, record);
});

afterEach(() => {
  window.removeEventListener(AppEvents.DIRTY_STATE_CHANGED, record);
});

describe("backend dirty-state announcement bridge", () => {
  it("subscribes to the event name the Rust DirtyFlag emits", async () => {
    await bridgeDirtyStateAnnouncement();

    expect(mockListen).toHaveBeenCalledTimes(1);
    expect(mockListen.mock.calls[0][0]).toBe(BACKEND_DIRTY_STATE_EVENT);

    // The literal contract with the emitter. A rename on either side that is
    // not mirrored produces a bridge that listens for an event nobody sends.
    const rust = read("../../../src-tauri/src/document_effect.rs");
    expect(rust).toContain(
      `pub const DIRTY_STATE_EVENT: &str = "${BACKEND_DIRTY_STATE_EVENT}"`,
    );
  });

  it("re-emits a clean->dirty transition as DIRTY_STATE_CHANGED", async () => {
    await bridgeDirtyStateAnnouncement();
    deliver({ isDirty: true });

    expect(received).toEqual([{ isDirty: true }]);
  });

  it("re-emits the dirty->clean direction so the asterisk clears", async () => {
    await bridgeDirtyStateAnnouncement();
    deliver({ isDirty: false });

    expect(received).toEqual([{ isDirty: false }]);
  });

  it("treats a malformed payload as a change rather than swallowing it", async () => {
    await bridgeDirtyStateAnnouncement();
    deliver(undefined);
    deliver({});

    // The backend only announces real transitions, so silence would be worse
    // than a redundant re-title: updateWindowTitle() re-reads the flag anyway.
    expect(received).toEqual([{ isDirty: true }, { isDirty: true }]);
  });

  it("is a no-op, not a throw, when there is no Tauri runtime", async () => {
    mockListen.mockRejectedValue(new Error("no tauri"));

    await expect(bridgeDirtyStateAnnouncement()).resolves.toBeUndefined();
    expect(received).toEqual([]);
  });

  it("emits an event the shell actually re-titles on", () => {
    // Both halves of the wiring, read from source rather than assumed:
    //  1. bootstrapShell installs the bridge at all.
    //  2. Layout subscribes DIRTY_STATE_CHANGED -> updateWindowTitle.
    // Without (2) this whole path is a silent no-op.
    const bootstrap = read("../bootstrap.ts");
    expect(bootstrap).toContain("bridgeDirtyStateAnnouncement");

    const layout = read("../Layout.tsx");
    expect(layout).toMatch(
      /onAppEvent\(\s*AppEvents\.DIRTY_STATE_CHANGED\s*,\s*\(\)\s*=>\s*updateWindowTitle\(\)\s*\)/,
    );
    expect(layout).toContain("updateWindowTitle");
  });
});

describe("updateWindowTitle renders the flag it is handed", () => {
  it("shows the asterisk when the backend reports the document dirty", async () => {
    const { tracedInvoke } = await import("../../utils/bridge");
    const invoke = vi.mocked(tracedInvoke);
    invoke.mockReset();
    invoke.mockImplementation(((cmd: string) => {
      if (cmd === "get_current_file_path") return Promise.resolve("C:/tmp/Budget.cala");
      if (cmd === "is_file_modified") return Promise.resolve(true);
      return Promise.resolve(null);
    }) as never);

    const { updateWindowTitle } = await import("../../core/lib/file-api");
    await updateWindowTitle();

    expect(document.title).toBe("Budget.cala * - Calcula");
  });

  it("drops the asterisk once the document is clean again", async () => {
    const { tracedInvoke } = await import("../../utils/bridge");
    const invoke = vi.mocked(tracedInvoke);
    invoke.mockReset();
    invoke.mockImplementation(((cmd: string) => {
      if (cmd === "get_current_file_path") return Promise.resolve("C:/tmp/Budget.cala");
      if (cmd === "is_file_modified") return Promise.resolve(false);
      return Promise.resolve(null);
    }) as never);

    const { updateWindowTitle } = await import("../../core/lib/file-api");
    await updateWindowTitle();

    expect(document.title).toBe("Budget.cala - Calcula");
  });
});
