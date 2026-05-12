//! FILENAME: app/extensions/TestRunner/lib/suites/biEngineIntegration.ts
// PURPOSE: BI Engine integration tests with live PostgreSQL database.
// CONTEXT: Tests the full BI lifecycle: load model -> connect to database ->
//          query data -> insert into grid -> create BI pivot -> refresh.
//          Requires: PostgreSQL running at localhost:5432 with Adventureworks DB.

import type { TestSuite } from "../types";
import { AREA_BI_ENGINE } from "../testArea";
import {
  assertTrue,
  assertEqual,
  expectNotNull,
  expectCellValue,
} from "../assertions";
import {
  biCreateConnection,
  biDeleteConnection,
  biConnect,
  biDisconnect,
  biGetConnections,
  biGetConnection,
  biBindTable,
  biQuery,
  biGetModelInfo,
  biInsertResult,
  biRefreshConnection,
  biGetRegionAtCell,
} from "@api/backend";
import {
  createPivotTable,
  updatePivotFields,
  getPivotView,
  deletePivotTable,
  getAllPivotTables,
  createFieldConfig,
  createValueFieldConfig,
  createLayoutConfig,
} from "../../../Pivot/lib/pivot-api";
import type {
  CreateConnectionRequest,
  BiQueryRequest,
  BiInsertRequest,
  ConnectionInfo,
} from "@api/backend";
import { calculateNow } from "@api";

const A = AREA_BI_ENGINE;

// ============================================================================
// Configuration
// ============================================================================

const MODEL_PATH = "C:\\Dropbox\\Projekt\\Calcula Studio\\examples\\model.json";
const CONNECTION_STRING = "postgresql://postgres:postgres@localhost:5432/Adventureworks";

// ============================================================================
// Helpers
// ============================================================================

/** The model tables and their BI schema bindings */
const MODEL_TABLES = [
  "dim_customer", "dim_date", "dim_product", "dim_territory",
  "fact_sales", "fact_purchasing",
];

/** Create a BI connection, return its ID. Throws if model can't be loaded. */
async function createTestConnection(name: string): Promise<ConnectionInfo> {
  const conn = await biCreateConnection({
    name,
    description: "E2E test connection",
    connectionString: CONNECTION_STRING,
    modelPath: MODEL_PATH,
  });
  return conn;
}

/** Connect to DB and bind all model tables to the BI schema */
async function connectAndBind(connectionId: number): Promise<ConnectionInfo> {
  const connected = await biConnect({ connectionId });
  // Bind all model tables to the BI schema
  for (const table of MODEL_TABLES) {
    await biBindTable(connectionId, {
      modelTable: table,
      schema: "BI",
      sourceTable: table,
    });
  }
  return connected;
}

/** Cleanup: delete all test connections */
async function cleanupConnections() {
  try {
    const conns = await biGetConnections();
    for (const c of conns) {
      if (c.name.startsWith("BiTest")) {
        try { await biDeleteConnection(c.id); } catch { /* */ }
      }
    }
  } catch { /* */ }
  // Also clean up any pivots
  try {
    const pivots = await getAllPivotTables();
    for (const p of pivots) {
      try { await deletePivotTable(p.pivotId); } catch { /* */ }
    }
  } catch { /* */ }
}

/** Clear test area cells */
async function clearArea(ctx: {
  setCells: (u: Array<{ row: number; col: number; value: string }>) => Promise<void>;
  settle: () => Promise<void>;
}) {
  const clears: Array<{ row: number; col: number; value: string }> = [];
  for (let r = 0; r < 40; r++) {
    for (let c = 0; c < 12; c++) {
      clears.push({ row: A.row + r, col: A.col + c, value: "" });
    }
  }
  await ctx.setCells(clears);
  await ctx.settle();
}

// ============================================================================
// Suite
// ============================================================================

