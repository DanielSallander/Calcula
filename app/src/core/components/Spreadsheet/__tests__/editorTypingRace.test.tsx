//! FILENAME: app/src/core/components/Spreadsheet/__tests__/editorTypingRace.test.tsx
// PURPOSE: Typing a value into a closed cell must commit ALL of it, in order.
//
// CONTEXT: Measured against the shipped build, `type("hello")` committed "o"
//          and `type("tabbed")` committed "b" -- only the last keystroke
//          survived. Typing after F2 (editor already open) was fine, so the
//          loss was in the open-then-receive-keystrokes path.
//
//          Opening by typing is asynchronous. The container's keydown handler
//          calls startEditing(key), which awaits checkEditGuards and
//          getMergeInfo before it dispatches the editing state; React then has
//          to render the editor and the editor has to take focus. Every key
//          that lands inside that window arrives at the grid CONTAINER, and the
//          container lost it twice over:
//
//            * before the editing state existed it could not tell an open was
//              already in flight, so it called startEditing AGAIN -- each call
//              dispatching a replace-mode entry holding only its own character,
//              last dispatch winning. That is the "o" and the "b".
//            * after the state existed but before the editor had focus, its
//              "let the editor handle it" early-return dropped the key.
//
//          The oracle below forces the race rather than hoping for it: the IPC
//          round trip inside startEditing is held open, the whole word (and the
//          Enter after it) is typed into that window, and only then is the
//          backend allowed to answer. Against the pre-fix code the first
//          assertion reads "o".

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

// --- Backend ---------------------------------------------------------------
/** Resolvers for every parked getMergeInfo, in call order. */
let mergeGate: Array<() => void> = [];
/** While true, getMergeInfo parks -- this is the open window, held open. */
let holdMergeInfo = false;
/** Everything that reached the backend as a committed cell value. */
let committed: Array<{ row: number; col: number; value: string }> = [];

const getMergeInfo = vi.fn(async () => {
  if (holdMergeInfo) {
    await new Promise<void>((resolve) => {
      mergeGate.push(resolve);
    });
  }
  return null;
});

vi.mock("../../../lib/tauri-api", () => ({
  getMergeInfo: (...args: unknown[]) => getMergeInfo(...(args as [])),
  getCell: vi.fn(async () => null),
  updateCell: vi.fn(async (row: number, col: number, value: string) => {
    committed.push({ row, col, value });
    return { cells: [{ row, col, display: value, formula: null }] };
  }),
  updateCellOnSheets: vi.fn(async () => []),
  setActiveSheet: vi.fn(async () => {}),
  getViewportCells: vi.fn(async () => []),
  updateCellsBatch: vi.fn(async () => []),
  beginUndoTransaction: vi.fn(async () => {}),
  commitUndoTransaction: vi.fn(async () => {}),
  cancelUndoTransaction: vi.fn(async () => {}),
  findCtrlArrowTarget: vi.fn(async () => [0, 0] as [number, number]),
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 9, endCol: 9 })),
}));

vi.mock("../../../../api/formulaAutocomplete", () => ({
  isFormulaAutocompleteVisible: () => false,
  AutocompleteEvents: { INPUT: "ac:input", KEY: "ac:key", ACCEPTED: "ac:accepted" },
}));
vi.mock("../../../../api/columnAutocomplete", () => ({
  isColumnAutocompleteVisible: () => false,
  ColumnAutocompleteEvents: { KEY: "cac:key", ACCEPTED: "cac:accepted" },
}));
vi.mock("../../../../api/cellTypes", () => ({
  handleCellTypeKeyDown: vi.fn(async () => false),
}));

import { useSpreadsheetEditing } from "../useSpreadsheetEditing";
import { InlineEditor } from "../../InlineEditor";
import { GridProvider, useGridContext } from "../../../state/GridContext";
import { getInitialState } from "../../../state/gridReducer";
import { setSelection } from "../../../state/gridActions";
import { setGlobalIsEditing } from "../../../hooks";
import {
  DEFAULT_GRID_CONFIG,
  createEmptyDimensionOverrides,
  type GridConfig,
  type Viewport,
} from "../../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const CONFIG: GridConfig = {
  ...DEFAULT_GRID_CONFIG,
  defaultCellWidth: 64,
  defaultCellHeight: 20,
  rowHeaderWidth: 50,
  colHeaderHeight: 24,
  totalRows: 1000,
  totalCols: 100,
};

const VIEWPORT: Viewport = {
  scrollX: 0,
  scrollY: 0,
  startRow: 0,
  startCol: 0,
  rowCount: 30,
  colCount: 20,
};

/** Cursor moves requested after a commit, as [deltaRow, deltaCol]. */
let moves: Array<[number, number]> = [];

/**
 * The moves, with -0 normalised to 0. Shift inverts both deltas, so moving up
 * asks for (-1, -0); -0 is the same cursor move but not the same value under
 * Object.is, which is all toEqual checks.
 */
