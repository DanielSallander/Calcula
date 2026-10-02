/**
 * OBJECT KEYBOARD -- M8 Task C (BUG-0258 design part 2: "Enter goes into a
 * selected slicer or timeline and the arrow keys move between items"; S9, Space
 * in the key grammar). WRITTEN, NOT YET RUN LIVE. Six steps, run in this
 * file's order: K-1, K-4 (slicer, worksheet), K-2 (slicer, canvas), K-3
 * (timeline, worksheet), K-5 (the key grammar, worksheet), K-6 (a bare key
 * refused in Settings, owner call 23 -- added 2026-10-02, never run live).
 *
 * The grammar (extensions/Slicer/lib/slicerKeys.ts; Calcula's choices -- Excel's
 * own route is Tab to the item, Down, Enter, and Alt+C clears): with exactly ONE
 * object selected and it a slicer, Enter goes INTO it; the arrows, Home, End,
 * PageUp and PageDown move a painted focus ring between its items; Space (or
 * Enter) applies the focused item with the slicer's own click rules, Ctrl
 * toggles, Shift selects the run from the item last applied; Escape leaves and
 * the slicer stays selected; Alt+C clears the filter, also without going in; Tab
 * is never claimed. Every focus move and every landed filter change is spoken
 * through the app's one polite live region (`[data-testid="app-announcer"]`,
 * @api/announce + shell/Announcer.tsx, M8 S6). DOM focus never leaves the grid.
 *
 * This journey reads the result back from the BACKEND (`get_all_slicers`, the
 * pivot's own view), Core's live grid state (the active cell), the product's own
 * focus state (lib/slicerKeyFocus.ts), the live region's text and RELATIVE
 * pixels (the ring is near-black where the button's edge was not) -- never "the
 * key press returned", and never a golden.
 *
 *   K-1 (worksheet) A click on a slicer's header selects it. Enter goes in
 *       (the first slot), Down twice moves the ring two slots (the live region
 *       says "<item>, 3 of N, selected", and the ring is PAINTED on that item),
 *       Space filters the backend to exactly that item -- the pivot shows that
 *       one row. Throughout, Core's active cell never moved and the slicer is
 *       still selected. Then the cell BEHIND the slicer (the active cell, given
 *       a value first) is out of reach: x, F2, Backspace and Delete open no
 *       edit and leave its value -- every door refuses while the keyboard is
 *       inside (M8 review finding 1) -- and the keyboard stays inside. Escape
 *       leaves the items, and the slicer is STILL selected.
 *   K-2 (canvas) Enter, then Right: the slicer does NOT move (the canvas nudge
 *       stood down: the slicer owns the arrows while the keyboard is inside it),
 *       and Down moves the ring. Escape twice: the first leaves the items (still
 *       selected), the second is the canvas's and deselects. Enter, then Tab:
 *       the NEXT object is selected and the keyboard is no longer inside the
 *       first.
 *   K-4 (worksheet) A filtered, selected slicer: Alt+C (without Enter) clears
 *       its filter -- every pivot row is back -- and the live region says
 *       "Filter cleared".
 *   K-3 (worksheet, the TIMELINE: extensions/TimelineSlicer/lib/timelineKeys.ts,
 *       M8 S8) A months timeline a script narrowed to January. A click on its
 *       header selects it. Enter goes in on January (the first period of the
 *       range), Right moves the ring to February, Shift+Right twice PREVIEWS
 *       February..April -- the live region says so, the ring is painted on
 *       April, and the backend still holds January with no undo step taken --
 *       and Enter commits: the backend holds ONE range of three periods
 *       (February..April), the pivot shows those months' rows, exactly ONE undo
 *       step was added and the live region says "Feb 2026 to Apr 2026
 *       selected". The active cell never moved and the timeline stays
 *       selected. The cell BEHIND the timeline is out of reach (as in K-1: no
 *       edit, its value kept, no undo step). Escape leaves, and ONE Ctrl+Z
 *       restores January.
 *   K-5 (worksheet, the KEY GRAMMAR: src/api/keybindings.ts, M8 S9) Space is
 *       spelled by name in a combination ("Ctrl+Space"); as the character the
 *       grammar trimmed it away, so a shortcut a user recorded on Ctrl+Space
 *       was saved and never fired. With nothing bound, Ctrl+Space selects the
 *       active cell's whole column (the grid's own key -- the positive
 *       control). Settings > Keyboard Shortcuts, Insert Hyperlink, Edit,
 *       Ctrl+Space: the capture box shows "Ctrl+Space" and names the grid's
 *       "Select Entire Column" as the conflict; Accept stores it. Then
 *       Ctrl+Space on the grid opens Insert Hyperlink and the selection does
 *       NOT change (the user's binding took the key before the grid). After a
 *       reset, Ctrl+Space selects the column again and opens nothing.
 *   K-6 (worksheet, a BARE key refused: src/api/keybindings.ts
 *       bareKeyShortcutRefusal, owner call 23) Settings > Keyboard Shortcuts,
 *       Insert Hyperlink, Edit: a bare Space, then a bare K, then a bare Enter
 *       -- each shows the refusal sentence ("cannot be a shortcut on its
 *       own") where the conflict warning goes and NO Accept button; nothing is
 *       stored. Then Ctrl+Space in the same box: the refusal is gone and
 *       Accept is offered (a key the grid owns is warned, never refused).
 *
 * NOT LIVE (unit tier only): a floating grid's cell edit (an external
 * session) makes both keyboards stand down -- slicerKeyboard.test.ts and
 * timelineKeyboard.test.ts "while a FLOATING GRID's cell edit is live"; the
 * '+' key ("Ctrl+Plus", the symbol tier) -- keybindings.spaceAndPlus.test.ts;
 * the M8 review's stale-focus ends (a level change or an emptied slicer ends
 * the focus at once, announced), the right press on another object's menu,
 * the slicer's Alt+C only while filtered and its run sentence, AltGr+C, the
 * lock pin -- the slicerKeyboard / timelineKeyboard (+Canvas) unit tests.
 * SCREEN READER (manual, NVDA): the live region's text is read back here, but
 * whether a reader SPEAKS it -- the same sentence twice, and a held arrow said
 * once where it stopped (shell/Announcer.tsx ANNOUNCE_SETTLE_MS) -- needs a
 * person with NVDA running during the live run.
 *
 * SABOTAGE (each must turn its step RED; apply, CONFIRM the behaviour changed,
 * run a fresh journey -- Vite serves the frontend, so a TypeScript sabotage
 * needs no Rust build -- see the message, then restore BYTE-IDENTICAL by sha256;
 * every file named here is LF; line numbers as of 2026-10-01, after the M8
 * review fixes, and re-read 2026-10-02 after BUG-0270 and the held-press
 * Escape change moved slicerObjectSelection.ts and keybindings.ts):
 *   K-1, K-2 and K-4 (the slicer):
 *   - extensions/Slicer/lib/slicerKeys.ts:262 `consume`: drop `e.stopPropagation();`
 *     -> K-1 goes red at its first check after Enter, "Enter did not go into the
 *     selected slicer on its first slot": the grid's own keyboard is a BUBBLE
 *     listener on the focus container that does not read defaultPrevented
 *     (core/hooks/useGridKeyboard.ts), so the Enter also reaches it and moves
 *     the cell cursor, and that selection change deselects the slicer and ends
 *     the focus. (Should the selection change not reach the slicer in the live
 *     app, the step goes red later instead, at "the keys INSIDE the slicer moved
 *     the ACTIVE CELL".)
 *   - extensions/Slicer/lib/slicerObjectSelection.ts:85 `ownsKey`: replace
 *     `return key === "Arrow" && isSlicerKeyFocusActive();` with `return false;`
 *     -> K-2 "the slicer MOVED: the canvas nudge took the arrow from the slicer
 *     the keyboard is inside".
 *   - extensions/Slicer/lib/slicerObjectSelection.ts:83 `ownsKey`: drop
 *     `|| isSlicerKeyFocusActive()` from the Escape answer (since BUG-0270 the
 *     same line answers Delete too) -> K-2 "the FIRST Escape deselected the
 *     slicer".
 *   - extensions/Slicer/rendering/slicerRenderer.ts:690 `renderSlicer`: delete the
 *     `drawFocusRing(...)` call -> K-1 "no focus ring is painted on the focused
 *     item".
 *   - extensions/Slicer/lib/slicerKeys.ts:310 `keyOutside`: delete
 *     `clearFromKeyboard(id);` (the Alt+C is still consumed, so nothing else
 *     acts on it either) -> K-4 "Alt+C did not clear the slicer's filter".
 *   - extensions/Slicer/lib/slicerKeys.ts:559 `installSlicerKeys`: replace
 *     `ownsSelection: slicerKeyFocusOwnsSelection,` with
 *     `ownsSelection: () => false,` (the inside no longer claims the
 *     selection) -> K-1 "a key inside the object opened an edit in the cell
 *     BEHIND it" (the typed x began an entry in the hidden active cell).
 *   K-3 (the timeline):
 *   - extensions/TimelineSlicer/lib/timelineKeys.ts:487 `moveFocus` (Shift branch,
 *     the `setTimelineKeyFocus(...)` line): add, after it, `void
 *     commitTimelineSpan(s.timeline.id, spanBetween(anchor, to), anchor);` ->
 *     K-3 "a Shift+arrow WROTE the timeline" (or "took an undo step"): the
 *     preview must be shown, never committed.
 *   - extensions/TimelineSlicer/lib/timelineKeys.ts:486 `moveFocus`: end the
 *     line with `: to;` instead of `: from;` (the run anchored at the NEW focus)
 *     -> K-3 "Shift+Right twice did not preview February..April". (Not a double
 *     commit: the store joins a selection made while another is landing into
 *     the SAME undo step, so a second commit would not change the step count
 *     and would prove nothing.)
 *   - extensions/TimelineSlicer/lib/timelineKeys.ts:326 `consume`: drop
 *     `e.stopPropagation();` -> K-3 "Enter did not go into the selected timeline
 *     ..." (the grid's bubble listener moves the cell cursor; the selection
 *     change deselects the timeline) or, later, "the keys INSIDE the timeline
 *     moved the ACTIVE CELL".
 *   - extensions/TimelineSlicer/rendering/timelineSlicerRenderer.ts:328: delete
 *     the `drawFocusRing(...)` call -> K-3 "no focus ring is painted on April".
 *   - extensions/TimelineSlicer/lib/timelineKeys.ts:633 `installTimelineKeys`:
 *     replace `ownsSelection: timelineKeyFocusOwnsSelection,` with
 *     `ownsSelection: () => false,` -> K-3 "a key inside the object opened an
 *     edit in the cell BEHIND it".
 *   K-5 (the key grammar; each of these also turns
 *   src/api/__tests__/keybindings.spaceAndPlus.test.ts red, sabotage harness
 *   S9-1/S9-2/S9-5):
 *   - src/api/keybindings.ts:630 `eventToCombo`: `parts.push(key);` instead of
 *     `parts.push(eventKeyToComboKey(key));` (the space bar recorded as a
 *     character again) -> K-5 "the capture box does not show the recorded key
 *     as Ctrl+Space" (it shows "Ctrl+").
 *   - src/api/keybindings.ts:442 `matchesEvent`: compare `parsed.key` instead of
 *     `comboKeyToEventKey(parsed.key)` -> K-5 "Ctrl+Space did not open Insert
 *     Hyperlink (the recorded shortcut never fired)" -- Settings still shows
 *     and stores "Ctrl+Space", and the grid selects the column instead.
 *   - src/api/keybindings.ts:1246 `findConflicts`: delete the GRID_SPACE_KEYS
 *     line (`if (sameCombo(...)) conflicts.push({ ...gridKey });`) -> K-5
 *     "Settings presented Ctrl+Space as FREE".
 *   K-6 (the bare key; each also turns src/api/__tests__/
 *   keybindings.bareKeyRefusal.test.ts and extensions/Settings/__tests__/
 *   KeybindingsPage.bareKey.test.tsx red; line numbers as of 2026-10-02):
 *   - src/api/keybindings.ts:896 `bareKeyShortcutRefusal`: add
 *     `return null;` as its first line -> K-6 "a bare Space was not refused
 *     in Settings" (and "a bare Space could be accepted as a shortcut").
 *   - extensions/Settings/components/KeybindingsPage.tsx:198 the row's Accept:
 *     drop `&& refusal === null` -> K-6 "a bare Space could be accepted as a
 *     shortcut" (the sentence is still shown; only the Accept comes back).
 *
 * PRECONDITIONS (CLAUDE.md): CARGO_TARGET_DIR outside the repo; clear stale
 * processes with app/scripts/kill-stale-dev.mjs (never msedgewebview2 by image
 * name); start only on a quiescent, compiling tree.
 *
 * SHARED APP. Every test starts and ends with the app's own File > New.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { readGridGeometry } from "../helpers/grid";
import {
  MOD,
  addCanvas,
  callModule,
  cellAt,
  configurePivot,
  createRangePivot,
  eventually,
  focusGrid,
  installAppImport,
  newFile,
  pivotView,
  pressUndo,
  undoState,
  viewText,
  writeTable,
} from "../helpers/pivot-live";
import { gridBox, objects, patchActiveCanvas, selectedObjects, type Obj } from "../helpers/canvas-live";
import {
  ACTIVITY_BAR_STORE,
  API_KEYBINDINGS,
  closeDialogsAndOverlays,
  executeCommand,
  gridSelection,
  openDialogs,
  type Sel,
} from "../helpers/edit-harness";
import { slicerItemValues, slicerLanded, slicerRow } from "../helpers/slicers";
import { timelineLanded, timelineRange, timelineZonePoint } from "../helpers/timelines";
import { samplePixelGrids, type PixelClip, type PixelSample } from "../viewportSample";

// ---------------------------------------------------------------------------
// Data and set-ups
// ---------------------------------------------------------------------------

/** Region / Sales: four regions. */
const DATA: Array<Array<string | number | null>> = [
  ["Region", "Sales"],
  ["North", 1],
  ["South", 2],
  ["West", 4],
  ["East", 8],
];

