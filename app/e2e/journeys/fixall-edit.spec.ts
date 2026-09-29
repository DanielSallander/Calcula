/**
 * FIX-ALL WAVE, AREA "EDIT" -- proved live.
 *
 * Six fix waves (A-F) fixed the editing and keyboard defects found since the
 * canvas owner test, each proved by unit tests only. This journey drives the
 * RUNNING app -- real key presses (or, where a keyboard layout cannot be
 * emulated, synthetic keydowns dispatched to the focused element the way that
 * layout delivers them), the real ribbon, the real menus, the real Settings
 * page -- and reads the outcome through the backend, the app's own module
 * state (same instance), and the DOM.
 *
 * Every check asserts BOTH directions: the fixed behaviour happens where it
 * should AND the old wrong behaviour does not, with a positive control that
 * delivers the same gesture the same way where it must act, so a keystroke
 * that never arrived cannot pass as a refusal.
 *
 * Test names carry the item / bug id they prove (BUG-xxxx, K/E/D/W/X/Y/Z
 * items from the fix-wave master list).
 *
 * SHARED APP. Every test starts with File > New and ends with it in a
 * `finally` (the app's own newFile, never a raw new_file -- BUG-0205), and puts
 * back any preference or shortcut it changed.
 */
import type { Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { unzipSync } from "fflate";
import { test, expect } from "../fixtures";
import { readGridGeometry } from "../helpers/grid";
import { createStarConnection } from "../helpers/edit-model";
import {
  answerNativeDialog,
  appIsRunning,
  beforeCloseCount,
  hookBeforeClose,
  mainWindowVisible,
  requestWindowClose,
  sleepMs,
  visibleDialogs,
} from "../helpers/edit-close";
import {
  activeSheet,
  addWorksheet,
  BOOKMARK_STORE,
  callModule,
  cellAt,
  cellsOn,
  clickFrCell,
  clickSheetTab,
  closeDialogsAndOverlays,
  columnHeaderPoint,
  cornerPoint,
  coreEditOpen,
  createFr,
  dismissToasts,
  eventually,
  executeCommand,
  focusGrid,
  focusInfo,
  formulaBarValue,
  FORMAT_PAINTER_STATE,
  frCell,
  frCellPoint,
  frEditorOpen,
  frEditorText,
  frLocalSelection,
  frObjectSelected,
  frTitlePoint,
  gridEditing,
  gridSelection,
  installAppImport,
  invoke,
  menuItemCount,
  newFile,
  openDialogs,
  openOverlays,
  API_EDIT_PREFS,
  API_GRID,
  API_KEYBINDINGS,
  cellPagePoint,
  frList,
  renameSheet,
  setFrCell,
  TAURI_API,
  runMenuItem,
  selectionOwned,
  sheets,
  startKeyLog,
  FLOATING_RANGES,
  FR_CHROME,
  sheetPointToPage,
  bounded,
  API_COMMANDS,
  rejectionMark,
  rejectionsSince,
  keyLog,
  startToastLog,
  styleAt,
  synthKey,
  toastMark,
  toastsSince,
  undoState,
  writeCells,
  type AppWindow,
  type FrInfo,
} from "../helpers/edit-harness";

/** The one sentence a floating grid's claim answers every refused door with. */
const FR_REFUSAL = /is not available for a floating range's cells yet\. Nothing was changed\./;

/** Where this spec's floating grid floats on a worksheet (sheet px): columns G.., rows 10.. */
const FR_POS = { x: 420, y: 180 };

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

/** One toast, and it is the floating grid's refusal. */
async function expectOneRefusal(page: Page, mark: number, door: string): Promise<void> {
  await page.waitForTimeout(700);
  const toasts = await toastsSince(page, mark);
  expect(toasts.map((t) => t.message), `${door}: expected exactly one refusal toast`).toHaveLength(1);
  expect(toasts[0].message, `${door}: the toast is not the floating grid's refusal`).toMatch(FR_REFUSAL);
}

interface DocSnapshot {
  a1: string;
  a1Style: number;
  undoDepth: number;
}

async function docSnapshot(page: Page): Promise<DocSnapshot> {
  const a1 = await cellAt(page, 0, 0);
  const u = await undoState(page);
  return { a1: String(a1?.display ?? ""), a1Style: a1?.styleIndex ?? 0, undoDepth: u.undoDepth };
}

/** Nothing reached Core's hidden cell: A1 unchanged, no undo step, no dialog. */
async function expectNothingWritten(page: Page, before: DocSnapshot, door: string): Promise<void> {
  const now = await docSnapshot(page);
  expect(now.a1, `${door}: A1's value changed`).toBe(before.a1);
  expect(now.a1Style, `${door}: A1's style changed`).toBe(before.a1Style);
  expect(now.undoDepth, `${door}: an undo step was added`).toBe(before.undoDepth);
  expect((await openDialogs(page)).map((d) => d.id), `${door}: a dialog opened`).toEqual([]);
}

/** Select Sheet1!A1, then a floating grid's cell (0,0): the claim is on. */
async function claimWithFrCell(page: Page, grid: { clickCell: (r: string) => Promise<void> }, fr: FrInfo, row = 0, col = 0): Promise<void> {
  await grid.clickCell("A1");
  await clickFrCell(page, fr, row, col);
  await eventually(() => frLocalSelection(page), (s) => s !== null && s.frId === fr.id, "clicking the floating grid's cell selected nothing in it");
  expect(await selectionOwned(page), "precondition: the floating grid claims the selection").toBe(true);
  const sel = await gridSelection(page);
  expect(sel && [sel.startRow, sel.startCol, sel.endRow, sel.endCol], "precondition: Core's hidden selection is A1").toEqual([0, 0, 0, 0]);
}

/** The cell type (Insert > Cell Type) assigned to a cell of the active sheet ("checkbox", "button", ...), or null. */
async function cellTypeAt(page: Page, row: number, col: number): Promise<string | null> {
  const t = await callModule<{ typeId: string } | null>(page, "/src/api/cellTypes.ts", "getCellTypeAt", [row, col]);
  // Type ids are namespaced ("calcula.checkbox").
  return t?.typeId ? t.typeId.replace(/^calcula\./, "") : null;
}

/** Click a tab of the ribbon's tab strip (a non-active one switches; the ACTIVE one collapses the ribbon). */
async function clickRibbonTab(page: Page, label: string): Promise<void> {
  const strip = page.locator("[data-ribbon-content]").locator("xpath=..");
  await strip.locator("button", { hasText: new RegExp(`^${label}$`) }).first().click();
  await page.waitForTimeout(250);
}

/**
 * Click a cell as a human does for Format Painter (the button held ~150 ms).
 * Returns whether THIS click painted; when it did not, clicks once more and
 * reports that the second one was needed.
 */
async function paintWithFormatPainter(
  page: Page,
  grid: { cellCenterScrollAware: (r: string) => Promise<{ x: number; y: number }> },
  ref: string,
  painted: () => Promise<boolean>,
  waitMs = 3000,
): Promise<{ firstClickPainted: boolean; secondClickPainted: boolean | null }> {
  const click = async () =>
    page.locator("canvas").first().click({ position: await grid.cellCenterScrollAware(ref), delay: 150, force: true });
  await click();
  const first = await eventually(painted, (v) => v, "first click", waitMs).then(() => true, () => false);
  if (first) return { firstClickPainted: true, secondClickPainted: null };
  await click();
  const second = await eventually(painted, (v) => v, "second click", waitMs).then(() => true, () => false);
  return { firstClickPainted: false, secondClickPainted: second };
}

async function resetKeybindings(page: Page): Promise<void> {
  await callModule(page, API_KEYBINDINGS, "resetAllKeybindings").catch(() => undefined);
}

async function cleanup(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await closeDialogsAndOverlays(page).catch(() => undefined);
  await callModule(page, BOOKMARK_STORE, "removeAllBookmarks").catch(() => undefined);
  await dismissToasts(page).catch(() => undefined);
  await newFile(page);
}

/** Open a top-level menu and hover/click a path in the DOM, as a user does. */
async function clickMenuPath(page: Page, path: string[]): Promise<void> {
  await page.locator("button").filter({ hasText: new RegExp(`^${path[0]}$`) }).first().click();
  await page.waitForTimeout(200);
  for (let i = 1; i < path.length; i++) {
    const item = page
      .locator("button")
      .filter({ has: page.locator("span", { hasText: new RegExp(`^${path[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) })
      .first();
    if (i < path.length - 1) {
      await item.hover();
      await page.waitForTimeout(200);
    } else {
      await item.click();
    }
  }
  await page.waitForTimeout(250);
}

async function hoverMenuPath(page: Page, path: string[]): Promise<void> {
  await page.locator("button").filter({ hasText: new RegExp(`^${path[0]}$`) }).first().click();
  await page.waitForTimeout(200);
  for (let i = 1; i < path.length; i++) {
    const item = page
      .locator("button")
      .filter({ has: page.locator("span", { hasText: new RegExp(`^${path[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) })
      .first();
    await item.hover();
    await page.waitForTimeout(250);
  }
}

// ===========================================================================
// 1. THE SELECTION OWNER: every door refuses once while a floating-grid cell
//    holds the selection on a worksheet, and works again on a sheet cell.
// ===========================================================================

test.describe("selection owner: a floating grid's cell on a worksheet", () => {
  test("BUG-0185 K1/E7: Home Bold, Font Color, Format > Cell Styles, Paste Special, Format Painter, CF Data Bars, More Number Formats, More Fill Options, Ctrl+B and Ctrl+1 each refuse once and leave A1 alone; on a sheet cell they act", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      await startToastLog(page);
      await writeCells(page, [[0, 0, "keep"]]);
      const fr = await createFr(page, FR_POS.x, FR_POS.y, "EditFR");
      await claimWithFrCell(page, grid, fr);
      const before = await docSnapshot(page);

      const doors: Array<{ name: string; act: () => Promise<void> }> = [
        { name: "Home > Bold", act: () => page.locator('[data-testid="fmt-bold"]').click() },
        {
          name: "Home > Font Color",
          act: async () => {
            await page.locator('[data-testid="fmt-textColor"]').click();
            await page.locator('[data-testid="fmt-textColor-popover"] button[data-colour-swatch]').nth(5).click();
          },
        },
        {
          name: "Format > Cell Styles",
          act: async () => {
            await hoverMenuPath(page, ["Format", "Cell Styles"]);
            await page.locator('[data-testid="cell-styles-gallery"]').getByText("Good", { exact: true }).first().click();
          },
        },
        { name: "Edit > Paste > Paste Special", act: () => runMenuItem(page, ["Edit", "Paste", "Paste Special..."]) },
        { name: "Home > Format Painter", act: () => page.locator('[data-testid="fmt-formatPainter"]').click() },
        {
          name: "Format > Conditional Formatting > Data Bars",
          act: async () => {
            await hoverMenuPath(page, ["Format", "Conditional Formatting", "Data Bars"]);
            await page.locator('button[title^="Gradient"]').first().click();
          },
        },
        {
          name: "Home > Number > More Number Formats...",
          act: async () => {
            await page.locator('[data-testid="fmt-numberFormat"]').click();
            await page.locator('[data-testid="fmt-numberFormat-option-__more-number-formats__"]').click();
          },
        },
        {
          name: "Home > Fill > More Fill Options...",
          act: async () => {
            await page.locator('[data-testid="fmt-backgroundColor"]').click();
            await page.locator("button", { hasText: /^More Fill Options\.\.\.$/ }).click();
          },
        },
        {
          name: "Ctrl+B",
          act: async () => {
            await focusGrid(page);
            await page.keyboard.press("Control+b");
          },
        },
        {
          name: "Ctrl+1",
          act: async () => {
            await focusGrid(page);
            await page.keyboard.press("Control+1");
          },
        },
      ];

      for (const door of doors) {
        await test.step(door.name, async () => {
          // The claim must still hold for every door: re-select the floating
          // cell if a previous door's popover/menu took it.
          if (!(await selectionOwned(page))) await clickFrCell(page, fr, 0, 0);
          expect(await selectionOwned(page), `${door.name}: precondition, the claim holds`).toBe(true);
          const mark = await toastMark(page);
          await door.act();
          await expectOneRefusal(page, mark, door.name);
          await expectNothingWritten(page, before, door.name);
          expect(
            await callModule<boolean>(page, FORMAT_PAINTER_STATE, "isFormatPainterActive"),
            `${door.name}: Format Painter started`,
          ).toBe(false);
          await page.keyboard.press("Escape");
          await page.waitForTimeout(150);
        });
      }

      // ---- POSITIVE CONTROL: on a sheet cell every door acts ----------------
      await grid.clickCell("A1");
      expect(await selectionOwned(page), "clicking a sheet cell ends the claim").toBe(false);

      await page.locator('[data-testid="fmt-bold"]').click();
      await eventually(() => styleAt(page, 0, 0), (s) => s.bold === true, "Home > Bold did not bold A1 once the sheet cell was selected");

      await focusGrid(page);
      await page.keyboard.press("Control+b");
      await eventually(() => styleAt(page, 0, 0), (s) => s.bold === false, "Ctrl+B on the sheet cell did not toggle bold (the key does not arrive?)");

      await page.locator('[data-testid="fmt-numberFormat"]').click();
      await page.locator('[data-testid="fmt-numberFormat-option-__more-number-formats__"]').click();
      const onNumber = await eventually(() => openDialogs(page), (d) => d.some((x) => x.id === "format-cells"), "More Number Formats... did not open Format Cells");
      expect((onNumber.find((x) => x.id === "format-cells")!.data as { tab?: string } | null)?.tab).toBe("number");
      await closeDialogsAndOverlays(page);

      await page.locator('[data-testid="fmt-backgroundColor"]').click();
      await page.locator("button", { hasText: /^More Fill Options\.\.\.$/ }).click();
      const onFill = await eventually(() => openDialogs(page), (d) => d.some((x) => x.id === "format-cells"), "More Fill Options... did not open Format Cells");
      expect((onFill.find((x) => x.id === "format-cells")!.data as { tab?: string } | null)?.tab).toBe("fill");
      await closeDialogsAndOverlays(page);

      await focusGrid(page);
      await page.keyboard.press("Control+1");
      await eventually(() => openDialogs(page), (d) => d.some((x) => x.id === "format-cells"), "Ctrl+1 on the sheet cell did not open Format Cells");
      await closeDialogsAndOverlays(page);

      await runMenuItem(page, ["Edit", "Paste", "Paste Special..."]);
      await eventually(() => openDialogs(page), (d) => d.some((x) => x.id === "paste-special"), "Paste Special did not open on the sheet cell");
      await closeDialogsAndOverlays(page);

      await page.locator('[data-testid="fmt-formatPainter"]').click();
      await eventually(
        () => callModule<boolean>(page, FORMAT_PAINTER_STATE, "isFormatPainterActive"),
        (v) => v === true,
        "Format Painter did not start on the sheet cell",
      );
      await page.keyboard.press("Escape");
    } finally {
      await cleanup(page);
    }
  });
});

test.describe("selection owner: menu and key doors (D4, W18, E7)", () => {
  test("D4 (BUG-0185 class): Sort, Filter, Group, Remove Duplicates, Data Validation, Ctrl+T, Ctrl+Shift+B, Ctrl+K, Ctrl+Alt+M, Cell Protection, Alt+;, Ctrl+E, Set Print Area, Cell Type > Checkbox, Paste Names each refuse once with a floating-grid cell selected; on a sheet cell they act", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(300_000);
    try {
      await newFile(page);
      await startToastLog(page);
      // Data > Sort A to Z sorts the region around the active cell and ALWAYS
      // takes its first row as a header (Sorting/handlers/dataMenuBuilder.ts).
      await writeCells(page, [
        [0, 0, "N"],
        [1, 0, "3"],
        [2, 0, "1"],
        [3, 0, "2"],
      ]);
      const fr = await createFr(page, FR_POS.x, FR_POS.y, "DoorsFR");
      await claimWithFrCell(page, grid, fr);
      const before = await docSnapshot(page);

      const menu = (path: string[]) => () => runMenuItem(page, path);
      const key = (combo: string) => async () => {
        await focusGrid(page);
        await page.keyboard.press(combo);
      };
      const doors: Array<{ name: string; act: () => Promise<void> }> = [
        { name: "Data > Sort A to Z", act: menu(["Data", "Sort A to Z"]) },
        { name: "Data > Filter", act: menu(["Data", "Filter"]) },
        { name: "Data > Outline > Group", act: menu(["Data", "Outline", "Group"]) },
        { name: "Data > Remove Duplicates", act: menu(["Data", "Remove Duplicates..."]) },
        { name: "Data > Data Validation", act: menu(["Data", "Validation", "Data Validation..."]) },
        { name: "Ctrl+T", act: key("Control+t") },
        { name: "Ctrl+Shift+B", act: key("Control+Shift+B") },
        { name: "Ctrl+K", act: key("Control+k") },
        { name: "Ctrl+Alt+M", act: key("Control+Alt+m") },
        { name: "Review > Cell Protection", act: menu(["Review", "Cell Protection..."]) },
        { name: "Alt+;", act: key("Alt+;") },
        { name: "Ctrl+E", act: key("Control+e") },
        { name: "View > Print Area > Set Print Area", act: menu(["View", "Print Area", "Set Print Area"]) },
        { name: "Insert > Cell Type > Checkbox", act: menu(["Insert", "Cell Type", "Checkbox"]) },
        { name: "Formulas > Paste Names", act: menu(["Formulas", "Paste Names..."]) },
      ];

      for (const door of doors) {
        await test.step(door.name, async () => {
          if (!(await selectionOwned(page))) await clickFrCell(page, fr, 0, 0);
          expect(await selectionOwned(page), `${door.name}: precondition, the claim holds`).toBe(true);
          const mark = await toastMark(page);
          await door.act();
          await expectOneRefusal(page, mark, door.name);
          await expectNothingWritten(page, before, door.name);
          expect(await openOverlays(page), `${door.name}: an overlay opened`).toEqual([]);
          expect(await invoke(page, "get_auto_filter"), `${door.name}: an AutoFilter appeared`).toBeNull();
          expect(await invoke<unknown[]>(page, "get_all_comments"), `${door.name}: a comment was created`).toEqual([]);
          expect(
            await callModule<boolean>(page, BOOKMARK_STORE, "hasBookmarkAt", [0, 0, 0]),
            `${door.name}: a bookmark was added at the hidden cell`,
          ).toBe(false);
          await page.keyboard.press("Escape");
          await page.waitForTimeout(150);
        });
      }
      expect(await cellsOn(page, [[0, 0, 0], [0, 1, 0], [0, 2, 0], [0, 3, 0]]), "the column was sorted under the claim").toEqual(["N", "3", "1", "2"]);

      // ---- POSITIVE CONTROL: the same doors act on a sheet cell ------------
      await grid.clickCell("A1");
      expect(await selectionOwned(page)).toBe(false);
      const noRefusal = async (mark: number, door: string) => {
        await page.waitForTimeout(500);
        const t = await toastsSince(page, mark);
        expect(t.filter((x) => FR_REFUSAL.test(x.message)).map((x) => x.message), `${door}: refused on a sheet cell`).toEqual([]);
      };
      let mark = await toastMark(page);
      await runMenuItem(page, ["Data", "Sort A to Z"]);
      await eventually(() => cellsOn(page, [[0, 0, 0], [0, 1, 0], [0, 2, 0], [0, 3, 0]]), (v) => v.join() === "N,1,2,3", "Sort A to Z did not sort on a sheet cell");
      await noRefusal(mark, "Sort A to Z");

      await grid.clickCell("A1");
      mark = await toastMark(page);
      await focusGrid(page);
      await page.keyboard.press("Control+t");
      await eventually(() => openDialogs(page), (d) => d.some((x) => x.id === "table:createDialog"), "Ctrl+T did not open Create Table on a sheet cell");
      await closeDialogsAndOverlays(page);
      await noRefusal(mark, "Ctrl+T");

      await grid.clickCell("A1");
      await focusGrid(page);
      await page.keyboard.press("Control+k");
      await eventually(() => openDialogs(page), (d) => d.some((x) => x.id === "insert-hyperlink"), "Ctrl+K did not open Insert Hyperlink on a sheet cell");
      await closeDialogsAndOverlays(page);

      await grid.clickCell("A1");
      await focusGrid(page);
      await page.keyboard.press("Control+Shift+B");
      await eventually(() => callModule<boolean>(page, BOOKMARK_STORE, "hasBookmarkAt", [0, 0, 0]), (v) => v, "Ctrl+Shift+B added no bookmark on a sheet cell");

      await grid.clickCell("A1");
      await focusGrid(page);
      await page.keyboard.press("Control+Alt+m");
      await eventually(() => invoke<unknown[]>(page, "get_all_comments"), (c) => c.length === 1, "Ctrl+Alt+M created no comment on a sheet cell");
      await closeDialogsAndOverlays(page);

      await grid.clickCell("A1");
      await runMenuItem(page, ["Data", "Filter"]);
      await eventually(() => invoke(page, "get_auto_filter"), (v) => v !== null, "Data > Filter did not turn a filter on");
      await runMenuItem(page, ["Data", "Filter"]);
      await eventually(() => invoke(page, "get_auto_filter"), (v) => v === null, "Data > Filter did not turn the filter off");

      await grid.clickCell("A1");
      await runMenuItem(page, ["Insert", "Cell Type", "Checkbox"]);
      await eventually(() => cellTypeAt(page, 0, 0), (t) => t === "checkbox", "Insert > Cell Type > Checkbox did not act on a sheet cell");

      await grid.clickCell("A2");
      await runMenuItem(page, ["Data", "Validation", "Data Validation..."]);
      await eventually(() => openDialogs(page), (d) => d.length === 1, "Data Validation opened no dialog on a sheet cell");
      await closeDialogsAndOverlays(page);

      await grid.clickCell("A2");
      await runMenuItem(page, ["Review", "Cell Protection..."]);
      await eventually(async () => (await openDialogs(page)).length + (await openOverlays(page)).length, (n) => n >= 1, "Cell Protection opened nothing on a sheet cell");
      await closeDialogsAndOverlays(page);

      await grid.selectRange("A1", "A3");
      const depth = (await undoState(page)).undoDepth;
      await runMenuItem(page, ["Data", "Outline", "Group"]);
      await eventually(() => undoState(page), (u) => u.undoDepth === depth + 1, "Data > Group added no undo step on a sheet cell");
    } finally {
      await cleanup(page);
    }
  });

  test("W18: with an AutoFilter on and a floating-grid cell selected, Ctrl+Shift+L turns the filter off; Ctrl+T/K/E, Shift+F2, Ctrl+Shift+B, Alt+Shift+Right/Left and Ctrl+C/V/X/D/R refuse once without moving the grid's selection; Alt+Down refuses as Pick From List; Shift+Right and F2 still work", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      await startToastLog(page);
      await writeCells(page, [
        [0, 0, "Name"], [0, 1, "Val"],
        [1, 0, "x"], [1, 1, "1"],
        [2, 0, "y"], [2, 1, "2"],
      ]);
      await grid.clickCell("A1");
      await focusGrid(page);
      await page.keyboard.press("Control+Shift+L");
      await eventually(() => invoke(page, "get_auto_filter"), (v) => v !== null, "precondition: Ctrl+Shift+L on A1 did not turn an AutoFilter on");

      const fr = await createFr(page, FR_POS.x, FR_POS.y, "KeysFR");
      await claimWithFrCell(page, grid, fr);
      const frSel = async () => {
        const s = await frLocalSelection(page);
        return s ? [s.anchorRow, s.anchorCol, s.endRow, s.endCol] : null;
      };
      expect(await frSel()).toEqual([0, 0, 0, 0]);

      // Ctrl+Shift+L turns the EXISTING filter off (the sheet's filter, not the selection's).
      let mark = await toastMark(page);
      await focusGrid(page);
      await page.keyboard.press("Control+Shift+L");
      await eventually(() => invoke(page, "get_auto_filter"), (v) => v === null, "Ctrl+Shift+L did not turn the existing filter off with a floating-grid cell selected");
      await page.waitForTimeout(400);
      expect((await toastsSince(page, mark)).filter((t) => FR_REFUSAL.test(t.message)), "turning the filter off was refused").toEqual([]);
      const afterFilterOff = await docSnapshot(page);

      const refused = ["Control+t", "Control+k", "Control+e", "Shift+F2", "Control+Shift+B", "Alt+Shift+ArrowRight", "Alt+Shift+ArrowLeft", "Control+c", "Control+v", "Control+x", "Control+d", "Control+r"];
      for (const combo of refused) {
        await test.step(combo, async () => {
          if (JSON.stringify(await frSel()) !== "[0,0,0,0]") await clickFrCell(page, fr, 0, 0);
          mark = await toastMark(page);
          await focusGrid(page);
          await page.keyboard.press(combo);
          await expectOneRefusal(page, mark, combo);
          await expectNothingWritten(page, afterFilterOff, combo);
          expect(await frSel(), `${combo}: the floating grid's selection moved or extended`).toEqual([0, 0, 0, 0]);
          expect(await frEditorOpen(page), `${combo}: the floating grid's cell editor opened`).toBe(false);
          const clip = await page.evaluate(() => (window as unknown as AppWindow).__CALCULA_GRID_STATE__?.clipboard?.mode ?? "none");
          expect(clip, `${combo}: Core's hidden cell was copied/cut`).toBe("none");
        });
      }

      mark = await toastMark(page);
      await focusGrid(page);
      await page.keyboard.press("Alt+ArrowDown");
      await page.waitForTimeout(700);
      const pick = await toastsSince(page, mark);
      expect(pick.map((t) => t.message), "Alt+Down: one Pick From List refusal").toHaveLength(1);
      expect(pick[0].message).toMatch(/^Pick From List is not available for a floating range's cells yet/);

      // Still the grid's own keys: Shift+Right extends, F2 opens its editor.
      await clickFrCell(page, fr, 0, 0);
      await startKeyLog(page);
      await focusGrid(page);
      await page.keyboard.press("Shift+ArrowRight");
      await eventually(frSel, (s) => JSON.stringify(s) === "[0,0,0,1]", "Shift+Right did not extend the floating grid's selection").catch(async (e) => {
        throw new Error(`${String(e)} | keys ${JSON.stringify(await keyLog(page))} | core selection ${JSON.stringify(await gridSelection(page))} | owned ${await selectionOwned(page)}`);
      });
      await clickFrCell(page, fr, 0, 0);
      await focusGrid(page);
      await page.keyboard.press("F2");
      await eventually(() => frEditorOpen(page), (v) => v === true, "F2 did not open the floating grid's cell editor");
      await page.keyboard.press("Escape");
    } finally {
      await cleanup(page);
    }
  });

  test("E7 (BUG-0199): Copy remapped to Ctrl+Shift+Q is refused once on a floating-grid cell and copies nothing; on a sheet cell the new key copies", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(120_000);
    try {
      await newFile(page);
      await startToastLog(page);
      await writeCells(page, [[0, 0, "keep"]]);
      // The Settings page's Accept calls exactly this (the Settings UI's own capture is proved in the K2/K3 tests).
      await callModule(page, API_KEYBINDINGS, "setUserKeybinding", ["core.copy", "Ctrl+Shift+Q"]);
      expect(await callModule<string>(page, API_KEYBINDINGS, "getEffectiveCombo", ["core.copy"])).toBe("Ctrl+Shift+Q");
      const fr = await createFr(page, FR_POS.x, FR_POS.y, "CopyFR");
      await claimWithFrCell(page, grid, fr);
      const clipMode = () => page.evaluate(() => (window as unknown as AppWindow).__CALCULA_GRID_STATE__?.clipboard?.mode ?? "none");

      const mark = await toastMark(page);
      await focusGrid(page);
      await page.keyboard.press("Control+Shift+Q");
      await expectOneRefusal(page, mark, "remapped Copy (Ctrl+Shift+Q)");
      expect(await clipMode(), "the remapped Copy copied Core's hidden A1").toBe("none");

      // POSITIVE CONTROL: on a sheet cell the NEW key copies (marching ants).
      await grid.clickCell("A1");
      await focusGrid(page);
      await page.keyboard.press("Control+Shift+Q");
      await eventually(clipMode, (m) => m === "copy", "the remapped Copy did not copy the sheet cell");
      await page.keyboard.press("Escape");
    } finally {
      await resetKeybindings(page);
      await cleanup(page);
    }
  });
});

