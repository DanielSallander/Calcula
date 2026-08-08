/**
 * SHAPES FROM A SCRIPT, AND THE HOME-TAB CUSTOMIZE ENTRY POINT — proved live.
 *
 * Two items shipped on 2026-08-07 and were verified only by unit tests:
 *
 *   (1a) `@api/controlsService` + `api.createShape` / `api.deleteShape`, with
 *        ONE shape recipe shared by the ribbon gallery and the script seam, an
 *        anchor-collision refusal, and the unconditional instance-keyed teardown
 *        that stopped a deleted control's object script being inherited by the
 *        next control at the same anchor.
 *   (2a) The View ▸ "Customize Home Tab..." entry point, with "Row Break"
 *        placeable again and "Reset to Default" made pure so Cancel really
 *        cancels.
 *
 * Everything below is driven through the PRODUCT: real macros run from the real
 * Macro Library, the real Insert ▸ Shapes gallery, the real View menu, the real
 * dialog, and the real File open/new path. The decisive assertions are made on
 * the RENDERED result — canvas pixels for a shape, the ribbon's own laid-out
 * button geometry for the Home tab — never only on what the backend says.
 *
 * WHY THIS IS A JOURNEY. Test 6 saves the document, wipes it with `newFile` and
 * reopens it, and test 8 reloads the frontend. The functional specs share one
 * accumulating workbook and one set of screenshot baselines, so a spec that
 * replaces the document or the ribbon layout shifts unrelated goldens.
 *
 * THE PROBES, AND WHY THEY HAVE TEETH
 *
 *   "did the shape PAINT?"      -> a canvas patch inset into the shape's own
 *                                  box, sampled through the app's LIVE geometry
 *                                  (`readGridGeometry`), asserted in BOTH
 *                                  directions: 0 before the create, 1 after,
 *                                  0 after the delete. A one-directional
 *                                  refusal assertion is worthless.
 *   "did the document gain a
 *    control?"                  -> `get_control_metadata` at the anchor, plus
 *                                  `get_all_controls` for the whole sheet, so
 *                                  "created somewhere else" is not mistaken for
 *                                  "not created".
 *   "did the macro fail?"       -> the Macro Library's own `[data-macro-error]`
 *                                  / `[data-macro-output]` panes. A run that
 *                                  neither errored nor printed `[OK]` is a
 *                                  hang, and the helper says so.
 *   "did the ribbon change?"    -> the distinct `getBoundingClientRect().top`
 *                                  values of a group's rendered buttons. That
 *                                  is what a row break MEANS on screen, and it
 *                                  cannot be satisfied by a stored setting.
 *
 * SHARED APP. This spec's private patch is columns BF..BL (57..63), rows 40-80
 * (0-based) — a fresh area; K, L, N, P, R, T-Z, AA-AD and AW-BD belong to other
 * specs. Every control it creates is removed in a `finally`, and the Home-tab
 * layout key is cleared and the page reloaded in test 8's `finally` so the
 * ribbon goes back to the default the visual goldens encode.
 *
 * LOCALE. sv-SE. No formula is typed anywhere here, so the ';' separator never
 * comes up.
 */
import type { Page } from "@playwright/test";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "../fixtures";
import { readGridGeometry } from "../helpers/grid";

const NAME_PREFIX = "E2EShapesHomeTab";
const ID_PREFIX = "macro-e2eshape-";

/** The private patch: columns BF..BL, rows 41..81 (1-based). */
const PATCH = { startRow: 39, startCol: 57, endRow: 81, endCol: 63 };

/** Anchors, spaced 6 rows apart: a rectangle is 80px = four default rows tall,
 *  so closer anchors would let one shape's box cover the next one's probe. */
const A_RENDER = { row: 40, col: 57 };      // test 1
const A_MENU = { row: 46, col: 57 };        // test 2, gallery path
const A_SCRIPT = { row: 46, col: 60 };      // test 2, script path
const A_BAD = { row: 52, col: 57 };         // test 3
const A_COLLIDE = { row: 58, col: 57 };     // test 4
const A_BUTTON = { row: 64, col: 57 };      // test 5
const A_KEEP = { row: 70, col: 57 };        // test 6, saved document
const A_DECOY = { row: 70, col: 60 };       // test 6, the OTHER workbook

const SAVED_DOC = path.join(os.tmpdir(), "calcula-shapes-hometab.cala");

/** localStorage key the Home-tab layout persists under (homeTabConfig.ts). */
const HOME_LAYOUT_KEY = "calcula.homeTab.layout";

/** The ribbon's Home sections, in the order the owner's constraint pins. */
const DEFAULT_SECTION_LABELS = [
  "Clipboard", "Font", "Alignment", "Number", "Styles", "Cells", "Editing",
];

// ---------------------------------------------------------------------------
// Cell references
// ---------------------------------------------------------------------------

function colName(col: number): string {
  let n = col + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function refOf(row: number, col: number): string {
  return `${colName(col)}${row + 1}`;
}

// ---------------------------------------------------------------------------
// Backend readers/writers — setup and assertions, never the thing under test.
// ---------------------------------------------------------------------------

async function invoke<T = unknown>(page: Page, cmd: string, args: unknown = {}): Promise<T> {
  return page.evaluate(
    async ({ c, a }) => {
      const tauri = (window as any).__TAURI__;
      return tauri.core.invoke(c, a);
    },
    { c: cmd, a: args },
  ) as Promise<T>;
}

interface ControlProperty {
  valueType: string;
  value: string;
}
interface ControlMetadata {
  controlType: string;
  properties: Record<string, ControlProperty>;
}

async function controlMeta(
  page: Page,
  row: number,
  col: number,
  sheetIndex = 0,
): Promise<ControlMetadata | null> {
  return invoke<ControlMetadata | null>(page, "get_control_metadata", { sheetIndex, row, col });
}

/** Every control on a sheet, as `[row, col, controlType]` triples. */
async function allControls(
  page: Page,
  sheetIndex = 0,
): Promise<Array<{ row: number; col: number; controlType: string }>> {
  const raw = await invoke<unknown>(page, "get_all_controls", { sheetIndex });
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const e = entry as Record<string, unknown>;
    const meta = (e.metadata ?? e) as Record<string, unknown>;
    return {
      row: Number(e.row ?? -1),
      col: Number(e.col ?? -1),
      controlType: String(meta.controlType ?? ""),
    };
  });
}

async function activeSheetIndex(page: Page): Promise<number> {
  const sheets = await invoke<{ activeIndex: number }>(page, "get_sheets");
  return sheets.activeIndex;
}

async function allowScripts(page: Page): Promise<void> {
  await invoke(page, "set_script_security_level", { level: "enabled" });
}

