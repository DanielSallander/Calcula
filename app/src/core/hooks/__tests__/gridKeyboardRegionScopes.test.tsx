//! FILENAME: app/src/core/hooks/__tests__/gridKeyboardRegionScopes.test.tsx
// PURPOSE: Ctrl+A, Ctrl+Shift+Space, Ctrl+Space and Shift+Space must narrow to
//          the region under the cursor before they take the whole sheet.
// CONTEXT: All four selected the whole sheet, always. That is a SILENT WRONG
//          ANSWER, not an error: the user pressed Ctrl+Space inside a table and
//          got a selection — just a selection a thousand times too big, with no
//          message and nothing in the console to say the table had been ignored.
//          Ctrl+Shift+Space was a second, character-for-character copy of the
//          flat select-all, so the two gestures could not even disagree
//          visibly; they were both wrong the same way.
//
//          The oracle is the region's own declaration. `Sales` sits at A5:C10
//          with a header row and a totals row, so its data is A6:C9 — every
//          assertion below is a block the region asked for, and the pre-fix
//          code answers "the whole sheet" to all of them.
//
//          Core learns none of that. It reads `selectionScope` off the generic
//          region-metadata bag; the Table extension computes what is in it.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// --- The backend calls the navigation path makes ----------------------------

vi.mock("../../lib/tauri-api", () => ({
  getMergeInfo: vi.fn(async () => null), // no merges in this fixture
  findCtrlArrowTarget: vi.fn(async () => [0, 0] as [number, number]),
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 9, endCol: 9 })),
}));

vi.mock("../../../api/cellTypes", () => ({
  handleCellTypeKeyDown: vi.fn(async () => false),
}));

vi.mock("../../../utils/component-logger", () => {
  const noop = () => {};
  return {
    fnLog: { enter: noop, exit: noop },
    stateLog: { action: noop },
    eventLog: { keyboard: noop },
  };
});

/** What the extensions have published to the grid this test. */
interface FakeRegion {
  id: string;
  type: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  data?: Record<string, unknown>;
  floating?: { x: number; y: number; width: number; height: number };
}

let regions: FakeRegion[] = [];

vi.mock("../../../api/gridOverlays", () => ({
  getGridRegions: () => regions,
}));

import { useGridKeyboard, setExtendMode, setEndMode } from "../useGridKeyboard";
import { GridProvider, useGridContext } from "../../state/GridContext";
import { getInitialState } from "../../state/gridReducer";
import { setSelection } from "../../state/gridActions";
import type { GridState, Selection } from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// ---------------------------------------------------------------------------
// The fixture: "Sales" at A5:C10, header row + totals row, data A6:C9
// ---------------------------------------------------------------------------

