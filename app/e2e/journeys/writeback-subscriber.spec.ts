/**
 * WRITEBACK, SUBSCRIBER SIDE, LIVE -- the owner's scenario end to end.
 *
 * THE SCENARIO (owner, 2026-10-21). A publisher put Report, Column1, A, B, C in
 * A1:A5, designated B3:B5 as a writeback region (per_subscriber, number,
 * on_submit, own_plus_aggregate, lenient, lifecycle always) and published it as
 * `writeback-test` to the workspace C:\writeback-test. A subscriber did File >
 * New, subscribed, typed 1, 2, 3 into B3:B5 -- and "cannot see if it was
 * written back".
 *
 * WHAT THIS PROVES, in the running app:
 *   1. the pulled sheet's region is reported on the subscriber's LOCAL sheet id
 *      (D1: it used to keep the publisher's id and fall back to sheet index 0),
 *      the "w" frame is painted round B3:B5 and NOT round A3, and the
 *      contextual "Writeback" tab is absent on A1 and present on B3;
 *   2. typing 1, 2, 3 with the KEYBOARD saves exactly three drafts in the
 *      backend, paints the top-right draft marker (against a non-writeback
 *      cell), and badges the tab "3";
 *   3. Submit All (through the tab, the confirm answered by the native-dialog
 *      driver) sends them: the backend says submitted, submission event files
 *      exist in the workspace under the version's submissions folder, the
 *      markers are gone and the success toast says so;
 *   4. editing B3 again and Discard Drafts puts back the last SENT value 1 and
 *      clears the marker;
 *   5. after save + File > New + reopen the region is still on the LOCAL sheet
 *      id, the tab still follows the cursor, and typing still saves a draft;
 *   6. Open Application for Editing (a working copy) gives the author the
 *      application's region back, framed on the sheet with a "w" on its edge,
 *      and the push diff names no removed region (checkout used to drop it).
 *
 * NEVER THE OWNER'S WORKSPACE. C:\writeback-test is COPIED to a temp folder
 * first; a submit writes `submissions/` into the workspace it was subscribed
 * from, and that must never be the owner's.
 *
 * ASSERTIONS. Backend state, DOM, files on disk and RELATIVE pixel samples
 * (samplePixels, both directions: present where it should be, absent where it
 * should not). No goldens -- they are stale (owner UI changes).
 *
 * ROUTES. Subscribe through `@api/collaboration#subscribeToApplication` plus the
 * dialog's own announcements (helpers/calp-collab.ts `subscribe`, the route the
 * calp journeys use). Values are TYPED (grid.setCellValue = click + keyboard +
 * Enter): the commit guard that turns a typed value into a draft runs only on
 * that path; `setCells` (the @api range facade) would bypass it. Submit and
 * Discard are clicked on the ribbon tab; their confirmAsync is a native
 * TaskDialog answered from outside the process (answer-native-dialog.ps1).
 */
import type { Locator, Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../fixtures";
import { parseCellRef, readGridGeometry, type GridHelper } from "../helpers/grid";
import { diffCount, samplePixelPatches } from "../viewportSample";
import {
  activate,
  callModule,
  eventually,
  invoke,
  newFile,
  openAt,
  readCell,
  saveAs,
  sheets,
  toastTexts,
  dismissToasts,
  COLLAB,
} from "../helpers/calp-harness";
import { subscribe, checkout, pushDiff, describeDiff } from "../helpers/calp-collab";

const SOURCE_WS = "C:\\writeback-test";
const APP = "writeback-test";
const VERSION = "1.0.0";
/** The publisher's sheet id in the owner's signed manifest. */
const PUBLISHER_SHEET_ID = "01a15d70-b30a-7e15-800c-62a1c4efa4d7";

const WORK = path.join(os.tmpdir(), "calcula-writeback-subscriber");
const WS = path.join(WORK, "workspace");
const SAVED = path.join(WORK, "subscriber.cala");
const SUBMISSIONS = path.join(WS, APP, VERSION, "submissions");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIALOG_DRIVER = path.join(HERE, "..", "answer-native-dialog.ps1");

/** B3:B5 zero-based. */
const REGION_CELLS = [
  { ref: "B3", row: 2, col: 1 },
  { ref: "B4", row: 3, col: 1 },
  { ref: "B5", row: 4, col: 1 },
];

// ---------------------------------------------------------------------------
// Shared state across the serial tests
// ---------------------------------------------------------------------------

let subscribedSheetName = "";
let subscribedSheetId = "";
/** The owner's own submission files before the run (they test there too). */
let ownerSubmissionsBefore: string[] = [];

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

interface RegionEntry {
  sheetId: string;
  sheetIndex: number;
  regionId: string;
  packageName?: string;
  registryUrl?: string;
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
  submissionPolicy?: string;
  visibility?: string;
  sheetName?: string;
}

interface LayerEntry {
  regionId: string;
  cellRow: number;
  cellCol: number;
  value: { type: string; value?: number | string | boolean };
  state: "draft" | "submitted" | "approved" | "rejected";
}

async function regions(page: Page): Promise<RegionEntry[]> {
  return callModule<RegionEntry[]>(page, COLLAB, "getWritebackRegions");
}

async function layer(page: Page): Promise<LayerEntry[]> {
  const l = await callModule<{ drafts: LayerEntry[] }>(page, COLLAB, "getWritebackLayer");
  return l.drafts;
}

function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFilesRecursive(p));
    else out.push(p);
  }
  return out;
}

