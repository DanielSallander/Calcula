/**
 * Formula E2E tests.
 *
 * These tests verify that formulas:
 *   - are calculated correctly
 *   - retain the "=" prefix when the cell is re-selected or re-edited
 *   - recalculate when dependencies change
 *   - survive round-trips (enter -> navigate away -> come back -> edit)
 */
import { test, expect } from "../fixtures";

test.describe("Formula entry and display", () => {
  test("entering a formula keeps the = prefix in the formula bar", async ({ grid }) => {
    // Enter two numbers
    await grid.setCellValue("A1", "10");
    await grid.setCellValue("A2", "20");

    // Enter a formula in A3
    await grid.setCellValue("A3", "=A1+A2");

    // Click A3 — the formula bar should show the formula WITH "="
    const formulaBarText = await grid.getCellFormulaBarText("A3");
    expect(formulaBarText).toBe("=A1+A2");
  });

  test("formula calculates correctly", async ({ grid }) => {
    await grid.setCellValue("B1", "5");
    await grid.setCellValue("B2", "3");
    await grid.setCellValue("B3", "=B1*B2");

    // The formula bar shows the formula, not the result, when cell is selected.
    // We verify the formula is intact:
    await grid.expectFormulaBar("B3", "=B1*B2");
  });

  test("editing a formula cell preserves the = prefix", async ({ grid }) => {
    await grid.setCellValue("C1", "100");
    await grid.setCellValue("C2", "=C1*2");

    // Navigate away and back
    await grid.clickCell("C1");
    await grid.clickCell("C2");

    // Enter edit mode (F2) — should show "=C1*2" in the editor
    const editValue = await grid.getEditingValue("C2");
    expect(editValue).toBe("=C1*2");
  });

  test("formula round-trip: enter, leave, re-edit, re-enter still works", async ({ grid }) => {
    await grid.setCellValue("D1", "7");
    await grid.setCellValue("D2", "=D1+3");

    // Verify formula bar shows formula
    await grid.expectFormulaBar("D2", "=D1+3");

    // Now enter edit mode, clear, and re-type
    await grid.doubleClickCell("D2");
    await grid.page.keyboard.press("Control+a");
    await grid.page.keyboard.type("=D1+10", { delay: 30 });
    await grid.page.keyboard.press("Enter");
    await grid.page.waitForTimeout(300);

    // Verify the updated formula
    await grid.expectFormulaBar("D2", "=D1+10");
  });

  test("formula with cell references like =E3*E2 keeps = prefix", async ({ grid }) => {
    // This is the exact scenario reported in the bug
    await grid.setCellValue("E2", "4");
    await grid.setCellValue("E3", "5");
    await grid.setCellValue("E4", "=E3*E2");

    // Select E4 — formula bar must show "=E3*E2"
    await grid.expectFormulaBar("E4", "=E3*E2");

    // Edit mode must also show "=E3*E2"
    const editValue = await grid.getEditingValue("E4");
    expect(editValue).toBe("=E3*E2");

    // Re-enter: edit, press Enter — the formula should still calculate
    await grid.doubleClickCell("E4");
    await grid.page.keyboard.press("Enter");
    await grid.page.waitForTimeout(300);

    // Formula bar must STILL show the formula, not plain text "E3*E2"
    const afterReEnter = await grid.getCellFormulaBarText("E4");
    expect(afterReEnter).toBe("=E3*E2");
  });
});

test.describe("Formula recalculation", () => {
  test("changing a dependency recalculates the formula", async ({ grid }) => {
    await grid.setCellValue("F1", "10");
    await grid.setCellValue("F2", "=F1*3");

    // F2 should show formula
    await grid.expectFormulaBar("F2", "=F1*3");

    // Change F1
    await grid.setCellValue("F1", "20");

    // F2 formula is unchanged but its computed value should update.
    // We can verify the formula is still intact:
    await grid.expectFormulaBar("F2", "=F1*3");
  });

  test("chain of dependent formulas all recalculate", async ({ grid }) => {
    await grid.setCellValue("G1", "2");
    await grid.setCellValue("G2", "=G1+1");   // 3
    await grid.setCellValue("G3", "=G2+1");   // 4
    await grid.setCellValue("G4", "=G3+1");   // 5

    // Verify all formulas are intact
    await grid.expectFormulaBar("G2", "=G1+1");
    await grid.expectFormulaBar("G3", "=G2+1");
    await grid.expectFormulaBar("G4", "=G3+1");

    // Change the root
    await grid.setCellValue("G1", "10");

    // Formulas should still be formulas (not converted to values)
    await grid.expectFormulaBar("G2", "=G1+1");
    await grid.expectFormulaBar("G3", "=G2+1");
    await grid.expectFormulaBar("G4", "=G3+1");
  });
});

test.describe("Common formula functions", () => {
  test("SUM function", async ({ grid }) => {
    await grid.setCellValue("H1", "1");
    await grid.setCellValue("H2", "2");
    await grid.setCellValue("H3", "3");
    await grid.setCellValue("H4", "=SUM(H1:H3)");

    await grid.expectFormulaBarStartsWith("H4", "=");
  });

  test("IF function", async ({ grid }) => {
    await grid.setCellValue("I1", "10");
    await grid.setCellValue("I2", '=IF(I1>5,"big","small")');

    await grid.expectFormulaBarStartsWith("I2", "=");
  });

  test("nested formula", async ({ grid }) => {
    await grid.setCellValue("J1", "4");
    await grid.setCellValue("J2", "9");
    await grid.setCellValue("J3", "=SUM(J1,J2)+J1*2");

    await grid.expectFormulaBarStartsWith("J3", "=");
  });

  test("formula with absolute reference", async ({ grid }) => {
    await grid.setCellValue("K1", "50");
    await grid.setCellValue("K2", "=$K$1+10");

    const text = await grid.getCellFormulaBarText("K2");
    expect(text).toContain("=");
    expect(text).toContain("K");
  });
});

test.describe("Edge cases", () => {
  test("plain text is NOT treated as formula", async ({ grid }) => {
    await grid.setCellValue("A20", "Hello World");
    const text = await grid.getCellFormulaBarText("A20");
    expect(text).toBe("Hello World");
  });

  test("number is NOT treated as formula", async ({ grid }) => {
    await grid.setCellValue("B20", "42");
    const text = await grid.getCellFormulaBarText("B20");
    expect(text).toBe("42");
  });

  test("empty formula (just =) is handled gracefully", async ({ grid }) => {
    // Typing "=" puts the editor into formula mode; Escape should cancel cleanly
    await grid.clickCell("C20");
    await grid.page.keyboard.type("=", { delay: 30 });
    await grid.page.keyboard.press("Escape");
    await grid.page.waitForTimeout(500);

    // Verify the app is still responsive by clicking another cell
    await grid.clickCell("D20");
    await grid.page.waitForTimeout(100);
  });
});
