/**
 * release-acts.spec.ts -- "Buttons and pivot +/- act on release instead of on
 * press, and sliding off cancels" (BUG-0258 design Part 2, phase 4; the
 * owner's answer "on release, and sliding off cancels" -- the standard Windows
 * button rule). M7 moved the FLOATING families (run-mode floating buttons, the
 * canvas pivot box's chrome, chart buttons, slicer items) to the release
 * through Core's content press; this journey proves the part M7 left, the
 * targets a CELL CLICK INTERCEPTOR answers -- now through ONE release-time seam
 * (src/core/lib/cellClickInterceptors.ts `actOnRelease` / `actOnCellRelease`,
 * held by Core's press session src/core/lib/cellPressRelease.ts, opened by
 * Core's mouse-down door in useSpreadsheetSelection.ts):
 *
 *   RA-1  a WORKSHEET pivot's +/- (extensions/Pivot/lib/pivotCellChrome.ts):
 *         a press on the '-' collapses nothing and selects nothing; pressed,
 *         slid off and released off it collapses nothing; a click collapses it.
 *   RA-2  its report-filter combo and its Row Labels filter button: a press
 *         opens no menu; slid off, nothing opens; a click opens the menu once
 *         (counted on the app event the menu is opened by).
 *   RA-3  its loading indicator's Cancel: a press cancels nothing; slid off,
 *         the pivot is still loading; a click cancels.
 *   RA-4  an IN-CELL (cell-anchored) button control (extensions/Controls/
 *         Button/interceptors.ts): a press runs nothing and the face looks
 *         PRESSED (the floating button's 12% wash, Button/rendering.ts); slid
 *         off it looks raised again and the release runs nothing; a click runs
 *         it; in Design Mode a click runs nothing.
 *   RA-5  a BUTTON CELL (Cell Type: Button, extensions/CellTypes/types/
 *         button.ts): the same -- held looks pressed, slid off runs nothing,
 *         a click runs its command (`cellTypes.clear`, which clears the
 *         button's own cell type: the observable).
 *   RA-6  a CHECKBOX CELL (Cell Type: Checkbox, extensions/CellTypes/types/
 *         checkbox.ts; owner question 26, 2026-10-02 -- a checkbox toggles on
 *         the release, as in Windows): a press toggles nothing and selects its
 *         cell; slid off and released off it, nothing toggles and the
 *         selection is still that one cell; a click toggles it once.
 *   RA-7  a LEGACY style-flag checkbox (extensions/Checkbox/interceptors.ts):
 *         the same.
 *   RA-8  a worksheet pivot's +/- DOUBLE-CLICK toggles it once, as the canvas
 *         box's does (owner question 27: the box's 450 ms guard, now ONE guard
 *         for both, extensions/Pivot/lib/pivotChromeRepeat.ts): a double-click
 *         on a '-' collapses the group and it stays collapsed; on its '+' it
 *         expands and stays expanded. Before, the second release toggled it
 *         back.
 *
 * Every point is the product's own geometry: the pivot chrome is read from
 * the bounds the overlay PAINTED (pivotCellChrome.ts) and confirmed by its own
 * hit test (`pivotCellChromeHitsAt`); cells from the grid helper.
 *
 * LIVE 2026-10-02: 8 passed. Its first live run (the full run 11) failed
 * RA-4..RA-7 on TEST assumptions, both fixed here, none in the product:
 * every cell point came from `GridHelper.cellCenter`, which answers in the grid
 * CANVAS's own box, and was used as a CLIENT point -- the presses landed one
 * canvas offset up-left of their cells and the face patches sampled the ribbon
 * (`cellClientCenter` below); and RA-4 dispatched the Properties pane's "In
 * cell" event without the pane's write of `embedded` that precedes it. Run it
 * live with
 *   cd app && npx playwright test --project=journey e2e/journeys/release-acts.spec.ts
 * (CARGO_TARGET_DIR=C:/Users/Salle/AppData/Local/calcula-target; clear stale
 * processes with `node app/scripts/kill-stale-dev.mjs`, never by killing
 * msedgewebview2 by name). Expect 8 passed.
 *
 * E2E GOTCHAS this journey is written around:
 *   - Pixels come from samplePixelGrids (e2e/viewportSample.ts): one
 *     UNCLIPPED capture, cropped in the page (a clipped capture can report an
 *     absence it caused; e2e/__tests__/noClippedCapture.test.ts). Never a
 *     golden (DPR 2 here, and the goldens are stale after the owner's UI work).
 *   - A press is `page.mouse.down()` with NO up, and the "nothing happened"
 *     checks wait 600-800 ms first: the in-cell interceptors are async (the
 *     Controls one asks the backend for the cell), so a press-time action
 *     would land a moment AFTER the down.
 *   - `page.mouse.click` presses and releases in place, which still acts.
 *
 * SABOTAGES that must turn this journey RED (apply one, confirm the behaviour
 * changed, start a FRESH run -- Vite serves the frontend, no Rust build --,
 * see the message, restore byte-identical; useSpreadsheetSelection.ts and
 * cellPressRelease.ts are LF, cellClickInterceptors.ts is CRLF: edit it with
 * node):
 *   (Line numbers re-read 2026-10-02: the review's Escape fix added comment
 *   lines to cellPressRelease.ts, so 1 and 2 moved from :166 and :249; the
 *   double-click guard's header lines moved 3 from :183.)
 *   (RUN LIVE 2026-10-02 against RA-4..RA-7, after the geometry fix: 1, 2, 4,
 *   5, 6, 7 and 8 each turned exactly the tests named below red on exactly the
 *   message named, every target restored byte-identical by sha256. 3 and 9 --
 *   the pivot chrome -- were not re-run then.)
 *   1. src/core/lib/cellPressRelease.ts:173 (`settle`): run the claim at the arm --
 *      replace `s.claim = claim;` with `judge(claim, pointOf(s, s.last)); return;`
 *      -> RA-1 "the '-' collapsed on the PRESS", RA-2 "opened its menu on the
 *      PRESS", RA-3 "Cancel acted on the PRESS", RA-4 "the in-cell button ran
 *      on the PRESS", RA-5 "the button cell ran on the PRESS", RA-6 / RA-7
 *      "the checkbox cell / legacy checkbox toggled on the PRESS".
 *   2. src/core/lib/cellPressRelease.ts:256 (`judge`): drop `|| !onTarget(claim, point)`
 *      -> every "slid off ... released off it" assertion (RA-1..RA-7).
 *   3. extensions/Pivot/lib/pivotCellChrome.ts:192 (`claimPivotCellChrome`): make
 *      `targetAt` return `key` unconditionally -> RA-1/RA-2/RA-3 slide-off
 *      assertions (the in-cell buttons stay green: their claims are the cells').
 *   4. extensions/Controls/Button/rendering.ts:62: `const pressed = false;`
 *      -> RA-4 "a held in-cell button does not look pressed".
 *   5. extensions/CellTypes/types/button.ts:304: drop `{ pressedLook: true }` from
 *      the onClick's actOnCellRelease -> RA-5 "a held button cell does not look
 *      pressed".
 *   6. extensions/Controls/Button/interceptors.ts:129-134: back to the press --
 *      `await executeButtonAction(row, col, (macroId) => mintExplicitMacroRun("button", macroId)); return true;`
 *      in place of the `return actOnCellRelease(...)` -> RA-4 "the in-cell
 *      button ran on the PRESS".
 *   7. extensions/CellTypes/types/checkbox.ts:155 (`pressCheckbox`): back to the
 *      press -- `await releaseCheckbox(row, col); return true;` in place of the
 *      `return actOnCellRelease(...)` -> RA-6 "the checkbox cell toggled on the
 *      PRESS" (RA-7 stays green: the legacy checkbox is another family).
 *   8. extensions/Checkbox/interceptors.ts:143 (`checkboxClickInterceptor`): back
 *      to the press -- `await toggleCheckboxAt(row, col); return true;` in place
 *      of the `return actOnCellRelease(...)` -> RA-7 "the legacy checkbox
 *      toggled on the PRESS".
 *   9. extensions/Pivot/lib/pivotCellChrome.ts:194: drop the guard --
 *      `runAtRelease: run,` -> RA-8 "a double-click on the '-' toggled it
 *      TWICE". (Dropping it at its source instead --
 *      extensions/Pivot/lib/pivotChromeRepeat.ts:31, make the `if` false --
 *      drops the canvas box's guard too; this journey sees the worksheet half.)
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import type { GridHelper } from "../helpers/grid";
import { readGridGeometry } from "../helpers/grid";
import {
  callModule,
  cellAt,
  configurePivot,
  createRangePivot,
  eventually,
  installAppImport,
  invoke,
  newFile,
  pivotView,
  rcToRef,
  writeTable,
  type AppWindow,
} from "../helpers/pivot-live";
import { appEventCount, setDesignMode, startAppEventCounter } from "../helpers/objectButtons";
import { samplePixelGrids, type PixelClip, type PixelSample } from "../viewportSample";

const CHROME = "/extensions/Pivot/lib/pivotCellChrome.ts";
const VIEW_STORE = "/extensions/Pivot/lib/pivotViewStore.ts";
const GRID_OVERLAYS = "/src/api/gridOverlays.ts";
const CELL_TYPES = "/src/api/cellTypes.ts";
const BUTTONS = "/src/api/buttonControlService.ts";
const OPEN_FILTER_MENU = "app:pivot-open-filter-menu";
const OPEN_HEADER_FILTER_MENU = "app:pivot-open-header-filter-menu";
const SUM_SALES = { sourceIndex: 2, name: "Sum of Sales", aggregation: "sum" };
const DATA: Array<Array<string | number>> = [
  ["Region", "Product", "Sales"],
  ["North", "Apples", 1],
  ["North", "Pears", 2],
  ["South", "Apples", 3],
  ["South", "Pears", 4],
];
/** A press-time action lands a moment after the down (the interceptors are async). */
const SETTLE_MS = 700;

