//! FILENAME: app/extensions/FlashFill/__tests__/flashFillEditKeys.test.ts
// PURPOSE: Flash Fill's own Ctrl+E listener stands down while a cell edit owns
//          the keyboard, and still runs when nothing is being edited.
// CONTEXT: Fix round 4, F2. The listener's text-field tag list (on the event
//          TARGET) could not see a floating grid's live cell edit PARKED with
//          the keyboard on the grid container, where Ctrl+E filled around
//          Core's hidden selection. Driven through the real activation and the
//          real window listener; the first thing Flash Fill does is read the
//          grid state, so that read is the witness.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
import { registerExternalFormulaTarget, setGlobalIsEditing } from "@api/editing";

const cleanups: (() => void)[] = [];

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
function ctrlE(): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "e", ctrlKey: true, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
}

beforeEach(() => {
  getGridStateSnapshot.mockClear();
  extension.activate({ commands: { register: vi.fn() } } as never);
});
afterEach(() => {
  extension.deactivate();
  while (cleanups.length > 0) cleanups.pop()!();
  setGlobalIsEditing(false);
  document.body.innerHTML = "";
});

describe("Flash Fill Ctrl+E while a cell edit owns the keyboard", () => {
  it("a floating grid's live edit, PARKED with the keyboard on the grid container: no flash fill, key not taken", () => {
    startFloatingGridEdit();
    focus(gridContainer());
    const e = ctrlE();
    expect(getGridStateSnapshot).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("Core's own in-cell edit with the keyboard momentarily on the grid: no flash fill", () => {
    setGlobalIsEditing(true);
    focus(gridContainer());
    ctrlE();
    expect(getGridStateSnapshot).not.toHaveBeenCalled();
  });

  it("the formula bar focused (unchanged: a text field): no flash fill", () => {
    focus(document.createElement("input"));
    ctrlE();
    expect(getGridStateSnapshot).not.toHaveBeenCalled();
  });

  it("positive control: nothing being edited, grid focused -> flash fill runs", () => {
    focus(gridContainer());
    const e = ctrlE();
    expect(getGridStateSnapshot).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });
});
