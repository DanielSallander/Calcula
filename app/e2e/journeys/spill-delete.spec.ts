/**
 * §2y THROUGH THE REAL UI — deleting the ORIGIN of a spilled array.
 *
 * WHAT §2y WAS. `clear_range` (what the Delete key runs) cleared the cell and
 * never touched `spill_ranges`. The map went on claiming the spilled cells for
 * a formula that no longer existed, so:
 *   - A2:A4 kept painting 2 3 4, values no formula in the document produces;
 *   - typing into one was REFUSED, naming a source cell that was already empty;
 *   - selecting the whole block and pressing Delete was refused by the same
 *     guard — both remedies the product offers were impossible to follow;
 *   - saving wrote those values as ordinary literals.
 *
 * The fix moved the tear-down to a CHOKE POINT
 * (`recalc_after_active_sheet_bulk_rewrite`): a seed that no longer holds a
 * formula releases whatever spill it owned. Eleven writers reach it, including
 * `clear_range`, `clear_cell`, `sort_range`, undo and redo.
 *
 * WHY THIS SPEC EXISTS. The closing pass proved all of that with 30 in-process
 * Rust tests and stated plainly that the live projects were not re-run: the
 * only unreproduced piece was `clear_range`'s `#[tauri::command]` wrapper and
 * the actual DELETE KEY. This spec supplies exactly that — the real key on the
 * real grid, read back through the command the canvas itself paints from, plus
 * the pixels, plus the bytes on disk.
 *
 * WHAT IS ASSERTED
 *   1. The reproduction, gesture for gesture: `=SEQUENCE(...)` in a cell, the
 *      REAL Delete key, the spilled cells GONE from the rendered grid (both the
 *      painted strings and the pixels), the neighbours EDITABLE again, and
 *      undo restoring the formula AND its spill.
 *   2. The other impossible remedy: select the whole spilled block, press
 *      Delete. Pre-fix this was refused; it must now clear.
 *   3. The bytes: a Delete then a Save must not leave orphan literals in the
 *      archive. Guarded against vacuity by first proving the archive DOES hold
 *      them while the array is alive.
 *   4. Redo takes it down again — the redo half of the choke point, which the
 *      register calls out as covered by the same rule and by no remembered call
 *      site.
 *
 * TEETH. Test 1 fails on a build whose tear-down is disabled: the values are
 * still painted, the neighbour edit is refused, and undo cannot restore. That
 * was demonstrated by sabotaging `recalc_after_active_sheet_bulk_rewrite` on
 * the running build and re-running this file; see the register (§3bd).
 *
 * VACUOUS-PASS DISCIPLINE. Every "gone" assertion is preceded by the matching
 * "present" assertion on the same cells, read by the same reader. Every "the
 * edit is accepted" is preceded by proof the cell was not already holding that
 * value.
 *
 * WHY A JOURNEY. It calls File > New and writes `.cala` files to disk.
 *
 * GRID REAL ESTATE. Columns EA..EF (130..135), rows 5..20 — claimed by no other
 * spec. Every test starts from File > New anyway.
 *
 * LOCALE. sv-SE: the formula list separator is ';', never ','.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import {
  readGridGeometry,
  cellRangeRectFrom,
  parseCellRef,
  type GridHelper,
} from "../helpers/grid";
import { waitForGridStable } from "../helpers/screenshots";

const FILE_ALIVE = path.join(os.tmpdir(), "calcula-spill-delete-alive.cala");
const FILE_DELETED = path.join(os.tmpdir(), "calcula-spill-delete-deleted.cala");

/** The spill origin, and the three cells its array spills onto. */
const ORIGIN = "EB5";
const SPILLED = ["EB6", "EB7", "EB8"] as const;
const WHOLE = ["EB5", "EB6", "EB7", "EB8"] as const;

/**
 * A start value nobody else's fixture could produce, so the byte oracle below
 * is looking for THIS array and not for a stray "2". `SEQUENCE(rows;cols;start)`
 * — three arguments, sv-SE separators.
 */
const FORMULA = "=SEQUENCE(4;1;424243)";
const VALUES = ["424243", "424244", "424245", "424246"] as const;

// ---------------------------------------------------------------------------
// Plumbing — setup and oracles only. Every gesture under test goes through the
// real UI.
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

/** File > New through the app's own path, not the raw command. */
async function newFile(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await callModule(page, "/src/core/lib/file-api.ts", "newFile");
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("dimensions:refresh"));
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await page.waitForTimeout(900);
}

