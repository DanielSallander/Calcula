//! FILENAME: app/extensions/TestRunner/lib/suites/pivotTables.ts
// PURPOSE: End-to-end pivot table integration tests.
// CONTEXT: Tests the full pivot lifecycle through the Tauri API:
//          create -> configure fields -> verify output -> filter -> sort ->
//          change layout -> calculated fields -> drill-down -> delete.

import type { TestSuite } from "../types";
import { AREA_PIVOT } from "../testArea";
import {
  assertTrue,
  assertEqual,
  expectNotNull,
} from "../assertions";
import {
  createPivotTable,
  updatePivotFields,
  getPivotView,
  deletePivotTable,
  getAllPivotTables,
  getPivotTableInfo,
  getPivotAtCell,
  refreshPivotCache,
  addCalculatedField,
  removeCalculatedField,
  updatePivotLayout,
  createFieldConfig,
  createValueFieldConfig,
  createLayoutConfig,
  getCellDisplayValue,
} from "../../../Pivot/lib/pivot-api";
import type {
  PivotViewResponse,
} from "../../../Pivot/lib/pivot-api";

// ============================================================================
// Helpers
// ============================================================================

const A = AREA_PIVOT;

// Source data occupies rows A.row .. A.row+20 (header + 20 data rows), cols A.col .. A.col+4
// Pivot output starts at A.col + 7 to leave a gap
const SRC_ROWS = 20;
const SRC_COLS = 5; // Region(0), Product(1), Quarter(2), Sales(3), Quantity(4)
const DEST_ROW_OFFSET = 0;
const DEST_COL_OFFSET = 7;

/** A1-style reference for source range, e.g. "K3901:O3921" */
function sourceRange(): string {
  const tl = A.ref(0, 0);
  const br = A.ref(SRC_ROWS, SRC_COLS - 1);
  return `${tl}:${br}`;
}

/** A1-style reference for pivot destination cell */
function destCell(): string {
  return A.ref(DEST_ROW_OFFSET, DEST_COL_OFFSET);
}

/** Populate the source data into the grid via the test context. */
async function populateSourceData(ctx: { setCells: (u: Array<{ row: number; col: number; value: string }>) => Promise<void>; settle: () => Promise<void> }) {
  const updates: Array<{ row: number; col: number; value: string }> = [];
  const r0 = A.row;
  const c0 = A.col;

  // Headers
  const headers = ["Region", "Product", "Quarter", "Sales", "Quantity"];
  for (let c = 0; c < headers.length; c++) {
    updates.push({ row: r0, col: c0 + c, value: headers[c] });
  }

  // 20 data rows - 3 regions x 2 products x 2 quarters + extras
  const data: [string, string, string, string, string][] = [
    ["North", "Widget", "Q1", "10000", "100"],
    ["North", "Widget", "Q2", "12000", "120"],
    ["North", "Gadget", "Q1", "8000", "80"],
    ["North", "Gadget", "Q2", "9000", "90"],
    ["South", "Widget", "Q1", "15000", "150"],
    ["South", "Widget", "Q2", "14000", "140"],
    ["South", "Gadget", "Q1", "11000", "110"],
    ["South", "Gadget", "Q2", "13000", "130"],
    ["East", "Widget", "Q1", "9000", "90"],
    ["East", "Widget", "Q2", "11000", "110"],
    ["East", "Gadget", "Q1", "7000", "70"],
    ["East", "Gadget", "Q2", "8500", "85"],
    ["West", "Widget", "Q1", "13000", "130"],
    ["West", "Widget", "Q2", "12500", "125"],
    ["West", "Gadget", "Q1", "9500", "95"],
    ["West", "Gadget", "Q2", "10500", "105"],
    ["North", "Widget", "Q3", "11500", "115"],
    ["South", "Widget", "Q3", "16000", "160"],
    ["East", "Gadget", "Q3", "7500", "75"],
    ["West", "Gadget", "Q3", "10000", "100"],
  ];

  for (let i = 0; i < data.length; i++) {
    for (let c = 0; c < data[i].length; c++) {
      updates.push({ row: r0 + 1 + i, col: c0 + c, value: data[i][c] });
    }
  }

  await ctx.setCells(updates);
  await ctx.settle();
}

