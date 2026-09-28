//! FILENAME: app/extensions/Grouping/__tests__/groupingEditKeys.test.ts
// PURPOSE: Grouping's own Alt+Shift+Arrow listener stands down while a cell
//          edit owns the keyboard, and still groups/ungroups when nothing is
//          being edited.
// CONTEXT: Fix round 4, F2. The listener had only a pointer-claim check, so
//          Alt+Shift+Right typed during a floating grid's cell edit (its editor
//          or the formula bar focused, or parked with the keyboard on the grid
//          container) grouped the rows of Core's HIDDEN selection. Driven
//          through the real activation and the real window listener; only the
//          outline store and the menu builders are doubled.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const performGroupRows = vi.fn();
const performUngroupRows = vi.fn();
const performGroupColumns = vi.fn();
const performUngroupColumns = vi.fn();
vi.mock("../lib/groupingStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/groupingStore")>()),
  performGroupRows: (...a: unknown[]) => performGroupRows(...a),
  performUngroupRows: (...a: unknown[]) => performUngroupRows(...a),
  performGroupColumns: (...a: unknown[]) => performGroupColumns(...a),
  performUngroupColumns: (...a: unknown[]) => performUngroupColumns(...a),
  resyncOutlineFromBackend: vi.fn(async () => {}),
  resetGroupingState: vi.fn(),
}));
vi.mock("../handlers/dataMenuBuilder", () => ({
  registerGroupingMenuItems: vi.fn(),
  registerGroupingContextMenuItems: vi.fn(() => () => {}),
}));
vi.mock("@api/groupingService", () => ({ registerGroupingController: () => () => {} }));

const h = vi.hoisted(() => ({ onSelection: null as null | ((sel: unknown) => void) }));
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  registerPostHeaderOverlay: () => () => {},
  ExtensionRegistry: {
    onSelectionChange: (cb: (sel: unknown) => void) => {
      h.onSelection = cb;
      return () => {
        h.onSelection = null;
      };
    },
  },
}));

import extension from "../index";
import { registerExternalFormulaTarget, setGlobalIsEditing } from "@api/editing";

const cleanups: (() => void)[] = [];

function stubContext(): never {
  return {
    ui: { dialogs: { register: vi.fn(), unregister: vi.fn() } },
    events: { on: () => () => {} },
  } as never;
}
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
function press(key: "ArrowRight" | "ArrowLeft"): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, altKey: true, shiftKey: true, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
}
function acted(): number {
  return (
    performGroupRows.mock.calls.length +
    performUngroupRows.mock.calls.length +
    performGroupColumns.mock.calls.length +
    performUngroupColumns.mock.calls.length
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  extension.activate(stubContext());
  // Core's selection: rows 3..6 (the rows a group would be built from).
  h.onSelection?.({ startRow: 2, endRow: 5, startCol: 0, endCol: 3, type: "cells" });
});
afterEach(() => {
  extension.deactivate();
  while (cleanups.length > 0) cleanups.pop()!();
  setGlobalIsEditing(false);
  document.body.innerHTML = "";
});

describe("Grouping Alt+Shift+Arrow while a cell edit owns the keyboard", () => {
  for (const key of ["ArrowRight", "ArrowLeft"] as const) {
    it(`${key}: a floating grid's live edit, parked with the keyboard on the grid container -> nothing grouped, key not taken`, () => {
      startFloatingGridEdit();
      focus(gridContainer());
      const e = press(key);
      expect(acted()).toBe(0);
      expect(e.defaultPrevented).toBe(false);
    });

    it(`${key}: a floating grid's live edit in the formula bar -> nothing grouped`, () => {
      startFloatingGridEdit();
      focus(document.createElement("input"));
      press(key);
      expect(acted()).toBe(0);
    });

    it(`${key}: Core's own in-cell edit -> nothing grouped`, () => {
      setGlobalIsEditing(true);
      focus(document.createElement("textarea"));
      press(key);
      expect(acted()).toBe(0);
    });
  }

  it("positive control: nothing being edited, grid focused -> Alt+Shift+Right groups the selected rows", () => {
    focus(gridContainer());
    const e = press("ArrowRight");
    expect(performGroupRows).toHaveBeenCalledWith(2, 5);
    expect(e.defaultPrevented).toBe(true);
  });

  it("positive control: Alt+Shift+Left ungroups them", () => {
    focus(gridContainer());
    press("ArrowLeft");
    expect(performUngroupRows).toHaveBeenCalledWith(2, 5);
  });
});
