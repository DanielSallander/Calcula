/**
 * OWNER DECISIONS D1-D7 — proved on the RUNNING app.
 *
 * The seven entries in docs/design/open-decisions-2026-08.md §4 were decided by
 * the owner under one standing rule — "parity with Excel should take priority
 * always when there are such questions" — and shipped from separate sessions.
 * Each was unit-tested; several were integrated without the app ever being
 * launched. Unit tests can prove a Rust function seeds a cascade and a React
 * test can prove a DOM node exists. Neither can prove the USER sees the new
 * number, and that is the whole of what this file is for.
 *
 * WHY THIS IS A JOURNEY, not a functional spec. It calls `new_file`, changes the
 * workbook's CALCULATION MODE and its ITERATION SETTINGS, defines and deletes
 * NAMES, and saves and reopens the document. The functional specs share one
 * accumulating workbook whose screenshot goldens encode the residue of
 * everything that ran before them; a spec that re-identifies the document or
 * flips a workbook-wide calculation flag belongs here.
 *
 * THE TEETH RULE, applied everywhere. "A stale value that happens to equal the
 * fresh one proves nothing." Every recalculation fixture is chosen so the
 * pre-edit and post-edit values DIFFER, and the WRONG value is asserted first as
 * a precondition — so the test fails against the code the decision replaced,
 * not only against a broken future one. Where an assertion could be satisfied
 * for the wrong reason (a click that "selects A1" because everything selects
 * A1; a captured rectangle that excludes scrollbars because it excludes
 * everything) the negative half is asserted next to the positive one.
 *
 * CROSS-SHEET READS DO NOT MASK THEMSELVES. `get_cell` and `get_viewport_cells`
 * only ever answer for the ACTIVE sheet, and switching sheets to read the other
 * one runs `set_active_sheet`, which rebuilds the dependency maps — precisely
 * the machinery D1 is about. Every claim about a sheet the user is NOT looking
 * at therefore reads `get_workbook_state_digest`, a pure read of the stored
 * per-sheet grids, and the rendered half is asserted afterwards by switching.
 * The negative ("Shift+F9 did NOT reach it") is asserted BEFORE any switch, so
 * a switch that recalculated could not hide it.
 *
 * LOCALE. sv-SE: the formula argument separator is ';', never ','.
 *
 * GRID REAL ESTATE. Every test starts from `new_file`, so no other spec's
 * coordinates can reach these and vice versa. The columns other specs park
 * fixtures in — K, L, N, P, R, T-Z, AA-AD, AW-BD, BF-BL — are untouched; this
 * file works in CE-CN, which nothing else claims.
 */
import type { Page } from "@playwright/test";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "../fixtures";
import { parseCellRef } from "../helpers/grid";
import { waitForGridStable } from "../helpers/screenshots";

const SAVE_FILE = path.join(os.tmpdir(), "calcula-owner-decisions.cala");

// ===========================================================================
// Plumbing
// ===========================================================================

/** Raw backend call — setup and oracles only, never the thing under test. */
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

/**
 * Call an exported function of one of the app's OWN modules, in the app's own
 * realm — the production route the UI takes. `__calcImport` is main.tsx's
 * dev-only dynamic-import bridge (the CSP forbids `new Function`).
 */
async function callModule<T = unknown>(
  page: Page,
  modulePath: string,
  fn: string,
  args: unknown[] = [],
): Promise<T> {
  return page.evaluate(
    async ({ modulePath, fn, args }) => {
      const m = (await (window as unknown as { __calcImport: (u: string) => Promise<unknown> })
        .__calcImport(new URL(modulePath, document.baseURI).href)) as Record<
        string,
        (...a: unknown[]) => unknown
      >;
      if (typeof m[fn] !== "function") {
        throw new Error(`${modulePath} exports no function "${fn}"`);
      }
      return (await m[fn](...(args as unknown[]))) as unknown;
    },
    { modulePath, fn, args },
  ) as Promise<T>;
}

/** Wipe the workbook through the app's OWN File > New path, not `invoke`. */
async function newFile(page: Page): Promise<void> {
  await callModule(page, "/src/core/lib/file-api.ts", "newFile");
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("dimensions:refresh"));
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await page.waitForTimeout(700);
}

/** The value STORED for a cell of a named sheet, read without activating it. */
async function storedCell(page: Page, sheetName: string, ref: string): Promise<string> {
  const { row, col } = parseCellRef(ref);
  const digest = await invoke<{
    sheets: Array<{ name: string; cells: Record<string, { v: string }> }>;
  }>(page, "get_workbook_state_digest", { options: { cellsOnly: true } });
  const sheet = digest.sheets.find((s) => s.name === sheetName);
  if (!sheet) {
    throw new Error(
      `sheet "${sheetName}" not in the digest (have: ${digest.sheets.map((s) => s.name).join(", ")})`,
    );
  }
  return sheet.cells[`${row}:${col}`]?.v ?? "";
}

/**
 * The display string the CANVAS has for a cell of the ACTIVE sheet.
 * `get_viewport_cells` is the command GridCanvas itself calls for the strings it
 * paints, so this is the rendered text and not a private backend field the UI
 * may never have fetched.
 */
async function renderedCell(page: Page, ref: string): Promise<string> {
  const { row, col } = parseCellRef(ref);
  const cells = await invoke<Array<{ row: number; col: number; display: string }>>(
    page,
    "get_viewport_cells",
    { startRow: row, startCol: col, endRow: row, endCol: col },
  );
  return String(cells[0]?.display ?? "");
}

/** The FORMULA the same command hands the formula bar for a rendered cell. */
async function renderedFormula(page: Page, ref: string): Promise<string> {
  const { row, col } = parseCellRef(ref);
  const cells = await invoke<Array<{ formula: string | null }>>(page, "get_viewport_cells", {
    startRow: row,
    startCol: col,
    endRow: row,
    endCol: col,
  });
  return cells[0]?.formula ?? "";
}

/**
 * A RENDERED number as a JS number.
 *
 * The app runs under sv-SE, where the decimal separator is a COMMA and the
 * thousands separator is a space, so `Number("19,999")` is `NaN` and a
 * convergence assertion written the obvious way fails as "expected NaN" while
 * the product is perfectly correct.
 */
