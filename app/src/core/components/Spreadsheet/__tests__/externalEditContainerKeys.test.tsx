//! FILENAME: app/src/core/components/Spreadsheet/__tests__/externalEditContainerKeys.test.tsx
// PURPOSE: The container's React key handler is the FALLBACK door for a live
//          EXTERNAL edit session (a floating grid's cell edit parked on another
//          sheet while it picks a reference, or hosted by the formula bar):
//          every key that reaches the container goes to the FORMULA, never to
//          the grid. And a non-pick cell click commits the session (commit-
//          before-select), the grid's own rule.
// CONTEXT: Before this, with the keyboard on the container after a pick, a
//          printable key opened a SECOND, Core edit on the grid cell ("=+" became
//          a Core entry on Sheet1), Enter moved the grid cursor instead of
//          committing, and Delete ran an empty commit over the picked cell.
//
//          Keys are fired straight at the handler. In the app, Delete and the
//          other registry keys arrive here only because the capture-phase
//          keybinding dispatcher stands down for a live session (pinned by
//          api/__tests__/keybindings.externalEdit.test.ts).
//
//          Drives the REAL hook with the harness of claimedWidgetEditingKeys.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

const api = vi.hoisted(() => ({
  updateCell: vi.fn(async (row: number, col: number, value: string) => ({
    cells: [{ row, col, display: value, formula: null }],
  })),
  updateCellsBatch: vi.fn(async () => []),
  setActiveSheet: vi.fn(async (index: number) => ({
    sheets: [
      { index: 0, name: "Sheet1", visibility: "visible" },
      { index: 2, name: "Report", visibility: "visible", kind: "canvas" },
    ],
    activeIndex: index,
  })),
}));

vi.mock("../../../lib/tauri-api", () => ({
  getMergeInfo: vi.fn(async () => null),
  getCell: vi.fn(async () => null),
  updateCell: api.updateCell,
  updateCellOnSheets: vi.fn(async () => []),
  setActiveSheet: api.setActiveSheet,
  getViewportCells: vi.fn(async () => []),
  updateCellsBatch: api.updateCellsBatch,
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
import { getMergeInfo } from "../../../lib/tauri-api";
import { GridProvider, useGridContext } from "../../../state/GridContext";
import { getInitialState } from "../../../state/gridReducer";
import { setSelection } from "../../../state/gridActions";
import { setGlobalIsEditing } from "../../../hooks";
import {
  setExternalSessionParked,
  isExternalSessionParked,
  __resetExternalEditForTests,
} from "../../../lib/formulaEditTarget";
import {
  createFakeExternalEdit,
  type FakeExternalEdit,
} from "../../../lib/__tests__/helpers/fakeExternalEdit";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let moves: Array<[number, number]> = [];
let editorOpen = false;
let commitBeforeSelect: (() => Promise<void>) | null = null;

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
      moves.push([dr + 0, dc + 0]);
    },
    scrollToSelection: () => {},
    selectCell: () => {},
  });
  commitBeforeSelect = handlers.handleCommitBeforeSelect;

  const open = Boolean(editingState.editing && editingState.isEditing);
  useEffect(() => {
    editorOpen = open;
  }, [open]);

  useEffect(() => {
    dispatch(setSelection({ startRow: 1, startCol: 4, endRow: 1, endCol: 4, type: "cells" }));
  }, [dispatch]);

  return (
    <div ref={focusContainerRef} data-testid="grid" tabIndex={0} onKeyDown={handlers.handleContainerKeyDown}>
      <canvas data-testid="canvas" />
    </div>
  );
}

let root: Root;
let host: HTMLDivElement;

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

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function press(key: string, init: KeyboardEventInit = {}): Promise<boolean> {
  const target = host.querySelector("[data-testid='canvas']") as HTMLElement;
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
  });
  await settle();
  return event.defaultPrevented;
}

/** A floating grid's edit on sheet 2, parked on Sheet1 after a pick. */
function parkedSession(text: string): FakeExternalEdit {
  const fake = createFakeExternalEdit({ hostSheetIndex: 2, text });
  fake.register();
  setExternalSessionParked(0);
  return fake;
}

