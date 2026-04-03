//! FILENAME: app/extensions/TestRunner/lib/suites/tables.ts
// PURPOSE: Tables (structured tables) test suite.
// CONTEXT: Tests table CRUD, columns, totals row, resize, structured references.

import type { TestSuite } from "../types";
import { assertTrue, assertEqual, expectNotNull } from "../assertions";
import { AREA_TABLES } from "../testArea";
import {
  createTable,
  deleteTable,
  renameTable,
  getTable,
  getTableByName,
  getTableAtCell,
  getAllTables,
  addTableColumn,
  removeTableColumn,
  renameTableColumn,
  toggleTotalsRow,
  setTotalsRowFunction,
  resizeTable,
  convertToRange,
  resolveStructuredReference,
  setCalculatedColumn,
} from "@api/backend";

const A = AREA_TABLES;

export const tablesSuite: TestSuite = {
  name: "Tables",
  description: "Tests table CRUD, columns, totals row, resize, and structured references.",

  afterEach: async (ctx) => {
    // Clean up any tables we created
    try {
      const tables = await getAllTables();
      for (const t of tables) {
        if (t.startRow >= A.row && t.startRow <= A.row + 30) {
          await deleteTable(t.id);
        }
      }
    } catch { /* ignore */ }
    const clears = [];
    for (let r = 0; r < 20; r++) {
      for (let c = 0; c < 6; c++) {
        clears.push({ row: A.row + r, col: A.col + c, value: "" });
      }
    }
    await ctx.setCells(clears);
    await ctx.settle();
  },

  tests: [
    {
      name: "Create table",
      description: "createTable creates a table with headers.",
      run: async (ctx) => {
        // Set up headers and data
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Name" },
          { row: A.row, col: A.col + 1, value: "Value" },
          { row: A.row + 1, col: A.col, value: "Alpha" },
          { row: A.row + 1, col: A.col + 1, value: "10" },
          { row: A.row + 2, col: A.col, value: "Beta" },
          { row: A.row + 2, col: A.col + 1, value: "20" },
        ]);
        await ctx.settle();

        const result = await createTable({
          name: "TestTable1",
          startRow: A.row,
          startCol: A.col,
          endRow: A.row + 2,
          endCol: A.col + 1,
          hasHeaders: true,
        });

        assertTrue(result.success, `createTable should succeed: ${result.error}`);
        expectNotNull(result.table, "table should be returned");
        assertEqual(result.table!.name, "TestTable1", "table name");
        assertEqual(result.table!.columns.length, 2, "should have 2 columns");
        assertEqual(result.table!.columns[0].name, "Name", "first column name");
        assertEqual(result.table!.columns[1].name, "Value", "second column name");
      },
    },
    {
      name: "Get table by ID and name",
      description: "getTable and getTableByName retrieve the same table.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Col1" },
          { row: A.row + 1, col: A.col, value: "A" },
        ]);
        await ctx.settle();

        const created = await createTable({
          name: "LookupTable",
          startRow: A.row,
          startCol: A.col,
          endRow: A.row + 1,
          endCol: A.col,
          hasHeaders: true,
        });
        assertTrue(created.success, `create should succeed: ${created.error}`);
        const id = created.table!.id;

        const byId = await getTable(id);
        expectNotNull(byId, "getTable should find by ID");
        assertEqual(byId!.name, "LookupTable", "name by ID");

        const byName = await getTableByName("LookupTable");
        expectNotNull(byName, "getTableByName should find");
        assertEqual(byName!.id, id, "same ID");
      },
    },
    {
      name: "Get table at cell",
      description: "getTableAtCell returns table when cell is inside.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "H1" },
          { row: A.row + 1, col: A.col, value: "D1" },
        ]);
        await ctx.settle();

        const created = await createTable({
          name: "CellTable",
          startRow: A.row,
          startCol: A.col,
          endRow: A.row + 1,
          endCol: A.col,
          hasHeaders: true,
        });
        assertTrue(created.success, `create: ${created.error}`);

        const found = await getTableAtCell(A.row + 1, A.col);
        expectNotNull(found, "should find table at data cell");
        assertEqual(found!.name, "CellTable", "table name matches");

        const outside = await getTableAtCell(A.row + 10, A.col + 10);
        assertTrue(outside === null, "no table at unrelated cell");
      },
    },
    {
      name: "Rename table",
      description: "renameTable changes the table name.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "X" },
          { row: A.row + 1, col: A.col, value: "1" },
        ]);
        await ctx.settle();

        const created = await createTable({
          name: "OldName",
          startRow: A.row,
          startCol: A.col,
          endRow: A.row + 1,
          endCol: A.col,
          hasHeaders: true,
        });
        assertTrue(created.success, `create: ${created.error}`);

        const result = await renameTable(created.table!.id, "NewName");
        assertTrue(result.success, `rename should succeed: ${result.error}`);
        assertEqual(result.table!.name, "NewName", "new name");

        const fetched = await getTableByName("NewName");
        expectNotNull(fetched, "should find by new name");
      },
    },
    {
      name: "Add and remove table column",
      description: "addTableColumn adds, removeTableColumn removes.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "A" },
          { row: A.row, col: A.col + 1, value: "B" },
          { row: A.row + 1, col: A.col, value: "1" },
          { row: A.row + 1, col: A.col + 1, value: "2" },
        ]);
        await ctx.settle();

        const created = await createTable({
          name: "ColTable",
          startRow: A.row,
          startCol: A.col,
          endRow: A.row + 1,
          endCol: A.col + 1,
          hasHeaders: true,
        });
        assertTrue(created.success, `create: ${created.error}`);
        const id = created.table!.id;

        // Add column
        const addResult = await addTableColumn(id, "C");
        assertTrue(addResult.success, `add column: ${addResult.error}`);
        assertTrue(addResult.table!.columns.length >= 3, "should have 3+ columns");

        // Remove the added column
        const removeResult = await removeTableColumn(id, "C");
        assertTrue(removeResult.success, `remove column: ${removeResult.error}`);
        assertEqual(removeResult.table!.columns.length, 2, "back to 2 columns");
      },
    },
    {
      name: "Rename table column",
      description: "renameTableColumn changes a column header.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Old" },
          { row: A.row + 1, col: A.col, value: "1" },
        ]);
        await ctx.settle();

        const created = await createTable({
          name: "RenColTable",
          startRow: A.row,
          startCol: A.col,
          endRow: A.row + 1,
          endCol: A.col,
          hasHeaders: true,
        });
        assertTrue(created.success, `create: ${created.error}`);

        const result = await renameTableColumn(created.table!.id, "Old", "New");
        assertTrue(result.success, `rename column: ${result.error}`);
        assertEqual(result.table!.columns[0].name, "New", "column renamed");
      },
    },
    {
      name: "Toggle totals row",
      description: "toggleTotalsRow shows/hides the totals row.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Val" },
          { row: A.row + 1, col: A.col, value: "10" },
          { row: A.row + 2, col: A.col, value: "20" },
        ]);
        await ctx.settle();

        const created = await createTable({
          name: "TotalsTable",
          startRow: A.row,
          startCol: A.col,
          endRow: A.row + 2,
          endCol: A.col,
          hasHeaders: true,
        });
        assertTrue(created.success, `create: ${created.error}`);

        // Enable totals row
        const onResult = await toggleTotalsRow(created.table!.id, true);
        assertTrue(onResult.success, `toggle on: ${onResult.error}`);
        assertTrue(onResult.table!.styleOptions.totalRow, "totalRow should be true");

        // Disable totals row
        const offResult = await toggleTotalsRow(created.table!.id, false);
        assertTrue(offResult.success, `toggle off: ${offResult.error}`);
        assertTrue(!offResult.table!.styleOptions.totalRow, "totalRow should be false");
      },
    },
    {
      name: "Set totals row function",
      description: "setTotalsRowFunction sets SUM on a column.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Amount" },
          { row: A.row + 1, col: A.col, value: "10" },
          { row: A.row + 2, col: A.col, value: "20" },
        ]);
        await ctx.settle();

        const created = await createTable({
          name: "TotalsFnTable",
          startRow: A.row,
          startCol: A.col,
          endRow: A.row + 2,
          endCol: A.col,
          hasHeaders: true,
        });
        assertTrue(created.success, `create: ${created.error}`);

        await toggleTotalsRow(created.table!.id, true);

        const result = await setTotalsRowFunction({
          tableId: created.table!.id,
          columnName: "Amount",
          function: "sum",
        });
        assertTrue(result.success, `setTotalsRowFunction: ${result.error}`);
        const col = result.table!.columns.find(c => c.name === "Amount");
        expectNotNull(col, "Amount column");
        assertEqual(col!.totalsRowFunction, "sum", "function should be sum");
      },
    },
    {
      name: "Resize table",
      description: "resizeTable expands the table range.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "H1" },
          { row: A.row, col: A.col + 1, value: "H2" },
          { row: A.row + 1, col: A.col, value: "1" },
          { row: A.row + 1, col: A.col + 1, value: "2" },
          { row: A.row + 2, col: A.col, value: "3" },
          { row: A.row + 2, col: A.col + 1, value: "4" },
        ]);
        await ctx.settle();

        const created = await createTable({
          name: "ResizeTable",
          startRow: A.row,
          startCol: A.col,
          endRow: A.row + 1,
          endCol: A.col + 1,
          hasHeaders: true,
        });
        assertTrue(created.success, `create: ${created.error}`);

        // Expand to include one more data row
        const result = await resizeTable({
          tableId: created.table!.id,
          startRow: A.row,
          startCol: A.col,
          endRow: A.row + 2,
          endCol: A.col + 1,
        });
        assertTrue(result.success, `resize: ${result.error}`);
        assertEqual(result.table!.endRow, A.row + 2, "endRow expanded");
      },
    },
    {
      name: "Convert table to range",
      description: "convertToRange removes table but keeps data.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Keep" },
          { row: A.row + 1, col: A.col, value: "Data" },
        ]);
        await ctx.settle();

        const created = await createTable({
          name: "ConvertTable",
          startRow: A.row,
          startCol: A.col,
          endRow: A.row + 1,
          endCol: A.col,
          hasHeaders: true,
        });
        assertTrue(created.success, `create: ${created.error}`);
        const id = created.table!.id;

        const result = await convertToRange(id);
        assertTrue(result.success, `convert: ${result.error}`);

        // Table should no longer exist
        const gone = await getTable(id);
        assertTrue(gone === null, "table should be gone after convert");

        // Data should still be there
        const cell = await ctx.getCell(A.row + 1, A.col);
        assertEqual(cell?.display, "Data", "data preserved");
      },
    },
    {
      name: "Get all tables",
      description: "getAllTables includes our created table.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "T" },
          { row: A.row + 1, col: A.col, value: "1" },
        ]);
        await ctx.settle();

        const created = await createTable({
          name: "ListTable",
          startRow: A.row,
          startCol: A.col,
          endRow: A.row + 1,
          endCol: A.col,
          hasHeaders: true,
        });
        assertTrue(created.success, `create: ${created.error}`);

        const all = await getAllTables();
        const ours = all.find(t => t.name === "ListTable");
        expectNotNull(ours, "our table should be in getAllTables");
      },
    },
    {
      name: "Resolve structured reference",
      description: "resolveStructuredReference resolves Table1[Column] syntax.",
      run: async (ctx) => {
        await ctx.setCells([
          { row: A.row, col: A.col, value: "Score" },
          { row: A.row + 1, col: A.col, value: "100" },
          { row: A.row + 2, col: A.col, value: "200" },
        ]);
        await ctx.settle();

        const created = await createTable({
          name: "RefTable",
          startRow: A.row,
          startCol: A.col,
          endRow: A.row + 2,
          endCol: A.col,
          hasHeaders: true,
        });
        assertTrue(created.success, `create: ${created.error}`);

        const ref = await resolveStructuredReference("RefTable[Score]");
        assertTrue(ref.success, `resolve: ${ref.error}`);
        expectNotNull(ref.resolved, "should have resolved range");
        assertEqual(ref.resolved!.startCol, A.col, "column matches");
        // Data rows only (excluding header)
        assertEqual(ref.resolved!.startRow, A.row + 1, "starts at first data row");
        assertEqual(ref.resolved!.endRow, A.row + 2, "ends at last data row");
      },
    },
  ],
};