// ===========================================================================
// 2. SHORTCUTS: registered once, run once, remappable in Settings
// ===========================================================================

const ACTIVITY = "/src/shell/ActivityBar/useActivityBarStore.ts";
const LIFECYCLE_BOOKMARKS = "calcula.builtin.cell-bookmarks";

async function activityState(page: Page): Promise<{ isOpen: boolean; activeViewId: string | null }> {
  await installAppImport(page);
  return page.evaluate(async (mod) => {
    const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
      useActivityBarStore: { getState: () => { isOpen: boolean; activeViewId: string | null } };
    };
    const s = m.useActivityBarStore.getState();
    return { isOpen: s.isOpen, activeViewId: s.activeViewId };
  }, ACTIVITY);
}

async function closeActivityBar(page: Page): Promise<void> {
  await installAppImport(page);
  await page.evaluate(async (mod) => {
    const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
      useActivityBarStore: { getState: () => { close: () => void } };
    };
    m.useActivityBarStore.getState().close();
  }, ACTIVITY);
  await page.waitForTimeout(200);
}

/** Settings > Keyboard Shortcuts, filtered to one command's row. */
async function openShortcutRow(page: Page, label: string) {
  await executeCommand(page, "settings.showTab", "keybindings");
  // The deep link's tab event can fire before the view mounts: pick the tab as a user does.
  const tab = page.locator("button", { hasText: /^Keyboard Shortcuts$/ }).first();
  await tab.waitFor({ state: "visible", timeout: 10_000 });
  await tab.click();
  const search = page.locator('input[placeholder="Search shortcuts..."]');
  await search.waitFor({ state: "visible", timeout: 10_000 });
  await search.fill(label);
  await page.waitForTimeout(300);
  const row = page.locator("tr", { has: page.locator("span", { hasText: new RegExp(`^${label}$`) }) }).first();
  await row.waitFor({ state: "visible", timeout: 5000 });
  return row;
}

async function lifecycle(page: Page, action: "deactivate" | "activate", id: string): Promise<void> {
  await page.evaluate(
    async ({ action, id }) => {
      const l = (window as unknown as { __CALCULA_EXTENSION_LIFECYCLE__?: Record<string, (id: string) => Promise<void>> }).__CALCULA_EXTENSION_LIFECYCLE__;
      if (!l) throw new Error("the dev lifecycle hook (Y15) is not installed");
      await l[action](id);
    },
    { action, id },
  );
  await page.waitForTimeout(400);
}

test.describe("shortcuts run once and follow a remap (K2, K3, K4, D1-D3)", () => {
  test("BUG-0183 K2/D1: Ctrl+K, Ctrl+E, Ctrl+Shift+L, Alt+Shift+Right, Ctrl+Alt+M, Shift+F2 and Ctrl+Shift+B each run exactly once; Ctrl+Shift+V from a ribbon button opens Save Current View", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(180_000);
    try {
      await newFile(page);
      await startToastLog(page);
      await writeCells(page, [
        [0, 0, "Ann Lee"],
        [1, 0, "Bo Kim"],
        [2, 0, "Cy Day"],
        [0, 1, "Ann"],
      ]);

      // Ctrl+K: one Insert Hyperlink dialog.
      await grid.clickCell("D1");
      await focusGrid(page);
      await page.keyboard.press("Control+k");
      const k = await eventually(() => openDialogs(page), (d) => d.length > 0, "Ctrl+K opened nothing");
      expect(k.map((d) => d.id), "Ctrl+K: exactly one Insert Hyperlink").toEqual(["insert-hyperlink"]);
      await closeDialogsAndOverlays(page);

      // Ctrl+E: one Flash Fill, one undo step.
      await grid.clickCell("B2");
      let depth = (await undoState(page)).undoDepth;
      await focusGrid(page);
      await page.keyboard.press("Control+e");
      await eventually(() => cellsOn(page, [[0, 1, 1], [0, 2, 1]]), (v) => v.join() === "Bo,Cy", "Ctrl+E did not flash-fill B2:B3");
      await page.waitForTimeout(500);
      expect((await undoState(page)).undoDepth, "Ctrl+E: exactly one undo step").toBe(depth + 1);

      // Ctrl+Shift+L: one toggle (twice would leave it off).
      await grid.clickCell("A1");
      await focusGrid(page);
      await page.keyboard.press("Control+Shift+L");
      await eventually(() => invoke(page, "get_auto_filter"), (v) => v !== null, "Ctrl+Shift+L did not turn a filter on");
      await page.waitForTimeout(500);
      expect(await invoke(page, "get_auto_filter"), "Ctrl+Shift+L ran twice (the filter is off again)").not.toBeNull();
      await page.keyboard.press("Control+Shift+L");
      await eventually(() => invoke(page, "get_auto_filter"), (v) => v === null, "a second Ctrl+Shift+L did not turn it off");

      // Alt+Shift+Right: one group, one undo step.
      await grid.selectRange("A5", "A7");
      depth = (await undoState(page)).undoDepth;
      await focusGrid(page);
      await page.keyboard.press("Alt+Shift+ArrowRight");
      await eventually(() => undoState(page), (u) => u.undoDepth >= depth + 1, "Alt+Shift+Right grouped nothing");
      await page.waitForTimeout(500);
      expect((await undoState(page)).undoDepth, "Alt+Shift+Right: exactly one undo step").toBe(depth + 1);

      // Ctrl+Alt+M: one comment.
      await grid.clickCell("D2");
      await focusGrid(page);
      await page.keyboard.press("Control+Alt+m");
      await eventually(() => invoke<unknown[]>(page, "get_all_comments"), (c) => c.length > 0, "Ctrl+Alt+M created no comment");
      await page.waitForTimeout(500);
      expect(await invoke<unknown[]>(page, "get_all_comments"), "Ctrl+Alt+M: exactly one comment").toHaveLength(1);
      await closeDialogsAndOverlays(page);

      // Shift+F2: one note.
      await grid.clickCell("D3");
      await focusGrid(page);
      await page.keyboard.press("Shift+F2");
      await eventually(() => invoke<unknown[]>(page, "get_all_notes"), (n) => n.length > 0, "Shift+F2 created no note");
      await page.waitForTimeout(500);
      expect(await invoke<unknown[]>(page, "get_all_notes"), "Shift+F2: exactly one note").toHaveLength(1);
      await closeDialogsAndOverlays(page);

      // Ctrl+Shift+B: one bookmark, one "Bookmark added" toast.
      await grid.clickCell("D4");
      const mark = await toastMark(page);
      await focusGrid(page);
      await page.keyboard.press("Control+Shift+B");
      await eventually(() => callModule<boolean>(page, BOOKMARK_STORE, "hasBookmarkAt", [3, 3, 0]), (v) => v, "Ctrl+Shift+B added no bookmark (BUG-0183)");
      await page.waitForTimeout(500);
      expect((await toastsSince(page, mark)).map((t) => t.message), "Ctrl+Shift+B: one toast").toEqual(["Bookmark added"]);
      expect(await callModule<number>(page, BOOKMARK_STORE, "getBookmarkCount"), "Ctrl+Shift+B: exactly one bookmark").toBe(1);

      // Ctrl+Shift+V from a FOCUSED RIBBON BUTTON: Save Current View.
      await page.locator('[data-testid="fmt-bold"]').focus();
      await page.keyboard.press("Control+Shift+V");
      await eventually(() => openOverlays(page), (o) => o.includes("view-bookmark-creator"), "Ctrl+Shift+V from a ribbon button did not open Save Current View");
      await closeDialogsAndOverlays(page);
    } finally {
      await cleanup(page);
    }
  });

  test("K2 (wa-keys 2): Alt+; selects only the visible cells of A1:A5 with row 3 hidden; the sv-SE Alt+Shift+; does the same", async ({ appPage: page, grid }) => {
    try {
      await newFile(page);
      await writeCells(page, [[0, 0, "1"], [1, 0, "2"], [2, 0, "3"], [3, 0, "4"], [4, 0, "5"]]);
      await callModule(page, API_GRID, "hideRows", [[2], true]);
      await page.waitForTimeout(400);
      const visibleOnly = (s: Awaited<ReturnType<typeof gridSelection>>) => {
        if (!s) return "none";
        const all = [s, ...s.additionalRanges].map((r) => `${Math.min(r.startRow, r.endRow)}-${Math.max(r.startRow, r.endRow)}:${r.startCol}`);
        return all.sort().join(",");
      };
      for (const how of ["Alt+;", "sv-SE"] as const) {
        await grid.selectRange("A1", "A5");
        expect(visibleOnly(await gridSelection(page)), "precondition: A1:A5 as one area").toBe("0-4:0");
        await focusGrid(page);
        if (how === "Alt+;") await page.keyboard.press("Alt+;");
        else await synthKey(page, { key: ";", code: "Comma", altKey: true, shiftKey: true });
        await eventually(async () => visibleOnly(await gridSelection(page)), (v) => v === "0-1:0,3-4:0", `${how} did not select only the visible cells`);
      }
    } finally {
      // Unhide BEFORE the workbook is replaced: the harness's File > New
      // (file-api newFile, no window reload -- the menu's File > New reloads)
      // leaves the grid's hidden-row mirror of the previous document behind
      // (the BUG-0155 class), and row 3 stayed hidden for every later test.
      await callModule(page, API_GRID, "hideRows", [[2], false]).catch(() => undefined);
      await cleanup(page);
    }
  });

  test("D2: Ctrl+Shift+H, Ctrl+Shift+E, Ctrl+Shift+X and Ctrl+Shift+N each toggle their panel once, from the grid and from the formula bar", async ({ appPage: page, grid }) => {
    test.setTimeout(120_000);
    const panels: Array<{ combo: string; view: string }> = [
      { combo: "Control+Shift+H", view: "search" },
      { combo: "Control+Shift+E", view: "explorer" },
      { combo: "Control+Shift+X", view: "extensions" },
      { combo: "Control+Shift+N", view: "script-notebook" },
    ];
    try {
      await newFile(page);
      await closeActivityBar(page);
      for (const where of ["grid", "formula bar"] as const) {
        for (const p of panels) {
          await test.step(`${p.combo} from the ${where}`, async () => {
            await closeActivityBar(page);
            await grid.clickCell("A1");
            if (where === "grid") await focusGrid(page);
            else await grid.formulaBar.click();
            await page.keyboard.press(p.combo);
            await eventually(() => activityState(page), (s) => s.isOpen && s.activeViewId === p.view, `${p.combo} did not open ${p.view}`);
            await page.waitForTimeout(400);
            const s = await activityState(page);
            expect(s, `${p.combo}: ran twice (the panel toggled closed again)`).toEqual({ isOpen: true, activeViewId: p.view });
            await page.keyboard.press("Escape").catch(() => undefined);
          });
        }
      }
    } finally {
      await closeActivityBar(page);
      await cleanup(page);
    }
  });

  test("K2/D2 remap in Settings: Insert Hyperlink moved to Ctrl+Alt+J opens on the new key and not on Ctrl+K; Toggle File Explorer moved to Ctrl+Alt+Shift+E toggles on the new key and not on Ctrl+Shift+E", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(150_000);
    try {
      await newFile(page);
      await closeActivityBar(page);

      // ---- Insert Hyperlink -> Ctrl+Alt+J, through the Settings capture box.
      let row = await openShortcutRow(page, "Insert Hyperlink");
      await row.getByRole("button", { name: "Edit" }).click();
      await page.keyboard.press("Control+Alt+j");
      await expect(page.locator("tr").filter({ hasText: "Insert Hyperlink" }).first(), "the capture box does not show the recorded key").toContainText("Ctrl+Alt+J");
      await page.locator("tr").filter({ hasText: "Insert Hyperlink" }).first().getByRole("button", { name: "Accept" }).click();
      await eventually(() => callModule<string>(page, API_KEYBINDINGS, "getEffectiveCombo", ["ext.hyperlinks.insert"]), (c) => c === "Ctrl+Alt+J", "Accept did not store Ctrl+Alt+J");

      // ---- Toggle File Explorer -> Ctrl+Alt+Shift+E.
      row = await openShortcutRow(page, "Toggle File Explorer");
      await row.getByRole("button", { name: "Edit" }).click();
      await page.keyboard.press("Control+Alt+Shift+E");
      await expect(page.locator("tr").filter({ hasText: "Toggle File Explorer" }).first()).toContainText("Ctrl+Alt+Shift+E");
      await page.locator("tr").filter({ hasText: "Toggle File Explorer" }).first().getByRole("button", { name: "Accept" }).click();
      await eventually(() => callModule<string>(page, API_KEYBINDINGS, "getEffectiveCombo", ["ext.fileExplorer.toggle"]), (c) => c === "Ctrl+Alt+Shift+E", "Accept did not store Ctrl+Alt+Shift+E");
      await closeActivityBar(page);

      // Ctrl+K now does NOTHING; Ctrl+Alt+J opens Insert Hyperlink.
      await grid.clickCell("A1");
      await focusGrid(page);
      await page.keyboard.press("Control+k");
      await page.waitForTimeout(700);
      expect(await openDialogs(page), "Ctrl+K still opened Insert Hyperlink after the remap").toEqual([]);
      await focusGrid(page);
      await page.keyboard.press("Control+Alt+j");
      await eventually(() => openDialogs(page), (d) => d.some((x) => x.id === "insert-hyperlink"), "Ctrl+Alt+J did not open Insert Hyperlink");
      await closeDialogsAndOverlays(page);

      // Ctrl+Shift+E does nothing; Ctrl+Alt+Shift+E opens the explorer.
      await grid.clickCell("A1");
      await focusGrid(page);
      await page.keyboard.press("Control+Shift+E");
      await page.waitForTimeout(700);
      expect((await activityState(page)).isOpen, "Ctrl+Shift+E still toggled the File Explorer after the remap").toBe(false);
      await focusGrid(page);
      await page.keyboard.press("Control+Alt+Shift+E");
      await eventually(() => activityState(page), (s) => s.isOpen && s.activeViewId === "explorer", "Ctrl+Alt+Shift+E did not open the File Explorer");
    } finally {
      await resetKeybindings(page);
      await closeActivityBar(page);
      await cleanup(page);
    }
  });

  test("K3 (BUG-0199): the Settings capture box records Ctrl+S without saving, also the Add Shortcut box, with or without a row box open; Ctrl+S outside the box saves (positive control)", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(150_000);
    const path = `${process.env.TEMP ?? "C:/Windows/Temp"}\\calcula-fixall-edit-capture.cala`;
    try {
      await newFile(page);
      await writeCells(page, [[0, 0, "saved"]]);
      await invoke(page, "save_file", { path });
      expect(await invoke<string | null>(page, "get_current_file_path"), "precondition: the workbook has a path, so Ctrl+S saves silently").toBeTruthy();
      await writeCells(page, [[0, 0, "dirty"]]);
      await eventually(() => invoke<boolean>(page, "is_file_modified"), (v) => v, "precondition: the workbook is dirty");

      // A row's box.
      const row = await openShortcutRow(page, "Copy");
      await row.getByRole("button", { name: "Edit" }).click();
      await page.keyboard.press("Control+s");
      await expect(page.locator("tr").filter({ hasText: "Press key combination" }).or(page.locator("tr").filter({ hasText: "Ctrl+S" })).first()).toContainText("Ctrl+S");
      await page.waitForTimeout(600);
      expect(await invoke<boolean>(page, "is_file_modified"), "Ctrl+S in the row's capture box SAVED the workbook").toBe(true);
      await page.locator("tr").filter({ hasText: "Ctrl+S" }).first().getByRole("button", { name: "Cancel" }).click();

      // The Add Shortcut box, after a row Edit was opened and cancelled with Escape.
      await page.getByRole("button", { name: "+ Add Shortcut" }).click();
      const copyRow = page.locator("tr", { has: page.locator("span", { hasText: /^Copy$/ }) }).first();
      await copyRow.getByRole("button", { name: "Edit" }).click();
      await page.keyboard.press("Escape");
      const addBox = page.locator("div[tabindex='0']", { hasText: /^Click here and press a key combination\.\.\.$/ });
      await addBox.click();
      await page.keyboard.press("Control+s");
      await expect(page.locator("div[tabindex='0']", { hasText: /^Ctrl\+S$/ }).first(), "the Add box did not record Ctrl+S").toBeVisible();
      await page.waitForTimeout(600);
      expect(await invoke<boolean>(page, "is_file_modified"), "Ctrl+S in the Add box SAVED the workbook").toBe(true);

      // Again with the row's Edit still OPEN while the Add box records.
      await copyRow.getByRole("button", { name: "Edit" }).click();
      await page.locator("div[tabindex='0']", { hasText: /^Ctrl\+S$/ }).first().click();
      await page.keyboard.press("Control+s");
      await page.waitForTimeout(600);
      expect(await invoke<boolean>(page, "is_file_modified"), "Ctrl+S with both boxes open SAVED the workbook").toBe(true);
      await page.keyboard.press("Escape");
      await closeActivityBar(page);

      // POSITIVE CONTROL: Ctrl+S on the grid saves (the key does arrive).
      await grid.clickCell("B2");
      await focusGrid(page);
      await page.keyboard.press("Control+s");
      await eventually(() => invoke<boolean>(page, "is_file_modified"), (v) => v === false, "Ctrl+S on the grid did not save (the key does not arrive?)");
    } finally {
      await resetKeybindings(page);
      await closeActivityBar(page);
      await cleanup(page);
    }
  });

  test("K3 (BUG-0199): Ctrl+Shift+C starts ONE Format Painter from the grid and from a focused ribbon button; one click paints once", async ({ appPage: page, grid }) => {
    try {
      await newFile(page);
      await writeCells(page, [[0, 0, "src"], [1, 1, "dst"]]);
      await invoke(page, "apply_formatting", { params: { rows: [0], cols: [0], bold: true } });
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
      const active = () => callModule<boolean>(page, FORMAT_PAINTER_STATE, "isFormatPainterActive");
      const clip = () => page.evaluate(() => (window as unknown as AppWindow).__CALCULA_GRID_STATE__?.clipboard?.mode ?? "none");

      await grid.clickCell("A1");
      await focusGrid(page);
      await page.keyboard.press("Control+Shift+C");
      await eventually(active, (v) => v === true, "Ctrl+Shift+C did not start Format Painter (or started it twice)");
      await page.waitForTimeout(400);
      expect(await active(), "Format Painter started twice (toggled off again)").toBe(true);
      expect(await clip(), "no marching ants around the source").toBe("copy");

      const depth = (await undoState(page)).undoDepth;
      const r = await paintWithFormatPainter(page, grid, "B2", async () => (await styleAt(page, 1, 1)).bold === true);
      expect.soft(
        r.firstClickPainted,
        `the FIRST click on B2 after Ctrl+Shift+C painted nothing (a second click ${r.secondClickPainted ? "did paint" : "did not paint either"})`,
      ).toBe(true);
      expect(r.firstClickPainted || r.secondClickPainted, "Format Painter never painted B2").toBe(true);
      await page.waitForTimeout(500);
      expect((await undoState(page)).undoDepth, "one click painted more than once").toBe(depth + 1);
      expect(await active(), "single-use Format Painter stayed on").toBe(false);

      // From a focused ribbon button.
      await grid.clickCell("A1");
      await page.locator('[data-testid="fmt-italic"]').focus();
      await page.keyboard.press("Control+Shift+C");
      await eventually(active, (v) => v === true, "Ctrl+Shift+C from a ribbon button did not start Format Painter");
      await page.keyboard.press("Escape");
      await eventually(active, (v) => v === false, "Escape did not stop Format Painter");
    } finally {
      await cleanup(page);
    }
  });

  test("K3 (BUG-0199) stuck edit flag: Format Painter, click the formula bar, Escape, click the ribbon, type in a cell -- Ctrl+Z undoes it", async ({ appPage: page, grid }) => {
    try {
      await newFile(page);
      await grid.clickCell("A1");
      await page.locator('[data-testid="fmt-formatPainter"]').click();
      await eventually(() => callModule<boolean>(page, FORMAT_PAINTER_STATE, "isFormatPainterActive"), (v) => v, "Format Painter did not start");
      await grid.formulaBar.click();
      await page.waitForTimeout(300);
      expect(await gridEditing(page), "the formula bar opened an edit while Format Painter is active (its edit guard)").toBeNull();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      expect(await callModule<boolean>(page, FORMAT_PAINTER_STATE, "isFormatPainterActive"), "Escape did not stop Format Painter").toBe(false);
      // "Click a ribbon button": switch the ribbon to Page Layout and back to Home
      // (acts on nothing; re-clicking the ACTIVE tab would collapse the ribbon).
      await clickRibbonTab(page, "Page Layout");
      await clickRibbonTab(page, "Home");
      await page.waitForTimeout(300);
      expect(await coreEditOpen(page), "Core's edit flag is stuck up after the refused formula-bar edit").toBe(false);
      await grid.clickCell("C3");
      await page.keyboard.type("q");
      await eventually(() => gridEditing(page), (e) => e?.value === "q", `typing q into C3 opened no edit (focus ${JSON.stringify(await focusInfo(page))})`);
      await page.keyboard.press("Enter");
      await eventually(() => cellsOn(page, [[0, 2, 2]]), (v) => v[0] === "q", "typing into C3 did not commit").catch(async (e) => {
        const around = await invoke(page, "get_range_cells_typed", { startRow: 0, startCol: 0, endRow: 8, endCol: 6 });
        throw new Error(`${String(e)} | selection ${JSON.stringify(await gridSelection(page))} | editing ${JSON.stringify(await gridEditing(page))} | cells ${JSON.stringify(around)}`);
      });
      await focusGrid(page);
      await page.keyboard.press("Control+z");
      await eventually(() => cellsOn(page, [[0, 2, 2]]), (v) => v[0] === "", "Ctrl+Z did not undo the entry (the edit flag stood it down)");
    } finally {
      await cleanup(page);
    }
  });

  test("K4: Shift+Backspace collapses B3:D6 to D6; Ctrl+Backspace scrolls D6 back into view and leaves the selection alone", async ({ appPage: page, grid }) => {
    try {
      await newFile(page);
      await grid.selectRange("B3", "D6");
      expect(await gridSelection(page), "precondition: B3:D6 selected with D6 active").toMatchObject({ startRow: 2, startCol: 1, endRow: 5, endCol: 3 });
      await focusGrid(page);
      await page.keyboard.press("Shift+Backspace");
      await eventually(() => gridSelection(page), (s) => !!s && s.startRow === 5 && s.endRow === 5 && s.startCol === 3 && s.endCol === 3, "Shift+Backspace did not collapse to the active cell D6");

      await grid.selectRange("B3", "D6");
      expect(await gridSelection(page), "precondition (2nd): B3:D6 selected again").toMatchObject({ startRow: 2, startCol: 1, endRow: 5, endCol: 3 });
      await page.locator("canvas").first().hover();
      for (let i = 0; i < 40; i++) {
        await page.mouse.wheel(0, 400);
        await page.waitForTimeout(30);
      }
      const scrolled = await eventually(
        () => page.evaluate(() => (window as unknown as AppWindow).__CALCULA_GRID_STATE__?.viewport?.scrollY ?? 0),
        (y) => y > 1000,
        "the wheel did not scroll the grid away",
      );
      await focusGrid(page);
      await page.keyboard.press("Control+Backspace");
      await eventually(
        () => page.evaluate(() => (window as unknown as AppWindow).__CALCULA_GRID_STATE__?.viewport?.scrollY ?? 0),
        (y) => y < scrolled && y <= 5 * 20,
        "Ctrl+Backspace did not scroll D6 back into view",
      );
      expect(await gridSelection(page), "Ctrl+Backspace changed the selection").toMatchObject({ startRow: 2, startCol: 1, endRow: 5, endCol: 3 });
    } finally {
      await cleanup(page);
    }
  });

  test("D3 (wb-doors 5/10): with Cell Bookmarks deactivated Ctrl+Shift+B does nothing and Insert > Bookmarks and its right-click items are gone; re-activated, exactly one Insert > Bookmarks returns and the key works", async ({ appPage: page, grid }) => {
    test.setTimeout(120_000);
    let deactivated = false;
    try {
      await newFile(page);
      expect(await menuItemCount(page, ["Insert", "Bookmarks"]), "precondition: Insert > Bookmarks exists").toBe(1);
      await lifecycle(page, "deactivate", LIFECYCLE_BOOKMARKS);
      deactivated = true;
      expect(await menuItemCount(page, ["Insert", "Bookmarks"]), "Insert > Bookmarks survived the deactivate").toBe(0);
      await grid.clickCell("B2");
      await focusGrid(page);
      await page.keyboard.press("Control+Shift+B");
      await page.waitForTimeout(700);
      expect(await callModule<boolean>(page, BOOKMARK_STORE, "hasBookmarkAt", [1, 1, 0]), "Ctrl+Shift+B still added a bookmark with the extension off").toBe(false);
      // Right-click menu: no bookmark items.
      const p = await grid.cellCenterScrollAware("B2");
      await page.locator("canvas").first().click({ button: "right", position: p, force: true });
      const menuText = await page.locator('[role="menu"][aria-label="Context menu"]').first().innerText().catch(() => "");
      expect(menuText, "the right-click menu kept bookmark items").not.toMatch(/bookmark/i);
      expect(menuText.length, "precondition: the right-click menu opened").toBeGreaterThan(0);
      await page.keyboard.press("Escape");

      await lifecycle(page, "activate", LIFECYCLE_BOOKMARKS);
      deactivated = false;
      expect(await menuItemCount(page, ["Insert", "Bookmarks"]), "Insert > Bookmarks did not come back exactly once").toBe(1);
      await grid.clickCell("B2");
      await focusGrid(page);
      await page.keyboard.press("Control+Shift+B");
      await eventually(() => callModule<boolean>(page, BOOKMARK_STORE, "hasBookmarkAt", [1, 1, 0]), (v) => v, "Ctrl+Shift+B did not work after re-activating");

      // The same for Format Painter's Edit menu item (wb-doors fixup 10).
      expect(await menuItemCount(page, ["Edit", "Format Painter"]), "precondition: Edit > Format Painter exists").toBe(1);
      await lifecycle(page, "deactivate", "calcula.builtin.format-painter");
      try {
        expect(await menuItemCount(page, ["Edit", "Format Painter"]), "Edit > Format Painter survived the deactivate").toBe(0);
      } finally {
        await lifecycle(page, "activate", "calcula.builtin.format-painter");
      }
      expect(await menuItemCount(page, ["Edit", "Format Painter"]), "Edit > Format Painter did not come back exactly once").toBe(1);
    } finally {
      if (deactivated) await lifecycle(page, "activate", LIFECYCLE_BOOKMARKS).catch(() => undefined);
      await cleanup(page);
    }
  });
});

