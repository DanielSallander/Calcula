/**
 * Visual regression tests for cross-cutting user workflows.
 *
 * Each test simulates a real user scenario that exercises multiple features
 * together, taking screenshots at key checkpoints. This catches regressions
 * in feature interactions that isolated tests miss.
 *
 * IMPORTANT: All tests share the same app instance. Each test calls resetGrid()
 * at the start to clear leftover data from prior tests.
 */
import { test, expect } from "../fixtures";
import type { GridHelper } from "../helpers/grid";
import {
  takeCheckpoint,
  takeGridScreenshot,
  takeDialogScreenshot,
  resetGrid,
} from "../helpers/screenshots";

/**
 * Fail if the grid does not hold EXACTLY what the golden about to be taken is
 * supposed to photograph.
 *
 * WHY THIS EXISTS — measured, 2026-08-12, twice in one afternoon. `setCellValue`
 * drives the real editor with real keystrokes, and it intermittently loses
 * some: one cold run committed `ue` into B1 where `Value` was typed, and another
 * left `grid-workflow-table-complete` with C5 and D5 EMPTY and B5 holding 4450
 * (C5's total) — one lost Enter shifting a whole totals row. Both produced a
 * golden diff of a few hundred pixels in a text strip, which reads exactly like
 * a rendering regression and is not one.
 *
 * `core-visual.spec.ts` already learned this (`expectDataBlock`, "twelve backend
 * reads turn that into a named failure at the point of the mistake"). This file
 * photographed six goldens' worth of data and verified none of it. The reads go
 * through `getCellDisplayValue`, i.e. the backend, so they cannot agree with a
 * canvas that is merely stale.
 */
async function expectCells(
  grid: GridHelper,
  cells: Array<[ref: string, expected: string]>
): Promise<void> {
  const refs = cells.map(([ref]) => ref);
  const expected = Object.fromEntries(cells);
  // ONE round trip for the whole block, not one per cell. `build a formatted
  // data table` already sits at 22-23s against this project's 30s budget
  // (sixteen real editor round trips), so sixteen further `page.evaluate`s
  // apiece is the difference between a test and a timeout — measured: it timed
  // out at 30.2s on the first cold run after the per-cell version landed.
  await expect
    .poll(
      async () =>
        await grid.page.evaluate(async (list: string[]) => {
          const tauri = (window as unknown as Record<string, any>).__TAURI__;
          if (!tauri?.core?.invoke) throw new Error("Tauri API not available");
          const out: Record<string, string> = {};
          for (const ref of list) {
            const m = /^([A-Za-z]+)(\d+)$/.exec(ref)!;
            let col = 0;
            for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
            const cell = await tauri.core.invoke("get_cell", {
              row: Number(m[2]) - 1,
              col: col - 1,
            });
            out[ref] = cell?.display ?? "";
          }
          return out;
        }, refs),
      {
        timeout: 10_000,
        message:
          "the grid does not hold what this golden is supposed to photograph " +
          `(${refs.join(", ")})`,
      }
    )
    .toEqual(expected);
}

