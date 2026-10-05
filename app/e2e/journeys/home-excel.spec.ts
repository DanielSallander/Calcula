/**
 * EXCEL 365'S HOME TAB, THROUGH THE REAL UI (2026-10-04).
 *
 * The Home tab was rebuilt as Excel 365's: eight groups (Undo, Clipboard, Font,
 * Alignment, Number, Styles, Cells, Editing), dialog launchers on Font /
 * Alignment / Number, split buttons with Excel's menus, and Excel's
 * right-to-left collapse on a narrow window. Every lane proved its control in
 * jsdom with the backend doubled; this journey proves the controls against the
 * REAL backend, in the REAL ribbon, the way a user drives them.
 *
 * WHAT IS ASSERTED. Backend state (styles, values, formulas, hidden rows, tab
 * colours, tables, filters, row heights) read back through `invoke`, and the
 * DOM (which groups exist, in which order, which are collapsed, which rows a
 * menu offers). Never a golden: the ribbon goldens are stale by owner decision
 * (memory: e2e_goldens_stale_after_owner_ui_changes), and nothing here needs a
 * pixel.
 *
 * THE NARROW WINDOW. The harness window is 1280 px wide, where Styles, Cells
 * and Editing are collapsed group buttons. Every control is therefore reached
 * through `homeControl` (helpers/homeTab.ts), which opens the group's flyout
 * when it has to -- and H1 asserts that this IS the layout at 1280, so a
 * change in the collapse is reported here, not as a timeout somewhere else.
 *
 * SESSION STATE THE RIBBON KEEPS. Three controls remember a choice for the
 * session, as Excel's do: Underline's face (single/double), Fill Color's bar
 * (the last colour) and the Borders pen (Line Color / Line Style). The tests
 * that change them put the defaults back in `finally`, so later specs see the
 * ribbon a fresh launch shows.
 *
 * GRID. Every test starts from File > New and works in A1:F12; `cleanup` ends
 * with File > New again. sv-SE locale: no formula typed here needs a separator.
 * No task pane is opened; every dialog is closed in `finally`.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import type { GridHelper } from "../helpers/grid";
import {
  cellAt,
  closeDialogsAndOverlays,
  dismissToasts,
  eventually,
  focusGrid,
  gridEditing,
  gridSelection,
  invoke,
  newFile,
  openDialogs,
  sheets,
  styleAt,
  synthKey,
  writeCells,
} from "../helpers/edit-harness";
import {
  HOME_GROUP_LABELS,
  clickHomeControl,
  clickHomeMenuRow,
  closeHomeFlyouts,
  collapsedHomeGroups,
  homeControl,
  homeGroupLauncherTestId,
  homeMenuRow,
  openHomeGroupFlyout,
  readHomeSectionCells,
} from "../helpers/homeTab";

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

interface BorderSide {
  style: string;
  color: string;
  width: number;
}

async function borders(page: Page, row: number, col: number): Promise<Record<"top" | "right" | "bottom" | "left", BorderSide>> {
  const s = (await styleAt(page, row, col)) as unknown as Record<string, BorderSide>;
  return { top: s.borderTop, right: s.borderRight, bottom: s.borderBottom, left: s.borderLeft };
}

async function display(page: Page, row: number, col: number): Promise<string> {
  return String((await cellAt(page, row, col))?.display ?? "");
}

async function formula(page: Page, row: number, col: number): Promise<string> {
  return String((await cellAt(page, row, col))?.formula ?? "");
}

/** Close menus, flyouts, dialogs and toasts, and start the next test from File > New. */
async function cleanup(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await closeHomeFlyouts(page).catch(() => undefined);
  await closeDialogsAndOverlays(page).catch(() => undefined);
  await dismissToasts(page).catch(() => undefined);
  await newFile(page);
}

async function fresh(page: Page): Promise<void> {
  await closeHomeFlyouts(page);
  await newFile(page);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("dimensions:refresh"));
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await page.waitForTimeout(500);
}

async function select(grid: GridHelper, from: string, to?: string): Promise<void> {
  if (to) await grid.selectRange(from, to);
  else await grid.clickCell(from);
  await grid.page.waitForTimeout(300);
}

