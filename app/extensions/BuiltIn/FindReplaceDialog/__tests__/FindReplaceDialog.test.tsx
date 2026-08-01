//! FILENAME: app/extensions/BuiltIn/FindReplaceDialog/__tests__/FindReplaceDialog.test.tsx
// PURPOSE: Prove that a REFUSED replace is shown to the user, not just logged.
// CONTEXT: `replace_all` now rejects the WHOLE gesture when any match sits
//          inside a subscribed .calp writeback region — the answers collected
//          there must not be rewritten by a find/replace. Nothing changes, and
//          the backend's message is the only thing that names the region and
//          the way out. Before this suite existed the dialog swallowed that
//          rejection into console.error, which made Replace All look like a
//          silent no-op: the user pressed a button, the grid did not change,
//          and the app said nothing. That is precisely the failure a unit test
//          has to lock down, so this file is also the directory's first test
//          harness (the dialog had none).
//
//          Mocked: @api (the facade functions the dialog calls) — nothing else.
//          The zustand find store, the useDialogWindow hook and the real
//          styled-components markup all run, so the assertions are made against
//          the DOM the user actually sees.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// ---------------------------------------------------------------------------
// Mocks (hoisted by vitest — every reference to a test local must sit inside a
// closure that runs later, never in the factory body itself)
// ---------------------------------------------------------------------------

const dispatchMock = vi.fn();
const findAllMock = vi.fn();
const replaceAllMock = vi.fn();
const replaceSingleMock = vi.fn();
const cellEventEmitMock = vi.fn();

vi.mock("@api", () => ({
  useGridDispatch: () => dispatchMock,
  setSelection: (
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    mode: string,
  ) => ({ type: "SET_SELECTION", startRow, startCol, endRow, endCol, mode }),
  scrollToCell: (row: number, col: number, center: boolean) => ({
    type: "SCROLL_TO_CELL",
    row,
    col,
    center,
  }),
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

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** The refusal the backend sends back for a match inside a writeback region. */
const REFUSAL =
  'Replace refused: "B2:C5" is inside writeback region "Q4 responses"; ' +
  "edit it through the response form instead.";

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

/** The debounce the dialog puts on its search box, plus a margin. */
const SEARCH_DEBOUNCE_MS = 350;

async function render(): Promise<void> {
  await act(async () => {
    root.render(<FindReplaceDialog isOpen onClose={onClose} />);
  });
}

/** Set a React-controlled input the way a keystroke would. */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function settleSearch(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS));
  });
}

function inputs(): HTMLInputElement[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>("input[type='text']"));
}

function buttonWithText(text: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!match) throw new Error(`no button labelled "${text}"`);
  return match as HTMLButtonElement;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function alertText(): string | null {
  const alert = container.querySelector("[role='alert']");
  return alert ? (alert.textContent ?? "") : null;
}

/**
 * Open the Replace dialog, search for "old" and land two matches — the state
 * every refusal test starts from (the Replace buttons are disabled with none).
 */
async function openWithMatches(): Promise<void> {
  findAllMock.mockResolvedValue({ matches: [[1, 1], [4, 2]] });
  useFindStore.getState().open(true);
  await render();
  await typeInto(inputs()[0], "old");
  await settleSearch();
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  dispatchMock.mockReset();
  findAllMock.mockReset();
  replaceAllMock.mockReset();
  replaceSingleMock.mockReset();
  cellEventEmitMock.mockReset();
  onClose.mockReset();
  useFindStore.getState().reset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  useFindStore.getState().reset();
});

// ---------------------------------------------------------------------------

describe("Find & Replace dialog — harness sanity", () => {
  it("renders nothing while the store says the dialog is closed", async () => {
    await render();
    expect(container.textContent).toBe("");
  });

  it("searches and reports the match count", async () => {
    await openWithMatches();
    expect(findAllMock).toHaveBeenCalledWith("old", {
      caseSensitive: false,
      matchEntireCell: false,
      searchFormulas: false,
    });
    expect(container.textContent).toContain("1 of 2 matches");
  });
});

describe("Replace All refused by the writeback guard", () => {
  it("SHOWS the backend's refusal instead of only logging it", async () => {
    await openWithMatches();
    replaceAllMock.mockRejectedValue(new Error(REFUSAL));

    // console.error must not be the only place this lands.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await click(buttonWithText("All"));
    consoleError.mockRestore();

    expect(alertText()).toContain("writeback region");
    expect(alertText()).toContain("Q4 responses");
  });

  it("gives the refusal a live region so it is announced, not just painted", async () => {
    await openWithMatches();
    replaceAllMock.mockRejectedValue(new Error(REFUSAL));
    await click(buttonWithText("All"));

    const alert = container.querySelector("[role='alert']");
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toBe(REFUSAL);
  });

  it("lets the refusal outrank the match count", async () => {
    await openWithMatches();
    replaceAllMock.mockRejectedValue(new Error(REFUSAL));
    await click(buttonWithText("All"));

    // "1 of 2 matches" next to an unexplained no-op is exactly the confusion
    // this guard's message exists to prevent.
    expect(container.textContent).not.toContain("1 of 2 matches");
    expect(container.textContent).toContain(REFUSAL);
  });

  it("keeps the matches, because the backend changed nothing", async () => {
    await openWithMatches();
    replaceAllMock.mockRejectedValue(new Error(REFUSAL));
    await click(buttonWithText("All"));

    expect(useFindStore.getState().matches).toHaveLength(2);
    expect(cellEventEmitMock).not.toHaveBeenCalled();
  });

  it("passes a non-Error rejection through verbatim", async () => {
    // Tauri rejects with a bare string, which is the common shape here.
    await openWithMatches();
    replaceAllMock.mockRejectedValue(REFUSAL);
    await click(buttonWithText("All"));

    expect(alertText()).toBe(REFUSAL);
  });

  it("clears the refusal when the user edits the query", async () => {
    await openWithMatches();
    replaceAllMock.mockRejectedValue(new Error(REFUSAL));
    await click(buttonWithText("All"));
    expect(alertText()).not.toBeNull();

    await typeInto(inputs()[0], "older");
    expect(alertText()).toBeNull();
  });

  it("clears the refusal once a later Replace All succeeds", async () => {
    await openWithMatches();
    replaceAllMock.mockRejectedValue(new Error(REFUSAL));
    await click(buttonWithText("All"));
    expect(alertText()).not.toBeNull();

    replaceAllMock.mockReset();
    replaceAllMock.mockResolvedValue({
      replacementCount: 2,
      updatedCells: [{ row: 1, col: 1, display: "new", formula: null }],
    });
    await click(buttonWithText("All"));

    expect(alertText()).toBeNull();
    expect(cellEventEmitMock).toHaveBeenCalledTimes(1);
    expect(useFindStore.getState().matches).toEqual([]);
  });
});

describe("single Replace refused by the writeback guard", () => {
  it("SHOWS the refusal — the cell did not change and nothing else says why", async () => {
    await openWithMatches();
    replaceSingleMock.mockRejectedValue(new Error(REFUSAL));

    await click(buttonWithText("Replace"));

    expect(replaceSingleMock).toHaveBeenCalledWith(1, 1, "old", "", false);
    expect(alertText()).toBe(REFUSAL);
  });
});