function ascii(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, "?");
}

function log(message: string): void {
  console.log(`[release-acts] ${ascii(message)}`);
}

// ---------------------------------------------------------------------------
// The worksheet pivot's chrome, as PAINTED
// ---------------------------------------------------------------------------

type ChromeKind = "icon" | "filter" | "headerFilter" | "cancel";

interface ChromePoint {
  /** CLIENT px at the chrome's centre. */
  x: number;
  y: number;
  /** The chrome's key, from the product's own key function. */
  key: string;
}

/**
 * The CLIENT point at the centre of a piece of a worksheet pivot's in-cell
 * chrome of `kind` (for an icon: a ROW icon that is `expanded` or not), from
 * the bounds the pivot overlay last PAINTED (lib/pivotCellChrome.ts), and
 * confirmed by the chrome's own hit test at that point. The bounds are in the
 * grid canvas's CSS box, exactly as the interceptor measures a press.
 */
async function chromePoint(page: Page, pivotId: string, kind: ChromeKind, expanded?: boolean): Promise<ChromePoint | null> {
  await installAppImport(page);
  return page.evaluate(
    async ({ mod, pivotId, kind, expanded }) => {
      type Rect = { x: number; y: number; width: number; height: number };
      type Hit = { kind: string; pivotId?: string; bounds?: Rect & { pivotId: string; isRow?: boolean; isExpanded?: boolean } };
      const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
        overlayIconBounds: Map<string, Rect & { pivotId: string; isRow: boolean; isExpanded: boolean }>;
        overlayFilterDropdownBounds: Map<string, Rect & { pivotId: string }>;
        overlayHeaderFilterBounds: Map<string, Rect & { pivotId: string }>;
        overlayCancelBounds: Map<string, Rect>;
        pivotCellChromeHitsAt: (x: number, y: number) => Hit[];
        pivotCellChromeKey: (h: Hit) => string;
      };
      const canvas = document.querySelector("[data-grid-canvas-layer] canvas") as HTMLCanvasElement | null;
      if (!canvas) return null;
      const box = canvas.getBoundingClientRect();
      const candidates: Rect[] = [];
      if (kind === "icon") {
        for (const b of m.overlayIconBounds.values()) {
          if (b.pivotId === pivotId && b.isRow && (expanded === undefined || b.isExpanded === expanded)) candidates.push(b);
        }
      } else if (kind === "filter") {
        for (const b of m.overlayFilterDropdownBounds.values()) if (b.pivotId === pivotId) candidates.push(b);
      } else if (kind === "headerFilter") {
        for (const b of m.overlayHeaderFilterBounds.values()) if (b.pivotId === pivotId) candidates.push(b);
      } else {
        const b = m.overlayCancelBounds.get(pivotId);
        if (b) candidates.push(b);
      }
      for (const b of candidates) {
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        const hit = m.pivotCellChromeHitsAt(cx, cy).find(
          (h) => h.kind === kind && (h.pivotId ?? h.bounds?.pivotId) === pivotId,
        );
        if (!hit) continue;
        return { x: box.left + cx, y: box.top + cy, key: m.pivotCellChromeKey(hit) };
      }
      return null;
    },
    { mod: CHROME, pivotId, kind, expanded },
  );
}