/** The ribbon's tab button labelled exactly `label` (never the menu bar's). */
function ribbonTab(page: Page, label: string): Locator {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.locator('[data-testid="ribbon"] button').filter({ hasText: new RegExp(`^${escaped}$`) });
}

async function writebackTabCount(page: Page): Promise<number> {
  return ribbonTab(page, "Writeback").count();
}

async function tabBadge(page: Page): Promise<string | null> {
  const b = page.locator('[data-tab-badge="writeback-tab"]');
  if ((await b.count()) === 0) return null;
  return ((await b.first().textContent()) ?? "").trim();
}

/** A cell's rectangle in PAGE CSS pixels, from the live geometry (no scroll assumed away). */
async function cellBox(page: Page, grid: GridHelper, ref: string): Promise<{ left: number; top: number; right: number; bottom: number }> {
  const geo = await readGridGeometry(page);
  const box = await grid.canvas.boundingBox();
  if (!box) throw new Error("no grid canvas");
  const { row, col } = parseCellRef(ref);
  const hiddenCols = new Set(geo.hiddenCols);
  const hiddenRows = new Set(geo.hiddenRows);
  const cw = (c: number) => (hiddenCols.has(c) ? 0 : geo.columnWidths[c] ?? geo.defaultCellWidth);
  const rh = (r: number) => (hiddenRows.has(r) ? 0 : geo.rowHeights[r] ?? geo.defaultCellHeight);
  let x = 0;
  for (let c = 0; c < col; c++) x += cw(c);
  let y = 0;
  for (let r = 0; r < row; r++) y += rh(r);
  const left = (geo.rowHeaderWidth + x - geo.scrollX) * geo.zoom;
  const top = (geo.colHeaderHeight + y - geo.scrollY) * geo.zoom;
  return {
    left: box.x + left,
    top: box.y + top,
    right: box.x + left + cw(col) * geo.zoom,
    bottom: box.y + top + rh(row) * geo.zoom,
  };
}

/** A strip straddling a cell's TOP edge (where the region outline would be). */
async function topEdgeClip(page: Page, grid: GridHelper, ref: string) {
  const b = await cellBox(page, grid, ref);
  return { x: Math.round(b.left + 6), y: Math.round(b.top - 2), width: Math.round(b.right - b.left - 12), height: 4 };
}

/** A small square straddling the MIDDLE of a cell's LEFT edge (where a frame "w" sits). */
async function leftEdgeMidClip(page: Page, grid: GridHelper, ref: string) {
  const b = await cellBox(page, grid, ref);
  const mid = (b.top + b.bottom) / 2;
  return { x: Math.round(b.left - 4), y: Math.round(mid - 4), width: 8, height: 8 };
}

/** A strip straddling a cell's BOTTOM edge. */
async function bottomEdgeClip(page: Page, grid: GridHelper, ref: string) {
  const b = await cellBox(page, grid, ref);
  return { x: Math.round(b.left + 6), y: Math.round(b.bottom - 2), width: Math.round(b.right - b.left - 12), height: 4 };
}

