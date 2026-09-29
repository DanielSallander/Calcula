//! FILENAME: app/src/api/__tests__/keybindings.editContext.test.ts
// PURPOSE: The registry built-ins that act on Core's SELECTION stand down while
//          a cell edit owns the keyboard -- Core's in-cell editor, the formula
//          bar, or a floating grid's live cell edit (an external edit session,
//          whose keyboard can sit on the grid container while it is parked
//          picking a reference) -- and still run when nothing is being edited.
// CONTEXT: Fix round 4, F2. Ctrl+T, Ctrl+Shift+L, Ctrl+E, Ctrl+K, the bookmark
//          keys, Alt+Shift+Arrow, Ctrl+Alt+M and Alt+; were context "always",
//          so Ctrl+T typed in the formula bar during a floating-grid edit ran
//          Insert Table over Core's hidden selection. They are "not-editing"
//          now: the dispatcher's own editing context (isEditingKeystroke). The
//          extensions' OWN listeners for the same keys ask @api/editing
//          isEditKeystroke, which is built from the same rule; its unit cases
//          are at the bottom.
//          Round-4 review: the dispatcher did not read Core's OWN edit flag, so
//          (a) with Core's edit PARKED on another sheet (a formula begun on
//          Sheet1, the user on Sheet2 picking a reference: no in-cell editor
//          rendered, the keyboard on the grid container) Ctrl+T, Ctrl+Shift+L,
//          Delete and the rest still ran over the viewed sheet's selection, and
//          (b) in the in-cell editor, a <textarea> INSIDE the grid container,
//          the GRID-SCOPED built-ins (Ctrl+Shift+C, the fills, merge, Format
//          Cells, the clipboard) still ran. Both are the "Core's own edit"
//          blocks below; the grid-scoped rows are GRID_SCOPED_KEYS.

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { handleGlobalKeyDown, initKeybindings, isEditingKeystroke } from "../keybindings";
import { CommandRegistry } from "../commands";
import { isCellEditInProgress, isEditKeystroke, setGlobalIsEditing } from "../editing";
import { registerExternalFormulaTarget } from "../../core/lib/formulaEditTarget";

/** [label, keydown init, the built-in's command] -- one row per selection-acting built-in. */
const SELECTION_KEYS: [string, KeyboardEventInit, string][] = [
  ["Ctrl+T", { key: "t", ctrlKey: true }, "insert.table"],
  ["Ctrl+Shift+L", { key: "L", ctrlKey: true, shiftKey: true }, "autofilter.toggle"],
  ["Ctrl+E", { key: "e", ctrlKey: true }, "flashfill.execute"],
  ["Ctrl+K", { key: "k", ctrlKey: true }, "hyperlinks.insert"],
  ["Ctrl+Shift+B", { key: "B", ctrlKey: true, shiftKey: true }, "bookmarks.toggle"],
  ["Ctrl+]", { key: "]", ctrlKey: true }, "bookmarks.next"],
  ["Ctrl+[", { key: "[", ctrlKey: true }, "bookmarks.prev"],
  ["Alt+Shift+ArrowRight", { key: "ArrowRight", altKey: true, shiftKey: true }, "grouping.group"],
  ["Alt+Shift+ArrowLeft", { key: "ArrowLeft", altKey: true, shiftKey: true }, "grouping.ungroup"],
  ["Ctrl+Alt+M", { key: "m", ctrlKey: true, altKey: true }, "review.newComment"],
  ["Alt+;", { key: ";", altKey: true }, "selectVisibleCells.execute"],
];

const cleanups: (() => void)[] = [];
const spies = new Map<string, ReturnType<typeof vi.fn>>();

beforeAll(() => {
  initKeybindings();
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  for (const id of spies.keys()) CommandRegistry.unregister(id);
  spies.clear();
  setGlobalIsEditing(false);
  document.body.innerHTML = "";
  (document.activeElement as HTMLElement | null)?.blur?.();
});

function spyAll(): void {
  for (const [, , commandId] of SELECTION_KEYS) {
    const spy = vi.fn();
    CommandRegistry.register(commandId, spy);
    spies.set(commandId, spy);
  }
}

function focusGrid(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-focus-container", "spreadsheet");
  el.tabIndex = -1;
  document.body.appendChild(el);
  el.focus();
  return el;
}

function focusField(tag: "input" | "textarea"): HTMLElement {
  const el = document.createElement(tag);
  document.body.appendChild(el);
  el.focus();
  return el;
}

/** A floating grid's cell edit: a two-view session in the pick slot. */
function startExternalSession(): void {
  cleanups.push(
    registerExternalFormulaTarget({
      isExpectingReference: () => false,
      insertReference: () => undefined,
      session: {} as never,
    }),
  );
}

