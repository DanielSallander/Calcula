//! FILENAME: app/extensions/AutoFilter/__tests__/autoFilterEditKeys.test.ts
// PURPOSE: AutoFilter's own Ctrl+Shift+L listener stands down while a cell edit
//          owns the keyboard, and still toggles the filter when nothing is
//          being edited.
// CONTEXT: Fix round 4, F2. The listener had only a pointer-claim check, so
//          Ctrl+Shift+L typed during a floating grid's cell edit (its editor or
//          the formula bar focused, or parked with the keyboard on the grid
//          container) toggled AutoFilter over Core's HIDDEN selection -- and
//          in Core's own in-cell editor it did the same, where Excel ignores
//          the key. The registry's binding for the same key is "not-editing"
//          (keybindings.editContext.test.ts); this is the listener's half.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const toggleFilter = vi.fn();
vi.mock("../lib/filterStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/filterStore")>()),
  toggleFilter: (...args: unknown[]) => toggleFilter(...args),
}));

import { handleKeyDown } from "../index";
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
function ctrlShiftL(): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "L", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
  Object.defineProperty(e, "target", { value: document.activeElement ?? document.body });
  return e;
}

beforeEach(() => {
  toggleFilter.mockClear();
});
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  setGlobalIsEditing(false);
  document.body.innerHTML = "";
});

describe("AutoFilter Ctrl+Shift+L while a cell edit owns the keyboard", () => {
  it("a floating grid's live edit, parked with the keyboard on the grid container: no toggle, key not taken", () => {
    startFloatingGridEdit();
    focus(gridContainer());
    const e = ctrlShiftL();
    handleKeyDown(e);
    expect(toggleFilter).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("a floating grid's live edit in the formula bar: no toggle", () => {
    startFloatingGridEdit();
    focus(document.createElement("input"));
    handleKeyDown(ctrlShiftL());
    expect(toggleFilter).not.toHaveBeenCalled();
  });

  it("Core's own in-cell edit: no toggle", () => {
    setGlobalIsEditing(true);
    focus(document.createElement("textarea"));
    handleKeyDown(ctrlShiftL());
    expect(toggleFilter).not.toHaveBeenCalled();
  });

  it("positive control: nothing being edited, grid focused -> the filter toggles", () => {
    focus(gridContainer());
    const e = ctrlShiftL();
    handleKeyDown(e);
    expect(toggleFilter).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });
});
