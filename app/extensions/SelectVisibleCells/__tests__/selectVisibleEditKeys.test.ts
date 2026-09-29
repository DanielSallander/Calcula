//! FILENAME: app/extensions/SelectVisibleCells/__tests__/selectVisibleEditKeys.test.ts
// PURPOSE: Alt+; does not reshape Core's selection while a cell edit owns the
//          keyboard, and still runs Select Visible Cells (once) when nothing is
//          being edited.
// CONTEXT: Fix round 4, F2: Alt+; typed during a floating grid's live cell
//          edit PARKED with the keyboard on the grid container rewrote Core's
//          selection under the edit. That was the extension's own window
//          listener; since wave B (D1) the keybinding registry is the ONE
//          keyboard path and the listener is gone, so this drives the REAL
//          dispatcher (initKeybindings, the `not-editing` binding) and the REAL
//          `selectVisibleCells.execute` command through the real activation.
//          The first thing it does is read the grid state, so that read is the
//          witness.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

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
import { CommandRegistry } from "@api/commands";
import { initKeybindings } from "@api/keybindings";
import { registerExternalFormulaTarget, setGlobalIsEditing } from "@api/editing";

const cleanups: (() => void)[] = [];

function stubContext(): never {
  return {
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
async function altSemicolon(): Promise<KeyboardEvent> {
  const e = new KeyboardEvent("keydown", { key: ";", altKey: true, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(e);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  return e;
}

beforeAll(() => {
  initKeybindings();
});
beforeEach(() => {
  getGridStateSnapshot.mockClear();
  extension.activate(stubContext());
});
afterEach(() => {
  extension.deactivate?.();
  while (cleanups.length > 0) cleanups.pop()!();
  setGlobalIsEditing(false);
  document.body.innerHTML = "";
});

describe("Select Visible Cells Alt+; while a cell edit owns the keyboard", () => {
  it("a floating grid's live edit, PARKED with the keyboard on the grid container: selection untouched, key not taken", async () => {
    startFloatingGridEdit();
    focus(gridContainer());
    const e = await altSemicolon();
    expect(getGridStateSnapshot).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("Core's own in-cell edit with the keyboard momentarily on the grid: selection untouched", async () => {
    setGlobalIsEditing(true);
    focus(gridContainer());
    await altSemicolon();
    expect(getGridStateSnapshot).not.toHaveBeenCalled();
  });

  it("positive control: nothing being edited, grid focused -> it runs ONCE", async () => {
    focus(gridContainer());
    const e = await altSemicolon();
    expect(getGridStateSnapshot).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });
});
