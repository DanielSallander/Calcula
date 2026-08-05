//! FILENAME: app/src/core/lib/__tests__/hiddenRowsCols.test.ts
// PURPOSE: The user hide/unhide gesture must reach the BACKEND authority.
// CONTEXT: Hiding a row used to be frontend-only session state — a reducer
//          dispatch and nothing else — so the hide never reached the file, was
//          not undoable, and did not even mark the document dirty. These tests
//          pin the gesture to the backend so it cannot regress.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../tauri-api", () => ({
  setRowsHidden: vi.fn(),
  setColsHidden: vi.fn(),
  getUserHiddenRows: vi.fn(),
  getUserHiddenCols: vi.fn(),
}));

import {
  applyRowsHidden,
  applyColsHidden,
  refreshUserHidden,
  indexRange,
} from "../hiddenRowsCols";
import {
  setRowsHidden,
  setColsHidden,
  getUserHiddenRows,
  getUserHiddenCols,
} from "../tauri-api";
import { GRID_ACTIONS } from "../../state/gridActions";
import { AppEvents } from "../events";

const mockSetRowsHidden = vi.mocked(setRowsHidden);
const mockSetColsHidden = vi.mocked(setColsHidden);
const mockGetUserHiddenRows = vi.mocked(getUserHiddenRows);
const mockGetUserHiddenCols = vi.mocked(getUserHiddenCols);

let dispatched: { type: string; payload: unknown }[];
const dispatch = (action: unknown) => {
  dispatched.push(action as { type: string; payload: unknown });
};

let dirtyEvents: unknown[];
let dirtyListener: (event: Event) => void;

beforeEach(() => {
  dispatched = [];
  dirtyEvents = [];
  vi.clearAllMocks();
  mockGetUserHiddenRows.mockResolvedValue([]);
  mockGetUserHiddenCols.mockResolvedValue([]);
  // jsdom's alert() throws "not implemented"; the refusal path calls it.
  window.alert = vi.fn();
  dirtyListener = (event: Event) => {
    dirtyEvents.push((event as CustomEvent).detail);
  };
  window.addEventListener(AppEvents.DIRTY_STATE_CHANGED, dirtyListener);
});

afterEach(() => {
  window.removeEventListener(AppEvents.DIRTY_STATE_CHANGED, dirtyListener);
});

describe("indexRange", () => {
  it("expands an inclusive span, in either drag direction", () => {
    expect(indexRange(2, 5)).toEqual([2, 3, 4, 5]);
    expect(indexRange(5, 2)).toEqual([2, 3, 4, 5]);
    expect(indexRange(7, 7)).toEqual([7]);
  });
});

describe("applyRowsHidden", () => {
  it("calls the BACKEND command — a hide is not frontend-only state", async () => {
    mockSetRowsHidden.mockResolvedValue([3, 4, 5]);

    const ok = await applyRowsHidden([3, 4, 5], true, dispatch);

    expect(ok).toBe(true);
    expect(mockSetRowsHidden).toHaveBeenCalledTimes(1);
    expect(mockSetRowsHidden).toHaveBeenCalledWith([3, 4, 5], true);
  });

  it("sends the whole range in ONE call (one IPC round-trip, one undo step)", async () => {
    mockSetRowsHidden.mockResolvedValue(indexRange(0, 499));

    await applyRowsHidden(indexRange(0, 499), true, dispatch);

    expect(mockSetRowsHidden).toHaveBeenCalledTimes(1);
    expect(mockSetRowsHidden.mock.calls[0][0]).toHaveLength(500);
  });

  it("mirrors the AUTHORITATIVE result, not the requested indices", async () => {
    // The backend returns the resulting set for the active sheet, which can
    // include rows hidden earlier and exclude rows a protection rule skipped.
    mockSetRowsHidden.mockResolvedValue([1, 3, 4, 5]);

    await applyRowsHidden([3, 4, 5], true, dispatch);

    expect(dispatched).toEqual([
      { type: GRID_ACTIONS.SET_MANUALLY_HIDDEN_ROWS, payload: { rows: [1, 3, 4, 5] } },
    ]);
  });

  it("marks the document DIRTY so the user is prompted to save", async () => {
    mockSetRowsHidden.mockResolvedValue([3]);

    await applyRowsHidden([3], true, dispatch);

    expect(dirtyEvents).toEqual([{ isDirty: true }]);
  });

  it("unhide passes hidden:false and mirrors the shrunken set", async () => {
    mockSetRowsHidden.mockResolvedValue([9]);

    await applyRowsHidden([3, 4, 5], false, dispatch);

    expect(mockSetRowsHidden).toHaveBeenCalledWith([3, 4, 5], false);
    expect(dispatched[0].payload).toEqual({ rows: [9] });
  });

  it("does not call the backend for an empty range", async () => {
    const ok = await applyRowsHidden([], true, dispatch);

    expect(ok).toBe(false);
    expect(mockSetRowsHidden).not.toHaveBeenCalled();
    expect(dispatched).toEqual([]);
    expect(dirtyEvents).toEqual([]);
  });

  it("on a REFUSAL (protected sheet) re-syncs the mirror and reports it", async () => {
    mockSetRowsHidden.mockRejectedValue(new Error("Sheet is protected: hide rows"));
    mockGetUserHiddenRows.mockResolvedValue([2]);
    mockGetUserHiddenCols.mockResolvedValue([6]);

    const ok = await applyRowsHidden([3], true, dispatch);

    expect(ok).toBe(false);
    // Mirror re-read from the authority — the two must never diverge silently.
    expect(dispatched).toEqual([
      { type: GRID_ACTIONS.SET_MANUALLY_HIDDEN_ROWS, payload: { rows: [2] } },
      { type: GRID_ACTIONS.SET_MANUALLY_HIDDEN_COLS, payload: { cols: [6] } },
    ]);
    expect(window.alert).toHaveBeenCalledWith("Sheet is protected: hide rows");
    // A refused hide changed nothing, so it must not claim the doc is dirty.
    expect(dirtyEvents).toEqual([]);
  });
});