/** The product's own focus module (the live instance the app loaded). */
const SLICER_KEY_FOCUS = "/extensions/Slicer/lib/slicerKeyFocus.ts";
/** How this journey names the "Select all" slot (the product uses a symbol). */
const SELECT_ALL = "<select all>";

type Surface = "worksheet" | "canvas";

/** Sheet1: the data, and a pivot at D1 (Region rows, Sum of Sales). Sheet1 must be active. */
async function seedPivot(page: Page): Promise<string> {
  await writeTable(page, DATA);
  const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:B5", destinationCell: "D1", sourceSheet: 0, destinationSheet: 0 });
  await configurePivot(page, {
    pivotId: pid,
    rowFields: [{ sourceIndex: 0, name: "Region" }],
    valueFields: [{ sourceIndex: 1, name: "Sum of Sales", aggregation: "sum" }],
  });
  return pid;
}

/** The pivot's row labels, in order, grand total left out. */
async function rowLabels(page: Page, pivotId: string): Promise<string[]> {
  const v = await pivotView(page, pivotId);
  const t = viewText(v);
  return v.rows.map((r, i) => (r.rowType === "Data" ? t[i][0] : null)).filter((x): x is string => x !== null);
}

/** A slicer on the pivot's Region field, 160 x 224 (four items, no scrolling). */
async function createSlicer(page: Page, pid: string, sheetIndex: number, x: number, y: number): Promise<string> {
  const s = await callModule<{ id: string } | null>(page, MOD.SLICER_STORE, "createSlicerAsync", [
    {
      name: `Region_${x}`,
      sheetIndex,
      x,
      y,
      width: 160,
      height: 224,
      sourceType: "pivot",
      cacheSourceId: pid,
      fieldName: "Region",
      connectedSources: [{ sourceType: "pivot", sourceId: pid }],
    },
  ]);
  expect(s, "precondition: a slicer was created on the pivot's Region field").toBeTruthy();
  await page.waitForTimeout(300);
  return s!.id;
}

