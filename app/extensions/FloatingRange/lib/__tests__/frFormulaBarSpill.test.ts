//! FILENAME: app/extensions/FloatingRange/lib/__tests__/frFormulaBarSpill.test.ts
// PURPOSE: A selected floating-grid cell that a formula SPILLS into shows the
//          anchor's formula GREYED and read-only in the formula bar, as a grid
//          cell does (wave C, W12 -- E3's remainder).
// CONTEXT: The grid's own formula bar learns a non-anchor spill cell from
//          `getSpillRanges`, which covers the ACTIVE sheet only; a floating
//          grid's backing sheet is never active, and its cell read carries no
//          spill data. So a spilled floating-grid cell showed its bare VALUE,
//          editable, as if it were a constant -- and an edit typed there turned
//          the anchor into #SPILL!. The extension now reads the backing sheet's
//          spills (@api/floatingRangeSpills) and publishes `spillGhost` with
//          the anchor's formula, `readOnly` true.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FloatingRangeInfo } from "@api/floatingRanges";

type Cell = { row: number; col: number; formula?: string | null; display?: string };
type Spill = { originRow: number; originCol: number; endRow: number; endCol: number };

const getFloatingRangeCells = vi.fn(async (..._args: unknown[]): Promise<Cell[]> => []);
vi.mock("@api/floatingRanges", () => ({
  FLOATING_RANGE_MAX_ROWS: 1000,
  FLOATING_RANGE_MAX_COLS: 256,
  listFloatingRanges: vi.fn(async () => []),
  updateFloatingRange: vi.fn(async () => ({})),
  updateFloatingRangeCell: vi.fn(async () => []),
  getFloatingRangeCells: (...args: unknown[]) => getFloatingRangeCells(...args),
}));

const getFloatingRangeSpillRanges = vi.fn(async (_id: string): Promise<Spill[]> => []);
vi.mock("@api/floatingRangeSpills", () => ({
  getFloatingRangeSpillRanges: (id: string) => getFloatingRangeSpillRanges(id),
}));

vi.mock("@api/lib", () => ({
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true })),
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showToast: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async () => null),
}));

import { getExternalCellTarget, formulaA1ToR1C1 } from "@api/externalEdit";
import { AppEvents, emitAppEvent } from "@api/events";
import { installFrFormulaBarPublisher, refreshFrFormulaBarContent } from "../frFormulaBar";
import {
  upsertFromInfo,
  resetFloatingRangeStore,
  setFrActiveSheetIndex,
  syncFloatingRangeRegions,
} from "../floatingRangeStore";
import { setLocalSelection, resetFrSelection } from "../frSelection";
import { cancelFrEditor, destroyFrEditor } from "../../editor/frEditor";

const FR_ID = "fr-spill";
const HOST = 2;

function info(): FloatingRangeInfo {
  return {
    id: FR_ID,
    backingSheetId: "backing",
    hostSheetId: "host",
    x: 0,
    y: 0,
    rotation: 0,
    pinToGrid: false,
    rowCount: 6,
    colCount: 3,
    colWidths: {},
    rowHeights: {},
    showTitle: true,
    showColumnHeaders: true,
    showRowHeaders: true,
    name: "Float1",
    backingSheetIndex: 3,
    hostSheetIndex: HOST,
  } as FloatingRangeInfo;
}

/** B2 holds =SEQUENCE(3), spilling into B2:B4; A1 is a constant. */
let contents: Record<string, Cell>;
let spills: Spill[];

