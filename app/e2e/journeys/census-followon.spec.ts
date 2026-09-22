/**
 * CENSUS FOLLOW-ON — the five claims of the dirty-flag / recalc census, proved
 * on the RUNNING app.
 *
 * The census closed with four contract verdicts and a `DocumentEffect` sweep
 * that touched every write path, including the per-keystroke one. Those
 * verdicts were established by reading and by unit tests. This spec supplies
 * the half no unit test can: that the user-visible consequence really follows,
 * in the real WebView, with no test double anywhere in the path.
 *
 * WHAT IS ASSERTED
 *   1. UNDO RESTORES DEPENDENT VALUES — same-sheet and CROSS-SHEET, on the
 *      rendered grid, after a typed edit and after a BULK paste. Redo follows
 *      forward again. §3b's verdict is that a restored LITERAL keeps its
 *      recorded value while a restored FORMULA re-derives; test 1c drives
 *      exactly that shape (a paste that replaces a formula with a literal) and
 *      then proves the restored formula is LIVE, not a cached number.
 *   2. The dirty flag still behaves after the per-keystroke `mutates()` removal.
 *   3. The inline editor expands over EMPTY neighbours and stops at an
 *      OCCUPIED one.
 *   4. Ctrl+Home lands on A1 every time, over many iterations — the reported
 *      defect was intermittent, so one pass proves nothing.
 *   5. A truncated cell's underline is as wide as the ELLIPSISED text, not as
 *      wide as the cell.
 *
 * WHY THIS IS A JOURNEY AND NOT A FUNCTIONAL SPEC. It calls `new_file`, it
 * saves the document to disk, and it adds a second sheet. The functional specs
 * share ONE accumulating workbook whose screenshot goldens encode the residue
 * of everything that ran before them, so a spec that wipes or re-identifies the
 * document belongs here.
 *
 * HOW THE CROSS-SHEET READS AVOID MASKING THEMSELVES. `get_cell` and
 * `get_viewport_cells` only ever answer for the ACTIVE sheet, and switching to
 * Sheet2 in order to read it runs `set_active_sheet`, which syncs the grid
 * mirror and rebuilds the dependency maps — precisely the machinery a stale
 * cross-sheet value would be hidden by. So every cross-sheet claim is asserted
 * TWICE and in this order: first through `get_workbook_state_digest` (a pure
 * read of the stored per-sheet grids, no mirror, no recalc, no rebuild) while
 * Sheet1 is still in front, and only then on the rendered Sheet2.
 *
 * VACUOUS-PASS DISCIPLINE. Every "must be X after undo" is preceded by a "must
 * be Y before it" on the same cell, so the assertion is a real transition and
 * not a value that never moved. Where that is not enough the teeth are spelled
 * out at the assertion.
 *
 * LOCALE. sv-SE: the formula argument separator is ';', never ','.
 *
 * GRID REAL ESTATE. Every test starts from `new_file`, so no other spec's
 * coordinates survive into these. Where the choice is free the tests use the
 * AF..AL block, which no functional spec claims.
 */
import type { Page } from "@playwright/test";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "../fixtures";
import { readGridGeometry, cellRangeRectFrom, parseCellRef, type GridHelper } from "../helpers/grid";
import { waitForGridStable } from "../helpers/screenshots";
import { diffCount, samplePixelGrid, type PixelClip, type PixelSample } from "../viewportSample";

const SAVE_FILE = path.join(os.tmpdir(), "calcula-census-followon.cala");

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

/** Call an exported function of one of the app's OWN modules, in its own realm. */
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

/**
 * Wipe the workbook through the app's OWN File > New path, not a raw
 * `invoke("new_file")`. The wrapper is what announces the change; the raw
 * command is the bypass, and a spec that starts from the bypass starts with
 * fixtures describing the previous document.
 */
async function newFile(page: Page): Promise<void> {
  await callModule(page, "/src/core/lib/file-api.ts", "newFile");
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("dimensions:refresh"));
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await page.waitForTimeout(700);
}

/**
 * The value STORED for a cell of a named sheet, read without activating it.
 * See the file header: this is the only non-masking cross-sheet read.
 */
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
 * `get_viewport_cells` is the command GridCanvas itself calls for the strings
 * it paints, so this is the rendered text and not a private backend field the
 * UI may never have fetched.
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

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

/**
 * A rectangle in CSS pixels — the sampler's own input type, not a copy of it.
 * This was a private `interface Clip` with the same four fields; aliasing the
 * real one means `rangeClip` below and the sampler it feeds cannot drift apart
 * without the compiler saying so.
 */
type Clip = PixelClip;

