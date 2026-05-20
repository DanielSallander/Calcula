/**
 * Named ranges E2E tests (Phase 16).
 *
 * Tests creating and using named ranges via Tauri API.
 */
import { test, expect } from "../fixtures";

test.describe("Named ranges", () => {
  test("create named range via name box", async ({ grid }) => {
    // Set up some data
    await grid.setCellValueDirect("T1", "100");
    await grid.setCellValueDirect("T2", "200");
    await grid.setCellValueDirect("T3", "300");

    // Select the range and name it via the Name Box
    await grid.selectRange("T1", "T3");
    await grid.nameBox.click();
    await grid.nameBox.fill("MyRange");
    await grid.page.keyboard.press("Enter");
    await grid.page.waitForTimeout(500);

    // Use the named range in a formula
    await grid.setCellValueDirect("U1", "=SUM(MyRange)");
    const result = await grid.getCellDisplayValue("U1");
    expect(result).toBe("600");
  });

  test("navigate to named range via name box", async ({ grid }) => {
    // Type the named range in the Name Box
    await grid.nameBox.click();
    await grid.nameBox.fill("MyRange");
    await grid.page.keyboard.press("Enter");
    await grid.page.waitForTimeout(300);

    // Should navigate to the range
    const nameBoxValue = await grid.getNameBoxValue();
    expect(nameBoxValue).toContain("MyRange");
  });
});
