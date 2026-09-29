/**
 * FIX-ALL WAVE (A-F) -- PIVOTS, SLICERS, TIMELINES, RIBBON FILTERS AND MODEL
 * PIVOTS, PROVED LIVE.
 *
 * Every test is one LIVE CHECK written by the fix agents of waves A-F
 * (wa-pivot, wb-slicer, wc-undo W1-W4, wd-pivot, we-pivot, wf-pivot), named
 * after its item id. Each asserts BOTH directions: the fixed behaviour where
 * it should happen (a positive control, so a no-op cannot pass) AND the old
 * wrong behaviour absent. Results are read through the backend (`invoke`) or
 * the DOM; pixels are never the only witness.
 *
 * ROUTES. Pivots are created and configured through the Pivot extension's own
 * API module (`pivot-api.ts`, what the editor and dialogs call); dialogs,
 * menus, the ribbon, the grid (clicks, double-clicks, point mode, Ctrl+Z) and
 * native confirm questions (answered over Win32 by
 * `e2e/answer-native-dialog.ps1`) are driven as a user drives them. A slicer
 * item click goes through `clickSlicerItem` (what the mouse handler calls after
 * its hit test) unless the check is ABOUT the pointer; a timeline period is
 * clicked with the real mouse (a real click fires TWO selections, mousedown and
 * mouseup, which is itself part of what the wave F checks are about).
 *
 * SHARED APP. Every test starts and ends with the app's own File > New (the
 * file-api route, never a raw `new_file` -- BUG-0205).
 *
 * LOCALE. sv-SE: formulas sent through `update_cell` use `;`.
 */
import type { Page } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../fixtures";
import type { GridHelper } from "../helpers/grid";
import {
  MOD,
  activateSheet,
  addCanvas,
  addWorksheet,
  allowScripts,
  answerDialog,
  bounded,
  callModule,
  canvasPointToPage,
  cellAt,
  cellsIn,
  clickRibbonTestId,
  configurePivot,
  createRangePivot,
  dismissToasts,
  displayGrid,
  escapeRe,
  eventually,
  focusGrid,
  installAppImport,
  invoke,
  isDirty,
  menuPath,
  newFile,
  openFileAtPath,
  openRibbonTab,
  peekInPage,
  pivotApi,
  pivotRegions,
  pivotRowsByLabel,
  pivotView,
  pressRedo,
  pressUndo,
  rcToRef,
  readDialog,
  settleInPage,
  sheetPointToPage,
  sheets,
  sleep,
  startInPage,
  startObjectScript,
  startScriptInPage,
  startToastLog,
  toastLog,
  undoState,
  viewText,
  writeCells,
  writeTable,
  type AppWindow,
  type PivotView,
} from "../helpers/pivot-live";

const TMP = os.tmpdir();

/** Region / Product / Sales -- North 15, South 20, East 7; Apples 17, Pears 25; total 42. */
const DS1: Array<Array<string | number | null>> = [
  ["Region", "Product", "Sales"],
  ["North", "Apples", 10],
  ["South", "Pears", 20],
  ["North", "Pears", 5],
  ["East", "Apples", 7],
];

/** X1: two records with an EMPTY region -- (blank) 35, North 10, South 20, total 65. */
const DS_X1: Array<Array<string | number | null>> = [
  ["Region", "Product", "Sales"],
  ["North", "Apples", 10],
  [null, "Apples", 30],
  ["South", "Pears", 20],
  [null, "Pears", 5],
];

const SUM_SALES = { sourceIndex: 2, name: "Sum of Sales", aggregation: "sum" };

/** Rows of a one-level pivot as {label: value}. */
async function rowMap(page: Page, pivotId: string): Promise<Record<string, string>> {
  const rows = await pivotRowsByLabel(page, pivotId);
  const out: Record<string, string> = {};
  for (const r of rows) out[r[0]] = r[1] ?? "";
  return out;
}

/** Row labels of a one-level pivot, in order, grand total left out. */
async function rowOrder(page: Page, pivotId: string): Promise<string[]> {
  const v = await pivotView(page, pivotId);
  const t = viewText(v);
  return v.rows.map((r, i) => (r.rowType === "Data" ? t[i][0] : null)).filter((x): x is string => x !== null);
}

/** Find the grid cell (sheet-absolute) whose display is `label` in a rectangle; returns its row/col. */
async function findLabel(page: Page, sheetIndex: number, label: string, r0 = 0, c0 = 0, r1 = 40, c1 = 12): Promise<{ row: number; col: number }> {
  const cells = await cellsIn(page, sheetIndex, r0, c0, r1, c1);
  const hit = cells.find((c) => c.display === label);
  if (!hit) throw new Error(`no cell reads "${label}" in the pivot area: ${JSON.stringify(cells.map((c) => [c.row, c.col, c.display]))}`);
  return { row: hit.row, col: hit.col };
}

/** Point mode: in `ref`, type "=" and click `target`; returns the formula bar text (edit left OPEN). */
async function pickInto(page: Page, grid: GridHelper, ref: string, target: string): Promise<string> {
  await grid.clickCell(ref);
  await page.keyboard.type("=");
  await page.waitForTimeout(200);
  await grid.clickCell(target);
  return eventually(() => grid.formulaBar.inputValue(), (v) => v.length > 1, `clicking ${target} inserted nothing`);
}

/** Double-click a pivot cell and return the drill-through sheet's data rows (header dropped). */
async function drill(page: Page, grid: GridHelper, ref: string, cols: number): Promise<{ sheetIndex: number; header: string[]; rows: string[][] }> {
  const before = await sheets(page);
  await grid.doubleClickCell(ref);
  const after = await eventually(() => sheets(page), (r) => r.sheets.length === before.sheets.length + 1, `double-clicking ${ref} added no drill-through sheet`, 15_000);
  const added = after.sheets.find((s) => !before.sheets.some((b) => b.index === s.index)) ?? after.sheets[after.sheets.length - 1];
  const grid2 = await displayGrid(page, added.index, 0, 0, 30, cols - 1);
  const header = grid2[0];
  const rows = grid2.slice(1).filter((r) => r.some((c) => c !== ""));
  return { sheetIndex: added.index, header, rows };
}

// ===========================================================================
// A. Range pivots: GETPIVOTDATA, drill-through, the point-mode pick
// ===========================================================================

test.describe("A. range pivots -- GETPIVOTDATA, drill, pick (wa-pivot)", () => {
  test("P1: GETPIVOTDATA field/item form answers North's total; a North drill lists only North; the pick writes the field/item form", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await writeTable(page, DS1);
      const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:C5", destinationCell: "E1", sourceSheet: 0, destinationSheet: 0 });
      await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [SUM_SALES] });
      const north = await eventually(() => findLabel(page, 0, "North", 0, 4, 10, 5), () => true, "the pivot never wrote North", 10_000);
      expect((await cellAt(page, 0, north.row, 5))?.display, "precondition: North's pivot value").toBe("15");

      // The typed field/item form reads North's total ...
      await writeCells(page, [
        [9, 0, '=GETPIVOTDATA("Sum of Sales";E1;"Region";"North")'],
        [10, 0, '=GETPIVOTDATA("Sum of Sales";E1;"Region";"West")'],
        [11, 0, '=GETPIVOTDATA("Sum of Sales";E1)'],
      ]);
      await eventually(() => cellAt(page, 0, 9, 0).then((c) => c?.display), (v) => v === "15", "GETPIVOTDATA(Region=North) is not North's 15");
      // ... and the controls: an item the pivot does not show is #REF!, the
      // grand-total form reads the whole 42 (so 15 is not just "some cell").
      expect((await cellAt(page, 0, 10, 0))?.display, "an item the pivot does not show must be #REF!").toBe("#REF!");
      expect((await cellAt(page, 0, 11, 0))?.display, "the grand-total form").toBe("42");

      // Double-click North's value: the drill sheet lists North's records only.
      const d = await drill(page, grid, rcToRef(north.row, 5), 3);
      expect(d.header, "the drill sheet's header").toEqual(["Region", "Product", "Sales"]);
      expect(d.rows.map((r) => r[0]), "the drill lists exactly North's two records (not the whole data set)").toEqual(["North", "North"]);

      // The point-mode pick writes the field/item form, which evaluates to 15.
      await activateSheet(page, 0);
      const fb = await pickInto(page, grid, "A14", rcToRef(north.row, 5));
      expect(fb, "the pick wrote a GETPIVOTDATA").toMatch(/^=GETPIVOTDATA\(/i);
      expect(fb, "the pick names Region=North (not the grand-total form)").toMatch(/"Region"\s*[;,]\s*"North"/);
      await page.keyboard.press("Enter");
      await eventually(() => cellAt(page, 0, 13, 0).then((c) => c?.display), (v) => v === "15", "the picked formula does not evaluate to 15");
    } finally {
      await newFile(page);
    }
  });

  test("R2: the pick on Sheet3's pivot names Product=Apples, on Sheet2's pivot Region -- each sheet's own pivot", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await writeTable(page, DS1);
      const s2 = await addWorksheet(page);
      const p2 = await createRangePivot(page, { sourceRange: "Sheet1!A1:C5", destinationCell: "A1", sourceSheet: 0, destinationSheet: s2.index });
      await configurePivot(page, { pivotId: p2, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [SUM_SALES] });
      const s3 = await addWorksheet(page);
      const p3 = await createRangePivot(page, { sourceRange: "Sheet1!A1:C5", destinationCell: "A1", sourceSheet: 0, destinationSheet: s3.index });
      await configurePivot(page, { pivotId: p3, rowFields: [{ sourceIndex: 1, name: "Product" }], valueFields: [SUM_SALES] });

      // Both pivots have their first item at A2 / value at B2.
      await eventually(() => cellAt(page, s3.index, 1, 0).then((c) => c?.display), (v) => v === "Apples", "Sheet3's pivot: A2 is not Apples");
      await eventually(() => cellAt(page, s2.index, 1, 0).then((c) => c?.display), (v) => v === "East", "Sheet2's pivot: A2 is not East");

      // Sheet3 (active): the pick names Product/Apples, never Region.
      const f3 = await pickInto(page, grid, "D5", "B2");
      expect(f3, "Sheet3's pick").toMatch(/"Product"\s*[;,]\s*"Apples"/);
      expect(f3, "Sheet3's pick must not describe Sheet2's pivot").not.toContain('"Region"');
      await page.keyboard.press("Enter");
      await eventually(() => cellAt(page, s3.index, 4, 3).then((c) => c?.display), (v) => v === "17", "Sheet3!D5 is not Apples' 17");

      // Sheet2: the pick names Region/East, never Product.
      await activateSheet(page, s2.index);
      const f2 = await pickInto(page, grid, "D5", "B2");
      expect(f2, "Sheet2's pick").toMatch(/"Region"\s*[;,]\s*"East"/);
      expect(f2, "Sheet2's pick must not describe Sheet3's pivot").not.toContain('"Product"');
      await page.keyboard.press("Enter");
      await eventually(() => cellAt(page, s2.index, 4, 3).then((c) => c?.display), (v) => v === "7", "Sheet2!D5 is not East's 7");
    } finally {
      await newFile(page);
    }
  });

  test("R4: values on rows, no row field, row grand totals off -- a drill lists ALL records and the pick writes the Count form with no pairs", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await writeTable(page, DS1);
      const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:C5", destinationCell: "E1", sourceSheet: 0, destinationSheet: 0 });
      await configurePivot(page, {
        pivotId: pid,
        rowFields: [],
        columnFields: [],
        valueFields: [SUM_SALES, { sourceIndex: 2, name: "Count of Sales", aggregation: "count" }],
        layout: { valuesPosition: "rows", showRowGrandTotals: false },
      });
      // The ROW labelled Count of Sales (column E, below the header row).
      const area = await eventually(
        () => displayGrid(page, 0, 0, 4, 8, 8),
        (a) => a.some((r, i) => i > 0 && r[0] === "Count of Sales"),
        "no 'Count of Sales' row was written",
      );
      const countRow = area.findIndex((r, i) => i > 0 && r[0] === "Count of Sales");
      const header = area[0];
      const countCol = header.indexOf("Count of Sales");
      const valueJ = countCol > 0 ? countCol : area[countRow].findIndex((d, j) => j > 0 && d !== "");
      const valueRef = rcToRef(countRow, valueJ + 4);
      expect(area[countRow][valueJ], `precondition: Count of Sales is 4 (pivot area E1:I9 = ${JSON.stringify(area)})`).toBe("4");
      // Values on ROWS: each value row shows its own value once, with no value
      // field repeated across the columns (Excel: one column of values).
      expect.soft(
        area[countRow].slice(1).filter((d) => d !== ""),
        `values on rows with no row field: the Count row must show ONLY its count (pivot area E1:I9 = ${JSON.stringify(area)})`,
      ).toEqual(["4"]);
      const d = await drill(page, grid, valueRef, 3);
      expect(d.rows.length, "the drill lists every record (4), not a bogus 'Sales=...' item").toBe(4);
      expect(d.rows.map((r) => r[0]).sort()).toEqual(["East", "North", "North", "South"]);

      await activateSheet(page, 0);
      const fb = await pickInto(page, grid, "A10", valueRef);
      expect(fb, "the pick names the Count value field").toMatch(/^=GETPIVOTDATA\("Count of Sales"/i);
      const quoted = fb.match(/"[^"]*"/g) ?? [];
      expect(quoted, `the pick carries no field/item pairs: ${fb}`).toEqual(['"Count of Sales"']);
      await page.keyboard.press("Enter");
      // The same form typed by hand, as a second witness of the evaluation.
      await writeCells(page, [[11, 0, '=GETPIVOTDATA("Count of Sales";E1)'], [12, 0, '=GETPIVOTDATA("Sum of Sales";E1)']]);
      const typed = [(await cellAt(page, 0, 11, 0))?.display, (await cellAt(page, 0, 12, 0))?.display];
      await eventually(
        () => cellAt(page, 0, 9, 0).then((c) => c?.display),
        (v) => v === "4",
        `the picked formula ${fb} does not evaluate to 4 (typed Count form reads ${typed[0]}, typed Sum form reads ${typed[1]})`,
      );
    } finally {
      await newFile(page);
    }
  });

  test("P2: a saved GETPIVOTDATA on Sheet1 reading a pivot on Sheet2 answers after reopening, without visiting Sheet2", async ({
    appPage: page,
  }) => {
    const file = path.join(TMP, `fixall-pivot-p2-${Date.now()}.cala`);
    try {
      await newFile(page);
      await writeTable(page, DS1);
      const s2 = await addWorksheet(page);
      const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:C5", destinationCell: "A1", sourceSheet: 0, destinationSheet: s2.index });
      await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [SUM_SALES] });
      await activateSheet(page, 0);
      await writeCells(page, [[9, 0, `=GETPIVOTDATA("Sum of Sales";${s2.name}!A1;"Region";"North")`]]);
      await eventulyDisplay(page, 0, 9, 0, "15", "precondition: the formula reads 15 before saving");

      await invoke(page, "save_file", { path: file });
      await newFile(page);
      expect((await cellAt(page, 0, 9, 0))?.display ?? "", "File > New left the formula behind").toBe("");
      await openFileAtPath(page, file);
      const r = await sheets(page);
      expect(r.activeIndex, "the workbook reopens on Sheet1").toBe(0);
      const a10 = await eventually(() => cellAt(page, 0, 9, 0), (c) => !!c, "A10 did not come back");
      expect(a10!.formula ?? "", "the formula came back").toMatch(/GETPIVOTDATA/i);
      expect(a10!.display, "without visiting Sheet2 the formula reads 15, not #REF!").toBe("15");
    } finally {
      await newFile(page);
      fs.rmSync(file, { force: true });
    }
  });
});

async function eventulyDisplay(page: Page, sheet: number, row: number, col: number, want: string, label: string): Promise<void> {
  await eventually(() => cellAt(page, sheet, row, col).then((c) => c?.display ?? ""), (v) => v === want, label);
}

// ===========================================================================
// X. Blank members, Show Values As, source order (wd-pivot, we-pivot, wf-pivot)
// ===========================================================================

test.describe("X. blank members and Show Values As (wd-pivot X1, we-pivot Y2, wf-pivot Z2)", () => {
  test("X1 (grid): (blank) 35 / North 10 / South 20 / total 65; on columns 30-5-35 and 40-25-65; drill (blank) = 2 rows; pick names (blank); uncheck -> 30; show items with no data keeps it", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await writeTable(page, DS_X1);
      const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:C5", destinationCell: "E1", sourceSheet: 0, destinationSheet: 0 });
      await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [SUM_SALES] });
      const rows = await rowMap(page, pid);
      expect(rows, "the (blank) row is the blank records' 35, not the grand total").toMatchObject({ "(blank)": "35", North: "10", South: "20", "Grand Total": "65" });
      expect(rows["(blank)"], "the (blank) row must not read the grand total (the old 100/65 defect)").not.toBe(rows["Grand Total"]);

      // Region on columns, Product on rows.
      await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 1, name: "Product" }], columnFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [SUM_SALES] });
      const v = await pivotView(page, pid);
      const t = viewText(v);
      const headerRow = t.find((r) => r.includes("(blank)") && r.includes("North"));
      expect(headerRow, `a column header row names (blank) and North: ${JSON.stringify(t)}`).toBeTruthy();
      const blankCol = headerRow!.indexOf("(blank)");
      const gtCol = headerRow!.indexOf("Grand Total");
      const byLabel = (label: string) => t.find((r) => r[0] === label)!;
      expect([byLabel("Apples")[blankCol], byLabel("Pears")[blankCol], byLabel("Grand Total")[blankCol]], "the (blank) column").toEqual(["30", "5", "35"]);
      expect([byLabel("Apples")[gtCol], byLabel("Pears")[gtCol], byLabel("Grand Total")[gtCol]], "the Grand Total column").toEqual(["40", "25", "65"]);

      // Back to Region on rows: drill and pick the (blank) value.
      await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 0, name: "Region" }], columnFields: [], valueFields: [SUM_SALES] });
      const blank = await eventually(() => findLabel(page, 0, "(blank)", 0, 4, 10, 5), () => true, "the grid shows no (blank) row");
      const d = await drill(page, grid, rcToRef(blank.row, 5), 3);
      expect(d.rows.length, "the (blank) drill lists exactly the 2 blank-region records").toBe(2);
      expect(d.rows.map((r) => r[0]), "both drilled records have an empty region").toEqual(["", ""]);
      expect(d.rows.map((r) => r[2]).sort(), "the drilled records are the 30 and the 5").toEqual(["30", "5"]);

      await activateSheet(page, 0);
      const fb = await pickInto(page, grid, "A10", rcToRef(blank.row, 5));
      expect(fb, "the pick names Region=(blank)").toMatch(/"Region"\s*[;,]\s*"\(blank\)"/);
      await page.keyboard.press("Enter");
      await eventulyDisplay(page, 0, 9, 0, "35", "the picked (blank) formula does not evaluate to 35");

      // Uncheck (blank) (the header dropdown's apply): the grand total drops to 30.
      const fieldIndex = (v.rowFieldSummaries ?? []).find((f) => f.fieldName === "Region")?.fieldIndex ?? 0;
      await callModule(page, MOD.PIVOT_API, "applyPivotFilter", [
        { pivotId: pid, fieldIndex, filters: { manualFilter: { selectedItems: ["North", "South"] } } },
      ]);
      const filtered = await rowMap(page, pid);
      expect(filtered["(blank)"], "an unchecked (blank) row is gone").toBeUndefined();
      expect(filtered["Grand Total"], "unchecking (blank) leaves North + South").toBe("30");

      // Clear it, then "Show items with no data" on Region: the (blank) row stays.
      await callModule(page, MOD.PIVOT_API, "clearPivotFilter", [{ pivotId: pid, fieldIndex }]);
      await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 0, name: "Region", showAllItems: true }], valueFields: [SUM_SALES] });
      const all = await rowMap(page, pid);
      expect(all["(blank)"], "with Show items with no data the (blank) row stays").toBe("35");
      expect(all["Grand Total"]).toBe("65");
    } finally {
      await newFile(page);
    }
  });

  test("X1 (Show Values As, API rule): Running Total In Region 35/45/65, Rank Largest 1/3/2, Difference From (previous) none/-25/10", async ({
    appPage: page,
  }) => {
    try {
      await newFile(page);
      await writeTable(page, DS_X1);
      const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:C5", destinationCell: "E1", sourceSheet: 0, destinationSheet: 0 });
      const withShowAs = (showAs: Record<string, string>) =>
        configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [{ ...SUM_SALES, showAs }] });

      await withShowAs({ calculation: "runningTotal", baseField: "Region" });
      const rt = await rowMap(page, pid);
      expect([rt["(blank)"], rt.North, rt.South], "Running Total In Region").toEqual(["35", "45", "65"]);

      await withShowAs({ calculation: "rankDescending", baseField: "Region" });
      const rk = await rowMap(page, pid);
      expect([rk["(blank)"], rk.South, rk.North], "Rank Largest to Smallest").toEqual(["1", "2", "3"]);

      await withShowAs({ calculation: "differenceFrom", baseField: "Region", baseItem: "(previous)" });
      const df = await rowMap(page, pid);
      expect(df["(blank)"], "the first item has no previous: no number").not.toMatch(/\d/);
      expect([df.North, df.South], "Difference From (previous)").toEqual(["-25", "10"]);

      // Control: Normal shows the plain sums again.
      await withShowAs({ calculation: "none" });
      const n = await rowMap(page, pid);
      expect([n["(blank)"], n.North, n.South]).toEqual(["35", "10", "20"]);
    } finally {
      await newFile(page);
    }
  });

  test("Y2: sorted Z-A, Running Total In Region 20/30/65; Difference (previous) none/-10/25; A-Z 35/45/65; Year rows x Region Z-A columns 0/10/40; West hidden + Rank Smallest East 1 (blank) 2", async ({
    appPage: page,
  }) => {
    try {
      await newFile(page);
      await writeTable(page, [
        ["Region", "Year", "Sales"],
        ["East", "Y1", 10],
        [null, "Y1", 30],
        ["West", "Y2", 20],
        [null, "Y2", 5],
      ]);
      const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:C5", destinationCell: "E1", sourceSheet: 0, destinationSheet: 0 });
      const region = (extra: Record<string, unknown> = {}) => ({ sourceIndex: 0, name: "Region", ...extra });
      const valueAs = (showAs: Record<string, string>) => [{ ...SUM_SALES, showAs }];

      await configurePivot(page, { pivotId: pid, rowFields: [region({ sortOrder: "desc" })], valueFields: valueAs({ calculation: "runningTotal", baseField: "Region" }) });
      expect(await rowOrder(page, pid), "Z-A order").toEqual(["West", "East", "(blank)"]);
      const rt = await rowMap(page, pid);
      expect([rt.West, rt.East, rt["(blank)"]], "Running Total In Region along Z-A").toEqual(["20", "30", "65"]);

      await configurePivot(page, { pivotId: pid, rowFields: [region({ sortOrder: "desc" })], valueFields: valueAs({ calculation: "differenceFrom", baseField: "Region", baseItem: "(previous)" }) });
      const df = await rowMap(page, pid);
      expect(df.West, "the first item (West) has no previous").not.toMatch(/\d/);
      expect([df.East, df["(blank)"]], "Difference From (previous) along Z-A").toEqual(["-10", "25"]);

      await configurePivot(page, { pivotId: pid, rowFields: [region({ sortOrder: "asc" })], valueFields: valueAs({ calculation: "runningTotal", baseField: "Region" }) });
      expect(await rowOrder(page, pid), "A-Z order").toEqual(["(blank)", "East", "West"]);
      const az = await rowMap(page, pid);
      expect([az["(blank)"], az.East, az.West], "Running Total along A-Z").toEqual(["35", "45", "65"]);

      // Year on rows, Region on columns sorted Z-A, running total along Region.
      await configurePivot(page, {
        pivotId: pid,
        rowFields: [{ sourceIndex: 1, name: "Year" }],
        columnFields: [region({ sortOrder: "desc" })],
        valueFields: valueAs({ calculation: "runningTotal", baseField: "Region" }),
      });
      const t = viewText(await pivotView(page, pid));
      const hdr = t.find((r) => r.includes("West") && r.includes("East"))!;
      expect(hdr, `a header row names the regions: ${JSON.stringify(t)}`).toBeTruthy();
      const y1 = t.find((r) => r[0] === "Y1")!;
      const cols = ["West", "East", "(blank)"].map((l) => hdr.indexOf(l));
      expect(cols.every((c) => c > 0), `Z-A columns West/East/(blank) all present: ${JSON.stringify(hdr)}`).toBe(true);
      expect(cols.map((c) => y1[c] === "" ? "0" : y1[c]), "the Y1 row along Region Z-A").toEqual(["0", "10", "40"]);

      // Hide West, Rank Smallest to Largest.
      await configurePivot(page, {
        pivotId: pid,
        rowFields: [region({ sortOrder: "asc", hiddenItems: ["West"] })],
        columnFields: [],
        valueFields: valueAs({ calculation: "rankAscending", baseField: "Region" }),
      });
      const rk = await rowMap(page, pid);
      expect(rk.West, "West is hidden").toBeUndefined();
      expect([rk.East, rk["(blank)"]], "Rank Smallest to Largest over the shown items").toEqual(["1", "2"]);
    } finally {
      await newFile(page);
    }
  });

  test("Z2: 'Data source order' and 'Manual' list items in entry order on rows and on columns (not hash order)", async ({ appPage: page }) => {
    const entry = ["Delta", "Alpha", "Hotel", "Bravo", "Golf", "Charlie", "Foxtrot", "Echo"];
    try {
      await newFile(page);
      await writeTable(page, [["Region", "Sales"], ...entry.map((r, i) => [r, i + 1])]);
      const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:B9", destinationCell: "E1", sourceSheet: 0, destinationSheet: 0 });
      const value = [{ sourceIndex: 1, name: "Sum of Sales", aggregation: "sum" }];

      // Control: ascending is alphabetical (so "entry order" below is not an accident).
      await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 0, name: "Region", sortOrder: "asc" }], valueFields: value });
      expect(await rowOrder(page, pid)).toEqual([...entry].sort());

      for (const order of ["source", "manual"]) {
        await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 0, name: "Region", sortOrder: order }], valueFields: value });
        expect(await rowOrder(page, pid), `rows, sortOrder=${order}`).toEqual(entry);
      }

      // On columns.
      await configurePivot(page, { pivotId: pid, rowFields: [], columnFields: [{ sourceIndex: 0, name: "Region", sortOrder: "source" }], valueFields: value });
      const t = viewText(await pivotView(page, pid));
      const hdr = t.find((r) => entry.every((e) => r.includes(e)));
      expect(hdr, `a header row lists all regions: ${JSON.stringify(t)}`).toBeTruthy();
      expect(hdr!.filter((c) => entry.includes(c)), "columns, sortOrder=source").toEqual(entry);
    } finally {
      await newFile(page);
    }
  });
});

