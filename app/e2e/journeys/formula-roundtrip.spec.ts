/**
 * §3ba THROUGH THE REAL UI — a sheet operation must not change what a formula
 * MEANS or how it is SPELLED.
 *
 * WHAT §3ba FIXED. `rename_sheet` and `delete_sheet` run `repair_all_formulas`
 * over EVERY formula on EVERY sheet, and until 2026-08-10 that walked a second,
 * hand-maintained AST->text serialiser whose tail arm was
 * `other => format!("{:?}", other)` — a debug-format catch-all over 247
 * built-ins. `CELL` was written `CellFn`, `STDEV.S` `StdevS`; for 47 functions
 * the produced text is not an accepted spelling, so re-parsing yielded an
 * unknown user function and the cell became `#NAME?` with no error at either
 * end. The same serialiser dropped PARENTHESES (`=(A1+B1)*C1` -> `A1+B1*C1`,
 * 50 -> 32) and produced sheet names that could not re-lex. And
 * `repair_all_formulas` read the DISPLAY form of a cell, which collapses a named
 * LAMBDA's `__INVOKE__` marker — so renaming any sheet destroyed every
 * named-function call in the workbook, on sheets the rename never mentioned.
 *
 * Alongside those: an unknown sheet resolved to the formula's OWN sheet instead
 * of `#REF!`; deleting a sheet never repaired plain cross-sheet references and
 * recalculated nothing, so cells downstream of a now-broken reference kept the
 * number they had while the sheet existed and that is what a save wrote;
 * renaming a sheet orphaned incoming cross-sheet edges; and defined names were
 * never updated by any sheet operation at all.
 *
 * AND WHAT WRITING THIS SPEC FOUND — two defects nothing above had seen, both
 * fixed in this pass (register §3bd):
 *   - a sheet rename RE-SPELLED every defined name in the workbook
 *     (`=Anchor` -> `=ANCHOR`), because both repairs re-render a formula whether
 *     or not they touched it and the renderer is not the identity on text a user
 *     typed. That is §2t's defect on a path §2t's fix does not reach.
 *   - the same re-render rewrote a named LAMBDA's own definition in the Name
 *     Manager: `=LAMBDA(x, x*2)` -> `=LAMBDA(X,X*2)`, i.e. it re-spelled a LOCAL
 *     BINDING, the one thing §2t's restamp deliberately refuses to touch.
 *
 * THE GESTURES. Sheet rename and delete go through the tab bar's own
 * `sheet:requestRename` / `sheet:requestDelete` events and, for the delete, its
 * real confirmation dialog — the same route `sheets.spec.ts` uses. Cells are
 * typed through the real inline editor where the value is the point.
 *
 * VACUOUS-PASS DISCIPLINE. Every "still X after the operation" is preceded by
 * "X before it", read by the same reader; and the counterweights are explicit —
 * a formula that SHOULD follow the rename is asserted to have followed it, so a
 * repair that had simply stopped working could not pass this file.
 *
 * WHY A JOURNEY. It calls File > New, adds and deletes sheets, and saves.
 *
 * GRID REAL ESTATE. Columns A..G rows 1..3 of a workbook this spec creates from
 * File > New, so nothing is shared with any other spec.
 *
 * LOCALE. sv-SE: a formula typed into a CELL uses ';'. A defined name's
 * `refers_to` is parsed INVARIANT and uses ',' — that asymmetry is real and is
 * called out where it bites.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { parseCellRef, type GridHelper } from "../helpers/grid";

const FILE = path.join(os.tmpdir(), "calcula-formula-roundtrip.cala");

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

async function newFile(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await callModule(page, "/src/core/lib/file-api.ts", "newFile");
  await page.waitForTimeout(900);
}

async function openAt(page: Page, target: string): Promise<void> {
  await callModule(page, "/src/core/lib/file-api.ts", "openFileAtPath", [target]);
  await page.waitForTimeout(2500);
}

async function setCell(page: Page, ref: string, value: string): Promise<void> {
  const { row, col } = parseCellRef(ref);
  await invoke(page, "update_cell", { row, col, value });
  await page.waitForTimeout(120);
}

interface CellSnapshot {
  display: string;
  formula: string;
}

/** What the grid paints AND what the formula bar shows, for one cell. */
async function cell(page: Page, ref: string): Promise<CellSnapshot> {
  const { row, col } = parseCellRef(ref);
  const c = await invoke<{ display?: string; formula?: string | null } | null>(page, "get_cell", {
    row,
    col,
  });
  return { display: c?.display ?? "", formula: c?.formula ?? "" };
}

