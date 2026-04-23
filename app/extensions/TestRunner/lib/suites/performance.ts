//! FILENAME: app/extensions/TestRunner/lib/suites/performance.ts
// PURPOSE: Performance test suite.
// CONTEXT: Measures rendering and operation speeds at scale to detect
//          regressions and ensure key operations complete within acceptable
//          time budgets.

import type { TestSuite } from "../types";
import { assertTrue } from "../assertions";
import { AREA_PERFORMANCE } from "../testArea";
import {
  sortRangeByColumn,
  applyNamedStyle,
  getNamedStyles,
} from "@api";
import { applyFormatting, clearRangeWithOptions } from "@api/lib";

const A = AREA_PERFORMANCE;

/**
 * Helper: clear a rectangular region by writing empty strings.
 * Uses clearRangeWithOptions for efficient bulk clearing.
 */
async function clearArea(
  ctx: { settle: () => Promise<void> },
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): Promise<void> {
  await clearRangeWithOptions(startRow, startCol, endRow, endCol, "all");
  await ctx.settle();
}

export const performanceSuite: TestSuite = {
  name: "Performance",
  description:
    "Measures operation speed at scale. Tests write large datasets, apply " +
    "formatting, sort, and verify operations complete within time budgets.",

  tests: [
    // ========================================================================
    // Test 1: Large data write (10K cells)
    // ========================================================================
    {
      name: "Perf: large data write (10K cells)",
      tags: ["performance"],
      async run(ctx) {
        const ROWS = 100;
        const COLS = 100;
        const updates: Array<{ row: number; col: number; value: string }> = [];
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            updates.push({
              row: A.row + r,
              col: A.col + c,
              value: String(r * COLS + c),
            });
          }
        }

        const start = performance.now();
        await ctx.setCells(updates);
        await ctx.settle();
        const elapsed = performance.now() - start;

        ctx.log(`Wrote ${ROWS * COLS} cells in ${elapsed.toFixed(0)}ms`);
        assertTrue(
          elapsed < 5000,
          `Should complete in <5000ms, took ${elapsed.toFixed(0)}ms`,
        );

        // Cleanup
        await clearArea(ctx, A.row, A.col, A.row + ROWS - 1, A.col + COLS - 1);
      },
    },

    // ========================================================================
    // Test 2: Formula evaluation at scale
    // ========================================================================
    {
      name: "Perf: formula evaluation (1K formulas)",
      tags: ["performance"],
      async run(ctx) {
        const COUNT = 1000;
        // Write 1000 value cells in column 0
        const valueUpdates: Array<{ row: number; col: number; value: string }> =
          [];
        for (let r = 0; r < COUNT; r++) {
          valueUpdates.push({
            row: A.row + r,
            col: A.col,
            value: String(r + 1),
          });
        }

        // Write 1000 SUM formulas in column 1, each referencing the value cell
        const formulaUpdates: Array<{
          row: number;
          col: number;
          value: string;
        }> = [];
        for (let r = 0; r < COUNT; r++) {
          const ref = A.ref(r, 0); // e.g. "K3851"
          formulaUpdates.push({
            row: A.row + r,
            col: A.col + 1,
            value: `=SUM(${ref},1)`,
          });
        }

        const start = performance.now();
        await ctx.setCells(valueUpdates);
        await ctx.setCells(formulaUpdates);
        await ctx.settle();
        const elapsed = performance.now() - start;

        ctx.log(
          `Wrote ${COUNT} values + ${COUNT} SUM formulas in ${elapsed.toFixed(0)}ms`,
        );
        assertTrue(
          elapsed < 3000,
          `Should complete in <3000ms, took ${elapsed.toFixed(0)}ms`,
        );

        // Cleanup
        await clearArea(ctx, A.row, A.col, A.row + COUNT - 1, A.col + 1);
      },
    },

    // ========================================================================
    // Test 3: Formatting at scale
    // ========================================================================
    {
      name: "Perf: formatting 1K cells (bold + color)",
      tags: ["performance"],
      async run(ctx) {
        const COUNT = 1000;
        // Write 1000 cells
        const updates: Array<{ row: number; col: number; value: string }> = [];
        const rows: number[] = [];
        const cols: number[] = [];
        for (let r = 0; r < COUNT; r++) {
          updates.push({
            row: A.row + r,
            col: A.col,
            value: `Item ${r}`,
          });
          rows.push(A.row + r);
          cols.push(A.col);
        }
        await ctx.setCells(updates);
        await ctx.settle();

        const start = performance.now();
        await applyFormatting(rows, cols, {
          bold: true,
          textColor: "#FF0000",
        });
        await ctx.settle();
        const elapsed = performance.now() - start;

        ctx.log(`Formatted ${COUNT} cells in ${elapsed.toFixed(0)}ms`);
        // Note: debug builds (unoptimized) are ~10-50x slower than release.
        // 15s threshold accommodates debug mode; release should be <1s.
        assertTrue(
          elapsed < 15000,
          `Should complete in <15000ms (debug), took ${elapsed.toFixed(0)}ms`,
        );

        // Cleanup
        await clearArea(ctx, A.row, A.col, A.row + COUNT - 1, A.col);
      },
    },

    // ========================================================================
    // Test 4: Sort performance
    // ========================================================================
    {
      name: "Perf: sort 5K rows",
      tags: ["performance"],
      async run(ctx) {
        const ROW_COUNT = 5000;
        // Write 5000 rows with pseudo-random numeric data
        const updates: Array<{ row: number; col: number; value: string }> = [];
        for (let r = 0; r < ROW_COUNT; r++) {
          // Deterministic pseudo-random value using a simple hash
          const val = ((r * 7919 + 104729) % 100000).toString();
          updates.push({
            row: A.row + r,
            col: A.col,
            value: val,
          });
        }
        await ctx.setCells(updates);
        await ctx.settle();

        const start = performance.now();
        await sortRangeByColumn(
          A.row,
          A.col,
          A.row + ROW_COUNT - 1,
          A.col,
          A.col,
          true, // ascending
          false, // no header
        );
        await ctx.settle();
        const elapsed = performance.now() - start;

        ctx.log(`Sorted ${ROW_COUNT} rows in ${elapsed.toFixed(0)}ms`);
        assertTrue(
          elapsed < 3000,
          `Should complete in <3000ms, took ${elapsed.toFixed(0)}ms`,
        );

        // Cleanup
        await clearArea(ctx, A.row, A.col, A.row + ROW_COUNT - 1, A.col);
      },
    },

    // ========================================================================
    // Test 5: Viewport cell retrieval at scale
    // ========================================================================
    {
      name: "Perf: viewport read (1K cells, 50-row window)",
      tags: ["performance"],
      async run(ctx) {
        const TOTAL = 1000;
        const VIEWPORT_ROWS = 50;
        // Write 1000 cells across 1000 rows
        const updates: Array<{ row: number; col: number; value: string }> = [];
        for (let r = 0; r < TOTAL; r++) {
          updates.push({
            row: A.row + r,
            col: A.col,
            value: `Data-${r}`,
          });
        }
        await ctx.setCells(updates);
        await ctx.settle();

        const start = performance.now();
        // Read a 50-row viewport window from the middle of the data
        const viewportStart = A.row + 475;
        await ctx.getCells(
          viewportStart,
          A.col,
          viewportStart + VIEWPORT_ROWS - 1,
          A.col,
        );
        const elapsed = performance.now() - start;

        ctx.log(
          `Read ${VIEWPORT_ROWS}-row viewport from ${TOTAL} cells in ${elapsed.toFixed(0)}ms`,
        );
        assertTrue(
          elapsed < 500,
          `Should complete in <500ms, took ${elapsed.toFixed(0)}ms`,
        );

        // Cleanup
        await clearArea(ctx, A.row, A.col, A.row + TOTAL - 1, A.col);
      },
    },

    // ========================================================================
    // Test 6: Batch cell read (scattered positions)
    // ========================================================================
    {
      name: "Perf: batch read scattered cells",
      tags: ["performance"],
      async run(ctx) {
        // Write cells at scattered positions across a 200x5 area
        const updates: Array<{ row: number; col: number; value: string }> = [];
        for (let r = 0; r < 200; r++) {
          for (let c = 0; c < 5; c++) {
            if ((r + c) % 3 === 0) {
              updates.push({
                row: A.row + r,
                col: A.col + c,
                value: `S-${r}-${c}`,
              });
            }
          }
        }
        await ctx.setCells(updates);
        await ctx.settle();

        const start = performance.now();
        // Read the entire range back
        await ctx.getCells(A.row, A.col, A.row + 199, A.col + 4);
        const elapsed = performance.now() - start;

        ctx.log(
          `Read scattered cells in 200x5 range in ${elapsed.toFixed(0)}ms`,
        );
        assertTrue(
          elapsed < 100,
          `Should complete in <100ms, took ${elapsed.toFixed(0)}ms`,
        );

        // Cleanup
        await clearArea(ctx, A.row, A.col, A.row + 199, A.col + 4);
      },
    },

    // ========================================================================
    // Test 7: Named styles application
    // ========================================================================
    {
      name: "Perf: apply named style to 100 cells",
      tags: ["performance"],
      async run(ctx) {
        const COUNT = 100;
        // Write 100 cells
        const updates: Array<{ row: number; col: number; value: string }> = [];
        const rows: number[] = [];
        const cols: number[] = [];
        for (let r = 0; r < COUNT; r++) {
          updates.push({
            row: A.row + r,
            col: A.col,
            value: `Cell ${r}`,
          });
          rows.push(A.row + r);
          cols.push(A.col);
        }
        await ctx.setCells(updates);
        await ctx.settle();

        // Get an available named style
        const styles = await getNamedStyles();
        if (styles.length === 0) {
          ctx.log("No named styles available, skipping timing assertion");
          await clearArea(ctx, A.row, A.col, A.row + COUNT - 1, A.col);
          return;
        }
        const styleName = styles[0].name;
        ctx.log(`Using named style: "${styleName}"`);

        const start = performance.now();
        await applyNamedStyle(styleName, rows, cols);
        await ctx.settle();
        const elapsed = performance.now() - start;

        ctx.log(
          `Applied named style to ${COUNT} cells in ${elapsed.toFixed(0)}ms`,
        );
        assertTrue(
          elapsed < 1000,
          `Should complete in <1000ms, took ${elapsed.toFixed(0)}ms`,
        );

        // Cleanup
        await clearArea(ctx, A.row, A.col, A.row + COUNT - 1, A.col);
      },
    },
  ],
};