/** Viewport-relative clip of a cell range, from the app's LIVE geometry. */
async function rangeClip(page: Page, from: string, to: string, pad = 0): Promise<Clip> {
  const geo = await readGridGeometry(page);
  const rect = cellRangeRectFrom(from, to, geo);
  const box = await page.locator("canvas").first().boundingBox();
  if (!box) throw new Error("grid canvas has no bounding box");
  return {
    x: box.x + rect.x - pad,
    y: box.y + rect.y - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
}

// THE DECODE AND THE DIFF LIVE IN `../viewportSample`, NOT HERE.
//
// This file used to carry its own `pixelGrid` (a `page.screenshot({ clip })`
// plus an in-page decode) and its own `diffCount`. Nine journeys carried the
// same pair, at the same threshold, with the refusal spelled four different
// ways — one fact with nine spellings, which is how they drift.
//
// The shared sampler captures the WHOLE viewport and crops afterwards, inside
// the page. A clipped capture asks Chromium to put that rectangle on screen,
// which is not a passive read: it is why the shared helper exists at all (see
// that module's header for the measured evidence and for the day it failed to
// reproduce). Nothing in THIS spec hovers, so the clip was never hurting it —
// but the copy was, and the copy is what is gone.
//
// `PixelSample` carries the same four fields the local `PixelGrid` did. `scale`
// is device pixels per CSS pixel: a screenshot is in DEVICE pixels and a clip
// is in CSS pixels, so anything comparing a measured pixel column against a
// CSS-space length (see the underline probe in test 5) must divide by it.
//
// ONE NUMBER REALLY DID MOVE, AND IT WAS MEASURED RATHER THAN ASSUMED. `scale`
// now comes from the crop rectangle the helper asks for, not from the width
// Playwright's clipped PNG happened to come back with, and a cell boundary is
// not on a whole CSS pixel (columns are 64.29 wide), so the two disagree.
// Measured on the running app at dpr 2, on this test's own fixture — an
// underlined WMWM in a default-width cell, sampled both ways at one clip:
//
//                        OLD (clipped)   NEW (shared helper)
//   crop, device px      128x40          129x40
//   scale                1.9910          2.0065
//   background pixel     208,208,208     208,208,208   <- IDENTICAL
//   longest run, CSS px  51.23           50.83
//   underline ends at    53.74           53.33
//   glyphs end at        52.74           52.33
//
// Everything this test asserts is a DIFFERENCE between two of those, and the
// differences are unmoved: underline-minus-glyphs is 1.00 either way, and the
// gap to the old-code clamp (cell 64.29 less 3px padding = 61.29) is 7.96 here
// against 7.55 before, both far past the `> 4` the fixture demands. The
// background `inkRows` takes from the crop's top-left pixel is the same
// gridline byte on both paths, so the ink threshold means what it meant.
// Test 5 prints the scale it used next to every measurement derived from it;
// read that line rather than trusting this block if the numbers ever drift.

// ===========================================================================

test.describe.serial("Census follow-on — proved on the running app", () => {
  test.setTimeout(240_000);

  // =========================================================================
  // 1. UNDO RESTORES DEPENDENT VALUES
  // =========================================================================

  /**
   * Sheet1: A1 = source, A2 = "=A1*2"  (the same-sheet dependent)
   * Sheet2: A1 = "=Sheet1!A2"          (the cross-sheet dependent, rooted on a
   *                                     RECALCULATED cell, not on the edited one)
   *
   * Leaves Sheet1 active.
   */
  async function seedChain(page: Page, source: string): Promise<void> {
    await newFile(page);
    await invoke(page, "update_cell", { row: 0, col: 0, value: source });
    await invoke(page, "update_cell", { row: 1, col: 0, value: "=A1*2" });

    await addSheetViaUI(page);
    const sheets = await invoke<{ sheets: Array<{ name: string }>; activeIndex: number }>(
      page,
      "get_sheets",
    );
    expect(sheets.sheets.length, "the tab-bar button must really have added a sheet").toBe(2);
    expect(sheets.activeIndex, "the new sheet must be the active one").toBe(1);
    expect(sheets.sheets[1].name, "the new sheet is the one the digest reads").toBe("Sheet2");

    await invoke(page, "update_cell", { row: 0, col: 0, value: "=Sheet1!A2" });

    await activateSheetViaUI(page, 0);
    await page.waitForTimeout(300);
  }

  /**
   * Assert the whole chain with NO save, NO reload, NO `calculate_now` and NO
   * sheet switch between the mutation and the read. Sheet1 must be active.
   */
  async function assertChain(page: Page, source: number, label: string): Promise<void> {
    expect(await renderedCell(page, "A1"), `${label}: Sheet1!A1 (the source)`).toBe(String(source));
    expect(await renderedCell(page, "A2"), `${label}: Sheet1!A2 (same-sheet dependent)`).toBe(
      String(source * 2),
    );
    expect(await storedCell(page, "Sheet2", "A1"), `${label}: Sheet2!A1 (cross-sheet dependent)`).toBe(
      String(source * 2),
    );
  }

  /** The same claim on the RENDERED Sheet2, then back to Sheet1. */
  async function assertRenderedOnSheet2(page: Page, want: string, label: string): Promise<void> {
    await activateSheetViaUI(page, 1);
    await waitForGridStable(page);
    expect(await renderedCell(page, "A1"), `${label}: RENDERED Sheet2!A1`).toBe(want);
    await activateSheetViaUI(page, 0);
  }

  test("1a. Ctrl+Z restores same-sheet AND cross-sheet dependents on the rendered grid; Ctrl+Y follows forward", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await seedChain(page, "100");
      await assertChain(page, 100, "baseline");
      await assertRenderedOnSheet2(page, "200", "baseline");

      // --- THE REAL GESTURE: click the cell, type, press Enter. ---
      await grid.setCellValue("A1", "250");
      await page.waitForTimeout(600);
      // Guard the gesture itself: a dropped keystroke must fail HERE, saying
      // so, rather than downstream where it would look like a recalc defect.
      expect(await renderedCell(page, "A1"), "the typed edit must have landed intact").toBe("250");
      await assertChain(page, 250, "after typed edit");
      // The transition that gives the undo assertion its teeth: the dependents
      // really moved OFF their pre-edit values, so "back to 200" below cannot
      // pass on a chain that never changed.
      await assertRenderedOnSheet2(page, "500", "after typed edit");

      // --- UNDO. Ctrl+Z on the real grid. ---
      await grid.undo();
      await page.waitForTimeout(700);
      await assertChain(page, 100, "after Ctrl+Z");
      await assertRenderedOnSheet2(page, "200", "after Ctrl+Z");

      // --- REDO. Ctrl+Y on the real grid. ---
      await grid.redo();
      await page.waitForTimeout(700);
      await assertChain(page, 250, "after Ctrl+Y");
      await assertRenderedOnSheet2(page, "500", "after Ctrl+Y");
    } finally {
      await newFile(page);
    }
  });

  test("1b. Sheet2 REPAINTS when undo restores it — the pixels move, not just the model", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await seedChain(page, "100");
      await assertChain(page, 100, "baseline");

      // Photograph Sheet2 while it is genuinely visible, so the comparison is
      // against a real rendered frame and not a model read.
      await activateSheetViaUI(page, 1);
      await waitForGridStable(page);
      const clip = await rangeClip(page, "A1", "B2", 2);
      const atHundred = await samplePixelGrid(page, clip);
      await activateSheetViaUI(page, 0);

      await grid.setCellValue("A1", "250");
      await page.waitForTimeout(600);
      await activateSheetViaUI(page, 1);
      await waitForGridStable(page);
      const atTwoFifty = await samplePixelGrid(page, clip);
      await activateSheetViaUI(page, 0);

      expect(
        diffCount(atHundred.data, atTwoFifty.data),
        "Sheet2 must repaint for the EDIT — if it does not, the undo comparison below is meaningless",
      ).toBeGreaterThan(0);

      await grid.undo();
      await page.waitForTimeout(700);
      await activateSheetViaUI(page, 1);
      await waitForGridStable(page);
      const afterUndo = await samplePixelGrid(page, clip);
      await activateSheetViaUI(page, 0);

      expect(
        diffCount(atTwoFifty.data, afterUndo.data),
        "Sheet2 must repaint on UNDO — identical pixels mean the summary sheet still shows 500",
      ).toBeGreaterThan(0);
      expect(
        diffCount(atHundred.data, afterUndo.data),
        "and it must be back to the frame it had at 100 — a repaint to some THIRD state is not a restore",
      ).toBe(0);
    } finally {
      await newFile(page);
    }
  });

  test("1c. undoing a BULK PASTE restores the overwritten FORMULA, and the restored formula is live", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await seedChain(page, "100");
      await assertChain(page, 100, "baseline");

      // Staging block: two literals, parked out of the chain's way.
      await invoke(page, "update_cell", { row: 0, col: 3, value: "700" });
      await invoke(page, "update_cell", { row: 1, col: 3, value: "800" });
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
      await page.waitForTimeout(300);

      // --- THE BULK OP: copy D1:D2 onto A1:A2 through the ribbon's own
      //     Copy/Paste commands. This is the shape §3b's verdict is about —
      //     one transaction that replaces a LITERAL (A1) and a FORMULA (A2)
      //     at once, so undo has to restore one of each. ---
      await grid.selectRange("D1", "D2");
      await grid.clickFormatButton("copy");
      await grid.clickCell("A1");
      await grid.clickFormatButton("paste");
      await page.waitForTimeout(800);
      await page.keyboard.press("Escape"); // drop the marquee

      expect(await renderedCell(page, "A1"), "the paste must really have landed on A1").toBe("700");
      expect(
        await renderedCell(page, "A2"),
        "the paste must have REPLACED the formula in A2 with a literal",
      ).toBe("800");
      expect(
        await grid.getCellFormulaBarText("A2"),
        "A2 must now hold a literal, not a formula — otherwise the restore below proves nothing",
      ).toBe("800");
      expect(
        await storedCell(page, "Sheet2", "A1"),
        "the cross-sheet dependent must have followed the paste",
      ).toBe("800");

      // --- UNDO the bulk op. ---
      await grid.navigateTo("A1");
      await grid.undo();
      await page.waitForTimeout(900);

      expect(await renderedCell(page, "A1"), "undo: A1 (a restored LITERAL) keeps its recorded value").toBe(
        "100",
      );
      expect(
        await grid.getCellFormulaBarText("A2"),
        "undo: A2 must come back as the FORMULA, not as the number it happened to show",
      ).toBe("=A1*2");
      expect(await renderedCell(page, "A2"), "undo: A2 (a restored FORMULA) re-derives to 200").toBe(
        "200",
      );
      expect(
        await storedCell(page, "Sheet2", "A1"),
        "undo: the cross-sheet dependent must be consistent with the restored chain",
      ).toBe("200");
      await assertRenderedOnSheet2(page, "200", "after undoing the paste");

      // --- THE PART A BLANKET RECALC WOULD GET WRONG. A restored formula
      //     that merely holds a cached number looks identical to a live one
      //     until its input moves. Move it. ---
      await grid.setCellValue("A1", "400");
      await page.waitForTimeout(700);
      await assertChain(page, 400, "the restored formula is LIVE");
      await assertRenderedOnSheet2(page, "800", "the restored formula is LIVE");
    } finally {
      await page.keyboard.press("Escape");
      await newFile(page);
    }
  });

  // =========================================================================
  // 2. THE DIRTY FLAG, AFTER THE PER-KEYSTROKE `mutates()` REMOVAL
  // =========================================================================

  /**
   * The asterisk as the USER sees it. `updateWindowTitle()` renders
   * "name * - Calcula" when the document is dirty. Nothing is dispatched by
   * this spec to provoke it: the indicator's LIVENESS is the claim.
   */
  async function titleShowsDirty(page: Page): Promise<boolean> {
    return page.evaluate(() => / \* - Calcula$/.test(document.title));
  }

  /** How deep the backend's undo stack is right now. */
  async function undoDepth(page: Page): Promise<number> {
    const st = await invoke<{ undoDepth: number }>(page, "get_undo_state");
    return st.undoDepth;
  }

  test("2. a typed edit dirties, a read does not, and saving clears — on the path the sweep touched", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await invoke(page, "update_cell", { row: 0, col: 0, value: "seed" });
      await addSheetViaUI(page);
      await activateSheetViaUI(page, 0);
      await invoke(page, "save_file", { path: SAVE_FILE });
      await page.waitForTimeout(900);

      expect(await invoke<boolean>(page, "is_file_modified"), "saved => flag clean").toBe(false);
      expect(await titleShowsDirty(page), "saved => no asterisk").toBe(false);

      // ---- REGRESSION, found by this spec on 2026-08-07 and fixed in
      //      `sparkline_commands.rs`. The Sparklines extension saves
      //      unconditionally on every SHEET_CHANGED, and `save_sparklines`
      //      treated "write back the empty list you just read" as a change:
      //      it dirtied the document and pushed an undo entry that restored
      //      nothing. Two switches took the undo stack from 4 to 6 and lit the
      //      title asterisk on a document nobody had edited, so the close
      //      prompt lied AND the user's next Ctrl+Z popped a no-op instead of
      //      undoing their last edit. `set_active_sheet` declares itself
      //      deliberately clean precisely so that LOOKING cannot dirty; an
      //      extension must not be able to overrule that. ----
      const depthBeforeLooking = await undoDepth(page);
      await activateSheetViaUI(page, 1);
      await activateSheetViaUI(page, 0);
      await page.waitForTimeout(600);
      expect(
        await invoke<boolean>(page, "is_file_modified"),
        "merely LOOKING at another sheet must not dirty a saved document",
      ).toBe(false);
      expect(await titleShowsDirty(page), "and must not raise the asterisk").toBe(false);
      expect(
        await undoDepth(page),
        "and must not push undo entries — each one silently eats a Ctrl+Z",
      ).toBe(depthBeforeLooking);

      // ---- CONTROL. Reads must not dirty. Without this the headline could
      //      pass on a flag that is simply stuck true. ----
      expect(String((await invoke<{ display?: string } | null>(page, "get_cell", { row: 0, col: 0 }))?.display ?? "")).toBe(
        "seed",
      );
      await renderedCell(page, "A1");
      await invoke(page, "get_sheets");
      await page.waitForTimeout(700);
      expect(await invoke<boolean>(page, "is_file_modified"), "reads => flag still clean").toBe(false);
      expect(await titleShowsDirty(page), "reads => still no asterisk").toBe(false);

      // ---- THE HEADLINE. A real typed keystroke commit: `update_cell_impl` is
      //      the function the sweep edited (it built FOUR DocumentEffects; the
      //      trailing bare `let _ = ...mutates()` was removed). If that removal
      //      took the dirty mark with it, this is where it shows. ----
      await grid.setCellValue("B2", "typed");
      await page.waitForTimeout(900);

      expect(
        await invoke<boolean>(page, "is_file_modified"),
        "a typed edit must still set the dirty FLAG",
      ).toBe(true);
      expect(
        await titleShowsDirty(page),
        "a typed edit must still raise the ASTERISK, with nothing dispatched by the test",
      ).toBe(true);

      // ---- And saving clears it again, so the flag is not merely stuck true. ----
      await invoke(page, "save_file", { path: SAVE_FILE });
      await page.waitForTimeout(900);
      expect(await invoke<boolean>(page, "is_file_modified"), "saved again => flag clean").toBe(false);
      expect(await titleShowsDirty(page), "saved again => asterisk gone").toBe(false);

      // ---- One more clean/dirty transition, so the whole cycle is proved to
      //      repeat rather than to have fired once. ----
      await grid.setCellValue("B3", "again");
      await page.waitForTimeout(900);
      expect(await invoke<boolean>(page, "is_file_modified"), "second edit => dirty again").toBe(true);
      expect(await titleShowsDirty(page), "second edit => asterisk again").toBe(true);
    } finally {
      await invoke(page, "save_file", { path: SAVE_FILE }).catch(() => undefined);
      await newFile(page);
    }
  });

  // =========================================================================
  // 3. INLINE EDITOR EXPANSION
  // =========================================================================

  /**
   * The editor's RENDERED width in CSS pixels, read off the live DOM node.
   * `[data-inline-editor]` is the stable hook on the editor input; the class
   * name is a styled-components hash and cannot be selected on.
   */
  async function editorWidth(page: Page): Promise<number> {
    const box = await page.locator("[data-inline-editor]").boundingBox();
    if (!box) throw new Error("the inline editor is not on screen");
    return box.width;
  }

  /** The editor's rendered right edge in CSS pixels (page coordinates). */
  async function editorRight(page: Page): Promise<number> {
    const box = await page.locator("[data-inline-editor]").boundingBox();
    if (!box) throw new Error("the inline editor is not on screen");
    return box.x + box.width;
  }

  /** The editor's rendered left edge in CSS pixels (page coordinates). */
  async function editorLeft(page: Page): Promise<number> {
    const box = await page.locator("[data-inline-editor]").boundingBox();
    if (!box) throw new Error("the inline editor is not on screen");
    return box.x;
  }

  /**
   * Open the editor on `ref`, type `text`, and settle.
   *
   * `navigateTo` FIRST, always. The expansion rule has three limits — the text
   * width, the first occupied neighbour and the VIEWPORT edge — and the third
   * one silently outranks the other two. `clickCell` alone would not re-scroll a
   * cell that is already visible, so a cell sitting near the right edge produces
   * a box clamped by the window; the measurement is then correct behaviour that
   * says nothing about neighbours. That really happened on the first cold run
   * here: the unobstructed case measured 129.3 px and the obstructed one 128.6,
   * a 0.7 px "difference" that was pure coincidence. `navigateTo` parks the ref
   * at the LEFT of the viewport, and `assertRoomToExpand` below refuses to
   * measure if there is still not enough room.
   *
   * The dwell before the rest of the text is not padding either: neighbour
   * occupancy is fetched asynchronously and an UNANSWERED lookup counts as
   * OCCUPIED, so a measurement taken too early would report "no expansion" for
   * both cases — and the occupied assertion would pass vacuously. The two cases
   * use IDENTICAL timing, which is what makes the empty case the proof that the
   * lookup had answered.
   */
  async function typeIntoEditor(
    page: Page,
    grid: GridHelper,
    ref: string,
    text: string,
  ): Promise<void> {
    // Park `ref` at the LEFT of the viewport. Name Box navigation scrolls
    // MINIMALLY — a cell already on screen does not move at all — so a plain
    // `navigateTo` leaves the editor wherever the previous step happened to put
    // it. Jumping far to the RIGHT first puts `ref` off-screen to the left, and
    // the second jump then brings it back as the leftmost column.
    const far = ref.replace(/^[A-Za-z]+/, "CB");
    await grid.navigateTo(far);
    await grid.navigateTo(ref);
    await grid.clickCell(ref);
    await page.keyboard.type(text.slice(0, 1), { delay: 30 });
    await page.waitForTimeout(900); // let the neighbour-occupancy lookup answer
    await page.keyboard.type(text.slice(1), { delay: 15 });
    await page.waitForTimeout(500);
  }

  /**
   * Refuse to measure an editor whose expansion the WINDOW could be limiting.
   * Without this the whole test can quietly become "the viewport is narrow".
   */
  async function assertRoomToExpand(page: Page, needed: number): Promise<void> {
    const left = await editorLeft(page);
    const innerWidth = await page.evaluate(() => window.innerWidth);
    expect(
      innerWidth - left,
      `FIXTURE PRECONDITION: the editor at x=${left.toFixed(1)} must have at least ${needed} CSS px of window to its right, or the viewport clamp — not the neighbours — decides the width`,
    ).toBeGreaterThan(needed);
  }

  const LONG_ENTRY = "Quarterly revenue reconciliation, EMEA";
  /** What LONG_ENTRY needs at the cell font; measured live, never assumed. */
  const LONG_ENTRY_MIN_PX = 200;

  test("3. the inline editor expands to fit the entry, over an OCCUPIED neighbour exactly as over an empty one", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      // AH10 is occupied; AF10/AG10 and AK10/AL10 are empty. Two independent
      // cells so neither case can inherit the other's editor state.
      await invoke(page, "update_cell", { row: 9, col: 33, value: "WALL" }); // AH10
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
      await page.waitForTimeout(300);

      const geo = await readGridGeometry(page);
      const cellW = (geo.columnWidths[36] ?? geo.defaultCellWidth) * geo.zoom; // AK

      // ---- CONTROL: a SHORT entry must not expand at all. Without this,
      //      "the box is wide" could be true of every editor everywhere. ----
      await typeIntoEditor(page, grid, "AK10", "x");
      const shortW = await editorWidth(page);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      expect(
        Math.abs(shortW - cellW),
        `a short entry must leave the editor at its cell width (cell ${cellW.toFixed(1)}, editor ${shortW.toFixed(1)})`,
      ).toBeLessThanOrEqual(1.5);

      // ---- CASE A: EMPTY neighbours. The box must grow to fit the TEXT, which
      //      is four columns' worth — not merely "wider than one cell". ----
      await typeIntoEditor(page, grid, "AK10", LONG_ENTRY);
      await assertRoomToExpand(page, LONG_ENTRY_MIN_PX + cellW);
      const emptyW = await editorWidth(page);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      expect(
        emptyW,
        `with empty neighbours the editor must grow to fit the entry, spanning several columns (cell ${cellW.toFixed(1)}, editor ${emptyW.toFixed(1)})`,
      ).toBeGreaterThan(cellW * 3);
      expect(
        emptyW,
        `and it must HUG the text rather than swallowing the rest of the row (editor ${emptyW.toFixed(1)})`,
      ).toBeLessThan(cellW * 6);

      // ---- CASE B: an OCCUPIED neighbour two columns along. AF10 grows over
      //      AG10 (empty) AND over AH10 (which holds "WALL"), to the SAME width
      //      as case A. Same text, same timing, and — enforced below — the same
      //      absence of a viewport clamp, so the only difference between A and B
      //      is the neighbour's content, and the editor's width must not depend
      //      on it at all.
      //
      //      THIS ASSERTION USED TO BE ITS OPPOSITE ("must stop before the
      //      occupied cell") AND THE PRODUCT DELIBERATELY REMOVED THAT RULE.
      //      DO NOT "fix" it back. Excel's in-cell editor is an OVERLAY: while
      //      an edit is open the box floats above the grid, covers whatever is
      //      beside it regardless of content, and everything it covered repaints
      //      untouched when the edit ends. Refusing to grow over a neighbour
      //      that holds data is a real Excel rule, but it governs DISPLAY (how a
      //      long value spills when it is NOT being edited), not EDITING, and
      //      applying it here produced the opposite of parity: an entry with an
      //      occupied neighbour had nowhere to go and scrolled inside one
      //      column, which Excel never does. The whole argument, and the three
      //      rules that replaced it, are in the header of
      //      src/core/components/InlineEditor/expansion.ts; the exact-pixel unit
      //      tests in expansion.test.ts state in their own header that the
      //      removal of the "stops at the first occupied cell" assertions is the
      //      point and not an omission. There is no occupancy input to
      //      `computeExpandedEditorWidth` at all any more — it takes x,
      //      baseWidth, desiredWidth and the GRID's right edge, and nothing
      //      else — so a wall here could only come back by re-adding a backend
      //      lookup to the keystroke path.
      await typeIntoEditor(page, grid, "AF10", LONG_ENTRY);
      await assertRoomToExpand(page, LONG_ENTRY_MIN_PX + cellW);
      const occupiedRight = await editorRight(page);
      const wallClip = await rangeClip(page, "AH10", "AH10");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);

      expect(
        occupiedRight,
        `the editor must cover the occupied cell, not stop at it (editor right ${occupiedRight.toFixed(1)}, AH10 starts at ${wallClip.x.toFixed(1)})`,
      ).toBeGreaterThan(wallClip.x);

      // TEETH, and they are what keeps this a test rather than a tautology: the
      // width must be the width the TEXT needs, which is the same number case A
      // arrived at with nothing in the way. A box that swallowed the rest of the
      // row would also be "greater than the wall", and so would the old
      // one-column-scroll failure if the wall happened to sit close enough.
      const occupiedW = occupiedRight - (await rangeClip(page, "AF10", "AF10")).x;
      expect(
        Math.abs(occupiedW - emptyW),
        `the occupied case must come out the SAME width as the unobstructed one — the neighbour's content is not an input (empty ${emptyW.toFixed(1)}, occupied ${occupiedW.toFixed(1)})`,
      ).toBeLessThanOrEqual(2);
      expect(
        occupiedW,
        "and it must still HUG the text rather than swallowing the rest of the row",
      ).toBeLessThan(cellW * 6);

      console.log(
        `[census-followon] inline editor: cell ${cellW.toFixed(1)} CSS px | short entry ${shortW.toFixed(1)} | empty neighbours ${emptyW.toFixed(1)} | occupied neighbour ${occupiedW.toFixed(1)}`,
      );
    } finally {
      await page.keyboard.press("Escape");
      await newFile(page);
    }
  });

  // =========================================================================
  // 4. Ctrl+Home
  // =========================================================================

  /**
   * Where the grid thinks the active cell is, and where the viewport is.
   * Read from `__CALCULA_GRID_STATE__`, which GridContext publishes on every
   * render — the same object the renderer draws from.
   */
  async function gridPosition(page: Page): Promise<{
    row: number;
    col: number;
    scrollX: number;
    scrollY: number;
  }> {
    return page.evaluate(() => {
      const gs = (window as unknown as { __CALCULA_GRID_STATE__?: {
        selection?: { endRow: number; endCol: number } | null;
        viewport?: { scrollX?: number; scrollY?: number };
      } }).__CALCULA_GRID_STATE__;
      return {
        row: gs?.selection?.endRow ?? -1,
        col: gs?.selection?.endCol ?? -1,
        scrollX: gs?.viewport?.scrollX ?? -1,
        scrollY: gs?.viewport?.scrollY ?? -1,
      };
    });
  }

  /**
   * Send Ctrl+Home the way a user does.
   *
   * `page.keyboard.press("Control+Home")` is tried FIRST and used for the whole
   * run if it works. WebView2 is documented in `fixtures.ts` as swallowing some
   * Control combos before they reach the grid's handler, which is a property of
   * the CDP harness and not of Calcula; if that happens the fallback dispatches
   * the identical KeyboardEvent on the spreadsheet container, which is the exact
   * entry point `useGridKeyboard.handleKeyDown` is bound to. Either way the
   * app's own navigation code — the serialised nav chain the defect lived in —
   * is what runs. Which route was used is reported.
   */
  async function pressCtrlHome(page: Page, real: boolean): Promise<void> {
    if (real) {
      await page.keyboard.press("Control+Home");
      return;
    }
    await page.locator("[data-focus-container='spreadsheet']").evaluate((el) => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Home",
          code: "Home",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  }

  test("4. Ctrl+Home reaches A1 on every one of 10 iterations, and chains correctly on 10 more", async ({
    appPage: page,
    grid,
  }) => {
    const ITERATIONS = 10;
    try {
      await newFile(page);

      // Probe once to choose the route, from a genuinely scrolled position.
      await grid.navigateTo("AJ400");
      await page.locator("[data-focus-container='spreadsheet']").focus();
      await page.waitForTimeout(300);
      await pressCtrlHome(page, true);
      await page.waitForTimeout(700);
      const probe = await gridPosition(page);
      const useRealKey = probe.row === 0 && probe.col === 0;
      console.log(
        `[census-followon] Ctrl+Home route: ${useRealKey ? "REAL page.keyboard.press" : "dispatched KeyboardEvent (WebView2 swallowed the real combo)"}`,
      );

      // ---- PART 1: 10 plain iterations. ----
      let plainReached = 0;
      for (let i = 0; i < ITERATIONS; i++) {
        // Navigate away to a different deep, scrolled position each time.
        const away = `${["AF", "AG", "AH", "AI", "AJ"][i % 5]}${200 + i * 53}`;
        await grid.navigateTo(away);
        await page.locator("[data-focus-container='spreadsheet']").focus();
        await page.waitForTimeout(250);

        const before = await gridPosition(page);
        expect(
          before.row === 0 && before.col === 0,
          `iteration ${i}: the grid must have really moved away from A1 first (${away})`,
        ).toBe(false);
        expect(
          before.scrollY,
          `iteration ${i}: the viewport must really be scrolled before Ctrl+Home`,
        ).toBeGreaterThan(0);

        await pressCtrlHome(page, useRealKey);
        await page.waitForTimeout(650);

        const after = await gridPosition(page);
        expect(after.row, `iteration ${i}: Ctrl+Home must land on row 1`).toBe(0);
        expect(after.col, `iteration ${i}: Ctrl+Home must land on column A`).toBe(0);
        expect(after.scrollX, `iteration ${i}: and scroll the viewport home (x)`).toBe(0);
        expect(after.scrollY, `iteration ${i}: and scroll the viewport home (y)`).toBe(0);
        plainReached++;
      }
      expect(plainReached, "every plain iteration must have landed").toBe(ITERATIONS);

      // ---- PART 2: the reported shape. Ctrl+Home IMMEDIATELY followed by
      //      ArrowRight, with no dwell between them, must land on B1. The
      //      original report ("Ctrl+Home is intermittently swallowed") was
      //      this: from A5 it produced B5, because ArrowRight chained off the
      //      PRE-Ctrl+Home selection and its dispatch landed last. ----
      let chainedReached = 0;
      for (let i = 0; i < ITERATIONS; i++) {
        await grid.navigateTo(`${["AF", "AG", "AH", "AI", "AJ"][i % 5]}${180 + i * 41}`);
        await page.locator("[data-focus-container='spreadsheet']").focus();
        await page.waitForTimeout(250);

        const before = await gridPosition(page);
        expect(
          before.row === 0 && before.col === 1,
          `chained iteration ${i}: must not already be at B1`,
        ).toBe(false);

        await pressCtrlHome(page, useRealKey);
        await page.keyboard.press("ArrowRight"); // deliberately no dwell
        await page.waitForTimeout(900);

        const after = await gridPosition(page);
        expect(
          `${after.row},${after.col}`,
          `chained iteration ${i}: Ctrl+Home then ArrowRight must land on B1, not on the row it started from`,
        ).toBe("0,1");
        chainedReached++;
      }
      expect(chainedReached, "every chained iteration must have landed").toBe(ITERATIONS);

      console.log(
        `[census-followon] Ctrl+Home: ${plainReached}/${ITERATIONS} plain, ${chainedReached}/${ITERATIONS} chained with ArrowRight`,
      );
    } finally {
      await newFile(page);
    }
  });

  // =========================================================================
  // 5. TRUNCATED-CELL UNDERLINE
  // =========================================================================

  interface InkRow {
    /** Rightmost ink column, device px relative to the clip. */
    right: number;
    /** Longest contiguous run of ink on this row, device px. */
    run: number;
  }

  /**
   * Per-row ink analysis of a captured cell.
   *
   * "Ink" is any pixel far from the cell's background. The background is taken
   * from the clip's top-left corner, which the renderer leaves blank (padding
   * is 3px and the text starts below the top padding). Gridlines are #f1f1f1
   * on white — a distance of 14, an order of magnitude under the threshold —
   * so they are not ink, but glyphs and rules are.
   */
  function inkRows(px: PixelSample, threshold = 60): InkRow[] {
    const bg = [px.data[0], px.data[1], px.data[2]];
    const rows: InkRow[] = [];
    for (let y = 0; y < px.height; y++) {
      let right = -1;
      let run = 0;
      let cur = 0;
      for (let x = 0; x < px.width; x++) {
        const i = (y * px.width + x) * 4;
        const isInk =
          Math.abs(px.data[i] - bg[0]) > threshold ||
          Math.abs(px.data[i + 1] - bg[1]) > threshold ||
          Math.abs(px.data[i + 2] - bg[2]) > threshold;
        if (isInk) {
          right = x;
          cur++;
          if (cur > run) run = cur;
        } else {
          cur = 0;
        }
      }
      rows.push({ right, run });
    }
    return rows;
  }

  // RE-AIMED WHEN CALCULA ADOPTED EXCEL'S OVERFLOW RULE (§21c item 3).
  //
  // The original fixture was an over-long TEXT value, and its teeth came from
  // the gap between where the ELLIPSISED string ended and where the old code's
  // "measure the full string, clamp to the cell" answer would have drawn. Excel
  // does not ellipsise — it CLIPS at the cell edge — so for an over-long value
  // the glyphs and the clamp now legitimately coincide, and that fixture can no
  // longer tell a correct renderer from the broken one. Left alone it would have
  // gone on "passing" while measuring nothing, which is worse than failing.
  //
  // The invariant is unchanged: A RULE MUST SPAN THE GLYPHS THAT WERE PAINTED,
  // NOT THE STRING THE CELL HOLDS. What changed is where that still bites, and
  // the fixture below moved to it: a value that FITS, whose glyphs stop a long
  // way short of the cell's inner edge. That gap is the discrimination, and it
  // is far larger than the old one — the old-code answer (clamp to the cell)
  // misses by tens of pixels rather than by a few.
  test("5. an underline is as wide as the GLYPHS PAINTED, not as wide as the cell", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);

      // Uniformly WIDE glyphs, short enough to fit the column with room to
      // spare. The width of the glyphs is what makes the "rule spans the text"
      // and "rule spans the cell" answers differ by a large, unambiguous margin.
      const WIDE = "WMWM";
      await invoke(page, "update_cell", { row: 19, col: 31, value: WIDE }); // AF20
      await invoke(page, "update_cell", { row: 19, col: 32, value: "X" }); // AG20 — blocks any spill
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
      await page.waitForTimeout(400);

      // Underline it through the ribbon, like a user.
      await grid.clickCell("AF20");
      await grid.toggleUnderline();
      await page.waitForTimeout(400);
      expect(
        await grid.getCellStyleProp("AF20", "underline"),
        "the ribbon must really have underlined AF20",
      ).toBe(true);

      // Move the selection far away: the active-cell border is accent-coloured
      // ink drawn ON the cell edges and would dominate every rightmost-ink
      // measurement below.
      await grid.navigateTo("AF20");
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent("app:navigate-to-cell", { detail: { row: 19, col: 39, select: true } }),
        ),
      );
      await page.waitForTimeout(400);
      await waitForGridStable(page);

      const clip = await rangeClip(page, "AF20", "AF20");
      const px = await samplePixelGrid(page, clip);
      const rows = inkRows(px);

      // The underline is the row with the longest CONTIGUOUS run of ink; glyph
      // rows are broken by the gaps between letters.
      let ulIndex = -1;
      let ulRun = 0;
      for (let y = 0; y < rows.length; y++) {
        if (rows[y].run > ulRun) {
          ulRun = rows[y].run;
          ulIndex = y;
        }
      }
      expect(
        ulRun / px.scale,
        `an underline must be present as a long unbroken rule (longest run ${(ulRun / px.scale).toFixed(1)} CSS px)`,
      ).toBeGreaterThan(20);

      const underlineRight = rows[ulIndex].right / px.scale;

      // The glyphs: every row except the underline and its antialiasing
      // neighbours.
      let textRight = -1;
      for (let y = 0; y < rows.length; y++) {
        if (Math.abs(y - ulIndex) <= 1) continue;
        if (rows[y].right > textRight) textRight = rows[y].right;
      }
      const glyphRight = textRight / px.scale;
      expect(glyphRight, "the cell must actually have painted glyphs").toBeGreaterThan(0);

      // THE CLAIM: the rule stops where the painted glyphs stop.
      expect(
        underlineRight,
        `the underline must not run past the visible text (underline ends ${underlineRight.toFixed(1)}, glyphs end ${glyphRight.toFixed(1)}, CSS px into the cell)`,
      ).toBeLessThanOrEqual(glyphRight + 3);
      expect(
        underlineRight,
        "and it must actually cover the text — a rule that stops far short is the same defect mirrored",
      ).toBeGreaterThanOrEqual(glyphRight - 6);

      // TEETH: where the pre-fix code would have drawn. It measured the FULL
      // string and clamped to the cell, i.e. to the inner edge at
      // cellWidth - paddingX. If that is not measurably further right than the
      // answer above, this fixture does not discriminate and the assertion
      // would be passing for free.
      const PADDING_X = 3;
      const clampRight = clip.width - PADDING_X;
      console.log(
        `[census-followon] underline probe: cell ${clip.width.toFixed(1)} CSS px, glyphs end ${glyphRight.toFixed(1)}, underline ends ${underlineRight.toFixed(1)}, old-code clamp ${clampRight.toFixed(1)} (capture scale ${px.scale})`,
      );
      expect(
        clampRight - underlineRight,
        `the fixture must discriminate: the cell-clamp the old code used is at ${clampRight.toFixed(1)} and the underline ends at ${underlineRight.toFixed(1)} — too small a gap and this test proves nothing`,
      ).toBeGreaterThan(4);
      // ...and the strongest form of the same statement: the answer the OLD
      // code would have produced fails the very assertion that just passed.
      expect(
        clampRight > glyphRight + 3,
        `the pre-fix underline (to the cell clamp at ${clampRight.toFixed(1)}) must be REJECTED by the tolerance used above (glyphs end ${glyphRight.toFixed(1)}) — otherwise this test would pass for the buggy renderer too`,
      ).toBe(true);
    } finally {
      await newFile(page);
    }
  });
});
