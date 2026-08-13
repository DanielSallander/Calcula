//! FILENAME: app/e2e/journeys/orphaned-sheet-state.spec.ts
// PURPOSE: Prove, on the RUNNING app, the three defects this pass closed:
//            * BUG-0005 — a sheet structural change must not leave a queued undo
//              entry aimed at a DIFFERENT sheet than the one it was recorded on;
//            * BUG-0040 — removing a table's AutoFilter must survive save/reload;
//            * BUG-0041 — per-sheet state belonging to a DELETED sheet must not
//              reappear on another sheet after save/reload.
//
// WHY LIVE, WHEN ALL THREE ALREADY HAVE RUST TESTS
//   The unit tests pin the mechanisms in isolation: two id<->index helpers, one
//   command body, one undo arm. Every one of these bugs, though, is a
//   COMPOSITION — a frontend that saves on an event, a cascade that runs before
//   it, a load path that reconstructs derived state, a serialiser in between. A
//   test that calls one of those four in isolation cannot see the seam the bug
//   actually lived in. So these drive the real app: the real tab bar, the real
//   context menu, the real `save_file` / `open_file`, and a real WebView reload
//   between the write and the read.
//
// EVERY ASSERTION HERE HAS A POSITIVE CONTROL, AND THE CONTROLS COME FIRST.
//   The register records an acceptance test that passed on a demonstrably broken
//   build because its probe read a cell the two documents agreed about. Two
//   habits guard against repeating that:
//
//     1. THE WRONG-SHEET OUTCOME IS ASSERTED BEFORE THE RIGHT ONE. In the
//        BUG-0005 test the exact value a mis-aimed undo would write is planted
//        on the victim sheet first, and the probe is required to REPORT it.
//        Only then is the sentinel restored and the real assertion made. If the
//        reader could not see a wrong-sheet write, the test fails while saying
//        so, instead of passing quietly.
//     2. EVERY "it is gone" HAS AN "and here is the case where it stays". A fix
//        that simply dropped all sparklines, or all AutoFilters, would satisfy
//        the negative half of each test and destroy the feature; the paired
//        control fails it.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import type { GridHelper } from "../helpers/grid";

const TMP_DIR = path.join(os.tmpdir(), "calcula-orphaned-sheet-state");

function tmpFile(name: string): string {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  return path.join(TMP_DIR, `${name}-${process.pid}-${Date.now()}.cala`);
}

// ---------------------------------------------------------------------------
// Backend / file helpers (same shapes as hidden-rows-persistence.spec.ts)
// ---------------------------------------------------------------------------

async function invokeBackend<T>(page: Page, cmd: string, args: unknown = {}): Promise<T> {
  return page.evaluate(
    async ({ cmd, args }) => {
      const tauri = (window as any).__TAURI__;
      return (await tauri.core.invoke(cmd, args)) as unknown;
    },
    { cmd, args },
  ) as Promise<T>;
}

async function wipeWorkbook(page: Page): Promise<void> {
  await invokeBackend(page, "new_file", {});
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("dimensions:refresh"));
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await page.waitForTimeout(900);
}

async function saveTo(page: Page, filePath: string): Promise<void> {
  const err = await page.evaluate(async (p) => {
    const tauri = (window as any).__TAURI__;
    try {
      await tauri.core.invoke("save_file", { path: p });
      return null;
    } catch (e) {
      return String(e);
    }
  }, filePath);
  expect(err, `save_file must succeed for ${filePath}`).toBeNull();
}

/**
 * Reopen the way File > Open does — `open_file` then a full WebView reload.
 * The reload is the point: the frontend keeps NO memory across it, so anything
 * present afterwards came from the backend, which came from the file.
 */
async function openAndReload(page: Page, filePath: string): Promise<void> {
  const err = await page.evaluate(async (p) => {
    const tauri = (window as any).__TAURI__;
    try {
      await tauri.core.invoke("open_file", { path: p });
      return null;
    } catch (e) {
      return String(e);
    }
  }, filePath);
  expect(err, `open_file must succeed for ${filePath}`).toBeNull();

  await page.evaluate(() => window.location.reload());
  await page.waitForSelector("[data-focus-container='spreadsheet']", {
    state: "visible",
    timeout: 60_000,
  });
  await page.waitForTimeout(2_500);
}

// ---------------------------------------------------------------------------
// Sheet gestures through the REAL UI
// ---------------------------------------------------------------------------

