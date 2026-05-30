/**
 * Row/Column Grouping E2E tests.
 *
 * Tests grouping operations (group, ungroup, collapse, expand) via Tauri API.
 * Uses cells in columns AA-AB, rows 1-20 to avoid conflicts with other tests.
 */
import { test, expect } from "../fixtures";
import {
  takeGridScreenshot,
  softly,
} from "../helpers/screenshots";

test.describe("Row Grouping", () => {
  test("group rows and verify outline", async ({ appPage, grid }) => {
    // Set up data in rows 1-5
    for (let i = 1; i <= 5; i++) {
      await grid.setCellValueDirect(`AA${i}`, `Row ${i}`);
    }
    await grid.page.waitForTimeout(200);

    // Group rows 1-3 (0-based: rows 0-2) via Tauri API
    const result: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("group_rows", {
        params: { startRow: 0, endRow: 2 },
      });
    });
    await grid.page.waitForTimeout(500);

    expect(result.success).toBe(true);

    await grid.navigateTo("AA1");
    await softly(takeGridScreenshot(appPage, "grouping-rows-grouped"));
  });

  test("collapse and expand row group", async ({ appPage, grid }) => {
    // Group rows 5-8 (0-based: rows 4-7)
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("group_rows", {
        params: { startRow: 4, endRow: 7 },
      });
    });
    await grid.page.waitForTimeout(500);

    // Collapse the group
    const collapseResult: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("collapse_row_group", { row: 7 });
    });
    await grid.page.waitForTimeout(500);

    expect(collapseResult.success).toBe(true);

    await grid.navigateTo("AA1");
    await softly(takeGridScreenshot(appPage, "grouping-rows-collapsed"));

    // Expand the group
    const expandResult: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("expand_row_group", { row: 7 });
    });
    await grid.page.waitForTimeout(500);

    expect(expandResult.success).toBe(true);

    await softly(takeGridScreenshot(appPage, "grouping-rows-expanded"));
  });

  test("ungroup rows", async ({ grid }) => {
    // Group rows 10-12 (0-based: rows 9-11)
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("group_rows", {
        params: { startRow: 9, endRow: 11 },
      });
    });
    await grid.page.waitForTimeout(300);

    // Ungroup the same rows
    const ungroupResult: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("ungroup_rows", { startRow: 9, endRow: 11 });
    });
    await grid.page.waitForTimeout(300);

    expect(ungroupResult.success).toBe(true);
  });
});

test.describe("Column Grouping", () => {
  test("group and ungroup columns", async ({ appPage, grid }) => {
    // Group columns AB-AD (0-based: cols 27-29)
    const groupResult: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("group_columns", {
        params: { startCol: 27, endCol: 29 },
      });
    });
    await grid.page.waitForTimeout(500);

    expect(groupResult.success).toBe(true);

    await grid.navigateTo("AB1");
    await softly(takeGridScreenshot(appPage, "grouping-columns-grouped"));

    // Ungroup
    const ungroupResult: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("ungroup_columns", { startCol: 27, endCol: 29 });
    });
    await grid.page.waitForTimeout(300);

    expect(ungroupResult.success).toBe(true);
  });
});