// ===========================================================================
// 3. sv-SE / AltGr (synthetic keydowns: Chromium on Windows reports AltGr as
//    Ctrl+Alt with the layout's character, which Playwright cannot emulate)
// ===========================================================================

const ALTGR: Array<{ ch: string; code: string; name: string }> = [
  { ch: "@", code: "Digit2", name: "AltGr+2" },
  { ch: "$", code: "Digit4", name: "AltGr+4" },
  { ch: "{", code: "Digit7", name: "AltGr+7" },
  { ch: "}", code: "Digit0", name: "AltGr+0" },
  { ch: "€", code: "KeyE", name: "AltGr+E" },
  { ch: "[", code: "Digit8", name: "AltGr+8" },
  { ch: "]", code: "Digit9", name: "AltGr+9" },
  { ch: "µ", code: "KeyM", name: "AltGr+M" },
];
const altGr = (ch: string, code: string) => ({ key: ch, code, ctrlKey: true, altKey: true });

async function seedBookmarks(page: Page): Promise<void> {
  await callModule(page, BOOKMARK_STORE, "addBookmark", [1, 1, 0, "Sheet1"]); // B2
  await callModule(page, BOOKMARK_STORE, "addBookmark", [4, 2, 0, "Sheet1"]); // C5
  expect(await callModule<number>(page, BOOKMARK_STORE, "getBookmarkCount")).toBe(2);
}

const selAt = async (page: Page) => {
  const s = await gridSelection(page);
  return s ? [s.startRow, s.startCol, s.endRow, s.endCol] : null;
};

/**
 * Bring the tab strip, the grid state and the backend onto one sheet by
 * clicking its tab (twice when the strip thinks it is already there).
 */
async function resyncOn(page: Page, index: number): Promise<void> {
  const uiIndex = () => page.evaluate(() => (window as unknown as { __CALCULA_GRID_STATE__?: { sheetContext?: { activeSheetIndex: number } } }).__CALCULA_GRID_STATE__?.sheetContext?.activeSheetIndex ?? -1);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.locator(`button[data-sheet-tab="${index}"]`).click();
    await page.waitForTimeout(700);
    if ((await activeSheet(page)) === index && (await uiIndex()) === index) return;
  }
  throw new Error(`could not bring the app back onto sheet ${index}`);
}

async function addCanvas(page: Page): Promise<{ index: number; name: string }> {
  const before = await sheets(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sheet:requestAdd", { detail: { kind: "canvas" } })));
  const after = await eventually(
    () => sheets(page),
    (r) => r.sheets.length === before.sheets.length + 1 && r.sheets.some((s) => s.kind === "canvas"),
    "no canvas was added",
  );
  await page.waitForTimeout(500);
  const c = after.sheets.find((s) => s.kind === "canvas")!;
  return { index: c.index, name: c.name };
}

test.describe("sv-SE and AltGr keys (W17, E13, X16, D5, R5)", () => {
  test("W17/E13: in ready mode on a Core cell AltGr+2/4/7/0/E/8/9/M open the editor with @ $ { } € [ ] µ -- no bookmark jump, no New Comment; in an open edit Ctrl+Alt+] does not navigate; the exact US Ctrl+] still jumps", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(150_000);
    try {
      await newFile(page);
      await seedBookmarks(page);
      for (const k of ALTGR) {
        await test.step(k.name, async () => {
          await grid.clickCell("A1");
          await focusGrid(page);
          await synthKey(page, altGr(k.ch, k.code));
          await eventually(() => gridEditing(page), (e) => !!e && e.row === 0 && e.col === 0 && e.value === k.ch, `${k.name} did not open A1's editor with "${k.ch}"`);
          expect(await selAt(page), `${k.name}: the selection jumped (a bookmark command ran)`).toEqual([0, 0, 0, 0]);
          expect(await invoke<unknown[]>(page, "get_all_comments"), `${k.name}: a New Comment ran`).toEqual([]);
          await page.keyboard.press("Escape");
          await eventually(() => gridEditing(page), (e) => e === null, `${k.name}: Escape did not cancel`);
        });
      }
      expect(await cellsOn(page, [[0, 0, 0]]), "A1 was written by a cancelled edit").toEqual([""]);

      // In an OPEN edit, Ctrl+Alt+] is the editor's (no navigation).
      await grid.clickCell("A1");
      await page.keyboard.type("z");
      await eventually(() => gridEditing(page), (e) => e?.value === "z", "typing did not open an edit");
      await synthKey(page, altGr("]", "Digit9"));
      await page.waitForTimeout(400);
      expect(await selAt(page), "Ctrl+Alt+] in an open edit navigated to a bookmark").toEqual([0, 0, 0, 0]);
      expect((await gridEditing(page))?.value, "the open edit was ended or rewritten").toBe("z");
      await page.keyboard.press("Escape");

      // POSITIVE CONTROL: the exact US shortcut still jumps to the next bookmark.
      await grid.clickCell("A1");
      await focusGrid(page);
      await page.keyboard.press("Control+]");
      await eventually(() => selAt(page), (s) => JSON.stringify(s) === "[1,1,1,1]", "Ctrl+] (exact) did not jump to the bookmark on B2");
    } finally {
      await cleanup(page);
    }
  });

  test("W17: on a floating grid's selected CELL AltGr+9 / AltGr+2 open its editor; with only the FRAME selected AltGr+9 is Next Bookmark and writes nothing, and typing a or F2 is refused once; from a focused ribbon button AltGr+9 is Next Bookmark; Insert > Bookmarks > Next and Review > New Comment still work", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(180_000);
    try {
      await newFile(page);
      await startToastLog(page);
      await seedBookmarks(page);
      const fr = await createFr(page, FR_POS.x, FR_POS.y, "AltGrFR");

      for (const k of [ALTGR[6], ALTGR[0]]) {
        await test.step(`${k.name} on a floating-grid cell`, async () => {
          await claimWithFrCell(page, grid, fr);
          await synthKey(page, altGr(k.ch, k.code));
          await eventually(() => frEditorOpen(page), (v) => v, `${k.name} did not open the floating grid's editor`);
          expect(await frEditorText(page), `${k.name}: the editor did not start with "${k.ch}"`).toBe(k.ch);
          expect(await selAt(page), `${k.name}: Core's hidden selection moved`).toEqual([0, 0, 0, 0]);
          await page.keyboard.press("Escape");
          await eventually(() => frEditorOpen(page), (v) => !v, "Escape did not close the floating grid's editor");
        });
      }
      expect((await frCell(page, fr.id, 0, 0))?.formula ?? null, "a cancelled edit wrote the floating grid's cell").toBeNull();

      // The FRAME (no cell): AltGr+9 is Next Bookmark.
      await grid.clickCell("A1");
      const title = await frTitlePoint(page, fr);
      await page.mouse.click(title.x, title.y);
      await eventually(() => frObjectSelected(page), (id) => id === fr.id, "clicking the title did not select the floating grid as an object");
      expect(await frLocalSelection(page), "precondition: no cell of the grid is selected").toBeNull();
      expect(await selectionOwned(page), "precondition: the frame claims the selection").toBe(true);
      await focusGrid(page);
      await synthKey(page, altGr("]", "Digit9"));
      await eventually(() => selAt(page), (s) => JSON.stringify(s) === "[1,1,1,1]", "AltGr+9 with the frame selected did not go to the next bookmark (B2)");
      expect(await coreEditOpen(page), "AltGr+9 with the frame selected opened Core's hidden cell").toBe(false);

      // The FRAME: typing and F2 are refused once each; nothing under it changes.
      await grid.clickCell("A1");
      await page.mouse.click(title.x, title.y);
      await eventually(() => frObjectSelected(page), (id) => id === fr.id, "re-selecting the frame failed");
      await focusGrid(page);
      for (const k of ["a", "F2"]) {
        const mark = await toastMark(page);
        await page.keyboard.press(k);
        await expectOneRefusal(page, mark, `frame + ${k}`);
        expect(await coreEditOpen(page), `frame + ${k}: Core's hidden cell was opened for editing`).toBe(false);
      }
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
      expect(await cellsOn(page, [[0, 0, 0]]), "A1 (under the claim) changed").toEqual([""]);
      const under = await invoke<unknown[]>(page, "get_range_cells_typed", { startRow: 0, startCol: 0, endRow: 30, endCol: 12 });
      expect(under, "a sheet cell under or near the frame was written").toEqual([]);

      // A focused RIBBON BUTTON: AltGr+9 is Next Bookmark (no cell takes typing there).
      await grid.clickCell("A1");
      await page.locator('[data-testid="fmt-bold"]').focus();
      await synthKey(page, altGr("]", "Digit9"));
      await eventually(() => selAt(page), (s) => JSON.stringify(s) === "[1,1,1,1]", "AltGr+9 from a ribbon button did not go to the next bookmark");

      // The commands stay reachable from their menus.
      await grid.clickCell("A1");
      await runMenuItem(page, ["Insert", "Bookmarks", "Next Bookmark"]);
      await eventually(() => selAt(page), (s) => JSON.stringify(s) === "[1,1,1,1]", "Insert > Bookmarks > Next did not go to the next bookmark");
      await grid.clickCell("D2");
      await runMenuItem(page, ["Review", "New Comment"]);
      await eventually(() => invoke<unknown[]>(page, "get_all_comments"), (c) => c.length === 1, "Review > New Comment created no comment");
    } finally {
      await cleanup(page);
    }
  });

  test("X16: on a canvas with nothing selected AltGr+9 / AltGr+8 are Next / Previous Bookmark; on a worksheet cell AltGr+9 types ]; on a canvas floating grid's cell it types into that cell", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(150_000);
    try {
      await newFile(page);
      await seedBookmarks(page);
      const canvas = await addCanvas(page);
      expect(await activeSheet(page)).toBe(canvas.index);
      await focusGrid(page);
      expect(await gridSelection(page), "precondition: a canvas has no cell selection").toBeNull();
      const landed = async () => ({
        sel: await selAt(page),
        surface: await page.evaluate(() => (window as unknown as { __CALCULA_GRID_STATE__?: { surface?: string } }).__CALCULA_GRID_STATE__?.surface ?? null),
      });
      // FIRST jump from the freshly added canvas: the exact US Ctrl+] (no AltGr).
      await page.keyboard.press("Control+]");
      await eventually(() => activeSheet(page), (i) => i === 0, "Ctrl+] from a fresh canvas did not run Next Bookmark");
      await page.waitForTimeout(700);
      expect.soft(await landed(), "the FIRST Next Bookmark from a freshly added canvas (exact Ctrl+]) switched the backend to Sheet1 but did not select B2").toEqual({ sel: [1, 1, 1, 1], surface: "grid" });
      // Is the tab strip on the sheet the backend shows? Clicking the canvas tab must go back to it.
      await page.locator(`button[data-sheet-tab="${canvas.index}"]`).click();
      await page.waitForTimeout(1200);
      expect.soft(await activeSheet(page), "after that jump, clicking the canvas tab did not go back to the canvas (the tab strip still thinks the canvas is active)").toBe(canvas.index);
      await resyncOn(page, 0);
      await resyncOn(page, canvas.index);

      // X16 itself: on the canvas with nothing selected, AltGr+9 is Next Bookmark again.
      await focusGrid(page);
      expect(await gridSelection(page), "precondition: back on the canvas, nothing selected").toBeNull();
      await synthKey(page, altGr("]", "Digit9"));
      await eventually(() => activeSheet(page), (i) => i === 0, "AltGr+9 on an empty canvas did not run Next Bookmark (no switch to Sheet1)");
      await page.waitForTimeout(700);
      expect.soft(await landed(), "AltGr+9 from a canvas switched to Sheet1 but did not select B2").toEqual({ sel: [1, 1, 1, 1], surface: "grid" });
      await resyncOn(page, 0);
      await resyncOn(page, canvas.index);
      await focusGrid(page);
      await synthKey(page, altGr("[", "Digit8"));
      await eventually(() => activeSheet(page), (i) => i === 0, "AltGr+8 on an empty canvas did not run Previous Bookmark");
      await page.waitForTimeout(700);
      expect.soft(await landed(), "Previous Bookmark from a canvas did not select C5").toEqual({ sel: [4, 2, 4, 2], surface: "grid" });

      // On a worksheet CELL, AltGr+9 types. (Arrive through the tab strip, so
      // Sheet1 is entered as a worksheet whatever the bookmark jump left.)
      await resyncOn(page, canvas.index);
      await resyncOn(page, 0);
      await grid.clickCell("A1");
      await focusGrid(page);
      await synthKey(page, altGr("]", "Digit9"));
      await eventually(() => gridEditing(page), (e) => e?.value === "]", "AltGr+9 on a worksheet cell did not start an entry with ]");
      await page.keyboard.press("Escape");

      // On a canvas floating grid's CELL, AltGr+9 types into that cell.
      await resyncOn(page, canvas.index);
      const fr = await createFr(page, 640, 96, "CanvasAltGr");
      await clickFrCell(page, fr, 0, 0);
      await eventually(() => frLocalSelection(page), (s) => s !== null, "the canvas floating grid's cell was not selected");
      await synthKey(page, altGr("]", "Digit9"));
      await eventually(() => frEditorOpen(page), (v) => v, "AltGr+9 on a canvas floating grid's cell did not open its editor");
      expect(await frEditorText(page)).toBe("]");
      await page.keyboard.press("Escape");
    } finally {
      await cleanup(page);
    }
  });

  test("D5: sv-SE Ctrl+; (Ctrl+Shift+Comma) enters today's date, Ctrl+Shift+4/2/6 typed as ¤ \" & apply Currency/Time/Scientific, Ctrl+Shift+: (Semicolon) enters the time", async ({ appPage: page, grid }) => {
    try {
      await newFile(page);
      // Numbers that are numbers in ANY locale ("1234.5" is text in sv-SE).
      await writeCells(page, [[0, 1, "1234"], [1, 1, "=1/2"], [2, 1, "12345"]]);
      const now = new Date();
      const dateText = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;

      await grid.clickCell("A1");
      await focusGrid(page);
      await synthKey(page, { key: ";", code: "Comma", ctrlKey: true, shiftKey: true });
      const a1 = await eventually(() => cellAt(page, 0, 0), (c) => !!c && String(c.display ?? "") !== "", "Ctrl+Shift+Comma (sv-SE Ctrl+;) entered nothing");
      const typed = await invoke<Array<{ value: unknown }>>(page, "get_range_cells_typed", { startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
      const serial = Math.floor((Date.now() - now.getTimezoneOffset() * 60_000) / 86_400_000) + 25569;
      const v = typed[0]?.value;
      expect(v === serial || String(a1!.display) === dateText || String(v) === dateText, `A1 is not today's date: display ${a1!.display}, value ${JSON.stringify(v)}`).toBe(true);

      const fmt: Array<{ ref: string; row: number; key: string; code: string; want: RegExp; what: string }> = [
        { ref: "B1", row: 0, key: "¤", code: "Digit4", want: /\$/, what: "Currency" },
        { ref: "B2", row: 1, key: '"', code: "Digit2", want: /\d{1,2}:\d{2}/, what: "Time" },
        { ref: "B3", row: 2, key: "&", code: "Digit6", want: /E\+/i, what: "Scientific" },
      ];
      // CONTROL: the US-layout keystroke (key "$" on Digit4) through the same grid door.
      await writeCells(page, [[3, 1, "77"]]);
      await grid.clickCell("B4");
      await focusGrid(page);
      await page.keyboard.press("Control+Shift+Digit4");
      await eventually(() => cellsOn(page, [[0, 3, 1]]), (d) => /$/.test(d[0]), "control: the US Ctrl+Shift+4 did not apply Currency either");
      await startKeyLog(page);
      for (const f of fmt) {
        await grid.clickCell(f.ref);
        await focusGrid(page);
        const selBefore = await gridSelection(page);
        const prevented = await synthKey(page, { key: f.key, code: f.code, ctrlKey: true, shiftKey: true });
        await eventually(() => cellsOn(page, [[0, f.row, 1]]), (d) => f.want.test(d[0]), `Ctrl+Shift+${f.code} typed as ${f.key} did not apply ${f.what}`).catch(async (e) => {
          const fmts = await Promise.all([0, 1, 2, 3].map(async (r) => `B${r + 1}=${(await styleAt(page, r, 1)).numberFormat}`));
          throw new Error(`${String(e)} | prevented=${prevented} | selection before ${JSON.stringify(selBefore)} | formats ${fmts.join(",")} | keys ${JSON.stringify(await keyLog(page))} | focus ${JSON.stringify(await focusInfo(page))}`);
        });
      }

      await grid.clickCell("C1");
      await focusGrid(page);
      await synthKey(page, { key: ":", code: "Semicolon", ctrlKey: true, shiftKey: true });
      const c1 = await eventually(() => cellsOn(page, [[0, 0, 2]]), (d) => d[0] !== "", "Ctrl+Shift+: entered nothing");
      expect(c1[0], "Ctrl+Shift+: entered a date instead of the time").toMatch(/\d{1,2}:\d{2}/);
      expect(c1[0]).not.toContain("/");
    } finally {
      await cleanup(page);
    }
  });

  test("R5 (reversed by W17): real Ctrl+Alt+M opens one New Comment; sv-SE AltGr+M in ready mode types µ; in an open edit the dispatcher leaves it alone; Settings records the sv-SE keystroke as Ctrl+Alt+M and it then runs its new command; Ctrl+& (Digit1) opens Format Cells once", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(150_000);
    try {
      await newFile(page);
      await closeActivityBar(page);
      await grid.clickCell("B2");
      await focusGrid(page);
      await page.keyboard.press("Control+Alt+m");
      await eventually(() => invoke<unknown[]>(page, "get_all_comments"), (c) => c.length === 1, "real Ctrl+Alt+M did not open one New Comment");
      await closeDialogsAndOverlays(page);

      await grid.clickCell("C2");
      await focusGrid(page);
      await synthKey(page, altGr("µ", "KeyM"));
      await eventually(() => gridEditing(page), (e) => e?.value === "µ", "sv-SE AltGr+M in ready mode did not type µ");
      expect(await invoke<unknown[]>(page, "get_all_comments"), "AltGr+M in ready mode ran New Comment").toHaveLength(1);
      await page.keyboard.press("Escape");

      await grid.clickCell("D2");
      await page.keyboard.type("x");
      await eventually(() => gridEditing(page), (e) => e?.value === "x", "typing did not open an edit");
      const prevented = await synthKey(page, altGr("µ", "KeyM"));
      expect(prevented, "the dispatcher took AltGr+M inside an open edit").toBe(false);
      expect(await invoke<unknown[]>(page, "get_all_comments"), "AltGr+M in an open edit ran New Comment").toHaveLength(1);
      await page.keyboard.press("Escape");

      // Settings: move New Comment away, record the sv-SE Ctrl+Alt+M for Insert Hyperlink.
      let row = await openShortcutRow(page, "New Comment");
      await row.getByRole("button", { name: "Edit" }).click();
      await page.keyboard.press("Control+Alt+Shift+K");
      await page.locator("tr").filter({ hasText: "New Comment" }).first().getByRole("button", { name: "Accept" }).click();
      await eventually(() => callModule<string>(page, API_KEYBINDINGS, "getEffectiveCombo", ["ext.review.newComment"]), (c) => c === "Ctrl+Alt+Shift+K", "New Comment was not moved");
      row = await openShortcutRow(page, "Insert Hyperlink");
      await row.getByRole("button", { name: "Edit" }).click();
      await page.waitForTimeout(200);
      await synthKey(page, altGr("µ", "KeyM"));
      await expect(page.locator("tr").filter({ hasText: "Insert Hyperlink" }).first(), "the capture box did not record the sv-SE keystroke as Ctrl+Alt+M").toContainText("Ctrl+Alt+M");
      await page.locator("tr").filter({ hasText: "Insert Hyperlink" }).first().getByRole("button", { name: "Accept" }).click();
      await eventually(() => callModule<string>(page, API_KEYBINDINGS, "getEffectiveCombo", ["ext.hyperlinks.insert"]), (c) => c === "Ctrl+Alt+M", "Accept did not store Ctrl+Alt+M");
      await closeActivityBar(page);
      await grid.clickCell("E2");
      await focusGrid(page);
      await page.keyboard.press("Control+Alt+m");
      await eventually(() => openDialogs(page), (d) => d.some((x) => x.id === "insert-hyperlink"), "Ctrl+Alt+M did not run its new command (Insert Hyperlink)");
      expect(await invoke<unknown[]>(page, "get_all_comments"), "Ctrl+Alt+M still made a comment").toHaveLength(1);
      await closeDialogsAndOverlays(page);

      // AZERTY / sv-SE-style Ctrl+Digit1 typed as "&": Format Cells once.
      await grid.clickCell("A1");
      await focusGrid(page);
      await synthKey(page, { key: "&", code: "Digit1", ctrlKey: true });
      const d = await eventually(() => openDialogs(page), (x) => x.length > 0, "Ctrl+Digit1 typed as & did not open Format Cells");
      expect(d.map((x) => x.id)).toEqual(["format-cells"]);
    } finally {
      await resetKeybindings(page);
      await closeActivityBar(page);
      await cleanup(page);
    }
  });

  test("NEW (found live): the Font Color popover's hex field + Enter applies the colour ONCE -- one undo step on a sheet cell, one refusal on a floating-grid cell", async ({ appPage: page, grid }) => {
    try {
      await newFile(page);
      await startToastLog(page);
      await writeCells(page, [[0, 0, "keep"], [1, 0, "paint"]]);
      await grid.clickCell("A2");
      const depth = (await undoState(page)).undoDepth;
      await page.locator('[data-testid="fmt-textColor"]').click();
      const hex = page.locator('[data-testid="fmt-textColor-popover-hex"]');
      await hex.fill("#FF0000");
      await hex.press("Enter");
      await eventually(() => styleAt(page, 1, 0), (s) => String(s.textColor).toLowerCase().includes("ff0000"), "hex + Enter did not colour A2");
      await page.waitForTimeout(600);
      expect.soft((await undoState(page)).undoDepth, "hex + Enter applied the colour more than once (undo steps)").toBe(depth + 1);

      const fr = await createFr(page, FR_POS.x, FR_POS.y, "HexFR");
      await claimWithFrCell(page, grid, fr);
      const mark = await toastMark(page);
      await page.locator('[data-testid="fmt-textColor"]').click();
      await hex.fill("#00AA00");
      await hex.press("Enter");
      await expectOneRefusal(page, mark, "Font Color hex + Enter");
    } finally {
      await cleanup(page);
    }
  });
});