function press(init: KeyboardEventInit): { handled: boolean; event: KeyboardEvent } {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "target", { value: document.activeElement ?? document.body });
  return { handled: handleGlobalKeyDown(event), event };
}

describe("selection-acting built-ins during a live floating-grid edit", () => {
  for (const [label, init, commandId] of SELECTION_KEYS) {
    it(`${label}: parked with the keyboard on the grid container -> ${commandId} does not run, the key is not taken`, () => {
      spyAll();
      startExternalSession();
      focusGrid();
      const { handled, event } = press(init);
      expect(spies.get(commandId)!, `${commandId} ran during a live floating-grid edit`).not.toHaveBeenCalled();
      expect(handled).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    });

    it(`${label}: the formula bar hosting it -> ${commandId} does not run`, () => {
      spyAll();
      startExternalSession();
      focusField("input");
      press(init);
      expect(spies.get(commandId)!).not.toHaveBeenCalled();
    });
  }
});

describe("selection-acting built-ins during Core's own in-cell edit", () => {
  for (const [label, init, commandId] of SELECTION_KEYS) {
    it(`${label}: the in-cell editor (a textarea) focused -> ${commandId} does not run`, () => {
      spyAll();
      setGlobalIsEditing(true);
      focusField("textarea");
      const { handled, event } = press(init);
      expect(spies.get(commandId)!, `${commandId} ran during an in-cell edit`).not.toHaveBeenCalled();
      expect(handled).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    });
  }
});