/** Whether ANY of the pivot's chrome is under a CLIENT point (the product's own hit test). */
async function chromeUnder(page: Page, p: { x: number; y: number }): Promise<boolean> {
  await installAppImport(page);
  return page.evaluate(
    async ({ mod, p }) => {
      const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
        pivotCellChromeHitsAt: (x: number, y: number) => unknown[];
      };
      const canvas = document.querySelector("[data-grid-canvas-layer] canvas") as HTMLCanvasElement | null;
      if (!canvas) return false;
      const box = canvas.getBoundingClientRect();
      return m.pivotCellChromeHitsAt(p.x - box.left, p.y - box.top).length > 0;
    },
    { mod: CHROME, p },
  );
}

/** A point `dx` px to the right of `p` that no chrome covers (the slide-off target). */
async function offChrome(page: Page, p: { x: number; y: number }): Promise<{ x: number; y: number }> {
  for (const dx of [140, 180, 220, 100]) {
    const q = { x: p.x + dx, y: p.y };
    if (!(await chromeUnder(page, q))) return q;
  }
  throw new Error("no point beside the chrome is free of chrome to slide off to");
}

async function gridSelection(page: Page): Promise<{ endRow: number; endCol: number } | null> {
  return page.evaluate(() => {
    const s = (window as unknown as AppWindow).__CALCULA_GRID_STATE__?.selection;
    return s ? { endRow: s.endRow, endCol: s.endCol } : null;
  });
}

