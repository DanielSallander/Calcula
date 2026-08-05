//! FILENAME: app/src/core/state/__tests__/hiddenComposition.test.ts
// PURPOSE: The three hidden SOURCES must stay independent, and the effective
//          union must be derived from all three every time.
// CONTEXT: effectiveHidden(index) = userHidden OR filterHidden OR outlineHidden.
//          Each failure pinned here was a live bug: SET_HIDDEN_COLS replaced the
//          whole set (resurrecting hand-hidden columns), SET_HIDDEN_ROWS omitted
//          the outline source (un-collapsing groups on a filter recompute), the
//          user/group cases reconstructed "filter-hidden" by subtraction (so a
//          row that was both filter- and hand-hidden lost its filter
//          attribution), and SET_ALL_DIMENSIONS destroyed all six sets on every
//          sheet switch and structural undo.

import { describe, it, expect } from "vitest";
import { gridReducer, getInitialState, composeHidden } from "../gridReducer";
import {
  setHiddenRows,
  setHiddenCols,
  setManuallyHiddenRows,
  setManuallyHiddenCols,
  setGroupHiddenRows,
  setGroupHiddenCols,
  setAllDimensions,
} from "../gridActions";
import type { GridState } from "../../types";

function createState(): GridState {
  const state = getInitialState();
  state.viewportDimensions = { width: 1000, height: 600 };
  return state;
}

const rows = (s: GridState) => Array.from(s.dimensions.hiddenRows ?? []).sort((a, b) => a - b);
const cols = (s: GridState) => Array.from(s.dimensions.hiddenCols ?? []).sort((a, b) => a - b);

describe("composeHidden", () => {
  it("unions any number of sources and tolerates undefined ones", () => {
    expect(Array.from(composeHidden(new Set([1, 2]), undefined, new Set([2, 9])))).toEqual([1, 2, 9]);
    expect(composeHidden().size).toBe(0);
  });
});

describe("effective hidden = user OR filter OR outline", () => {
  it("rows: all three sources contribute to the union", () => {
    let state = createState();
    state = gridReducer(state, setHiddenRows([1]));
    state = gridReducer(state, setManuallyHiddenRows([5]));
    state = gridReducer(state, setGroupHiddenRows([10, 11]));

    expect(rows(state)).toEqual([1, 5, 10, 11]);
  });

  it("cols: user and outline sources both contribute", () => {
    let state = createState();
    state = gridReducer(state, setGroupHiddenCols([2, 3]));
    state = gridReducer(state, setManuallyHiddenCols([7]));

    expect(cols(state)).toEqual([2, 3, 7]);
  });

  it("a filter recompute does NOT un-collapse an outline group", () => {
    let state = createState();
    state = gridReducer(state, setGroupHiddenRows([10]));
    state = gridReducer(state, setHiddenRows([1, 2]));

    expect(rows(state)).toEqual([1, 2, 10]);
  });

  it("CLEARING a filter leaves a hand-hidden row hidden", () => {
    let state = createState();
    state = gridReducer(state, setHiddenRows([1, 2, 3]));
    state = gridReducer(state, setManuallyHiddenRows([5]));

    state = gridReducer(state, setHiddenRows([])); // filter cleared

    expect(rows(state)).toEqual([5]);
    expect(state.dimensions.manuallyHiddenRows!.has(5)).toBe(true);
  });

  it("UNHIDING by hand does not resurrect a filter-hidden row", () => {
    let state = createState();
    // Row 5 is hidden by BOTH the filter and the user's hand.
    state = gridReducer(state, setHiddenRows([5]));
    state = gridReducer(state, setManuallyHiddenRows([5]));
    expect(rows(state)).toEqual([5]);

    // The user unhides 1:10 — the backend drops 5 from the USER set only.
    state = gridReducer(state, setManuallyHiddenRows([]));

    // The filter still hides it. (Reconstructing "filter-hidden" by subtraction
    // attributed row 5 to the user alone and made it reappear.)
    expect(rows(state)).toEqual([5]);
  });

  it("expanding an outline group does not clear a user hide", () => {
    let state = createState();
    state = gridReducer(state, setManuallyHiddenRows([5]));
    state = gridReducer(state, setGroupHiddenRows([5, 6, 7]));
    expect(rows(state)).toEqual([5, 6, 7]);

    state = gridReducer(state, setGroupHiddenRows([])); // group expanded

    expect(rows(state)).toEqual([5]);
  });

  it("SET_HIDDEN_COLS unions instead of replacing — a hand-hidden column survives", () => {
    let state = createState();
    state = gridReducer(state, setManuallyHiddenCols([3]));
    state = gridReducer(state, setGroupHiddenCols([8]));

    // A view-bookmark restore dispatches setHiddenCols; it used to overwrite
    // hiddenCols outright, silently unhiding column 3 AND putting the frontend
    // out of sync with the backend's user-hidden authority.
    state = gridReducer(state, setHiddenCols([1]));

    expect(cols(state)).toEqual([1, 3, 8]);
    expect(state.dimensions.manuallyHiddenCols!.has(3)).toBe(true);
  });
});

describe("SET_ALL_DIMENSIONS is non-destructive", () => {
  it("keeps every hidden source when sizes are refreshed from the backend", () => {
    let state = createState();
    state = gridReducer(state, setHiddenRows([1]));
    state = gridReducer(state, setManuallyHiddenRows([5]));
    state = gridReducer(state, setGroupHiddenRows([10]));
    state = gridReducer(state, setManuallyHiddenCols([2]));
    state = gridReducer(state, setGroupHiddenCols([4]));

    // Fires on every sheet switch and every structural undo/redo. Replacing the
    // whole dimensions object here is what gave a hide a lifetime of "until you
    // click another sheet tab".
    state = gridReducer(
      state,
      setAllDimensions(new Map([[0, 120]]), new Map([[0, 30]]))
    );

    expect(state.dimensions.columnWidths.get(0)).toBe(120);
    expect(state.dimensions.rowHeights.get(0)).toBe(30);
    expect(rows(state)).toEqual([1, 5, 10]);
    expect(cols(state)).toEqual([2, 4]);
    expect(state.dimensions.manuallyHiddenRows!.has(5)).toBe(true);
    expect(state.dimensions.groupHiddenRows!.has(10)).toBe(true);
    expect(state.dimensions.filterHiddenRows!.has(1)).toBe(true);
  });
});

describe("per-sheet mirror", () => {
  it("a sheet switch REPLACES the user set with the new sheet's, and back", () => {
    // The backend owns one user-hidden set per sheet and swaps the active one;
    // the frontend mirror is just the last refreshUserHidden() result. Sheet1
    // hides row 4 by hand and has a filter hiding row 1.
    let state = createState();
    state = gridReducer(state, setHiddenRows([1]));
    state = gridReducer(state, setManuallyHiddenRows([4]));
    expect(rows(state)).toEqual([1, 4]);

    // Switch to Sheet2: dimensions refresh, then the mirror is re-read (empty).
    state = gridReducer(state, setAllDimensions(new Map(), new Map()));
    state = gridReducer(state, setManuallyHiddenRows([]));
    state = gridReducer(state, setHiddenRows([]));
    expect(rows(state)).toEqual([]);

    // Switch back to Sheet1: the authority still has row 4.
    state = gridReducer(state, setAllDimensions(new Map(), new Map()));
    state = gridReducer(state, setManuallyHiddenRows([4]));
    expect(rows(state)).toEqual([4]);
  });
});