/** Pick a standard swatch by its accessible name inside a palette. */
async function pickSwatch(page: Page, paletteTestId: string, colourName: string): Promise<void> {
  const palette = page.getByTestId(paletteTestId).filter({ visible: true }).first();
  await palette.waitFor({ state: "visible", timeout: 5_000 });
  await palette.locator(`button[data-colour-swatch][aria-label="${colourName}"]`).first().click();
}

/** Open the Borders menu's Line Color submenu and choose a colour (or Automatic). */
async function setBorderPenColour(page: Page, colour: "Automatic" | string): Promise<void> {
  await (await homeMenuRow(page, "fmt-borders-options", "fmt-borders-lineColor")).click();
  if (colour === "Automatic") {
    const auto = page.getByTestId("fmt-borders-lineColor-palette-automatic").filter({ visible: true }).first();
    await auto.waitFor({ state: "visible", timeout: 5_000 });
    await auto.click();
  } else {
    await pickSwatch(page, "fmt-borders-lineColor-palette", colour);
  }
  await page.waitForTimeout(300);
  // A pick closes the chain; if a level stayed open, close it so the next
  // homeMenuRow starts from a closed menu.
  if ((await page.getByTestId("fmt-borders-outside").filter({ visible: true }).count()) > 0) {
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  }
}

async function setBorderPenStyle(page: Page, style: "thin" | "dotted" | "dashed" | "double" | "medium" | "thick"): Promise<void> {
  await (await homeMenuRow(page, "fmt-borders-options", "fmt-borders-lineStyle")).click();
  const row = page.getByTestId(`fmt-borders-lineStyle-${style}`).filter({ visible: true }).first();
  await row.waitFor({ state: "visible", timeout: 5_000 });
  await row.click();
  await page.waitForTimeout(300);
  if ((await page.getByTestId("fmt-borders-outside").filter({ visible: true }).count()) > 0) {
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  }
}

// ---------------------------------------------------------------------------
// Journeys
// ---------------------------------------------------------------------------