/**
 * Put the FRONTEND view flags back to normal before anything is measured.
 *
 * This is not defensive padding — it is repair. `dirty-flag.spec.ts` runs
 * earlier in this project and restores the view flags with
 * `set_sheet_display_flags`, which writes the BACKEND only: the renderer reads
 * Core state, which is fed by `DISPLAY_*_TOGGLED` events, and neither that
 * command nor the `new_file` that follows re-syncs it. So the rest of the
 * journey run renders with the row/column headings switched OFF while the
 * backend reports them ON — and a control clicked at its painted position on
 * that canvas is not selected at all (measured, not inferred; the cause was not
 * chased further here because it belongs to the headings feature, not to this
 * one). Anything that clicks or samples the grid has to normalise first.
 */
async function normalizeViewState(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api: any = await (window as any).__calcImport(
      new URL("/src/api/index.ts", document.baseURI).href,
    );
    api.emitAppEvent(api.AppEvents.DISPLAY_HEADINGS_TOGGLED, { displayHeadings: true });
    api.emitAppEvent(api.AppEvents.DISPLAY_GRIDLINES_TOGGLED, { displayGridlines: true });
    const grid: any = await (window as any).__calcImport(
      new URL("/src/api/grid.ts", document.baseURI).href,
    );
    try { grid.setZoomLevel(100); } catch { /* not available */ }
    try { grid.changeViewMode("normal"); } catch { /* not available */ }
  });
  await page.waitForTimeout(400);
}

/**
 * Clear this spec's private patch and remove every control inside it.
 *
 * Deletion goes through the CONTROLS PROVIDER, not through
 * `remove_control_metadata`. A raw backend removal leaves the frontend's
 * floating store holding the entry, so the control keeps PAINTING — and the
 * store is only swapped when the sheet actually changes (the reloader
 * short-circuits on `nextSheet === loadedSheetIndex`), so re-emitting
 * SHEET_CHANGED for the current sheet does nothing. A phantom shape left over
 * from one test poisons the next test's pixel probe.
 */
async function clearPatch(page: Page): Promise<void> {
  const sheetIndex = await activeSheetIndex(page).catch(() => 0);
  const controls = await allControls(page, sheetIndex).catch(() => []);
  for (const c of controls) {
    if (
      c.row >= PATCH.startRow && c.row <= PATCH.endRow &&
      c.col >= PATCH.startCol && c.col <= PATCH.endCol
    ) {
      const instanceId = `control-${sheetIndex}-${c.row}-${c.col}`;
      await page
        .evaluate(async (id) => {
          const cs: any = await (window as any).__calcImport(
            new URL("/src/api/controlsService.ts", document.baseURI).href,
          );
          const provider = cs.getControlsProvider();
          if (provider) await provider.deleteControl(id);
        }, instanceId)
        .catch(() => {});
      await invoke(page, "remove_control_metadata", {
        sheetIndex,
        row: c.row,
        col: c.col,
      }).catch(() => {});
      await invoke(page, "delete_object_scripts_for_instance", { instanceId }).catch(() => {});
    }
  }
  await invoke(page, "clear_range_with_options", {
    params: {
      startRow: PATCH.startRow,
      startCol: PATCH.startCol,
      endRow: PATCH.endRow,
      endCol: PATCH.endCol,
      applyTo: "all",
    },
  }).catch(() => {});
  // The floating store and the overlay regions live in the frontend; a backend
  // removal alone leaves a phantom painting until the sheet is reloaded.
  await page.evaluate(async () => {
    const api: any = await (window as any).__calcImport(
      new URL("/src/api/index.ts", document.baseURI).href,
    );
    const tauri = (window as any).__TAURI__;
    const sheets: any = await tauri.core.invoke("get_sheets");
    const active = sheets.sheets.find((s: any) => s.index === sheets.activeIndex);
    api.emitAppEvent(api.AppEvents.SHEET_CHANGED, {
      sheetIndex: sheets.activeIndex,
      sheetName: active?.name ?? "",
    });
    window.dispatchEvent(new Event("grid:refresh"));
  }).catch(() => {});
  await page.waitForTimeout(400);
}

// ---------------------------------------------------------------------------
// Macros — seeded into the module store, RUN from the real Macro Library
// ---------------------------------------------------------------------------

/** The recorded-macro shape: one worker function plus `setup`. */
function macroSource(name: string, body: string): string {
  return (
    `// Macro: ${name}\n` +
    `// Target runtime: object script (unlocked)\n` +
    `async function work(api) {\n` +
    body +
    `}\n` +
    `\n` +
    `function setup(context) {\n` +
    `  if (!context.api) {\n` +
    `    context.notify("needs an UNLOCKED script", "error");\n` +
    `    return;\n` +
    `  }\n` +
    `  return work(context.api);\n` +
    `}\n`
  );
}

async function seedMacro(
  page: Page,
  opts: { id: string; name: string; body: string },
): Promise<void> {
  const description =
    `Recorded macro · runtime=objectScript · 1 action · recorded ${new Date().toISOString()}`;
  await page.evaluate(
    async ({ id, name, description, source }) => {
      const tauri = (window as any).__TAURI__;
      await tauri.core.invoke("save_script", {
        script: { id, name, description, source, scope: { type: "workbook" } },
      });
    },
    { id: opts.id, name: opts.name, description, source: macroSource(opts.name, opts.body) },
  );
}

async function openMacroLibrary(page: Page, grid: any) {
  await grid.openMenu("Developer");
  const item = page.locator("button").filter({ hasText: /^Macros/ }).first();
  await item.waitFor({ state: "visible", timeout: 5_000 });
  await item.click();
  const library = page.locator("[data-macro-library-dialog]");
  await expect(library).toBeVisible({ timeout: 10_000 });
  return library;
}

async function closeMacroLibrary(page: Page) {
  const library = page.locator("[data-macro-library-dialog]");
  if ((await library.count()) === 0) return;
  await library.locator("button").filter({ hasText: /^Close$/ }).first().click();
  await expect(library).toBeHidden({ timeout: 10_000 });
}

interface MacroRun {
  /** The `[data-macro-error]` text, or "" when the run succeeded. */
  error: string;
  /** The `[data-macro-output]` text, or "" when the run failed. */
  output: string;
}

/**
 * Run one seeded macro through the REAL Macro Library and report what the
 * dialog told the user.
 *
 * The dialog is the product's own oracle: a successful run prints `[OK] ...`
 * into `[data-macro-output]`, a failed one puts the message in
 * `[data-macro-error]`. Polling for EITHER (rather than for the effect) is what
 * makes a refusal test assert the refusal instead of a timeout.
 */