function movesTaken(): Array<[number, number]> {
  return moves.map(([r, c]) => [r + 0, c + 0] as [number, number]);
}

// ---------------------------------------------------------------------------
// Harness: the real container-keydown -> useEditing -> InlineEditor wiring,
// assembled exactly as Spreadsheet.tsx assembles it.
// ---------------------------------------------------------------------------

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const focusContainerRef = useRef<HTMLDivElement | null>(null);
  const formulaInputRef = useRef<HTMLInputElement | null>(null);

  const { editingState, handlers } = useSpreadsheetEditing({
    containerRef,
    focusContainerRef,
    formulaInputRef,
    state,
    selectedCellContent: "",
    moveActiveCell: (dr, dc) => {
      moves.push([dr, dc]);
    },
    scrollToSelection: () => {},
    selectCell: () => {},
  });

  useEffect(() => {
    dispatch(setSelection({ startRow: 2, startCol: 1, endRow: 2, endCol: 1, type: "cells" }));
  }, [dispatch]);

  return (
    <div
      ref={focusContainerRef}
      data-testid="grid"
      tabIndex={0}
      onKeyDown={handlers.handleContainerKeyDown}
    >
      {editingState.editing && editingState.isEditing && (
        <InlineEditor
          editing={editingState.editing}
          config={CONFIG}
          viewport={VIEWPORT}
          dimensions={createEmptyDimensionOverrides()}
          onValueChange={handlers.handleInlineValueChange}
          onCommit={handlers.handleInlineCommit}
          onCancel={handlers.handleInlineCancel}
          onTab={handlers.handleInlineTab}
          onEnter={handlers.handleInlineEnter}
          onCtrlEnter={handlers.handleInlineCtrlEnter}
          onRestoreFocus={() => focusContainerRef.current?.focus()}
          onArrowKeyReference={handlers.handleArrowKeyReference}
        />
      )}
    </div>
  );
}

let root: Root;
let host: HTMLDivElement;

function gridEl(): HTMLDivElement {
  return host.querySelector("[data-testid='grid']") as HTMLDivElement;
}

function editorEl(): HTMLTextAreaElement | null {
  return host.querySelector("[data-inline-editor]") as HTMLTextAreaElement | null;
}

async function mount(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <GridProvider initialState={getInitialState()}>
        <Harness />
      </GridProvider>,
    );
  });
}

/**
 * Press a key at the grid container, the way the browser does while the grid --
 * not the editor -- holds focus. Deliberately does NOT flush timers: the point
 * of these tests is what happens to keys that arrive before the editor is
 * ready, so the editor must be allowed to stay un-ready.
 */
async function pressOnGrid(
  key: string,
  mods: { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; keyCode?: number } = {},
): Promise<void> {
  await act(async () => {
    gridEl().dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }),
    );
    await Promise.resolve();
  });
}

/** Type a whole word at the grid, one keydown per character. */
async function typeOnGrid(text: string): Promise<void> {
  for (const ch of text) await pressOnGrid(ch);
}

/** Let the parked backend answer, then drain promises, React work and timers. */
async function releaseBackend(): Promise<void> {
  await act(async () => {
    const gates = mergeGate;
    mergeGate = [];
    for (const open of gates) open();
    await Promise.resolve();
    await Promise.resolve();
  });
  await settle();
}

