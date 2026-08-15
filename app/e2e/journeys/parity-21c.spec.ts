/**
 * LIVE PROOFS for the three Excel-parity decisions of 2026-08-15 (§21c items
 * 1-3, decided in open-decisions-2026-08.md §24 / §25 / §26 and integrated in
 * §27).
 *
 * WHY THIS FILE EXISTS. All three shipped with unit tests, Rust tests and a
 * one-off live probe recorded in the register — and NOTHING in the E2E tree
 * touched any of them. Measured 2026-08-15 while closing the programme: zero
 * references to `verticalAlign`, to the overflow marker, or to the Number
 * dropdown anywhere under `app/e2e`. A parity decision whose only live evidence
 * is a paragraph in a design document is evidence that expires; the next pass
 * that changes the renderer finds out from a user.
 *
 * WHAT IS ASSERTED, and why each half needs the running app
 *
 *   1. THE HOME > NUMBER DROPDOWN REPORTS ITS OWN RESULT (§25, BUG-0065 /
 *      BUG-0069 / BUG-0073). Every entry the backend resolves for the CURRENT
 *      locale must read back through `get_style` under the same display name,
 *      or the dropdown cannot highlight what the user just chose. This is
 *      driven against the live backend because the whole defect class is a
 *      hand-written TypeScript mirror of a Rust serialiser drifting from it.
 *
 *      LOCALE-TOLERANT ON PURPOSE. The samples are NOT compared against
 *      Swedish strings: the assertion is that no entry renders a US decimal
 *      point when the backend's own locale says otherwise, and that the
 *      round-trip holds. A spec that hard-codes `45306,56` is a second
 *      hard-coded locale table, which is the defect, not the test.
 *
 *   2. THE DOCUMENT DEFAULT VERTICAL ALIGNMENT IS BOTTOM (§24). An untouched
 *      cell must carry style index 0 AND read `bottom`; a cell explicitly set
 *      to Middle must still read `middle`. The pair is the point: "everything
 *      reads bottom" is also what a broken reader returns.
 *
 *   3. THE OVERFLOW LADDER IS EXCEL'S, WHICH IS TWO RULES (§26, BUG-0066).
 *      A number under an EXPLICIT format that does not fit paints `####`; the
 *      same number under General negotiates down its own ladder instead; text
 *      never shows the marker at all, it clips. Asserted on PIXELS, because
 *      the marker is a rendering outcome that deliberately never enters the
 *      value — `display` must never be a run of '#', or the marker would
 *      travel into copy/paste, CSV export and the formula bar.
 *
 * IT IS A JOURNEY, NOT A FUNCTIONAL SPEC: it resizes column A, writes formats
 * into the shared workbook and reads the canvas, all of which shift the goldens
 * of the specs that run after it alphabetically in `e2e/tests`.
 *
 * NO GOLDEN. Every pixel claim here is a RELATIVE measurement between two cells
 * captured in the same frame on the same run, so it cannot rot against a
 * recapture, a dpr change or a colour profile.
 *
 * Grid area: rows 40-46, column A-B — below everything the walker and the
 * functional specs use.
 */
import { test, expect } from "../fixtures";
import { readGridGeometry } from "../helpers/grid";
import type { Page } from "@playwright/test";

/** Invoke a backend command through the e2e-enabled window.__TAURI__ bridge. */
async function invoke<T = unknown>(page: Page, cmd: string, args: unknown = {}): Promise<T> {
  return page.evaluate(
    async ({ c, a }) => {
      const t = (window as unknown as {
        __TAURI__: { core: { invoke: (cmd: string, args: unknown) => Promise<unknown> } };
      }).__TAURI__;
      return t.core.invoke(c, a);
    },
    { c: cmd, a: args },
  ) as Promise<T>;
}

/** First row this file writes to. Nothing else in the tree uses rows 40+. */
const ROW_EXPLICIT = 40;
const ROW_GENERAL = 41;
const ROW_TEXT_BLOCKED = 42;
const ROW_VALIGN_A = 44;

/** The value both overflow cells carry: 12 significant digits, no fit at 60px. */
const WIDE_NUMBER = "123456789.12";

/**
 * Apply formatting through THE PRODUCT'S OWN WRAPPER — `applyFormatting` in
 * `src/core/lib/tauri-api.ts`, reached over main.tsx's dev-only
 * `__calcImport` bridge, exactly as `readGridGeometry` reaches the renderer's
 * header rule.
 *
 * Deliberately NOT a raw `apply_formatting` invoke with hand-written events.
 * The `####` decision reads the cell's `numberFormat` out of the FRONTEND STYLE
 * CACHE; a cache miss falls back to index 0 — the document default, which is
 * General — and General NEGOTIATES, so a stale cache turns item 3 into its own
 * opposite while `get_style` reports the right thing (BUG-0076). Priming the
 * cache by hand here would make item 3 pass over a regression of BUG-0076
 * instead of catching it. Going through the wrapper means this file guards
 * both: the wrapper is where `announceStyleEntries` lives, and it is the one
 * door to the command.
 */
