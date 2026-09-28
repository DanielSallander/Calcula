//! FILENAME: app/extensions/FloatingRange/lib/__tests__/frSelection.test.ts
// PURPOSE: The FR-local cell selection ANNOUNCES every change
//          (`onLocalSelectionChanged`) -- and only real changes.
// CONTEXT: Owner finding #10 (2026-09-27): the formula bar and the Name Box
//          show a floating range's active cell, so they must hear the
//          selection move. It used to be module state that nobody heard, and
//          two doors changed it IN PLACE (the arrow move, and the drag-extend
//          in index.ts), which no listener could have seen even with one. A
//          silent identical re-set matters as much: the publisher re-reads a
//          cell per notification.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  onLocalSelectionChanged,
  setLocalSelection,
  getLocalSelection,
  clearLocalSelection,
  moveLocalSelection,
  extendLocalSelection,
  resetFrSelection,
  selectFloatingRange,
  type FrLocalSelection,
} from "../frSelection";

const A1: FrLocalSelection = { frId: "fr-1", anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 };

let heard: ReturnType<typeof vi.fn>;
let off: () => void;

beforeEach(() => {
  resetFrSelection();
  heard = vi.fn();
  off = onLocalSelectionChanged(heard);
});

afterEach(() => {
  off();
  resetFrSelection();
});

describe("local selection notifications", () => {
  it("set: announces a change, stays silent for an identical re-set", () => {
    setLocalSelection(A1);
    expect(heard).toHaveBeenCalledTimes(1);
    setLocalSelection({ ...A1 });
    expect(heard).toHaveBeenCalledTimes(1);
    setLocalSelection({ ...A1, endCol: 2 });
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("stores a COPY: mutating the caller's object afterwards changes nothing", () => {
    const mine = { ...A1 };
    setLocalSelection(mine);
    mine.endRow = 9;
    expect(getLocalSelection()?.endRow).toBe(0);
  });

  it("clear: announces only when there was a selection", () => {
    clearLocalSelection();
    expect(heard).not.toHaveBeenCalled();
    setLocalSelection(A1);
    clearLocalSelection();
    expect(heard).toHaveBeenCalledTimes(2);
    expect(getLocalSelection()).toBeNull();
  });

  it("move: announces a move that moved, with a NEW object; silent against the edge", () => {
    setLocalSelection(A1);
    const before = getLocalSelection();
    heard.mockClear();
    moveLocalSelection(1, 0, false, 4, 3);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(getLocalSelection()).toEqual({ ...A1, anchorRow: 1, endRow: 1 });
    // The held snapshot is untouched: the move replaced the object.
    expect(before).toEqual(A1);
    heard.mockClear();
    moveLocalSelection(0, -1, false, 4, 3); // already at column 0
    expect(heard).not.toHaveBeenCalled();
  });

  it("move with extend: announces, anchor kept", () => {
    setLocalSelection(A1);
    heard.mockClear();
    moveLocalSelection(1, 1, true, 4, 3);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(getLocalSelection()).toEqual({ ...A1, endRow: 1, endCol: 1 });
  });

  it("extend: sets the moving end and announces; an unchanged end is silent", () => {
    setLocalSelection(A1);
    heard.mockClear();
    extendLocalSelection(2, 1);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(getLocalSelection()).toEqual({ ...A1, endRow: 2, endCol: 1 });
    extendLocalSelection(2, 1);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("extend without a selection does nothing", () => {
    extendLocalSelection(2, 1);
    expect(heard).not.toHaveBeenCalled();
    expect(getLocalSelection()).toBeNull();
  });

  it("reset: announces only when a local selection was dropped", () => {
    selectFloatingRange("fr-1");
    resetFrSelection();
    expect(heard).not.toHaveBeenCalled();
    setLocalSelection(A1);
    heard.mockClear();
    resetFrSelection();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("a listener that throws does not stop the others", () => {
    const second = vi.fn();
    const offBad = onLocalSelectionChanged(() => {
      throw new Error("boom");
    });
    const offSecond = onLocalSelectionChanged(second);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      setLocalSelection(A1);
      expect(heard).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
      offBad();
      offSecond();
    }
  });
});
