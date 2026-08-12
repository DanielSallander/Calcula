/**
 * Visual regression tests for core grid features.
 *
 * These tests take screenshots at defined checkpoints and compare them
 * against golden baselines. On first run, baselines are created automatically.
 * On subsequent runs, pixel differences are detected and flagged.
 *
 * Update baselines: yarn playwright test --update-snapshots e2e/visual/
 */
import { test, expect } from "../fixtures";
import {
  resetToNewWorkbook,
  takeCheckpoint,
  takeGridScreenshot,
  takeRibbonScreenshot,
  takeStatusBarScreenshot,
} from "../helpers/screenshots";

test.describe("Core Visual Regression", () => {
  test("empty grid - default state", async ({ appPage }) => {
    // Reset to a clean workbook — prior functional tests leave data behind
    await resetToNewWorkbook(appPage);
    // Navigate to A1 to ensure consistent starting position
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(500);

    await takeCheckpoint(appPage, "core-empty-grid");
    await takeGridScreenshot(appPage, "core-empty-canvas");
    await takeRibbonScreenshot(appPage, "core-default-ribbon");
    await takeStatusBarScreenshot(appPage, "core-default-statusbar");
  });

  /**
   * The block these two tests photograph, and what each cell must hold once it
   * is written. Declared ONCE so the write and the verification cannot drift.
   */
  const DATA_BLOCK: Array<[ref: string, input: string, expected: string]> = [
    ["A1", "Name", "Name"],
    ["B1", "Value", "Value"],
    ["C1", "Total", "Total"],
    ["A2", "Alpha", "Alpha"],
    ["B2", "100", "100"],
    ["C2", "=B2*2", "200"],
    ["A3", "Beta", "Beta"],
    ["B3", "200", "200"],
    ["C3", "=B3*2", "400"],
    ["A4", "Gamma", "Gamma"],
    ["B4", "300", "300"],
    ["C4", "=SUM(B2:B4)", "600"],
  ];

  /**
   * Fail if the block is not EXACTLY what the golden is supposed to show.
   *
   * WHY THIS EXISTS. `grid.setCellValue` reaches its cell by computing a canvas
   * pixel from grid geometry, and that arithmetic drifts (measured elsewhere in
   * this suite: a range captured as M3:T19 on one run and N3:T20 on the next).
   * A write that lands one column over produces a grid that looks entirely
   * plausible and differs from the golden by a whole column — a diff the next
   * pass reads as a rendering regression. Twelve backend reads turn that into a
   * named failure at the point of the mistake.
   *
   * It also covers the formulas: C2/C3/C4 are the only cells here whose value
   * arrives from a recalculation, so asserting their RESULTS is what proves the
   * capture is not racing the round trip rather than merely hoping it is not.
   */
  async function expectDataBlock(grid: any): Promise<void> {
    for (const [ref, , expected] of DATA_BLOCK) {
      await expect
        .poll(async () => await grid.getCellDisplayValue(ref), {
          timeout: 10_000,
          message: `${ref} is not what this golden is supposed to photograph`,
        })
        .toBe(expected);
    }
  }

  test("grid with data - basic cell content", async ({ grid, appPage }) => {
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    for (const [ref, input] of DATA_BLOCK) {
      await grid.setCellValue(ref, input);
    }

    // The data is the subject of the picture, so it is asserted before the
    // picture is taken — including the three recalculated cells.
    await expectDataBlock(grid);

    // Park the selection on A1 through the NAME BOX, not `clickCell`. Same
    // reasoning as the editing-mode golden below: the Name Box is a real DOM
    // input that selects exactly A1 every time, where a canvas click computes a
    // pixel and can leave an ambient range selection behind. The selection
    // rectangle is the largest block of pixels in a grid capture, so recording
    // after a `clickCell` freezes one side of a coin flip into the golden.
    await grid.navigateTo("A1");
    expect(
      (await grid.getNameBoxValue()).toUpperCase(),
      "the golden is a picture of the block with A1 selected"
    ).toBe("A1");

    await takeGridScreenshot(appPage, "core-data-entry");
  });

  test("cell selection highlight", async ({ grid, appPage }) => {
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    // This test photographs the selection over the block the previous test
    // wrote. It does NOT write it, so it must not assume it: a run that starts
    // here (`--grep`, a retry, a reordering) would otherwise photograph an
    // empty grid and compare it against a golden full of data.
    await expectDataBlock(grid);

    // Single cell selection — via the Name Box, for the reason above.
    await grid.navigateTo("C3");
    expect((await grid.getNameBoxValue()).toUpperCase()).toBe("C3");
    await takeGridScreenshot(appPage, "core-selection-single");

    // Range selection. `selectRange` starts from a canvas click, so pin the
    // anchor with the Name Box first and let Shift+arrows do the extension —
    // the same keyboard path a user has, and one that cannot land on the wrong
    // cell. Assert the result before photographing it.
    await grid.navigateTo("A1");
    await grid.shiftArrowSelect(3, 2); // A1 -> C4
    await appPage.waitForTimeout(300);
    const selection = await appPage.evaluate(() => {
      const gs = (window as unknown as Record<string, any>).__CALCULA_GRID_STATE__;
      const s = gs?.selection;
      return s
        ? { startRow: s.startRow, startCol: s.startCol, endRow: s.endRow, endCol: s.endCol }
        : null;
    });
    expect(selection, "the grid state must expose the selection this golden shows").not.toBeNull();
    expect(
      {
        top: Math.min(selection!.startRow, selection!.endRow),
        left: Math.min(selection!.startCol, selection!.endCol),
        bottom: Math.max(selection!.startRow, selection!.endRow),
        right: Math.max(selection!.startCol, selection!.endCol),
      },
      "the golden is a picture of A1:C4 selected"
    ).toEqual({ top: 0, left: 0, bottom: 3, right: 2 });

    await takeGridScreenshot(appPage, "core-selection-range");
  });

  test("formula bar shows formula", async ({ grid, appPage }) => {
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    await grid.setCellValue("A1", "10");
    await grid.setCellValue("A2", "=A1+5");

    // Click the formula cell to show formula in bar
    await grid.clickCell("A2");
    await appPage.waitForTimeout(500);

    await takeCheckpoint(appPage, "core-formula-bar-display");
  });

  test("editing mode - inline editor visible", async ({ grid, appPage }) => {
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    await grid.setCellValue("A1", "Hello World");
    // `navigateTo`, NOT `clickCell`. This golden is a picture of the inline
    // editor, and `clickCell` computes a canvas pixel from uniform column-width
    // maths that drifts run to run — it can mis-target the column and leave an
    // ambient RANGE selection behind (measured: paste-special captured M3:T19 on
    // one run and N3:T20 on the next). The selection rectangle is the largest
    // block of pixels in a grid capture, so recording a baseline after a
    // clickCell freezes one side of that coin flip into the golden and the other
    // side fails forever. The Name Box is a real DOM input: it selects exactly
    // A1, every time, and it leaves focus on the spreadsheet container so F2
    // reaches the grid.
    await grid.navigateTo("A1");
    // Enter edit mode
    await appPage.keyboard.press("F2");
    await appPage.waitForTimeout(500);

    await takeGridScreenshot(appPage, "core-editing-mode");

    // Exit edit mode
    await appPage.keyboard.press("Escape");
  });
});