function numeric(display: string): number {
  return Number(display.replace(/[\s  ]/g, "").replace(",", "."));
}

/** Add a sheet through the REAL tab-bar button and wait for the auto-switch. */
async function addSheetViaUI(page: Page): Promise<void> {
  await page.locator('button[title="Add new sheet"]').click({ force: true });
  await page.waitForTimeout(900);
}

/** Switch sheets through the REAL tab button. */
async function activateSheetViaUI(page: Page, index: number): Promise<void> {
  await page.locator(`button[data-sheet-tab="${index}"]`).click();
  await page.waitForTimeout(900);
}

/** Put keyboard focus where F9 / Shift+F9 are handled (they are grid-owned). */
async function focusGrid(page: Page): Promise<void> {
  await page.locator("[data-focus-container='spreadsheet']").focus();
  await page.waitForTimeout(120);
}

/** Formulas > Calculation Options > Enable Iterative Calculation (a toggle). */
async function toggleIterativeViaMenu(
  page: Page,
  grid: { openMenu: (m: string) => Promise<void> },
): Promise<void> {
  await grid.openMenu("Formulas");
  const opts = page.locator("button").filter({ hasText: /^Calculation Options/ }).first();
  await expect(opts, "Formulas > Calculation Options must be reachable").toBeVisible({
    timeout: 5000,
  });
  await opts.hover({ timeout: 5000 });
  await page.waitForTimeout(400);
  const toggle = page
    .locator("button")
    .filter({ hasText: /^Enable Iterative Calculation/ })
    .first();
  await expect(toggle, "the iterative-calculation toggle must be reachable").toBeVisible({
    timeout: 5000,
  });
  await toggle.click({ timeout: 5000 });
  await page.waitForTimeout(700);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(60);
  }
}

// ===========================================================================