test.describe("Workflow: Data Entry & Formatting", () => {
  test("build a formatted data table", async ({ grid, appPage }) => {
    // SIXTEEN real editor round trips plus two bold applications. MEASURED
    // across four cold runs: 22.6s, 23.2s, 23.9s, 30.2s — i.e. the project's
    // 30s default is not a budget this test fits inside, and the run where it
    // did not was reported as a bare "Test timeout of 30000ms exceeded" with
    // nothing about the product in it. Raised here, on the one test that needs
    // it, rather than loosening the project default for the other seventeen.
    test.setTimeout(90_000);
    await resetGrid(appPage);

    // Step 1: Enter headers
    await grid.setCellValue("A1", "Product");
    await grid.setCellValue("B1", "Q1");
    await grid.setCellValue("C1", "Q2");
    await grid.setCellValue("D1", "Total");

    // Step 2: Bold the headers
    await grid.selectRange("A1", "D1");
    await grid.toggleBold();

    await expectCells(grid, [
      ["A1", "Product"],
      ["B1", "Q1"],
      ["C1", "Q2"],
      ["D1", "Total"],
    ]);
    await takeGridScreenshot(appPage, "workflow-table-headers-bold");

    // Step 3: Enter data
    await grid.setCellValue("A2", "Widget A");
    await grid.setCellValue("B2", "1500");
    await grid.setCellValue("C2", "2300");
    await grid.setCellValue("D2", "=B2+C2");
    await grid.setCellValue("A3", "Widget B");
    await grid.setCellValue("B3", "800");
    await grid.setCellValue("C3", "1200");
    await grid.setCellValue("D3", "=B3+C3");
    await grid.setCellValue("A4", "Widget C");
    await grid.setCellValue("B4", "3200");
    await grid.setCellValue("C4", "950");
    await grid.setCellValue("D4", "=B4+C4");

    // Step 4: Add totals row
    await grid.setCellValue("A5", "Total");
    await grid.setCellValue("B5", "=SUM(B2:B4)");
    await grid.setCellValue("C5", "=SUM(C2:C4)");
    await grid.setCellValue("D5", "=SUM(D2:D4)");

    // Bold the totals row
    await grid.selectRange("A5", "D5");
    await grid.toggleBold();

    // Deselect
    await grid.clickCell("F1");
    await appPage.waitForTimeout(500);

    // The whole table, including the four recalculated cells and the totals row
    // — the row a lost Enter actually corrupted.
    await expectCells(grid, [
      ["A2", "Widget A"], ["B2", "1500"], ["C2", "2300"], ["D2", "3800"],
      ["A3", "Widget B"], ["B3", "800"], ["C3", "1200"], ["D3", "2000"],
      ["A4", "Widget C"], ["B4", "3200"], ["C4", "950"], ["D4", "4150"],
      ["A5", "Total"], ["B5", "5500"], ["C5", "4450"], ["D5", "9950"],
    ]);
    await takeGridScreenshot(appPage, "workflow-table-complete");
  });
});

test.describe("Workflow: Formula Chain", () => {
  test("dependent formulas update correctly", async ({ grid, appPage }) => {
    await resetGrid(appPage);

    // Build a formula chain: A1 -> B1 -> C1 -> D1
    await grid.setCellValue("A1", "10");
    await grid.setCellValue("B1", "=A1*2");
    await grid.setCellValue("C1", "=B1+5");
    await grid.setCellValue("D1", "=C1^2");

    await grid.clickCell("A1");
    await appPage.waitForTimeout(500);
    await expectCells(grid, [["A1", "10"], ["B1", "20"], ["C1", "25"], ["D1", "625"]]);
    await takeGridScreenshot(appPage, "workflow-formula-chain-initial");

    // Change the source value via keyboard
    await grid.setCellValue("A1", "20");
    await appPage.waitForTimeout(500);

    await grid.clickCell("A1");
    await appPage.waitForTimeout(500);
    // The chain is asserted, not merely photographed. A capture taken while the
    // cascade is still in flight (or after a keystroke went missing) differs
    // from the golden in a text strip, which is indistinguishable from a
    // rendering regression when it is the only evidence.
    await expectCells(grid, [["A1", "20"], ["B1", "40"], ["C1", "45"], ["D1", "2025"]]);
    await takeGridScreenshot(appPage, "workflow-formula-chain-updated");
  });
});

test.describe("Workflow: Undo/Redo Chain", () => {
  test("undo restores previous visual state", async ({ grid, appPage }) => {
    await resetGrid(appPage);

    // Step 1: Enter data
    await grid.setCellValue("A1", "Before");
    await grid.clickCell("B1");
    await appPage.waitForTimeout(300);
    await expectCells(grid, [["A1", "Before"]]);
    await takeGridScreenshot(appPage, "workflow-undo-step1");

    // Step 2: Overwrite with new data
    await grid.setCellValue("A1", "After");
    await grid.clickCell("B1");
    await appPage.waitForTimeout(300);
    await expectCells(grid, [["A1", "After"]]);
    await takeGridScreenshot(appPage, "workflow-undo-step2");

    // Step 3: Undo should restore "Before"
    await grid.undo();
    await grid.clickCell("B1");
    await appPage.waitForTimeout(300);
    await expectCells(grid, [["A1", "Before"]]);
    await takeGridScreenshot(appPage, "workflow-undo-step3-restored");

    // Step 4: Redo should restore "After"
    await grid.redo();
    await grid.clickCell("B1");
    await appPage.waitForTimeout(300);
    await expectCells(grid, [["A1", "After"]]);
    await takeGridScreenshot(appPage, "workflow-undo-step4-redone");
  });
});

