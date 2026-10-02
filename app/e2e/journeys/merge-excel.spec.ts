/**
 * EXCEL'S MERGE MENU, THROUGH THE REAL UI (2026-10-02).
 *
 * The owner asked for Merge "as in Excel". Excel's Home > Alignment carries ONE
 * split button: the icon half is Merge & Center, a TOGGLE (pressed whenever a
 * merged cell lies in the selection; clicking it then unmerges and resets the
 * alignment of the former merge to General), and the arrow opens Excel's menu
 * -- Merge & Center, Merge Across, Merge Cells, Unmerge Cells. A merge that
 * would discard values asks first, with Excel's own sentence, and Cancel
 * changes NOTHING.
 *
 * WHY A JOURNEY. The unit suites stand on either side of the native dialog:
 * the gesture's tests double `confirmAsync`, the button's tests double the
 * backend reads. Only the real app shows the real Win32 confirm, and only the
 * real backend can say what Cancel left behind. Every refusal is paired with
 * its positive control on the same path, because "nothing merged" is also what
 * a dead button looks like.
 *
 * THE DIALOG is answered from OUTSIDE the app over Win32
 * (`e2e/answer-native-dialog.ps1`, via helpers/edit-close.ts). The click that
 * raises it is AWAITED before the synchronous driver runs: an un-awaited
 * Playwright call has not written its CDP message, and execFileSync blocks this
 * process (memory: e2e_unawaited_call_before_execfilesync).
 *
 * GRID. Every test starts from File > New and works in A1:D22. sv-SE locale;
 * no formula here needs a separator.
 *
 * PROVED 2026-10-02: 6/6 live. SABOTAGE: with the gesture's `if (!ok) return;`
 * replaced by `void ok;` (Cancel ignored) M1 FAILS live at "Cancel still
 * merged" -- the sabotage was confirmed to change behaviour, and the source
 * restored byte for byte. The first live run also found that the harness turns
 * every tooltip off (fixtures.ts), which is why M5 switches them on for its one
 * hover.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { parseCellRef, type GridHelper } from "../helpers/grid";
import { answerNativeDialog, appIsRunning, visibleDialogs } from "../helpers/edit-close";

const MERGE_WARNING = "Merging cells only keeps the upper-left value and discards other values.";

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

async function invoke<T = unknown>(page: Page, cmd: string, args: unknown = {}): Promise<T> {
  return page.evaluate(
    async ({ c, a }) => {
      const t = (
        window as unknown as {
          __TAURI__: { core: { invoke: (cmd: string, args: unknown) => Promise<unknown> } };
        }
      ).__TAURI__;
      return t.core.invoke(c, a);
    },
    { c: cmd, a: args },
  ) as Promise<T>;
}

async function callModule<T = unknown>(page: Page, modulePath: string, fn: string, args: unknown[] = []): Promise<T> {
  return page.evaluate(
    async ({ modulePath, fn, args }) => {
      const m = (await (
        window as unknown as { __calcImport: (u: string) => Promise<unknown> }
      ).__calcImport(new URL(modulePath, document.baseURI).href)) as Record<string, (...a: unknown[]) => unknown>;
      if (typeof m[fn] !== "function") throw new Error(`${modulePath} exports no function "${fn}"`);
      return (await m[fn](...(args as unknown[]))) as unknown;
    },
    { modulePath, fn, args },
  ) as Promise<T>;
}

async function newFile(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await callModule(page, "/src/core/lib/file-api.ts", "newFile");
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("dimensions:refresh"));
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await page.waitForTimeout(900);
}

interface Region {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

async function mergeAt(page: Page, ref: string): Promise<Region | null> {
  const { row, col } = parseCellRef(ref);
  return invoke<Region | null>(page, "get_merge_info", { row, col });
}

async function allMerges(page: Page): Promise<Region[]> {
  const regions = await invoke<Region[]>(page, "get_merged_regions");
  return [...regions].sort((a, b) => a.startRow - b.startRow || a.startCol - b.startCol);
}

const main = (page: Page) => page.locator('[data-testid="fmt-mergeCells"]').first();
const chevron = (page: Page) => page.locator('[data-testid="fmt-mergeCells-options"]').first();

/** The Merge button's pressed state, polled: it re-reads after a quiet 120 ms. */
async function expectPressed(page: Page, pressed: boolean, label: string): Promise<void> {
  await expect
    .poll(async () => main(page).getAttribute("aria-pressed"), {
      timeout: 10_000,
      intervals: [200],
      message: `${label}: Merge & Center's pressed state`,
    })
    .toBe(String(pressed));
}