// ===========================================================================
// 4. THE FLOATING-GRID EDIT SEAM (E1-E4, E6, E9, E12, W12)
// ===========================================================================

const PIVOT_API = "/extensions/Pivot/lib/pivot-api.ts";
const LIFECYCLE_FR = "calcula.floating-range";

async function dblclickFrCell(page: Page, fr: { x: number; y: number }, row: number, col: number): Promise<void> {
  const p = await frCellPoint(page, fr, row, col);
  await page.mouse.dblclick(p.x, p.y);
  await eventually(() => frEditorOpen(page), (v) => v, `double-clicking the floating grid's cell (${row},${col}) opened no editor`);
}

/** The text of the live floating-grid edit (its textarea, else the formula bar that hosts it). */
async function frEditText(page: Page): Promise<string> {
  const t = await frEditorText(page);
  if (t !== null) return t;
  return formulaBarValue(page);
}

async function clickPoint(page: Page, p: { x: number; y: number }, button: "left" | "right" = "left"): Promise<void> {
  await page.mouse.click(p.x, p.y, { button });
  await page.waitForTimeout(250);
}

/** Computed colour of the formula bar, and of the theme's tertiary text colour. */
async function formulaBarColours(page: Page): Promise<{ bar: string; tertiary: string; readOnly: boolean }> {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-formula-bar="true"]') as HTMLInputElement | null;
    const probe = document.createElement("span");
    probe.style.color = "var(--text-tertiary)";
    (bar?.parentElement ?? document.body).appendChild(probe);
    const tertiary = getComputedStyle(probe).color;
    probe.remove();
    return { bar: bar ? getComputedStyle(bar).color : "", tertiary, readOnly: !!bar?.readOnly };
  });
}

test.describe("the floating-grid edit seam (E1-E4, E6, E9, E12, W12)", () => {
  test("E1 (BUG-0186): a right-press on A1, a re-press of column C's header and of the corner each drop the floating grid's selection; the grid menu shows", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      const fr = await createFr(page, FR_POS.x, FR_POS.y, "PressFR");
      await claimWithFrCell(page, grid, fr);

      // Right-press on A1, inside Core's (hidden) selection.
      const a1 = await grid.cellCenterScrollAware("A1");
      await page.locator("canvas").first().click({ button: "right", position: a1, force: true });
      await eventually(() => frLocalSelection(page), (s) => s === null, "a right-press on A1 did not drop the floating grid's selection");
      await expect(page.locator('[role="menu"][aria-label="Context menu"]').first(), "the grid's context menu did not show").toBeVisible();
      expect(await page.locator("[data-fr-context-menu]").count(), "the floating grid's menu showed").toBe(0);
      expect(await selectionOwned(page)).toBe(false);
      await page.keyboard.press("Escape");

      // Column C's header, a floating cell, column C's header AGAIN.
      await clickPoint(page, await columnHeaderPoint(page, 2));
      const colSel = await gridSelection(page);
      expect(colSel && [colSel.startCol, colSel.endCol, colSel.startRow], "precondition: column C selected").toEqual([2, 2, 0]);
      await clickFrCell(page, fr, 0, 0);
      await eventually(() => frLocalSelection(page), (s) => s !== null, "clicking the floating cell selected nothing");
      await clickPoint(page, await columnHeaderPoint(page, 2));
      await eventually(() => frLocalSelection(page), (s) => s === null, "re-pressing column C's header did not drop the floating selection");
      expect(await selectionOwned(page)).toBe(false);

      // The select-all corner, a floating cell, the corner AGAIN.
      await clickPoint(page, await cornerPoint(page));
      await clickFrCell(page, fr, 0, 0);
      await eventually(() => frLocalSelection(page), (s) => s !== null, "clicking the floating cell selected nothing (corner case)");
      await clickPoint(page, await cornerPoint(page));
      await eventually(() => frLocalSelection(page), (s) => s === null, "re-pressing the corner did not drop the floating selection");
    } finally {
      await cleanup(page);
    }
  });

  test("E2 + W13 quoting: a column-header pick into a floating-grid edit inserts Sheet1!C:C, then 'Q1-2026'!C:C (stored and calculated); a GETPIVOTDATA pick qualifies the pivot cell with 'Q1-2026'!; a cell pick on 2024Budget inserts '2024Budget'!C3", async ({
    appPage: page,
  }) => {
    test.setTimeout(180_000);
    try {
      await newFile(page);
      await writeCells(page, [
        [0, 2, "1"], [1, 2, "2"], [2, 2, "3"],
        [19, 0, "Month"], [19, 1, "Units"],
        [20, 0, "Jan"], [20, 1, "10"],
        [21, 0, "Feb"], [21, 1, "40"],
        [22, 0, "Mar"], [22, 1, "20"],
        [23, 0, "Apr"], [23, 1, "30"],
      ]);
      const view = await callModule<{ pivotId: string }>(page, PIVOT_API, "createPivotTable", [
        { sourceRange: "Sheet1!A20:B24", destinationCell: "D20", sourceSheet: 0, destinationSheet: 0, hasHeaders: true, name: "EditPivot" },
      ]);
      await callModule(page, PIVOT_API, "updatePivotFields", [
        { pivotId: view.pivotId, rowFields: [{ sourceIndex: 0, name: "Month" }], valueFields: [{ sourceIndex: 1, name: "Sum of Units", aggregation: "sum" }] },
      ]);
      await page.evaluate(() => window.dispatchEvent(new Event("pivot:refresh")));
      const out = await eventually(
        () => invoke<Array<{ row: number; col: number; display: string }>>(page, "get_range_cells_typed", { startRow: 19, startCol: 3, endRow: 27, endCol: 4 }),
        (c) => c.some((x) => x.display === "Feb"),
        "the pivot did not write its output",
      );
      const febRow = out.find((x) => x.display === "Feb")!.row;
      const fr = await createFr(page, FR_POS.x, FR_POS.y, "PickFR");

      // Sheet1: a column-header pick.
      await dblclickFrCell(page, fr, 1, 0);
      await page.keyboard.type("=SUM(");
      await clickPoint(page, await columnHeaderPoint(page, 2));
      await eventually(() => frEditText(page), (t) => t === "=SUM(Sheet1!C:C", "a column-header pick did not reach the floating-grid edit as Sheet1!C:C");
      await page.keyboard.press("Escape");
      await eventually(() => frEditorOpen(page), (v) => !v, "Escape did not cancel");
      expect((await frCell(page, fr.id, 1, 0))?.formula ?? null, "Escape stored the formula").toBeNull();

      // Q1-2026: quoted, stored, calculated.
      await renameSheet(page, 0, "Q1-2026");
      await dblclickFrCell(page, fr, 1, 0);
      await page.keyboard.type("=SUM(");
      await clickPoint(page, await columnHeaderPoint(page, 2));
      await eventually(() => frEditText(page), (t) => t === "=SUM('Q1-2026'!C:C", "the header pick on Q1-2026 is not quoted");
      await page.keyboard.type(")");
      await page.keyboard.press("Enter");
      const stored = await eventually(() => frCell(page, fr.id, 1, 0), (c) => !!c && c.formula !== null, "Enter stored nothing");
      expect(stored!.formula).toBe("=SUM('Q1-2026'!C:C)");
      expect(Number(stored!.value), "the stored formula did not calculate (parse error?)").toBe(6);

      // GETPIVOTDATA pick of the pivot on Q1-2026.
      await dblclickFrCell(page, fr, 2, 0);
      await page.keyboard.type("=");
      const pivotCell = await cellPagePoint(page, febRow, 4);
      await clickPoint(page, pivotCell);
      const gpd = await eventually(() => frEditText(page), (t) => t.startsWith("=GETPIVOTDATA("), "a pivot pick inserted no GETPIVOTDATA");
      expect(gpd, "the GETPIVOTDATA pick does not qualify the pivot cell with its quoted sheet").toMatch(
        new RegExp(`^=GETPIVOTDATA\\("Sum of Units"[;,]'Q1-2026'!\\$E\\$${febRow + 1}[;,]"Month"[;,]"Feb"\\)$`),
      );
      await page.keyboard.press("Enter");
      const got = await eventually(() => frCell(page, fr.id, 2, 0), (c) => !!c && c.value !== null && c.value !== undefined && String(c.value) !== "", "the GETPIVOTDATA cell stored nothing");
      expect(Number(got!.value), `GETPIVOTDATA did not calculate: ${JSON.stringify(got)}`).toBe(40);

      // 2024Budget: a cell pick is quoted.
      await renameSheet(page, 0, "2024Budget");
      await dblclickFrCell(page, fr, 3, 0);
      await page.keyboard.type("=");
      await clickPoint(page, await cellPagePoint(page, 2, 2));
      await eventually(() => frEditText(page), (t) => t === "='2024Budget'!C3", "a cell pick on 2024Budget is not quoted");
      await page.keyboard.press("Enter");
      const c3 = await eventually(() => frCell(page, fr.id, 3, 0), (c) => !!c && c.formula !== null, "the 2024Budget pick was not stored");
      expect(Number(c3!.value), "='2024Budget'!C3 did not calculate").toBe(3);
    } finally {
      await cleanup(page);
    }
  });

  test("E3: in R1C1 a floating-grid cell's =A1*2 at B2 shows =R[-1]C[-1]*2, an edit to *3 stores =A1*3, and back in A1 it shows =A1*3", async ({ appPage: page }) => {
    try {
      await newFile(page);
      const fr = await createFr(page, FR_POS.x, FR_POS.y, "R1C1FR");
      await setFrCell(page, fr.id, 1, 1, "=A1*2");
      await clickFrCell(page, fr, 1, 1);
      await eventually(() => formulaBarValue(page), (v) => v === "=A1*2", "precondition (A1 mode): the bar does not show =A1*2");

      await callModule(page, API_GRID, "changeReferenceStyle", ["R1C1"]);
      await page.waitForTimeout(400);
      await clickFrCell(page, fr, 0, 0);
      await clickFrCell(page, fr, 1, 1);
      await eventually(() => formulaBarValue(page), (v) => v === "=R[-1]C[-1]*2", "R1C1: the bar does not show =R[-1]C[-1]*2");
      await page.locator('[data-formula-bar="true"]').first().click();
      await page.keyboard.press("Control+a");
      await page.keyboard.type("=R[-1]C[-1]*3");
      await page.keyboard.press("Enter");
      await eventually(() => frCell(page, fr.id, 1, 1), (c) => c?.formula === "=A1*3", "the R1C1 edit was not stored as =A1*3");

      await callModule(page, API_GRID, "changeReferenceStyle", ["A1"]);
      await page.waitForTimeout(400);
      await clickFrCell(page, fr, 0, 0);
      await clickFrCell(page, fr, 1, 1);
      await eventually(() => formulaBarValue(page), (v) => v === "=A1*3", "back in A1 the bar does not show =A1*3");
    } finally {
      await callModule(page, API_GRID, "changeReferenceStyle", ["A1"]).catch(() => undefined);
      await cleanup(page);
    }
  });

  test("E4: Move-after-Return off keeps a floating-grid commit in place (cell and formula bar); direction Right moves right and Shift+Enter moves left; the default moves down", async ({ appPage: page }) => {
    const prefs = await page.evaluate(() => ({
      keys: Object.keys(localStorage).filter((k) => /move/i.test(k)).map((k) => [k, localStorage.getItem(k)] as [string, string | null]),
    }));
    try {
      await newFile(page);
      await callModule(page, API_EDIT_PREFS, "setMoveAfterReturn", [true]);
      await callModule(page, API_EDIT_PREFS, "setMoveDirection", ["down"]);
      const fr = await createFr(page, FR_POS.x, FR_POS.y, "EnterFR");
      const at = async () => {
        const s = await frLocalSelection(page);
        return s ? [s.endRow, s.endCol] : null;
      };

      // Default (down): the control.
      await clickFrCell(page, fr, 0, 0);
      await page.keyboard.type("1");
      await page.keyboard.press("Enter");
      await eventually(at, (s) => JSON.stringify(s) === "[1,0]", "the default Enter did not move down");

      // Off: in the cell.
      await callModule(page, API_EDIT_PREFS, "setMoveAfterReturn", [false]);
      await clickFrCell(page, fr, 0, 0);
      await page.keyboard.type("2");
      await page.keyboard.press("Enter");
      await eventually(() => frCell(page, fr.id, 0, 0), (c) => Number(c?.value) === 2, "the in-cell commit did not land");
      expect(await at(), "Move-after-Return off: the in-cell Enter moved").toEqual([0, 0]);

      // Off: from the formula bar.
      await clickFrCell(page, fr, 0, 0);
      await page.locator('[data-formula-bar="true"]').first().click();
      await page.keyboard.press("Control+a");
      await page.keyboard.type("3");
      await page.keyboard.press("Enter");
      await eventually(() => frCell(page, fr.id, 0, 0), (c) => Number(c?.value) === 3, "the formula-bar commit did not land");
      expect(await at(), "Move-after-Return off: the formula-bar Enter moved").toEqual([0, 0]);

      // Right, and Shift+Enter left.
      await callModule(page, API_EDIT_PREFS, "setMoveAfterReturn", [true]);
      await callModule(page, API_EDIT_PREFS, "setMoveDirection", ["right"]);
      await clickFrCell(page, fr, 0, 0);
      await page.keyboard.type("4");
      await page.keyboard.press("Enter");
      await eventually(at, (s) => JSON.stringify(s) === "[0,1]", "direction Right: Enter did not move right");
      await page.keyboard.type("5");
      await page.keyboard.press("Shift+Enter");
      await eventually(at, (s) => JSON.stringify(s) === "[0,0]", "direction Right: Shift+Enter did not move left");
      expect(Number((await frCell(page, fr.id, 0, 1))?.value)).toBe(5);
    } finally {
      await page.evaluate((keys) => {
        for (const k of Object.keys(localStorage).filter((x) => /move/i.test(x))) localStorage.removeItem(k);
        for (const [k, v] of keys) if (v !== null) localStorage.setItem(k, v);
      }, prefs.keys);
      await cleanup(page);
    }
  });

  test("W12 (E3 remainder): a floating grid's spill ghost shows its anchor's formula greyed and read-only; the anchor is normal; a one-cell spill leaves no ghost; in R1C1 the ghost reads =R[-1]C[-1]:R[1]C[-1]*2", async ({ appPage: page }) => {
    try {
      await newFile(page);
      const fr = await createFr(page, FR_POS.x, FR_POS.y, "SpillFR");
      await setFrCell(page, fr.id, 0, 0, "=SEQUENCE(3)");
      await eventually(() => frCell(page, fr.id, 2, 0), (c) => Number(c?.value) === 3, "=SEQUENCE(3) did not spill");

      await clickFrCell(page, fr, 1, 0);
      await eventually(() => formulaBarValue(page), (v) => v === "=SEQUENCE(3)", "the ghost A2 does not show its anchor's formula");
      const ghost = await formulaBarColours(page);
      expect(ghost.readOnly, "the ghost's formula bar is editable").toBe(true);
      expect(ghost.bar, "the ghost's formula is not greyed").toBe(ghost.tertiary);
      await page.locator('[data-formula-bar="true"]').first().click();
      await page.waitForTimeout(300);
      expect(await frEditorOpen(page), "clicking the ghost's formula opened an edit").toBe(false);
      expect(await coreEditOpen(page)).toBe(false);
      await page.keyboard.press("Escape");

      await clickFrCell(page, fr, 0, 0);
      await eventually(() => formulaBarValue(page), (v) => v === "=SEQUENCE(3)", "the anchor does not show its formula");
      const anchor = await formulaBarColours(page);
      expect(anchor.readOnly, "the anchor's formula bar is read-only").toBe(false);
      expect(anchor.bar, "the anchor is greyed like a ghost").not.toBe(anchor.tertiary);

      await setFrCell(page, fr.id, 0, 0, "=SEQUENCE(1)");
      await clickFrCell(page, fr, 0, 1);
      await clickFrCell(page, fr, 1, 0);
      await page.waitForTimeout(300);
      const noGhost = await formulaBarColours(page);
      expect(await formulaBarValue(page), "A2 still shows a ghost of a one-cell spill").toBe("");
      expect(noGhost.bar === noGhost.tertiary && noGhost.readOnly, "A2 is still greyed").toBe(false);

      await setFrCell(page, fr.id, 1, 1, "=A1:A3*2");
      await callModule(page, API_GRID, "changeReferenceStyle", ["R1C1"]);
      await page.waitForTimeout(400);
      await clickFrCell(page, fr, 3, 1);
      await eventually(() => formulaBarValue(page), (v) => v === "=R[-1]C[-1]:R[1]C[-1]*2", "R1C1: the ghost B4 does not read =R[-1]C[-1]:R[1]C[-1]*2");
    } finally {
      await callModule(page, API_GRID, "changeReferenceStyle", ["A1"]).catch(() => undefined);
      await cleanup(page);
    }
  });

  test("E6: deactivating Floating Range while its edit is parked on Sheet2 returns to the host sheet with the host's own column widths, and the range stays on its sheet", async ({ appPage: page }) => {
    test.setTimeout(120_000);
    let deactivated = false;
    try {
      await newFile(page);
      const fr = await createFr(page, FR_POS.x, FR_POS.y, "ParkFR");
      await addWorksheet(page);
      await callModule(page, TAURI_API, "setColumnWidth", [0, 200]);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("dimensions:refresh")));
      await clickSheetTab(page, 0);
      await dblclickFrCell(page, fr, 0, 0);
      await page.keyboard.type("=SUM(");
      await page.locator('button[data-sheet-tab="1"]').click();
      await eventually(() => activeSheet(page), (i) => i === 1, "the point-mode tab click did not show Sheet2");
      await page.waitForTimeout(400);
      expect(await frEditorOpen(page), "precondition: the edit is parked, still open").toBe(true);
      const colA = () => page.evaluate(() => {
        const d = (window as unknown as { __CALCULA_GRID_STATE__?: { dimensions?: { columnWidths?: Map<number, number> | Record<number, number> } } }).__CALCULA_GRID_STATE__?.dimensions?.columnWidths;
        if (!d) return null;
        return d instanceof Map ? d.get(0) ?? null : (d as Record<number, number>)[0] ?? null;
      });
      expect(await colA(), "precondition: Sheet2's column A is 200 wide on screen").toBe(200);

      await lifecycle(page, "deactivate", LIFECYCLE_FR);
      deactivated = true;
      await eventually(() => activeSheet(page), (i) => i === 0, "deactivating did not return to the host sheet");
      await eventually(colA, (w) => w === null || w !== 200, "the host sheet shows Sheet2's column widths");
      await lifecycle(page, "activate", LIFECYCLE_FR);
      deactivated = false;
      const list = await frList(page);
      expect(list.find((f) => f.id === fr.id)?.hostSheetIndex, "the range left its host sheet").toBe(0);
    } finally {
      if (deactivated) await lifecycle(page, "activate", LIFECYCLE_FR).catch(() => undefined);
      await cleanup(page);
    }
  });

  test("E9: File > New with a cell edit open ends it; afterwards typing, Ctrl+Z, Ctrl+Y and the arrow keys all work", async ({ appPage: page, grid }) => {
    try {
      await newFile(page);
      await grid.clickCell("A1");
      await page.keyboard.type("abc");
      await eventually(() => coreEditOpen(page), (v) => v, "precondition: an edit is open");
      await newFile(page);
      expect(await coreEditOpen(page), "File > New left Core's edit flag up").toBe(false);
      expect(await gridEditing(page), "File > New left the edit open").toBeNull();

      await grid.clickCell("B2");
      await page.keyboard.type("x");
      await page.keyboard.press("Enter");
      await eventually(() => cellsOn(page, [[0, 1, 1]]), (v) => v[0] === "x", "typing after File > New did not commit");
      await focusGrid(page);
      await page.keyboard.press("Control+z");
      await eventually(() => cellsOn(page, [[0, 1, 1]]), (v) => v[0] === "", "Ctrl+Z after File > New did nothing");
      await page.keyboard.press("Control+y");
      await eventually(() => cellsOn(page, [[0, 1, 1]]), (v) => v[0] === "x", "Ctrl+Y after File > New did nothing");
      await grid.clickCell("B2");
      await page.keyboard.press("ArrowRight");
      await eventually(() => selAt(page), (s) => JSON.stringify(s) === "[1,2,1,2]", "ArrowRight after File > New did not move");
    } finally {
      await cleanup(page);
    }
  });

  test("E12: on a canvas with nothing selected, click the formula bar, Escape, then Ctrl+Z undoes the last edit", async ({ appPage: page, grid }) => {
    try {
      await newFile(page);
      const canvas = await addCanvas(page);
      await clickSheetTab(page, 0);
      await grid.clickCell("A1");
      await page.keyboard.type("u");
      await page.keyboard.press("Enter");
      await eventually(() => cellsOn(page, [[0, 0, 0]]), (v) => v[0] === "u", "precondition: A1 = u");
      await clickSheetTab(page, canvas.index);
      expect(await gridSelection(page), "precondition: nothing selected on the canvas").toBeNull();
      await page.locator('[data-formula-bar="true"]').first().click();
      await page.waitForTimeout(300);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      expect(await coreEditOpen(page), "the refused formula-bar edit left Core's edit flag up").toBe(false);
      await focusGrid(page);
      await page.keyboard.press("Control+z");
      await eventually(() => cellsOn(page, [[0, 0, 0]]), (v) => v[0] === "", "Ctrl+Z on the canvas did not undo the edit (stuck edit flag)");
    } finally {
      await cleanup(page);
    }
  });
});

