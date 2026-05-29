/**
 * Grid Rendering & Canvas E2E tests.
 *
 * Covers visual regression of the canvas-based grid: empty state, populated cells,
 * gridlines, headers, and rendering after formatting changes.
 */
import { test, expect } from "../fixtures";
import {
  takeGridScreenshot,
  takeCheckpoint,
  resetGrid,
  waitForGridStable,
  softly,
} from "../helpers/screenshots";

test.describe("Grid rendering visual regression", () => {
  test("empty grid renders correctly with headers and gridlines", async ({
    appPage,
    grid,
  }) => {
    await waitForGridStable(appPage);
    await softly(takeGridScreenshot(appPage, "empty-grid-default"));
    await softly(takeCheckpoint(appPage, "empty-grid-full-window"));
  });

  test("cells with text render correctly", async ({ appPage, grid }) => {
    await grid.setCellValue("A1", "Name");
    await grid.setCellValue("B1", "Value");
    await grid.setCellValue("A2", "Alpha");
    await grid.setCellValue("B2", "100");
    await grid.setCellValue("A3", "Beta");
    await grid.setCellValue("B3", "200");

    await grid.clickCell("A1");
    await waitForGridStable(appPage);
    await softly(takeGridScreenshot(appPage, "cells-with-text"));
  });

  test("formatted cells render correctly", async ({ appPage, grid }) => {
    await grid.setCellValue("A1", "Bold");
    await grid.setCellValue("A2", "Italic");
    await grid.setCellValue("A3", "Both");

    // Apply bold to A1
    await grid.clickCell("A1");
    await grid.toggleBold();

    // Apply italic to A2
    await grid.clickCell("A2");
    await grid.toggleItalic();

    // Apply both to A3
    await grid.clickCell("A3");
    await grid.toggleBold();
    await grid.toggleItalic();

    await grid.clickCell("A1");
    await waitForGridStable(appPage);
    await softly(takeGridScreenshot(appPage, "formatted-cells-bold-italic"));

    // Verify formatting was applied
    expect(await grid.getCellStyleProp("A1", "bold")).toBe(true);
    expect(await grid.getCellStyleProp("A2", "italic")).toBe(true);
    expect(await grid.getCellStyleProp("A3", "bold")).toBe(true);
    expect(await grid.getCellStyleProp("A3", "italic")).toBe(true);
  });

  test("grid renders after clearing cells", async ({ appPage, grid }) => {
    // Populate
    await grid.setCellValue("A1", "Before");
    await grid.setCellValue("B1", "Clear");
    await waitForGridStable(appPage);
    await softly(takeGridScreenshot(appPage, "before-clear"));

    // Clear B1
    await grid.clickCell("B1");
    await grid.delete();
    await waitForGridStable(appPage);
    await softly(takeGridScreenshot(appPage, "after-clear-b1"));

    // Verify B1 is empty
    const val = await grid.getCellFormulaBarText("B1");
    expect(val).toBe("");
  });
});