describe("the container's key handler while an external session is live", () => {
  beforeEach(() => {
    moves = [];
    editorOpen = false;
    commitBeforeSelect = null;
    setGlobalIsEditing(false);
    api.updateCell.mockClear();
    api.updateCellsBatch.mockClear();
    api.setActiveSheet.mockClear();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    setGlobalIsEditing(false);
    __resetExternalEditForTests();
  });

  it("a printable key goes INTO the formula at its caret -- never a second, Core edit", async () => {
    await mount();
    const fake = parkedSession("=");

    const prevented = await press("+");

    expect(prevented).toBe(true);
    expect(editorOpen).toBe(false);
    expect(fake.calls).toContainEqual({ fn: "setText", args: ["=+", 2] });
    expect(fake.session.getText()).toBe("=+");
  });

  it("Enter commits the session with the grid's Enter move, returning to its host first; the grid cursor stays", async () => {
    await mount();
    const fake = parkedSession("=Sheet1!E2");

    await press("Enter");

    expect(fake.calls.filter((c) => c.fn === "commit")).toEqual([{ fn: "commit", args: ["down"] }]);
    expect(api.setActiveSheet).toHaveBeenCalledWith(2);
    expect(isExternalSessionParked()).toBe(false);
    expect(moves).toEqual([]);
  });

  it("Shift+Tab commits with the matching move", async () => {
    await mount();
    const fake = parkedSession("=Sheet1!E2");
    await press("Tab", { shiftKey: true });
    expect(fake.calls.filter((c) => c.fn === "commit")).toEqual([{ fn: "commit", args: ["left"] }]);
  });

  it("Escape cancels the session", async () => {
    await mount();
    const fake = parkedSession("=Sheet1!E2");
    await press("Escape");
    expect(fake.calls.map((c) => c.fn)).toContain("cancel");
    expect(fake.calls.map((c) => c.fn)).not.toContain("commit");
  });

  it("Delete is never the grid's clear: no Core edit, no write", async () => {
    await mount();
    const fake = parkedSession("=Sheet1!E2");
    const prevented = await press("Delete");
    expect(prevented).toBe(true);
    expect(editorOpen).toBe(false);
    expect(api.updateCell).not.toHaveBeenCalled();
    expect(api.updateCellsBatch).not.toHaveBeenCalled();
    expect(fake.session.getText()).toBe("=Sheet1!E2");
  });

  it("Backspace deletes the character before the caret (parked with the bar hidden, this door is the only keyboard)", async () => {
    // Round-2 ledger item: Backspace here only handed the keyboard back -- to
    // this same container when the bar is hidden -- so a mistyped formula
    // could not be corrected without the mouse.
    await mount();
    const fake = parkedSession("=SUM(A1");

    const prevented = await press("Backspace");

    expect(prevented).toBe(true);
    expect(fake.session.getText()).toBe("=SUM(A");
    expect(fake.session.getCursor()).toBe(6);
    // Mid-formula: the character BEFORE the caret goes, not the last one.
    fake.session.setCursor(2);
    await press("Backspace");
    expect(fake.session.getText()).toBe("=UM(A");
    expect(fake.session.getCursor()).toBe(1);
    // Nothing else moved: no commit, no cancel, no Core edit, no write.
    expect(fake.calls.map((c) => c.fn)).not.toContain("commit");
    expect(fake.calls.map((c) => c.fn)).not.toContain("cancel");
    expect(editorOpen).toBe(false);
    expect(api.updateCell).not.toHaveBeenCalled();
  });

  it("Backspace at the start of the formula deletes nothing; Ctrl+Backspace is not a character delete", async () => {
    await mount();
    const fake = parkedSession("=A1");
    fake.session.setCursor(0);
    await press("Backspace");
    expect(fake.session.getText()).toBe("=A1");
    fake.session.setCursor(3);
    await press("Backspace", { ctrlKey: true });
    expect(fake.session.getText()).toBe("=A1");
  });

  it("on the HOST (not parked) a stray key hands the keyboard back to the in-place view", async () => {
    await mount();
    const fake = createFakeExternalEdit({ hostSheetIndex: 2, text: "=1" });
    fake.register();
    await press("ArrowDown");
    expect(fake.calls.map((c) => c.fn)).toContain("focusCellView");
    expect(moves).toEqual([]);
  });

  it("positive control: with no session a printable key opens the Core editor", async () => {
    await mount();
    await press("x");
    expect(editorOpen).toBe(true);
  });

  it("commit-before-select (a non-pick cell click) commits the session with no move", async () => {
    await mount();
    const fake = parkedSession("=Sheet1!E2");
    await act(async () => {
      await commitBeforeSelect?.();
    });
    expect(fake.calls.filter((c) => c.fn === "commit")).toEqual([{ fn: "commit", args: [null] }]);
    expect(api.setActiveSheet).toHaveBeenCalledWith(2);
  });
});

describe("the container's key handler with no session: modified Delete (review 2026-09-28)", () => {
  // The grid keyboard lets a modified Delete/Backspace through since it is no
  // clear (gridKeyboardModifiedDelete.test.tsx). This fallback must not turn
  // it into one: it used to open an EMPTY edit on the active cell and commit
  // it -- a clear, which under a floating range's selection is a clear of a
  // hidden cell. The empty edit's open is what is observed (startEditing
  // resolves the active cell's merge first); the harness's commit of it
  // writes nothing, since the edit state it would commit is not yet rendered.
  const startEditingProbe = vi.mocked(getMergeInfo);
  beforeEach(() => {
    editorOpen = false;
    setGlobalIsEditing(false);
    startEditingProbe.mockClear();
    api.updateCell.mockClear();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    setGlobalIsEditing(false);
    __resetExternalEditForTests();
  });

  it("positive control: the bare Delete opens the empty edit that clears the active cell", async () => {
    await mount();
    const prevented = await press("Delete");
    expect(prevented).toBe(true);
    expect(startEditingProbe).toHaveBeenCalledWith(1, 4);
  });

  const MODIFIED: [string, KeyboardEventInit][] = [
    ["Delete", { ctrlKey: true }],
    ["Delete", { shiftKey: true }],
    ["Backspace", { ctrlKey: true }],
    ["Backspace", { shiftKey: true }],
    ["Backspace", { altKey: true }],
  ];
  for (const [key, init] of MODIFIED) {
    const mods = Object.keys(init).map((m) => m.replace("Key", "")).join("+");
    it(`${mods}+${key} opens no clearing edit`, async () => {
      await mount();
      const prevented = await press(key, init);
      expect(startEditingProbe, `${mods}+${key} opened the clearing edit`).not.toHaveBeenCalled();
      expect(prevented).toBe(false);
      expect(api.updateCell).not.toHaveBeenCalled();
      expect(editorOpen).toBe(false);
    });
  }
});
