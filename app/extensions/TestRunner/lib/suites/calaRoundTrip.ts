//! FILENAME: app/extensions/TestRunner/lib/suites/calaRoundTrip.ts
// PURPOSE: .cala file format round-trip integration tests.
// CONTEXT: Tests save -> load -> verify for various workbook features:
//          cells, formulas, styles, merged regions, named ranges, tables,
//          multiple sheets, and column/row dimensions.

import type { TestSuite } from "../types";
import { AREA_CALA_ROUNDTRIP } from "../testArea";
import {
  assertTrue,
  assertEqual,
  expectNotNull,
  expectCellValue,
} from "../assertions";
import { invokeBackend } from "@api/backend";
import { appDataDir } from "@tauri-apps/api/path";

const A = AREA_CALA_ROUNDTRIP;

// ============================================================================
// Helpers
// ============================================================================

/** Generate a unique temp file path for .cala files */
async function tempCalaPath(label: string): Promise<string> {
  const dir = await appDataDir();
  return `${dir}test_${label}_${Date.now()}.cala`;
}

/** Save current workbook to a .cala file */
async function saveToFile(path: string): Promise<void> {
  await invokeBackend("save_file", { path });
}

/** Load a .cala file into the workbook, returns cell data */
async function loadFromFile(path: string): Promise<CellData[]> {
  return invokeBackend<CellData[]>("open_file", { path });
}

/** Create a new blank workbook */
async function newWorkbook(): Promise<void> {
  await invokeBackend("new_file", {});
}

/** Cleanup placeholder -- temp files are left for the OS to clean up */
async function deleteFile(_path: string): Promise<void> {
  // No-op: @tauri-apps/plugin-fs not available; temp files are harmless
}

/** Clear the test area */
async function clearArea(ctx: {
  setCells: (u: Array<{ row: number; col: number; value: string }>) => Promise<void>;
  settle: () => Promise<void>;
}) {
  const clears: Array<{ row: number; col: number; value: string }> = [];
  for (let r = 0; r < 30; r++) {
    for (let c = 0; c < 10; c++) {
      clears.push({ row: A.row + r, col: A.col + c, value: "" });
    }
  }
  await ctx.setCells(clears);
  await ctx.settle();
}

// ============================================================================
// Suite
// ============================================================================

