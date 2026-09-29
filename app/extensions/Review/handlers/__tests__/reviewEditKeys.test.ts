//! FILENAME: app/extensions/Review/handlers/__tests__/reviewEditKeys.test.ts
// PURPOSE: Ctrl+Alt+M (new comment) and Shift+F2 (new note) do nothing while a
//          cell edit owns the keyboard, and still act on the active cell (once)
//          when nothing is being edited.
// CONTEXT: Fix round 4, F2: Ctrl+Alt+M typed during a floating grid's live
//          cell edit PARKED with the keyboard on the grid container put a
//          comment on Core's hidden active cell. (Ctrl+Alt+M is also AltGr+M
//          on some layouts -- a character someone may be typing.) That was the
//          extension's own window listener; since wave B (D1) the keybinding
//          registry is the ONE keyboard path and the listener is gone, so this
//          drives the REAL dispatcher (initKeybindings, the `not-editing`
//          bindings) and the REAL review.newComment / review.newNote commands.
//          The first thing either does is look up the cell's existing
//          comment/note, so that read is the witness.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

const getComment = vi.fn(async (..._a: unknown[]) => null);
const getNote = vi.fn(async (..._a: unknown[]) => null);
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  getComment: (...a: unknown[]) => getComment(...a),
  getNote: (...a: unknown[]) => getNote(...a),
  addComment: vi.fn(async () => ({ success: false })),
  addNote: vi.fn(async () => ({ success: false })),
  showOverlay: vi.fn(),
}));
vi.mock("../../lib/annotationStore", () => ({ refreshAnnotationState: vi.fn(async () => {}) }));

import { registerReviewCommands, setActiveCellForKeyboard } from "../keyboardHandler";
import { CommandRegistry } from "@api/commands";
import { initKeybindings } from "@api/keybindings";
import { registerExternalFormulaTarget, setGlobalIsEditing } from "@api/editing";

const cleanups: (() => void)[] = [];
let unregisterCommands: () => void = () => {};

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
async function press(init: KeyboardEventInit): Promise<KeyboardEvent> {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(e);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  return e;
}
const KEYS: [string, KeyboardEventInit, () => number][] = [
  ["Ctrl+Alt+M", { key: "m", ctrlKey: true, altKey: true }, () => getComment.mock.calls.length],
  ["Shift+F2", { key: "F2", shiftKey: true }, () => getNote.mock.calls.length],
];
function acted(): number {
  return getComment.mock.calls.length + getNote.mock.calls.length;
}

beforeAll(() => {
  initKeybindings();
});
beforeEach(() => {
  vi.clearAllMocks();
  setActiveCellForKeyboard({ row: 3, col: 1 });
  unregisterCommands = registerReviewCommands({
    register: (id, fn) => CommandRegistry.register(id, fn),
    unregister: (id) => CommandRegistry.unregister(id),
  });
});
afterEach(() => {
  unregisterCommands();
  setActiveCellForKeyboard(null);
  while (cleanups.length > 0) cleanups.pop()!();
  setGlobalIsEditing(false);
  document.body.innerHTML = "";
});

describe("Review shortcuts while a cell edit owns the keyboard", () => {
  for (const [label, init, first] of KEYS) {
    it(`${label}: a floating grid's live edit, PARKED with the keyboard on the grid container -> nothing, key not taken`, async () => {
      startFloatingGridEdit();
      focus(gridContainer());
      const e = await press(init);
      expect(acted()).toBe(0);
      expect(e.defaultPrevented).toBe(false);
    });

    it(`${label}: Core's own in-cell edit with the keyboard momentarily on the grid -> nothing`, async () => {
      setGlobalIsEditing(true);
      focus(gridContainer());
      await press(init);
      expect(acted()).toBe(0);
    });

    it(`${label}: positive control -- nothing being edited, grid focused -> it acts on the active cell, ONCE`, async () => {
      focus(gridContainer());
      const e = await press(init);
      expect(first()).toBe(1);
      expect(e.defaultPrevented).toBe(true);
    });
  }
});