/** Press at `p`, wait for a press-time action to have had its chance, then slide to `off` and release there. */
async function pressSlideOffRelease(page: Page, p: { x: number; y: number }, off: { x: number; y: number }, atPress: () => Promise<void>): Promise<void> {
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.waitForTimeout(SETTLE_MS);
  await atPress();
  await page.mouse.move(off.x, off.y, { steps: 6 });
  await page.waitForTimeout(250);
  await page.mouse.up();
  await page.waitForTimeout(SETTLE_MS + 300);
}

async function pivotOnSheet1(page: Page, fields: Record<string, unknown>): Promise<string> {
  await writeTable(page, DATA);
  const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:C5", destinationCell: "E3", sourceSheet: 0, destinationSheet: 0 });
  await configurePivot(page, { pivotId: pid, valueFields: [SUM_SALES], ...fields });
  await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
  await page.waitForTimeout(600);
  return pid;
}

// ---------------------------------------------------------------------------
// Buttons in cells
// ---------------------------------------------------------------------------

async function withScriptsEnabled<T>(page: Page, body: () => Promise<T>): Promise<T> {
  const previous = await invoke<string>(page, "get_script_security_level").catch(() => "prompt");
  await invoke(page, "set_script_security_level", { level: "enabled" });
  try {
    return await body();
  } finally {
    await invoke(page, "set_script_security_level", { level: previous }).catch(() => undefined);
  }
}

function meanLuma(s: PixelSample): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 2 < s.data.length; i += 4) {
    sum += 0.299 * s.data[i] + 0.587 * s.data[i + 1] + 0.114 * s.data[i + 2];
    n++;
  }
  return n === 0 ? NaN : sum / n;
}

/**
 * The CLIENT (page) centre of a cell -- what `page.mouse` and the pixel
 * sampler take.
 *
 * FIXED 2026-10-02 after the first live run (RA-4..RA-7 red): this journey used
 * `GridHelper.cellCenter` as if it answered in client pixels. It answers in the
 * grid CANVAS's own CSS box -- what `canvas.click({ position })` takes
 * (e2e/helpers/grid.ts) -- so every press landed one canvas offset up and to
 * the left of its cell (the trace: a press meant for C11 at canvas (182.7,
 * 230) went to client (182.7, 230) = canvas (134.7, 38) = B1, the selection
 * RA-7 reported; RA-6's C9 landed ABOVE the canvas and selected nothing), and
 * the face patch sampled the ribbon (255 held, 255 released, RA-5). The
 * product was never pressed.
 */
async function cellClientCenter(grid: GridHelper, ref: string): Promise<{ x: number; y: number }> {
  const local = await grid.cellCenter(ref);
  const box = await grid.canvas.boundingBox();
  if (!box) throw new Error("the grid canvas has no bounding box");
  return { x: box.x + local.x, y: box.y + local.y };
}

/**
 * A patch of an in-cell button's FACE, clear of its centred caption and of
 * the raised highlight / shading: 5-11 px in from the cell's left edge,
 * 2-6 px below its centre. CLIENT pixels (the sampler's frame).
 */
async function facePatch(page: Page, grid: GridHelper, ref: string, col: number): Promise<PixelClip> {
  const geo = await readGridGeometry(page);
  const centre = await cellClientCenter(grid, ref);
  const w = geo.columnWidths[col] ?? geo.defaultCellWidth;
  return { x: centre.x - (w / 2 - 5) * geo.zoom, y: centre.y + 2 * geo.zoom, width: 6 * geo.zoom, height: 4 * geo.zoom };
}

async function faceLuma(page: Page, clip: PixelClip): Promise<number> {
  return meanLuma((await samplePixelGrids(page, [clip]))[0]);
}

interface StoredProp {
  valueType: string;
  value: string;
}

async function controlProps(page: Page, sheetIndex: number, row: number, col: number): Promise<Record<string, StoredProp> | null> {
  const meta = await invoke<{ properties: Record<string, StoredProp> } | null>(page, "get_control_metadata", { sheetIndex, row, col });
  return meta?.properties ?? null;
}

/** Does the cell carry the in-cell BUTTON style flag (what the in-cell button's interceptor and renderer read)? */
async function hasButtonStyle(page: Page, row: number, col: number): Promise<boolean> {
  const cell = await invoke<{ styleIndex?: number } | null>(page, "get_cell", { row, col });
  if (!cell) return false;
  const style = await invoke<{ button?: boolean } | null>(page, "get_style", { index: cell.styleIndex ?? 0 });
  return style?.button === true;
}

interface CellTypeEntry {
  row: number;
  col: number;
  typeId: string;
}

