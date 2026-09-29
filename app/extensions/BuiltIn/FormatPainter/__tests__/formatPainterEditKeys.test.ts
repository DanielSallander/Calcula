//! FILENAME: app/extensions/BuiltIn/FormatPainter/__tests__/formatPainterEditKeys.test.ts
// PURPOSE: Ctrl+Shift+C does not start Format Painter while a cell edit owns
//          the keyboard (and in any text field), and still picks up the format
//          when nothing is being edited.
// CONTEXT: Fix round 4, F2. The listener checked NOTHING: Ctrl+Shift+C typed in
//          the formula bar -- during Core's own edit or a floating grid's cell
//          edit -- started the painter on Core's selection, a HIDDEN one during
//          a floating-grid edit. Since BUG-0199 the key is started ONLY by the
//          registry binding ("not-editing"), so this drives the REAL
//          dispatcher (initKeybindings) and the real command registry through
//          the real activation; only the painter itself is doubled.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

const activate = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../formatPainterLogic", () => ({
  activateFormatPainter: (...a: unknown[]) => activate(...a),
  deactivateFormatPainter: vi.fn(),
}));
vi.mock("../formatPainterState", () => ({ isFormatPainterActive: () => false }));
vi.mock("@api/ui", () => ({ registerMenuItem: vi.fn(), unregisterMenuItem: vi.fn() }));
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  // eslint-disable-next-line @typescript-eslint/naming-convention -- the real export name
  ExtensionRegistry: { onSelectionChange: () => () => {} },
}));

import extension from "../index";
import { CommandRegistry, CoreCommands } from "@api/commands";
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
function ctrlShiftC(): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "C", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
}
function painterStarts(): number {
  return activate.mock.calls.length;
}

beforeAll(() => {
  initKeybindings();
});
beforeEach(() => {
  activate.mockClear();
  extension.activate(stubContext());
});
afterEach(() => {
  extension.deactivate();
  CommandRegistry.unregister(CoreCommands.FORMAT_PAINTER);
  CommandRegistry.unregister(CoreCommands.FORMAT_PAINTER_LOCK);
  while (cleanups.length > 0) cleanups.pop()!();
  setGlobalIsEditing(false);
  document.body.innerHTML = "";
});

describe("Format Painter Ctrl+Shift+C while a cell edit owns the keyboard", () => {
  it("a floating grid's live edit, parked with the keyboard on the grid container: the painter does not start, key not taken", () => {
    startFloatingGridEdit();
    focus(gridContainer());
    const e = ctrlShiftC();
    expect(painterStarts()).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  it("a floating grid's live edit in the formula bar: the painter does not start", () => {
    startFloatingGridEdit();
    focus(document.createElement("input"));
    ctrlShiftC();
    expect(painterStarts()).toBe(0);
  });

  it("Core's own in-cell edit: the painter does not start", () => {
    setGlobalIsEditing(true);
    focus(document.createElement("textarea"));
    ctrlShiftC();
    expect(painterStarts()).toBe(0);
  });

  it("any text field (a dialog's input), no cell edit: the painter does not start", () => {
    focus(document.createElement("input"));
    ctrlShiftC();
    expect(painterStarts()).toBe(0);
  });

  it("positive control: nothing being edited, grid focused -> the painter starts", () => {
    focus(gridContainer());
    const e = ctrlShiftC();
    expect(painterStarts()).toBe(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("positive control: a ribbon button focused (not a text field) -> the painter still starts", () => {
    focus(document.createElement("button"));
    ctrlShiftC();
    expect(painterStarts()).toBe(1);
  });
});
