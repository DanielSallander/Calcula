/**
 * OPEN-ITEMS §1 OWNER CALLS — proved on the RUNNING app.
 *
 * Four of the six items in `docs/design/open-items.md` §1 were decided by the
 * owner on 2026-08-16 under the same standing rule the D1-D7 batch used:
 * "parity with Excel should take priority always when there are such
 * questions". Each was unit-tested where it lives — in the engine, in the
 * persistence crate, in a React hook test. None of those can prove the USER
 * sees the new answer, and that is the whole of what this file is for.
 *
 *   1.1  A negative currency renders with a LEADING MINUS, not parentheses.
 *   1.3  The locale comes from Windows' REGIONAL FORMAT, not its display
 *        language, and "System default" is a live re-read.
 *   1.4  Ctrl+Z SELECTS what it restored — on the same sheet, not only across.
 *   1.5  A blank cell is 0 in arithmetic, "" in concatenation, and IGNORED by
 *        the counting and statistical functions.
 *
 * WHY THIS IS A JOURNEY, not a functional spec. It calls `new_file`, applies
 * document-wide number formats and reads the application locale. The functional
 * specs share one accumulating workbook whose screenshot goldens encode the
 * residue of everything that ran before them.
 *
 * THE TEETH RULE, applied throughout. Every fixture is chosen so the RIGHT
 * answer and the OLD WRONG answer differ, and the old answer is named in the
 * assertion message. `AVERAGE` over {1, blank, 3} is 2 and used to be 1.333;
 * a negative currency is `-$1,234.56` and used to be `($1,234.56)`; the cursor
 * after Ctrl+Z is on the restored range and used to be wherever it was left.
 * A fixture where the two answers coincide proves nothing.
 *
 * LOCALE. This suite runs against whatever the machine reports and is written
 * locale-tolerantly on purpose — the formula argument separator is read from
 * the backend rather than assumed, and every numeric assertion accepts either
 * decimal separator. A spec that hard-codes `1 234,56` is a second hard-coded
 * locale table, which is the defect this file is partly about.
 *
 * GRID REAL ESTATE. Every test THAT TOUCHES CELLS starts from `new_file` (1.3
 * reads only the locale and deliberately does not), so no other spec's
 * coordinates can reach these. Work happens in columns CP-CX.
 * `pivot-undo-fidelity.spec.ts` also claims CQ/CR/CU and calls `new_file` once
 * for its two tests — the bands overlap, and the only thing keeping them apart
 * is that this file re-wipes before each cell-touching test. The `afterAll`
 * below wipes again so the next spec inherits an empty grid rather than this
 * file's fixtures.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { parseCellRef } from "../helpers/grid";

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
      const calcImport = (window as unknown as { __calcImport?: (u: string) => Promise<unknown> })
        .__calcImport;
      if (!calcImport) {
        throw new Error(
          "window.__calcImport is missing, so this spec cannot reach the product's own " +
            "modules. It is installed by app/src/main.tsx under import.meta.env.DEV — " +
            "E2E must run against the dev server.",
        );
      }
      const m = (await calcImport(new URL(modulePath, document.baseURI).href)) as Record<
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

/** Apply a number format through the product's own `applyFormatting` wrapper. */
async function applyFormatThroughProduct(
  page: Page,
  rows: number[],
  cols: number[],
  formatting: Record<string, unknown>,
): Promise<void> {
  await callModule(page, "/src/core/lib/tauri-api.ts", "applyFormatting", [
    rows,
    cols,
    formatting,
  ]);
  await page.waitForTimeout(120);
}

/** What the GRID paints for a cell — the display string, not the stored value. */
async function renderedCell(page: Page, ref: string): Promise<string> {
  const { row, col } = parseCellRef(ref);
  const cells = await invoke<Array<{ row: number; col: number; display: string }>>(
    page,
    "get_viewport_cells",
    { startRow: row, endRow: row, startCol: col, endCol: col },
  );
  const hit = cells.find((c) => c.row === row && c.col === col);
  return hit?.display ?? "";
}

/** The argument separator this build's locale uses — `,` on en-US, `;` on sv-SE. */
async function argSeparator(page: Page): Promise<string> {
  const locale = await invoke<{ listSeparator?: string }>(page, "get_locale_settings", {});
  return locale.listSeparator || ",";
}

