//! FILENAME: app/extensions/FloatingRange/__tests__/frHomeDoorsWiring.test.ts
// PURPOSE: The REAL floating-grid owner (lib/frKeyRouting.ts `actsOn` +
//          lib/frCellTarget.ts) opens the Home doors that were migrated with
//          owner DOUBLES (P3 S9-S11), end to end in the unit tier: the owner
//          finding G3 case -- Home > Decrease Decimal with a floating grid's
//          cell selected -- writes the GRID's cell through its target, and
//          announces no refusal. The doors' own tests use doubles; this is the
//          one place the real owner meets a real door, so dropping a
//          capability from `FR_ACTS_ON` turns the door back into a refusal
//          HERE (the spec's "actsOn without numberFormat" sabotage).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FloatingRangeInfo } from "@api/floatingRanges";

vi.mock("@api/floatingRanges", () => ({
  FLOATING_RANGE_MAX_ROWS: 1000,
  FLOATING_RANGE_MAX_COLS: 256,
  listFloatingRanges: vi.fn(async () => []),
  updateFloatingRange: vi.fn(async () => ({})),
  getFloatingRangeCells: vi.fn(async () => []),
}));

const lib = vi.hoisted(() => ({
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true })),
  adjustNumberFormatDecimals: vi.fn(async (..._args: unknown[]) => ({
    cells: [{ row: 0, col: 1, display: "1234.6", formula: null, styleIndex: 3 }],
    styles: [{ index: 3, style: { numberFormat: "0.0" } }],
  })),
  applyFormatting: vi.fn(async (..._args: unknown[]) => ({ cells: [], styles: [] })),
  beginUndoTransaction: vi.fn(async () => 1),
  commitUndoTransaction: vi.fn(async () => undefined),
  cancelUndoTransaction: vi.fn(async () => undefined),
}));
vi.mock("@api/lib", () => lib);

vi.mock("@api/cellEvents", () => ({ cellEvents: { emit: vi.fn() } }));
vi.mock("@api/grid", () => ({ getGridStateSnapshot: () => null }));

import { registerToastSink, type ToastPayload } from "@api/notifications";
import { stepNumberFormatDecimals } from "../../BuiltIn/HomeTab/components/alignment/numberGroupCommands";
import { installFrKeyRouting, frSelectionRefusal } from "../lib/frKeyRouting";
import { resetFloatingRangeStore, setFrActiveSheetIndex, upsertFromInfo } from "../lib/floatingRangeStore";
import { clearLocalSelection, deselectAllFloatingRanges, setLocalSelection } from "../lib/frSelection";

const FR_ID = "fr-home";

const INFO = {
  id: FR_ID,
  backingSheetId: "backing",
  hostSheetId: "host",
  x: 0,
  y: 0,
  rotation: 0,
  pinToGrid: false,
  rowCount: 5,
  colCount: 4,
  colWidths: {},
  rowHeights: {},
  hiddenRows: [],
  hiddenCols: [],
  showTitle: true,
  showColumnHeaders: true,
  showRowHeaders: true,
  name: "Float1",
  backingSheetIndex: 1,
  hostSheetIndex: 0,
} as FloatingRangeInfo;

let toasts: ToastPayload[] = [];
let uninstall: () => void = () => {};

beforeEach(() => {
  toasts = [];
  registerToastSink((t) => toasts.push(t));
  lib.adjustNumberFormatDecimals.mockClear();
  resetFloatingRangeStore();
  upsertFromInfo(INFO);
  setFrActiveSheetIndex(0);
  uninstall = installFrKeyRouting({ extensionId: "test", deleteSelection: () => {} });
});

afterEach(() => {
  uninstall();
  clearLocalSelection();
  deselectAllFloatingRanges();
  resetFloatingRangeStore();
});

describe("owner finding G3: Home > Decrease Decimal on a floating grid's cell", () => {
  it("writes the GRID's cell through its target -- no refusal, never Core's hidden cell", async () => {
    // Float1!B1 selected (Core's own selection sits hidden on the sheet).
    setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 1, endRow: 0, endCol: 1 });
    const answered = await stepNumberFormatDecimals(-1, "Decrease Decimal");
    expect(answered).toBe(true);
    expect(toasts.map((t) => t.message)).toEqual([]);
    expect(lib.adjustNumberFormatDecimals).toHaveBeenCalledTimes(1);
    expect(lib.adjustNumberFormatDecimals).toHaveBeenCalledWith([0], [1], -1, {
      target: { kind: "floatingRange", id: FR_ID },
    });
  });

  it("control: a capability the grid does not admit still refuses with the grid's sentence", () => {
    expect(frSelectionRefusal("Decrease Decimal")).toBe(
      "Decrease Decimal is not available inside a floating grid yet. Nothing was changed.",
    );
  });
});
