/**
 * CORE'S OWN CELL EDIT OWNS THE KEYBOARD -- proved live.
 *
 * Two keyboard doors that fix rounds 4 and 5 closed in the dispatcher
 * (`src/api/keybindings.ts` `isCellEditLive`, fed by the one edit flag in
 * `src/core/lib/cellEditFlag.ts`) and that only jsdom had seen:
 *
 *   L1 A formula begun on Sheet1 and PARKED on Sheet2 while the user points at
 *      a reference. No text field has focus there -- the in-cell editor is not
 *      rendered on Sheet2 and the keyboard sits on the grid container -- so a
 *      tag test cannot see the edit. Before the fix, Delete, Ctrl+T and
 *      Ctrl+Shift+L ran over the VIEWED sheet's selection: Delete cleared
 *      Sheet2's cells under an edit the user was still typing on Sheet1.
 *   L2 Ctrl+V inside the in-cell editor. Before the fix the grid's paste
 *      binding ran and pasted the clipboard OVER THE SELECTED CELLS instead of
 *      into the text being typed.
 *
 * WHAT IS ASSERTED. The backend's cells, tables and AutoFilter (read with
 * `get_watch_cells`, `get_tables_all_sheets`, `get_auto_filter`) -- never "a key
 * was pressed". Each refusal is paired with a POSITIVE CONTROL that delivers the
 * SAME keystrokes the SAME way with no edit open and must change the document:
 * WebView2 swallows some accelerators before the page sees them, and a refusal
 * test whose key never arrived would pass for exactly that reason.
 *
 * PRECONDITIONS ARE ASSERTED, not assumed: the parked state is proved by the
 * focused element (the grid container, not a text field), Core's edit flag
 * (read from the app's own module instance) and the formula still on screen;
 * the paste is proved to land in a TEXTAREA with the clipboard holding what the
 * app's own copy put there.
 *
 * SHARED APP. Every test starts and ends with File > New.
 */
import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { test, expect } from "../fixtures";

const FILE_API = "/src/core/lib/file-api.ts";
const CELL_EDIT_FLAG = "/src/core/lib/cellEditFlag.ts";

interface AppWindow {
  __calcImport: (u: string) => Promise<unknown>;
  __appImport?: (modulePath: string) => Promise<unknown>;
  __TAURI__: { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } };
  __CALCULA_GRID_STATE__?: {
    selection: { startRow: number; startCol: number; endRow: number; endCol: number } | null;
    editing: { row: number; col: number; value: string } | null;
  };
}

interface CellRow {
  display?: string;
  formula?: string | null;
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/** Import an app module from the SAME instance the app loaded (module state!). */
async function installAppImport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as AppWindow;
    if (w.__appImport) return;
    w.__appImport = async (modulePath: string) => {
      const entries = performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .filter((n) => {
          try {
            return new URL(n).pathname === modulePath;
          } catch {
            return false;
          }
        });
      entries.sort();
      const url = entries.length > 0 ? entries[entries.length - 1] : new URL(modulePath, document.baseURI).href;
      return w.__calcImport(url);
    };
  });
}

async function invoke<T = unknown>(page: Page, cmd: string, args: unknown = {}): Promise<T> {
  return page.evaluate(
    async ({ c, a }) => (window as unknown as AppWindow).__TAURI__.core.invoke(c, a),
    { c: cmd, a: args },
  ) as Promise<T>;
}

async function newFile(page: Page): Promise<void> {
  await installAppImport(page);
  await page.evaluate(async (mod) => {
    const m = (await (window as unknown as AppWindow).__appImport!(mod)) as { newFile: () => Promise<void> };
    await m.newFile();
  }, FILE_API);
  await page.waitForTimeout(400);
}

async function eventually<T>(probe: () => Promise<T>, ok: (v: T) => boolean, label: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = undefined as T;
  while (Date.now() < deadline) {
    last = await probe();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`${label}: still ${JSON.stringify(last)?.slice(0, 400)} after ${timeoutMs}ms`);
}

/** Write cells on the ACTIVE sheet and tell the grid to repaint. */
async function writeCells(page: Page, cells: Array<[number, number, string]>): Promise<void> {
  for (const [row, col, value] of cells) {
    await invoke(page, "update_cell", { row, col, value });
  }
  await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
  await page.waitForTimeout(200);
}