// ===========================================================================
// 5. SHEET-NAME QUOTING IN CORE'S OWN PICKS AND BUILDERS (W13, W14, X15)
// ===========================================================================

const CHART_RENDERER = "/extensions/Charts/rendering/chartRenderer.ts";

type RefRow = { startRow: number; startCol: number; endRow: number; endCol: number; sheetName?: string; isPassive?: boolean };

async function activeRefs(page: Page): Promise<RefRow[]> {
  return page.evaluate(() => {
    const refs = ((window as unknown as { __CALCULA_GRID_STATE__?: { formulaReferences?: RefRow[] } }).__CALCULA_GRID_STATE__?.formulaReferences ?? []) as RefRow[];
    return refs
      .filter((r) => !r.isPassive)
      .map((r) => ({ startRow: r.startRow, startCol: r.startCol, endRow: r.endRow, endCol: r.endCol, sheetName: r.sheetName }));
  });
}

/** Drag a reference highlight by its TOP border from one cell to another (point mode). */
async function dragHighlight(page: Page, from: { row: number; col: number }, to: { row: number; col: number }): Promise<void> {
  const geo = await readGridGeometry(page);
  const a = await cellPagePoint(page, from.row, from.col);
  const b = await cellPagePoint(page, to.row, to.col);
  const half = (geo.defaultCellHeight / 2) * geo.zoom;
  const startY = a.y - half + 1.5;
  await page.mouse.move(a.x, startY);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (startY + b.y - half + 1.5) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y - half + 1.5, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
}

test.describe("sheet-name quoting in Core's picks and builders (W13, W14, X15)", () => {
  test("W13: a cross-sheet pick into Core's edit writes 'Q1-2026'!, 'TRUE'!, 'Q1.'!, 'Bob''s'! and Q1.2026! by the parser's rule; each stores and calculates; the highlight sits on that sheet's B2 only; dragging it gives 'Bob''s'!C3 and Q1.2026!C3", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(240_000);
    const cases = [
      { name: "Q1-2026", prefix: "'Q1-2026'!", drag: false },
      { name: "TRUE", prefix: "'TRUE'!", drag: false },
      { name: "Q1.", prefix: "'Q1.'!", drag: false },
      { name: "Bob's", prefix: "'Bob''s'!", drag: true },
      { name: "Q1.2026", prefix: "Q1.2026!", drag: true },
    ];
    try {
      await newFile(page);
      await addWorksheet(page);
      await writeCells(page, [[1, 1, "7"], [2, 2, "5"]]); // Sheet2!B2 = 7, Sheet2!C3 = 5
      await clickSheetTab(page, 0);
      for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        await test.step(c.name, async () => {
          await renameSheet(page, 1, c.name);
          await clickSheetTab(page, 0);
          await grid.clickCell(`A${i + 1}`);
          await page.keyboard.type("=SUM(", { delay: 30 });
          await page.locator('button[data-sheet-tab="1"]').click();
          await eventually(() => activeSheet(page), (s) => s === 1, "point mode did not show the other sheet");
          await page.waitForTimeout(300);
          await grid.clickCell("B2");
          await eventually(() => formulaBarValue(page), (v) => v === `=SUM(${c.prefix}B2`, `the pick on ${c.name} is not ${c.prefix}B2`);
          const refs = await activeRefs(page);
          expect(refs, `${c.name}: the highlight is not exactly B2 of that sheet (a phantom reference?)`).toEqual([
            { startRow: 1, startCol: 1, endRow: 1, endCol: 1, sheetName: c.name },
          ]);
          let want = `=SUM(${c.prefix}B2)`;
          let value = "7";
          if (c.drag) {
            await dragHighlight(page, { row: 1, col: 1 }, { row: 2, col: 2 });
            await eventually(() => formulaBarValue(page), (v) => v === `=SUM(${c.prefix}C3`, `dragging the ${c.name} highlight did not give ${c.prefix}C3`);
            want = `=SUM(${c.prefix}C3)`;
            value = "5";
          }
          await page.keyboard.press("Enter");
          await eventually(() => activeSheet(page), (s) => s === 0, "Enter did not return to Sheet1");
          const cell = await eventually(() => cellAt(page, i, 0), (x) => !!x?.formula, `A${i + 1} stored nothing`);
          expect.soft(String(cell!.display), `A${i + 1} did not calculate (${c.name})`).toBe(value);
          expect.soft(cell!.formula, `A${i + 1} does not SHOW the formula it was given (${c.name})`).toBe(want);
        });
      }
    } finally {
      await cleanup(page);
    }
  });

  test("W13 3-D: =SUM( then the Q1-2026 tab and a Shift+click on Sheet3 inserts 'Q1-2026:Sheet3'!", async ({ appPage: page, grid }) => {
    try {
      await newFile(page);
      await addWorksheet(page);
      await addWorksheet(page);
      await renameSheet(page, 1, "Q1-2026");
      await clickSheetTab(page, 0);
      await grid.clickCell("A1");
      await page.keyboard.type("=SUM(", { delay: 30 });
      await page.locator('button[data-sheet-tab="1"]').click();
      await page.waitForTimeout(300);
      await page.locator('button[data-sheet-tab="2"]').click({ modifiers: ["Shift"] });
      await eventually(() => formulaBarValue(page), (v) => v === "=SUM('Q1-2026:Sheet3'!", "the 3-D prefix is not 'Q1-2026:Sheet3'!");
      await page.keyboard.press("Escape");
    } finally {
      await cleanup(page);
    }
  });

  test("W13 Name Box: on My Sheet, A1:A5 named SalesData refers to ='My Sheet'!$A$1:$A$5 and =SUM(SalesData) calculates", async ({ appPage: page, grid }) => {
    try {
      await newFile(page);
      await renameSheet(page, 0, "My Sheet");
      await writeCells(page, [[0, 0, "1"], [1, 0, "2"], [2, 0, "3"], [3, 0, "4"], [4, 0, "5"]]);
      await grid.selectRange("A1", "A5");
      await grid.nameBox.click();
      await grid.nameBox.fill("SalesData");
      await page.keyboard.press("Enter");
      const names = await eventually(
        () => invoke<Array<{ name: string; refersTo: string }>>(page, "get_all_named_ranges"),
        (n) => n.some((x) => x.name === "SalesData"),
        "the Name Box did not define SalesData",
      );
      expect(names.find((x) => x.name === "SalesData")!.refersTo).toBe("='My Sheet'!$A$1:$A$5");
      await grid.clickCell("C1");
      await page.keyboard.type("=SUM(SalesData)");
      await page.keyboard.press("Enter");
      await eventually(() => cellsOn(page, [[0, 0, 2]]), (v) => v[0] === "15", "=SUM(SalesData) did not calculate");
    } finally {
      await cleanup(page);
    }
  });

  test("W13 DV: a list validation sourced from sheet TRUE shows ='TRUE'!$A$1:$A$4 when the dialog is reopened, and OK keeps the rule", async ({ appPage: page, grid }) => {
    try {
      await newFile(page);
      await addWorksheet(page);
      await renameSheet(page, 1, "TRUE");
      await writeCells(page, [[0, 0, "a"], [1, 0, "b"], [2, 0, "c"], [3, 0, "d"]]);
      await addWorksheet(page);
      await renameSheet(page, 2, "Lists");
      await writeCells(page, [[0, 0, "a"], [1, 0, "b"], [2, 0, "c"], [3, 0, "d"]]);
      await clickSheetTab(page, 0);
      const dialog = page.locator('[role="dialog"][aria-label="Data Validation"]');
      const source = dialog.locator('input[placeholder="e.g., Yes,No,Maybe or =$A$1:$A$10"]');
      const consoleLines: string[] = [];
      page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text().slice(0, 300)}`));
      const consoleErrors = () => consoleLines.filter((l) => /^error|valid|rule/i.test(l)).slice(-4).join(" || ");

      // CONTROL: the same dialog, a list sourced from an ordinary sheet name, saves.
      await grid.clickCell("A2");
      await runMenuItem(page, ["Data", "Validation", "Data Validation..."]);
      await expect(dialog).toBeVisible();
      await dialog.locator("select").first().selectOption("list");
      await source.fill("=Lists!$A$1:$A$4");
      await dialog.getByRole("button", { name: "OK" }).click();
      await expect(dialog, "control: OK refused =Lists!$A$1:$A$4").toHaveCount(0, { timeout: 4000 }).catch((e) => {
        throw new Error(`${String(e).split(/\r?\n/)[0]} | console: ${consoleErrors()}`);
      });

      await grid.clickCell("A1");
      await runMenuItem(page, ["Data", "Validation", "Data Validation..."]);
      await expect(dialog).toBeVisible();
      await dialog.locator("select").first().selectOption("list");
      await source.fill("='TRUE'!$A$1:$A$4");
      await dialog.getByRole("button", { name: "OK" }).click();
      await expect(dialog, "OK refused the quoted TRUE source").toHaveCount(0, { timeout: 4000 }).catch(async (e) => {
        const says = (await dialog.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 400);
        throw new Error(`${String(e).split(/\r?\n/)[0]} | the dialog says: ${says} | console: ${consoleErrors()}`);
      });
      const rule = await eventually(() => invoke(page, "get_data_validation", { row: 0, col: 0, sheetIndex: null }), (v) => v !== null, "no rule was stored");

      await grid.clickCell("A1");
      await runMenuItem(page, ["Data", "Validation", "Data Validation..."]);
      await expect(dialog).toBeVisible();
      await expect(source, "the reopened dialog does not show the quoted source").toHaveValue("='TRUE'!$A$1:$A$4");
      await dialog.getByRole("button", { name: "OK" }).click();
      await expect(dialog, "OK on the reopened dialog was refused").toHaveCount(0);
      expect(await invoke(page, "get_data_validation", { row: 0, col: 0, sheetIndex: null }), "OK changed the rule").toEqual(rule);
    } finally {
      await cleanup(page);
    }
  });

  test("W14: in Sheet1!A1's own edit, = then a pivot value on the Pivots sheet inserts GETPIVOTDATA(...,Pivots!$E$n,...) and A1 shows the value, not #REF!", async ({ appPage: page, grid }) => {
    test.setTimeout(120_000);
    try {
      await newFile(page);
      await writeCells(page, [
        [9, 0, "Month"], [9, 1, "Units"],
        [10, 0, "Jan"], [10, 1, "10"],
        [11, 0, "Feb"], [11, 1, "40"],
        [12, 0, "Mar"], [12, 1, "20"],
        [13, 0, "Apr"], [13, 1, "30"],
      ]);
      await addWorksheet(page);
      await renameSheet(page, 1, "Pivots");
      const view = await callModule<{ pivotId: string }>(page, PIVOT_API, "createPivotTable", [
        { sourceRange: "Sheet1!A10:B14", destinationCell: "D2", sourceSheet: 0, destinationSheet: 1, hasHeaders: true, name: "W14Pivot" },
      ]);
      await callModule(page, PIVOT_API, "updatePivotFields", [
        { pivotId: view.pivotId, rowFields: [{ sourceIndex: 0, name: "Month" }], valueFields: [{ sourceIndex: 1, name: "Sum of Units", aggregation: "sum" }] },
      ]);
      await page.evaluate(() => window.dispatchEvent(new Event("pivot:refresh")));
      const out = await eventually(
        () => invoke<Array<{ row: number; col: number; display: string }>>(page, "get_range_cells_typed", { sheetIndex: 1, startRow: 0, startCol: 3, endRow: 10, endCol: 4 }),
        (c) => c.some((x) => x.display === "Feb"),
        "the pivot did not write its output on Pivots",
      );
      const febRow = out.find((x) => x.display === "Feb")!.row;

      // CONTROL: on the pivot's OWN sheet the same pick inserts GETPIVOTDATA.
      expect(await activeSheet(page), "precondition: Pivots is active").toBe(1);
      await page.evaluate(() => window.dispatchEvent(new Event("pivot:refresh")));
      await page.waitForTimeout(800);
      await grid.clickCell("H2");
      await page.keyboard.type("=");
      await clickPoint(page, await cellPagePoint(page, febRow, 4));
      await eventually(() => formulaBarValue(page), (v) => v.startsWith("=GETPIVOTDATA("), "control: a same-sheet pivot pick inserted no GETPIVOTDATA");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);

      await clickSheetTab(page, 0);
      await grid.clickCell("A1");
      await page.keyboard.type("=");
      await page.locator('button[data-sheet-tab="1"]').click();
      await eventually(() => activeSheet(page), (s) => s === 1, "point mode did not show Pivots");
      await page.waitForTimeout(400);
      await clickPoint(page, await cellPagePoint(page, febRow, 4));
      const text = await eventually(() => formulaBarValue(page), (v) => v.startsWith("=GETPIVOTDATA("), "a pivot pick inserted no GETPIVOTDATA");
      expect(text, "the pick is not qualified with the pivot's sheet").toMatch(
        new RegExp(`^=GETPIVOTDATA\\("Sum of Units"[;,]Pivots!\\$E\\$${febRow + 1}[;,]"Month"[;,]"Feb"\\)$`),
      );
      await page.keyboard.press("Enter");
      await eventually(() => activeSheet(page), (s) => s === 0, "Enter did not return to Sheet1");
      await eventually(() => cellsOn(page, [[0, 0, 0]]), (v) => v[0] === "40", "A1 does not show the pivot value (#REF!?)");
    } finally {
      await cleanup(page);
    }
  });

  test("Z9 + X15: F11 on A1:B5 of sheet 2024Budget opens the same prefilled Create Chart dialog as Insert > Chart..., and the chart it inserts reads 2024Budget; with a floating-grid cell selected F11 refuses once; with Charts deactivated F11 does nothing and logs Unknown command: insert.chart", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(180_000);
    let deactivated = false;
    const consoleLines: string[] = [];
    const onConsole = (m: { text: () => string }) => consoleLines.push(m.text());
    page.on("console", onConsole);
    try {
      await newFile(page);
      await startToastLog(page);
      await renameSheet(page, 0, "2024Budget");
      await writeCells(page, [
        [0, 0, "Month"], [0, 1, "Units"],
        [1, 0, "Jan"], [1, 1, "10"],
        [2, 0, "Feb"], [2, 1, "40"],
        [3, 0, "Mar"], [3, 1, "20"],
        [4, 0, "Apr"], [4, 1, "30"],
      ]);
      const dialogInputs = () =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll("input"))
            .filter((i) => i.offsetParent !== null && /[A-Z]+\$?\d+:\$?[A-Z]+\$?\d+/.test(i.value))
            .map((i) => i.value),
        );

      await grid.selectRange("A1", "B5");
      await runMenuItem(page, ["Insert", "Chart..."]);
      await eventually(() => openDialogs(page), (d) => d.some((x) => x.id === "chart:createDialog"), "Insert > Chart... opened no Create Chart dialog");
      const viaMenu = await eventually(dialogInputs, (v) => v.length > 0, "the Insert > Chart dialog shows no range");
      await closeDialogsAndOverlays(page);

      await grid.selectRange("A1", "B5");
      await focusGrid(page);
      await page.keyboard.press("F11");
      await eventually(() => openDialogs(page), (d) => d.some((x) => x.id === "chart:createDialog"), "F11 opened no Create Chart dialog (Z9)");
      const viaF11 = await eventually(dialogInputs, (v) => v.length > 0, "the F11 dialog shows no range");
      expect(viaF11, "F11 prefilled differently from Insert > Chart...").toEqual(viaMenu);
      expect(viaF11.join(" "), "the prefill is not A1:B5").toMatch(/\$?A\$?1:\$?B\$?5/);

      // X15: the range text round-trips to ITS sheet.
      const before = await invoke<Array<{ id: string }>>(page, "get_charts");
      await page.getByRole("button", { name: "Insert Chart" }).click();
      const charts = await eventually(() => invoke<Array<{ id: string; sheetIndex: number; specJson: string }>>(page, "get_charts"), (c) => c.length === before.length + 1, "Insert Chart created nothing");
      const chart = charts.find((c) => !before.some((b) => b.id === c.id))!;
      const values = await eventually(
        () => callModule<unknown>(page, CHART_RENDERER, "getCachedChartData", [chart.id]).then((d) => (d as { data?: { series?: Array<{ values: number[] }> } } | null)?.data?.series?.[0]?.values ?? null),
        (v) => Array.isArray(v),
        "the inserted chart never painted",
        15_000,
      );
      expect(values, "the chart does not plot 2024Budget's A1:B5").toEqual([10, 40, 20, 30]);

      // A floating-grid cell selected: F11 refuses once, opens nothing.
      await closeDialogsAndOverlays(page);
      const fr = await createFr(page, 700, 300, "F11FR");
      await claimWithFrCell(page, grid, fr);
      const mark = await toastMark(page);
      await focusGrid(page);
      await page.keyboard.press("F11");
      await expectOneRefusal(page, mark, "F11");
      expect((await openDialogs(page)).map((d) => d.id)).toEqual([]);

      // Charts deactivated: F11 does nothing, and says so on the console.
      await grid.selectRange("A1", "B5");
      await lifecycle(page, "deactivate", "calcula.charts");
      deactivated = true;
      consoleLines.length = 0;
      await focusGrid(page);
      await page.keyboard.press("F11");
      await page.waitForTimeout(800);
      expect(await openDialogs(page), "F11 opened a dialog with Charts deactivated").toEqual([]);
      expect(consoleLines.some((l) => /Unknown command: insert\.chart/.test(l)), `no "Unknown command: insert.chart" on the console (saw: ${consoleLines.slice(-5).join(" | ")})`).toBe(true);
    } finally {
      page.off("console", onConsole);
      if (deactivated) await lifecycle(page, "activate", "calcula.charts").catch(() => undefined);
      await cleanup(page);
    }
  });
});

// ===========================================================================
// 6. UNDO: gestures inside a script's batch, the paste transaction, refusal
//    toasts; Space on a legacy checkbox; a button bound to checkbox.toggle
// ===========================================================================

const OBJECT_SCRIPT_RUNNER = "/src/api/objectScriptRunner.ts";
const FILTER_STORE = "/extensions/AutoFilter/lib/filterStore.ts";
const SLICER_STORE = "/extensions/Slicer/lib/slicerStore.ts";

function macroSource(fnName: string, body: string): string {
  return (
    `// Macro: ${fnName}\n` +
    `async function ${fnName}(api) {\n` +
    body +
    `}\n` +
    `\n` +
    `function setup(context) {\n` +
    `  if (!context.api) {\n` +
    `    context.notify("needs an UNLOCKED script", "error");\n` +
    `    return;\n` +
    `  }\n` +
    `  return ${fnName}(context.api);\n` +
    `}\n`
  );
}