/**
 * The display string the CANVAS has for a cell of the active sheet.
 * `get_viewport_cells` is the command GridCanvas itself calls for the strings
 * it paints, so this is the rendered text — not a private backend field the UI
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

async function renderedBlock(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const ref of WHOLE) out.push(await renderedCell(page, ref));
  return out;
}

/** The stored formula of a cell — what the formula bar would show. */
async function storedFormula(page: Page, ref: string): Promise<string> {
  const { row, col } = parseCellRef(ref);
  const cell = await invoke<{ formula?: string | null } | null>(page, "get_cell", { row, col });
  return cell?.formula ?? "";
}

interface SpillRange {
  originRow: number;
  originCol: number;
  endRow: number;
  endCol: number;
}

/** The spill map for the ACTIVE sheet — the store the whole defect is about. */
async function spillRanges(page: Page): Promise<SpillRange[]> {
  return invoke<SpillRange[]>(page, "get_spill_ranges");
}

// ---------------------------------------------------------------------------
// Pixels — "gone from the rendered grid" means gone from the canvas.
// ---------------------------------------------------------------------------

interface Capture {
  data: number[];
  width: number;
  height: number;
}

/** Raw RGBA of the block's rectangle, decoded inside the page. */
async function captureBlock(page: Page): Promise<Capture> {
  const geo = await readGridGeometry(page);
  const rect = cellRangeRectFrom(WHOLE[0], WHOLE[WHOLE.length - 1], geo);
  const box = await page.locator("canvas").first().boundingBox();
  if (!box) throw new Error("the grid canvas has no bounding box");
  // Two pixels of padding so a spill BORDER painted just outside the cell
  // rectangle is inside the capture. The border is part of what must disappear.
  const pad = 3;
  const clip = {
    x: box.x + rect.x - pad,
    y: box.y + rect.y - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
  const png = await page.screenshot({ clip });
  return page.evaluate(async (b64: string) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context for the pixel decode");
    ctx.drawImage(bitmap, 0, 0);
    return {
      data: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data),
      width: canvas.width,
      height: canvas.height,
    };
  }, png.toString("base64"));
}