/** Clean up the source + pivot output area. */
async function clearArea(ctx: { setCells: (u: Array<{ row: number; col: number; value: string }>) => Promise<void>; settle: () => Promise<void> }) {
  // Delete all pivot tables first (so protected regions are removed)
  try {
    const pivots = await getAllPivotTables();
    for (const p of pivots) {
      await deletePivotTable(p.pivotId);
    }
  } catch { /* ignore */ }

  const clears: Array<{ row: number; col: number; value: string }> = [];
  for (let r = 0; r < 45; r++) {
    for (let c = 0; c < 15; c++) {
      clears.push({ row: A.row + r, col: A.col + c, value: "" });
    }
  }
  await ctx.setCells(clears);
  await ctx.settle();
}

/** Count cells of a given type in a PivotViewResponse */
function countCellType(view: PivotViewResponse, cellType: string): number {
  let n = 0;
  for (const row of view.rows) {
    for (const cell of row.cells) {
      if (cell.cellType === cellType) n++;
    }
  }
  return n;
}

/** Find all data cells and sum their numeric values */
function sumDataCells(view: PivotViewResponse): number {
  let total = 0;
  for (const row of view.rows) {
    for (const cell of row.cells) {
      if (cell.cellType === "Data" && typeof cell.value === "number") {
        total += cell.value;
      }
    }
  }
  return total;
}

/** Find the GrandTotal cell value */
function grandTotal(view: PivotViewResponse): number | null {
  for (const row of view.rows) {
    for (const cell of row.cells) {
      if (cell.cellType === "GrandTotal" && typeof cell.value === "number") {
        return cell.value;
      }
    }
  }
  return null;
}

/** Get display text from a pivot cell (prefers formattedValue, falls back to value) */
function cellText(cell: { formattedValue?: string; value: unknown }): string {
  if (cell.formattedValue) return cell.formattedValue.trim();
  return getCellDisplayValue(cell.value as any).trim();
}

/** Collect all row header labels */
function rowHeaders(view: PivotViewResponse): string[] {
  const labels: string[] = [];
  for (const row of view.rows) {
    for (const cell of row.cells) {
      if (cell.cellType === "RowHeader") {
        const v = cellText(cell);
        if (v) labels.push(v);
      }
    }
  }
  return labels;
}

/** Collect all column header labels (deduplicated) */
function colHeaders(view: PivotViewResponse): string[] {
  const labels: string[] = [];
  for (const row of view.rows) {
    for (const cell of row.cells) {
      if (cell.cellType === "ColumnHeader") {
        const v = cellText(cell);
        if (v && !labels.includes(v)) labels.push(v);
      }
    }
  }
  return labels;
}

// Expected grand total: sum of all Sales values
const EXPECTED_TOTAL = 10000 + 12000 + 8000 + 9000 + 15000 + 14000 + 11000 + 13000
  + 9000 + 11000 + 7000 + 8500 + 13000 + 12500 + 9500 + 10500
  + 11500 + 16000 + 7500 + 10000; // = 218000

// ============================================================================
// Suite
// ============================================================================