async function runMacro(page: Page, grid: any, macroName: string): Promise<MacroRun> {
  const library = await openMacroLibrary(page, grid);
  const row = library.locator("[data-macro-library-item]").filter({ hasText: macroName });
  await expect(row, `the macro "${macroName}" is in the library`).toHaveCount(1);
  await row.click();
  const runBtn = library.locator("[data-macro-run-button]");
  await expect(runBtn).toBeEnabled({ timeout: 10_000 });
  await runBtn.click();

  // Read the two panes with a DOM snapshot rather than `locator.innerText()`:
  // an absent locator has NO action timeout configured in this project, so
  // `innerText()` on the pane that has not appeared yet waits FOREVER and the
  // whole poll — and the test — hangs instead of reporting the other pane.
  const readPanes = (): Promise<{ error: string; output: string }> =>
    page.evaluate(() => {
      const dialog = document.querySelector("[data-macro-library-dialog]");
      const text = (sel: string) =>
        (dialog?.querySelector(sel) as HTMLElement | null)?.innerText ?? "";
      return { error: text("[data-macro-error]"), output: text("[data-macro-output]") };
    });

  let result: MacroRun | null = null;
  for (let i = 0; i < 240; i++) {
    const { error, output } = await readPanes();
    if (error) {
      result = { error, output };
      break;
    }
    if (output.includes("[OK]")) {
      result = { error: "", output };
      break;
    }
    await page.waitForTimeout(250);
  }
  await closeMacroLibrary(page);
  if (!result) {
    throw new Error(
      `"${macroName}" neither errored nor printed [OK] within 60s — the run never finished.`,
    );
  }
  return result;
}

/** Remove every macro this spec seeded. Idempotent. */
async function cleanupMacros(page: Page): Promise<void> {
  await page.evaluate(
    async ({ prefix, idPrefix }) => {
      const tauri = (window as any).__TAURI__;
      try {
        const modules: Array<{ id: string; name: string }> =
          await tauri.core.invoke("list_scripts");
        for (const m of modules) {
          if ((m.name && m.name.startsWith(prefix)) || (m.id && m.id.startsWith(idPrefix))) {
            await tauri.core.invoke("delete_script", { id: m.id }).catch(() => {});
          }
        }
      } catch {
        /* no module store */
      }
    },
    { prefix: NAME_PREFIX, idPrefix: ID_PREFIX },
  );
}

// ---------------------------------------------------------------------------
// Navigation and the canvas pixel probe
// ---------------------------------------------------------------------------

/**
 * Put an anchor cell into view with ROOM BELOW AND RIGHT of it, and select it.
 *
 * The naive `navigateTo(anchor)` scrolls the anchor to the BOTTOM edge of the
 * viewport, where a 120x80 shape is clipped by the canvas and a pixel probe
 * reports 12% painted for a shape that is perfectly fine. Navigating first to a
 * cell 12 rows down and 4 columns right pushes the anchor into the body of the
 * viewport; the second navigation then only moves the SELECTION, because the
 * anchor is already visible.
 */
async function bringAnchorIntoView(grid: any, row: number, col: number): Promise<void> {
  await grid.navigateTo(refOf(row + 12, col + 4));
  await grid.navigateTo(refOf(row, col));
}

type Pixel = [number, number, number];

/**
 * The anchor cell's top-left corner in CANVAS CSS pixels, from LIVE geometry:
 * per-column widths, hidden lines, the scroll offset, the zoom factor — and
 * whether the ROW/COLUMN HEADINGS are being drawn at all.
 *
 * That last one is not hypothetical and it is not this spec's own doing: the
 * headings are a persisted per-sheet view flag, so a document another journey
 * spec saved with `displayHeadings: false` and this suite later reopens brings
 * them back switched off. `gs.config` keeps reporting 22/20 when that happens —
 * the renderer substitutes 0/0 itself (`gridRenderer/core.ts`) — so a probe that
 * trusts the config samples 22px left and 20px above the truth and reports ~0.80
 * for a shape that is painted perfectly. Same rule as the renderer, read from
 * the same live state.
 */
async function anchorOrigin(
  page: Page,
  row: number,
  col: number,
): Promise<{ x: number; y: number; zoom: number }> {
  const geo = await readGridGeometry(page);
  const headingsShown = await page.evaluate(
    () => (window as any).__CALCULA_GRID_STATE__?.displayHeadings !== false,
  );
  const rowHeaderWidth = headingsShown ? geo.rowHeaderWidth : 0;
  const colHeaderHeight = headingsShown ? geo.colHeaderHeight : 0;
  const hiddenCols = new Set(geo.hiddenCols);
  const hiddenRows = new Set(geo.hiddenRows);
  let xOffset = 0;
  for (let c = 0; c < col; c++) {
    xOffset += hiddenCols.has(c) ? 0 : geo.columnWidths[c] ?? geo.defaultCellWidth;
  }
  let yOffset = 0;
  for (let r = 0; r < row; r++) {
    yOffset += hiddenRows.has(r) ? 0 : geo.rowHeights[r] ?? geo.defaultCellHeight;
  }
  return {
    x: (rowHeaderWidth + xOffset - geo.scrollX) * geo.zoom,
    y: (colHeaderHeight + yOffset - geo.scrollY) * geo.zoom,
    zoom: geo.zoom,
  };
}