/** Display text of cells on ANY sheet, straight from the backend ("" when empty). */
async function cellsOn(page: Page, requests: Array<[number, number, number]>): Promise<string[]> {
  const rows = await invoke<Array<CellRow | null>>(page, "get_watch_cells", { requests });
  return rows.map((c) => (c ? String(c.display ?? "") : ""));
}

async function activeSheet(page: Page): Promise<number> {
  const r = await invoke<{ activeIndex: number }>(page, "get_sheets");
  return r.activeIndex;
}

/** Whether Core's own cell edit is open, from the app's own module instance. */
async function coreEditOpen(page: Page): Promise<boolean> {
  await installAppImport(page);
  return page.evaluate(async (mod) => {
    const m = (await (window as unknown as AppWindow).__appImport!(mod)) as { isCoreCellEditOpen: () => boolean };
    return m.isCoreCellEditOpen();
  }, CELL_EDIT_FLAG);
}

/** What holds the keyboard right now. */
async function focusInfo(page: Page): Promise<{ tag: string; gridContainer: boolean; formulaBar: boolean }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      tag: el?.tagName ?? "(none)",
      gridContainer: !!el?.matches("[data-focus-container='spreadsheet']"),
      formulaBar: !!el?.matches('[data-formula-bar="true"]'),
    };
  });
}

async function gridSelection(page: Page): Promise<{ startRow: number; startCol: number; endRow: number; endCol: number } | null> {
  return page.evaluate(() => {
    const s = (window as unknown as AppWindow).__CALCULA_GRID_STATE__?.selection;
    return s ? { startRow: s.startRow, startCol: s.startCol, endRow: s.endRow, endCol: s.endCol } : null;
  });
}

function createTableTitle(page: Page) {
  return page.locator("h2", { hasText: /^Create Table$/ });
}

/**
 * End every test with no dialog, no open edit and a fresh workbook -- also when
 * the test FAILED mid-way (a wrongly opened Create Table over a parked edit
 * takes the first Escape itself, and a surviving edit would turn the next
 * test's clicks into point-mode references). Each Escape is aimed at what is
 * actually still open, and the result is checked, not assumed.
 */
async function leaveNoEditBehind(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const dialog = (await createTableTitle(page).count().catch(() => 0)) > 0;
    const editing = await coreEditOpen(page).catch(() => false);
    if (!dialog && !editing) break;
    // A closed dialog leaves the keyboard on <body>, where Escape reaches no
    // edit at all: hand it to the grid container first (the parked edit's own
    // keyboard, and a blur-commit at worst for an edit on this sheet).
    if (!dialog) {
      await page.locator("[data-focus-container='spreadsheet']").focus().catch(() => {});
    }
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
  }
  await newFile(page);
  expect(await coreEditOpen(page), "cleanup: an edit survived File > New").toBe(false);
}

/** Add a worksheet through the tab strip's own add route; the new sheet becomes active. */
async function addWorksheet(page: Page): Promise<void> {
  const before = await invoke<{ sheets: unknown[] }>(page, "get_sheets");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sheet:requestAdd", { detail: null })));
  await eventually(
    () => invoke<{ sheets: unknown[]; activeIndex: number }>(page, "get_sheets"),
    (r) => r.sheets.length === before.sheets.length + 1 && r.activeIndex === before.sheets.length,
    "no worksheet was added",
  );
  await page.waitForTimeout(300);
}

/** The system clipboard's text, read from OUTSIDE the app. */
function systemClipboardText(): string {
  return execFileSync("powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], {
    encoding: "utf-8",
    timeout: 30_000,
  }).replace(/\r?\n$/, "");
}

// Sheet2's patch A1:C3, and the requests that read it back.
const SHEET2_PATCH: Array<[number, number, string]> = [
  [0, 0, "5"], [0, 1, "6"], [0, 2, "8"],
  [1, 0, "3"], [1, 1, "7"], [1, 2, "9"],
  [2, 0, "1"], [2, 1, "2"], [2, 2, "4"],
];
const SHEET2_READ: Array<[number, number, number]> = SHEET2_PATCH.map(([r, c]) => [1, r, c]);
const SHEET2_EXPECTED = SHEET2_PATCH.map(([, , v]) => v);

/**
 * Sheet1!A1 = "orig", Sheet2!A1:C3 = the patch, Sheet1 active again. Sheet2's
 * B2 is selected when it is left, so its viewed selection sits on the patch.
 */