/** Start an object script through the product's own run-once route (not awaited). */
async function startScript(page: Page, fnName: string, body: string): Promise<void> {
  await installAppImport(page);
  await page.evaluate(
    async ({ mod, name, source }) => {
      const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, (o: unknown) => Promise<void>>>; __e2eRunDone: string | null };
      w.__e2eRunDone = null;
      const m = await w.__appImport(mod);
      m.runObjectScriptOnce({ name, source }).then(
        () => {
          w.__e2eRunDone = "ok";
        },
        (e: unknown) => {
          w.__e2eRunDone = `error: ${e instanceof Error ? e.message : String(e)}`;
        },
      );
    },
    { mod: OBJECT_SCRIPT_RUNNER, name: fnName, source: macroSource(fnName, body) },
  );
}

async function scriptDone(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as unknown as { __e2eRunDone?: string | null }).__e2eRunDone ?? null);
}

async function awaitScript(page: Page): Promise<void> {
  const r = await eventually(() => scriptDone(page), (v) => v !== null, "the script never finished", 25_000);
  expect(r, "the script failed").toBe("ok");
}

const BUILD_BODY =
  `  await api.beginBatch("Build");\n` +
  `  await api.setCellValue(0, 0, "1");\n` +
  `  await api.sleep(6000);\n` +
  `  await api.setCellValue(1, 0, "2");\n` +
  `  await api.commitBatch();\n`;

async function withScriptsAllowed<T>(page: Page, run: () => Promise<T>): Promise<T> {
  const before = await invoke<string>(page, "get_script_security_level").catch(() => null);
  await invoke(page, "set_script_security_level", { level: "enabled" });
  try {
    return await run();
  } finally {
    if (before) await invoke(page, "set_script_security_level", { level: before }).catch(() => undefined);
  }
}

test.describe("undo: script batches, the paste step, refusals; Space on a checkbox (Y7, Z6, Z8, W15, Y9, Z7, Z11)", () => {
  test("Y7/Z6: a gesture made while a script holds beginBatch(\"Build\") joins the batch -- Edit > Undo reads Build and ONE Ctrl+Z takes back A1, A2 and the gesture (paste, Format Painter, Ctrl+Enter, fill handle, header resize, AutoFilter sort, Clear All, Flash Fill, Insert Cell Type > Checkbox, a scripted Text to Columns)", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(420_000);
    await withScriptsAllowed(page, async () => {
      try {
        await newFile(page);
        await writeCells(page, [
          [0, 2, "c"],
          [0, 7, "Letter"], [1, 7, "c"], [2, 7, "a"], [3, 7, "b"],
          [0, 9, "j"],
          [0, 10, "Ann Lee"], [1, 10, "Bo Kim"], [0, 11, "Ann"],
          [0, 13, "x,y"],
        ]);
        await invoke(page, "apply_formatting", { params: { rows: [0], cols: [2], bold: true } });
        await grid.selectRange("H1", "H4");
        await focusGrid(page);
        await page.keyboard.press("Control+Shift+L");
        await eventually(() => invoke(page, "get_auto_filter"), (v) => v !== null, "precondition: an AutoFilter on H1:H4");
        const colWidth = (col: number) =>
          page.evaluate((col) => {
            const d = (window as unknown as { __CALCULA_GRID_STATE__?: { dimensions?: { columnWidths?: Map<number, number> } } }).__CALCULA_GRID_STATE__?.dimensions?.columnWidths;
            return d instanceof Map ? d.get(col) ?? null : null;
          }, col);

        const gestures: Array<{
          name: string;
          body?: string;
          act?: () => Promise<void>;
          landed: () => Promise<boolean>;
          reverted: () => Promise<boolean>;
        }> = [
          {
            name: "paste C1 -> D1",
            act: async () => {
              await grid.clickCell("C1");
              await page.keyboard.press("Control+c");
              await grid.clickCell("D1");
              await page.keyboard.press("Control+v");
            },
            landed: async () => (await cellsOn(page, [[0, 0, 3]]))[0] === "c",
            reverted: async () => (await cellsOn(page, [[0, 0, 3]]))[0] === "",
          },
          {
            name: "Format Painter C1 -> E1",
            act: async () => {
              await grid.clickCell("C1");
              await page.locator('[data-testid="fmt-formatPainter"]').click();
              // Two clicks at most: see the K3 test for the first-click finding.
              await paintWithFormatPainter(page, grid, "E1", async () => (await styleAt(page, 0, 4)).bold === true, 1200);
            },
            landed: async () => (await styleAt(page, 0, 4)).bold === true,
            reverted: async () => (await styleAt(page, 0, 4)).bold !== true,
          },
          {
            name: "Ctrl+Enter fill F1:F3",
            act: async () => {
              await grid.selectRange("F1", "F3");
              await page.keyboard.type("f");
              await page.keyboard.press("Control+Enter");
            },
            landed: async () => (await cellsOn(page, [[0, 0, 5], [0, 1, 5], [0, 2, 5]])).join() === "f,f,f",
            reverted: async () => (await cellsOn(page, [[0, 0, 5], [0, 1, 5], [0, 2, 5]])).join() === ",,",
          },
          {
            name: "fill-handle drag C1 -> C3",
            act: async () => {
              await grid.clickCell("C1");
              const geo = await readGridGeometry(page);
              const c = await cellPagePoint(page, 0, 2);
              const hx = c.x + (geo.defaultCellWidth / 2) * geo.zoom - 1;
              const hy = c.y + (geo.defaultCellHeight / 2) * geo.zoom - 1;
              await page.mouse.move(hx, hy);
              await page.mouse.down();
              await page.mouse.move(hx, hy + 20 * geo.zoom, { steps: 4 });
              await page.mouse.move(hx, hy + 2 * geo.defaultCellHeight * geo.zoom, { steps: 4 });
              await page.mouse.up();
            },
            landed: async () => (await cellsOn(page, [[0, 1, 2], [0, 2, 2]])).join() === "c,c",
            reverted: async () => (await cellsOn(page, [[0, 1, 2], [0, 2, 2]])).join() === ",",
          },
          {
            name: "header-resize drag of column G",
            act: async () => {
              const h = await columnHeaderPoint(page, 6);
              const geo = await readGridGeometry(page);
              const edge = h.x + (geo.defaultCellWidth / 2) * geo.zoom;
              await page.mouse.move(edge, h.y);
              await page.mouse.down();
              await page.mouse.move(edge + 20 * geo.zoom, h.y, { steps: 4 });
              await page.mouse.move(edge + 40 * geo.zoom, h.y, { steps: 4 });
              await page.mouse.up();
            },
            landed: async () => ((await colWidth(6)) ?? 0) > 80,
            // The BACKEND's width: the undo must restore it (the grid's mirror is reported separately below).
            reverted: async () => ((await invoke<number | null>(page, "get_column_width", { col: 6 })) ?? 64.29) < 70,
          },
          {
            name: "AutoFilter Sort A to Z on column H",
            act: async () => {
              await callModule(page, FILTER_STORE, "sortByColumn", [7, true]);
            },
            landed: async () => (await cellsOn(page, [[0, 1, 7], [0, 2, 7], [0, 3, 7]])).join() === "a,b,c",
            reverted: async () => (await cellsOn(page, [[0, 1, 7], [0, 2, 7], [0, 3, 7]])).join() === "c,a,b",
          },
          {
            name: "Home > Clear All on J1",
            act: async () => {
              await grid.clickCell("J1");
              await page.locator('[data-testid="fmt-clearAll"]').click();
            },
            landed: async () => (await cellsOn(page, [[0, 0, 9]]))[0] === "",
            reverted: async () => (await cellsOn(page, [[0, 0, 9]]))[0] === "j",
          },
          {
            name: "Flash Fill (Ctrl+E) L2",
            act: async () => {
              await grid.clickCell("L2");
              await focusGrid(page);
              await page.keyboard.press("Control+e");
            },
            landed: async () => (await cellsOn(page, [[0, 1, 11]]))[0] === "Bo",
            reverted: async () => (await cellsOn(page, [[0, 1, 11]]))[0] === "",
          },
          {
            name: "Insert > Cell Type > Checkbox on M1",
            act: async () => {
              await grid.clickCell("M1");
              await runMenuItem(page, ["Insert", "Cell Type", "Checkbox"]);
            },
            landed: async () => (await cellTypeAt(page, 0, 12)) === "checkbox",
            reverted: async () => (await cellTypeAt(page, 0, 12)) !== "checkbox",
          },
          {
            name: "a scripted Text to Columns inside the script's own batch",
            body:
              `  await api.beginBatch("Build");\n` +
              `  await api.setCellValue(0, 0, "1");\n` +
              `  await api.textToColumns(0, 13, 0, 13, { delimiters: [","], destination: { row: 0, col: 14 } });\n` +
              `  await api.setCellValue(1, 0, "2");\n` +
              `  await api.commitBatch();\n`,
            landed: async () => (await cellsOn(page, [[0, 0, 14], [0, 0, 15]])).join() === "x,y",
            reverted: async () => (await cellsOn(page, [[0, 0, 14], [0, 0, 15]])).join() === ",",
          },
        ];

        for (const g of gestures) {
          await test.step(g.name, async () => {
            const depthBefore = (await undoState(page)).undoDepth;
            await startScript(page, "BuildRun", g.body ?? BUILD_BODY);
            await eventually(() => cellsOn(page, [[0, 0, 0]]), (v) => v[0] === "1", "the script's batch never began (A1)", 15_000);
            if (g.act) {
              await g.act();
              await eventually(g.landed, (v) => v, `${g.name}: the gesture did not land`);
              expect(await scriptDone(page), `${g.name}: the gesture was not made DURING the batch (the script already finished)`).toBeNull();
            }
            await awaitScript(page);
            await eventually(() => cellsOn(page, [[0, 1, 0]]), (v) => v[0] === "2", "the script did not write A2");
            if (!g.act) await eventually(g.landed, (v) => v, `${g.name}: the scripted gesture did not land`);
            const u = await undoState(page);
            expect(u.undoDescription, `${g.name}: Edit > Undo does not read Build`).toBe("Build");
            expect(u.undoDepth, `${g.name}: the gesture made its own undo step(s)`).toBe(depthBefore + 1);
            await grid.clickCell("A5");
            await focusGrid(page);
            await page.keyboard.press("Control+z");
            await eventually(() => cellsOn(page, [[0, 0, 0], [0, 1, 0]]), (v) => v.join() === ",", `${g.name}: one Ctrl+Z did not take back A1 and A2`);
            await eventually(g.reverted, (v) => v, `${g.name}: one Ctrl+Z did not take back the gesture with the batch`);
            if (g.name.startsWith("header-resize")) {
              await page.waitForTimeout(500);
              expect.soft((await colWidth(6)) ?? 64.29, "the backend restored column G, but the grid still shows it at the resized width after the undo").toBeLessThan(70);
            }
            expect((await undoState(page)).undoDepth, `${g.name}: Ctrl+Z took more than one step`).toBe(depthBefore);
          });
        }
      } finally {
        await cleanup(page);
      }
    });
  });

  test("Y7 control / Z8 / Z6 controls: with no script running a paste is ONE step \"Paste 1 cells\" and the next edit is its own step; Flash Fill and Insert Cell Type are their own labelled steps", async ({ appPage: page, grid }) => {
    try {
      await newFile(page);
      await writeCells(page, [[0, 2, "c"], [0, 10, "Ann Lee"], [1, 10, "Bo Kim"], [0, 11, "Ann"]]);
      await grid.clickCell("C1");
      await page.keyboard.press("Control+c");
      await grid.clickCell("D1");
      const depth = (await undoState(page)).undoDepth;
      await page.keyboard.press("Control+v");
      await eventually(() => cellsOn(page, [[0, 0, 3]]), (v) => v[0] === "c", "the paste did not land");
      let u = await undoState(page);
      expect(u.undoDescription).toBe("Paste 1 cells");
      expect(u.undoDepth).toBe(depth + 1);
      expect(u.transactionOpen, "the paste left its transaction open (Z8)").toBe(false);
      await grid.clickCell("E1");
      await page.keyboard.type("e");
      await page.keyboard.press("Enter");
      await eventually(() => cellsOn(page, [[0, 0, 4]]), (v) => v[0] === "e", "E1 did not commit");
      u = await undoState(page);
      expect(u.undoDepth, "the edit after the paste joined the paste's step").toBe(depth + 2);
      await focusGrid(page);
      await page.keyboard.press("Control+z");
      await eventually(() => cellsOn(page, [[0, 0, 4], [0, 0, 3]]), (v) => v.join() === ",c", "Ctrl+Z did not take back only E1");
      await page.keyboard.press("Control+z");
      await eventually(() => cellsOn(page, [[0, 0, 3]]), (v) => v[0] === "", "the second Ctrl+Z did not take back only the paste");

      await grid.clickCell("L2");
      await focusGrid(page);
      await page.keyboard.press("Control+e");
      await eventually(() => cellsOn(page, [[0, 1, 11]]), (v) => v[0] === "Bo", "Flash Fill did not fill");
      expect((await undoState(page)).undoDescription).toBe("Flash Fill");
      await grid.clickCell("M1");
      await runMenuItem(page, ["Insert", "Cell Type", "Checkbox"]);
      await eventually(() => cellTypeAt(page, 0, 12), (t) => t === "checkbox", "Insert Cell Type did not act");
      expect((await undoState(page)).undoDescription).toBe("Insert cell type");
    } finally {
      await cleanup(page);
    }
  });

  test("we-core finding 2: a sheet the USER adds during a script's batch ends it -- A2 and A3 undo as separate steps; when the SCRIPT itself adds the sheet, A2 and A3 undo together as Build", async ({ appPage: page, grid }) => {
    test.setTimeout(150_000);
    await withScriptsAllowed(page, async () => {
      try {
        await newFile(page);
        await startScript(
          page,
          "UserSheet",
          `  await api.beginBatch("Build");\n` +
            `  await api.setCellValue(0, 0, "1", 0);\n` +
            `  await api.sleep(6000);\n` +
            `  await api.setCellValue(1, 0, "2", 0);\n` +
            `  await api.setCellValue(2, 0, "3", 0);\n` +
            `  await api.commitBatch();\n`,
        );
        await eventually(() => cellsOn(page, [[0, 0, 0]]), (v) => v[0] === "1", "the batch never began", 15_000);
        await addWorksheet(page);
        await clickSheetTab(page, 0);
        expect(await scriptDone(page), "the sheet was not added DURING the batch").toBeNull();
        await awaitScript(page);
        await eventually(() => cellsOn(page, [[0, 1, 0], [0, 2, 0]]), (v) => v.join() === "2,3", "the script did not write A2:A3");
        expect((await undoState(page)).undoDescription, "the batch survived the user's sheet add").not.toBe("Build");
        await grid.clickCell("C5");
        await focusGrid(page);
        await page.keyboard.press("Control+z");
        await eventually(() => cellsOn(page, [[0, 1, 0], [0, 2, 0]]), (v) => v.join() === "2,", "the first Ctrl+Z did not take back A3 alone");
        await page.keyboard.press("Control+z");
        await eventually(() => cellsOn(page, [[0, 1, 0]]), (v) => v[0] === "", "the second Ctrl+Z did not take back A2");

        // CONTROL: the script's OWN addSheet resumes its batch.
        await newFile(page);
        await startScript(
          page,
          "ScriptSheet",
          `  await api.beginBatch("Build");\n` +
            `  await api.setCellValue(0, 0, "1", 0);\n` +
            `  await api.addSheet();\n` +
            `  await api.setCellValue(1, 0, "2", 0);\n` +
            `  await api.setCellValue(2, 0, "3", 0);\n` +
            `  await api.commitBatch();\n`,
        );
        await awaitScript(page);
        await eventually(() => cellsOn(page, [[0, 1, 0], [0, 2, 0]]), (v) => v.join() === "2,3", "the script did not write A2:A3");
        expect((await undoState(page)).undoDescription, "the script's own sheet add did not resume its batch").toBe("Build");
        await clickSheetTab(page, 0);
        await grid.clickCell("C5");
        await focusGrid(page);
        await page.keyboard.press("Control+z");
        await eventually(() => cellsOn(page, [[0, 1, 0], [0, 2, 0]]), (v) => v.join() === ",", "one Ctrl+Z did not take back A2 and A3 together");
      } finally {
        await cleanup(page);
      }
    });
  });

  test("W15: Undo pressed while a MODEL slicer click is still landing shows ONE toast that the change is still being applied and undoes nothing; once it lands, Undo takes the click back", async ({ appPage: page }) => {
    test.setTimeout(300_000);
    let conn: { connectionId: string; dir: string } | null = null;
    try {
      await newFile(page);
      await startToastLog(page);
      conn = await createStarConnection(page, "Sales star (edit journey W15)", 120);
      const pivotApi = async <T,>(fn: string, arg: unknown): Promise<T> =>
        page.evaluate(
          async ({ fn, arg, mod }) => {
            const m = (await (window as unknown as { __appImport: (x: string) => Promise<Record<string, unknown>> }).__appImport(mod)) as {
              pivot: Record<string, (a: unknown) => Promise<unknown>>;
            };
            return (await m.pivot[fn](arg)) as unknown;
          },
          { fn, arg, mod: "/src/api/pivot.ts" },
        ) as Promise<T>;
      const canvas = await addCanvas(page);
      const v = await pivotApi<{ pivotId: string }>("createFromBiModel", {
        destinationSheet: canvas.index,
        connectionId: conn.connectionId,
        destinationCell: "B2",
        canvasFrame: { x: 48, y: 48, width: 320, height: 240, frozenHeaders: true },
      });
      await pivotApi("updateBiFields", {
        pivotId: v.pivotId,
        rowFields: [{ table: "Product", column: "Category" }],
        columnFields: [],
        valueFields: [{ measureName: "Revenue" }],
        filterFields: [],
      });

      // Insert Slicers on the canvas, from the model (the canvas journey's recipe).
      const insertItem = page.locator('[data-testid="canvas-insert-slicer"]');
      if (!(await insertItem.isVisible())) {
        await page.locator("[data-ribbon-content]").getByRole("button", { name: /^Insert/ }).first().click();
      }
      await insertItem.click();
      const dialog = page.locator("h2", { hasText: "Insert Slicers" }).locator("xpath=../..");
      await expect(dialog).toBeVisible();
      const modelOption = await eventually(
        () =>
          dialog.locator("select option").evaluateAll((opts) =>
            opts.map((o) => ({ value: (o as HTMLOptionElement).value, label: (o.textContent ?? "").trim() })).find((o) => o.label.endsWith("(Model)")),
          ),
        (o) => !!o,
        "the Insert Slicers dialog does not list the model",
        15000,
      );
      await dialog.locator("select").selectOption(modelOption!.value);
      await dialog.locator("label", { hasText: /Category/ }).locator('input[type="checkbox"]').first().check();
      await dialog.getByRole("button", { name: "OK" }).click();
      type SlicerRow = { id: string; sourceType: string; selectedItems: string[] | null };
      const slicers = () => callModule<SlicerRow[]>(page, SLICER_STORE, "getAllSlicers", []);
      const slicer = (await eventually(slicers, (s) => s.some((x) => x.sourceType === "biConnection"), "no model slicer was created")).find(
        (x) => x.sourceType === "biConnection",
      )!;
      await page.waitForTimeout(1500);

      // An EMPTY history first (a sheet add ends it, Excel parity): an Undo that
      // is NOT refused then has nothing to take back, so Undo can be pressed
      // repeatedly while the click lands without destroying anything.
      await addWorksheet(page);
      await resyncOn(page, canvas.index);
      expect((await undoState(page)).undoDepth, "precondition: the history is empty").toBe(0);

      // Click an item (not awaited) and press Undo every 15 ms while it lands.
      await installAppImport(page);
      const mark = await toastMark(page);
      const presses = await page.evaluate(
        async ({ mod, cmdMod, id }) => {
          const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, unknown>> };
          const store = (await w.__appImport(mod)) as {
            updateSlicerSelectionAsync: (id: string, items: string[]) => Promise<unknown>;
            isSlicerGestureLanding: () => boolean;
          };
          const cmds = (await w.__appImport(cmdMod)) as { CommandRegistry: { execute: (id: string) => Promise<unknown> } };
          let done = false;
          const t0 = performance.now();
          const landing = store.updateSlicerSelectionAsync(id, ["Gadgets"]).finally(() => {
            done = true;
          });
          let n = 0;
          // While the click LANDS (the store's flag, armed before its first
          // await), not until the call resolves: once the step is pushed the
          // flag clears and the call still does its post-landing work, and an
          // Undo then is a real one that takes the click back.
          while (!done && store.isSlicerGestureLanding() && performance.now() - t0 < 30_000) {
            await cmds.CommandRegistry.execute("core.edit.undo");
            n += 1;
            await new Promise((r) => setTimeout(r, 5));
          }
          await landing;
          return { presses: n, landedMs: Math.round(performance.now() - t0) };
        },
        { mod: SLICER_STORE, cmdMod: API_COMMANDS, id: slicer.id },
      );
      await page.waitForTimeout(500);
      const toasts = (await toastsSince(page, mark)).map((t) => t.message);
      const refused = toasts.filter((t) => /still being applied/.test(t));
      expect(refused.length, `no Undo pressed while the click landed was refused with a toast (${JSON.stringify(presses)}; toasts ${JSON.stringify(toasts)})`).toBeGreaterThan(0);
      expect(refused.length, "an Undo press gave more than one toast").toBeLessThanOrEqual(presses.presses);
      expect(toasts.length - refused.length, `other toasts appeared: ${JSON.stringify(toasts)}`).toBe(0);
      expect((await undoState(page)).undoDepth, "the click's step is not on the history (or a refused Undo took it)").toBe(1);

      // After it lands, Undo takes the click back.
      await executeCommand(page, "core.edit.undo");
      await eventually(
        async () => (await slicers()).find((s) => s.id === slicer.id)?.selectedItems ?? null,
        (sel) => sel === null || sel.length === 0,
        "Undo after the landing did not take the slicer click back",
      );
    } finally {
      await cleanup(page);
      if (conn) {
        await invoke(page, "bi_delete_connection", { connectionId: conn.connectionId }).catch(() => undefined);
        fs.rmSync(conn.dir, { recursive: true, force: true });
      }
    }
  });

  test("Y9: Space toggles a legacy checkbox FALSE -> TRUE -> FALSE and leaves an ordinary cell alone", async ({ appPage: page, grid }) => {
    try {
      await newFile(page);
      await writeCells(page, [[1, 1, "FALSE"], [1, 2, "x"]]);
      await invoke(page, "apply_formatting", { params: { rows: [1], cols: [1], checkbox: true } });
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
      expect((await styleAt(page, 1, 1)).checkbox, "precondition: B2 is a legacy checkbox").toBe(true);
      await grid.clickCell("B2");
      await focusGrid(page);
      await page.keyboard.press("Space");
      await eventually(() => cellsOn(page, [[0, 1, 1]]), (v) => v[0].toUpperCase() === "TRUE", "Space did not toggle B2 to TRUE (Y9)");
      await page.keyboard.press("Space");
      await eventually(() => cellsOn(page, [[0, 1, 1]]), (v) => v[0].toUpperCase() === "FALSE", "a second Space did not toggle B2 back");
      await grid.clickCell("C2");
      await focusGrid(page);
      await page.keyboard.press("Space");
      await page.waitForTimeout(400);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      expect(await cellsOn(page, [[0, 1, 2]]), "Space changed an ordinary cell").toEqual(["x"]);
    } finally {
      await cleanup(page);
    }
  });

  test("Z7: Space on a legacy checkbox inside a pivot's output shows ONE error toast naming the PivotTable and leaves no unhandled rejection", async ({ appPage: page, grid }) => {
    try {
      await newFile(page);
      await startToastLog(page);
      await writeCells(page, [
        [0, 0, "Month"], [0, 1, "Units"],
        [1, 0, "Jan"], [1, 1, "10"],
        [2, 0, "Feb"], [2, 1, "40"],
      ]);
      const view = await callModule<{ pivotId: string }>(page, PIVOT_API, "createPivotTable", [
        { sourceRange: "Sheet1!A1:B3", destinationCell: "D2", sourceSheet: 0, destinationSheet: 0, hasHeaders: true, name: "Z7Pivot" },
      ]);
      await callModule(page, PIVOT_API, "updatePivotFields", [
        { pivotId: view.pivotId, rowFields: [{ sourceIndex: 0, name: "Month" }], valueFields: [{ sourceIndex: 1, name: "Sum of Units", aggregation: "sum" }] },
      ]);
      await page.evaluate(() => window.dispatchEvent(new Event("pivot:refresh")));
      const out = await eventually(
        () => invoke<Array<{ row: number; col: number; display: string }>>(page, "get_range_cells_typed", { startRow: 1, startCol: 3, endRow: 8, endCol: 4 }),
        (c) => c.some((x) => x.display === "Jan"),
        "the pivot did not write its output",
      );
      const jan = out.find((x) => x.display === "Jan")!;
      await invoke(page, "apply_formatting", { params: { rows: [jan.row], cols: [jan.col], checkbox: true } });
      expect((await styleAt(page, jan.row, jan.col)).checkbox, "precondition: the pivot cell carries the checkbox format").toBe(true);
      const rej = await rejectionMark(page);
      const mark = await toastMark(page);
      await clickPoint(page, await cellPagePoint(page, jan.row, jan.col));
      await focusGrid(page);
      await page.keyboard.press("Space");
      await page.waitForTimeout(1000);
      const t = await toastsSince(page, mark);
      expect(t.map((x) => x.message), "Space inside the pivot: expected ONE toast").toHaveLength(1);
      expect(t[0].message).toMatch(/part of a pivot ?table/i);
      expect(t[0].variant).toBe("error");
      expect(await rejectionsSince(page, rej), "an unhandled rejection escaped").toEqual([]);
      expect(await cellsOn(page, [[0, jan.row, jan.col]]), "the pivot cell was changed").toEqual(["Jan"]);
    } finally {
      await cleanup(page);
    }
  });

  test("Z11: an Insert > Cell Type > Button bound to checkbox.toggle toggles the legacy checkbox under the selection when clicked", async ({ appPage: page, grid }) => {
    try {
      await newFile(page);
      await writeCells(page, [[1, 1, "FALSE"]]);
      await invoke(page, "apply_formatting", { params: { rows: [1], cols: [1], checkbox: true } });
      await grid.clickCell("D2");
      await runMenuItem(page, ["Insert", "Cell Type", "Button..."]);
      const select = page.locator("select", { has: page.locator("option", { hasText: /^Select a command/ }) }).first();
      await select.waitFor({ state: "visible", timeout: 8000 });
      await select.selectOption("checkbox.toggle");
      await page.getByRole("button", { name: "Insert Button" }).click();
      await eventually(() => cellTypeAt(page, 1, 3), (t) => t === "button", "no button cell type on D2");
      await grid.clickCell("B2");
      await clickPoint(page, await cellPagePoint(page, 1, 3));
      await eventually(() => cellsOn(page, [[0, 1, 1]]), (v) => v[0].toUpperCase() === "TRUE", "clicking the button did not toggle B2");
    } finally {
      await cleanup(page);
    }
  });
});