/** The sheet the objects go on: Sheet1, or a new canvas whose page fits the window. */
async function objectSheet(page: Page, surface: Surface): Promise<{ index: number }> {
  if (surface === "worksheet") return { index: 0 };
  const canvas = await addCanvas(page);
  const box = await gridBox(page);
  const pageWidth = Math.min(1280, Math.floor((box.width - 32) / 16) * 16);
  const pageHeight = Math.min(720, Math.floor((box.height - 32) / 16) * 16);
  await patchActiveCanvas(page, { pagePreset: "custom", pageWidth, pageHeight });
  return { index: canvas.index };
}

const SLICER_REGION = (sid: string) => `slicer-${sid}`;

/** The published object of a slicer, with its selection state. */
async function objectOf(page: Page, regionId: string): Promise<Obj> {
  const o = (await objects(page)).find((x) => x.id === regionId);
  if (!o) throw new Error(`no published object ${regionId}: ${(await objects(page)).map((x) => x.id).join(", ")}`);
  return o;
}

/** The CLIENT point of a sheet-px point on the active sheet. */
async function clientOf(page: Page, sx: number, sy: number): Promise<{ x: number; y: number }> {
  const geo = await readGridGeometry(page);
  const box = await gridBox(page);
  return { x: box.x + (geo.rowHeaderWidth + sx - geo.scrollX) * geo.zoom, y: box.y + (geo.colHeaderHeight + sy - geo.scrollY) * geo.zoom };
}

/** A click the way a hand makes one. */
async function click(page: Page, p: { x: number; y: number }): Promise<void> {
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(250);
}

/** Click the slicer's header (frame): it selects the slicer and moves nothing. */
async function clickHeader(page: Page, sid: string): Promise<void> {
  const s = await slicerRow(page, sid);
  await click(page, await clientOf(page, s.x + s.width / 2, s.y + 10));
  await eventually(() => objectOf(page, SLICER_REGION(sid)), (o) => o.selected, "a click on the slicer's header did not select it");
}

/** The keyboard's inner focus, from the product's own module (null = not inside a slicer). */
async function keyFocus(page: Page): Promise<{ slicerId: string; value: string } | null> {
  await installAppImport(page);
  return page.evaluate(
    async ({ mod, selectAll }) => {
      const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, unknown>> };
      const m = await w.__appImport(mod);
      const f = (m.getSlicerKeyFocus as () => { slicerId: string; value: unknown } | null)();
      if (!f) return null;
      return { slicerId: f.slicerId, value: typeof f.value === "symbol" ? selectAll : String(f.value) };
    },
    { mod: SLICER_KEY_FOCUS, selectAll: SELECT_ALL },
  );
}

/** What the app's polite live region says now. */
async function announced(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector('[data-testid="app-announcer"]')?.textContent ?? "<no live region>");
}

/** Whether ANY cell edit is open: Core's own, or a floating grid's external session (@api/editing). */
async function cellEditOpen(page: Page): Promise<boolean> {
  return callModule<boolean>(page, "/src/api/editing.ts", "isCellEditInProgress");
}

/** What the active cell is given before the keyboard goes into an object: the value it must keep. */
const BEHIND = "Keep me";

/**
 * The cell BEHIND an object the keyboard is inside (M8 review, finding 1): on
 * a worksheet Core's active cell stays where it was, hidden behind the object.
 * A typed letter (what a listbox user tries for type-ahead), F2, Backspace and
 * Delete used to open an edit there or clear it, under the focus ring. Every
 * door now refuses while the keyboard is inside: no edit opens, and the cell
 * keeps its value.
 */
async function keysNeverReachTheCellBehind(page: Page, cell: Sel): Promise<void> {
  for (const k of ["x", "F2", "Backspace", "Delete"]) await page.keyboard.press(k);
  await page.waitForTimeout(400);
  expect(await cellEditOpen(page), "a key inside the object opened an edit in the cell BEHIND it").toBe(false);
  expect((await cellAt(page, 0, cell.startRow, cell.startCol))?.display, "a key inside the object changed the cell BEHIND it").toBe(BEHIND);
}

/** Give the active cell a value (it must be outside the data and the pivot). */
async function seedCellBehind(page: Page, cell: Sel): Promise<void> {
  await writeTable(page, [[BEHIND]], cell.startRow, cell.startCol);
  await eventually(() => cellAt(page, 0, cell.startRow, cell.startCol), (c) => c?.display === BEHIND, "precondition: the active cell holds a value");
}

/** The slicer's slots as the keyboard walks them: "Select all" first when it is shown. */
async function slotsOf(page: Page, sid: string): Promise<string[]> {
  const s = await callModule<{ showSelectAll?: boolean } | undefined>(page, MOD.SLICER_STORE, "getSlicerById", [sid]);
  const values = await slicerItemValues(page, sid);
  return s?.showSelectAll ? [SELECT_ALL, ...values] : values;
}

