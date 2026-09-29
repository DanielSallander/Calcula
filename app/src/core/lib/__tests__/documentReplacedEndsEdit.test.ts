//! FILENAME: app/src/core/lib/__tests__/documentReplacedEndsEdit.test.ts
// PURPOSE: Replacing the document ends Core's open cell edit -- its flag is
//          lowered and the edit is discarded -- on EVERY replacement path:
//          file-api's newFile and openFileAtPath, and any other caller of
//          announceBackendStateReplaced (calp_checkout). E9.
// CONTEXT: Round 5 (fix5-live.md, finding 2): `newFile()` left Core's edit
//          flag up when an edit was open. The real File > New reloads the
//          window, but the E2E harness, scripts and calp_checkout replace the
//          document in place, and every spec that followed inherited a flag
//          that said "a cell edit is open" -- Undo/Redo and the grid-scoped
//          keys stood down for an edit that belonged to a document that no
//          longer existed. The flag must be down BEFORE AFTER_NEW / AFTER_OPEN,
//          whose listeners act on the new document.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const tracedInvoke = vi.fn();
vi.mock("../../../utils/bridge", () => ({ tracedInvoke: (...a: unknown[]) => tracedInvoke(...a) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import { announceBackendStateReplaced, newFile, openFileAtPath } from "../file-api";
import { isCoreCellEditOpen, setCoreCellEditFlag } from "../cellEditFlag";
import { AppEvents, onAppEvent } from "../events";

const offs: (() => void)[] = [];
let discards = 0;
const onDiscard = () => {
  discards += 1;
};

beforeEach(() => {
  tracedInvoke.mockReset().mockImplementation(async (cmd: string) => {
    if (cmd === "open_file") return [];
    if (cmd === "keychain_get_password") return null;
    return undefined;
  });
  discards = 0;
  window.addEventListener("grid:discardEdit", onDiscard);
  setCoreCellEditFlag(true);
});

afterEach(() => {
  window.removeEventListener("grid:discardEdit", onDiscard);
  while (offs.length > 0) offs.pop()!();
  setCoreCellEditFlag(false);
});

/** The flag as the new document's first listener sees it. */
function flagAt(event: string): { seen: boolean | null } {
  const at = { seen: null as boolean | null };
  offs.push(onAppEvent(event, () => {
    if (at.seen === null) at.seen = isCoreCellEditOpen();
  }));
  return at;
}

describe("a replaced document ends Core's open cell edit (E9)", () => {
  it("newFile lowers the flag before AFTER_NEW and discards the edit", async () => {
    const atAfterNew = flagAt(AppEvents.AFTER_NEW);
    await newFile();
    expect(isCoreCellEditOpen()).toBe(false);
    expect(atAfterNew.seen, "AFTER_NEW listeners saw the old document's edit flag").toBe(false);
    expect(discards).toBeGreaterThanOrEqual(1);
  });

  it("openFileAtPath does the same before AFTER_OPEN", async () => {
    const atAfterOpen = flagAt(AppEvents.AFTER_OPEN);
    await openFileAtPath("C:/Books/Other.cala");
    expect(isCoreCellEditOpen()).toBe(false);
    expect(atAfterOpen.seen).toBe(false);
    expect(discards).toBeGreaterThanOrEqual(1);
  });

  it("any other replacement (calp_checkout calls announceBackendStateReplaced) does too", () => {
    announceBackendStateReplaced();
    expect(isCoreCellEditOpen()).toBe(false);
    expect(discards).toBe(1);
  });

  it("control: a FAILED new keeps the edit (the old document is still there)", async () => {
    tracedInvoke.mockRejectedValueOnce(new Error("backend busy"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(newFile()).rejects.toThrow(/backend busy/);
    expect(isCoreCellEditOpen()).toBe(true);
    expect(discards).toBe(0);
  });
});