// ===========================================================================
// 7. MORE DOORS (wb-doors 8 and 12) and the TestRunner suites (we-core fixup)
// ===========================================================================

const COMMAND_DISPATCH = "/src/api/commandDispatch.ts";
const TEST_RUNNER = "/extensions/TestRunner/lib/runner.ts";

test.describe("more doors and the TestRunner suites (wb-doors 8/12, we-core fixup 1-3)", () => {
  test("wb-doors 8/12: with a floating-grid cell selected on a worksheet, Model > PivotTable from Model... and the palette's Attach Cell Behavior to Selection each refuse once and open nothing; on a sheet cell they open", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await startToastLog(page);
      await writeCells(page, [[0, 0, "keep"]]);
      const fr = await createFr(page, FR_POS.x, FR_POS.y, "BiFR");
      await claimWithFrCell(page, grid, fr);
      const before = await docSnapshot(page);

      let mark = await toastMark(page);
      await runMenuItem(page, ["Model", "PivotTable from Model..."]);
      await expectOneRefusal(page, mark, "Model > PivotTable from Model...");
      await expectNothingWritten(page, before, "Model > PivotTable from Model...");

      if (!(await selectionOwned(page))) await clickFrCell(page, fr, 0, 0);
      mark = await toastMark(page);
      await callModule(page, COMMAND_DISPATCH, "executeCommandAnywhere", ["cellBehaviors.attachToSelection"]);
      await expectOneRefusal(page, mark, "Attach Cell Behavior to Selection");
      await expectNothingWritten(page, before, "Attach Cell Behavior to Selection");
      expect(await openOverlays(page)).toEqual([]);
      expect(await invoke<unknown[]>(page, "get_all_cell_behaviors", {}), "a cell behavior was attached under the claim").toEqual([]);

      // POSITIVE CONTROL on a sheet cell: each door opens its surface.
      await grid.clickCell("A1");
      mark = await toastMark(page);
      await runMenuItem(page, ["Model", "PivotTable from Model..."]);
      await page.waitForTimeout(600);
      const opened = (await openDialogs(page)).length + (await openOverlays(page)).length;
      const said = (await toastsSince(page, mark)).map((t) => t.message);
      expect(said.filter((m) => FR_REFUSAL.test(m)), "Model > PivotTable from Model... refused on a sheet cell").toEqual([]);
      expect(opened + said.length, "Model > PivotTable from Model... did nothing on a sheet cell").toBeGreaterThan(0);
      await closeDialogsAndOverlays(page);

      mark = await toastMark(page);
      await grid.clickCell("A1");
      await callModule(page, COMMAND_DISPATCH, "executeCommandAnywhere", ["cellBehaviors.attachToSelection"]);
      await eventually(() => invoke<unknown[]>(page, "get_all_cell_behaviors", {}), (b) => b.length === 1, "Attach Cell Behavior attached nothing on a sheet cell");
      const said2 = (await toastsSince(page, mark)).map((t) => t.message);
      expect(said2.filter((m) => FR_REFUSAL.test(m)), "Attach Cell Behavior refused on a sheet cell").toEqual([]);
      // The attach hands the user the Object Script Editor (a window of its own): close it.
      await page.waitForTimeout(1500);
      await page.evaluate(async () => {
        const T = (window as unknown as { __TAURI__?: { webviewWindow?: { WebviewWindow?: { getByLabel: (l: string) => Promise<{ destroy: () => Promise<void> } | null> } } } }).__TAURI__;
        const w = await T?.webviewWindow?.WebviewWindow?.getByLabel("object-script-editor");
        if (w) await w.destroy();
      }).catch(() => undefined);
      await page.waitForTimeout(600);
    } finally {
      await cleanup(page);
    }
  });

  test("we-core fixup 1-3 / Y9: the TestRunner's Checkbox suite passes 4 of 4, Excel Gap Features' DisplayZeros door test passes and leaves zeros shown, Formatting Operations' style test passes and leaves K501 not bold", async ({ appPage: page }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      type Suite = { suiteName: string; results: Array<{ name: string; status: string; error?: string }> };
      const run = (name: string) => callModule<Suite | null>(page, TEST_RUNNER, "runSuiteByName", [name]);
      // The suites the PRODUCT registers, run by their own names -- the per-suite
      // Run button's route (runSuiteByName runs a suite whatever its
      // `disabled` flag; the flag only makes Run All skip it, which is by design
      // for every Phase 0-9 suite). The Checkbox suite used to be written but
      // never registered, so it could not be run from the product at all.
      const registered = await page.evaluate(async (mod) => {
        const m = (await (window as unknown as { __appImport: (x: string) => Promise<Record<string, unknown>> }).__appImport(mod)) as {
          getRegisteredSuites: () => Array<{ name: string; disabled?: boolean }>;
        };
        return m.getRegisteredSuites().map((x) => ({ name: x.name, disabled: !!x.disabled }));
      }, TEST_RUNNER);
      expect(registered.find((x) => x.name === "Checkbox"), "the TestRunner does not register the Checkbox suite (it cannot be run from the product)").toBeTruthy();
      expect(registered.find((x) => x.name === "Formatting Operations"), "the TestRunner does not register Formatting Operations").toBeTruthy();
      const displayZeros = () => page.evaluate(() => (window as unknown as { __CALCULA_GRID_STATE__?: { displayZeros?: boolean } }).__CALCULA_GRID_STATE__?.displayZeros);
      const zerosBefore = await displayZeros();

      const cb = await run("Checkbox");
      expect(cb, "no Checkbox suite").not.toBeNull();
      expect(cb!.results.map((r) => `${r.name}: ${r.status}${r.error ? ` (${r.error})` : ""}`), "Checkbox suite").toEqual(
        cb!.results.map((r) => `${r.name}: pass`),
      );
      expect(cb!.results).toHaveLength(4);

      const gap = await run("Excel Gap Features");
      const dz = gap!.results.find((r) => r.name === "DisplayZeros: toggle state through the View menu's door");
      expect(dz, "the renamed DisplayZeros test is missing").toBeTruthy();
      expect(`${dz!.status}${dz!.error ? ` (${dz!.error})` : ""}`).toBe("pass");
      expect(await displayZeros(), "the DisplayZeros test left the display setting changed").toBe(zerosBefore);

      const fmt = await run("Formatting Operations");
      const st = fmt!.results.find((r) => r.name === "Cell retains value after style change");
      expect(st, "the style test is missing").toBeTruthy();
      expect(`${st!.status}${st!.error ? ` (${st!.error})` : ""}`).toBe("pass");
      expect((await styleAt(page, 500, 10)).bold, "K501 is still bold after the suite (its formats were not cleared)").not.toBe(true);
    } finally {
      await cleanup(page);
    }
  });
});

// ===========================================================================
// 10. Y11 (X12 repeated): Copy / Paste on a canvas through the Edit menu, the
//     Home tab and Ctrl+C / Ctrl+V -- ONE rule (@api/objectClipboard)
// ===========================================================================

const CHART_STORE = "/extensions/Charts/lib/chartStore.ts";
const OBJECT_SELECTION = "/src/api/objectSelection.ts";

async function chartOn(page: Page, sheetIndex: number, dataSheetId: string, x: number, y: number, name: string): Promise<string> {
  await installAppImport(page);
  return page.evaluate(
    async ({ mod, sheetIndex, dataSheetId, x, y, name }) => {
      const store = (await (window as unknown as { __appImport: (m: string) => Promise<Record<string, unknown>> }).__appImport(mod)) as {
        createChart: (s: unknown, p: Record<string, unknown>) => { chartId: string };
        syncChartRegions: () => void;
      };
      const spec = {
        mark: "bar",
        data: { sheetIndex: 0, sheetId: dataSheetId, startRow: 0, startCol: 0, endRow: 4, endCol: 1 },
        hasHeaders: true,
        seriesOrientation: "columns",
        categoryIndex: 0,
        series: [{ sourceIndex: 1, name: "Units", color: "#4472C4" }],
        title: name,
      };
      const created = store.createChart(spec, { sheetIndex, x, y, width: 200, height: 150, name });
      store.syncChartRegions();
      return created.chartId;
    },
    { mod: CHART_STORE, sheetIndex, dataSheetId, x, y, name },
  );
}

async function chartsOnSheet(page: Page, sheetIndex: number): Promise<Array<{ id: string; x: number; y: number }>> {
  const all = await invoke<Array<{ id: string; sheetIndex: number; specJson: string }>>(page, "get_charts");
  return all
    .filter((c) => c.sheetIndex === sheetIndex)
    .map((c) => {
      const d = JSON.parse(c.specJson) as { x: number; y: number };
      return { id: c.id, x: d.x, y: d.y };
    });
}

test.describe("canvas object clipboard through every door (Y11 / X12)", () => {
  test("Y11 (X12): on a canvas, two selected charts copied and pasted through Edit > Copy/Paste, the Home tab and Ctrl+C/Ctrl+V arrive as two copies 20 px offset, selected, and one Ctrl+Z removes both; a floating-grid cell's Copy is refused; on a worksheet the doors copy cells", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      await startToastLog(page);
      await writeCells(page, [[0, 0, "Month"], [0, 1, "Units"], [1, 0, "Jan"], [1, 1, "10"], [2, 0, "Feb"], [2, 1, "40"], [3, 0, "Mar"], [3, 1, "20"], [4, 0, "Apr"], [4, 1, "30"]]);
      const sheet1 = (await sheets(page)).sheets.find((s) => s.index === 0)!;

      // Worksheet: the doors copy CELLS.
      await grid.clickCell("A2");
      await runMenuItem(page, ["Edit", "Copy"]);
      await grid.clickCell("D2");
      await runMenuItem(page, ["Edit", "Paste", "Paste"]);
      await eventually(() => cellsOn(page, [[0, 1, 3]]), (v) => v[0] === "Jan", "Edit > Copy/Paste did not copy a worksheet cell");
      await page.keyboard.press("Escape");

      const canvas = await addCanvas(page);
      await chartOn(page, canvas.index, sheet1.sheetId!, 64, 64, "ClipA");
      await chartOn(page, canvas.index, sheet1.sheetId!, 320, 64, "ClipB");
      await page.waitForTimeout(1500);
      const base = await chartsOnSheet(page, canvas.index);
      expect(base).toHaveLength(2);

      // A floating grid's CELL on the canvas: Edit > Copy is refused and copies no object.
      const fr = await createFr(page, 640, 320, "ClipFR");
      await clickFrCell(page, fr, 0, 0);
      await eventually(() => frLocalSelection(page), (s) => s !== null, "the canvas floating grid's cell was not selected");
      const mark = await toastMark(page);
      await runMenuItem(page, ["Edit", "Copy"]);
      await expectOneRefusal(page, mark, "Edit > Copy with a floating-grid cell selected");
      const empty = await sheetPointToPage(page, 900, 600);
      await page.mouse.click(empty.x, empty.y);
      await runMenuItem(page, ["Edit", "Paste", "Paste"]);
      await page.waitForTimeout(800);
      expect(await chartsOnSheet(page, canvas.index), "a refused copy still pasted objects").toHaveLength(2);

      const selectBoth = async () => {
        const from = await sheetPointToPage(page, 20, 20);
        const to = await sheetPointToPage(page, 560, 250);
        await page.mouse.click(from.x, from.y);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
        await page.mouse.move(to.x, to.y, { steps: 5 });
        await page.mouse.up();
        await eventually(
          () => callModule<unknown[]>(page, OBJECT_SELECTION, "getSelectedObjectRegions", []).then((r) => r.length),
          (n) => n === 2,
          "the marquee did not select both charts",
        );
      };

      const doors: Array<{ name: string; copy: () => Promise<void>; paste: () => Promise<void> }> = [
        { name: "Edit menu", copy: () => runMenuItem(page, ["Edit", "Copy"]), paste: () => runMenuItem(page, ["Edit", "Paste", "Paste"]) },
        {
          name: "Home tab",
          copy: async () => {
            await clickRibbonTab(page, "Home");
            await page.locator('[data-testid="fmt-copy"]').click();
          },
          paste: () => page.locator('[data-testid="fmt-paste"]').click(),
        },
        {
          name: "Ctrl+C / Ctrl+V",
          copy: async () => {
            await focusGrid(page);
            await page.keyboard.press("Control+c");
          },
          paste: async () => {
            await focusGrid(page);
            await page.keyboard.press("Control+v");
          },
        },
      ];
      for (const d of doors) {
        await test.step(d.name, async () => {
          await selectBoth();
          await d.copy();
          await page.waitForTimeout(400);
          await d.paste();
          const after = await eventually(() => chartsOnSheet(page, canvas.index), (c) => c.length === 4, `${d.name}: the paste did not create two copies`);
          const copies = after.filter((c) => !base.some((b) => b.id === c.id));
          const offsets = copies.map((c) => {
            const src = base.find((b) => Math.abs(b.x + 20 - c.x) < 0.5 && Math.abs(b.y + 20 - c.y) < 0.5);
            return !!src;
          });
          expect(offsets, `${d.name}: the copies are not 20 px offset from their originals`).toEqual([true, true]);
          expect(await callModule<unknown[]>(page, OBJECT_SELECTION, "getSelectedObjectRegions", []).then((r) => r.length), `${d.name}: the copies are not selected`).toBe(2);
          await focusGrid(page);
          await page.keyboard.press("Control+z");
          await eventually(() => chartsOnSheet(page, canvas.index), (c) => c.length === 2, `${d.name}: one Ctrl+Z did not remove both copies`);
        });
      }
    } finally {
      await cleanup(page);
    }
  });
});

// ===========================================================================
// 11. FLOATING-GRID MECHANICS (E10) and the canvas mixed Delete (E11)
// ===========================================================================

async function frInfo(page: Page, id: string): Promise<FrInfo & { colWidths: Record<number, number>; rowHeights: Record<number, number> }> {
  const all = await invoke<Array<FrInfo & { colWidths: Record<number, number>; rowHeights: Record<number, number> }>>(page, "list_floating_ranges");
  return all.find((f) => f.id === id)!;
}

/** Fill a column of a floating grid (window temporarily widened: writes are window-bounded). */
async function fillFrContent(page: Page, id: string, cells: Array<[number, number, string]>, window: { rows: number; cols: number }): Promise<void> {
  const maxRow = Math.max(...cells.map(([r]) => r)) + 1;
  const maxCol = Math.max(...cells.map(([, c]) => c)) + 1;
  await callModule(page, FLOATING_RANGES, "updateFloatingRange", [id, { rowCount: Math.max(maxRow, window.rows), colCount: Math.max(maxCol, window.cols) }]);
  for (const [r, c, v] of cells) await setFrCell(page, id, r, c, v);
  await callModule(page, FLOATING_RANGES, "updateFloatingRange", [id, { rowCount: window.rows, colCount: window.cols }]);
  await eventually(() => frInfo(page, id), (f) => f.rowCount === window.rows && f.colCount === window.cols, "the window was not restored");
  await page.waitForTimeout(500);
}