/** A cell of a NON-active sheet, read without activating it (no mirror sync). */
async function storedCell(page: Page, sheetName: string, ref: string): Promise<string> {
  const { row, col } = parseCellRef(ref);
  const digest = await invoke<{
    sheets: Array<{ name: string; cells: Record<string, { v: string }> }>;
  }>(page, "get_workbook_state_digest", { options: { cellsOnly: true } });
  const sheet = digest.sheets.find((s) => s.name === sheetName);
  if (!sheet) {
    throw new Error(
      `sheet "${sheetName}" is not in the digest (have: ` +
        `${digest.sheets.map((s) => s.name).join(", ")})`,
    );
  }
  return sheet.cells[`${row}:${col}`]?.v ?? "";
}

async function sheetNames(page: Page): Promise<string[]> {
  const res = await invoke<{ sheets: Array<{ name: string }> }>(page, "get_sheets");
  return res.sheets.map((s) => s.name);
}

// ---------------------------------------------------------------------------
// The gestures the tab bar performs
// ---------------------------------------------------------------------------

async function addSheetViaButton(page: Page): Promise<void> {
  await page.locator('button[title="Add new sheet"]').click({ force: true });
  await page.waitForTimeout(900);
}

async function activateSheet(page: Page, index: number): Promise<void> {
  await page.locator(`button[data-sheet-tab="${index}"]`).click();
  await page.waitForTimeout(700);
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
  await page.waitForTimeout(600);
}

/** Delete through the tab bar's event AND its real confirmation dialog. */
async function deleteSheet(page: Page, index: number): Promise<void> {
  const before = await sheetNames(page);
  await page.evaluate((idx: number) => {
    window.dispatchEvent(new CustomEvent("sheet:requestDelete", { detail: { index: idx } }));
  }, index);
  await page.waitForTimeout(400);
  const confirm = page.locator("button").filter({ hasText: /^Delete$/ });
  if (await confirm.isVisible({ timeout: 3000 }).catch(() => false)) {
    await confirm.click();
  } else {
    throw new Error("the sheet-delete confirmation dialog never appeared");
  }
  await expect
    .poll(async () => (await sheetNames(page)).length, {
      timeout: 15_000,
      intervals: [200],
      message: "the sheet was never actually deleted",
    })
    .toBe(before.length - 1);
  await page.waitForTimeout(800);
}

async function defineName(page: Page, name: string, refersTo: string): Promise<void> {
  const res = await invoke<{ success: boolean; error?: string | null }>(
    page,
    "create_named_range",
    { name, sheetIndex: null, refersTo, comment: null, folder: null },
  );
  if (!res.success) {
    throw new Error(`the fixture name "${name}" was not created: ${res.error ?? "unknown"}`);
  }
}

async function namedRanges(page: Page): Promise<Array<{ name: string; refersTo: string }>> {
  return invoke(page, "get_all_named_ranges");
}

// ===========================================================================