test.describe("Excel 365's Home tab", () => {
  test("H1: eight groups in Excel's order with their captions; Styles, Cells and Editing are collapsed at 1280 and open as flyouts", async ({ appPage: page }) => {
    try {
      await fresh(page);
      const cells = await readHomeSectionCells(page);
      expect(cells.map((c) => c.label), "the Home tab's groups, left to right").toEqual([...HOME_GROUP_LABELS]);

      const width = await page.evaluate(() => window.innerWidth);
      console.log(`[H1] window ${width}px; collapsed: ${JSON.stringify(cells.filter((c) => c.collapsed).map((c) => c.label))}`);
      expect(
        await collapsedHomeGroups(page),
        `at the harness's ${width}px window Excel's order sheds Styles, Cells and Editing first (owner decision 3)`,
      ).toEqual(["styles", "cells", "editing"]);

      // The inline groups carry their controls in the band itself.
      for (const id of ["fmt-undo", "fmt-paste", "fmt-bold", "fmt-borders", "fmt-orientation", "fmt-mergeCells", "fmt-accountingFormat", "fmt-commaFormat"]) {
        await expect(page.locator(`[data-ribbon-content] [data-testid="${id}"]`), `${id} is inline in the band`).toHaveCount(1);
      }
      // Undo sits ABOVE Redo (Microsoft 365's Undo group).
      const undoBox = await page.locator('[data-ribbon-content] [data-testid="fmt-undo"]').boundingBox();
      const redoBox = await page.locator('[data-ribbon-content] [data-testid="fmt-redo"]').boundingBox();
      expect(undoBox && redoBox && undoBox.y < redoBox.y, "Undo is above Redo").toBe(true);

      // Each collapsed group opens a flyout named after it, holding its controls.
      const expected: Record<string, string[]> = {
        styles: ["fmt-conditionalFormatting", "fmt-formatAsTable", "fmt-cellStyles"],
        cells: ["fmt-insertCells", "fmt-deleteCells", "fmt-formatMenu"],
        editing: ["fmt-autoSum", "fmt-fill", "fmt-clear", "fmt-sortFilter", "fmt-findSelect"],
      };
      for (const [group, ids] of Object.entries(expected)) {
        await expect(
          page.locator(`[data-ribbon-content] [data-testid="${ids[0]}"]`),
          `${ids[0]} is NOT in the band while ${group} is collapsed`,
        ).toHaveCount(0);
        const flyout = await openHomeGroupFlyout(page, group);
        await expect(page.getByTestId(homeGroupLauncherTestId(group))).toHaveAttribute("aria-expanded", "true");
        for (const id of ids) {
          await expect(flyout.locator(`[data-testid="${id}"]`), `${group}'s flyout holds ${id}`).toHaveCount(1);
        }
        await closeHomeFlyouts(page);
        await expect(flyout, `${group}'s flyout closed again`).toBeHidden();
      }
    } finally {
      await cleanup(page);
    }
  });

  test("H2: exactly three dialog launchers; Font's opens Format Cells on the Font tab, Alignment's and Number's on theirs", async ({ appPage: page }) => {
    try {
      await fresh(page);
      const ids = await page
        .locator('[data-ribbon-content] [data-testid^="dialog-launcher-home."]')
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-testid")).sort());
      expect(ids, "Font, Alignment and Number carry Excel's corner arrow; no other group does").toEqual([
        "dialog-launcher-home.alignment",
        "dialog-launcher-home.font",
        "dialog-launcher-home.number",
      ]);

      for (const [group, tab] of [["font", "font"], ["alignment", "alignment"], ["number", "number"]] as const) {
        await closeDialogsAndOverlays(page);
        await clickHomeControl(page, `dialog-launcher-home.${group}`);
        const dialogs = await eventually(
          () => openDialogs(page),
          (d) => d.some((x) => x.id === "format-cells"),
          `the ${group} launcher did not open Format Cells`,
        );
        const data = dialogs.find((x) => x.id === "format-cells")!.data as { tab?: string } | null;
        expect(data?.tab, `the ${group} launcher opens on the ${tab} tab`).toBe(tab);
        if (tab === "font") {
          await expect(page.getByTestId("fc-font-name"), "the Font tab's own controls are on screen").toBeVisible();
        }
      }
    } finally {
      await cleanup(page);
    }
  });

  test("H3: the Paste split offers Excel's rows, and Paste Values pastes the value, not the formula", async ({ appPage: page, grid }) => {
    try {
      await fresh(page);
      await writeCells(page, [[0, 0, "5"], [1, 0, "=A1*2"]]);
      await select(grid, "A2");
      await clickHomeControl(page, "fmt-copy");
      await page.waitForTimeout(400);
      await select(grid, "C2");

      const rows = [
        "paste", "formulas", "formulasNumberFormats", "keepSource", "noBorders", "columnWidths", "transpose",
        "values", "valuesNumberFormats", "valuesSourceFormatting", "formatting", "link", "special",
      ];
      await homeMenuRow(page, "fmt-paste-options", "fmt-paste-values");
      for (const r of rows) {
        const row = page.getByTestId(`fmt-paste-${r}`).filter({ visible: true });
        await expect(row, `the Paste menu offers fmt-paste-${r}`).toHaveCount(1);
        await expect(row, `fmt-paste-${r} is live after a cell copy`).toBeEnabled();
      }
      await page.getByTestId("fmt-paste-values").filter({ visible: true }).first().click();

      await eventually(() => display(page, 1, 2), (v) => v === "10", "Paste Values did not paste 10 into C2");
      expect(await formula(page, 1, 2), "Paste Values pasted the FORMULA").toBe("");
      // Positive control: the source still holds its formula.
      expect(await formula(page, 1, 0)).toMatch(/^=A1\*2$/i);
    } finally {
      await page.keyboard.press("Escape").catch(() => undefined);
      await cleanup(page);
    }
  });

  test("H4: Borders > Outside Borders draws the range's outer edges only; Line Color then All Borders uses the colour", async ({ appPage: page, grid }) => {
    try {
      await fresh(page);
      await setBorderPenStyle(page, "thin");
      await setBorderPenColour(page, "Automatic");

      await select(grid, "B2", "C3");
      await clickHomeMenuRow(page, "fmt-borders-options", "fmt-borders-outside");
      await eventually(async () => (await borders(page, 1, 1)).top.style, (s) => s === "thin", "Outside Borders drew no top edge on B2");

      const b2 = await borders(page, 1, 1);
      const c2 = await borders(page, 1, 2);
      const b3 = await borders(page, 2, 1);
      const c3 = await borders(page, 2, 2);
      expect([b2.top.style, b2.left.style, c2.top.style, c2.right.style], "B2/C2 outer edges").toEqual(["thin", "thin", "thin", "thin"]);
      expect([b3.bottom.style, b3.left.style, c3.bottom.style, c3.right.style], "B3/C3 outer edges").toEqual(["thin", "thin", "thin", "thin"]);
      // The inside lines are NOT drawn (that is All Borders, not Outside).
      expect([b2.right.style, b2.bottom.style, c3.top.style, c3.left.style], "no inside lines").toEqual(["none", "none", "none", "none"]);

      // Line Color > Red, then All Borders on E2:F3.
      await setBorderPenColour(page, "Red");
      await select(grid, "E2", "F3");
      await clickHomeMenuRow(page, "fmt-borders-options", "fmt-borders-all");
      await eventually(async () => (await borders(page, 1, 4)).top.style, (s) => s !== "none", "All Borders drew nothing on E2");
      for (const [r, c] of [[1, 4], [1, 5], [2, 4], [2, 5]]) {
        const b = await borders(page, r, c);
        for (const side of ["top", "right", "bottom", "left"] as const) {
          expect(b[side].style, `cell ${r},${c} ${side} is drawn`).not.toBe("none");
          expect(b[side].color.toLowerCase(), `cell ${r},${c} ${side} uses the pen's Line Color`).toBe("#ff0000");
        }
      }
      // TEETH: the Outside border drawn before the colour pick is still automatic (not red).
      expect((await borders(page, 1, 1)).top.color.toLowerCase()).not.toBe("#ff0000");
    } finally {
      await page.keyboard.press("Escape").catch(() => undefined);
      await setBorderPenColour(page, "Automatic").catch(() => undefined);
      await setBorderPenStyle(page, "thin").catch(() => undefined);
      await cleanup(page);
    }
  });

  test("H5: Underline > Double Underline writes a double underline; Fill Color's face applies yellow and No Fill clears it", async ({ appPage: page, grid }) => {
    try {
      await fresh(page);
      await writeCells(page, [[0, 0, "Under"], [2, 0, "fill one"], [3, 0, "fill two"]]);

      await select(grid, "A1");
      await clickHomeMenuRow(page, "fmt-underline-options", "fmt-underline-double");
      await eventually(async () => (await styleAt(page, 0, 0)).underline, (u) => u === "double", "Double Underline did not underline A1 twice");

      // Fill Color: pick Yellow from the palette (it applies AND becomes the bar)...
      await select(grid, "A3");
      await (await homeControl(page, "fmt-backgroundColor-options")).click();
      await pickSwatch(page, "fmt-backgroundColor-popover", "Yellow");
      await eventually(async () => String((await styleAt(page, 2, 0)).backgroundColor).toLowerCase(), (c) => c === "#ffff00", "the Yellow swatch did not fill A3");

      // ...then the FACE applies the bar's colour to another cell, no palette.
      await select(grid, "A4");
      expect(String((await styleAt(page, 3, 0)).backgroundColor).toLowerCase(), "precondition: A4 is not yellow yet").not.toBe("#ffff00");
      await clickHomeControl(page, "fmt-backgroundColor");
      await eventually(async () => String((await styleAt(page, 3, 0)).backgroundColor).toLowerCase(), (c) => c === "#ffff00", "Fill Color's face did not apply yellow to A4");

      // No Fill clears it.
      await (await homeControl(page, "fmt-backgroundColor-options")).click();
      const noFill = page.getByTestId("fmt-backgroundColor-popover-automatic").filter({ visible: true }).first();
      await noFill.waitFor({ state: "visible", timeout: 5_000 });
      await noFill.click();
      await eventually(
        async () => styleAt(page, 3, 0),
        (s) => String(s.backgroundColor).toLowerCase() !== "#ffff00" && (s.fill === undefined || s.fill === null || (s.fill as { type?: string }).type === "none"),
        "No Fill did not clear A4's fill",
      );
    } finally {
      // Put the session's faces back: Underline single, Fill bar yellow.
      await page.keyboard.press("Escape").catch(() => undefined);
      await grid.clickCell("F12").catch(() => undefined);
      await clickHomeMenuRow(page, "fmt-underline-options", "fmt-underline-single").catch(() => undefined);
      await (await homeControl(page, "fmt-backgroundColor-options").catch(() => null))?.click().catch(() => undefined);
      await pickSwatch(page, "fmt-backgroundColor-popover", "Yellow").catch(() => undefined);
      await cleanup(page);
    }
  });

  test("H6: Orientation > Rotate Text Up rotates the text and grows the row so it can be read", async ({ appPage: page, grid }) => {
    try {
      await fresh(page);
      await writeCells(page, [[9, 0, "A rotated column heading"]]);
      const before = (await invoke<number | null>(page, "get_row_height", { row: 9 })) ?? 20;
      await select(grid, "A10");
      await clickHomeMenuRow(page, "fmt-orientation", "fmt-orientation-rotateTextUp");
      await eventually(async () => (await styleAt(page, 9, 0)).textRotation, (r) => r === "rotate90", "Rotate Text Up did not set rotate90");
      const after = await eventually(
        async () => (await invoke<number | null>(page, "get_row_height", { row: 9 })) ?? 20,
        (h) => h > before + 20,
        "the row did not grow to fit the rotated text",
      );
      expect(after, "Excel grows the row for rotated text").toBeGreaterThan(before);
    } finally {
      await cleanup(page);
    }
  });

  test("H7: Accounting > £ English (United Kingdom), Comma Style, and Increase Decimal on 0% gives 0.0%", async ({ appPage: page, grid }) => {
    try {
      await fresh(page);
      // Whole numbers on purpose: the harness runs sv-SE, where "1234.5" is TEXT
      // (the decimal separator is a comma), and a number format never touches text.
      await writeCells(page, [[0, 0, "1234"], [1, 0, "1234"], [2, 0, "0"]]);
      expect(
        ((await cellAt(page, 0, 0)) as { overflow?: string } | null)?.overflow,
        "precondition: A1 holds a NUMBER",
      ).toBe("numeric");

      await select(grid, "A1");
      await clickHomeMenuRow(page, "fmt-accountingFormat-options", "fmt-accountingFormat-gbp");
      await eventually(async () => String((await styleAt(page, 0, 0)).numberFormat), (f) => /^Accounting \(£, 2 decimals/.test(f), "the £ row did not write a pound Accounting format");
      expect(await display(page, 0, 0)).toContain("£");

      await select(grid, "A2");
      await clickHomeControl(page, "fmt-commaFormat");
      await eventually(async () => String((await styleAt(page, 1, 0)).numberFormat), (f) => /^Accounting \(, 2 decimals/.test(f), "Comma Style is not Accounting with no symbol and 2 decimals");
      expect(await display(page, 1, 0), "Comma Style shows no currency symbol").not.toMatch(/[£$€¥]|kr/);

      await select(grid, "A3");
      await clickHomeControl(page, "fmt-percentFormat");
      await eventually(async () => String((await styleAt(page, 2, 0)).numberFormat), (f) => f === "Percentage (0 decimals)", "the % button did not apply 0%");
      await clickHomeControl(page, "fmt-increaseDecimal");
      await eventually(async () => String((await styleAt(page, 2, 0)).numberFormat), (f) => f === "Percentage (1 decimals)", "Increase Decimal did not keep the percentage and add a decimal");
      expect(await display(page, 2, 0)).toMatch(/^0[.,]0\s*%$/);
    } finally {
      await cleanup(page);
    }
  });

  test("H8: Conditional Formatting > Highlight Cells Rules > Greater Than opens its dialog; Format as Table's gallery makes a table", async ({ appPage: page, grid }) => {
    try {
      await fresh(page);
      await writeCells(page, [
        [0, 0, "Name"], [0, 1, "Score"], [0, 2, "Team"],
        [1, 0, "Ann"], [1, 1, "10"], [1, 2, "Red"],
        [2, 0, "Bo"], [2, 1, "20"], [2, 2, "Blue"],
        [3, 0, "Cy"], [3, 1, "30"], [3, 2, "Red"],
      ]);

      await select(grid, "B2", "B4");
      await clickHomeControl(page, "fmt-conditionalFormatting");
      const highlight = page.getByTestId("cf:highlightCells").filter({ visible: true }).first();
      await highlight.waitFor({ state: "visible", timeout: 5_000 });
      await highlight.click();
      const greater = page.getByTestId("cf:greaterThan").filter({ visible: true }).first();
      await greater.waitFor({ state: "visible", timeout: 5_000 });
      await greater.click();
      const cf = await eventually(() => openDialogs(page), (d) => d.some((x) => x.id === "cf-quick-dialog"), "Greater Than... opened no dialog");
      expect((cf.find((x) => x.id === "cf-quick-dialog")!.data as { ruleType?: string } | null)?.ruleType).toBe("greaterThan");
      await closeDialogsAndOverlays(page);
      await closeHomeFlyouts(page);

      // Format as Table: the gallery's first style (Light 1) on A1:C4.
      expect(await invoke(page, "get_table_at_cell", { row: 0, col: 0 }), "precondition: no table yet").toBeNull();
      await select(grid, "A1", "C4");
      await clickHomeControl(page, "fmt-formatAsTable");
      const gallery = page.getByTestId("format-as-table-gallery").filter({ visible: true }).first();
      await gallery.waitFor({ state: "visible", timeout: 5_000 });
      await gallery.locator('[role="option"]').first().click();
      // Outside a table it opens Create Table with the style; OK creates it.
      await expect(page.locator("h2", { hasText: /^Create Table$/ })).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: "OK", exact: true }).filter({ visible: true }).last().click();
      const table = await eventually(
        () => invoke<{ startRow: number; startCol: number; endRow: number; endCol: number; styleName: string } | null>(page, "get_table_at_cell", { row: 0, col: 0 }),
        (t) => t !== null,
        "Format as Table made no table",
        10_000,
      );
      expect([table!.startRow, table!.startCol, table!.endRow, table!.endCol]).toEqual([0, 0, 3, 2]);
      expect(table!.styleName, "the table wears the picked gallery style").toMatch(/light/i);
    } finally {
      await cleanup(page);
    }
  });

  test("H9: Insert > Insert Cells... shift down moves the values; Delete > Delete Sheet Rows on a cell selection deletes the whole row", async ({ appPage: page, grid }) => {
    try {
      await fresh(page);
      await writeCells(page, [[0, 0, "top"], [1, 0, "below"], [0, 1, "side"]]);
      await select(grid, "A1");
      await clickHomeMenuRow(page, "fmt-insertCells-options", "fmt-insertCells-cells");
      await expect(page.getByTestId("insert-cells-dialog")).toBeVisible({ timeout: 10_000 });
      await page.getByTestId("cell-shift-option-down").click();
      await page.getByTestId("cell-shift-ok").click();
      await eventually(() => display(page, 1, 0), (v) => v === "top", "Insert Cells (shift down) did not move A1 to A2");
      expect(await display(page, 0, 0), "A1 is the inserted empty cell").toBe("");
      expect(await display(page, 2, 0)).toBe("below");
      expect(await display(page, 0, 1), "shift DOWN leaves column B alone").toBe("side");

      await fresh(page);
      await writeCells(page, [[0, 0, "r1"], [1, 0, "r2"], [2, 0, "r3"], [1, 3, "d2"]]);
      await select(grid, "B2");
      await clickHomeMenuRow(page, "fmt-deleteCells-options", "fmt-deleteCells-rows");
      await eventually(() => display(page, 1, 0), (v) => v === "r3", "Delete Sheet Rows did not delete row 2");
      expect(await display(page, 0, 0)).toBe("r1");
      expect(await display(page, 1, 3), "the WHOLE row went, column D too").toBe("");
    } finally {
      await cleanup(page);
    }
  });

  test("H10: Format > Hide & Unhide > Hide Rows hides the selected rows; Format > Tab Color colours the tab", async ({ appPage: page, grid }) => {
    try {
      await fresh(page);
      await select(grid, "B5", "B6");
      await clickHomeMenuRow(page, "fmt-formatMenu", "fmt-formatMenu-hideUnhide");
      const hideRows = page.getByTestId("fmt-formatMenu-hideRows").filter({ visible: true }).first();
      await hideRows.waitFor({ state: "visible", timeout: 5_000 });
      await hideRows.click();
      const hidden = await eventually(
        () => invoke<{ user: number[]; effective: number[] }>(page, "get_hidden_rows_info", { sheetIndex: null }),
        (h) => h.user.includes(4) && h.user.includes(5),
        "Hide Rows did not hide rows 5 and 6",
      );
      expect(hidden.user, "only the selected rows").not.toContain(3);
      expect(hidden.user).not.toContain(6);
      await closeHomeFlyouts(page);

      expect((await sheets(page)).sheets[0] as unknown as { tabColor?: string }).toMatchObject({ tabColor: "" });
      await clickHomeMenuRow(page, "fmt-formatMenu", "fmt-formatMenu-tabColor");
      await pickSwatch(page, "fmt-formatMenu-tabColor-palette", "Red");
      await eventually(
        async () => String(((await sheets(page)).sheets[0] as unknown as { tabColor?: string }).tabColor ?? "").toLowerCase(),
        (c) => c === "#ff0000",
        "Tab Color > Red did not colour the sheet tab",
      );
    } finally {
      await cleanup(page);
    }
  });

  test("H11: AutoSum writes =SUM over a column of numbers (range and single cell), Fill > Down copies, Clear > Clear All empties", async ({ appPage: page, grid }) => {
    try {
      await fresh(page);
      await writeCells(page, [[0, 0, "1"], [1, 0, "2"], [2, 0, "3"], [0, 2, "4"], [1, 2, "5"], [2, 2, "6"]]);

      // A range of numbers: AutoSum writes the total directly below it.
      await select(grid, "A1", "A3");
      await clickHomeControl(page, "fmt-autoSum");
      await eventually(() => formula(page, 3, 0), (f) => /^=SUM\(A1:A3\)$/i.test(f), "AutoSum on A1:A3 wrote no =SUM(A1:A3) in A4");
      expect(await display(page, 3, 0)).toBe("6");
      await closeHomeFlyouts(page);

      // One cell under numbers: Excel opens the edit with its guess; Enter commits it.
      await select(grid, "C4");
      await clickHomeControl(page, "fmt-autoSum");
      await eventually(() => gridEditing(page), (e) => e !== null && /^=SUM\(C1:C3\)$/i.test(e.value), "AutoSum on C4 opened no =SUM(C1:C3) edit");
      const caretInEditor = await eventually(
        () =>
          page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) && !el.closest("[data-ribbon-content], [data-section-flyout]");
          }),
        (v) => v,
        "AutoSum left the keyboard on the ribbon instead of in the cell edit",
      );
      expect(caretInEditor).toBe(true);
      await page.keyboard.press("Enter");
      await eventually(() => formula(page, 3, 2), (f) => /^=SUM\(C1:C3\)$/i.test(f), "Enter did not commit the AutoSum guess");
      expect(await display(page, 3, 2)).toBe("15");
      await closeHomeFlyouts(page);

      // Fill > Down.
      await writeCells(page, [[5, 4, "seed"]]);
      await select(grid, "E6", "E8");
      await clickHomeMenuRow(page, "fmt-fill", "fmt-fill-down");
      await eventually(async () => [await display(page, 6, 4), await display(page, 7, 4)], (v) => v.join() === "seed,seed", "Fill > Down did not copy E6 down");
      await closeHomeFlyouts(page);

      // Clear > Clear All: the value AND the formatting go.
      await writeCells(page, [[9, 5, "gone"]]);
      await invoke(page, "apply_formatting", { params: { rows: [9], cols: [5], bold: true } });
      expect((await styleAt(page, 9, 5)).bold, "precondition: F10 is bold").toBe(true);
      await select(grid, "F10");
      await clickHomeMenuRow(page, "fmt-clear", "fmt-clear-all");
      await eventually(() => display(page, 9, 5), (v) => v === "", "Clear All left the value");
      expect((await styleAt(page, 9, 5)).bold, "Clear All left the formatting").toBe(false);
    } finally {
      await cleanup(page);
    }
  });

  test("H12: Sort & Filter > Sort A to Z sorts the selection; Filter turns the AutoFilter on (checked) and off", async ({ appPage: page, grid }) => {
    try {
      await fresh(page);
      await writeCells(page, [[0, 0, "c"], [1, 0, "a"], [2, 0, "b"]]);
      await select(grid, "A1", "A3");
      await clickHomeMenuRow(page, "fmt-sortFilter", "fmt-sortFilter-ascending");
      await eventually(
        async () => [await display(page, 0, 0), await display(page, 1, 0), await display(page, 2, 0)].join(),
        (v) => v === "a,b,c",
        "Sort A to Z did not sort A1:A3",
      );
      await page.keyboard.press("Escape").catch(() => undefined);
      await closeHomeFlyouts(page);

      await fresh(page);
      await writeCells(page, [[0, 0, "Name"], [0, 1, "Score"], [1, 0, "Ann"], [1, 1, "10"], [2, 0, "Bo"], [2, 1, "20"]]);
      await select(grid, "A1");
      expect(await invoke(page, "get_auto_filter"), "precondition: no AutoFilter").toBeNull();
      await clickHomeMenuRow(page, "fmt-sortFilter", "fmt-sortFilter-filter");
      await eventually(() => invoke(page, "get_auto_filter"), (f) => f !== null, "Filter did not add an AutoFilter");
      await closeHomeFlyouts(page);
      const row = await homeMenuRow(page, "fmt-sortFilter", "fmt-sortFilter-filter");
      await expect(row, "the Filter row shows checked while the sheet has a filter").toHaveAttribute("aria-checked", "true");
      await row.click();
      await eventually(() => invoke(page, "get_auto_filter"), (f) => f === null, "Filter clicked again did not remove the AutoFilter");
    } finally {
      await cleanup(page);
    }
  });

  test("H13: Find & Select > Go To (and F5) navigates; Constants selects exactly the constant cells", async ({ appPage: page, grid }) => {
    try {
      await fresh(page);

      // F5 (Excel's Go To). A synthetic key: a real F5 is WebView2's reload accelerator.
      await select(grid, "A1");
      await focusGrid(page);
      await synthKey(page, { key: "F5", code: "F5" });
      await expect(page.getByTestId("go-to-dialog"), "F5 opens Go To").toBeVisible({ timeout: 10_000 });
      await page.getByTestId("go-to-reference").fill("D7");
      await page.getByTestId("go-to-ok").click();
      await eventually(() => gridSelection(page), (s) => s !== null && s.startRow === 6 && s.startCol === 3, "Go To D7 did not move the selection");

      // The ribbon's Go To... opens the same dialog.
      await clickHomeMenuRow(page, "fmt-findSelect", "fmt-findSelect-goTo");
      await expect(page.getByTestId("go-to-dialog"), "Find & Select > Go To... opens Go To").toBeVisible({ timeout: 10_000 });
      await page.getByTestId("go-to-reference").fill("B3");
      await page.getByTestId("go-to-ok").click();
      await eventually(() => gridSelection(page), (s) => s !== null && s.startRow === 2 && s.startCol === 1, "Go To B3 did not move the selection");
      await closeHomeFlyouts(page);

      // Constants: A1 and A3 are constants, A2 a formula. Exact areas, never a bounding box.
      await writeCells(page, [[0, 0, "1"], [1, 0, "=1+1"], [2, 0, "x"]]);
      await select(grid, "A1");
      await clickHomeMenuRow(page, "fmt-findSelect", "fmt-findSelect-constants");
      const sel = await eventually(
        () => gridSelection(page),
        (s) => s !== null && s.additionalRanges.length > 0,
        "Constants selected one area (expected A1 and A3 as two)",
      );
      const areas = [sel!, ...sel!.additionalRanges]
        .map((r) => [r.startRow, r.startCol, r.endRow, r.endCol].join(","))
        .sort();
      expect(areas, "exactly A1 and A3 -- never the formula in A2").toEqual(["0,0,0,0", "2,0,2,0"]);
    } finally {
      await cleanup(page);
    }
  });
});