describe("applyColsHidden", () => {
  it("calls the backend, mirrors the result and marks dirty", async () => {
    mockSetColsHidden.mockResolvedValue([2, 3]);

    const ok = await applyColsHidden([2, 3], true, dispatch);

    expect(ok).toBe(true);
    expect(mockSetColsHidden).toHaveBeenCalledWith([2, 3], true);
    expect(dispatched).toEqual([
      { type: GRID_ACTIONS.SET_MANUALLY_HIDDEN_COLS, payload: { cols: [2, 3] } },
    ]);
    expect(dirtyEvents).toEqual([{ isDirty: true }]);
  });

  it("on a refusal re-syncs and reports", async () => {
    mockSetColsHidden.mockRejectedValue("Sheet is protected: hide columns");
    mockGetUserHiddenCols.mockResolvedValue([4]);

    const ok = await applyColsHidden([2], true, dispatch);

    expect(ok).toBe(false);
    expect(window.alert).toHaveBeenCalledWith("Sheet is protected: hide columns");
    expect(dispatched.at(-1)).toEqual({
      type: GRID_ACTIONS.SET_MANUALLY_HIDDEN_COLS,
      payload: { cols: [4] },
    });
  });
});

describe("refreshUserHidden", () => {
  it("re-reads BOTH sets for the active sheet", async () => {
    mockGetUserHiddenRows.mockResolvedValue([1, 2]);
    mockGetUserHiddenCols.mockResolvedValue([7]);

    await refreshUserHidden(dispatch);

    expect(dispatched).toEqual([
      { type: GRID_ACTIONS.SET_MANUALLY_HIDDEN_ROWS, payload: { rows: [1, 2] } },
      { type: GRID_ACTIONS.SET_MANUALLY_HIDDEN_COLS, payload: { cols: [7] } },
    ]);
  });

  it("per-sheet: a second read returns the OTHER sheet's set, replacing the mirror", async () => {
    // The backend swaps user_hidden_rows with the active sheet, so switching
    // sheets is just a re-read. Sheet1 hides row 4; Sheet2 hides nothing.
    mockGetUserHiddenRows.mockResolvedValueOnce([4]);
    mockGetUserHiddenCols.mockResolvedValueOnce([]);
    await refreshUserHidden(dispatch);
    expect(dispatched[0].payload).toEqual({ rows: [4] });

    dispatched = [];
    mockGetUserHiddenRows.mockResolvedValueOnce([]);
    mockGetUserHiddenCols.mockResolvedValueOnce([]);
    await refreshUserHidden(dispatch);
    expect(dispatched[0].payload).toEqual({ rows: [] });

    // ...and switching back restores it, because the authority never lost it.
    dispatched = [];
    mockGetUserHiddenRows.mockResolvedValueOnce([4]);
    mockGetUserHiddenCols.mockResolvedValueOnce([]);
    await refreshUserHidden(dispatch);
    expect(dispatched[0].payload).toEqual({ rows: [4] });
  });

  it("swallows a read failure rather than leaving the grid half-updated", async () => {
    mockGetUserHiddenRows.mockRejectedValue(new Error("backend down"));

    await expect(refreshUserHidden(dispatch)).resolves.toBeUndefined();
    expect(dispatched).toEqual([]);
  });
});