/** Pixels differing by more than a hair between two same-sized captures. */
function diffCount(a: Capture, b: Capture): number {
  if (a.data.length !== b.data.length) {
    throw new Error(
      `capture sizes differ (${a.width}x${a.height} vs ${b.width}x${b.height}) — ` +
        `the clip moved between captures, so the comparison means nothing`,
    );
  }
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      Math.abs(a.data[i] - b.data[i]) > 8 ||
      Math.abs(a.data[i + 1] - b.data[i + 1]) > 8 ||
      Math.abs(a.data[i + 2] - b.data[i + 2]) > 8
    ) {
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// THE ORACLE ON DISK. Decompresses every entry of the `.cala` and THROWS on any
// parse failure: the assertions built on it are absences, and "" satisfies them
// all. Same discipline as `document-store-leak.spec.ts`.
// ---------------------------------------------------------------------------

function calaText(file: string): string {
  if (!fs.existsSync(file)) {
    throw new Error(`the archive is missing at ${file} — nothing was saved`);
  }
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 66_000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error(
      `${file} has no ZIP end-of-central-directory record — it is not a plain .cala`,
    );
  }
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const parts: string[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) {
      throw new Error(`${file}: central directory entry ${n} has a bad signature`);
    }
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`${file}: entry ${n} has no local header at its recorded offset`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) parts.push(raw.toString("utf8"));
    else if (method === 8) parts.push(zlib.inflateRawSync(raw).toString("utf8"));
    else throw new Error(`${file}: entry ${n} uses unsupported compression method ${method}`);
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (parts.length === 0) {
    throw new Error(`${file} contains no entries at all — the parse is broken`);
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// The gestures, all through the real UI.
// ---------------------------------------------------------------------------

/** Type the array formula into the origin through the REAL inline editor. */
async function typeArrayFormula(grid: GridHelper): Promise<void> {
  await grid.navigateTo(ORIGIN);
  await grid.typeIntoCell(FORMULA);
  await grid.page.waitForTimeout(400);
}

/** Select the origin and press the REAL Delete key. */
async function pressDeleteOn(grid: GridHelper, ref: string): Promise<void> {
  await grid.navigateTo(ref);
  await grid.page.keyboard.press("Delete");
  await grid.page.waitForTimeout(500);
}

// ===========================================================================

test.describe.serial("§2y — the Delete key on a spill origin", () => {
  test.beforeAll(() => {
    for (const f of [FILE_ALIVE, FILE_DELETED]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  // =========================================================================
  // 1. THE REPRODUCTION, GESTURE FOR GESTURE
  // =========================================================================
  test("Delete on the origin: the spill is gone from the grid, the neighbours are editable, and undo brings both back", async ({
    grid,
  }) => {
    test.setTimeout(240_000);
    const page = grid.page;

    await newFile(page);
    await grid.navigateTo(ORIGIN);
    await waitForGridStable(page);

    // ---- The EMPTY reference frame. Captured with the selection already on
    // the origin so the active-cell chrome is identical in every capture and
    // the only thing a diff can see is the array itself.
    const empty = await captureBlock(page);

    // ---- Type the array formula through the real inline editor.
    await typeArrayFormula(grid);
    await grid.navigateTo(ORIGIN);
    await waitForGridStable(page);

    // ---- PRECONDITION: the array really spilled, on the rendered grid and in
    // the map. Everything below is an absence; without this the whole test
    // could pass against a formula that never evaluated.
    expect(
      await renderedBlock(page),
      "precondition: the array must really be painted before its removal can mean anything",
    ).toEqual([...VALUES]);
    const spillBefore = await spillRanges(page);
    const { row: oRow, col: oCol } = parseCellRef(ORIGIN);
    expect(
      spillBefore,
      "precondition: the spill map must hold exactly this array",
    ).toEqual([{ originRow: oRow, originCol: oCol, endRow: oRow + 3, endCol: oCol }]);

    const filled = await captureBlock(page);
    const inkOfTheArray = diffCount(empty, filled);
    expect(
      inkOfTheArray,
      "precondition: typing the array must visibly change the canvas, or the " +
        "pixel assertion below is comparing two identical blanks",
    ).toBeGreaterThan(50);

    // =====================================================================
    // THE GESTURE: the REAL Delete key on the origin. Not `clear_range`, not
    // a command — the key. §2y exists because the store-level probe used
    // `update_cell(row, col, "")`, which is a different command with a
    // different (correct) tear-down.
    // =====================================================================
    await pressDeleteOn(grid, ORIGIN);
    await waitForGridStable(page);

    // ---- (a) GONE FROM THE RENDERED GRID — the painted strings...
    expect(
      await renderedBlock(page),
      "the Delete key cleared the formula and left its spilled values painted on " +
        "the grid: numbers no formula in the document produces",
    ).toEqual(["", "", "", ""]);

    // ---- ...and the pixels, which is the claim the strings only stand in for.
    await grid.navigateTo(ORIGIN);
    await waitForGridStable(page);
    const afterDelete = await captureBlock(page);
    expect(
      diffCount(empty, afterDelete),
      `the canvas still differs from an empty block by ${diffCount(empty, afterDelete)} ` +
        `pixels after Delete (the array's own ink was ${inkOfTheArray}) — the values, ` +
        `or the spill border around them, are still being painted`,
    ).toBeLessThan(20);

    // ---- (b) THE MAP AGREES. A rendered blank over a map that still claims
    // the cells is precisely §2y's session-scoped dead end.
    expect(
      await spillRanges(page),
      "the cells look empty but the spill map still claims them for a formula " +
        "that no longer exists — every later edit and delete in this block will " +
        "be refused, for the rest of the session",
    ).toEqual([]);

    // ---- (c) THE NEIGHBOURS ARE EDITABLE. §2y's sharpest symptom: typing into
    // a former spill cell was refused, naming a source cell that was empty.
    expect(
      await renderedCell(page, SPILLED[0]),
      "precondition: the neighbour must be empty before we prove a value reaches it",
    ).toBe("");
    await grid.navigateTo(SPILLED[0]);
    await grid.typeIntoCell("TYPED-AFTER-DELETE");
    await page.waitForTimeout(400);
    expect(
      await renderedCell(page, SPILLED[0]),
      `typing into ${SPILLED[0]} after deleting the origin was refused — the guard ` +
        `still reads a spill map entry whose formula is gone, and tells the user to ` +
        `"edit or delete the formula in the source cell", which is empty`,
    ).toBe("TYPED-AFTER-DELETE");

    // ---- (d) UNDO RESTORES THE FORMULA AND ITS SPILL.
    // Two undos: the typed edit above, then the Delete. The order is the user's.
    await grid.navigateTo(SPILLED[0]);
    await grid.undo();
    await page.waitForTimeout(400);
    expect(
      await renderedCell(page, SPILLED[0]),
      "undo of the typed edit did not clear the neighbour, so the second undo " +
        "below would be re-spilling onto an occupied cell and this test would " +
        "be measuring the wrong thing",
    ).toBe("");

    await grid.undo();
    await page.waitForTimeout(600);
    await waitForGridStable(page);

    expect(
      await storedFormula(page, ORIGIN),
      "undo did not put the array FORMULA back in the origin",
    ).toBe(FORMULA);
    expect(
      await renderedBlock(page),
      "undo restored the formula but not its SPILL — the origin holds a live " +
        "array formula and the cells it owns are blank (or #VALUE!, which is what " +
        "restoring the spilled literals alongside the origin produces)",
    ).toEqual([...VALUES]);
    expect(
      await spillRanges(page),
      "undo restored the array on screen but not in the spill map, so the cells " +
        "are unprotected: the next edit overwrites part of a live array",
    ).toEqual([{ originRow: oRow, originCol: oCol, endRow: oRow + 3, endCol: oCol }]);

    // ---- (e) REDO TAKES IT DOWN AGAIN. The register names redo as covered by
    // the same choke point and by no remembered call site; this is that claim.
    await grid.navigateTo(ORIGIN);
    await grid.redo();
    await page.waitForTimeout(600);
    expect(
      await renderedBlock(page),
      "redo of the Delete left the spilled values painted — the tear-down is on " +
        "the choke point every bulk rewrite ends at, and redo is one of them",
    ).toEqual(["", "", "", ""]);
    expect(await spillRanges(page), "redo left the spill map behind").toEqual([]);
  });

  // =========================================================================
  // 2. THE OTHER IMPOSSIBLE REMEDY — select the whole block and press Delete
  // =========================================================================
  test("selecting the whole spilled block and pressing Delete clears it", async ({ grid }) => {
    test.setTimeout(240_000);
    const page = grid.page;

    await newFile(page);
    await typeArrayFormula(grid);
    expect(
      await renderedBlock(page),
      "precondition: the array must be alive before the block delete",
    ).toEqual([...VALUES]);

    // The gesture a user tries when told to "modify the formula in EB5": select
    // the whole thing and press Delete. §2y measured this as REFUSED — by the
    // same guard, with a message pointing back at the cell being deleted.
    await grid.selectRange(WHOLE[0], WHOLE[WHOLE.length - 1]);
    await page.keyboard.press("Delete");
    await page.waitForTimeout(600);
    await waitForGridStable(page);

    expect(
      await renderedBlock(page),
      "selecting the whole spilled array and pressing Delete did not clear it — " +
        "`check_spill_protection` refused a host whose ORIGIN is inside the very " +
        "rectangle being cleared, which is the one gesture the error message tells " +
        "the user to perform",
    ).toEqual(["", "", "", ""]);
    expect(
      await spillRanges(page),
      "the block delete cleared the cells and left the map claiming them",
    ).toEqual([]);
  });

  // =========================================================================
  // 3. THE BYTES — a deleted array must not save as orphan literals
  // =========================================================================
  test("Delete then Save: the archive holds no orphan literals from the dead array", async ({
    grid,
  }) => {
    test.setTimeout(240_000);
    const page = grid.page;

    await newFile(page);
    await typeArrayFormula(grid);
    expect(
      await renderedBlock(page),
      "precondition: the array must be alive before the first save",
    ).toEqual([...VALUES]);

    // ---- VACUITY GUARD. Prove the oracle can SEE the array when it is really
    // there. Without this, "the archive does not contain 424246" would pass on
    // a parser that opened nothing.
    await invoke(page, "save_file", { path: FILE_ALIVE });
    await expect
      .poll(() => fs.existsSync(FILE_ALIVE), { timeout: 20_000, intervals: [200] })
      .toBe(true);
    const alive = calaText(FILE_ALIVE);
    expect(alive, "the live array's origin formula must be in the archive").toContain(
      "SEQUENCE",
    );
    for (const v of VALUES.slice(1)) {
      expect(
        alive,
        `the live array's spilled value ${v} must be visible to this oracle`,
      ).toContain(v);
    }

    // ---- The gesture, then the save a user does next.
    await pressDeleteOn(grid, ORIGIN);
    await invoke(page, "save_file", { path: FILE_DELETED });
    await expect
      .poll(() => fs.existsSync(FILE_DELETED), { timeout: 20_000, intervals: [200] })
      .toBe(true);

    const deleted = calaText(FILE_DELETED);
    for (const v of VALUES.slice(1)) {
      expect(
        deleted,
        `the saved file holds ${v} as an ORDINARY LITERAL: the formula that made ` +
          `it was deleted, nothing in the document produces it, and the user has no ` +
          `way to know it stopped being derived`,
      ).not.toContain(v);
    }
    expect(
      deleted,
      "the deleted origin's formula is still in the archive",
    ).not.toContain("SEQUENCE");
    // ...and the file really is a workbook, so the absences are absences and
    // not a truncated write.
    expect(deleted, "the saved file must be a real workbook").toContain("Sheet1");
  });
});
