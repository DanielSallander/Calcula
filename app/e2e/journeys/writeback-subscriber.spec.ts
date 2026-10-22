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
 *      the region frame (a soft line on the gridlines with an edit icon on its
 *      top and bottom edges) is painted round B3:B5 and NOT round A3 -- as a
 *      HAIRLINE: one device row, the boundary gridline's own, with the row just
 *      inside the cell untouched -- and the contextual "Writeback" tab is absent
 *      on A1 and present on B3;
 *   2. typing 1, 2, 3 with the KEYBOARD saves exactly three drafts in the
 *      backend, paints the red draft triangle in each cell's top-left corner
 *      (against a non-writeback cell, and READ as red: the corner's red channel
 *      dominates, a plain cell's does not), and badges the tab "3";
 *   3. Submit All (through the tab, the confirm answered by the native-dialog
 *      driver) sends them: the backend says submitted, submission event files
 *      exist in the workspace under the version's submissions folder, the
 *      markers are gone and the success toast says so;
 *   4. editing B3 again and Discard Drafts puts back the last SENT value 1 and
 *      clears the marker;
 *   5. after save + File > New + reopen the region is still on the LOCAL sheet
 *      id, the tab still follows the cursor, and typing still saves a draft;
 *   6. a NEW workbook that subscribes again shows, in B3:B5, the values this
 *      subscriber last SENT, as submitted, on the canvas too (BUG-0554: nothing
 *      copied sent values into a workbook that did not already hold them);
 *   7. Open Application for Editing (a working copy) gives the author the
 *      application's region back, framed on the sheet with its edit icon (the
 *      8px one: no taller than 8 CSS px), the Writeback tab shows the
 *      PUBLISHER's commands there (Collected Responses, no Submit), and the push
 *      diff names no removed region (checkout used to drop it);
 *   8. in that working copy, Collected Responses lists the author's OWN region
 *      and shows the three answers the earlier steps sent (BUG-0553: it read
 *      "No writeback regions in this workbook." -- the pane listed only the
 *      SUBSCRIBER index, where an author's region never is);
 *   9. the Application Inspector, pointed at the workspace's pointer file,
 *      OPENS the one application by itself: Overview names it and its version,
 *      Sheets & Data lists its sheet, and Writeback lists the B3:B5 region and
 *      the three answers sent (BUG-0552: a workspace location names no
 *      application, nothing was loaded, and every tab was the Browse hint);
 *  10. WHO SENT IT (identity phase 1, 2026-10-22): each sent answer is signed
 *      as THIS machine's Windows account (read from the OS here, never from
 *      the app), the Writeback tab's Status names that account, and the
 *      author's Collected Responses reads every answer "Verified: written by
 *      <that account>" (BUG-0584: in a workspace this deep the owner lookup
 *      failed and every answer read "cannot be checked here");
 *  11. in a COPY of the workspace: an answer validly signed by another key
 *      that CLAIMS a neighbour's account reads "Not verified: written by
 *      <this account>"; one of this subscriber's own answers with its NAME
 *      (and value) edited is forged -- listed nowhere and never seeded into a
 *      new subscriber's cells; and an UNSIGNED "rejected" decision dropped
 *      into reviews/ is ignored, while a decision the publisher really makes
 *      (positive control, the same file shape plus a seal) counts;
 *  12. a value the publisher REJECTS (a signed decision) comes back to a new
 *      subscriber workbook with the red triangle AND its text in the danger
 *      tone, beside an unsent value (the triangle, ordinary text) and a sent one
 *      (nothing) -- and crops of that frame, Light and Dark, are saved for the
 *      owner (never compared).
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
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "../fixtures";
import { parseCellRef, readGridGeometry, type GridHelper } from "../helpers/grid";
import { diffCount, samplePixelGrids, samplePixelPatches, type PixelSample } from "../viewportSample";
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
  destroyInspectorWindows,
  COLLAB,
} from "../helpers/calp-harness";
import { subscribe, checkout, pushDiff, describeDiff } from "../helpers/calp-collab";
import { closeTaskPanes } from "../helpers/object-pane";

const SOURCE_WS = "C:\\writeback-test";
const APP = "writeback-test";
const VERSION = "1.0.0";
/** The publisher's sheet id in the owner's signed manifest. */
const PUBLISHER_SHEET_ID = "01a15d70-b30a-7e15-800c-62a1c4efa4d7";

/**
 * The least share of an 8x8 CSS-px patch centred on the frame's top-edge icon
 * that differs from the same patch further along the edge (the line alone).
 * The 8px icon (2026-10-22) is drawn with ONE device pixel of stroke from 100%
 * to 175% scaling and two at 200%, with the line broken round it; with no icon
 * the line is unbroken and the two patches are the same. Measured 2026-10-22:
 * live at DPR 1, 32 of 64 (0.50) with the icon and 0 with it switched off; live
 * at DPR 2, 135 of 256 (0.527) with the icon and 0 with it switched off (the
 * live round's sabotage); on a headless render of the same painters and the
 * same patch rule (which also reads 32 of 64 at DPR 1), 0.42 at 125%, 0.35 at
 * 150%, 0.29 at 175%, 0.53 at 200%. 0.15 separates icon from no icon at every
 * scaling.
 */
const GLYPH_SHARE_FLOOR = 0.15;

/**
 * The tallest the top-edge icon may ink, CSS px (what it adds to the line, top
 * to bottom). The 8px glyph is drawn with its vertices on device pixels, so it
 * inks 7 rows at DPR 1 and 13 device rows (6.5 CSS px) at DPR 2; the 12px icon
 * it replaced ("a bit too intrusive on the cell", owner 2026-10-22) inks 9 CSS
 * px at either. Measured live 2026-10-22 at DPR 2: see the step's log line.
 */
const ICON_MAX_EXTENT = 8;

/**
 * A corner pixel reads RED when its red channel tops both others by more than
 * this. The draft / rejected triangle is filled with the Light skin's danger
 * tone #b42318 (180, 35, 24: 145 over); white, a grey gridline, black or grey
 * text and the frame's indigo all read 0 or below.
 */
const MARKER_RED_MARGIN = 60;

/**
 * The least share of a marker patch (wholly inside the triangle) that reads red.
 * Measured live 2026-10-22 at DPR 2: every pixel (24 of 24) of each draft's and
 * the rejected value's patch, none of a plain cell's.
 */
const MARKER_RED_SHARE = 0.8;

/**
 * A glyph pixel reads RED when its red channel tops both others by more than
 * this. Anti-aliased text mixes its colour with the cell's: the danger tone at
 * coverage c is 145 * c over, and the glyph pixels sampled are the ones where
 * ordinary ink differs from the blank cell by more than 60 (c above ~0.24), so
 * a rejected value's read 34 or more there; ordinary (neutral) ink reads 0.
 */
const TEXT_RED_MARGIN = 25;

const WORK = path.join(os.tmpdir(), "calcula-writeback-subscriber");
const WS = path.join(WORK, "workspace");
const SAVED = path.join(WORK, "subscriber.cala");
const SUBMISSIONS = path.join(WS, APP, VERSION, "submissions");
/** Step 11's copy of the workspace, where answers and a decision are planted. */
const WS_PLANTED = path.join(WORK, "planted-workspace");

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
/** This machine's Windows account, from the OS. */
let ME: MachineAccount = { principal: "", sid: "" };

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

/** One Collected Responses row (`@api/collaboration` RegionSubmission). */
interface InboxRow {
  submissionId: string;
  submitterId: string;
  submitterName: string;
  submitterPrincipal: string;
  cellRow: number;
  cellCol: number;
  valueDisplay: string;
  state: string;
  sender: string;
  identity?: { status: string; reason: string; writtenBy: string };
  identityLabel?: string;
  counted?: boolean;
}