/** Leave no native dialog behind for the next spec (they block Tauri IPC). */
function sweepDialogs(): void {
  for (const d of appIsRunning() ? visibleDialogs() : []) answerNativeDialog(d.title, { action: "cancel" }, 2_000);
}

async function selectAndWait(grid: GridHelper, from: string, to: string): Promise<void> {
  await grid.selectRange(from, to);
  await grid.page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------
// Journeys
// ---------------------------------------------------------------------------

test.describe("Excel's Merge & Center", () => {
  test("M1: Cancel changes nothing; OK merges and centres; clicking again unmerges to General; one Ctrl+Z restores both", async ({ grid }) => {
    const page = grid.page;
    try {
      await newFile(page);
      await grid.setCellValueDirect("A1", "Alpha");
      await grid.setCellValueDirect("B1", "Beta");
      await selectAndWait(grid, "A1", "C1");
      await expectPressed(page, false, "nothing merged yet");

      // Cancel: the warning appears with Excel's words, and nothing changes.
      await main(page).click();
      const no = answerNativeDialog("Calcula", { action: "cancel" });
      expect(no.notFound, `no warning appeared (driver: ${no.raw})`).toBe(false);
      expect(no.text).toContain(MERGE_WARNING);
      await page.waitForTimeout(800);
      expect(await mergeAt(page, "A1"), "Cancel still merged").toBeNull();
      expect(await grid.getCellDisplayValue("B1"), "Cancel still discarded B1").toBe("Beta");
      expect(await grid.getCellStyleStringProp("A1", "textAlign"), "Cancel still centred").not.toBe("center");

      // OK (positive control on the same path).
      await main(page).click();
      const yes = answerNativeDialog("Calcula", { action: "ok" });
      expect(yes.notFound, `no warning appeared (driver: ${yes.raw})`).toBe(false);
      await expect
        .poll(async () => JSON.stringify(await mergeAt(page, "A1")), { timeout: 10_000 })
        .toBe(JSON.stringify({ startRow: 0, startCol: 0, endRow: 0, endCol: 2 }));
      expect(await grid.getCellDisplayValue("A1")).toBe("Alpha");
      expect(await grid.getCellDisplayValue("B1"), "the discarded value survived").toBe("");
      expect(await grid.getCellStyleStringProp("A1", "textAlign")).toBe("center");
      await expectPressed(page, true, "after Merge & Center");

      // The toggle: no warning, unmerged, General.
      await main(page).click();
      await expect.poll(async () => mergeAt(page, "A1"), { timeout: 10_000 }).toBeNull();
      expect(visibleDialogs(), "unmerging asked a question").toEqual([]);
      expect(await grid.getCellStyleStringProp("A1", "textAlign")).toBe("general");
      await expectPressed(page, false, "after the toggle");

      // ONE undo step brings back the merge AND the centring.
      await grid.undo();
      await expect
        .poll(async () => JSON.stringify(await mergeAt(page, "A1")), { timeout: 10_000 })
        .toBe(JSON.stringify({ startRow: 0, startCol: 0, endRow: 0, endCol: 2 }));
      expect(await grid.getCellStyleStringProp("A1", "textAlign")).toBe("center");
      await expectPressed(page, true, "after Ctrl+Z");
    } finally {
      sweepDialogs();
    }
  });

  test("M2: Merge Cells from the menu moves a lone value to the top-left without asking", async ({ grid }) => {
    const page = grid.page;
    try {
      await newFile(page);
      await grid.setCellValueDirect("B5", "Title");
      await selectAndWait(grid, "A5", "C5");
      await chevron(page).click();
      await page.locator('[data-testid="fmt-merge-cells"]').click();
      await expect
        .poll(async () => JSON.stringify(await mergeAt(page, "A5")), { timeout: 10_000 })
        .toBe(JSON.stringify({ startRow: 4, startCol: 0, endRow: 4, endCol: 2 }));
      expect(visibleDialogs(), "a lone value discards nothing, so nothing is asked").toEqual([]);
      expect(await grid.getCellDisplayValue("A5")).toBe("Title");
      expect(await grid.getCellDisplayValue("B5")).toBe("");
      // Merge Cells leaves alignment alone.
      expect(await grid.getCellStyleStringProp("A5", "textAlign")).not.toBe("center");
    } finally {
      sweepDialogs();
    }
  });

  test("M3: Merge Across merges each row, and one Ctrl+Z takes all of them back", async ({ grid }) => {
    const page = grid.page;
    try {
      await newFile(page);
      for (const r of [10, 11, 12]) {
        await grid.setCellValueDirect(`A${r}`, `Row${r}`);
        await grid.setCellValueDirect(`B${r}`, "x");
      }
      await selectAndWait(grid, "A10", "C12");
      await chevron(page).click();
      await page.locator('[data-testid="fmt-merge-across"]').click();
      const ok = answerNativeDialog("Calcula", { action: "ok" });
      expect(ok.notFound, `no warning appeared (driver: ${ok.raw})`).toBe(false);
      await expect
        .poll(async () => (await allMerges(page)).length, { timeout: 10_000 })
        .toBe(3);
      expect(await allMerges(page)).toEqual([
        { startRow: 9, startCol: 0, endRow: 9, endCol: 2 },
        { startRow: 10, startCol: 0, endRow: 10, endCol: 2 },
        { startRow: 11, startCol: 0, endRow: 11, endCol: 2 },
      ]);
      await grid.undo();
      await expect.poll(async () => (await allMerges(page)).length, { timeout: 10_000 }).toBe(0);
      expect(await grid.getCellDisplayValue("B11"), "undo brought the discarded value back").toBe("x");
    } finally {
      sweepDialogs();
    }
  });

  test("M4: Unmerge Cells unmerges every merge in the selection and keeps alignment", async ({ grid }) => {
    const page = grid.page;
    try {
      await newFile(page);
      await invoke(page, "merge_cells", { startRow: 19, startCol: 0, endRow: 19, endCol: 1 });
      await invoke(page, "merge_cells", { startRow: 21, startCol: 2, endRow: 21, endCol: 3 });
      await invoke(page, "apply_formatting", { params: { rows: [19], cols: [0], textAlign: "right" } });
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
      await selectAndWait(grid, "A20", "D22");
      await expectPressed(page, true, "a merge lies in the selection");
      await chevron(page).click();
      await page.locator('[data-testid="fmt-merge-unmerge"]').click();
      await expect.poll(async () => (await allMerges(page)).length, { timeout: 10_000 }).toBe(0);
      expect(await grid.getCellStyleStringProp("A20", "textAlign"), "Unmerge Cells keeps alignment").toBe("right");
      await expectPressed(page, false, "nothing merged any more");
    } finally {
      sweepDialogs();
    }
  });

  test("M5: a protected sheet greys out both halves, and Unprotect brings them back", async ({ grid }) => {
    const page = grid.page;
    try {
      await newFile(page);
      await selectAndWait(grid, "A1", "B1");
      await callModule(page, "/src/api/backend.ts", "protectSheet", [{}]);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("protection:refresh")));
      await expect.poll(async () => main(page).getAttribute("aria-disabled"), { timeout: 10_000 }).toBe("true");
      expect(await chevron(page).getAttribute("aria-disabled")).toBe("true");
      // The reason is readable: a hover shows it. The harness turns every
      // tooltip off for the run (fixtures.ts, goldens); this one is the
      // assertion, so it is switched on just for this hover and back off below.
      await page.evaluate(() => {
        delete document.documentElement.dataset.tooltips;
      });
      await main(page).hover();
      await expect(page.locator("[role='tooltip']")).toContainText("protected sheet", { timeout: 5_000 });
      await page.mouse.move(0, 0);
      await page.evaluate(() => {
        document.documentElement.dataset.tooltips = "off";
      });

      await callModule(page, "/src/api/backend.ts", "unprotectSheet", []);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("protection:refresh")));
      await expect.poll(async () => main(page).getAttribute("aria-disabled"), { timeout: 10_000 }).toBeNull();
    } finally {
      await page
        .evaluate(() => {
          document.documentElement.dataset.tooltips = "off";
        })
        .catch(() => undefined);
      await callModule(page, "/src/api/backend.ts", "unprotectSheet", []).catch(() => undefined);
      sweepDialogs();
    }
  });

  test("M6: the keyboard -- ArrowDown on the button opens the menu, Enter runs Unmerge Cells", async ({ grid }) => {
    const page = grid.page;
    try {
      await newFile(page);
      await invoke(page, "merge_cells", { startRow: 2, startCol: 0, endRow: 2, endCol: 2 });
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
      await selectAndWait(grid, "A3", "C3");
      // Tab inside the grid moves the active cell, not focus: focus the button.
      await main(page).focus();
      await page.keyboard.press("ArrowDown");
      await expect(page.locator('[data-testid="fmt-merge-center"]')).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await expect(page.locator('[data-testid="fmt-merge-unmerge"]')).toBeFocused();
      await page.keyboard.press("Enter");
      await expect.poll(async () => mergeAt(page, "A3"), { timeout: 10_000 }).toBeNull();
    } finally {
      sweepDialogs();
    }
  });
});
