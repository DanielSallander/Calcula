//! FILENAME: app/extensions/BuiltIn/FindReplaceDialog/__tests__/findReplaceCellTarget.test.tsx
// PURPOSE: Find & Replace on a floating grid's cells (P3 S11, owner finding
//          G3): with one of the grid's cells selected, Find searches THAT
//          object (findAll with its target), a match is selected in the
//          object (the owner's selectCells -- never Core's setSelection, whose
//          cell is hidden under the object), and Replace / Replace All write
//          with the target. A replace never applies one scope's matches to
//          another: when the selection left the object, it refuses in words.
// CONTEXT: The selection owner is REAL (@api/selectionOwner); @api's search
//          functions are doubles, as in FindReplaceDialog.test.tsx.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const dispatchMock = vi.fn();
const findAllMock = vi.fn();
const replaceAllMock = vi.fn();
const replaceSingleMock = vi.fn();
const cellEventEmitMock = vi.fn();

vi.mock("@api", () => ({
  useGridDispatch: () => dispatchMock,
  setSelection: (startRow: number, startCol: number, endRow: number, endCol: number, mode: string) => ({
    type: "SET_SELECTION",
    startRow,
    startCol,
    endRow,
    endCol,
    mode,
  }),
  scrollToCell: (row: number, col: number, center: boolean) => ({ type: "SCROLL_TO_CELL", row, col, center }),
  findAll: (...args: unknown[]) => findAllMock(...args),
  replaceAll: (...args: unknown[]) => replaceAllMock(...args),
  replaceSingle: (...args: unknown[]) => replaceSingleMock(...args),
  cellEvents: {
    subscribe: () => () => {},
    emit: (...args: unknown[]) => cellEventEmitMock(...args),
  },
  columnToLetter: (col: number) => String.fromCharCode(65 + col),
}));

import { FindReplaceDialog } from "../FindReplaceDialog";
import { useFindStore } from "../../../_shared/lib/useFindStore";
import { registerSelectionOwner, type CellTargetCapability } from "@api/selectionOwner";
import type { Selection } from "@api/types";

const REF = { kind: "floatingRange" as const, id: "fr-1" };
const SEARCH_DEBOUNCE_MS = 350;

let container: HTMLDivElement;
let root: Root;
let frSelection: Selection | null = null;
let actsOn: readonly CellTargetCapability[] = ["read", "content"];
const selected: Selection[] = [];
let release: () => void = () => {};

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS));
  });
}

function buttonWithText(text: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
  if (!match) throw new Error(`no button labelled "${text}"`);
  return match as HTMLButtonElement;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function openAndSearch(): Promise<void> {
  findAllMock.mockResolvedValue({ matches: [[1, 1], [3, 0]] });
  useFindStore.getState().open(true);
  await act(async () => {
    root.render(<FindReplaceDialog isOpen onClose={() => {}} />);
  });
  const input = container.querySelector<HTMLInputElement>("input[type='text']")!;
  await typeInto(input, "old");
  await settle();
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  for (const m of [dispatchMock, findAllMock, replaceAllMock, replaceSingleMock, cellEventEmitMock]) m.mockReset();
  useFindStore.getState().reset();
  selected.length = 0;
  actsOn = ["read", "content"];
  frSelection = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells", activeRow: 0, activeCol: 0 };
  release = registerSelectionOwner({
    id: "test-floating-grid",
    label: "a floating grid's cells",
    ownsSelection: () => frSelection !== null,
    get actsOn() {
      return actsOn;
    },
    refusal: (action) => `${action} is not available inside a floating grid yet. Nothing was changed.`,
    cellTarget: () =>
      frSelection === null
        ? null
        : { ref: REF, selection: frSelection, bounds: { rows: 6, cols: 3 }, label: "Float1", wholeObject: false },
    selectCells: (sel) => {
      selected.push(sel);
      frSelection = sel;
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  useFindStore.getState().reset();
  release();
});

describe("Find & Replace on a floating grid's cells", () => {
  it("searches the OBJECT and selects the first match in it, never in Core's hidden selection", async () => {
    await openAndSearch();
    expect(findAllMock).toHaveBeenCalledWith(
      "old",
      { caseSensitive: false, matchEntireCell: false, searchFormulas: false },
      { target: REF },
    );
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(selected[0]).toMatchObject({ startRow: 1, startCol: 1, endRow: 1, endCol: 1, activeRow: 1, activeCol: 1 });
  });

  it("Find Next moves inside the object", async () => {
    await openAndSearch();
    await click(container.querySelector("button[title='Find Next (Enter)']")!);
    expect(selected.at(-1)).toMatchObject({ startRow: 3, startCol: 0 });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("Replace and Replace All write with the object's target, and emit no sheet cell events", async () => {
    await openAndSearch();
    replaceSingleMock.mockResolvedValue({ row: 1, col: 1, display: "new", formula: null });
    await click(buttonWithText("Replace"));
    expect(replaceSingleMock).toHaveBeenCalledWith(1, 1, "old", "", false, undefined, { target: REF });

    replaceAllMock.mockResolvedValue({ replacementCount: 1, updatedCells: [{ row: 3, col: 0, display: "new", formula: null }] });
    await click(buttonWithText("All"));
    expect(replaceAllMock).toHaveBeenCalledWith("old", "", { caseSensitive: false, matchEntireCell: false }, { target: REF });
    expect(cellEventEmitMock).not.toHaveBeenCalled();
  });

  it("a replace after the selection left the object refuses in words and writes nothing", async () => {
    await openAndSearch();
    frSelection = null; // the user clicked a sheet cell
    await click(buttonWithText("All"));
    expect(replaceAllMock).not.toHaveBeenCalled();
    expect(container.querySelector("[role='alert']")?.textContent).toBe(
      "The selection moved since the search. Search again. Nothing was changed.",
    );
  });

  it("Replace on an owner that admits no \"content\" refuses (inert until S8)", async () => {
    await openAndSearch();
    actsOn = ["read"];
    await click(buttonWithText("Replace"));
    expect(replaceSingleMock).not.toHaveBeenCalled();
  });
});
