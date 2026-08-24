//! FILENAME: app/extensions/Table/lib/tableRegionScope.test.ts
// PURPOSE: The table's grid region must CARRY its selection scope, and the
//          field names must match the ones Core reads.
// CONTEXT: This is the wire between "the Table extension knows where its data
//          rows are" and "Ctrl+Space selects them". It travels through
//          `GridRegion.data`, the generic extension-metadata bag, because there
//          is no typed @api seam for a selection scope yet — and an untyped bag
//          has no compiler to notice a renamed field. The failure mode is
//          silent by construction: Core would find no scope, fall back to the
//          whole sheet, and look exactly like the defect this replaced.
//
//          So the pairing is pinned the way this repo pins its other untyped
//          boundaries (`interpreterReachDrift.test.ts` reads a Rust file at test
//          time): the drift case below READS Core's hook as text. Reading a file
//          is not an import, so the Facade Rule is intact.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Doubles — the store's whole outside world
// ---------------------------------------------------------------------------

interface FakeRegion {
  id: string;
  type: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  data?: Record<string, unknown>;
}

let publishedRegions: FakeRegion[] = [];

vi.mock("@api/gridOverlays", () => ({
  removeGridRegionsByType: vi.fn(() => {
    publishedRegions = [];
  }),
  addGridRegions: vi.fn((regions: FakeRegion[]) => {
    publishedRegions = [...publishedRegions, ...regions];
  }),
}));

interface FakeTable {
  id: string;
  name: string;
  sheetIndex: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  columns: Array<{ name: string }>;
  styleOptions: { headerRow: boolean; totalRow: boolean };
}

let backendTables: FakeTable[] = [];

vi.mock("@api/backend", () => ({
  createTable: vi.fn(),
  deleteTable: vi.fn(),
  getTable: vi.fn(),
  getTableAtCell: vi.fn(),
  getAllTables: vi.fn(async () => backendTables),
  updateTableStyle: vi.fn(),
  toggleTotalsRow: vi.fn(),
  resizeTable: vi.fn(),
  renameTable: vi.fn(),
  convertToRange: vi.fn(),
  checkTableAutoExpand: vi.fn(),
  enforceTableHeader: vi.fn(),
  setCalculatedColumn: vi.fn(),
  convertFormulaToTableRefs: vi.fn(),
}));

vi.mock("@api", () => ({
  cellEvents: { emit: vi.fn() },
}));

vi.mock("@api/events", () => ({
  emitAppEvent: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/naming-convention
  AppEvents: { MUTATION_REFRESH: "app:mutation-refresh" },
}));

import { refreshCache, resetTableStore } from "./tableStore";
import { tableSelectionScope } from "./tableBands";

// ---------------------------------------------------------------------------

/** Sales at A5:C10, with a header row and a totals row. */
const SALES: FakeTable = {
  id: "t-1",
  name: "Sales",
  sheetIndex: 0,
  startRow: 4,
  startCol: 0,
  endRow: 9,
  endCol: 2,
  columns: [{ name: "Region" }, { name: "Units" }, { name: "Margin" }],
  styleOptions: { headerRow: true, totalRow: true },
};

beforeEach(() => {
  publishedRegions = [];
  backendTables = [];
  resetTableStore();
});

describe("the table's grid region carries its selection scope", () => {
  it("publishes the scope the Table extension computed, not a copy of it", async () => {
    backendTables = [SALES];
    await refreshCache();

    expect(publishedRegions).toHaveLength(1);
    expect(publishedRegions[0].data?.selectionScope).toEqual(tableSelectionScope(SALES));
  });

  it("publishes a scope whose blocks are the table's data and the whole table", async () => {
    backendTables = [SALES];
    await refreshCache();

    // Spelled out rather than compared to the helper, so a helper that started
    // answering nonsense could not make both assertions agree with each other.
    expect(publishedRegions[0].data?.selectionScope).toMatchObject({
      allSteps: [
        { startRow: 5, startCol: 0, endRow: 8, endCol: 2 },
        { startRow: 4, startCol: 0, endRow: 9, endCol: 2 },
      ],
      columnSteps: [
        { startRow: 5, endRow: 8 },
        { startRow: 4, endRow: 9 },
      ],
      rowSteps: [{ startCol: 0, endCol: 2 }],
    });
  });

  it("publishes one scope per table", async () => {
    backendTables = [
      SALES,
      { ...SALES, id: "t-2", name: "Costs", startRow: 20, endRow: 25 },
    ];
    await refreshCache();

    expect(publishedRegions).toHaveLength(2);
    for (const region of publishedRegions) {
      expect(region.data?.selectionScope).toBeDefined();
    }
  });
});

describe("the field names Core reads are the field names the table writes", () => {
  // Read, never imported: an extension may not import Core (Facade Rule), and
  // the point of the guard is the TEXT of the contract anyway.
  const coreHook = fs.readFileSync(
    path.resolve(__dirname, "../../../src/core/hooks/useGridKeyboard.ts"),
    "utf8",
  );

  /**
   * Whole-word, not substring. A plain `includes` passes for a field RENAMED by
   * suffix — "columnSteps" is inside "columnStepsRenamed" — which is precisely
   * the drift this guard exists to catch, and it is how this case was first
   * written and first found to be toothless.
   */
  function mentions(field: string): boolean {
    return new RegExp(`\\b${field}\\b`).test(coreHook);
  }

  it("Core still looks for `selectionScope` on the region's data", () => {
    expect(mentions("selectionScope")).toBe(true);
  });

  it("Core still reads every step list this module publishes", () => {
    const scope = tableSelectionScope(SALES) as Record<string, unknown>;
    for (const field of Object.keys(scope)) {
      expect(
        mentions(field),
        `useGridKeyboard.ts no longer mentions "${field}" — the Table extension ` +
          "publishes it and Core would silently fall back to the whole sheet",
      ).toBe(true);
    }
  });
});