async function seedTwoSheets(page: Page, grid: { clickCell: (r: string) => Promise<void> }): Promise<void> {
  await writeCells(page, [[0, 0, "orig"]]);
  await addWorksheet(page);
  await writeCells(page, SHEET2_PATCH);
  await grid.clickCell("B2");
  await page.locator('button[data-sheet-tab="0"]').click();
  await eventually(() => activeSheet(page), (i) => i === 0, "could not return to Sheet1");
  await page.waitForTimeout(300);
  expect(await cellsOn(page, SHEET2_READ), "the Sheet2 patch was not written").toEqual(SHEET2_EXPECTED);
  expect(await cellsOn(page, [[0, 0, 0]])).toEqual(["orig"]);
}

// ---------------------------------------------------------------------------
// L1 -- a parked cross-sheet edit
// ---------------------------------------------------------------------------

test.describe("Core's parked cross-sheet edit ignores grid keys (L1)", () => {
  test("Delete, Ctrl+T and Ctrl+Shift+L on Sheet2 during =SUM( from Sheet1 change nothing; Escape cancels and returns", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await seedTwoSheets(page, grid);

      // Begin the formula IN the in-cell editor on Sheet1!A1.
      await grid.clickCell("A1");
      await page.keyboard.type("=SUM(", { delay: 40 });
      await eventually(() => grid.formulaBar.inputValue(), (v) => v === "=SUM(", "typing =SUM( did not open an edit");
      expect((await focusInfo(page)).tag, "the edit did not open in the in-cell editor").toBe("TEXTAREA");

      // Point mode: the Sheet2 tab moves the VIEW, the edit stays on Sheet1.
      await page.locator('button[data-sheet-tab="1"]').click();
      await eventually(() => activeSheet(page), (i) => i === 1, "the point-mode tab click did not show Sheet2");
      await page.waitForTimeout(400);
      expect(await grid.formulaBar.inputValue(), "the edit did not survive the switch").toBe("=SUM(");

      // Point at Sheet2!B2: a reference goes INTO the formula, and the keyboard
      // goes to the grid container (the in-cell editor is not rendered here).
      await grid.clickCell("B2");
      await eventually(
        () => grid.formulaBar.inputValue(),
        (v) => /^=SUM\(Sheet2!B2$/i.test(v),
        "clicking Sheet2!B2 did not insert a reference into the parked formula",
      );
      await page.waitForTimeout(300);

      // --- THE PARKED STATE, proved -------------------------------------------
      const parked = await focusInfo(page);
      expect(
        parked,
        "precondition: the keyboard must be on the grid container with NO text field focused -- " +
          "otherwise this test would only re-prove the text-field guard that already worked",
      ).toEqual({ tag: "DIV", gridContainer: true, formulaBar: false });
      expect(await coreEditOpen(page), "precondition: Core's edit flag must be open while parked").toBe(true);
      const sel = await gridSelection(page);
      expect(sel, "precondition: a viewed selection exists").not.toBeNull();
      expect(
        Math.max(sel!.startRow, sel!.endRow) <= 2 && Math.max(sel!.startCol, sel!.endCol) <= 2,
        `precondition: the viewed selection ${JSON.stringify(sel)} must lie on the seeded patch, so a key ` +
          "that acted on it would CHANGE the patch",
      ).toBe(true);

      // --- the three keys -------------------------------------------------------
      // Each key is checked on its own (soft), so one key's refusal failing
      // cannot hide another's: Delete and Ctrl+T/Ctrl+Shift+L are refused by
      // DIFFERENT halves of the dispatcher (the grid-scoped refusal and the
      // "not-editing" context). Ctrl+T goes last because a Create Table dialog
      // it wrongly opened would take the keyboard from any key after it.
      // Everything is read through the backend while Sheet2 is still the
      // backend's active sheet (point mode moved it there).
      expect(await activeSheet(page)).toBe(1);

      await page.keyboard.press("Delete");
      await page.waitForTimeout(500);
      expect.soft(await cellsOn(page, SHEET2_READ), "Delete changed Sheet2 under a parked Sheet1 edit").toEqual(SHEET2_EXPECTED);
      expect.soft(await grid.formulaBar.inputValue(), "Delete ended or rewrote the parked edit").toMatch(/^=SUM\(Sheet2!B2$/i);

      await page.keyboard.press("Control+Shift+L");
      await page.waitForTimeout(700);
      expect
        .soft(await invoke(page, "get_auto_filter"), "Ctrl+Shift+L created an AutoFilter on Sheet2 during a parked edit")
        .toBeNull();

      await page.keyboard.press("Control+t");
      await page.waitForTimeout(700);
      await expect.soft(createTableTitle(page), "Ctrl+T opened Create Table during a parked edit").toHaveCount(0);

      expect(await cellsOn(page, SHEET2_READ), "a key changed Sheet2's cells").toEqual(SHEET2_EXPECTED);
      expect(await invoke(page, "get_tables_all_sheets"), "a table was created during a parked edit").toEqual([]);
      expect(await invoke(page, "get_auto_filter"), "an AutoFilter was created on Sheet2 during a parked edit").toBeNull();
      expect(await coreEditOpen(page), "the edit was ended by one of the keys").toBe(true);
      expect(await grid.formulaBar.inputValue()).toMatch(/^=SUM\(Sheet2!B2$/i);

      // --- Escape cancels and returns ------------------------------------------
      await page.keyboard.press("Escape");
      await eventually(() => activeSheet(page), (i) => i === 0, "Escape did not return to Sheet1");
      await eventually(() => coreEditOpen(page), (v) => v === false, "Escape did not end the edit");
      expect(await cellsOn(page, [[0, 0, 0]]), "Escape committed the formula instead of cancelling").toEqual(["orig"]);
      expect(await invoke(page, "get_auto_filter"), "an AutoFilter appeared on Sheet1").toBeNull();
      expect(await cellsOn(page, SHEET2_READ)).toEqual(SHEET2_EXPECTED);
      expect(await invoke(page, "get_tables_all_sheets")).toEqual([]);
    } finally {
      await leaveNoEditBehind(page);
    }
  });

  test("POSITIVE CONTROL -- with no edit open, the same keys on Sheet2 clear B2, toggle an AutoFilter and open Create Table", async ({
    appPage: page,
    grid,
  }) => {
    // Without this case the refusals above would pass just as well if these
    // keystrokes never reached the page at all.
    try {
      await newFile(page);
      await seedTwoSheets(page, grid);

      await page.locator('button[data-sheet-tab="1"]').click();
      await eventually(() => activeSheet(page), (i) => i === 1, "the tab click did not switch to Sheet2");
      await page.waitForTimeout(400);
      expect(await coreEditOpen(page)).toBe(false);

      // Delete on Sheet2!B2 clears it.
      await grid.clickCell("B2");
      expect((await focusInfo(page)).gridContainer, "the keyboard is not on the grid").toBe(true);
      await page.keyboard.press("Delete");
      await eventually(() => cellsOn(page, [[1, 1, 1]]), (v) => v[0] === "", "Delete did not clear Sheet2!B2 with no edit open");
      // ...and only B2.
      const after = await cellsOn(page, SHEET2_READ);
      expect(after).toEqual(SHEET2_EXPECTED.map((v, i) => (i === 4 ? "" : v)));

      // Ctrl+Shift+L toggles an AutoFilter on (and off again).
      await grid.clickCell("A1");
      await page.keyboard.press("Control+Shift+L");
      await eventually(() => invoke(page, "get_auto_filter"), (v) => v !== null, "Ctrl+Shift+L created no AutoFilter with no edit open");
      await page.keyboard.press("Control+Shift+L");
      await eventually(() => invoke(page, "get_auto_filter"), (v) => v === null, "a second Ctrl+Shift+L did not remove the AutoFilter");

      // Ctrl+T opens Create Table, and its OK creates a table on Sheet2.
      await grid.clickCell("A1");
      await page.keyboard.press("Control+t");
      await expect(createTableTitle(page), "Ctrl+T did not open Create Table with no edit open").toHaveCount(1, { timeout: 8000 });
      await page.locator("button").filter({ hasText: /^OK$/ }).last().click();
      const tables = await eventually(
        () => invoke<Array<{ sheetIndex: number }>>(page, "get_tables_all_sheets"),
        (t) => t.length === 1,
        "OK in Create Table created no table",
      );
      expect(tables[0].sheetIndex).toBe(1);
    } finally {
      await leaveNoEditBehind(page);
    }
  });
});

// ---------------------------------------------------------------------------
// L2 -- Ctrl+V inside the in-cell editor
// ---------------------------------------------------------------------------

test.describe("Ctrl+V in Core's in-cell editor pastes into the text (L2)", () => {
  /** A1:B2 hold values; D1:E2 is copied by the app's own Ctrl+C. */
  async function seedAndCopy(page: Page, grid: { selectRange: (a: string, b: string) => Promise<void> }): Promise<void> {
    await writeCells(page, [
      [0, 0, "x1"], [0, 1, "y1"],
      [1, 0, "x2"], [1, 1, "y2"],
      [0, 3, "abc"], [0, 4, "p"],
      [1, 3, "q"], [1, 4, "r"],
    ]);
    await grid.selectRange("D1", "E2");
    await page.keyboard.press("Control+c");
    // The copy is the app's own; assert it reached the SYSTEM clipboard, which
    // is what a native paste into the editor reads.
    await eventually(
      async () => systemClipboardText(),
      (t) => t.replace(/\r\n/g, "\n") === "abc\tp\nq\tr",
      "the app's Ctrl+C did not put D1:E2 on the system clipboard",
    );
  }

  /** B2 then Shift+A1: the whole of A1:B2 selected, with A1 the ACTIVE cell (selection.end). */
  async function selectA1B2WithA1Active(page: Page, grid: { selectRange: (a: string, b: string) => Promise<void> }): Promise<void> {
    await grid.selectRange("B2", "A1");
    expect(await gridSelection(page), "A1:B2 is not selected with A1 active").toEqual({
      startRow: 1,
      startCol: 1,
      endRow: 0,
      endCol: 0,
    });
  }

  const A1B2: Array<[number, number, number]> = [
    [0, 0, 0], [0, 0, 1],
    [0, 1, 0], [0, 1, 1],
  ];

  test("F2 on A1 with A1:B2 selected, Ctrl+V, Enter: the clipboard text lands in A1's TEXT and B1/A2/B2 keep their values", async ({
    appPage: page,
    grid,
  }) => {
    try {
      await newFile(page);
      await seedAndCopy(page, grid);
      await selectA1B2WithA1Active(page, grid);

      await page.keyboard.press("F2");
      await eventually(() => focusInfo(page), (f) => f.tag === "TEXTAREA", "F2 did not open the in-cell editor");
      await eventually(() => grid.formulaBar.inputValue(), (v) => v === "x1", "the edit did not open on A1's value");

      await page.keyboard.press("Control+v");
      await page.waitForTimeout(600);
      // The editor's own text, before committing: the paste went INTO it.
      const editorText = await page.evaluate(() => (document.activeElement as HTMLTextAreaElement | null)?.value ?? "");
      expect(editorText.replace(/\r\n/g, "\n"), "Ctrl+V did not insert the clipboard into the editor's text").toBe(
        "x1abc\tp\nq\tr",
      );
      // ...and NOT over the selection: nothing has been written yet.
      expect(await cellsOn(page, A1B2), "Ctrl+V pasted over the selection during the edit").toEqual(["x1", "y1", "x2", "y2"]);

      await page.keyboard.press("Enter");
      await eventually(() => coreEditOpen(page), (v) => v === false, "Enter did not commit the edit");
      await page.waitForTimeout(300);

      const [a1, b1, a2, b2] = await cellsOn(page, A1B2);
      expect(a1.replace(/\r\n/g, "\n"), "A1 does not hold the edited text with the pasted clipboard in it").toBe("x1abc\tp\nq\tr");
      expect([b1, a2, b2], "the paste also landed over the selection").toEqual(["y1", "x2", "y2"]);
    } finally {
      await leaveNoEditBehind(page);
    }
  });

  test("POSITIVE CONTROL -- with no edit open, the same Ctrl+V pastes the copied block over A1:B2", async ({
    appPage: page,
    grid,
  }) => {
    // Without this case the refusal above would pass just as well if Ctrl+V
    // never reached the grid's paste at all.
    try {
      await newFile(page);
      await seedAndCopy(page, grid);
      await selectA1B2WithA1Active(page, grid);
      expect(await coreEditOpen(page)).toBe(false);

      await page.keyboard.press("Control+v");
      await eventually(
        () => cellsOn(page, A1B2),
        (v) => JSON.stringify(v) === JSON.stringify(["abc", "p", "q", "r"]),
        "Ctrl+V with no edit open did not paste the copied block over A1:B2",
      );
    } finally {
      await leaveNoEditBehind(page);
    }
  });
});
