//! FILENAME: app/extensions/DataValidation/__tests__/editKeystrokeKeys.test.ts
// PURPOSE: Data Validation's own Alt+Down / Alt+Up listener stands down while a
//          cell edit owns the keyboard, and still opens the in-cell list when
//          nothing is being edited.
// CONTEXT: Fix round 4, F2. The listener's text-field tag list saw Core's
//          in-cell editor and the formula bar, but not a floating grid's live
//          cell edit PARKED with the keyboard on the grid container (it picks
//          a reference on another sheet): there Alt+Down opened the list on
//          Core's hidden active cell, and a pick would write into it. It now
//          asks @api/editing isEditKeystroke, the one question every
//          selection-acting key listener asks.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const toggleDropdownFromKeyboard = vi.fn();
const closeDropdown = vi.fn();
const getCurrentSelection = vi.fn();
const getOpenDropdownCell = vi.fn();

vi.mock("../handlers/dropdownHandler", () => ({
  toggleDropdownFromKeyboard: (...args: unknown[]) => toggleDropdownFromKeyboard(...args),
  closeDropdown: (...args: unknown[]) => closeDropdown(...args),
}));
vi.mock("../lib/validationStore", () => ({
  getCurrentSelection: () => getCurrentSelection(),
  getOpenDropdownCell: () => getOpenDropdownCell(),
}));

import { handleKeyDown } from "../handlers/keyboardHandler";
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
function alt(key: "ArrowDown" | "ArrowUp"): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true });
  Object.defineProperty(e, "target", { value: document.activeElement ?? document.body });
  handleKeyDown(e);
  return e;
}

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentSelection.mockReturnValue({ activeRow: 4, activeCol: 2, endRow: 4, endCol: 2 });
  getOpenDropdownCell.mockReturnValue(null);
});
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  setGlobalIsEditing(false);
  document.body.innerHTML = "";
});

describe("Data Validation Alt+Down while a cell edit owns the keyboard", () => {
  it("a floating grid's live edit, PARKED with the keyboard on the grid container: no list, key not taken", () => {
    startFloatingGridEdit();
    focus(gridContainer());
    const e = alt("ArrowDown");
    expect(toggleDropdownFromKeyboard).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("Core's own in-cell edit with the keyboard momentarily on the grid: no list", () => {
    setGlobalIsEditing(true);
    focus(gridContainer());
    alt("ArrowDown");
    expect(toggleDropdownFromKeyboard).not.toHaveBeenCalled();
  });

  it("Alt+Up during a live floating-grid edit does not close an open list either", () => {
    getOpenDropdownCell.mockReturnValue({ row: 4, col: 2 });
    startFloatingGridEdit();
    focus(gridContainer());
    alt("ArrowUp");
    expect(closeDropdown).not.toHaveBeenCalled();
  });

  it("the formula bar focused (unchanged: a text field)", () => {
    focus(document.createElement("input"));
    alt("ArrowDown");
    expect(toggleDropdownFromKeyboard).not.toHaveBeenCalled();
  });

  it("positive control: nothing being edited, grid focused -> the active cell's list opens", () => {
    focus(gridContainer());
    const e = alt("ArrowDown");
    expect(toggleDropdownFromKeyboard).toHaveBeenCalledWith(4, 2);
    expect(e.defaultPrevented).toBe(true);
  });
});