const SALES_REGION: FakeRegion = {
  id: "table-1",
  type: "table",
  startRow: 4,
  startCol: 0,
  endRow: 9,
  endCol: 2,
  data: {
    name: "Sales",
    selectionScope: {
      columnSteps: [
        { startRow: 5, endRow: 8 },
        { startRow: 4, endRow: 9 },
      ],
      rowSteps: [{ startCol: 0, endCol: 2 }],
      allSteps: [
        { startRow: 5, startCol: 0, endRow: 8, endCol: 2 },
        { startRow: 4, startCol: 0, endRow: 9, endCol: 2 },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Harness — same shape as gridKeyboardEndUsedRange.test.tsx
// ---------------------------------------------------------------------------

let observedSelection: Selection | null = null;
let containerEl: HTMLDivElement;
let selectedColumns: number[] = [];
let selectedRows: number[] = [];

/** Where the cursor starts. B7 is a data cell of Sales. */
let seedCell = { row: 6, col: 1 };

/** The grid's dispatch, so a test can move the selection the way a click does. */
let harnessDispatch: ReturnType<typeof useGridContext>["dispatch"] | null = null;

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const ref = React.useRef<HTMLDivElement | null>(null);
  observedSelection = state.selection;
  harnessDispatch = dispatch;

  useGridKeyboard({
    containerRef: ref,
    enabled: true,
    isEditing: false,
    // The real callbacks select the whole sheet column/row. Recording them is
    // how the "and now the SHEET column" assertions tell the widest step from
    // a gesture that simply did nothing.
    onSelectColumn: (col: number) => {
      selectedColumns.push(col);
      dispatch(
        setSelection({
          startRow: 0,
          startCol: col,
          endRow: state.config.totalRows - 1,
          endCol: col,
          type: "columns",
        }),
      );
    },
    onSelectRow: (row: number) => {
      selectedRows.push(row);
      dispatch(
        setSelection({
          startRow: row,
          startCol: 0,
          endRow: row,
          endCol: state.config.totalCols - 1,
          type: "rows",
        }),
      );
    },
  });

  React.useEffect(() => {
    dispatch(
      setSelection({
        startRow: seedCell.row,
        startCol: seedCell.col,
        endRow: seedCell.row,
        endCol: seedCell.col,
        type: "cells",
      }),
    );
  }, [dispatch]);

  return <div ref={ref} data-testid="grid" tabIndex={0} />;
}

let root: Root;

async function mount(): Promise<void> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const initial: GridState = getInitialState();
  await act(async () => {
    root.render(
      <GridProvider initialState={initial}>
        <Harness />
      </GridProvider>,
    );
  });
  containerEl = host.querySelector("[data-testid='grid']") as HTMLDivElement;
}

function press(
  key: string,
  mods: { ctrl?: boolean; shift?: boolean } = {},
): void {
  act(() => {
    containerEl.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        ctrlKey: mods.ctrl ?? false,
        shiftKey: mods.shift ?? false,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

/** Put the cursor on one cell, the way a click does. */
function clickCell(row: number, col: number): void {
  act(() => {
    harnessDispatch?.(
      setSelection({ startRow: row, startCol: col, endRow: row, endCol: col, type: "cells" }),
    );
  });
}

/** The selected block, normalised, as "r1c1:r2c2". */
function blockOf(sel: Selection | null): string {
  if (!sel) return "none";
  const startRow = Math.min(sel.startRow, sel.endRow);
  const endRow = Math.max(sel.startRow, sel.endRow);
  const startCol = Math.min(sel.startCol, sel.endCol);
  const endCol = Math.max(sel.startCol, sel.endCol);
  return `r${startRow}c${startCol}:r${endRow}c${endCol}`;
}

const TOTAL_ROWS = getInitialState().config.totalRows;
const TOTAL_COLS = getInitialState().config.totalCols;
/** The answer the pre-fix code gave to all four gestures. */
const WHOLE_SHEET = `r0c0:r${TOTAL_ROWS - 1}c${TOTAL_COLS - 1}`;
const SALES_DATA = "r5c0:r8c2";
const SALES_WHOLE = "r4c0:r9c2";

beforeEach(() => {
  regions = [SALES_REGION];
  selectedColumns = [];
  selectedRows = [];
  seedCell = { row: 6, col: 1 };
  observedSelection = null;
  // Module state: an armed mode here arms it for the next test too.
  setExtendMode(false);
  setEndMode(false);
});

// ---------------------------------------------------------------------------

describe("Ctrl+A narrows to the region before it takes the sheet", () => {
  it("selects the table's DATA on the first press", async () => {
    await mount();
    press("a", { ctrl: true });

    expect(blockOf(observedSelection)).toBe(SALES_DATA);
    expect(blockOf(observedSelection)).not.toBe(WHOLE_SHEET);
  });

  it("widens to the WHOLE table on the second press", async () => {
    await mount();
    press("a", { ctrl: true });
    press("a", { ctrl: true });

    expect(blockOf(observedSelection)).toBe(SALES_WHOLE);
  });

  it("takes the whole sheet on the third press", async () => {
    await mount();
    press("a", { ctrl: true });
    press("a", { ctrl: true });
    press("a", { ctrl: true });

    expect(blockOf(observedSelection)).toBe(WHOLE_SHEET);
  });

  it("stays on the whole sheet — a fourth press does not snap back to the table", async () => {
    await mount();
    press("a", { ctrl: true });
    press("a", { ctrl: true });
    press("a", { ctrl: true });
    press("a", { ctrl: true });

    expect(blockOf(observedSelection)).toBe(WHOLE_SHEET);
  });

  it("selects the whole sheet at once when the cursor is outside every region", async () => {
    seedCell = { row: 40, col: 5 };
    await mount();
    press("a", { ctrl: true });

    expect(blockOf(observedSelection)).toBe(WHOLE_SHEET);
  });

  it("restarts at the table's data after a click puts the cursor back on a cell", async () => {
    await mount();
    press("a", { ctrl: true });
    press("a", { ctrl: true });
    press("a", { ctrl: true });
    expect(blockOf(observedSelection)).toBe(WHOLE_SHEET);

    // A click ends the progression. The step is derived from what is SELECTED,
    // never from a press counter — a counter would have to be reset from every
    // other gesture in the hook, and the one that was forgotten would be a
    // shortcut that silently did nothing.
    clickCell(7, 1);
    press("a", { ctrl: true });

    expect(blockOf(observedSelection)).toBe(SALES_DATA);
  });

  it("skips the step already selected instead of spending a keypress on it", async () => {
    await mount();
    // The table's data body, selected by something other than this gesture.
    act(() => {
      harnessDispatch?.(
        setSelection({ startRow: 5, startCol: 0, endRow: 8, endCol: 2, type: "cells" }),
      );
    });

    press("a", { ctrl: true });

    expect(blockOf(observedSelection)).toBe(SALES_WHOLE);
  });
});

describe("Ctrl+Shift+Space is the same command as Ctrl+A, not a second select-all", () => {
  it("selects the table's data on the first press", async () => {
    await mount();
    press(" ", { ctrl: true, shift: true });

    expect(blockOf(observedSelection)).toBe(SALES_DATA);
  });

  it("continues a progression Ctrl+A started, because they are one gesture", async () => {
    await mount();
    press("a", { ctrl: true });
    press(" ", { ctrl: true, shift: true });

    expect(blockOf(observedSelection)).toBe(SALES_WHOLE);
  });
});

describe("Ctrl+Space selects the table column before the sheet column", () => {
  it("selects the column's DATA rows on the first press", async () => {
    await mount();
    press(" ", { ctrl: true });

    expect(blockOf(observedSelection)).toBe("r5c1:r8c1");
    expect(selectedColumns).toEqual([]);
  });

  it("widens to the whole table column on the second press", async () => {
    await mount();
    press(" ", { ctrl: true });
    press(" ", { ctrl: true });

    expect(blockOf(observedSelection)).toBe("r4c1:r9c1");
  });

  it("takes the sheet column on the third press", async () => {
    await mount();
    press(" ", { ctrl: true });
    press(" ", { ctrl: true });
    press(" ", { ctrl: true });

    expect(selectedColumns).toEqual([1]);
    expect(blockOf(observedSelection)).toBe(`r0c1:r${TOTAL_ROWS - 1}c1`);
  });

  it("stays on the sheet column — a fourth press does not snap back to the table", async () => {
    // Terminality is not a rule in the hook; it falls out of the sheet-wide
    // selection parking the active cell on the sheet's last row, where no table
    // claims it. Nothing SAYS that, so it is asserted here.
    await mount();
    press(" ", { ctrl: true });
    press(" ", { ctrl: true });
    press(" ", { ctrl: true });
    press(" ", { ctrl: true });

    expect(blockOf(observedSelection)).toBe(`r0c1:r${TOTAL_ROWS - 1}c1`);
  });

  it("selects the sheet column at once outside a region, as it always did", async () => {
    seedCell = { row: 40, col: 5 };
    await mount();
    press(" ", { ctrl: true });

    expect(selectedColumns).toEqual([5]);
  });

  it("scopes to the column the cursor is in, not to the table's first column", async () => {
    seedCell = { row: 7, col: 2 };
    await mount();
    press(" ", { ctrl: true });

    expect(blockOf(observedSelection)).toBe("r5c2:r8c2");
  });

  it("works from the HEADER row, where the column's data still starts below it", async () => {
    seedCell = { row: 4, col: 0 };
    await mount();
    press(" ", { ctrl: true });

    expect(blockOf(observedSelection)).toBe("r5c0:r8c0");
  });
});

describe("Shift+Space selects the table row before the sheet row", () => {
  it("selects the table's row on the first press", async () => {
    await mount();
    press(" ", { shift: true });

    expect(blockOf(observedSelection)).toBe("r6c0:r6c2");
    expect(selectedRows).toEqual([]);
  });

  it("takes the sheet row on the second press", async () => {
    await mount();
    press(" ", { shift: true });
    press(" ", { shift: true });

    expect(selectedRows).toEqual([6]);
    expect(blockOf(observedSelection)).toBe(`r6c0:r6c${TOTAL_COLS - 1}`);
  });

  it("stays on the sheet row — a third press does not snap back to the table", async () => {
    await mount();
    press(" ", { shift: true });
    press(" ", { shift: true });
    press(" ", { shift: true });

    expect(blockOf(observedSelection)).toBe(`r6c0:r6c${TOTAL_COLS - 1}`);
  });

  it("selects the sheet row at once outside a region, as it always did", async () => {
    seedCell = { row: 40, col: 5 };
    await mount();
    press(" ", { shift: true });

    expect(selectedRows).toEqual([40]);
  });
});

describe("a region that declares nothing usable falls back to the sheet", () => {
  it("ignores a region with no selectionScope at all", async () => {
    regions = [{ ...SALES_REGION, data: { name: "Sales" } }];
    await mount();
    press("a", { ctrl: true });

    expect(blockOf(observedSelection)).toBe(WHOLE_SHEET);
  });

  it("ignores steps that are not whole, non-negative, correctly ordered blocks", async () => {
    // This data crosses an extension boundary. An inverted or half-written step
    // must degrade to the old behaviour, never to a selection nobody asked for.
    regions = [
      {
        ...SALES_REGION,
        data: {
          selectionScope: {
            allSteps: [
              { startRow: 8, startCol: 0, endRow: 5, endCol: 2 }, // inverted
              { startRow: -1, startCol: 0, endRow: 8, endCol: 2 }, // off-grid
              { startRow: 5, startCol: 0, endRow: 8 }, // missing endCol
            ],
          },
        },
      },
    ];
    await mount();
    press("a", { ctrl: true });

    expect(blockOf(observedSelection)).toBe(WHOLE_SHEET);
  });

  it("ignores a FLOATING region, which owns no cells at all", async () => {
    regions = [
      { ...SALES_REGION, floating: { x: 0, y: 0, width: 100, height: 100 } },
    ];
    await mount();
    press("a", { ctrl: true });

    expect(blockOf(observedSelection)).toBe(WHOLE_SHEET);
  });

  it("ignores a region that does not contain the active cell", async () => {
    seedCell = { row: 30, col: 1 };
    await mount();
    press(" ", { ctrl: true });

    expect(selectedColumns).toEqual([1]);
  });
});