/** Drain everything, including the setTimeout(0) that focuses the editor. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("typing to open the inline editor", () => {
  beforeEach(() => {
    committed = [];
    moves = [];
    mergeGate = [];
    holdMergeInfo = true;
    getMergeInfo.mockClear();
    window.innerWidth = 1200;
    window.innerHeight = 800;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    setGlobalIsEditing(false);
    holdMergeInfo = false;
    mergeGate = [];
  });

  // -------------------------------------------------------------------------
  // The data loss
  // -------------------------------------------------------------------------

  it("keeps every character typed while the editor is opening", async () => {
    await mount();
    await typeOnGrid("hello");
    // Nothing has been able to open yet: the entry lives entirely in the
    // open window at this point.
    await releaseBackend();

    expect(editorEl()?.value).toBe("hello");
    // The caret is where a typist expects it: after the last character.
    expect(editorEl()?.selectionStart).toBe(5);
  });

  it("commits the whole word, in order, when Enter follows", async () => {
    await mount();
    await typeOnGrid("hello");
    await releaseBackend();
    await pressOnEditor("Enter");

    // Pre-fix this was "o".
    expect(committed).toEqual([{ row: 2, col: 1, value: "hello" }]);
  });

  it("commits the whole word when the Enter ALSO lands inside the open window", async () => {
    await mount();
    await typeOnGrid("tabbed");
    // Typed faster than the editor could mount: the commit key arrives before
    // there is anything to press it on, and must be replayed rather than lost.
    await pressOnGrid("Enter");
    await releaseBackend();

    // Pre-fix this was "b" -- and the Enter did nothing at all.
    expect(committed).toEqual([{ row: 2, col: 1, value: "tabbed" }]);
    expect(movesTaken()).toEqual([[1, 0]]);
  });

  it("starts exactly ONE edit no matter how fast the word is typed", async () => {
    await mount();
    await typeOnGrid("hello");
    await releaseBackend();

    // The regression was five overlapping startEditing calls, each resolving a
    // merge and each dispatching its own single-character entry.
    expect(getMergeInfo).toHaveBeenCalledTimes(1);
  });

  it("keeps characters that arrive after the state exists but before focus", async () => {
    // Only setTimeout is faked: React's own scheduler runs on a MessageChannel,
    // so the editor still mounts while the timer that focuses it stays parked.
    // That is precisely the second half of the window -- editor on screen,
    // keystrokes still arriving at the container -- where they used to be
    // silently dropped by the "let the editor handle it" early-return.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await mount();
      await pressOnGrid("a");
      await act(async () => {
        const gates = mergeGate;
        mergeGate = [];
        for (const open of gates) open();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(editorEl()).not.toBeNull();
      expect(document.activeElement).not.toBe(editorEl());

      await pressOnGrid("b");
      await pressOnGrid("c");

      // Now let it focus.
      await act(async () => {
        vi.runOnlyPendingTimers();
      });

      expect(editorEl()?.value).toBe("abc");
      expect(document.activeElement).toBe(editorEl());
      // ...and the caret is after the last character the user typed. The editor
      // restores the caret from the tracked position when it focuses, so a
      // position left behind at the seed would drop the user mid-word and the
      // next character would land inside the entry ("aXbc").
      expect(editorEl()?.selectionStart).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives a long entry typed entirely inside the window", async () => {
    await mount();
    const text = "The quick brown fox, 1234567890!";
    await typeOnGrid(text);
    await releaseBackend();

    expect(editorEl()?.value).toBe(text);
  });

  // -------------------------------------------------------------------------
  // The other keys, pressed at the same speed
  // -------------------------------------------------------------------------

  it("Escape typed inside the window cancels instead of committing", async () => {
    await mount();
    await typeOnGrid("abc");
    await pressOnGrid("Escape");
    await releaseBackend();

    expect(committed).toEqual([]);
    expect(editorEl()).toBeNull();
  });

  it("Tab typed inside the window commits and moves sideways", async () => {
    await mount();
    await typeOnGrid("abc");
    await pressOnGrid("Tab");
    await releaseBackend();

    expect(committed).toEqual([{ row: 2, col: 1, value: "abc" }]);
    expect(movesTaken()).toEqual([[0, 1]]);
  });

  it("Shift+Enter typed inside the window commits upward", async () => {
    await mount();
    await typeOnGrid("abc");
    await pressOnGrid("Enter", { shiftKey: true });
    await releaseBackend();

    expect(committed).toEqual([{ row: 2, col: 1, value: "abc" }]);
    expect(movesTaken()).toEqual([[-1, 0]]);
  });

  it("Backspace inside the window corrects the entry instead of clearing the cell", async () => {
    await mount();
    await typeOnGrid("abx");
    await pressOnGrid("Backspace");
    await pressOnGrid("c");
    await releaseBackend();

    expect(editorEl()?.value).toBe("abc");
    // The container's Delete/Backspace branch commits an empty cell; reaching
    // it mid-entry would have thrown the entry away.
    expect(committed).toEqual([]);
  });

  it("Alt+Enter inside the window puts a line break in the entry", async () => {
    await mount();
    await typeOnGrid("a");
    await pressOnGrid("Enter", { altKey: true });
    await typeOnGrid("b");
    await releaseBackend();

    expect(editorEl()?.value).toBe("a\nb");
    expect(committed).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // What must NOT open an editor
  // -------------------------------------------------------------------------

  it("does not open on an IME composition keydown", async () => {
    await mount();
    // WebView2 reports a composing keydown as keyCode 229; the composed text
    // arrives later as an input event on whatever holds focus. Opening on this
    // would eat the key and leave the composition nowhere to land.
    await pressOnGrid("Process", { keyCode: 229 });
    await settle();

    expect(editorEl()).toBeNull();
    expect(getMergeInfo).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // The path that already worked, kept working
  // -------------------------------------------------------------------------

  it("F2 then typing still edits normally", async () => {
    holdMergeInfo = false;
    await mount();
    await pressOnGrid("F2");
    await settle();

    const el = editorEl();
    expect(el).not.toBeNull();
    expect(document.activeElement).toBe(el);
  });
});

/** Press a key on the editor itself, once it has focus. */
async function pressOnEditor(
  key: string,
  mods: { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean } = {},
): Promise<void> {
  const el = editorEl();
  if (!el) throw new Error("no inline editor is open");
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }));
    await Promise.resolve();
    await Promise.resolve();
  });
  await settle();
}