async function cellTypeAt(page: Page, row: number, col: number): Promise<string | null> {
  const all = await invoke<CellTypeEntry[]>(page, "get_all_cell_types", { sheetIndex: 0 });
  return all.find((c) => c.row === row && c.col === col)?.typeId ?? null;
}

// ===========================================================================
// RA-1..RA-3: a worksheet pivot's in-cell chrome
// ===========================================================================

test.describe("a worksheet pivot's in-cell chrome acts on RELEASE over the same chrome", () => {
  test("RA-1: a press on a '-' collapses nothing and selects nothing; pressed and slid off it collapses nothing; a click collapses it", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(180_000);
    try {
      await newFile(page);
      const pid = await pivotOnSheet1(page, {
        rowFields: [
          { sourceIndex: 0, name: "Region" },
          { sourceIndex: 1, name: "Product" },
        ],
      });
      const rowsBefore = (await pivotView(page, pid)).rows.length;
      const minus = await eventually(() => chromePoint(page, pid, "icon", true), (p) => p !== null, "the pivot painted no '-' on a row header", 15_000);
      log(`'-' at ${JSON.stringify(minus)}; ${rowsBefore} view rows`);
      const off = await offChrome(page, minus!);
      await grid.clickCell("A12");
      const selected = await gridSelection(page);

      await pressSlideOffRelease(page, minus!, off, async () => {
        expect((await pivotView(page, pid)).rows.length, "the '-' collapsed on the PRESS").toBe(rowsBefore);
        expect(await gridSelection(page), "a press on the '-' selected its cell").toEqual(selected);
      });
      expect((await pivotView(page, pid)).rows.length, "pressed on the '-', slid off and released off it: it COLLAPSED").toBe(rowsBefore);

      await page.mouse.click(minus!.x, minus!.y);
      await eventually(
        () => pivotView(page, pid).then((v) => v.rows.length),
        (n) => n < rowsBefore,
        "a click on the '-' (press and release on it) did not collapse the group",
        15_000,
      );
    } finally {
      await newFile(page);
    }
  });

  test("RA-2: a report-filter combo and the Row Labels filter button open no menu on the press and none when slid off; a click opens it once", async ({
    appPage: page,
  }) => {
    test.setTimeout(180_000);
    try {
      await newFile(page);
      const pid = await pivotOnSheet1(page, {
        rowFields: [{ sourceIndex: 1, name: "Product" }],
        filterFields: [{ sourceIndex: 0, name: "Region" }],
      });

      for (const [kind, event] of [
        ["filter", OPEN_FILTER_MENU],
        ["headerFilter", OPEN_HEADER_FILTER_MENU],
      ] as const) {
        const at = await eventually(() => chromePoint(page, pid, kind), (p) => p !== null, `the pivot painted no ${kind} button`, 15_000);
        log(`${kind} at ${JSON.stringify(at)}`);
        const off = await offChrome(page, at!);
        await startAppEventCounter(page, event);

        await pressSlideOffRelease(page, at!, off, async () => {
          expect(await appEventCount(page, event), `the ${kind} button opened its menu on the PRESS`).toBe(0);
        });
        expect(await appEventCount(page, event), `pressed on the ${kind} button, slid off and released off it: its menu OPENED`).toBe(0);

        await page.mouse.click(at!.x, at!.y);
        await eventually(() => appEventCount(page, event), (n) => n >= 1, `a click on the ${kind} button opened no menu`);
        await page.waitForTimeout(400);
        expect(await appEventCount(page, event), `one click on the ${kind} button opened its menu more than once`).toBe(1);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
      }
    } finally {
      await newFile(page);
    }
  });

  test("RA-3: the loading indicator's Cancel cancels nothing on the press and nothing when slid off; a click cancels", async ({
    appPage: page,
  }) => {
    test.setTimeout(180_000);
    let pid = "";
    try {
      await newFile(page);
      pid = await pivotOnSheet1(page, { rowFields: [{ sourceIndex: 0, name: "Region" }] });
      // The pivot's own loading state, as a slow refresh sets it; the overlay
      // paints the Cancel button after 1 s of it.
      await callModule(page, VIEW_STORE, "setLoading", [pid, "Calculating"]);
      await callModule(page, GRID_OVERLAYS, "requestOverlayRedraw");
      const cancel = await eventually(() => chromePoint(page, pid, "cancel"), (p) => p !== null, "the loading pivot painted no Cancel button", 10_000);
      const off = await offChrome(page, cancel!);
      const loading = () => callModule<boolean>(page, VIEW_STORE, "isLoading", [pid]);

      await pressSlideOffRelease(page, cancel!, off, async () => {
        expect(await loading(), "Cancel acted on the PRESS").toBe(true);
      });
      expect(await loading(), "pressed on Cancel, slid off and released off it: the loading was CANCELLED").toBe(true);

      await page.mouse.click(cancel!.x, cancel!.y);
      await eventually(loading, (l) => l === false, "a click on Cancel did not cancel the loading", 10_000);
    } finally {
      if (pid) await callModule(page, VIEW_STORE, "clearLoading", [pid]).catch(() => undefined);
      await newFile(page);
    }
  });
});