/**
 * The top half of the state-marker disc (centre right-9, top+5, radius 3, a
 * 1px ring), ABOVE any right-aligned digit, so the cell's own text cannot be
 * mistaken for a marker.
 */
async function markerClip(page: Page, grid: GridHelper, ref: string) {
  const b = await cellBox(page, grid, ref);
  return { x: Math.round(b.right - 13), y: Math.round(b.top + 1), width: 8, height: 3 };
}

/** Park the cursor away from everything sampled (selection paint is not evidence). */
async function parkCursor(grid: GridHelper): Promise<void> {
  await grid.clickCell("F12");
  await grid.page.mouse.move(5, 5);
  await grid.page.waitForTimeout(400);
}

/** Press a named button on the native dialog whose title contains `titleLike`. */
function answerNativeDialog(titleLike: string, button: string, waitMs = 20_000): string {
  if (!fs.existsSync(DIALOG_DRIVER)) throw new Error(`native-dialog driver missing at ${DIALOG_DRIVER}`);
  try {
    return execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", DIALOG_DRIVER, "-TitleLike", titleLike, "-Action", "button", "-Button", button, "-TimeoutMs", String(waitMs)],
      { encoding: "utf-8", timeout: waitMs + 30_000 },
    );
  } catch (e) {
    const out = (e as { stdout?: string }).stdout;
    return `DRIVERERROR:${String(e)} ${typeof out === "string" ? out : ""}`;
  }
}

/** Drain any native dialog left over from an earlier spec (one app serves every spec). */
function drainNativeDialogs(): void {
  for (let i = 0; i < 5; i++) {
    let out = "";
    try {
      out = execFileSync(
        "powershell",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", DIALOG_DRIVER, "-TitleLike", "Calcula", "-Action", "cancel", "-TimeoutMs", "1200"],
        { encoding: "utf-8", timeout: 30_000 },
      );
    } catch (e) {
      out = String((e as { stdout?: string }).stdout ?? "");
    }
    if (!out.includes("CLICKED:")) return;
  }
}

/** Activate the contextual tab (a click on its strip button) and wait for its band. */
async function openWritebackTab(page: Page): Promise<void> {
  await ribbonTab(page, "Writeback").click();
  await page.locator('[data-testid="writeback-tab-submit-all"]').waitFor({ state: "visible", timeout: 8000 });
}

// ---------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------

