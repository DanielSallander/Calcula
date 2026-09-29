//! FILENAME: app/extensions/AutoFilter/__tests__/autoFilterEditKeys.test.ts
// PURPOSE: Ctrl+Shift+L does not toggle AutoFilter while a cell edit owns the
//          keyboard, and still toggles it (once) when nothing is being edited.
// CONTEXT: Fix round 4, F2: Ctrl+Shift+L typed during a floating grid's cell
//          edit (its editor or the formula bar focused, or parked with the
//          keyboard on the grid container) toggled AutoFilter over Core's
//          HIDDEN selection -- and in Core's own in-cell editor it did the
//          same, where Excel ignores the key. That was the extension's own
//          window listener; since wave B (D1) the keybinding registry is the
//          ONE keyboard path and the listener is gone, so this drives the REAL
//          dispatcher (initKeybindings, the `not-editing` binding) and the REAL
//          command through the real activation.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

const toggleFilter = vi.fn();
vi.mock("../lib/filterStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/filterStore")>()),
  toggleFilter: (...args: unknown[]) => toggleFilter(...args),
  refreshFilterState: vi.fn(async () => undefined),
}));

import extension from "../index";
import { CommandRegistry } from "@api/commands";
import { initKeybindings } from "@api/keybindings";
import { registerExternalFormulaTarget, setGlobalIsEditing } from "@api/editing";

const cleanups: (() => void)[] = [];

/** Every door inert, except `commands`, which are REAL. */
function stubContext(): never {
  const inert = (): unknown =>
    new Proxy(() => () => {}, {
      get: (_t, prop) => (prop === "then" ? undefined : inert()),
      apply: () => () => {},
    });
  return new Proxy(inert() as Record<string, unknown>, {
    get: (t, prop) =>
      prop === "commands"
        ? {
            register: (id: string, fn: (...a: unknown[]) => unknown) => CommandRegistry.register(id, fn),
            unregister: (id: string) => CommandRegistry.unregister(id),
            execute: (id: string) => CommandRegistry.execute(id),
          }
        : (t as Record<string | symbol, unknown>)[prop as string],
  }) as never;
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
async function ctrlShiftL(): Promise<KeyboardEvent> {
  const e = new KeyboardEvent("keydown", { key: "L", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(e);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  return e;
}

beforeAll(() => {
  initKeybindings();
});
beforeEach(() => {
  toggleFilter.mockClear();
  extension.activate(stubContext());
});
afterEach(() => {
  extension.deactivate?.();
  while (cleanups.length > 0) cleanups.pop()!();
  setGlobalIsEditing(false);
  document.body.innerHTML = "";
});

describe("AutoFilter Ctrl+Shift+L while a cell edit owns the keyboard", () => {
  it("a floating grid's live edit, parked with the keyboard on the grid container: no toggle, key not taken", async () => {
    startFloatingGridEdit();
    focus(gridContainer());
    const e = await ctrlShiftL();
    expect(toggleFilter).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("a floating grid's live edit in the formula bar: no toggle", async () => {
    startFloatingGridEdit();
    focus(document.createElement("input"));
    await ctrlShiftL();
    expect(toggleFilter).not.toHaveBeenCalled();
  });

  it("Core's own in-cell edit: no toggle", async () => {
    setGlobalIsEditing(true);
    focus(document.createElement("textarea"));
    await ctrlShiftL();
    expect(toggleFilter).not.toHaveBeenCalled();
  });

  it("positive control: nothing being edited, grid focused -> the filter toggles ONCE", async () => {
    focus(gridContainer());
    const e = await ctrlShiftL();
    expect(toggleFilter).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });
});
