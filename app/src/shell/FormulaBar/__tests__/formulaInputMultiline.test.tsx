//! FILENAME: app/src/shell/FormulaBar/__tests__/formulaInputMultiline.test.tsx
// PURPOSE: Expanding the bar swaps the editor's ELEMENT. The keys must not
//          notice.
//
// CONTEXT: Collapsed, the editor is an <input>, where Enter does nothing on its
//          own and the component's handler is the only thing that ends the
//          entry. Expanded it is a <textarea>, where Enter inserts a NEWLINE by
//          default — so the same handler now has to keep suppressing a default
//          that did not exist before. Get that wrong and committing a cell with
//          Enter also writes a stray "\n" into it, or worse, does not commit at
//          all and quietly starts a second line.
//
//          Alt+Enter is the mirror image: it is SUPPOSED to make a newline, and
//          it does so by splicing the character itself (the in-cell editor's
//          approach — see InlineEditor.tsx) rather than by letting the textarea
//          default through, so it behaves identically in both elements. That
//          path already worked; it was simply invisible in a 22px slit.
//
// Both elements are exercised by the same table, because "the keys still work"
// is a claim about the pair, not about either one.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// ---------------------------------------------------------------------------
// Doubles, matching formulaInputSelectionRace.test.tsx.
// ---------------------------------------------------------------------------

const dispatch = vi.fn();
const gridState = {
  selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
  referenceStyle: "A1",
};

/**
 * The edit in progress, or null. It has to START null and be switched on:
 * the component copies `editing.value` into its own display state on the
 * TRANSITION (the render-time derived-state pattern), so a doubled editor that
 * was already editing at first render shows an empty string and every
 * caret-relative assertion below would be about nothing.
 */
let editingCell: { value: string; row: number; col: number } | null = null;
const updateValue = vi.fn();
const commitEdit = vi.fn(() => Promise.resolve({ success: true }));
const cancelEdit = vi.fn(() => Promise.resolve());

vi.mock("../../../api", () => ({
  useGridContext: () => ({ state: gridState, dispatch }),
  getCell: () => Promise.resolve(null),
  getMergeInfo: () => Promise.resolve(null),
  isSheetProtected: () => Promise.resolve(false),
  getCellProtection: () => Promise.resolve({ formulaHidden: false }),
  checkRangeGuards: () => null,
  getSpillRanges: () => Promise.resolve([]),
}));

vi.mock("../../../api/editing", () => ({
  useEditing: () => ({
    editing: editingCell,
    updateValue,
    commitEdit,
    cancelEdit,
    startEdit: vi.fn(),
  }),
  setGlobalIsEditing: vi.fn(),
  getGlobalEditingValue: () => editingCell?.value ?? "",
  setGlobalCursorPosition: vi.fn(),
  getGlobalCursorPosition: () => 0,
  setChartSeriesRefMode: vi.fn(),
}));

vi.mock("../../../api/formulaAutocomplete", () => ({
  isFormulaAutocompleteVisible: () => false,
  AutocompleteEvents: { INPUT: "ac:input", KEY: "ac:key", ACCEPTED: "ac:accepted" },
}));

import { FormulaInput } from "../FormulaInput";

// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;
let commitComplete: Array<{ key: string; shiftKey: boolean }>;

function onCommitComplete(e: Event): void {
  commitComplete.push((e as CustomEvent).detail);
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Render the editor in one of its two shapes. */
function render(expanded: boolean): void {
  act(() => {
    root.render(React.createElement(FormulaInput, { expanded, editorHeight: 80 }));
  });
}

/** Render idle, then open an edit on `value` — the transition the bar sees. */
async function beginEditing(expanded: boolean, value: string): Promise<void> {
  editingCell = null;
  render(expanded);
  await flush();
  editingCell = { value, row: 0, col: 0 };
  render(expanded);
  await flush();
  expect(editor().value).toBe(value);
}

function editor(): HTMLInputElement | HTMLTextAreaElement {
  const el = container.querySelector("[data-formula-bar]");
  if (!el) throw new Error("the formula bar editor did not render");
  return el as HTMLInputElement | HTMLTextAreaElement;
}

/** Press a key on the editor and hand back the event, defaults and all. */
async function press(init: KeyboardEventInit, caret?: number): Promise<KeyboardEvent> {
  const el = editor();
  if (caret !== undefined) el.setSelectionRange(caret, caret);
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    el.dispatchEvent(event);
    await Promise.resolve();
    await Promise.resolve();
  });
  return event;
}

const SHAPES: Array<[string, boolean, string]> = [
  ["collapsed", false, "input"],
  ["expanded", true, "textarea"],
];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  editingCell = null;
  updateValue.mockClear();
  commitEdit.mockClear();
  cancelEdit.mockClear();
  dispatch.mockClear();
  commitComplete = [];
  window.addEventListener("formulaBar:commitComplete", onCommitComplete);
});

afterEach(() => {
  window.removeEventListener("formulaBar:commitComplete", onCommitComplete);
  act(() => root.unmount());
  container.remove();
});

describe.each(SHAPES)("FormulaInput (%s) — the entry keys", (_label, expanded, tag) => {
  it("renders the element the mode calls for", async () => {
    await beginEditing(expanded, "=SUM(A1:A9)");
    expect(editor().tagName.toLowerCase()).toBe(tag);
  });

  it("Enter commits, and never types a newline", async () => {
    await beginEditing(expanded, "=SUM(A1:A9)");

    const event = await press({ key: "Enter" });

    expect(commitEdit).toHaveBeenCalledTimes(1);
    expect(
      event.defaultPrevented,
      "the default was allowed through — on the expanded <textarea> that is a " +
        "literal newline appended to the cell the user just committed",
    ).toBe(true);
    expect(commitComplete).toEqual([{ key: "Enter", shiftKey: false }]);
    expect(updateValue).not.toHaveBeenCalled();
  });

  it("Tab commits and asks the grid to move sideways", async () => {
    await beginEditing(expanded, "=SUM(A1:A9)");

    const event = await press({ key: "Tab" });

    expect(commitEdit).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(commitComplete).toEqual([{ key: "Tab", shiftKey: false }]);
  });

  it("Shift+Enter commits backwards", async () => {
    await beginEditing(expanded, "=SUM(A1:A9)");

    await press({ key: "Enter", shiftKey: true });

    expect(commitComplete).toEqual([{ key: "Enter", shiftKey: true }]);
  });

  it("Escape cancels and never commits", async () => {
    await beginEditing(expanded, "=SUM(A1:A9)");

    const event = await press({ key: "Escape" });

    expect(cancelEdit).toHaveBeenCalledTimes(1);
    expect(commitEdit).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(commitComplete).toEqual([{ key: "Escape", shiftKey: false }]);
  });

  it("Alt+Enter types the newline itself, and does not commit", async () => {
    await beginEditing(expanded, "=SUM(A1:A9)");

    const event = await press({ key: "Enter", altKey: true }, 4);

    expect(commitEdit).not.toHaveBeenCalled();
    expect(
      updateValue,
      "Alt+Enter must SPLICE the newline at the caret — leaving it to the " +
        "textarea's default would put it in the collapsed <input> nowhere at all",
    ).toHaveBeenCalledWith("=SUM\n(A1:A9)");
    expect(event.defaultPrevented).toBe(true);
  });
});