async function sheetNames(page: Page): Promise<string[]> {
  const res = await invokeBackend<any>(page, "get_sheets", {});
  return (res.sheets ?? []).map((s: any) => String(s.name));
}

async function addSheetViaButton(page: Page): Promise<void> {
  await page.locator('button[title="Add new sheet"]').click({ force: true });
  await page.waitForTimeout(1_100);
}

async function clickSheetTab(page: Page, index: number): Promise<void> {
  const tab = page.locator(`button[data-sheet-tab="${index}"]`);
  await expect(tab).toBeVisible({ timeout: 5_000 });
  await tab.click();
  await page.waitForTimeout(900);
}

/** Move a sheet one place left through the real tab context menu. */
async function moveSheetLeftViaUI(page: Page, index: number): Promise<void> {
  const tab = page.locator(`button[data-sheet-tab="${index}"]`);
  await tab.click({ button: "right" });
  await page.waitForTimeout(600);
  await page.getByText("Move Left", { exact: true }).first().click();
  await page.waitForTimeout(1_200);
}

/** Delete a sheet through the real tab context menu and its confirmation. */
async function deleteSheetViaUI(page: Page, index: number): Promise<void> {
  const tab = page.locator(`button[data-sheet-tab="${index}"]`);
  await tab.click({ button: "right" });
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Delete", exact: true }).first().click();
  await page.waitForTimeout(700);
  await expect(
    page.locator("text=Are you sure you want to delete"),
    "the sheet-delete confirmation must appear",
  ).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).last().click();
  await page.waitForTimeout(1_800);
}

/**
 * A1's value as the USER sees it: switch to the sheet through the tab bar, put
 * the cursor on the cell, and read the formula bar the app painted.
 */
async function readA1OnSheet(page: Page, grid: GridHelper, sheetIndex: number): Promise<string> {
  await clickSheetTab(page, sheetIndex);
  await grid.clickCell("A1");
  await page.waitForTimeout(250);
  return (await grid.getFormulaBarValue()).trim();
}

// ===========================================================================
// BUG-0005 — a renumbered sheet must not receive another sheet's undo
// ===========================================================================

test.describe("A sheet structural change never aims an undo at the wrong sheet (BUG-0005)", () => {
  test("renumbering sheets after an edit leaves every sheet's own value intact", async ({ grid }) => {
    const page = grid.page;
    await wipeWorkbook(page);

    // Three sheets: the edit will be recorded on index 2, and the move will
    // then make index 2 mean a DIFFERENT sheet.
    await addSheetViaButton(page);
    await addSheetViaButton(page);
    expect(await sheetNames(page), "three sheets to renumber between").toHaveLength(3);

    const VICTIM = 1; // Sheet2 — the sheet a mis-aimed undo would land on
    const EDITED = 2; // Sheet3 — the sheet the edit is really recorded on

    const ORIGINAL = "ORIGINAL-ON-SHEET3";
    const EDITED_VALUE = "EDITED-ON-SHEET3";
    const SENTINEL = "SENTINEL-DO-NOT-TOUCH";

    // --- the edit whose undo entry is the hazard -----------------------------
    await clickSheetTab(page, EDITED);
    await grid.clickCell("A1");
    await grid.typeAndEnter(ORIGINAL);
    await page.waitForTimeout(400);
    await grid.clickCell("A1");
    await grid.typeAndEnter(EDITED_VALUE);
    await page.waitForTimeout(400);
    expect(
      await readA1OnSheet(page, grid, EDITED),
      "precondition: the edit registered",
    ).toBe(EDITED_VALUE);

    // --- POSITIVE CONTROL, BEFORE THE REAL ASSERTION ------------------------
    // Plant on the victim sheet the EXACT value a mis-aimed undo would write,
    // and require the probe to report it. Without this step, the assertion at
    // the end ("the victim still holds its sentinel") could pass because the
    // reader is blind rather than because nothing was written.
    await clickSheetTab(page, VICTIM);
    await grid.clickCell("A1");
    await grid.typeAndEnter(ORIGINAL);
    await page.waitForTimeout(400);
    expect(
      await readA1OnSheet(page, grid, VICTIM),
      "THE WRONG-SHEET OUTCOME MUST BE VISIBLE TO THIS PROBE. If a mis-aimed " +
        "undo wrote ORIGINAL onto the victim sheet, this is exactly what the " +
        "final assertion would have to see and reject.",
    ).toBe(ORIGINAL);

    // Now replace it with a value no undo entry in this workbook carries, so
    // the final assertion is positive rather than an absence.
    await clickSheetTab(page, VICTIM);
    await grid.clickCell("A1");
    await grid.typeAndEnter(SENTINEL);
    await page.waitForTimeout(400);
    expect(await readA1OnSheet(page, grid, VICTIM)).toBe(SENTINEL);

    // --- the structural change that renumbers the indices -------------------
    // Sheet3 moves to index 1; the victim becomes index 2 — the index the
    // queued entry names.
    await moveSheetLeftViaUI(page, EDITED);
    const namesAfterMove = await sheetNames(page);
    expect(namesAfterMove, "the move must actually have reordered the tabs").toEqual([
      "Sheet1",
      "Sheet3",
      "Sheet2",
    ]);

    // --- the gesture --------------------------------------------------------
    await clickSheetTab(page, 0);
    await grid.undo();
    await page.waitForTimeout(1_200);

    // --- THE SAFETY PROPERTY: nothing landed on a sheet nobody edited -------
    expect(
      await readA1OnSheet(page, grid, 2),
      "Sheet2 is at index 2 now, which is the index the queued entry named. " +
        "Its own value must be untouched — a value arriving here is the whole " +
        "defect: an undo writing onto a sheet the user never edited, silently.",
    ).toBe(SENTINEL);

    // --- THE PARITY PROPERTY: the structural change ended the history -------
    // Excel does not make a workbook-structure change undoable, and ending the
    // history is how it avoids this family entirely. So the edit stands.
    expect(
      await readA1OnSheet(page, grid, 1),
      "Sheet3 moved to index 1. Excel ends the undo history at a sheet " +
        "structural change, so Ctrl+Z restores nothing and the edit stands.",
    ).toBe(EDITED_VALUE);
  });
});