/** The Identity line of each row of the open Collected Responses pane. */
async function identityLines(page: Page): Promise<Array<{ status: string; text: string }>> {
  return page.locator('[data-testid="publisher-dashboard-identity"]').evaluateAll((els) =>
    els.map((e) => ({ status: e.getAttribute("data-identity") ?? "", text: (e.textContent ?? "").trim() })),
  );
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

/** A small square straddling a cell's TOP edge at its horizontal centre (where the frame's icon sits for B3:B5). */
async function topEdgeMidClip(page: Page, grid: GridHelper, ref: string) {
  const b = await cellBox(page, grid, ref);
  const mid = (b.left + b.right) / 2;
  return { x: Math.round(mid - 4), y: Math.round(b.top - 4), width: 8, height: 8 };
}

/** The same square on the same TOP edge near the cell's left end: the frame line there, never the icon. */
async function topEdgeLeftClip(page: Page, grid: GridHelper, ref: string) {
  const b = await cellBox(page, grid, ref);
  return { x: Math.round(b.left + 9), y: Math.round(b.top - 4), width: 8, height: 8 };
}

/** A small square straddling the MIDDLE of a cell's LEFT edge (where a side icon would sit -- there is none). */
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
 * Inside the state marker: the red right triangle in the cell's TOP-LEFT
 * corner (legs 7, right angle in the corner). One pixel in from the corner, so
 * neither the gridline nor the region frame lying on it is sampled, and 3 x 2
 * CSS px, well inside the triangle (its hypotenuse is at x + y = 7) -- and far
 * from the cell's own text, which sits on the bottom and (a number) on the right.
 * It used to read the top-RIGHT disc that the triangle replaced (2026-10-22),
 * where nothing is painted any more: the "a marker is there" checks failed and
 * the "the marker is gone" checks passed whatever the grid showed.
 */
async function markerClip(page: Page, grid: GridHelper, ref: string) {
  const b = await cellBox(page, grid, ref);
  return { x: Math.round(b.left + 1), y: Math.round(b.top + 1), width: 3, height: 2 };
}

/**
 * A strip ACROSS a cell's TOP boundary, on the frame's LINE: 4 CSS px wide and
 * 9 px in from the cell's left edge (clear of the left edge's vertical line and
 * of the top edge's icon, which sits at the middle of the column), from 3 px
 * above the boundary to 3 px below it. The same strip on a plain cell of the
 * same row is the plain gridline the frame is compared with, row by row.
 */
async function topBoundaryStrip(page: Page, grid: GridHelper, ref: string) {
  const b = await cellBox(page, grid, ref);
  return { x: Math.round(b.left + 9), y: Math.round(b.top) - 3, width: 4, height: 6 };
}

/** A 16 x 14 CSS-px box centred on the middle of a cell's TOP edge (where the frame's icon sits for B3:B5). */
async function topIconBox(page: Page, grid: GridHelper, ref: string) {
  const b = await cellBox(page, grid, ref);
  const mid = (b.left + b.right) / 2;
  return { x: Math.round(mid - 8), y: Math.round(b.top) - 7, width: 16, height: 14 };
}

/** The same box on the same TOP edge, 5 px in from the cell's left end: the frame line there, never the icon. */
async function topLineBox(page: Page, grid: GridHelper, ref: string) {
  const b = await cellBox(page, grid, ref);
  return { x: Math.round(b.left + 5), y: Math.round(b.top) - 7, width: 16, height: 14 };
}

/**
 * The RIGHT half of a cell's interior, where a number is drawn (right-aligned,
 * on the cell's bottom): clear of the top-left triangle, of the frame's lines
 * and of the bottom edge's icon at the middle of the column. Its size follows
 * only the column's width and the row's height, so cells of one column (or of
 * columns as wide) on rows as tall give samples of one size.
 */
async function numberPatch(page: Page, grid: GridHelper, ref: string) {
  const b = await cellBox(page, grid, ref);
  const w = b.right - b.left;
  const h = b.bottom - b.top;
  return { x: Math.round(b.left + w / 2 + 6), y: Math.round(b.top + 2), width: Math.round(w / 2 - 7), height: Math.round(h - 3) };
}

/** Per DEVICE ROW of two same-sized samples: how many pixels differ (diffCount's rule). */
function rowDiffs(a: PixelSample, b: PixelSample, tolerance = 8): number[] {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`capture sizes differ (${a.width}x${a.height} vs ${b.width}x${b.height}) -- the clip moved, so the comparison means nothing`);
  }
  const rows: number[] = [];
  for (let y = 0; y < a.height; y++) {
    let n = 0;
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      if (
        Math.abs(a.data[i] - b.data[i]) > tolerance ||
        Math.abs(a.data[i + 1] - b.data[i + 1]) > tolerance ||
        Math.abs(a.data[i + 2] - b.data[i + 2]) > tolerance
      ) {
        n++;
      }
    }
    rows.push(n);
  }
  return rows;
}

/** Device row `y` of a sample, as a one-row sample (to compare two rows of one capture). */
function sampleRow(s: PixelSample, y: number): PixelSample {
  const from = y * s.width * 4;
  return { data: s.data.slice(from, from + s.width * 4), width: s.width, height: 1, scale: s.scale };
}

/** The RGBA offsets of every pixel of a sample. */
function allPixels(s: PixelSample): number[] {
  return Array.from({ length: s.width * s.height }, (_, p) => p * 4);
}

/** The share of the pixels at `at` (default: all) whose RED channel tops both others by more than `margin`. */
function redShare(s: PixelSample, margin: number, at: number[] = allPixels(s)): number {
  if (at.length === 0) return 0;
  return at.filter((i) => s.data[i] - Math.max(s.data[i + 1], s.data[i + 2]) > margin).length / at.length;
}

/** The mean colour of the pixels at `at` (default: all), for the log. */
function meanRgb(s: PixelSample, at: number[] = allPixels(s)): string {
  if (at.length === 0) return "none";
  const mean = [0, 1, 2].map((c) => Math.round(at.reduce((sum, i) => sum + s.data[i + c], 0) / at.length));
  return `rgb(${mean.join(",")})`;
}

/**
 * Save a crop of the page round A2:C6 -- the region B3:B5 and its neighbours --
 * for the OWNER to look at. Evidence only: never compared with anything (the
 * goldens are stale), so it cannot fail a run.
 */
async function saveRegionShot(page: Page, grid: GridHelper, name: string): Promise<void> {
  const a = await cellBox(page, grid, "A2");
  const c = await cellBox(page, grid, "C6");
  const x = Math.floor(a.left) - 1;
  const y = Math.floor(a.top) - 1;
  const file = test.info().outputPath(name);
  await page.screenshot({ path: file, clip: { x, y, width: Math.ceil(c.right) + 2 - x, height: Math.ceil(c.bottom) + 2 - y } });
  console.log(`[writeback] for the owner: ${file}`);
}

const APPEARANCE = "/src/api/appearance.ts";

/**
 * Switch the app skin through @api/appearance (the Settings panel's own call)
 * and give the grid a frame to repaint. Back to Light also drops the persisted
 * choice: the skin is app-global, and no later spec may inherit Dark.
 */
