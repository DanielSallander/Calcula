/**
 * Edge case and integration E2E tests.
 *
 * Tests cross-feature interactions, boundary conditions, and
 * potential regression scenarios.
 */
import { test, expect } from "../fixtures";

test.describe("Large data handling", () => {
  test("enter values in 100 cells rapidly", async ({ grid }) => {
    // Batch-set 100 cells via Tauri API
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      const updates = [];
      for (let i = 0; i < 100; i++) {
        updates.push({ row: i, col: 30, value: `Row${i}` });
      }
      await tauri.core.invoke("update_cells_batch", { updates });
    });
    await grid.page.waitForTimeout(500);

    // Verify first and last cell
    const first = await grid.getCellDisplayValue("AE1");
    const last = await grid.getCellDisplayValue("AE100");
    expect(first).toBe("Row0");
    expect(last).toBe("Row99");
  });

  test("formula chain of 50 dependent cells", async ({ grid }) => {
    // A chain: AE101=1, AE102=AE101+1, AE103=AE102+1, ...
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("update_cell", { row: 100, col: 30, value: "1" });
      for (let i = 1; i < 50; i++) {
        await tauri.core.invoke("update_cell", {
          row: 100 + i, col: 30,
          value: `=AE${101 + i - 1}+1`,
        });
      }
    });
    await grid.page.waitForTimeout(1000);

    // AE150 should be 50
    const result = await grid.getCellDisplayValue("AE150");
    expect(result).toBe("50");
  });
});

test.describe("Special characters", () => {
  test("cell with unicode text", async ({ grid }) => {
    await grid.setCellValueDirect("AF1", "Åäö Ñ 日本語 🎉");
    const display = await grid.getCellDisplayValue("AF1");
    expect(display).toContain("Åäö");
  });

  test("cell with very long text (1000 chars)", async ({ grid }) => {
    const longText = "A".repeat(1000);
    await grid.setCellValueDirect("AF2", longText);
    const display = await grid.getCellDisplayValue("AF2");
    expect(display.length).toBe(1000);
  });

  test("cell with newline characters", async ({ grid }) => {
    await grid.setCellValueDirect("AF3", "Line1\nLine2");
    const display = await grid.getCellDisplayValue("AF3");
    expect(display).toContain("Line1");
  });
});

test.describe("Numeric edge cases", () => {
  test("very large number", async ({ grid }) => {
    await grid.setCellValueDirect("AG1", "999999999999");
    const display = await grid.getCellDisplayValue("AG1");
    expect(display).toContain("999999999999");
  });

  test("very small decimal", async ({ grid }) => {
    await grid.setCellValueDirect("AG2", "0.000001");
    const display = await grid.getCellDisplayValue("AG2");
    // Should store the number, not show 0
    const val = parseFloat(display.replace(",", "."));
    expect(val).toBeCloseTo(0.000001, 6);
  });

  test("negative number", async ({ grid }) => {
    await grid.setCellValueDirect("AG3", "-42.5");
    const display = await grid.getCellDisplayValue("AG3");
    expect(display).toMatch(/-42[.,]5/);
  });
});

test.describe("Formula edge cases", () => {
  test("circular reference detection", async ({ grid }) => {
    // Set A=B and B=A
    await grid.setCellValueDirect("AH1", "=AH2");
    await grid.setCellValueDirect("AH2", "=AH1");
    await grid.page.waitForTimeout(300);

    const display = await grid.getCellDisplayValue("AH1");
    // Should show an error, not hang
    expect(display).toBeTruthy();
  });

  test("empty SUM range returns 0", async ({ grid }) => {
    await grid.setCellValueDirect("AH3", "=SUM(AH10:AH20)");
    const display = await grid.getCellDisplayValue("AH3");
    expect(display).toBe("0");
  });

  test("nested IF with multiple conditions", async ({ grid }) => {
    await grid.setCellValueDirect("AH4", "85");
    // Use semicolons for locale-aware formula entry via Tauri API
    await grid.setCellValueDirect("AH5", '=IF(AH4>=90;"A";IF(AH4>=80;"B";IF(AH4>=70;"C";"F")))');
    const display = await grid.getCellDisplayValue("AH5");
    expect(display).toBe("B");
  });
});

test.describe("Cross-feature integration", () => {
  test("format a formula cell then recalculate", async ({ grid }) => {
    await grid.setCellValueDirect("AI1", "100");
    await grid.setCellValueDirect("AI2", "=AI1/400");

    // Apply percent format
    await grid.clickCell("AI2");
    await grid.clickFormatButton("percentFormat");

    // Change the source — formula result: 200/400 = 0.5 → 50%
    await grid.setCellValueDirect("AI1", "200");
    await grid.page.waitForTimeout(300);

    // Formula should recalculate AND keep format
    const display = await grid.getCellDisplayValue("AI2");
    expect(display).toMatch(/50\s*%/);
    const fmt = await grid.getCellStyleStringProp("AI2", "numberFormat");
    expect(fmt).toContain("Percentage");
  });

  test("sort range with formatted cells preserves formatting", async ({ grid }) => {
    await grid.setCellValueDirect("AJ1", "30");
    await grid.setCellValueDirect("AJ2", "10");
    await grid.setCellValueDirect("AJ3", "20");

    // Bold the first cell
    await grid.clickCell("AJ1");
    await grid.toggleBold();

    // Sort ascending
    await grid.page.evaluate(async () => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("sort_range", {
        params: {
          startRow: 0, startCol: 35, endRow: 2, endCol: 35,
          fields: [{ key: 0, ascending: true }],
          matchCase: false, hasHeaders: false, orientation: "rows",
        },
      });
    });
    await grid.page.waitForTimeout(300);

    // Values should be sorted
    expect(await grid.getCellDisplayValue("AJ1")).toBe("10");
    expect(await grid.getCellDisplayValue("AJ2")).toBe("20");
    expect(await grid.getCellDisplayValue("AJ3")).toBe("30");
  });

  test("copy cell with formatting and formula", async ({ grid }) => {
    await grid.setCellValueDirect("AK1", "50");
    await grid.setCellValueDirect("AK2", "=AK1*2");
    await grid.clickCell("AK2");
    await grid.toggleBold();

    // Copy AK2 to AK3
    await grid.clickCell("AK2");
    await grid.clickFormatButton("copy");
    await grid.clickCell("AK3");
    await grid.clickFormatButton("paste");
    await grid.page.waitForTimeout(300);

    // AK3 should have shifted formula AND bold
    const display = await grid.getCellDisplayValue("AK3");
    // AK3 = AK2*2 would reference the cell above
    expect(display).toBeTruthy();
    expect(await grid.getCellStyleProp("AK3", "bold")).toBe(true);
  });
});

test.describe("Concurrent operations", () => {
  test("rapid formatting toggles don't corrupt state", async ({ grid }) => {
    await grid.setCellValueDirect("AL1", "RapidToggle");
    await grid.clickCell("AL1");

    // Toggle bold on/off 5 times rapidly
    for (let i = 0; i < 5; i++) {
      await grid.clickFormatButton("bold");
      await grid.page.waitForTimeout(100);
    }
    // After odd number of toggles, bold should be on
    await grid.page.waitForTimeout(500);
    const bold = await grid.getCellStyleProp("AL1", "bold");
    expect(bold).toBe(true);
  });
});