// ===========================================================================
// BUG-0040 — removing a table's AutoFilter must survive a reopen
// ===========================================================================

test.describe("Removing a table's AutoFilter survives save/reload (BUG-0040)", () => {
  /** Seed a small block and make it a table. Returns the table id. */
  async function makeTable(page: Page, grid: GridHelper): Promise<string> {
    await grid.setCellValueDirect("A1", "Region");
    await grid.setCellValueDirect("B1", "Amount");
    await grid.setCellValueDirect("A2", "North");
    await grid.setCellValueDirect("B2", "10");
    await grid.setCellValueDirect("A3", "South");
    await grid.setCellValueDirect("B3", "20");

    const res = await invokeBackend<any>(page, "create_table", {
      params: {
        name: `FilterProbe${Date.now()}`,
        startRow: 0,
        startCol: 0,
        endRow: 2,
        endCol: 1,
        hasHeaders: true,
      },
    });
    expect(res?.success, `create_table must succeed: ${JSON.stringify(res?.error)}`).toBe(true);
    return String(res.table.id);
  }

  async function autoFilterPresent(page: Page): Promise<boolean> {
    const af = await invokeBackend<any>(page, "get_auto_filter", {});
    return af !== null && af !== undefined;
  }

  async function filterButtonOn(page: Page, tableId: string): Promise<boolean> {
    const tables = await invokeBackend<any[]>(page, "get_all_tables", {});
    const t = (tables ?? []).find((x: any) => String(x.id) === tableId);
    expect(t, "the table must still exist").toBeTruthy();
    return Boolean(t.styleOptions.showFilterButton);
  }

  test("a table whose filter was NOT removed still has it after a reopen (control)", async ({ grid }) => {
    // THE POSITIVE CONTROL, RUN FIRST. A "fix" that simply stopped restoring
    // AutoFilters would pass the real test below and would break every table.
    const page = grid.page;
    await wipeWorkbook(page);
    const tableId = await makeTable(page, grid);

    expect(await autoFilterPresent(page), "create_table establishes the filter").toBe(true);
    expect(await filterButtonOn(page, tableId)).toBe(true);

    const file = tmpFile("filter-kept");
    await saveTo(page, file);
    await openAndReload(page, file);

    expect(
      await autoFilterPresent(page),
      "a table that still advertises filter buttons must come back with its filter",
    ).toBe(true);
  });

  test("a removed filter stays removed after a reopen", async ({ grid }) => {
    const page = grid.page;
    await wipeWorkbook(page);
    const tableId = await makeTable(page, grid);
    expect(await autoFilterPresent(page), "precondition: the table has a filter").toBe(true);

    const res = await invokeBackend<any>(page, "remove_auto_filter", {});
    expect(res?.success, "remove_auto_filter must succeed").toBe(true);

    expect(await autoFilterPresent(page), "removed in memory").toBe(false);
    expect(
      await filterButtonOn(page, tableId),
      "and the table stops advertising filter buttons — for a table these are " +
        "ONE state (Excel's ListObject.ShowAutoFilter), and while they " +
        "disagreed the load path's seed used the flag to manufacture the " +
        "filter back",
    ).toBe(false);

    const file = tmpFile("filter-removed");
    await saveTo(page, file);
    await openAndReload(page, file);

    expect(
      await autoFilterPresent(page),
      "THE DEFECT: the reopened document must be the document that was saved. " +
        "The filter the user deliberately removed used to be re-invented by the " +
        "load path on every single reopen.",
    ).toBe(false);
  });
});