// ===========================================================================
// UI helpers: the Create PivotTable dialog, Change Data Source, the field pane
// ===========================================================================

function createDialog(page: Page) {
  return page.locator("h2", { hasText: /^Create PivotTable$/ }).locator("xpath=../..");
}

async function openCreatePivotDialog(page: Page): Promise<void> {
  await menuPath(page, "Insert", ["PivotTable..."]);
  await expect(createDialog(page), "Insert > PivotTable... opened no Create PivotTable dialog").toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(600); // the auto-detect of the source runs after open
}

function cdsDialog(page: Page) {
  return page.locator("h2", { hasText: /^Change PivotTable Data Source$/ }).locator("xpath=../..");
}

/** Select a cell of the pivot, then Pivot Table > Change Source. */
async function openChangeDataSource(page: Page, grid: GridHelper, pivotCell: string): Promise<void> {
  // A cell AWAY from the pivot first: the contextual tab follows a selection CHANGE.
  await grid.clickCell("H14");
  await page.waitForTimeout(300);
  await grid.clickCell(pivotCell);
  await page.waitForTimeout(700);
  await openRibbonTab(page, "Pivot Table");
  await clickRibbonTestId(page, "pivot-analyze-change-source");
  await expect(cdsDialog(page), "Change Source opened no dialog").toBeVisible({ timeout: 10_000 });
  // The dialog loads the current source asynchronously.
  await page.waitForTimeout(500);
}

function cdsInput(page: Page) {
  return cdsDialog(page).locator('input[type="text"]').first();
}

/** Type a source into the open Change Data Source dialog and press OK (does NOT wait for the dialog to close). */
async function cdsApply(page: Page, text: string | null): Promise<void> {
  if (text !== null) await cdsInput(page).fill(text);
  await cdsDialog(page).getByRole("button", { name: /^OK$/ }).click();
}

async function dialogError(dialog: ReturnType<typeof createDialog>): Promise<string> {
  return dialog.evaluate((el) => {
    // The error box is the one child whose text is not a label/hint/input.
    const texts = Array.from(el.querySelectorAll("div"))
      .filter((d) => d.children.length === 0)
      .map((d) => (d.textContent ?? "").trim())
      .filter((t) => /no sheet|not|invalid|error|refus|cover|overlap|cannot|can't|Please/i.test(t));
    return texts.join(" | ");
  });
}

/** The pivot's stored source (what a refresh reads). */
async function pivotInfo(page: Page, pivotId: string): Promise<{ sourceRange: string; [k: string]: unknown }> {
  return callModule(page, MOD.PIVOT_API, "getPivotTableInfo", [pivotId]);
}

/** The field-list pane pill `name` (in its zone) -> Field options -> `item`. */
async function pillMenu(page: Page, name: string, item: string): Promise<void> {
  const pill = page.locator(`span[title="${name}"]`).first();
  await pill.waitFor({ state: "visible", timeout: 10_000 });
  await pill.locator('xpath=following-sibling::button[@title="Field options"]').click();
  await page.waitForTimeout(250);
  await page.locator("button").filter({ has: page.locator("span", { hasText: new RegExp(`^${escapeRe(item)}$`) }) }).first().click();
  await page.waitForTimeout(400);
}

/** Two data sets that cannot be confused: every Sheet1 region starts "S1-", every Sheet2 region "S2-". */
const S1DATA: Array<Array<string | number | null>> = [
  ["Region", "Product", "Channel", "Sales"],
  ["S1-North", "Apples", "Web", 1],
  ["S1-South", "Pears", "Store", 2],
  ["S1-North", "Pears", "Web", 3],
  ["S1-East", "Apples", "Store", 4],
];
const S2DATA: Array<Array<string | number | null>> = [
  ["Region", "Product", "Channel", "Sales"],
  ["S2-Alpha", "Apples", "Web", 10],
  ["S2-Beta", "Pears", "Store", 20],
  ["S2-Alpha", "Pears", "Web", 30],
  ["S2-Gamma", "Apples", "Store", 40],
  ["S2-Beta", "Apples", "Web", 50],
  ["S2-Gamma", "Pears", "Store", 60],
  ["S2-Delta", "Apples", "Web", 70],
  ["S2-Delta", "Pears", "Store", 80],
];

/** Sheet1 = S1DATA (A1:D5), Sheet2 = S2DATA (A1:D9); Sheet1 left active. */
async function seedTwoSources(page: Page): Promise<{ s2: number }> {
  await writeTable(page, S1DATA);
  const s2 = await addWorksheet(page);
  await writeTable(page, S2DATA);
  await activateSheet(page, 0);
  return { s2: s2.index };
}

/** Configure `pid` with Region on rows and return its row labels (grand total left out). */
async function regionLabels(page: Page, pid: string): Promise<string[]> {
  await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [{ sourceIndex: 3, name: "Sum of Sales", aggregation: "sum" }] });
  return rowOrder(page, pid);
}

async function allPivotIds(page: Page): Promise<string[]> {
  const all = await pivotApi<Array<{ id?: string; pivotId?: string }>>(page, "getAll", undefined);
  return all.map((p) => String(p.id ?? p.pivotId));
}

const FLOAT_A1 = { dx: 28 + 32, dy: 20 + 16 + 10 };

// ===========================================================================
// B. The Create PivotTable dialog (wa-pivot P4/R5/N1, R3; wd-pivot X3)
// ===========================================================================

test.describe("B. Create PivotTable dialog", () => {
  test("P4/R5/N1: a typed 'sheet2!$A$1:$D$9' source reads Sheet2; 'Nope!' is refused with no sheet added; 'sheet2!$F$1' lands on Sheet2 F1 and goes there; 'Nope!F1' names the missing sheet", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      const { s2 } = await seedTwoSources(page);
      await grid.clickCell("A2");

      // --- A typed sheet prefix (lower case, absolute) names the SOURCE sheet.
      const before = await allPivotIds(page);
      const sheetCount = (await sheets(page)).sheets.length;
      await openCreatePivotDialog(page);
      await createDialog(page).locator('[data-testid="pivot-worksheet-source-range"]').fill("sheet2!$A$1:$D$9");
      await createDialog(page).getByRole("button", { name: /^OK$/ }).click();
      await expect(createDialog(page), "OK did not create (the dialog stayed open)").toHaveCount(0, { timeout: 10_000 });
      const ids = await eventually(() => allPivotIds(page), (a) => a.length === before.length + 1, "no pivot was created");
      const pid = ids.find((id) => !before.includes(id))!;
      expect((await sheets(page)).sheets.length, "New Worksheet added exactly one sheet").toBe(sheetCount + 1);
      const labels = await regionLabels(page, pid);
      expect(labels.length, `the pivot has rows: ${JSON.stringify(labels)}`).toBeGreaterThan(0);
      expect(labels.every((l) => l.startsWith("S2-")), `the pivot summarises SHEET2's data, not Sheet1's: ${JSON.stringify(labels)}`).toBe(true);

      // --- An unknown sheet in the source is refused IN the dialog; no sheet is added.
      await activateSheet(page, 0);
      await grid.clickCell("A2");
      const count2 = (await sheets(page)).sheets.length;
      await openCreatePivotDialog(page);
      await createDialog(page).locator('[data-testid="pivot-worksheet-source-range"]').fill("Nope!A1:D9");
      await createDialog(page).getByRole("button", { name: /^OK$/ }).click();
      await page.waitForTimeout(1200);
      await expect(createDialog(page), "the dialog must stay open on an unknown source sheet").toBeVisible();
      expect(await dialogError(createDialog(page)), "the dialog names the missing sheet").toMatch(/Nope/);
      expect((await sheets(page)).sheets.length, "no sheet was added for a refused source").toBe(count2);
      await createDialog(page).getByRole("button", { name: /^Cancel$/ }).click();

      // --- Existing destination, typed lower case with $: lands on Sheet2 F1 and the view goes there.
      const before3 = await allPivotIds(page);
      await openCreatePivotDialog(page);
      await createDialog(page).locator('[data-testid="pivot-worksheet-source-range"]').fill("Sheet1!A1:D5");
      await createDialog(page).locator('input[type="radio"][value="existing"]').check();
      await createDialog(page).locator('input[placeholder="e.g., Sheet2!F1"]').fill("sheet2!$F$1");
      await createDialog(page).getByRole("button", { name: /^OK$/ }).click();
      await expect(createDialog(page)).toHaveCount(0, { timeout: 10_000 });
      await eventually(() => sheets(page), (r) => r.activeIndex === s2, "the view did not go to Sheet2");
      const ids3 = await eventually(() => allPivotIds(page), (a) => a.length === before3.length + 1, "no pivot was created at sheet2!$F$1");
      const pid3 = ids3.find((id) => !before3.includes(id))!;
      const regions = await eventually(() => pivotRegions(page), (r) => r.some((x) => String(x.pivotId) === pid3), "the pivot has no region on Sheet2");
      const reg = regions.find((x) => String(x.pivotId) === pid3)!;
      expect({ row: reg.startRow, col: reg.startCol }, "the pivot is anchored at F1 of Sheet2").toEqual({ row: 0, col: 5 });
      expect(await displayGrid(page, 0, 0, 5, 3, 7), "nothing landed on Sheet1 at F1").toEqual([["", "", ""], ["", "", ""], ["", "", ""], ["", "", ""]]);

      // --- An existing destination on a sheet that does not exist: refused, named.
      await activateSheet(page, 0);
      await grid.clickCell("A2");
      const count4 = (await sheets(page)).sheets.length;
      const before4 = await allPivotIds(page);
      await openCreatePivotDialog(page);
      await createDialog(page).locator('[data-testid="pivot-worksheet-source-range"]').fill("Sheet1!A1:D5");
      await createDialog(page).locator('input[type="radio"][value="existing"]').check();
      await createDialog(page).locator('input[placeholder="e.g., Sheet2!F1"]').fill("Nope!F1");
      await createDialog(page).getByRole("button", { name: /^OK$/ }).click();
      await page.waitForTimeout(1200);
      await expect(createDialog(page)).toBeVisible();
      expect(await dialogError(createDialog(page))).toContain('There is no sheet named "Nope".');
      expect(await allPivotIds(page), "no pivot was created for Nope!F1").toEqual(before4);
      expect((await sheets(page)).sheets.length).toBe(count4);
      expect(await displayGrid(page, 0, 0, 5, 3, 7), "nothing landed on the active Sheet1 at F1").toEqual([["", "", ""], ["", "", ""], ["", "", ""], ["", "", ""]]);
      await createDialog(page).getByRole("button", { name: /^Cancel$/ }).click();
    } finally {
      await newFile(page);
    }
  });

  test("X3: with a floating-grid cell selected, Insert > PivotTable opens with an EMPTY source; with a normal cell selected it prefills the data region", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await writeTable(page, DS1);
      // A floating grid on the worksheet, clear of the data.
      await callModule<{ id: string }>(page, "/src/api/floatingRanges.ts", "createFloatingRange", [420, 60, "FloatX3"]);
      await page.waitForTimeout(800);

      // Control first: a data cell prefills the detected region.
      await grid.clickCell("A2");
      expect(await callModule<boolean>(page, "/src/api/selectionOwner.ts", "isSelectionOwned", []), "precondition: a sheet cell is not an owned selection").toBe(false);
      await openCreatePivotDialog(page);
      const prefilled = await createDialog(page).locator('[data-testid="pivot-worksheet-source-range"]').inputValue();
      expect(prefilled, "a normal cell prefills the data region").toMatch(/A\$?1:\$?C\$?5/);
      await createDialog(page).getByRole("button", { name: /^Cancel$/ }).click();

      // A floating-grid cell (its A1).
      const p = await sheetPointToPage(page, 420 + FLOAT_A1.dx, 60 + FLOAT_A1.dy);
      await page.mouse.click(p.x, p.y);
      await eventually(
        () => callModule<boolean>(page, "/src/api/selectionOwner.ts", "isSelectionOwned", []),
        (v) => v === true,
        "precondition: clicking the floating grid's A1 did not select its cell",
      );
      await openCreatePivotDialog(page);
      expect(await createDialog(page).locator('[data-testid="pivot-worksheet-source-range"]').inputValue(), "with a floating-grid cell selected the source starts EMPTY").toBe("");
      await createDialog(page).getByRole("button", { name: /^Cancel$/ }).click();
    } finally {
      await newFile(page);
    }
  });

  test("R3: Table Design > Summarize with PivotTable -- a retyped 'Sheet2!A1:D9' reads Sheet2 even after Refresh; leaving 'Table1' follows the table as it grows", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await seedTwoSources(page);
      const table = await callModule<{ id: string; name: string } | null>(page, "/extensions/Table/lib/tableStore.ts", "createTableAsync", [
        { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 4, endCol: 3, hasHeaders: true },
      ]);
      expect(table?.name, "precondition: a table was created on Sheet1").toBeTruthy();
      const summarize = async () => {
        await activateSheet(page, 0);
        await grid.clickCell("B2");
        await page.waitForTimeout(600);
        await openRibbonTab(page, "Table Design");
        await clickRibbonTestId(page, "table-design-summarize-pivot");
        await expect(createDialog(page)).toBeVisible({ timeout: 10_000 });
        await page.waitForTimeout(500);
      };

      // --- Retyped: the pivot reads Sheet2 and stays there after Refresh.
      await summarize();
      expect(await createDialog(page).locator('[data-testid="pivot-worksheet-source-range"]').inputValue(), "precondition: the dialog names the table").toBe(table!.name);
      const before = await allPivotIds(page);
      await createDialog(page).locator('[data-testid="pivot-worksheet-source-range"]').fill("Sheet2!A1:D9");
      await createDialog(page).getByRole("button", { name: /^OK$/ }).click();
      await expect(createDialog(page)).toHaveCount(0, { timeout: 10_000 });
      const pid = (await eventually(() => allPivotIds(page), (a) => a.length === before.length + 1, "no pivot")).find((id) => !before.includes(id))!;
      expect((await regionLabels(page, pid)).every((l) => l.startsWith("S2-")), "the retyped source reads Sheet2").toBe(true);
      await callModule(page, MOD.PIVOT_API, "refreshPivotCache", [pid]);
      const afterRefresh = await rowOrder(page, pid);
      expect(afterRefresh.length).toBeGreaterThan(0);
      expect(afterRefresh.every((l) => l.startsWith("S2-")), `after Refresh the pivot still reads Sheet2 (not the table): ${JSON.stringify(afterRefresh)}`).toBe(true);

      // --- Left as the table: the pivot follows the table as it grows.
      await summarize();
      const before2 = await allPivotIds(page);
      await createDialog(page).getByRole("button", { name: /^OK$/ }).click();
      await expect(createDialog(page)).toHaveCount(0, { timeout: 10_000 });
      const pid2 = (await eventually(() => allPivotIds(page), (a) => a.length === before2.length + 1, "no pivot")).find((id) => !before2.includes(id))!;
      const first = await regionLabels(page, pid2);
      expect(first.every((l) => l.startsWith("S1-")), `the table pivot reads the table: ${JSON.stringify(first)}`).toBe(true);
      expect(first).not.toContain("S1-Grow");
      // Grow the table by one row (a new region) through Resize Table, then Refresh.
      await activateSheet(page, 0);
      await writeCells(page, [[5, 0, "S1-Grow"], [5, 1, "Apples"], [5, 2, "Web"], [5, 3, "9"]]);
      const resized = await invoke<{ success: boolean; error?: string }>(page, "resize_table", {
        params: { tableId: table!.id, startRow: 0, startCol: 0, endRow: 5, endCol: 3 },
      });
      expect(resized.success, `precondition: Resize Table grew the table (${resized.error ?? ""})`).toBe(true);
      await callModule(page, MOD.PIVOT_API, "refreshPivotCache", [pid2]);
      const grown = await rowOrder(page, pid2);
      expect(grown, "the table pivot follows the table's new row after Refresh").toContain("S1-Grow");
      // ... and the retyped pivot still does not.
      await callModule(page, MOD.PIVOT_API, "refreshPivotCache", [pid]);
      expect((await rowOrder(page, pid)).some((l) => l.startsWith("S1-")), "the retyped pivot never reads the table").toBe(false);
    } finally {
      await newFile(page);
    }
  });
});

// ===========================================================================
// C. Change Data Source (wd-pivot fix-up 8, we-pivot Y5/Y6, wf-pivot Z1)
// ===========================================================================

/** Sheet1!A1:C10: rows 2-5 total 15, rows 6-10 total 496 (one new region, "Extra"), all 511. */
const CDS_DATA: Array<Array<string | number | null>> = [
  ["Region", "Product", "Sales"],
  ["North", "Apples", 1],
  ["South", "Pears", 2],
  ["East", "Apples", 4],
  ["West", "Pears", 8],
  ["North", "Pears", 16],
  ["South", "Apples", 32],
  ["East", "Pears", 64],
  ["West", "Apples", 128],
  ["Extra", "Apples", 256],
];

async function grandTotal(page: Page, pid: string): Promise<string> {
  return (await rowMap(page, pid))["Grand Total"] ?? "";
}

async function saveClean(page: Page, file: string): Promise<void> {
  await invoke(page, "save_file", { path: file });
  await eventually(() => isDirty(page), (d) => d === false, "precondition: the saved document is clean");
}

async function renameSheet(page: Page, index: number, newName: string): Promise<void> {
  await invoke(page, "rename_sheet", { index, newName });
  await page.evaluate(() => window.dispatchEvent(new Event("sheets:refresh")));
  await page.waitForTimeout(300);
}