/**
 * A CLIENT strip along the LEFT edge of slot `slot`'s painted button (3 x 10
 * css px at its vertical middle): where the focus ring's 2 px dark outline is
 * painted. From the renderer's own `slicerItemButton` -- the geometry the
 * painter uses -- never a copy of the layout.
 */
async function ringStrip(page: Page, sid: string, slot: number): Promise<PixelClip> {
  await installAppImport(page);
  const r = await page.evaluate(
    async ({ sid, slot, mods }) => {
      const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, (...a: unknown[]) => unknown>> };
      const renderer = await w.__appImport(mods.renderer);
      const geo = await w.__appImport(mods.geo);
      const store = await w.__appImport(mods.store);
      const grid = await w.__appImport(mods.grid);
      const s = store.getSlicerById(sid) as { width: number; height: number } | undefined;
      if (!s) return { error: `no slicer ${sid}` };
      const items = (store.getCachedItems(sid) as unknown[] | undefined) ?? [];
      const b = geo.slicerCanvasBounds(s) as { x: number; y: number } | null;
      if (!b) return { error: "no bounds" };
      const button = renderer.slicerItemButton(s, items.length, { width: s.width, height: s.height }, slot) as {
        x: number;
        y: number;
        width: number;
        height: number;
      } | null;
      if (!button) return { error: `no slot ${slot}` };
      const area = (document.querySelector("[data-grid-area]") as HTMLElement).getBoundingClientRect();
      const zoom = ((grid.getGridStateSnapshot() as { zoom?: number } | null)?.zoom ?? 1) as number;
      return {
        // The MIDDLE of the button's TOP edge, where the ring's 2 px dark stroke
        // runs. Not its left edge: a SELECTED slicer carries Core's eight resize
        // handles, and the mid-left one can sit exactly on an item's vertical
        // middle and cover the ring there (runs 10/10b, 2026-10-01: 0 dark
        // pixels while the full-page screenshot showed the ring).
        x: area.left + (b.x + button.x + button.width * 0.4) * zoom,
        y: area.top + (b.y + button.y) * zoom,
        width: 12 * zoom,
        height: 3 * zoom,
      };
    },
    { sid, slot, mods: { renderer: MOD.SLICER_RENDERER, geo: MOD.SLICER_CANVAS_GEO, store: MOD.SLICER_STORE, grid: "/src/api/grid.ts" } },
  );
  if ("error" in r) throw new Error(`ringStrip: ${r.error}`);
  return r as PixelClip;
}

/** Near-black pixels in a sample: the focus ring's dark outline (#000000). */
function ringPixels(s: PixelSample): number {
  let n = 0;
  for (let i = 0; i + 3 < s.data.length; i += 4) {
    if (s.data[i] <= 24 && s.data[i + 1] <= 24 && s.data[i + 2] <= 24) n++;
  }
  return n;
}

async function ringPixelsAt(page: Page, clip: PixelClip): Promise<number> {
  await page.waitForTimeout(150);
  return ringPixels((await samplePixelGrids(page, [clip]))[0]);
}

/** The same items, order ignored. */
const sameSet = (a: readonly string[] | null, b: readonly string[]) =>
  a !== null && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