test.describe("floating-grid mechanics (E10) and the canvas mixed Delete (E11)", () => {
  test("E10a: drag-selecting from row 1 past the bottom of a 3-row floating grid with 20 rows of content scrolls and extends the selection to row 20", async ({ appPage: page }) => {
    try {
      await newFile(page);
      const fr = await createFr(page, FR_POS.x, FR_POS.y, "DragFR", { rows: 3, cols: 2 });
      await fillFrContent(page, fr.id, Array.from({ length: 20 }, (_, i) => [i, 0, `r${i + 1}`] as [number, number, string]), { rows: 3, cols: 2 });
      const start = await frCellPoint(page, fr, 0, 0);
      const bottom = await sheetPointToPage(page, fr.x + 60, fr.y + FR_CHROME.title + FR_CHROME.colHeader + 3 * FR_CHROME.cellH + 30);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x, (start.y + bottom.y) / 2, { steps: 3 });
      await page.mouse.move(start.x, bottom.y, { steps: 3 });
      // Hold past the edge: the grid scrolls and the selection extends each tick.
      await eventually(
        () => frLocalSelection(page),
        (s) => !!s && s.endRow === 19,
        "holding past the bottom edge did not extend the selection to row 20",
        10_000,
      ).finally(async () => {
        await page.mouse.up();
      });
      const sel = await frLocalSelection(page);
      expect(sel && [sel.anchorRow, sel.anchorCol, sel.endRow], "the drag did not keep its anchor on row 1").toEqual([0, 0, 19]);
    } finally {
      await cleanup(page);
    }
  });

  test("E10c: stretching a floating grid's right edge scales EVERY content column, so the columns scrolled to afterwards match the stretched width", async ({ appPage: page }) => {
    try {
      await newFile(page);
      const fr = await createFr(page, FR_POS.x, FR_POS.y, "StretchFR", { rows: 3, cols: 3 });
      await fillFrContent(page, fr.id, Array.from({ length: 10 }, (_, c) => [0, c, `c${c + 1}`] as [number, number, string]), { rows: 3, cols: 3 });
      // Select the object (its title), then drag the right edge's midpoint handle.
      const title = await frTitlePoint(page, fr);
      await page.mouse.click(title.x, title.y);
      await eventually(() => frObjectSelected(page), (id) => id === fr.id, "the floating grid was not selected as an object");
      const w = FR_CHROME.rowHeader + 3 * FR_CHROME.cellW;
      const h = FR_CHROME.title + FR_CHROME.colHeader + 3 * FR_CHROME.cellH;
      const handle = await sheetPointToPage(page, fr.x + w, fr.y + h / 2);
      const geo = await readGridGeometry(page);
      await page.mouse.move(handle.x, handle.y);
      await page.mouse.down();
      await page.mouse.move(handle.x + 48 * geo.zoom, handle.y, { steps: 4 });
      await page.mouse.move(handle.x + 96 * geo.zoom, handle.y, { steps: 4 });
      await page.mouse.up();
      const info = await eventually(() => frInfo(page, fr.id), (f) => Object.keys(f.colWidths ?? {}).length > 0, "the edge drag stored no column widths");
      const widths = Array.from({ length: 10 }, (_, c) => info.colWidths[c] ?? null);
      expect(widths.every((x) => x !== null && x > FR_CHROME.cellW + 1), `not every content column was stretched: ${JSON.stringify(widths)}`).toBe(true);
      expect(new Set(widths.map((x) => Math.round((x ?? 0) * 100))).size, `the stretched columns differ: ${JSON.stringify(widths)}`).toBe(1);
    } finally {
      await cleanup(page);
    }
  });

  test("E10b: on a canvas, dragging the bottom edge of a floating grid with content down to row 1000 past the page border lands the frame's bottom exactly ON the border", async ({ appPage: page }) => {
    try {
      await newFile(page);
      await addCanvas(page);
      const fr = await createFr(page, 64, 300, "BorderFR", { rows: 10, cols: 2 });
      await fillFrContent(page, fr.id, [[0, 0, "top"], [999, 0, "bottom"]], { rows: 10, cols: 2 });
      const title = await frTitlePoint(page, fr);
      await page.mouse.click(title.x, title.y);
      await eventually(() => frObjectSelected(page), (id) => id === fr.id, "the canvas floating grid was not selected as an object");
      const w = FR_CHROME.rowHeader + 2 * FR_CHROME.cellW;
      const h = FR_CHROME.title + FR_CHROME.colHeader + 10 * FR_CHROME.cellH;
      const handle = await sheetPointToPage(page, fr.x + w / 2, fr.y + h);
      const geo = await readGridGeometry(page);
      await page.mouse.move(handle.x, handle.y);
      await page.mouse.down();
      // 536 -> 786 sheet px: past the 720 page border, still inside the window.
      await page.mouse.move(handle.x, handle.y + 120 * geo.zoom, { steps: 4 });
      await page.mouse.move(handle.x, handle.y + 250 * geo.zoom, { steps: 4 });
      await page.mouse.up();
      const info = await eventually(() => frInfo(page, fr.id), (f) => Object.keys(f.rowHeights ?? {}).length > 0, "the edge drag stored no row heights");
      let bottom = fr.y + FR_CHROME.title + FR_CHROME.colHeader;
      for (let r = 0; r < 10; r++) bottom += info.rowHeights[r] ?? FR_CHROME.cellH;
      const layout = await invoke<{ sheets: Array<{ kind?: string; canvasLayout?: { pageHeight: number } }> }>(page, "get_sheets");
      const pageH = layout.sheets.find((x) => x.kind === "canvas")?.canvasLayout?.pageHeight ?? 720;
      expect(Math.abs(bottom - pageH), `the frame's bottom is at ${bottom.toFixed(2)}, not on the page border ${pageH}`).toBeLessThanOrEqual(0.5);
    } finally {
      await cleanup(page);
    }
  });

  test("E10d: a script's api.floatingRangeGetCells on a 1000x256 floating grid returns its cells, each with its kind; with Floating Range deactivated it returns an error", async ({ appPage: page }) => {
    test.setTimeout(180_000);
    let deactivated = false;
    await withScriptsAllowed(page, async () => {
      try {
        await newFile(page);
        const fr = await createFr(page, FR_POS.x, FR_POS.y, "BigFR", { rows: 1000, cols: 256 });
        await setFrCell(page, fr.id, 0, 0, "first");
        await setFrCell(page, fr.id, 999, 255, "42");
        await setFrCell(page, fr.id, 500, 100, "=1+1");
        const body =
          `  let out;\n` +
          `  try {\n` +
          `    const r = await api.floatingRangeGetCells(${JSON.stringify(fr.id)});\n` +
          `    const kinds = r.cells.map((c) => typeof c.kind === "string" && c.kind.length > 0);\n` +
          `    out = r.rowCount + "x" + r.colCount + ":" + r.cells.length + ":" + (kinds.every(Boolean) ? "kinds" : "NOKIND");\n` +
          `  } catch (e) {\n` +
          `    out = "ERROR:" + (e && e.message ? e.message : String(e));\n` +
          `  }\n` +
          `  await api.setCellValue(0, 0, out);\n`;
        await startScript(page, "GetCells", body);
        await awaitScript(page);
        const [got] = await cellsOn(page, [[0, 0, 0]]);
        expect(got, "api.floatingRangeGetCells did not return the 3 cells of a 1000x256 range with their kinds").toBe("1000x256:3:kinds");

        await lifecycle(page, "deactivate", LIFECYCLE_FR);
        deactivated = true;
        await startScript(page, "GetCellsOff", body);
        await awaitScript(page);
        const [off] = await cellsOn(page, [[0, 0, 0]]);
        expect(off, "with Floating Range deactivated the script call did not return an error").toMatch(/^ERROR:/);
      } finally {
        if (deactivated) await lifecycle(page, "activate", LIFECYCLE_FR).catch(() => undefined);
        await cleanup(page);
      }
    });
  });

  test("E11: on a canvas, a floating grid and a chart selected together and deleted with ONE confirmation: declining keeps the range (one toast names it) while the chart goes; accepting removes both", async ({ appPage: page, grid }) => {
    test.setTimeout(180_000);
    try {
      await newFile(page);
      await startToastLog(page);
      await writeCells(page, [[0, 0, "Month"], [0, 1, "Units"], [1, 0, "Jan"], [1, 1, "10"], [2, 0, "Feb"], [2, 1, "40"], [3, 0, "Mar"], [3, 1, "20"], [4, 0, "Apr"], [4, 1, "30"]]);
      const sheet1 = (await sheets(page)).sheets.find((s) => s.index === 0)!;
      const canvas = await addCanvas(page);
      const fr = await createFr(page, 640, 320, "DelFR", { rows: 4, cols: 3 });

      const selectBoth = async (chartX: number) => {
        const title = await frTitlePoint(page, fr);
        await page.mouse.click(title.x, title.y);
        await eventually(() => frObjectSelected(page), (id) => id === fr.id, "the floating grid was not selected");
        const c = await sheetPointToPage(page, chartX + 100, 64 + 60);
        await page.keyboard.down("Control");
        await page.mouse.click(c.x, c.y);
        await page.keyboard.up("Control");
        await eventually(
          () => callModule<unknown[]>(page, OBJECT_SELECTION, "getSelectedObjectRegions", []).then((r) => r.length),
          (n) => n === 2,
          "Ctrl+click did not add the chart to the selection",
        );
      };

      // Decline.
      const c1 = await chartOn(page, canvas.index, sheet1.sheetId!, 64, 64, "DelChartA");
      await page.waitForTimeout(1200);
      await selectBoth(64);
      let mark = await toastMark(page);
      await focusGrid(page);
      await page.keyboard.press("Delete");
      const no = answerNativeDialog("Delete Floating Range", { action: "cancel" });
      expect(no.notFound, `no confirmation appeared (driver: ${no.raw})`).toBe(false);
      await page.waitForTimeout(1500);
      expect((await chartsOnSheet(page, canvas.index)).map((c) => c.id), "declining kept the chart").not.toContain(c1);
      expect((await frList(page)).some((f) => f.id === fr.id), "declining still deleted the range").toBe(true);
      const t = (await toastsSince(page, mark)).map((x) => x.message);
      expect(t.filter((m) => /DelFR/.test(m)), `expected ONE toast naming the range (saw ${JSON.stringify(t)})`).toHaveLength(1);

      // Accept.
      const c2 = await chartOn(page, canvas.index, sheet1.sheetId!, 64, 64, "DelChartB");
      await page.waitForTimeout(1200);
      await selectBoth(64);
      mark = await toastMark(page);
      await focusGrid(page);
      await page.keyboard.press("Delete");
      const yes = answerNativeDialog("Delete Floating Range", { action: "ok" });
      expect(yes.notFound, `no confirmation appeared (driver: ${yes.raw})`).toBe(false);
      await eventually(async () => (await chartsOnSheet(page, canvas.index)).some((c) => c.id === c2), (v) => v === false, "accepting did not delete the chart");
      await eventually(async () => (await frList(page)).some((f) => f.id === fr.id), (v) => v === false, "accepting did not delete the range");
    } finally {
      for (const d of appIsRunning() ? visibleDialogs() : []) answerNativeDialog(d.title, { action: "cancel" }, 2_000);
      await cleanup(page);
    }
  });
});

test.describe("the page-mode wheel on a floating grid (W16)", () => {
  test("W16: a PAGE-mode wheel notch (Windows 'one screen at a time') scrolls a floating grid showing 3 of 30 rows by exactly 3 rows; Shift+wheel scrolls sideways by exactly its cell-area width", async ({ appPage: page }) => {
    try {
      await newFile(page);
      const fr = await createFr(page, FR_POS.x, FR_POS.y, "WheelFR", { rows: 3, cols: 3 });
      await fillFrContent(
        page,
        fr.id,
        [...Array.from({ length: 30 }, (_, r) => [r, 0, `r${r + 1}`] as [number, number, string]), [0, 9, "far"]],
        { rows: 3, cols: 3 },
      );
      const scroll = () => callModule<{ left: number; top: number }>(page, "/extensions/FloatingRange/lib/frScroll.ts", "getFrScroll", [fr.id]);
      expect(await scroll(), "precondition: unscrolled").toEqual({ left: 0, top: 0 });
      const at = await frCellPoint(page, fr, 1, 1);
      // Chromium delivers Windows' page-scroll setting as deltaMode 2 (DOM_DELTA_PAGE);
      // Playwright's wheel is pixel-mode only, so the event is dispatched as the OS sends it.
      const pageWheel = (shiftKey: boolean) =>
        page.evaluate(
          ({ x, y, shiftKey }) => {
            const el = document.elementFromPoint(x, y) ?? document.body;
            el.dispatchEvent(new WheelEvent("wheel", { deltaY: 1, deltaMode: 2, clientX: x, clientY: y, shiftKey, bubbles: true, cancelable: true }));
          },
          { x: at.x, y: at.y, shiftKey },
        );
      await pageWheel(false);
      await eventually(scroll, (s) => s.top > 0, "a page-mode wheel notch did not scroll the floating grid");
      expect((await scroll()).top, "one notch did not scroll exactly the 3 visible rows (60 px)").toBeCloseTo(3 * FR_CHROME.cellH, 3);
      await pageWheel(false);
      await eventually(scroll, (s) => s.top > 3 * FR_CHROME.cellH, "a second notch did not scroll further");
      expect((await scroll()).top, "two notches are not exactly 6 rows (rows were skipped)").toBeCloseTo(6 * FR_CHROME.cellH, 3);
      await pageWheel(true);
      await eventually(scroll, (s) => s.left > 0, "Shift + a page-mode notch did not scroll sideways");
      expect((await scroll()).left, "Shift + one notch did not scroll exactly the cell area's width (3 columns)").toBeCloseTo(3 * FR_CHROME.cellW, 2);
    } finally {
      await cleanup(page);
    }
  });
});

// ===========================================================================
// 8. LAST: the close prompt's Save whose Save As picker is CANCELLED (E8).
//    Kept last in the file: if the defect came back the window is destroyed,
//    and nothing after it could run.
// ===========================================================================

test.describe("the close prompt's Save with a cancelled picker (E8, BUG-0200)", () => {
  test("E8 (BUG-0200): close an untitled dirty workbook, choose Save, cancel the Save As picker -- the window stays over the still-dirty workbook, nothing was torn down, a script still runs, and the next close asks again", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(240_000);
    expect(appIsRunning(), "app.exe is not running").toBe(true);
    expect(visibleDialogs().map((w) => w.title), "a native dialog was already open").toEqual([]);
    await withScriptsAllowed(page, async () => {
      try {
        await newFile(page);
        await grid.clickCell("C3");
        await page.keyboard.type("unsaved work");
        await page.keyboard.press("Enter");
        await expect.poll(() => invoke<boolean>(page, "is_file_modified"), { timeout: 10_000 }).toBe(true);
        expect(await invoke<string | null>(page, "get_current_file_path"), "precondition: the workbook is untitled").toBeNull();
        await hookBeforeClose(page);

        await requestWindowClose(page);
        const prompt = answerNativeDialog("Calcula", { action: "button", label: "Save" });
        expect(prompt.notFound, `no close prompt appeared (driver: ${prompt.raw})`).toBe(false);
        expect(prompt.sent, `the prompt's Save was not pressed (driver: ${prompt.raw})`).toBe("CLICKED:Save");
        expect(prompt.outcome, `the prompt did not go away (driver: ${prompt.raw})`).toBe("GONE");

        // The Save As picker: whatever the OS calls it, a new visible dialog of the app.
        let picker: { title: string } | null = null;
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline && picker === null) {
          const d = visibleDialogs().filter((w) => w.title && w.title !== "Calcula");
          if (d.length > 0) picker = { title: d[0].title };
          else await sleepMs(500);
        }
        expect(picker, "no Save As picker appeared after choosing Save").not.toBeNull();
        const cancelled = answerNativeDialog(picker!.title, { action: "escape" });
        expect(cancelled.sent, `the picker was not cancelled (driver: ${cancelled.raw})`).toBe("ESCAPED");
        expect(cancelled.outcome, `the picker did not go away (driver: ${cancelled.raw})`).toBe("GONE");

        await sleepMs(2500);
        expect(appIsRunning(), "the app EXITED after the picker was cancelled").toBe(true);
        expect(mainWindowVisible(), "the main window is gone").toBe(true);
        expect(visibleDialogs().map((w) => w.title), "a native dialog is still up").toEqual([]);
        expect(await invoke<boolean>(page, "is_file_modified"), "the workbook is no longer dirty").toBe(true);
        expect(await beforeCloseCount(page), "BEFORE_CLOSE was broadcast although nothing closed (scripts torn down)").toBe(0);
        expect(await cellsOn(page, [[0, 2, 2]]), "the unsaved edit is gone").toEqual(["unsaved work"]);

        // Scripts still run.
        await startScript(page, "StillRuns", `  await api.setCellValue(4, 4, "ran");\n`);
        await awaitScript(page);
        await eventually(() => cellsOn(page, [[0, 4, 4]]), (v) => v[0] === "ran", "a script no longer runs after the cancelled Save");

        // The next close asks again (answered with Cancel).
        await requestWindowClose(page);
        const again = answerNativeDialog("Calcula", { action: "button", label: "Cancel" });
        expect(again.notFound, `the next close did not ask again (driver: ${again.raw})`).toBe(false);
        expect(again.outcome).toBe("GONE");
        await sleepMs(1500);
        expect(appIsRunning()).toBe(true);
        await bounded("newFile", newFile(page));
      } finally {
        if (appIsRunning() && visibleDialogs().length > 0) {
          const d = visibleDialogs()[0];
          if (d.title === "Calcula") answerNativeDialog("Calcula", { action: "button", label: "Cancel" }, 2_000);
          else answerNativeDialog(d.title, { action: "escape" }, 2_000);
        }
      }
    });
  });
});

// ===========================================================================
// 9. DESTRUCTIVE (E8): close + Save ENDS the app lifetime this project
//    shares, so each of these runs ALONE, as the last act of its own launch:
//      FIXALL_EDIT_CLOSE=macro      --grep "E8b"
//      FIXALL_EDIT_CLOSE=animation  --grep "E8c"
//    In an ordinary run they are skipped (still collected).
// ===========================================================================

const CLOSE_MODE = process.env.FIXALL_EDIT_CLOSE ?? "";

/** Every text entry of a saved .cala (a ZIP of JSON), joined. */
function calaText(file: string): string {
  const entries = unzipSync(new Uint8Array(fs.readFileSync(file)));
  return Object.entries(entries)
    .map(([name, bytes]) => `@@${name}\n${new TextDecoder().decode(bytes)}`)
    .join("\n");
}

async function closeWithSave(page: Page): Promise<void> {
  await requestWindowClose(page);
  const prompt = answerNativeDialog("Calcula", { action: "button", label: "Save" });
  expect(prompt.notFound, `no close prompt appeared (driver: ${prompt.raw})`).toBe(false);
  expect(prompt.sent, `Save was not pressed (driver: ${prompt.raw})`).toBe("CLICKED:Save");
  // The window closes once the preparations and the write have landed.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && mainWindowVisible()) await sleepMs(1000);
  expect(mainWindowVisible(), "the window did not close after Save").toBe(false);
}

test.describe("close + Save, destructive (E8b/E8c, BUG-0200) -- one per launch", () => {
  test("E8b (BUG-0200): a macro recording that is running when the user closes and chooses Save is stored in the saved file", async ({ appPage: page, grid }) => {
    test.skip(CLOSE_MODE !== "macro", "destructive: run alone with FIXALL_EDIT_CLOSE=macro");
    test.setTimeout(180_000);
    const file = path.join(os.tmpdir(), `calcula-fixall-edit-e8b-${Date.now()}.cala`);
    await newFile(page);
    await writeCells(page, [[0, 0, "seed"]]);
    await invoke(page, "save_file", { path: file });
    expect(calaText(file), "precondition: the saved file holds no recording yet").not.toContain("E2ECloseRec");
    await callModule(page, "/extensions/MacroRecorder/lib/actionRecorder.ts", "startRecording", ["E2ECloseRec"]);
    await grid.clickCell("B2");
    await page.keyboard.type("rec");
    await page.keyboard.press("Enter");
    await eventually(() => cellsOn(page, [[0, 1, 1]]), (v) => v[0] === "rec", "the recorded edit did not land");
    await closeWithSave(page);
    const text = calaText(file);
    expect(text, "the saved file does not contain the recorded module (the save raced the recorder)").toContain("E2ECloseRec");
    expect(text).toContain("rec");
  });

  test("E8c (BUG-0200): an animation playing when the user closes and chooses Save leaves the ORIGINAL cell value in the file, not a frame", async ({ appPage: page }) => {
    test.skip(CLOSE_MODE !== "animation", "destructive: run alone with FIXALL_EDIT_CLOSE=animation");
    test.setTimeout(180_000);
    const file = path.join(os.tmpdir(), `calcula-fixall-edit-e8c-${Date.now()}.cala`);
    await newFile(page);
    await writeCells(page, [[0, 0, "4242"], [0, 1, "=A1*1"]]);
    await invoke(page, "save_file", { path: file });
    await writeCells(page, [[0, 2, "dirty"]]);
    const ENGINE = "/extensions/Animation/lib/animationEngine.ts";
    await installAppImport(page);
    await page.evaluate(async (mod) => {
      const m = (await (window as unknown as { __appImport: (m: string) => Promise<Record<string, unknown>> }).__appImport(mod)) as {
        playbackEngine: {
          setClockCellDriver: (c: unknown) => Promise<void>;
          setFps: (n: number) => void;
          setLoop: (b: boolean) => void;
          play: () => unknown;
        };
      };
      await m.playbackEngine.setClockCellDriver({ sheetIndex: 0, row: 0, col: 0, from: 7000000, to: 7000900, step: 1 });
      m.playbackEngine.setFps(20);
      m.playbackEngine.setLoop(true);
      void m.playbackEngine.play();
    }, ENGINE);
    await eventually(() => cellsOn(page, [[0, 0, 0]]), (v) => /^7\s?000\s?\d{3}$|^7000\d{3}$|^7[,.\s]?000[,.\s]?\d{3}$/.test(v[0]), "the animation is not playing frames into A1");
    await closeWithSave(page);
    const text = calaText(file);
    expect(text, "the saved file lost the original A1").toContain("4242");
    expect(text.match(/700\d{4}/g) ?? [], "the saved file holds an animation FRAME value").toEqual([]);
  });
});