async function samplePatch(
  page: Page,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<Pixel[]> {
  return page.evaluate(
    ({ x, y, w, h }) => {
      const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
      if (!canvas) throw new Error("grid canvas not found");
      const rect = canvas.getBoundingClientRect();
      const scale = canvas.width / rect.width;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      const img = ctx.getImageData(
        Math.max(0, Math.round(x * scale)),
        Math.max(0, Math.round(y * scale)),
        Math.max(1, Math.round(w * scale)),
        Math.max(1, Math.round(h * scale)),
      );
      const out: Array<[number, number, number]> = [];
      for (let i = 0; i < img.data.length; i += 4) {
        out.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
      }
      return out;
    },
    { x, y, w, h },
  );
}

/** The default shape fill, #4472C4 — what `createShapeControlAt` writes. */
const isShapeFill = ([r, g, b]: Pixel): boolean => r >= 50 && r <= 90 && g >= 95 && g <= 135 && b >= 175 && b <= 215;

function fraction(px: Pixel[], pred: (p: Pixel) => boolean): number {
  return px.length === 0 ? 0 : px.filter(pred).length / px.length;
}

/**
 * The fraction of a patch inside the shape's box that carries the shape's fill.
 *
 * The patch is a 100x14 band across the TOP of a rectangle's 120x80 body,
 * inset 8px so the 1px stroke and the selection chrome are outside it, and
 * ABOVE the caption: `textAlign: center` with the text vertically centred means
 * a patch through the middle is part white glyphs, which scores a perfectly
 * painted shape at ~0.90 and would have to be met by loosening the threshold —
 * i.e. by making the probe blinder rather than better aimed.
 */
async function shapeFillFraction(page: Page, row: number, col: number): Promise<number> {
  const origin = await anchorOrigin(page, row, col);
  const z = origin.zoom;
  return fraction(
    await samplePatch(page, origin.x + 8 * z, origin.y + 5 * z, 100 * z, 14 * z),
    isShapeFill,
  );
}

/** Poll until the shape has painted (creation, store sync and repaint are async). */
async function waitForShapePainted(page: Page, row: number, col: number): Promise<number> {
  let best = 0;
  for (let i = 0; i < 25; i++) {
    best = Math.max(best, await shapeFillFraction(page, row, col));
    if (best > 0.95) return best;
    await page.waitForTimeout(300);
  }
  return best;
}

/** Poll until the shape has stopped painting. */
async function waitForShapeGone(page: Page, row: number, col: number): Promise<number> {
  let worst = 1;
  for (let i = 0; i < 25; i++) {
    worst = Math.min(worst, await shapeFillFraction(page, row, col));
    if (worst < 0.02) return worst;
    await page.waitForTimeout(300);
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Document lifecycle, through the app's OWN file API (what the File menu calls)
// ---------------------------------------------------------------------------

async function fileApi<T>(page: Page, fn: string, arg?: string): Promise<T> {
  return page.evaluate(
    async ({ fn, arg }) => {
      const mod = await (window as unknown as {
        __calcImport: (u: string) => Promise<Record<string, (a?: unknown) => Promise<unknown>>>;
      }).__calcImport(new URL("/src/core/lib/file-api.ts", document.baseURI).href);
      return (await mod[fn](arg)) as unknown;
    },
    { fn, arg },
  ) as Promise<T>;
}

const newDocument = (page: Page) => fileApi<void>(page, "newFile");
const openDocument = (page: Page, file: string) => fileApi<unknown>(page, "openFileAtPath", file);

async function saveDocument(page: Page, file: string): Promise<void> {
  await invoke(page, "save_file", { path: file });
  await page.waitForTimeout(500);
}

// ---------------------------------------------------------------------------
// The ribbon — the RENDERED Home tab
// ---------------------------------------------------------------------------

interface RibbonSection {
  label: string;
  /** Number of distinct rendered rows the group's buttons occupy. */
  rows: number;
  /** `data-testid` of every rendered item, in DOM order. */
  itemIds: string[];
}

/**
 * Read the Home tab as it is LAID OUT, not as it is configured.
 *
 * A row break's whole meaning is "start a new band row here", so the oracle is
 * the number of distinct `top` coordinates the group's buttons occupy. Nothing
 * about a stored layout can satisfy that: the ribbon has to have re-rendered.
 */
async function readRibbonSections(page: Page): Promise<RibbonSection[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-section-cell]")).map((cell) => {
      const label = cell.lastElementChild?.textContent?.trim() ?? "";
      const buttons = Array.from(cell.querySelectorAll("[data-testid^='fmt-']"));
      const tops = [
        ...new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))),
      ];
      return {
        label,
        rows: tops.length,
        itemIds: buttons.map((b) => b.getAttribute("data-testid") ?? ""),
      };
    }),
  );
}

/**
 * Wait until the HOME panel's sections are the ones on screen.
 *
 * Panels register one at a time, so for a moment after a frontend reload the
 * band holds only whichever tab registered first — Page Layout's "Themes" is
 * what a too-early read actually saw. Polling for the Home tab's own sections
 * is the difference between measuring the ribbon and measuring the race.
 */
async function waitForHomeRibbon(page: Page): Promise<RibbonSection[]> {
  let last: RibbonSection[] = [];
  for (let i = 0; i < 60; i++) {
    last = await readRibbonSections(page);
    if (last.some((s) => s.label === "Cells") && last.some((s) => s.label === "Clipboard")) {
      return last;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    `the Home tab never rendered its sections (saw: ${last.map((s) => s.label).join(", ")})`,
  );
}

async function sectionRows(page: Page, label: string): Promise<number> {
  const sections = await waitForHomeRibbon(page);
  const found = sections.find((s) => s.label === label);
  if (!found) {
    throw new Error(
      `no ribbon section labelled "${label}" (saw: ${sections.map((s) => s.label).join(", ")})`,
    );
  }
  return found.rows;
}

/** Wipe the persisted Home-tab layout and reload, so the ribbon is the default
 *  every visual golden encodes. */
async function restoreDefaultHomeLayout(page: Page): Promise<void> {
  await page.evaluate((key) => {
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  }, HOME_LAYOUT_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-focus-container='spreadsheet']", {
    state: "visible",
    timeout: 90_000,
  });
  await page.waitForTimeout(1_500);
}

async function openCustomizeDialog(page: Page, grid: any) {
  await grid.openMenu("View");
  const item = page.locator("button").filter({ hasText: /Customize Home Tab/ }).first();
  await item.waitFor({ state: "visible", timeout: 5_000 });
  await item.click();
  const dialog = page.locator("[data-hometab-customize-dialog]");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  return dialog;
}

// ===========================================================================

