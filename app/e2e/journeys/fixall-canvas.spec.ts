/**
 * FIX-ALL WAVE, CANVAS AREA -- the LIVE CHECKs of waves A-F proved in the
 * running app.
 *
 * Six fix waves (A-F) fixed every defect found since the canvas owner test, and
 * every one of them was proved by unit tests only. This journey drives the
 * PRODUCT for each LIVE CHECK of the canvas area -- the real pointer on the real
 * objects, the real keys through the real dispatcher, the real menus and ribbon
 * -- and reads the result back from the BACKEND (`get_charts`,
 * `get_all_controls`, `get_all_slicers`, `get_sheets`, `get_undo_state`) and the
 * DOM, never "the call returned OK".
 *
 * Every test is named after the item it proves (V1, W25, W26, X12, M1 ...) and
 * asserts BOTH directions: the fixed behaviour happens where it should (a
 * positive control, so a key that never arrived cannot pass) AND the old wrong
 * behaviour does not.
 *
 * SHARED APP. Every test starts and ends with the app's own File > New
 * (file-api `newFile`, never a raw `new_file`: BUG-0205). Sheet1 A1:C5 is the
 * data patch (Month / Units / Day).
 *
 * DPR 2 here, so no screenshot goldens: pixel evidence (where any) is relative
 * and read through `samplePixelGrids`.
 */
import type { Page } from "@playwright/test";
import * as fs from "node:fs";
import * as nodeOs from "node:os";
import * as path from "node:path";
import { test, expect } from "../fixtures";
import { readGridGeometry } from "../helpers/grid";
import {
  MOD,
  addCanvas,
  addWorksheet,
  installAppImport,
  sheetPointToPage,
  barSpec,
  callModule,
  chartData,
  clickEmpty,
  clickSheetTab,
  clickObject,
  controlsOn,
  createChart,
  createShape,
  createTimeline,
  dragObject,
  dismissNativeDialogs,
  dismissToasts,
  openFileAtPath,
  eventually,
  gridBox,
  gridKey,
  hasRibbonTab,
  invoke,
  tryInvoke,
  isDirty,
  newFile,
  objects,
  persistedCharts,
  pivotRegions,
  protectActiveSheet,
  seedSheet1,
  selectedObjects,
  sheetsResult,
  startToasts,
  timelinesAll,
  toasts,
  undoState,
  unprotectActiveSheet,
  visibleNativeDialogs,
  patchActiveCanvas,
  createPivot,
  createSlicer,
  slicersAll,
  type Obj,
} from "../helpers/canvas-live";

// ---------------------------------------------------------------------------
// Shared set-ups
// ---------------------------------------------------------------------------

/** Chart A, chart B and a shape S on a canvas (sheet px; multiples of 16). */
const A_RECT = { x: 32, y: 32, width: 224, height: 144 };
const B_RECT = { x: 288, y: 32, width: 224, height: 144 };
const S_RECT = { x: 32, y: 224, width: 144, height: 80 };

interface CanvasScene {
  canvasIndex: number;
  sheet1Id: string;
  chartA: string;
  chartB: string;
  pageWidth: number;
  pageHeight: number;
}

/** Add a canvas whose page fits the window (every object on screen at zoom 1). */
async function fittedCanvas(page: Page): Promise<{ index: number; pageWidth: number; pageHeight: number }> {
  const canvas = await addCanvas(page);
  const box = await gridBox(page);
  const pageWidth = Math.min(1280, Math.floor((box.width - 32) / 16) * 16);
  const pageHeight = Math.min(720, Math.floor((box.height - 32) / 16) * 16);
  await patchActiveCanvas(page, { pagePreset: "custom", pageWidth, pageHeight });
  return { index: canvas.index, pageWidth, pageHeight };
}

/**
 * A fresh workbook: Sheet1 data, a canvas whose page fits the window (so every
 * object is on screen at zoom 1), charts A and B and shape S on it.
 */
async function canvasScene(page: Page, opts: { shape?: boolean; chartA?: boolean; chartB?: boolean } = {}): Promise<CanvasScene> {
  await newFile(page);
  await seedSheet1(page);
  const sheet1Id = (await sheetsResult(page)).sheets[0].sheetId!;
  const canvas = await fittedCanvas(page);
  const chartA = opts.chartA === false ? "" : await createChart(page, barSpec(sheet1Id, "Chart A"), { sheetIndex: canvas.index, ...A_RECT, name: "Chart A" });
  const chartB = opts.chartB === false || opts.chartA === false ? "" : await createChart(page, barSpec(sheet1Id, "Chart B"), { sheetIndex: canvas.index, ...B_RECT, name: "Chart B" });
  if (opts.shape !== false) await createShape(page, { sheetIndex: canvas.index, ...S_RECT });
  const expected = (chartA ? 1 : 0) + (chartB ? 1 : 0) + (opts.shape === false ? 0 : 1);
  await eventually(() => objects(page), (o) => o.length === expected, "the scene's objects were never published");
  return { canvasIndex: canvas.index, sheet1Id, chartA, chartB, pageWidth: canvas.pageWidth, pageHeight: canvas.pageHeight };
}

/** Counts of what the BACKEND holds on a sheet. */
async function held(page: Page, sheetIndex: number): Promise<{ charts: number; shapes: number }> {
  const charts = (await persistedCharts(page)).filter((c) => c.sheetIndex === sheetIndex).length;
  const shapes = (await controlsOn(page, sheetIndex)).length;
  return { charts, shapes };
}

function objByChart(os: Obj[], chartId: string): Obj {
  const o = os.find((x) => x.chartId === chartId);
  if (!o) throw new Error(`chart ${chartId} is not published: ${JSON.stringify(os.map((x) => x.id))}`);
  return o;
}

function shapesOf(os: Obj[]): Obj[] {
  return os.filter((o) => o.type === "floating-control");
}

/** Click chart A, Ctrl+click chart B, Ctrl+click the shape: the three-object selection. */
async function selectABS(page: Page, scene: CanvasScene): Promise<void> {
  await clickEmpty(page, 600, 20);
  const os = await objects(page);
  await pick(page, objByChart(os, scene.chartA));
  await addPick(page, objByChart(os, scene.chartB));
  const s = shapesOf(os).sort((a, b) => a.x - b.x || a.y - b.y)[0];
  await addPick(page, s, CENTER(s));
  const sel = await eventually(() => selectedObjects(page), (x) => x.length === 3, "precondition: chart A + chart B + shape are not all selected");
  expect(sel.filter((o) => o.type === "chart").length, "precondition: both charts are in the selection").toBe(2);
}

function describeObjs(os: Obj[]): string {
  return os.map((o) => `${o.type}:${o.label}@${o.x},${o.y}${o.selected ? "*" : ""}`).join(" | ");
}

/**
 * A plain click that must SELECT `o` (alone). One retry, logged: a first click
 * that selects nothing is recorded, never silently absorbed.
 */
async function pick(page: Page, o: Obj, at?: { dx: number; dy: number }): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await clickObject(page, o, { at });
    const ok = await eventually(
      async () => (await objects(page)).find((x) => x.id === o.id)?.selected ?? false,
      (v) => v,
      "",
      1500,
    ).then(
      () => true,
      () => false,
    );
    if (ok) {
      if (attempt > 1) console.log(`[fixall-canvas] RETRY: the first click on ${o.type} "${o.label}" selected nothing; the second did`);
      return;
    }
  }
  throw new Error(`two clicks did not select ${o.type} "${o.label}": ${describeObjs(await objects(page))}`);
}

/** A Ctrl+click that must ADD `o` to the selection (one logged retry). */
async function addPick(page: Page, o: Obj, at?: { dx: number; dy: number }): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await clickObject(page, o, { ctrl: true, at });
    const ok = await eventually(
      async () => (await objects(page)).find((x) => x.id === o.id)?.selected ?? false,
      (v) => v,
      "",
      1500,
    ).then(
      () => true,
      () => false,
    );
    if (ok) {
      if (attempt > 1) console.log(`[fixall-canvas] RETRY: the first Ctrl+click on ${o.type} "${o.label}" added nothing; the second did`);
      return;
    }
  }
  throw new Error(`two Ctrl+clicks did not add ${o.type} "${o.label}" to the selection: ${describeObjs(await objects(page))}`);
}

const CENTER = (o: Obj) => ({ dx: o.w / 2, dy: o.h / 2 });
/** A chart's outer margin, for a RIGHT click that must open the chart (not an axis) menu. */
const CHART_AREA = { dx: 6, dy: 6 };
const HEADER = (o: Obj) => ({ dx: o.w / 2, dy: 10 });

/** Display text of cells on any sheet, straight from the backend ("" when empty). */
async function cellsOn(page: Page, requests: Array<[number, number, number]>): Promise<string[]> {
  const rows = await invoke<Array<{ display?: string } | null>>(page, "get_watch_cells", { requests });
  return rows.map((c) => (c ? String(c.display ?? "") : ""));
}

/** The Properties pane row whose label is exactly `label`, and its input. */
function paneInput(page: Page, label: string) {
  return page
    .locator("span, label, div")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .first()
    .locator("xpath=ancestor::div[.//input][1]")
    .locator("input")
    .first();
}

/** The open top-level menu's container (the parent of its menu-bar button). */
async function openTopMenu(page: Page, name: string) {
  const btn = page.locator("button").filter({ hasText: new RegExp(`^${name}$`) }).first();
  await btn.click();
  await page.waitForTimeout(300);
  return btn.locator("xpath=..");
}

/** Edit > Copy, through the real menu. */
async function editMenuCopy(page: Page): Promise<void> {
  const menu = await openTopMenu(page, "Edit");
  await menu.locator("button").filter({ hasText: /^Copy\s*(Ctrl\+C)?$/ }).first().click();
  await page.waitForTimeout(300);
}

/** Edit > Paste > Paste, through the real menu. */
async function editMenuPaste(page: Page): Promise<void> {
  const menu = await openTopMenu(page, "Edit");
  await menu.locator("button").filter({ hasText: /^Pastes*▸?$/ }).first().hover();
  await page.waitForTimeout(300);
  await page.locator("button").filter({ hasText: /^Paste\s*Ctrl\+V$/ }).first().click();
  await page.waitForTimeout(300);
}

/** The Home tab's Copy / Paste buttons, through the real ribbon. */
async function homeButton(page: Page, which: "copy" | "paste"): Promise<void> {
  const band = page.locator("[data-ribbon-content]");
  const strip = band.locator("xpath=..").locator("div").first();
  await strip.locator("button", { hasText: /^Home$/ }).first().click();
  await page.waitForTimeout(200);
  await page.locator(`[data-testid="fmt-${which}"]`).first().click();
  await page.waitForTimeout(300);
}

/** Bring the Canvas contextual tab forward (a selected object's own tab may have taken the band). */
async function openCanvasTab(page: Page): Promise<void> {
  const band = page.locator("[data-ribbon-content]");
  const strip = band.locator("xpath=..").locator("div").first();
  await strip.locator("button", { hasText: /^Canvas$/ }).first().click();
  await page.waitForTimeout(200);
}

/** The ACTIVE canvas's stacking lists, from the backend. */
async function stacking(page: Page, ci: number): Promise<{ zOrder: string[]; locked: string[]; snapToGrid: boolean; gridSizePx: number; background: string }> {
  const s = (await sheetsResult(page)).sheets.find((x) => x.index === ci)!;
  const l = s.canvasLayout!;
  return {
    zOrder: (l.zOrder ?? []).map((r) => `${r.kind}:${r.id}`),
    locked: (l.locked ?? []).map((r) => `${r.kind}:${r.id}`),
    snapToGrid: l.snapToGrid,
    gridSizePx: l.gridSizePx,
    background: l.background,
  };
}

async function endClean(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await newFile(page).catch(() => {});
}

// ---------------------------------------------------------------------------
// V1 / W26 -- Delete acts on the WHOLE canvas selection
// ---------------------------------------------------------------------------

