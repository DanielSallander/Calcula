/**
 * Sheet/Workbook Protection E2E tests.
 *
 * Tests protect/unprotect sheets, cell protection checks, and allow-edit ranges
 * via Tauri API commands.
 * Uses cells in columns AE-AF, rows 1-10 to avoid conflicts with other tests.
 */
import { test, expect } from "../fixtures";
import { takeGridScreenshot, softly } from "../helpers/screenshots";

test.describe("Sheet Protection", () => {
  test("protect and unprotect a sheet", async ({ appPage, grid }) => {
    // Set up some data
    await grid.setCellValueDirect("AE1", "Protected Data");
    await grid.setCellValueDirect("AE2", "100");
    await grid.page.waitForTimeout(200);

    // Initially sheet should not be protected
    const initialStatus: boolean = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("is_sheet_protected", {});
    });
    expect(initialStatus).toBe(false);

    // Protect the sheet
    const protectResult: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("protect_sheet", {
        params: { password: null },
      });
    });
    await grid.page.waitForTimeout(300);

    expect(protectResult.success).toBe(true);

    // Verify sheet is now protected
    const protectedStatus: boolean = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("is_sheet_protected", {});
    });
    expect(protectedStatus).toBe(true);

    await grid.navigateTo("AE1");
    await softly(takeGridScreenshot(appPage, "protection-sheet-protected"));

    // Unprotect the sheet
    const unprotectResult: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("unprotect_sheet", {});
    });
    await grid.page.waitForTimeout(300);

    expect(unprotectResult.success).toBe(true);

    // Verify sheet is unprotected again
    const afterUnprotect: boolean = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("is_sheet_protected", {});
    });
    expect(afterUnprotect).toBe(false);
  });

  test("cell edit check when sheet is protected", async ({ grid }) => {
    // Set up data and protect the sheet
    await grid.setCellValueDirect("AE3", "Locked Cell");
    await grid.page.waitForTimeout(200);

    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("protect_sheet", { params: { password: null } });
    });
    await grid.page.waitForTimeout(300);

    // Check if a cell can be edited (should be blocked by default)
    const editCheck: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("can_edit_cell", { row: 2, col: 30 });
    });

    // can_edit_cell returns ProtectionCheckResult { canEdit, reason }
    expect(editCheck.canEdit).toBe(false);

    // Clean up: unprotect the sheet
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("unprotect_sheet", {});
    });
    await grid.page.waitForTimeout(200);
  });

  test("protection status includes options", async ({ grid }) => {
    // Protect the sheet and check full status
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("protect_sheet", { params: { password: null } });
    });
    await grid.page.waitForTimeout(300);

    const status: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_protection_status", {});
    });

    expect(status).toBeDefined();
    expect(status.isProtected).toBe(true);

    // Clean up
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("unprotect_sheet", {});
    });
    await grid.page.waitForTimeout(200);
  });

  test("allow-edit range CRUD", async ({ appPage, grid }) => {
    // Add an allow-edit range
    const addResult: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("add_allow_edit_range", {
        params: {
          title: "Editable Area",
          startRow: 0,
          startCol: 30,
          endRow: 4,
          endCol: 31,
        },
      });
    });
    await grid.page.waitForTimeout(300);

    expect(addResult.success).toBe(true);

    // Get all allow-edit ranges
    const ranges: any[] = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_allow_edit_ranges", {});
    });

    expect(ranges.length).toBeGreaterThanOrEqual(1);
    const found = ranges.find((r: any) => r.title === "Editable Area");
    expect(found).toBeDefined();

    // Remove the allow-edit range
    const removeResult: any = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("remove_allow_edit_range", { title: "Editable Area" });
    });
    await grid.page.waitForTimeout(200);

    expect(removeResult.success).toBe(true);

    // Verify it's gone
    const rangesAfter: any[] = await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke("get_allow_edit_ranges", {});
    });
    const notFound = rangesAfter.find((r: any) => r.title === "Editable Area");
    expect(notFound).toBeUndefined();

    await grid.navigateTo("AE1");
    await softly(takeGridScreenshot(appPage, "protection-allow-edit-cleared"));
  });
});
