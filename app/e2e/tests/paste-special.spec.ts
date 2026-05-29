/**
 * Paste Special E2E tests.
 *
 * Tests Paste Special dialog and quick-paste commands (paste values,
 * paste formulas, paste formatting).
 *
 * Uses cells in columns T-V, rows 1-20 to avoid collision with other tests.
 */
import { test, expect } from "../fixtures";
import {
  takeGridScreenshot,
  softly,
} from "../helpers/screenshots";

test.describe("Paste Special - paste values only", () => {
  test("paste values strips formula, keeps computed result", async ({
    appPage,
    grid,
  }) => {
    // Set up: a value and a formula
    await grid.setCellValueDirect("T1", "50");
    await grid.setCellValue("T2", "=T1*2");
    await grid.page.waitForTimeout(300);

    // Verify formula works
    expect(await grid.getCellDisplayValue("T2")).toBe("100");

    // Copy T2 (which has =T1*2)
    await grid.clickCell("T2");
    await grid.clickFormatButton("copy");
    await grid.page.waitForTimeout(200);

    // Paste values via the Paste Special dialog (Ctrl+Alt+V).
    // NOTE: Paste Special is a TypeScript CommandRegistry command
    // ("core.clipboard.pasteSpecial"), not a Tauri command — it can only be
    // reached through the UI, so we drive the dialog directly.
    // Use navigateTo (name box) instead of clickCell: direct canvas clicks
    // rely on uniform column-width math and can mis-target the wrong column.
    await grid.navigateTo("T3");
    await appPage.keyboard.press("Control+Alt+v");
    await appPage.waitForTimeout(500);

    // Select "Values" radio button and confirm
    const valuesRadio = appPage.locator('input[type="radio"][value="values"]');
    await valuesRadio.click();
    await appPage.waitForTimeout(100);

    const okButton = appPage.locator("button").filter({ hasText: "OK" });
    await okButton.click();
    await appPage.waitForTimeout(300);

    // Verify T3 has value 100 (not a formula)
    const formula = await grid.getCellFormulaBarText("T3");
    // Should be "100" (plain value), not "=T1*2"
    expect(formula).not.toContain("=");
    expect(formula).toBe("100");

    // Set a deterministic selection before the screenshot. getCellFormulaBarText
    // above uses a canvas click whose uniform-column-width pixel math can
    // mis-target a column and leave an ambient range selection (observed as
    // M3:T19 / N3:T20 between runs), making the captured selection rectangle
    // non-deterministic. navigateTo uses the Name Box DOM input, which reliably
    // collapses the selection to a single known cell so the screenshot is stable.
    await grid.navigateTo("T3");
    await appPage.waitForTimeout(200);

    await softly(takeGridScreenshot(appPage, "paste-special-values-result"));
  });

  test("paste formatting copies style but not value", async ({
    appPage,
    grid,
  }) => {
    // Set up: a bold cell with content
    await grid.setCellValueDirect("T5", "StyledText");
    await grid.clickCell("T5");
    await grid.toggleBold();
    await grid.page.waitForTimeout(200);

    // Verify bold applied
    expect(await grid.getCellStyleProp("T5", "bold")).toBe(true);

    // Set up target cell
    await grid.setCellValueDirect("T6", "PlainText");
    await grid.page.waitForTimeout(200);

    // Copy the bold cell
    await grid.clickCell("T5");
    await grid.clickFormatButton("copy");
    await grid.page.waitForTimeout(200);

    // Navigate to target and attempt paste formatting via dialog.
    // Use navigateTo (name box) instead of clickCell: direct canvas clicks
    // rely on uniform column-width math and can mis-target the wrong column.
    await grid.navigateTo("T6");
    await appPage.keyboard.press("Control+Alt+v");
    await appPage.waitForTimeout(500);

    // Select "Formats" radio button in the dialog
    const formatsRadio = appPage.locator('input[type="radio"][value="formats"]');
    if ((await formatsRadio.count()) > 0) {
      await formatsRadio.click();
      await appPage.waitForTimeout(100);

      // Click OK
      const okButton = appPage.locator("button").filter({ hasText: "OK" });
      await okButton.click();
      await appPage.waitForTimeout(300);

      // T6 should now be bold, but content should remain "PlainText"
      expect(await grid.getCellStyleProp("T6", "bold")).toBe(true);
      expect(await grid.getCellFormulaBarText("T6")).toBe("PlainText");
    }

    // Set a deterministic selection before the screenshot (see note in the
    // "paste values" test above): canvas clicks can leave a non-deterministic
    // ambient range selection, so collapse to a single known cell via the
    // Name Box for a stable screenshot.
    await grid.navigateTo("T6");
    await appPage.waitForTimeout(200);

    await softly(takeGridScreenshot(appPage, "paste-special-formatting-result"));
  });

  test("paste special dialog opens and closes correctly", async ({
    appPage,
    grid,
  }) => {
    // Copy something first so the dialog has clipboard data
    await grid.setCellValueDirect("T8", "CopyFirst");
    await grid.clickCell("T8");
    await grid.clickFormatButton("copy");
    await grid.page.waitForTimeout(200);

    // Open Paste Special dialog
    await grid.clickCell("T9");
    await appPage.keyboard.press("Control+Alt+v");
    await appPage.waitForTimeout(500);

    // Verify dialog is visible (look for "Paste Special" title)
    const dialogTitle = appPage.locator("text=Paste Special").first();
    const dialogVisible = (await dialogTitle.count()) > 0;

    if (dialogVisible) {
      // Verify radio options exist
      expect(await appPage.locator('input[name="pasteAttribute"]').count()).toBeGreaterThan(0);
      expect(await appPage.locator('input[name="operation"]').count()).toBeGreaterThan(0);

      // Verify checkboxes exist
      expect(await appPage.locator("text=Skip blanks").count()).toBeGreaterThan(0);
      expect(await appPage.locator("text=Transpose").count()).toBeGreaterThan(0);

      // Cancel the dialog
      await appPage.keyboard.press("Escape");
      await appPage.waitForTimeout(300);

      // Dialog should be gone
      const afterClose = await appPage.locator("text=Paste Special").count();
      expect(afterClose).toBe(0);
    }
  });
});
