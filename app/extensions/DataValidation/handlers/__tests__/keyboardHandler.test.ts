//! FILENAME: app/extensions/DataValidation/handlers/__tests__/keyboardHandler.test.ts
// PURPOSE: Alt+Down is the keyboard equivalent of the chevron button, which is
//          now the only mouse target that opens the list.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockShowOverlay = vi.fn();
const mockHideOverlay = vi.fn();
const mockHasInCellDropdown = vi.fn();

vi.mock("@api", () => ({
  showOverlay: (...args: unknown[]) => mockShowOverlay(...args),
  hideOverlay: (...args: unknown[]) => mockHideOverlay(...args),
  hasInCellDropdown: (...args: unknown[]) => mockHasInCellDropdown(...args),
  dispatchGridAction: vi.fn(),
  getAllDataValidations: vi.fn(),
  getInvalidCells: vi.fn(),
  addGridRegions: vi.fn(),
  removeGridRegionsByType: vi.fn(),
  requestOverlayRedraw: vi.fn(),
  emitAppEvent: vi.fn(),
}));

vi.mock("@api/grid", () => ({
  getGridStateSnapshot: () => null,
  setSelection: () => ({ type: "SET_SELECTION" }),
}));

vi.mock("@api/rendering", () => ({
  getGridCanvas: () => null,
}));

import {
  registerValidationKeyboardShortcuts,
  unregisterValidationKeyboardShortcuts,
} from "../keyboardHandler";
import {
  getOpenDropdownCell,
  setCurrentSelection,
  setOpenDropdownCell,
} from "../../lib/validationStore";

function press(init: KeyboardEventInit): KeyboardEvent {
  const evt = new KeyboardEvent("keydown", { cancelable: true, bubbles: true, ...init });
  window.dispatchEvent(evt);
  return evt;
}

/** Let the handler's void-async work settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  setOpenDropdownCell(null);
  setCurrentSelection({ startRow: 4, startCol: 1, endRow: 4, endCol: 1 });
  mockHasInCellDropdown.mockResolvedValue(true);
  registerValidationKeyboardShortcuts();
});

afterEach(() => {
  unregisterValidationKeyboardShortcuts();
});

describe("Alt+Down", () => {
  it("opens the list on the active cell and swallows the key", async () => {
    const evt = press({ key: "ArrowDown", altKey: true });
    await flush();

    expect(evt.defaultPrevented).toBe(true);
    expect(mockShowOverlay).toHaveBeenCalledTimes(1);
    expect(getOpenDropdownCell()).toEqual({ row: 4, col: 1 });
  });

  it("closes the list on a second press", async () => {
    setOpenDropdownCell({ row: 4, col: 1 });
    press({ key: "ArrowDown", altKey: true });
    await flush();

    expect(mockHideOverlay).toHaveBeenCalledWith("validation-list-dropdown");
    expect(getOpenDropdownCell()).toBeNull();
  });

  it("ignores a plain Down arrow so normal navigation still works", async () => {
    const evt = press({ key: "ArrowDown" });
    await flush();

    expect(evt.defaultPrevented).toBe(false);
    expect(mockShowOverlay).not.toHaveBeenCalled();
  });

  it("ignores Ctrl+Alt+Down and Shift+Alt+Down", async () => {
    press({ key: "ArrowDown", altKey: true, ctrlKey: true });
    press({ key: "ArrowDown", altKey: true, shiftKey: true });
    await flush();
    expect(mockShowOverlay).not.toHaveBeenCalled();
  });

  it("does not steal the key from a focused text input", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    const evt = press({ key: "ArrowDown", altKey: true });
    await flush();

    expect(evt.defaultPrevented).toBe(false);
    expect(mockShowOverlay).not.toHaveBeenCalled();
    input.remove();
  });

  it("does nothing without a selection", async () => {
    setCurrentSelection(null);
    press({ key: "ArrowDown", altKey: true });
    await flush();
    expect(mockShowOverlay).not.toHaveBeenCalled();
  });

  it("stops firing once unregistered", async () => {
    unregisterValidationKeyboardShortcuts();
    press({ key: "ArrowDown", altKey: true });
    await flush();
    expect(mockShowOverlay).not.toHaveBeenCalled();
  });
});

describe("Alt+Up", () => {
  it("closes an open list", async () => {
    setOpenDropdownCell({ row: 4, col: 1 });
    const evt = press({ key: "ArrowUp", altKey: true });
    await flush();

    expect(evt.defaultPrevented).toBe(true);
    expect(mockHideOverlay).toHaveBeenCalledWith("validation-list-dropdown");
  });

  it("is left alone when no list is open", async () => {
    const evt = press({ key: "ArrowUp", altKey: true });
    await flush();
    expect(evt.defaultPrevented).toBe(false);
  });
});