test.describe("Shapes from a script + the Home-tab Customize entry point", () => {
  // =========================================================================
  // 1 — a script creates a shape and it RENDERS; deleting it removes it from
  //     the canvas AND from the backend
  // =========================================================================

  test("1. api.createShape paints a real shape (pinToGrid \"false\", caption in `text`), api.deleteShape removes it from canvas and backend", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(300_000);

    const stamp = Date.now().toString(36);
    const makeName = `${NAME_PREFIX} make ${stamp}`;
    const makeId = `${ID_PREFIX}make-${stamp}`;
    const killName = `${NAME_PREFIX} kill ${stamp}`;
    const killId = `${ID_PREFIX}kill-${stamp}`;
    const idCell = refOf(A_RENDER.row, 63);

    await allowScripts(page);
    await normalizeViewState(page);
    await clearPatch(page);

    try {
      const sheet = await activeSheetIndex(page);
      await bringAnchorIntoView(grid, A_RENDER.row, A_RENDER.col);

      // TEETH: nothing is painted at this anchor yet, so "1.0 after create" is
      // a real transition rather than a probe that samples something blue.
      const before = await shapeFillFraction(page, A_RENDER.row, A_RENDER.col);
      expect(before, "the anchor is empty before the macro runs").toBeLessThan(0.02);
      expect(await controlMeta(page, A_RENDER.row, A_RENDER.col, sheet)).toBeNull();

      await seedMacro(page, {
        id: makeId,
        name: makeName,
        body:
          `  const h = await api.createShape("rectangle", ` +
          `{ row: ${A_RENDER.row}, col: ${A_RENDER.col} }, ` +
          `{ width: 120, height: 80, text: "MADE-BY-SCRIPT" });\n` +
          // api.range() is ASYNC (it resolves the sheet first) — the range has
          // to be awaited before it has any methods.
          `  const out = await api.range("${idCell}");\n` +
          `  await out.setValue(h.instanceId);\n`,
      });

      const run = await runMacro(page, grid, makeName);
      expect(run.error, "the create macro ran cleanly").toBe("");

      await bringAnchorIntoView(grid, A_RENDER.row, A_RENDER.col);
      const painted = await waitForShapePainted(page, A_RENDER.row, A_RENDER.col);
      expect(painted, "the shape is PAINTED on the grid canvas").toBeGreaterThan(0.95);

      // The handle the script got back names a control that really exists.
      const reportedId = await invoke<{ display?: string; value?: unknown }>(page, "get_cell", {
        row: A_RENDER.row,
        col: 63,
      });
      const instanceId = String(reportedId?.display ?? reportedId?.value ?? "");
      expect(instanceId, "the handle carries the control's instance id").toBe(
        `control-${sheet}-${A_RENDER.row}-${A_RENDER.col}`,
      );

      const meta = await controlMeta(page, A_RENDER.row, A_RENDER.col, sheet);
      expect(meta, "the backend holds a control at the anchor").not.toBeNull();
      expect(meta!.controlType).toBe("shape");

      // The three load-bearing keys of the recipe, read out of the BACKEND.
      expect(
        meta!.properties.pinToGrid?.value,
        'pinToGrid is written EXPLICITLY as "false" — an absent property makes ' +
          "the backend default it to `moves with cells` and diverge on the first row insert",
      ).toBe("false");
      expect(
        meta!.properties.text?.value,
        "the caption lives in `text` — writing `label` succeeds and draws nothing",
      ).toBe("MADE-BY-SCRIPT");
      expect(
        Object.keys(meta!.properties),
        "no `label` property exists anywhere on the control",
      ).not.toContain("label");

      // ---- delete, through the same script door -------------------------
      await seedMacro(page, {
        id: killId,
        name: killName,
        body:
          // The id the CREATE handle reported, round-tripped through the grid
          // and back into the delete call — no caller re-derives the
          // `control-{sheet}-{row}-{col}` format.
          `  await api.deleteShape(${JSON.stringify(instanceId)});\n`,
      });

      const killRun = await runMacro(page, grid, killName);
      expect(killRun.error, "the delete macro ran cleanly").toBe("");

      await bringAnchorIntoView(grid, A_RENDER.row, A_RENDER.col);
      const gone = await waitForShapeGone(page, A_RENDER.row, A_RENDER.col);
      expect(gone, "the shape no longer paints").toBeLessThan(0.02);
      expect(
        await controlMeta(page, A_RENDER.row, A_RENDER.col, sheet),
        "the backend no longer holds a control at the anchor",
      ).toBeNull();
    } finally {
      await closeMacroLibrary(page).catch(() => {});
      await cleanupMacros(page).catch(() => {});
      await clearPatch(page).catch(() => {});
    }
  });

  // =========================================================================
  // 2 — one recipe, two callers: the gallery and the script agree key for key
  // =========================================================================

  test("2. a shape from the real Insert > Shapes gallery and a shape from api.createShape carry the SAME property set", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(300_000);

    const stamp = Date.now().toString(36);
    const scriptName = `${NAME_PREFIX} recipe ${stamp}`;
    const scriptId = `${ID_PREFIX}recipe-${stamp}`;

    await allowScripts(page);
    await normalizeViewState(page);
    await clearPatch(page);

    try {
      const sheet = await activeSheetIndex(page);

      // ---- (a) the RIBBON path: Insert > Shapes > Rectangle --------------
      await bringAnchorIntoView(grid, A_MENU.row, A_MENU.col);
      await grid.openMenu("Insert");
      const shapesItem = page.locator("button").filter({ hasText: /^Shapes/ }).first();
      await shapesItem.waitFor({ state: "visible", timeout: 5_000 });
      await shapesItem.hover();
      const rectangle = page.locator("[title='Rectangle']").first();
      await expect(rectangle, "the shape gallery opened").toBeVisible({ timeout: 10_000 });
      await rectangle.click();
      await page.waitForTimeout(800);
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(80);
      }

      const menuMeta = await controlMeta(page, A_MENU.row, A_MENU.col, sheet);
      expect(menuMeta, "the gallery placed a control at the selected cell").not.toBeNull();
      expect(menuMeta!.controlType).toBe("shape");

      // ---- (b) the SCRIPT path -------------------------------------------
      await seedMacro(page, {
        id: scriptId,
        name: scriptName,
        body:
          `  await api.createShape("rectangle", ` +
          `{ row: ${A_SCRIPT.row}, col: ${A_SCRIPT.col} });\n`,
      });
      const run = await runMacro(page, grid, scriptName);
      expect(run.error, "the script placed its shape cleanly").toBe("");

      const scriptMeta = await controlMeta(page, A_SCRIPT.row, A_SCRIPT.col, sheet);
      expect(scriptMeta, "the script placed a control at its anchor").not.toBeNull();

      // ---- (c) the drift this seam exists to prevent ----------------------
      const menuKeys = Object.keys(menuMeta!.properties).sort();
      const scriptKeys = Object.keys(scriptMeta!.properties).sort();
      expect(
        scriptKeys,
        `the two callers write the SAME property keys. gallery=${JSON.stringify(menuKeys)} ` +
          `script=${JSON.stringify(scriptKeys)}`,
      ).toEqual(menuKeys);
      expect(menuKeys.length, "the recipe is 17 keys long").toBe(17);

      // Every value must agree except x/y, which are the two anchors' own
      // pixel walk and are SUPPOSED to differ.
      const differing: string[] = [];
      for (const key of menuKeys) {
        if (key === "x" || key === "y") continue;
        const a = menuMeta!.properties[key];
        const b = scriptMeta!.properties[key];
        if (a.value !== b.value || a.valueType !== b.valueType) {
          differing.push(`${key}: gallery=${JSON.stringify(a)} script=${JSON.stringify(b)}`);
        }
      }
      expect(differing, `no property drifts between the two callers`).toEqual([]);

      // TEETH for the exclusion: x and y really are different, so excluding
      // them is not quietly excluding everything.
      expect(
        menuMeta!.properties.x.value === scriptMeta!.properties.x.value,
        "x differs between the two anchors (the exclusion above is not vacuous)",
      ).toBe(false);
      expect(
        menuMeta!.properties.y.value,
        "y is the SAME — both anchors are on row " + (A_MENU.row + 1),
      ).toBe(scriptMeta!.properties.y.value);
    } finally {
      await closeMacroLibrary(page).catch(() => {});
      await cleanupMacros(page).catch(() => {});
      await clearPatch(page).catch(() => {});
    }
  });

  // =========================================================================
  // 3 — a bad catalog id fails LOUDLY and creates nothing
  // =========================================================================

  test("3. api.createShape(\"rectangel\") is REFUSED with a message naming the accepted ids, and no control is created", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(300_000);

    const stamp = Date.now().toString(36);
    const badName = `${NAME_PREFIX} bad ${stamp}`;
    const badId = `${ID_PREFIX}bad-${stamp}`;

    await allowScripts(page);
    await normalizeViewState(page);
    await clearPatch(page);

    try {
      const sheet = await activeSheetIndex(page);
      const controlsBefore = (await allControls(page, sheet)).length;

      await seedMacro(page, {
        id: badId,
        name: badName,
        body:
          `  await api.createShape("rectangel", ` +
          `{ row: ${A_BAD.row}, col: ${A_BAD.col} });\n`,
      });

      const run = await runMacro(page, grid, badName);
      expect(run.error, "the run FAILED rather than silently doing nothing").not.toBe("");
      expect(
        run.error,
        "the refusal names the shape the caller asked for",
      ).toContain("rectangel");
      expect(
        run.error,
        "the refusal is the catalog's own — it names ids the caller could have used",
      ).toMatch(/Unknown shape/i);
      expect(
        run.error,
        "and 'rectangle' is among the ids it lists, so the message is actionable",
      ).toContain("rectangle");

      expect(
        await controlMeta(page, A_BAD.row, A_BAD.col, sheet),
        "no control was created at the anchor",
      ).toBeNull();
      expect(
        (await allControls(page, sheet)).length,
        "no control was created ANYWHERE on the sheet",
      ).toBe(controlsBefore);
    } finally {
      await closeMacroLibrary(page).catch(() => {});
      await cleanupMacros(page).catch(() => {});
      await clearPatch(page).catch(() => {});
    }
  });

  // =========================================================================
  // 4 — an occupied anchor is REFUSED, never overwritten
  // =========================================================================

  test("4. creating a second shape at an OCCUPIED anchor is refused and the first shape survives untouched", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(300_000);

    const stamp = Date.now().toString(36);
    const firstName = `${NAME_PREFIX} first ${stamp}`;
    const firstId = `${ID_PREFIX}first-${stamp}`;
    const secondName = `${NAME_PREFIX} second ${stamp}`;
    const secondId = `${ID_PREFIX}second-${stamp}`;

    await allowScripts(page);
    await normalizeViewState(page);
    await clearPatch(page);

    try {
      const sheet = await activeSheetIndex(page);

      await seedMacro(page, {
        id: firstId,
        name: firstName,
        body:
          `  await api.createShape("rectangle", ` +
          `{ row: ${A_COLLIDE.row}, col: ${A_COLLIDE.col} }, { text: "FIRST" });\n`,
      });
      const firstRun = await runMacro(page, grid, firstName);
      expect(firstRun.error, "the first shape was created").toBe("");

      const controlsAfterFirst = (await allControls(page, sheet)).length;
      const firstMeta = await controlMeta(page, A_COLLIDE.row, A_COLLIDE.col, sheet);
      expect(firstMeta!.properties.text.value).toBe("FIRST");

      // A DIFFERENT shape type and caption, so an overwrite would be obvious.
      await seedMacro(page, {
        id: secondId,
        name: secondName,
        body:
          `  await api.createShape("star5", ` +
          `{ row: ${A_COLLIDE.row}, col: ${A_COLLIDE.col} }, { text: "SECOND" });\n`,
      });
      const secondRun = await runMacro(page, grid, secondName);

      expect(
        secondRun.error,
        "the collision is REFUSED — `set_control_metadata` is a plain map insert, " +
          "so a silent overwrite would wipe the first control and hand its object " +
          "script to the newcomer",
      ).not.toBe("");
      expect(secondRun.error).toMatch(/already holds/i);

      const after = await controlMeta(page, A_COLLIDE.row, A_COLLIDE.col, sheet);
      expect(after, "the first control is still there").not.toBeNull();
      expect(after!.properties.shapeType.value, "still a rectangle, not a star").toBe("rectangle");
      expect(after!.properties.text.value, "still the FIRST caption").toBe("FIRST");
      expect(
        (await allControls(page, sheet)).length,
        "the refused create landed nowhere else either",
      ).toBe(controlsAfterFirst);
    } finally {
      await closeMacroLibrary(page).catch(() => {});
      await cleanupMacros(page).catch(() => {});
      await clearPatch(page).catch(() => {});
    }
  });

  // =========================================================================
  // 5 — the orphaned-object-script bug is dead
  // =========================================================================

  test("5. deleting a BUTTON takes its object script with it: a new button at the same anchor inherits nothing", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(300_000);

    await allowScripts(page);
    await normalizeViewState(page);
    await clearPatch(page);

    const sheet = await activeSheetIndex(page);
    const instanceId = `control-${sheet}-${A_BUTTON.row}-${A_BUTTON.col}`;
    const scriptId = `e2eshape-orphan-${Date.now().toString(36)}`;
    let designModeOn = false;

    /** Insert a button at the current selection through the real Insert menu. */
    const insertButtonHere = async () => {
      await grid.openMenu("Insert");
      const controls = page.locator("button").filter({ hasText: /^Controls/ }).first();
      await controls.waitFor({ state: "visible", timeout: 5_000 });
      await controls.hover();
      const buttonItem = page.locator("button").filter({ hasText: /^Button$/ }).first();
      await expect(buttonItem).toBeVisible({ timeout: 10_000 });
      await buttonItem.click();
      await page.waitForTimeout(900);
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(80);
      }
    };

    const toggleDesignMode = async () => {
      await grid.openMenu("Developer");
      const item = page.locator("button").filter({ hasText: /^Design Mode/ }).first();
      await item.waitFor({ state: "visible", timeout: 5_000 });
      await item.click();
      await page.waitForTimeout(400);
      designModeOn = !designModeOn;
    };

    const scriptForInstance = () =>
      invoke<unknown>(page, "get_object_script_by_target", {
        objectType: "button",
        instanceId,
      });

    try {
      // ---- a button, with an object script bound to it -------------------
      await bringAnchorIntoView(grid, A_BUTTON.row, A_BUTTON.col);
      await insertButtonHere();
      const created = await controlMeta(page, A_BUTTON.row, A_BUTTON.col, sheet);
      expect(created, "Insert > Controls > Button placed a control").not.toBeNull();
      expect(created!.controlType).toBe("button");

      await invoke(page, "save_object_script", {
        script: {
          id: scriptId,
          name: "E2E orphan probe",
          objectType: "button",
          instanceId,
          source: "// ORPHAN-PROBE-SOURCE\nfunction setup(context) { return; }\n",
          accessLevel: "restricted",
          description: null,
          provenance: null,
          packageName: null,
          packageVersion: null,
        },
      });

      // TEETH: the binding really exists, so "null afterwards" is a change.
      const bound = (await scriptForInstance()) as { source?: string } | null;
      expect(bound, "the script really is bound to this button before the delete").not.toBeNull();
      expect(String(bound?.source ?? "")).toContain("ORPHAN-PROBE-SOURCE");

      // ---- delete it the way a user does: Design Mode, click, Delete -----
      await toggleDesignMode();
      const origin = await anchorOrigin(page, A_BUTTON.row, A_BUTTON.col);
      await grid.canvas.click({
        position: { x: origin.x + 30, y: origin.y + 10 },
        force: true,
      });
      await page.waitForTimeout(500);
      // A REAL Delete keypress, with NOTHING between the click and the key.
      //
      // Do not "helpfully" focus the grid container first: Controls deselects
      // the floating control on every `onSelectionChange` whose signature
      // differs, and focusing the container re-emits one — so a click, a
      // `focus()`, then Delete deletes NOTHING, silently, and the test would
      // then need a synthetic KeyboardEvent to pass, which would have hidden
      // the real reason behind a workaround. Measured, not assumed: click +
      // focus + Delete leaves the control; click + Delete removes it; and so
      // does click + a dispatched event. WebView2 is not swallowing this key.
      await page.keyboard.press("Delete");
      await page.waitForTimeout(1_200);

      expect(
        await controlMeta(page, A_BUTTON.row, A_BUTTON.col, sheet),
        "the button is gone from the backend",
      ).toBeNull();
      expect(
        await scriptForInstance(),
        "the object script went WITH it — this cleanup used to be gated on " +
          "controlType === \"shape\", so a button's script survived its button",
      ).toBeNull();

      // ---- a NEW button at the SAME anchor inherits nothing ---------------
      await toggleDesignMode(); // back out of design mode to insert normally
      await bringAnchorIntoView(grid, A_BUTTON.row, A_BUTTON.col);
      await insertButtonHere();
      const replacement = await controlMeta(page, A_BUTTON.row, A_BUTTON.col, sheet);
      expect(replacement, "a second button was placed at the same anchor").not.toBeNull();

      expect(
        await scriptForInstance(),
        "the NEW button has no object script — an instanceId derives from the " +
          "ANCHOR, so a leaked script would run on this button's click as code " +
          "its author never wrote",
      ).toBeNull();

      const remaining = await invoke<Array<{ instanceId: string | null }>>(
        page,
        "list_object_scripts",
      );
      expect(
        remaining.filter((s) => s.instanceId === instanceId),
        "and no script anywhere still names that instance id",
      ).toEqual([]);
    } finally {
      if (designModeOn) {
        await grid.openMenu("Developer").catch(() => {});
        await page
          .locator("button")
          .filter({ hasText: /^Design Mode/ })
          .first()
          .click()
          .catch(() => {});
        await page.waitForTimeout(300);
        for (let i = 0; i < 3; i++) await page.keyboard.press("Escape").catch(() => {});
      }
      await invoke(page, "delete_object_script", { id: scriptId }).catch(() => {});
      await invoke(page, "delete_object_scripts_for_instance", { instanceId }).catch(() => {});
      await clearPatch(page).catch(() => {});
    }
  });

  // =========================================================================
  // 6 — controls survive File > Open, and the store does not keep the other
  //     workbook's controls
  // =========================================================================

  test("6. a shape survives save -> new document -> reopen, and the new document's control does not follow the reopen", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(900_000);

    await allowScripts(page);
    await normalizeViewState(page);
    await clearPatch(page);

    try {
      const sheet = await activeSheetIndex(page);

      // ---- document A: one shape, saved ----------------------------------
      await bringAnchorIntoView(grid, A_KEEP.row, A_KEEP.col);
      await page.evaluate(
        async ({ sheetIndex, row, col }) => {
          const cs: any = await (window as any).__calcImport(
            new URL("/src/api/controlsService.ts", document.baseURI).href,
          );
          await cs.requireControlsProvider().createShape({
            sheetIndex, row, col, shapeType: "rectangle", text: "DOC-A",
          });
        },
        { sheetIndex: sheet, row: A_KEEP.row, col: A_KEEP.col },
      );
      expect(
        await waitForShapePainted(page, A_KEEP.row, A_KEEP.col),
        "document A's shape paints before the save",
      ).toBeGreaterThan(0.95);

      await saveDocument(page, SAVED_DOC);

      // ---- document B: a DIFFERENT control, at a different anchor ---------
      await newDocument(page);
      await page.waitForTimeout(1_500);

      await bringAnchorIntoView(grid, A_KEEP.row, A_KEEP.col);
      // TEETH: A's shape is gone from the new document, so "present after
      // reopen" below is a real reload rather than a leftover.
      expect(
        await waitForShapeGone(page, A_KEEP.row, A_KEEP.col),
        "document A's shape does NOT paint in the new document",
      ).toBeLessThan(0.02);
      expect(
        await controlMeta(page, A_KEEP.row, A_KEEP.col, await activeSheetIndex(page)),
        "and the new document holds no control at A's anchor",
      ).toBeNull();

      const sheetB = await activeSheetIndex(page);
      await bringAnchorIntoView(grid, A_DECOY.row, A_DECOY.col);
      await page.evaluate(
        async ({ sheetIndex, row, col }) => {
          const cs: any = await (window as any).__calcImport(
            new URL("/src/api/controlsService.ts", document.baseURI).href,
          );
          await cs.requireControlsProvider().createShape({
            sheetIndex, row, col, shapeType: "rectangle", text: "DOC-B",
          });
        },
        { sheetIndex: sheetB, row: A_DECOY.row, col: A_DECOY.col },
      );
      expect(
        await waitForShapePainted(page, A_DECOY.row, A_DECOY.col),
        "document B's decoy shape paints",
      ).toBeGreaterThan(0.95);

      // ---- reopen document A ---------------------------------------------
      await openDocument(page, SAVED_DOC);
      await page.waitForTimeout(2_000);
      const sheetA = await activeSheetIndex(page);

      await bringAnchorIntoView(grid, A_KEEP.row, A_KEEP.col);
      expect(
        await waitForShapePainted(page, A_KEEP.row, A_KEEP.col),
        "document A's shape is back on the canvas after the reopen",
      ).toBeGreaterThan(0.95);
      const keptMeta = await controlMeta(page, A_KEEP.row, A_KEEP.col, sheetA);
      expect(keptMeta, "and the reopened document holds it").not.toBeNull();
      expect(keptMeta!.properties.text.value).toBe("DOC-A");
      expect(keptMeta!.properties.pinToGrid.value, "the pin survived the round trip").toBe("false");

      await bringAnchorIntoView(grid, A_DECOY.row, A_DECOY.col);
      expect(
        await waitForShapeGone(page, A_DECOY.row, A_DECOY.col),
        "the OTHER workbook's control does not paint over the reopened one — " +
          "the floating store is swapped on AFTER_OPEN, not kept",
      ).toBeLessThan(0.02);
      expect(
        await controlMeta(page, A_DECOY.row, A_DECOY.col, sheetA),
        "and the backend never gained it either",
      ).toBeNull();

      const inventory = await allControls(page, sheetA);
      expect(
        inventory.filter((c) => c.row === A_DECOY.row && c.col === A_DECOY.col),
        "the reopened document's control inventory has no trace of document B",
      ).toEqual([]);
    } finally {
      await clearPatch(page).catch(() => {});
    }
  });

  // =========================================================================
  // 7 — the Home-tab entry point is reachable, and the default is unchanged
  // =========================================================================

  test("7. View > \"Customize Home Tab...\" opens the dialog, and the ribbon still shows today's default sections in today's order", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(300_000);

    try {
      // The owner's constraint: the CURRENT appearance stays the default.
      const sections = await waitForHomeRibbon(page);
      expect(
        sections.map((s) => s.label),
        "the Home tab's sections, in order",
      ).toEqual(DEFAULT_SECTION_LABELS);

      // The entry point itself.
      await grid.openMenu("View");
      const item = page.locator("button").filter({ hasText: /Customize Home Tab/ }).first();
      await expect(
        item,
        "the View menu carries the entry point (the dialog was registered, " +
          "listening and unreachable before this)",
      ).toBeVisible({ timeout: 10_000 });
      await item.click();

      const dialog = page.locator("[data-hometab-customize-dialog]");
      await expect(dialog, "clicking it OPENS the dialog").toBeVisible({ timeout: 10_000 });
      // It is the real editor, not an empty shell: one card per ribbon group.
      const groupCards = dialog.locator("[data-hometab-group]");
      await expect(groupCards).toHaveCount(DEFAULT_SECTION_LABELS.length);

      await dialog.locator("[data-hometab-cancel]").click();
      await expect(dialog).toBeHidden({ timeout: 10_000 });

      // Cancelling changed nothing.
      expect(
        (await waitForHomeRibbon(page)).map((s) => s.label),
        "the ribbon is untouched by opening and cancelling",
      ).toEqual(DEFAULT_SECTION_LABELS);
    } finally {
      for (let i = 0; i < 3; i++) await page.keyboard.press("Escape").catch(() => {});
    }
  });

  // =========================================================================
  // 8 — Row Break is placeable, and Reset-then-Cancel really cancels
  // =========================================================================

  test("8. a Row Break can be added and the ribbon lays it out; Reset then Cancel leaves the saved layout UNCHANGED across a reload", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(300_000);

    try {
      // Baseline: Cells is ["insertRow","insertColumn",rowBreak,"deleteRow",
      // "deleteColumn"] — two rendered rows.
      expect(await sectionRows(page, "Cells"), "Cells starts as two rendered rows").toBe(2);

      // ---- add a row break ------------------------------------------------
      let dialog = await openCustomizeDialog(page, grid);

      const rowBreakBtn = dialog.locator("[data-hometab-add='rowBreak']");
      await expect(rowBreakBtn, "the Row Break command is offered").toHaveCount(1);
      await expect(
        rowBreakBtn,
        'Row Break is a MULTI-INSTANCE separator: the used-item set must exempt ' +
          "it, or it is greyed out on first open and layout control is advertised " +
          "but unreachable",
      ).toBeEnabled();

      // TEETH for that assertion: a single-instance item already placed IS
      // disabled, so "enabled" is a property of rowBreak, not of every button.
      await expect(
        dialog.locator("[data-hometab-add='bold']"),
        "a single-instance command already in a group is disabled (so the " +
          "assertion above is not just 'nothing is ever disabled')",
      ).toBeDisabled();

      await dialog.locator("[data-hometab-add-to]").selectOption("cells");
      await rowBreakBtn.click();
      await page.waitForTimeout(300);

      const cellsGroup = dialog.locator("[data-hometab-group='cells']");
      const breaks = cellsGroup.locator("[data-hometab-chip='rowBreak']");
      await expect(breaks, "Cells now holds two row breaks").toHaveCount(2);

      // The new break appended at the END, where a trailing separator renders
      // nothing. Move it one place left so it lands BETWEEN deleteRow and
      // deleteColumn and actually splits a row.
      await breaks.last().locator("[data-hometab-chip-left]").click();
      await page.waitForTimeout(200);
      const chipOrder = await cellsGroup
        .locator("[data-hometab-chip]")
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-hometab-chip")));
      expect(chipOrder, "the new break sits between deleteRow and deleteColumn").toEqual([
        "insertRow", "insertColumn", "rowBreak", "deleteRow", "rowBreak", "deleteColumn",
      ]);

      await dialog.locator("[data-hometab-save]").click();
      await expect(dialog).toBeHidden({ timeout: 10_000 });
      await page.waitForTimeout(600);

      // Saving must leave the user LOOKING AT the tab they just customised.
      // Re-registering used to unregister first, which made the Home tab
      // momentarily not exist; the ribbon's fallback then selected Page Layout
      // and the customised Home tab was off screen.
      const tabStrip = page.locator("[data-ribbon-content]").locator("xpath=..");
      await expect(
        tabStrip.locator("button").filter({ hasText: /^Home$/ }),
        "the Home tab is still the one on screen after Save",
      ).toHaveCount(1);
      expect(
        (await readRibbonSections(page)).map((s) => s.label),
        "Save did not kick the ribbon onto another tab",
      ).toEqual(DEFAULT_SECTION_LABELS);

      expect(
        await sectionRows(page, "Cells"),
        "the RIBBON lays the group out in three rows now",
      ).toBe(3);
      expect(
        (await waitForHomeRibbon(page)).map((s) => s.label),
        "and no other section moved",
      ).toEqual(DEFAULT_SECTION_LABELS);

      // ---- it survives a reload ------------------------------------------
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-focus-container='spreadsheet']", {
        state: "visible",
        timeout: 90_000,
      });
      await page.waitForTimeout(1_500);
      expect(
        await sectionRows(page, "Cells"),
        "the saved layout is what the ribbon builds at startup",
      ).toBe(3);

      // ---- Reset, then CANCEL --------------------------------------------
      dialog = await openCustomizeDialog(page, grid);
      await dialog.locator("[data-hometab-reset]").click();
      await page.waitForTimeout(300);
      // The reset is STAGED: the dialog now shows the default (one row break in
      // Cells) while nothing has been written.
      await expect(
        dialog.locator("[data-hometab-group='cells'] [data-hometab-chip='rowBreak']"),
        "Reset staged the default layout in the dialog",
      ).toHaveCount(1);

      await dialog.locator("[data-hometab-cancel]").click();
      await expect(dialog).toBeHidden({ timeout: 10_000 });
      await page.waitForTimeout(600);

      expect(
        await sectionRows(page, "Cells"),
        "Cancel cancelled: the ribbon still shows the customised layout",
      ).toBe(3);

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-focus-container='spreadsheet']", {
        state: "visible",
        timeout: 90_000,
      });
      await page.waitForTimeout(1_500);
      expect(
        await sectionRows(page, "Cells"),
        "and it is STILL the customised layout after a reload — `resetLayout` " +
          "used to removeItem() on the spot, so Reset+Cancel wiped storage and " +
          "the reset appeared at the next launch",
      ).toBe(3);

      const stored = await page.evaluate(
        (key) => localStorage.getItem(key),
        HOME_LAYOUT_KEY,
      );
      expect(stored, "storage still holds the customised layout").toContain("rowBreak");
    } finally {
      // Put the ribbon back to the default the visual goldens encode.
      await restoreDefaultHomeLayout(page).catch(() => {});
      const back = await sectionRows(page, "Cells").catch(() => -1);
      expect(back, "the default layout is restored for the rest of the suite").toBe(2);
    }
  });
});