async function endClean(page: Page): Promise<void> {
  await page.mouse.up().catch(() => undefined);
  await page.keyboard.press("Escape").catch(() => undefined);
  await newFile(page).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// K-1. Worksheet: Enter, Down twice, Space -- the active cell never moves
// ---------------------------------------------------------------------------

test.describe("the keyboard inside a selected slicer (worksheet)", () => {
  test("K-1 (worksheet): a header click selects the slicer; Enter goes in, Down twice and Space filter to that item; the active cell never moved and the slicer stays selected; Escape leaves and it is still selected", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      const pid = await seedPivot(page);
      const sid = await createSlicer(page, pid, 0, 320, 192);
      await eventually(() => slicerItemValues(page, sid), (v) => v.length === 4, "the slicer never listed the four regions", 15_000);
      const slots = await slotsOf(page, sid);
      expect(await rowLabels(page, pid), "precondition: every region shows").toHaveLength(4);
      expect((await slicerRow(page, sid)).selectedItems, "precondition: the slicer filters nothing").toBeNull();

      // A cell first (column A is free of objects), so the active cell is known.
      await click(page, await clientOf(page, 30, 110));
      await clickHeader(page, sid);
      await focusGrid(page);
      const cell0 = await gridSelection(page);
      expect(cell0, "precondition: Core has an active cell").not.toBeNull();
      expect(cell0!.startRow >= 5 && cell0!.startCol === 0, "precondition: the active cell is below the data (A6 or lower)").toBe(true);
      await seedCellBehind(page, cell0!);
      const target = slots[2];
      expect(target, "precondition: slot 2 is an item").not.toBe(SELECT_ALL);
      const ring = await ringStrip(page, sid, 2);
      const ringBefore = await ringPixelsAt(page, ring);

      // ---- Enter goes in.
      await page.keyboard.press("Enter");
      await eventually(() => keyFocus(page), (f) => f?.slicerId === sid && f.value === slots[0], "Enter did not go into the selected slicer on its first slot");

      // ---- Down twice: the ring is on slot 2, said and painted.
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await eventually(() => keyFocus(page), (f) => f?.value === target, "Down twice did not move the focus two slots");
      await eventually(
        () => announced(page),
        (t) => t === `${target}, 3 of ${slots.length}, selected`,
        "the live region does not say where the focus is",
      );
      const ringNow = await ringPixelsAt(page, ring);
      if (!(ringNow > ringBefore + 4)) {
        // DIAGNOSTIC (runs 10/10b, 2026-10-01: the focus moved and was announced,
        // but no ring pixel). Is the ring merely not REPAINTED? Force one
        // overlay redraw and sample again; also say what the painter would read.
        const probe = await page.evaluate(async ({ sid, mods }) => {
          const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, (...a: unknown[]) => unknown>> };
          const overlays = await w.__appImport("/src/api/gridOverlays.ts");
          const keys = await w.__appImport(mods.keys).catch(() => null);
          const focus = keys && typeof keys.getSlicerKeyFocus === "function" ? keys.getSlicerKeyFocus() : "(no getSlicerKeyFocus export)";
          overlays.requestOverlayRedraw();
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
          return { focus, sid };
        }, { sid, mods: { keys: "/extensions/Slicer/lib/slicerKeyFocus.ts" } }).catch((e) => ({ error: String(e) }));
        const ringAfterRedraw = await ringPixelsAt(page, ring);
        await page.screenshot({ path: test.info().outputPath("k1-ring-fullpage.png") }).catch(() => undefined);
        // Which slot DID get a ring (an off-by-one between the painter's slot
        // numbering and the key handler's would show up here)?
        const perSlot: string[] = [];
        for (let s = 0; s < Math.min(slots.length, 6); s++) {
          const strip = await ringStrip(page, sid, s).catch(() => null);
          perSlot.push(`${s}:${strip ? await ringPixelsAt(page, strip) : "n/a"}`);
        }
        throw new Error(
          `no focus ring is painted on the focused item (near-black pixels ${ringBefore} -> ${ringNow}); ` +
            `after a FORCED overlay redraw: ${ringAfterRedraw} (if this is > ${ringBefore + 4}, the key handler never asked for a repaint); ` +
            `painter input: ${JSON.stringify(probe).slice(0, 600)}; ring strip ${JSON.stringify(ring)}; ring pixels per slot ${perSlot.join(" ")}; slots ${JSON.stringify(slots)}`,
        );
      }

      // ---- Space applies the focused item: the backend filter is exactly it.
      await page.keyboard.press("Space");
      await slicerLanded(page);
      await eventually(
        () => slicerRow(page, sid),
        (s) => sameSet(s.selectedItems, [target]),
        "Space did not filter the slicer to the focused item",
      );
      await eventually(() => rowLabels(page, pid), (r) => sameSet(r, [target]), "the pivot is not filtered to the focused item");

      expect(await gridSelection(page), "the keys INSIDE the slicer moved the ACTIVE CELL (they reached the grid's own keyboard)").toEqual(cell0);
      expect((await objectOf(page, SLICER_REGION(sid))).selected, "the keys inside the slicer deselected it").toBe(true);

      // ---- The cell BEHIND the slicer is out of reach; the keyboard stays inside.
      await keysNeverReachTheCellBehind(page, cell0!);
      expect(await keyFocus(page), "a refused key took the keyboard out of the slicer").toEqual({ slicerId: sid, value: target });
      expect(await gridSelection(page), "a refused key moved the active cell").toEqual(cell0);

      // ---- Escape leaves the items; the slicer stays selected.
      await page.keyboard.press("Escape");
      await eventually(() => keyFocus(page), (f) => f === null, "Escape did not leave the slicer's items");
      expect((await objectOf(page, SLICER_REGION(sid))).selected, "Escape deselected the slicer (it should only leave its items)").toBe(true);
      expect(await gridSelection(page), "Escape moved the active cell").toEqual(cell0);
    } finally {
      await endClean(page);
    }
  });

  // -------------------------------------------------------------------------
  // K-4. Alt+C clears, without going in
  // -------------------------------------------------------------------------

  test("K-4 (worksheet): on a filtered, selected slicer Alt+C clears the filter without going in -- every pivot row is back -- and the live region says 'Filter cleared'", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      const pid = await seedPivot(page);
      const sid = await createSlicer(page, pid, 0, 320, 192);
      const values = await eventually(() => slicerItemValues(page, sid), (v) => v.length === 4, "the slicer never listed the four regions", 15_000);

      // Filter it from the keyboard: Enter, Space (the first item), Escape.
      await clickHeader(page, sid);
      await focusGrid(page);
      await page.keyboard.press("Enter");
      await eventually(() => keyFocus(page), (f) => f?.slicerId === sid, "Enter did not go in");
      const slots = await slotsOf(page, sid);
      if (slots[0] === SELECT_ALL) await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Space");
      await slicerLanded(page);
      await eventually(() => slicerRow(page, sid), (s) => sameSet(s.selectedItems, [values[0]]), "precondition: Space filtered the slicer");
      await page.keyboard.press("Escape");
      await eventually(() => keyFocus(page), (f) => f === null, "precondition: Escape left the items");
      await eventually(() => rowLabels(page, pid), (r) => r.length === 1, "precondition: the pivot shows one row");

      // ---- Alt+C, outside the items.
      await page.keyboard.press("Alt+KeyC");
      await slicerLanded(page);
      await eventually(() => slicerRow(page, sid), (s) => s.selectedItems === null, "Alt+C did not clear the slicer's filter");
      await eventually(() => rowLabels(page, pid), (r) => r.length === 4, "Alt+C did not bring every pivot row back");
      await eventually(() => announced(page), (t) => t === "Filter cleared", "the live region did not say the filter was cleared");
      expect(await keyFocus(page), "Alt+C went into the slicer").toBeNull();
      expect((await objectOf(page, SLICER_REGION(sid))).selected, "Alt+C deselected the slicer").toBe(true);
    } finally {
      await endClean(page);
    }
  });
});

// ---------------------------------------------------------------------------
// K-2. Canvas: the nudge and the canvas's Escape stand down; Tab goes on
// ---------------------------------------------------------------------------

test.describe("the keyboard inside a selected slicer (canvas)", () => {
  test("K-2 (canvas): Enter then Right does NOT move the slicer and Down moves the ring; Escape twice leaves, then deselects; Enter then Tab selects the next object and leaves the first", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      const pid = await seedPivot(page);
      const sheet = await objectSheet(page, "canvas");
      const sid = await createSlicer(page, pid, sheet.index, 64, 64);
      const sid2 = await createSlicer(page, pid, sheet.index, 320, 64);
      await eventually(() => slicerItemValues(page, sid), (v) => v.length === 4, "the slicer never listed the four regions", 15_000);
      const slots = await slotsOf(page, sid);
      const before = await slicerRow(page, sid);

      await clickHeader(page, sid);
      await focusGrid(page);
      expect((await selectedObjects(page)).map((o) => o.id), "precondition: the first slicer alone is selected").toEqual([SLICER_REGION(sid)]);

      // ---- Enter, then Right: the canvas nudge stands down.
      await page.keyboard.press("Enter");
      await eventually(() => keyFocus(page), (f) => f?.slicerId === sid && f.value === slots[0], "Enter did not go into the selected slicer");
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(900); // a nudge burst commits at the key's release or after 400 ms
      const after = await slicerRow(page, sid);
      expect(
        { x: after.x, y: after.y },
        "the slicer MOVED: the canvas nudge took the arrow from the slicer the keyboard is inside",
      ).toEqual({ x: before.x, y: before.y });
      expect((await keyFocus(page))?.value, "a one-column slicer has nothing to its right: the focus stays").toBe(slots[0]);
      await page.keyboard.press("ArrowDown");
      await eventually(() => keyFocus(page), (f) => f?.value === slots[1], "Down did not move the focus ring on a canvas");
      const still = await slicerRow(page, sid);
      expect({ x: still.x, y: still.y }, "Down nudged the slicer").toEqual({ x: before.x, y: before.y });

      // ---- Escape twice: leave the items, then the canvas deselects.
      await page.keyboard.press("Escape");
      await eventually(() => keyFocus(page), (f) => f === null, "the first Escape did not leave the items");
      expect((await objectOf(page, SLICER_REGION(sid))).selected, "the FIRST Escape deselected the slicer (the canvas binding took it)").toBe(true);
      await page.keyboard.press("Escape");
      await eventually(() => objectOf(page, SLICER_REGION(sid)), (o) => !o.selected, "the second Escape (the canvas's) did not deselect the slicer");

      // ---- Enter, then Tab: the next object, and the keyboard leaves the first.
      await clickHeader(page, sid);
      await focusGrid(page);
      await page.keyboard.press("Enter");
      await eventually(() => keyFocus(page), (f) => f?.slicerId === sid, "Enter did not go in again");
      await page.keyboard.press("Tab");
      await eventually(
        () => selectedObjects(page),
        (sel) => sel.length === 1 && sel[0].id === SLICER_REGION(sid2),
        "Tab after Enter did not select the next object",
      );
      expect(await keyFocus(page), "the keyboard stayed inside the slicer Tab left").toBeNull();

      // Nothing was filtered on the way.
      expect((await slicerRow(page, sid)).selectedItems).toBeNull();
    } finally {
      await endClean(page);
    }
  });
});

