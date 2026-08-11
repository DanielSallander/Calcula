/**
 * LIVE PROOFS for four register items that were closed by unit tests and
 * source-level censuses, and had never been driven through the real WebView.
 *
 * WHAT IS ASSERTED, and why each one needs the running app
 *
 *   1. §2aj — A STRUCTURED REFERENCE STAYS LIVE. `=SUM(Sales[Amount])` typed
 *      into a real cell must be STORED as the structured reference (the
 *      formula bar shows it, not `=SUM($A$2:$A$4)`), and when the table GROWS
 *      through the real auto-expand gesture — typing a value in the row under
 *      it — the rendered total must follow. Before the fix the total stayed
 *      60 forever and the formula bar showed absolute coordinates for a
 *      formula nobody typed. Unit tests cannot show this: the defect was in
 *      `split_entered_formula`, which only the typed-entry path reaches, and
 *      the auto-expand only happens when a keystroke lands under a table.
 *
 *   2. §2ai — A SHEET QUALIFIER KEEPS ITS CASING. `=Data!A1` must read
 *      `=Data!A1` in the formula bar, must still read that after a save and a
 *      reload from disk, and must FOLLOW a rename of the sheet it names —
 *      including a rename that only changes case. The lexer upper-cases the
 *      qualifier, so every one of those is a restamp that has to fire on a
 *      different route (entry, load, repair).
 *
 *   3. ERROR PARITY — `=SQRT(-1)` and `=LOG(0)` render Excel's `#NUM!`, not
 *      `#VALUE!`, and the rendering survives a save/reload.
 *
 *   4. ERROR PARITY — a dynamic array blocked by an occupied cell renders
 *      Excel's `#SPILL!`, the error pane NAMES THE BLOCKING CELL (which is the
 *      only thing that makes `#SPILL!` worth having as its own error), and
 *      both survive a save/reload. `spill_blocks` is in-memory state rebuilt
 *      by evaluation, so the reload half is a genuine question and not a
 *      formality.
 *
 * WHY A JOURNEY AND NOT A FUNCTIONAL SPEC. Every test starts from File > New
 * and three of them save the document to disk and open it again. The
 * functional specs share ONE accumulating workbook whose screenshot goldens
 * encode the residue of everything that ran before them, so a spec that wipes
 * or re-identifies the document belongs here.
 *
 * VACUOUS-PASS DISCIPLINE. Every "must be X after the gesture" is preceded by
 * a "must be Y before it", read by the SAME reader, so each assertion is a
 * real transition and not a value that never moved. Where the pre-state is
 * itself the thing under test it is asserted against the OLD WRONG ANSWER by
 * name (`not.toBe("=SUM($A$2:$A$4)")`), so a regression to the defect fails
 * here rather than passing quietly.
 *
 * READERS. `get_cell` is what the formula bar binds to and `get_viewport_cells`
 * is what GridCanvas asks for the strings it paints; both are used, because a
 * value that is right in one and wrong in the other is exactly the class of
 * defect this file exists to catch.
 *
 * LOCALE. sv-SE: a formula typed into a CELL uses ';' as the argument
 * separator, never ','.
 *
 * GRID REAL ESTATE. Columns A..E of a workbook each test creates from
 * File > New, so nothing is shared with any other spec.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { parseCellRef, type GridHelper } from "../helpers/grid";

const FILE = path.join(os.tmpdir(), "calcula-live-parity-proofs.cala");

// ===========================================================================
// Plumbing — setup and oracles only, never the thing under test
// ===========================================================================

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

/** Call an exported function of one of the app's OWN modules, in its own realm. */
async function callModule<T = unknown>(
  page: Page,
  modulePath: string,
  fn: string,
  args: unknown[] = [],
): Promise<T> {
  return page.evaluate(
    async ({ modulePath, fn, args }) => {
      const m = (await (
        window as unknown as { __calcImport: (u: string) => Promise<unknown> }
      ).__calcImport(new URL(modulePath, document.baseURI).href)) as Record<
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

/**
 * Wipe the workbook through the app's OWN File > New path, not a raw
 * `invoke("new_file")` — the wrapper is what announces the change, and a spec
 * that starts from the bypass starts with fixtures describing the last
 * document.
 */
async function newFile(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await callModule(page, "/src/core/lib/file-api.ts", "newFile");
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("dimensions:refresh"));
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await page.waitForTimeout(900);
}

async function openAt(page: Page, target: string): Promise<void> {
  await callModule(page, "/src/core/lib/file-api.ts", "openFileAtPath", [target]);
  await page.waitForTimeout(2500);
}

async function saveTo(page: Page, target: string): Promise<void> {
  await invoke(page, "save_file", { path: target });
  await page.waitForTimeout(600);
}

interface CellSnapshot {
  /** What the formula bar binds to. */
  display: string;
  formula: string;
}

async function cell(page: Page, ref: string): Promise<CellSnapshot> {
  const { row, col } = parseCellRef(ref);
  const c = await invoke<{ display?: string; formula?: string | null } | null>(page, "get_cell", {
    row,
    col,
  });
  return { display: c?.display ?? "", formula: c?.formula ?? "" };
}

/** The string GridCanvas actually paints for a cell of the ACTIVE sheet. */
async function painted(page: Page, ref: string): Promise<string> {
  const { row, col } = parseCellRef(ref);
  const cells = await invoke<Array<{ display: string }>>(page, "get_viewport_cells", {
    startRow: row,
    startCol: col,
    endRow: row,
    endCol: col,
  });
  return String(cells[0]?.display ?? "");
}

async function sheetNames(page: Page): Promise<string[]> {
  const res = await invoke<{ sheets: Array<{ name: string }> }>(page, "get_sheets");
  return res.sheets.map((s) => s.name);
}

/** The spill map as `[originRow, originCol, endRow, endCol]` rows. */
async function spillMap(page: Page): Promise<number[][]> {
  const ranges = await invoke<
    Array<{ originRow: number; originCol: number; endRow: number; endCol: number }>
  >(page, "get_spill_ranges");
  return (Array.isArray(ranges) ? ranges : []).map((r) => [
    r.originRow,
    r.originCol,
    r.endRow,
    r.endCol,
  ]);
}

/**
 * Excel's F9, as a KEYSTROKE. The handler is in `useGridKeyboard` and only
 * fires while the spreadsheet container holds focus, so the focus move is part
 * of the gesture and not scaffolding — `navigateTo` ends by focusing it.
 * `H1` is off every array these tests build, so the navigation itself cannot
 * disturb what is being measured.
 */
async function pressF9(page: Page, grid: GridHelper): Promise<void> {
  await grid.navigateTo("H1");
  await page.keyboard.press("F9");
  await page.waitForTimeout(1200);
}

/**
 * Collect everything the page logs as an ERROR while `body` runs.
 *
 * A cascade that leaves an orphan behind is not silent: the survivor answers
 * "Table <id> not found" on every item fetch, one console error per repaint.
 * That is how §3bn was first seen (as a `no-console-errors` walk failure), so
 * a proof of the fix that only counts objects is weaker than the failure it
 * replaces.
 */
/** The BACKEND's slicer list — the store of record, not the extension's cache. */
async function backendSlicers(page: Page): Promise<Array<{ id: string; cacheSourceId?: string }>> {
  const rows = await invoke<Array<{ id: string; cacheSourceId?: string }>>(page, "get_all_slicers");
  return Array.isArray(rows) ? rows : [];
}

/**
 * How many FLOATING REGIONS of type "slicer" are registered with the grid.
 *
 * This is the wedge oracle. §3bn's 120 s timeout was not caused by an object
 * existing — it was caused by a region going on claiming a rectangle over the
 * grid, so clicks meant for the cells underneath hit a control that could
 * never answer. `@api/gridOverlays` is where that claim lives.
 */
async function slicerRegionCount(page: Page): Promise<number> {
  const regions = await callModule<Array<{ type: string }>>(
    page,
    "/src/api/gridOverlays.ts",
    "getGridRegions",
  );
  return (Array.isArray(regions) ? regions : []).filter((r) => r.type === "slicer").length;
}

async function consoleErrorsDuring(page: Page, body: () => Promise<void>): Promise<string[]> {
  const errors: string[] = [];
  const onConsole = (msg: { type(): string; text(): string }) => {
    if (msg.type() === "error") errors.push(msg.text());
  };
  page.on("console", onConsole as never);
  try {
    await body();
  } finally {
    page.off("console", onConsole as never);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Real gestures
// ---------------------------------------------------------------------------

async function addSheetViaButton(page: Page): Promise<void> {
  await page.locator('button[title="Add new sheet"]').click({ force: true });
  await page.waitForTimeout(900);
}

async function activateSheet(page: Page, index: number): Promise<void> {
  await page.locator(`button[data-sheet-tab="${index}"]`).click();
  await page.waitForTimeout(800);
}

/** Rename through the tab bar's own event, then WAIT for the tab to say so. */
async function renameSheet(page: Page, index: number, newName: string): Promise<void> {
  await page.evaluate(
    ({ idx, name }) => {
      window.dispatchEvent(
        new CustomEvent("sheet:requestRename", { detail: { index: idx, newName: name } }),
      );
    },
    { idx: index, name: newName },
  );
  await expect
    .poll(async () => (await sheetNames(page))[index], {
      timeout: 15_000,
      intervals: [200],
      message: `the sheet tab never took the name "${newName}"`,
    })
    .toBe(newName);
  await page.waitForTimeout(700);
}

/**
 * Tell the frontend that table definitions changed. The Table extension keeps
 * its overlay cache in sync on these window events; they are the documented
 * hook the backend's own out-of-band "tables:refresh" is bridged onto, not a
 * test-only backdoor.
 */
async function announceTablesChanged(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("app:table-created"));
    window.dispatchEvent(new Event("app:table-definitions-updated"));
  });
  await page.waitForTimeout(800);
}

interface TableRow {
  id: string;
  name: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

async function tables(page: Page): Promise<TableRow[]> {
  return invoke<TableRow[]>(page, "get_all_tables");
}

/** The error pane's own explanation for a cell, via the command it calls. */
async function errorMessageAt(page: Page, ref: string): Promise<string> {
  const { row, col } = parseCellRef(ref);
  const indicators = await invoke<
    Array<{ row: number; col: number; errorType: string; message: string }>
  >(page, "get_error_indicators", {
    startRow: row,
    startCol: col,
    endRow: row,
    endCol: col,
  });
  const hit = indicators.find((i) => i.row === row && i.col === col);
  return hit?.message ?? "";
}

// ===========================================================================

// NOT `.serial`. Every test here starts from File > New and shares nothing with
// its neighbours, and `.serial` would SKIP the rest of the file after the first
// failure — which is exactly what happened on the first run: the `#SPILL!` test
// found a real defect and took the BUG-0020 proof down with it, so one finding
// cost the run a second, unrelated assertion.
test.describe("Live parity proofs — structured refs, sheet casing, error parity", () => {
  test.beforeAll(() => {
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
  });

  // AUTOMATIC CALCULATION, asserted rather than assumed, before every test.
  //
  // `calculation_mode` is workbook-wide AppState that File > New does not
  // reset, so ONE spec anywhere in the run that leaves it on "manual" makes
  // every formula proof in this file measure a workbook that is not
  // recalculating — and they would fail in ways that look like the product
  // being broken rather than the harness. The characterisation test below
  // switches it deliberately and restores it in a `finally`; this is the belt
  // for everything else.
  test.beforeEach(async ({ appPage }) => {
    await invoke(appPage, "set_calculation_mode", { mode: "automatic" });
  });

  test.afterAll(() => {
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
  });

  // =========================================================================
  // 1. §2aj — the structured reference is STORED, and it FOLLOWS the table
  // =========================================================================
  test("§2aj — =SUM(Sales[Amount]) is stored as typed and follows the table when it grows", async ({
    appPage,
    grid,
  }) => {
    await newFile(appPage);

    // --- fixture: a one-column table, typed through the real inline editor ---
    for (const [ref, value] of [
      ["A1", "Amount"],
      ["A2", "10"],
      ["A3", "20"],
      ["A4", "30"],
    ] as Array<[string, string]>) {
      await grid.navigateTo(ref);
      await grid.typeIntoCell(value);
    }

    const created = await invoke<{
      success: boolean;
      table?: { id: string; name: string };
      error?: string | null;
    }>(appPage, "create_table", {
      params: {
        name: "Sales",
        startRow: 0,
        startCol: 0,
        endRow: 3,
        endCol: 0,
        hasHeaders: true,
      },
    });
    expect(created.success, `create_table failed: ${created.error ?? "unknown"}`).toBe(true);
    const tableId = created.table?.id;
    expect(tableId, "create_table returned no table").toBeTruthy();
    if (created.table?.name !== "Sales") {
      await invoke(appPage, "rename_table", { tableId, newName: "Sales" });
    }
    await announceTablesChanged(appPage);

    const before = await tables(appPage);
    const salesBefore = before.find((t) => t.name === "Sales");
    expect(salesBefore, "the fixture table was not created").toBeDefined();
    expect(salesBefore?.endRow, "the fixture table does not span A1:A4").toBe(3);

    // --- the gesture under test: TYPE the structured reference ---
    await grid.navigateTo("C1");
    await grid.typeIntoCell("=SUM(Sales[Amount])");

    const entered = await cell(appPage, "C1");

    // THE TRANSPARENCY HALF. The old defect's exact output is named, so a
    // regression to entry-time flattening fails here by name.
    expect(
      entered.formula,
      "the formula bar shows a rectangle the user never typed (§2aj regression)",
    ).not.toBe("=SUM($A$2:$A$4)");
    expect(entered.formula).toBe("=SUM(Sales[Amount])");

    // THE VALUE HALF, before the growth — so "100 afterwards" is a transition.
    expect(entered.display).toBe("60");
    expect(await painted(appPage, "C1")).toBe("60");

    // --- the gesture under test: GROW the table through auto-expand ---
    // Typing a value in the row directly under a table is the real gesture
    // `check_table_auto_expand` exists for.
    await grid.navigateTo("A5");
    await grid.typeIntoCell("40");
    await announceTablesChanged(appPage);

    // The table really did grow — otherwise the value assertion below would be
    // asserting nothing about structured references at all.
    const after = await tables(appPage);
    const salesAfter = after.find((t) => t.name === "Sales");
    expect(salesAfter?.endRow, "the table did not auto-expand over the typed row").toBe(4);

    const grown = await cell(appPage, "C1");
    expect(grown.display, "the total did not follow the table (§2aj: it stayed 60)").toBe("100");
    expect(await painted(appPage, "C1")).toBe("100");
    expect(grown.formula, "the stored formula was rewritten by the growth").toBe(
      "=SUM(Sales[Amount])",
    );
  });

  // =========================================================================
  // 2. §2ai — the sheet qualifier keeps its casing, and follows a rename
  // =========================================================================
  test("§2ai — =Data!A1 keeps its casing through entry, save/reload and a rename", async ({
    appPage,
    grid,
  }) => {
    await newFile(appPage);

    await addSheetViaButton(appPage);
    await renameSheet(appPage, 1, "Data");
    expect(await sheetNames(appPage)).toEqual(["Sheet1", "Data"]);

    await activateSheet(appPage, 1);
    await grid.navigateTo("A1");
    await grid.typeIntoCell("7");
    await activateSheet(appPage, 0);

    // --- entry ---
    await grid.navigateTo("B1");
    await grid.typeIntoCell("=Data!A1");

    const entered = await cell(appPage, "B1");
    expect(entered.formula, "the lexer's upper-cased qualifier reached the formula bar").not.toBe(
      "=DATA!A1",
    );
    expect(entered.formula).toBe("=Data!A1");
    expect(entered.display, "the qualifier kept its case but stopped resolving").toBe("7");

    // --- save / reload ---
    await saveTo(appPage, FILE);
    await openAt(appPage, FILE);

    const reloaded = await cell(appPage, "B1");
    expect(reloaded.formula, "the load path did not restamp the qualifier").toBe("=Data!A1");
    expect(reloaded.display).toBe("7");
    expect(await painted(appPage, "B1")).toBe("7");

    // --- a rename the reference must FOLLOW ---
    await renameSheet(appPage, 1, "Ledger");
    const renamed = await cell(appPage, "B1");
    expect(renamed.formula, "the reference did not follow the rename").toBe("=Ledger!A1");
    expect(renamed.display, "the rename broke the reference").toBe("7");

    // --- a CASE-ONLY rename, which is the case §2ai was found on ---
    await renameSheet(appPage, 1, "LEDGER");
    const recased = await cell(appPage, "B1");
    expect(recased.formula, "a case-only rename did not re-spell the qualifier").toBe("=LEDGER!A1");
    expect(recased.display).toBe("7");
  });

  // =========================================================================
  // 3. #NUM! parity
  // =========================================================================
  test("=SQRT(-1) and =LOG(0) render #NUM! and survive a save/reload", async ({
    appPage,
    grid,
  }) => {
    await newFile(appPage);

    await grid.navigateTo("A1");
    await grid.typeIntoCell("=SQRT(-1)");
    await grid.navigateTo("A2");
    await grid.typeIntoCell("=LOG(0)");

    // A counterweight on the same sheet: a domain-legal call still answers a
    // number, so "#NUM! everywhere" cannot pass this test.
    await grid.navigateTo("A3");
    await grid.typeIntoCell("=SQRT(9)");

    const sqrtNeg = await cell(appPage, "A1");
    expect(sqrtNeg.display, "SQRT(-1) answers Excel's #NUM!, not #VALUE!").toBe("#NUM!");
    expect(await painted(appPage, "A1")).toBe("#NUM!");

    const logZero = await cell(appPage, "A2");
    expect(logZero.display, "LOG(0) answers Excel's #NUM!, not #VALUE!").toBe("#NUM!");

    expect((await cell(appPage, "A3")).display).toBe("3");

    await saveTo(appPage, FILE);
    await openAt(appPage, FILE);

    expect((await cell(appPage, "A1")).display, "#NUM! did not survive the reload").toBe("#NUM!");
    expect((await cell(appPage, "A2")).display, "#NUM! did not survive the reload").toBe("#NUM!");
    expect(await painted(appPage, "A1")).toBe("#NUM!");
    expect((await cell(appPage, "A3")).display).toBe("3");
  });

  // =========================================================================
  // 4. #SPILL! parity — and the blocker's ADDRESS, which is the point of it
  // =========================================================================
  test("a blocked dynamic array renders #SPILL!, names the blocker, and survives a save/reload", async ({
    appPage,
    grid,
  }) => {
    await newFile(appPage);

    // A spill that is NOT blocked, as the counterweight: if SEQUENCE simply
    // never spilled, the blocked case below would pass for the wrong reason.
    await grid.navigateTo("A1");
    await grid.typeIntoCell("=SEQUENCE(1;2)");
    expect((await cell(appPage, "A1")).display, "the unblocked array did not spill").toBe("1");
    expect(await painted(appPage, "B1"), "the unblocked array did not reach its second cell").toBe(
      "2",
    );

    // Now the blocked one: D1 is occupied, so C1's array cannot write C1:D1.
    await grid.navigateTo("D1");
    await grid.typeIntoCell("block");
    await grid.navigateTo("C1");
    await grid.typeIntoCell("=SEQUENCE(1;2)");

    const blocked = await cell(appPage, "C1");
    expect(blocked.display, "a blocked array answers Excel's #SPILL!, not #VALUE!").toBe("#SPILL!");
    expect(await painted(appPage, "C1")).toBe("#SPILL!");
    expect(await painted(appPage, "D1"), "the blocked array overwrote its blocker").toBe("block");

    const message = await errorMessageAt(appPage, "C1");
    expect(message, "the error pane did not name the blocking cell").toContain("D1");

    // The save/reload half. It used to live in a characterisation test below,
    // because it did not hold: the calculate-before-save pass collapsed the
    // array to its first element and wrote THAT to disk (§3bm). It holds now.
    await saveTo(appPage, FILE);
    expect(
      (await cell(appPage, "C1")).display,
      "saving collapsed a blocked array to its first element (§3bm)",
    ).toBe("#SPILL!");
    expect(await painted(appPage, "D1"), "the blocker's own text must survive the save").toBe(
      "block",
    );

    await openAt(appPage, FILE);
    expect((await cell(appPage, "C1")).display, "#SPILL! did not survive the reload").toBe(
      "#SPILL!",
    );
    expect(await painted(appPage, "C1")).toBe("#SPILL!");
    expect(await errorMessageAt(appPage, "C1"), "the blocker's address after a reload").toContain(
      "D1",
    );
  });

  // =========================================================================
  // 4b. §3bm — THE RECALCULATION PASS SPILLS (was a CHARACTERISATION test)
  // =========================================================================
  //
  // THIS TEST USED TO ASSERT THE WRONG ANSWER ON PURPOSE. It is now inverted,
  // because §3bm is fixed.
  //
  // WHAT WAS WRONG. `app/src-tauri/src/calculation.rs` — `run_calculation_pass`
  // (F9, Shift+F9) and `recalculate_sheet_values` — contained no reference to
  // spilling at all. It wrote `evaluate_formula_with_pivot(...)`, which ends in
  // `EvalResult::to_cell_value()`, and that COLLAPSES an array to its first
  // element (`core/engine/src/evaluator.rs`: "Arrays collapse to the first
  // value when stored in a cell"). The three places that really decided a spill
  // were all in `commands/data.rs` and the pass reached none of them.
  //
  // There is now ONE spill decision — `commands::data::apply_spill_decision`,
  // parameterised on the sheet — and every per-cell evaluator ends in it: the
  // three edit paths, the cross-sheet walk, and both recalculation passes.
  //
  // Both halves still carry a CONTROL, so neither can pass because the
  // recalculation did not happen at all.
  test("§3bm — F9 re-lays a resized array and keeps a blocked array's #SPILL!", async ({
    appPage,
    grid,
  }) => {
    await newFile(appPage);

    // ---- 1. a blocked origin KEEPS its error through a recalculation ----
    await grid.navigateTo("D1");
    await grid.typeIntoCell("block");
    await grid.navigateTo("C1");
    await grid.typeIntoCell("=SEQUENCE(1;2)");
    expect(
      (await cell(appPage, "C1")).display,
      "precondition: entry must produce #SPILL!, or this test measures nothing",
    ).toBe("#SPILL!");

    await saveTo(appPage, FILE);

    expect(
      (await cell(appPage, "C1")).display,
      "the calculate-before-save pass collapsed a blocked array to a plausible number (§3bm)",
    ).toBe("#SPILL!");
    expect(
      await painted(appPage, "D1"),
      "the blocker's own text must survive whatever the pass did to the origin",
    ).toBe("block");

    // ---- 2. a shrunk array gives up the cells it no longer covers ----
    await newFile(appPage);
    await grid.navigateTo("A1");
    await grid.typeIntoCell("4");
    await grid.navigateTo("B1");
    await grid.typeIntoCell("=SEQUENCE(A1)");
    // CONTROL: an ordinary dependent of the same driver. If this does not move,
    // the recalculation did not run and the array assertions say nothing.
    await grid.navigateTo("F1");
    await grid.typeIntoCell("=A1*10");

    expect(await painted(appPage, "B4"), "precondition: the array must have spilled to four").toBe(
      "4",
    );
    expect(await painted(appPage, "F1")).toBe("40");

    // Manual mode, so the ONLY thing that can put the array right is the
    // recalculation pass — this is the shape a .calp refresh produces.
    //
    // TRY/FINALLY, and it is not defensive padding. `calculation_mode` is
    // WORKBOOK-WIDE AppState that File > New does not reset, so a test that
    // switches it to manual and then fails an assertion leaves EVERY LATER SPEC
    // IN THE RUN with automatic recalculation off — typed edits stop
    // propagating, dozens of unrelated specs fail, and several sit until their
    // 300 s timeout. That is not a hypothetical: it is what an earlier draft of
    // this test did to a whole journey run. Any future test that flips a global
    // mode must restore it the same way.
    await invoke(appPage, "set_calculation_mode", { mode: "manual" });
    try {
      await grid.navigateTo("A1");
      await grid.typeIntoCell("2");
      await invoke(appPage, "calculate_now", { cubeResults: null });
      await appPage.waitForTimeout(800);

      expect(
        await painted(appPage, "F1"),
        "CONTROL: the recalculation did not run, so nothing below is measured",
      ).toBe("20");
      expect(
        await painted(appPage, "B2"),
        "the array's own cells within the new extent must be right",
      ).toBe("2");
      expect(
        await painted(appPage, "B3"),
        "B3 must be EMPTY after the array shrinks to two (§3bm)",
      ).toBe("");
      expect(
        await painted(appPage, "B4"),
        "B4 must be EMPTY after the array shrinks to two (§3bm)",
      ).toBe("");

      // ...and the MAP must agree with the grid, which is the half that made
      // §3bm "silently right, then silently wrong": the cells stopped being
      // painted while `spill_ranges` still claimed them.
      const ranges = await invoke<
        Array<{ originRow: number; originCol: number; endRow: number; endCol: number }>
      >(appPage, "get_spill_ranges");
      expect(
        Array.isArray(ranges)
          ? ranges.map((r) => [r.originRow, r.originCol, r.endRow, r.endCol])
          : ranges,
        "the spill map must claim exactly B1:B2 for the shrunk array",
      ).toEqual([[0, 1, 1, 1]]);
    } finally {
      await invoke(appPage, "set_calculation_mode", { mode: "automatic" });
    }
  });

  // =========================================================================
  // 4c. §3bm — THE REAL F9 KEYSTROKE, both directions of a length change
  // =========================================================================
  //
  // The test above drives the pass through `invoke("calculate_now")`, which is
  // what the ribbon command calls. This one presses the KEY, because the F9
  // handler lives in `useGridKeyboard` behind a focus condition
  // (`data-focus-container="spreadsheet"`) and a command-name indirection
  // (`calculate.now`) that an `invoke` bypasses entirely: a build where the
  // keystroke never reaches the pass would leave the test above green.
  //
  // It also changes the array's length in BOTH directions. The shrink is the
  // §3bm defect (stale cells survive); the grow is its mirror (the new cells
  // are never laid), and only one of the two was covered.
  //
  // NON-VACUITY, three ways: an ordinary dependent (`F1`) that must move,
  // an assertion that F1 has NOT moved before the keypress (so manual mode
  // really is manual and F9 is doing the work), and the spill map read back
  // after each press.
  test("§3bm — a real F9 keystroke re-lays =SEQUENCE(n) when n grows AND when it shrinks", async ({
    appPage,
    grid,
  }) => {
    await newFile(appPage);

    await grid.navigateTo("A1");
    await grid.typeIntoCell("2");
    await grid.navigateTo("B1");
    await grid.typeIntoCell("=SEQUENCE(A1)");
    await grid.navigateTo("F1");
    await grid.typeIntoCell("=A1*10");

    expect(await painted(appPage, "B1"), "precondition: =SEQUENCE(2) must spill").toBe("1");
    expect(await painted(appPage, "B2"), "precondition: =SEQUENCE(2) must spill").toBe("2");
    expect(await painted(appPage, "B3"), "precondition: nothing below the array").toBe("");
    expect(await spillMap(appPage), "precondition: the map holds exactly B1:B2").toEqual([
      [0, 1, 1, 1],
    ]);

    await invoke(appPage, "set_calculation_mode", { mode: "manual" });
    try {
      // ---- GROW: 2 -> 4, and the ONLY thing that may lay B3:B4 is F9 ----
      await grid.navigateTo("A1");
      await grid.typeIntoCell("4");
      expect(
        await painted(appPage, "F1"),
        "manual mode is not manual — the edit recalculated a dependent by itself, " +
          "so a green F9 assertion below would prove nothing",
      ).toBe("20");

      await pressF9(appPage, grid);

      expect(
        await painted(appPage, "F1"),
        "CONTROL: the F9 KEYSTROKE never reached the calculation pass",
      ).toBe("40");
      expect(
        [
          await painted(appPage, "B1"),
          await painted(appPage, "B2"),
          await painted(appPage, "B3"),
          await painted(appPage, "B4"),
        ],
        "F9 did not GROW the array into the cells it now covers (§3bm, mirror case)",
      ).toEqual(["1", "2", "3", "4"]);
      expect(await spillMap(appPage), "the map must claim B1:B4 after the grow").toEqual([
        [0, 1, 3, 1],
      ]);

      // ---- SHRINK: 4 -> 2, and no stale cell may survive ----
      await grid.navigateTo("A1");
      await grid.typeIntoCell("2");
      await pressF9(appPage, grid);

      expect(await painted(appPage, "F1"), "CONTROL: the second F9 did not run").toBe("20");
      expect(
        [
          await painted(appPage, "B1"),
          await painted(appPage, "B2"),
          await painted(appPage, "B3"),
          await painted(appPage, "B4"),
        ],
        "a stale cell survived the shrink — this is §3bm itself",
      ).toEqual(["1", "2", "", ""]);
      expect(await spillMap(appPage), "the map must claim exactly B1:B2 again").toEqual([
        [0, 1, 1, 1],
      ]);
    } finally {
      await invoke(appPage, "set_calculation_mode", { mode: "automatic" });
    }
  });

  // =========================================================================
  // 4d. §3bf — `B1#` FOLLOWS ITS SOURCE
  // =========================================================================
  //
  // `A1#` used to be resolved once, at ENTRY, and stored as a fixed rectangle,
  // so a reader of an array never saw the array change size. §3bs moved the
  // resolution into `eval_ast`. Three things have to hold and each fails
  // differently:
  //
  //   * the STORED text keeps the `#` (the formula bar must not show a
  //     rectangle the user never typed — the §2aj standard applied to a third
  //     indirection);
  //   * the VALUE follows through the ordinary edit cascade, in both
  //     directions;
  //   * F9 answers the same thing. `evaluate_single_formula` had its own
  //     private copy of the resolution rule that knew nothing about spill
  //     refs and answered `#NAME?` the first time F9 was pressed.
  //
  // ...and it survives a save/reload, where the spill map is rebuilt from
  // scratch and the reader is re-parsed from the archive.
  test("§3bf — =SUM(B1#) keeps its # and follows the array through edits, F9 and a reload", async ({
    appPage,
    grid,
  }) => {
    await newFile(appPage);

    await grid.navigateTo("A1");
    await grid.typeIntoCell("3");
    await grid.navigateTo("B1");
    await grid.typeIntoCell("=SEQUENCE(A1)");
    await grid.navigateTo("D1");
    await grid.typeIntoCell("=SUM(B1#)");

    const entered = await cell(appPage, "D1");
    expect(entered.display, "=SUM(B1#) over 1..3").toBe("6");
    expect(
      entered.formula,
      "the stored formula lost the # — a spill reference frozen into a " +
        "rectangle at entry is §3bf itself",
    ).toContain("B1#");
    expect(entered.formula, "the formula bar shows a rectangle nobody typed").not.toContain("B1:B");

    // ---- it FOLLOWS, through the ordinary edit cascade, growing ----
    await grid.navigateTo("A1");
    await grid.typeIntoCell("5");
    expect(
      await painted(appPage, "D1"),
      "the spill reference did not follow its array when it GREW (§3bf)",
    ).toBe("15");

    // ---- and shrinking, which is the direction that leaves stale cells ----
    await grid.navigateTo("A1");
    await grid.typeIntoCell("2");
    expect(
      await painted(appPage, "D1"),
      "the spill reference did not follow its array when it SHRANK — if this " +
        "reads 15 the reader is still summing cells the array gave up",
    ).toBe("3");

    // ---- F9 answers the same, from the pass's own resolution path ----
    await invoke(appPage, "set_calculation_mode", { mode: "manual" });
    try {
      await grid.navigateTo("A1");
      await grid.typeIntoCell("4");
      await pressF9(appPage, grid);
      expect(
        await painted(appPage, "D1"),
        "F9 answered something other than 1+2+3+4 for =SUM(B1#) — the pass had " +
          "its own copy of the resolution rule and answered #NAME?",
      ).toBe("10");
    } finally {
      await invoke(appPage, "set_calculation_mode", { mode: "automatic" });
    }

    // ---- and it survives the archive ----
    await saveTo(appPage, FILE);
    await openAt(appPage, FILE);

    const reopened = await cell(appPage, "D1");
    expect(reopened.formula, "the reload dropped the # from the stored formula").toContain("B1#");
    expect(
      reopened.display,
      "the reopened spill reference does not read the reopened array",
    ).toBe("10");
    expect(await painted(appPage, "B4"), "precondition: the array itself came back").toBe("4");

    // AN ARRAY MUST COME BACK AS AN ARRAY, NOT AS ITS FIRST ELEMENT.
    //
    // `B1#` reading 10 could in principle be satisfied by four ordinary
    // numbers that no longer belong to anything, so the three claims that
    // make it an ARRAY are asserted separately:
    //
    //   * every cell of the extent is painted (1..4, not "1" then blanks);
    //   * the SPILL MAP claims exactly B1:B4 — this is the half §2ab
    //     persisted and the half §3bm used to destroy on the way to disk;
    //   * only the ORIGIN carries the formula. A workbook that came back with
    //     `=SEQUENCE(A1)` in all four cells would paint the same numbers and
    //     would be a different document from the one that was saved.
    expect(
      [
        await painted(appPage, "B1"),
        await painted(appPage, "B2"),
        await painted(appPage, "B3"),
        await painted(appPage, "B4"),
      ],
      "the reopened array collapsed — a saved array must come back as an array",
    ).toEqual(["1", "2", "3", "4"]);
    expect(
      await spillMap(appPage),
      "the spill map did not survive the archive: the array paints but nothing " +
        "owns those cells, so the next edit under it cannot be blocked or released",
    ).toEqual([[0, 1, 3, 1]]);
    const reopenedOrigin = await cell(appPage, "B1");
    expect(reopenedOrigin.formula, "the origin lost its formula on the way to disk").toContain(
      "SEQUENCE",
    );
    expect(
      (await cell(appPage, "B3")).formula,
      "a spilled CELL came back carrying the origin's formula — the archive " +
        "stored four independent formulas, not one array",
    ).not.toContain("SEQUENCE");
  });

  // =========================================================================
  // 5. BUG-0020 — a conditional-format rule is undoable by Ctrl+Z
  // =========================================================================
  //
  // This was the ONE real product defect in the S12 soak bundle: the CF
  // commands recorded no undo entry at all, so `conditionalFormats.0` was
  // still on the sheet after the oracle wound the history back past its
  // creation. It is proved here through the REAL Ctrl+Z gesture on the grid,
  // because the Rust test can only prove the recorder was called — not that
  // the keystroke reaches it.
  //
  // It is also the instrument the "teeth" check uses: comment out the
  // `record_conditional_formats_undo` call in `add_conditional_format_impl`,
  // rebuild, and this test must fail. If it does not, it is not testing the
  // fix.
  test("BUG-0020 — Ctrl+Z removes a conditional-format rule, Ctrl+Y puts it back", async ({
    appPage,
    grid,
  }) => {
    await newFile(appPage);

    const rules = () =>
      invoke<Array<{ id: number }>>(appPage, "get_all_conditional_formats").then((r) =>
        Array.isArray(r) ? r : [],
      );

    expect((await rules()).length, "File > New left conditional formats behind").toBe(0);

    await invoke(appPage, "add_conditional_format", {
      params: {
        rule: { type: "cellValue", operator: "greaterThan", value1: "40" },
        format: { backgroundColor: "#FFC7CE", textColor: "#9C0006" },
        ranges: [{ startRow: 0, startCol: 0, endRow: 3, endCol: 0 }],
        stopIfTrue: false,
      },
    });
    await appPage.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
    await appPage.waitForTimeout(300);

    expect((await rules()).length, "the fixture rule was never added").toBe(1);

    // The REAL gesture.
    await grid.navigateTo("A1");
    await grid.undo();
    await appPage.waitForTimeout(400);

    expect(
      (await rules()).length,
      "Ctrl+Z did not remove the conditional-format rule (BUG-0020)",
    ).toBe(0);

    await grid.redo();
    await appPage.waitForTimeout(400);

    expect((await rules()).length, "Ctrl+Y did not put the rule back").toBe(1);
  });

  // =========================================================================
  // 6. PROOF — §3bn: deleting a table takes its slicer with it
  // =========================================================================
  //
  // INVERTED 2026-08-11 (§3bt). This was a CHARACTERISATION test asserting the
  // defect; the defect is fixed, so it now asserts the Excel behaviour and is
  // the live proof of it.
  //
  // HOW IT WAS FOUND. `state-consistency` has been failing intermittently all
  // programme and being written off as monkey flake. Seed 1786421716252 failed
  // TWICE OUT OF TWO runs, with two different symptoms in one region:
  //
  //   * functional run: `no-console-errors` —
  //     "[Slicer] Failed to get items for slicer <id> Table <id> not found"
  //   * invariant replay: `page-crashed` — an overlay intercepted pointer
  //     events through 171 click retries and the test timed out at 120 s, i.e.
  //     the UI was WEDGED, not merely noisy.
  //
  // Both walks contain `slicer.create` followed by `table.delete`. Reduced to
  // those two gestures the root cause is plain and needs no walk at all:
  // deleting a table leaves its slicer behind, still naming a table id that no
  // longer exists. The error surfaces only when something later asks the
  // orphan to refresh its items, which is why the walks failed far away from
  // the cause and looked random.
  //
  // WHAT EXCEL DOES, and what this now proves. A slicer cannot outlive its
  // source: deleting the table removes the slicers connected to it. A slicer
  // that still has a live Report Connection is REPOINTED instead of deleted --
  // that half is covered by `object_deps_tests.rs`, which can build the
  // multi-connection case far more cheaply than a live walk can.
  test("§3bn PROOF — deleting a table deletes the slicer bound to it", async ({
    appPage,
  }) => {
    await newFile(appPage);

    for (const [r, c, v] of [
      [0, 0, "Product"],
      [0, 1, "Qty"],
      [1, 0, "Apple"],
      [1, 1, "10"],
      [2, 0, "Pear"],
      [2, 1, "20"],
    ] as Array<[number, number, string]>) {
      await invoke(appPage, "update_cell", { row: r, col: c, value: v });
    }
    await invoke(appPage, "create_table", {
      params: {
        name: "SlicerSource",
        startRow: 0,
        startCol: 0,
        endRow: 2,
        endCol: 1,
        hasHeaders: true,
      },
    });
    await announceTablesChanged(appPage);

    const tablesBefore = await tables(appPage);
    const source = tablesBefore.find((t) => t.name === "SlicerSource");
    expect(source, "the fixture table was not created").toBeDefined();
    const tableId = source!.id;

    const slicerId = await appPage.evaluate(async (id: string) => {
      const api = (
        window as unknown as {
          __CALCULA_SLICER__?: { createSlicerAsync: (a: unknown) => Promise<{ id?: string }> };
        }
      ).__CALCULA_SLICER__;
      if (!api) return "NO_SLICER_API";
      const s = await api.createSlicerAsync({
        name: "OrphanProbe",
        sheetIndex: 0,
        x: 500,
        y: 50,
        width: 200,
        height: 250,
        sourceType: "table",
        cacheSourceId: id,
        fieldName: "Product",
        connectedSources: [{ sourceType: "table", sourceId: id }],
        columns: 1,
      });
      return s?.id ?? "NO_ID";
    }, tableId);
    expect(slicerId, "the fixture slicer was not created").not.toBe("NO_ID");
    expect(slicerId).not.toBe("NO_SLICER_API");
    await appPage.waitForTimeout(600);

    expect(
      await slicerRegionCount(appPage),
      "precondition: the slicer claims a floating grid region before the delete, " +
        "or the wedge assertion below cannot fail",
    ).toBe(1);

    // THE GESTURE — through the app's OWN delete path, not a raw `invoke`.
    // `deleteTableAsync` is exactly what the Table Design tab's Delete button
    // calls, and the announcement it makes afterwards is half of the fix: the
    // backend cascade removes the slicer, and the announcement is what makes
    // the Slicer extension's cache and its floating region agree. A test that
    // called the Tauri command directly would leave the overlay behind and
    // blame the backend for it.
    //
    // The page's error log is captured across it, because the orphan's symptom
    // was a console error per repaint, not a wrong count.
    const noise = await consoleErrorsDuring(appPage, async () => {
      await callModule(appPage, "/extensions/Table/lib/tableStore.ts", "deleteTableAsync", [
        tableId,
      ]);
      await appPage.waitForTimeout(1200);
    });
    expect(
      noise.filter((t) => /not found|Failed to get items/i.test(t)),
      "the delete left something asking the backend for the table it just deleted",
    ).toEqual([]);

    expect(
      (await tables(appPage)).length,
      "precondition: the table really is gone, or nothing below is about an orphan",
    ).toBe(0);

    const survivors = await appPage.evaluate(() => {
      const api = (
        window as unknown as {
          __CALCULA_SLICER__?: { getAllSlicers?: () => Array<{ id: string; cacheSourceId?: string }> };
        }
      ).__CALCULA_SLICER__;
      return api?.getAllSlicers?.() ?? [];
    });

    expect(
      survivors.length,
      "§3bn REGRESSED — the slicer outlived the only table it was bound to. " +
        "That orphan answers 'Table not found' on every item fetch AND keeps its " +
        "overlay claiming a rectangle, which is what wedged `state-consistency` " +
        "into a 120 s click-retry timeout on seed 1786421716252.",
    ).toBe(0);
    expect(
      survivors.map((s) => s.cacheSourceId),
      "no surviving slicer may still name the deleted table",
    ).not.toContain(tableId);
    expect(
      (await backendSlicers(appPage)).length,
      "the BACKEND still holds the slicer — the extension cache being empty " +
        "would then be a stale view, and the orphan would come back on reload",
    ).toBe(0);
    expect(
      await slicerRegionCount(appPage),
      "no slicer survives, but a floating region still claims its rectangle: " +
        "that is the wedge that swallowed 171 clicks, and it outlives the object",
    ).toBe(0);

    // Defensive sweep. Nothing should be left now, but a regression here is
    // exactly what wedges the NEXT spec, so the cleanup stays.
    await appPage.evaluate(async () => {
      const api = (
        window as unknown as {
          __CALCULA_SLICER__?: {
            getAllSlicers?: () => Array<{ id: string }>;
            deleteSlicerAsync?: (id: string) => Promise<unknown>;
          };
        }
      ).__CALCULA_SLICER__;
      for (const s of api?.getAllSlicers?.() ?? []) {
        await api?.deleteSlicerAsync?.(s.id).catch(() => undefined);
      }
    });
    await appPage.waitForTimeout(400);
  });

  // =========================================================================
  // 7. A SECOND PAIR FROM THE §3bt MATRIX — Convert to Range
  // =========================================================================
  //
  // Chosen deliberately, not for convenience. §3bu's finding was that the
  // seventh census asked its question per object KIND, so `convert_to_range`
  // and `delete_table` VOUCHED FOR EACH OTHER — deleting the cascade from
  // either one left the census green. `convert_to_range` is therefore the one
  // pair whose live behaviour the census could not have guaranteed, and it is
  // also a second delete path that §3bt found carrying the identical orphan.
  //
  // It asserts three things the table/slicer proof does not:
  //   * the CELLS SURVIVE. Convert to Range removes the table and keeps its
  //     data; a cascade that took the values with it would be catastrophic and
  //     would still satisfy "no orphan".
  //   * the grid's OVERLAY REGISTRY gives the rectangle back. `getAllSlicers`
  //     counting zero is not the same claim: the wedge in §3bn was a floating
  //     region still claiming pointer events, and that lives in
  //     `@api/gridOverlays`.
  //   * ONE Ctrl+Z restores the whole world. §3bt added an undo transaction to
  //     `convert_to_range`, which previously recorded NOTHING, and the cascade
  //     records its restores BEFORE the owner's so they replay AFTER it.
  test("§3bt second pair — Convert to Range cascades to the slicer, keeps the data, and undoes as one", async ({
    appPage,
  }) => {
    await newFile(appPage);

    for (const [r, c, v] of [
      [0, 0, "Product"],
      [0, 1, "Qty"],
      [1, 0, "Apple"],
      [1, 1, "10"],
      [2, 0, "Pear"],
      [2, 1, "20"],
    ] as Array<[number, number, string]>) {
      await invoke(appPage, "update_cell", { row: r, col: c, value: v });
    }
    await invoke(appPage, "create_table", {
      params: {
        name: "ConvertSource",
        startRow: 0,
        startCol: 0,
        endRow: 2,
        endCol: 1,
        hasHeaders: true,
      },
    });
    await announceTablesChanged(appPage);

    const source = (await tables(appPage)).find((t) => t.name === "ConvertSource");
    expect(source, "the fixture table was not created").toBeDefined();
    const tableId = source!.id;

    const slicerId = await appPage.evaluate(async (id: string) => {
      const api = (
        window as unknown as {
          __CALCULA_SLICER__?: { createSlicerAsync: (a: unknown) => Promise<{ id?: string }> };
        }
      ).__CALCULA_SLICER__;
      if (!api) return "NO_SLICER_API";
      const s = await api.createSlicerAsync({
        name: "ConvertProbe",
        sheetIndex: 0,
        x: 520,
        y: 60,
        width: 200,
        height: 250,
        sourceType: "table",
        cacheSourceId: id,
        fieldName: "Product",
        connectedSources: [{ sourceType: "table", sourceId: id }],
        columns: 1,
      });
      return s?.id ?? "NO_ID";
    }, tableId);
    expect(slicerId, "the fixture slicer was not created").not.toBe("NO_ID");
    expect(slicerId).not.toBe("NO_SLICER_API");
    await appPage.waitForTimeout(600);

    expect(
      (await backendSlicers(appPage)).length,
      "precondition: the slicer exists in the BACKEND before the gesture",
    ).toBe(1);
    expect(
      await slicerRegionCount(appPage),
      "precondition: the slicer claims a floating region, or the wedge assertion " +
        "below cannot fail",
    ).toBe(1);

    // THE GESTURE — the app's own Convert to Range, the function the Table
    // Design tab's button calls.
    const noise = await consoleErrorsDuring(appPage, async () => {
      await callModule(appPage, "/extensions/Table/lib/tableStore.ts", "convertToRangeAsync", [
        tableId,
      ]);
      await appPage.waitForTimeout(1200);
    });
    expect(
      noise.filter((t) => /not found|Failed to get items/i.test(t)),
      "Convert to Range left something asking for the table it just dissolved",
    ).toEqual([]);

    expect(
      (await tables(appPage)).length,
      "precondition: Convert to Range really removed the table",
    ).toBe(0);
    expect(
      (await backendSlicers(appPage)).map((s) => s.cacheSourceId),
      "the slicer outlived the table Convert to Range dissolved — the second " +
        "delete path the seventh census could not see (§3bu)",
    ).toEqual([]);
    expect(
      await slicerRegionCount(appPage),
      "no slicer survives, but a floating region still claims its rectangle — " +
        "that is the wedge, not the orphan",
    ).toBe(0);

    // THE DATA. This is what Convert to Range is FOR.
    expect(
      [await painted(appPage, "A2"), await painted(appPage, "B2")],
      "the cascade took the table's data with it",
    ).toEqual(["Apple", "10"]);

    // ONE Ctrl+Z, one restored world.
    await appPage.keyboard.press("Control+z");
    await appPage.waitForTimeout(1500);
    await announceTablesChanged(appPage);

    expect(
      (await tables(appPage)).map((t) => t.name),
      "Ctrl+Z did not bring the table back — `convert_to_range` used to record " +
        "no undo transaction at all (§3bt)",
    ).toEqual(["ConvertSource"]);
    expect(
      (await backendSlicers(appPage)).length,
      "the table came back without its slicer — a cascade that cannot be undone " +
        "is data loss wearing a fix's clothes",
    ).toBe(1);

    // Cleanup: leave nothing that can wedge the next spec.
    await appPage.evaluate(async () => {
      const api = (
        window as unknown as {
          __CALCULA_SLICER__?: {
            getAllSlicers?: () => Array<{ id: string }>;
            deleteSlicerAsync?: (id: string) => Promise<unknown>;
          };
        }
      ).__CALCULA_SLICER__;
      for (const s of api?.getAllSlicers?.() ?? []) {
        await api?.deleteSlicerAsync?.(s.id).catch(() => undefined);
      }
    });
    await appPage.waitForTimeout(400);
  });
});
