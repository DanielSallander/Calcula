/**
 * Clipboard E2E tests (Phase 4).
 *
 * Tests copy/cut/paste via ribbon buttons (which call the CommandRegistry)
 * to avoid WebView2 keyboard shortcut interception.
 *
 * Uses cells in rows 50+ to avoid collision with Phase 1-3 tests.
 */
import { test, expect } from "../fixtures";

test.describe("Copy and paste", () => {
  test("copy a cell and paste to another cell", async ({ grid }) => {
    await grid.setCellValue("A50", "CopyMe");
    await grid.clickCell("A50");
    await grid.clickFormatButton("copy");

    await grid.clickCell("B50");
    await grid.clickFormatButton("paste");

    expect(await grid.getCellFormulaBarText("B50")).toBe("CopyMe");
    // Source should still have the value
    expect(await grid.getCellFormulaBarText("A50")).toBe("CopyMe");
  });

  test("cut a cell and paste to another cell", async ({ grid }) => {
    await grid.setCellValue("A51", "CutMe");
    await grid.clickCell("A51");
    await grid.clickFormatButton("cut");

    await grid.clickCell("B51");
    await grid.clickFormatButton("paste");

    expect(await grid.getCellFormulaBarText("B51")).toBe("CutMe");
    // Source should be cleared after cut+paste
    expect(await grid.getCellFormulaBarText("A51")).toBe("");
  });

  test("paste overwrites existing content", async ({ grid }) => {
    await grid.setCellValue("A52", "New");
    await grid.setCellValue("B52", "Old");
    await grid.clickCell("A52");
    await grid.clickFormatButton("copy");

    await grid.clickCell("B52");
    await grid.clickFormatButton("paste");

    expect(await grid.getCellFormulaBarText("B52")).toBe("New");
  });

  test("copy a number preserves value", async ({ grid }) => {
    await grid.setCellValue("A53", "42");
    await grid.clickCell("A53");
    await grid.clickFormatButton("copy");

    await grid.clickCell("B53");
    await grid.clickFormatButton("paste");

    expect(await grid.getCellFormulaBarText("B53")).toBe("42");
  });
});

test.describe("Copy with formulas", () => {
  test("copy formula shifts relative references", async ({ grid }) => {
    await grid.setCellValue("A54", "10");
    await grid.setCellValue("A55", "20");
    await grid.setCellValue("B54", "=A54*2");
    await grid.clickCell("B54");
    await grid.clickFormatButton("copy");

    // Paste one row down: =A54*2 should become =A55*2
    await grid.clickCell("B55");
    await grid.clickFormatButton("paste");

    const formula = await grid.getEditingValue("B55");
    expect(formula).toMatch(/^=A55\*2$/i);
    const display = await grid.getCellDisplayValue("B55");
    expect(display).toBe("40");
  });

  test("copy formula shifts column references", async ({ grid }) => {
    await grid.setCellValue("C54", "5");
    await grid.setCellValue("D54", "=C54+1");
    await grid.clickCell("D54");
    await grid.clickFormatButton("copy");

    // Paste one column right: =C54+1 should become =D54+1
    await grid.clickCell("E54");
    await grid.clickFormatButton("paste");

    const formula = await grid.getEditingValue("E54");
    expect(formula).toMatch(/^=D54\+1$/i);
  });
});

test.describe("Copy range", () => {
  test("copy a range and paste preserves all values", async ({ grid }) => {
    await grid.setCellValue("A56", "R1C1");
    await grid.setCellValue("B56", "R1C2");
    await grid.setCellValue("A57", "R2C1");
    await grid.setCellValue("B57", "R2C2");

    await grid.selectRange("A56", "B57");
    await grid.clickFormatButton("copy");

    await grid.clickCell("D56");
    await grid.clickFormatButton("paste");

    expect(await grid.getCellFormulaBarText("D56")).toBe("R1C1");
    expect(await grid.getCellFormulaBarText("E56")).toBe("R1C2");
    expect(await grid.getCellFormulaBarText("D57")).toBe("R2C1");
    expect(await grid.getCellFormulaBarText("E57")).toBe("R2C2");
  });
});

test.describe("Copy formatting", () => {
  test("copy preserves bold formatting", async ({ grid }) => {
    await grid.setCellValue("A58", "BoldCopy");
    await grid.clickCell("A58");
    await grid.toggleBold();

    await grid.clickCell("A58");
    await grid.clickFormatButton("copy");

    await grid.clickCell("B58");
    await grid.clickFormatButton("paste");

    expect(await grid.getCellStyleProp("B58", "bold")).toBe(true);
    expect(await grid.getCellFormulaBarText("B58")).toBe("BoldCopy");
  });
});
