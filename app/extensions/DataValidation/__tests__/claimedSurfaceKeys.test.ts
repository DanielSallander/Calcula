//! FILENAME: app/extensions/DataValidation/__tests__/claimedSurfaceKeys.test.ts
// PURPOSE: One BEHAVIOURAL proof, at runtime, that an extension's global
//          capture-phase key handler stands down inside a claimed surface.
//
// CONTEXT: `core/lib/globalInputListeners.test.ts` proves every "claim-guarded"
//          row's file references a claim predicate, which is a STATIC check: it
//          cannot tell a guard that runs before the action from one bolted on
//          after it. This extension is the representative case because its
//          handler is the one that is exported for tests. Alt+Down opens the
//          in-cell list on the ACTIVE CELL — a cell somewhere else on the sheet
//          entirely from the on-grid form the user is typing into — and it
//          preventDefault()s, which is how it would eat the dropdown's own
//          Alt+Down.
//
//          The handler's own tag list (INPUT / TEXTAREA / contenteditable) does
//          not cover a <select> or a <button>, which is exactly the gap the
//          claim exists to close.

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
import { POINTER_CLAIM_ATTR } from "@api";

let container: HTMLElement;
let card: HTMLElement;
let select: HTMLSelectElement;

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentSelection.mockReturnValue({ activeRow: 4, activeCol: 2, endRow: 4, endCol: 2 });
  getOpenDropdownCell.mockReturnValue(null);

  container = document.createElement("div");
  container.setAttribute("data-focus-container", "spreadsheet");
  card = document.createElement("div");
  card.setAttribute(POINTER_CLAIM_ATTR, "form:card-1");
  select = document.createElement("select");
  card.appendChild(select);
  container.appendChild(card);
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
});

function altDown(target: Element): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", {
    key: "ArrowDown",
    altKey: true,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(ev, "target", { value: target, configurable: true });
  return ev;
}

describe("DataValidation Alt+Down inside a claimed on-grid surface", () => {
  it("does NOT open the active cell's list, and does NOT preventDefault", () => {
    const ev = altDown(select);
    const pd = vi.spyOn(ev, "preventDefault");
    handleKeyDown(ev);
    expect(toggleDropdownFromKeyboard).not.toHaveBeenCalled();
    expect(pd).not.toHaveBeenCalled();
  });

  it("the CLAIM is what stops it — without the attribute the same key opens the list", () => {
    card.removeAttribute(POINTER_CLAIM_ATTR);
    const ev = altDown(select);
    const pd = vi.spyOn(ev, "preventDefault");
    handleKeyDown(ev);
    expect(toggleDropdownFromKeyboard).toHaveBeenCalledWith(4, 2);
    expect(pd).toHaveBeenCalled();
  });

  it("Alt+Up inside a claim does not close an open list either", () => {
    getOpenDropdownCell.mockReturnValue({ row: 4, col: 2 });
    const ev = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(ev, "target", { value: select, configurable: true });
    handleKeyDown(ev);
    expect(closeDropdown).not.toHaveBeenCalled();
  });
});
