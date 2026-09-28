//! FILENAME: app/extensions/BuiltIn/CellBookmarks/__tests__/bookmarkEditKeys.test.ts
// PURPOSE: Cell Bookmarks' own key listener (Ctrl+Shift+B, Ctrl+] / Ctrl+[,
//          Ctrl+Shift+V) stands down while a cell edit owns the keyboard, and
//          still acts when nothing is being edited.
// CONTEXT: Fix round 4, F2. The registry's bookmark bindings became
//          "not-editing", so during an edit the dispatcher no longer stops
//          these keys in the capture phase and this BUBBLE-phase listener
//          hears them. It had only a pointer-claim check: Ctrl+Shift+B would
//          bookmark Core's selection (hidden during a floating-grid edit),
//          Ctrl+] would move it, and Ctrl+Shift+V -- the native paste-as-text in
//          a field -- was cancelled to open Save View.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const addBookmark = vi.fn();
const removeBookmark = vi.fn();
vi.mock("../lib/bookmarkStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/bookmarkStore")>()),
  addBookmark: (...a: unknown[]) => addBookmark(...a),
  removeBookmark: (...a: unknown[]) => removeBookmark(...a),
  hasBookmarkAt: () => false,
}));
const navigateToNextBookmark = vi.fn(() => ({ row: 0, col: 0 }));
const navigateToPrevBookmark = vi.fn(() => ({ row: 0, col: 0 }));
vi.mock("../lib/bookmarkNavigation", () => ({
  navigateToNextBookmark: () => navigateToNextBookmark(),
  navigateToPrevBookmark: () => navigateToPrevBookmark(),
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({
    selection: { startRow: 7, startCol: 2, endRow: 7, endCol: 2 },
    sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
  }),
}));
const showOverlay = vi.fn();
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showOverlay: (...a: unknown[]) => showOverlay(...a),
  showToast: vi.fn(),
}));

import { handleBookmarkKeyDown } from "../index";
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
function key(k: string, shift: boolean): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: k, ctrlKey: true, shiftKey: shift, bubbles: true, cancelable: true });
  Object.defineProperty(e, "target", { value: document.activeElement ?? document.body });
  handleBookmarkKeyDown(e);
  return e;
}
function acted(): number {
  return (
    addBookmark.mock.calls.length +
    removeBookmark.mock.calls.length +
    navigateToNextBookmark.mock.calls.length +
    navigateToPrevBookmark.mock.calls.length +
    showOverlay.mock.calls.length
  );
}

const KEYS: [string, string, boolean][] = [
  ["Ctrl+Shift+B", "B", true],
  ["Ctrl+]", "]", false],
  ["Ctrl+[", "[", false],
  ["Ctrl+Shift+V", "V", true],
];

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  setGlobalIsEditing(false);
  document.body.innerHTML = "";
});

describe("Cell Bookmarks keys while a cell edit owns the keyboard", () => {
  for (const [label, k, shift] of KEYS) {
    it(`${label}: a floating grid's live edit, parked with the keyboard on the grid -> nothing happens, key not taken`, () => {
      startFloatingGridEdit();
      focus(gridContainer());
      const e = key(k, shift);
      expect(acted()).toBe(0);
      expect(e.defaultPrevented).toBe(false);
    });

    it(`${label}: the formula bar focused during a floating grid's edit -> nothing happens`, () => {
      startFloatingGridEdit();
      focus(document.createElement("input"));
      key(k, shift);
      expect(acted()).toBe(0);
    });

    it(`${label}: Core's own in-cell edit -> nothing happens`, () => {
      setGlobalIsEditing(true);
      focus(document.createElement("textarea"));
      const e = key(k, shift);
      expect(acted()).toBe(0);
      expect(e.defaultPrevented).toBe(false);
    });

    it(`${label}: positive control -- nothing being edited, grid focused -> it acts`, () => {
      focus(gridContainer());
      const e = key(k, shift);
      expect(acted()).toBe(1);
      expect(e.defaultPrevented).toBe(true);
    });
  }

  it("Ctrl+Shift+B with no edit bookmarks Core's active cell", () => {
    focus(gridContainer());
    key("B", true);
    expect(addBookmark).toHaveBeenCalledWith(7, 2, 0, "Sheet1");
  });
});
