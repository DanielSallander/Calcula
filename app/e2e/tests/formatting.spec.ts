/**
 * Cell formatting E2E tests (Phase 2).
 *
 * Tests apply formatting via ribbon buttons (data-testid="fmt-{id}"),
 * then verify by reading the cell's style directly from the Tauri backend
 * via getCellStyleProp(). This is more reliable than checking ribbon button
 * state, which has async refresh timing issues.
 *
 * Uses cells in rows 30+ to avoid collision with Phase 1 tests.
 */
import { test, expect } from "../fixtures";

test.describe("Bold formatting", () => {
  test("toggles bold on a cell", async ({ grid }) => {
    await grid.setCellValue("A30", "BoldTest");
    await grid.clickCell("A30");
    await grid.toggleBold();

    expect(await grid.getCellStyleProp("A30", "bold")).toBe(true);
  });

  test("toggling bold twice removes it", async ({ grid }) => {
    await grid.setCellValue("B30", "UnboldTest");
    await grid.clickCell("B30");

    await grid.toggleBold();
    expect(await grid.getCellStyleProp("B30", "bold")).toBe(true);

    await grid.toggleBold();
    expect(await grid.getCellStyleProp("B30", "bold")).toBe(false);
  });

  test("bold persists after navigating away and back", async ({ grid }) => {
    await grid.setCellValue("C30", "Persistent");
    await grid.clickCell("C30");
    await grid.toggleBold();

    // Navigate away
    await grid.clickCell("D30");
    await grid.page.waitForTimeout(300);

    // Verify bold persisted via Tauri backend
    expect(await grid.getCellStyleProp("C30", "bold")).toBe(true);
  });

  test("bold applied via ribbon persists", async ({ grid }) => {
    await grid.setCellValue("E30", "RibbonBold");
    await grid.clickCell("E30");
    await grid.clickFormatButton("bold");

    // Navigate away and back
    await grid.clickCell("F30");
    await grid.page.waitForTimeout(300);

    expect(await grid.getCellStyleProp("E30", "bold")).toBe(true);
  });
});

test.describe("Italic formatting", () => {
  test("toggles italic on a cell", async ({ grid }) => {
    await grid.setCellValue("A31", "ItalicTest");
    await grid.clickCell("A31");
    await grid.toggleItalic();

    expect(await grid.getCellStyleProp("A31", "italic")).toBe(true);
  });

  test("italic persists after navigating away and back", async ({ grid }) => {
    await grid.setCellValue("B31", "PersistItalic");
    await grid.clickCell("B31");
    await grid.toggleItalic();

    await grid.clickCell("C31");
    await grid.page.waitForTimeout(300);

    expect(await grid.getCellStyleProp("B31", "italic")).toBe(true);
  });
});

test.describe("Underline formatting", () => {
  test("toggles underline on a cell", async ({ grid }) => {
    await grid.setCellValue("A32", "UnderlineTest");
    await grid.clickCell("A32");
    await grid.toggleUnderline();

    expect(await grid.getCellStyleProp("A32", "underline")).toBe(true);
  });

  test("toggling underline twice removes it", async ({ grid }) => {
    await grid.setCellValue("B32", "NoUnderline");
    await grid.clickCell("B32");

    await grid.toggleUnderline();
    expect(await grid.getCellStyleProp("B32", "underline")).toBe(true);

    await grid.toggleUnderline();
    // underline property is a string ("none" or "single"), check for falsy
    const underline = await grid.getCellStyleProp("B32", "underline");
    expect(underline).toBe(false);
  });
});

