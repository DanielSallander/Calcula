//! FILENAME: app/extensions/SelectVisibleCells/__tests__/selectVisibleEditKeys.test.ts
// PURPOSE: Select Visible Cells' own Alt+; listener stands down while a cell
//          edit owns the keyboard, and still runs when nothing is being edited.
// CONTEXT: Fix round 4, F2. The listener's text-field tag list (on the event
//          TARGET) could not see a floating grid's live cell edit PARKED with
//          the keyboard on the grid container, where Alt+; rewrote Core's
//          selection under the edit. Driven through the real activation and
//          the real window listener; the first thing it does is read the grid
//          state, so that read is the witness.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getGridStateSnapshot = vi.fn((): null => null);
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => getGridStateSnapshot(),
}));
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  registerMenuItem: vi.fn(),
  showToast: vi.fn(),
}));

import extension from "../index";
import { registerExternalFormulaTarget, setGlobalIsEditing } from "@api/editing";

const cleanups: (() => void)[] = [];

function focus(el: HTMLElement): HTMLElement {
  document.body.appendChild(el);
  el.focus();
  return el;
}
function gridContainer(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-focus-container", "spreadsheet");
  el.tabIndex = 0;
  return el;
}
function startFloatingGridEdit(): void {
  cleanups.push(
    registerExternalFormulaTarget({
      isExpectingReference: () => false,
      insertReference: () => undefined,
      session: {} as never,
    }),
  );
}
function altSemicolon(): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: ";", altKey: true, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
}

beforeEach(() => {
  getGridStateSnapshot.mockClear();
  extension.activate({} as never);
});
afterEach(() => {
  extension.deactivate();
  while (cleanups.length > 0) cleanups.pop()!();
  setGlobalIsEditing(false);
  document.body.innerHTML = "";
});

describe("Select Visible Cells Alt+; while a cell edit owns the keyboard", () => {
  it("a floating grid's live edit, PARKED with the keyboard on the grid container: selection untouched, key not taken", () => {
    startFloatingGridEdit();
    focus(gridContainer());
    const e = altSemicolon();
    expect(getGridStateSnapshot).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("Core's own in-cell edit with the keyboard momentarily on the grid: selection untouched", () => {
    setGlobalIsEditing(true);
    focus(gridContainer());
    altSemicolon();
    expect(getGridStateSnapshot).not.toHaveBeenCalled();
  });

  it("positive control: nothing being edited, grid focused -> it runs", () => {
    focus(gridContainer());
    const e = altSemicolon();
    expect(getGridStateSnapshot).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });
});