test.describe.serial("Owner decisions D1-D7 (live)", () => {
  test.setTimeout(300_000);

  // =========================================================================
  // D1(a). F9 = WORKBOOK, Shift+F9 = ACTIVE SHEET
  // =========================================================================

  /**
   * D1: "In Excel there is 'Calculate Now' that calculates the workbook and
   * 'Calculate Sheet' that calculates the sheet. We should do the same."
   *
   * `calculate_now` used to collect formula cells from the ACTIVE-SHEET mirror
   * and evaluate only those, while the menu called it "Calculate Workbook".
   * `calculate_sheet` delegated straight to it, on a comment older than
   * multi-sheet workbooks.
   *
   * MANUAL CALCULATION MODE is what makes this observable at all: in automatic
   * mode the edit itself cascades and F9 has nothing left to do, so the test
   * would pass against either implementation. Manual mode is also exactly the
   * situation a user presses F9 in.
   *
   * THE ORDER MATTERS AND IS DELIBERATE. Shift+F9's non-reach is asserted from
   * the workbook DIGEST while Sheet1 is still active — a sheet switch runs
   * `set_active_sheet`, which rebuilds dependency maps, so reading Sheet2 by
   * switching to it could mask the very thing being measured. Only once F9 has
   * been proved to have moved the STORED value do we switch and assert the
   * user can see it.
   */
  test("D1a. a dependent on a NON-ACTIVE sheet updates after F9 and does not after Shift+F9", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await addSheetViaUI(page); // creates Sheet2 and switches to it
      await grid.setCellValue("CE1", "=Sheet1!CE1*10");
      await activateSheetViaUI(page, 0);
      await grid.setCellValue("CE1", "2");
      await page.waitForTimeout(600);

      expect(
        await storedCell(page, "Sheet2", "CE1"),
        "precondition: the cross-sheet dependent is correct before manual mode",
      ).toBe("20");

      await invoke(page, "set_calculation_mode", { mode: "manual" });
      expect(await invoke<string>(page, "get_calculation_mode")).toBe("manual");

      // The edit that manual mode deliberately leaves un-cascaded.
      await grid.setCellValue("CE1", "7");
      await page.waitForTimeout(800);
      expect(
        await renderedCell(page, "CE1"),
        "the precedent itself took the new value",
      ).toBe("7");
      expect(
        await storedCell(page, "Sheet2", "CE1"),
        "TEETH: the dependent on the other sheet is STALE — 20, not 70 — so both " +
          "presses below have something real to be measured against",
      ).toBe("20");

      // Shift+F9 = Calculate Sheet. Sheet1 is active; Sheet2 is not its business.
      await focusGrid(page);
      await page.keyboard.press("Shift+F9");
      await page.waitForTimeout(1500);
      expect(
        await storedCell(page, "Sheet2", "CE1"),
        "Shift+F9 is SHEET scope: a dependent on another sheet must NOT move",
      ).toBe("20");
      expect(
        await renderedCell(page, "CE1"),
        "and the active sheet is untouched by it either way",
      ).toBe("7");

      // F9 = Calculate Now = the WORKBOOK.
      await focusGrid(page);
      await page.keyboard.press("F9");
      await expect
        .poll(() => storedCell(page, "Sheet2", "CE1"), { timeout: 15_000 })
        .toBe("70");

      // ...and the user can SEE it. (This switch may itself recalculate; the
      // claim it carries is only "the rendered grid shows 70", and the claim
      // that F9 is what moved it was made above, before any switch.)
      await activateSheetViaUI(page, 1);
      await waitForGridStable(page);
      expect(
        await renderedCell(page, "CE1"),
        "the rendered grid on the other sheet shows the recalculated value",
      ).toBe("70");
    } finally {
      await invoke(page, "set_calculation_mode", { mode: "automatic" }).catch(() => {});
      await activateSheetViaUI(page, 0).catch(() => {});
      await newFile(page);
    }
  });

  // =========================================================================
  // D1(b). A CROSS-SHEET ITERATIVE CYCLE CONVERGES UNDER REPEATED F9
  // =========================================================================

  /**
   * The measurement that settled D1, made the way it was made: with iterative
   * calculation ON, `Sheet1!CE3 = Sheet2!CE3*0.5+10` and `Sheet2!CE3 =
   * Sheet1!CE3` sat at 15 / 10 through SIX presses of F9 on Sheet1 and did not
   * budge, because the pass only ever evaluated the active sheet. Switching
   * tabs and pressing F9 on each sheet was the real round.
   *
   * So this test presses F9 and NEVER SWITCHES SHEETS. That is the difference
   * D1 made, and a test that switched tabs between presses would pass against
   * the old behaviour too.
   *
   * TEETH: the starting value is asserted to be far from the fixed point first,
   * so "it converged" cannot mean "it was already there".
   */
  test("D1b. a cross-sheet iterative cycle converges under repeated F9 without switching sheets", async ({
    appPage: page,
    grid,
  }) => {
    let iterativeOn = false;
    try {
      await newFile(page);
      await addSheetViaUI(page);
      await grid.setCellValue("CE3", "=Sheet1!CE3");
      await activateSheetViaUI(page, 0);

      await toggleIterativeViaMenu(page, grid);
      iterativeOn = true;
      const settings = await invoke<{ enabled: boolean }>(page, "get_iteration_settings");
      expect(settings.enabled, "the real menu enabled iterative calculation").toBe(true);

      await grid.setCellValue("CE3", "=Sheet2!CE3*0.5+10");
      await page.waitForTimeout(800);

      const start = await renderedCell(page, "CE3");
      expect(
        start,
        "a cross-sheet cycle must never report a circular error while iteration is ON",
      ).not.toContain("#CIRCULAR");
      expect(
        Math.abs(numeric(start) - 20),
        `TEETH: the cycle starts well away from its fixed point 20 (got "${start}"), ` +
          "so convergence below is a real move and not the initial state",
      ).toBeGreaterThan(1);

      let last = start;
      let presses = 0;
      for (; presses < 12; presses++) {
        await focusGrid(page);
        await page.keyboard.press("F9");
        await page.waitForTimeout(700);
        last = await renderedCell(page, "CE3");
        expect(
          last,
          `no #CIRCULAR at press ${presses + 1} while iteration is on`,
        ).not.toContain("#CIRCULAR");
        if (Number.isFinite(numeric(last)) && Math.abs(numeric(last) - 20) < 0.01) break;
      }
      expect(
        Math.abs(numeric(last) - 20),
        `repeated F9 on ONE sheet must converge the cross-sheet cycle to 20 ` +
          `(last "${last}" after ${presses + 1} presses, no tab switching)`,
      ).toBeLessThan(0.01);
      // eslint-disable-next-line no-console
      console.log(`[D1b] converged after ${presses + 1} F9 press(es), no sheet switching`);

      expect(
        Math.abs(numeric(await storedCell(page, "Sheet2", "CE3")) - 20),
        "and the other side of the cycle converged with it, unvisited",
      ).toBeLessThan(0.01);
    } finally {
      if (iterativeOn) {
        await toggleIterativeViaMenu(page, grid).catch(() => {});
        await invoke(page, "set_iteration_settings", {
          enabled: false,
          maxIterations: 100,
          maxChange: 0.001,
        }).catch(() => {});
      }
      await activateSheetViaUI(page, 0).catch(() => {});
      await newFile(page);
    }
  });

  // =========================================================================
  // D2. A TYPED FORMULA KEEPS ITS NAME
  // =========================================================================

  /**
   * D2: "we should do exactly as in Excel". `update_cell` used to resolve names
   * at ENTRY: with `RATE` = `$D$5`, typing `=RATE` stored `$D$5`. The name was
   * not in the document, the formula bar showed `=$D$5`, and repointing `RATE`
   * moved nothing.
   *
   * All four halves are asserted, and each is a different claim:
   *   (i)   the DOCUMENT holds the name — read straight after typing, through
   *         the same command the formula bar reads;
   *   (ii)  repointing the name moves the VALUE, with no F9 and no other edit;
   *   (iii) DELETING the name leaves `#NAME?` with the formula text intact —
   *         Excel neither substitutes the old definition back in nor blanks the
   *         formula, and this is the behaviour that falls out of storing the
   *         name rather than being coded for;
   *   (iv)  the name survives save and reload, IN THE NAME MANAGER'S OWN
   *         CAPITALISATION (§2t: `BudgetTotal` used to come back as
   *         `BUDGETTOTAL`, because a cell keeps only its AST and the reload
   *         re-parses through a lexer that upper-cases bare identifiers).
   *
   * The name is deliberately spelled in MIXED CASE. An all-caps name would
   * satisfy (iv) whether or not the reload restamp exists.
   */
  test("D2. a typed formula keeps its NAME: the bar shows it, repointing moves it, deleting leaves #NAME?, and it survives save/reload", async ({
    appPage: page,
    grid,
  }) => {
    const NAME = "OwnerDecisionRate";
    try {
      await newFile(page);
      await grid.setCellValue("CE5", "111");
      await grid.setCellValue("CE6", "222");

      const created = await invoke<{ success: boolean; error?: string }>(
        page,
        "create_named_range",
        { name: NAME, sheetIndex: null, refersTo: "=$CE$5", comment: null, folder: null },
      );
      expect(created.success, `create_named_range failed: ${created.error ?? ""}`).toBe(true);

      // ---- (i) THE BAR SHOWS THE NAME ----
      // Typed through the real editor, not `update_cell` — entry is the path
      // that used to eat the name.
      await grid.setCellValue("CE7", `=${NAME}`);
      await page.waitForTimeout(500);
      expect(
        await renderedFormula(page, "CE7"),
        "the document must hold the NAME, not the reference it expands to",
      ).toBe(`=${NAME}`);
      await grid.navigateTo("CE7");
      await page.waitForTimeout(250);
      expect(
        await grid.getFormulaBarValue(),
        "and the FORMULA BAR shows it — this is the surface the defect was reported on",
      ).toBe(`=${NAME}`);
      expect(await renderedCell(page, "CE7"), "and it evaluates").toBe("111");

      // A second, arithmetic form, so the claim is not about a bare name alone.
      await grid.setCellValue("CE8", `=${NAME}*2`);
      await page.waitForTimeout(400);
      expect(await renderedFormula(page, "CE8")).toBe(`=${NAME}*2`);
      expect(await renderedCell(page, "CE8")).toBe("222");

      // ---- (ii) REPOINTING MOVES THE VALUE, with no other action ----
      const updated = await invoke<{ success: boolean; error?: string }>(
        page,
        "update_named_range",
        { name: NAME, sheetIndex: null, refersTo: "=$CE$6", comment: null, folder: null },
      );
      expect(updated.success, `update_named_range failed: ${updated.error ?? ""}`).toBe(true);
      await expect
        .poll(() => renderedCell(page, "CE7"), { timeout: 10_000 })
        .toBe("222");
      expect(
        await renderedCell(page, "CE8"),
        "every formula that reads the name follows it, not just the bare one",
      ).toBe("444");
      expect(
        await renderedFormula(page, "CE7"),
        "and the stored formula still reads the NAME after the repoint",
      ).toBe(`=${NAME}`);

      // ---- (iv, part 1) SAVE AND RELOAD — done before the delete, because the
      //      delete is destructive to the fixture.
      await invoke(page, "save_file", { path: SAVE_FILE });
      await page.waitForTimeout(1000);
      await newFile(page); // a document that definitely has no such name
      expect(
        await renderedFormula(page, "CE7"),
        "the intermediate new document is empty, so the reload below proves something",
      ).toBe("");

      await callModule(page, "/src/core/lib/file-api.ts", "openFileAtPath", [SAVE_FILE]);
      await page.waitForTimeout(2500);
      await waitForGridStable(page);
      expect(
        await renderedFormula(page, "CE7"),
        "the NAME survived save and reload — in the Name Manager's own " +
          "capitalisation, not the lexer's (§2t)",
      ).toBe(`=${NAME}`);
      expect(
        await renderedFormula(page, "CE8"),
        "and so did the arithmetic form",
      ).toBe(`=${NAME}*2`);
      expect(await renderedCell(page, "CE7"), "and it still evaluates").toBe("222");

      // ---- (iii) DELETING THE NAME: Excel's result ----
      const deleted = await invoke<{ success: boolean; error?: string }>(
        page,
        "delete_named_range",
        { name: NAME, sheetIndex: null },
      );
      expect(deleted.success, `delete_named_range failed: ${deleted.error ?? ""}`).toBe(true);
      await expect
        .poll(() => renderedCell(page, "CE7"), { timeout: 10_000 })
        .toBe("#NAME?");
      expect(
        await renderedFormula(page, "CE7"),
        "Excel does not substitute the old definition back in and does not blank " +
          "the formula: the text stays, the value becomes #NAME?",
      ).toBe(`=${NAME}`);
      expect(
        await renderedCell(page, "CE6"),
        "TEETH: the cell the name USED to point at is untouched — deleting a name " +
          "must not touch data",
      ).toBe("222");
    } finally {
      await invoke(page, "delete_named_range", { name: NAME, sheetIndex: null }).catch(() => {});
      await newFile(page);
    }
  });

  // =========================================================================
  // D3. PIVOT AND TABLE WRITES SEED THE ONE SHARED CASCADE
  // =========================================================================

  /**
   * D3: all eight pivot/table/relocation writers seed the ONE shared cascade,
   * because Excel updates every one of these formulas. A formula over a freshly
   * written pivot block used to keep the value of whatever the pivot overwrote;
   * a totals row used to leave its readers frozen — and, found on the way, the
   * totals row never computed at all, because it stored an unresolved
   * `SUBTOTAL(109,Table1[Amount])` the engine could not evaluate.
   *
   * TEETH in both halves: the reader is written BEFORE the pivot/total exists,
   * so its pre-state is asserted to be the WRONG value (0 / the old total) and
   * the assertion cannot pass on a stale read that happens to agree.
   */
  test("D3a. a formula over a pivot's output updates when the pivot is written and refreshed", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      // Source data in CE10:CF13 — a two-column table the pivot aggregates.
      await invoke(page, "update_cells_batch", {
        updates: [
          { row: 9, col: 82, value: "city" },
          { row: 9, col: 83, value: "sales" },
          { row: 10, col: 82, value: "Uppsala" },
          { row: 10, col: 83, value: "100" },
          { row: 11, col: 82, value: "Uppsala" },
          { row: 11, col: 83, value: "200" },
          { row: 12, col: 82, value: "Lund" },
          { row: 12, col: 83, value: "400" },
        ],
      });
      await page.waitForTimeout(500);

      // A reader over the cell the pivot's GRAND TOTAL will land in — CI13,
      // measured off this exact fixture (destination CH10, one row field, one
      // value field: header row, two city rows, then "Grand Total"). It is
      // written FIRST and reads an EMPTY cell, so its value now is 0 and any
      // later non-zero is the cascade doing its job.
      await grid.setCellValue("CE30", "=CI13*10");
      await page.waitForTimeout(400);
      expect(
        await renderedCell(page, "CE30"),
        "TEETH: the reader is 0 before the pivot exists",
      ).toBe("0");

      const created = await invoke<{ pivotId: string }>(page, "create_pivot_table", {
        request: { sourceRange: "CE10:CF13", destinationCell: "CH10", hasHeaders: true },
      });
      expect(created.pivotId, "the pivot was created").toBeTruthy();

      await invoke(page, "update_pivot_fields", {
        request: {
          pivotId: created.pivotId,
          rowFields: [{ sourceIndex: 0, name: "city" }],
          valueFields: [{ sourceIndex: 1, name: "Sum of sales", aggregation: "sum" }],
        },
      });
      await page.waitForTimeout(1200);
      await waitForGridStable(page);

      expect(
        await renderedCell(page, "CH13"),
        "the fixture's layout is what this test assumes: CH13 is the Grand Total row",
      ).toBe("Grand Total");
      expect(
        await renderedCell(page, "CI13"),
        "and CI13 is its number — 100 + 200 + 400",
      ).toBe("700");
      await expect
        .poll(() => renderedCell(page, "CE30"), { timeout: 10_000 })
        .toBe("7000");

      // ---- REFRESH: change the source, refresh the cache, the reader follows.
      await invoke(page, "update_cell", { row: 12, col: 83, value: "4000" });
      await page.waitForTimeout(500);
      await invoke(page, "refresh_pivot_cache", { pivotId: created.pivotId });
      await page.waitForTimeout(1500);
      await waitForGridStable(page);
      expect(
        await renderedCell(page, "CI13"),
        "the refreshed pivot recomputed its grand total",
      ).toBe("4300");
      await expect
        .poll(() => renderedCell(page, "CE30"), { timeout: 10_000 })
        .toBe("43000");
    } finally {
      await newFile(page);
    }
  });

  test("D3b. a table operation moves a formula that reads the table's totals row", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      // A two-column table at CE40:CF44: header row 40, data rows 41-43, and
      // row 44 reserved for the TOTALS row. Measured, not assumed: with
      // `totalRow: true` the table's LAST row IS the totals row — pass
      // `endRow` as the last DATA row and the totals formula overwrites it.
      await invoke(page, "update_cells_batch", {
        updates: [
          { row: 39, col: 82, value: "Item" },
          { row: 39, col: 83, value: "Amount" },
          { row: 40, col: 82, value: "A" },
          { row: 40, col: 83, value: "100" },
          { row: 41, col: 82, value: "B" },
          { row: 41, col: 83, value: "200" },
          { row: 42, col: 82, value: "C" },
          { row: 42, col: 83, value: "300" },
        ],
      });
      await page.waitForTimeout(400);

      const created = await invoke<{ success: boolean; table: { id: number } }>(
        page,
        "create_table",
        {
          params: {
            name: "OwnerDecisionTable",
            startRow: 39,
            startCol: 82,
            endRow: 43,
            endCol: 83,
            hasHeaders: true,
            styleOptions: {
              totalRow: true,
              headerRow: true,
              bandedRows: true,
              bandedColumns: false,
              firstColumn: false,
              lastColumn: false,
              showFilterButton: true,
            },
          },
        },
      );
      expect(created.success, "the table was created").toBe(true);

      // A reader over the TOTALS cell (CF44, one row under the last data row),
      // written before the totals function exists.
      await grid.setCellValue("CE45", "=CF44*2");
      await page.waitForTimeout(400);
      expect(
        await renderedCell(page, "CE45"),
        "TEETH: the reader is 0 while the totals row holds nothing",
      ).toBe("0");

      const totals = await invoke<{ success: boolean; error?: string }>(
        page,
        "set_totals_row_function",
        { params: { tableId: created.table.id, columnName: "Amount", function: "sum" } },
      );
      expect(totals.success, `set_totals_row_function failed: ${totals.error ?? ""}`).toBe(true);
      await page.waitForTimeout(900);
      await waitForGridStable(page);

      expect(
        await renderedCell(page, "CF44"),
        "the totals row COMPUTES — it used to store an unresolved SUBTOTAL and " +
          "render blank (D3's third defect)",
      ).toBe("600");
      await expect
        .poll(() => renderedCell(page, "CE45"), { timeout: 10_000 })
        .toBe("1200");

      // ---- and editing the data underneath moves both, through the edges the
      //      table commands never used to register at all.
      await invoke(page, "update_cell", { row: 41, col: 83, value: "1000" });
      await page.waitForTimeout(900);
      expect(
        await renderedCell(page, "CF44"),
        "editing the data under a totals row moves the total",
      ).toBe("1400");
      await expect
        .poll(() => renderedCell(page, "CE45"), { timeout: 10_000 })
        .toBe("2800");
    } finally {
      await newFile(page);
    }
  });

  // =========================================================================
  // D4. THE ANIMATION PLAY PILL CLAIMS NO CELL
  // =========================================================================

  /**
   * D4: the pill was a `GridRegion` with `floating: {x: 8, y: 8}` and a
   * `hitTest` — i.e. it was IN the list the grid hit-tests — so it covered
   * A1:C2 and swallowed the click. It is now DOM chrome registered through the
   * overlay registry, and it registers no grid region whatsoever.
   *
   * Three assertions, and the middle one is the one a mock could not make:
   *   (i)   the REAL `getGridRegions()` registry gains nothing when a driver is
   *         loaded — read off the product's own registry, not a stub;
   *   (ii)  a click at A1 selects A1 AND does not start playback. Checking only
   *         the selection would pass on a pill that stopped stealing the click
   *         while still starting an animation underneath it;
   *   (iii) the close affordance unloads the driver — through the product route
   *         that did not exist before D4 (`clearDriver` had no caller at all).
   *
   * The selection is parked at CE50 first, so "A1" cannot be residue.
   */
  test("D4. with a driver loaded the pill claims no grid region, A1 still reaches the grid, and the close control unloads", async ({
    appPage: page,
    grid,
  }) => {
    const gridRegionIds = () =>
      page.evaluate(async () => {
        const m = (await (
          window as unknown as { __calcImport: (u: string) => Promise<unknown> }
        ).__calcImport(
          new URL("/src/api/gridOverlays.ts", document.baseURI).href,
        )) as { getGridRegions: () => Array<{ id: string }> };
        return m.getGridRegions().map((r) => r.id).sort();
      });

    try {
      await newFile(page);
      await grid.setCellValue("A1", "5");
      const before = await gridRegionIds();

      await grid.openMenu("View");
      await grid.clickMenuItem("Animation Timeline");
      await expect(page.locator('[data-testid="anim-driver-cell"]')).toBeVisible({
        timeout: 8000,
      });
      await page.locator('[data-testid="anim-driver-cell"]').fill("A1");
      await page.locator('[data-testid="anim-from"]').fill("0");
      await page.locator('[data-testid="anim-to"]').fill("10");
      await page.locator('[data-testid="anim-step"]').fill("1");
      await page.locator('[data-testid="anim-set-driver"]').click();
      await expect(page.locator('[data-testid="anim-frame"]')).toHaveText("1 / 11", {
        timeout: 5000,
      });
      await expect(page.locator('[data-testid="anim-play-pill"]')).toBeVisible({
        timeout: 5000,
      });

      // ---- (i) the grid's own region registry is unchanged ----
      const after = await gridRegionIds();
      expect(
        after,
        "a loaded driver must add NOTHING the grid hit-tests — read off the real " +
          "getGridRegions() registry",
      ).toEqual(before);

      // ---- (ii) the click reaches the grid, and only the grid ----
      await grid.clickCell("CE50");
      expect(
        await grid.getNameBoxValue(),
        "TEETH: the selection is parked away first, so 'A1' below cannot be residue",
      ).toBe("CE50");
      await grid.clickCell("A1");
      expect(
        await grid.getNameBoxValue(),
        "a click at A1 selects A1 with a driver loaded — the pill used to eat it",
      ).toBe("A1");
      await expect(
        page.locator('[data-testid="anim-frame"]'),
        "and the click did NOT reach the transport: still frame 1, still not playing",
      ).toHaveText("1 / 11");

      // ---- (iii) the close affordance is a real unload route ----
      await page.locator('[data-testid="anim-pill-close"]').click();
      await expect(page.locator('[data-testid="anim-play-pill"]')).toHaveCount(0, {
        timeout: 5000,
      });
      await expect(
        page.locator('[data-testid="anim-frame"]'),
        "the driver is GIVEN BACK, not merely stopped",
      ).toHaveText("no driver", { timeout: 5000 });
      expect(
        await renderedCell(page, "A1"),
        "and the transient guarantee held: the pre-playback value is restored",
      ).toBe("5");
    } finally {
      await page
        .locator('[data-testid="anim-pill-close"]')
        .click({ timeout: 3000 })
        .catch(() => {});
      await page.evaluate(() => {
        const w = window as unknown as {
          __CALCULA_PANEL_REGISTRY__?: { closePanel?: (id?: string) => void };
        };
        w.__CALCULA_PANEL_REGISTRY__?.closePanel?.("animation");
      });
      await page.waitForTimeout(300);
      await newFile(page);
    }
  });

  // =========================================================================
  // D5. A GRID CAPTURE FRAMES THE CANVAS LAYER, NOT THE SCROLLBARS
  // =========================================================================

  /**
   * D5: eleven grid goldens differed from their baseline by nothing but a
   * scrollbar THUMB, whose size and position follow the used range — shared
   * state the suite leaks between specs on purpose. `takeGridScreenshot` now
   * frames `[data-grid-canvas-layer]` instead of `[data-grid-area]`.
   *
   * ASSERTED STRUCTURALLY, as the brief requires, and NOT by looking at a
   * golden: a golden can only say "these pixels match the pixels I recorded",
   * which is exactly the thing that was unreliable. What is checked here is the
   * GEOMETRY the helper resolves:
   *
   *   (i)   the attribute the helper depends on exists (if it ever disappears
   *         the helper silently degrades to the old framing);
   *   (ii)  the captured rectangle is inset from the grid area by exactly the
   *         scrollbar thickness on the right and bottom, and by NOTHING on the
   *         top and left — so headers and frozen panes are still in frame;
   *   (iii) TEETH: the scrollbars are present, non-degenerate, and every one of
   *         them lies OUTSIDE the captured rectangle. Without this, an app that
   *         rendered no scrollbars at all would satisfy (ii) trivially;
   *   (iv)  the helper resolves to that element and not to the fallback — read
   *         off the same selector constant the helper uses.
   */
  test("D5. the grid capture rectangle excludes the scrollbars, structurally", async ({
    appPage: page,
    grid,
  }) => {
    await newFile(page);
    // Put data far out so the scrollbars have real, non-degenerate thumbs —
    // this is the state the leaked goldens were photographed in.
    await grid.setCellValue("CE60", "scrollbar fixture");
    await page.waitForTimeout(400);
    await grid.navigateTo("A1");
    await waitForGridStable(page);

    const geo = await page.evaluate(() => {
      const rect = (el: Element | null) =>
        el
          ? (({ x, y, width, height }) => ({
              x: Math.round(x),
              y: Math.round(y),
              width: Math.round(width),
              height: Math.round(height),
            }))(el.getBoundingClientRect())
          : null;
      const area = document.querySelector("[data-grid-area]");
      const layer = document.querySelector("[data-grid-canvas-layer]");
      const others = area
        ? Array.from(area.children)
            .filter((el) => !el.hasAttribute("data-grid-canvas-layer"))
            .map((el) => rect(el)!)
        : [];
      return {
        layerCount: document.querySelectorAll("[data-grid-canvas-layer]").length,
        area: rect(area),
        layer: rect(layer),
        others,
      };
    });

    // (i)
    expect(
      geo.layerCount,
      "[data-grid-canvas-layer] is a DO-NOT-BREAK contract: takeGridScreenshot " +
        "falls back to the old framing (scrollbars IN shot) without it",
    ).toBe(1);
    expect(geo.area, "the grid area is mounted").not.toBeNull();
    const area = geo.area!;
    const layer = geo.layer!;

    // (ii) — the inset is the CSS that already existed, so it is exact.
    const SCROLLBAR_SIZE = 14; // Spreadsheet.tsx
    expect(layer.x, "no inset on the LEFT: the row headers stay in frame").toBe(area.x);
    expect(layer.y, "no inset on TOP: the column headers stay in frame").toBe(area.y);
    expect(
      area.width - layer.width,
      "the captured rectangle is narrower by exactly the scrollbar thickness",
    ).toBe(SCROLLBAR_SIZE);
    expect(
      area.height - layer.height,
      "and shorter by exactly the scrollbar thickness",
    ).toBe(SCROLLBAR_SIZE);

    // (iii) TEETH — the scrollbars exist and are all outside the captured box.
    expect(
      geo.others.length,
      "the grid area really does carry scrollbars/corner box next to the canvas " +
        "layer — otherwise (ii) is satisfied by an app that draws none",
    ).toBeGreaterThan(0);
    for (const o of geo.others) {
      expect(o.width, "each is non-degenerate").toBeGreaterThan(0);
      expect(o.height, "each is non-degenerate").toBeGreaterThan(0);
      const overlapsX = o.x < layer.x + layer.width && o.x + o.width > layer.x;
      const overlapsY = o.y < layer.y + layer.height && o.y + o.height > layer.y;
      expect(
        overlapsX && overlapsY,
        `a scrollbar at ${JSON.stringify(o)} must lie OUTSIDE the captured ` +
          `rectangle ${JSON.stringify(layer)}`,
      ).toBe(false);
    }

    // (iv) — the element the helper resolves is the one measured above.
    const resolved = await page
      .locator("[data-grid-canvas-layer]")
      .first()
      .boundingBox();
    expect(resolved, "the helper's selector resolves to exactly one element").not.toBeNull();
    expect(Math.round(resolved!.width)).toBe(layer.width);
    expect(Math.round(resolved!.height)).toBe(layer.height);

    await newFile(page);
  });

  // =========================================================================
  // D6. `cells: collapsePriority` 99 -> 55
  // =========================================================================

  /**
   * D6: the Cells group's `collapsePriority` was an accidental 99 — the value a
   * missing `GROUP_ORDER` row produced — so Cells demoted LAST on a narrow
   * ribbon. The owner chose 55: between Styles (50) and Editing (60), which is
   * where Excel sheds it.
   *
   * HOW THIS IS DRIVEN, and why not by resizing the window. The demotion order
   * is decided by ONE pure product function, `computeWidthDemotions`, from the
   * live section list and the live measured widths. This test reads BOTH out of
   * the running app — the registered sections come from `panelRegistry`, the
   * widths are the real rendered widths of the ribbon strip's own children —
   * and then narrows the band, step by step, through that function.
   *
   * Actually shrinking the band would have been the other option and is the
   * wrong one here: `useSectionFit`'s own contract is that "a demoted section
   * stays demoted for the app session" (its inline content is unmounted, so it
   * cannot be re-measured), so narrowing the real ribbon would leave demoted
   * sections behind for every spec that runs after this one.
   *
   * TEETH: the ORDER is asserted in full, not just "Cells is not last". An
   * assertion that only said "not last" would pass for 11, 21 or 54 as well.
   */
  test("D6. on a narrowing ribbon the Cells group demotes between Styles and Editing, not last", async ({
    appPage: page,
  }) => {
    const live = await page.evaluate(async () => {
      const imp = (window as unknown as { __calcImport: (u: string) => Promise<unknown> })
        .__calcImport;
      const reg = (await imp(
        new URL("/src/shell/registries/panelRegistry.ts", document.baseURI).href,
      )) as { panelRegistry: { getPanel: (id: string) => { sections?: unknown[] } | undefined } };
      const panel = reg.panelRegistry.getPanel("home");
      const sections = ((panel?.sections ?? []) as Array<{
        id: string;
        label: string;
        collapsePriority?: number;
        ribbonPresentation?: string;
      }>).map((s) => ({
        id: s.id,
        label: s.label,
        collapsePriority: s.collapsePriority,
        ribbonPresentation: s.ribbonPresentation,
      }));

      // The real rendered widths of the strip's children, in section order.
      const band = document.querySelector("[data-ribbon-content]");
      const strip = band?.querySelector("div") ?? null;
      const widths = strip
        ? Array.from(strip.children).map((el) => el.getBoundingClientRect().width)
        : [];
      return { sections, widths, bandWidth: band?.getBoundingClientRect().width ?? 0 };
    });

    expect(
      live.sections.map((s) => s.id),
      "the Home panel registers its seven groups, in Excel's left-to-right order",
    ).toEqual([
      "home.clipboard",
      "home.font",
      "home.alignment",
      "home.number",
      "home.styles",
      "home.cells",
      "home.editing",
    ]);
    expect(
      live.sections.map((s) => s.collapsePriority),
      "the LIVE registered priorities — Cells is 55, between Styles (50) and Editing (60)",
    ).toEqual([10, 20, 30, 40, 50, 55, 60]);
    expect(
      live.widths.length,
      "and the ribbon really rendered all seven inline, so the widths below are real",
    ).toBe(7);
    for (const w of live.widths) expect(w).toBeGreaterThan(0);

    // Drive the PRODUCT's own decision function with the LIVE inputs, narrowing
    // the band until everything that can demote has.
    const order = await page.evaluate(
      async ({ sections, widths }) => {
        const fit = (await (
          window as unknown as { __calcImport: (u: string) => Promise<unknown> }
        ).__calcImport(
          new URL("/src/shell/components/useSectionFit.ts", document.baseURI).href,
        )) as {
          computeWidthDemotions: (
            s: Array<{
              id: string;
              width: number;
              launcherWidth?: number;
              collapsePriority: number;
              alreadyLauncher: boolean;
            }>,
            containerWidth: number,
            extra?: number,
          ) => Set<string>;
        };
        const LAUNCHER = 64; // LAUNCHER_BAND_WIDTH — no measured launcher exists yet
        const inputs = sections.map(
          (s: { id: string; collapsePriority?: number }, i: number) => ({
            id: s.id,
            width: widths[i],
            collapsePriority: s.collapsePriority ?? 1000 - i,
            alreadyLauncher: false,
          }),
        );
        const total = widths.reduce((a: number, b: number) => a + b, 0);
        const seen: string[] = [];
        for (let w = Math.ceil(total); w >= 0; w -= 4) {
          const demoted = fit.computeWidthDemotions(inputs, w);
          for (const s of inputs) {
            if (demoted.has(s.id) && !seen.includes(s.id)) seen.push(s.id);
          }
          if (seen.length === inputs.length) break;
        }
        return seen;
      },
      { sections: live.sections, widths: live.widths },
    );

    expect(
      order,
      "as the band narrows, groups become launchers in collapsePriority order — " +
        "and Cells goes SIXTH, before Editing, which is where Excel sheds it",
    ).toEqual([
      "home.clipboard",
      "home.font",
      "home.alignment",
      "home.number",
      "home.styles",
      "home.cells",
      "home.editing",
    ]);
    expect(
      order.indexOf("home.cells"),
      "TEETH stated as the defect: Cells is NOT the last thing standing (the " +
        "accidental 99 made it exactly that)",
    ).toBeLessThan(order.indexOf("home.editing"));
  });

  // =========================================================================
  // D7. EXCEL'S EXACT ERROR LITERALS
  // =========================================================================

  /**
   * D7: `cell_error_display` sent six of the ten variants to
   * `format!("#{:?}", e).to_uppercase()` — the Rust variant NAME. `#DIV0` is
   * not `#DIV/0!`, and that was not cosmetic: `isErrorValue` matches the
   * CANONICAL literals, so a division by zero was painted as ORDINARY
   * LEFT-ALIGNED BLACK TEXT, indistinguishable from a string the user typed.
   * `CellError::Parse` was deleted rather than respelled, because Excel has no
   * unparseable-formula STATE and neither does Calcula.
   *
   * Asserted here: both literals as RENDERED, the absence of `#PARSE` anywhere
   * a user can reach it, and survival across save and reload — which is the
   * property `from_literal(as_literal(v)) == v` exists to give and the one a
   * respelling breaks silently.
   */
  test("D7. a division by zero renders #DIV/0! and a bad name renders #NAME?, no #PARSE anywhere, and the literals survive save/reload", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await grid.setCellValue("CE70", "0");
      await grid.setCellValue("CE71", "=1/CE70");
      await grid.setCellValue("CE72", "=NO_SUCH_NAME_HERE");
      await grid.setCellValue("CE73", "=1+"); // unparseable: Excel refuses or stores text
      await page.waitForTimeout(700);

      expect(
        await renderedCell(page, "CE71"),
        "Excel's literal, exactly — the grid used to paint #DIV0, which " +
          "isErrorValue could not recognise as an error at all",
      ).toBe("#DIV/0!");
      expect(await renderedCell(page, "CE72"), "Excel's literal for an unknown name").toBe(
        "#NAME?",
      );

      // #PARSE appears NOWHERE the user can reach.
      const unparseable = await renderedCell(page, "CE73");
      expect(
        unparseable,
        "an unparseable formula is stored as TEXT (Excel has no unparseable-formula " +
          "STATE), so no error literal is produced for it at all",
      ).toBe("=1+");
      expect(
        await renderedFormula(page, "CE73"),
        "and it is not a formula cell",
      ).toBe("");

      const literals = await page.evaluate(async () => {
        const m = (await (
          window as unknown as { __calcImport: (u: string) => Promise<unknown> }
        ).__calcImport(new URL("/src/api/formulaFunctions.ts", document.baseURI).href)) as {
          CELL_ERROR_LITERALS: readonly string[];
        };
        return [...m.CELL_ERROR_LITERALS];
      });
      expect(
        literals,
        "the frontend's authority list carries no #PARSE — a literal missing from " +
          "it is collapsed to #VALUE! by normalizeCellErrorLiteral",
      ).not.toContain("#PARSE");
      expect(literals, "and it does carry the two under test").toEqual(
        expect.arrayContaining(["#DIV/0!", "#NAME?"]),
      );

      // Nothing on the sheet renders the old Debug spellings.
      const painted = await invoke<Array<{ display: string }>>(page, "get_viewport_cells", {
        startRow: 69,
        startCol: 82,
        endRow: 75,
        endCol: 82,
      });
      for (const c of painted) {
        expect(c.display, "no Rust variant name reaches the grid").not.toMatch(
          /^#(PARSE|DIV0|REF|NAME|VALUE|CIRCULAR|CONFLICT)$/,
        );
      }

      // ---- SAVE AND RELOAD: the literal is what round-trips ----
      await invoke(page, "save_file", { path: SAVE_FILE });
      await page.waitForTimeout(1000);
      await newFile(page);
      expect(
        await renderedCell(page, "CE71"),
        "TEETH: the intermediate document is empty, so the reload proves something",
      ).toBe("");

      await callModule(page, "/src/core/lib/file-api.ts", "openFileAtPath", [SAVE_FILE]);
      await page.waitForTimeout(2500);
      await waitForGridStable(page);
      expect(
        await renderedCell(page, "CE71"),
        "the #DIV/0! literal survives save and reload as itself",
      ).toBe("#DIV/0!");
      expect(
        await renderedCell(page, "CE72"),
        "and so does #NAME?",
      ).toBe("#NAME?");
    } finally {
      await newFile(page);
    }
  });

  // =========================================================================
  // THE TYPING RACE — every cell edit in the product
  // =========================================================================

  /**
   * §2r, and the regression that would hurt most: typing `hello` into a CLOSED
   * cell committed `"o"`, and `tabbed` committed `"b"`. Opening the editor
   * awaits two IPC round trips, so every keystroke that lands during the open
   * arrived at the grid CONTAINER — which either started a SECOND open (each
   * dispatching a fresh REPLACE-mode entry holding one character) or dropped the
   * key while the editor it deferred to did not yet have focus.
   *
   * Typed at FULL SPEED with no per-character delay, which is the condition the
   * bug needs; a test that typed slowly would pass against the broken code.
   * Deliberately NOT through `GridHelper.typeIntoCell` — that helper's
   * click-and-wait-for-the-editor dance exists because of this very bug.
   *
   * TEETH: the assertion is the WHOLE string AND ITS ORDER. "hello" would be
   * satisfied by neither `"o"` (the measured defect) nor `"olleh"`.
   */
  test("TYPING RACE. a multi-character value typed into a CLOSED cell commits whole and in order", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);

      // (a) the bug report verbatim: type into a closed cell, then commit.
      await grid.navigateTo("CE80");
      await page.waitForTimeout(200);
      await page.keyboard.type("hello", { delay: 0 });
      await page.waitForTimeout(600);
      expect(
        await grid.getFormulaBarValue(),
        "the whole word reached the editor — this used to be a single character",
      ).toBe("hello");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(600);
      expect(await renderedCell(page, "CE80"), "and the whole word committed").toBe("hello");

      // (b) the word AND its Enter inside the same open window — no pause at
      //     all between the last character and the commit.
      await grid.navigateTo("CE81");
      await page.waitForTimeout(200);
      await page.keyboard.type("tabbed\n", { delay: 0 });
      await page.waitForTimeout(800);
      expect(
        await renderedCell(page, "CE81"),
        "typing a word and committing it with no pause commits the word, not its " +
          "last character",
      ).toBe("tabbed");
      expect(
        await grid.getNameBoxValue(),
        "and Enter still moved the cursor down, exactly as it does at any speed",
      ).toBe("CE82");

      // (c) a LONGER string, so a fix that happened to buffer one extra key
      //     cannot pass. Order is what is being asserted.
      await grid.navigateTo("CE83");
      await page.waitForTimeout(200);
      await page.keyboard.type("abcdefghij", { delay: 0 });
      await page.keyboard.press("Enter");
      await page.waitForTimeout(700);
      expect(
        await renderedCell(page, "CE83"),
        "ten characters, in order, from a closed cell",
      ).toBe("abcdefghij");

      // (d) a NUMBER, because a numeric commit takes a different formatting
      //     path out of the same buffer.
      await grid.navigateTo("CE84");
      await page.waitForTimeout(200);
      await page.keyboard.type("12345", { delay: 0 });
      await page.keyboard.press("Enter");
      await page.waitForTimeout(700);
      expect(await renderedCell(page, "CE84"), "a typed number commits whole too").toBe(
        "12345",
      );
    } finally {
      await newFile(page);
    }
  });
});