test.describe.serial("writeback subscriber: see what you typed, send it, and see that it was sent", () => {
  test.beforeAll(() => {
    if (!fs.existsSync(SOURCE_WS)) throw new Error(`the owner's workspace ${SOURCE_WS} is not on this machine`);
    if (fs.existsSync(WORK)) fs.rmSync(WORK, { recursive: true, force: true });
    ownerSubmissionsBefore = listFilesRecursive(path.join(SOURCE_WS, APP, VERSION, "submissions")).sort();
    copyDir(SOURCE_WS, WS);
    // The owner tests in their own workspace too, so it may already hold
    // submissions and reviews. Drop them from the COPY (never the source): the
    // copy must start without submissions, or "files appeared" proves nothing.
    for (const sub of ["submissions", "reviews"]) {
      fs.rmSync(path.join(WS, APP, VERSION, sub), { recursive: true, force: true });
    }
    expect(fs.existsSync(SUBMISSIONS)).toBe(false);
    drainNativeDialogs();
  });

  test("subscribe: the region is on the LOCAL sheet, outlined, and the tab follows the cursor", async ({ appPage: page, grid }) => {
    test.setTimeout(240_000);
    await newFile(page);
    const before = await sheets(page);
    const r = await subscribe(page, WS, APP);
    expect(r.packageName).toBe(APP);
    expect(r.sheetsPulled).toBeGreaterThanOrEqual(1);

    const after = await sheets(page);
    const known = new Set(before.sheets.map((s) => s.sheetId));
    const pulled = after.sheets.filter((s) => !known.has(s.sheetId));
    expect(pulled.length, `pulled sheets: ${JSON.stringify(after.sheets)}`).toBe(1);
    subscribedSheetName = pulled[0].name;
    subscribedSheetId = pulled[0].sheetId ?? "";
    expect(subscribedSheetId).not.toBe("");
    // FreshLocal: the subscriber's sheet has its own id, never the publisher's.
    expect(subscribedSheetId).not.toBe(PUBLISHER_SHEET_ID);

    const idx = await activate(page, subscribedSheetName);

    // D1: the region names the LOCAL sheet (id + index + name), so every guard
    // keyed on the active sheet finds it. Before the fix it kept the
    // publisher's id and fell back to index 0.
    const list = await eventually(() => regions(page), (l) => l.length === 1, "the subscribed region never reached the index");
    const reg = list[0];
    expect(reg.sheetId).toBe(subscribedSheetId);
    expect(reg.sheetIndex).toBe(idx);
    expect(reg.sheetName).toBe(subscribedSheetName);
    expect([reg.rowStart, reg.rowEnd, reg.colStart, reg.colEnd]).toEqual([2, 4, 1, 1]);
    expect(reg.packageName).toBe(APP);
    expect(reg.submissionPolicy).toBe("on_submit");
    expect(reg.visibility).toBe("own_plus_aggregate");

    // The publisher's content arrived.
    expect((await readCell(page, idx, "A1")).display).toBe("Report");
    expect((await readCell(page, idx, "A3")).display).toBe("A");

    // THE TAB: absent on A1, present (labelled exactly "Writeback") on B3.
    await grid.clickCell("A1");
    await expect.poll(() => writebackTabCount(page), { timeout: 5000 }).toBe(0);
    await grid.clickCell("B3");
    await expect.poll(() => writebackTabCount(page), { timeout: 5000 }).toBe(1);
    expect(((await ribbonTab(page, "Writeback").textContent()) ?? "").trim()).toBe("Writeback");
    await grid.clickCell("A3");
    await expect.poll(() => writebackTabCount(page), { timeout: 5000 }).toBe(0);
    await grid.clickCell("B5");
    await expect.poll(() => writebackTabCount(page), { timeout: 5000 }).toBe(1);
    await grid.clickCell("B6");
    await expect.poll(() => writebackTabCount(page), { timeout: 5000 }).toBe(0);

    // THE OUTLINE: B3's top edge and B5's bottom edge carry the dashed
    // perimeter; B4's top edge is an internal line of the region and carries
    // only the gridline. A3/A4 (outside the region) are both plain gridlines.
    await parkCursor(grid);
    const [b3Top, b4Top, b5Bottom, b4Bottom, a3Top, a4Top] = await samplePixelPatches(page, [
      await topEdgeClip(page, grid, "B3"),
      await topEdgeClip(page, grid, "B4"),
      await bottomEdgeClip(page, grid, "B5"),
      await bottomEdgeClip(page, grid, "B3"),
      await topEdgeClip(page, grid, "A3"),
      await topEdgeClip(page, grid, "A4"),
    ]);
    const outlineTop = diffCount(b3Top, b4Top);
    const outlineBottom = diffCount(b5Bottom, b4Bottom);
    const noOutlineA = diffCount(a3Top, a4Top);
    console.log(`[writeback] outline diff B3top/B4top=${outlineTop} B5bottom/B3bottom=${outlineBottom} A3top/A4top=${noOutlineA}`);
    expect(outlineTop, "no frame on B3's top edge").toBeGreaterThan(10);
    expect(outlineBottom, "no frame on B5's bottom edge").toBeGreaterThan(10);
    expect(noOutlineA, "an outline was painted round A3 (not a writeback cell)").toBeLessThanOrEqual(2);
  });

  test("typing 1, 2, 3 saves exactly three drafts, marks them, and badges the tab 3", async ({ appPage: page, grid }) => {
    test.setTimeout(240_000);
    await activate(page, subscribedSheetName);
    expect((await layer(page)).length).toBe(0);

    // Marker baseline BEFORE typing: B3's corner is plain.
    await parkCursor(grid);
    const [b3Before, c3Before] = await samplePixelPatches(page, [await markerClip(page, grid, "B3"), await markerClip(page, grid, "C3")]);
    expect(diffCount(b3Before, c3Before), "B3 carried a marker before anything was typed").toBeLessThanOrEqual(1);

    await grid.setCellValue("B3", "1");
    await grid.setCellValue("B4", "2");
    await grid.setCellValue("B5", "3");

    const drafts = await eventually(() => layer(page), (l) => l.filter((e) => e.state === "draft").length === 3, "three drafts never appeared");
    expect(drafts.length).toBe(3);
    const cells = drafts.map((d) => `${d.cellRow}:${d.cellCol}=${String(d.value.value)}`).sort();
    expect(cells).toEqual(["2:1=1", "3:1=2", "4:1=3"]);
    const regionId = (await regions(page))[0].regionId;
    expect(drafts.every((d) => d.regionId === regionId)).toBe(true);

    const idx = (await sheets(page)).activeIndex;
    expect((await readCell(page, idx, "B3")).display).toBe("1");
    expect((await readCell(page, idx, "B5")).display).toBe("3");

    // MARKERS: each typed cell's corner now differs from a non-writeback cell's
    // (C3, C4, C5); the control pair C3/C4 does not differ.
    await parkCursor(grid);
    const patches = await samplePixelPatches(page, [
      await markerClip(page, grid, "B3"),
      await markerClip(page, grid, "B4"),
      await markerClip(page, grid, "B5"),
      await markerClip(page, grid, "C3"),
      await markerClip(page, grid, "C4"),
    ]);
    const d3 = diffCount(patches[0], patches[3]);
    const d4 = diffCount(patches[1], patches[4]);
    const d5 = diffCount(patches[2], patches[4]);
    const control = diffCount(patches[3], patches[4]);
    console.log(`[writeback] draft marker diffs B3=${d3} B4=${d4} B5=${d5} control=${control}`);
    expect(d3, "no draft marker on B3").toBeGreaterThan(4);
    expect(d4, "no draft marker on B4").toBeGreaterThan(4);
    expect(d5, "no draft marker on B5").toBeGreaterThan(4);
    expect(control).toBeLessThanOrEqual(1);

    // BADGE: 3 unsent values, shown while the tab is up (cursor in the region).
    await grid.clickCell("B3");
    await expect.poll(() => writebackTabCount(page), { timeout: 5000 }).toBe(1);
    await expect.poll(() => tabBadge(page), { timeout: 5000 }).toBe("3");
  });

  test("Submit All sends them: submitted, files in the workspace, markers gone, a toast says so", async ({ appPage: page, grid }) => {
    test.setTimeout(240_000);
    await activate(page, subscribedSheetName);
    expect(fs.existsSync(SUBMISSIONS)).toBe(false);
    await dismissToasts(page);

    await grid.clickCell("B3");
    await expect.poll(() => writebackTabCount(page), { timeout: 5000 }).toBe(1);
    await openWritebackTab(page);
    const submitAll = page.locator('[data-testid="writeback-tab-submit-all"]');
    await expect(submitAll).toBeEnabled();
    // Await the click (it must be SENT) before the synchronous driver blocks Node.
    await submitAll.click();
    const verdict = answerNativeDialog("Submit all writeback values", "Submit All");
    console.log(`[writeback] submit confirm: ${verdict.replace(/\r?\n/g, " | ")}`);
    expect(verdict).toContain("CLICKED:Submit All");
    expect(verdict).toContain("GONE");

    const sent = await eventually(
      () => layer(page),
      (l) => l.length === 3 && l.every((e) => e.state === "submitted"),
      "the drafts never became submitted",
      20_000,
    );
    expect(sent.map((e) => `${e.cellRow}:${e.cellCol}=${String(e.value.value)}`).sort()).toEqual(["2:1=1", "3:1=2", "4:1=3"]);

    // ON DISK: the workspace copy now holds the submission events.
    const files = await eventually(async () => listFilesRecursive(SUBMISSIONS), (f) => f.length > 0, "no submission files in the workspace");
    console.log(`[writeback] submission files: ${files.map((f) => path.relative(WS, f)).join(", ")}`);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    expect(jsonFiles.length).toBeGreaterThan(0);
    const text = jsonFiles.map((f) => fs.readFileSync(f, "utf-8")).join("\n");
    const regionId = (await regions(page))[0].regionId;
    expect(text).toContain(regionId);
    // Never the owner's workspace.
    expect(
      listFilesRecursive(path.join(SOURCE_WS, APP, VERSION, "submissions")).sort(),
      "the run wrote into the owner's workspace",
    ).toEqual(ownerSubmissionsBefore);

    // THE TOAST.
    await expect
      .poll(async () => (await toastTexts(page)).join(" || "), { timeout: 8000 })
      .toContain("3 values sent to writeback-test. The publisher can now see them.");

    // BADGE gone, STATUS says sent.
    await expect.poll(() => tabBadge(page), { timeout: 5000 }).toBe(null);
    const status = ((await page.locator('[data-testid="writeback-tab-status-state"]').textContent()) ?? "").trim();
    console.log(`[writeback] status after submit: ${status}`);
    expect(status).toMatch(/^Sent/);

    // MARKERS gone: the typed cells' corners now match a plain cell's.
    await parkCursor(grid);
    const patches = await samplePixelPatches(page, [
      await markerClip(page, grid, "B3"),
      await markerClip(page, grid, "B4"),
      await markerClip(page, grid, "B5"),
      await markerClip(page, grid, "C4"),
    ]);
    for (let i = 0; i < 3; i++) {
      expect(diffCount(patches[i], patches[3]), `${REGION_CELLS[i].ref} still carries a marker after submit`).toBeLessThanOrEqual(1);
    }
  });

  test("editing B3 again then Discard Drafts restores the last sent value and clears the marker", async ({ appPage: page, grid }) => {
    test.setTimeout(240_000);
    await activate(page, subscribedSheetName);
    const idx = (await sheets(page)).activeIndex;
    await dismissToasts(page);

    await grid.setCellValue("B3", "9");
    const edited = await eventually(
      () => layer(page),
      (l) => l.some((e) => e.cellRow === 2 && e.cellCol === 1 && e.state === "draft"),
      "the re-edit of B3 saved no draft",
    );
    expect(edited.find((e) => e.cellRow === 2 && e.cellCol === 1)?.value.value).toBe(9);
    expect((await readCell(page, idx, "B3")).display).toBe("9");

    await parkCursor(grid);
    let [b3, c3] = await samplePixelPatches(page, [await markerClip(page, grid, "B3"), await markerClip(page, grid, "C3")]);
    expect(diffCount(b3, c3), "no marker on the re-edited B3").toBeGreaterThan(4);

    await grid.clickCell("B3");
    await expect.poll(() => writebackTabCount(page), { timeout: 5000 }).toBe(1);
    await expect.poll(() => tabBadge(page), { timeout: 5000 }).toBe("1");
    await openWritebackTab(page);
    const discard = page.locator('[data-testid="writeback-tab-discard"]');
    await expect(discard).toBeEnabled();
    await discard.click();
    const verdict = answerNativeDialog("Discard writeback drafts", "Discard");
    console.log(`[writeback] discard confirm: ${verdict.replace(/\r?\n/g, " | ")}`);
    expect(verdict).toContain("CLICKED:Discard");

    await eventually(() => readCell(page, idx, "B3"), (c) => c.display === "1", "B3 did not go back to the last sent value 1");
    const after = await layer(page);
    const b3Entry = after.find((e) => e.cellRow === 2 && e.cellCol === 1);
    expect(b3Entry?.state).toBe("submitted");
    expect(b3Entry?.value.value).toBe(1);
    expect(after.filter((e) => e.state === "draft").length).toBe(0);
    await expect.poll(async () => (await toastTexts(page)).join(" || "), { timeout: 8000 }).toContain("1 value discarded.");
    await expect.poll(() => tabBadge(page), { timeout: 5000 }).toBe(null);

    await parkCursor(grid);
    [b3, c3] = await samplePixelPatches(page, [await markerClip(page, grid, "B3"), await markerClip(page, grid, "C3")]);
    expect(diffCount(b3, c3), "B3 still carries a marker after Discard").toBeLessThanOrEqual(1);
  });

  test("after save and reopen the region is still on the local sheet and typing still saves a draft", async ({ appPage: page, grid }) => {
    test.setTimeout(300_000);
    await activate(page, subscribedSheetName);
    await saveAs(page, SAVED);
    expect(fs.existsSync(SAVED)).toBe(true);
    await newFile(page);
    await expect.poll(async () => (await regions(page)).length, { timeout: 10_000 }).toBe(0);

    await openAt(page, SAVED);
    const reopened = await sheets(page);
    const sheet = reopened.sheets.find((s) => s.name === subscribedSheetName);
    expect(sheet, `sheets after reopen: ${JSON.stringify(reopened.sheets)}`).toBeTruthy();
    const idx = await activate(page, subscribedSheetName);

    const list = await eventually(() => regions(page), (l) => l.length === 1, "no region after reopen", 20_000);
    expect(list[0].sheetId).toBe(sheet!.sheetId);
    expect(list[0].sheetId).not.toBe(PUBLISHER_SHEET_ID);
    expect(list[0].sheetIndex).toBe(idx);

    // What was sent survives the reopen.
    const l0 = await layer(page);
    expect(l0.filter((e) => e.state === "submitted").length).toBe(3);

    await grid.clickCell("A1");
    await expect.poll(() => writebackTabCount(page), { timeout: 5000 }).toBe(0);
    await grid.clickCell("B4");
    await expect.poll(() => writebackTabCount(page), { timeout: 5000 }).toBe(1);

    await grid.setCellValue("B4", "4");
    const l1 = await eventually(
      () => layer(page),
      (l) => l.some((e) => e.cellRow === 3 && e.cellCol === 1 && e.state === "draft"),
      "typing on the reopened sheet saved no draft",
    );
    expect(l1.find((e) => e.cellRow === 3 && e.cellCol === 1)?.value.value).toBe(4);
    expect((await readCell(page, idx, "B4")).display).toBe("4");

    await parkCursor(grid);
    const [b4, c4] = await samplePixelPatches(page, [await markerClip(page, grid, "B4"), await markerClip(page, grid, "C4")]);
    expect(diffCount(b4, c4), "no marker on the reopened sheet's draft").toBeGreaterThan(4);

    await newFile(page);
  });
  test("Open Application for Editing: the author sees the region framed, and a push would keep it", async ({ appPage: page, grid }) => {
    test.setTimeout(300_000);
    await newFile(page);
    const r = await checkout(page, WS, APP);
    expect(r.version).toBe(VERSION);

    // Checkout keeps the application's own sheet id.
    const list = await sheets(page);
    const sheet = list.sheets.find((s) => s.sheetId === PUBLISHER_SHEET_ID);
    expect(sheet, `sheets after checkout: ${JSON.stringify(list.sheets)}`).toBeTruthy();
    await activate(page, sheet!.name);

    // THE AUTHOR'S REGION IS BACK: checkout used to drop it, so the owner saw
    // none and the next push would have published the application without it.
    const own = await eventually(
      () => callModule<Array<{ id: string; selector: { sheetId: string; rowStart: number; rowEnd: number; colStart: number; colEnd: number } }>>(page, COLLAB, "getWritebackDraftRegions"),
      (l) => l.length === 1,
      "the working copy has no designated writeback region",
      15_000,
    );
    const sel = own[0].selector;
    expect(sel.sheetId).toBe(PUBLISHER_SHEET_ID);
    expect([sel.rowStart, sel.rowEnd, sel.colStart, sel.colEnd]).toEqual([2, 4, 1, 1]);

    // An author is not a subscriber: no index entry, so no tab and no markers.
    expect((await regions(page)).length).toBe(0);
    await grid.clickCell("B3");
    await page.waitForTimeout(400);
    expect(await writebackTabCount(page)).toBe(0);

    // THE FRAME: the perimeter on B3's top edge (not on B4's internal one), and
    // a "w" in the middle of B4's left edge (not on D4's plain gridline).
    await parkCursor(grid);
    const [b3Top, b4Top, b4Left, d4Left] = await samplePixelPatches(page, [
      await topEdgeClip(page, grid, "B3"),
      await topEdgeClip(page, grid, "B4"),
      await leftEdgeMidClip(page, grid, "B4"),
      await leftEdgeMidClip(page, grid, "D4"),
    ]);
    const frameTop = diffCount(b3Top, b4Top);
    const glyph = diffCount(b4Left, d4Left);
    console.log(`[writeback] working copy frame B3top/B4top=${frameTop} w B4left/D4left=${glyph}`);
    expect(frameTop, "no frame on B3's top edge in the working copy").toBeGreaterThan(10);
    expect(glyph, "no 'w' on B4's left edge in the working copy").toBeGreaterThan(4);

    // A PUSH WOULD KEEP IT: the diff against the base names no removed region.
    const d = await pushDiff(page, WS, APP);
    const removed = d.objects.filter((o) => o.domain === "writebackRegion" && o.change === "removed");
    expect(removed, `the push would drop the region: ${describeDiff(d)}`).toEqual([]);

    await newFile(page);
  });
});