test.describe("C. Change Data Source", () => {
  test("CDS/Y6: on Sheet2, 'Sheet1!A1:C5' reads Sheet1 rows 2-5 and Refresh keeps it; bare 'A1:C5' still reads Sheet1; 'Nope!A1:C5' is refused and a clean document stays clean", async ({
    appPage: page,
    grid,
  }) => {
    const file = path.join(TMP, `fixall-pivot-cds-${Date.now()}.cala`);
    try {
      await newFile(page);
      await writeTable(page, CDS_DATA);
      const s2 = await addWorksheet(page);
      const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:C10", destinationCell: "A1", sourceSheet: 0, destinationSheet: s2.index });
      await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [SUM_SALES] });
      expect(await grandTotal(page, pid), "precondition: the whole range").toBe("511");

      await openChangeDataSource(page, grid, "B2");
      expect(await cdsInput(page).inputValue(), "the box shows the current source").toMatch(/A\$?1:\$?C\$?10/);
      await cdsApply(page, "Sheet1!A1:C5");
      await expect(cdsDialog(page), "OK on Sheet1!A1:C5 did not apply").toHaveCount(0, { timeout: 10_000 });
      await eventually(() => grandTotal(page, pid), (v) => v === "15", "the pivot does not summarise Sheet1 rows 2-5");
      expect((await pivotInfo(page, pid)).sourceRange).toMatch(/A\$?1:\$?C\$?5/);

      // Refresh (ribbon) keeps it.
      await grid.clickCell("B2");
      await openRibbonTab(page, "Pivot Table");
      await clickRibbonTestId(page, "pivot-analyze-refresh");
      await page.waitForTimeout(800);
      expect(await grandTotal(page, pid), "Refresh reads the same Sheet1 rows").toBe("15");

      // A bare range is the pivot's SOURCE sheet, never its own sheet (A1:C5 of Sheet2 is the pivot itself).
      await openChangeDataSource(page, grid, "B2");
      await cdsApply(page, "A1:C5");
      await expect(cdsDialog(page), "OK on A1:C5 did not apply").toHaveCount(0, { timeout: 10_000 });
      expect(await grandTotal(page, pid), "bare A1:C5 still reads Sheet1").toBe("15");
      const labels = await rowOrder(page, pid);
      expect(labels, "the pivot's rows are Sheet1's regions, not its own cells").toEqual(["East", "North", "South", "West"]);

      // Unknown sheet: refused in the dialog, the document stays clean, nothing changes.
      await saveClean(page, file);
      await openChangeDataSource(page, grid, "B2");
      await cdsApply(page, "Nope!A1:C5");
      await page.waitForTimeout(1200);
      await expect(cdsDialog(page), "the dialog stays open on an unknown sheet").toBeVisible();
      expect(await dialogError(cdsDialog(page)), "the refusal names the missing sheet").toMatch(/no sheet named ['"]?Nope/i);
      expect(await isDirty(page), "a refused change leaves a clean document clean").toBe(false);
      await cdsDialog(page).getByRole("button", { name: /^Cancel$/ }).click();
      expect(await grandTotal(page, pid)).toBe("15");
    } finally {
      await newFile(page);
      fs.rmSync(file, { force: true });
    }
  });

  test("CDS overwrite: a larger source that grows the pivot over user cells asks 'overwrite existing data?'; Cancel puts the cells and the source back", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await writeTable(page, CDS_DATA);
      const s2 = await addWorksheet(page);
      const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:C5", destinationCell: "A1", sourceSheet: 0, destinationSheet: s2.index });
      await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [SUM_SALES] });
      // The pivot fills A1:B6 (header, 4 regions, total); the user's cell sits right below it.
      await writeCells(page, [[6, 0, "keep me"]]);
      expect((await cellAt(page, s2.index, 6, 0))?.display).toBe("keep me");

      await openChangeDataSource(page, grid, "B2");
      await cdsApply(page, "Sheet1!A1:C10");
      const v = answerDialog("Cancel");
      expect(v.notFound, `no overwrite question appeared (driver: ${v.raw})`).toBe(false);
      expect(v.text, `the question: ${v.raw}`).toMatch(/overwrite existing data/i);
      expect(v.outcome, `the answer was delivered: ${v.raw}`).toBe("GONE");

      await eventually(() => cellAt(page, s2.index, 6, 0).then((c) => c?.display ?? ""), (d) => d === "keep me", "Cancel did not put the user's cell back");
      await eventually(() => grandTotal(page, pid), (g) => g === "15", "Cancel did not put the old source back");
      expect((await pivotInfo(page, pid)).sourceRange, "the stored source is the old one").toMatch(/A\$?1:\$?C\$?5/);

      // Control: OK keeps the larger source (the question gates a real overwrite).
      if (await cdsDialog(page).count()) await cdsDialog(page).getByRole("button", { name: /^Cancel$/ }).click();
      await openChangeDataSource(page, grid, "B2");
      await cdsApply(page, "Sheet1!A1:C10");
      const ok = answerDialog("OK");
      expect(ok.notFound, `the question appeared again: ${ok.raw}`).toBe(false);
      await eventually(() => grandTotal(page, pid), (g) => g === "511", "OK did not keep the larger source");
    } finally {
      await newFile(page);
    }
  });

  test("Y5 (ranges): a pivot sourced from 'Sales Data'!A1:C10 or 2024!A1:C10 gets an EDITABLE box and OK applies", async ({ appPage: page, grid }) => {
    try {
      await newFile(page);
      await writeTable(page, CDS_DATA);
      const s2 = await addWorksheet(page);
      await writeTable(page, CDS_DATA);
      await renameSheet(page, 0, "Sales Data");
      await renameSheet(page, s2.index, "2024");
      const s3 = await addWorksheet(page);
      for (const [name, idx] of [["'Sales Data'", 0], ["'2024'", s2.index]] as Array<[string, number]>) {
        const pid = await createRangePivot(page, { sourceRange: `${name}!A1:C10`, destinationCell: idx === 0 ? "A1" : "E1", sourceSheet: idx, destinationSheet: s3.index });
        await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [SUM_SALES] });
        expect(await grandTotal(page, pid)).toBe("511");
        await openChangeDataSource(page, grid, idx === 0 ? "B2" : "F2");
        await expect(cdsDialog(page).getByText(/connected to a BI model/i), `${name}: the BI note must not show for a range pivot`).toHaveCount(0);
        await expect(cdsInput(page), `${name}: the box is an editable input`).toBeEditable();
        const typed = name === "'2024'" ? "2024!A1:C5" : "'Sales Data'!A1:C5";
        await cdsApply(page, typed);
        await expect(cdsDialog(page), `${name}: OK applied (the dialog closed)`).toHaveCount(0, { timeout: 10_000 });
        await eventually(() => grandTotal(page, pid), (g) => g === "15", `${name}: the pivot does not read ${typed}`);
      }
    } finally {
      await newFile(page);
    }
  });

  test("Z1: a source covering the pivot's OWN output is refused (E1:F4 named), a clean document stays clean; a range beside it applies; the same range for a pivot on Sheet2 applies", async ({
    appPage: page,
    grid,
  }) => {
    const file = path.join(TMP, `fixall-pivot-z1-${Date.now()}.cala`);
    try {
      await newFile(page);
      await writeTable(page, [
        ["Region", "Product", "Sales"],
        ["North", "Apples", 10],
        ["South", "Pears", 20],
        ["East", "Apples", 7],
      ]);
      const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:C4", destinationCell: "E1", sourceSheet: 0, destinationSheet: 0 });
      await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [SUM_SALES] });
      expect(await grandTotal(page, pid)).toBe("37");
      await saveClean(page, file);
      const pivotCells = await displayGrid(page, 0, 0, 4, 5, 5);

      for (const bad of ["Sheet1!A1:H20", "Sheet1!A2:F10", "Sheet1!A:H"]) {
        await openChangeDataSource(page, grid, "F2");
        await cdsApply(page, bad);
        await page.waitForTimeout(1200);
        await expect(cdsDialog(page), `${bad}: the dialog stays open`).toBeVisible();
        const err = await dialogError(cdsDialog(page));
        expect(err, `${bad}: the refusal says it covers the pivot's own output`).toMatch(/own output/i);
        expect(err, `${bad}: the refusal names the output range`).toMatch(/E1:F\d/);
        expect(await isDirty(page), `${bad}: no unsaved-changes mark`).toBe(false);
        await cdsDialog(page).getByRole("button", { name: /^Cancel$/ }).click();
        expect((await pivotInfo(page, pid)).sourceRange, `${bad}: the source is unchanged`).toMatch(/A\$?1:\$?C\$?4/);
        expect(await displayGrid(page, 0, 0, 4, 5, 5), `${bad}: the pivot's cells are unchanged`).toEqual(pivotCells);
      }

      // Control: A1:D4 (beside the output) applies.
      await openChangeDataSource(page, grid, "F2");
      await cdsApply(page, "Sheet1!A1:D4");
      await expect(cdsDialog(page), "Sheet1!A1:D4 applies").toHaveCount(0, { timeout: 10_000 });
      expect((await pivotInfo(page, pid)).sourceRange).toMatch(/A\$?1:\$?D\$?4/);

      // A pivot on Sheet2: the same big range is not its output, so it applies.
      const s2 = await addWorksheet(page);
      const p2 = await createRangePivot(page, { sourceRange: "Sheet1!A1:C4", destinationCell: "A1", sourceSheet: 0, destinationSheet: s2.index });
      await configurePivot(page, { pivotId: p2, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [SUM_SALES] });
      await openChangeDataSource(page, grid, "B2");
      await cdsApply(page, "Sheet1!A1:H20");
      await expect(cdsDialog(page), "on a Sheet2 pivot, Sheet1!A1:H20 applies").toHaveCount(0, { timeout: 10_000 });
      expect((await pivotInfo(page, p2)).sourceRange).toMatch(/A\$?1:\$?H\$?20/);
    } finally {
      await newFile(page);
      fs.rmSync(file, { force: true });
    }
  });

  test("Y5 (tables): a Table1 pivot's box shows 'Table1' and OK applies; a resize is read; a typed range unlinks it (Refresh stays on the range); a range pivot typed 'table1' links it; Ctrl+Z puts the previous source back", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await writeTable(page, [
        ["Region", "Product", "Sales"],
        ["T1-North", "Apples", 1],
        ["T1-South", "Pears", 2],
        ["T1-East", "Apples", 4],
      ]);
      const table = await callModule<{ id: string; name: string } | null>(page, "/extensions/Table/lib/tableStore.ts", "createTableAsync", [
        { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 3, endCol: 2, hasHeaders: true },
      ]);
      expect(table?.name, "precondition: Table1").toBeTruthy();
      const s2 = await addWorksheet(page);
      await writeTable(page, [
        ["Region", "Product", "Sales"],
        ["T2-Alpha", "Apples", 10],
        ["T2-Beta", "Pears", 20],
        ["T2-Gamma", "Apples", 40],
      ]);
      const s3 = await addWorksheet(page);
      // Linked, as the Summarize/Insert-from-table door creates it.
      const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:C4", destinationCell: "A1", sourceSheet: 0, destinationSheet: s3.index, sourceTableName: table!.name });
      await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [SUM_SALES] });
      expect(await rowOrder(page, pid)).toEqual(["T1-East", "T1-North", "T1-South"]);

      // OK on the pre-filled "Table1" applies with no error.
      await openChangeDataSource(page, grid, "B2");
      expect(await cdsInput(page).inputValue(), "the box shows the table's name").toBe(table!.name);
      await expect(cdsInput(page)).toBeEditable();
      await cdsApply(page, null);
      await expect(cdsDialog(page), "OK on 'Table1' was refused").toHaveCount(0, { timeout: 10_000 });

      // Resize Table1, OK on "Table1" again: the new extent is read.
      await activateSheet(page, 0);
      await writeCells(page, [[4, 0, "T1-Grow"], [4, 1, "Apples"], [4, 2, "8"]]);
      const r1 = await invoke<{ success: boolean }>(page, "resize_table", { params: { tableId: table!.id, startRow: 0, startCol: 0, endRow: 4, endCol: 2 } });
      expect(r1.success, "precondition: resized").toBe(true);
      await activateSheet(page, s3.index);
      await openChangeDataSource(page, grid, "B2");
      await cdsApply(page, null);
      await expect(cdsDialog(page)).toHaveCount(0, { timeout: 10_000 });
      await eventually(() => rowOrder(page, pid), (r) => r.includes("T1-Grow"), "OK on 'Table1' did not read the resized table");

      // A typed range unlinks it; the box then shows the range; a resize/Refresh stays on the range.
      await openChangeDataSource(page, grid, "B2");
      await cdsApply(page, `${s2.name}!A1:C4`);
      await expect(cdsDialog(page)).toHaveCount(0, { timeout: 10_000 });
      await eventually(() => rowOrder(page, pid), (r) => r.length > 0 && r.every((l) => l.startsWith("T2-")), "the typed range is not read");
      await openChangeDataSource(page, grid, "B2");
      expect(await cdsInput(page).inputValue(), "the box now shows the typed range").toMatch(new RegExp(`^${escapeRe(s2.name)}!\\$?A\\$?1:\\$?C\\$?4$`));
      await cdsDialog(page).getByRole("button", { name: /^Cancel$/ }).click();

      // Ctrl+Z right after the change puts the previous source back, INCLUDING the link.
      await pressUndo(page);
      await eventually(() => pivotInfo(page, pid).then((i) => i.sourceTableName ?? null), (n) => n === table!.name, "Ctrl+Z did not restore the table link");
      await eventually(() => rowOrder(page, pid), (r) => r.includes("T1-Grow"), "after Ctrl+Z the pivot does not read the table again");
      await pressRedo(page);
      await eventually(() => pivotInfo(page, pid).then((i) => i.sourceTableName ?? null), (n) => n === null, "Ctrl+Y did not unlink again");

      // Unlinked: the table grows (Resize Table) and a Refresh still reads the typed range.
      await activateSheet(page, 0);
      await writeCells(page, [[5, 0, "T1-More"], [5, 1, "Pears"], [5, 2, "16"]]);
      await invoke(page, "resize_table", { params: { tableId: table!.id, startRow: 0, startCol: 0, endRow: 5, endCol: 2 } });
      await activateSheet(page, s3.index);
      await callModule(page, MOD.PIVOT_API, "refreshPivotCache", [pid]);
      expect((await rowOrder(page, pid)).every((l) => l.startsWith("T2-")), "after the table grew and a Refresh, the unlinked pivot still reads the range").toBe(true);

      // A RANGE pivot typed 'table1' is linked to the table (any case) and follows it.
      const p2 = await createRangePivot(page, { sourceRange: `${s2.name}!A1:C4`, destinationCell: "E1", sourceSheet: s2.index, destinationSheet: s3.index });
      await configurePivot(page, { pivotId: p2, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [SUM_SALES] });
      await openChangeDataSource(page, grid, "F2");
      await cdsApply(page, "table1");
      await expect(cdsDialog(page), "'table1' was refused").toHaveCount(0, { timeout: 10_000 });
      await eventually(() => rowOrder(page, p2), (r) => r.includes("T1-More") && r.every((l) => l.startsWith("T1-")), "'table1' did not read the table");
      await openChangeDataSource(page, grid, "F2");
      expect(await cdsInput(page).inputValue(), "the box shows the table's own name").toBe(table!.name);
      await cdsDialog(page).getByRole("button", { name: /^Cancel$/ }).click();
      expect((await pivotInfo(page, p2)).sourceTableName, "the range pivot is now linked").toBe(table!.name);
      // Ctrl+Z: back to the range, unlinked.
      await pressUndo(page);
      await eventually(() => pivotInfo(page, p2).then((i) => i.sourceTableName ?? null), (n) => n === null, "Ctrl+Z did not unlink the range pivot");
      await eventually(() => rowOrder(page, p2), (r) => r.every((l) => l.startsWith("T2-")), "Ctrl+Z did not put the range back");
    } finally {
      await newFile(page);
    }
  });

  test("BUG-0226: a source just BELOW the pivot is refused by both doors -- Change Data Source (the re-grown output would cover it) and Insert > PivotTable (the new pivot's block would cover it); the source is intact, nothing is created, a clean document stays clean", async ({
    appPage: page,
    grid,
  }) => {
    const file = path.join(TMP, `fixall-pivot-0226-${Date.now()}.cala`);
    // Seven regions: a Region-on-rows pivot over them is NINE rows (header, 7 items, total).
    const seven = (top: number, left: number): Array<[number, number, string]> => {
      const rows: string[][] = [["Region", "Product", "Sales"], ...[1, 2, 3, 4, 5, 6, 7].map((i) => [`R${i}`, "Apples", String(i)])];
      return rows.flatMap((r, dr) => r.map((v, dc) => [top + dr, left + dc, v] as [number, number, string]));
    };
    try {
      await newFile(page);
      await writeTable(page, CDS_DATA);
      // A pivot at E1 over Sheet1!A1:C5 (four regions): E1:F6.
      const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:C5", destinationCell: "E1", sourceSheet: 0, destinationSheet: 0 });
      await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [SUM_SALES] });
      expect(await grandTotal(page, pid), "precondition: the four regions").toBe("15");
      const own = (await pivotRegions(page)).find((r) => String(r.pivotId) === pid)!;
      expect({ r0: own.startRow, c0: own.startCol, r1: own.endRow, c1: own.endCol }, "precondition: the pivot holds E1:F6").toEqual({ r0: 0, c0: 4, r1: 5, c1: 5 });
      // Seven regions at E8:G15, clear of E1:F6 -- but inside the E1:F9 the pivot would grow to.
      await writeCells(page, seven(7, 4));
      // Seven regions at I6:K13, for the create door (an empty pivot at I1 reserves I1:K18).
      await writeCells(page, seven(5, 8));
      const cdsBlock = await displayGrid(page, 0, 7, 4, 14, 6);
      const createBlock = await displayGrid(page, 0, 5, 8, 12, 10);
      expect(cdsBlock[0], "precondition: the E8 block").toEqual(["Region", "Product", "Sales"]);
      await saveClean(page, file);

      // --- Change Data Source to E8:G15: refused in the dialog, naming the pivot's own output.
      await openChangeDataSource(page, grid, "E2");
      await cdsApply(page, "Sheet1!E8:G15");
      await page.waitForTimeout(1200);
      await expect(cdsDialog(page), "the dialog stays open on a range the re-grown pivot would cover").toBeVisible();
      expect(await dialogError(cdsDialog(page)), "the refusal says the pivot's own output would cover the range").toMatch(/own output would\s+grow to E1:F9/i);
      await cdsDialog(page).getByRole("button", { name: /^Cancel$/ }).click();
      expect(await grandTotal(page, pid), "the pivot still reads its old source").toBe("15");
      expect((await pivotInfo(page, pid)).sourceRange, "the stored source did not move").toMatch(/A\$?1:\$?C\$?5/);
      expect(await displayGrid(page, 0, 7, 4, 14, 6), "the E8:G15 source is intact").toEqual(cdsBlock);
      expect(await isDirty(page), "a refused change leaves a clean document clean").toBe(false);

      // --- Insert > PivotTable over I6:K13 at I1: the empty pivot's I1:K18 would cover it -- refused.
      const before = await allPivotIds(page);
      await grid.clickCell("M20");
      await openCreatePivotDialog(page);
      await createDialog(page).locator('[data-testid="pivot-worksheet-source-range"]').fill("Sheet1!I6:K13");
      await createDialog(page).locator('input[type="radio"][value="existing"]').check();
      await createDialog(page).locator('input[placeholder="e.g., Sheet2!F1"]').fill("Sheet1!I1");
      await createDialog(page).getByRole("button", { name: /^OK$/ }).click();
      await page.waitForTimeout(1200);
      await expect(createDialog(page), "the dialog stays open on a destination whose pivot would cover its source").toBeVisible();
      expect(await dialogError(createDialog(page)), "the refusal says the pivot would cover its own source").toMatch(/covers its own\s+source data \(I6:K13\)/i);
      await createDialog(page).getByRole("button", { name: /^Cancel$/ }).click();
      expect(await allPivotIds(page), "no pivot was created").toEqual(before);
      expect((await pivotRegions(page)).some((r) => r.startRow === 0 && r.startCol === 8), "no pivot region at I1").toBe(false);
      expect(await displayGrid(page, 0, 5, 8, 12, 10), "the I6:K13 source is intact").toEqual(createBlock);
      expect(await isDirty(page), "a refused create leaves a clean document clean").toBe(false);

      // --- Positive control: the same create one row clear of the placeholder (I1 over I19:K26) is made.
      await writeCells(page, seven(18, 8));
      await openCreatePivotDialog(page);
      await createDialog(page).locator('[data-testid="pivot-worksheet-source-range"]').fill("Sheet1!I19:K26");
      await createDialog(page).locator('input[type="radio"][value="existing"]').check();
      await createDialog(page).locator('input[placeholder="e.g., Sheet2!F1"]').fill("Sheet1!I1");
      await createDialog(page).getByRole("button", { name: /^OK$/ }).click();
      await expect(createDialog(page), "a create clear of its source is made").toHaveCount(0, { timeout: 10_000 });
      await eventually(() => allPivotIds(page), (a) => a.length === before.length + 1, "the control create made no pivot");
    } finally {
      await newFile(page);
      fs.rmSync(file, { force: true });
    }
  });

  test("placeholder (beside BUG-0226): an empty pivot over the user's cells writes none of them -- Ctrl+Z of its create keeps them, and its first field change leaves every one its output does not cover", async ({
    appPage: page,
  }) => {
    try {
      await newFile(page);
      await writeTable(page, CDS_DATA);
      // The user's cells inside the 18 x 3 placeholder an empty pivot at E1 reserves (E1:G18), below
      // the E1:F6 its first output (four regions) will take.
      await writeCells(page, [[9, 4, "keep E10"], [12, 6, "keep G13"], [17, 5, "keep F18"]]);
      const mine = await displayGrid(page, 0, 0, 4, 17, 6);
      expect(mine[9][0], "precondition: E10").toBe("keep E10");

      // Empty create, then Ctrl+Z: the user's cells are untouched.
      const p1 = await createRangePivot(page, { sourceRange: "Sheet1!A1:C5", destinationCell: "E1", sourceSheet: 0, destinationSheet: 0 });
      const reg1 = await eventually(() => pivotRegions(page), (r) => r.some((x) => String(x.pivotId) === p1), "the empty pivot registered no placeholder");
      const ph = reg1.find((x) => String(x.pivotId) === p1)!;
      expect({ r1: ph.endRow, c1: ph.endCol }, "precondition: the placeholder reaches G18").toEqual({ r1: 17, c1: 6 });
      await pressUndo(page);
      await eventually(() => allPivotIds(page), (a) => !a.includes(p1), "Ctrl+Z did not undo the empty create");
      expect(await displayGrid(page, 0, 0, 4, 17, 6), "undoing the empty create erased the user's cells under its placeholder").toEqual(mine);

      // Empty create again, then its first field change: E1:F6 is written, the three cells stay.
      const p2 = await createRangePivot(page, { sourceRange: "Sheet1!A1:C5", destinationCell: "E1", sourceSheet: 0, destinationSheet: 0 });
      await configurePivot(page, { pivotId: p2, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [SUM_SALES] });
      expect(await grandTotal(page, p2), "the pivot summarises the four regions").toBe("15");
      const after = await displayGrid(page, 0, 0, 4, 17, 6);
      expect([after[9][0], after[12][2], after[17][1]], "the first field change erased the user's cells under the placeholder").toEqual(["keep E10", "keep G13", "keep F18"]);
    } finally {
      await newFile(page);
    }
  });
});

// ===========================================================================
// D. The field pane, the header dropdown, delete/undo merges, filter pages,
//    slicer labels (wa-pivot P3/P5/P6/P7, wb-slicer A2, wd-pivot X1/X2)
// ===========================================================================

function valueSettingsModal(page: Page) {
  return page.locator("h2", { hasText: /^Value Field Settings$/ }).locator("xpath=../..");
}

function modalSelect(page: Page, label: string) {
  return valueSettingsModal(page).locator("label", { hasText: new RegExp(`^${escapeRe(label)}$`) }).locator("xpath=following-sibling::select");
}

