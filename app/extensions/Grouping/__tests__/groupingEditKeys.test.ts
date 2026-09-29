//! FILENAME: app/extensions/Grouping/__tests__/groupingEditKeys.test.ts
// PURPOSE: Alt+Shift+Arrow does not group/ungroup while a cell edit owns the
//          keyboard, and still groups/ungroups (once) when nothing is being
//          edited.
// CONTEXT: Fix round 4, F2: Alt+Shift+Right typed during a floating grid's
//          cell edit (its editor or the formula bar focused, or parked with the
//          keyboard on the grid container) grouped the rows of Core's HIDDEN
//          selection. That was the extension's own window listener; since wave
//          B (D1) the keybinding registry is the ONE keyboard path and the
//          listener is gone, so this drives the REAL dispatcher
//          (initKeybindings, the `not-editing` bindings) and the REAL
//          grouping.group / grouping.ungroup commands through the real
//          activation; only the outline store and the menu builders are doubled.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

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
  // eslint-disable-next-line @typescript-eslint/naming-convention -- the real export name
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
import { CommandRegistry } from "@api/commands";
import { initKeybindings } from "@api/keybindings";
import { registerExternalFormulaTarget, setGlobalIsEditing } from "@api/editing";

const cleanups: (() => void)[] = [];

function stubContext(): never {
  return {
    ui: { dialogs: { register: vi.fn(), unregister: vi.fn() } },
    events: { on: () => () => {} },
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown) => CommandRegistry.register(id, fn),
      unregister: (id: string) => CommandRegistry.unregister(id),
      execute: (id: string) => CommandRegistry.execute(id),
    },
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
async function press(key: "ArrowRight" | "ArrowLeft"): Promise<KeyboardEvent> {
  const e = new KeyboardEvent("keydown", { key, altKey: true, shiftKey: true, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(e);
  for (let i = 0; i < 4; i++) await Promise.resolve();
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

beforeAll(() => {
  initKeybindings();
});
beforeEach(() => {
  vi.clearAllMocks();
  extension.activate(stubContext());
  // Core's selection: rows 3..6 (the rows a group would be built from).
  h.onSelection?.({ startRow: 2, endRow: 5, startCol: 0, endCol: 3, type: "cells" });
});
afterEach(() => {
  extension.deactivate?.();
  while (cleanups.length > 0) cleanups.pop()!();
  setGlobalIsEditing(false);
  document.body.innerHTML = "";
});

describe("Grouping Alt+Shift+Arrow while a cell edit owns the keyboard", () => {
  for (const key of ["ArrowRight", "ArrowLeft"] as const) {
    it(`${key}: a floating grid's live edit, parked with the keyboard on the grid container -> nothing grouped, key not taken`, async () => {
      startFloatingGridEdit();
      focus(gridContainer());
      const e = await press(key);
      expect(acted()).toBe(0);
      expect(e.defaultPrevented).toBe(false);
    });

    it(`${key}: a floating grid's live edit in the formula bar -> nothing grouped`, async () => {
      startFloatingGridEdit();
      focus(document.createElement("input"));
      await press(key);
      expect(acted()).toBe(0);
    });

    it(`${key}: Core's own in-cell edit -> nothing grouped`, async () => {
      setGlobalIsEditing(true);
      focus(document.createElement("textarea"));
      await press(key);
      expect(acted()).toBe(0);
    });
  }

  it("positive control: nothing being edited, grid focused -> Alt+Shift+Right groups the selected rows ONCE", async () => {
    focus(gridContainer());
    const e = await press("ArrowRight");
    expect(performGroupRows).toHaveBeenCalledTimes(1);
    expect(performGroupRows).toHaveBeenCalledWith(2, 5);
    expect(e.defaultPrevented).toBe(true);
  });

  it("positive control: Alt+Shift+Left ungroups them ONCE", async () => {
    focus(gridContainer());
    await press("ArrowLeft");
    expect(performUngroupRows).toHaveBeenCalledTimes(1);
    expect(performUngroupRows).toHaveBeenCalledWith(2, 5);
  });
});