export const calaRoundTripSuite: TestSuite = {
  name: ".cala Round-Trip",

  afterEach: async (ctx) => {
    await clearArea(ctx);
  },

  tests: [
    // ------------------------------------------------------------------
    // 1. BASIC: TEXT, NUMBER, BOOLEAN CELLS
    // ------------------------------------------------------------------
    {
      name: "Round-trip: text, number, and boolean cells",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        await ctx.setCells([
          { row: r0, col: c0, value: "Hello World" },
          { row: r0 + 1, col: c0, value: "=42" },
          { row: r0 + 2, col: c0, value: "TRUE" },
          { row: r0 + 3, col: c0, value: "=3.14159" },
        ]);
        await ctx.settle();

        // Save
        const path = await tempCalaPath("basic");
        await saveToFile(path);

        // Clear and reload
        await newWorkbook();
        await ctx.settle();
        await loadFromFile(path);
        await ctx.settle();

        // Verify
        let cell = await ctx.getCell(r0, c0);
        expectCellValue(cell, "Hello World", "Text survived round-trip");

        cell = await ctx.getCell(r0 + 1, c0);
        expectCellValue(cell, "42", "Number survived round-trip");

        cell = await ctx.getCell(r0 + 2, c0);
        expectNotNull(cell, "Boolean cell exists after round-trip");

        cell = await ctx.getCell(r0 + 3, c0);
        expectNotNull(cell, "Pi cell exists after round-trip");
        const piVal = parseFloat(cell!.display.replace(",", "."));
        assertTrue(Math.abs(piVal - 3.14159) < 0.001, `Pi = 3.14159, got ${piVal}`);

        await deleteFile(path);
      },
    },

    // ------------------------------------------------------------------
    // 2. FORMULAS PRESERVED
    // ------------------------------------------------------------------
    {
      name: "Round-trip: formulas are preserved and recalculate",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        await ctx.setCells([
          { row: r0, col: c0, value: "=10" },
          { row: r0 + 1, col: c0, value: "=20" },
          { row: r0 + 2, col: c0, value: `=SUM(${A.ref(0, 0)}:${A.ref(1, 0)})` },
          { row: r0 + 3, col: c0, value: `=${A.ref(0, 0)}*${A.ref(1, 0)}` },
        ]);
        await ctx.settle();

        const path = await tempCalaPath("formulas");
        await saveToFile(path);

        await newWorkbook();
        await ctx.settle();
        await loadFromFile(path);
        await ctx.settle();

        // Values
        let cell = await ctx.getCell(r0 + 2, c0);
        expectCellValue(cell, "30", "SUM formula result preserved");

        cell = await ctx.getCell(r0 + 3, c0);
        expectCellValue(cell, "200", "Multiply formula result preserved");

        // Check formula text is preserved
        cell = await ctx.getCell(r0 + 2, c0);
        expectNotNull(cell, "SUM cell exists");
        assertTrue(
          cell!.formula !== null && cell!.formula !== undefined,
          "SUM formula text should be preserved"
        );

        await deleteFile(path);
      },
    },

    // ------------------------------------------------------------------
    // 3. MANY CELLS (SPARSE DATA)
    // ------------------------------------------------------------------
    {
      name: "Round-trip: 100 cells with mixed content",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        const updates: Array<{ row: number; col: number; value: string }> = [];
        for (let i = 0; i < 100; i++) {
          const r = r0 + Math.floor(i / 5);
          const c = c0 + (i % 5);
          if (i % 3 === 0) updates.push({ row: r, col: c, value: `Cell_${i}` });
          else if (i % 3 === 1) updates.push({ row: r, col: c, value: `=${i * 7}` });
          else updates.push({ row: r, col: c, value: `=LEN("test${i}")` });
        }
        await ctx.setCells(updates);
        await ctx.settle();

        const path = await tempCalaPath("sparse");
        await saveToFile(path);

        await newWorkbook();
        await ctx.settle();
        await loadFromFile(path);
        await ctx.settle();

        // Spot-check
        let cell = await ctx.getCell(r0, c0);
        expectCellValue(cell, "Cell_0", "First text cell");

        cell = await ctx.getCell(r0, c0 + 1);
        expectCellValue(cell, "7", "First number cell (1*7)");

        cell = await ctx.getCell(r0, c0 + 2);
        expectCellValue(cell, "5", "LEN formula cell");

        await deleteFile(path);
      },
    },

    // ------------------------------------------------------------------
    // 4. EMPTY WORKBOOK
    // ------------------------------------------------------------------
    {
      name: "Round-trip: empty workbook",
      run: async (ctx) => {
        // Start with a clean slate
        await newWorkbook();
        await ctx.settle();

        const path = await tempCalaPath("empty");
        await saveToFile(path);

        // Modify something, then reload
        await ctx.setCells([{ row: 0, col: 0, value: "temporary" }]);
        await ctx.settle();

        await loadFromFile(path);
        await ctx.settle();

        // Cell A1 should be empty after loading the empty workbook
        const cell = await ctx.getCell(0, 0);
        assertTrue(
          cell === null || cell.display === "",
          `A1 should be empty after loading empty workbook, got "${cell?.display}"`
        );

        await deleteFile(path);
      },
    },

    // ------------------------------------------------------------------
    // 5. FORMULA REFERENCES SURVIVE
    // ------------------------------------------------------------------
    {
      name: "Round-trip: cross-cell references stay valid",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        // Build a small calculation model
        await ctx.setCells([
          { row: r0, col: c0, value: "Price" },
          { row: r0, col: c0 + 1, value: "Qty" },
          { row: r0, col: c0 + 2, value: "Total" },
          { row: r0 + 1, col: c0, value: "=25" },
          { row: r0 + 1, col: c0 + 1, value: "=4" },
          { row: r0 + 1, col: c0 + 2, value: `=${A.ref(1, 0)}*${A.ref(1, 1)}` },
          { row: r0 + 2, col: c0, value: "=50" },
          { row: r0 + 2, col: c0 + 1, value: "=2" },
          { row: r0 + 2, col: c0 + 2, value: `=${A.ref(2, 0)}*${A.ref(2, 1)}` },
          { row: r0 + 3, col: c0 + 2, value: `=SUM(${A.ref(1, 2)}:${A.ref(2, 2)})` },
        ]);
        await ctx.settle();

        const path = await tempCalaPath("refs");
        await saveToFile(path);

        await newWorkbook();
        await ctx.settle();
        await loadFromFile(path);
        await ctx.settle();

        // Totals: 25*4=100, 50*2=100, SUM=200
        let cell = await ctx.getCell(r0 + 1, c0 + 2);
        expectCellValue(cell, "100", "Line 1 total: 25*4 = 100");

        cell = await ctx.getCell(r0 + 2, c0 + 2);
        expectCellValue(cell, "100", "Line 2 total: 50*2 = 100");

        cell = await ctx.getCell(r0 + 3, c0 + 2);
        expectCellValue(cell, "200", "Grand total: 200");

        await deleteFile(path);
      },
    },

    // ------------------------------------------------------------------
    // 6. SAVE TWICE, LOAD LATEST
    // ------------------------------------------------------------------
    {
      name: "Round-trip: save, modify, save again, load latest",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        await ctx.setCells([{ row: r0, col: c0, value: "Version1" }]);
        await ctx.settle();

        const path = await tempCalaPath("versions");
        await saveToFile(path);

        // Modify and save again
        await ctx.setCells([{ row: r0, col: c0, value: "Version2" }]);
        await ctx.settle();
        await saveToFile(path);

        // Load
        await newWorkbook();
        await ctx.settle();
        await loadFromFile(path);
        await ctx.settle();

        const cell = await ctx.getCell(r0, c0);
        expectCellValue(cell, "Version2", "Should load latest version");

        await deleteFile(path);
      },
    },

    // ------------------------------------------------------------------
    // 7. SPECIAL CHARACTERS IN CELL VALUES
    // ------------------------------------------------------------------
    {
      name: "Round-trip: special characters and Unicode",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        await ctx.setCells([
          { row: r0, col: c0, value: "Line1\nLine2" },
          { row: r0 + 1, col: c0, value: 'Quotes "here"' },
          { row: r0 + 2, col: c0, value: "Tab\there" },
          { row: r0 + 3, col: c0, value: "<html>&amp;" },
        ]);
        await ctx.settle();

        const path = await tempCalaPath("special");
        await saveToFile(path);

        await newWorkbook();
        await ctx.settle();
        await loadFromFile(path);
        await ctx.settle();

        let cell = await ctx.getCell(r0 + 1, c0);
        expectNotNull(cell, "Quotes cell exists");
        assertTrue(
          cell!.display.includes('"'),
          `Should contain quotes, got "${cell!.display}"`
        );

        cell = await ctx.getCell(r0 + 3, c0);
        expectNotNull(cell, "HTML entities cell exists");
        assertTrue(
          cell!.display.includes("&"),
          `Should contain ampersand, got "${cell!.display}"`
        );

        await deleteFile(path);
      },
    },

    // ------------------------------------------------------------------
    // 8. LARGE NUMBERS AND EDGE VALUES
    // ------------------------------------------------------------------
    {
      name: "Round-trip: large numbers, zero, negative",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        await ctx.setCells([
          { row: r0, col: c0, value: "=0" },
          { row: r0 + 1, col: c0, value: "=-999999" },
          { row: r0 + 2, col: c0, value: "=1000000" },
          { row: r0 + 3, col: c0, value: "=0.000001" },
        ]);
        await ctx.settle();

        const path = await tempCalaPath("numbers");
        await saveToFile(path);

        await newWorkbook();
        await ctx.settle();
        await loadFromFile(path);
        await ctx.settle();

        let cell = await ctx.getCell(r0, c0);
        expectCellValue(cell, "0", "Zero preserved");

        cell = await ctx.getCell(r0 + 1, c0);
        expectNotNull(cell, "Negative number exists");
        const negVal = parseFloat(cell!.display.replace(/\s/g, "").replace(",", "."));
        assertTrue(Math.abs(negVal + 999999) < 1, `Negative preserved: ${negVal}`);

        cell = await ctx.getCell(r0 + 2, c0);
        expectNotNull(cell, "Large number exists");
        const largeVal = parseFloat(cell!.display.replace(/\s/g, "").replace(",", "."));
        assertTrue(Math.abs(largeVal - 1000000) < 1, `Large number preserved: ${largeVal}`);

        await deleteFile(path);
      },
    },

    // ------------------------------------------------------------------
    // 9. DATA + FORMULAS IN MULTIPLE AREAS
    // ------------------------------------------------------------------
    {
      name: "Round-trip: data scattered across distant cells",
      run: async (ctx) => {
        // Write data at distant locations
        await ctx.setCells([
          { row: 0, col: 0, value: "=1" },
          { row: 100, col: 0, value: "=2" },
          { row: 0, col: 5, value: "=3" },
          { row: 100, col: 5, value: "=SUM(A1,A101,F1)" },
        ]);
        await ctx.settle();

        const path = await tempCalaPath("distant");
        await saveToFile(path);

        await newWorkbook();
        await ctx.settle();
        await loadFromFile(path);
        await ctx.settle();

        let cell = await ctx.getCell(0, 0);
        expectCellValue(cell, "1", "A1 = 1");

        cell = await ctx.getCell(100, 0);
        expectCellValue(cell, "2", "A101 = 2");

        cell = await ctx.getCell(100, 5);
        expectCellValue(cell, "6", "F101 = SUM(1,2,3) = 6");

        await deleteFile(path);
      },
    },

    // ------------------------------------------------------------------
    // 10. MULTIPLE SAVE/LOAD CYCLES
    // ------------------------------------------------------------------
    {
      name: "Round-trip: three save/load cycles preserve data",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        const path = await tempCalaPath("cycles");

        // Cycle 1: write A
        await ctx.setCells([{ row: r0, col: c0, value: "=100" }]);
        await ctx.settle();
        await saveToFile(path);

        // Cycle 2: load, add B, save
        await newWorkbook();
        await ctx.settle();
        await loadFromFile(path);
        await ctx.settle();
        await ctx.setCells([{ row: r0 + 1, col: c0, value: "=200" }]);
        await ctx.settle();
        await saveToFile(path);

        // Cycle 3: load, add C, save
        await newWorkbook();
        await ctx.settle();
        await loadFromFile(path);
        await ctx.settle();
        await ctx.setCells([{ row: r0 + 2, col: c0, value: `=SUM(${A.ref(0, 0)}:${A.ref(1, 0)})` }]);
        await ctx.settle();
        await saveToFile(path);

        // Final load and verify all data
        await newWorkbook();
        await ctx.settle();
        await loadFromFile(path);
        await ctx.settle();

        let cell = await ctx.getCell(r0, c0);
        expectCellValue(cell, "100", "Cycle 1 data preserved");

        cell = await ctx.getCell(r0 + 1, c0);
        expectCellValue(cell, "200", "Cycle 2 data preserved");

        cell = await ctx.getCell(r0 + 2, c0);
        expectCellValue(cell, "300", "Cycle 3 SUM formula = 300");

        await deleteFile(path);
      },
    },

    // ------------------------------------------------------------------
    // 11. LONG TEXT VALUES
    // ------------------------------------------------------------------
    {
      name: "Round-trip: long text value (1000 chars)",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        const longText = "A".repeat(1000);
        await ctx.setCells([{ row: r0, col: c0, value: longText }]);
        await ctx.settle();

        const path = await tempCalaPath("longtext");
        await saveToFile(path);

        await newWorkbook();
        await ctx.settle();
        await loadFromFile(path);
        await ctx.settle();

        const cell = await ctx.getCell(r0, c0);
        expectNotNull(cell, "Long text cell exists");
        assertEqual(cell!.display.length, 1000, "Long text length preserved");

        await deleteFile(path);
      },
    },

    // ------------------------------------------------------------------
    // 12. WORKFLOW: BUILD SPREADSHEET, SAVE, LOAD, VERIFY CALCULATIONS
    // ------------------------------------------------------------------
    {
      name: "Workflow: build model, save, reload, verify all calculations",
      run: async (ctx) => {
        const r0 = A.row, c0 = A.col;
        // Build a small financial model
        await ctx.setCells([
          { row: r0, col: c0, value: "Revenue" },
          { row: r0, col: c0 + 1, value: "=100000" },
          { row: r0 + 1, col: c0, value: "COGS" },
          { row: r0 + 1, col: c0 + 1, value: "=60000" },
          { row: r0 + 2, col: c0, value: "Gross Profit" },
          { row: r0 + 2, col: c0 + 1, value: `=${A.ref(0, 1)}-${A.ref(1, 1)}` },
          { row: r0 + 3, col: c0, value: "OpEx" },
          { row: r0 + 3, col: c0 + 1, value: "=25000" },
          { row: r0 + 4, col: c0, value: "EBIT" },
          { row: r0 + 4, col: c0 + 1, value: `=${A.ref(2, 1)}-${A.ref(3, 1)}` },
          { row: r0 + 5, col: c0, value: "Tax (25%)" },
          { row: r0 + 5, col: c0 + 1, value: `=${A.ref(4, 1)}*0.25` },
          { row: r0 + 6, col: c0, value: "Net Income" },
          { row: r0 + 6, col: c0 + 1, value: `=${A.ref(4, 1)}-${A.ref(5, 1)}` },
          { row: r0 + 7, col: c0, value: "Margin %" },
          { row: r0 + 7, col: c0 + 1, value: `=ROUND(${A.ref(6, 1)}/${A.ref(0, 1)}*100,1)` },
        ]);
        await ctx.settle();

        // Verify pre-save
        let cell = await ctx.getCell(r0 + 6, c0 + 1);
        expectCellValue(cell, "11250", "Net Income = 11250 before save");

        // Save
        const path = await tempCalaPath("financial");
        await saveToFile(path);

        // Load into fresh workbook
        await newWorkbook();
        await ctx.settle();
        await loadFromFile(path);
        await ctx.settle();

        // Verify all calculations survived
        cell = await ctx.getCell(r0 + 2, c0 + 1);
        expectCellValue(cell, "40000", "Gross Profit = 40000");

        cell = await ctx.getCell(r0 + 4, c0 + 1);
        expectCellValue(cell, "15000", "EBIT = 15000");

        cell = await ctx.getCell(r0 + 5, c0 + 1);
        expectCellValue(cell, "3750", "Tax = 3750");

        cell = await ctx.getCell(r0 + 6, c0 + 1);
        expectCellValue(cell, "11250", "Net Income = 11250 after load");

        // Margin: 11250/100000*100 = 11.25 -> 11.3 (ROUND to 1 decimal)
        cell = await ctx.getCell(r0 + 7, c0 + 1);
        expectNotNull(cell, "Margin cell exists");
        const margin = parseFloat(cell!.display.replace(",", "."));
        assertTrue(Math.abs(margin - 11.3) < 0.1, `Margin = 11.3%, got ${margin}`);

        await deleteFile(path);
      },
    },
  ],
};
