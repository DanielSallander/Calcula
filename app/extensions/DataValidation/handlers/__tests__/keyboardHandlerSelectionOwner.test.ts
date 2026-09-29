//! FILENAME: app/extensions/DataValidation/handlers/__tests__/keyboardHandlerSelectionOwner.test.ts
// PURPOSE: Alt+Down (open the in-cell list on Core's ACTIVE cell) refuses with
//          ONE toast and opens nothing while a selection owner holds the
//          selection -- the key is still taken, so the grid does not move
//          either; Alt+Up closing an open list is not refused. Both work when
//          nothing owns the selection.
// CONTEXT: D4 (wa-keys fixup, "audit for others"; BUG-0185 class). With a
//          floating grid's cell selected, Core's active cell is HIDDEN under
//          the floating grid; Alt+Down opened ITS list and a pick wrote into
//          it. Data Validation's own window listener is the door (the key is
//          not a registry binding), so it asks @api/selectionOwner itself.
//          TEST owner.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  hasInCellDropdown: vi.fn(async () => true),
  showOverlay: vi.fn(),
  hideOverlay: vi.fn(),
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showOverlay: (...a: unknown[]) => h.showOverlay(...a),
  hideOverlay: (...a: unknown[]) => h.hideOverlay(...a),
  hasInCellDropdown: (...a: unknown[]) => h.hasInCellDropdown(...(a as [])),
  dispatchGridAction: vi.fn(),
  requestOverlayRedraw: vi.fn(),
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => null,
}));
vi.mock("@api/rendering", () => ({ getGridCanvas: () => null }));

import { registerValidationKeyboardShortcuts, unregisterValidationKeyboardShortcuts } from "../keyboardHandler";
import { setCurrentSelection, setOpenDropdownCell, getOpenDropdownCell } from "../../lib/validationStore";
import { registerSelectionOwner } from "@api/selectionOwner";
import { registerToastSink, type ToastPayload } from "@api/notifications";

const toasts: ToastPayload[] = [];
let owns = false;
let release: () => void = () => {};

function press(init: KeyboardEventInit): KeyboardEvent {
  const evt = new KeyboardEvent("keydown", { cancelable: true, bubbles: true, ...init });
  window.dispatchEvent(evt);
  return evt;
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
function refusals(): ToastPayload[] {
  return toasts.filter((t) => t.message.includes("the selection belongs to"));
}

beforeEach(() => {
  vi.clearAllMocks();
  setOpenDropdownCell(null);
  setCurrentSelection({ startRow: 4, startCol: 1, endRow: 4, endCol: 1 });
  toasts.length = 0;
  registerToastSink((t) => toasts.push(t));
  owns = false;
  release = registerSelectionOwner({ id: "test-owner", label: "the test object's cells", ownsSelection: () => owns });
  registerValidationKeyboardShortcuts();
});
afterEach(() => {
  unregisterValidationKeyboardShortcuts();
  release();
});

describe("Alt+Down while a selection owner holds the selection", () => {
  it("opens no list on Core's hidden cell; the key is taken; one toast", async () => {
    owns = true;
    const evt = press({ key: "ArrowDown", altKey: true });
    await flush();
    expect(h.hasInCellDropdown).not.toHaveBeenCalled();
    expect(h.showOverlay).not.toHaveBeenCalled();
    expect(evt.defaultPrevented).toBe(true);
    expect(refusals().length).toBe(1);
  });

  it("Alt+Up still closes a list that is already open (not a selection door)", async () => {
    setOpenDropdownCell({ row: 4, col: 1 });
    owns = true;
    press({ key: "ArrowUp", altKey: true });
    await flush();
    expect(getOpenDropdownCell()).toBeNull();
    expect(refusals()).toEqual([]);
  });
});

describe("positive control: nothing owns the selection", () => {
  it("Alt+Down asks for the active cell's list, no refusal", async () => {
    press({ key: "ArrowDown", altKey: true });
    await flush();
    expect(h.hasInCellDropdown).toHaveBeenCalled();
    expect(refusals()).toEqual([]);
  });
});
