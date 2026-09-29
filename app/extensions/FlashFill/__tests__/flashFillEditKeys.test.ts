//! FILENAME: app/extensions/FlashFill/__tests__/flashFillEditKeys.test.ts
// PURPOSE: Ctrl+E does not run Flash Fill while a cell edit owns the keyboard,
//          and still runs it (once) when nothing is being edited.
// CONTEXT: Fix round 4, F2: Ctrl+E typed during a floating grid's live cell
//          edit PARKED with the keyboard on the grid container filled around
//          Core's hidden selection. That was the extension's own window
//          listener; since wave B (D1) the keybinding registry is the ONE
//          keyboard path and the listener is gone, so this drives the REAL
//          dispatcher (initKeybindings, the `not-editing` binding) and the REAL
//          `flashfill.execute` command through the real activation. The first
//          thing Flash Fill does is read the grid state, so that read is the
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
}));

import extension from "../index";
import { CommandRegistry } from "@api/commands";
import { initKeybindings } from "@api/keybindings";
import { registerExternalFormulaTarget, setGlobalIsEditing } from "@api/editing";

const cleanups: (() => void)[] = [];

function stubContext(): never {
  return {
    commands: {
      register: (id: string, fn: (...a: unknown[]) => unknown, opts?: unknown) =>
        CommandRegistry.register(id, fn, opts as never),
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
async function ctrlE(): Promise<KeyboardEvent> {
  const e = new KeyboardEvent("keydown", { key: "e", ctrlKey: true, bubbles: true, cancelable: true });
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

describe("Flash Fill Ctrl+E while a cell edit owns the keyboard", () => {
  it("a floating grid's live edit, PARKED with the keyboard on the grid container: no flash fill, key not taken", async () => {
    startFloatingGridEdit();
    focus(gridContainer());
    const e = await ctrlE();
    expect(getGridStateSnapshot).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("Core's own in-cell edit with the keyboard momentarily on the grid: no flash fill", async () => {
    setGlobalIsEditing(true);
    focus(gridContainer());
    await ctrlE();
    expect(getGridStateSnapshot).not.toHaveBeenCalled();
  });

  it("the formula bar focused (a text field): no flash fill", async () => {
    focus(document.createElement("input"));
    await ctrlE();
    expect(getGridStateSnapshot).not.toHaveBeenCalled();
  });

  it("positive control: nothing being edited, grid focused -> flash fill runs ONCE", async () => {
    focus(gridContainer());
    const e = await ctrlE();
    expect(getGridStateSnapshot).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });
});
