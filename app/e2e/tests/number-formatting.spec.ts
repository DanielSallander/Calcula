/**
 * Number formatting E2E tests (Phase 3).
 *
 * Tests apply number formats via ribbon buttons and verify both the
 * style property (numberFormat) and the displayed value via Tauri API.
 *
 * The backend stores descriptive format names (e.g., "Percentage (0 decimals)")
 * rather than raw format codes. Tests match against these descriptive names.
 *
 * Uses cells in rows 40+ to avoid collision with Phase 1-2 tests.
 */
import { test, expect } from "../fixtures";

test.describe("Percentage format", () => {
  test("percent button formats a decimal as percentage", async ({ grid }) => {
    await grid.setCellValue("A40", "0.42");
    await grid.clickCell("A40");
    await grid.clickFormatButton("percentFormat");

    const fmt = await grid.getCellStyleStringProp("A40", "numberFormat");
    expect(fmt).toContain("Percentage");
    const display = await grid.getCellDisplayValue("A40");
    // Display should contain "42" and "%" (locale may add spaces)
    expect(display).toMatch(/42\s*%/);
  });

  test("percent format on integer", async ({ grid }) => {
    await grid.setCellValue("B40", "3");
    await grid.clickCell("B40");
    await grid.clickFormatButton("percentFormat");

    const display = await grid.getCellDisplayValue("B40");
    expect(display).toMatch(/300\s*%/);
  });

  test("percent format persists after navigating away", async ({ grid }) => {
    await grid.setCellValue("C40", "0.05");
    await grid.clickCell("C40");
    await grid.clickFormatButton("percentFormat");

    await grid.clickCell("D40");
    await grid.page.waitForTimeout(300);

    const fmt = await grid.getCellStyleStringProp("C40", "numberFormat");
    expect(fmt).toContain("Percentage");
  });
});

test.describe("Comma format", () => {
  test("comma button adds thousands separator", async ({ grid }) => {
    await grid.setCellValue("A41", "1234567");
    await grid.clickCell("A41");
    await grid.clickFormatButton("commaFormat");

    const fmt = await grid.getCellStyleStringProp("A41", "numberFormat");
    expect(fmt).toContain("separator");
    const display = await grid.getCellDisplayValue("A41");
    // Should have separators — locale may use comma, dot, or space
    expect(display).toMatch(/1[\s,.\u00a0]234[\s,.\u00a0]567/);
  });

  test("comma format on small number", async ({ grid }) => {
    await grid.setCellValue("B41", "42");
    await grid.clickCell("B41");
    await grid.clickFormatButton("commaFormat");

    const display = await grid.getCellDisplayValue("B41");
    expect(display).toBe("42");
  });
});

test.describe("Increase/decrease decimals", () => {
  test("increase decimal adds one decimal place", async ({ grid }) => {
    await grid.setCellValue("A42", "3.14");
    await grid.clickCell("A42");
    await grid.clickFormatButton("increaseDecimal");

    const fmt = await grid.getCellStyleStringProp("A42", "numberFormat");
    expect(fmt).toMatch(/1 decimal/i);
    const display = await grid.getCellDisplayValue("A42");
    // Should show at least one decimal place
    expect(display).toMatch(/3[.,]1/);
  });

  test("decrease decimal removes one decimal place", async ({ grid }) => {
    // First set a format with decimals
    await grid.setCellValue("B42", "3.14159");
    await grid.clickCell("B42");
    // Apply a format with decimals first
    await grid.clickFormatButton("increaseDecimal");
    await grid.page.waitForTimeout(300);

    // Now decrease
    await grid.clickCell("B42");
    await grid.clickFormatButton("decreaseDecimal");

    const display = await grid.getCellDisplayValue("B42");
    // Should have fewer decimal places than the raw value
    expect(display.length).toBeLessThan("3.14159".length);
  });

  test("multiple increase decimal clicks add more places", async ({ grid }) => {
    await grid.setCellValue("C42", "1");
    await grid.clickCell("C42");
    await grid.clickFormatButton("increaseDecimal");
    await grid.clickFormatButton("increaseDecimal");
    await grid.clickFormatButton("increaseDecimal");

    const fmt = await grid.getCellStyleStringProp("C42", "numberFormat");
    expect(fmt).toMatch(/3 decimal/i);
    const display = await grid.getCellDisplayValue("C42");
    // Should show "1.000" or "1,000" depending on locale
    expect(display).toMatch(/1[.,]000/);
  });
});

test.describe("Format applied to formula results", () => {
  test("percent format on formula cell", async ({ grid }) => {
    await grid.setCellValue("A43", "50");
    await grid.setCellValue("B43", "200");
    await grid.setCellValue("C43", "=A43/B43");
    await grid.clickCell("C43");
    await grid.clickFormatButton("percentFormat");

    const display = await grid.getCellDisplayValue("C43");
    expect(display).toMatch(/25\s*%/);

    // Formula should still be intact
    const formula = await grid.getCellFormulaBarText("C43");
    expect(formula.startsWith("=")).toBe(true);
  });

  test("comma format on formula cell", async ({ grid }) => {
    await grid.setCellValue("D43", "=1000*1000");
    await grid.clickCell("D43");
    await grid.clickFormatButton("commaFormat");

    const display = await grid.getCellDisplayValue("D43");
    expect(display).toMatch(/1[\s,.\u00a0]000[\s,.\u00a0]000/);
  });
});

test.describe("Format persistence", () => {
  test("number format survives cell re-edit", async ({ grid }) => {
    await grid.setCellValue("A44", "0.75");
    await grid.clickCell("A44");
    await grid.clickFormatButton("percentFormat");
    const display1 = await grid.getCellDisplayValue("A44");
    expect(display1).toMatch(/75\s*%/);

    // Re-edit the cell with a new value
    await grid.setCellValue("A44", "0.5");

    // Format should persist
    const fmt = await grid.getCellStyleStringProp("A44", "numberFormat");
    expect(fmt).toContain("Percentage");
    const display2 = await grid.getCellDisplayValue("A44");
    expect(display2).toMatch(/50\s*%/);
  });

  test("format applied to multiple cells via range", async ({ grid }) => {
    await grid.setCellValue("A45", "1000");
    await grid.setCellValue("B45", "2000");
    await grid.setCellValue("C45", "3000");

    await grid.selectRange("A45", "C45");
    await grid.clickFormatButton("commaFormat");

    const fmtA = await grid.getCellStyleStringProp("A45", "numberFormat");
    const fmtB = await grid.getCellStyleStringProp("B45", "numberFormat");
    const fmtC = await grid.getCellStyleStringProp("C45", "numberFormat");
    expect(fmtA).toContain("separator");
    expect(fmtB).toContain("separator");
    expect(fmtC).toContain("separator");
  });
});