test.describe("Formatting Visual Regression", () => {
  test("bold/italic/underline rendering", async ({ grid, appPage }) => {
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    await grid.setCellValue("A1", "Normal");
    await grid.setCellValue("A2", "Bold");
    await grid.setCellValue("A3", "Italic");
    await grid.setCellValue("A4", "Underline");

    // Apply bold to A2
    await grid.clickCell("A2");
    await grid.toggleBold();

    // Apply italic to A3
    await grid.clickCell("A3");
    await grid.toggleItalic();

    // Apply underline to A4
    await grid.clickCell("A4");
    await grid.toggleUnderline();

    // Deselect to see clean rendering
    await grid.clickCell("B1");
    await appPage.waitForTimeout(500);

    await takeGridScreenshot(appPage, "fmt-bold-italic-underline");
  });

  test("number format rendering", async ({ grid, appPage }) => {
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    await grid.setCellValue("A1", "Format");
    await grid.setCellValue("B1", "Value");
    await grid.setCellValue("A2", "Number");
    await grid.setCellValueDirect("B2", "1234.5678");
    await grid.setCellValue("A3", "Percent");
    await grid.setCellValueDirect("B3", "0.75");
    await grid.setCellValue("A4", "Date");
    await grid.setCellValueDirect("B4", "45000");
    await grid.setCellValue("A5", "Negative");
    await grid.setCellValueDirect("B5", "-500");

    await grid.clickCell("A1");
    await appPage.waitForTimeout(500);

    await takeGridScreenshot(appPage, "fmt-number-formats");
  });

  test("alignment rendering", async ({ grid, appPage }) => {
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    await grid.setCellValue("A1", "Left");
    await grid.setCellValue("B1", "Center");
    await grid.setCellValue("C1", "Right");

    // Apply center to B1
    await grid.clickCell("B1");
    const centerBtn = appPage.locator("[data-testid='fmt-alignCenter']");
    if (await centerBtn.count() > 0) {
      await centerBtn.click();
      await appPage.waitForTimeout(300);
    }

    // Apply right to C1
    await grid.clickCell("C1");
    const rightBtn = appPage.locator("[data-testid='fmt-alignRight']");
    if (await rightBtn.count() > 0) {
      await rightBtn.click();
      await appPage.waitForTimeout(300);
    }

    await grid.clickCell("D1");
    await appPage.waitForTimeout(500);

    await takeGridScreenshot(appPage, "fmt-alignment");
  });
});

test.describe("Sheet Tab Visual Regression", () => {
  test("sheet tabs - default state", async ({ appPage }) => {
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    // Screenshot the bottom of the page where sheet tabs live
    await takeCheckpoint(appPage, "sheets-default-tabs");
  });
});

test.describe("Menu Visual Regression", () => {
  test("file menu open visual", async ({ grid, appPage }) => {
    await resetToNewWorkbook(appPage);
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    await grid.openMenu("File");
    await appPage.waitForTimeout(500);

    await takeCheckpoint(appPage, "menu-file-open");

    await grid.closeMenu();
  });

  test("edit menu open", async ({ grid, appPage }) => {
    await resetToNewWorkbook(appPage);
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    await grid.openMenu("Edit");
    await appPage.waitForTimeout(500);

    await takeCheckpoint(appPage, "menu-edit-open");

    await grid.closeMenu();
  });

  test("data menu open visual", async ({ grid, appPage }) => {
    await resetToNewWorkbook(appPage);
    await appPage.keyboard.press("Control+Home");
    await appPage.waitForTimeout(300);

    await grid.openMenu("Data");
    await appPage.waitForTimeout(500);

    await takeCheckpoint(appPage, "menu-data-open");

    await grid.closeMenu();
  });
});