/** The header filter dropdown's root (the fixed-position box holding "(Select All)"). */
function headerDropdown(page: Page) {
  return page.locator("label", { hasText: "(Select All)" }).locator('xpath=ancestor::div[contains(@style,"position: fixed")][1]');
}

async function openHeaderDropdown(page: Page, pivotId: string): Promise<void> {
  // What the "Row Labels" header button emits (its only job is to emit this).
  await callModule(page, MOD.EVENTS, "emitAppEvent", ["app:pivot-open-header-filter-menu", { pivotId, zone: "row", anchorX: 360, anchorY: 220 }]);
  await expect(headerDropdown(page), "the header dropdown did not open").toBeVisible({ timeout: 10_000 });
  // Values load asynchronously ("Loading...").
  await eventually(
    () => headerDropdown(page).evaluate((el) => (el.textContent ?? "").includes("Loading...")),
    (loading) => !loading,
    "the header dropdown never finished loading",
  );
}

async function headerDropdownItems(page: Page): Promise<Array<{ text: string; checked: boolean }>> {
  return headerDropdown(page).evaluate((root) =>
    Array.from(root.querySelectorAll("label"))
      .map((l) => ({ text: (l.textContent ?? "").trim(), checked: !!(l.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.checked }))
      .filter((x) => x.text !== "(Select All)"),
  );
}

async function subtotalRowsAtDepth(page: Page, pid: string, depth: number): Promise<number> {
  const v = await pivotView(page, pid);
  return v.rows.filter((r) => r.rowType === "Subtotal" && (r.depth ?? 0) === depth).length;
}

async function mergesIn(page: Page, r0: number, c0: number, r1: number, c1: number): Promise<number> {
  const merged = await invoke<Array<{ startRow: number; startCol: number; endRow: number; endCol: number }>>(page, "get_merged_regions");
  return merged.filter((m) => m.startRow >= r0 && m.endRow <= r1 && m.startCol >= c0 && m.endCol <= c1).length;
}

test.describe("D. field pane, header dropdown, merges, filter pages, slicer labels", () => {
  test("X1 (Show Values As through the Value Field Settings dialog): Running Total In > Region reads 35/45/65; Difference From > Region > (previous) reads -25/10", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await writeTable(page, DS_X1);
      const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:C5", destinationCell: "E1", sourceSheet: 0, destinationSheet: 0 });
      await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [SUM_SALES] });
      await grid.clickCell("F2");
      await page.waitForTimeout(1000);

      // Running Total In > Region.
      await pillMenu(page, "Sum of Sales", "Value Field Settings...");
      await expect(valueSettingsModal(page)).toBeVisible({ timeout: 10_000 });
      await modalSelect(page, "Show Values As").selectOption("running_total");
      const offered = { baseField: (await modalSelect(page, "Base field").count()) > 0 };
      if (offered.baseField) await modalSelect(page, "Base field").selectOption("Region");
      await valueSettingsModal(page).getByRole("button", { name: /^OK$/ }).click();
      await expect(valueSettingsModal(page)).toHaveCount(0);
      const rt = await eventually(() => rowMap(page, pid), (m) => m.North !== "10", "the dialog's Running Total In changed nothing", 10_000).catch(async () => rowMap(page, pid));
      expect.soft(offered.baseField, "the dialog offers a Base field for Running Total In").toBe(true);
      expect.soft([rt["(blank)"], rt.North, rt.South], `Running Total In Region through the dialog (base field offered: ${offered.baseField}; got ${JSON.stringify(rt)})`).toEqual(["35", "45", "65"]);

      // Difference From > Region > (previous).
      await pillMenu(page, "Sum of Sales", "Value Field Settings...");
      await expect(valueSettingsModal(page)).toBeVisible({ timeout: 10_000 });
      await modalSelect(page, "Show Values As").selectOption("difference");
      const offered2 = { baseField: (await modalSelect(page, "Base field").count()) > 0, baseItem: (await modalSelect(page, "Base item").count()) > 0 };
      if (offered2.baseField) await modalSelect(page, "Base field").selectOption("Region");
      if (offered2.baseItem) await modalSelect(page, "Base item").selectOption("(previous)");
      await valueSettingsModal(page).getByRole("button", { name: /^OK$/ }).click();
      await page.waitForTimeout(1500);
      const df = await rowMap(page, pid);
      expect.soft(offered2, "the dialog offers a Base field and a Base item for Difference From").toEqual({ baseField: true, baseItem: true });
      expect([df.North, df.South], `Difference From (previous) through the dialog (offered: ${JSON.stringify(offered2)}; got ${JSON.stringify(df)})`).toEqual(["-25", "10"]);
    } finally {
      await newFile(page);
    }
  });

  test("P5: sorted Z-A, an item hidden and subtotals off on Region; Product moved to Columns in the field pane -- Region keeps its order, its filter and its subtotals setting", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await writeTable(page, [
        ["Region", "Channel", "Product", "Sales"],
        ["North", "Web", "Apples", 2],
        ["North", "Store", "Pears", 5],
        ["South", "Web", "Pears", 3],
        ["South", "Store", "Apples", 6],
        ["East", "Web", "Apples", 1],
        ["West", "Store", "Pears", 4],
        ["West", "Web", "Apples", 7],
      ]);
      const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:D8", destinationCell: "G1", sourceSheet: 0, destinationSheet: 0 });
      const value = [{ sourceIndex: 3, name: "Sum of Sales", aggregation: "sum" }];
      await configurePivot(page, {
        pivotId: pid,
        rowFields: [{ sourceIndex: 0, name: "Region" }, { sourceIndex: 1, name: "Channel" }, { sourceIndex: 2, name: "Product" }],
        valueFields: value,
        layout: { reportLayout: "tabular" },
      });
      expect(await subtotalRowsAtDepth(page, pid, 0), "control: Region subtotal rows exist by default").toBeGreaterThan(0);

      // The field pane is open on this pivot BEFORE Region is changed elsewhere.
      await grid.clickCell("H3");
      await page.locator('span[title="Product"]').first().waitFor({ state: "visible", timeout: 10_000 });

      // Header dropdown: Sort Z to A, then uncheck East; Field Settings: subtotals None.
      const regionIdx = ((await pivotView(page, pid)).rowFieldSummaries ?? []).find((f) => f.fieldName === "Region")!.fieldIndex;
      await pivotApi(page, "sortField", { pivotId: pid, fieldIndex: regionIdx, sortBy: "descending" });
      await pivotApi(page, "applyFilter", { pivotId: pid, fieldIndex: regionIdx, filters: { manualFilter: { selectedItems: ["North", "South", "West"] } } });
      await configurePivot(page, {
        pivotId: pid,
        rowFields: [{ sourceIndex: 0, name: "Region", showSubtotals: false }, { sourceIndex: 1, name: "Channel" }, { sourceIndex: 2, name: "Product" }],
      });
      const regionsOf = async () => {
        const v = await pivotView(page, pid);
        const t = viewText(v);
        const seen: string[] = [];
        v.rows.forEach((r, i) => {
          if (r.rowType === "Data" && t[i][0] && !seen.includes(t[i][0])) seen.push(t[i][0]);
        });
        return seen;
      };
      expect(await regionsOf(), "precondition: Z-A with East hidden").toEqual(["West", "South", "North"]);
      expect(await subtotalRowsAtDepth(page, pid, 0), "precondition: Region subtotals are off").toBe(0);

      // Product -> Columns, in the field pane.
      await pillMenu(page, "Product", "Move to Columns");
      await eventually(
        async () => viewText(await pivotView(page, pid)).some((r) => r.includes("Apples") && r.includes("Pears")),
        (v) => v,
        "Product did not move to the columns",
        10_000,
      );
      expect(await regionsOf(), "Region is still Z-A with East still hidden").toEqual(["West", "South", "North"]);
      expect(await subtotalRowsAtDepth(page, pid, 0), "Region's subtotals are still off").toBe(0);
    } finally {
      await newFile(page);
    }
  });

  test("X2/A2 (header dropdown): a column with =\"\" cells AND empty cells lists both, (blank) last and checked; unchecking only \"\" hides only the \"\" rows; reopened, (blank) is still checked; OK unchanged keeps the (blank) rows", async ({
    appPage: page,
  }) => {
    try {
      await newFile(page);
      await writeCells(page, [
        [0, 0, "Region"], [0, 1, "Sales"],
        [1, 0, "East"], [1, 1, "10"],
        [2, 0, "West"], [2, 1, "20"],
        /* A4 left EMPTY */ [3, 1, "30"],
        [4, 0, '=""'], [4, 1, "50"],
      ]);
      const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:B5", destinationCell: "E1", sourceSheet: 0, destinationSheet: 0 });
      await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [{ sourceIndex: 1, name: "Sum of Sales", aggregation: "sum" }] });
      expect((await rowMap(page, pid))["Grand Total"], "precondition: all four records").toBe("110");

      await openHeaderDropdown(page, pid);
      const items = await headerDropdownItems(page);
      const blankItem = items.find((i) => i.text === "(blank)");
      const emptyItem = items.find((i) => i.text !== "(blank)" && !["East", "West"].includes(i.text));
      expect(blankItem, `the dropdown lists (blank): ${JSON.stringify(items)}`).toBeTruthy();
      expect(emptyItem, `the dropdown lists the "" item separately: ${JSON.stringify(items)}`).toBeTruthy();
      expect(items[items.length - 1].text, "(blank) is listed last").toBe("(blank)");
      expect(items.every((i) => i.checked), "everything is checked while every row shows (A2)").toBe(true);

      // Uncheck only "" and press OK.
      await headerDropdown(page).locator("label").filter({ hasText: new RegExp(`^${escapeRe(emptyItem!.text)}$`) }).locator('input[type="checkbox"]').uncheck();
      await headerDropdown(page).getByRole("button", { name: /^OK$/ }).click();
      await expect(headerDropdown(page)).toHaveCount(0);
      await eventually(() => rowMap(page, pid).then((m) => m["Grand Total"]), (g) => g === "60", "unchecking only \"\" did not hide exactly the \"\" rows (60 = 10+20+30)");
      expect((await rowMap(page, pid))["(blank)"], "the (blank) rows still show").toBe("30");

      // Reopen: (blank) still checked, "" unchecked.
      await openHeaderDropdown(page, pid);
      const again = await headerDropdownItems(page);
      expect(again.find((i) => i.text === "(blank)")?.checked, `(blank) is still CHECKED: ${JSON.stringify(again)}`).toBe(true);
      expect(again.find((i) => i.text === emptyItem!.text)?.checked, `"" is unchecked: ${JSON.stringify(again)}`).toBe(false);
      // OK unchanged: the (blank) rows still show.
      await headerDropdown(page).getByRole("button", { name: /^OK$/ }).click();
      await page.waitForTimeout(800);
      const after = await rowMap(page, pid);
      expect(after["(blank)"], "OK unchanged keeps the (blank) rows").toBe("30");
      expect(after["Grand Total"]).toBe("60");
    } finally {
      await newFile(page);
    }
  });

  test("P3: a tabular pivot with 3 row fields and a report filter -- Delete, Ctrl+Z, Ctrl+Y leave no merged cells in its old block; undoing its creation leaves none either", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await writeTable(page, [
        ["Region", "Product", "Channel", "Year", "Sales"],
        ["North", "Apples", "Web", "2024", 1],
        ["North", "Pears", "Store", "2025", 2],
        ["South", "Apples", "Web", "2025", 3],
        ["South", "Pears", "Store", "2024", 4],
      ]);
      const s2 = await addWorksheet(page);
      const configure = async (pid: string) =>
        configurePivot(page, {
          pivotId: pid,
          rowFields: [{ sourceIndex: 0, name: "Region" }, { sourceIndex: 1, name: "Product" }, { sourceIndex: 2, name: "Channel" }],
          filterFields: [{ sourceIndex: 3, name: "Year" }],
          valueFields: [{ sourceIndex: 4, name: "Sum of Sales", aggregation: "sum" }],
          layout: { reportLayout: "tabular" },
        });
      const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:E5", destinationCell: "A1", sourceSheet: 0, destinationSheet: s2.index });
      await configure(pid);
      const reg = (await eventually(() => pivotRegions(page), (r) => r.some((x) => String(x.pivotId) === pid), "no region")).find((x) => String(x.pivotId) === pid)!;
      const block = [reg.startRow, reg.startCol, reg.endRow + 2, reg.endCol + 2] as const;
      const merges0 = await mergesIn(page, ...block);
      expect(merges0, "precondition: the pivot's output carries merged cells (the filter dropdown)").toBeGreaterThan(0);

      // Delete (Pivot Table > Delete).
      await grid.clickCell(rcToRef(reg.startRow + 3, reg.startCol));
      await openRibbonTab(page, "Pivot Table");
      await clickRibbonTestId(page, "pivot-analyze-delete");
      await eventually(() => pivotRegions(page), (r) => !r.some((x) => String(x.pivotId) === pid), "Delete left the pivot");
      expect(await mergesIn(page, ...block), "a plain Delete leaves no merges in the old block").toBe(0);

      // Ctrl+Z brings it back (with its merges); Ctrl+Y deletes it again, leaving none.
      await pressUndo(page);
      await eventually(() => pivotRegions(page), (r) => r.some((x) => String(x.pivotId) === pid), "Ctrl+Z did not bring the pivot back");
      expect(await mergesIn(page, ...block), "control: the restored pivot has its merges").toBeGreaterThan(0);
      await pressRedo(page);
      await eventually(() => pivotRegions(page), (r) => !r.some((x) => String(x.pivotId) === pid), "Ctrl+Y did not delete it again");
      expect(await mergesIn(page, ...block), "after Delete, Ctrl+Z, Ctrl+Y no merges are left in the old block").toBe(0);

      // Undo the creation of a fresh one: no merges left either.
      const p2 = await createRangePivot(page, { sourceRange: "Sheet1!A1:E5", destinationCell: "A1", sourceSheet: 0, destinationSheet: s2.index });
      await configure(p2);
      expect(await mergesIn(page, ...block), "control: the new pivot has merges").toBeGreaterThan(0);
      for (let i = 0; i < 4 && (await pivotRegions(page)).some((x) => String(x.pivotId) === p2); i++) {
        await pressUndo(page);
        await page.waitForTimeout(400);
      }
      expect((await pivotRegions(page)).some((x) => String(x.pivotId) === p2), "undo took the created pivot away").toBe(false);
      expect(await mergesIn(page, ...block), "undoing the creation leaves no merges").toBe(0);
    } finally {
      await newFile(page);
    }
  });

  test("P6: Show Report Filter Pages over 'a/b', 'a_b' and 'Sheet1' names the pages 'a_b', 'a_b (2)' and 'Sheet1 (2)'", async ({ appPage: page, grid }) => {
    try {
      await newFile(page);
      await writeTable(page, [["Cat", "Sales"], ["a/b", 1], ["a_b", 2], ["Sheet1", 3]]);
      const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:B4", destinationCell: "D1", sourceSheet: 0, destinationSheet: 0 });
      await configurePivot(page, { pivotId: pid, filterFields: [{ sourceIndex: 0, name: "Cat" }], valueFields: [{ sourceIndex: 1, name: "Sum of Sales", aggregation: "sum" }] });
      const before = (await sheets(page)).sheets.map((s) => s.name);
      const reg = (await pivotRegions(page)).find((x) => String(x.pivotId) === pid)!;
      await grid.clickCell(rcToRef(reg.endRow, reg.startCol));
      await openRibbonTab(page, "Pivot Table");
      await clickRibbonTestId(page, "pivot-analyze-filter-pages");
      const after = await eventually(() => sheets(page), (r) => r.sheets.length === before.length + 3, "three filter pages were not added", 15_000);
      const added = after.sheets.map((s) => s.name).filter((n) => !before.includes(n));
      expect([...added].sort(), "one page per value, colliding names suffixed").toEqual(["Sheet1 (2)", "a_b", "a_b (2)"].sort());
    } finally {
      await newFile(page);
    }
  });

  test("P7: Insert > Slicer lists the pivots on two sheets, each labelled with ITS OWN sheet", async ({ appPage: page }) => {
    try {
      await newFile(page);
      await writeTable(page, DS1);
      const s2 = await addWorksheet(page);
      const pa = await createRangePivot(page, { sourceRange: "Sheet1!A1:C5", destinationCell: "A1", sourceSheet: 0, destinationSheet: s2.index, name: "PivotOnTwo" });
      await configurePivot(page, { pivotId: pa, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [SUM_SALES] });
      const s3 = await addWorksheet(page);
      const pb = await createRangePivot(page, { sourceRange: "Sheet1!A1:C5", destinationCell: "A1", sourceSheet: 0, destinationSheet: s3.index, name: "PivotOnThree" });
      await configurePivot(page, { pivotId: pb, rowFields: [{ sourceIndex: 1, name: "Product" }], valueFields: [SUM_SALES] });

      await menuPath(page, "Insert", ["Slicer..."]);
      const dialog = page.locator("h2", { hasText: /^Insert Slicers$/ }).locator("xpath=../..");
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      const labels = await eventually(
        () => dialog.locator("select option").evaluateAll((opts) => opts.map((o) => (o.textContent ?? "").trim())),
        (l) => l.some((x) => x.startsWith("PivotOnTwo")) && l.some((x) => x.startsWith("PivotOnThree")),
        "the dialog does not list both pivots",
      );
      expect(labels.find((l) => l.startsWith("PivotOnTwo")), "the Sheet2 pivot is labelled Sheet2").toBe(`PivotOnTwo (PivotTable, ${s2.name})`);
      expect(labels.find((l) => l.startsWith("PivotOnThree")), "the Sheet3 pivot is labelled Sheet3").toBe(`PivotOnThree (PivotTable, ${s3.name})`);
      await dialog.getByRole("button", { name: /^Cancel$/ }).click().catch(() => page.keyboard.press("Escape"));
    } finally {
      await newFile(page);
    }
  });
});

// ===========================================================================
// E. Slicers on range pivots (wb-slicer S2/A1, we-pivot Y1, wd-pivot X2)
// ===========================================================================

interface SlicerRow {
  id: string;
  name: string;
  sheetIndex: number;
  selectedItems: string[] | null;
}

async function createPivotSlicer(page: Page, pid: string, field: string, sheetIndex: number, x = 460, y = 40): Promise<string> {
  const s = await callModule<SlicerRow | null>(page, MOD.SLICER_STORE, "createSlicerAsync", [
    {
      name: field,
      sheetIndex,
      x,
      y,
      width: 180,
      height: 220,
      sourceType: "pivot",
      cacheSourceId: pid,
      fieldName: field,
      connectedSources: [{ sourceType: "pivot", sourceId: pid }],
    },
  ]);
  expect(s, `precondition: a slicer on ${field} was created`).toBeTruthy();
  await callModule(page, MOD.SLICER_STORE, "refreshSlicerItems", [s!.id]);
  return s!.id;
}

async function slicerItems(page: Page, id: string): Promise<string[]> {
  await callModule(page, MOD.SLICER_STORE, "refreshSlicerItems", [id]);
  const items = await callModule<Array<{ value: string }> | undefined>(page, MOD.SLICER_STORE, "getCachedItems", [id]);
  return (items ?? []).map((i) => i.value);
}

async function slicerSelection(page: Page, id: string): Promise<string[] | null> {
  const s = await callModule<SlicerRow | undefined>(page, MOD.SLICER_STORE, "getSlicerById", [id]);
  return s?.selectedItems ?? null;
}

/** A script's selection (no question asked): what a script's setSelectedItems does. */
async function scriptSelect(page: Page, id: string, items: string[] | null): Promise<void> {
  await callModule(page, MOD.SLICER_STORE, "updateSlicerSelectionAsync", [id, items]);
  await page.waitForTimeout(300);
}

/** Region/Sales, pivot at D1, slicer on Region, narrowed to North by a script; the user's "V" in D4 (just below). */
async function setupSlicerOverwrite(page: Page): Promise<{ pid: string; sid: string }> {
  await writeTable(page, [["Region", "Sales"], ["North", 1], ["South", 2], ["East", 4], ["West", 8]]);
  const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:B5", destinationCell: "D1", sourceSheet: 0, destinationSheet: 0 });
  await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [{ sourceIndex: 1, name: "Sum of Sales", aggregation: "sum" }] });
  const sid = await createPivotSlicer(page, pid, "Region", 0);
  await scriptSelect(page, sid, ["North"]);
  await eventually(() => rowOrder(page, pid), (r) => JSON.stringify(r) === '["North"]', "precondition: the pivot shows North only");
  await writeCells(page, [[3, 3, "V"]]);
  expect((await cellAt(page, 0, 3, 3))?.display, "precondition: the user's V in D4").toBe("V");
  return { pid, sid };
}

const NOT_TAKEN_BACK = /could not be taken back|not taken back/i;

