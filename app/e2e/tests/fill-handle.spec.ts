/**
 * Fill handle E2E tests (Phase 9).
 *
 * Tests fill down/right operations via Tauri API.
 * Uses setCellValueDirect() to avoid locale keyboard issues.
 *
 * Uses cells in columns Q-S, rows 1-10 to avoid collision.
 */
import { test, expect } from "../fixtures";

test.describe("Fill down", () => {
  test("fill down copies value to cells below", async ({ grid }) => {
    await grid.setCellValueDirect("Q1", "Hello");
    await grid.setCellValueDirect("Q2", "");
    await grid.setCellValueDirect("Q3", "");

    // Fill Q1 down to Q1:Q3
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("fill_range", {
        sourceStartRow: 0, sourceStartCol: 16, sourceEndRow: 0, sourceEndCol: 16,
        targetStartRow: 1, targetStartCol: 16, targetEndRow: 2, targetEndCol: 16,
      });
    });
    await grid.page.waitForTimeout(300);

    expect(await grid.getCellDisplayValue("Q2")).toBe("Hello");
    expect(await grid.getCellDisplayValue("Q3")).toBe("Hello");
  });

  test("fill down shifts formula references", async ({ grid }) => {
    await grid.setCellValueDirect("R1", "10");
    await grid.setCellValueDirect("R2", "20");
    await grid.setCellValueDirect("R3", "30");
    await grid.setCellValueDirect("S1", "=R1*2");

    // Fill S1 down to S1:S3
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("fill_range", {
        sourceStartRow: 0, sourceStartCol: 18, sourceEndRow: 0, sourceEndCol: 18,
        targetStartRow: 1, targetStartCol: 18, targetEndRow: 2, targetEndCol: 18,
      });
    });
    await grid.page.waitForTimeout(300);

    // S2 should have =R2*2 = 40, S3 should have =R3*2 = 60
    expect(await grid.getCellDisplayValue("S2")).toBe("40");
    expect(await grid.getCellDisplayValue("S3")).toBe("60");
  });
});

test.describe("Fill right", () => {
  test("fill right copies value to cells right", async ({ grid }) => {
    await grid.setCellValueDirect("Q5", "Data");

    // Fill Q5 right to Q5:S5
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("fill_range", {
        sourceStartRow: 4, sourceStartCol: 16, sourceEndRow: 4, sourceEndCol: 16,
        targetStartRow: 4, targetStartCol: 17, targetEndRow: 4, targetEndCol: 18,
      });
    });
    await grid.page.waitForTimeout(300);

    expect(await grid.getCellDisplayValue("R5")).toBe("Data");
    expect(await grid.getCellDisplayValue("S5")).toBe("Data");
  });

  test("fill right shifts column references", async ({ grid }) => {
    await grid.setCellValueDirect("Q7", "1");
    await grid.setCellValueDirect("R7", "2");
    await grid.setCellValueDirect("S7", "3");
    await grid.setCellValueDirect("Q8", "=Q7+10");

    // Fill Q8 right to Q8:S8
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("fill_range", {
        sourceStartRow: 7, sourceStartCol: 16, sourceEndRow: 7, sourceEndCol: 16,
        targetStartRow: 7, targetStartCol: 17, targetEndRow: 7, targetEndCol: 18,
      });
    });
    await grid.page.waitForTimeout(300);

    // R8 should be =R7+10 = 12, S8 should be =S7+10 = 13
    expect(await grid.getCellDisplayValue("R8")).toBe("12");
    expect(await grid.getCellDisplayValue("S8")).toBe("13");
  });
});

test.describe("Fill preserves formatting", () => {
  test("fill copies number format", async ({ grid }) => {
    await grid.setCellValueDirect("Q10", "0.5");

    // Apply percent format to Q10
    await grid.clickCell("Q10");
    await grid.clickFormatButton("percentFormat");

    // Fill Q10 down to Q11
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("fill_range", {
        sourceStartRow: 9, sourceStartCol: 16, sourceEndRow: 9, sourceEndCol: 16,
        targetStartRow: 10, targetStartCol: 16, targetEndRow: 10, targetEndCol: 16,
      });
    });
    await grid.page.waitForTimeout(300);

    // Q11 should also be formatted as percent
    const fmt = await grid.getCellStyleStringProp("Q11", "numberFormat");
    expect(fmt).toContain("Percentage");
  });
});
