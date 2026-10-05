/**
 * Number formatting E2E tests (Phase 3).
 *
 * Tests apply number formats via ribbon buttons and verify both the
 * style property (numberFormat) and the displayed value via Tauri API.
 *
 * The backend stores descriptive format names (e.g., "Percentage (0 decimals)")
 * rather than raw format codes. Tests match against these descriptive names.
 *
 * EXCEL'S NUMBER GROUP (2026-10-04). Comma Style is Excel's: Accounting with no
 * currency symbol and 2 decimals (the backend's `comma` preset, named
 * "Accounting (, 2 decimals...)"), no longer `#,##0`. Increase / Decrease
 * Decimal are the backend's `adjust_number_format_decimals`: the ACTIVE cell's
 * format plus or minus one decimal, keeping its kind; on General it starts from
 * the decimals the value SHOWS (3.14 -> 3, 3.14159 -> 5, 1 -> 0), as Excel does.
 *
 * Uses cells in rows 40+ to avoid collision with Phase 1-2 tests.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

/**
 * A decimal literal spelled the way the RUNNING app reads typed input.
 *
 * The app parses typed numbers with the Windows REGIONAL format (lib.rs), and
 * this harness runs sv-SE, where the decimal mark is a comma: "0.42" typed
 * there is TEXT, and a number format never touches text -- the percent button
 * then "fails" with a display of 0.42 and no product defect anywhere (memory:
 * e2e formula separator locale, the decimal half). Asking the backend for its
 * own separator keeps the spec true on an en-US machine too.
 */
async function typedDecimal(page: Page, value: string): Promise<string> {
  const settings = await page
    .evaluate(() =>
      (window as unknown as { __TAURI__: { core: { invoke: (c: string, a: object) => Promise<{ decimalSeparator?: string }> } } })
        .__TAURI__.core.invoke("get_locale_settings", {}),
    )
    .catch(() => null);
  return value.replace(".", settings?.decimalSeparator ?? ".");
}

/** Comma Style's display name: Accounting, EMPTY symbol, 2 decimals (any negative clause). */
const COMMA_STYLE_NAME = /^Accounting \(, 2 decimals/;

/** A digit-group separator in any locale the harness may run in (sv-SE uses a no-break space). */
const SEP = "[\\s,.\\u00a0\\u202f]";

test.describe("Percentage format", () => {
  test("percent button formats a decimal as percentage", async ({ grid }) => {
    await grid.setCellValue("A40", await typedDecimal(grid.page, "0.42"));
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
    await grid.setCellValue("C40", await typedDecimal(grid.page, "0.05"));
    await grid.clickCell("C40");
    await grid.clickFormatButton("percentFormat");

    await grid.clickCell("D40");
    await grid.page.waitForTimeout(300);

    const fmt = await grid.getCellStyleStringProp("C40", "numberFormat");
    expect(fmt).toContain("Percentage");
  });
});

test.describe("Comma format", () => {
  test("comma button applies Excel's Comma Style: thousands separator and two decimals", async ({ grid }) => {
    await grid.setCellValue("A41", "1234567");
    await grid.clickCell("A41");
    await grid.clickFormatButton("commaFormat");

    const fmt = await grid.getCellStyleStringProp("A41", "numberFormat");
    expect(fmt).toMatch(COMMA_STYLE_NAME);
    const display = await grid.getCellDisplayValue("A41");
    // Separators and the decimal mark follow the locale; the two decimals are Excel's.
    expect(display).toMatch(new RegExp(`1${SEP}234${SEP}567[.,]00`));
  });

  test("comma format on small number shows two decimals", async ({ grid }) => {
    await grid.setCellValue("B41", "42");
    await grid.clickCell("B41");
    await grid.clickFormatButton("commaFormat");

    const display = await grid.getCellDisplayValue("B41");
    // Accounting pads the value (a trailing space, Excel's `_-`), so trim first.
    expect(display.trim()).toMatch(/^42[.,]00$/);
  });
});

test.describe("Increase/decrease decimals", () => {
  test("increase decimal adds one decimal place to the decimals the value shows", async ({ grid }) => {
    await grid.setCellValue("A42", await typedDecimal(grid.page, "3.14"));
    await grid.clickCell("A42");
    await grid.clickFormatButton("increaseDecimal");

    // General shows 3.14 (two decimals), so Excel's Increase gives three.
    const fmt = await grid.getCellStyleStringProp("A42", "numberFormat");
    expect(fmt).toBe("Number (3 decimals)");
    const display = await grid.getCellDisplayValue("A42");
    expect(display).toMatch(/^3[.,]140$/);
  });

  test("decrease decimal removes one decimal place", async ({ grid }) => {
    // General shows 3.14159 (five decimals); Increase makes it six.
    await grid.setCellValue("B42", await typedDecimal(grid.page, "3.14159"));
    await grid.clickCell("B42");
    await grid.clickFormatButton("increaseDecimal");
    await grid.page.waitForTimeout(300);
    expect(await grid.getCellStyleStringProp("B42", "numberFormat")).toBe("Number (6 decimals)");

    // Now decrease: back to five, the step undone exactly.
    await grid.clickCell("B42");
    await grid.clickFormatButton("decreaseDecimal");

    expect(await grid.getCellStyleStringProp("B42", "numberFormat")).toBe("Number (5 decimals)");
    const display = await grid.getCellDisplayValue("B42");
    expect(display).toMatch(/^3[.,]14159$/);
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

  test("increase decimal keeps the format's kind: a percentage stays a percentage", async ({ grid }) => {
    await grid.setCellValue("D42", await typedDecimal(grid.page, "0.5"));
    await grid.clickCell("D42");
    await grid.clickFormatButton("percentFormat");
    expect(await grid.getCellStyleStringProp("D42", "numberFormat")).toBe("Percentage (0 decimals)");

    await grid.clickFormatButton("increaseDecimal");
    expect(await grid.getCellStyleStringProp("D42", "numberFormat")).toBe("Percentage (1 decimals)");
    expect(await grid.getCellDisplayValue("D42")).toMatch(/^50[.,]0\s*%$/);
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
    expect(display).toMatch(new RegExp(`1${SEP}000${SEP}000[.,]00`));
  });
});

test.describe("Format persistence", () => {
  test("number format survives cell re-edit", async ({ grid }) => {
    await grid.setCellValue("A44", await typedDecimal(grid.page, "0.75"));
    await grid.clickCell("A44");
    await grid.clickFormatButton("percentFormat");
    const display1 = await grid.getCellDisplayValue("A44");
    expect(display1).toMatch(/75\s*%/);

    // Re-edit the cell with a new value
    await grid.setCellValue("A44", await typedDecimal(grid.page, "0.5"));

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
    expect(fmtA).toMatch(COMMA_STYLE_NAME);
    expect(fmtB).toMatch(COMMA_STYLE_NAME);
    expect(fmtC).toMatch(COMMA_STYLE_NAME);
  });
});