test.describe("E. slicers on range pivots", () => {
  test("Y1 (slicer): a click that grows the pivot over the user's cell asks once; Cancel brings back the slicer, the pivot and the cell, no 'not taken back' toast, and the user's previous edit is still the next Ctrl+Z", async ({
    appPage: page,
  }) => {
    try {
      await newFile(page);
      const { pid, sid } = await setupSlicerOverwrite(page);
      const before = await undoState(page);
      await startToastLog(page);

      await startInPage(page, "y1slicer", MOD.SLICER_STORE, "clickSlicerItem", [sid, "South", true]);
      const v = answerDialog("Cancel");
      expect(v.notFound, `no overwrite question (driver: ${v.raw})`).toBe(false);
      expect(v.text).toMatch(/overwrite existing data/i);
      expect(v.outcome).toBe("GONE");
      await settleInPage(page, "y1slicer");
      expect(readDialog(1500).notFound, "the question was asked ONCE").toBe(true);

      await eventually(() => slicerSelection(page, sid), (s) => JSON.stringify(s) === '["North"]', "the slicer did not come back to North");
      await eventually(() => rowOrder(page, pid), (r) => JSON.stringify(r) === '["North"]', "the pivot did not come back");
      expect((await cellAt(page, 0, 3, 3))?.display, "the user's cell came back").toBe("V");
      const toasts = await toastLog(page);
      expect(toasts.filter((t) => NOT_TAKEN_BACK.test(t.text)), `no 'not taken back' toast: ${JSON.stringify(toasts)}`).toEqual([]);
      const after = await undoState(page);
      expect([after.undoDepth, after.undoDescription], "the history is as it was before the click").toEqual([before.undoDepth, before.undoDescription]);

      // The user's previous edit (V in D4) is the next Ctrl+Z.
      await pressUndo(page);
      await eventually(() => cellAt(page, 0, 3, 3).then((c) => c?.display ?? ""), (d) => d === "", "the next Ctrl+Z did not undo the user's V");
      expect(await slicerSelection(page, sid), "and did not touch the slicer").toEqual(["North"]);

      // Control: OK keeps the grown pivot.
      await writeCells(page, [[3, 3, "V"]]);
      await startInPage(page, "y1ok", MOD.SLICER_STORE, "clickSlicerItem", [sid, "South", true]);
      const ok = answerDialog("OK");
      expect(ok.notFound, `the question appeared for the control: ${ok.raw}`).toBe(false);
      await settleInPage(page, "y1ok");
      await eventually(() => rowOrder(page, pid), (r) => JSON.stringify(r) === '["North","South"]', "OK did not keep the grown pivot");
    } finally {
      await newFile(page);
    }
  });

  test("S2 (script during a click): a click during a script batch that already wrote joins it -- no question; after commitBatch one Ctrl+Z undoes both and the cell shows V again", async ({ appPage: page }) => {
    try {
      await newFile(page);
      await allowScripts(page);
      const { pid, sid } = await setupSlicerOverwrite(page);
      await startObjectScript(
        page,
        "s2batch",
        "S2 batch",
        `  await api.beginBatch("S2 batch");\n  await api.setCellValue(3, 3, "S");\n  await api.sleep(5000);\n  await api.commitBatch();`,
      );
      await eventually(() => cellAt(page, 0, 3, 3).then((c) => c?.display ?? ""), (d) => d === "S", "the script did not write S into D4");
      await startInPage(page, "s2click", MOD.SLICER_STORE, "clickSlicerItem", [sid, "South", true]);
      const d = readDialog(3500);
      if (!d.notFound) answerDialog("OK", 2000);
      expect(d.notFound, `a click that joined the script's batch must not ask (driver: ${d.raw})`).toBe(true);
      await settleInPage(page, "s2click", 20_000);
      await eventually(() => rowOrder(page, pid), (r) => JSON.stringify(r) === '["North","South"]', "the click did not filter the pivot");
      await settleInPage(page, "s2batch", 20_000);
      const st = await undoState(page);
      expect(st.transactionOpen, "the batch is closed").toBe(false);
      expect(st.undoDescription, "the top step is the script's batch").toBe("S2 batch");

      await pressUndo(page);
      await eventually(() => cellAt(page, 0, 3, 3).then((c) => c?.display ?? ""), (v) => v === "V", "one Ctrl+Z did not bring V back");
      await eventually(() => slicerSelection(page, sid), (s) => JSON.stringify(s) === '["North"]', "one Ctrl+Z did not take back the click");
      expect(await rowOrder(page, pid), "and the pivot").toEqual(["North"]);
    } finally {
      await newFile(page);
    }
  });

  test("S2 (variant): a click during a script batch that has NOT written yet asks; a decline takes back the click only and the script's later write stays", async ({ appPage: page }) => {
    try {
      await newFile(page);
      await allowScripts(page);
      const { pid, sid } = await setupSlicerOverwrite(page);
      await startObjectScript(
        page,
        "s2empty",
        "S2 empty batch",
        `  await api.beginBatch("S2 empty batch");\n  await api.sleep(4000);\n  await api.setCellValue(0, 8, "late");\n  await api.commitBatch();`,
      );
      await eventually(() => undoState(page), (s) => s.transactionOpen, "precondition: the script's batch is open");
      await startInPage(page, "s2vclick", MOD.SLICER_STORE, "clickSlicerItem", [sid, "South", true]);
      const v = answerDialog("Cancel");
      expect(v.notFound, `an empty batch is not joined: the click asks (driver: ${v.raw})`).toBe(false);
      await settleInPage(page, "s2vclick", 20_000);
      await eventually(() => slicerSelection(page, sid), (s) => JSON.stringify(s) === '["North"]', "the decline did not take back the click");
      expect((await cellAt(page, 0, 3, 3))?.display).toBe("V");
      expect(await rowOrder(page, pid)).toEqual(["North"]);
      await settleInPage(page, "s2empty", 20_000);
      expect((await cellAt(page, 0, 0, 8))?.display, "the script's later write stays").toBe("late");
    } finally {
      await newFile(page);
    }
  });

  test("X2 (pivot slicer): a column with =\"\" and empty cells lists East, West, (blank) -- no \"\" item; East + (blank) hides only West; East alone hides both kinds of blank; with =\"\" but no empty cells it lists East, West and selecting both hides nothing", async ({
    appPage: page,
  }) => {
    try {
      await newFile(page);
      await writeCells(page, [
        [0, 0, "Region"], [0, 1, "Sales"],
        [1, 0, "East"], [1, 1, "10"],
        [2, 0, "West"], [2, 1, "20"],
        [3, 1, "30"],
        [4, 0, '=""'], [4, 1, "50"],
      ]);
      const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:B5", destinationCell: "E1", sourceSheet: 0, destinationSheet: 0 });
      await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [{ sourceIndex: 1, name: "Sum of Sales", aggregation: "sum" }] });
      const sid = await createPivotSlicer(page, pid, "Region", 0);
      const items = await slicerItems(page, sid);
      expect(items, "the slicer's items").toEqual(["East", "West", "(blank)"]);

      await scriptSelect(page, sid, ["East", "(blank)"]);
      await eventually(() => rowMap(page, pid).then((m) => m["Grand Total"]), (g) => g === "90", "East + (blank) must hide only West (10+30+50)");
      expect(await rowOrder(page, pid), "West is gone").not.toContain("West");

      await scriptSelect(page, sid, ["East"]);
      await eventually(() => rowMap(page, pid).then((m) => m["Grand Total"]), (g) => g === "10", "East alone must hide both kinds of blank row");

      // A column with ="" but no empty cell.
      await newFile(page);
      await writeCells(page, [
        [0, 0, "Region"], [0, 1, "Sales"],
        [1, 0, "East"], [1, 1, "10"],
        [2, 0, "West"], [2, 1, "20"],
        [3, 0, '=""'], [3, 1, "50"],
      ]);
      const p2 = await createRangePivot(page, { sourceRange: "Sheet1!A1:B4", destinationCell: "E1", sourceSheet: 0, destinationSheet: 0 });
      await configurePivot(page, { pivotId: p2, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [{ sourceIndex: 1, name: "Sum of Sales", aggregation: "sum" }] });
      const s2 = await createPivotSlicer(page, p2, "Region", 0);
      expect(await slicerItems(page, s2), "no (blank) is offered when no cell is empty").toEqual(["East", "West"]);
      await scriptSelect(page, s2, ["East", "West"]);
      await page.waitForTimeout(500);
      expect((await rowMap(page, p2))["Grand Total"], "selecting every offered item hides nothing").toBe("80");
    } finally {
      await newFile(page);
    }
  });

  test("A1 (pivot slicer): a column with empty cells lists (blank) last; Ctrl+click West from all keeps the blank rows; a click on East alone drops them and their total", async ({ appPage: page }) => {
    try {
      await newFile(page);
      await writeTable(page, [["Region", "Sales"], ["East", 10], ["West", 20], [null, 30], ["North", 40]]);
      const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:B5", destinationCell: "E1", sourceSheet: 0, destinationSheet: 0 });
      await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [{ sourceIndex: 1, name: "Sum of Sales", aggregation: "sum" }] });
      const sid = await createPivotSlicer(page, pid, "Region", 0);
      const items = await slicerItems(page, sid);
      expect(items[items.length - 1], `(blank) is listed last: ${JSON.stringify(items)}`).toBe("(blank)");

      await callModule(page, MOD.SLICER_STORE, "clickSlicerItem", [sid, "West", true]);
      await eventually(() => rowMap(page, pid), (m) => m.West === undefined, "Ctrl+click West did not deselect West");
      const m1 = await rowMap(page, pid);
      expect(m1["(blank)"], "the blank rows stay").toBe("30");
      expect(m1["Grand Total"]).toBe("80");

      await callModule(page, MOD.SLICER_STORE, "clickSlicerItem", [sid, "East", false]);
      await eventually(() => rowMap(page, pid), (m) => m["Grand Total"] === "10", "a click on East alone did not drop the blank rows from the total");
      expect((await rowMap(page, pid))["(blank)"], "no (blank) row").toBeUndefined();
    } finally {
      await newFile(page);
    }
  });
});

// ===========================================================================
// F. Timelines (wc-undo W1 + protection + F1, wb-slicer S2 timeline doors,
//    we-pivot Y1, wf-pivot Z3 and its fix-up checks)
// ===========================================================================

interface TimelineRow {
  id: string;
  selectionStart: string | null;
  selectionEnd: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Date / Product / Sales: Jan = Apples; Feb = Apples, Pears, Plums; Mar = Kiwis. */
const TL_DATA: Array<Array<string | number | null>> = [
  ["Date", "Product", "Sales"],
  ["'2026-01-10", "Apples", 1],
  ["'2026-02-05", "Apples", 2],
  ["'2026-02-10", "Pears", 4],
  ["'2026-02-20", "Plums", 8],
  ["'2026-03-03", "Kiwis", 16],
];

async function timelineRow(page: Page, id: string): Promise<TimelineRow | null> {
  return (await callModule<TimelineRow | undefined>(page, MOD.TIMELINE_STORE, "getTimelineById", [id])) ?? null;
}

async function timelineRange(page: Page, id: string): Promise<string> {
  const t = await timelineRow(page, id);
  return t?.selectionStart ? `${t.selectionStart.slice(0, 7)}..${(t.selectionEnd ?? "").slice(0, 7)}` : "all";
}

/** Pivot at E1 (Product rows) over TL_DATA and a months timeline on its Date field, at sheet (x, y). */
async function setupTimeline(page: Page, x = 470, y = 180): Promise<{ pid: string; tid: string }> {
  await writeTable(page, TL_DATA);
  // TEXT dates: a typed (numeric) date lands the timeline in year -2688 (TL-NUM below).
  expect((await cellAt(page, 0, 1, 0))?.type, "precondition: the dates are text").toBe("text");
  const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:C6", destinationCell: "E1", sourceSheet: 0, destinationSheet: 0 });
  await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 1, name: "Product" }], valueFields: [SUM_SALES] });
  const tl = await callModule<TimelineRow | null>(page, MOD.TIMELINE_STORE, "createTimelineAsync", [
    { name: "Date", sheetIndex: 0, x, y, width: 420, height: 140, sourceId: pid, fieldName: "Date", level: "months" },
  ]);
  expect(tl, "precondition: a timeline was created on the pivot's Date field").toBeTruthy();
  await page.waitForTimeout(600);
  return { pid, tid: tl!.id };
}

/**
 * The CLIENT point of the centre of the timeline period starting `yyyymm`
 * ("2026-02"), found by the extension's own hit test.
 */
async function periodPoint(page: Page, tid: string, yyyymm: string): Promise<{ x: number; y: number }> {
  const r = await page.evaluate(
    async ({ tid, yyyymm, mods }) => {
      const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, (...a: unknown[]) => unknown>> };
      const renderer = await w.__appImport(mods.renderer);
      const geo = await w.__appImport(mods.geo);
      const store = await w.__appImport(mods.store);
      const grid = await w.__appImport(mods.grid);
      const tl = store.getTimelineById(tid) as { x: number } | undefined;
      const data = store.getCachedTimelineData(tid) as { periods: Array<{ startDate: string }> } | undefined;
      if (!tl || !data) return { error: "no timeline or no data" };
      const k = data.periods.findIndex((p) => p.startDate.startsWith(yyyymm));
      if (k < 0) return { error: `no period ${yyyymm}: ${data.periods.map((p) => p.startDate).join(",")}` };
      const b = geo.timelineCanvasBounds(tl) as { x: number; y: number; width: number; height: number } | null;
      if (!b) return { error: "no bounds" };
      const xs: number[] = [];
      const ys: number[] = [];
      for (let y = b.y; y < b.y + b.height; y += 2) {
        for (let x = b.x; x < b.x + b.width; x += 2) {
          const h = renderer.getTimelineHitDetail(x, y, b, tid) as { type: string; periodIndex?: number } | null;
          if (h && h.type === "period" && h.periodIndex === k) {
            xs.push(x);
            ys.push(y);
          }
        }
      }
      if (xs.length === 0) return { error: `period ${k} has no hit area` };
      xs.sort((a, b) => a - b);
      ys.sort((a, b) => a - b);
      const cx = xs[Math.floor(xs.length / 2)];
      const cy = ys[Math.floor(ys.length / 2)];
      const area = (document.querySelector("[data-grid-area]") as HTMLElement).getBoundingClientRect();
      const zoom = ((grid.getGridStateSnapshot() as { zoom?: number } | null)?.zoom ?? 1) as number;
      return { x: area.left + cx * zoom, y: area.top + cy * zoom };
    },
    { tid, yyyymm, mods: { renderer: MOD.TIMELINE_RENDERER, geo: MOD.TIMELINE_CANVAS_GEO, store: MOD.TIMELINE_STORE, grid: "/src/api/grid.ts" } },
  );
  if ("error" in r) throw new Error(`periodPoint: ${r.error}`);
  return r as { x: number; y: number };
}

/** A real mouse click on a timeline period. */
async function clickPeriod(page: Page, tid: string, yyyymm: string): Promise<void> {
  const p = await periodPoint(page, tid, yyyymm);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(150);
}

async function timelineLanded(page: Page): Promise<void> {
  await eventually(() => callModule<boolean>(page, MOD.TIMELINE_STORE, "isTimelineGestureLanding", []), (v) => v === false, "the timeline selection never landed", 15_000);
  await page.waitForTimeout(300);
}

/** A script's timeline selection (no question): the store's own non-asking door. */
async function scriptTimeline(page: Page, tid: string, start: string | null, end: string | null): Promise<void> {
  await callModule(page, MOD.TIMELINE_STORE, "updateTimelineSelectionAsync", [tid, start, end]);
  await page.waitForTimeout(300);
}

/** Setup narrowed to January by a script, and the user's V typed just below the pivot (E4). */
async function setupTimelineOverwrite(page: Page): Promise<{ pid: string; tid: string }> {
  const r = await setupTimeline(page);
  await scriptTimeline(page, r.tid, "2026-01-01", "2026-01-31");
  await eventually(() => rowOrder(page, r.pid), (o) => JSON.stringify(o) === '["Apples"]', "precondition: January shows Apples only");
  await writeCells(page, [[3, 4, "V"]]);
  expect((await cellAt(page, 0, 3, 4))?.display).toBe("V");
  return r;
}

test.describe("F. timelines", () => {
  test("W1: a timeline click and its pivot rows are ONE undo step -- one Ctrl+Z reverts both, Ctrl+Y re-applies both", async ({ appPage: page }) => {
    try {
      await newFile(page);
      const { pid, tid } = await setupTimeline(page);
      expect(await rowOrder(page, pid)).toEqual(["Apples", "Kiwis", "Pears", "Plums"]);
      const depth0 = (await undoState(page)).undoDepth;

      await clickPeriod(page, tid, "2026-02");
      await timelineLanded(page);
      await eventually(() => timelineRange(page, tid), (r) => r === "2026-02..2026-02", "the click did not select February");
      await eventually(() => rowOrder(page, pid), (o) => JSON.stringify(o) === '["Apples","Pears","Plums"]', "the pivot is not filtered to February");
      expect((await undoState(page)).undoDepth, "the click is exactly one undo step").toBe(depth0 + 1);

      await pressUndo(page);
      await eventually(() => timelineRange(page, tid), (r) => r === "all", "Ctrl+Z did not revert the timeline");
      await eventually(() => rowOrder(page, pid), (o) => o.length === 4, "ONE Ctrl+Z did not also revert the pivot rows (reconcile)");

      await pressRedo(page);
      await eventually(() => timelineRange(page, tid), (r) => r === "2026-02..2026-02", "Ctrl+Y did not re-apply the timeline");
      await eventually(() => rowOrder(page, pid), (o) => JSON.stringify(o) === '["Apples","Pears","Plums"]', "Ctrl+Y did not re-filter the pivot");
    } finally {
      await newFile(page);
    }
  });

  test("WF-D3 (probe): after a timeline click and Ctrl+Z, the next click on a cell does not re-apply the undone period", async ({ appPage: page, grid }) => {
    try {
      await newFile(page);
      const { pid, tid } = await setupTimeline(page);
      await clickPeriod(page, tid, "2026-02");
      await timelineLanded(page);
      await eventually(() => timelineRange(page, tid), (r) => r === "2026-02..2026-02", "precondition: February");
      await pressUndo(page);
      await eventually(() => timelineRange(page, tid), (r) => r === "all", "precondition: Ctrl+Z reverted it");
      await grid.clickCell("B20");
      await page.waitForTimeout(1500);
      expect(await timelineRange(page, tid), "a click on a cell re-applied the period the user had undone").toBe("all");
      expect((await rowOrder(page, pid)).length, "the pivot stays unfiltered").toBe(4);
    } finally {
      await newFile(page);
    }
  });

  test("WF-D3 (probe): after clicking January, moving the pointer over March (no button held) and clicking a cell leaves January selected, not January-March", async ({ appPage: page, grid }) => {
    try {
      await newFile(page);
      const { tid } = await setupTimeline(page);
      await clickPeriod(page, tid, "2026-01");
      await timelineLanded(page);
      await eventually(() => timelineRange(page, tid), (r) => r === "2026-01..2026-01", "precondition: January");
      const mar = await periodPoint(page, tid, "2026-03");
      await page.mouse.move(mar.x, mar.y, { steps: 5 });
      await page.waitForTimeout(300);
      await grid.clickCell("B20");
      await page.waitForTimeout(1500);
      expect(await timelineRange(page, tid), "hovering (no button) extended the selection into a range").toBe("2026-01..2026-01");
    } finally {
      await newFile(page);
    }
  });

  test("W1/Y1/Z3 (timeline, nothing open): a click that grows the pivot over the user's cell asks ONCE; Cancel brings back the range, the pivot and the cell, with no 'not taken back' toast; the user's edit is still the next Ctrl+Z", async ({
    appPage: page,
  }) => {
    try {
      await newFile(page);
      const { pid, tid } = await setupTimelineOverwrite(page);
      const before = await undoState(page);
      await startToastLog(page);

      const p = await periodPoint(page, tid, "2026-02");
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      await page.mouse.up();
      const v = answerDialog("Cancel");
      expect(v.notFound, `no overwrite question (driver: ${v.raw})`).toBe(false);
      expect(v.text).toMatch(/overwrite existing data/i);
      expect(v.outcome).toBe("GONE");
      await timelineLanded(page);
      const second = readDialog(2500);
      if (!second.notFound) answerDialog("Cancel", 2000);
      expect(second.notFound, `the click asked a SECOND time (driver: ${second.raw})`).toBe(true);

      await eventually(() => timelineRange(page, tid), (r) => r === "2026-01..2026-01", "Cancel did not bring the timeline back to January");
      await eventually(() => rowOrder(page, pid), (o) => JSON.stringify(o) === '["Apples"]', "Cancel did not bring the pivot back");
      expect((await cellAt(page, 0, 3, 4))?.display, "the user's cell came back").toBe("V");
      const toasts = await toastLog(page);
      expect(toasts.filter((t) => NOT_TAKEN_BACK.test(t.text)), `no 'not taken back' toast: ${JSON.stringify(toasts)}`).toEqual([]);
      const after = await undoState(page);
      expect([after.undoDepth, after.undoDescription], "the history is as before the click").toEqual([before.undoDepth, before.undoDescription]);
      await pressUndo(page);
      await eventually(() => cellAt(page, 0, 3, 4).then((c) => c?.display ?? ""), (d) => d === "", "the next Ctrl+Z is not the user's edit");
    } finally {
      await newFile(page);
    }
  });

  test("Z3: a timeline click while a script batch is open asks nothing, and the script's commitBatch makes ONE Ctrl+Z step of both", async ({ appPage: page }) => {
    try {
      await newFile(page);
      await allowScripts(page);
      const { pid, tid } = await setupTimelineOverwrite(page);
      await startObjectScript(
        page,
        "z3batch",
        "Z3 batch",
        `  await api.beginBatch("Z3 batch");\n  await api.setCellValue(0, 9, "script");\n  await api.sleep(5000);\n  await api.commitBatch();`,
      );
      await eventually(() => cellAt(page, 0, 0, 9).then((c) => c?.display ?? ""), (d) => d === "script", "the script did not write J1");
      await clickPeriod(page, tid, "2026-02");
      const d = readDialog(3500);
      if (!d.notFound) answerDialog("OK", 2000);
      expect(d.notFound, `a click inside the script's batch must not ask (driver: ${d.raw})`).toBe(true);
      await timelineLanded(page);
      await eventually(() => rowOrder(page, pid), (o) => JSON.stringify(o) === '["Apples","Pears","Plums"]', "the click did not filter the pivot");
      await settleInPage(page, "z3batch", 20_000);
      const st = await undoState(page);
      expect(st.undoDescription, "the top step is the script's batch").toBe("Z3 batch");
      await pressUndo(page);
      await eventually(() => cellAt(page, 0, 0, 9).then((c) => c?.display ?? ""), (v) => v === "", "one Ctrl+Z did not take back the script's write");
      await eventually(() => timelineRange(page, tid), (r) => r === "2026-01..2026-01", "the same Ctrl+Z did not take back the timeline click");
      await eventually(() => rowOrder(page, pid), (o) => JSON.stringify(o) === '["Apples"]', "the same Ctrl+Z did not take back the pivot");
      expect((await cellAt(page, 0, 3, 4))?.display, "and the user's V is back").toBe("V");
    } finally {
      await newFile(page);
    }
  });

  test("F1: a timeline's own script -- beginBatch, A1, setRange(January), A2, commitBatch -- reads 'B' in Edit > Undo and ONE Ctrl+Z reverts A1, A2, the range and the pivot rows", async ({ appPage: page }) => {
    try {
      await newFile(page);
      await allowScripts(page);
      const { pid, tid } = await setupTimeline(page);
      await startInPage(page, "f1", MOD.OBJECT_SCRIPT_RUNNER, "runObjectScriptOnce", [
        {
          name: "F1 timeline script",
          objectType: "timeline",
          instanceId: tid,
          source:
            "export async function setup(context) {\n" +
            "  const api = context.api;\n" +
            '  await api.beginBatch("B");\n' +
            '  await api.setCellValue(0, 9, "1");\n' +
            '  await context.setRange("2026-01-01", "2026-01-31");\n' +
            '  await api.setCellValue(1, 9, "2");\n' +
            "  await api.commitBatch();\n" +
            "}\n",
        },
      ]);
      await settleInPage(page, "f1", 20_000);
      await timelineLanded(page);
      await eventually(() => timelineRange(page, tid), (r) => r === "2026-01..2026-01", "the script did not select January");
      await eventually(() => rowOrder(page, pid), (o) => JSON.stringify(o) === '["Apples"]', "the pivot was not filtered to January");
      expect((await cellAt(page, 0, 0, 9))?.display).toBe("1");
      expect((await cellAt(page, 0, 1, 9))?.display).toBe("2");
      expect((await undoState(page)).undoDescription, "Edit > Undo reads B").toBe("B");

      await pressUndo(page);
      await eventually(() => cellAt(page, 0, 0, 9).then((c) => c?.display ?? ""), (v) => v === "", "one Ctrl+Z did not clear A1 (J1)");
      expect((await cellAt(page, 0, 1, 9))?.display ?? "", "the same Ctrl+Z clears A2 (J2)").toBe("");
      await eventually(() => timelineRange(page, tid), (r) => r === "all", "the same Ctrl+Z did not revert the range");
      await eventually(() => rowOrder(page, pid), (o) => o.length === 4, "the same Ctrl+Z did not revert the pivot rows");
    } finally {
      await newFile(page);
    }
  });

  test("S2 (timeline Clear doors): right-click > Clear Timeline Filter and the Timeline tab's Clear Filter, on a clear that grows the pivot over cells, both ask; Cancel keeps the range", async ({
    appPage: page,
  }) => {
    try {
      await newFile(page);
      const { pid, tid } = await setupTimelineOverwrite(page);

      // Right-click on the timeline's header, then Clear Timeline Filter.
      const t = (await timelineRow(page, tid))!;
      const hp = await sheetPointToPage(page, t.x + 40, t.y + 10);
      await page.mouse.click(hp.x, hp.y, { button: "right" });
      await page.getByText("Clear Timeline Filter", { exact: true }).click();
      const v1 = answerDialog("Cancel");
      expect(v1.notFound, `right-click > Clear Timeline Filter did not ask (driver: ${v1.raw})`).toBe(false);
      await timelineLanded(page);
      await eventually(() => timelineRange(page, tid), (r) => r === "2026-01..2026-01", "Cancel did not keep January");
      expect((await cellAt(page, 0, 3, 4))?.display).toBe("V");
      expect(await rowOrder(page, pid)).toEqual(["Apples"]);

      // The Timeline tab's Clear Filter (the timeline is selected by the right-click / a click on it).
      await page.keyboard.press("Escape");
      await page.mouse.click(hp.x, hp.y);
      await page.waitForTimeout(600);
      const tabs = await page.evaluate(() => {
        const band = document.querySelector("[data-ribbon-content]");
        const strip = band?.parentElement?.querySelector("div");
        return Array.from(strip?.querySelectorAll("button") ?? []).map((b) => (b.textContent ?? "").trim());
      });
      const tlTab = tabs.find((x) => /timeline/i.test(x));
      expect(tlTab, `a Timeline contextual tab is shown: ${JSON.stringify(tabs)}`).toBeTruthy();
      await openRibbonTab(page, tlTab!);
      const clear = page.locator("[data-ribbon-content]").getByRole("button", { name: /Clear Filter/i }).first();
      await clear.click();
      const v2 = answerDialog("Cancel");
      expect(v2.notFound, `the Timeline tab's Clear Filter did not ask (driver: ${v2.raw})`).toBe(false);
      await timelineLanded(page);
      await eventually(() => timelineRange(page, tid), (r) => r === "2026-01..2026-01", "Cancel did not keep January");
      expect((await cellAt(page, 0, 3, 4))?.display).toBe("V");
    } finally {
      await newFile(page);
    }
  });

  test("W1 (protection): with 'Edit objects' unchecked, Remove Timeline and Remove Slicer each give ONE error toast naming the protection, the object stays and the document stays clean; unprotected, a remove is taken back by one Ctrl+Z", async ({
    appPage: page,
  }) => {
    const file = path.join(TMP, `fixall-pivot-prot-${Date.now()}.cala`);
    try {
      await newFile(page);
      const { pid, tid } = await setupTimeline(page, 470, 240);
      const sid = await createPivotSlicer(page, pid, "Product", 0, 470, 20);
      await invoke(page, "protect_sheet", { params: {} });
      await saveClean(page, file);
      await startToastLog(page);

      const removeVia = async (sheetX: number, sheetY: number, label: string) => {
        const pt = await sheetPointToPage(page, sheetX, sheetY);
        await page.mouse.click(pt.x, pt.y, { button: "right" });
        await page.getByText(label, { exact: true }).click();
        await page.waitForTimeout(1200);
      };
      const t = (await timelineRow(page, tid))!;
      await removeVia(t.x + 40, t.y + 10, "Remove Timeline");
      expect(await timelineRow(page, tid), "the timeline stays").not.toBeNull();
      const s = (await callModule<{ x: number; y: number }>(page, MOD.SLICER_STORE, "getSlicerById", [sid]))!;
      await removeVia(s.x + 40, s.y + 10, "Remove Slicer");
      expect(await callModule(page, MOD.SLICER_STORE, "getSlicerById", [sid]), "the slicer stays").toBeTruthy();
      const toasts = (await toastLog(page)).filter((x) => x.variant === "error");
      expect(toasts.length, `one error toast per refused remove: ${JSON.stringify(toasts)}`).toBe(2);
      expect(toasts.every((x) => /protect/i.test(x.text)), `each names the protection: ${JSON.stringify(toasts)}`).toBe(true);
      expect(await isDirty(page), "no unsaved-changes asterisk").toBe(false);

      // Unprotected: remove, then one Ctrl+Z brings it back.
      await invoke(page, "unprotect_sheet", { password: null });
      await removeVia(t.x + 40, t.y + 10, "Remove Timeline");
      await eventually(() => timelineRow(page, tid), (r) => r === null, "unprotected, Remove Timeline did not remove it");
      await pressUndo(page);
      await eventually(() => timelineRow(page, tid), (r) => r !== null, "one Ctrl+Z did not bring the timeline back");
    } finally {
      await newFile(page);
      fs.rmSync(file, { force: true });
    }
  });
});