// ===========================================================================
// RA-4, RA-5: buttons in cells
// ===========================================================================

test.describe("a button in a cell runs on RELEASE on its cell, and looks pressed while held", () => {
  test("RA-4: an IN-CELL button control: held it looks pressed and has run nothing; slid off it looks raised and the release runs nothing; a click runs it; in Design Mode a click runs nothing", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(240_000);
    const RUN = Date.now().toString(36);
    const MARK = { row: 30, col: 8 };
    const marker = `RA4-${RUN}`;
    try {
      await withScriptsEnabled(page, async () => {
        await newFile(page);
        await setDesignMode(page, false);
        // A floating button with the user's OWN inline code, through the
        // Controls seam, then put in its cell the user's way: the Properties
        // pane's "In cell" toggle event (Controls/index.ts handleEmbeddedToggle).
        await installAppImport(page);
        const made = await page.evaluate(
          async ({ mod, req }) => {
            const m = (await (window as unknown as AppWindow).__appImport!(mod)) as {
              requireButtonControlProvider: () => { createButton: (r: unknown) => Promise<{ row: number; col: number }> };
            };
            return m.requireButtonControlProvider().createButton(req);
          },
          {
            mod: BUTTONS,
            req: { sheetIndex: 0, row: 4, col: 1, label: "Go", onSelect: `Calcula.setCellValue(${MARK.row}, ${MARK.col}, '${marker}');` },
          },
        );
        await page.waitForTimeout(500);
        // The Properties pane's "In cell" toggle, exactly as the pane does it
        // (PropertiesPane.tsx handlePropertyChange): WRITE the `embedded`
        // property, THEN announce it. FIXED 2026-10-02 after the first live
        // run: this journey dispatched the event alone. The toggle's handler
        // (Controls/index.ts handleEmbeddedToggle) writes `embedded` only when
        // it MOVES the button to another cell (embedToggleMove.ts); when the
        // button's centre is over its own anchor cell -- as here, B5 -- the
        // pane's write is the only one, so the toggle DID put the button in its
        // cell (the run log has its update_cell(4,1)) and the probe below
        // waited 15 s for a property nobody had written.
        await invoke(page, "set_control_property", {
          sheetIndex: 0,
          row: made.row,
          col: made.col,
          controlType: "button",
          propertyName: "embedded",
          valueType: "static",
          value: "true",
        });
        await page.evaluate(
          ({ row, col }) =>
            window.dispatchEvent(new CustomEvent("controls:embedded-changed", { detail: { sheetIndex: 0, row, col, embedded: true } })),
          made,
        );
        // Where the toggle put it: the cell under the floating button's centre,
        // marked embedded AND carrying the button style flag the in-cell
        // interceptor and renderer read (Button/interceptors.ts, rendering.ts).
        const cell = await eventually(
          async () => {
            for (let r = made.row; r <= made.row + 2; r++) {
              for (let c = made.col; c <= made.col + 2; c++) {
                const p = await controlProps(page, 0, r, c);
                if (p?.embedded?.value === "true" && (await hasButtonStyle(page, r, c))) return { row: r, col: c };
              }
            }
            return null;
          },
          (c) => c !== null,
          "the toggle did not put the button in a cell",
          15_000,
        );
        const ref = rcToRef(cell!.row, cell!.col);
        log(`in-cell button at ${ref}`);
        await page.waitForTimeout(600);
        const centre = await cellClientCenter(grid, ref);
        const off = await cellClientCenter(grid, rcToRef(cell!.row, cell!.col + 3));
        const face = await facePatch(page, grid, ref, cell!.col);
        const ran = async () => ((await cellAt(page, 0, MARK.row, MARK.col))?.display ?? "") === marker;

        await grid.clickCell("A20");
        await page.mouse.move(off.x, off.y);
        await page.waitForTimeout(300);
        const released = await faceLuma(page, face);

        await pressSlideOffRelease(page, centre, off, async () => {
          // "Ran" first: a press that ACTS answers no claim, so it never looks
          // pressed either -- asked second, the look would mask the run
          // (sabotages 1 and 6, live 2026-10-02).
          const held = await faceLuma(page, face);
          expect(await ran(), "the in-cell button ran on the PRESS").toBe(false);
          expect(held, `a held in-cell button does not look pressed (released ${released.toFixed(1)}, held ${held.toFixed(1)})`).toBeLessThan(released - 8);
        });
        const slidOff = await faceLuma(page, face);
        expect(Math.abs(slidOff - released), `slid off, the in-cell button still looks pressed (released ${released.toFixed(1)}, now ${slidOff.toFixed(1)})`).toBeLessThan(4);
        expect(await ran(), "pressed on the in-cell button, slid off and released off it: it RAN").toBe(false);

        await page.mouse.click(centre.x, centre.y);
        await eventually(ran, (r) => r, "a click on the in-cell button (press and release on it) did not run it", 20_000);

        // Design Mode: a click selects the button's cell and runs nothing.
        await invoke(page, "update_cell", { row: MARK.row, col: MARK.col, value: "" });
        await setDesignMode(page, true);
        await page.mouse.click(centre.x, centre.y);
        await page.waitForTimeout(1200);
        expect(await ran(), "in Design Mode a click ran the in-cell button").toBe(false);
      });
    } finally {
      await setDesignMode(page, false).catch(() => undefined);
      await newFile(page);
    }
  });

  test("RA-5: a BUTTON CELL: held it looks pressed and has run nothing; slid off the release runs nothing; a click runs its command", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(180_000);
    const B = { row: 6, col: 3 };
    const ref = rcToRef(B.row, B.col);
    try {
      await newFile(page);
      await setDesignMode(page, false);
      // The user's OWN button cell running `cellTypes.clear`, which clears the
      // SELECTION's cell type -- the button's own, since its press selects it:
      // the observable that it ran.
      await callModule(page, CELL_TYPES, "setCellType", [
        B.row,
        B.col,
        "calcula.button",
        { label: "Clear me", action: { kind: "command", commandId: "cellTypes.clear" } },
      ]);
      await callModule(page, CELL_TYPES, "refreshCellTypeAssignments");
      await page.waitForTimeout(500);
      expect(await cellTypeAt(page, B.row, B.col), "precondition: the button cell exists").toBe("calcula.button");

      const centre = await cellClientCenter(grid, ref);
      const off = await cellClientCenter(grid, rcToRef(B.row, B.col + 3));
      const face = await facePatch(page, grid, ref, B.col);
      await grid.clickCell("A20");

      // The press SELECTS the button cell (the keyboard follows the press), so
      // the pressed look is compared with the same cell, still selected, after
      // the slide-off release -- never with a baseline taken while another cell
      // was selected.
      let held = NaN;
      await pressSlideOffRelease(page, centre, off, async () => {
        held = await faceLuma(page, face);
        expect(await cellTypeAt(page, B.row, B.col), "the button cell ran on the PRESS").toBe("calcula.button");
      });
      const slidOff = await faceLuma(page, face);
      expect(held, `a held button cell does not look pressed (held ${held.toFixed(1)}, after the slide-off release ${slidOff.toFixed(1)})`).toBeLessThan(slidOff - 8);
      expect(await cellTypeAt(page, B.row, B.col), "pressed on the button cell, slid off and released off it: it RAN").toBe("calcula.button");

      await page.mouse.click(centre.x, centre.y);
      await eventually(
        () => cellTypeAt(page, B.row, B.col),
        (t) => t !== "calcula.button",
        "a click on the button cell (press and release on it) did not run its command",
        20_000,
      );
    } finally {
      await newFile(page);
    }
  });
});