test.describe.serial("§3ba — sheet operations preserve what a formula means and how it is spelled", () => {
  test.beforeAll(() => {
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
  });

  // =========================================================================
  // 1. A RENAME RUNS EVERY FORMULA THROUGH THE SERIALISER
  // =========================================================================
  test("renaming a sheet keeps grouping, function names, defined-name spelling and named LAMBDAs", async ({
    grid,
  }) => {
    test.setTimeout(300_000);
    const page = grid.page;

    await newFile(page);
    await renameSheet(page, 0, "Data");

    await setCell(page, "A1", "2");
    await setCell(page, "B1", "3");
    await setCell(page, "C1", "10");

    // Typed through the REAL inline editor, because the whole claim is about
    // the text a user authored surviving.
    await grid.navigateTo("D1");
    await grid.typeIntoCell("=(A1+B1)*C1");
    await grid.navigateTo("E1");
    await grid.typeIntoCell('=CELL("row";A1)');
    await page.waitForTimeout(400);

    // A defined name in MIXED CASE, and a named LAMBDA. `refers_to` is parsed
    // INVARIANT, so its argument separator is a comma even on an sv-SE machine.
    await defineName(page, "Anchor", "=Data!$A$1");
    await defineName(page, "Twice", "=LAMBDA(x, x*2)");
    await grid.navigateTo("F1");
    await grid.typeIntoCell("=Anchor*2");
    await grid.navigateTo("G1");
    await grid.typeIntoCell("=Twice(21)");
    await page.waitForTimeout(400);

    // ---- PRECONDITIONS. Everything below is "unchanged"; if any of these is
    // wrong the test would be asserting the preservation of a defect.
    const before = {
      D1: await cell(page, "D1"),
      E1: await cell(page, "E1"),
      F1: await cell(page, "F1"),
      G1: await cell(page, "G1"),
    };
    expect(before.D1, "precondition: the grouped expression must evaluate to 50").toEqual({
      display: "50",
      formula: "=(A1+B1)*C1",
    });
    expect(before.E1.display, "precondition: CELL(\"row\";A1) must be 1").toBe("1");
    expect(before.E1.formula, "precondition: the function must be spelled CELL").toContain("CELL(");
    expect(before.F1, "precondition: the mixed-case name resolves and is spelled as defined").toEqual(
      { display: "4", formula: "=Anchor*2" },
    );
    expect(before.G1, "precondition: the named LAMBDA resolves and keeps its name").toEqual({
      display: "42",
      formula: "=Twice(21)",
    });

    // A second sheet whose formula DOES name the sheet being renamed — the
    // counterweight, so a repair that had simply stopped working cannot pass.
    await addSheetViaButton(page);
    expect(await sheetNames(page), "the fixture needs a second sheet").toEqual(["Data", "Sheet2"]);
    await setCell(page, "B1", "=Data!A1");
    expect((await cell(page, "B1")).display, "precondition: the cross-sheet read works").toBe("2");
    await activateSheet(page, 0);

    // =====================================================================
    // THE GESTURE: rename the sheet. Every formula on every sheet now goes
    // through the AST -> text serialiser and back.
    // =====================================================================
    await renameSheet(page, 0, "Facts");

    expect(
      await cell(page, "D1"),
      "the serialiser dropped the parentheses: `=(A1+B1)*C1` became `=A1+B1*C1`, " +
        "so the cell now computes 32 instead of 50 — a value changed by renaming a " +
        "sheet the formula does not mention",
    ).toEqual({ display: "50", formula: "=(A1+B1)*C1" });

    const e1 = await cell(page, "E1");
    expect(
      e1.formula,
      "the serialiser wrote the Rust VARIANT name instead of the function name " +
        "(`CELL` -> `CellFn`); re-parsing makes it an unknown user function, so the " +
        "cell silently becomes #NAME? with no error at either end",
    ).toContain("CELL(");
    expect(e1.display, "and the value went with it").toBe("1");

    expect(
      await cell(page, "F1"),
      "renaming a sheet re-spelled a defined name the rename does not touch " +
        "(`Anchor` -> `ANCHOR`): §2t's defect on the path §2t's fix does not reach",
    ).toEqual({ display: "4", formula: "=Anchor*2" });

    expect(
      await cell(page, "G1"),
      "renaming a sheet destroyed the named-LAMBDA call — the repair read the " +
        "DISPLAY form, which collapses the `__INVOKE__` marker, and stored the " +
        "collapsed text back",
    ).toEqual({ display: "42", formula: "=Twice(21)" });

    // ---- THE NAME TABLE ITSELF followed the rename, and nothing else moved.
    const names = await namedRanges(page);
    const anchor = names.find((n) => n.name === "Anchor");
    const twice = names.find((n) => n.name === "Twice");
    expect(
      anchor?.refersTo,
      "a defined name's target did not follow the sheet rename — the name now " +
        "points at a sheet that does not exist",
    ).toBe("=Facts!$A$1");
    expect(
      twice?.refersTo,
      "renaming an unrelated sheet rewrote a named LAMBDA's own definition, " +
        "re-spelling its PARAMETER — a local binding, which is exactly what §2t's " +
        "restamp refuses to touch",
    ).toBe("=LAMBDA(x, x*2)");

    // ---- THE COUNTERWEIGHT: the formula that SHOULD have followed, did — and
    // it still recalculates, which is the cross-sheet edge surviving the rename.
    expect(
      await storedCell(page, "Sheet2", "B1"),
      "precondition for the edge test: the cross-sheet formula must still read 2",
    ).toBe("2");
    await setCell(page, "A1", "999");
    await page.waitForTimeout(600);
    expect(
      await storedCell(page, "Sheet2", "B1"),
      "renaming the sheet orphaned the INCOMING cross-sheet edge: the cascade " +
        "looks up the new spelling, misses, and the dependent on another sheet " +
        "keeps the value it had — and saves it",
    ).toBe("999");
  });

  // =========================================================================
  // 2. AN UNKNOWN SHEET IS #REF!, NOT THE FORMULA'S OWN SHEET
  // =========================================================================
  test("a reference to a sheet that does not exist is #REF!", async ({ grid }) => {
    test.setTimeout(240_000);
    const page = grid.page;

    await newFile(page);
    await setCell(page, "A1", "100");
    await grid.navigateTo("B1");
    await grid.typeIntoCell("=NoSuchSheet!A1");
    await page.waitForTimeout(500);

    expect(
      (await cell(page, "B1")).display,
      "a qualified reference to a sheet that does not exist fell back to the " +
        "formula's OWN sheet and returned 100 — the workbook silently answers a " +
        "question about a sheet nobody has",
    ).toBe("#REF!");

    // COUNTERWEIGHT: a qualified reference to a sheet that DOES exist still works.
    await addSheetViaButton(page);
    await setCell(page, "A1", "7");
    await activateSheet(page, 0);
    await grid.navigateTo("C1");
    await grid.typeIntoCell("=Sheet2!A1");
    await page.waitForTimeout(500);
    expect(
      (await cell(page, "C1")).display,
      "the #REF! rule swallowed a reference to a sheet that really is there",
    ).toBe("7");
  });

  // =========================================================================
  // 3. DELETING A SHEET BREAKS ITS REFERENCES **AND RECALCULATES**
  // =========================================================================
  test("deleting a sheet turns its references into #REF! and re-evaluates everything downstream", async ({
    grid,
  }) => {
    test.setTimeout(300_000);
    const page = grid.page;

    await newFile(page);
    await addSheetViaButton(page);
    expect(await sheetNames(page), "the fixture needs two sheets").toEqual(["Sheet1", "Sheet2"]);
    await setCell(page, "A1", "5");
    await activateSheet(page, 0);

    await grid.navigateTo("A1");
    await grid.typeIntoCell("=Sheet2!A1");
    await grid.navigateTo("B1");
    await grid.typeIntoCell("=A1*10");
    await page.waitForTimeout(500);

    expect(
      [(await cell(page, "A1")).display, (await cell(page, "B1")).display],
      "precondition: the chain must be live before the sheet is deleted",
    ).toEqual(["5", "50"]);

    // ---- THE GESTURE: delete Sheet2 through the tab bar and its dialog.
    await deleteSheet(page, 1);

    expect(
      (await cell(page, "A1")).display,
      "the deleted sheet's reference was never repaired: the formula still names " +
        "a sheet that is gone",
    ).toBe("#REF!");
    expect(
      (await cell(page, "B1")).display,
      "the cell DOWNSTREAM of the broken reference kept the number it computed " +
        "while the sheet existed. Nothing recalculated after the repair, so 50 is " +
        "what a save would now write — a stale value with no formula behind it",
    ).toBe("#REF!");
  });

  // =========================================================================
  // 4. AND IT ALL SURVIVES THE BYTES
  // =========================================================================
  test("the same formulas come back unchanged from a save and reopen", async ({ grid }) => {
    test.setTimeout(300_000);
    const page = grid.page;

    await newFile(page);
    await setCell(page, "A1", "2");
    await setCell(page, "B1", "3");
    await setCell(page, "C1", "10");
    await defineName(page, "Anchor", "=Sheet1!$A$1");
    await grid.navigateTo("D1");
    await grid.typeIntoCell("=(A1+B1)*C1");
    await grid.navigateTo("E1");
    await grid.typeIntoCell('=CELL("row";A1)');
    await grid.navigateTo("F1");
    await grid.typeIntoCell("=Anchor*2");
    await page.waitForTimeout(500);

    const before = {
      D1: await cell(page, "D1"),
      E1: await cell(page, "E1"),
      F1: await cell(page, "F1"),
    };
    expect(before.D1.display, "precondition").toBe("50");
    expect(before.F1.formula, "precondition: the name keeps its authored spelling").toBe(
      "=Anchor*2",
    );

    await invoke(page, "save_file", { path: FILE });
    await expect
      .poll(() => fs.existsSync(FILE), { timeout: 20_000, intervals: [200] })
      .toBe(true);
    await newFile(page);
    await openAt(page, FILE);

    expect(
      { D1: await cell(page, "D1"), E1: await cell(page, "E1"), F1: await cell(page, "F1") },
      "a save and reopen changed a formula's text or its value",
    ).toEqual(before);
  });
});