// ===========================================================================
// BUG-0041 — a deleted sheet's state must not reappear on another sheet
// ===========================================================================

test.describe("A deleted sheet's sparklines do not move to another sheet (BUG-0041)", () => {
  /** Draw a line sparkline at AT1 over AP1:AS1 on the ACTIVE sheet. */
  async function makeSparkline(page: Page, grid: GridHelper): Promise<void> {
    await grid.setCellValueDirect("AP1", "10");
    await grid.setCellValueDirect("AQ1", "20");
    await grid.setCellValueDirect("AR1", "15");
    await grid.setCellValueDirect("AS1", "30");
    await page.evaluate(() => {
      const sparkApi = (window as any).__CALCULA_SPARKLINES__;
      if (!sparkApi) throw new Error("__CALCULA_SPARKLINES__ missing");
      sparkApi.createSparklineGroup(
        { startRow: 0, startCol: 45, endRow: 0, endCol: 45 },
        { startRow: 0, startCol: 41, endRow: 0, endCol: 44 },
        "line",
      );
    });
    await page.waitForTimeout(700);
  }

  async function sparklineSheetIndices(page: Page): Promise<number[]> {
    const entries = await invokeBackend<any[]>(page, "get_sparklines", {});
    return (entries ?? [])
      .filter((e: any) => {
        const raw = String(e.groupsJson ?? "[]").trim();
        return raw !== "" && raw !== "[]" && raw !== "null";
      })
      .map((e: any) => Number(e.sheetIndex))
      .sort((a, b) => a - b);
  }

  test("a sparkline on a sheet that is NOT deleted survives a reopen (control)", async ({ grid }) => {
    // THE POSITIVE CONTROL, RUN FIRST: a fix that dropped every sparkline would
    // satisfy the real test below and would delete the feature.
    const page = grid.page;
    await wipeWorkbook(page);
    await addSheetViaButton(page);
    await clickSheetTab(page, 1);
    await makeSparkline(page, grid);

    expect(await sparklineSheetIndices(page), "drawn on sheet 1").toEqual([1]);

    const file = tmpFile("sparkline-kept");
    await saveTo(page, file);
    await openAndReload(page, file);

    expect(
      await sparklineSheetIndices(page),
      "the sheet still exists, so its sparkline must come back ON IT",
    ).toEqual([1]);
  });

  test("a sparkline whose sheet is deleted does not reappear anywhere", async ({ grid }) => {
    const page = grid.page;
    await wipeWorkbook(page);
    await addSheetViaButton(page);
    await clickSheetTab(page, 1);
    await makeSparkline(page, grid);
    expect(await sparklineSheetIndices(page), "precondition: drawn on sheet 1").toEqual([1]);

    // The real gesture: delete the sheet the group lives on. The extension
    // saves on SHEET_CHANGED, and SHEET_CHANGED fires for a COLLECTION change
    // too — so this is the moment the deleted sheet's index was written back.
    await deleteSheetViaUI(page, 1);
    expect(await sheetNames(page), "one sheet left").toHaveLength(1);

    expect(
      await sparklineSheetIndices(page),
      "in memory: the store must not hold groups for a sheet that is gone. " +
        "This is where the extension's own save used to put them straight back " +
        "after cascade_sheet_removed had dropped them.",
    ).toEqual([]);

    const file = tmpFile("sparkline-deleted");
    await saveTo(page, file);
    await openAndReload(page, file);

    expect(
      await sparklineSheetIndices(page),
      "THE DEFECT: after the reopen the group used to be present on SHEET 0 — " +
        "a sheet it was never drawn on. Saving minted a fresh id for the " +
        "out-of-range index and loading resolved that unknown id to 0.",
    ).toEqual([]);
  });
});