export const pivotTablesSuite: TestSuite = {
  name: "Pivot Tables",

  afterEach: async (ctx) => {
    await clearArea(ctx);
  },

  tests: [
    // ------------------------------------------------------------------
    // 1. CREATION & BASIC STRUCTURE
    // ------------------------------------------------------------------
    {
      name: "Create pivot table from range",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const view = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
          hasHeaders: true,
          name: "TestPivot",
        });
        expectNotNull(view, "createPivotTable should return a view");
        assertTrue(view.pivotId >= 1, "Pivot ID should be >= 1");

        // Empty pivot (no fields) should have minimal output
        assertEqual(view.rowCount >= 0, true, "rowCount should be non-negative");
      },
    },
    {
      name: "Configure row + value fields (Region by Sales)",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        const view = await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [createFieldConfig(0, "Region")],
          valueFields: [createValueFieldConfig(3, "Sum of Sales", "sum")],
        });

        // Should have 4 region rows
        const rh = rowHeaders(view);
        assertTrue(rh.includes("North"), "Should contain North");
        assertTrue(rh.includes("South"), "Should contain South");
        assertTrue(rh.includes("East"), "Should contain East");
        assertTrue(rh.includes("West"), "Should contain West");

        // Grand total should equal sum of all sales
        const gt = grandTotal(view);
        expectNotNull(gt, "Should have grand total");
        assertTrue(
          Math.abs(gt! - EXPECTED_TOTAL) < 0.01,
          `Grand total ${gt} should equal ${EXPECTED_TOTAL}`
        );
      },
    },
    {
      name: "Cross-tab: rows=Region, columns=Product, values=Sum(Sales)",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        const view = await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [createFieldConfig(0, "Region")],
          columnFields: [createFieldConfig(1, "Product")],
          valueFields: [createValueFieldConfig(3, "Sum of Sales", "sum")],
        });

        const ch = colHeaders(view);
        assertTrue(ch.some(h => h === "Widget" || h.includes("Widget")), "Should have Widget column");
        assertTrue(ch.some(h => h === "Gadget" || h.includes("Gadget")), "Should have Gadget column");

        // Grand total unchanged
        const gt = grandTotal(view);
        expectNotNull(gt, "Cross-tab should have grand total");
        assertTrue(Math.abs(gt! - EXPECTED_TOTAL) < 0.01, `Grand total ${gt} should be ${EXPECTED_TOTAL}`);
      },
    },

    // ------------------------------------------------------------------
    // 2. MULTIPLE VALUE FIELDS
    // ------------------------------------------------------------------
    {
      name: "Multiple value fields (Sum + Count + Average)",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        const view = await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [createFieldConfig(0, "Region")],
          valueFields: [
            createValueFieldConfig(3, "Sum of Sales", "sum"),
            createValueFieldConfig(3, "Count", "count"),
            createValueFieldConfig(3, "Avg Sales", "average"),
          ],
        });

        // 4 regions * 3 value fields = at least 12 data cells
        const dc = countCellType(view, "Data");
        assertTrue(dc >= 12, `Should have >= 12 data cells, got ${dc}`);
      },
    },

    // ------------------------------------------------------------------
    // 3. AGGREGATION TYPES
    // ------------------------------------------------------------------
    {
      name: "Min and Max aggregation",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        // Min
        const viewMin = await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [createFieldConfig(0, "Region")],
          valueFields: [createValueFieldConfig(3, "Min Sales", "min")],
        });
        const gtMin = grandTotal(viewMin);
        expectNotNull(gtMin, "Min pivot should have grand total");
        // Global min is 7000
        assertTrue(Math.abs(gtMin! - 7000) < 0.01, `Min grand total should be 7000, got ${gtMin}`);

        // Max
        const viewMax = await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [createFieldConfig(0, "Region")],
          valueFields: [createValueFieldConfig(3, "Max Sales", "max")],
        });
        const gtMax = grandTotal(viewMax);
        expectNotNull(gtMax, "Max pivot should have grand total");
        // Global max is 16000
        assertTrue(Math.abs(gtMax! - 16000) < 0.01, `Max grand total should be 16000, got ${gtMax}`);
      },
    },

    // ------------------------------------------------------------------
    // 4. FILTERING (hidden items)
    // ------------------------------------------------------------------
    {
      name: "Filter: hide regions via hiddenItems",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        const view = await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [createFieldConfig(0, "Region", { hiddenItems: ["East", "West"] })],
          valueFields: [createValueFieldConfig(3, "Sum of Sales", "sum")],
        });

        const rh = rowHeaders(view);
        assertTrue(rh.includes("North"), "North should be visible");
        assertTrue(rh.includes("South"), "South should be visible");
        assertTrue(!rh.includes("East"), "East should be hidden");
        assertTrue(!rh.includes("West"), "West should be hidden");

        // Grand total = North + South only
        const northSouth = (10000 + 12000 + 8000 + 9000 + 11500)
          + (15000 + 14000 + 11000 + 13000 + 16000);
        const gt = grandTotal(view);
        expectNotNull(gt, "Filtered pivot should have grand total");
        assertTrue(
          Math.abs(gt! - northSouth) < 0.01,
          `Filtered grand total ${gt} should be ${northSouth}`
        );
      },
    },

    // ------------------------------------------------------------------
    // 5. SORTING
    // ------------------------------------------------------------------
    {
      name: "Sort rows ascending",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [createFieldConfig(0, "Region", { sortOrder: "asc" })],
          valueFields: [createValueFieldConfig(3, "Sum of Sales", "sum")],
        });

        const view = await getPivotView(created.pivotId);
        const rh = rowHeaders(view);
        const sorted = [...rh].sort();
        assertEqual(JSON.stringify(rh), JSON.stringify(sorted), "Row headers should be ascending");
      },
    },
    {
      name: "Sort rows descending",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [createFieldConfig(0, "Region", { sortOrder: "desc" })],
          valueFields: [createValueFieldConfig(3, "Sum of Sales", "sum")],
        });

        const view = await getPivotView(created.pivotId);
        const rh = rowHeaders(view);
        const sorted = [...rh].sort().reverse();
        assertEqual(JSON.stringify(rh), JSON.stringify(sorted), "Row headers should be descending");
      },
    },

    // ------------------------------------------------------------------
    // 6. LAYOUT VARIANTS
    // ------------------------------------------------------------------
    {
      name: "Compact layout (single label column)",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        const view = await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [
            createFieldConfig(0, "Region"),
            createFieldConfig(1, "Product"),
          ],
          valueFields: [createValueFieldConfig(3, "Sum of Sales", "sum")],
          layout: createLayoutConfig({ reportLayout: "compact" }),
        });

        assertEqual(view.rowLabelColCount, 1, "Compact should use 1 label column");
      },
    },
    {
      name: "Tabular layout (one column per row field)",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        const view = await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [
            createFieldConfig(0, "Region"),
            createFieldConfig(1, "Product"),
          ],
          valueFields: [createValueFieldConfig(3, "Sum of Sales", "sum")],
          layout: createLayoutConfig({ reportLayout: "tabular" }),
        });

        assertEqual(view.rowLabelColCount, 2, "Tabular with 2 row fields should use 2 label columns");
      },
    },

    // ------------------------------------------------------------------
    // 7. GRAND TOTALS ON/OFF
    // ------------------------------------------------------------------
    {
      name: "Disable row grand totals",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        const view = await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [createFieldConfig(0, "Region")],
          valueFields: [createValueFieldConfig(3, "Sum of Sales", "sum")],
          layout: createLayoutConfig({ showRowGrandTotals: false }),
        });

        const gtRow = countCellType(view, "GrandTotalRow") + countCellType(view, "GrandTotal");
        assertEqual(gtRow, 0, "No row grand total when disabled");
      },
    },
    {
      name: "Disable column grand totals",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        const view = await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [createFieldConfig(0, "Region")],
          columnFields: [createFieldConfig(1, "Product")],
          valueFields: [createValueFieldConfig(3, "Sum of Sales", "sum")],
          layout: createLayoutConfig({ showColumnGrandTotals: false }),
        });

        const gtCol = countCellType(view, "GrandTotalColumn") + countCellType(view, "GrandTotal");
        assertEqual(gtCol, 0, "No column grand total when disabled");
      },
    },

    // ------------------------------------------------------------------
    // 8. TWO-LEVEL HIERARCHY
    // ------------------------------------------------------------------
    {
      name: "Two-level row hierarchy (Region > Product)",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        const view = await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [
            createFieldConfig(0, "Region"),
            createFieldConfig(1, "Product"),
          ],
          valueFields: [createValueFieldConfig(3, "Sum of Sales", "sum")],
        });

        const rh = rowHeaders(view);
        // Outer level
        assertTrue(rh.includes("North"), "Should have North at outer level");
        assertTrue(rh.includes("South"), "Should have South at outer level");
        // Inner level
        assertTrue(rh.includes("Widget"), "Should have Widget at inner level");
        assertTrue(rh.includes("Gadget"), "Should have Gadget at inner level");

        // Grand total unchanged
        const gt = grandTotal(view);
        assertTrue(Math.abs(gt! - EXPECTED_TOTAL) < 0.01, "Hierarchy grand total should match");
      },
    },

    // ------------------------------------------------------------------
    // 9. FIELD RECONFIGURATION
    // ------------------------------------------------------------------
    {
      name: "Change row field from Region to Product",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        // First: by Region
        await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [createFieldConfig(0, "Region")],
          valueFields: [createValueFieldConfig(3, "Sum of Sales", "sum")],
        });

        // Then: switch to Product
        const view2 = await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [createFieldConfig(1, "Product")],
          valueFields: [createValueFieldConfig(3, "Sum of Sales", "sum")],
        });

        const rh = rowHeaders(view2);
        assertTrue(rh.includes("Widget"), "Should now show Widget");
        assertTrue(rh.includes("Gadget"), "Should now show Gadget");
        assertTrue(!rh.includes("North"), "Should no longer show North");

        // Grand total unchanged
        const gt = grandTotal(view2);
        assertTrue(Math.abs(gt! - EXPECTED_TOTAL) < 0.01, "Grand total unchanged after field swap");
      },
    },
    {
      name: "Change aggregation from Sum to Average",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        // Sum first
        const viewSum = await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [createFieldConfig(0, "Region")],
          valueFields: [createValueFieldConfig(3, "Sum of Sales", "sum")],
        });
        const gtSum = grandTotal(viewSum)!;

        // Average
        const viewAvg = await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [createFieldConfig(0, "Region")],
          valueFields: [createValueFieldConfig(3, "Avg Sales", "average")],
        });
        const gtAvg = grandTotal(viewAvg)!;

        const expectedAvg = EXPECTED_TOTAL / SRC_ROWS;
        assertTrue(
          Math.abs(gtAvg - expectedAvg) < 0.01,
          `Average grand total ${gtAvg} should be ${expectedAvg}`
        );
      },
    },

    // ------------------------------------------------------------------
    // 10. PIVOT METADATA & MANAGEMENT
    // ------------------------------------------------------------------
    {
      name: "getPivotTableInfo returns correct metadata",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
          name: "SalesPivot",
        });

        const info = await getPivotTableInfo(created.pivotId);
        expectNotNull(info, "Should return pivot info");
        assertEqual(info.id, created.pivotId, "IDs should match");
      },
    },
    {
      name: "getAllPivotTables lists created pivot",
      run: async (ctx) => {
        await populateSourceData(ctx);
        await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        const all = await getAllPivotTables();
        assertTrue(all.length >= 1, "Should have at least 1 pivot table");
      },
    },
    {
      name: "getPivotAtCell detects pivot region",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        // Configure fields so the pivot has output
        await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [createFieldConfig(0, "Region")],
          valueFields: [createValueFieldConfig(3, "Sum of Sales", "sum")],
        });

        // Check destination cell
        const region = await getPivotAtCell(A.row + DEST_ROW_OFFSET, A.col + DEST_COL_OFFSET);
        expectNotNull(region, "Destination cell should be inside pivot region");
        assertTrue(region!.pivotId >= 1, "Pivot region should have a valid pivot ID");
      },
    },
    {
      name: "deletePivotTable removes pivot",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        await deletePivotTable(created.pivotId);

        const all = await getAllPivotTables();
        assertTrue(
          !all.some(p => p.pivotId === created.pivotId),
          "Deleted pivot should not appear in list"
        );
      },
    },

    // ------------------------------------------------------------------
    // 11. REFRESH CACHE
    // ------------------------------------------------------------------
    {
      name: "Refresh cache picks up changed source data",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        const view1 = await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [createFieldConfig(0, "Region")],
          valueFields: [createValueFieldConfig(3, "Sum of Sales", "sum")],
        });
        const gt1 = grandTotal(view1)!;

        // Change a source cell: increase North/Widget/Q1 from 10000 to 20000
        await ctx.setCells([{ row: A.row + 1, col: A.col + 3, value: "20000" }]);
        await ctx.settle();

        // Refresh
        const view2 = await refreshPivotCache(created.pivotId);
        const gt2 = grandTotal(view2)!;

        assertTrue(
          Math.abs(gt2 - (gt1 + 10000)) < 0.01,
          `After refresh, grand total ${gt2} should be ${gt1 + 10000}`
        );
      },
    },

    // ------------------------------------------------------------------
    // 12. VALUES POSITION (rows vs columns)
    // ------------------------------------------------------------------
    {
      name: "Values on rows (multiple value fields stacked)",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        const view = await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [createFieldConfig(0, "Region")],
          valueFields: [
            createValueFieldConfig(3, "Sum of Sales", "sum"),
            createValueFieldConfig(4, "Sum of Qty", "sum"),
          ],
          layout: createLayoutConfig({ valuesPosition: "rows" }),
        });

        // When values are on rows, we get more rows (each region has 2 sub-rows)
        assertTrue(view.rowCount > 8, `Values on rows should produce > 8 rows, got ${view.rowCount}`);
      },
    },

    // ------------------------------------------------------------------
    // 13. THREE-LEVEL HIERARCHY
    // ------------------------------------------------------------------
    {
      name: "Three-level hierarchy (Region > Product > Quarter)",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        const view = await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [
            createFieldConfig(0, "Region"),
            createFieldConfig(1, "Product"),
            createFieldConfig(2, "Quarter"),
          ],
          valueFields: [createValueFieldConfig(3, "Sum of Sales", "sum")],
        });

        const rh = rowHeaders(view);
        assertTrue(rh.includes("North"), "Level 1: Region");
        assertTrue(rh.includes("Widget"), "Level 2: Product");
        assertTrue(rh.includes("Q1"), "Level 3: Quarter");

        const gt = grandTotal(view);
        assertTrue(Math.abs(gt! - EXPECTED_TOTAL) < 0.01, "3-level hierarchy grand total correct");
      },
    },

    // ------------------------------------------------------------------
    // 14. SUBTOTALS
    // ------------------------------------------------------------------
    {
      name: "Subtotals off on outer field",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        const view = await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [
            createFieldConfig(0, "Region", { showSubtotals: false }),
            createFieldConfig(1, "Product"),
          ],
          valueFields: [createValueFieldConfig(3, "Sum of Sales", "sum")],
          layout: createLayoutConfig({ reportLayout: "tabular" }),
        });

        const subtotals = countCellType(view, "RowSubtotal");
        assertEqual(subtotals, 0, "No subtotals when disabled on outer field");
      },
    },

    // ------------------------------------------------------------------
    // 15. CALCULATED FIELDS
    // ------------------------------------------------------------------
    {
      name: "Add and remove calculated field",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [createFieldConfig(0, "Region")],
          valueFields: [
            createValueFieldConfig(3, "Sum of Sales", "sum"),
            createValueFieldConfig(4, "Sum of Qty", "sum"),
          ],
        });

        // Add calculated field: Revenue per Unit = Sales / Qty
        const viewCalc = await addCalculatedField({
          pivotId: created.pivotId,
          name: "Rev per Unit",
          formula: "'Sum of Sales' / 'Sum of Qty'",
        });

        // Should have data cells for the calculated field
        const dc = countCellType(viewCalc, "Data");
        // 4 regions * 3 columns (Sales, Qty, Calc) = 12+
        assertTrue(dc >= 12, `Should have >= 12 data cells with calc field, got ${dc}`);

        // Remove it (fieldIndex 0 = the first calculated field)
        const viewRemoved = await removeCalculatedField({
          pivotId: created.pivotId,
          fieldIndex: 0,
        });
        const dc2 = countCellType(viewRemoved, "Data");
        assertTrue(dc2 < dc, "Should have fewer data cells after removing calc field");
      },
    },

    // ------------------------------------------------------------------
    // 16. PIVOT OUTPUT WRITTEN TO GRID
    // ------------------------------------------------------------------
    {
      name: "Pivot cells are written to the grid",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [createFieldConfig(0, "Region")],
          valueFields: [createValueFieldConfig(3, "Sum of Sales", "sum")],
        });

        // Read the destination cell from the grid (not from pivot view)
        const destR = A.row + DEST_ROW_OFFSET;
        const destC = A.col + DEST_COL_OFFSET;
        const cell = await ctx.getCell(destR, destC);
        expectNotNull(cell, "Pivot output cell should exist in grid");
        // The top-left of the pivot should have some content (header or label)
        assertTrue(
          cell!.display !== "",
          "Pivot destination cell should not be empty"
        );
      },
    },

    // ------------------------------------------------------------------
    // 17. VIEW STRUCTURAL INTEGRITY
    // ------------------------------------------------------------------
    {
      name: "View dimensions are consistent",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        const view = await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [createFieldConfig(0, "Region")],
          columnFields: [createFieldConfig(1, "Product")],
          valueFields: [createValueFieldConfig(3, "Sum of Sales", "sum")],
        });

        assertEqual(view.rows.length, view.rowCount, "rows.length should match rowCount");
        // Every row should have the same number of cells
        for (let i = 0; i < view.rows.length; i++) {
          assertEqual(
            view.rows[i].cells.length,
            view.colCount,
            `Row ${i} should have ${view.colCount} cells, got ${view.rows[i].cells.length}`
          );
        }
      },
    },
    {
      name: "Data cell sum equals grand total",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        const view = await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [createFieldConfig(0, "Region")],
          valueFields: [createValueFieldConfig(3, "Sum of Sales", "sum")],
        });

        const dataSum = sumDataCells(view);
        const gt = grandTotal(view)!;
        assertTrue(
          Math.abs(dataSum - gt) < 0.01,
          `Data sum ${dataSum} should equal grand total ${gt}`
        );
      },
    },

    // ------------------------------------------------------------------
    // 18. COMBINED FILTER + SORT
    // ------------------------------------------------------------------
    {
      name: "Filter + descending sort combined",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        const view = await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [createFieldConfig(0, "Region", {
            hiddenItems: ["East", "West"],
            sortOrder: "desc",
          })],
          valueFields: [createValueFieldConfig(3, "Sum of Sales", "sum")],
        });

        const rh = rowHeaders(view);
        assertTrue(!rh.includes("East"), "East should be filtered out");
        assertTrue(!rh.includes("West"), "West should be filtered out");
        // Should be descending: South before North
        const sorted = [...rh].sort().reverse();
        assertEqual(JSON.stringify(rh), JSON.stringify(sorted), "Should be descending order");
      },
    },

    // ------------------------------------------------------------------
    // 19. UPDATE LAYOUT AFTER CREATION
    // ------------------------------------------------------------------
    {
      name: "Update layout to outline after initial compact",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        // Start compact
        await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [
            createFieldConfig(0, "Region"),
            createFieldConfig(1, "Product"),
          ],
          valueFields: [createValueFieldConfig(3, "Sum of Sales", "sum")],
          layout: createLayoutConfig({ reportLayout: "compact" }),
        });

        // Switch to outline
        const view2 = await updatePivotLayout({
          pivotId: created.pivotId,
          layout: { reportLayout: "outline" },
        });

        assertEqual(view2.rowLabelColCount, 2, "Outline with 2 row fields should use 2 columns");
      },
    },

    // ------------------------------------------------------------------
    // 20. CROSS-TAB WITH MULTIPLE VALUES
    // ------------------------------------------------------------------
    {
      name: "Cross-tab with 2 value fields (Sales + Quantity)",
      run: async (ctx) => {
        await populateSourceData(ctx);
        const created = await createPivotTable({
          sourceRange: sourceRange(),
          destinationCell: destCell(),
        });

        const view = await updatePivotFields({
          pivotId: created.pivotId,
          rowFields: [createFieldConfig(0, "Region")],
          columnFields: [createFieldConfig(2, "Quarter")],
          valueFields: [
            createValueFieldConfig(3, "Sum of Sales", "sum"),
            createValueFieldConfig(4, "Sum of Qty", "sum"),
          ],
        });

        // Should have data cells
        const dc = countCellType(view, "Data");
        assertTrue(dc > 0, `Cross-tab with multiple values should have data cells, got ${dc}`);

        // View structure should be valid
        assertEqual(view.rows.length, view.rowCount, "Row count matches");
      },
    },
  ],
};
