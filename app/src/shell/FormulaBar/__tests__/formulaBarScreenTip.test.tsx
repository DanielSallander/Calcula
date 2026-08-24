//! FILENAME: app/src/shell/FormulaBar/__tests__/formulaBarScreenTip.test.tsx
// PURPOSE: The formula bar must announce the CARET, not only the text.
//
// CONTEXT: The function screen tip answers "which argument of which call am I
//          standing in", and that answer changes when the caret moves with the
//          formula untouched — clicking from an outer function into a nested
//          one, or simply opening an edit on a cell that already holds
//          `=VLOOKUP(...)`. The extension that computes it is driven entirely by
//          `autocomplete:input`, and this component used to emit that ONLY from
//          onChange: the nested-call logic was written, correct, and never
//          re-run, so the tip showed the wrong function or none at all.
//
//          The events are asserted here rather than the tip itself, because
//          this side of the seam owns exactly one thing: telling the extension
//          where the caret is. What the extension then draws is pinned in
//          extensions/BuiltIn/FormulaAutocomplete/argumentHint.test.tsx.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// ---------------------------------------------------------------------------
// Doubles, matching formulaInputSelectionRace.test.tsx: every backend call the
// component makes through the @api barrel is a promise this test controls.
// ---------------------------------------------------------------------------

interface FakeCell {
  formula?: string;
  display?: string;
}

const cells = new Map<string, FakeCell>();
const dispatch = vi.fn();
const gridState: {
  selection: { startRow: number; startCol: number; endRow: number; endCol: number } | null;
  referenceStyle: string;
} = { selection: null, referenceStyle: "A1" };

vi.mock("../../../api", () => ({
  useGridContext: () => ({ state: gridState, dispatch }),
  getCell: (row: number, col: number) => Promise.resolve(cells.get(`${row},${col}`) ?? null),
  getMergeInfo: () => Promise.resolve(null),
  isSheetProtected: () => Promise.resolve(false),
  getCellProtection: () => Promise.resolve({ formulaHidden: false }),
  checkRangeGuards: () => null,
  getSpillRanges: () => Promise.resolve([]),
}));

const startEdit = vi.fn(() => Promise.resolve());

vi.mock("../../../api/editing", () => ({
  useEditing: () => ({
    editing: null,
    updateValue: vi.fn(),
    commitEdit: vi.fn(),
    cancelEdit: vi.fn(),
    startEdit,
  }),
  setGlobalIsEditing: vi.fn(),
  getGlobalEditingValue: () => "",
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
let announced: Array<{ value: string; cursorPosition: number; source: string }>;

function onInput(e: Event): void {
  announced.push((e as CustomEvent).detail);
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function editor(): HTMLInputElement | HTMLTextAreaElement {
  const el = container.querySelector("[data-formula-bar]");
  if (!el) throw new Error("the formula bar editor did not render");
  return el as HTMLInputElement | HTMLTextAreaElement;
}

/**
 * Move the caret the way a user does. React derives onSelect from the input
 * events around a selection change (keyup/mouseup), never from a synthetic
 * `select` event — so the keyup is what makes this a real caret move rather
 * than a direct call to the handler.
 */
function moveCaret(pos: number): void {
  const el = editor();
  act(() => {
    el.setSelectionRange(pos, pos);
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "ArrowLeft" }));
  });
}

/**
 * Type into the controlled editor. The value has to go in through the ELEMENT's
 * own setter: React overrides the `value` property on the instance to track
 * what it last wrote, so assigning `el.value` directly leaves the tracker
 * believing nothing changed and no onChange is ever dispatched.
 */
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!setValue) throw new Error("no native value setter to type through");
  setValue.call(el, value);
  el.setSelectionRange(value.length, value.length);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("FormulaInput announces where the caret is, not only what was typed", () => {
  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    cells.clear();
    dispatch.mockClear();
    startEdit.mockClear();
    announced = [];
    window.addEventListener("ac:input", onInput);
    gridState.selection = { startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
  });

  afterEach(() => {
    window.removeEventListener("ac:input", onInput);
    act(() => root.unmount());
    container.remove();
  });

  async function showFormula(formula: string): Promise<void> {
    cells.set("0,0", { formula, display: "x" });
    act(() => {
      root.render(React.createElement(FormulaInput));
    });
    await flush();
    expect(editor().value).toBe(formula);
    announced = [];
  }

  it("announces a caret move inside a formula", async () => {
    await showFormula("=VLOOKUP(A1,B:C,2,FALSE)");
    editor().focus();
    announced = [];

    moveCaret(13);

    expect(
      announced,
      "the caret moved into another argument and nothing was told about it — " +
        "the screen tip cannot follow a caret it never hears about",
    ).toHaveLength(1);
    expect(announced[0].value).toBe("=VLOOKUP(A1,B:C,2,FALSE)");
    expect(announced[0].cursorPosition).toBe(13);
    expect(announced[0].source).toBe("formulaBar");
  });

  it("announces the formula when the edit opens on it", async () => {
    // The outcome is what is pinned, not which path produced it: focusing an
    // element also makes jsdom report a selection change that React turns into
    // an onSelect, so the announcement can arrive from the focus handler or
    // from the caret handler and the two cannot be told apart here. Removing
    // both is what this reds on — and both is what "the tip never appears" is.
    await showFormula("=SUM(A1,B1)");

    act(() => {
      editor().focus();
    });
    await flush();

    expect(
      announced.some((a) => a.value === "=SUM(A1,B1)"),
      "opening an edit on an existing formula announced nothing, so the tip " +
        "only ever appeared after the first keystroke",
    ).toBe(true);
  });

  it("says nothing about a caret moving through a plain value", async () => {
    await showFormula("Quarterly revenue");
    editor().focus();
    announced = [];

    moveCaret(4);

    expect(announced).toHaveLength(0);
  });

  it("still announces what is typed", async () => {
    // Positive control: the caret path must not have displaced the typing path.
    await showFormula("=SUM(");
    const el = editor();
    act(() => {
      el.focus();
      typeInto(el, "=SUM(A");
    });

    expect(announced.some((a) => a.value === "=SUM(A" && a.cursorPosition === 6)).toBe(true);
  });
});