async function setSkin(page: Page, id: "calcula.light" | "calcula.dark"): Promise<void> {
  await callModule(page, APPEARANCE, "setActiveSkin", [id]);
  if (id === "calcula.light") await page.evaluate(() => localStorage.removeItem("calcula.appearance.skinId"));
  await page.waitForTimeout(700);
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

// ---------------------------------------------------------------------------
// Identity: this machine's account (from the OS), and the answer seal
// ---------------------------------------------------------------------------

interface MachineAccount {
  /** `DOMAIN\user` or `COMPUTER\user`, as whoami spells it (lower case). */
  principal: string;
  sid: string;
}

/** This machine's Windows account, read from the OS (whoami) -- never from the app under test. */
function machineAccount(): MachineAccount {
  const whoami = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe");
  const out = execFileSync(whoami, ["/user", "/fo", "csv", "/nh"], { encoding: "utf-8" }).trim();
  const m = /^"([^"]+)","([^"]+)"$/.exec(out);
  if (!m) throw new Error(`whoami /user said: ${out}`);
  return { principal: m[1], sid: m[2] };
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** An answer as it lies in `{app}/{version}/submissions/{sender}/` (core/calp/src/writeback.rs). */
interface AnswerFile {
  id: string;
  regionId: string;
  cellRow: number;
  cellCol: number;
  cellId?: string;
  submitter: { displayName: string; id: string; principalName?: string; provider?: string; scope?: string };
  value: { type: string; value?: number | string | boolean };
  state: string;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  environment?: string;
  modelKey?: string[];
  seal?: { publicKey: string; origin: string; signature: string };
}

/**
 * The bytes an answer's signature covers -- a COPY of
 * `core/calp/src/submission_seal.rs::event_payload`, so this spec can plant a
 * validly signed answer. The copy is checked against Rust on every run: each
 * answer the app really sent must verify with it (the "harness" assertion in
 * step 11), so a drift fails loudly instead of planting garbage that would be
 * "ignored" for the wrong reason.
 */
function eventPayload(app: string, version: string, s: AnswerFile, publicKey: string, origin: string): Buffer {
  const parts: Buffer[] = [Buffer.from("calcula-writeback-event-v1\0", "utf8")];
  const put = (text: string) => {
    const bytes = Buffer.from(text, "utf8");
    const len = Buffer.alloc(8);
    len.writeBigUInt64LE(BigInt(bytes.length));
    parts.push(len, bytes);
  };
  const putOpt = (text: string | undefined | null) => {
    if (text == null) put("0");
    else {
      put("1");
      put(text);
    }
  };
  const valueText = (): string => {
    switch (s.value.type) {
      case "number": {
        const bits = Buffer.alloc(8);
        bits.writeDoubleBE(Number(s.value.value));
        return `n:${bits.toString("hex")}`;
      }
      case "text":
        return `t:${String(s.value.value)}`;
      case "boolean":
        return `b:${s.value.value ? 1 : 0}`;
      default:
        return "e:";
    }
  };
  put(app);
  put(version);
  put(s.environment ?? "");
  put(s.id);
  put(s.regionId);
  put(String(s.cellRow));
  put(String(s.cellCol));
  putOpt(s.cellId);
  if (s.modelKey == null) put("-");
  else {
    put(String(s.modelKey.length));
    for (const k of s.modelKey) put(k);
  }
  put(valueText());
  put(s.createdAt);
  put(s.updatedAt);
  putOpt(s.submittedAt);
  put(s.submitter.id);
  put(s.submitter.displayName);
  put(s.submitter.principalName ?? "");
  put(s.submitter.provider ?? "legacy");
  put(s.submitter.scope ?? "unknown");
  put(publicKey.trim().toLowerCase());
  put(origin);
  return Buffer.concat(parts);
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Whether `s` carries a valid signature by the key in its seal. */
function sealVerifies(s: AnswerFile): boolean {
  if (!s.seal) return false;
  const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(s.seal.publicKey, "hex")]), format: "der", type: "spki" });
  return crypto.verify(null, eventPayload(APP, VERSION, s, s.seal.publicKey, s.seal.origin), key, Buffer.from(s.seal.signature, "hex"));
}

/** `identity_provider::key_commitment`: 32 hex of SHA-256 of the hex public key. */
function keyCommitment(publicKeyHex: string): string {
  return crypto.createHash("sha256").update(publicKeyHex.trim().toLowerCase(), "utf8").digest("hex").slice(0, 32);
}

function rawPublicKeyHex(key: crypto.KeyObject): string {
  const jwk = key.export({ format: "jwk" }) as { x?: string };
  return Buffer.from(jwk.x ?? "", "base64url").toString("hex");
}

/** `submission_seal::event_digest`: what a review decision binds to. */
function eventDigest(s: AnswerFile): string {
  return crypto.createHash("sha256").update(eventPayload(APP, VERSION, s, s.seal?.publicKey ?? "", s.seal?.origin ?? "")).digest("hex");
}

/** The answers this subscriber sent into `workspace`: its own `win-<SID>-...` folder. */
function sentAnswers(workspace: string, sid: string): Array<{ file: string; s: AnswerFile }> {
  const root = path.join(workspace, APP, VERSION, "submissions");
  const out: Array<{ file: string; s: AnswerFile }> = [];
  for (const file of listFilesRecursive(root)) {
    if (!file.endsWith(".json")) continue;
    if (!path.basename(path.dirname(file)).startsWith(`win-${sid}-`)) continue;
    out.push({ file, s: JSON.parse(fs.readFileSync(file, "utf-8")) as AnswerFile });
  }
  return out;
}