/** A number read out of a display string, tolerant of either decimal separator. */
function numberFrom(display: string): number {
  // GROUPING FIRST, THEN THE DECIMAL MARK. A single `.replace(",", ".")` is a
  // first-occurrence STRING replace, so an en-US `"1,234.56"` became
  // `"1.234.56"` -> NaN, and the helper threw its own "not a number in any
  // locale" message about a perfectly ordinary number. Nearly every fixture
  // here is under ten, so it was a trap for whoever added a larger one.
  const stripped = display.replace(/[\s\u00a0]/g, "");
  const lastComma = stripped.lastIndexOf(",");
  const lastDot = stripped.lastIndexOf(".");
  const decimalMark = lastComma > lastDot ? "," : ".";
  const grouping = decimalMark === "," ? "." : ",";
  const cleaned = stripped.split(grouping).join("").replace(decimalMark, ".");
  const n = Number(cleaned);
  if (Number.isNaN(n)) throw new Error(`"${display}" is not a number in any locale`);
  return n;
}

test.describe("open-items §1 owner calls, proved live", () => {
  // =========================================================================
  // 1.1 — currency negatives
  // =========================================================================

  test("1.1 a negative currency paints a leading minus, and the parenthesised entry is still reachable", async ({
    appPage,
  }) => {
    await newFile(appPage);

    // CP1 = 1234.56, CP2 = -1234.56. The pair is the point: the positive must
    // be untouched by a change that only concerns negatives.
    await invoke(appPage, "update_cell", { row: 0, col: 93, value: "1234.56" });
    await invoke(appPage, "update_cell", { row: 1, col: 93, value: "-1234.56" });
    await applyFormatThroughProduct(appPage, [0, 1], [93], { numberFormat: "currency_usd" });

    const positive = await renderedCell(appPage, "CP1");
    const negative = await renderedCell(appPage, "CP2");

    expect(positive, "the currency symbol must still be painted").toContain("$");
    expect(
      numberFrom(positive.replace("$", "")),
      "the positive rendering must be untouched by a negatives-only change — " +
        `asserting the VALUE, because "contains a $" passes for $0.00 too. Got: "${positive}"`,
    ).toBeCloseTo(1234.56, 2);
    expect(
      negative.startsWith("-"),
      `Excel's Currency preset writes the SINGLE-SECTION code $#,##0.00, and a ` +
        `single-section code renders a negative with a LEADING MINUS. This used to ` +
        `paint "($1,234.56)" — parentheses are Excel's THIRD and FOURTH ` +
        `"Negative numbers:" entries, not its default. Got: "${negative}"`,
    ).toBe(true);
    expect(
      negative.includes("(") || negative.includes(")"),
      `...and no parentheses at all under the default entry. Got: "${negative}"`,
    ).toBe(false);

    // THE OTHER HALF, and it is what makes this a parity fix rather than a
    // removal: parentheses are still reachable, as the entry Excel means by
    // them. The dialog composes the symbol preset with a negative suffix.
    await applyFormatThroughProduct(appPage, [1], [93], {
      numberFormat: "currency_usd_neg_paren",
    });
    const parenthesised = await renderedCell(appPage, "CP2");
    expect(
      parenthesised,
      "Excel's third negative entry is ($1,234.56) — still available, now on purpose",
    ).toContain("(");
    expect(parenthesised).toContain(")");

    // ...and the round trip: the cell must be able to REPORT the entry it
    // carries, or the Format Cells dialog reopens on the wrong row and resets
    // the choice on an untouched OK (the BUG-0065 shape).
    const cell = await invoke<{ styleIndex: number }>(appPage, "get_cell", { row: 1, col: 93 });
    const style = await invoke<{ numberFormat: string }>(appPage, "get_style", {
      index: cell.styleIndex,
    });
    expect(
      style.numberFormat,
      "get_style must name the negative entry, or the dialog cannot highlight it",
    ).toContain("parenthesised negatives");
  });

  // =========================================================================
  // 1.3 — the locale comes from the OS regional format
  // =========================================================================

  test("1.3 the locale is the OS regional format, and System default re-reads it live", async ({
    appPage,
  }) => {
    // The backend's answer at boot. Every field must be populated: the OS read
    // degrades PER FIELD onto the table, so an empty one means a whole branch
    // silently failed rather than one `GetLocaleInfoEx` call returning 0.
    const boot = await invoke<{
      localeId: string;
      displayName: string;
      decimalSeparator: string;
      thousandsSeparator: string;
      listSeparator: string;
      dateFormat: string;
      longDateFormat: string;
      timeFormat: string;
      currencySymbol: string;
    }>(appPage, "get_locale_settings", {});

    // THIS TEST CANNOT DISTINGUISH THE FIX FROM THE BUG ON AN en-US MACHINE:
    // the defect was that `set_locale("system")` silently returned en-US, so on
    // a machine whose regional format IS en-US every assertion below passes
    // either way. Said out loud rather than left as a silent hole.
    expect(
      boot.localeId,
      "this machine's regional format is en-US, which is exactly what the OLD " +
        "'system' path returned — run this spec on a non-en-US machine for it to " +
        "have teeth",
    ).not.toBe("en-US");

    for (const [field, value] of Object.entries(boot)) {
      expect(String(value).length, `locale.${field} is empty`).toBeGreaterThan(0);
    }
    expect(
      boot.localeId,
      "a BCP-47 tag, e.g. sv-SE — this is LOCALE_SNAME, the regional format",
      // Windows really returns three-subtag names (`sr-Latn-RS`, `zh-Hans-CN`)
      // and three-letter languages (`fil-PH`), so the shape has to admit them.
    ).toMatch(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);
    expect(
      boot.decimalSeparator === boot.thousandsSeparator,
      "a locale whose decimal and grouping separators are the same character " +
        "cannot format a number; this is the shape a half-failed read takes",
    ).toBe(false);

    // "System default" is a LIVE RE-READ. It used to re-report whatever was
    // captured at launch, so a user who changed Windows Region and came back
    // saw a stale value with no way to refresh short of restarting the app.
    // Sending "system" to `set_locale` used to return en-US in silence.
    // EVERY WRITE FROM HERE IS UNDONE IN THE `finally`. This is the only spec
    // in the journey project that changes an APPLICATION-WIDE setting, the
    // project runs one app in one worker, and ~15 specs follow alphabetically.
    // Leaving the app on de-DE would give them '.' as a thousands separator and
    // ',' as the formula argument separator, which is a parse error in every
    // `SUM(A1;B1)` the suite contains.
    try {
    const reread = await invoke<{ localeId: string; listSeparator: string }>(
      appPage,
      "set_locale",
      { localeId: "system" },
    );
    expect(
      reread.localeId,
      `"system" must ask Windows, not fall through to the invariant locale. ` +
        `Boot said ${boot.localeId}; the re-read said ${reread.localeId}`,
    ).toBe(boot.localeId);
    expect(reread.listSeparator).toBe(boot.listSeparator);

    // An EXPLICIT override is still answered by the table, byte for byte — a
    // user who picks de-DE is asking for Germany, not for Germany-as-
    // configured-on-this-machine.
    const german = await invoke<{ localeId: string; decimalSeparator: string }>(
      appPage,
      "set_locale",
      { localeId: "de-DE" },
    );
    expect(german.localeId).toBe("de-DE");
    expect(german.decimalSeparator).toBe(",");

    } finally {
      // Restored to the locale the app was ACTUALLY IN, not to "system":
      // `app/src/api/locale.ts` pushes any saved localStorage override into the
      // backend on first read, so "system" is not necessarily where we started.
      await invoke(appPage, "set_locale", { localeId: boot.localeId });
    }
    const restored = await invoke<{ localeId: string }>(appPage, "get_locale_settings", {});
    expect(restored.localeId, "the suite must be left on the locale it found").toBe(
      boot.localeId,
    );
  });

  // =========================================================================
  // 1.4 — Ctrl+Z selects what it restored
  // =========================================================================

  test("1.4 a SAME-SHEET Ctrl+Z selects the range it restored", async ({ appPage, grid }) => {
    await newFile(appPage);

    // A four-cell block at CR10:CS11, written as ONE undo transaction so the
    // restore names a real RANGE rather than a single cell.
    await invoke(appPage, "begin_undo_transaction", { description: "block" });
    for (const [row, col, value] of [
      [9, 95, "1"],
      [9, 96, "2"],
      [10, 95, "3"],
      [10, 96, "4"],
    ] as Array<[number, number, string]>) {
      await invoke(appPage, "update_cell", { row, col, value });
    }
    await invoke(appPage, "commit_undo_transaction", {});
    await appPage.waitForTimeout(200);

    // Move the cursor FAR away from what is about to be undone. This is the
    // precondition that makes the assertion meaningful: if the cursor were
    // already on the block, "it selected the block" would be indistinguishable
    // from "it did nothing".
    await grid.navigateTo("CU30");
    expect(await grid.getNameBoxValue(), "precondition: the cursor is elsewhere").toBe("CU30");

    await grid.undo();

    // Excel selects the range an undo restored — re-selection is HOW THE USER
    // SEES what came back. Before this, the whole dispatch was gated on the
    // undo having crossed a sheet boundary, so on the common path it was dead
    // code and the cursor stayed at CU30.
    //
    // THE RANGE, not the corner: the Name Box renders a multi-cell selection as
    // `topLeft:bottomRight` (`formatSelectionAddress`, app/src/shell/FormulaBar/
    // NameBox.tsx), so asserting "CR10" alone would have passed for a
    // single-cell selection and quietly under-tested the whole point.
    const nameBox = await grid.getNameBoxValue();
    expect(
      nameBox,
      `a same-sheet Ctrl+Z must select the RANGE it restored (Excel parity, ` +
        `open-items 1.4). The cursor stayed at CU30 before this change, and ` +
        `selecting only the corner would be the anchor-not-range half-fix. ` +
        `Name box: "${nameBox}"`,
    ).toBe("CR10:CS11");

    // ...and the values really did come back out, so this is a genuine undo
    // and not merely a cursor move.
    expect(await renderedCell(appPage, "CR10")).toBe("");
    expect(await renderedCell(appPage, "CS11")).toBe("");
  });

  test("1.4b a restore that names no cells leaves the cursor alone", async ({ appPage, grid }) => {
    await newFile(appPage);

    // A COLUMN WIDTH describes a whole column and records no cell coordinates,
    // so there is nothing to select. That silence is deliberate and it is what
    // makes selecting-on-every-undo safe: a restore with no coordinates leaves
    // the user where they are rather than guessing.
    await invoke(appPage, "set_column_width", { col: 97, width: 160 });
    await appPage.waitForTimeout(150);
    // THE POSITIVE CONTROL, and without it this test cannot fail: "the cursor
    // did not move" is also what an undo that never ran produces — an empty
    // stack, a swallowed exception, a Ctrl+Z that missed the grid. Asserting
    // that something WAS undone is what makes the other assertion mean
    // anything.
    const widened = await invoke<number | null>(appPage, "get_column_width", { col: 97 });
    expect(widened, "precondition: the column really was widened").toBe(160);

    await grid.navigateTo("CU30");
    await grid.undo();

    expect(
      await invoke<number | null>(appPage, "get_column_width", { col: 97 }),
      "the undo must actually have restored the width",
    ).not.toBe(160);
    expect(
      await grid.getNameBoxValue(),
      "a geometry-only restore names no cells, so the cursor must not move",
    ).toBe("CU30");
  });

  // =========================================================================
  // 1.5 — the three-way blank rule
  // =========================================================================

  test("1.5 a blank cell is 0 in arithmetic, \"\" in text, and ignored by the counters", async ({
    appPage,
  }) => {
    await newFile(appPage);
    const sep = await argSeparator(appPage);

    // CW1 = 1, CW2 DELIBERATELY EMPTY, CW3 = 3. Two values in three cells, so
    // the right answer and the blank-as-zero answer differ for every function
    // below.
    await invoke(appPage, "update_cell", { row: 0, col: 100, value: "1" });
    await invoke(appPage, "update_cell", { row: 2, col: 100, value: "3" });

    const formulas: Array<[string, string, string, string]> = [
      // ref,   formula,                     expected, what the old build said
      ["CX1", "=CW2+1", "1", "1 (unchanged — arithmetic was already right)"],
      ["CX2", `=CW2&"x"`, "x", '"0x"'],
      ["CX3", "=LEN(CW2)", "0", "1"],
      ["CX4", "=COUNT(CW1:CW3)", "2", "3"],
      ["CX5", "=COUNTA(CW1:CW3)", "2", "3"],
      ["CX6", "=AVERAGE(CW1:CW3)", "2", "1.333…"],
      ["CX7", "=MIN(CW1:CW3)", "1", "0"],
      ["CX8", "=PRODUCT(CW1:CW3)", "3", "0"],
      ["CX9", "=COUNTBLANK(CW1:CW3)", "1", "0 (it never worked at all)"],
      ["CX10", "=SUM(CW1:CW3)", "4", "4 (unchanged — skipping a zero and adding it agree)"],
      // MULTI-ARGUMENT ON PURPOSE. Every formula above is single-argument, so
      // the `sep` substitution below was the identity function and this file's
      // claim to be locale-tolerant was untested — a regression in
      // `delocalize_formula` would have sailed through. These two carry a real
      // argument separator, and they are also the two cases the second round of
      // review found broken: COUNTIF's blank criteria and SUBTOTAL's agreement
      // with its plain counterpart.
      ["CX11", '=COUNTIF(CW1:CW3,"<>")', "2", "3"],
      ["CX12", "=SUBTOTAL(1,CW1:CW3)", "2", "1.333…"],
    ];

    for (const [ref, formula, , ] of formulas) {
      const { row, col } = parseCellRef(ref);
      await invoke(appPage, "update_cell", { row, col, value: formula.replace(/,/g, sep) });
    }
    await appPage.waitForTimeout(300);

    for (const [ref, formula, expected, wasBefore] of formulas) {
      const display = await renderedCell(appPage, ref);
      if (expected === "x") {
        expect(display, `${formula} — before this change: ${wasBefore}`).toBe("x");
      } else {
        expect(
          numberFrom(display),
          `${formula} must be ${expected}; before open-items 1.5 it was ${wasBefore}`,
        ).toBeCloseTo(Number(expected), 6);
      }
    }

    // ...AND THE TWO SPELLINGS OF A RANGE AGREE. This was the sharpest
    // symptom: a rectangle injected zeros for absent cells while a whole-column
    // reference skipped them, so the same workbook answered differently
    // depending on how the user wrote the range.
    // Column 101 is CX (A..Z = 0..25, AA..AZ = 26..51, BA..BZ = 52..77,
    // CA = 78, so CX = 78 + 23 = 101) and row 20 renders as row 21. Written by
    // index and read by reference, so both spellings of the same cell are in
    // the source and a mismatch is visible rather than silent.
    await invoke(appPage, "update_cell", {
      row: 20,
      col: 101,
      value: "=AVERAGE(CW1:CW3)".replace(/,/g, sep),
    });
    await invoke(appPage, "update_cell", {
      row: 21,
      col: 101,
      value: "=AVERAGE(CW:CW)".replace(/,/g, sep),
    });
    await appPage.waitForTimeout(250);
    const rectangle = numberFrom(await renderedCell(appPage, "CX21"));
    const wholeColumn = numberFrom(await renderedCell(appPage, "CX22"));
    expect(
      rectangle,
      "the two range spellings must agree — A1:A3 used to give 1.333 and A:A gave 2",
    ).toBeCloseTo(wholeColumn, 6);
    expect(rectangle, "...and both must be Excel's answer, not merely equal").toBeCloseTo(2, 6);

    // A BLANK STILL DISPLAYS AS 0. `=A1` over an empty cell shows 0 in Excel,
    // so the blank collapses at the storage boundary even though it stays a
    // blank inside the evaluator. Losing this half would make formula cells
    // that LOOK empty.
    await invoke(appPage, "update_cell", { row: 25, col: 101, value: "=CW2" });
    await appPage.waitForTimeout(150);
    expect(
      numberFrom(await renderedCell(appPage, "CX26")),
      "a bare reference to a blank cell displays 0, exactly as in Excel",
    ).toBe(0);

    // LEAVE THE GRID EMPTY. This file is not last in the journey project, and
    // the specs that follow it without calling `new_file` themselves are safe
    // only by a column/row convention nothing enforces. Wiping here costs one
    // call and removes the dependency. (It is the last statement of the last
    // test rather than an `afterAll` because `appPage` is a test-scoped
    // fixture and an `afterAll` cannot reach it.)
    await newFile(appPage);
  });
});