async function applyFormatThroughProduct(
  page: Page,
  rows: number[],
  cols: number[],
  formatting: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    async ({ r, c, f }) => {
      const calcImport = (window as unknown as {
        __calcImport?: (u: string) => Promise<unknown>;
      }).__calcImport;
      if (!calcImport) {
        throw new Error(
          "window.__calcImport is missing, so this spec cannot reach the product's " +
            "own applyFormatting wrapper. It is installed by app/src/main.tsx under " +
            "import.meta.env.DEV — E2E must run against the dev server. Refusing to " +
            "hand-roll the wrapper: hand-rolling it is what this test exists to catch.",
        );
      }
      const mod = (await calcImport(
        new URL("/src/core/lib/tauri-api.ts", document.baseURI).href,
      )) as {
        applyFormatting: (
          rows: number[],
          cols: number[],
          formatting: Record<string, unknown>,
        ) => Promise<unknown>;
      };
      await mod.applyFormatting(r, c, f);
      window.dispatchEvent(new Event("grid:refresh"));
    },
    { r: rows, c: cols, f: formatting },
  );
  await page.waitForTimeout(400);
}

async function repaint(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("dimensions:refresh"));
    window.dispatchEvent(new Event("grid:refresh"));
  });
  await page.waitForTimeout(600);
}

/**
 * Scroll a cell into view and park the selection somewhere harmless.
 *
 * REQUIRED BEFORE ANY `cellInk`. Rows 40+ sit BELOW the default viewport, and a
 * `page.screenshot({clip})` outside the image does not return blank pixels — it
 * throws "Clipped area is either empty or outside the resulting image", which is
 * how the first version of this spec failed (measured in the journey project;
 * it passed standalone only because the probe used rows 10-17).
 */
async function bringIntoView(page: Page, row: number, col: number): Promise<void> {
  await page.evaluate(
    ({ r, c }) => {
      window.dispatchEvent(
        new CustomEvent("app:navigate-to-cell", { detail: { row: r, col: c, select: true } }),
      );
    },
    { r: row, c: col },
  );
  await page.waitForTimeout(700);
}

/** Dark-pixel count of one cell's interior, in the frame as painted. */
async function cellInk(page: Page, row: number, col: number): Promise<number> {
  const geo = await readGridGeometry(page);
  const canvasBox = await page.locator("canvas").first().boundingBox();
  if (!canvasBox) throw new Error("no canvas");
  const colWidth = (c: number): number => geo.columnWidths[c] ?? geo.defaultCellWidth;
  const rowHeight = (r: number): number => geo.rowHeights[r] ?? geo.defaultCellHeight;
  let xo = 0;
  for (let c = 0; c < col; c++) xo += colWidth(c);
  let yo = 0;
  for (let r = 0; r < row; r++) yo += rowHeight(r);
  const x = canvasBox.x + (geo.rowHeaderWidth + xo - geo.scrollX) * geo.zoom;
  const y = canvasBox.y + (geo.colHeaderHeight + yo - geo.scrollY) * geo.zoom;
  const w = Math.round(colWidth(col) * geo.zoom) - 2;
  const h = Math.round(rowHeight(row) * geo.zoom) - 2;

  // FAIL WITH THE NUMBERS rather than letting page.screenshot throw its own
  // opaque "Clipped area is ... outside the resulting image". An out-of-frame
  // cell means the caller forgot `bringIntoView`, or a side panel shrank the
  // canvas under it — both are worth naming.
  const onScreen =
    y >= canvasBox.y + geo.colHeaderHeight * geo.zoom - 1 &&
    y + h <= canvasBox.y + canvasBox.height + 1 &&
    x >= canvasBox.x - 1 &&
    x + w <= canvasBox.x + canvasBox.width + 1;
  if (!onScreen) {
    throw new Error(
      `[parity-21c] cell r${row}c${col} is not in frame, so its ink cannot be ` +
        `measured. cell rect = x:${x.toFixed(1)} y:${y.toFixed(1)} w:${w} h:${h}; ` +
        `canvas = x:${canvasBox.x.toFixed(1)} y:${canvasBox.y.toFixed(1)} ` +
        `w:${canvasBox.width} h:${canvasBox.height}; scroll = ` +
        `x:${geo.scrollX} y:${geo.scrollY} zoom:${geo.zoom}. ` +
        `Call bringIntoView() first; if the canvas is unexpectedly NARROW, a ` +
        `side panel is open and an earlier spec left it that way.`,
    );
  }

  const buf = await page.screenshot({
    clip: { x: Math.round(x) + 1, y: Math.round(y) + 1, width: w, height: h },
  });
  // PNG decode without a dependency: count non-white through a raw re-encode is
  // not available here, so use the browser to decode the bytes it just produced.
  return page.evaluate(async (bytes: number[]) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
    const bitmap = await createImageBitmap(blob);
    const off = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = off.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum < 128) dark++;
    }
    return dark;
  }, Array.from(buf));
}