// ===========================================================================
// G. Data-model (BI) pivots, model slicers, ribbon filters, design queries
//    (wd-pivot X1/X2, wb-slicer S1/S2/A3, wc-undo W4, wa-pivot P9/P10,
//    we-pivot Y5, wf-pivot Z2)
// ===========================================================================

const MODEL_TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures/model/sales_star.json");
const CSV_SOURCE = "fixall_csv";

interface ModelRow {
  region: string | null;
  year: number;
  amount: number;
}

interface ModelOptions {
  /** Storage mode of the one table ("in_memory" loads once; "direct_query" re-reads the CSV per query). */
  storage?: "in_memory" | "direct_query";
  /** Rewrite Region with this row-level expression (a pipeline step). */
  regionTransform?: string;
  /** A calculation group with these item names, in this order. */
  calcGroupItems?: string[];
  /** Append this many generated rows (regions East/West/North/South, years 2024/2025, amount 1): a SLOW source. */
  extraRows?: number;
}

function csvLine(values: Array<string | number | null>): string {
  return values
    .map((v) => {
      if (v === null) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

/** One table "Sales" (Region, Year, Amount) in a CSV directory + the model bound to it. */
function buildModel(rows: ModelRow[], opts: ModelOptions = {}): { dir: string; model: Record<string, unknown> } {
  const dir = fs.mkdtempSync(path.join(TMP, "fixall-pivot-model-"));
  const lines = ["Region,Year,Amount", ...rows.map((r) => csvLine([r.region, r.year, r.amount]))];
  fs.writeFileSync(path.join(dir, "Sales.csv"), lines.join("\n") + "\n", "utf8");
  if (opts.extraRows) {
    const regions = ["East", "West", "North", "South"];
    const chunk = 100_000;
    for (let start = 0; start < opts.extraRows; start += chunk) {
      const n = Math.min(chunk, opts.extraRows - start);
      const out: string[] = new Array(n);
      for (let i = 0; i < n; i++) {
        const k = start + i;
        out[i] = `${regions[k % 4]},${2024 + (Math.floor(k / 4) % 2)},1`;
      }
      fs.appendFileSync(path.join(dir, "Sales.csv"), out.join("\n") + "\n", "utf8");
    }
  }
  const template = (JSON.parse(fs.readFileSync(MODEL_TEMPLATE, "utf8")) as { model: Record<string, unknown> }).model;
  const columns = [
    { name: "Region", data_type: "String", nullable: true },
    { name: "Year", data_type: "Int64", nullable: false },
    { name: "Amount", data_type: "Float64", nullable: false },
  ];
  const binding: Record<string, unknown> = { source_id: CSV_SOURCE, schema: "csv", table: "Sales" };
  if (opts.regionTransform) {
    binding.source_columns = columns;
    binding.transformations = [{ type: "transformColumn", column: "Region", expression: opts.regionTransform, dataType: "String" }];
  }
  const model: Record<string, unknown> = {
    ...template,
    model_name: "FixAll",
    tables: [{ name: "Sales", columns, storage_mode: opts.storage ?? "in_memory", source_binding: binding }],
    relationships: [],
    measures: [
      {
        name: "Revenue",
        expression: { Aggregate: { operation: "Sum", operand: { QualifiedColumnRef: { table_or_var: "Sales", column: "Amount" } } } },
        source: "SUM(Sales[Amount])",
        format_string: "0",
      },
    ],
    calculated_columns: [],
    measure_groups: [],
    hierarchies: [],
    date_table: null,
    kpis: [],
    sources: [
      { id: CSV_SOURCE, kind: "csv", connection: { database: dir, default_schema: "csv" }, preferred_auth: "integrated", display_name: "FixAll (CSV)" },
    ],
  };
  if (opts.calcGroupItems) {
    model.calculation_groups = [
      { name: "Views", items: opts.calcGroupItems.map((name) => ({ name, expression: "SelectedMeasure", source: "SELECTEDMEASURE()" })) },
    ];
  }
  return { dir, model };
}

async function connectModel(page: Page, name: string, rows: ModelRow[], opts: ModelOptions = {}): Promise<{ connectionId: string; dir: string }> {
  const { dir, model } = buildModel(rows, opts);
  const info = await invoke<{ id: string }>(page, "bi_create_connection", {
    request: { name, description: null, connectionString: "", modelJson: { formatVersion: 1, model } },
  });
  await invoke(page, "bi_model_connect_source", { connectionId: info.id, sourceId: CSV_SOURCE, connectionString: "", remember: false });
  return { connectionId: info.id, dir };
}

async function dropModel(page: Page, conn: { connectionId: string; dir: string } | null): Promise<void> {
  if (!conn) return;
  await invoke(page, "bi_delete_connection", { connectionId: conn.connectionId }).catch(() => undefined);
  fs.rmSync(conn.dir, { recursive: true, force: true });
}

/** A BI pivot at B2 of `sheetIndex`: rows Sales.Region (+ extra), values Revenue. */
async function modelPivot(page: Page, connectionId: string, sheetIndex: number, fields: Record<string, unknown> = {}, cell = "B2"): Promise<string> {
  const v = await pivotApi<{ pivotId: string }>(page, "createFromBiModel", { destinationSheet: sheetIndex, connectionId, destinationCell: cell });
  await pivotApi(page, "updateBiFields", {
    pivotId: v.pivotId,
    rowFields: [{ table: "Sales", column: "Region" }],
    columnFields: [],
    valueFields: [{ measureName: "Revenue" }],
    filterFields: [],
    ...fields,
  });
  await page.evaluate(() => window.dispatchEvent(new Event("pivot:refresh")));
  await page.waitForTimeout(500);
  return String(v.pivotId);
}

/** The blank-member model: East 10, West 20, NULL 30, NULL 5, North 40 (2025 for the 5 and the 40). */
const BLANK_ROWS: ModelRow[] = [
  { region: "East", year: 2024, amount: 10 },
  { region: "West", year: 2024, amount: 20 },
  { region: null, year: 2024, amount: 30 },
  { region: null, year: 2025, amount: 5 },
  { region: "North", year: 2025, amount: 40 },
];

async function createModelSlicer(page: Page, connectionId: string, column: string, sheetIndex: number, filterLevel = 1): Promise<string> {
  const s = await callModule<SlicerRow | null>(page, MOD.SLICER_STORE, "createSlicerAsync", [
    {
      name: column,
      sheetIndex,
      x: 520,
      y: 30,
      width: 180,
      height: 220,
      sourceType: "biConnection",
      cacheSourceId: connectionId,
      fieldName: `Sales.${column}`,
      connectedSources: [{ sourceType: "biConnection", sourceId: connectionId }],
      filterLevel,
    },
  ]);
  expect(s, `precondition: a model slicer on ${column}`).toBeTruthy();
  return s!.id;
}

test.describe("G. data-model pivots, model slicers, ribbon filters", () => {
  test("X1 (model): the (blank) row of a data-model pivot is the NULL rows' 35, not the grand total; double-clicking it says drill-through cannot list a (blank) item and adds no sheet", async ({
    appPage: page,
    grid,
  }) => {
    let conn: { connectionId: string; dir: string } | null = null;
    try {
      await newFile(page);
      conn = await connectModel(page, "FixAll X1", BLANK_ROWS);
      const pid = await modelPivot(page, conn.connectionId, 0);
      const rows = await eventually(() => rowMap(page, pid), (m) => !!m["Grand Total"], "the model pivot never answered", 20_000);
      expect(rows["(blank)"], `the (blank) row is the NULL rows' sum: ${JSON.stringify(rows)}`).toBe("35");
      expect(rows["Grand Total"]).toBe("105");
      expect(rows.East).toBe("10");

      const blank = await findLabel(page, 0, "(blank)", 0, 0, 12, 4);
      await startToastLog(page);
      const before = (await sheets(page)).sheets.length;
      await grid.doubleClickCell(rcToRef(blank.row, blank.col + 1));
      await eventually(() => toastLog(page), (t) => t.some((x) => /cannot list the rows of a \(blank\) item/i.test(x.text)), "no 'cannot list the rows of a (blank) item' message", 15_000);
      await page.waitForTimeout(800);
      expect((await sheets(page)).sheets.length, "no drill-through sheet was added").toBe(before);
      // Control: a named item drills.
      const east = await findLabel(page, 0, "East", 0, 0, 12, 4);
      await grid.doubleClickCell(rcToRef(east.row, east.col + 1));
      await eventually(() => sheets(page), (r) => r.sheets.length === before + 1, "control: East's drill-through added no sheet", 15_000);
    } finally {
      await newFile(page);
      await dropModel(page, conn);
    }
  });

  test("X2 (model lists): NULL and \"\" regions -- a model slicer and a ribbon filter list East, West, (blank); East + (blank) hides only West (90); East alone hides both kinds of blank", async ({
    appPage: page,
  }) => {
    let conn: { connectionId: string; dir: string } | null = null;
    try {
      await newFile(page);
      conn = await connectModel(
        page,
        "FixAll X2",
        [
          { region: "East", year: 2024, amount: 10 },
          { region: "West", year: 2024, amount: 20 },
          { region: null, year: 2024, amount: 30 },
          { region: "EMPTYSTR", year: 2024, amount: 50 },
        ],
        { regionTransform: 'IF([Region] = "EMPTYSTR", "", [Region])' },
      );
      const pid = await modelPivot(page, conn.connectionId, 0);
      const all = await eventually(() => rowMap(page, pid), (m) => !!m["Grand Total"], "the model pivot never answered", 20_000);
      expect(all["Grand Total"], `precondition: all four rows (the "" transform loaded): ${JSON.stringify(all)}`).toBe("110");
      expect(Object.keys(all), `precondition: no EMPTYSTR left (the pipeline rewrote it to ""): ${JSON.stringify(all)}`).not.toContain("EMPTYSTR");

      // Model slicer.
      const sid = await createModelSlicer(page, conn.connectionId, "Region", 0);
      const items = await eventually(() => slicerItems(page, sid), (i) => i.length > 0, "the model slicer shows no items", 15_000);
      expect(items, "the model slicer lists East, West, (blank) -- one blank item").toEqual(["East", "West", "(blank)"]);
      await scriptSelect(page, sid, ["East", "(blank)"]);
      await eventually(() => rowMap(page, pid).then((m) => m["Grand Total"]), (g) => g === "90", "East + (blank) must hide only West (10+30+50)", 20_000);
      await scriptSelect(page, sid, ["East"]);
      await eventually(() => rowMap(page, pid).then((m) => m["Grand Total"]), (g) => g === "10", "East alone must hide both kinds of blank", 20_000);
      await scriptSelect(page, sid, null);
      await eventually(() => rowMap(page, pid).then((m) => m["Grand Total"]), (g) => g === "110", "clearing the slicer did not restore all rows", 20_000);
      await callModule(page, MOD.SLICER_STORE, "deleteSlicerAsync", [sid]);

      // Ribbon filter.
      const filter = await callModule<{ id: string } | null>(page, "/extensions/ControlsPane/lib/filterPaneStore.ts", "createFilterAsync", [
        { name: "RegionFilter", connectionId: conn.connectionId, fieldName: "Sales.Region", connectionMode: "workbook" },
      ]);
      expect(filter, "precondition: a ribbon filter was created").toBeTruthy();
      await callModule(page, "/extensions/ControlsPane/lib/filterPaneStore.ts", "refreshFilterItems", [filter!.id]);
      const fItems = await eventually(
        async () => ((await callModule<Array<{ value: string }> | undefined>(page, "/extensions/ControlsPane/lib/filterPaneStore.ts", "getCachedItems", [filter!.id])) ?? []).map((i) => i.value),
        (i) => i.length > 0,
        "the ribbon filter shows no items",
        15_000,
      );
      expect(fItems, "the ribbon filter lists East, West, (blank)").toEqual(["East", "West", "(blank)"]);
      await callModule(page, "/extensions/ControlsPane/lib/filterPaneStore.ts", "updateFilterSelectionAsync", [filter!.id, ["East", "(blank)"]]);
      await eventually(() => rowMap(page, pid).then((m) => m["Grand Total"]), (g) => g === "90", "ribbon filter East + (blank) must hide only West", 20_000);
    } finally {
      await newFile(page);
      await dropModel(page, conn);
    }
  });

  test("A3: a BI pivot sorted Region descending stays descending after Year is added to Columns, and after Region itself moves to Columns", async ({ appPage: page }) => {
    let conn: { connectionId: string; dir: string } | null = null;
    try {
      await newFile(page);
      conn = await connectModel(page, "FixAll A3", BLANK_ROWS.filter((r) => r.region !== null));
      const pid = await modelPivot(page, conn.connectionId, 0);
      await eventually(() => rowOrder(page, pid), (o) => o.length === 3, "the model pivot never answered", 20_000);
      expect(await rowOrder(page, pid), "control: ascending by default").toEqual(["East", "North", "West"]);
      const regionIdx = ((await pivotView(page, pid)).rowFieldSummaries ?? []).find((f) => /Region/.test(f.fieldName))!.fieldIndex;
      await pivotApi(page, "sortField", { pivotId: pid, fieldIndex: regionIdx, sortBy: "descending" });
      await eventually(() => rowOrder(page, pid), (o) => JSON.stringify(o) === '["West","North","East"]', "the sort did not apply", 20_000);

      // Add Year to Columns (the field list sends the zones; nothing says "sort").
      await pivotApi(page, "updateBiFields", {
        pivotId: pid,
        rowFields: [{ table: "Sales", column: "Region" }],
        columnFields: [{ table: "Sales", column: "Year" }],
        valueFields: [{ measureName: "Revenue" }],
        filterFields: [],
      });
      await eventually(() => rowOrder(page, pid), (o) => o.length === 3, "no rows after adding Year", 20_000);
      expect(await rowOrder(page, pid), "Region stays descending after Year joins the columns").toEqual(["West", "North", "East"]);

      // Region itself to Columns.
      await pivotApi(page, "updateBiFields", {
        pivotId: pid,
        rowFields: [{ table: "Sales", column: "Year" }],
        columnFields: [{ table: "Sales", column: "Region" }],
        valueFields: [{ measureName: "Revenue" }],
        filterFields: [],
      });
      const t = await eventually(async () => viewText(await pivotView(page, pid)), (x) => x.some((r) => r.includes("West") && r.includes("East")), "Region did not reach the columns", 20_000);
      const hdr = t.find((r) => r.includes("West") && r.includes("East"))!;
      expect(hdr.filter((c) => ["West", "North", "East"].includes(c)), "Region stays descending on the columns").toEqual(["West", "North", "East"]);
    } finally {
      await newFile(page);
      await dropModel(page, conn);
    }
  });

  test("Y5 (model): Change Data Source on a data-model pivot shows the read-only 'connected to a BI model' note, and OK only closes", async ({ appPage: page, grid }) => {
    let conn: { connectionId: string; dir: string } | null = null;
    try {
      await newFile(page);
      conn = await connectModel(page, "FixAll Y5", BLANK_ROWS);
      const pid = await modelPivot(page, conn.connectionId, 0);
      await eventually(() => rowMap(page, pid), (m) => !!m["Grand Total"], "the model pivot never answered", 20_000);
      const reg = (await pivotRegions(page)).find((x) => String(x.pivotId) === pid)!;
      await openChangeDataSource(page, grid, rcToRef(reg.startRow + 2, reg.startCol + 1));
      await expect(cdsDialog(page).getByText(/connected to a BI model/i), "the read-only note").toBeVisible();
      await expect(cdsDialog(page).locator('input[type="text"]'), "no editable source box").toHaveCount(0);
      const depth = (await undoState(page)).undoDepth;
      await cdsDialog(page).getByRole("button", { name: /^OK$/ }).click();
      await expect(cdsDialog(page), "OK closes").toHaveCount(0);
      expect((await undoState(page)).undoDepth, "OK changed nothing").toBe(depth);
    } finally {
      await newFile(page);
      await dropModel(page, conn);
    }
  });

  test("Z2 (model): a placed calculation group of 10 items lists them in DECLARATION order", async ({ appPage: page }) => {
    let conn: { connectionId: string; dir: string } | null = null;
    const declared = ["Zulu", "Kilo", "Yankee", "Alpha", "Mike", "Bravo", "Xray", "Charlie", "Lima", "Delta"];
    try {
      await newFile(page);
      conn = await connectModel(page, "FixAll Z2", BLANK_ROWS.filter((r) => r.region !== null), { calcGroupItems: declared });
      const pid = await modelPivot(page, conn.connectionId, 0, { rowFields: [{ table: "__calcgroup__", column: "Views" }] });
      const order = await eventually(() => rowOrder(page, pid), (o) => o.length === declared.length, "the calculation group's items never showed", 20_000);
      expect(order, "declaration order (not alphabetical, not hash order)").toEqual(declared);
    } finally {
      await newFile(page);
      await dropModel(page, conn);
    }
  });

  test("P10/R1: a design query FILTERS Region = (\"East\") charts East only (the NULL-region rows in no total); = (\"East\", \"(blank)\") includes them -- in a chart and in a report", async ({ appPage: page }) => {
    let conn: { connectionId: string; dir: string } | null = null;
    try {
      await newFile(page);
      conn = await connectModel(page, "FixAll P10", BLANK_ROWS);
      const run = (dslText: string) =>
        callModule<{ categories: string[]; series: Array<{ values: number[] }> }>(page, "/extensions/Charts/lib/designQueryChartDataReader.ts", "readDesignQueryData", [
          { type: "designQuery", dslText, connectionId: conn!.connectionId },
        ]);
      const pairs = (d: { categories: string[]; series: Array<{ values: number[] }> }) => d.categories.map((c, i) => `${c}=${d.series[0]?.values[i]}`);

      const east = await run('ROWS: Sales.Year\nVALUES: [Revenue]\nFILTERS: Sales.Region = ("East")');
      expect(pairs(east), "East only: 2024 = 10, and no 2025 (its rows are NULL and North)").toEqual(["2024=10"]);
      const withBlank = await run('ROWS: Sales.Year\nVALUES: [Revenue]\nFILTERS: Sales.Region = ("East", "(blank)")');
      expect(pairs(withBlank), "East + (blank): 2024 = 10 + 30, 2025 = 5").toEqual(["2024=40", "2025=5"]);

      // The same query as a REPORT on Sheet1 (the Create Report dialog's request).
      const reportCells = async (dslText: string, anchorRow: number) => {
        const compiled = await page.evaluate(
          async ({ dslText, connectionId, mod }) => {
            const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, (...a: unknown[]) => unknown>>; __TAURI__: { core: { invoke: (c: string, a?: unknown) => Promise<unknown> } } };
            const dq = await w.__appImport(mod);
            const biModel = await w.__TAURI__.core.invoke("get_connection_bi_model", { connectionId });
            const out = dq.compileDesignQuery(dslText, connectionId, biModel) as { request: unknown; errors: unknown[] };
            return out;
          },
          { dslText, connectionId: conn!.connectionId, mod: "/extensions/_shared/dsl/pivotLayout/designQuery.ts" },
        );
        expect(compiled.request, `the report's query compiles: ${JSON.stringify(compiled.errors)}`).toBeTruthy();
        await invoke(page, "create_report", { request: { name: `R${anchorRow}`, dslText, sheetIndex: 0, anchorRow, anchorCol: 6, query: compiled.request } });
        await page.waitForTimeout(800);
        return displayGrid(page, 0, anchorRow, 6, anchorRow + 6, 8);
      };
      const r1 = await reportCells('ROWS: Sales.Year\nVALUES: [Revenue]\nFILTERS: Sales.Region = ("East")', 0);
      const years1 = r1.filter((r) => /^20\d\d$/.test(r[0]));
      expect(years1.map((r) => `${r[0]}=${r[1]}`), `the report shows East only: ${JSON.stringify(r1)}`).toEqual(["2024=10"]);
      const r2 = await reportCells('ROWS: Sales.Year\nVALUES: [Revenue]\nFILTERS: Sales.Region = ("East", "(blank)")', 12);
      const years2 = r2.filter((r) => /^20\d\d$/.test(r[0]));
      expect(years2.map((r) => `${r[0]}=${r[1]}`), `the report includes the blank rows: ${JSON.stringify(r2)}`).toEqual(["2024=40", "2025=5"]);
    } finally {
      await newFile(page);
      await dropModel(page, conn);
    }
  });
});

// ===========================================================================
// H. Table slicers, script batches, the model field pane
//    (wc-undo W2/W3, wb-slicer S1 table, we-pivot Y3, wa-pivot P9)
// ===========================================================================

async function hiddenRows(page: Page): Promise<number[]> {
  return (await invoke<number[]>(page, "get_hidden_rows")).sort((a, b) => a - b);
}

/** Region/Sales on the ACTIVE sheet A1:B5 as Table1: East rows 1 and 3, West row 2, North row 4. */
async function tableWithRegions(page: Page, sheetIndex: number): Promise<{ id: string; name: string }> {
  await writeTable(page, [["Region", "Sales"], ["East", 1], ["West", 2], ["East", 3], ["North", 4]]);
  const t = await callModule<{ id: string; name: string } | null>(page, "/extensions/Table/lib/tableStore.ts", "createTableAsync", [
    { sheetIndex, startRow: 0, startCol: 0, endRow: 4, endCol: 1, hasHeaders: true },
  ]);
  expect(t, "precondition: a table").toBeTruthy();
  return t!;
}

async function createTableSlicer(page: Page, tableId: string, sheetIndex: number): Promise<string> {
  const s = await callModule<SlicerRow | null>(page, MOD.SLICER_STORE, "createSlicerAsync", [
    {
      name: "Region",
      sheetIndex,
      x: 420,
      y: 40,
      width: 180,
      height: 200,
      sourceType: "table",
      cacheSourceId: tableId,
      fieldName: "Region",
      connectedSources: [{ sourceType: "table", sourceId: tableId }],
    },
  ]);
  expect(s, "precondition: a table slicer").toBeTruthy();
  await callModule(page, MOD.SLICER_STORE, "refreshSlicerItems", [s!.id]);
  return s!.id;
}

test.describe("H. table slicers, script batches, the model field pane", () => {
  test("W2/S1 (table slicer): clicking East hides the other rows; ONE Ctrl+Z restores both the slicer and the rows; Ctrl+Y re-filters", async ({ appPage: page }) => {
    try {
      await newFile(page);
      const t = await tableWithRegions(page, 0);
      const sid = await createTableSlicer(page, t.id, 0);
      expect(await hiddenRows(page), "precondition: nothing hidden").toEqual([]);
      const depth0 = (await undoState(page)).undoDepth;

      await callModule(page, MOD.SLICER_STORE, "clickSlicerItem", [sid, "East", false]);
      await eventually(() => hiddenRows(page), (h) => JSON.stringify(h) === "[2,4]", "clicking East did not hide West and North");
      expect(await slicerSelection(page, sid)).toEqual(["East"]);
      expect((await undoState(page)).undoDepth, "the click is ONE step").toBe(depth0 + 1);

      await pressUndo(page);
      await eventually(() => hiddenRows(page), (h) => h.length === 0, "one Ctrl+Z did not unhide the rows");
      await eventually(() => slicerSelection(page, sid), (s) => s === null || s.length === 0, "the same Ctrl+Z did not restore the slicer");
      await pressRedo(page);
      await eventually(() => hiddenRows(page), (h) => JSON.stringify(h) === "[2,4]", "Ctrl+Y did not re-filter");
      expect(await slicerSelection(page, sid)).toEqual(["East"]);
    } finally {
      await newFile(page);
    }
  });

  test("W2 (other sheet): a table slicer on Sheet2 filters the table on Sheet1 -- switching to Sheet1 shows the rows filtered and the Region column's filter set", async ({ appPage: page }) => {
    try {
      await newFile(page);
      const t = await tableWithRegions(page, 0);
      const s2 = await addWorksheet(page);
      const sid = await createTableSlicer(page, t.id, s2.index);
      await callModule(page, MOD.SLICER_STORE, "clickSlicerItem", [sid, "East", false]);
      await eventually(() => slicerSelection(page, sid), (s) => JSON.stringify(s) === '["East"]', "the click did not land");
      await page.waitForTimeout(600);
      await activateSheet(page, 0);
      await eventually(() => hiddenRows(page), (h) => JSON.stringify(h) === "[2,4]", "on Sheet1 the table's rows are not filtered");
      const af = await invoke<{ criteria: Array<unknown | null> } | null>(page, "get_auto_filter");
      expect(af, "the table's AutoFilter exists").toBeTruthy();
      expect(af!.criteria[0], "the Region column arrow shows as filtered (it carries the criteria)").not.toBeNull();
    } finally {
      await newFile(page);
    }
  });

  test("W3: a script's beginBatch, a block write, a table-slicer selection and commitBatch are undone by ONE Ctrl+Z", async ({ appPage: page }) => {
    try {
      await newFile(page);
      await allowScripts(page);
      const t = await tableWithRegions(page, 0);
      const sid = await createTableSlicer(page, t.id, 0);
      await startObjectScript(
        page,
        "w3",
        "W3 batch",
        `  await api.beginBatch("W3");\n  await api.setCellValue(0, 5, "a");\n  await api.setCellValue(1, 5, "b");\n  await api.slicer("${sid}").setSelectedItems(["East"]);\n  await api.commitBatch();`,
      );
      await settleInPage(page, "w3", 20_000);
      await eventually(() => hiddenRows(page), (h) => JSON.stringify(h) === "[2,4]", "the script's slicer selection did not filter the table");
      expect((await undoState(page)).undoDescription, "the top step is the script's batch").toBe("W3");
      await pressUndo(page);
      await eventually(() => hiddenRows(page), (h) => h.length === 0, "one Ctrl+Z did not unfilter the table");
      expect((await cellAt(page, 0, 0, 5))?.display ?? "", "the same Ctrl+Z cleared F1").toBe("");
      expect((await cellAt(page, 0, 1, 5))?.display ?? "", "and F2").toBe("");
      await eventually(() => slicerSelection(page, sid), (s) => s === null || s.length === 0, "and the slicer's selection");
    } finally {
      await newFile(page);
    }
  });

  test("Y3: a script's beginBatch, A1, applyNamedStyle('Good'), A2, commitBatch reads 'B' and ONE Ctrl+Z clears A1, A2 and the style; Home > Cell Styles > Good is one step", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await allowScripts(page);
      const styleOf = async (row: number, col: number) => (await invoke<{ styleIndex: number } | null>(page, "get_cell", { row, col }))?.styleIndex ?? 0;
      expect(await styleOf(0, 0), "precondition: A1 is unstyled").toBe(0);
      await startObjectScript(
        page,
        "y3",
        "Y3 batch",
        `  await api.beginBatch("B");\n  await api.setCellValue(0, 0, "1");\n  await api.applyNamedStyle("Good", 0, 0, 0, 0);\n  await api.setCellValue(1, 0, "2");\n  await api.commitBatch();`,
      );
      await settleInPage(page, "y3", 20_000);
      expect((await cellAt(page, 0, 0, 0))?.display).toBe("1");
      expect((await cellAt(page, 0, 1, 0))?.display).toBe("2");
      expect(await styleOf(0, 0), "the script applied Good to A1").not.toBe(0);
      expect((await undoState(page)).undoDescription, "Edit > Undo reads B").toBe("B");
      await pressUndo(page);
      await eventually(() => cellAt(page, 0, 0, 0).then((c) => c?.display ?? ""), (v) => v === "", "one Ctrl+Z did not clear A1");
      expect((await cellAt(page, 0, 1, 0))?.display ?? "", "the same Ctrl+Z cleared A2").toBe("");
      expect(await styleOf(0, 0), "the same Ctrl+Z removed Good").toBe(0);

      // Home > Cell Styles > Good on a plain selection: one step.
      await grid.selectRange("C3", "C4");
      const depth = (await undoState(page)).undoDepth;
      await page.locator('[data-testid="fmt-cellStyles"]').first().click();
      const good = page.locator('[data-testid="cell-styles-gallery"]').getByText("Good", { exact: true }).first();
      await good.click();
      await eventually(() => styleOf(2, 2), (s) => s !== 0, "Home > Cell Styles > Good styled nothing");
      const st = await undoState(page);
      expect(st.undoDepth, "Home > Cell Styles > Good is ONE step").toBe(depth + 1);
      expect(st.undoDescription ?? "", "its label names the two cells").toMatch(/2 cells/);
    } finally {
      await newFile(page);
    }
  });

  test("P9: on a model pivot with a calculated field and a tabular layout, toggling Lookup on a placed column in the field pane keeps the calculated column and the layout", async ({
    appPage: page,
    grid,
  }) => {
    let conn: { connectionId: string; dir: string } | null = null;
    try {
      await newFile(page);
      conn = await connectModel(page, "FixAll P9", BLANK_ROWS.filter((r) => r.region !== null));
      const pid = await modelPivot(page, conn.connectionId, 0, {
        rowFields: [{ table: "Sales", column: "Region" }, { table: "Sales", column: "Year" }],
        calculatedFields: [{ name: "Double", formula: "[Revenue] * 2" }],
        layout: { reportLayout: "tabular", showColumnGrandTotals: false, showRowGrandTotals: false },
      });
      const hasDouble = async () => viewText(await pivotView(page, pid)).some((r) => r.some((c) => /Double/.test(c)));
      const gtRows = async () => (await pivotView(page, pid)).rows.filter((r) => r.rowType === "GrandTotal").length;
      await eventually(hasDouble, (v) => v, "precondition: the calculated column shows", 20_000);
      expect(await gtRows(), "precondition: grand totals are off").toBe(0);

      // The field pane: Year's G badge -> Lookup.
      const reg = (await pivotRegions(page)).find((x) => String(x.pivotId) === pid)!;
      await grid.clickCell(rcToRef(reg.startRow + 2, reg.startCol));
      const badge = page.locator("span", { hasText: /^Year$/ }).locator("xpath=following-sibling::span[@title and contains(@title,'Lookup')]").first();
      await badge.waitFor({ state: "visible", timeout: 15_000 });
      await badge.click();
      await eventually(() => badge.textContent(), (t) => (t ?? "").trim() === "L", "precondition: the badge did not switch Year to Lookup");
      await page.waitForTimeout(2500);
      expect(await hasDouble(), "the calculated column survives the Lookup toggle").toBe(true);
      expect(await gtRows(), "the layout (grand totals off) survives the Lookup toggle").toBe(0);
    } finally {
      await newFile(page);
      await dropModel(page, conn);
    }
  });
});

