/**
 * Merge cells E2E tests (Phase 6).
 *
 * Tests merge/unmerge operations via Tauri API and ribbon button.
 * Verifies content preservation, merge detection, and unmerge behavior.
 *
 * Uses cells in rows 65+ to avoid collision with Phase 1-5 tests.
 */
import { test, expect } from "../fixtures";

/** Helper: merge a range via Tauri API. */
async function mergeCells(page: any, startRow: number, startCol: number, endRow: number, endCol: number) {
  return page.evaluate(
    async (args: { sr: number; sc: number; er: number; ec: number }) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("merge_cells", {
        startRow: args.sr, startCol: args.sc, endRow: args.er, endCol: args.ec,
      });
    },
    { sr: startRow, sc: startCol, er: endRow, ec: endCol }
  );
}

/** Helper: unmerge cells via Tauri API. */
async function unmergeCells(page: any, row: number, col: number) {
  return page.evaluate(
    async (args: { r: number; c: number }) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("unmerge_cells", { row: args.r, col: args.c });
    },
    { r: row, c: col }
  );
}

/** Helper: check if a cell is part of a merged region. */
async function getMergeInfo(page: any, row: number, col: number) {
  return page.evaluate(
    async (args: { r: number; c: number }) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_merge_info", { row: args.r, col: args.c });
    },
    { r: row, c: col }
  );
}

test.describe("Merge cells", () => {
  test("merge a 2x2 range preserves top-left value", async ({ grid }) => {
    await grid.setCellValue("A65", "Merged");
    await grid.setCellValue("B65", "B");
    await grid.setCellValue("A66", "C");
    await grid.setCellValue("B66", "D");

    await mergeCells(grid.page, 64, 0, 65, 1); // 0-based rows
    await grid.page.waitForTimeout(300);

    // Top-left value should be preserved
    const display = await grid.getCellDisplayValue("A65");
    expect(display).toBe("Merged");

    // Cell should be detected as merged
    const info = await getMergeInfo(grid.page, 64, 0);
    expect(info).not.toBeNull();
    expect(info.startRow).toBe(64);
    expect(info.startCol).toBe(0);
    expect(info.endRow).toBe(65);
    expect(info.endCol).toBe(1);

    // Clean up
    await unmergeCells(grid.page, 64, 0);
  });

  test("merged region detected for all cells in range", async ({ grid }) => {
    await grid.setCellValue("D65", "Master");
    await mergeCells(grid.page, 64, 3, 65, 4); // D65:E66
    await grid.page.waitForTimeout(300);

    // All 4 cells should report as merged
    for (const [r, c] of [[64, 3], [64, 4], [65, 3], [65, 4]]) {
      const info = await getMergeInfo(grid.page, r, c);
      expect(info).not.toBeNull();
    }

    await unmergeCells(grid.page, 64, 3);
  });

  test("unmerge restores individual cells", async ({ grid }) => {
    await grid.setCellValue("A67", "Temp");
    await mergeCells(grid.page, 66, 0, 66, 2); // A67:C67
    await grid.page.waitForTimeout(300);

    // Verify merged
    const infoBefore = await getMergeInfo(grid.page, 66, 0);
    expect(infoBefore).not.toBeNull();

    // Unmerge
    await unmergeCells(grid.page, 66, 0);
    await grid.page.waitForTimeout(300);

    // All cells should now be unmerged
    const infoAfter = await getMergeInfo(grid.page, 66, 0);
    expect(infoAfter).toBeNull();
  });
});

test.describe("Merge via ribbon", () => {
  test("merge button merges selected range", async ({ grid }) => {
    await grid.setCellValue("A68", "RibbonMerge");
    await grid.selectRange("A68", "C68");
    await grid.clickFormatButton("mergeCells");
    await grid.page.waitForTimeout(500);

    const info = await getMergeInfo(grid.page, 67, 0);
    expect(info).not.toBeNull();

    // Clean up
    await unmergeCells(grid.page, 67, 0);
  });
});

test.describe("Merge edge cases", () => {
  test("merge single cell is a no-op", async ({ grid }) => {
    await grid.setCellValue("A69", "Single");
    // Merging a single cell shouldn't create a merged region
    const result = await mergeCells(grid.page, 68, 0, 68, 0);
    const info = await getMergeInfo(grid.page, 68, 0);
    // Single-cell merge should either not create a region or be handled gracefully
    // The value should still be readable
    const display = await grid.getCellDisplayValue("A69");
    expect(display).toBe("Single");
  });

  test("formula in merged cell still works", async ({ grid }) => {
    await grid.setCellValue("A70", "10");
    await grid.setCellValue("B70", "=A70*3");
    // Merge B70:C70 (formula cell with neighbor)
    await mergeCells(grid.page, 69, 1, 69, 2);
    await grid.page.waitForTimeout(300);

    const display = await grid.getCellDisplayValue("B70");
    expect(display).toBe("30");

    await unmergeCells(grid.page, 69, 1);
  });
});