test.describe("Multiple formatting", () => {
  test("bold + italic on same cell", async ({ grid }) => {
    await grid.setCellValue("A33", "BoldItalic");
    await grid.clickCell("A33");
    await grid.toggleBold();
    await grid.toggleItalic();

    expect(await grid.getCellStyleProp("A33", "bold")).toBe(true);
    expect(await grid.getCellStyleProp("A33", "italic")).toBe(true);
  });

  test("bold + italic + underline on same cell", async ({ grid }) => {
    await grid.setCellValue("B33", "AllThree");
    await grid.clickCell("B33");
    await grid.toggleBold();
    await grid.toggleItalic();
    await grid.toggleUnderline();

    expect(await grid.getCellStyleProp("B33", "bold")).toBe(true);
    expect(await grid.getCellStyleProp("B33", "italic")).toBe(true);
    expect(await grid.getCellStyleProp("B33", "underline")).toBe(true);
  });

  test("multiple formats persist after navigating away", async ({ grid }) => {
    await grid.setCellValue("C33", "AllPersist");
    await grid.clickCell("C33");
    await grid.toggleBold();
    await grid.toggleItalic();

    // Navigate away
    await grid.clickCell("D33");
    await grid.page.waitForTimeout(300);

    // Check via backend
    expect(await grid.getCellStyleProp("C33", "bold")).toBe(true);
    expect(await grid.getCellStyleProp("C33", "italic")).toBe(true);
  });
});

test.describe("Formatting on formulas", () => {
  test("bold on a formula cell", async ({ grid }) => {
    await grid.setCellValue("A34", "10");
    await grid.setCellValue("B34", "=A34*2");
    await grid.clickCell("B34");
    await grid.toggleBold();

    expect(await grid.getCellStyleProp("B34", "bold")).toBe(true);
    // Formula should still be intact
    const formula = await grid.getCellFormulaBarText("B34");
    expect(formula.startsWith("=")).toBe(true);
  });
});

test.describe("Strikethrough formatting", () => {
  test("strikethrough via ribbon button", async ({ grid }) => {
    await grid.setCellValue("A35", "StrikeTest");
    await grid.clickCell("A35");
    await grid.clickFormatButton("strikethrough");

    expect(await grid.getCellStyleProp("A35", "strikethrough")).toBe(true);
  });

  test("strikethrough toggle off via ribbon", async ({ grid }) => {
    await grid.setCellValue("B35", "UnStrike");
    await grid.clickCell("B35");

    await grid.clickFormatButton("strikethrough");
    expect(await grid.getCellStyleProp("B35", "strikethrough")).toBe(true);

    await grid.clickFormatButton("strikethrough");
    expect(await grid.getCellStyleProp("B35", "strikethrough")).toBe(false);
  });
});

test.describe("Formatting state readback", () => {
  test("unformatted cell shows no active formats in ribbon", async ({ grid }) => {
    // Reset any lingering formatting
    await grid.clickCell("K29");
    await grid.page.waitForTimeout(300);
    if (await grid.isFormatActive("bold")) await grid.clickFormatButton("bold");
    if (await grid.isFormatActive("italic")) await grid.clickFormatButton("italic");
    if (await grid.isFormatActive("underline")) await grid.clickFormatButton("underline");
    if (await grid.isFormatActive("strikethrough")) await grid.clickFormatButton("strikethrough");

    await grid.setCellValue("K30", "Plain");
    await grid.clickCell("K30");
    await grid.page.waitForTimeout(1000);

    expect(await grid.isFormatActive("bold")).toBe(false);
    expect(await grid.isFormatActive("italic")).toBe(false);
    expect(await grid.isFormatActive("underline")).toBe(false);
    expect(await grid.isFormatActive("strikethrough")).toBe(false);
  });
});

test.describe("Formatting on range", () => {
  test("bold applies to entire selected range", async ({ grid }) => {
    await grid.setCellValue("A36", "R1");
    await grid.setCellValue("B36", "R2");
    await grid.setCellValue("C36", "R3");

    await grid.selectRange("A36", "C36");
    await grid.toggleBold();

    expect(await grid.getCellStyleProp("A36", "bold")).toBe(true);
    expect(await grid.getCellStyleProp("B36", "bold")).toBe(true);
    expect(await grid.getCellStyleProp("C36", "bold")).toBe(true);
  });
});