// ===========================================================================
// I. On a canvas (wa-pivot P8, wb-slicer S4/S5/A4)
// ===========================================================================

const BOX = { x: 64, y: 64, width: 320, height: 240 };

/** Sheet1 = TL_DATA; a canvas with a pivot box (Product rows) sourced from it. */
async function canvasWithPivotBox(page: Page): Promise<{ canvas: number; pid: string }> {
  await writeTable(page, TL_DATA);
  const cv = await addCanvas(page);
  const view = await callModule<{ pivotId: string }>(page, MOD.PIVOT_API, "createPivotTable", [
    { sourceRange: "Sheet1!A1:C6", destinationCell: "A1", sourceSheet: 0, destinationSheet: cv.index, hasHeaders: true, name: "BoxPivot", canvasFrame: { ...BOX, frozenHeaders: true } },
  ]);
  const pid = String(view.pivotId);
  await callModule(page, MOD.PIVOT_API, "updatePivotFields", [
    { pivotId: pid, rowFields: [{ sourceIndex: 1, name: "Product" }], valueFields: [SUM_SALES] },
  ]);
  await page.evaluate(() => window.dispatchEvent(new Event("pivot:refresh")));
  await eventually(
    () => page.evaluate((id) => !!(window as unknown as { __CALCULA_PIVOT__?: { getVisualState: (id: string) => unknown } }).__CALCULA_PIVOT__?.getVisualState(id), pid),
    (v) => v,
    "the pivot box never painted",
    15_000,
  );
  return { canvas: cv.index, pid };
}

async function visibleMenuLabels(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]'))
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => (el.textContent ?? "").trim()),
  );
}

async function selectedObjectTypes(page: Page): Promise<string[]> {
  const regs = await callModule<Array<{ type: string }>>(page, MOD.OBJECT_SELECTION, "getSelectedObjectRegions", []);
  return regs.map((r) => r.type);
}

test.describe("I. on a canvas", () => {
  test("P8: right-clicking a canvas pivot box opens the PIVOT menu (Refresh, Sort; no Cut, no Insert Row); Refresh works; Escape closes it and the box stays selected", async ({ appPage: page }) => {
    try {
      await newFile(page);
      const { pid } = await canvasWithPivotBox(page);
      const p = await sheetPointToPage(page, BOX.x + 60, BOX.y + 40);
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(400);
      await page.mouse.click(p.x, p.y, { button: "right" });
      const labels = await eventually(() => visibleMenuLabels(page), (l) => l.length > 0, "no menu opened on the pivot box");
      expect(labels.some((l) => /^Refresh/.test(l)), `the pivot menu has Refresh: ${JSON.stringify(labels)}`).toBe(true);
      expect(labels.some((l) => /^Sort/.test(l)), `the pivot menu has Sort: ${JSON.stringify(labels)}`).toBe(true);
      expect(labels.some((l) => /^Cut/.test(l) || /Insert Row/i.test(l)), `no cell items (Cut, Insert Row): ${JSON.stringify(labels)}`).toBe(false);

      // Escape closes the menu, the box stays selected.
      await page.keyboard.press("Escape");
      await eventually(() => visibleMenuLabels(page), (l) => l.length === 0, "Escape did not close the pivot menu");
      const vis = await page.evaluate((id) => (window as unknown as { __CALCULA_PIVOT__: { getVisualState: (id: string) => { selected: boolean } | null } }).__CALCULA_PIVOT__.getVisualState(id), pid);
      expect(vis?.selected, "the box stays selected after Escape").toBe(true);

      // Refresh from the menu: a changed source value reaches the box.
      await activateSheet(page, 0);
      await writeCells(page, [[1, 2, "100"]]); // Jan Apples 1 -> 100
      const cvIdx = (await sheets(page)).sheets.find((s) => s.kind === "canvas")!.index;
      await activateSheet(page, cvIdx);
      const before = (await rowMap(page, pid)).Apples;
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(300);
      await page.mouse.click(p.x, p.y, { button: "right" });
      await page.locator('[role="menu"] [role="menuitem"]').filter({ hasText: /^Refresh/ }).first().click();
      await eventually(() => rowMap(page, pid).then((m) => m.Apples), (v) => v === "102", `menu Refresh did not re-read the source (Apples was ${before})`, 15_000);
    } finally {
      await newFile(page);
    }
  });

  test("S4: right-clicking a slicer on a canvas then Escape closes the menu; the slicer stays selected and the Slicer tab stays", async ({ appPage: page }) => {
    try {
      await newFile(page);
      const { canvas, pid } = await canvasWithPivotBox(page);
      const sid = await createPivotSlicer(page, pid, "Product", canvas, 480, 64);
      await page.waitForTimeout(600);
      const p = await sheetPointToPage(page, 480 + 60, 64 + 10);
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(400);
      await page.mouse.click(p.x, p.y, { button: "right" });
      await expect(page.getByText("Remove Slicer", { exact: true }), "the slicer menu opened").toBeVisible({ timeout: 10_000 });
      await page.keyboard.press("Escape");
      await expect(page.getByText("Remove Slicer", { exact: true }), "Escape closed the slicer menu").toHaveCount(0, { timeout: 5000 });
      expect(await selectedObjectTypes(page), "the slicer stays selected").toContain("slicer");
      const tabs = (await page.evaluate(() => {
        const band = document.querySelector("[data-ribbon-content]");
        const strip = band?.parentElement?.querySelector("div");
        return Array.from(strip?.querySelectorAll("button") ?? []).map((b) => (b.textContent ?? "").trim());
      })) as string[];
      expect(tabs.some((t) => /slicer/i.test(t)), `the Slicer tab is still shown: ${JSON.stringify(tabs)}`).toBe(true);
      expect(sid).toBeTruthy();
    } finally {
      await newFile(page);
    }
  });

  test("S5: with a floating-grid edit (=) parked on a worksheet that has a slicer and a timeline, right-clicking where each sits opens neither menu", async ({ appPage: page }) => {
    try {
      await newFile(page);
      const { pid, tid } = await setupTimeline(page, 470, 240);
      const sid = await createPivotSlicer(page, pid, "Product", 0, 470, 20);
      const cv = await addCanvas(page);
      const fr = await callModule<{ id: string }>(page, "/src/api/floatingRanges.ts", "createFloatingRange", [640, 96, "FloatS5"]);
      await page.waitForTimeout(800);
      const a1 = await sheetPointToPage(page, 640 + FLOAT_A1.dx, 96 + FLOAT_A1.dy);
      await page.mouse.dblclick(a1.x, a1.y);
      await page.waitForTimeout(300);
      await page.keyboard.type("=");
      await page.locator('button[data-sheet-tab="0"]').click();
      await eventually(() => sheets(page), (r) => r.activeIndex === 0, "the point-mode tab click did not show Sheet1");
      await page.waitForTimeout(600);
      const t = (await timelineRow(page, tid))!;
      const s = (await callModule<{ x: number; y: number }>(page, MOD.SLICER_STORE, "getSlicerById", [sid]))!;
      for (const [label, sx, sy, menuItem] of [
        ["slicer", s.x + 40, s.y + 10, "Remove Slicer"],
        ["timeline", t.x + 40, t.y + 10, "Remove Timeline"],
      ] as Array<[string, number, number, string]>) {
        const pt = await sheetPointToPage(page, sx, sy);
        await page.mouse.click(pt.x, pt.y, { button: "right" });
        await page.waitForTimeout(700);
        expect(await page.getByText(menuItem, { exact: true }).count(), `no ${label} menu while a floating-grid formula is parked here`).toBe(0);
        await page.keyboard.press("Escape").catch(() => undefined);
        await page.waitForTimeout(200);
      }
      expect(fr.id && cv.index).toBeTruthy();
    } finally {
      await page.keyboard.press("Escape").catch(() => undefined);
      await newFile(page);
    }
  });

  test("A4/W26: on a canvas, a pivot box, a slicer, a timeline and a chart selected together are all deleted by Delete, and ONE Ctrl+Z brings all four back", async ({ appPage: page }) => {
    try {
      await newFile(page);
      const { canvas, pid } = await canvasWithPivotBox(page);
      const sid = await createPivotSlicer(page, pid, "Product", canvas, 420, 64);
      const tl = await callModule<TimelineRow | null>(page, MOD.TIMELINE_STORE, "createTimelineAsync", [
        { name: "Date", sheetIndex: canvas, x: 64, y: 340, width: 400, height: 140, sourceId: pid, fieldName: "Date", level: "months" },
      ]);
      expect(tl, "precondition: a timeline on the canvas").toBeTruthy();
      const sheet1Id = (await sheets(page)).sheets.find((s) => s.index === 0)!.sheetId;
      const chartId = await page.evaluate(
        async ({ mod, sheet1Id, canvas }) => {
          const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, (...a: unknown[]) => unknown>> };
          const store = await w.__appImport(mod);
          const created = store.createChart(
            {
              mark: "bar",
              data: { sheetIndex: 0, sheetId: sheet1Id, startRow: 0, startCol: 1, endRow: 5, endCol: 2 },
              hasHeaders: true,
              seriesOrientation: "columns",
              categoryIndex: 0,
              series: [{ sourceIndex: 1, name: "Sales", color: "#4472C4" }],
              title: "A4",
            },
            { sheetIndex: canvas, x: 640, y: 64, width: 320, height: 220, name: "A4Chart" },
          ) as { chartId: string };
          store.syncChartRegions();
          return created.chartId;
        },
        { mod: MOD.CHART_STORE, sheet1Id, canvas },
      );
      await page.waitForTimeout(1200);
      const counts = async () => ({
        pivot: (await pivotRegions(page)).filter((r) => String(r.pivotId) === pid).length,
        slicer: (await callModule<SlicerRow[]>(page, MOD.SLICER_STORE, "getAllSlicers", [])).filter((s) => s.id === sid).length,
        timeline: (await callModule<TimelineRow[]>(page, MOD.TIMELINE_STORE, "getAllTimelines", [])).filter((t) => t.id === tl!.id).length,
        chart: (await invoke<Array<{ id: string }>>(page, "get_charts")).filter((c) => c.id === chartId).length,
      });
      expect(await counts(), "precondition: all four exist").toEqual({ pivot: 1, slicer: 1, timeline: 1, chart: 1 });

      // Marquee from the empty page over all four.
      const from = await sheetPointToPage(page, 20, 20);
      const to = await sheetPointToPage(page, 1000, 500);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
      await page.mouse.move(to.x, to.y, { steps: 5 });
      await page.mouse.up();
      const sel = await eventually(() => selectedObjectTypes(page), (t) => t.length >= 4, "the marquee did not select the four objects");
      expect(sel.length, `four objects selected: ${JSON.stringify(sel)}`).toBe(4);

      await page.keyboard.press("Delete");
      await eventually(counts, (c) => c.pivot + c.slicer + c.timeline + c.chart === 0, "Delete did not delete all four", 15_000);
      await pressUndo(page);
      await eventually(counts, (c) => c.pivot + c.slicer + c.timeline + c.chart === 4, "ONE Ctrl+Z did not bring all four back", 15_000);
    } finally {
      await newFile(page);
    }
  });
});