// ===========================================================================
// RA-6, RA-7: checkboxes in cells (owner question 26)
// ===========================================================================

interface SelectionBox {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

async function gridSelectionBox(page: Page): Promise<SelectionBox | null> {
  return page.evaluate(() => {
    const s = (window as unknown as AppWindow).__CALCULA_GRID_STATE__?.selection;
    return s ? { startRow: s.startRow, startCol: s.startCol, endRow: s.endRow, endCol: s.endCol } : null;
  });
}

/** The display of a cell of Sheet1, upper-cased ("" when empty). */
async function displayAt(page: Page, row: number, col: number): Promise<string> {
  return ((await cellAt(page, 0, row, col))?.display ?? "").toUpperCase();
}

/** Does the cell carry the LEGACY checkbox style flag (the Checkbox extension's kind)? */
async function isLegacyCheckbox(page: Page, row: number, col: number): Promise<boolean> {
  const cell = await invoke<{ styleIndex?: number } | null>(page, "get_cell", { row, col });
  const style = await invoke<{ checkbox?: boolean } | null>(page, "get_style", { index: cell?.styleIndex ?? 0 });
  return style?.checkbox === true;
}

/**
 * The checkbox at (row, col), holding FALSE: a press toggles nothing and
 * selects its cell; pressed, slid off and released off it, nothing toggles and
 * the selection is still that ONE cell (a press Core had not handed to the
 * checkbox would have drag-selected to the release cell); a click toggles it,
 * once.
 */
async function checkboxActsOnRelease(page: Page, grid: GridHelper, row: number, col: number, what: string): Promise<void> {
  const centre = await cellClientCenter(grid, rcToRef(row, col));
  const off = await cellClientCenter(grid, rcToRef(row, col + 3));
  const own: SelectionBox = { startRow: row, startCol: col, endRow: row, endCol: col };
  await grid.clickCell("A20");
  expect(await displayAt(page, row, col), `precondition: the ${what} holds FALSE`).toBe("FALSE");

  await pressSlideOffRelease(page, centre, off, async () => {
    expect(await displayAt(page, row, col), `the ${what} toggled on the PRESS`).toBe("FALSE");
    expect(await gridSelectionBox(page), `a press on the ${what} did not select its cell`).toEqual(own);
  });
  expect(await displayAt(page, row, col), `pressed on the ${what}, slid off and released off it: it TOGGLED`).toBe("FALSE");
  expect(
    await gridSelectionBox(page),
    `pressed on the ${what} and slid off: the selection moved off its one cell (Core drag-selected: the press was not the checkbox's)`,
  ).toEqual(own);

  await page.mouse.click(centre.x, centre.y);
  await eventually(() => displayAt(page, row, col), (v) => v === "TRUE", `a click on the ${what} (press and release on it) did not toggle it`, 15_000);
  await page.waitForTimeout(SETTLE_MS);
  expect(await displayAt(page, row, col), `one click on the ${what} toggled it more than once`).toBe("TRUE");
}

test.describe("a checkbox in a cell toggles on RELEASE on its cell, and sliding off cancels", () => {
  test("RA-6: a CHECKBOX CELL (Cell Type: Checkbox): a press toggles nothing and selects it; slid off, nothing toggles; a click toggles it once", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(180_000);
    const C = { row: 8, col: 2 };
    try {
      await newFile(page);
      await invoke(page, "update_cell", { row: C.row, col: C.col, value: "FALSE" });
      await callModule(page, CELL_TYPES, "setCellType", [C.row, C.col, "calcula.checkbox", {}]);
      await callModule(page, CELL_TYPES, "refreshCellTypeAssignments");
      await page.waitForTimeout(500);
      expect(await cellTypeAt(page, C.row, C.col), "precondition: the checkbox cell exists").toBe("calcula.checkbox");
      await checkboxActsOnRelease(page, grid, C.row, C.col, "checkbox cell");
    } finally {
      await newFile(page);
    }
  });

  test("RA-7: a LEGACY style-flag checkbox (the Checkbox extension): a press toggles nothing and selects it; slid off, nothing toggles; a click toggles it once", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(180_000);
    const L = { row: 10, col: 2 };
    try {
      await newFile(page);
      await invoke(page, "update_cell", { row: L.row, col: L.col, value: "FALSE" });
      await invoke(page, "apply_formatting", { params: { rows: [L.row], cols: [L.col], checkbox: true } });
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
      await page.waitForTimeout(500);
      expect(await isLegacyCheckbox(page, L.row, L.col), "precondition: the cell carries the checkbox style flag").toBe(true);
      await checkboxActsOnRelease(page, grid, L.row, L.col, "legacy checkbox");
    } finally {
      await newFile(page);
    }
  });
});

