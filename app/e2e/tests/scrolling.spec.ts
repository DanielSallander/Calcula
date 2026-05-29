/**
 * Scrolling & Virtualization E2E tests.
 *
 * Covers viewport scrolling via mouse wheel, name box navigation to distant
 * cells, scroll-to-cell behavior, and data integrity after scrolling.
 */
import { test, expect } from "../fixtures";
import {
  takeGridScreenshot,
  waitForGridStable,
  softly,
} from "../helpers/screenshots";

test.describe("Scrolling & Virtualization", () => {
  test("scroll down via mouse wheel changes viewport", async ({
    appPage,
    grid,
  }) => {
    // Put data at A1 so we know we're starting at the top
    await grid.setCellValue("A1", "Top");
    await waitForGridStable(appPage);
    await softly(takeGridScreenshot(appPage, "scroll-before"));

    // Scroll down significantly
    await grid.scrollWheel(500);
    await appPage.waitForTimeout(300);
    await waitForGridStable(appPage);
    await softly(takeGridScreenshot(appPage, "scroll-after-wheel-down"));

    // The name box should show we're no longer at row 1
    // Navigate back to A1 to verify scroll-to-cell
    await grid.navigateTo("A1");
    await appPage.waitForTimeout(200);
    expect(await grid.getNameBoxValue()).toBe("A1");
  });

  test("navigate to distant cell and verify data round-trip", async ({
    appPage,
    grid,
  }) => {
    // Set a value far away
    await grid.navigateTo("Z100");
    await appPage.waitForTimeout(200);
    expect(await grid.getNameBoxValue()).toBe("Z100");

    await grid.typeIntoCell("FarAway");
    await waitForGridStable(appPage);
    await softly(takeGridScreenshot(appPage, "scroll-distant-cell-z100"));

    // Navigate back to A1
    await grid.navigateTo("A1");
    await appPage.waitForTimeout(200);
    expect(await grid.getNameBoxValue()).toBe("A1");

    // Navigate back to Z100 and verify data persisted
    await grid.navigateTo("Z100");
    await appPage.waitForTimeout(200);
    await grid.expectFormulaBar("Z100", "FarAway");
  });

  test("scroll to very large row number", async ({ appPage, grid }) => {
    // Navigate to a very distant row to test virtualization
    await grid.navigateTo("A5000");
    await appPage.waitForTimeout(300);
    expect(await grid.getNameBoxValue()).toBe("A5000");

    await grid.typeIntoCell("Row5000");
    await waitForGridStable(appPage);
    await softly(takeGridScreenshot(appPage, "scroll-row-5000"));

    // Verify data
    await grid.navigateTo("A1");
    await appPage.waitForTimeout(200);
    await grid.navigateTo("A5000");
    await appPage.waitForTimeout(200);
    await grid.expectFormulaBar("A5000", "Row5000");
  });

  test("data at A1 is intact after scrolling far and back", async ({
    grid,
  }) => {
    await grid.setCellValue("A1", "Anchor");
    await grid.setCellValue("A2", "=A1&\" Point\"");

    // Scroll far away
    await grid.navigateTo("M500");
    await grid.page.waitForTimeout(200);

    // Come back
    await grid.navigateTo("A1");
    await grid.page.waitForTimeout(200);

    await grid.expectFormulaBar("A1", "Anchor");
    await grid.expectFormulaBar("A2", "Anchor Point");
  });
});
