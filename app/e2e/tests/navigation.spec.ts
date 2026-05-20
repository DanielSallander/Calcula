/**
 * Grid navigation E2E tests.
 *
 * Covers keyboard navigation, name box navigation, and selection.
 */
import { test, expect } from "../fixtures";

test.describe("Keyboard navigation", () => {
  test("arrow keys move the active cell", async ({ grid }) => {
    // Use name box navigation to ensure a known starting cell
    await grid.navigateTo("A1");

    // Right arrow -> B1
    await grid.page.keyboard.press("ArrowRight");
    await grid.page.waitForTimeout(100);
    expect(await grid.getNameBoxValue()).toBe("B1");

    // Down arrow -> B2
    await grid.page.keyboard.press("ArrowDown");
    await grid.page.waitForTimeout(100);
    expect(await grid.getNameBoxValue()).toBe("B2");

    // Left arrow -> A2
    await grid.page.keyboard.press("ArrowLeft");
    await grid.page.waitForTimeout(100);
    expect(await grid.getNameBoxValue()).toBe("A2");

    // Up arrow -> A1
    await grid.page.keyboard.press("ArrowUp");
    await grid.page.waitForTimeout(100);
    expect(await grid.getNameBoxValue()).toBe("A1");
  });

  test("Enter moves down after committing a value", async ({ grid }) => {
    await grid.navigateTo("A1");
    await grid.page.waitForTimeout(100);
    await grid.typeIntoCell("first");

    // After Enter, active cell should be A2
    expect(await grid.getNameBoxValue()).toBe("A2");
  });

  test("Tab moves right after committing a value", async ({ grid }) => {
    await grid.navigateTo("A1");
    await grid.page.waitForTimeout(100);
    await grid.page.keyboard.type("tabbed", { delay: 20 });
    await grid.page.keyboard.press("Tab");
    await grid.page.waitForTimeout(200);

    expect(await grid.getNameBoxValue()).toBe("B1");
  });

  test("Ctrl+Home goes to A1", async ({ grid }) => {
    await grid.navigateTo("E10");
    await grid.page.keyboard.press("Control+Home");
    await grid.page.waitForTimeout(200);

    expect(await grid.getNameBoxValue()).toBe("A1");
  });
});

test.describe("Name Box navigation", () => {
  test("typing a cell ref in the name box navigates to that cell", async ({ grid }) => {
    await grid.navigateTo("F15");
    expect(await grid.getNameBoxValue()).toBe("F15");
  });

  test("navigating to a far cell and back", async ({ grid }) => {
    await grid.navigateTo("Z100");
    expect(await grid.getNameBoxValue()).toBe("Z100");

    await grid.navigateTo("A1");
    expect(await grid.getNameBoxValue()).toBe("A1");
  });
});

test.describe("Cell selection", () => {
  test("clicking a cell shows its address in the name box", async ({ grid }) => {
    await grid.clickCell("C3");
    expect(await grid.getNameBoxValue()).toBe("C3");
  });

  test("shift-click selects a range", async ({ grid }) => {
    await grid.selectRange("A1", "C3");

    // The name box shows the selected range
    const nameBox = await grid.getNameBoxValue();
    expect(nameBox).toBe("A1:C3");
  });
});

test.describe("Sheet tabs", () => {
  test("sheet tab is visible and clickable", async ({ grid }) => {
    // There should be at least one sheet tab
    const tab = grid.page.locator("button[data-sheet-tab]").first();
    await expect(tab).toBeVisible();
  });
});
