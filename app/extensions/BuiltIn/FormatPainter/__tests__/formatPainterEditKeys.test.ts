//! FILENAME: app/extensions/BuiltIn/FormatPainter/__tests__/formatPainterEditKeys.test.ts
// PURPOSE: Format Painter's own Ctrl+Shift+C listener stands down while a cell
//          edit owns the keyboard (and in any text field), and still picks up
//          the format when nothing is being edited.
// CONTEXT: Fix round 4, F2. The listener checked NOTHING: Ctrl+Shift+C typed in
//          the formula bar -- during Core's own edit or a floating grid's cell
//          edit -- started the painter on Core's selection, a HIDDEN one during
//          a floating-grid edit. Driven through the real activation and the
//          real window listener; only the painter itself is doubled.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../formatPainterLogic", () => ({
  activateFormatPainter: vi.fn(async () => {}),
  deactivateFormatPainter: vi.fn(),
}));
vi.mock("../formatPainterState", () => ({ isFormatPainterActive: () => false }));
vi.mock("@api/ui", () => ({ registerMenuItem: vi.fn() }));
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  ExtensionRegistry: { onSelectionChange: () => () => {} },
}));

import extension from "../index";
import { CoreCommands } from "@api/commands";
import { registerExternalFormulaTarget, setGlobalIsEditing } from "@api/editing";

const execute = vi.fn(async (..._a: unknown[]) => {});
const cleanups: (() => void)[] = [];

function stubContext(): never {
  return { commands: { register: vi.fn(), execute } } as never;
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
  return execute.mock.calls.filter((c) => c[0] === CoreCommands.FORMAT_PAINTER).length;
}

beforeEach(() => {
  execute.mockClear();
  extension.activate(stubContext());
});
afterEach(() => {
  extension.deactivate();
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
