//! FILENAME: app/extensions/Hyperlinks/__tests__/hyperlinkEditKeys.test.ts
// PURPOSE: Ctrl+K does not open Insert Hyperlink while a cell edit owns the
//          keyboard, and still opens it (once) when nothing is being edited.
// CONTEXT: Fix round 4, F2: Ctrl+K typed during a floating grid's live cell
//          edit PARKED with the keyboard on the grid container opened Insert
//          Hyperlink for Core's hidden active cell. That was the extension's
//          own window listener; since wave B (D1) the keybinding registry is
//          the ONE keyboard path and the listener is gone, so this drives the
//          REAL dispatcher (initKeybindings, the `not-editing` binding) and the
//          REAL command through the real activation. The dialog is the witness.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  showDialog: vi.fn(),
  selectionSubs: new Set<(sel: unknown) => void>(),
}));
vi.mock("@api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@api")>();
  return {
    ...real,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the real export name
    ExtensionRegistry: {
      ...real.ExtensionRegistry,
      onSelectionChange: (cb: (sel: unknown) => void) => {
        h.selectionSubs.add(cb);
        return () => h.selectionSubs.delete(cb);
      },
    },
    showDialog: (...a: unknown[]) => h.showDialog(...a),
  };
});
vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  getHyperlink: vi.fn(async () => null),
  getHyperlinkIndicators: vi.fn(async () => []),
}));

import extension from "../index";
import { CommandRegistry } from "@api/commands";
import { initKeybindings } from "@api/keybindings";
import { registerExternalFormulaTarget, setGlobalIsEditing } from "@api/editing";

const cleanups: (() => void)[] = [];

function stubContext(): never {
  return {
    ui: { dialogs: { register: vi.fn(), unregister: vi.fn() } },
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
async function ctrlK(): Promise<KeyboardEvent> {
  const e = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(e);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  return e;
}

beforeAll(() => {
  initKeybindings();
});
beforeEach(() => {
  h.showDialog.mockClear();
  extension.activate(stubContext());
  for (const cb of h.selectionSubs) cb({ startRow: 4, startCol: 2, endRow: 4, endCol: 2, type: "cells" });
});
afterEach(() => {
  extension.deactivate?.();
  while (cleanups.length > 0) cleanups.pop()!();
  setGlobalIsEditing(false);
  document.body.innerHTML = "";
});

describe("Ctrl+K (Insert Hyperlink) while a cell edit owns the keyboard", () => {
  it("a floating grid's live edit, PARKED with the keyboard on the grid container: no dialog, the key is left alone", async () => {
    startFloatingGridEdit();
    focus(gridContainer());
    const e = await ctrlK();
    expect(h.showDialog).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("Core's own in-cell edit with the keyboard momentarily on the grid: no dialog, the key is left alone", async () => {
    setGlobalIsEditing(true);
    focus(gridContainer());
    const e = await ctrlK();
    expect(h.showDialog).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("the formula bar focused (a text field): no dialog, the key is left alone", async () => {
    focus(document.createElement("input"));
    const e = await ctrlK();
    expect(h.showDialog).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("positive control: nothing being edited, grid focused -> Insert Hyperlink opens ONCE, for the active cell", async () => {
    focus(gridContainer());
    const e = await ctrlK();
    expect(h.showDialog).toHaveBeenCalledTimes(1);
    expect(h.showDialog).toHaveBeenCalledWith("insert-hyperlink", { row: 4, col: 2, editMode: false });
    expect(e.defaultPrevented).toBe(true);
  });
});