// ---------------------------------------------------------------------------
// K-3. The timeline (worksheet): a preview, ONE commit, ONE Ctrl+Z
// ---------------------------------------------------------------------------

/** Date / Product / Sales: one product per month, January to May 2026 (TEXT dates, as fixall-pivot F). */
const TL_DATA: Array<Array<string | number | null>> = [
  ["Date", "Product", "Sales"],
  ["'2026-01-10", "Apples", 1],
  ["'2026-02-05", "Pears", 2],
  ["'2026-03-03", "Plums", 4],
  ["'2026-04-14", "Kiwis", 8],
  ["'2026-05-20", "Figs", 16],
];

/** The product's own timeline focus module (the live instance the app loaded). */
const TIMELINE_KEY_FOCUS = "/extensions/TimelineSlicer/lib/timelineKeyFocus.ts";
const TIMELINE_GESTURE_VIEW = "/extensions/TimelineSlicer/lib/timelineGestureView.ts";
const TIMELINE_REGION = (tid: string) => `timeline-slicer-${tid}`;

/** Sheet1: TL_DATA, a pivot at E1 (Product rows, Sum of Sales) and a months timeline on its Date field. */
async function seedTimeline(page: Page): Promise<{ pid: string; tid: string }> {
  await writeTable(page, TL_DATA);
  // TEXT dates: a typed (numeric) date lands the timeline in year -2688 (fixall-pivot TL-NUM).
  expect((await cellAt(page, 0, 1, 0))?.type, "precondition: the dates are text").toBe("text");
  const pid = await createRangePivot(page, { sourceRange: "Sheet1!A1:C6", destinationCell: "E1", sourceSheet: 0, destinationSheet: 0 });
  await configurePivot(page, {
    pivotId: pid,
    rowFields: [{ sourceIndex: 1, name: "Product" }],
    valueFields: [{ sourceIndex: 2, name: "Sum of Sales", aggregation: "sum" }],
  });
  const tl = await callModule<{ id: string } | null>(page, MOD.TIMELINE_STORE, "createTimelineAsync", [
    { name: "Date", sheetIndex: 0, x: 470, y: 180, width: 420, height: 140, sourceId: pid, fieldName: "Date", level: "months" },
  ]);
  expect(tl, "precondition: a timeline was created on the pivot's Date field").toBeTruthy();
  await page.waitForTimeout(600);
  return { pid, tid: tl!.id };
}

/** The keyboard's focus inside a timeline, from the product's own module (null = not inside one). */
async function timelineKeyFocus(page: Page): Promise<{ timelineId: string; periodStart: string; anchorStart: string | null } | null> {
  await installAppImport(page);
  return page.evaluate(async (mod) => {
    const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, unknown>> };
    const m = await w.__appImport(mod);
    const f = (m.getTimelineKeyFocus as () => { timelineId: string; periodStart: string; anchorStart: string | null } | null)();
    return f ? { timelineId: f.timelineId, periodStart: f.periodStart, anchorStart: f.anchorStart } : null;
  }, TIMELINE_KEY_FOCUS);
}

/** The range the timeline PAINTS instead of its committed one (a drag's, the keyboard's preview, a landing commit's). */
async function timelinePreview(page: Page, tid: string): Promise<{ first: number; last: number } | null> {
  await installAppImport(page);
  return page.evaluate(
    async ({ mod, tid }) => {
      const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, unknown>> };
      const m = await w.__appImport(mod);
      return (m.getTimelineRangePreview as (id: string) => { first: number; last: number } | null)(tid);
    },
    { mod: TIMELINE_GESTURE_VIEW, tid },
  );
}

/**
 * A CLIENT strip along the LEFT edge of period `index`'s tile (3 x 10 css px at
 * its vertical middle): where the focus ring's 2 px dark outline is painted.
 * From the extension's own layout (`computeTimelineLayout`) and scroll -- the
 * numbers the painter uses -- never a copy of them.
 */
async function timelineRingStrip(page: Page, tid: string, index: number): Promise<PixelClip> {
  await installAppImport(page);
  const r = await page.evaluate(
    async ({ tid, index, mods }) => {
      const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, (...a: unknown[]) => unknown>> };
      const zones = await w.__appImport(mods.zones);
      const view = await w.__appImport(mods.view);
      const geo = await w.__appImport(mods.geo);
      const store = await w.__appImport(mods.store);
      const grid = await w.__appImport(mods.grid);
      const tl = store.getTimelineById(tid) as Record<string, unknown> | undefined;
      const data = store.getCachedTimelineData(tid) as { periods: unknown[] } | undefined;
      if (!tl || !data) return { error: `no timeline ${tid}` };
      const b = geo.timelineCanvasBounds(tl) as { x: number; y: number } | null;
      if (!b) return { error: "no bounds" };
      const layout = zones.computeTimelineLayout(tl, data.periods.length) as { periodWidth: number; tileTop: number; periodH: number };
      const scroll = zones.clampScroll(layout, view.getScrollOffset(tid)) as number;
      const area = (document.querySelector("[data-grid-area]") as HTMLElement).getBoundingClientRect();
      const zoom = ((grid.getGridStateSnapshot() as { zoom?: number } | null)?.zoom ?? 1) as number;
      return {
        x: area.left + (b.x + index * layout.periodWidth - scroll) * zoom,
        y: area.top + (b.y + layout.tileTop + layout.periodH / 2 - 5) * zoom,
        width: 3 * zoom,
        height: 10 * zoom,
      };
    },
    {
      tid,
      index,
      mods: {
        zones: "/extensions/TimelineSlicer/lib/timelineZones.ts",
        view: "/extensions/TimelineSlicer/lib/timelineView.ts",
        geo: MOD.TIMELINE_CANVAS_GEO,
        store: MOD.TIMELINE_STORE,
        grid: "/src/api/grid.ts",
      },
    },
  );
  if ("error" in r) throw new Error(`timelineRingStrip: ${r.error}`);
  return r as PixelClip;
}