test.describe("fix-all canvas, live", () => {
  // -------------------------------------------------------------------------
  // Defects found LIVE while proving the checks below (named, so each is ONE
  // failure with its own evidence instead of a cascade through the rest).
  // -------------------------------------------------------------------------

  test("LIVE-1 (found live): Controls follow the ACTIVE sheet -- a shape on a canvas is not painted on Sheet1, and it is back on its canvas after save + reopen", async ({
    appPage: page,
  }) => {
    test.setTimeout(180_000);
    const doc = path.join(nodeOs.tmpdir(), "calcula-fixall-canvas-live1.cala");
    try {
      const scene = await canvasScene(page, { chartA: false });
      const ci = scene.canvasIndex;
      expect(shapesOf(await objects(page)).length, "precondition: the canvas shows its shape").toBe(1);
      const state = await page.evaluate(() => {
        const s = (window as unknown as { __CALCULA_GRID_STATE__?: { config?: { activeSheet?: number }; sheetContext?: { activeSheetIndex: number } } }).__CALCULA_GRID_STATE__;
        return { configActiveSheet: s?.config?.activeSheet ?? null, activeSheetIndex: s?.sheetContext?.activeSheetIndex ?? null };
      });
      console.log(`[fixall-canvas] LIVE-1 grid state on the canvas: ${JSON.stringify(state)}`);
      await clickSheetTab(page, 0);
      await eventually(() => sheetsResult(page), (r) => r.activeIndex === 0, "could not switch to Sheet1");
      await page.waitForTimeout(1200);
      const onSheet1 = shapesOf(await objects(page));
      expect.soft(onSheet1.map((o) => `${o.id}@${o.x},${o.y}`), "Sheet1 paints (and hit-tests) the CANVAS's shape").toEqual([]);
      // Save, reopen, go to the canvas: its shape must be there.
      await invoke(page, "save_file", { path: doc });
      await newFile(page);
      await openFileAtPath(page, doc);
      const sheets = await eventually(() => sheetsResult(page), (r) => r.sheets.some((s) => s.kind === "canvas"), "the canvas did not survive the reopen");
      const back = sheets.sheets.find((s) => s.kind === "canvas")!;
      expect((await controlsOn(page, back.index)).length, "precondition: the backend still holds the canvas's shape").toBe(1);
      await clickSheetTab(page, back.index);
      await eventually(() => sheetsResult(page), (r) => r.activeIndex === back.index, "could not switch to the reopened canvas");
      const shown = await eventually(async () => shapesOf(await objects(page)).length, (n) => n === 1, "", 8000).then(
        () => "",
        (e) => String(e).slice(0, 300),
      );
      expect(shown, "after save + reopen the canvas's shape is not shown on its canvas").toBe("");
      void ci;
    } finally {
      await endClean(page);
      fs.rmSync(doc, { force: true });
    }
  });

  test("LIVE-2 (found live): a click on the empty canvas page released at once (a tap) does not leave the marquee armed -- the next click on an object selects that object only", async ({
    appPage: page,
  }) => {
    test.setTimeout(180_000);
    try {
      const scene = await canvasScene(page);
      const os = await objects(page);
      const A = objByChart(os, scene.chartA);
      await installAppImport(page);
      const band = () =>
        page.evaluate(async () => {
          const m = (await (window as unknown as { __appImport: (p: string) => Promise<unknown> }).__appImport("/extensions/CanvasSheet/lib/marquee.ts")) as {
            currentMarqueeBand: () => unknown;
          };
          return m.currentMarqueeBand();
        });
      // Positive control: a click held like a hand holds it, then a click on chart A: A only.
      await clickEmpty(page, 600, 20);
      await clickObject(page, A);
      await eventually(async () => (await selectedObjects(page)).map((o) => o.label), (v) => v.length > 0, "a human click on chart A selected nothing");
      expect((await selectedObjects(page)).map((o) => o.label), "positive control: a held click then a click on A selects A only").toEqual(["Chart A"]);

      // The same with an INSTANT empty-page click (press and release in one instant, as a tap does).
      await clickEmpty(page, 600, 400);
      const p = await sheetPointToPage(page, 600, 20);
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(250);
      const q = await sheetPointToPage(page, 300, 300);
      await page.mouse.move(q.x, q.y, { steps: 4 });
      const armed = await band();
      expect.soft(armed, "after an instant empty-page click a marquee band follows the pointer with NO button held").toBeNull();
      await clickObject(page, A);
      const sel = (await selectedObjects(page)).map((o) => o.label).sort();
      expect(sel, "after an instant empty-page click, a click on chart A selected more than A").toEqual(["Chart A"]);
    } finally {
      await endClean(page);
    }
  });

  test("V1: on a canvas, Delete and Backspace remove chart + set-held second chart + shape, and ONE Ctrl+Z restores all three", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      for (const key of ["Delete", "Backspace"]) {
        const scene = await canvasScene(page);
        const ci = scene.canvasIndex;
        expect(await held(page, ci)).toEqual({ charts: 2, shapes: 1 });
        await selectABS(page, scene);
        await gridKey(page, key);
        await eventually(() => held(page, ci), (h) => h.charts === 0 && h.shapes === 0, `${key}: not all three objects were deleted`);
        expect((await undoState(page)).undoDescription, `${key}: the delete is ONE step named for the whole selection`).toBe("Delete Objects");
        await gridKey(page, "Control+z");
        // ONE Ctrl+Z: all three come back (three steps would bring back one).
        await eventually(() => held(page, ci), (h) => h.charts === 2 && h.shapes === 1, `${key}: one Ctrl+Z did not restore all three`);
        const ids = (await persistedCharts(page)).filter((c) => c.sheetIndex === ci).map((c) => c.id).sort();
        expect(ids, `${key}: the SAME charts came back`).toEqual([scene.chartA, scene.chartB].sort());
        // ...and the user SEES all three again.
        const shown = await eventually(() => objects(page), (o) => o.length === 3, "", 8000).then(
          () => "",
          (e) => String(e).slice(0, 400),
        );
        expect.soft(shown, `${key}: after the undo the restored objects are not all shown again`).toBe("");
      }
    } finally {
      await endClean(page);
    }
  });

  // -------------------------------------------------------------------------
  // W25 -- the object clipboard across families
  // -------------------------------------------------------------------------

  test("W25 (wc-canvas 1): Ctrl+C / Ctrl+V of chart A + chart B + shape: three copies at +20 px, selected ('3 objects'), one undo step, redo, second paste at +40", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(180_000);
    try {
      const scene = await canvasScene(page);
      const ci = scene.canvasIndex;
      const origCharts = await persistedCharts(page);
      const origShape = (await controlsOn(page, ci))[0];
      await selectABS(page, scene);
      await gridKey(page, "Control+c");
      await page.waitForTimeout(400);
      // Copy alone changes nothing in the document.
      expect(await held(page, ci), "Ctrl+C created or removed an object").toEqual({ charts: 2, shapes: 1 });

      await gridKey(page, "Control+v");
      await eventually(() => held(page, ci), (h) => h.charts === 4 && h.shapes === 2, "Ctrl+V did not create a copy of all three");
      const after = await persistedCharts(page);
      const newCharts = after.filter((c) => !origCharts.some((o) => o.id === c.id));
      const byTitle = (t: string) => newCharts.find((c) => c.spec.title === t);
      expect({ x: byTitle("Chart A")?.x, y: byTitle("Chart A")?.y }, "chart A's copy lands +20 px").toEqual({ x: A_RECT.x + 20, y: A_RECT.y + 20 });
      expect({ x: byTitle("Chart B")?.x, y: byTitle("Chart B")?.y }, "chart B's copy lands +20 px").toEqual({ x: B_RECT.x + 20, y: B_RECT.y + 20 });
      const shapes = await controlsOn(page, ci);
      const newShape = shapes.find((s) => s.row !== origShape.row || s.col !== origShape.col)!;
      expect({ x: newShape.x, y: newShape.y }, "the shape's copy lands +20 px").toEqual({ x: S_RECT.x + 20, y: S_RECT.y + 20 });

      // The copies -- and only the copies -- are the selection, and the Name Box says so.
      const sel = await eventually(() => selectedObjects(page), (s) => s.length === 3, "the three copies are not the selection");
      const selChartIds = sel.filter((o) => o.chartId).map((o) => o.chartId).sort();
      expect(selChartIds, "the selected charts are the COPIES").toEqual(newCharts.map((c) => c.id).sort());
      await eventually(() => grid.nameBox.inputValue(), (v) => v === "3 objects", "the Name Box does not read '3 objects'");

      // One step: one Ctrl+Z removes all three copies; Ctrl+Y brings them back.
      expect((await undoState(page)).undoDescription).toBe("Paste Objects");
      await gridKey(page, "Control+z");
      await eventually(() => held(page, ci), (h) => h.charts === 2 && h.shapes === 1, "one Ctrl+Z did not remove all three copies");
      await gridKey(page, "Control+y");
      await eventually(() => held(page, ci), (h) => h.charts === 4 && h.shapes === 2, "Ctrl+Y did not restore the three copies");

      // A second paste cascades: +40.
      await eventually(() => objects(page), (o) => o.length === 6, "the redone copies were not re-published");
      await gridKey(page, "Control+v");
      await eventually(() => held(page, ci), (h) => h.charts === 6 && h.shapes === 3, "the second Ctrl+V did not paste");
      const third = (await persistedCharts(page)).filter((c) => c.spec.title === "Chart A").map((c) => c.x).sort((a, b) => a - b);
      expect(third, "chart A and its copies at 0 / +20 / +40").toEqual([A_RECT.x, A_RECT.x + 20, A_RECT.x + 40]);
    } finally {
      await endClean(page);
    }
  });

  test("W25 (wc-canvas 2): Ctrl+D duplicates chart A + chart B + shape at +20 px, selected, and one Ctrl+Z removes all three", async ({
    appPage: page,
  }) => {
    test.setTimeout(180_000);
    try {
      const scene = await canvasScene(page);
      const ci = scene.canvasIndex;
      const origIds = (await persistedCharts(page)).map((c) => c.id);
      await selectABS(page, scene);
      await gridKey(page, "Control+d");
      await eventually(() => held(page, ci), (h) => h.charts === 4 && h.shapes === 2, "Ctrl+D did not duplicate all three");
      const dup = (await persistedCharts(page)).filter((c) => !origIds.includes(c.id));
      expect(dup.map((c) => `${c.spec.title}@${c.x},${c.y}`).sort()).toEqual(
        [`Chart A@${A_RECT.x + 20},${A_RECT.y + 20}`, `Chart B@${B_RECT.x + 20},${B_RECT.y + 20}`].sort(),
      );
      const shapeXs = (await controlsOn(page, ci)).map((s) => `${s.x},${s.y}`).sort();
      expect(shapeXs).toEqual([`${S_RECT.x},${S_RECT.y}`, `${S_RECT.x + 20},${S_RECT.y + 20}`].sort());
      const sel = await eventually(() => selectedObjects(page), (s) => s.length === 3, "the duplicates are not the selection");
      expect(sel.filter((o) => o.chartId).map((o) => o.chartId).sort()).toEqual(dup.map((c) => c.id).sort());
      expect((await undoState(page)).undoDescription).toBe("Duplicate Objects");
      await gridKey(page, "Control+z");
      await eventually(() => held(page, ci), (h) => h.charts === 2 && h.shapes === 1, "one Ctrl+Z did not remove all three duplicates");
      expect((await persistedCharts(page)).map((c) => c.id).sort(), "the originals are untouched").toEqual(origIds.sort());
    } finally {
      await endClean(page);
    }
  });

  test("W25 (wc-canvas 3): a slicer in the selection is named in ONE toast by Ctrl+C and by Ctrl+D, and the other three are still copied / duplicated", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      let scene: CanvasScene;
      let ci = 0;
      let slicer = { id: "", name: "" };
      let slicerObj: Obj | undefined;
      let slicersBefore = 0;
      const build = async () => {
        scene = await canvasScene(page);
        ci = scene.canvasIndex;
        const pivotId = await createPivot(page, { destinationSheet: 0, destinationCell: "H1", name: "SlicerSourcePivot" });
        slicer = await createSlicer(page, { sheetIndex: ci, x: 544, y: 32, width: 160, height: 192, pivotId, name: "Slicer_Month" });
        slicerObj = await eventually(async () => (await objects(page)).find((o) => o.type === "slicer"), (o) => !!o, "the slicer never appeared on the canvas");
        slicersBefore = (await slicersAll(page)).length;
      };
      const selectFour = async () => {
        await selectABS(page, scene);
        await addPick(page, slicerObj!, HEADER(slicerObj!));
        await eventually(() => selectedObjects(page), (s) => s.length === 4, "precondition: the slicer did not join the selection");
      };
      await build();

      // ---- Copy
      await selectFour();
      await startToasts(page);
      await gridKey(page, "Control+c");
      const copyToasts = await eventually(() => toasts(page), (t) => t.length >= 1, "Ctrl+C with a slicer in the selection said nothing");
      await page.waitForTimeout(800);
      const allCopy = await toasts(page);
      expect(allCopy.length, `ONE toast for the Copy: ${JSON.stringify(allCopy)}`).toBe(1);
      expect(copyToasts[0].text).toContain(`Copy: 1 selected object was not copied (${slicer.name}). It cannot be copied.`);
      // The rest WAS copied: a paste creates the two charts and the shape, and no slicer.
      await clickEmpty(page, 600, 400);
      await gridKey(page, "Control+v");
      await eventually(() => held(page, ci), (h) => h.charts === 4 && h.shapes === 2, "the charts and the shape were not copied alongside the refused slicer");
      expect((await slicersAll(page)).length, "no slicer was pasted").toBe(slicersBefore);

      // ---- Duplicate (a fresh scene: see the V1 note on what an undo leaves on screen)
      await build();
      await selectFour();
      await startToasts(page);
      await gridKey(page, "Control+d");
      await eventually(() => held(page, ci), (h) => h.charts === 4 && h.shapes === 2, "Ctrl+D did not duplicate the charts and the shape");
      await page.waitForTimeout(800);
      const dupToasts = await toasts(page);
      expect(dupToasts.length, `ONE toast for the Duplicate: ${JSON.stringify(dupToasts)}`).toBe(1);
      expect(dupToasts[0].text).toContain(`Duplicate: 1 selected object was not duplicated (${slicer.name}). It cannot be duplicated.`);
      expect((await slicersAll(page)).length, "no slicer was duplicated").toBe(slicersBefore);
    } finally {
      await endClean(page);
    }
  });

  test("W25 (wc-canvas 4): with nothing selected, Ctrl+V pastes the object clipboard onto the page", async ({ appPage: page }) => {
    test.setTimeout(180_000);
    try {
      const scene = await canvasScene(page, { shape: false });
      const ci = scene.canvasIndex;
      const os = await objects(page);
      await pick(page, objByChart(os, scene.chartA));
      await gridKey(page, "Control+c");
      await page.waitForTimeout(300);
      await clickEmpty(page, 600, 400);
      expect(await selectedObjects(page), "precondition: nothing is selected").toEqual([]);
      expect(await held(page, ci)).toEqual({ charts: 2, shapes: 0 });
      await gridKey(page, "Control+v");
      await eventually(() => held(page, ci), (h) => h.charts === 3, "Ctrl+V with nothing selected pasted nothing");
      const copy = (await persistedCharts(page)).find((c) => c.id !== scene.chartA && c.id !== scene.chartB)!;
      expect({ t: copy.spec.title, x: copy.x, y: copy.y }).toEqual({ t: "Chart A", x: A_RECT.x + 20, y: A_RECT.y + 20 });
    } finally {
      await endClean(page);
    }
  });

  test("W25 R2 (wc-canvas 12): rapid Ctrl+V lands each pair 20 px further with no two copies stacked, each paste its own undo step; Ctrl+D twice cascades to +40 and takes two Ctrl+Z", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      let scene = await canvasScene(page, { chartB: false });
      let ci = scene.canvasIndex;
      const selectAS = async () => {
        await clickEmpty(page, 600, 20);
        const os = await objects(page);
        await pick(page, objByChart(os, scene.chartA));
        const s = shapesOf(os).sort((a, b) => a.x - b.x)[0];
        await addPick(page, s, CENTER(s));
        await eventually(() => selectedObjects(page), (x) => x.length === 2, "precondition: chart + shape are not selected");
      };
      await selectAS();
      await gridKey(page, "Control+c");
      // Five pastes as fast as the keyboard delivers them (a held key repeats about this fast).
      await page.locator("[data-focus-container='spreadsheet']").focus();
      for (let i = 0; i < 5; i++) await page.keyboard.press("Control+v");
      await eventually(() => held(page, ci), (h) => h.charts === 6 && h.shapes === 6, "five rapid Ctrl+V did not make five pairs", 20000);
      const chartXs = (await persistedCharts(page)).filter((c) => c.sheetIndex === ci).map((c) => c.x).sort((a, b) => a - b);
      expect(chartXs, "each chart copy lands 20 px further; none stacked").toEqual([0, 20, 40, 60, 80, 100].map((d) => A_RECT.x + d));
      const shapeXs = (await controlsOn(page, ci)).map((s) => s.x).sort((a, b) => a - b);
      expect(shapeXs, "each shape copy lands 20 px further; none stacked").toEqual([0, 20, 40, 60, 80, 100].map((d) => S_RECT.x + d));

      // Each Ctrl+Z takes back ONE paste (the newest pair first).
      for (let left = 4; left >= 0; left--) {
        await gridKey(page, "Control+z");
        await eventually(
          () => held(page, ci),
          (h) => h.charts === 1 + left && h.shapes === 1 + left,
          `Ctrl+Z did not take back exactly one paste (expected ${left} pasted pairs left)`,
        );
      }

      // What the user SEES after the five undos: the originals only.
      const seen = await eventually(() => objects(page), (o) => o.length === 2, "", 8000).then(
        () => "",
        (e) => String(e).slice(0, 500),
      );
      expect.soft(seen, "after five Ctrl+Z the undone pastes are still on screen (or the originals are not)").toBe("");

      // Ctrl+D twice quickly (a fresh scene): the second duplicates the FIRST's copies (+40), and it is two steps.
      scene = await canvasScene(page, { chartB: false });
      ci = scene.canvasIndex;
      await selectAS();
      await page.locator("[data-focus-container='spreadsheet']").focus();
      await page.keyboard.press("Control+d");
      await page.keyboard.press("Control+d");
      await eventually(() => held(page, ci), (h) => h.charts === 3 && h.shapes === 3, "two quick Ctrl+D did not make two pairs", 20000);
      expect((await persistedCharts(page)).filter((c) => c.sheetIndex === ci).map((c) => c.x).sort((a, b) => a - b), "the second pair lands at +40").toEqual([A_RECT.x, A_RECT.x + 20, A_RECT.x + 40]);
      await gridKey(page, "Control+z");
      await eventually(() => held(page, ci), (h) => h.charts === 2 && h.shapes === 2, "the first Ctrl+Z did not take back only the second duplicate");
      expect((await persistedCharts(page)).filter((c) => c.sheetIndex === ci).map((c) => c.x).sort((a, b) => a - b)).toEqual([A_RECT.x, A_RECT.x + 20]);
      await gridKey(page, "Control+z");
      await eventually(() => held(page, ci), (h) => h.charts === 1 && h.shapes === 1, "the second Ctrl+Z did not take back the first duplicate");
    } finally {
      await endClean(page);
    }
  });

  // -------------------------------------------------------------------------
  // W26 / A4 -- four families in one Delete; the protected canvas refuses
  // -------------------------------------------------------------------------

  test("W26 (wc-canvas 10, wb-slicer A4): a pivot box, a slicer, a timeline and a chart selected together are deleted by ONE Delete and restored by ONE Ctrl+Z; on a protected canvas all four are refused, stay selected and are named with the protection reason", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);
    try {
      const scene = await canvasScene(page, { shape: false, chartB: false });
      const ci = scene.canvasIndex;
      const pivotId = await createPivot(page, {
        destinationSheet: ci,
        canvasFrame: { x: 32, y: 208, width: 256, height: 176 },
        name: "BoxPivot",
      });
      await eventually(() => objects(page), (o) => o.some((x) => x.type === "pivot-visual"), "the pivot box never appeared");
      const slicer = await createSlicer(page, { sheetIndex: ci, x: 304, y: 208, width: 160, height: 176, pivotId, name: "Slicer_Box" });
      const timeline = await createTimeline(page, { sheetIndex: ci, x: 304, y: 32, width: 320, height: 112, pivotId, name: "Timeline_Box" });
      const four = await eventually(() => objects(page), (o) => o.length === 4, "the four objects were never all published");
      const types = four.map((o) => o.type).sort();
      expect(types).toEqual(["chart", "pivot-visual", "slicer", "timeline-slicer"]);

      const selectFour = async () => {
        await clickEmpty(page, 700, 420);
        const os = await objects(page);
        const chart = os.find((o) => o.type === "chart")!;
        const box = os.find((o) => o.type === "pivot-visual")!;
        const sl = os.find((o) => o.type === "slicer")!;
        const tl = os.find((o) => o.type === "timeline-slicer")!;
        await pick(page, chart);
        await addPick(page, box, { dx: box.w / 2, dy: box.h / 2 });
        await addPick(page, sl, HEADER(sl));
        await addPick(page, tl, { dx: tl.w / 2, dy: 8 });
        await eventually(() => selectedObjects(page), (s) => s.length === 4, "precondition: the four objects are not all selected");
      };
      const inventory = async () => ({
        charts: (await persistedCharts(page)).filter((c) => c.sheetIndex === ci).length,
        slicers: (await slicersAll(page)).filter((s) => s.sheetIndex === ci).length,
        timelines: (await timelinesAll(page)).filter((t) => t.sheetIndex === ci).length,
        boxes: (await pivotRegions(page)).filter((r) => !!r.canvasFrame).length,
      });
      const ALL = { charts: 1, slicers: 1, timelines: 1, boxes: 1 };
      expect(await inventory()).toEqual(ALL);

      // ---- Protected against object edits: Delete refuses every one of them.
      // (Selected first: the protection is applied to a selection the user already made.)
      await selectFour();
      await protectActiveSheet(page);
      expect((await selectedObjects(page)).length, "precondition: protecting the sheet dropped the selection").toBe(4);
      await startToasts(page);
      await gridKey(page, "Delete");
      await page.waitForTimeout(2500);
      expect(await inventory(), "a protected canvas let Delete remove an object").toEqual(ALL);
      const stillSelected = (await selectedObjects(page)).map((o) => o.type).sort();
      expect(stillSelected, "the refused objects stay selected").toEqual(["chart", "pivot-visual", "slicer", "timeline-slicer"]);
      const refusal = await toasts(page);
      expect(refusal.length, `ONE toast for the refused Delete: ${JSON.stringify(refusal)}`).toBe(1);
      expect(refusal[0].text.toLowerCase()).toContain("protect");
      expect(refusal[0].text, "the toast names the timeline").toContain(timeline.name);
      expect(refusal[0].text, "the toast names the slicer").toContain(slicer.name);

      // ---- Unprotected: ONE Delete removes all four, ONE Ctrl+Z brings all four back.
      await unprotectActiveSheet(page);
      await selectFour();
      await gridKey(page, "Delete");
      await eventually(inventory, (v) => v.charts + v.slicers + v.timelines + v.boxes === 0, "Delete did not remove all four objects", 15000);
      expect((await undoState(page)).undoDescription).toBe("Delete Objects");
      await gridKey(page, "Control+z");
      await eventually(inventory, (v) => JSON.stringify(v) === JSON.stringify(ALL), "one Ctrl+Z did not restore all four objects", 15000);
      await eventually(() => objects(page), (o) => o.length === 4, "the restored objects were not re-published", 15000);
    } finally {
      await endClean(page);
    }
  });

  test("V1 refusal + B7: on a canvas protected against object edits, Delete on two charts keeps both (selected, ONE 'protected' toast naming both, no Charts dialog) and announces no chart:deleted; unprotected, one chart's Delete announces exactly one", async ({
    appPage: page,
  }) => {
    test.setTimeout(180_000);
    try {
      const scene = await canvasScene(page, { shape: false });
      const ci = scene.canvasIndex;
      await page.evaluate(() => {
        const w = window as unknown as { __e2eChartDeleted?: number; __e2eChartDeletedHooked?: boolean };
        w.__e2eChartDeleted = 0;
        if (!w.__e2eChartDeletedHooked) {
          window.addEventListener("chart:deleted", () => {
            w.__e2eChartDeleted = (w.__e2eChartDeleted ?? 0) + 1;
          });
          w.__e2eChartDeletedHooked = true;
        }
      });
      const deletedEvents = () => page.evaluate(() => (window as unknown as { __e2eChartDeleted?: number }).__e2eChartDeleted ?? -1);

      const os = await objects(page);
      await pick(page, objByChart(os, scene.chartA));
      await addPick(page, objByChart(os, scene.chartB));
      await protectActiveSheet(page);
      await eventually(() => selectedObjects(page), (s) => s.length === 2, "precondition: protecting the sheet dropped the two-chart selection");
      await startToasts(page);
      await gridKey(page, "Delete");
      await page.waitForTimeout(2500);
      expect((await held(page, ci)).charts, "a protected canvas let Delete remove a chart").toBe(2);
      expect((await selectedObjects(page)).map((o) => o.chartId).sort(), "both charts stay selected").toEqual([scene.chartA, scene.chartB].sort());
      const t = await toasts(page);
      expect(t.length, `ONE toast: ${JSON.stringify(t)}`).toBe(1);
      expect(t[0].text).toContain("Chart A");
      expect(t[0].text).toContain("Chart B");
      expect(t[0].text).toMatch(/protected sheet|sheet is protected/i);
      expect(visibleNativeDialogs().map((d) => d.title), "a native Charts dialog opened for the refusal").toEqual([]);
      expect(await deletedEvents(), "chart:deleted was announced for a refused delete").toBe(0);

      // Positive control: unprotected, deleting ONE chart announces exactly once.
      await unprotectActiveSheet(page);
      await clickEmpty(page, 600, 400);
      await pick(page, objByChart(await objects(page), scene.chartA));
      await gridKey(page, "Delete");
      await eventually(() => held(page, ci), (h) => h.charts === 1, "unprotected, Delete did not remove chart A");
      await eventually(deletedEvents, (n) => n >= 1, "no chart:deleted for a delete that landed");
      await page.waitForTimeout(500);
      expect(await deletedEvents(), "exactly ONE chart:deleted").toBe(1);
    } finally {
      dismissNativeDialogs();
      await endClean(page);
    }
  });

  test("X11: pasting a shape onto a canvas protected against object edits is refused with one toast, creates nothing and leaves the document clean; with 'Edit objects' allowed the paste lands", async ({
    appPage: page,
  }) => {
    test.setTimeout(180_000);
    const doc = path.join(nodeOs.tmpdir(), "calcula-fixall-canvas-x11.cala");
    try {
      const scene = await canvasScene(page, { chartB: false });
      const ci = scene.canvasIndex;
      const s = shapesOf(await objects(page))[0];
      await pick(page, s, CENTER(s));
      await gridKey(page, "Control+c");
      await page.waitForTimeout(300);
      await protectActiveSheet(page);
      await invoke(page, "save_file", { path: doc });
      await eventually(() => isDirty(page), (d) => d === false, "precondition: the saved document is not clean");
      await startToasts(page);
      await gridKey(page, "Control+v");
      await page.waitForTimeout(2000);
      expect((await controlsOn(page, ci)).length, "a shape was pasted onto a protected canvas").toBe(1);
      const t = await toasts(page);
      expect(t.length, `ONE toast: ${JSON.stringify(t)}`).toBe(1);
      expect(t[0].text.toLowerCase()).toContain("protect");
      expect(await isDirty(page), "the refused paste marked the document unsaved").toBe(false);

      // Positive control: 'Edit objects' allowed -> the same paste lands.
      await unprotectActiveSheet(page);
      await protectActiveSheet(page, { allowEditObjects: true });
      await gridKey(page, "Control+v");
      await eventually(() => controlsOn(page, ci), (c) => c.length === 2, "with Edit objects allowed, the paste did not land");
    } finally {
      await endClean(page);
      fs.rmSync(doc, { force: true });
    }
  });

  // -------------------------------------------------------------------------
  // V4 / S4 / wc-canvas 5-6 / P8 -- object menus on a canvas
  // -------------------------------------------------------------------------

  test("V4 + S4 (BUG-0196): on a canvas, Escape with the chart menu, the axis menu, a shape's menu or a slicer's menu open closes the menu and KEEPS the object selected (its tab stays); with no menu, Escape deselects", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      const scene = await canvasScene(page, { chartB: false });
      const ci = scene.canvasIndex;
      const pivotId = await createPivot(page, { destinationSheet: 0, destinationCell: "H1", name: "EscPivot" });
      await createSlicer(page, { sheetIndex: ci, x: 304, y: 32, width: 160, height: 192, pivotId, name: "Slicer_Esc" });
      const os = await eventually(() => objects(page), (o) => o.length === 3, "the scene never published its three objects");
      const chart = objByChart(os, scene.chartA);
      const shape = shapesOf(os)[0];
      const slicerObj = os.find((o) => o.type === "slicer")!;
      const chartMenu = page.locator("[data-chart-context-menu]");
      const controlMenu = page.locator("[data-control-context-menu]");
      const chartSelected = async () => (await callModule<{ chartId: string | null }>(page, MOD.CHART_SELECTION, "getChartSelection")).chartId;

      // ---- The chart menu.
      await clickEmpty(page, 700, 420);
      await pick(page, chart);
      await eventually(chartSelected, (id) => id === scene.chartA, "precondition: the selected chart is not the chart selection");
      await clickObject(page, chart, { right: true, at: CHART_AREA });
      await expect(chartMenu, "the chart menu did not open").toBeVisible();
      await page.keyboard.press("Escape");
      await expect(chartMenu, "Escape did not close the chart menu").toBeHidden();
      await page.waitForTimeout(300);
      expect(await chartSelected(), "Escape with the chart menu open deselected the chart").toBe(scene.chartA);
      expect((await selectedObjects(page)).map((o) => o.chartId), "the chart left the canvas selection").toEqual([scene.chartA]);
      expect(await hasRibbonTab(page, "Chart Design"), "the Chart Design tab went away").toBe(true);
      // Positive control: with NO menu open, the same Escape deselects.
      await gridKey(page, "Escape");
      await eventually(chartSelected, (id) => id === null, "with no menu open, Escape did not deselect the chart (the key never arrives?)");

      // ---- The axis menu.
      await pick(page, chart);
      const layout = (await chartData(page, scene.chartA))?.layout?.elements ?? {};
      const band = layout.yAxisBand;
      expect(band, "precondition: the chart has a value-axis band").toBeTruthy();
      await clickObject(page, chart, { right: true, at: { dx: band!.x + band!.width / 2, dy: band!.y + band!.height / 2 } });
      const axisMenu = page.getByText("Reverse Axis", { exact: true });
      await expect(axisMenu, "the axis menu did not open").toBeVisible();
      await page.keyboard.press("Escape");
      await expect(axisMenu, "Escape did not close the axis menu").toBeHidden();
      await page.waitForTimeout(300);
      expect(await chartSelected(), "Escape with the axis menu open deselected the chart").toBe(scene.chartA);
      expect(await hasRibbonTab(page, "Chart Design")).toBe(true);

      // ---- A shape's menu.
      await clickEmpty(page, 700, 420);
      await pick(page, shape, CENTER(shape));
      await clickObject(page, shape, { right: true, at: { dx: shape.w / 2, dy: shape.h / 2 } });
      await expect(controlMenu, "the shape's menu did not open").toBeVisible();
      await page.keyboard.press("Escape");
      await expect(controlMenu, "Escape did not close the shape's menu").toBeHidden();
      await page.waitForTimeout(300);
      expect((await selectedObjects(page)).map((o) => o.type), "Escape with the shape's menu open deselected the shape").toEqual(["floating-control"]);
      await gridKey(page, "Escape");
      await eventually(() => selectedObjects(page), (s) => s.length === 0, "with no menu open, Escape did not deselect the shape");

      // ---- A slicer's menu (S4).
      await clickEmpty(page, 700, 420);
      await pick(page, slicerObj, HEADER(slicerObj));
      await clickObject(page, slicerObj, { right: true, at: { dx: slicerObj.w / 2, dy: 12 } });
      const slicerMenu = page.getByText("Slicer Settings...", { exact: true });
      await expect(slicerMenu, "the slicer's menu did not open").toBeVisible();
      await page.keyboard.press("Escape");
      await expect(slicerMenu, "Escape did not close the slicer's menu").toBeHidden();
      await page.waitForTimeout(300);
      expect((await selectedObjects(page)).map((o) => o.type), "Escape with the slicer's menu open deselected the slicer").toEqual(["slicer"]);
      expect(await hasRibbonTab(page, "Slicer"), "the Slicer tab went away").toBe(true);
    } finally {
      await endClean(page);
    }
  });

  test("W25 (wc-canvas 5): a chart's menu on a canvas starts with Duplicate / Copy, adds Paste once something is copied; right-clicking an unselected chart with a shape selected leaves only the chart selected", async ({
    appPage: page,
  }) => {
    test.setTimeout(180_000);
    try {
      const scene = await canvasScene(page, { chartB: false });
      const os = await objects(page);
      const chart = objByChart(os, scene.chartA);
      const shape = shapesOf(os)[0];
      const menuItems = () => page.locator("[data-chart-context-menu] [data-chart-menu-item]").evaluateAll((els) => els.map((e) => e.getAttribute("data-chart-menu-item")));

      // Nothing on the object clipboard (it outlives File > New, like any clipboard).
      await callModule(page, MOD.OBJ_CLIP, "resetObjectClipboard");

      // With the SHAPE selected, right-click the (unselected) chart.
      await clickEmpty(page, 700, 420);
      await pick(page, shape, CENTER(shape));
      await clickObject(page, chart, { right: true, at: CHART_AREA });
      await expect(page.locator("[data-chart-context-menu]")).toBeVisible();
      const first = await menuItems();
      expect(first.slice(0, 2), "Duplicate / Copy head the chart menu on a canvas").toEqual(["duplicateObjects", "copyObjects"]);
      expect(first, "no Paste before anything is copied").not.toContain("pasteObjects");
      expect((await selectedObjects(page)).map((o) => o.type), "right-clicking an unselected chart leaves ONLY the chart selected").toEqual(["chart"]);

      // Copy from the menu; the next menu offers Paste.
      await page.locator('[data-chart-menu-item="copyObjects"]').click();
      await eventually(() => callModule<boolean>(page, MOD.OBJ_CLIP, "hasObjectClipboard"), (v) => v === true, "the menu's Copy put nothing on the object clipboard");
      await clickObject(page, chart, { right: true, at: CHART_AREA });
      await expect(page.locator("[data-chart-context-menu]")).toBeVisible();
      const second = await menuItems();
      expect(second.slice(0, 3)).toEqual(["duplicateObjects", "copyObjects", "pasteObjects"]);
      await page.keyboard.press("Escape");
    } finally {
      await endClean(page);
    }
  });

  test("W25 (wc-canvas 6): right-clicking the second chart of a chart + chart + shape selection keeps all three selected, and the menu's Duplicate (chart's, then shape's) duplicates all three as one step", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      const scene = await canvasScene(page);
      const ci = scene.canvasIndex;
      await selectABS(page, scene);
      const os = await objects(page);
      await clickObject(page, objByChart(os, scene.chartB), { right: true, at: CHART_AREA });
      await expect(page.locator("[data-chart-context-menu]")).toBeVisible();
      expect((await selectedObjects(page)).length, "the right-click on the second chart narrowed the selection").toBe(3);
      await page.locator('[data-chart-menu-item="duplicateObjects"]').click();
      await eventually(() => held(page, ci), (h) => h.charts === 4 && h.shapes === 2, "the chart menu's Duplicate did not duplicate all three");
      expect((await undoState(page)).undoDescription).toBe("Duplicate Objects");
      await gridKey(page, "Control+z");
      await eventually(() => held(page, ci), (h) => h.charts === 2 && h.shapes === 1, "one Ctrl+Z did not remove the menu's three duplicates");

      // The same from the SHAPE's menu (a fresh scene: see the V1 note on what an undo leaves on screen).
      const scene2 = await canvasScene(page);
      const ci2 = scene2.canvasIndex;
      await selectABS(page, scene2);
      const shape = shapesOf(await objects(page))[0];
      await clickObject(page, shape, { right: true, at: { dx: shape.w / 2, dy: shape.h / 2 } });
      await expect(page.locator("[data-control-context-menu]")).toBeVisible();
      expect((await selectedObjects(page)).length, "the right-click on the shape narrowed the selection").toBe(3);
      await page.locator('[data-control-menu-item="controls.duplicate"]').click();
      await eventually(() => held(page, ci2), (h) => h.charts === 4 && h.shapes === 2, "the shape menu's Duplicate did not duplicate all three");
      await gridKey(page, "Control+z");
      await eventually(() => held(page, ci2), (h) => h.charts === 2 && h.shapes === 1, "one Ctrl+Z did not remove the shape menu's three duplicates");
    } finally {
      await endClean(page);
    }
  });

  test("P8: right-clicking a canvas pivot box opens the PIVOT menu (Refresh; no Cut / Insert Row), its Refresh re-reads the source, and Escape closes the menu with the box still selected", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      const scene = await canvasScene(page, { shape: false, chartB: false });
      const ci = scene.canvasIndex;
      const pivotId = await createPivot(page, { destinationSheet: ci, canvasFrame: { x: 304, y: 32, width: 256, height: 176 }, name: "MenuPivot" });
      const box = await eventually(async () => (await objects(page)).find((o) => o.type === "pivot-visual"), (o) => !!o, "the pivot box never appeared");
      const region = (await pivotRegions(page)).find((r) => String(r.pivotId) === pivotId)!;
      const outputText = async () =>
        (
          await invoke<Array<{ display: string }>>(page, "get_range_cells_typed", {
            sheetIndex: ci,
            startRow: region.startRow,
            startCol: region.startCol,
            endRow: region.startRow + 8,
            endCol: region.startCol + 1,
          })
        ).map((c) => c.display);
      expect(await outputText(), "precondition: Jan's units are 10").toContain("10");

      // Change the SOURCE (Sheet1!B2: Jan 10 -> 17) with the canvas on screen.
      await page.evaluate(
        async ({ mod }) => {
          const m = (await (window as unknown as { __appImport: (p: string) => Promise<unknown> }).__appImport(mod)) as {
            CellRange: { fromCell: (r: number, c: number, s?: number) => { setValue: (v: string) => Promise<unknown> } };
          };
          await m.CellRange.fromCell(1, 1, 0).setValue("17");
        },
        { mod: MOD.API_RANGE },
      );

      await clickObject(page, box!, { at: { dx: box!.w - 16, dy: box!.h - 16 } });
      await eventually(() => selectedObjects(page), (s) => s.length === 1 && s[0].type === "pivot-visual", "precondition: a click did not select the box");
      await clickObject(page, box!, { right: true, at: { dx: 40, dy: 30 } });
      const menu = page.locator('[data-pivot-box-menu="0"]');
      await expect(menu, "right-clicking the pivot box opened no pivot menu").toBeVisible();
      const labels = await menu.locator('[role="menuitem"]').evaluateAll((els) => els.map((e) => (e.textContent ?? "").replace(/>$/, "").trim()));
      expect(labels, "the pivot menu offers Refresh").toContain("Refresh");
      for (const cellItem of ["Cut", "Copy", "Paste", "Insert Row", "Insert Rows", "Delete Row", "Insert"]) {
        expect(labels, `a grid-cell item (${cellItem}) appeared in the pivot box menu`).not.toContain(cellItem);
      }
      await page.keyboard.press("Escape");
      await expect(menu, "Escape did not close the pivot box menu").toBeHidden();
      await page.waitForTimeout(300);
      expect((await selectedObjects(page)).map((o) => o.type), "Escape with the pivot box menu open deselected the box").toEqual(["pivot-visual"]);

      // Refresh from the menu re-reads the source.
      await clickObject(page, box!, { right: true, at: { dx: 40, dy: 30 } });
      await expect(menu).toBeVisible();
      await menu.locator('[role="menuitem"]', { hasText: /^Refresh$/ }).first().click();
      await eventually(outputText, (t) => t.includes("17"), "the pivot box menu's Refresh did not re-read the changed source", 15000);
    } finally {
      await endClean(page);
    }
  });

  // -------------------------------------------------------------------------
  // V3 / W5 / R1 -- group drags, arrange undo, locks
  // -------------------------------------------------------------------------

  test("V3: a co-moved slicer, timeline or shape stops at the page's right edge (pageWidth - width), a LOCKED member stays put, and a shape member dragged against x=0 and back keeps its offset", async ({
    appPage: page,
  }) => {
    test.setTimeout(420_000);
    try {
      await newFile(page);
      await seedSheet1(page);
      const pivotId = await createPivot(page, { destinationSheet: 0, destinationCell: "H1", name: "CoMovePivot" });

      type Pos = { x: number; y: number; w: number };
      /** One family's case on its own canvas: lead + a member 48 px from the right page edge. */
      const runCase = async (
        family: string,
        create: (ci: number, x: number, w: number) => Promise<void>,
        read: (ci: number) => Promise<Pos[]>,
        w: number,
        grab: (o: Obj) => { dx: number; dy: number },
        narrowPage?: number,
      ) => {
        const c = await fittedCanvas(page);
        if (narrowPage) {
          // A shape's click opens the Properties pane, which narrows the grid: keep the page inside what stays visible.
          await patchActiveCanvas(page, { pagePreset: "custom", pageWidth: narrowPage, pageHeight: c.pageHeight });
          c.pageWidth = narrowPage;
        }
        const leadX = 64;
        const edgeX = c.pageWidth - w - 48;
        await create(c.index, leadX, w);
        await create(c.index, edgeX, w);
        const os = await eventually(() => objects(page), (o) => o.length === 2, `${family}: the two objects were not published`);
        const [lead, edge] = [...os].sort((a, b) => a.x - b.x);
        const leadOf = (ps: Pos[]) => [...ps].sort((a, b) => a.x - b.x)[0];
        const edgeOf = (ps: Pos[]) => [...ps].sort((a, b) => a.x - b.x)[1];

        await pick(page, lead, grab(lead));
        await addPick(page, edge, grab(edge));
        await eventually(() => selectedObjects(page), (s) => s.length === 2, `${family}: precondition, both are not selected`);
        await dragObject(page, lead, [{ dx: 152, dy: 0 }, { dx: 304, dy: 0 }], grab(lead));
        const moved = await eventually(
          () => read(c.index),
          (ps) => ps.length === 2 && leadOf(ps).x === leadX + 304,
          `${family}: the lead did not move 304 px (the drag never happened?)`,
        );
        expect(edgeOf(moved).x, `${family}: the co-moved member must stop at pageWidth - width, not run off the page`).toBe(c.pageWidth - w);

        // Lock the edge member, then drag the lead back: the locked member stays.
        await clickEmpty(page, c.pageWidth / 2, c.pageHeight - 24);
        const os2 = await objects(page);
        const edge2 = [...os2].sort((a, b) => a.x - b.x)[1];
        await pick(page, edge2, grab(edge2));
        await eventually(() => selectedObjects(page), (s) => s.length === 1, `${family}: precondition, the edge member alone is not selected`);
        await openCanvasTab(page);
        await page.locator('[data-testid="canvas-arrange-lock"]').click();
        await eventually(() => stacking(page, c.index), (s) => s.locked.length === 1, `${family}: Arrange > Lock locked nothing`);
        const lead2 = [...os2].sort((a, b) => a.x - b.x)[0];
        await pick(page, lead2, grab(lead2));
        await addPick(page, edge2, grab(edge2));
        await eventually(() => selectedObjects(page), (s) => s.length === 2, `${family}: precondition, lead + locked member are not selected`);
        await dragObject(page, lead2, [{ dx: -48, dy: 0 }, { dx: -96, dy: 0 }], grab(lead2));
        const after = await eventually(
          () => read(c.index),
          (ps) => leadOf(ps).x === leadX + 304 - 96,
          `${family}: the lead did not move back 96 px`,
        );
        expect(edgeOf(after).x, `${family}: the LOCKED member moved with the group`).toBe(c.pageWidth - w);
      };

      // ---- Slicers
      await runCase(
        "slicers",
        async (ci, x, w) => void (await createSlicer(page, { sheetIndex: ci, x, y: 48, width: w, height: 176, pivotId, name: `Slicer_${x}` })),
        async (ci) => (await slicersAll(page)).filter((s) => s.sheetIndex === ci).map((s) => ({ x: s.x, y: s.y, w: s.width })),
        160,
        (o) => ({ dx: o.w / 2, dy: 10 }),
      );
      // ---- Timelines
      await runCase(
        "timelines",
        async (ci, x, w) => void (await createTimeline(page, { sheetIndex: ci, x, y: 48, width: w, height: 96, pivotId, name: `Timeline_${x}` })),
        async (ci) => (await timelinesAll(page)).filter((t) => t.sheetIndex === ci).map((t) => ({ x: t.x, y: t.y, w: t.width })),
        288,
        (o) => ({ dx: o.w / 2, dy: 8 }),
      );
      // ---- Shapes
      await runCase(
        "shapes",
        async (ci, x, w) => void (await createShape(page, { sheetIndex: ci, x, y: 48, width: w, height: 80 })),
        async (ci) => (await controlsOn(page, ci)).map((s) => ({ x: s.x, y: s.y, w: s.width })),
        128,
        (o) => ({ dx: o.w / 2, dy: o.h / 2 }),
        704,
      );

      // ---- A shape member dragged against x=0 and back, in ONE gesture, keeps its offset.
      const c = await fittedCanvas(page);
      await createShape(page, { sheetIndex: c.index, x: 208, y: 272, width: 128, height: 80 });
      await createShape(page, { sheetIndex: c.index, x: 32, y: 384, width: 128, height: 80 });
      // This canvas's own shapes (ids control-<sheet>-...): LIVE-1 leaves earlier canvases' shapes painted here too.
      const mine = async () => (await objects(page)).filter((o) => o.id.startsWith(`control-${c.index}-`));
      const os = await eventually(mine, (o) => o.length === 2, "the offset pair was not published");
      const lead = os.find((o) => o.x === 208)!;
      const member = os.find((o) => o.x === 32)!;
      await pick(page, lead, CENTER(lead));
      await addPick(page, member, CENTER(member));
      await eventually(() => selectedObjects(page), (s) => s.length === 2, "precondition: the offset pair is not selected");
      // Left 112 (the member would reach -80: held at 0), then back right to a net +48.
      await dragObject(page, lead, [{ dx: -56, dy: 0 }, { dx: -112, dy: 0 }, { dx: -40, dy: 0 }, { dx: 48, dy: 0 }], { dx: lead.w / 2, dy: lead.h / 2 });
      const end = await eventually(
        () => controlsOn(page, c.index),
        (cs) => cs.some((s) => s.x === 208 + 48),
        "the lead shape did not end 48 px right",
      );
      const endMember = end.find((s) => s.y === 384)!;
      expect(endMember.x, "the member did not return to its original offset from the lead (32 - 208 = -176)").toBe(208 + 48 - 176);
    } finally {
      await endClean(page);
    }
  });

  test("W5 (M4): on a canvas Bring to Front and Lock are each ONE undo step with a working redo, a snap-grid change is NOT a step (Ctrl+Z skips past it), and re-applying the same background after a save leaves the document clean", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);
    const doc = path.join(nodeOs.tmpdir(), "calcula-fixall-canvas-w5.cala");
    try {
      const scene = await canvasScene(page, { shape: false, chartB: false });
      const ci = scene.canvasIndex;
      await createChart(page, barSpec(scene.sheet1Id, "Chart C"), { sheetIndex: ci, x: 160, y: 96, width: 224, height: 144, name: "Chart C" });
      await eventually(() => objects(page), (o) => o.length === 2, "chart C was not published");
      const aObj = () => objects(page).then((os) => objByChart(os, scene.chartA));
      const refA = (await aObj()).refKey!;
      expect(refA, "precondition: chart A has a canvas identity").toBeTruthy();
      const before = await stacking(page, ci);
      expect(before.zOrder[before.zOrder.length - 1] ?? null, "precondition: chart A is not already on top").not.toBe(refA);

      // ---- Bring to Front: one step, undo, redo.
      await pick(page, await aObj(), { dx: 24, dy: 24 });
      await eventually(() => selectedObjects(page), (s) => s.length === 1 && s[0].chartId === scene.chartA, "precondition: chart A alone is not selected");
      await openCanvasTab(page);
      await page.locator('[data-testid="canvas-arrange-forward"]').click();
      await page.locator('[data-testid="canvas-arrange-bring-to-front"]').click();
      await eventually(() => stacking(page, ci), (s) => s.zOrder[s.zOrder.length - 1] === refA, "Bring to Front did not put chart A on top");
      expect((await undoState(page)).undoDescription, "the step Edit > Undo would take is the reorder").toBe("Reorder objects");
      await gridKey(page, "Control+z");
      await eventually(() => stacking(page, ci), (s) => JSON.stringify(s.zOrder) === JSON.stringify(before.zOrder), "Ctrl+Z did not restore the previous order");
      await gridKey(page, "Control+y");
      await eventually(() => stacking(page, ci), (s) => s.zOrder[s.zOrder.length - 1] === refA, "Ctrl+Y did not bring chart A to the front again");

      // ---- Lock: one step; while locked a drag does not move it; after Ctrl+Z it drags.
      await pick(page, await aObj(), { dx: 24, dy: 24 });
      await openCanvasTab(page);
      await page.locator('[data-testid="canvas-arrange-lock"]').click();
      await eventually(() => stacking(page, ci), (s) => s.locked.includes(refA), "Arrange > Lock did not lock chart A");
      expect((await undoState(page)).undoDescription).toBe("Lock objects");
      await dragObject(page, await aObj(), [{ dx: 24, dy: 0 }, { dx: 48, dy: 0 }], { dx: 24, dy: 24 });
      await page.waitForTimeout(900);
      expect((await persistedCharts(page)).find((c) => c.id === scene.chartA)!.x, "a LOCKED chart moved (positive control of the lock)").toBe(A_RECT.x);
      await gridKey(page, "Control+z");
      await eventually(() => stacking(page, ci), (s) => !s.locked.includes(refA), "Ctrl+Z did not unlock chart A");
      await dragObject(page, await aObj(), [{ dx: 24, dy: 0 }, { dx: 48, dy: 0 }], { dx: 24, dy: 24 });
      await eventually(
        async () => (await persistedCharts(page)).find((c) => c.id === scene.chartA)!.x,
        (x) => x === A_RECT.x + 48,
        "after Ctrl+Z undid the lock, chart A could not be dragged",
      );

      // ---- A snap-grid change is not an undo step: Ctrl+Z skips it and takes back the drag.
      const snapBefore = (await stacking(page, ci)).snapToGrid;
      await openCanvasTab(page);
      await page.locator('[data-testid="canvas-snap-to-grid"]').click();
      await eventually(() => stacking(page, ci), (s) => s.snapToGrid === !snapBefore, "Snap to Grid did not toggle");
      await gridKey(page, "Control+z");
      await eventually(
        async () => (await persistedCharts(page)).find((c) => c.id === scene.chartA)!.x,
        (x) => x === A_RECT.x,
        "Ctrl+Z after a snap change did not take back the previous action (the drag)",
      );
      expect((await stacking(page, ci)).snapToGrid, "Ctrl+Z undid the snap-grid change (it must not be a step)").toBe(!snapBefore);

      // ---- Save, then the SAME background again: still clean. A different one: dirty.
      const bg = (await stacking(page, ci)).background;
      await invoke(page, "save_file", { path: doc });
      await eventually(() => isDirty(page), (d) => d === false, "precondition: the saved document is not clean");
      await patchActiveCanvas(page, { background: bg });
      await page.waitForTimeout(800);
      expect(await isDirty(page), "re-applying the SAME background marked the document unsaved").toBe(false);
      await patchActiveCanvas(page, { background: bg === "#fafaf0" ? "#f0f0fa" : "#fafaf0" });
      await eventually(() => isDirty(page), (d) => d === true, "a DIFFERENT background did not mark the document unsaved (positive control)");
    } finally {
      await endClean(page);
      fs.rmSync(doc, { force: true });
    }
  });

  test("R1 (wc-canvas 11): the copy of a LOCKED shape pasted after the original was deleted is unlocked, draggable and paints above the older shape; Ctrl+Z x3 brings the original back still locked; a shape inserted after deleting the locked newest shape is unlocked", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);
    try {
      const at = (o: Obj) => ({ dx: o.w / 2, dy: o.h / 2 });
      /** Shapes A then B (B newest) on a fresh canvas, B locked through Arrange > Lock. */
      const lockedPair = async () => {
        const scene = await canvasScene(page, { chartA: false, shape: false });
        const ci = scene.canvasIndex;
        await createShape(page, { sheetIndex: ci, x: 64, y: 48, width: 128, height: 80 });
        await createShape(page, { sheetIndex: ci, x: 256, y: 48, width: 128, height: 80 });
        const os0 = await eventually(() => objects(page), (o) => o.length === 2, "shapes A and B were not published");
        const B = os0.find((o) => o.x === 256)!;
        await pick(page, B, at(B));
        await openCanvasTab(page);
        await page.locator('[data-testid="canvas-arrange-lock"]').click();
        await eventually(() => stacking(page, ci), (s) => s.locked.includes(B.refKey!), "Arrange > Lock did not lock shape B");
        return { ci, B, refB: B.refKey! };
      };

      // ---- Part 1: copy B, delete it, paste.
      const { ci, B, refB } = await lockedPair();
      await pick(page, B, at(B));
      await gridKey(page, "Control+c");
      await page.waitForTimeout(300);
      await gridKey(page, "Delete");
      await eventually(() => controlsOn(page, ci), (c) => c.length === 1, "Delete did not remove the locked shape B");
      await gridKey(page, "Control+v");
      await eventually(() => controlsOn(page, ci), (c) => c.length === 2, "Ctrl+V did not paste B's copy");
      const os1 = await eventually(() => objects(page), (o) => o.length === 2, "the copy was not published");
      const copy = os1.find((o) => o.x === 256 + 20)!;
      expect(copy, "the copy lands +20 px from B").toBeTruthy();
      const locked = (await stacking(page, ci)).locked;
      expect(locked, "the copy inherited the deleted B's LOCK").not.toContain(copy.refKey);
      const idxCopy = os1.findIndex((o) => o.id === copy.id);
      const idxA = os1.findIndex((o) => o.x === 64);
      expect(idxCopy, "the copy paints BELOW the older shape A (it took B's paint slot?)").toBeGreaterThan(idxA);
      await dragObject(page, copy, [{ dx: 16, dy: 16 }, { dx: 32, dy: 32 }], at(copy));
      await eventually(
        () => controlsOn(page, ci),
        (c) => !c.some((s) => s.x === 276 && s.y === 68),
        "the copy could not be dragged (it behaves as locked)",
      );

      // Ctrl+Z x3 (drag, paste, delete): B is back where it was, and still locked.
      for (let i = 0; i < 3; i++) {
        await gridKey(page, "Control+z");
        await page.waitForTimeout(500);
      }
      const back = await eventually(
        () => controlsOn(page, ci),
        (c) => c.length === 2 && c.some((s) => s.x === 256 && s.y === 48),
        "Ctrl+Z x3 did not bring B back",
      );
      expect(back.map((s) => `${s.x},${s.y}`).sort()).toEqual(["256,48", "64,48"]);
      expect((await stacking(page, ci)).locked, "the restored B is no longer locked").toContain(refB);
      const shownBack = await eventually(async () => (await objects(page)).map((o) => `${o.x},${o.y}`).sort(), (v) => JSON.stringify(v) === '["256,48","64,48"]', "", 8000).then(
        () => "",
        (e) => String(e).slice(0, 400),
      );
      expect.soft(shownBack, "after Ctrl+Z x3 the screen does not show A and the restored B (and only them)").toBe("");

      // ---- Part 2 (a fresh canvas): delete the locked newest shape, then insert one from the Canvas tab -- it is unlocked.
      const p2 = await lockedPair();
      await pick(page, p2.B, at(p2.B));
      await gridKey(page, "Delete");
      await eventually(() => controlsOn(page, p2.ci), (c) => c.length === 1, "Delete did not remove the locked B");
      await clickEmpty(page, 600, 400);
      await openCanvasTab(page);
      const insertItem = page.locator('[data-testid="canvas-insert-shape"]');
      if (!(await insertItem.isVisible())) {
        await page.locator("[data-ribbon-content]").getByRole("button", { name: /^Insert/ }).first().click();
      }
      await insertItem.click();
      await eventually(() => controlsOn(page, p2.ci), (c) => c.length === 2, "the Canvas tab's Insert Shape created nothing");
      const os2 = await eventually(() => objects(page), (o) => o.length === 2, "the inserted shape was not published");
      const inserted = os2.find((o) => o.x !== 64)!;
      expect(inserted.refKey, "the inserted shape reuses the deleted locked B's identity").not.toBe(p2.refB);
      expect((await stacking(page, p2.ci)).locked, "the inserted shape is locked").not.toContain(inserted.refKey);
      await dragObject(page, inserted, [{ dx: 32, dy: 0 }, { dx: 64, dy: 0 }], at(inserted));
      await eventually(
        async () => (await controlsOn(page, p2.ci)).map((c) => c.x).sort((a, b) => a - b),
        (xs) => !xs.includes(inserted.x),
        "the inserted shape could not be dragged (it behaves as locked)",
      );
    } finally {
      await endClean(page);
    }
  });

  // -------------------------------------------------------------------------
  // Worksheet controls: keys, several shapes, pinned copy, protection doors
  // -------------------------------------------------------------------------

  test("Controls keys (wa-canvasTs): on a worksheet with A1:A3 selected, Ctrl+D on a selected shape duplicates the shape and fills nothing down; Ctrl+C / Ctrl+V paste a shape and leave the cells alone", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(180_000);
    try {
      await newFile(page);
      await invoke(page, "update_cell", { row: 0, col: 0, value: "x" });
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
      await createShape(page, { sheetIndex: 0, x: 320, y: 120, width: 128, height: 80 });
      await eventually(() => objects(page), (o) => o.length === 1, "the shape was not published");
      const A1A3: Array<[number, number, number]> = [[0, 0, 0], [0, 1, 0], [0, 2, 0]];
      await grid.selectRange("A1", "A3");
      const s = shapesOf(await objects(page))[0];
      await pick(page, s, CENTER(s));
      const sel = await page.evaluate(() => (window as unknown as { __CALCULA_GRID_STATE__?: { selection?: { startRow: number; endRow: number; startCol: number; endCol: number } } }).__CALCULA_GRID_STATE__?.selection ?? null);
      expect(sel && Math.max(sel.startRow, sel.endRow), "precondition: A1:A3 is still Core's selection behind the shape").toBe(2);

      await gridKey(page, "Control+d");
      await eventually(() => controlsOn(page, 0), (c) => c.length === 2, "Ctrl+D on a selected shape did not duplicate it");
      await page.waitForTimeout(400);
      expect(await cellsOn(page, A1A3), "Ctrl+D filled A1 down into the cells hidden under the shape").toEqual(["x", "", ""]);

      await pick(page, s, { dx: 15, dy: 50 }); // the duplicate (+20) covers the centre; its corner handle reaches 10 px
      await gridKey(page, "Control+c");
      await page.waitForTimeout(300);
      await gridKey(page, "Control+v");
      await eventually(() => controlsOn(page, 0), (c) => c.length === 3, "Ctrl+C / Ctrl+V on a selected shape did not paste a shape");
      await page.waitForTimeout(400);
      expect(await cellsOn(page, A1A3), "Ctrl+C / Ctrl+V changed the cells").toEqual(["x", "", ""]);

      // Positive control: with NO shape selected the same Ctrl+D fills A1 down.
      await grid.clickCell("A1");
      await grid.selectRange("A1", "A3");
      await gridKey(page, "Control+d");
      await eventually(() => cellsOn(page, A1A3), (v) => JSON.stringify(v) === JSON.stringify(["x", "x", "x"]), "with no shape selected, Ctrl+D did not fill down (the key never arrives?)");
    } finally {
      await endClean(page);
    }
  });

  test("Controls several shapes (wa-canvasTs fixup, wc-canvas 12 worksheet): Ctrl+D on three shapes makes three copies undone by ONE Ctrl+Z; Ctrl+C then Ctrl+V twice lands the second paste at +40 (not +60); two quick Ctrl+D on two shapes cascade to +40 and take two Ctrl+Z", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      const XS = [320, 480, 640];
      for (const x of XS) await createShape(page, { sheetIndex: 0, x, y: 40, width: 128, height: 64 });
      const os = await eventually(() => objects(page), (o) => o.length === 3, "the three shapes were not published");
      const byX = (x: number) => os.find((o) => o.x === x)!;
      const selectThree = async () => {
        await pick(page, byX(XS[0]), CENTER(byX(XS[0])));
        await addPick(page, byX(XS[1]), CENTER(byX(XS[1])));
        await addPick(page, byX(XS[2]), CENTER(byX(XS[2])));
      };
      const xsOf = async (y0: number) => (await controlsOn(page, 0)).filter((c) => c.y >= y0).map((c) => c.x).sort((a, b) => a - b);

      await selectThree();
      await gridKey(page, "Control+d");
      await eventually(() => controlsOn(page, 0), (c) => c.length === 6, "Ctrl+D did not duplicate all three shapes");
      expect(await xsOf(40)).toEqual([...XS, ...XS.map((x) => x + 20)].sort((a, b) => a - b));
      await gridKey(page, "Control+z");
      await eventually(() => controlsOn(page, 0), (c) => c.length === 3, "one Ctrl+Z did not remove all three duplicates");

      await eventually(() => objects(page), (o) => o.length === 3, "the originals were not re-published after the undo");
      await selectThree();
      await gridKey(page, "Control+c");
      await page.waitForTimeout(300);
      await gridKey(page, "Control+v");
      await eventually(() => controlsOn(page, 0), (c) => c.length === 6, "the first Ctrl+V did not paste three shapes");
      await gridKey(page, "Control+v");
      await eventually(() => controlsOn(page, 0), (c) => c.length === 9, "the second Ctrl+V did not paste three shapes");
      const firstColumn = (await controlsOn(page, 0)).filter((c) => c.x < XS[1] - 40).map((c) => `${c.x},${c.y}`).sort();
      expect(firstColumn, "the second paste lands +40 from the original, not +60").toEqual(["320,40", "340,60", "360,80"]);

      // Two quick Ctrl+D on two shapes: +20 then +40, two steps.
      await gridKey(page, "Control+z");
      await gridKey(page, "Control+z");
      await eventually(() => controlsOn(page, 0), (c) => c.length === 3, "could not take the two pastes back");
      await eventually(() => objects(page), (o) => o.length === 3, "the originals were not re-published");
      await pick(page, byX(XS[0]), CENTER(byX(XS[0])));
      await addPick(page, byX(XS[1]), CENTER(byX(XS[1])));
      await page.locator("[data-focus-container='spreadsheet']").focus();
      await page.keyboard.press("Control+d");
      await page.keyboard.press("Control+d");
      await eventually(() => controlsOn(page, 0), (c) => c.length === 7, "two quick Ctrl+D did not make two pairs", 15000);
      const col1 = (await controlsOn(page, 0)).filter((c) => c.x < XS[1] - 40).map((c) => c.x).sort((a, b) => a - b);
      expect(col1, "the second duplicate cascades to +40").toEqual([320, 340, 360]);
      await gridKey(page, "Control+z");
      await eventually(() => controlsOn(page, 0), (c) => c.length === 5, "the first Ctrl+Z did not take back only the second duplicate");
      await gridKey(page, "Control+z");
      await eventually(() => controlsOn(page, 0), (c) => c.length === 3, "the second Ctrl+Z did not take back the first duplicate");
    } finally {
      await endClean(page);
    }
  });

  test("R4 (wc-canvas 13): a PINNED shape's Ctrl+C / Ctrl+V copy is pinned too, and after save + reopen a column resize to the right of everything moves neither", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    const doc = path.join(nodeOs.tmpdir(), "calcula-fixall-canvas-r4.cala");
    try {
      await newFile(page);
      await createShape(page, { sheetIndex: 0, x: 336, y: 120, width: 128, height: 80 });
      const s = (await eventually(() => objects(page), (o) => o.length === 1, "the shape was not published"))[0];
      await pick(page, s, CENTER(s));
      // Properties > Pin to grid (the pane opens on the shape's click).
      const pin = paneInput(page, "Pin to grid");
      await expect(pin, "the Properties pane shows no 'Pin to grid' switch").toBeVisible({ timeout: 10_000 });
      await pin.check();
      await eventually(() => controlsOn(page, 0), (c) => c[0]?.pinToGrid === "true", "Pin to grid did not pin the shape");

      await pick(page, s, CENTER(s));
      await gridKey(page, "Control+c");
      await page.waitForTimeout(300);
      await gridKey(page, "Control+v");
      const both = await eventually(() => controlsOn(page, 0), (c) => c.length === 2, "the pinned shape's paste created nothing");
      const copy = both.find((c) => c.x === 356)!;
      expect(copy, "the copy lands +20").toBeTruthy();
      expect(copy.pinToGrid, "the copy of a pinned shape is not pinned").toBe("true");

      // The copy's Properties pane shows it pinned.
      const copyObj = (await objects(page)).find((o) => o.x === 356)!;
      await pick(page, copyObj, CENTER(copyObj));
      await expect(paneInput(page, "Pin to grid"), "the copy's Properties pane shows it unpinned").toBeChecked({ timeout: 10_000 });

      // Save, reopen, resize a column to the right of everything: nothing moves.
      await invoke(page, "save_file", { path: doc });
      await newFile(page);
      await openFileAtPath(page, doc);
      const reopened = await eventually(() => controlsOn(page, 0), (c) => c.length === 2, "the two shapes did not survive save and reopen");
      const positions = reopened.map((c) => `${c.x},${c.y}`).sort();
      const geo = await readGridGeometry(page);
      const lastCol = Math.max(...reopened.map((c) => c.col), 7) + 3; // right of every anchor and of both shapes (x < 500 = col H)
      let edge = geo.rowHeaderWidth;
      for (let c = 0; c <= lastCol; c++) edge += geo.columnWidths[c] ?? geo.defaultCellWidth;
      const box = await gridBox(page);
      const hx = box.x + (edge - geo.scrollX) * geo.zoom;
      const hy = box.y + (geo.colHeaderHeight / 2) * geo.zoom;
      expect(hx, `precondition: column ${lastCol}'s right border is on screen`).toBeLessThan(box.x + box.width - 10);
      await page.mouse.move(hx - 1, hy);
      await page.mouse.down();
      await page.mouse.move(hx + 30, hy, { steps: 5 });
      await page.mouse.move(hx + 60, hy, { steps: 5 });
      await page.mouse.up();
      await eventually(
        () => readGridGeometry(page),
        (g) => (g.columnWidths[lastCol] ?? g.defaultCellWidth) > geo.defaultCellWidth + 20,
        `the header drag did not resize column ${lastCol} (positive control)`,
      );
      await page.waitForTimeout(1200);
      const after = (await controlsOn(page, 0)).map((c) => `${c.x},${c.y}`).sort();
      expect(after, "a column resize right of everything moved a pinned shape (the copy jumped?)").toEqual(positions);
      const painted = (await objects(page)).map((o) => `${o.x},${o.y}`).sort();
      expect(painted, "the painted positions moved").toEqual(positions);
    } finally {
      await endClean(page);
      fs.rmSync(doc, { force: true });
    }
  });

  test("V1 worksheet (wa-canvasTs fixup): on a worksheet, click a slicer, then a chart, then its title, and Delete removes ONLY the title -- chart and slicer stay, no toast", async ({
    appPage: page,
  }) => {
    test.setTimeout(180_000);
    try {
      await newFile(page);
      await seedSheet1(page);
      const sheet1Id = (await sheetsResult(page)).sheets[0].sheetId!;
      const pivotId = await createPivot(page, { destinationSheet: 0, destinationCell: "H1", name: "WsPivot" });
      await createSlicer(page, { sheetIndex: 0, x: 640, y: 180, width: 160, height: 176, pivotId, name: "Slicer_Ws" });
      const chartId = await createChart(page, barSpec(sheet1Id, "Title To Delete"), { sheetIndex: 0, x: 320, y: 180, width: 256, height: 176, name: "WsChart" });
      const os = await eventually(() => objects(page), (o) => o.length === 2, "the chart and the slicer were not published");
      const slicerObj = os.find((o) => o.type === "slicer")!;
      const chartObj = objByChart(os, chartId);

      await clickObject(page, slicerObj, { at: HEADER(slicerObj) });
      await clickObject(page, chartObj);
      const title = (await chartData(page, chartId))?.layout?.elements?.title;
      expect(title, "precondition: the chart has a title rect").toBeTruthy();
      await clickObject(page, chartObj, { at: { dx: title!.x + title!.width / 2, dy: title!.y + title!.height / 2 } });
      const sel = await callModule<{ chartId: string | null; level: string; elementId?: string }>(page, MOD.CHART_SELECTION, "getChartSelection");
      expect(sel, "precondition: the chart is walked down to its title").toMatchObject({ chartId, level: "element", elementId: "title" });
      await startToasts(page);
      await gridKey(page, "Delete");
      await eventually(
        async () => (await persistedCharts(page)).find((c) => c.id === chartId)?.spec.title ?? null,
        (t) => t === null || t === undefined || t === "",
        "Delete did not remove the chart's title",
      );
      expect((await persistedCharts(page)).filter((c) => c.id === chartId).length, "the chart itself was deleted").toBe(1);
      expect((await slicersAll(page)).length, "the slicer was deleted").toBe(1);
      await page.waitForTimeout(600);
      expect(await toasts(page), "a toast appeared").toEqual([]);
    } finally {
      await endClean(page);
    }
  });

  test("B5 + B6 + B5-pane: on a sheet protected with 'Edit objects' off, Insert > Controls > Button makes nothing (one toast), Delete on a shape keeps it (one toast), and a Width typed in the Properties pane is refused (one toast, field and shape keep the stored width) while Text still changes; unprotected, Insert > Button works", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      await createShape(page, { sheetIndex: 0, x: 336, y: 120, width: 128, height: 80, text: "keep" });
      const s = (await eventually(() => objects(page), (o) => o.length === 1, "the shape was not published"))[0];
      await pick(page, s, CENTER(s));
      await expect(paneInput(page, "Width"), "the Properties pane shows no Width field").toBeVisible({ timeout: 10_000 });
      await protectActiveSheet(page);

      // ---- Width in the Properties pane: refused, reverted; Text: still allowed.
      await startToasts(page);
      const width = paneInput(page, "Width");
      await width.click();
      await width.fill("300");
      await width.press("Enter");
      await eventually(() => toasts(page), (t) => t.length >= 1, "a refused Width said nothing");
      await page.waitForTimeout(800);
      const wt = await toasts(page);
      expect(wt.length, `ONE toast for the refused Width: ${JSON.stringify(wt)}`).toBe(1);
      expect(wt[0].text).toContain("width");
      expect((await controlsOn(page, 0))[0].width, "the shape took the refused width").toBe(128);
      await eventually(() => paneInput(page, "Width").inputValue(), (v) => v === "128", "the Width field did not go back to the stored width");
      const text = paneInput(page, "Text");
      await text.click();
      await text.fill("changed");
      await text.press("Enter");
      await eventually(() => controlsOn(page, 0), (c) => c[0].text === "changed", "changing Text was refused on the protected sheet");

      // ---- Delete on the shape: kept, one toast (B6).
      await pick(page, s, CENTER(s));
      await startToasts(page);
      await gridKey(page, "Delete");
      await page.waitForTimeout(1500);
      expect((await controlsOn(page, 0)).length, "a protected sheet let Delete remove the shape").toBe(1);
      const dt = await toasts(page);
      expect(dt.length, `ONE toast for the refused Delete: ${JSON.stringify(dt)}`).toBe(1);
      expect(dt[0].text.toLowerCase()).toContain("protect");

      // ---- Insert > Controls > Button: nothing, one toast (B5).
      await grid.clickCell("B12");
      await startToasts(page);
      await grid.openMenu("Insert");
      await grid.hoverMenuItem("^Controls");
      await page.locator("button").filter({ hasText: /^Button$/ }).first().click();
      await page.waitForTimeout(1500);
      expect((await controlsOn(page, 0)).length, "Insert > Controls > Button inserted a button on a protected sheet").toBe(1);
      const bt = await toasts(page);
      expect.soft(bt.length, `ONE toast for the refused insert (the refusal must be SAID): ${JSON.stringify(bt)}`).toBe(1);

      // ---- Positive control: unprotected, the same menu inserts a button.
      await unprotectActiveSheet(page);
      await grid.clickCell("B12");
      await grid.openMenu("Insert");
      await grid.hoverMenuItem("^Controls");
      await page.locator("button").filter({ hasText: /^Button$/ }).first().click();
      await eventually(() => controlsOn(page, 0), (c) => c.some((x) => x.type === "button"), "unprotected, Insert > Controls > Button inserted nothing");
    } finally {
      await page.keyboard.press("Escape").catch(() => {});
      await endClean(page);
    }
  });

  test("B8: with a floating-grid cell selected on a worksheet, Insert > Controls > Button, Insert > Shapes and Insert > Image each refuse with ONE toast, open no file picker and create nothing; after a sheet-cell click, Insert > Button works", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      await callModule(page, MOD.FLOATING_RANGES, "createFloatingRange", [480, 80, "FloatB8"]);
      const fr = await eventually(async () => (await objects(page)).find((o) => o.type === "floating-range"), (o) => !!o, "the floating grid was not published");
      // Its A1 cell: title bar 20px, column header 16px, row header 28px (canvas journey's FR_A1).
      await clickObject(page, fr!, { at: { dx: 28 + 32, dy: 20 + 16 + 10 } });
      await eventually(() => grid.nameBox.inputValue(), (v) => v === "FloatB8!A1", "precondition: the floating grid's A1 is not the selected cell");

      const tryDoor = async (label: string, open: () => Promise<void>) => {
        await startToasts(page);
        await open();
        await page.waitForTimeout(1500);
        const t = await toasts(page);
        expect(t.length, `${label}: ONE toast, got ${JSON.stringify(t)}`).toBe(1);
        expect(visibleNativeDialogs().map((d) => d.title), `${label}: a native dialog (file picker) opened`).toEqual([]);
        expect((await controlsOn(page, 0)).length, `${label}: something was created`).toBe(0);
        await page.keyboard.press("Escape");
        await dismissToasts(page);
      };
      await tryDoor("Insert > Controls > Button", async () => {
        await grid.openMenu("Insert");
        await grid.hoverMenuItem("^Controls");
        await page.locator("button").filter({ hasText: /^Button$/ }).first().click();
      });
      await tryDoor("Insert > Shapes", async () => {
        await grid.openMenu("Insert");
        await grid.hoverMenuItem("^Shapes");
        await page.locator('[title="Rectangle"]').first().click();
      });
      await tryDoor("Insert > Image", async () => {
        await grid.openMenu("Insert");
        await page.locator("button").filter({ hasText: /^Image$/ }).first().click();
      });

      // Positive control: a sheet cell selected, Insert > Controls > Button inserts.
      await grid.clickCell("B12");
      await grid.openMenu("Insert");
      await grid.hoverMenuItem("^Controls");
      await page.locator("button").filter({ hasText: /^Button$/ }).first().click();
      await eventually(() => controlsOn(page, 0), (c) => c.some((x) => x.type === "button"), "with a sheet cell selected, Insert > Controls > Button inserted nothing");
    } finally {
      dismissNativeDialogs();
      await page.keyboard.press("Escape").catch(() => {});
      await endClean(page);
    }
  });

  // -------------------------------------------------------------------------
  // X12 / Y11 -- the Edit menu's and the Home tab's Copy / Paste on a canvas
  // -------------------------------------------------------------------------

  test("X12 + Y11: on a canvas, Edit > Copy / Edit > Paste > Paste and the Home tab's Copy / Paste copy a chart + shape selection (two copies at +20, selected, ONE Ctrl+Z); with a floating-grid cell selected Edit > Copy is the grid's refusal and copies no object; on a worksheet both doors still copy cells", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(300_000);
    try {
      for (const door of ["Edit menu", "Home tab"] as const) {
        // A fresh scene per door (see the V1 note on what an undo leaves on screen).
        const scene = await canvasScene(page, { chartB: false });
        const ci = scene.canvasIndex;
        await clickEmpty(page, 700, 420);
        const os0 = await objects(page);
        await pick(page, objByChart(os0, scene.chartA));
        const sh = shapesOf(os0).sort((a, b) => a.x - b.x)[0];
        await addPick(page, sh, CENTER(sh));
        if (door === "Edit menu") await editMenuCopy(page);
        else await homeButton(page, "copy");
        await eventually(() => callModule<boolean>(page, MOD.OBJ_CLIP, "hasObjectClipboard"), (v) => v, `${door}: Copy put nothing on the object clipboard`);
        if (door === "Edit menu") await editMenuPaste(page);
        else await homeButton(page, "paste");
        await eventually(() => held(page, ci), (h) => h.charts === 2 && h.shapes === 2, `${door}: Paste did not create a copy of the chart and the shape`);
        const copyChart = (await persistedCharts(page)).find((c) => c.id !== scene.chartA)!;
        expect({ x: copyChart.x, y: copyChart.y }, `${door}: the chart copy lands +20`).toEqual({ x: A_RECT.x + 20, y: A_RECT.y + 20 });
        expect((await controlsOn(page, ci)).map((c) => `${c.x},${c.y}`).sort(), `${door}: the shape copy lands +20`).toEqual(
          [`${S_RECT.x},${S_RECT.y}`, `${S_RECT.x + 20},${S_RECT.y + 20}`].sort(),
        );
        const sel = await eventually(() => selectedObjects(page), (s) => s.length === 2, `${door}: the two copies are not the selection`);
        expect(sel.find((o) => o.type === "chart")?.chartId, `${door}: the selected chart is the copy`).toBe(copyChart.id);
        await gridKey(page, "Control+z");
        await eventually(() => held(page, ci), (h) => h.charts === 1 && h.shapes === 1, `${door}: one Ctrl+Z did not remove both copies`);
      }

      // ---- A floating-grid cell selected on the canvas: Edit > Copy is the grid's refusal, no object copied.
      await callModule(page, MOD.OBJ_CLIP, "resetObjectClipboard");
      await callModule(page, MOD.FLOATING_RANGES, "createFloatingRange", [640, 96, "FloatX12"]);
      const fr = await eventually(async () => (await objects(page)).find((o) => o.type === "floating-range"), (o) => !!o, "the floating grid was not published");
      await clickObject(page, fr!, { at: { dx: 28 + 32, dy: 20 + 16 + 10 } });
      await eventually(() => grid.nameBox.inputValue(), (v) => v === "FloatX12!A1", "precondition: the floating grid's A1 is not the selected cell");
      await startToasts(page);
      await editMenuCopy(page);
      await page.waitForTimeout(800);
      expect(await callModule<boolean>(page, MOD.OBJ_CLIP, "hasObjectClipboard"), "Edit > Copy on a floating-grid cell copied an OBJECT").toBe(false);
      const t = await toasts(page);
      expect(t.length, `ONE refusal toast: ${JSON.stringify(t)}`).toBe(1);
      expect(t[0].text).toContain("floating range");

      // ---- On a worksheet, the doors are the cell clipboard.
      await page.keyboard.press("Escape");
      await clickSheetTab(page, 0);
      await eventually(() => sheetsResult(page), (r) => r.activeIndex === 0, "could not return to Sheet1");
      await grid.clickCell("A2");
      await editMenuCopy(page);
      await grid.clickCell("D10");
      await editMenuPaste(page);
      await eventually(() => cellsOn(page, [[0, 9, 3]]), (v) => v[0] === "Jan", "Edit > Copy / Paste on a worksheet did not copy the cell");
      await grid.clickCell("A3");
      await homeButton(page, "copy");
      await grid.clickCell("D11");
      await homeButton(page, "paste");
      await eventually(() => cellsOn(page, [[0, 10, 3]]), (v) => v[0] === "Feb", "the Home tab's Copy / Paste on a worksheet did not copy the cell");
    } finally {
      await page.keyboard.press("Escape").catch(() => {});
      await endClean(page);
    }
  });

  test("W25 (wc-canvas 7): with a cell inside a floating grid selected on a canvas, Ctrl+C copies no object (the range keeps the key)", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(180_000);
    try {
      await canvasScene(page, { shape: false, chartB: false });
      await callModule(page, MOD.OBJ_CLIP, "resetObjectClipboard");
      await callModule(page, MOD.FLOATING_RANGES, "createFloatingRange", [640, 96, "FloatW7"]);
      const fr = await eventually(async () => (await objects(page)).find((o) => o.type === "floating-range"), (o) => !!o, "the floating grid was not published");
      await clickObject(page, fr!, { at: { dx: 28 + 32, dy: 20 + 16 + 10 } });
      await eventually(() => grid.nameBox.inputValue(), (v) => v === "FloatW7!A1", "precondition: the floating grid's A1 is not the selected cell");
      await startToasts(page);
      await gridKey(page, "Control+c");
      await page.waitForTimeout(800);
      expect(await callModule<boolean>(page, MOD.OBJ_CLIP, "hasObjectClipboard"), "Ctrl+C on a floating-grid cell copied an OBJECT").toBe(false);
      console.log(`[fixall-canvas] wc-canvas 7 toasts: ${JSON.stringify(await toasts(page))}`);
      // Positive control: the floating grid's FRAME (no cell) selected, Ctrl+C copies nothing either
      // (a floating grid cannot be copied) -- but a chart selected alone does copy.
      await page.keyboard.press("Escape");
      await clickEmpty(page, 700, 420);
      const chart = (await objects(page)).find((o) => o.type === "chart")!;
      await pick(page, chart);
      await gridKey(page, "Control+c");
      await eventually(() => callModule<boolean>(page, MOD.OBJ_CLIP, "hasObjectClipboard"), (v) => v, "Ctrl+C on a selected chart copied nothing (the key never arrives?)");
    } finally {
      await page.keyboard.press("Escape").catch(() => {});
      await endClean(page);
    }
  });

  test("W25 (wc-canvas 9): ONE object clipboard -- a shape copied on a worksheet pastes onto a canvas, and a chart copied on a canvas pastes onto a worksheet with a shape selected", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      const scene = await canvasScene(page, { shape: false, chartB: false });
      const ci = scene.canvasIndex;
      // A shape on Sheet1.
      await clickSheetTab(page, 0);
      await eventually(() => sheetsResult(page), (r) => r.activeIndex === 0, "could not switch to Sheet1");
      await createShape(page, { sheetIndex: 0, x: 336, y: 120, width: 128, height: 80 });
      const ws = await eventually(async () => shapesOf(await objects(page)), (o) => o.length === 1, "the worksheet shape was not published");
      await pick(page, ws[0], CENTER(ws[0]));
      await gridKey(page, "Control+c");
      await page.waitForTimeout(400);
      // Paste it on the canvas.
      await clickSheetTab(page, ci);
      await eventually(() => sheetsResult(page), (r) => r.activeIndex === ci, "could not switch to the canvas");
      await page.waitForTimeout(800);
      expect.soft(shapesOf(await objects(page)).map((o) => `${o.x},${o.y}`), "the canvas shows Sheet1's shape").toEqual([]);
      await clickEmpty(page, 700, 420);
      await gridKey(page, "Control+v");
      await eventually(() => controlsOn(page, ci), (c) => c.length === 1, "the worksheet shape's copy was not pasted onto the canvas");
      expect((await controlsOn(page, 0)).length, "the paste landed on the worksheet instead").toBe(1);

      // A chart copied on the canvas pastes onto the worksheet.
      await clickEmpty(page, 700, 420);
      await pick(page, objByChart(await objects(page), scene.chartA));
      await gridKey(page, "Control+c");
      await page.waitForTimeout(400);
      await clickSheetTab(page, 0);
      await eventually(() => sheetsResult(page), (r) => r.activeIndex === 0, "could not switch back to Sheet1");
      await page.waitForTimeout(800);
      const ws2 = await eventually(async () => shapesOf(await objects(page)), (o) => o.some((x) => x.x === 336 && x.y === 120), "the worksheet shape is not published after the switch");
      expect.soft(ws2.map((o) => `${o.x},${o.y}`), "Sheet1 shows a shape that belongs to the canvas").toEqual(["336,120"]);
      const wsShape = ws2.find((x) => x.x === 336 && x.y === 120)!;
      await pick(page, wsShape, CENTER(wsShape));
      await gridKey(page, "Control+v");
      await eventually(
        async () => (await persistedCharts(page)).filter((c) => c.sheetIndex === 0).length,
        (n) => n === 1,
        "the canvas chart's copy was not pasted onto the worksheet",
      );
      expect((await controlsOn(page, 0)).length, "the worksheet paste created a shape instead of the chart").toBe(1);
    } finally {
      await endClean(page);
    }
  });

  test("W25 + X12 + Y11 (wc-canvas 8): on a SUBSCRIBED canvas Ctrl+D, Ctrl+V, Edit > Paste and Home > Paste each show the canvas's one 'publisher's layout' note and create nothing, while Ctrl+C still copies", async ({
    appPage: page,
  }) => {
    test.setTimeout(360_000);
    const workspace = path.join(nodeOs.tmpdir(), "calcula-fixall-canvas-workspace");
    const app = "fixall-canvas-sub";
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.mkdirSync(workspace, { recursive: true });
    try {
      await canvasScene(page, { shape: false, chartB: false });
      await page.waitForTimeout(900);
      const published = await invoke<{ version: string }>(page, "calp_publish", {
        params: { registryPath: workspace, packageName: app, version: "1.0.0", kind: "report", sheetIndices: [], publishedBy: "e2e", includeComments: false },
      });
      expect(published.version, "precondition: the application was published").toBe("1.0.0");

      await newFile(page);
      await callModule(page, MOD.COLLABORATION, "subscribeToApplication", [{ registryPath: workspace, packageName: app, versionPin: "1.0.0" }]);
      await page.evaluate(
        async ({ mod, app }) => {
          const ev = (await (window as unknown as { __appImport: (p: string) => Promise<unknown> }).__appImport(mod)) as {
            emitAppEvent: (n: string, d?: unknown) => void;
            AppEvents: Record<string, string>;
          };
          ev.emitAppEvent(ev.AppEvents.SHEET_CHANGED, {});
          ev.emitAppEvent(ev.AppEvents.PACKAGE_UPDATED, { packageName: app, version: "1.0.0", kind: "subscribe" });
        },
        { mod: MOD.EVENTS, app },
      );
      const after = await eventually(() => sheetsResult(page), (r) => r.sheets.some((s) => s.kind === "canvas"), "the canvas did not arrive with the pull");
      const pc = after.sheets.find((s) => s.kind === "canvas")!;
      await clickSheetTab(page, pc.index);
      const chart = await eventually(async () => (await objects(page)).find((o) => o.type === "chart"), (o) => !!o, "the pulled chart was not published", 15000);
      const chartsBefore = (await persistedCharts(page)).filter((c) => c.sheetIndex === pc.index).length;
      await pick(page, chart!);

      const refusedOnce = async (label: string, act: () => Promise<void>) => {
        await startToasts(page);
        await act();
        await page.waitForTimeout(1500);
        const t = await toasts(page);
        expect(t.length, `${label}: ONE note, got ${JSON.stringify(t)}`).toBe(1);
        expect(t[0].text, `${label}: not the publisher's-layout note`).toContain("layout is the publisher's");
        expect((await persistedCharts(page)).filter((c) => c.sheetIndex === pc.index).length, `${label}: an object was added to the subscribed canvas`).toBe(chartsBefore);
        await dismissToasts(page);
      };

      // Ctrl+C is a read: it still copies.
      await callModule(page, MOD.OBJ_CLIP, "resetObjectClipboard");
      await gridKey(page, "Control+c");
      await eventually(() => callModule<boolean>(page, MOD.OBJ_CLIP, "hasObjectClipboard"), (v) => v, "Ctrl+C on a subscribed canvas copied nothing");
      await refusedOnce("Ctrl+D", () => gridKey(page, "Control+d"));
      await refusedOnce("Ctrl+V", () => gridKey(page, "Control+v"));
      await refusedOnce("Edit > Paste", () => editMenuPaste(page));
      await refusedOnce("Home > Paste", () => homeButton(page, "paste"));
    } finally {
      await page.keyboard.press("Escape").catch(() => {});
      await endClean(page);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // V5 / V6 / V7 -- chart parameters, the sheet-switch flash, the parked tab
  // -------------------------------------------------------------------------

  test("V5: a chart on a canvas reads its param cell (=D1) and writes its point selection (=F1) on the sheet its data comes from, with no dialog", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      await seedSheet1(page);
      const sheet1Id = (await sheetsResult(page)).sheets[0].sheetId!;
      const c = await fittedCanvas(page);
      const setSheet1 = async (row: number, col: number, v: string) =>
        page.evaluate(
          async ({ mod, row, col, v }) => {
            const m = (await (window as unknown as { __appImport: (p: string) => Promise<unknown> }).__appImport(mod)) as {
              CellRange: { fromCell: (r: number, c: number, s?: number) => { setValue: (v: string) => Promise<unknown> } };
            };
            await m.CellRange.fromCell(row, col, 0).setValue(v);
          },
          { mod: MOD.API_RANGE, row, col, v },
        );

      // ---- A param bound to D1 filters the canvas chart.
      const filterSpec = {
        ...barSpec(sheet1Id, "Param chart"),
        params: [{ name: "T", cellRef: "=D1", value: 0 }],
        transform: [{ type: "filter", field: "Units", predicate: "value > [T]" }],
      };
      const paramChart = await createChart(page, filterSpec, { sheetIndex: c.index, x: 48, y: 48, width: 384, height: 256, name: "ParamChart" });
      await eventually(async () => (await chartData(page, paramChart))?.values ?? null, (v) => JSON.stringify(v) === "[10,40,20,30]", "precondition: with D1 empty the chart shows all four values");
      await setSheet1(0, 3, "25");
      await eventually(
        async () => (await chartData(page, paramChart))?.values ?? null,
        (v) => JSON.stringify(v) === "[40,30]",
        "Sheet1!D1 = 25 did not filter the canvas chart (it read the canvas, not its data sheet?)",
        15000,
      );
      await setSheet1(0, 3, "0");
      await eventually(async () => (await chartData(page, paramChart))?.values ?? null, (v) => JSON.stringify(v) === "[10,40,20,30]", "Sheet1!D1 = 0 did not unfilter the chart", 15000);

      // ---- A point selection writes its category to Sheet1!F1.
      const pickSpec = {
        ...barSpec(sheet1Id, "Pick chart"),
        params: [{ name: "picked", select: "point", on: "category", writeTo: "=F1" }],
      };
      const pickChart = await createChart(page, pickSpec, { sheetIndex: c.index, x: 480, y: 48, width: 384, height: 256, name: "PickChart" });
      const pickObj = objByChart(await objects(page), pickChart);
      await pick(page, pickObj);
      const mar = (await chartData(page, pickChart))?.bars?.find((b) => b.categoryName === "Mar");
      expect(mar, "precondition: the Mar bar has hit geometry").toBeTruthy();
      await startToasts(page);
      await clickObject(page, pickObj, { at: { dx: mar!.x + mar!.width / 2, dy: mar!.y + mar!.height / 2 } });
      await eventually(() => cellsOn(page, [[0, 0, 5]]), (v) => v[0] === "Mar", "clicking the Mar bar did not write 'Mar' to Sheet1!F1");
      expect(await cellsOn(page, [[c.index, 0, 5]]), "the write-back landed on the canvas's own grid").toEqual([""]);
      expect(visibleNativeDialogs().map((d) => d.title), "a dialog opened for the write-back").toEqual([]);
      const t = await toasts(page);
      expect(t.filter((x) => /refus|cannot|could not/i.test(x.text)), `a refusal toast appeared: ${JSON.stringify(t)}`).toEqual([]);
    } finally {
      dismissNativeDialogs();
      await endClean(page);
    }
  });

  test("V6: leaving a canvas at 75% zoom for a worksheet paints the worksheet's FIRST frame with its own headings, gridlines and 100% zoom -- no one-frame flash of the canvas's view", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      // A solid red block A1:J40 on Sheet1: where it is painted says what the frame shows.
      const rows = Array.from({ length: 40 }, (_, i) => i);
      const cols = Array.from({ length: 10 }, (_, i) => i);
      await callModule(page, MOD.TAURI_API, "applyFormatting", [rows, cols, { backgroundColor: "#ff0000" }]);
      await page.evaluate(() => window.dispatchEvent(new Event("grid:refresh")));
      const canvas = await addCanvas(page);
      await callModule(page, MOD.GRID_API, "setZoomLevel", [75]);
      await eventually(() => page.evaluate(() => (window as unknown as { __CALCULA_GRID_STATE__: { zoom: number } }).__CALCULA_GRID_STATE__.zoom), (z) => Math.abs(z - 0.75) < 0.001, "precondition: the canvas is not at 75%");
      await page.waitForTimeout(600);
      // Warm both directions once (the persisted zoom of each sheet).
      await clickSheetTab(page, 0);
      await eventually(() => page.evaluate(() => (window as unknown as { __CALCULA_GRID_STATE__: { zoom: number } }).__CALCULA_GRID_STATE__.zoom), (z) => z === 1, "precondition: Sheet1 is not at 100%");
      await clickSheetTab(page, canvas.index);
      await eventually(() => page.evaluate(() => (window as unknown as { __CALCULA_GRID_STATE__: { zoom: number } }).__CALCULA_GRID_STATE__.zoom), (z) => Math.abs(z - 0.75) < 0.001, "precondition: the canvas did not come back at 75%");
      await page.waitForTimeout(800);

      // Sample every frame: the state AND three pixels of the grid canvas.
      await page.evaluate(() => {
        const w = window as unknown as { __v6: unknown[]; __v6on: boolean; __CALCULA_GRID_STATE__: Record<string, unknown> & { sheetContext: { activeSheetIndex: number } } };
        w.__v6 = [];
        w.__v6on = true;
        const c = document.querySelector("canvas") as HTMLCanvasElement;
        let ctx: CanvasRenderingContext2D | null = null;
        try {
          ctx = c.getContext("2d");
        } catch {
          ctx = null;
        }
        const scale = c.width / c.getBoundingClientRect().width;
        const px = (x: number, y: number): number[] | null => {
          if (!ctx) return null;
          const d = ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data;
          return [d[0], d[1], d[2]];
        };
        const tick = (): void => {
          if (!w.__v6on) return;
          const s = w.__CALCULA_GRID_STATE__;
          w.__v6.push({
            idx: s.sheetContext.activeSheetIndex,
            surface: s.surface,
            zoom: s.zoom,
            headings: s.displayHeadings,
            gridlines: s.displayGridlines,
            header: px(8, 150),
            cell: px(200, 150),
            // Mid-column I at 100% (22px row header, 64.29px columns: I spans
            // 536..600). x=600 sat ON the I/J gridline, so every settled frame
            // read "not red" there and the whole switch counted as a flash. At
            // 75% the red block ends near 499, so this still tells the zooms apart.
            far: px(570, 150),
          });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await page.waitForTimeout(300);
      await page.locator('button[data-sheet-tab="0"]').click();
      await page.waitForTimeout(1500);
      type Frame = { idx: number; surface: string; zoom: number; headings: boolean; gridlines: boolean; header: number[] | null; cell: number[] | null; far: number[] | null };
      const frames = await page.evaluate(() => {
        const w = window as unknown as { __v6: unknown[]; __v6on: boolean };
        w.__v6on = false;
        return w.__v6;
      }) as Frame[];
      const red = (p: number[] | null) => !!p && p[0] > 200 && p[1] < 90 && p[2] < 90;
      console.log(`[fixall-canvas] V6 frames: ${frames.length}; ${frames.slice(0, 40).map((f) => `${f.idx}/${f.zoom}/${f.headings ? "H" : "-"}/${red(f.header) ? "R" : "."}${red(f.cell) ? "R" : "."}${red(f.far) ? "R" : "."}`).join(" ")}`);
      // Positive control: the sampler saw the canvas at 75% before the click, and then Sheet1.
      expect(frames.some((f) => f.idx === canvas.index && Math.abs(f.zoom - 0.75) < 0.001), "the sampler never saw the canvas at 75%").toBe(true);
      const sheetFrames = frames.filter((f) => f.idx === 0);
      expect(sheetFrames.length, "the sampler never saw Sheet1").toBeGreaterThan(0);
      // State: every frame on Sheet1 has Sheet1's own view.
      const badState = sheetFrames.filter((f) => f.zoom !== 1 || f.headings !== true || f.gridlines !== true);
      expect(badState.map((f) => `${f.zoom}/${f.headings}/${f.gridlines}`), "a frame on Sheet1 carried the canvas's zoom / headings / gridlines").toEqual([]);
      // Pixels: every frame that PAINTS worksheet cells paints them with headings at 100%.
      if (frames.some((f) => f.cell !== null)) {
        const painted = frames.filter((f) => red(f.cell));
        expect(painted.length, "no sampled frame painted Sheet1's cells").toBeGreaterThan(0);
        const flashed = painted.filter((f) => red(f.header) || !red(f.far));
        expect(flashed.length, `${flashed.length} painted frame(s) showed Sheet1's cells without headings or not at 100% (the flash)`).toBe(0);
      } else {
        console.log("[fixall-canvas] V6: the grid canvas could not be read (no 2d context); only the state half was checked");
      }
    } finally {
      await endClean(page);
    }
  });

  test("V7: the Canvas tab follows the sheet ON SCREEN during a parked edit -- a floating-grid edit parked from canvas CV loses it over a worksheet and gets it back when the edit returns to CV (host tab, or Enter); a canvas tab is never a point-mode target, so the view AND the tab stay put; a Core edit pointing across worksheets never shows it", async ({
    appPage: page,
    grid,
  }) => {
    test.setTimeout(300_000);
    try {
      await newFile(page);
      await seedSheet1(page);
      await invoke(page, "update_cell", { row: 1, col: 4, value: "42" }); // Sheet1!E2
      const cv = await fittedCanvas(page); // index 1
      const c2 = await fittedCanvas(page); // index 2
      const ws2 = await addWorksheet(page); // index 3
      await clickSheetTab(page, cv.index);
      await eventually(() => sheetsResult(page), (r) => r.activeIndex === cv.index, "could not return to CV");
      const fr = await callModule<{ id: string }>(page, MOD.FLOATING_RANGES, "createFloatingRange", [640, 96, "FloatV7"]);
      const frObj = await eventually(async () => (await objects(page)).find((o) => o.type === "floating-range"), (o) => !!o, "the floating grid was not published");
      const canvasTab = () => hasRibbonTab(page, "Canvas");
      expect(await canvasTab(), "precondition: the Canvas tab is up on CV").toBe(true);
      await installAppImport(page);
      await page.evaluate(() => {
        const w = window as unknown as { __e2eFms?: unknown[]; __e2eFmsHooked?: boolean };
        w.__e2eFms = [];
        if (!w.__e2eFmsHooked) {
          window.addEventListener("sheet:formulaModeSwitch", (e) => w.__e2eFms!.push((e as CustomEvent).detail ?? null));
          w.__e2eFmsHooked = true;
        }
      });
      /** What the tab logic reads, for a failure message. */
      const tabState = async () =>
        page.evaluate(async () => {
          const w = window as unknown as { __appImport: (p: string) => Promise<unknown>; __e2eFms?: unknown[]; __CALCULA_GRID_STATE__?: { sheetContext?: { activeSheetIndex: number } } };
          const ov = (await w.__appImport("/src/api/gridOverlays.ts")) as { isPointModeOnForeignSheet: () => boolean };
          const ex = (await w.__appImport("/src/api/externalEdit.ts")) as { getParkedViewSheetIndex: () => number | null };
          const ct = (await w.__appImport("/extensions/CanvasSheet/lib/canvasTab.ts")) as { isCanvasTabRegistered: () => boolean; viewedSheetIsCanvas: () => boolean };
          return {
            foreign: ov.isPointModeOnForeignSheet(),
            parked: ex.getParkedViewSheetIndex(),
            registered: ct.isCanvasTabRegistered(),
            viewedIsCanvas: ct.viewedSheetIsCanvas(),
            gridActive: w.__CALCULA_GRID_STATE__?.sheetContext?.activeSheetIndex,
            switches: JSON.stringify(w.__e2eFms ?? []),
          };
        });
      const tabIs = async (want: boolean, label: string) => {
        const ok = await eventually(canvasTab, (v) => v === want, "", 8000).then(() => true, () => false);
        if (!ok) throw new Error(`${label} -- ${JSON.stringify(await tabState())}`);
      };

      const viewed = () => page.evaluate(() => (window as unknown as { __CALCULA_GRID_STATE__?: { sheetContext?: { activeSheetIndex: number } } }).__CALCULA_GRID_STATE__?.sheetContext?.activeSheetIndex ?? -1);
      const clickTab = async (i: number) => {
        await page.locator(`button[data-sheet-tab="${i}"]`).click();
        await page.waitForTimeout(600);
      };

      // ---- A floating-grid edit parked across sheets.
      const a1 = await sheetPointToPage(page, frObj!.x + 28 + 32, frObj!.y + 20 + 16 + 10);
      await page.mouse.dblclick(a1.x, a1.y);
      await page.waitForTimeout(300);
      await page.keyboard.type("=");
      await eventually(() => grid.formulaBar.inputValue(), (v) => v === "=", "precondition: the floating-grid edit did not open");
      // Another canvas is never a reference target: the view stays on CV, and so does the tab.
      await clickTab(c2.index);
      expect(await viewed(), "a click on canvas C2 moved a formula edit's view onto a canvas").toBe(cv.index);
      expect(await grid.formulaBar.inputValue(), "the click on C2 ended the edit").toBe("=");
      await tabIs(true, "over CV (C2 refused) the Canvas tab went away");
      // A worksheet: the view moves, the tab goes.
      await clickTab(0);
      expect(await viewed(), "precondition: the parked edit did not point at Sheet1").toBe(0);
      await tabIs(false, "over the worksheet the Canvas tab stayed up");
      // C2 again: refused, the view stays on Sheet1 -- and the tab stays away with it.
      await clickTab(c2.index);
      expect(await viewed(), "from Sheet1, a click on canvas C2 moved the view onto a canvas").toBe(0);
      await tabIs(false, "the Canvas tab came up while Sheet1 is on screen");
      // The host tab brings the edit back: CV on screen, tab up.
      await clickTab(cv.index);
      await eventually(viewed, (v) => v === cv.index, "the host tab did not bring the parked edit back to CV");
      await tabIs(true, "back on CV the Canvas tab did not come back");
      expect(await grid.formulaBar.inputValue(), "the edit did not survive the way back").toBe("=");
      // Out again, point at Sheet1!E2, Enter: committed, back on CV, tab up.
      await clickTab(0);
      await tabIs(false, "over the worksheet (again) the Canvas tab stayed up");
      await grid.clickCell("E2");
      await eventually(() => grid.formulaBar.inputValue(), (v) => v === "=Sheet1!E2", "clicking Sheet1!E2 did not point into the floating-grid edit");
      await page.keyboard.press("Enter");
      await eventually(() => sheetsResult(page), (r) => r.activeIndex === cv.index, "Enter did not return to CV");
      await tabIs(true, "after Enter returned to CV the Canvas tab is not up");
      const cell = await callModule<Array<{ formula: string | null }>>(page, MOD.FLOATING_RANGES, "getFloatingRangeCells", [fr.id, 0, 0, 0, 0]);
      expect(cell[0]?.formula, "the parked edit was not committed").toBe("=Sheet1!E2");

      // ---- Core's own edit started on a worksheet.
      await clickSheetTab(page, 0);
      await eventually(() => sheetsResult(page), (r) => r.activeIndex === 0, "could not switch to Sheet1");
      await grid.clickCell("G5");
      await page.keyboard.type("=");
      await eventually(() => grid.formulaBar.inputValue(), (v) => v === "=", "precondition: Core's edit did not open");
      await tabIs(false, "precondition: a Canvas tab on the worksheet");
      await clickTab(c2.index);
      expect(await viewed(), "a Core edit's view moved onto canvas C2").toBe(0);
      await tabIs(false, "a Core edit whose view stayed on Sheet1 shows the Canvas tab");
      await clickTab(ws2.index);
      await eventually(viewed, (v) => v === ws2.index, "a Core edit did not point at the other worksheet");
      await tabIs(false, "a Core edit pointing at another worksheet shows the Canvas tab");
      await page.keyboard.press("Escape");
      await eventually(() => sheetsResult(page), (r) => r.activeIndex === 0, "Escape did not return to Sheet1");
    } finally {
      await page.keyboard.press("Escape").catch(() => {});
      await endClean(page);
    }
  });

  // -------------------------------------------------------------------------
  // M3 / X14 -- chart ranges that name their sheet by INDEX only
  // -------------------------------------------------------------------------

  /** Sheet1 (the chart host), Sheet2 (1,2,3,4), Sheet3 (5,6,7,8) and optionally Sheet4 (91..94); returns their ids. */
  async function fourSheets(page: Page, withSheet4: boolean): Promise<string[]> {
    await newFile(page);
    await seedSheet1(page);
    await addWorksheet(page);
    await addWorksheet(page);
    if (withSheet4) await addWorksheet(page);
    const put = async (sheet: number, values: string[]) => {
      await page.evaluate(
        async ({ mod, sheet, values }) => {
          const m = (await (window as unknown as { __appImport: (p: string) => Promise<unknown> }).__appImport(mod)) as {
            CellRange: { fromCell: (r: number, c: number, s?: number) => { setValue: (v: string) => Promise<unknown> } };
          };
          const months = ["Month", "Jan", "Feb", "Mar", "Apr"];
          for (let r = 0; r < 5; r++) {
            await m.CellRange.fromCell(r, 0, sheet).setValue(months[r]);
            await m.CellRange.fromCell(r, 1, sheet).setValue(r === 0 ? "Units" : values[r - 1]);
          }
        },
        { mod: MOD.API_RANGE, sheet, values },
      );
    };
    await put(1, ["1", "2", "3", "4"]);
    await put(2, ["5", "6", "7", "8"]);
    if (withSheet4) await put(3, ["91", "92", "93", "94"]);
    await clickSheetTab(page, 0);
    await eventually(() => sheetsResult(page), (r) => r.activeIndex === 0, "could not return to Sheet1");
    return (await sheetsResult(page)).sheets.map((s) => s.sheetId!);
  }

  /** Store an index-only chart straight in the backend (the MCP/script route); returns its id. */
  async function indexOnlyChart(page: Page, spec: Record<string, unknown>, placement: { x: number; y: number }): Promise<string> {
    const id = await page.evaluate(() => crypto.randomUUID());
    const def = { chartId: id, name: "IndexOnly", sheetIndex: 0, x: placement.x, y: placement.y, width: 320, height: 208, spec };
    await invoke(page, "save_chart", { entry: { id, sheetIndex: 0, specJson: JSON.stringify(def) } });
    return id;
  }

  const dataOf = async (page: Page, id: string) => (await persistedCharts(page)).find((c) => c.id === id)!.spec.data as { sheetIndex: number; sheetId?: string };

  test("M3 (BUG-0204): a workbook whose chart range names its sheet by INDEX only opens with the range already pinned to its sheet id and the document clean; deleting a sheet before the source, saving and reopening keeps the chart on its sheet", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    const doc = path.join(nodeOs.tmpdir(), "calcula-fixall-canvas-m3.cala");
    try {
      const ids = await fourSheets(page, false);
      const id = await indexOnlyChart(page, barSpec(undefined, "IndexOnly", 2), { x: 320, y: 40 });
      expect((await dataOf(page, id)).sheetId, "precondition: the stored range names its sheet by index only").toBeUndefined();
      await invoke(page, "save_file", { path: doc });
      await newFile(page);
      await openFileAtPath(page, doc);
      // RIGHT after the open: the backend already holds the id, and the document is clean.
      const d = await eventually(() => dataOf(page, id), (x) => !!x, "the chart did not survive the reopen");
      expect(d.sheetId, "the load did not pin the index-only range to its sheet's id").toBe(ids[2]);
      expect(await isDirty(page), "opening the workbook marked it unsaved (the stamp dirtied it)").toBe(false);
      await eventually(async () => (await chartData(page, id))?.values ?? null, (v) => JSON.stringify(v) === "[5,6,7,8]", "the reopened chart does not plot Sheet3");

      // Delete Sheet2 (before the source), save, reopen: still Sheet3's data.
      await callModule(page, MOD.TAURI_API, "deleteSheet", [1]);
      await eventually(() => dataOf(page, id), (x) => x.sheetId === ids[2], "deleting Sheet2 re-pointed the chart away from the former Sheet3");
      await eventually(async () => (await chartData(page, id))?.values ?? null, (v) => JSON.stringify(v) === "[5,6,7,8]", "after deleting Sheet2 the chart does not plot the former Sheet3");
      console.log(`[fixall-canvas] M3 after delete: ${JSON.stringify(await dataOf(page, id))}`);
      await invoke(page, "save_file", { path: doc });
      await newFile(page);
      await openFileAtPath(page, doc);
      const d2 = await eventually(() => dataOf(page, id), (x) => !!x, "the chart did not survive the second reopen");
      expect(d2.sheetId, "after delete + save + reopen the chart does not name the former Sheet3").toBe(ids[2]);
      await eventually(async () => (await chartData(page, id))?.values ?? null, (v) => JSON.stringify(v) === "[5,6,7,8]", "after delete + reopen the chart does not plot the former Sheet3's values");
    } finally {
      await endClean(page);
      fs.rmSync(doc, { force: true });
    }
  });

  test("X14: an index-only chart dragged and, within 300 ms, Sheet2 deleted keeps the former Sheet3's data AND its dragged position (after the reload and after reopen); dragged and then its own data sheet deleted, it charts nothing else", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);
    const doc = path.join(nodeOs.tmpdir(), "calcula-fixall-canvas-x14.cala");
    try {
      const ids = await fourSheets(page, false);
      const id = await indexOnlyChart(page, barSpec(undefined, "IndexOnly", 2), { x: 320, y: 40 });
      // The frontend learns of it the way a backend-initiated create announces it -- without a stamp.
      await callModule(page, MOD.CHART_STORE, "loadChartsFromBackend", [{ stampSheetIds: false }]);
      await callModule(page, MOD.CHART_STORE, "syncChartRegions");
      await eventually(async () => (await chartData(page, id))?.values ?? null, (v) => JSON.stringify(v) === "[5,6,7,8]", "precondition: the chart does not plot Sheet3");
      expect((await dataOf(page, id)).sheetId, "precondition: the stored range is index-only").toBeUndefined();

      const dragThenDelete = async (sheetToDelete: number) => {
        const o = objByChart(await objects(page), id);
        const geo = await readGridGeometry(page);
        const start = await sheetPointToPage(page, o.x + 24, o.y + 24);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + 24 * geo.zoom, start.y, { steps: 3 });
        await page.mouse.move(start.x + 48 * geo.zoom, start.y, { steps: 3 });
        await page.mouse.up();
        // Within the 300 ms save debounce: delete the sheet through the tab strip's own route.
        await callModule(page, MOD.TAURI_API, "deleteSheet", [sheetToDelete]);
      };

      await dragThenDelete(1);
      const after = await eventually(
        async () => (await persistedCharts(page)).find((c) => c.id === id)!,
        (c) => c.x === 320 + 48 && (c.spec.data as { sheetIndex: number }).sheetIndex === 1,
        "after the drag + Sheet2 delete the chart is not on the former Sheet3 at its dragged position",
        15000,
      );
      const sid = (after.spec.data as { sheetId?: string }).sheetId;
      expect(sid === undefined || sid === ids[2], `the chart's range was pinned to the WRONG sheet (${sid})`).toBe(true);
      await eventually(async () => (await chartData(page, id))?.values ?? null, (v) => JSON.stringify(v) === "[5,6,7,8]", "after the reload the chart does not plot the former Sheet3");

      await invoke(page, "save_file", { path: doc });
      await newFile(page);
      await openFileAtPath(page, doc);
      const reopened = await eventually(async () => (await persistedCharts(page)).find((c) => c.id === id), (c) => !!c, "the chart did not survive the reopen");
      expect({ x: reopened!.x, sheetIndex: (reopened!.spec.data as { sheetIndex: number }).sheetIndex }).toEqual({ x: 368, sheetIndex: 1 });
      await eventually(async () => (await chartData(page, id))?.values ?? null, (v) => JSON.stringify(v) === "[5,6,7,8]", "after reopen the chart does not plot the former Sheet3");

      // Drag, then delete the chart's OWN data sheet (index 1 now) within 300 ms.
      const consoleLines: string[] = [];
      const onConsole = (m: { type: () => string; text: () => string }) => consoleLines.push(`${m.type()}: ${m.text().slice(0, 400)}`);
      page.on("console", onConsole);
      try {
        await dragThenDelete(1);
        await eventually(
          async () => consoleLines.filter((l) => l.includes(`Failed to render chart ${id}`)),
          (v) => v.length > 0,
          "with its data sheet deleted the chart did not report a failed read (it would keep painting its last data)",
          10000,
        );
      } finally {
        page.off("console", onConsole);
      }
      const d3 = await dataOf(page, id);
      expect(d3.sheetId, "with its data sheet deleted the chart was re-pointed at ANOTHER sheet").toBe(ids[2]);
      expect((await persistedCharts(page)).find((c) => c.id === id)?.x, "the second drag was lost").toBe(368 + 48);
      console.log(`[fixall-canvas] X14 data-sheet deleted: data=${JSON.stringify(d3)} report=${consoleLines.find((l) => l.includes("Failed to render chart"))?.slice(0, 300)}`);
    } finally {
      await endClean(page);
      fs.rmSync(doc, { force: true });
    }
  });

  test("X14 list case: a pending edit that APPENDS a layer to an index-only layered chart, with Sheet2 deleted within 300 ms, keeps the line layer on the former Sheet3 (never Sheet4) and keeps the appended layer, also after reopen; a pending REMOVAL keeps the remaining layer on its own sheet", async ({
    appPage: page,
  }) => {
    test.setTimeout(300_000);
    const doc = path.join(nodeOs.tmpdir(), "calcula-fixall-canvas-x14b.cala");
    try {
      const ids = await fourSheets(page, true);
      const range = (sheetIndex: number) => ({ sheetIndex, startRow: 0, startCol: 0, endRow: 4, endCol: 1 });
      const layered = (layers: unknown[]) => ({ ...barSpec(ids[0], "Layered", 0), layers });
      const lineOn3 = { mark: "line", data: range(2), series: [{ sourceIndex: 1, name: "S3", color: "#ED7D31" }] };
      const pointOn4 = { mark: "point", data: range(3), series: [{ sourceIndex: 1, name: "S4", color: "#70AD47" }] };

      // ---- Append.
      const a = await indexOnlyChart(page, layered([lineOn3]), { x: 320, y: 40 });
      await callModule(page, MOD.CHART_STORE, "loadChartsFromBackend", [{ stampSheetIds: false }]);
      await callModule(page, MOD.CHART_STORE, "syncChartRegions");
      await page.waitForTimeout(800);
      await callModule(page, MOD.CHART_STORE, "updateChartSpec", [a, { layers: [lineOn3, { mark: "point", data: range(2), series: [{ sourceIndex: 1, name: "Marker", color: "#000000" }] }] }]);
      await callModule(page, MOD.TAURI_API, "deleteSheet", [1]);
      const layersOf = async (id: string) => ((await persistedCharts(page)).find((c) => c.id === id)!.spec.layers ?? []) as Array<{ data: { sheetIndex: number; sheetId?: string } }>;
      const la = await eventually(() => layersOf(a), (l) => l.length === 2, "the appended layer was lost", 15000);
      expect(la[0].data.sheetIndex, "the line layer does not read the former Sheet3 (index 1)").toBe(1);
      expect(la[0].data.sheetId === undefined || la[0].data.sheetId === ids[2], `the line layer was pinned to the wrong sheet (${la[0].data.sheetId})`).toBe(true);
      await invoke(page, "save_file", { path: doc });
      await newFile(page);
      await openFileAtPath(page, doc);
      const la2 = await eventually(() => layersOf(a), (l) => l.length === 2, "after reopen the appended layer is gone");
      expect(la2[0].data, "after reopen the line layer is not on the former Sheet3").toMatchObject({ sheetIndex: 1, sheetId: ids[2] });

      // ---- Removal: two layers, a pending edit drops the first; the remaining one keeps its own sheet.
      const ids2 = await fourSheets(page, true);
      const b = await indexOnlyChart(page, layered([lineOn3, pointOn4]), { x: 320, y: 40 });
      await callModule(page, MOD.CHART_STORE, "loadChartsFromBackend", [{ stampSheetIds: false }]);
      await callModule(page, MOD.CHART_STORE, "syncChartRegions");
      await page.waitForTimeout(800);
      await callModule(page, MOD.CHART_STORE, "updateChartSpec", [b, { layers: [pointOn4] }]);
      await callModule(page, MOD.TAURI_API, "deleteSheet", [1]);
      const lb = await eventually(() => layersOf(b), (l) => l.length === 1, "the removal did not land", 15000);
      expect(lb[0].data.sheetIndex, "the remaining layer no longer reads the former Sheet4 (index 2)").toBe(2);
      expect(lb[0].data.sheetId === undefined || lb[0].data.sheetId === ids2[3], `the remaining layer was pinned to the wrong sheet (${lb[0].data.sheetId})`).toBe(true);
    } finally {
      await endClean(page);
      fs.rmSync(doc, { force: true });
    }
  });

  // -------------------------------------------------------------------------
  // M1 -- a BI query result block follows its sheet
  // -------------------------------------------------------------------------

  test("M1 (BUG-0138): a BI result block on Sheet2 refreshes onto Sheet2 after Sheet2 is moved to the front (Sheet1!A1 keeps 'x', the block refuses edits); with Sheet2 deleted a refresh writes nothing and does not fail; on 'My Data' the result names are quoted and =SUM() works", async ({
    appPage: page,
  }) => {
    test.setTimeout(420_000);
    let conn: { connectionId: string; dir: string } | null = null;
    try {
      await newFile(page);
      await invoke(page, "update_cell", { row: 0, col: 0, value: "x" });
      conn = await createStarConnectionLive(page, "Sales star (fixall canvas M1)");
      const request = { measures: ["Revenue"], groupBy: [{ table: "Product", column: "Category" }], filters: [] };
      const result = await invoke<{ columns: unknown[]; rowCount: number }>(page, "bi_query", { connectionId: conn.connectionId, request, scriptId: null });
      expect(result.rowCount, "precondition: the query returned rows").toBeGreaterThan(0);
      const s2 = await addWorksheet(page);
      await invoke(page, "bi_insert_result", {
        request: { connectionId: conn.connectionId, sheetIndex: s2.index, startRow: 0, startCol: 0 },
        queryResult: result,
        queryRequest: request,
      });
      const header = (await cellsOn(page, [[s2.index, 0, 0]]))[0];
      expect(header, "precondition: the block's header is on Sheet2!A1").not.toBe("");
      await clickSheetTab(page, 0);

      // ---- Move Sheet2 to the front, Refresh.
      await callModule(page, MOD.TAURI_API, "moveSheet", [s2.index, 0]);
      const moved = await eventually(() => sheetsResult(page), (r) => r.sheets[0].name === s2.name, "Sheet2 did not move to the front");
      const sheet1Now = moved.sheets.find((s) => s.name === "Sheet1")!.index;
      await invoke(page, "bi_refresh_connection", { connectionId: conn.connectionId });
      expect((await cellsOn(page, [[sheet1Now, 0, 0]]))[0], "the refresh wrote the block over Sheet1 (its old index)").toBe("x");
      expect((await cellsOn(page, [[0, 0, 0]]))[0], "the block is no longer on the moved Sheet2").toBe(header);
      // The block's cells refuse edits on the MOVED sheet; a cell outside it does not.
      await clickSheetTab(page, 0);
      await eventually(() => sheetsResult(page), (r) => r.activeIndex === 0, "could not switch to the moved Sheet2");
      const inBlock = await tryInvoke(page, "update_cell", { row: 1, col: 0, value: "hack" });
      expect("error" in inBlock, "a cell of the refreshed block accepted an edit").toBe(true);
      const outside = await tryInvoke(page, "update_cell", { row: 1, col: 10, value: "ok" });
      expect("ok" in outside, "a cell outside the block refused an edit (positive control)").toBe(true);

      // ---- Delete the block's sheet, Refresh: nothing written, no error.
      await clickSheetTab(page, sheet1Now);
      await callModule(page, MOD.TAURI_API, "deleteSheet", [0]);
      await eventually(() => sheetsResult(page), (r) => r.sheets.length === 1, "the block's sheet was not deleted");
      const refreshed = await tryInvoke(page, "bi_refresh_connection", { connectionId: conn.connectionId });
      expect("ok" in refreshed, `a refresh with the block's sheet deleted failed: ${JSON.stringify(refreshed)}`).toBe(true);
      const sheet1Cells = await cellsOn(page, [[0, 0, 0], [0, 1, 0], [0, 0, 1]]);
      expect(sheet1Cells, "the refresh wrote the orphaned block somewhere").toEqual(["x", "", ""]);

      // ---- A sheet called 'My Data': quoted names, and =SUM(name) calculates.
      const md = await addWorksheet(page);
      await callModule(page, MOD.TAURI_API, "renameSheet", [md.index, "My Data"]);
      await invoke(page, "bi_insert_result", {
        request: { connectionId: conn.connectionId, sheetIndex: md.index, startRow: 0, startCol: 0 },
        queryResult: result,
        queryRequest: request,
      });
      const names = await invoke<Array<{ name: string; refersTo: string }>>(page, "get_all_named_ranges");
      const bi = names.filter((n) => n.name.startsWith("BIResult."));
      console.log(`[fixall-canvas] M1 names: ${JSON.stringify(bi)}`);
      expect(bi.length, "no BIResult.* name was written").toBeGreaterThan(0);
      for (const n of bi) expect(n.refersTo, `${n.name} does not quote the sheet name`).toContain("'My Data'!$");
      const revenue = bi.find((n) => /revenue/i.test(n.name)) ?? bi[bi.length - 1];
      await clickSheetTab(page, 0);
      await invoke(page, "update_cell", { row: 5, col: 5, value: `=SUM(${revenue.name})` });
      const sum = await invoke<Array<{ value: unknown; display: string }>>(page, "get_range_cells_typed", { sheetIndex: 0, startRow: 5, startCol: 5, endRow: 5, endCol: 5 });
      expect(Number(sum[0]?.value), `=SUM(${revenue.name}) does not calculate: ${JSON.stringify(sum)}`).toBeGreaterThan(0);
    } finally {
      await endClean(page);
      if (conn) {
        await invoke(page, "bi_delete_connection", { connectionId: conn.connectionId }).catch(() => undefined);
        fs.rmSync(conn.dir, { recursive: true, force: true });
      }
    }
  });

  // -------------------------------------------------------------------------
  // M2 -- notebook rewind restores each sheet's own snapshot
  // -------------------------------------------------------------------------

  test("M2: a notebook cell that wrote on Sheet1 and Data, then Data moved to the front, Rewind gives each sheet its OWN cells back; after a delete + an add, Rewind is refused with a message", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    const NB = "/extensions/ScriptNotebook/lib/notebookApi.ts";
    try {
      await newFile(page);
      await invoke(page, "update_cell", { row: 0, col: 0, value: "orig-S1" });
      const data = await addWorksheet(page);
      await callModule(page, MOD.TAURI_API, "renameSheet", [data.index, "Data"]);
      await invoke(page, "update_cell", { row: 0, col: 0, value: "orig-D" });
      await clickSheetTab(page, 0);
      await invoke(page, "grant_script_session_approval").catch(() => undefined);

      const nbId = `fixall-m2-${Date.now()}`;
      const doc = await callModule<{ id: string; name: string; cells: Array<Record<string, unknown>> }>(page, NB, "createNotebook", [nbId, "M2"]);
      const src = 'Calcula.workbook.sheet("Sheet1").range("A1").setValue("nb-S1"); Calcula.workbook.sheet("Data").range("A1").setValue("nb-D");';
      const cell = { id: "c1", source: src, lastOutput: [], lastError: null, cellsModified: 0, durationMs: 0, executionIndex: null };
      await callModule(page, NB, "saveNotebook", [{ ...doc, cells: [cell] }]);
      const run = await callModule<{ type: string; message?: string }>(page, NB, "runNotebookCell", [{ notebookId: nbId, cellId: "c1", source: src }]);
      expect(run.type, `the notebook cell failed: ${JSON.stringify(run)}`).toBe("success");
      const a1 = async () => {
        const r = await sheetsResult(page);
        const s1 = r.sheets.find((s) => s.name === "Sheet1")!.index;
        const d = r.sheets.find((s) => s.name === "Data")!.index;
        return (await cellsOn(page, [[s1, 0, 0], [d, 0, 0]])).join("|");
      };
      await eventually(a1, (v) => v === "nb-S1|nb-D", "precondition: the cell's writes did not land on both sheets");

      // Move Data to the front, then Rewind to before the cell.
      await callModule(page, MOD.TAURI_API, "moveSheet", [1, 0]);
      await eventually(() => sheetsResult(page), (r) => r.sheets[0].name === "Data", "Data did not move to the front");
      await callModule(page, NB, "rewindNotebook", [{ notebookId: nbId, targetCellId: "c1" }]);
      await eventually(a1, (v) => v === "orig-S1|orig-D", "after the move, Rewind did not give each sheet its own cells back (swapped?)");

      // Run again, then delete a sheet and add one: Rewind is refused, with a message.
      const run2 = await callModule<{ type: string }>(page, NB, "runNotebookCell", [{ notebookId: nbId, cellId: "c1", source: src }]);
      expect(run2.type).toBe("success");
      await eventually(a1, (v) => v === "nb-S1|nb-D", "precondition: the second run did not land");
      const di = (await sheetsResult(page)).sheets.find((s) => s.name === "Data")!.index;
      await callModule(page, MOD.TAURI_API, "deleteSheet", [di]);
      await addWorksheet(page);
      const refused = await page.evaluate(
        async ({ mod, nbId }) => {
          try {
            const m = (await (window as unknown as { __appImport: (p: string) => Promise<unknown> }).__appImport(mod)) as {
              rewindNotebook: (r: unknown) => Promise<unknown>;
            };
            await m.rewindNotebook({ notebookId: nbId, targetCellId: "c1" });
            return null;
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
        },
        { mod: NB, nbId },
      );
      expect(refused, "after a delete + an add, Rewind was not refused").not.toBeNull();
      console.log(`[fixall-canvas] M2 refusal: ${refused}`);
      const s1 = (await sheetsResult(page)).sheets.find((s) => s.name === "Sheet1")!.index;
      expect((await cellsOn(page, [[s1, 0, 0]]))[0], "the refused rewind still changed Sheet1").toBe("nb-S1");
    } finally {
      await endClean(page);
    }
  });
});