function select(row: number, col: number): void {
  setLocalSelection({ frId: FR_ID, anchorRow: row, anchorCol: col, endRow: row, endCol: col });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

let uninstall: () => void;
let layer: HTMLElement;

beforeEach(() => {
  contents = {
    "0,0": { row: 0, col: 0, formula: null, display: "7" },
    "1,1": { row: 1, col: 1, formula: "=SEQUENCE(3)", display: "1" },
    "2,1": { row: 2, col: 1, formula: null, display: "2" },
    "3,1": { row: 3, col: 1, formula: null, display: "3" },
  };
  spills = [{ originRow: 1, originCol: 1, endRow: 3, endCol: 1 }];
  getFloatingRangeCells.mockReset();
  getFloatingRangeCells.mockImplementation(async (...args: unknown[]) => {
    const c = contents[`${args[1] as number},${args[2] as number}`];
    return c ? [c] : [];
  });
  getFloatingRangeSpillRanges.mockReset();
  getFloatingRangeSpillRanges.mockImplementation(async () => spills);
  resetFloatingRangeStore();
  resetFrSelection();
  layer = document.createElement("div");
  layer.setAttribute("data-grid-canvas-layer", "");
  document.body.appendChild(layer);
  upsertFromInfo(info());
  setFrActiveSheetIndex(HOST);
  syncFloatingRangeRegions();
  uninstall = installFrFormulaBarPublisher();
});

afterEach(() => {
  uninstall();
  cancelFrEditor();
  destroyFrEditor();
  layer.remove();
  resetFrSelection();
  resetFloatingRangeStore();
});

describe("a spilled floating-grid cell in the formula bar", () => {
  it("a non-anchor spill cell shows the ANCHOR's formula, greyed and read-only", async () => {
    select(2, 1);
    await flush();
    expect(getExternalCellTarget()).toMatchObject({
      address: "Float1!B3",
      content: "=SEQUENCE(3)",
      readOnly: true,
      spillGhost: true,
    });
    expect(getFloatingRangeSpillRanges).toHaveBeenCalledWith(FR_ID);
  });

  it("the ANCHOR itself is an ordinary, editable formula cell", async () => {
    select(1, 1);
    await flush();
    const target = getExternalCellTarget();
    expect(target).toMatchObject({ address: "Float1!B2", content: "=SEQUENCE(3)", readOnly: false });
    expect(target?.spillGhost ?? false).toBe(false);
  });

  it("a constant outside every spill is not a ghost", async () => {
    select(0, 0);
    await flush();
    const target = getExternalCellTarget();
    expect(target).toMatchObject({ address: "Float1!A1", content: "7", readOnly: false });
    expect(target?.spillGhost ?? false).toBe(false);
  });

  it("a refresh re-reads the spills: a cell the spill no longer covers stops being a ghost", async () => {
    select(3, 1);
    await flush();
    expect(getExternalCellTarget()).toMatchObject({ content: "=SEQUENCE(3)", spillGhost: true });
    // The anchor is edited to =SEQUENCE(2): B4 is now empty and no spill covers it.
    contents["1,1"] = { row: 1, col: 1, formula: "=SEQUENCE(2)", display: "1" };
    delete contents["3,1"];
    spills = [{ originRow: 1, originCol: 1, endRow: 2, endCol: 1 }];
    refreshFrFormulaBarContent();
    await flush();
    const target = getExternalCellTarget();
    expect(target).toMatchObject({ address: "Float1!B4", content: "", readOnly: false });
    expect(target?.spillGhost ?? false).toBe(false);
  });
});

// Review C: in R1C1 a ghost shows its ANCHOR's formula relative to the ANCHOR
// -- the cell whose formula it is -- exactly as the grid's own ghost does
// (FormulaInput.tsx). Measured from the selected cell instead, every relative
// reference in the greyed text would name the wrong cells, silently.
describe("a spilled floating-grid cell in the R1C1 reference style", () => {
  afterEach(() => {
    emitAppEvent(AppEvents.REFERENCE_STYLE_CHANGED, { referenceStyle: "A1" });
  });

  it("the ghost's R1C1 text is relative to its anchor, not to the selected cell", async () => {
    // B2 holds =A1:A3*2, spilling into B2:B4; B4 is selected.
    contents["1,1"] = { row: 1, col: 1, formula: "=A1:A3*2", display: "2" };
    emitAppEvent(AppEvents.REFERENCE_STYLE_CHANGED, { referenceStyle: "R1C1" });
    select(3, 1);
    await flush();
    const fromAnchor = formulaA1ToR1C1("=A1:A3*2", 1, 1);
    const fromCell = formulaA1ToR1C1("=A1:A3*2", 3, 1);
    expect(fromAnchor).not.toBe(fromCell); // fixture: the two readings differ
    expect(fromAnchor).toBe("=R[-1]C[-1]:R[1]C[-1]*2");
    expect(getExternalCellTarget()).toMatchObject({
      address: "Float1!B4",
      content: fromAnchor,
      readOnly: true,
      spillGhost: true,
    });
  });
});