test.describe("the keyboard inside a selected timeline (worksheet)", () => {
  test("K-3 (worksheet): Enter, Right, Shift+Right twice, Enter -- the preview writes nothing, the commit is ONE range of three periods in ONE undo step, and ONE Ctrl+Z restores the previous range", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      const { pid, tid } = await seedTimeline(page);

      // The previous range: January, by a script (the store's non-asking door).
      await callModule(page, MOD.TIMELINE_STORE, "updateTimelineSelectionAsync", [tid, "2026-01-01", "2026-01-31"]);
      await timelineLanded(page);
      await eventually(() => timelineRange(page, tid), (r) => r === "2026-01..2026-01", "precondition: a script narrowed the timeline to January");
      await eventually(() => rowLabels(page, pid), (r) => sameSet(r, ["Apples"]), "precondition: January shows Apples only");

      // A cell first (column A is free of objects), so the active cell is known;
      // then the timeline's header (frame) selects it.
      await click(page, await clientOf(page, 30, 300));
      await click(page, await timelineZonePoint(page, tid, "header"));
      await eventually(() => objectOf(page, TIMELINE_REGION(tid)), (o) => o.selected, "a click on the timeline's header did not select it");
      await focusGrid(page);
      const cell0 = await gridSelection(page);
      expect(cell0, "precondition: Core has an active cell").not.toBeNull();
      expect(cell0!.startRow >= 6 && cell0!.startCol === 0, "precondition: the active cell is below the data (A7 or lower)").toBe(true);
      // Before depth0: giving the cell its value is an undo step of its own.
      await seedCellBehind(page, cell0!);
      const depth0 = (await undoState(page)).undoDepth;
      const ring = await timelineRingStrip(page, tid, 3);
      const ringBefore = await ringPixelsAt(page, ring);

      // ---- Enter goes in on January, the first period of the range.
      await page.keyboard.press("Enter");
      await eventually(
        () => timelineKeyFocus(page),
        (f) => f?.timelineId === tid && f.periodStart === "2026-01-01",
        "Enter did not go into the selected timeline on the first period of its range",
      );
      await eventually(() => announced(page), (t) => t === "Date: Jan 2026, 1 of 5, selected", "the live region does not say where the focus went in");

      // ---- Right, then Shift+Right twice: a PREVIEW of February..April, nothing written.
      await page.keyboard.press("ArrowRight");
      await eventually(() => timelineKeyFocus(page), (f) => f?.periodStart === "2026-02-01", "Right did not move the focus to February");
      await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press("Shift+ArrowRight");
      await eventually(() => timelinePreview(page, tid), (p) => p?.first === 1 && p.last === 3, "Shift+Right twice did not preview February..April");
      await eventually(
        () => announced(page),
        (t) => t === "Feb 2026 to Apr 2026 previewed, 3 periods",
        "the live region does not say what is previewed",
      );
      const ringNow = await ringPixelsAt(page, ring);
      expect(ringNow, `no focus ring is painted on April, the focused period (near-black pixels ${ringBefore} -> ${ringNow})`).toBeGreaterThan(ringBefore + 4);
      await page.waitForTimeout(400);
      expect(await timelineRange(page, tid), "a Shift+arrow WROTE the timeline (the preview must be shown, never committed)").toBe("2026-01..2026-01");
      expect((await undoState(page)).undoDepth, "a Shift+arrow took an undo step").toBe(depth0);

      // ---- Enter commits ONCE: one range of three periods, one undo step.
      await page.keyboard.press("Enter");
      await timelineLanded(page);
      await eventually(() => timelineRange(page, tid), (r) => r === "2026-02..2026-04", "Enter did not commit February..April");
      await eventually(() => rowLabels(page, pid), (r) => sameSet(r, ["Pears", "Plums", "Kiwis"]), "the pivot is not filtered to February..April");
      expect((await undoState(page)).undoDepth, "the keyboard's commit is not exactly ONE undo step").toBe(depth0 + 1);
      await eventually(() => announced(page), (t) => t === "Feb 2026 to Apr 2026 selected", "the live region did not say what was selected");
      expect(await gridSelection(page), "the keys INSIDE the timeline moved the ACTIVE CELL (they reached the grid's own keyboard)").toEqual(cell0);
      expect((await objectOf(page, TIMELINE_REGION(tid))).selected, "the keys inside the timeline deselected it").toBe(true);
      expect((await timelineKeyFocus(page))?.periodStart, "the commit moved the focus or left the timeline").toBe("2026-04-01");

      // ---- The cell BEHIND the timeline is out of reach; the keyboard stays inside.
      await keysNeverReachTheCellBehind(page, cell0!);
      expect((await timelineKeyFocus(page))?.periodStart, "a refused key took the keyboard out of the timeline").toBe("2026-04-01");
      expect((await undoState(page)).undoDepth, "a refused key took an undo step").toBe(depth0 + 1);

      // ---- Escape leaves (no preview is live after the commit); the timeline stays selected.
      await page.keyboard.press("Escape");
      await eventually(() => timelineKeyFocus(page), (f) => f === null, "Escape did not leave the timeline's periods");
      expect((await objectOf(page, TIMELINE_REGION(tid))).selected, "Escape deselected the timeline (it should only leave its periods)").toBe(true);

      // ---- ONE Ctrl+Z restores January, range and pivot rows.
      await pressUndo(page);
      await eventually(() => timelineRange(page, tid), (r) => r === "2026-01..2026-01", "ONE Ctrl+Z did not restore the previous range (January)");
      await eventually(() => rowLabels(page, pid), (r) => sameSet(r, ["Apples"]), "ONE Ctrl+Z did not also restore the pivot rows");
      expect((await undoState(page)).undoDepth).toBe(depth0);
    } finally {
      await endClean(page);
    }
  });
});

// ---------------------------------------------------------------------------
// K-5. The key grammar: a shortcut recorded on Ctrl+Space fires (M8 S9)
// ---------------------------------------------------------------------------

/** Settings > Keyboard Shortcuts, filtered to one command's row (fixall-edit.spec.ts's route). */
async function openShortcutRow(page: Page, label: string) {
  await executeCommand(page, "settings.showTab", "keybindings");
  // The deep link's tab event can fire before the view mounts: pick the tab as a user does.
  const tab = page.locator("button", { hasText: /^Keyboard Shortcuts$/ }).first();
  await tab.waitFor({ state: "visible", timeout: 10_000 });
  await tab.click();
  const search = page.locator('input[placeholder="Search shortcuts..."]');
  await search.waitFor({ state: "visible", timeout: 10_000 });
  await search.fill(label);
  await page.waitForTimeout(300);
  const row = page.locator("tr", { has: page.locator("span", { hasText: new RegExp(`^${label}$`) }) }).first();
  await row.waitFor({ state: "visible", timeout: 5000 });
  return row;
}

/** Close the side panel Settings opened in (the activity bar's own store). */
async function closeSidePanel(page: Page): Promise<void> {
  await installAppImport(page);
  await page.evaluate(async (mod) => {
    const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, unknown>> };
    const m = (await w.__appImport(mod)) as { useActivityBarStore: { getState: () => { close: () => void } } };
    m.useActivityBarStore.getState().close();
  }, ACTIVITY_BAR_STORE);
  await page.waitForTimeout(200);
}

/** Core's selection is the WHOLE column `col` (the grid's Ctrl+Space, outside a table). */
const isWholeColumn = (s: Sel | null, col: number): boolean =>
  s !== null && s.startCol === col && s.endCol === col && s.startRow === 0 && s.endRow > 1000;

/** Core's selection is the one cell `cell` again. */
const isTheCell = (s: Sel | null, cell: Sel): boolean =>
  s !== null && s.startRow === cell.startRow && s.endRow === cell.endRow && s.startCol === cell.startCol && s.endCol === cell.endCol;