test.describe("Workflow: Multi-Sheet", () => {
  test("data entry across sheets", async ({ grid, appPage }) => {
    await resetGrid(appPage);

    // Enter data on first sheet
    await grid.setCellValue("A1", "Sheet1 Data");
    await grid.setCellValue("A2", "100");

    await expectCells(grid, [["A1", "Sheet1 Data"], ["A2", "100"]]);
    await takeCheckpoint(appPage, "workflow-multisheet-sheet1");

    // Note: Creating new sheets and cross-sheet formulas would require
    // more specific UI interaction helpers. This is a placeholder for
    // when sheet creation E2E helpers are available.
  });
});

test.describe("Workflow: Copy-Paste Roundtrip", () => {
  test("copy formatted cells and paste", async ({ grid, appPage }) => {
    await resetGrid(appPage);

    // Enter and format source data
    await grid.setCellValue("A1", "Source");
    await grid.clickCell("A1");
    await grid.toggleBold();

    await grid.setCellValue("A2", "123");
    await grid.setCellValue("A3", "456");

    // Copy range A1:A3
    await grid.selectRange("A1", "A3");
    await grid.copy();

    // Paste to C1
    await grid.clickCell("C1");
    await grid.paste();
    await appPage.waitForTimeout(500);

    // Deselect
    await grid.clickCell("E1");
    await appPage.waitForTimeout(300);

    await expectCells(grid, [
      ["A1", "Source"], ["A2", "123"], ["A3", "456"],
      ["C1", "Source"], ["C2", "123"], ["C3", "456"],
    ]);
    await takeGridScreenshot(appPage, "workflow-copy-paste-result");
  });
});

test.describe("Workflow: Keyboard-Only Data Entry", () => {
  test("enter data using only keyboard", async ({ grid, appPage }) => {
    await resetGrid(appPage);

    // Type in A1, Enter moves to A2, etc.
    await grid.typeAndEnter("Name");
    await grid.typeAndEnter("Alice");
    await grid.typeAndEnter("Bob");
    await grid.typeAndEnter("Charlie");

    // Navigate to B1 via Ctrl+Home then Right.
    //
    // WHY THIS IS ASSERTED RATHER THAN ASSUMED. Ctrl+Home has to survive
    // WebView2's key interception to reach the grid, and intermittently does
    // not. When it is swallowed the cursor stays at A5 (where the four Enters
    // left it), ArrowRight lands on B5, and the Score block is written to
    // B5:B8 instead of B1:B4 — a grid that looks plausible and differs from
    // the golden by five rows. That coin flip was observed in the wild and is
    // exactly the kind of nondeterminism a re-record silently bakes in.
    // Retry the shortcut until the Name Box confirms A1, then fail loudly.
    let landed = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      await grid.spreadsheet.focus();
      await appPage.keyboard.press("Control+Home");
      await appPage.waitForTimeout(250);
      landed = await grid.getNameBoxValue();
      if (landed.toUpperCase() === "A1") break;
    }
    expect(
      landed.toUpperCase(),
      "Ctrl+Home never reached the grid, so the data block would be written at " +
        "the wrong row and the golden would encode a drifted layout"
    ).toBe("A1");

    await grid.pressArrow("ArrowRight");
    expect(
      (await grid.getNameBoxValue()).toUpperCase(),
      "expected the keyboard cursor at B1 before entering the Score column"
    ).toBe("B1");

    await grid.typeAndEnter("Score");
    await grid.typeAndEnter("85");
    await grid.typeAndEnter("92");
    await grid.typeAndEnter("78");

    // Click away
    await grid.clickCell("D1");
    await appPage.waitForTimeout(500);

    await expectCells(grid, [
      ["A1", "Name"], ["A2", "Alice"], ["A3", "Bob"], ["A4", "Charlie"],
      ["B1", "Score"], ["B2", "85"], ["B3", "92"], ["B4", "78"],
    ]);
    await takeGridScreenshot(appPage, "workflow-keyboard-entry");
  });
});