/** A UUID-v7-shaped id (a submission/review id: alphanumerics and '-'). */
function newEventId(): string {
  const hex = crypto.randomBytes(16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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
    ME = machineAccount();
    expect(ME.sid).toMatch(/^S-1-5-21-/);
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

    // THE OUTLINE: B3's top edge and B5's bottom edge carry the frame; B4's
    // top edge is an internal line of the region and carries only the
    // gridline. A3/A4 (outside the region) are both plain gridlines.
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

    // THE LINE IS A HAIRLINE ON THE GRIDLINE (owner, 2026-10-22: the frame read
    // "too sharp and noticeable"; it was a 1-CSS-px line drawn half a pixel
    // INSIDE the region -- two device rows at DPR 2, a second line beside the
    // gridline). Across B3's top boundary, device row by device row, against the
    // same strip on D3 (the plain gridline of the same row boundary): the
    // boundary row -- the plain gridline's own -- differs in every pixel, and
    // NO other row does: not the row just inside the cell, not the one above.
    const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
    const [frameStrip, plainStrip] = await samplePixelGrids(page, [
      await topBoundaryStrip(page, grid, "B3"),
      await topBoundaryStrip(page, grid, "D3"),
    ]);
    const interiorRow = sampleRow(plainStrip, plainStrip.height - 1);
    const gridRows = Array.from({ length: plainStrip.height }, (_, y) => y).filter((y) => diffCount(sampleRow(plainStrip, y), interiorRow) > 0);
    const byRow = rowDiffs(frameStrip, plainStrip);
    const g = gridRows[0] ?? -1;
    console.log(
      `[writeback] window devicePixelRatio ${dpr} (capture scale ${frameStrip.scale}); B3 top boundary vs D3, differing pixels per device row ` +
        `[${byRow.join(", ")}] of ${frameStrip.width}; plain gridline row(s) ${JSON.stringify(gridRows)}; ` +
        `boundary row ${g >= 0 ? meanRgb(sampleRow(frameStrip, g)) : "?"} (plain ${g >= 0 ? meanRgb(sampleRow(plainStrip, g)) : "?"}), ` +
        `row inside ${g >= 0 ? meanRgb(sampleRow(frameStrip, g + 1)) : "?"} (plain ${g >= 0 ? meanRgb(sampleRow(plainStrip, g + 1)) : "?"})`,
    );
    expect(gridRows.length, "the plain gridline in the strip is not ONE device row (the strip is not across the boundary)").toBe(1);
    expect(g > 0 && g < plainStrip.height - 1, "the boundary row lies at the strip's edge").toBe(true);
    expect(byRow[g], "the frame does not re-tint every pixel of the region's boundary gridline").toBe(frameStrip.width);
    expect(byRow[g + 1], "the device row just INSIDE B3 differs from a plain cell's: the frame is not a hairline on the gridline").toBe(0);
    expect(byRow[g - 1], "the device row just outside B3 differs from a plain cell's").toBe(0);
    expect(byRow.reduce((sum, n) => sum + n, 0), "the frame paints more than the one boundary row").toBe(byRow[g]);
  });

  test("typing 1, 2, 3 saves exactly three drafts, marks them, and badges the tab 3", async ({ appPage: page, grid }) => {
    test.setTimeout(240_000);
    await activate(page, subscribedSheetName);
    expect((await layer(page)).length).toBe(0);

    // Marker baseline BEFORE typing: B3's corner is plain, and nothing red.
    await parkCursor(grid);
    const [b3Before, c3Before] = await samplePixelGrids(page, [await markerClip(page, grid, "B3"), await markerClip(page, grid, "C3")]);
    expect(diffCount(b3Before, c3Before), "B3 carried a marker before anything was typed").toBeLessThanOrEqual(1);
    expect(redShare(b3Before, MARKER_RED_MARGIN), `B3's corner read red before anything was typed (${meanRgb(b3Before)})`).toBe(0);

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
    // (C3, C4, C5); the control pair C3/C4 does not differ. And the mark is the
    // RED triangle, read both ways: the typed cells' top-left corners are red,
    // the plain cells' are not.
    await parkCursor(grid);
    const patches = await samplePixelGrids(page, [
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
    const red = patches.map((p) => redShare(p, MARKER_RED_MARGIN));
    console.log(
      `[writeback] draft marker diffs B3=${d3} B4=${d4} B5=${d5} control=${control}; red share B3=${red[0]} B4=${red[1]} B5=${red[2]} ` +
        `C3=${red[3]} C4=${red[4]} of ${patches[0].width}x${patches[0].height}; colours ${patches.map((p) => meanRgb(p)).join(" ")}`,
    );
    expect(d3, "no draft marker on B3").toBeGreaterThan(4);
    expect(d4, "no draft marker on B4").toBeGreaterThan(4);
    expect(d5, "no draft marker on B5").toBeGreaterThan(4);
    expect(control).toBeLessThanOrEqual(1);
    for (let i = 0; i < 3; i++) {
      expect(red[i], `${REGION_CELLS[i].ref}'s top-left corner is not the red triangle (${meanRgb(patches[i])})`).toBeGreaterThanOrEqual(MARKER_RED_SHARE);
    }
    expect(red[3], `a plain cell's top-left corner (C3) reads red (${meanRgb(patches[3])})`).toBe(0);
    expect(red[4], `a plain cell's top-left corner (C4) reads red (${meanRgb(patches[4])})`).toBe(0);

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

    // WHO SENT THEM (identity phase 1): each answer lies in this ACCOUNT's
    // folder, names it, and is signed by the key its id commits to -- checked
    // here against the OS's account (whoami) and with node's own Ed25519.
    const signed = sentAnswers(WS, ME.sid);
    expect(signed.length, `answers under win-${ME.sid}-...: ${files.map((f) => path.relative(WS, f)).join(", ")}`).toBe(3);
    for (const { file, s } of signed) {
      expect(path.basename(path.dirname(file)), "the sender folder is the sender id").toBe(s.submitter.id);
      expect(s.submitter.provider).toBe("windows");
      expect(same(s.submitter.principalName ?? "", ME.principal), `${s.submitter.principalName} is not ${ME.principal}`).toBe(true);
      expect(s.seal, "an answer left this computer unsigned").toBeTruthy();
      expect(s.submitter.id).toBe(`win-${ME.sid}-${keyCommitment(s.seal!.publicKey)}`);
      expect(sealVerifies(s), `the signature on ${path.basename(file)} does not verify`).toBe(true);
    }
    // ...and the tab's Status says so, in words.
    const who = ((await page.locator('[data-testid="writeback-tab-status-who"]').textContent()) ?? "").trim();
    const account = ((await page.locator('[data-testid="writeback-tab-status-account"]').textContent()) ?? "").trim();
    console.log(`[writeback] status who: ${who} | ${account}`);
    expect(who).toBe(`You are signed in as ${signed[0].s.submitter.displayName} (Windows account)`);
    expect(account.toLowerCase(), "Status does not name this machine's Windows account").toContain(ME.principal.toLowerCase());

    // MARKERS gone: the typed cells' corners now match a plain cell's, and
    // nothing in them reads red.
    await parkCursor(grid);
    const patches = await samplePixelGrids(page, [
      await markerClip(page, grid, "B3"),
      await markerClip(page, grid, "B4"),
      await markerClip(page, grid, "B5"),
      await markerClip(page, grid, "C4"),
    ]);
    for (let i = 0; i < 3; i++) {
      expect(diffCount(patches[i], patches[3]), `${REGION_CELLS[i].ref} still carries a marker after submit`).toBeLessThanOrEqual(1);
      expect(redShare(patches[i], MARKER_RED_MARGIN), `${REGION_CELLS[i].ref}'s corner still reads red after submit (${meanRgb(patches[i])})`).toBe(0);
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
    let [b3, c3] = await samplePixelGrids(page, [await markerClip(page, grid, "B3"), await markerClip(page, grid, "C3")]);
    expect(diffCount(b3, c3), "no marker on the re-edited B3").toBeGreaterThan(4);
    expect(redShare(b3, MARKER_RED_MARGIN), `the re-edited B3's corner is not the red triangle (${meanRgb(b3)})`).toBeGreaterThanOrEqual(MARKER_RED_SHARE);

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
    [b3, c3] = await samplePixelGrids(page, [await markerClip(page, grid, "B3"), await markerClip(page, grid, "C3")]);
    expect(diffCount(b3, c3), "B3 still carries a marker after Discard").toBeLessThanOrEqual(1);
    expect(redShare(b3, MARKER_RED_MARGIN), `B3's corner still reads red after Discard (${meanRgb(b3)})`).toBe(0);
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
    const [b4, c4] = await samplePixelGrids(page, [await markerClip(page, grid, "B4"), await markerClip(page, grid, "C4")]);
    expect(diffCount(b4, c4), "no marker on the reopened sheet's draft").toBeGreaterThan(4);
    expect(redShare(b4, MARKER_RED_MARGIN), `the reopened sheet's draft corner is not the red triangle (${meanRgb(b4)})`).toBeGreaterThanOrEqual(MARKER_RED_SHARE);

    await newFile(page);
  });

  test("a NEW workbook that subscribes again shows the values this subscriber last sent", async ({ appPage: page, grid }) => {
    test.setTimeout(240_000);
    // File > New and subscribe again: nothing in this workbook has ever held
    // the values. The identity is this computer's, so the workspace knows them
    // (BUG-0554: the cells stayed blank -- nothing copied sent values into a
    // workbook that did not already hold them).
    await newFile(page);
    expect((await layer(page)).length, "a new workbook starts with no writeback values").toBe(0);
    const before = await sheets(page);
    const r = await subscribe(page, WS, APP);
    expect(r.packageName).toBe(APP);
    const after = await sheets(page);
    const known = new Set(before.sheets.map((s) => s.sheetId));
    const pulled = after.sheets.filter((s) => !known.has(s.sheetId));
    expect(pulled.length, `pulled sheets: ${JSON.stringify(after.sheets)}`).toBe(1);
    const idx = await activate(page, pulled[0].name);

    // THE BACKEND: the layer holds what was SENT (B3 = 1 after the discard,
    // B4 = 2, B5 = 3; step 5's B4 = 4 was a draft in a workbook closed without
    // saving, never sent), each as submitted -- and no draft.
    const shown = await eventually(
      () => layer(page),
      (l) => l.length === 3 && l.every((e) => e.state === "submitted"),
      "the new workbook never took the values this subscriber sent",
      20_000,
    );
    expect(shown.map((e) => `${e.cellRow}:${e.cellCol}=${String(e.value.value)}`).sort()).toEqual(["2:1=1", "3:1=2", "4:1=3"]);
    for (const [ref, want] of [["B3", "1"], ["B4", "2"], ["B5", "3"]] as const) {
      await eventually(() => readCell(page, idx, ref), (c) => c.display === want, `${ref} does not show the sent ${want}`);
    }

    // THE CANVAS: B3's interior now carries a digit (it differs from the empty
    // C3 beside it); the control pair D3/D4 does not differ. The inset keeps
    // the region frame (and the draft triangle's corner) out of the sample. The
    // control pair is D, not C, from when the frame carried a right-edge icon
    // on the B4/C4 border that reached into C4 (C3/C4 differed by 8); the sides
    // carry no icon since 2026-10-22, and D is kept as the cleaner control.
    const interior = async (ref: string) => {
      const b = await cellBox(page, grid, ref);
      return { x: Math.round(b.left + 3), y: Math.round(b.top + 6), width: Math.round(b.right - b.left - 6), height: Math.max(4, Math.round(b.bottom - b.top - 11)) };
    };
    await parkCursor(grid);
    await expect
      .poll(
        async () => {
          const [b3, c3] = await samplePixelPatches(page, [await interior("B3"), await interior("C3")]);
          return diffCount(b3, c3);
        },
        { timeout: 10_000, message: "B3 is painted blank although the backend holds 1" },
      )
      .toBeGreaterThan(4);
    const [d3, d4] = await samplePixelPatches(page, [await interior("D3"), await interior("D4")]);
    expect(diffCount(d3, d4), "control pair").toBeLessThanOrEqual(1);

    // Nothing unsent: no badge on the tab.
    await grid.clickCell("B3");
    await expect.poll(() => writebackTabCount(page), { timeout: 5000 }).toBe(1);
    await expect.poll(() => tabBadge(page), { timeout: 5000 }).toBe(null);
    await grid.clickCell("A1");

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

    // An author is not a subscriber: no index entry, so no markers -- but the
    // Writeback tab appears with the PUBLISHER's commands, and only there.
    expect((await regions(page)).length).toBe(0);
    await grid.clickCell("A1");
    await expect.poll(() => writebackTabCount(page), { timeout: 5000 }).toBe(0);
    await grid.clickCell("B3");
    await expect.poll(() => writebackTabCount(page), { timeout: 5000 }).toBe(1);
    await ribbonTab(page, "Writeback").click();
    await page.locator('[data-testid="writeback-tab-collected-responses"]').waitFor({ state: "visible", timeout: 8000 });
    await expect(page.locator('[data-testid="writeback-tab-edit-region"]')).toBeVisible();
    expect(await page.locator('[data-testid="writeback-tab-submit-all"]').count(), "a publisher has nothing to submit").toBe(0);
    await expect(page.locator('[data-testid="writeback-tab-publisher-region"]')).toContainText("B3:B5");
    await grid.clickCell("A1");
    await expect.poll(() => writebackTabCount(page), { timeout: 5000 }).toBe(0);

    // THE FRAME: the perimeter on B3's top edge (not on B4's internal one); the
    // edit icon at the middle of that TOP edge -- B is the only column, so its
    // centre -- and not further along the same edge, which carries the same
    // frame LINE but no icon (so the line alone cannot pass this); and NO icon
    // on the sides (owner, 2026-10-22: a side icon touched the middle row's
    // value), so the middle of B4's left edge is the plain line, like B3's.
    await parkCursor(grid);
    const [b3Top, b4Top, b3TopMid, b3TopLeft, b4Left, b3Left] = await samplePixelGrids(page, [
      await topEdgeClip(page, grid, "B3"),
      await topEdgeClip(page, grid, "B4"),
      await topEdgeMidClip(page, grid, "B3"),
      await topEdgeLeftClip(page, grid, "B3"),
      await leftEdgeMidClip(page, grid, "B4"),
      await leftEdgeMidClip(page, grid, "B3"),
    ]);
    const frameTop = diffCount(b3Top, b4Top);
    const glyph = diffCount(b3TopMid, b3TopLeft);
    const sideGlyph = diffCount(b4Left, b3Left);
    // As a SHARE of the patch: the count is in DEVICE pixels, so the same icon
    // counts four times as many pixels at DPR 2 as at DPR 1.
    const glyphShare = glyph / (b3TopMid.width * b3TopMid.height);
    console.log(
      `[writeback] working copy frame B3top/B4top=${frameTop} icon B3topMid/B3topLeft=${glyph} of ${b3TopMid.width}x${b3TopMid.height} (dpr ${b3TopMid.scale}) side B4left/B3left=${sideGlyph}`,
    );
    expect(frameTop, "no frame on B3's top edge in the working copy").toBeGreaterThan(10);
    expect(glyphShare, "no edit icon at the middle of the frame's top edge in the working copy").toBeGreaterThan(GLYPH_SHARE_FLOOR);
    expect(sideGlyph, "an edit icon is painted on the frame's left edge (the sides carry none)").toBeLessThanOrEqual(2);

    // THE ICON IS THE SMALL ONE (owner, 2026-10-22: the 12px icon was "a bit
    // too intrusive on the cell"). What it adds to the line -- the device rows
    // of a box round it that differ from the same box on the line alone -- is
    // no taller than ICON_MAX_EXTENT CSS px.
    const [iconBox, lineBox] = await samplePixelGrids(page, [await topIconBox(page, grid, "B3"), await topLineBox(page, grid, "B3")]);
    const iconRows = rowDiffs(iconBox, lineBox);
    const inked = iconRows.flatMap((n, y) => (n > 0 ? [y] : []));
    const iconExtent = inked.length === 0 ? 0 : (inked[inked.length - 1] - inked[0] + 1) / iconBox.scale;
    console.log(`[writeback] working copy top icon: differing pixels per device row [${iconRows.join(", ")}] -> ${iconExtent} CSS px tall (limit ${ICON_MAX_EXTENT})`);
    expect(iconExtent, "the top edge's icon is taller than the 8px icon").toBeLessThanOrEqual(ICON_MAX_EXTENT);
    expect(iconExtent, "nothing drawn at the middle of the top edge").toBeGreaterThanOrEqual(4);

    // COLLECTED RESPONSES, FOR THE AUTHOR (BUG-0553). The backend first: the
    // publisher-side list names the author's own region as READY, and its
    // inbox holds the three values steps 3-4 sent (B3 = 1 after the discard,
    // B4 = 2, B5 = 3; the B4 = 4 of step 5 was a draft, never sent).
    const regionId = own[0].id;
    const listed = await callModule<Array<{ regionId: string; role: string; status: string; detail: string; version: string | null }>>(
      page, COLLAB, "listCollectionRegions",
    );
    console.log(`[writeback] collection regions in the working copy: ${JSON.stringify(listed)}`);
    const mine = listed.find((r) => r.regionId === regionId);
    expect(mine, "Collected Responses does not list the author's own region").toBeTruthy();
    expect(mine!.role).toBe("author");
    expect(mine!.status, mine!.detail).toBe("ready");
    expect(mine!.version).toBe(VERSION);
    const inbox = await callModule<InboxRow[]>(page, COLLAB, "loadRegionSubmissions", [regionId]);
    expect(inbox.map((r) => `${r.cellRow}:${r.cellCol}=${r.valueDisplay}:${r.state}`).sort()).toEqual([
      "2:1=1:submitted",
      "3:1=2:submitted",
      "4:1=3:submitted",
    ]);
    // WHO SENT THEM, as this reader sees it: signed, and VERIFIED -- Windows
    // recorded this machine's account (whoami's) as the writer of each file.
    // BUG-0584: this workspace is deep enough that the files lie beyond
    // MAX_PATH, and every answer read "cannot be checked here: Windows did
    // not say who wrote the file".
    for (const r of inbox) {
      console.log(`[writeback] identity ${r.cellRow}:${r.cellCol}: ${r.sender} / ${r.identity?.status} / ${r.identityLabel}`);
      expect(r.sender).toBe("signed");
      expect(r.identity?.status, r.identityLabel).toBe("verified");
      expect(same(r.identity?.writtenBy ?? "", ME.principal), `written by ${r.identity?.writtenBy}, not ${ME.principal}`).toBe(true);
      expect(r.identityLabel).toBe(`Verified: written by ${r.identity!.writtenBy} (Windows account)`);
      expect(r.counted).toBe(true);
    }

    // ...and the PANE, opened from the tab the author sees on B3.
    await grid.clickCell("B3");
    await expect.poll(() => writebackTabCount(page), { timeout: 5000 }).toBe(1);
    await ribbonTab(page, "Writeback").click();
    const collected = page.locator('[data-testid="writeback-tab-collected-responses"]');
    await collected.waitFor({ state: "visible", timeout: 8000 });
    await collected.click();
    const pane = page.locator('[data-testid="publisher-dashboard"]');
    await pane.waitFor({ state: "visible", timeout: 10_000 });
    await expect(page.locator('[data-testid="publisher-dashboard-empty"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="publisher-dashboard-region"]')).toContainText("B3:B5");
    await expect(page.locator('[data-testid="publisher-dashboard-row"]')).toHaveCount(3, { timeout: 15_000 });
    await expect(page.locator('[data-testid="publisher-dashboard-not-ready"]')).toHaveCount(0);
    const paneText = (await pane.textContent()) ?? "";
    console.log(`[writeback] Collected Responses: ${paneText.replace(/\s+/g, " ").slice(0, 300)}`);
    expect(paneText).not.toContain("No writeback regions");
    // THE IDENTITY COLUMN: one line per answer, each Verified and naming this
    // machine's account.
    const identities = await identityLines(page);
    console.log(`[writeback] Collected Responses identity lines: ${JSON.stringify(identities)}`);
    expect(identities.length).toBe(3);
    for (const line of identities) {
      expect(line.status).toBe("verified");
      expect(line.text.toLowerCase()).toBe(`identity: verified: written by ${ME.principal.toLowerCase()} (windows account)`);
    }
    const closed = await closeTaskPanes(page);
    expect(closed.isOpen, "the Responses pane must not leak into later specs").toBe(false);
    await grid.clickCell("A1");

    // A PUSH WOULD KEEP IT: the diff against the base names no removed region.
    const d = await pushDiff(page, WS, APP);
    const removed = d.objects.filter((o) => o.domain === "writebackRegion" && o.change === "removed");
    expect(removed, `the push would drop the region: ${describeDiff(d)}`).toEqual([]);

    await newFile(page);
  });

  test("Application Inspector on the workspace: it opens the application and every tab shows it", async ({ appPage: page }) => {
    test.setTimeout(240_000);
    const context = page.context();
    // A FRESH window: one left open by an earlier run would only be focused,
    // and would run the module it loaded then, in the state it was left in.
    await destroyInspectorWindows(page);
    await page.locator("button").filter({ hasText: /^Collaboration$/ }).first().click();
    await page.getByText("Application Inspector...", { exact: true }).first().click();
    // Matched by URL (the window is destroyed above, so this is the new one).
    const found = await eventually(
      async () => context.pages().find((p) => /packageInspector/.test(p.url())) ?? null,
      (p) => !!p,
      "the Application Inspector window never appeared",
      30_000,
    );
    const inspector = found!;
    try {
      const box = inspector.locator('input[placeholder^="Workspace, application"]');
      await box.waitFor({ state: "visible", timeout: 30_000 });
      const bodyText = () => inspector.evaluate(() => document.body.innerText);
      const BROWSE_HINT = /Browse to a workspace's workspace\.calcula file/;

      // THE POINTER FILE -- the only thing Browse returns. It names no
      // application; the workspace holds exactly one, so the window opens it at
      // latest with no further gesture (BUG-0552: nothing was loaded and all
      // eight tabs showed the Browse hint).
      await box.fill(path.join(WS, "workspace.calcula"));
      await box.press("Enter");
      const title = await eventually(
        () => inspector.evaluate(() => document.querySelector("h2")?.textContent ?? ""),
        (t) => t.includes(APP) && t.includes(`v${VERSION}`),
        "the Overview never named the application and its version (the BUG-0552 empty-tabs state)",
        30_000,
      );
      console.log(`[writeback] inspector overview title: ${title}`);
      expect(await bodyText(), "the Browse hint is gone once the application is open").not.toMatch(BROWSE_HINT);

      // THE BACKEND, read from the inspector window itself (the same commands
      // its sections call): the application's sheet, its one region at B3:B5,
      // and the three answers this journey sent (this computer published it,
      // so it holds the key and sees them).
      const reads = await inspector.evaluate(
        async ({ ws, app, version }) => {
          const w = window as unknown as { __TAURI__: { core: { invoke: (c: string, a: Record<string, unknown>) => Promise<unknown> } } };
          const args = { registryPath: ws, packageName: app, versionPin: version };
          const ov = (await w.__TAURI__.core.invoke("calp_inspector_overview", args)) as {
            resolvedVersion: string;
            sheets: Array<{ sheetId: string; name: string }>;
          };
          const wb = (await w.__TAURI__.core.invoke("calp_inspector_writeback", args)) as {
            regions: Array<{ id: string; sheetName: string; range: string }>;
            isPublisher: boolean;
            totalSubmissions: number;
          };
          return { ov, wb };
        },
        { ws: WS, app: APP, version: VERSION },
      );
      console.log(`[writeback] inspector reads: ${JSON.stringify({ sheets: reads.ov.sheets, wb: { regions: reads.wb.regions, isPublisher: reads.wb.isPublisher, total: reads.wb.totalSubmissions } })}`);
      expect(reads.ov.resolvedVersion).toBe(VERSION);
      expect(reads.ov.sheets.map((s) => s.sheetId)).toEqual([PUBLISHER_SHEET_ID]);
      const sheetName = reads.ov.sheets[0].name;
      expect(reads.wb.regions.map((r) => `${r.sheetName} ${r.range}`)).toEqual([`${sheetName} B3:B5`]);
      expect(reads.wb.isPublisher, "this computer published writeback-test, so it holds the key").toBe(true);
      expect(reads.wb.totalSubmissions, "the three answers step 3 sent").toBe(3);

      // SHEETS & DATA: the section lists the application's sheet, not the hint.
      await inspector.locator("div").filter({ hasText: /^Sheets & Data$/ }).first().click();
      await eventually(
        bodyText,
        (t) => t.includes("Sheets & Data") && t.includes(sheetName) && !BROWSE_HINT.test(t),
        `the Sheets & Data tab never listed the sheet ${sheetName}`,
        20_000,
      );

      // WRITEBACK: the region row and the publisher's response count.
      await inspector.locator("div").filter({ hasText: /^Writeback$/ }).first().click();
      const wbText = await eventually(
        bodyText,
        (t) => t.includes("Grid input regions (1)") && t.includes(`${sheetName} B3:B5`) && /3 submissions/.test(t),
        "the Writeback tab never showed the B3:B5 region and the three answers",
        20_000,
      );
      expect(wbText).toContain("Responses collected so far");
      expect(wbText).not.toMatch(BROWSE_HINT);
    } finally {
      // From the MAIN window: the inspector may not close itself (see the helper).
      expect(await destroyInspectorWindows(page), "the inspector window this test opened").toBe(1);
    }
  });

  test("in a copy of the workspace: a claimed neighbour reads Not verified, an edited answer is forged and never seeds, an unsigned decision is ignored", async ({ appPage: page, grid }) => {
    test.setTimeout(300_000);
    // A COPY of the workspace the earlier steps sent into (never the owner's).
    fs.rmSync(WS_PLANTED, { recursive: true, force: true });
    copyDir(WS, WS_PLANTED);
    const mine = sentAnswers(WS_PLANTED, ME.sid);
    expect(mine.length).toBe(3);
    // THE HARNESS: this spec's copy of the signed payload is Rust's -- every
    // answer the app really sent verifies with it -- so what it plants is
    // signed (or broken) exactly as intended.
    for (const { s } of mine) expect(sealVerifies(s), "the spec's event payload no longer matches core/calp/src/submission_seal.rs").toBe(true);
    const byRow = (row: number) => mine.find((m) => m.s.cellRow === row)!;
    const [b3, b4, b5] = [byRow(2), byRow(3), byRow(4)];
    const regionId = b3.s.regionId;
    const later = new Date(Date.parse(b5.s.updatedAt) + 60_000).toISOString();

    // PLANT 1 -- a CLAIM: an answer for B3 validly signed by a key this spec
    // made, naming a NEIGHBOUR's account on this computer. The id commits to
    // that key, so the fold keeps it as signed; but Windows recorded THIS
    // account as the file's writer.
    const keys = crypto.generateKeyPairSync("ed25519");
    const neighbourKey = rawPublicKeyHex(keys.publicKey);
    const neighbourSid = ME.sid.replace(/-\d+$/, "-4242");
    const claim: AnswerFile = {
      ...structuredClone(b3.s),
      id: newEventId(),
      submitter: {
        displayName: "Neighbour",
        id: `win-${neighbourSid}-${keyCommitment(neighbourKey)}`,
        principalName: `${process.env.COMPUTERNAME ?? ME.principal.split("\\")[0]}\\neighbour`,
        provider: "windows",
        scope: "localMachine",
      },
      value: { type: "number", value: 555 },
      createdAt: later,
      updatedAt: later,
      submittedAt: later,
    };
    const payload = eventPayload(APP, VERSION, claim, neighbourKey, "interactive");
    claim.seal = { publicKey: neighbourKey, origin: "interactive", signature: crypto.sign(null, payload, keys.privateKey).toString("hex") };
    expect(sealVerifies(claim), "the planted claim is validly signed").toBe(true);
    const claimDir = path.join(WS_PLANTED, APP, VERSION, "submissions", claim.submitter.id);
    fs.mkdirSync(claimDir, { recursive: true });
    fs.writeFileSync(path.join(claimDir, `${regionId}_2_1_${claim.id}.json`), JSON.stringify(claim, null, 2));

    // PLANT 2 -- an EDIT: this subscriber's own B5 answer file, its NAME
    // edited to the neighbour's (and its value to 777), in place. Its seal no
    // longer covers what it says.
    const edited: AnswerFile = structuredClone(b5.s);
    edited.submitter.displayName = "Neighbour";
    edited.submitter.principalName = claim.submitter.principalName;
    edited.value = { type: "number", value: 777 };
    expect(sealVerifies(edited), "the edited answer's seal is broken").toBe(false);
    fs.writeFileSync(b5.file, JSON.stringify(edited, null, 2));

    // PLANT 3 -- an UNSIGNED decision rejecting this subscriber's B3 answer:
    // the shape the app writes (checked below against a real one), no seal.
    const reviewsDir = path.join(WS_PLANTED, APP, VERSION, "reviews");
    fs.mkdirSync(reviewsDir, { recursive: true });
    const unsigned = {
      id: newEventId(),
      targetSubmissionId: b3.s.id,
      regionId,
      submitterId: b3.s.submitter.id,
      newState: "rejected",
      reviewReason: "planted",
      reviewedBy: "Mallory",
      reviewedAt: later,
      targetDigest: eventDigest(b3.s),
    };
    fs.writeFileSync(path.join(reviewsDir, `${unsigned.id}.json`), JSON.stringify(unsigned, null, 2));

    /** A NEW workbook subscribed to the planted copy: what it takes back as this account's own. */
    const subscribeAndRead = async (want: number) => {
      await newFile(page);
      const before = await sheets(page);
      await subscribe(page, WS_PLANTED, APP);
      const pulled = (await sheets(page)).sheets.filter((s) => !before.sheets.some((b) => b.sheetId === s.sheetId));
      expect(pulled.length).toBe(1);
      const idx = await activate(page, pulled[0].name);
      await eventually(
        () => layer(page),
        (l) => l.length >= want,
        `the new workbook took back fewer than the ${want} answers this account signed`,
        20_000,
      );
      // Settled, then read once more: the caller compares the whole layer, so
      // a seeded extra (the edited 777) shows in the diff.
      await page.waitForTimeout(500);
      const shown = await layer(page);
      console.log(`[writeback] planted subscriber layer: ${JSON.stringify(shown.map((e) => `${e.cellRow}:${e.cellCol}=${String(e.value.value)}:${e.state}`))}`);
      return { idx, shown };
    };

    // ---- THE SUBSCRIBER FIRST: a new workbook subscribed to the planted copy
    // takes back only what this account really signed -- B3 = 1, B4 = 2 --
    // never the edited 777, and B5 stays blank (its only answer there is the
    // forged one); the unsigned rejection of B3 does not reach it.
    const first = await subscribeAndRead(2);
    expect(first.shown.map((e) => `${e.cellRow}:${e.cellCol}=${String(e.value.value)}`).sort()).toEqual(["2:1=1", "3:1=2"]);
    expect(first.shown.find((e) => e.cellRow === 2)?.state, "the unsigned rejection reached the subscriber").toBe("submitted");
    for (const [ref, want] of [["B3", "1"], ["B4", "2"], ["B5", ""]] as const) {
      await eventually(() => readCell(page, first.idx, ref), (c) => c.display === want, `${ref} does not show "${want}"`);
    }

    // ---- THE PUBLISHER: a working copy of the planted workspace.
    await newFile(page);
    await checkout(page, WS_PLANTED, APP);
    await eventually(
      () => callModule<Array<{ id: string }>>(page, COLLAB, "getWritebackDraftRegions"),
      (l) => l.length === 1 && l[0].id === regionId,
      "the planted copy's working copy has no designated region",
      15_000,
    );
    const inbox = await eventually(
      () => callModule<InboxRow[]>(page, COLLAB, "loadRegionSubmissions", [regionId]),
      (l) => l.length > 0,
      "Collected Responses read nothing from the planted copy",
      15_000,
    );
    console.log(`[writeback] planted inbox: ${JSON.stringify(inbox.map((r) => ({ cell: `${r.cellRow}:${r.cellCol}`, v: r.valueDisplay, state: r.state, who: r.submitterPrincipal, sender: r.sender, identity: r.identityLabel })))}`);
    // The edited B5 is FORGED: listed nowhere (neither 777 nor the 3 it replaced).
    expect(inbox.map((r) => `${r.cellRow}:${r.cellCol}=${r.valueDisplay}`).sort()).toEqual(["2:1=1", "2:1=555", "3:1=2"]);
    const claimRow = inbox.find((r) => r.submitterId === claim.submitter.id);
    expect(claimRow, "the validly signed claim is listed").toBeTruthy();
    expect(claimRow!.sender).toBe("signed");
    expect(claimRow!.identity?.status, claimRow!.identityLabel).toBe("notVerified");
    expect(same(claimRow!.identity?.writtenBy ?? "", ME.principal), `written by ${claimRow!.identity?.writtenBy}`).toBe(true);
    expect(claimRow!.identityLabel).toBe(`Not verified: written by ${claimRow!.identity!.writtenBy}`);
    const myB3 = inbox.find((r) => r.submitterId === b3.s.submitter.id && r.cellRow === 2)!;
    expect(myB3.identity?.status).toBe("verified");
    // The unsigned decision is IGNORED: B3 is still waiting for a decision.
    expect(myB3.state, "an unsigned 'rejected' decision was applied").toBe("submitted");

    // THE PANE says the same.
    await activate(page, (await sheets(page)).sheets.find((s) => s.sheetId === PUBLISHER_SHEET_ID)!.name);
    await grid.clickCell("B3");
    await expect.poll(() => writebackTabCount(page), { timeout: 5000 }).toBe(1);
    await ribbonTab(page, "Writeback").click();
    const collected = page.locator('[data-testid="writeback-tab-collected-responses"]');
    await collected.waitFor({ state: "visible", timeout: 8000 });
    await collected.click();
    await page.locator('[data-testid="publisher-dashboard"]').waitFor({ state: "visible", timeout: 10_000 });
    await expect(page.locator('[data-testid="publisher-dashboard-row"]')).toHaveCount(3, { timeout: 15_000 });
    const lines = await identityLines(page);
    console.log(`[writeback] planted identity lines: ${JSON.stringify(lines)}`);
    expect(lines.map((l) => l.status).sort()).toEqual(["notVerified", "verified", "verified"]);
    expect(lines.find((l) => l.status === "notVerified")!.text.toLowerCase()).toBe(`identity: not verified: written by ${ME.principal.toLowerCase()}`);

    // POSITIVE CONTROL for the ignored decision: the publisher APPROVES B4
    // here, and that one counts. Its file has the planted one's shape plus a
    // seal -- so the plant was ignored for being unsigned, not for its shape.
    const myB4 = inbox.find((r) => r.submitterId === b4.s.submitter.id && r.cellRow === 3)!;
    const reviewsBefore = new Set(fs.readdirSync(reviewsDir));
    await callModule(page, COLLAB, "setSubmissionState", [regionId, myB4.submitterId, 3, 1, "approved", null, myB4.submissionId]);
    const after = await eventually(
      () => callModule<InboxRow[]>(page, COLLAB, "loadRegionSubmissions", [regionId]),
      (l) => l.some((r) => r.submissionId === myB4.submissionId && r.state === "approved"),
      "the publisher's own approval of B4 did not count",
      15_000,
    );
    expect(after.find((r) => r.submissionId === myB3.submissionId)?.state, "B3 after an unrelated approval").toBe("submitted");
    const realReviewFile = fs.readdirSync(reviewsDir).find((f) => !reviewsBefore.has(f));
    expect(realReviewFile, "the approval wrote no review file").toBeTruthy();
    const realReview = JSON.parse(fs.readFileSync(path.join(reviewsDir, realReviewFile!), "utf-8")) as Record<string, unknown>;
    expect(Object.keys(realReview).filter((k) => !(k in unsigned)).sort(), "the planted decision differs from a real one by more than its seal").toEqual(["seal"]);
    const closed = await closeTaskPanes(page);
    expect(closed.isOpen, "the Responses pane must not leak into later specs").toBe(false);
    await grid.clickCell("A1");

    // ---- THE SUBSCRIBER AGAIN: the signed approval reaches it (POSITIVE
    // CONTROL for the subscriber side); the unsigned rejection still does not.
    const again = await subscribeAndRead(2);
    expect(again.shown.map((e) => `${e.cellRow}:${e.cellCol}=${String(e.value.value)}`).sort()).toEqual(["2:1=1", "3:1=2"]);
    expect(again.shown.find((e) => e.cellRow === 2)?.state, "the unsigned rejection reached the subscriber").toBe("submitted");
    expect(again.shown.find((e) => e.cellRow === 3)?.state, "POSITIVE CONTROL: the publisher's signed approval").toBe("approved");
    await newFile(page);
  });

  test("a value the publisher REJECTS comes back marked: the red triangle and the value in the danger tone, beside an unsent value and a sent one", async ({ appPage: page, grid }) => {
    test.setTimeout(300_000);
    // THE PUBLISHER rejects this subscriber's B5 (3) -- a signed decision, the
    // route of Collected Responses' Reject -- in the workspace steps 3-4 sent
    // into (step 11 planted into a COPY of it; this one holds no plant).
    await newFile(page);
    await checkout(page, WS, APP);
    const own = await eventually(
      () => callModule<Array<{ id: string }>>(page, COLLAB, "getWritebackDraftRegions"),
      (l) => l.length === 1,
      "the working copy has no designated region",
      15_000,
    );
    const regionId = own[0].id;
    const inbox = await eventually(
      () => callModule<InboxRow[]>(page, COLLAB, "loadRegionSubmissions", [regionId]),
      (l) => l.length === 3,
      "Collected Responses does not hold the three answers sent",
      15_000,
    );
    const b5 = inbox.find((r) => r.cellRow === 4 && r.cellCol === 1);
    expect(b5?.valueDisplay, `inbox: ${JSON.stringify(inbox.map((r) => `${r.cellRow}:${r.cellCol}=${r.valueDisplay}:${r.state}`))}`).toBe("3");
    await callModule(page, COLLAB, "setSubmissionState", [regionId, b5!.submitterId, 4, 1, "rejected", "Please check this value", b5!.submissionId]);
    await eventually(
      () => callModule<InboxRow[]>(page, COLLAB, "loadRegionSubmissions", [regionId]),
      (l) => l.some((r) => r.submissionId === b5!.submissionId && r.state === "rejected"),
      "the publisher's rejection of B5 did not count",
      15_000,
    );

    // THE SUBSCRIBER: a new workbook takes back B3 = 1 and B4 = 2 as sent and
    // B5 = 3 as REJECTED; then B4 is typed again, 3, and not sent.
    await newFile(page);
    const before = await sheets(page);
    await subscribe(page, WS, APP);
    const pulled = (await sheets(page)).sheets.filter((s) => !before.sheets.some((b) => b.sheetId === s.sheetId));
    expect(pulled.length).toBe(1);
    const idx = await activate(page, pulled[0].name);
    const shown = await eventually(
      () => layer(page),
      (l) => l.length === 3 && l.some((e) => e.cellRow === 4 && e.state === "rejected"),
      "the new workbook never showed the publisher's rejection",
      20_000,
    );
    expect(shown.map((e) => `${e.cellRow}:${e.cellCol}=${String(e.value.value)}:${e.state}`).sort()).toEqual([
      "2:1=1:submitted",
      "3:1=2:submitted",
      "4:1=3:rejected",
    ]);
    await grid.setCellValue("B4", "3");
    await eventually(
      () => layer(page),
      (l) => l.some((e) => e.cellRow === 3 && e.cellCol === 1 && e.state === "draft" && e.value.value === 3),
      "typing 3 into B4 saved no draft",
    );
    for (const [ref, want] of [["B3", "1"], ["B4", "3"], ["B5", "3"]] as const) {
      await eventually(() => readCell(page, idx, ref), (c) => c.display === want, `${ref} does not show ${want}`);
    }

    // THE GRID. Corners: the unsent B4 and the rejected B5 carry the red
    // triangle; the sent B3 carries nothing (its corner is the plain C3's).
    // Text: B4 and B5 both show "3", right-aligned in one column on rows of one
    // height, so the glyph lies on the same pixels in both. On the pixels where
    // B4's ordinary ink is (where it differs from the blank C4), B5's reads in
    // the danger tone and B4's does not.
    await parkCursor(grid);
    const [m3, m4, m5, mPlain, t4, t5, tPlain] = await samplePixelGrids(page, [
      await markerClip(page, grid, "B3"),
      await markerClip(page, grid, "B4"),
      await markerClip(page, grid, "B5"),
      await markerClip(page, grid, "C3"),
      await numberPatch(page, grid, "B4"),
      await numberPatch(page, grid, "B5"),
      await numberPatch(page, grid, "C4"),
    ]);
    if (t4.data.length !== tPlain.data.length || t5.data.length !== t4.data.length) {
      throw new Error(`number patches differ in size (${t4.width}x${t4.height}, ${t5.width}x${t5.height}, ${tPlain.width}x${tPlain.height})`);
    }
    const ink = allPixels(t4).filter((i) => [0, 1, 2].some((c) => Math.abs(t4.data[i + c] - tPlain.data[i + c]) > 60));
    const corner = {
      sent: redShare(m3, MARKER_RED_MARGIN),
      draft: redShare(m4, MARKER_RED_MARGIN),
      rejected: redShare(m5, MARKER_RED_MARGIN),
      plain: redShare(mPlain, MARKER_RED_MARGIN),
    };
    const text = { draft: redShare(t4, TEXT_RED_MARGIN, ink), rejected: redShare(t5, TEXT_RED_MARGIN, ink) };
    console.log(
      `[writeback] corners red share: B3 sent=${corner.sent} B4 unsent=${corner.draft} B5 rejected=${corner.rejected} C3 plain=${corner.plain} ` +
        `(${meanRgb(m3)} ${meanRgb(m4)} ${meanRgb(m5)} ${meanRgb(mPlain)}); "3" glyph ${ink.length} px of ${t4.width}x${t4.height}: ` +
        `B4 unsent ink ${meanRgb(t4, ink)} red share ${text.draft}, B5 rejected ink ${meanRgb(t5, ink)} red share ${text.rejected}`,
    );
    expect(corner.rejected, `the rejected B5 has no red triangle (${meanRgb(m5)})`).toBeGreaterThanOrEqual(MARKER_RED_SHARE);
    expect(corner.draft, `the unsent B4 has no red triangle (${meanRgb(m4)})`).toBeGreaterThanOrEqual(MARKER_RED_SHARE);
    expect(corner.sent, `the sent B3's corner reads red (${meanRgb(m3)})`).toBe(0);
    expect(diffCount(m3, mPlain), "the sent B3 carries a marker").toBeLessThanOrEqual(1);
    expect(corner.plain, `a plain cell's corner reads red (${meanRgb(mPlain)})`).toBe(0);
    expect(ink.length, "no glyph found in B4's number patch (the sample is not on the value)").toBeGreaterThanOrEqual(8);
    expect(text.rejected, `the rejected B5's value is not drawn in the danger tone (${meanRgb(t5, ink)})`).toBeGreaterThanOrEqual(0.8);
    expect(text.draft, `the unsent B4's value is drawn red (${meanRgb(t4, ink)})`).toBe(0);

    // FOR THE OWNER (never compared): the frame round B3:B5 with a sent (B3), an
    // unsent (B4) and a rejected (B5) value, in the Light skin and in the Dark.
    await saveRegionShot(page, grid, "writeback-frame-sent-unsent-rejected-light.png");
    try {
      await setSkin(page, "calcula.dark");
      await saveRegionShot(page, grid, "writeback-frame-sent-unsent-rejected-dark.png");
    } finally {
      await setSkin(page, "calcula.light");
    }
    await grid.clickCell("A1");
    await newFile(page);
  });
});