test.describe("the key grammar: Space (worksheet)", () => {
  test("K-5 (worksheet): with nothing bound Ctrl+Space selects the column; Insert Hyperlink recorded on Ctrl+Space in Settings shows 'Ctrl+Space' and names the grid's Select Entire Column; then Ctrl+Space opens Insert Hyperlink and selects nothing; after a reset the grid has its key back", async ({
    appPage: page,
  }) => {
    test.setTimeout(180_000);
    try {
      await newFile(page);
      await callModule(page, API_KEYBINDINGS, "resetAllKeybindings");
      await closeSidePanel(page);

      // A cell (column A is free of objects), so the active cell and its column are known.
      const cellPoint = await clientOf(page, 30, 110);
      await click(page, cellPoint);
      await focusGrid(page);
      const cell0 = await gridSelection(page);
      expect(cell0, "precondition: Core has an active cell").not.toBeNull();
      const col = cell0!.endCol;

      // ---- Positive control: nothing bound, the GRID's own Ctrl+Space selects the column.
      await page.keyboard.press("Control+Space");
      await eventually(
        () => gridSelection(page),
        (s) => isWholeColumn(s, col),
        "with nothing bound, Ctrl+Space did not select the column (the grid lost its own key)",
      );
      await click(page, cellPoint);
      await focusGrid(page);
      await eventually(() => gridSelection(page), (s) => isTheCell(s, cell0!), "precondition: a click put the selection back on the cell");

      // ---- Record Ctrl+Space for Insert Hyperlink, the way a user does.
      const row = await openShortcutRow(page, "Insert Hyperlink");
      await row.getByRole("button", { name: "Edit" }).click();
      await page.keyboard.press("Control+Space");
      const editing = page.locator("tr").filter({ hasText: "Insert Hyperlink" }).first();
      await expect(
        editing,
        "the capture box does not show the recorded key as Ctrl+Space (the grammar trimmed the space away)",
      ).toContainText("Ctrl+Space");
      await expect(
        editing,
        "Settings presented Ctrl+Space as FREE: the grid's own Select Entire Column is not named as the conflict",
      ).toContainText("Select Entire Column");
      await editing.getByRole("button", { name: "Accept" }).click();
      await eventually(
        () => callModule<string>(page, API_KEYBINDINGS, "getEffectiveCombo", ["ext.hyperlinks.insert"]),
        (c) => c === "Ctrl+Space",
        "Accept did not store Ctrl+Space",
      );
      await closeSidePanel(page);

      // ---- Ctrl+Space now opens Insert Hyperlink, and the grid's Select Column does not run.
      await click(page, cellPoint);
      await focusGrid(page);
      const cell1 = await gridSelection(page);
      expect(cell1 !== null && isTheCell(cell1, cell0!), "precondition: the selection is the cell").toBe(true);
      await page.keyboard.press("Control+Space");
      await eventually(
        () => openDialogs(page),
        (d) => d.some((x) => x.id === "insert-hyperlink"),
        "Ctrl+Space did not open Insert Hyperlink (the recorded shortcut never fired)",
      );
      expect(await gridSelection(page), "Ctrl+Space ALSO reached the grid: the user's binding must take the key").toEqual(cell1);
      await closeDialogsAndOverlays(page);

      // ---- Reset: the grid has its key back, and nothing opens.
      await callModule(page, API_KEYBINDINGS, "resetUserKeybinding", ["ext.hyperlinks.insert"]);
      await click(page, cellPoint);
      await focusGrid(page);
      await page.keyboard.press("Control+Space");
      await eventually(
        () => gridSelection(page),
        (s) => isWholeColumn(s, col),
        "after the reset Ctrl+Space no longer selects the column",
      );
      expect(await openDialogs(page), "after the reset Ctrl+Space still opened a dialog").toEqual([]);
    } finally {
      await callModule(page, API_KEYBINDINGS, "resetAllKeybindings").catch(() => undefined);
      await closeDialogsAndOverlays(page).catch(() => undefined);
      await closeSidePanel(page).catch(() => undefined);
      await endClean(page);
    }
  });
});

// ---------------------------------------------------------------------------
// K-6. A BARE printable key is refused as a shortcut (owner call 23)
// ---------------------------------------------------------------------------

/** The sentence every refusal of a bare key carries (@api/keybindings bareKeyShortcutRefusal). */
const BARE_KEY_REFUSED = "cannot be a shortcut on its own";

test.describe("the key grammar: a bare key is refused (worksheet)", () => {
  test("K-6 (worksheet): recording a BARE Space, a bare letter or a bare Enter for Insert Hyperlink in Settings shows the refusal sentence and offers no Accept; nothing is stored; Ctrl+Space in the same box clears the refusal and is offered", async ({
    appPage: page,
  }) => {
    test.setTimeout(120_000);
    try {
      await newFile(page);
      await callModule(page, API_KEYBINDINGS, "resetAllKeybindings");
      await closeSidePanel(page);
      const before = await callModule<string>(page, API_KEYBINDINGS, "getEffectiveCombo", ["ext.hyperlinks.insert"]);

      const row = await openShortcutRow(page, "Insert Hyperlink");
      await row.getByRole("button", { name: "Edit" }).click();
      const editing = page.locator("tr").filter({ hasText: "Insert Hyperlink" }).first();
      const refusal = editing.locator("[data-shortcut-refusal]");

      for (const [key, shown] of [
        ["Space", "Space"],
        ["k", "K"],
        ["Enter", "Enter"],
      ] as const) {
        await page.keyboard.press(key);
        await expect(editing, `the capture box does not show the recorded bare ${shown}`).toContainText(shown);
        await expect(refusal, `a bare ${shown} was not refused in Settings`).toContainText(BARE_KEY_REFUSED);
        await expect(
          editing.getByRole("button", { name: "Accept" }),
          `a bare ${shown} could be accepted as a shortcut`,
        ).toHaveCount(0);
      }
      expect(
        await callModule<boolean>(page, API_KEYBINDINGS, "hasUserOverride", ["ext.hyperlinks.insert"]),
        "a refused bare key was stored as the shortcut",
      ).toBe(false);
      expect(await callModule<string>(page, API_KEYBINDINGS, "getEffectiveCombo", ["ext.hyperlinks.insert"])).toBe(before);

      // ---- Positive control: the same box, Ctrl+Space -- a key the grid owns is WARNED, never refused.
      await page.keyboard.press("Control+Space");
      await expect(editing).toContainText("Ctrl+Space");
      await expect(refusal, "the refusal outlived the bare key").toHaveCount(0);
      await expect(editing.getByRole("button", { name: "Accept" }), "Ctrl+Space was not offered").toHaveCount(1);
      await page.keyboard.press("Escape");
    } finally {
      await callModule(page, API_KEYBINDINGS, "resetAllKeybindings").catch(() => undefined);
      await closeDialogsAndOverlays(page).catch(() => undefined);
      await closeSidePanel(page).catch(() => undefined);
      await endClean(page);
    }
  });
});