// ===========================================================================
// RA-8: a worksheet pivot's +/- double-click toggles ONCE (owner question 27)
// ===========================================================================

test.describe("a double-click on a worksheet pivot's +/- toggles it once, as on the canvas box", () => {
  test("RA-8: a double-click on a '-' collapses the group and it STAYS collapsed; a double-click on its '+' expands it and it stays expanded", async ({
    appPage: page,
  }) => {
    test.setTimeout(180_000);
    try {
      await newFile(page);
      const pid = await pivotOnSheet1(page, {
        rowFields: [
          { sourceIndex: 0, name: "Region" },
          { sourceIndex: 1, name: "Product" },
        ],
      });
      const viewRows = () => pivotView(page, pid).then((v) => v.rows.length);
      const rowsBefore = await viewRows();
      const minus = await eventually(() => chromePoint(page, pid, "icon", true), (p) => p !== null, "the pivot painted no '-' on a row header", 15_000);
      log(`'-' at ${JSON.stringify(minus)}; ${rowsBefore} view rows`);

      await page.mouse.dblclick(minus!.x, minus!.y);
      await eventually(viewRows, (n) => n < rowsBefore, "a double-click on the '-' did not collapse the group", 15_000);
      // A second toggle (the double-click's second release) would expand it again a moment later.
      await page.waitForTimeout(1_500);
      expect(await viewRows(), "a double-click on the '-' toggled it TWICE (collapsed, then expanded back)").toBeLessThan(rowsBefore);

      const plus = await eventually(() => chromePoint(page, pid, "icon", false), (p) => p !== null, "the collapsed group painted no '+'", 15_000);
      log(`'+' at ${JSON.stringify(plus)}`);
      await page.mouse.dblclick(plus!.x, plus!.y);
      await eventually(viewRows, (n) => n === rowsBefore, "a double-click on the '+' did not expand the group", 15_000);
      await page.waitForTimeout(1_500);
      expect(await viewRows(), "a double-click on the '+' toggled it TWICE (expanded, then collapsed back)").toBe(rowsBefore);
    } finally {
      await newFile(page);
    }
  });
});
