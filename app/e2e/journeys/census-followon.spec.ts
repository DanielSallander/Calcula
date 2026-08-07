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

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

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

interface PixelGrid {
  data: number[];
  width: number;
  height: number;
  /** Device pixels per CSS pixel in this capture. */
  scale: number;
}

/**
 * Raw RGBA of a clip, decoded in the page (no image dependency in Node), plus
 * the capture's device scale — a screenshot is in DEVICE pixels and the clip is
 * in CSS pixels, so anything that compares a measured pixel column against a
 * CSS-space length must divide by this.
 */
async function pixelGrid(page: Page, clip: Clip): Promise<PixelGrid> {
  const png = await page.screenshot({ clip });
  const decoded = await page.evaluate(async (b64: string) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context for pixel decode");
    ctx.drawImage(bitmap, 0, 0);
    return {
      data: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data),
      width: canvas.width,
      height: canvas.height,
    };
  }, png.toString("base64"));
  return { ...decoded, scale: decoded.width / clip.width };
}

/** Pixels differing by more than a hair between two same-sized captures. */
function diffCount(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`capture sizes differ (${a.length} vs ${b.length}) — the clip moved`);
  }
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (
      Math.abs(a[i] - b[i]) > 8 ||
      Math.abs(a[i + 1] - b[i + 1]) > 8 ||
      Math.abs(a[i + 2] - b[i + 2]) > 8
    ) {
      n++;
    }
  }
  return n;
}

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
      const atHundred = await pixelGrid(page, clip);
      await activateSheetViaUI(page, 0);

      await grid.setCellValue("A1", "250");
      await page.waitForTimeout(600);
      await activateSheetViaUI(page, 1);
      await waitForGridStable(page);
      const atTwoFifty = await pixelGrid(page, clip);
      await activateSheetViaUI(page, 0);

      expect(
        diffCount(atHundred.data, atTwoFifty.data),
        "Sheet2 must repaint for the EDIT — if it does not, the undo comparison below is meaningless",
      ).toBeGreaterThan(0);

      await grid.undo();
      await page.waitForTimeout(700);
      await activateSheetViaUI(page, 1);
      await waitForGridStable(page);
      const afterUndo = await pixelGrid(page, clip);
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

  test("3. the inline editor expands over EMPTY neighbours and stops at an OCCUPIED one", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      // AH10 is occupied so the OCCUPIED case has a wall; AF10/AG10 and
      // AK10/AL10 are empty. Two independent cells so neither case can inherit
      // the other's editor state.
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

      // ---- CASE B: an OCCUPIED neighbour two columns along. AF10 may grow
      //      over AG10 (empty) but must NOT cover AH10 (which holds "WALL").
      //      Same text, same timing, and — enforced below — the same absence of
      //      a viewport clamp, so the ONLY difference between A and B is the
      //      wall. ----
      await typeIntoEditor(page, grid, "AF10", LONG_ENTRY);
      await assertRoomToExpand(page, LONG_ENTRY_MIN_PX + cellW);
      const occupiedRight = await editorRight(page);
      const wallClip = await rangeClip(page, "AH10", "AH10");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);

      expect(
        occupiedRight,
        `the editor must stop before the occupied cell (editor right ${occupiedRight.toFixed(1)}, AH10 starts at ${wallClip.x.toFixed(1)})`,
      ).toBeLessThanOrEqual(wallClip.x + 1);

      // Teeth for CASE B: the SAME text at the SAME timing did expand in case
      // A, so "did not expand over AH10" is a decision and not a lookup that
      // had not answered yet. And it did use the one empty column it had.
      const occupiedW = occupiedRight - (await rangeClip(page, "AF10", "AF10")).x;
      expect(
        occupiedW,
        "the editor must still have used the ONE empty neighbour it was allowed (AG10) — stopping at its own cell would be a different bug",
      ).toBeGreaterThan(cellW * 1.5);
      expect(
        occupiedW,
        `and it must be MATERIALLY narrower than the unobstructed case (${emptyW.toFixed(1)}) — a few pixels apart would be coincidence, not a wall`,
      ).toBeLessThan(emptyW - cellW);

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
  function inkRows(px: PixelGrid, threshold = 60): InkRow[] {
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

  test("5. a truncated cell's underline is as wide as the ELLIPSISED text, not as wide as the cell", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);

      // A string of uniformly WIDE glyphs. The point of the fixture is that the
      // character which does NOT fit is wide, so the ellipsised string ends a
      // long way short of the cell's inner edge — which is where the old code
      // (measure the FULL string, clamp to the cell) would have drawn to. With
      // narrow glyphs the two answers can differ by a single pixel and the
      // assertion would have no teeth.
      const WIDE = "WMWMWMWMWMWMWMWMWMWM";
      await invoke(page, "update_cell", { row: 19, col: 31, value: WIDE }); // AF20
      await invoke(page, "update_cell", { row: 19, col: 32, value: "X" }); // AG20 — the wall that forces truncation
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
      const px = await pixelGrid(page, clip);
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

      // THE CLAIM: the rule stops where the ellipsised text stops.
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