/** A live BI connection over the sales-star fixture (the canvas journey's #11 recipe). */
async function createStarConnectionLive(page: Page, name: string): Promise<{ connectionId: string; dir: string }> {
  const fixtureDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../../../tests/fixtures/model");
  const bundle = JSON.parse(fs.readFileSync(path.join(fixtureDir, "sales_star.json"), "utf8")) as {
    model: { tables: Array<{ name: string; columns: Array<{ name: string; data_type: unknown }> }> } & Record<string, unknown>;
    data: Record<string, { columns: string[]; rows: unknown[][] }>;
  };
  const dir = fs.mkdtempSync(path.join(nodeOs.tmpdir(), "calcula-fixall-model-"));
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  for (const [table, { columns, rows }] of Object.entries(bundle.data)) {
    fs.writeFileSync(path.join(dir, `${table}.csv`), [columns.join(","), ...rows.map((r) => r.map(cell).join(","))].join("\n") + "\n", "utf8");
  }
  const model: Record<string, unknown> = { ...bundle.model };
  model.tables = bundle.model.tables.map((t) => ({
    ...t,
    columns: t.columns.map((c) => (c.data_type === "Int32" ? { ...c, data_type: "Int64" } : c)),
    source_binding: { source_id: "star_csv", schema: "csv", table: t.name },
  }));
  model.sources = [{ id: "star_csv", kind: "csv", connection: { database: dir, default_schema: "csv" }, preferred_auth: "integrated", display_name: "Sales star (CSV)" }];
  const info = await invoke<{ id: string }>(page, "bi_create_connection", {
    request: { name, description: null, connectionString: "", modelJson: { formatVersion: 1, model } },
  });
  await invoke(page, "bi_model_connect_source", { connectionId: info.id, sourceId: "star_csv", connectionString: "", remember: false });
  return { connectionId: info.id, dir };
}