test.describe("Excel-parity decisions of 2026-08-15, proved live (§21c items 1-3)", () => {
  test("item 1 — every Home > Number entry reports its own result, in this build's locale", async ({
    appPage,
  }) => {
    const formats = await invoke<
      Array<{ preset: string; displayName: string; sample: string }>
    >(appPage, "get_ribbon_number_formats", { sampleValue: 45306.5625 });

    // Excel's dropdown, in Excel's order. Special and Custom are Format Cells
    // categories, not dropdown entries; the twelfth row is "More Number
    // Formats...", which is UI and not a format.
    expect(
      formats.map((f) => f.preset),
      "the dropdown's population is Excel's eleven entries, in Excel's order",
    ).toEqual([
      "general",
      "number",
      "currency",
      "accounting",
      "date_short",
      "date_long",
      "time",
      "percentage",
      "fraction_1",
      "scientific",
      "text",
    ]);

    // THE ROUND TRIP. `get_style` speaks display names and the dropdown speaks
    // presets; inverting that mapping in TypeScript is how BUG-0065 happened
    // and BUG-0073 happened again through a route §25 opened.
    await invoke(appPage, "update_cell", { row: 46, col: 0, value: "45306.5625" });
    const mismatches: string[] = [];
    for (const f of formats) {
      await applyFormatThroughProduct(appPage, [46], [0], { numberFormat: f.preset });
      const cell = await invoke<{ styleIndex: number }>(appPage, "get_cell", {
        row: 46,
        col: 0,
      });
      const style = await invoke<{ numberFormat: string }>(appPage, "get_style", {
        index: cell.styleIndex,
      });
      if (style.numberFormat !== f.displayName) {
        mismatches.push(`${f.preset}: dropdown says "${f.displayName}", get_style says "${style.numberFormat}"`);
      }
    }
    expect(
      mismatches,
      "an entry the dropdown cannot read back is an entry it cannot highlight — " +
        "the user picks a format and the box goes on describing the old one",
    ).toEqual([]);

    // THE LOCALE HALF, asserted against the backend's own locale rather than
    // against a hard-coded Swedish string.
    const separator = await invoke<{ decimalSeparator?: string }>(
      appPage,
      "get_locale_settings",
      {},
    ).catch(() => null);
    if (separator?.decimalSeparator && separator.decimalSeparator !== ".") {
      const usSpelling = formats.filter((f) => /\d\.\d/.test(f.sample));
      expect(
        usSpelling.map((f) => `${f.preset}=${f.sample}`),
        `this build's decimal separator is "${separator.decimalSeparator}", so no ` +
          `dropdown sample may render a US decimal point`,
      ).toEqual([]);
    }
  });

  test("item 2 — an untouched cell is BOTTOM aligned and an explicit Middle is unmoved", async ({
    appPage,
  }) => {
    await invoke(appPage, "update_cell", { row: ROW_VALIGN_A, col: 0, value: "Default" });
    await invoke(appPage, "update_cell", { row: ROW_VALIGN_A, col: 1, value: "Explicit" });
    await applyFormatThroughProduct(appPage, [ROW_VALIGN_A], [1], {
      verticalAlign: "middle",
    });

    const a = await invoke<{ styleIndex: number }>(appPage, "get_cell", {
      row: ROW_VALIGN_A,
      col: 0,
    });
    const b = await invoke<{ styleIndex: number }>(appPage, "get_cell", {
      row: ROW_VALIGN_A,
      col: 1,
    });
    const aStyle = await invoke<{ verticalAlign: string }>(appPage, "get_style", {
      index: a.styleIndex,
    });
    const bStyle = await invoke<{ verticalAlign: string }>(appPage, "get_style", {
      index: b.styleIndex,
    });

    expect(a.styleIndex, "a cell nobody formatted carries the document default").toBe(0);
    expect(aStyle.verticalAlign, "the document default is Excel's Bottom").toBe("bottom");
    // The positive control: "everything reads bottom" is also what a reader
    // stuck on index 0 returns.
    expect(bStyle.verticalAlign, "an explicitly Middle cell did NOT move").toBe("middle");
  });

  test("item 3 — a narrow number marks, the same number under General negotiates, text clips", async ({
    appPage,
  }) => {
    test.setTimeout(90_000);
    // Column A's width is document state this test CHANGES, so it is restored in
    // a finally: a thrown assertion must not leave a 60 px column A behind for
    // the ~20 specs that run after this one.
    try {
    await invoke(appPage, "set_column_width", { col: 0, width: 60 });
    await invoke(appPage, "update_cell", { row: ROW_EXPLICIT, col: 0, value: WIDE_NUMBER });
    await invoke(appPage, "update_cell", { row: ROW_GENERAL, col: 0, value: WIDE_NUMBER });
    await invoke(appPage, "update_cell", {
      row: ROW_TEXT_BLOCKED,
      col: 0,
      value: "Clipped by neighbour",
    });
    await invoke(appPage, "update_cell", { row: ROW_TEXT_BLOCKED, col: 1, value: "X" });

    // EXPLICIT format on the first row only. Both rows hold the same value at
    // the same width, so the FORMAT is the only variable.
    await applyFormatThroughProduct(appPage, [ROW_EXPLICIT], [0], {
      numberFormat: "number_sep",
    });
    await repaint(appPage);
    // These rows sit below the default viewport. Scroll them in BEFORE any ink
    // is measured, and park the selection off the subjects so the active-cell
    // chrome cannot tint what is being counted.
    await bringIntoView(appPage, ROW_TEXT_BLOCKED + 4, 0);
    await bringIntoView(appPage, ROW_EXPLICIT, 6);

    const explicitStyle = await invoke<{ numberFormat: string }>(appPage, "get_style", {
      index: (
        await invoke<{ styleIndex: number }>(appPage, "get_cell", {
          row: ROW_EXPLICIT,
          col: 0,
        })
      ).styleIndex,
    });
    expect(
      explicitStyle.numberFormat,
      "the backend must actually hold an explicit format, or this test is about General twice",
    ).not.toBe("General");

    const explicitInk = await cellInk(appPage, ROW_EXPLICIT, 0);
    const generalInk = await cellInk(appPage, ROW_GENERAL, 0);
    const textInk = await cellInk(appPage, ROW_TEXT_BLOCKED, 0);

    // '########' is a solid comb across the whole width; General's scientific
    // rung ('1,23E+08') is eight narrow glyphs. The marker carries more ink.
    expect(
      explicitInk,
      `an explicit format never negotiates: it must paint the marker, not General's ` +
        `ladder (explicit=${explicitInk}px general=${generalInk}px). Equal ink means ` +
        `the renderer resolved the cell to the DEFAULT style — see BUG-0076.`,
    ).toBeGreaterThan(generalInk);

    // Text never marks. It is cut mid-glyph by the occupied neighbour.
    expect(
      textInk,
      `text clips, it does not mark (text=${textInk}px marker=${explicitInk}px)`,
    ).toBeLessThan(explicitInk);
    expect(textInk, "the text cell painted something at all").toBeGreaterThan(0);

    // THE MARKER IS A RENDERING OUTCOME AND NEVER ENTERS THE VALUE.
    const display = await invoke<{ display: string }>(appPage, "get_cell", {
      row: ROW_EXPLICIT,
      col: 0,
    });
    expect(
      /^#+$/.test(display.display),
      `display was ${JSON.stringify(display.display)} — a '#' run in the VALUE would ` +
        `travel into copy/paste, CSV export and the formula bar`,
    ).toBe(false);

    // And widening clears it: this number IS representable, so the refusal is
    // about width and nothing else.
    await invoke(appPage, "set_column_width", { col: 0, width: 260 });
    await repaint(appPage);
    const wideInk = await cellInk(appPage, ROW_EXPLICIT, 0);
    expect(
      wideInk,
      "widening the column must change what the explicit-format cell paints",
    ).not.toBe(explicitInk);
    } finally {
      // Restore the document state this test changed, whether or not it passed.
      await invoke(appPage, "set_column_width", { col: 0, width: 100 }).catch(() => {});
      await invoke(appPage, "clear_range_with_options", {
        params: {
          startRow: ROW_EXPLICIT,
          startCol: 0,
          endRow: ROW_VALIGN_A + 4,
          endCol: 2,
          // lower case: see e2e/__tests__/clearApplyToVocabulary.test.ts
          applyTo: "all",
        },
      }).catch(() => {});
      await repaint(appPage);
    }
  });
});