export const biEngineIntegrationSuite: TestSuite = {
  name: "BI Engine Integration",

  afterEach: async (ctx) => {
    await cleanupConnections();
    await clearArea(ctx);
  },

  tests: [
    // ------------------------------------------------------------------
    // 1. LOAD MODEL
    // ------------------------------------------------------------------
    {
      name: "Load model.json and verify tables/measures",
      run: async (ctx) => {
        const conn = await createTestConnection("BiTest_LoadModel");

        expectNotNull(conn, "Connection should be created");
        assertTrue(conn.id >= 1, `Connection ID should be >= 1, got ${conn.id}`);
        assertTrue(conn.tableCount > 0, `Should have tables, got ${conn.tableCount}`);
        assertTrue(conn.measureCount > 0, `Should have measures, got ${conn.measureCount}`);
        assertEqual(conn.isConnected, false, "Should not be connected to DB yet");

        ctx.log(`Model loaded: ${conn.tableCount} tables, ${conn.measureCount} measures`);
      },
    },

    // ------------------------------------------------------------------
    // 2. GET MODEL INFO
    // ------------------------------------------------------------------
    {
      name: "Get model info: tables, columns, measures, relationships",
      run: async (ctx) => {
        const conn = await createTestConnection("BiTest_ModelInfo");
        const info = await biGetModelInfo(conn.id);

        expectNotNull(info, "Model info should exist");

        // Tables: dim_customer, dim_date, dim_product, dim_territory, fact_sales, fact_purchasing
        assertTrue(info!.tables.length >= 6, `Should have >= 6 tables, got ${info!.tables.length}`);
        ctx.log(`Tables: ${info!.tables.map(t => t.name).join(", ")}`);

        // Check specific tables exist
        const tableNames = info!.tables.map(t => t.name);
        assertTrue(tableNames.includes("dim_customer"), "Should have dim_customer");
        assertTrue(tableNames.includes("fact_sales"), "Should have fact_sales");
        assertTrue(tableNames.includes("dim_product"), "Should have dim_product");

        // Check columns on dim_customer
        const customer = info!.tables.find(t => t.name === "dim_customer");
        expectNotNull(customer, "dim_customer table");
        assertTrue(customer!.columns.length >= 5, `dim_customer should have >= 5 columns`);
        const colNames = customer!.columns.map(c => c.name);
        assertTrue(colNames.includes("customerid"), "Should have customerid column");
        assertTrue(colNames.includes("fullname") || colNames.includes("firstname"), "Should have name column");

        // Measures
        assertTrue(info!.measures.length >= 5, `Should have >= 5 measures, got ${info!.measures.length}`);
        ctx.log(`Measures: ${info!.measures.slice(0, 10).map(m => m.name).join(", ")}...`);

        // Relationships
        assertTrue(info!.relationships.length >= 4, `Should have >= 4 relationships, got ${info!.relationships.length}`);
      },
    },

    // ------------------------------------------------------------------
    // 3. CONNECT TO DATABASE
    // ------------------------------------------------------------------
    {
      name: "Connect to PostgreSQL database",
      run: async (ctx) => {
        const conn = await createTestConnection("BiTest_Connect");
        assertEqual(conn.isConnected, false, "Not connected yet");

        // Connect and bind tables
        const connected = await connectAndBind(conn.id);
        assertEqual(connected.isConnected, true, "Should be connected after biConnect");

        ctx.log(`Connected! isConnected=${connected.isConnected}`);

        // Disconnect
        const disconnected = await biDisconnect(conn.id);
        assertEqual(disconnected.isConnected, false, "Should be disconnected");
      },
    },

    // ------------------------------------------------------------------
    // 4. QUERY: SIMPLE MEASURE
    // ------------------------------------------------------------------
    {
      name: "Query: TotalSales measure (no groupBy)",
      run: async (ctx) => {
        const conn = await createTestConnection("BiTest_SimpleQuery");
        await connectAndBind(conn.id);

        const result = await biQuery(conn.id, {
          measures: ["TotalSales"],
          groupBy: [],
          filters: [],
        });

        assertTrue(result.columns.length >= 1, `Should have >= 1 column, got ${result.columns.length}`);
        assertTrue(result.rowCount >= 1, `Should have >= 1 row, got ${result.rowCount}`);

        // TotalSales should be a positive number
        const totalSales = result.rows[0][0];
        expectNotNull(totalSales, "TotalSales should not be null");
        const val = parseFloat(totalSales!);
        assertTrue(val > 0, `TotalSales should be > 0, got ${val}`);

        ctx.log(`TotalSales = ${totalSales}`);
      },
    },

    // ------------------------------------------------------------------
    // 5. QUERY: MEASURE WITH GROUPBY
    // ------------------------------------------------------------------
    {
      name: "Query: TotalSales grouped by territory",
      run: async (ctx) => {
        const conn = await createTestConnection("BiTest_GroupBy");
        await connectAndBind(conn.id);

        const result = await biQuery(conn.id, {
          measures: ["TotalSales"],
          groupBy: [{ table: "dim_territory", column: "territoryname" }],
          filters: [],
        });

        assertTrue(result.columns.length >= 2, `Should have >= 2 columns (territory + measure)`);
        assertTrue(result.rowCount >= 2, `Should have multiple territories, got ${result.rowCount}`);

        ctx.log(`Query returned ${result.rowCount} territory rows`);
        ctx.log(`Columns: ${result.columns.join(", ")}`);
        // Log first few rows
        for (let i = 0; i < Math.min(3, result.rows.length); i++) {
          ctx.log(`  Row ${i}: ${result.rows[i].join(", ")}`);
        }
      },
    },

    // ------------------------------------------------------------------
    // 6. QUERY: MULTIPLE MEASURES + MULTIPLE GROUPBY
    // ------------------------------------------------------------------
    {
      name: "Query: TotalSales + TotalQty grouped by category and territory",
      run: async (ctx) => {
        const conn = await createTestConnection("BiTest_MultiMeasure");
        await connectAndBind(conn.id);

        const result = await biQuery(conn.id, {
          measures: ["TotalSales", "TotalQty"],
          groupBy: [
            { table: "dim_product", column: "categoryname" },
            { table: "dim_territory", column: "territoryname" },
          ],
          filters: [],
        });

        // Should have 4 columns: category, territory, TotalSales, TotalQty
        assertTrue(result.columns.length >= 4, `Should have >= 4 columns, got ${result.columns.length}`);
        assertTrue(result.rowCount >= 2, `Should have multiple rows, got ${result.rowCount}`);

        ctx.log(`Multi-measure query: ${result.rowCount} rows x ${result.columns.length} cols`);
      },
    },

    // ------------------------------------------------------------------
    // 7. QUERY WITH FILTER
    // ------------------------------------------------------------------
    {
      name: "Query: TotalSales filtered by territory",
      run: async (ctx) => {
        const conn = await createTestConnection("BiTest_Filter");
        await connectAndBind(conn.id);

        // First get unfiltered total
        const allResult = await biQuery(conn.id, {
          measures: ["TotalSales"],
          groupBy: [],
          filters: [],
        });
        const totalAll = parseFloat(allResult.rows[0][0]!);

        // Filter: use territoryid which is a numeric FK column that definitely exists
        const filteredResult = await biQuery(conn.id, {
          measures: ["TotalSales"],
          groupBy: [],
          filters: [{
            table: "fact_sales",
            column: "territoryid",
            operator: ">",
            value: "0",
          }],
        });

        const totalFiltered = parseFloat(filteredResult.rows[0][0]!);
        assertTrue(totalFiltered > 0, `Filtered total should be > 0, got ${totalFiltered}`);
        assertTrue(totalFiltered <= totalAll, `Filtered (${totalFiltered}) should be <= total (${totalAll})`);

        ctx.log(`All: ${totalAll}, territoryid>0: ${totalFiltered}`);
      },
    },

    // ------------------------------------------------------------------
    // 8. INSERT QUERY RESULTS INTO GRID
    // ------------------------------------------------------------------
    {
      name: "Insert BI query results into spreadsheet grid",
      run: async (ctx) => {
        const conn = await createTestConnection("BiTest_Insert");
        await connectAndBind(conn.id);

        const queryReq: BiQueryRequest = {
          measures: ["TotalSales"],
          groupBy: [{ table: "dim_territory", column: "territoryname" }],
          filters: [],
        };

        const result = await biQuery(conn.id, queryReq);
        assertTrue(result.rowCount >= 2, "Should have data to insert");

        // Insert into grid
        const insertReq: BiInsertRequest = {
          connectionId: conn.id,
          sheetIndex: 0,
          startRow: A.row,
          startCol: A.col,
        };

        const inserted = await biInsertResult(insertReq, result, queryReq);
        assertTrue(inserted.endRow > inserted.startRow, "Should span multiple rows");

        ctx.log(`Inserted at ${inserted.startRow},${inserted.startCol} to ${inserted.endRow},${inserted.endCol}`);

        // Verify data appears in grid
        await ctx.settle();
        const headerCell = await ctx.getCell(A.row, A.col);
        expectNotNull(headerCell, "Header cell should exist in grid");
        assertTrue(
          headerCell!.display !== "",
          `Header should not be empty, got "${headerCell!.display}"`
        );

        // Check a data cell
        const dataCell = await ctx.getCell(A.row + 1, A.col);
        expectNotNull(dataCell, "Data cell should exist");
        assertTrue(dataCell!.display !== "", "Data cell should have content");

        ctx.log(`Header: ${headerCell!.display}, First data: ${dataCell!.display}`);
      },
    },

    // ------------------------------------------------------------------
    // 9. CONNECTION MANAGEMENT
    // ------------------------------------------------------------------
    {
      name: "Connection CRUD: create, list, get, delete",
      run: async (ctx) => {
        // Create two connections
        const conn1 = await createTestConnection("BiTest_Conn1");
        const conn2 = await createTestConnection("BiTest_Conn2");

        // List
        const all = await biGetConnections();
        assertTrue(all.length >= 2, `Should have >= 2 connections, got ${all.length}`);

        // Get specific
        const fetched = await biGetConnection(conn1.id);
        assertEqual(fetched.name, "BiTest_Conn1", "Name should match");
        assertEqual(fetched.modelPath, MODEL_PATH, "Model path should match");

        // Delete first
        await biDeleteConnection(conn1.id);
        const afterDelete = await biGetConnections();
        assertTrue(
          !afterDelete.some(c => c.id === conn1.id),
          "Deleted connection should not appear in list"
        );

        // Second still exists
        assertTrue(
          afterDelete.some(c => c.id === conn2.id),
          "Second connection should still exist"
        );
      },
    },

    // ------------------------------------------------------------------
    // 10. QUERY: COMPLEX MEASURE (KPI)
    // ------------------------------------------------------------------
    {
      name: "Query: computed KPI measures (AvgUnitPrice, OrderLineCount)",
      run: async (ctx) => {
        const conn = await createTestConnection("BiTest_KPI");
        await connectAndBind(conn.id);

        const result = await biQuery(conn.id, {
          measures: ["AvgUnitPrice", "OrderLineCount", "DistinctCustomers"],
          groupBy: [],
          filters: [],
        });

        assertTrue(result.columns.length >= 3, "Should have 3 measure columns");
        assertTrue(result.rowCount === 1, "Ungrouped should return 1 row");

        const avgPrice = parseFloat(result.rows[0][0]!);
        const lineCount = parseFloat(result.rows[0][1]!);
        const customers = parseFloat(result.rows[0][2]!);

        assertTrue(avgPrice > 0, `AvgUnitPrice should be > 0, got ${avgPrice}`);
        assertTrue(lineCount > 0, `OrderLineCount should be > 0, got ${lineCount}`);
        assertTrue(customers > 0, `DistinctCustomers should be > 0, got ${customers}`);

        ctx.log(`AvgPrice=${avgPrice}, Lines=${lineCount}, Customers=${customers}`);
      },
    },

    // ------------------------------------------------------------------
    // 11. QUERY: GROUPED BY MULTIPLE DIMENSIONS
    // ------------------------------------------------------------------
    {
      name: "Query: sales by product category and year",
      run: async (ctx) => {
        const conn = await createTestConnection("BiTest_CatYear");
        await connectAndBind(conn.id);

        const result = await biQuery(conn.id, {
          measures: ["TotalSales"],
          groupBy: [
            { table: "dim_product", column: "categoryname" },
            { table: "dim_date", column: "year" },
          ],
          filters: [],
        });

        assertTrue(result.rowCount >= 2, `Should have multiple rows, got ${result.rowCount}`);
        assertTrue(result.columns.length >= 3, "Should have category + year + measure");

        // Verify categories include known values
        const categories = result.rows.map(r => r[0]).filter(v => v !== null);
        ctx.log(`Categories found: ${[...new Set(categories)].join(", ")}`);
        assertTrue(categories.length > 0, "Should have category values");
      },
    },

    // ------------------------------------------------------------------
    // 12. FULL WORKFLOW: CONNECT + QUERY + INSERT + VERIFY
    // ------------------------------------------------------------------
    {
      name: "Workflow: load model, connect, query, insert, verify grid data",
      run: async (ctx) => {
        // Step 1: Create and connect
        const conn = await createTestConnection("BiTest_Workflow");
        await connectAndBind(conn.id);

        // Step 2: Query sales by territory
        const queryReq: BiQueryRequest = {
          measures: ["TotalSales", "TotalQty"],
          groupBy: [{ table: "dim_territory", column: "territoryname" }],
          filters: [],
        };
        const result = await biQuery(conn.id, queryReq);
        assertTrue(result.rowCount >= 2, "Should have territory data");

        // Step 3: Insert into grid
        const inserted = await biInsertResult(
          { connectionId: conn.id, sheetIndex: 0, startRow: A.row, startCol: A.col },
          result,
          queryReq,
        );

        // Step 4: Verify grid has data
        await ctx.settle();

        // Check header row
        const h1 = await ctx.getCell(A.row, A.col);
        expectNotNull(h1, "First header should exist");

        // Check we have multiple data rows
        let dataRows = 0;
        for (let i = 1; i <= result.rowCount; i++) {
          const cell = await ctx.getCell(A.row + i, A.col);
          if (cell && cell.display !== "") dataRows++;
        }
        assertTrue(dataRows >= 2, `Should have >= 2 data rows in grid, got ${dataRows}`);

        // Step 5: Verify the region is tracked
        const region = await biGetRegionAtCell(A.row + 1, A.col);
        expectNotNull(region, "BI region should be detected at inserted location");

        ctx.log(`Full workflow complete: ${dataRows} territory rows inserted into grid`);
      },
    },
  ],
};