// ===========================================================================
// J. Slow model: a click still landing (wb-slicer S1, wc-undo W4), ribbon
//    filter undo (wb-slicer S2)
// ===========================================================================

const FILTER_STORE = "/extensions/ControlsPane/lib/filterPaneStore.ts";
const STILL_APPLYING = /still being applied/i;
/** A DirectQuery table over a large CSV: every re-query re-reads the file. */
const SLOW_ROWS = 1_500_000;

async function createRibbonFilter(page: Page, connectionId: string, column: string): Promise<string> {
  const f = await callModule<{ id: string } | null>(page, FILTER_STORE, "createFilterAsync", [
    { name: `${column}Filter`, connectionId, fieldName: `Sales.${column}`, connectionMode: "workbook" },
  ]);
  expect(f, `precondition: a ribbon filter on ${column}`).toBeTruthy();
  await callModule(page, FILTER_STORE, "refreshFilterItems", [f!.id], 120_000);
  return f!.id;
}

async function filterSelection(page: Page, id: string): Promise<string[] | null> {
  const f = await callModule<{ selectedItems: string[] | null } | undefined>(page, FILTER_STORE, "getFilterById", [id]);
  return f?.selectedItems ?? null;
}

/**
 * Hold ONE backend command of an extension's channel for `ms` before it is
 * sent, so a gesture is reliably still LANDING while the test acts. The
 * DirectQuery source is fast since the aggregate pushdown fix (~150 ms a
 * re-query): the click landed before X was typed, and the first Ctrl+Z took X
 * back (fix-all run 4). The channel is re-bound to exactly what the host binds
 * a built-in extension (`createScopedInvokeBackend(true, invokeBackend)`) with
 * the hold added; the returned function restores the plain binding. What this
 * does NOT exercise is X reaching the backend WHILE the gesture command runs
 * -- the backend's PendingGesture refusal and step ordering are the Rust
 * tests' job.
 */
async function holdBackendCommand(
  page: Page,
  channelModule: string,
  channelExport: string,
  command: string,
  ms: number,
): Promise<() => Promise<void>> {
  await installAppImport(page);
  const bind = (hold: boolean) =>
    page.evaluate(
      async ({ channelModule, channelExport, command, ms, hold }) => {
        const w = window as unknown as AppWindow;
        const bc = (await w.__appImport!("/src/api/backendCommands.ts")) as {
          createScopedInvokeBackend: (trusted: boolean, raw: unknown) => (c: string, a?: unknown) => Promise<unknown>;
        };
        const be = (await w.__appImport!("/src/api/backend.ts")) as { invokeBackend: unknown };
        const scoped = bc.createScopedInvokeBackend(true, be.invokeBackend);
        const channel = ((await w.__appImport!(channelModule)) as Record<string, { set: (f: unknown) => void }>)[channelExport];
        channel.set(
          hold
            ? (c: string, a?: unknown) =>
                c === command ? new Promise((r) => setTimeout(r, ms)).then(() => scoped(c, a)) : scoped(c, a)
            : scoped,
        );
      },
      { channelModule, channelExport, command, ms, hold },
    );
  await bind(true);
  return async () => {
    await bind(false);
  };
}

/**
 * The shared S1 sequence: start a user gesture (not awaited), prove it is
 * still LANDING, press Ctrl+Z (refused, with the sentence), type X into A30
 * meanwhile; after it lands the first Ctrl+Z takes back the gesture and keeps
 * X, Ctrl+Y re-applies it, and a later Ctrl+Z pair removes X.
 */
async function slowGestureUndoSequence(
  page: Page,
  grid: GridHelper,
  opts: {
    key: string;
    start: () => Promise<void>;
    landing: () => Promise<boolean>;
    applied: () => Promise<boolean>;
    restored: () => Promise<boolean>;
    /** Hold the gesture's backend command so it is still landing while the test acts. */
    hold?: { channelModule: string; channelExport: string; command: string };
  },
): Promise<void> {
  await startToastLog(page);
  const depth0 = (await undoState(page)).undoDepth;
  const release = opts.hold
    ? await holdBackendCommand(page, opts.hold.channelModule, opts.hold.channelExport, opts.hold.command, 8000)
    : null;
  try {
    await opts.start();
    await eventually(opts.landing, (v) => v, "precondition: the gesture is still landing (the source is not slow enough to test mid-click)", 5000);
    expect((await undoState(page)).transactionOpen, "while the click lands no undo transaction is held open").toBe(false);

    // Ctrl+Z mid-click: refused with one sentence, nothing undone. The click may
    // LAND while the toast is awaited -- its own step is then on the history --
    // so mid-click the depth only must not have dropped; the exact count (X and
    // the click, nothing taken back) is asserted once it has landed.
    await pressUndo(page);
    await eventually(() => toastLog(page), (t) => t.some((x) => STILL_APPLYING.test(x.text)), "Ctrl+Z mid-click gave no 'still being applied' toast");
    expect((await toastLog(page)).filter((x) => STILL_APPLYING.test(x.text)).length, "exactly one such toast").toBe(1);
    expect((await undoState(page)).undoDepth, "nothing was undone mid-click").toBeGreaterThanOrEqual(depth0);

    // Type X meanwhile.
    await grid.clickCell("A30");
    await page.keyboard.type("X");
    await page.keyboard.press("Enter");
    await eventually(() => cellAt(page, 0, 29, 0).then((c) => c?.display ?? ""), (v) => v === "X", "X was not written while the click landed", 20_000);
    // The whole point of the sequence: X went on the history BEFORE the click.
    expect(await opts.landing(), "X was written after the click had already landed (the hold did not hold)").toBe(true);

    await eventually(opts.landing, (v) => !v, "the gesture never landed", 120_000);
  } finally {
    if (release) await release();
  }
  await eventually(opts.applied, (v) => v, "the gesture did not apply", 60_000);
  expect((await undoState(page)).undoDepth, "two steps: the X edit and the click").toBe(depth0 + 2);

  await pressUndo(page);
  await eventually(opts.restored, (v) => v, "the first Ctrl+Z did not take back the click", 60_000);
  expect((await cellAt(page, 0, 29, 0))?.display, "the first Ctrl+Z keeps X").toBe("X");
  await pressRedo(page);
  await eventually(opts.applied, (v) => v, "Ctrl+Y did not re-apply the click", 60_000);
  await pressUndo(page);
  await eventually(opts.restored, (v) => v, "Ctrl+Z (again) did not take back the click", 60_000);
  await pressUndo(page);
  await eventually(() => cellAt(page, 0, 29, 0).then((c) => c?.display ?? ""), (v) => v === "", "the second Ctrl+Z did not remove X", 20_000);
}

test.describe("J. slow model: a click still landing; ribbon filter undo", () => {
  test("S1 (model slicer, slow): mid-click Ctrl+Z is refused with 'still being applied'; X typed meanwhile is its own step; the first Ctrl+Z restores slicer and pivot and keeps X; Ctrl+Y redoes; the next removes X", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(600_000);
    let conn: { connectionId: string; dir: string } | null = null;
    try {
      await newFile(page);
      conn = await connectModel(page, "FixAll slow S1", [], { storage: "direct_query", extraRows: SLOW_ROWS });
      const pid = await modelPivot(page, conn.connectionId, 0);
      await eventually(() => rowOrder(page, pid), (o) => o.length === 4, "the slow model pivot never answered", 120_000);
      const sid = await createModelSlicer(page, conn.connectionId, "Region", 0);
      await eventually(() => slicerItems(page, sid), (i) => i.length === 4, "the model slicer shows no items", 120_000);
      await slowGestureUndoSequence(page, grid, {
        key: "s1",
        hold: { channelModule: "/extensions/Slicer/lib/slicerBackend.ts", channelExport: "slicerBackend", command: "update_slicer_selection" },
        start: () => startInPage(page, "s1click", MOD.SLICER_STORE, "clickSlicerItem", [sid, "East", false]),
        landing: () => callModule<boolean>(page, MOD.SLICER_STORE, "isSlicerGestureLanding", []),
        applied: async () => JSON.stringify(await rowOrder(page, pid)) === '["East"]' && JSON.stringify(await slicerSelection(page, sid)) === '["East"]',
        restored: async () => (await rowOrder(page, pid)).length === 4 && ((await slicerSelection(page, sid)) ?? []).length === 0,
      });
    } finally {
      await newFile(page);
      await dropModel(page, conn);
    }
  });

  test("S1 (ribbon filter, slow): the same -- mid-change Ctrl+Z refused with 'still being applied', X its own step, Ctrl+Z / Ctrl+Y on the change", async ({ appPage: page, grid }) => {
    test.setTimeout(600_000);
    let conn: { connectionId: string; dir: string } | null = null;
    try {
      await newFile(page);
      conn = await connectModel(page, "FixAll slow ribbon", [], { storage: "direct_query", extraRows: SLOW_ROWS });
      const pid = await modelPivot(page, conn.connectionId, 0);
      await eventually(() => rowOrder(page, pid), (o) => o.length === 4, "the slow model pivot never answered", 120_000);
      const fid = await createRibbonFilter(page, conn.connectionId, "Region");
      await slowGestureUndoSequence(page, grid, {
        key: "s1r",
        hold: { channelModule: "/extensions/ControlsPane/lib/filterPaneBackend.ts", channelExport: "filterPaneBackend", command: "update_ribbon_filter_selection" },
        start: () => startInPage(page, "s1rclick", FILTER_STORE, "updateFilterSelectionAsync", [fid, ["East"]]),
        landing: () => callModule<boolean>(page, FILTER_STORE, "isRibbonFilterChangeLanding", []),
        applied: async () => JSON.stringify(await rowOrder(page, pid)) === '["East"]' && JSON.stringify(await filterSelection(page, fid)) === '["East"]',
        restored: async () => (await rowOrder(page, pid)).length === 4 && ((await filterSelection(page, fid)) ?? []).length === 0,
      });
    } finally {
      await newFile(page);
      await dropModel(page, conn);
    }
  });

  test("W4 (level-2 slicer on a column the pivot lacks, slow): Ctrl+Z while 'Applying filter...' is refused with one toast; after it lands Ctrl+Z undoes it and Ctrl+Y redoes it", async ({ appPage: page }) => {
    test.setTimeout(600_000);
    let conn: { connectionId: string; dir: string } | null = null;
    try {
      await newFile(page);
      conn = await connectModel(page, "FixAll slow W4", [], { storage: "direct_query", extraRows: SLOW_ROWS });
      const pid = await modelPivot(page, conn.connectionId, 0);
      const all = await eventually(() => rowMap(page, pid), (m) => !!m["Grand Total"], "the slow model pivot never answered", 120_000);
      const sid = await createModelSlicer(page, conn.connectionId, "Year", 0, 2);
      await eventually(() => slicerItems(page, sid), (i) => i.length === 2, "the Year slicer shows no items", 120_000);
      await startToastLog(page);
      const depth0 = (await undoState(page)).undoDepth;
      await startInPage(page, "w4click", MOD.SLICER_STORE, "clickSlicerItem", [sid, "2024", false]);
      await eventually(() => callModule<boolean>(page, MOD.SLICER_STORE, "isSlicerGestureLanding", []), (v) => v, "precondition: the filter is still applying", 5000);
      await pressUndo(page);
      await eventually(() => toastLog(page), (t) => t.some((x) => STILL_APPLYING.test(x.text)), "Ctrl+Z while applying gave no 'still being applied' toast");
      // The click may land while the toast is awaited (its step then counts):
      // never below depth0 here, exactly one step once it has landed.
      expect((await undoState(page)).undoDepth, "nothing undone while applying").toBeGreaterThanOrEqual(depth0);
      await eventually(() => callModule<boolean>(page, MOD.SLICER_STORE, "isSlicerGestureLanding", []), (v) => !v, "the filter never landed", 120_000);
      expect((await undoState(page)).undoDepth, "the refused Ctrl+Z took nothing back: exactly the click's step").toBe(depth0 + 1);
      const filtered = await eventually(() => rowMap(page, pid), (m) => m["Grand Total"] !== all["Grand Total"], "the level-2 Year filter did not change the pivot", 60_000);
      expect(Number(filtered["Grand Total"]), "2024 is half the rows").toBe(Number(all["Grand Total"]) / 2);
      await pressUndo(page);
      await eventually(() => rowMap(page, pid).then((m) => m["Grand Total"]), (g) => g === all["Grand Total"], "Ctrl+Z did not undo the filter", 60_000);
      await pressRedo(page);
      await eventually(() => rowMap(page, pid).then((m) => m["Grand Total"]), (g) => g === filtered["Grand Total"], "Ctrl+Y did not redo the filter", 60_000);
    } finally {
      await newFile(page);
      await dropModel(page, conn);
    }
  });

  test("S2 (ribbon Ctrl+Z / delete): East -> West then Ctrl+Z shows East again and Ctrl+Y West; a filter selecting East deleted and Ctrl+Z brings the card back with East and its pivot filtered", async ({ appPage: page }) => {
    let conn: { connectionId: string; dir: string } | null = null;
    try {
      await newFile(page);
      conn = await connectModel(page, "FixAll S2 ribbon", BLANK_ROWS.filter((r) => r.region !== null));
      const pid = await modelPivot(page, conn.connectionId, 0);
      await eventually(() => rowOrder(page, pid), (o) => o.length === 3, "the model pivot never answered", 20_000);
      const fid = await createRibbonFilter(page, conn.connectionId, "Region");
      await callModule(page, FILTER_STORE, "updateFilterSelectionAsync", [fid, ["East"]]);
      await eventually(() => rowOrder(page, pid), (o) => JSON.stringify(o) === '["East"]', "East did not apply");
      await callModule(page, FILTER_STORE, "updateFilterSelectionAsync", [fid, ["West"]]);
      await eventually(() => rowOrder(page, pid), (o) => JSON.stringify(o) === '["West"]', "West did not apply");
      await pressUndo(page);
      await eventually(() => rowOrder(page, pid), (o) => JSON.stringify(o) === '["East"]', "Ctrl+Z did not show East again");
      expect(await filterSelection(page, fid)).toEqual(["East"]);
      await pressRedo(page);
      await eventually(() => rowOrder(page, pid), (o) => JSON.stringify(o) === '["West"]', "Ctrl+Y did not show West again");

      // Delete the filter (its card's delete), then Ctrl+Z.
      await callModule(page, FILTER_STORE, "deleteFilterAsync", [fid]);
      await eventually(() => rowOrder(page, pid), (o) => o.length === 3, "deleting the filter did not clear its filter");
      expect(await callModule(page, FILTER_STORE, "getFilterById", [fid])).toBeFalsy();
      await pressUndo(page);
      await eventually(() => callModule(page, FILTER_STORE, "getFilterById", [fid]).then((f) => !!f), (v) => v, "Ctrl+Z did not bring the filter card back");
      expect(await filterSelection(page, fid), "the card comes back with its selection").toEqual(["West"]);
      await eventually(() => rowOrder(page, pid), (o) => JSON.stringify(o) === '["West"]', "the pivot is not filtered again after Ctrl+Z");
    } finally {
      await newFile(page);
      await dropModel(page, conn);
    }
  });
});

// ===========================================================================
// K. Found while proving the checks above (probe)
// ===========================================================================

test.describe("K. found live", () => {
  test("CTX (probe): back on a pivot's sheet with its cell still active, the Pivot Table tab shows and Sheet1's Table Design tab does not", async ({ appPage: page, grid }) => {
    try {
      await newFile(page);
      await writeTable(page, DS1);
      await callModule(page, "/extensions/Table/lib/tableStore.ts", "createTableAsync", [
        { sheetIndex: 0, startRow: 0, startCol: 0, endRow: 4, endCol: 2, hasHeaders: true },
      ]);
      const s2 = await addWorksheet(page);
      const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:C5", destinationCell: "A1", sourceSheet: 0, destinationSheet: s2.index });
      await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 0, name: "Region" }], valueFields: [SUM_SALES] });
      const tabLabels = async () => (await ribbonTabsOf(page)).map((t) => t.label);

      await grid.clickCell("H10");
      await grid.clickCell("B2");
      await eventually(tabLabels, (t) => t.includes("Pivot Table"), "control: selecting a pivot cell shows the Pivot Table tab");

      await activateSheet(page, 0);
      await grid.clickCell("B2");
      await eventually(tabLabels, (t) => t.includes("Table Design"), "control: a table cell shows Table Design");

      await activateSheet(page, s2.index);
      await page.waitForTimeout(800);
      const back = await tabLabels();
      expect.soft(back, "Sheet1's Table Design tab must not stay up on the pivot sheet").not.toContain("Table Design");
      expect(back, "the pivot sheet's active cell B2 is in the pivot: its tab should show").toContain("Pivot Table");
    } finally {
      await newFile(page);
    }
  });
});

async function ribbonTabsOf(page: Page): Promise<Array<{ label: string }>> {
  return page.evaluate(() => {
    const band = document.querySelector("[data-ribbon-content]");
    const strip = band?.parentElement?.querySelector("div");
    return Array.from(strip?.querySelectorAll("button") ?? []).map((b) => ({ label: (b.textContent ?? "").trim() }));
  });
}

test.describe("K. found live (timeline dates)", () => {
  test("TL-NUM (found live): a timeline over TYPED dates (numbers: 2026-01-10 = 46032) lists 2026's months, not year -2688", async ({ appPage: page }) => {
    try {
      await newFile(page);
      await writeTable(page, TL_DATA.map((r, i) => (i === 0 ? r : [String(r[0]).replace(/^'/, ""), r[1], r[2]])));
      const c = await cellAt(page, 0, 1, 0);
      expect([c?.type, c?.value, c?.display], "precondition: a typed ISO date is a date number").toEqual(["number", 46032, "2026-01-10"]);
      const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:C6", destinationCell: "E1", sourceSheet: 0, destinationSheet: 0 });
      await configurePivot(page, { pivotId: pid, rowFields: [{ sourceIndex: 1, name: "Product" }], valueFields: [SUM_SALES] });
      const tl = await callModule<{ id: string } | null>(page, MOD.TIMELINE_STORE, "createTimelineAsync", [
        { name: "Date", sheetIndex: 0, x: 470, y: 180, width: 420, height: 140, sourceId: pid, fieldName: "Date", level: "months" },
      ]);
      await page.waitForTimeout(600);
      const data = await callModule<{ minDate: string; maxDate: string; periods: Array<{ startDate: string }> }>(page, MOD.TIMELINE_STORE, "getCachedTimelineData", [tl!.id]);
      expect.soft(
        { min: data.minDate, max: data.maxDate, periods: data.periods.map((p) => p.startDate) },
        "the timeline's range is the data's (2026-01-10 .. 2026-03-03)",
      ).toEqual({ min: "2026-01-10", max: "2026-03-03", periods: ["2026-01-01", "2026-02-01", "2026-03-01"] });
      expect.soft(await invoke<string[]>(page, "get_pivot_date_fields", { pivotId: pid }), "only Date is offered as a date field (not Sales)").toEqual(["Date"]);
    } finally {
      await newFile(page);
    }
  });
});

test.describe("E2. slicer dialog saves", () => {
  test("S2 (dialog save): Report Connections -- unticking the pivot a filtering slicer narrows grows it over the user's cell; ONE question, and Cancel restores the cell, the connection and the filter", async ({
    appPage: page,
  }) => {
    try {
      await newFile(page);
      const { pid, sid } = await setupSlicerOverwrite(page);
      const pivotName = String((await pivotInfo(page, pid)).name);
      const s = (await callModule<{ x: number; y: number }>(page, MOD.SLICER_STORE, "getSlicerById", [sid]))!;
      const openConnections = async () => {
        const p = await sheetPointToPage(page, s.x + 40, s.y + 10);
        await page.mouse.click(p.x, p.y, { button: "right" });
        await page.getByText("Report Connections...", { exact: true }).click();
        const dialog = page.locator("h2", { hasText: /^Report Connections$/ }).locator("xpath=../..");
        await expect(dialog).toBeVisible({ timeout: 10_000 });
        await dialog.locator("label", { hasText: pivotName }).locator('input[type="checkbox"]').waitFor({ state: "visible", timeout: 10_000 });
        return dialog;
      };
      const connected = async () =>
        ((await callModule<{ connectedSources?: Array<{ sourceId: string }> }>(page, MOD.SLICER_STORE, "getSlicerById", [sid]))?.connectedSources ?? []).map((c) => String(c.sourceId));
      expect(await connected(), "precondition: the slicer filters the pivot").toContain(pid);

      let dialog = await openConnections();
      await dialog.locator("label", { hasText: pivotName }).locator('input[type="checkbox"]').uncheck();
      await dialog.getByRole("button", { name: /^OK$/ }).click();
      const v = answerDialog("Cancel");
      expect(v.notFound, `unticking a connection that grows the pivot did not ask (driver: ${v.raw})`).toBe(false);
      expect(v.text).toMatch(/overwrite existing data/i);
      await page.waitForTimeout(800);
      const again = readDialog(2000);
      if (!again.notFound) answerDialog("Cancel", 2000);
      expect(again.notFound, "ONE question").toBe(true);
      await eventually(() => cellAt(page, 0, 3, 3).then((c) => c?.display ?? ""), (d) => d === "V", "Cancel did not restore the user's cell");
      await eventually(connected, (c) => c.includes(pid), "Cancel did not restore the connection");
      await eventually(() => rowOrder(page, pid), (r) => JSON.stringify(r) === '["North"]', "Cancel did not restore the filter");

      // Control: OK keeps the unfiltered pivot.
      dialog = await openConnections();
      await dialog.locator("label", { hasText: pivotName }).locator('input[type="checkbox"]').uncheck();
      await dialog.getByRole("button", { name: /^OK$/ }).click();
      const ok = answerDialog("OK");
      expect(ok.notFound, `the control asked too: ${ok.raw}`).toBe(false);
      await eventually(() => rowOrder(page, pid), (r) => r.length === 4, "OK did not keep the disconnected (unfiltered) pivot");
    } finally {
      await newFile(page);
    }
  });
});