describe("positive controls", () => {
  for (const [label, init, commandId] of SELECTION_KEYS) {
    it(`${label}: no edit, grid focused -> ${commandId} runs`, () => {
      spyAll();
      focusGrid();
      const { handled } = press(init);
      expect(handled).toBe(true);
      expect(spies.get(commandId)!).toHaveBeenCalledTimes(1);
    });
  }

  it("a truly global key (Ctrl+S) still runs during a live floating-grid edit", () => {
    const save = vi.fn();
    CommandRegistry.register("core.file.save", save);
    cleanups.push(() => CommandRegistry.unregister("core.file.save"));
    startExternalSession();
    focusGrid();
    press({ key: "s", ctrlKey: true });
    expect(save).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Core's OWN edit (round-4 review)
// ---------------------------------------------------------------------------

/** The grid-scoped built-ins: they act on the selected CELLS wherever they run. */
const GRID_SCOPED_KEYS: [string, KeyboardEventInit, string][] = [
  ["Ctrl+Shift+C", { key: "C", ctrlKey: true, shiftKey: true }, "core.format.painter"],
  ["Ctrl+D", { key: "d", ctrlKey: true }, "core.edit.fillDown"],
  ["Ctrl+R", { key: "r", ctrlKey: true }, "core.edit.fillRight"],
  ["Ctrl+M", { key: "m", ctrlKey: true }, "core.grid.merge"],
  ["Ctrl+1", { key: "1", ctrlKey: true }, "core.format.cells"],
  ["Ctrl+C", { key: "c", ctrlKey: true }, "core.clipboard.copy"],
  ["Ctrl+X", { key: "x", ctrlKey: true }, "core.clipboard.cut"],
  ["Ctrl+V", { key: "v", ctrlKey: true }, "core.clipboard.paste"],
  ["Ctrl+Shift+V", { key: "V", ctrlKey: true, shiftKey: true }, "core.clipboard.pasteSpecial"],
  ["Delete", { key: "Delete" }, "core.edit.clearContents"],
];

/** Workbook undo/redo ("not-editing"): a formula being typed owns its own undo. */
const UNDO_KEYS: [string, KeyboardEventInit, string][] = [
  ["Ctrl+Z", { key: "z", ctrlKey: true }, "core.edit.undo"],
  ["Ctrl+Y", { key: "y", ctrlKey: true }, "core.edit.redo"],
];

const CORE_EDIT_KEYS = [...SELECTION_KEYS, ...GRID_SCOPED_KEYS, ...UNDO_KEYS];

function spyOn(rows: [string, KeyboardEventInit, string][]): void {
  for (const [, , commandId] of rows) {
    if (spies.has(commandId)) continue;
    const spy = vi.fn();
    CommandRegistry.register(commandId, spy);
    spies.set(commandId, spy);
  }
}

/**
 * Core's edit PARKED on another sheet: useSpreadsheetEditing's
 * handleFocusRestoreForEditing puts the keyboard on the grid container (the
 * in-cell editor is not rendered on the sheet being viewed) while the flag
 * stays up. No text field is focused -- only the flag says "editing".
 */
function parkCoreEdit(): HTMLElement {
  setGlobalIsEditing(true);
  return focusGrid();
}

/**
 * Core's in-cell editor as Spreadsheet.tsx renders it: a <textarea> INSIDE the
 * [data-focus-container="spreadsheet"] element, so "grid focused" holds.
 */
function openInCellEditor(): HTMLTextAreaElement {
  setGlobalIsEditing(true);
  const container = document.createElement("div");
  container.setAttribute("data-focus-container", "spreadsheet");
  container.tabIndex = -1;
  const editor = document.createElement("textarea");
  editor.setAttribute("data-inline-editor", "true");
  container.appendChild(editor);
  document.body.appendChild(container);
  editor.focus();
  return editor;
}

describe("Core's own edit PARKED on another sheet (keyboard on the grid container)", () => {
  for (const [label, init, commandId] of CORE_EDIT_KEYS) {
    it(`${label}: ${commandId} does not run and the key is not taken`, () => {
      spyOn(CORE_EDIT_KEYS);
      parkCoreEdit();
      const { handled, event } = press(init);
      expect(
        spies.get(commandId)!,
        `${commandId} ran over the viewed sheet's selection during Core's parked edit`,
      ).not.toHaveBeenCalled();
      // Unprevented, so Core's own doors (the container's fallback branch and
      // useGridKeyboard's edit gate) see it and leave the grid alone.
      expect(handled).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    });
  }

  it("a truly global key (Ctrl+S) still runs", () => {
    const save = vi.fn();
    CommandRegistry.register("core.file.save", save);
    cleanups.push(() => CommandRegistry.unregister("core.file.save"));
    parkCoreEdit();
    press({ key: "s", ctrlKey: true });
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("Core's in-cell editor (a textarea INSIDE the grid container)", () => {
  for (const [label, init, commandId] of CORE_EDIT_KEYS) {
    it(`${label}: ${commandId} does not run and the key reaches the editor`, () => {
      spyOn(CORE_EDIT_KEYS);
      openInCellEditor();
      const { handled, event } = press(init);
      expect(spies.get(commandId)!, `${commandId} ran during the in-cell edit`).not.toHaveBeenCalled();
      // Unprevented: Ctrl+C/X/V are the text field's own clipboard.
      expect(handled).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    });
  }
});

describe("positive controls for Core's own edit: the flag down, grid focused", () => {
  for (const [label, init, commandId] of [...GRID_SCOPED_KEYS, ...UNDO_KEYS]) {
    it(`${label}: ${commandId} runs`, () => {
      spyOn(CORE_EDIT_KEYS);
      focusGrid();
      const { handled } = press(init);
      expect(handled).toBe(true);
      expect(spies.get(commandId)!).toHaveBeenCalledTimes(1);
    });
  }

  it("the flag coming DOWN re-arms the grid: park, end the edit, Delete clears again", () => {
    spyOn(GRID_SCOPED_KEYS);
    parkCoreEdit();
    press({ key: "Delete" });
    expect(spies.get("core.edit.clearContents")!).not.toHaveBeenCalled();
    setGlobalIsEditing(false);
    press({ key: "Delete" });
    expect(spies.get("core.edit.clearContents")!).toHaveBeenCalledTimes(1);
  });
});

describe("the predicates", () => {
  function ev(init: KeyboardEventInit = {}): KeyboardEvent {
    const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "L", ...init });
    Object.defineProperty(e, "target", { value: document.activeElement ?? document.body });
    return e;
  }

  it("nothing being edited, grid focused: neither predicate holds", () => {
    focusGrid();
    expect(isEditingKeystroke(ev())).toBe(false);
    expect(isEditKeystroke(ev())).toBe(false);
    expect(isCellEditInProgress()).toBe(false);
  });

  it("a live external session with the keyboard on the grid: both hold", () => {
    startExternalSession();
    focusGrid();
    expect(isEditingKeystroke(ev())).toBe(true);
    expect(isEditKeystroke(ev())).toBe(true);
    expect(isCellEditInProgress()).toBe(true);
  });

  it("Core's edit with the keyboard on the grid (parked): BOTH hold -- the listener and the dispatcher agree", () => {
    setGlobalIsEditing(true);
    focusGrid();
    expect(isCellEditInProgress()).toBe(true);
    expect(isEditKeystroke(ev())).toBe(true);
    expect(isEditingKeystroke(ev()), "the dispatcher's editing context missed Core's parked edit").toBe(true);
  });

  it("a text field focused, or an event whose TARGET is one: the extension-facing one holds", () => {
    focusField("input");
    expect(isEditKeystroke(ev())).toBe(true);
    (document.activeElement as HTMLElement).blur();
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    const e = new KeyboardEvent("keydown", { key: "L" });
    Object.defineProperty(e, "target", { value: field });
    expect(isEditKeystroke(e)).toBe(true);
  });
});
