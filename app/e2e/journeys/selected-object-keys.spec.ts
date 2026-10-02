/**
 * SELECTED OBJECT KEYS -- BUG-0270. SK-1..SK-8 passed live in E2E run 10
 * (2026-10-01); SK-9 is WRITTEN, NOT YET RUN LIVE. Nine steps, run in this
 * file's order: SK-1, SK-2, SK-3, SK-4, SK-5 (worksheet), SK-6 (canvas), SK-7,
 * SK-8 (worksheet; added by the fix's review, 2026-10-01), SK-9 (worksheet;
 * owner call 25, 2026-10-02).
 *
 * The defect: a slicer or timeline that is merely SELECTED on a WORKSHEET (a
 * click on its header -- the keyboard not inside it) left the active cell
 * hidden behind it open to the keyboard: Delete cleared that cell (the
 * dispatcher's Clear Contents) and the slicer stayed; a typed character opened
 * an edit in it; F2, Space and Alt+Down acted on it. M8c closed this only while
 * the keyboard is INSIDE the object.
 *
 * The rule (Excel parity first; extensions/BuiltIn/ObjectPosition/lib/
 * selectedObjectKeys.ts): while any floating object is selected on a worksheet
 * the selection owns the keyboard. Delete / Backspace remove the selected
 * object(s) through each family's own delete as ONE undo step (a family's own
 * Delete door -- Charts, Controls, a floating grid -- keeps the key); a typed
 * character, F2, Space and Alt+Down do NOTHING to the cells (every door refuses
 * with "... is not available while an object is selected ..."); Escape goes
 * back to the cells. A protected sheet refuses the delete with the backend's
 * own sentence. Arrows are left as they were (Calcula moves the cell cursor,
 * which deselects the object; Excel nudges -- not in this fix). The object
 * INSERTS -- Insert Shape, Insert > Controls > Button, Insert Image -- are not
 * refused: they place a new object at the active cell, as in Excel (owner call
 * 25; the claim admits the door kind "objectInsert").
 *
 * This journey reads the result back from the BACKEND (`get_all_slicers`,
 * `get_all_timeline_slicers`, `get_all_controls`, the pivot's view, the cell,
 * `get_undo_state`), Core's live grid state (the active cell, whether an edit
 * is open), the object-selection seam and the toasts on screen -- never "the
 * key press returned", and never a golden.
 *
 *   SK-1 (worksheet, the reported repro) A pivot and a slicer on its Region
 *        field, filtered from the keyboard (Enter, the first item, Escape: the
 *        slicer stays selected, the keyboard is no longer inside). A8 holds
 *        "Keep me" and is the active cell; a click on the slicer's header
 *        selects it. x, F2, Space and Alt+Down: no cell edit opens, A8 keeps
 *        its value, the active cell does not move, the slicer stays selected,
 *        and a toast says "is not available while an object is selected".
 *        Delete: the slicer is gone from the backend, every pivot row is back
 *        (deleting a slicer clears its filter), A8 still holds "Keep me", and
 *        the undo step is "Delete Objects". ONE Ctrl+Z: the slicer is back
 *        with its filter, and the pivot shows one row again.
 *   SK-2 (worksheet, inside vs selected; the positive control) Enter goes
 *        inside: Delete deletes NOTHING (the inside claim refuses). Escape
 *        leaves the items (still selected); Escape again deselects the slicer
 *        (the generic Escape). Then "y" + Enter types into A8: the claim ended
 *        with the selection.
 *   SK-3 (worksheet, a timeline) A months timeline a script narrowed to
 *        January; a click on its header selects it; Backspace deletes it.
 *        ONE Ctrl+Z: it is back with January.
 *   SK-4 (worksheet, protected = "locked") The sheet protected without Edit
 *        Objects: Delete on a selected slicer leaves it standing, one toast
 *        says it was "not deleted", A8 keeps its value and no undo step is
 *        taken.
 *   SK-5 (worksheet, a chart and a shape) A chart selected by a click on its
 *        body: x, F2 and Space open no edit and A8 keeps its value; Escape
 *        deselects the chart. A shape selected by a click: x opens no edit;
 *        Delete deletes the shape (Controls' own door -- the control that a
 *        family door keeps the key).
 *   SK-6 (canvas, the dead key) ONE slicer on a canvas, selected: Delete
 *        deletes it (before BUG-0270 nothing happened: the canvas's own Delete
 *        acts only on a selection that spans families, and a slicer has no
 *        Delete door of its own). ONE Ctrl+Z brings it back.
 *   SK-7 (worksheet, press parity -- review finding 2) A chart clicked, then
 *        the slicer's header: the chart is no longer selected, and Delete
 *        deletes ONLY the slicer (before, the chart clicked EARLIER stayed
 *        selected, Charts' door owned Delete and deleted the chart). Ctrl+Z.
 *        Then the chart clicked and the slicer Ctrl+clicked: both selected, and
 *        Delete deletes BOTH as ONE undo step "Delete Objects".
 *   SK-8 (worksheet -- review findings 3 and 6) With the slicer selected the
 *        formula bar is EMPTY and read-only; a click into it opens no edit of
 *        A8, gives the focus back and says why. A click on the cell that is
 *        ALREADY active (A8) deselects the slicer, and "z" + Enter reaches A8.
 *   SK-9 (worksheet -- owner call 25, Excel parity) With the slicer selected,
 *        "x" is still refused (the claim is on), and then Insert > Controls >
 *        Button, from the MENU BAR, inserts a button anchored at A8 -- the
 *        active cell the slicer left where it was -- with no refusal toast;
 *        the slicer is still there.
 *
 * NOT LIVE (unit tier only, extensions/BuiltIn/ObjectPosition/__tests__/
 * selectedObjectKeys.test.ts): a chart walked down to its TITLE keeps
 * Backspace (Charts' smallest-thing delete, never the whole chart); a task
 * pane's button or an open grip menu with the keyboard; the generic claim
 * standing BEHIND a floating grid's cell; a read-only (subscribed) canvas page
 * refusing the delete (src/api/__tests__/objectSelectionReadOnlyDelete.test.ts).
 * From the review: Delete with the timeline's or a pivot box's right-click
 * MENU open deletes nothing and the timeline's menu closes on Escape
 * (TimelineSlicer timelineKeyboard.test.ts, Pivot pivotVisualSelectionRef.test.ts);
 * fx and the Name Box refuse while an object is selected
 * (src/shell/FormulaBar/__tests__/formulaBarFxSelectionOwner.test.tsx,
 * nameBoxExternalAddress.test.tsx); Design Mode ending deselects a selected
 * button (Controls controlDesignModeDeselect.test.ts); a typed word is ONE
 * toast (T14).
 *
 * SABOTAGE (each must turn its step RED; apply, CONFIRM the behaviour changed,
 * run a fresh journey -- Vite serves the frontend, so a TypeScript sabotage
 * needs no Rust build -- see the message, then restore BYTE-IDENTICAL by sha256;
 * every file named here is LF; line numbers as of 2026-10-01):
 *   - extensions/BuiltIn/ObjectPosition/lib/selectedObjectKeys.ts:141
 *     `selectedObjectOwnsSelection`: `return false;` -> SK-1 "x opened an edit
 *     in the cell behind the slicer" (type-to-edit no longer refused).
 *   - extensions/BuiltIn/ObjectPosition/lib/selectedObjectKeys.ts:149
 *     `objectDeleteApplies`: `return false;` -> SK-1 "Delete did not delete the
 *     selected slicer" (with the claim still on, the hidden cell is refused
 *     rather than cleared; with BOTH sabotages the reported defect is back:
 *     A8 cleared).
 *   - extensions/Slicer/lib/slicerObjectSelection.ts:82 `ownsKey`: drop
 *     `|| key === "Delete"` -> SK-2 "Delete INSIDE the slicer deleted it" (and
 *     object-keyboard.spec.ts K-1, which presses Delete inside).
 *   - extensions/BuiltIn/ObjectPosition/lib/selectedObjectKeys.ts:163
 *     `objectEscapeApplies`: `return false;` -> SK-2 "Escape did not deselect
 *     the slicer".
 *   - extensions/TimelineSlicer/lib/timelineObjectSelection.ts:82 `ownsKey`:
 *     `if (key === "Escape") {` -> no live step turns red for a SELECTED
 *     timeline (it is the inside case); object-keyboard.spec.ts K-3 does.
 *   - src/api/objectSelection.ts:890 `noteWorksheetObjectPress`: `return;` as
 *     its first line -> SK-7 "the chart clicked EARLIER stayed selected beside
 *     the slicer" (and, with it, "Delete deleted the chart the user clicked
 *     BEFORE the slicer").
 *   - src/api/objectSelection.ts:670 `shouldActOnWholeObjectSelection`: put
 *     back `getGridStateSnapshot()?.surface === "canvas" &&` -> SK-7 "Delete on
 *     a chart + slicer selection left the slicer".
 *   - src/shell/FormulaBar/FormulaInput.tsx:520 the selection-owner branch of
 *     `handleFocus`: `&& false` -> SK-8 "a click into the formula bar opened
 *     an edit in the cell behind the object".
 *   - extensions/BuiltIn/ObjectPosition/lib/selectedObjectKeys.ts:272 delete
 *     the `onGridCellPressed` line -> SK-8 "a click on the active cell left the
 *     slicer selected".
 *   - extensions/BuiltIn/ObjectPosition/lib/selectedObjectKeys.ts:268 delete
 *     the `admits: OBJECT_INSERT_ADMITTED,` line -> SK-9 "Insert > Controls >
 *     Button was refused while the slicer is selected" (line numbers of this
 *     file re-read 2026-10-02, after the claim gained `admits`).
 *   - extensions/Controls/lib/insertAnchor.ts:31 `refuseObjectInsertIfSelectionOwned`:
 *     `return refuseIfSelectionOwned(action);` (no door kind) -> SK-9, the same
 *     message.
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
import {
  barSpec,
  clickObject,
  controlsOn,
  createChart,
  createShape,
  gridBox,
  objects,
  patchActiveCanvas,
  protectActiveSheet,
  slicersAll,
  startToasts,
  timelinesAll,
  toasts,
  unprotectActiveSheet,
  type Obj,
} from "../helpers/canvas-live";
import { gridSelection, type Sel } from "../helpers/edit-harness";
import { slicerItemValues, slicerLanded, slicerRow } from "../helpers/slicers";
import { timelineLanded, timelineRange, timelineZonePoint } from "../helpers/timelines";

// ---------------------------------------------------------------------------
// Data and set-ups (journeys duplicate their helpers; never import a spec)
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

/** What the refused doors say while an object is selected (selectedObjectKeys.ts). */
const REFUSED = "is not available while an object is selected";

/** What A8 holds before the keys are pressed: the value it must keep. */
const BEHIND = "Keep me";

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

const SLICER_REGION = (sid: string) => `slicer-${sid}`;
const TIMELINE_REGION = (tid: string) => `timeline-slicer-${tid}`;

/** The published object of a region id, with its selection state; null when it is not published. */
async function objectOrNull(page: Page, regionId: string): Promise<Obj | null> {
  return (await objects(page)).find((x) => x.id === regionId) ?? null;
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
  await eventually(() => objectOrNull(page, SLICER_REGION(sid)), (o) => o?.selected === true, "a click on the slicer's header did not select it");
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

/** Whether ANY cell edit is open: Core's own, or a floating grid's external session (@api/editing). */
async function cellEditOpen(page: Page): Promise<boolean> {
  return callModule<boolean>(page, "/src/api/editing.ts", "isCellEditInProgress");
}

/**
 * Click A8 (column A is free of objects; the data ends at row 5 or 6), give it
 * BEHIND, and return Core's selection there: the cell the keys must not reach.
 */
async function activeCellA8(page: Page): Promise<Sel> {
  await click(page, await clientOf(page, 30, 150));
  await focusGrid(page);
  const cell = await gridSelection(page);
  expect(cell, "precondition: Core has an active cell").not.toBeNull();
  expect(cell!.startRow === 7 && cell!.startCol === 0, `precondition: the active cell is A8 (got R${cell!.startRow}C${cell!.startCol})`).toBe(true);
  await writeTable(page, [[BEHIND]], cell!.startRow, cell!.startCol);
  await eventually(() => cellAt(page, 0, cell!.startRow, cell!.startCol), (c) => c?.display === BEHIND, "precondition: A8 holds a value");
  return { startRow: cell!.startRow, startCol: cell!.startCol, endRow: cell!.endRow, endCol: cell!.endCol };
}

/** The active cell's value and Core's selection are what they were; no edit is open. */
async function cellUntouched(page: Page, cell: Sel, what: string): Promise<void> {
  expect(await cellEditOpen(page), `${what} opened an edit in the cell behind the object`).toBe(false);
  expect((await cellAt(page, 0, cell.startRow, cell.startCol))?.display, `${what} changed the cell behind the object`).toBe(BEHIND);
  const now = await gridSelection(page);
  expect(
    now && { startRow: now.startRow, startCol: now.startCol, endRow: now.endRow, endCol: now.endCol },
    `${what} moved the active cell`,
  ).toEqual(cell);
}

/** Whether a toast that appeared since startToasts says the door was refused for a selected object. */
async function sawRefusal(page: Page): Promise<boolean> {
  return (await toasts(page)).some((t) => t.text.includes(REFUSED));
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
// SK-1 / SK-2. A selected slicer on a worksheet
// ---------------------------------------------------------------------------

test.describe("a SELECTED slicer owns the keyboard (worksheet)", () => {
  test("SK-1 (worksheet): x, F2, Space and Alt+Down never reach the cell behind a selected slicer; Delete deletes the slicer as ONE undo step, its filter with it; ONE Ctrl+Z brings both back", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      const pid = await seedPivot(page);
      const sid = await createSlicer(page, pid, 0, 320, 192);
      const values = await eventually(() => slicerItemValues(page, sid), (v) => v.length === 4, "the slicer never listed the four regions", 15_000);
      const name = (await slicersAll(page)).find((x) => x.id === sid)?.name ?? "";
      expect(name, "precondition: the backend names the slicer").not.toBe("");

      // Filter it from the keyboard (as object-keyboard K-4): Enter, the first item, Escape.
      await clickHeader(page, sid);
      await focusGrid(page);
      await page.keyboard.press("Enter");
      await eventually(() => keyFocus(page), (f) => f?.slicerId === sid, "precondition: Enter went into the slicer");
      const firstIsSelectAll = (await keyFocus(page))?.value === SELECT_ALL;
      if (firstIsSelectAll) await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Space");
      await slicerLanded(page);
      await eventually(() => slicerRow(page, sid), (s) => sameSet(s.selectedItems, [values[0]]), "precondition: Space filtered the slicer");
      await page.keyboard.press("Escape");
      await eventually(() => keyFocus(page), (f) => f === null, "precondition: Escape left the items");
      await eventually(() => rowLabels(page, pid), (r) => r.length === 1, "precondition: the pivot shows one row");

      // A8 is the active cell and holds a value; the slicer is SELECTED (not entered).
      const cell = await activeCellA8(page);
      await clickHeader(page, sid);
      await focusGrid(page);
      expect(await keyFocus(page), "precondition: the keyboard is NOT inside the slicer").toBeNull();
      expect(await gridSelection(page).then((s) => s && s.startRow), "precondition: the header click left Core's active cell on A8").toBe(cell.startRow);

      // ---- x, F2, Space, Alt+Down: nothing reaches A8.
      await startToasts(page);
      await page.keyboard.press("x");
      await page.waitForTimeout(300);
      await cellUntouched(page, cell, "x");
      await page.keyboard.press("F2");
      await page.waitForTimeout(300);
      await cellUntouched(page, cell, "F2");
      await page.keyboard.press("Space");
      await page.waitForTimeout(300);
      await cellUntouched(page, cell, "Space");
      await page.keyboard.press("Alt+ArrowDown");
      await page.waitForTimeout(300);
      await cellUntouched(page, cell, "Alt+Down");
      expect((await objectOrNull(page, SLICER_REGION(sid)))?.selected, "a refused key deselected the slicer").toBe(true);
      await eventually(() => sawRefusal(page), (v) => v, `no toast said a key was refused while the slicer is selected ("${REFUSED}")`);

      // ---- Delete: the slicer, not the cell.
      await page.keyboard.press("Delete");
      await eventually(() => slicersAll(page), (all) => !all.some((s) => s.id === sid), "Delete did not delete the selected slicer");
      await eventually(() => rowLabels(page, pid), (r) => r.length === 4, "deleting the slicer did not clear its filter (every pivot row back)");
      expect((await cellAt(page, 0, cell.startRow, cell.startCol))?.display, "Delete cleared the cell behind the slicer").toBe(BEHIND);
      expect((await undoState(page)).undoDescription, "the delete is not ONE undo step named for it").toBe("Delete Objects");

      // ---- ONE Ctrl+Z: the slicer is back, filter and all.
      await pressUndo(page);
      const back = await eventually(
        () => slicersAll(page),
        (all) => all.some((s) => s.name === name),
        "ONE Ctrl+Z did not bring the slicer back",
      );
      const restored = back.find((s) => s.name === name)!;
      await eventually(
        () => slicerRow(page, restored.id),
        (s) => sameSet(s.selectedItems, [values[0]]),
        "ONE Ctrl+Z brought the slicer back without its filter",
      );
      await eventually(() => rowLabels(page, pid), (r) => r.length === 1, "ONE Ctrl+Z did not filter the pivot again");
    } finally {
      await endClean(page);
    }
  });

  test("SK-2 (worksheet): INSIDE the slicer Delete deletes nothing; Escape leaves, Escape again deselects; then typing reaches A8 again", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      const pid = await seedPivot(page);
      const sid = await createSlicer(page, pid, 0, 320, 192);
      await eventually(() => slicerItemValues(page, sid), (v) => v.length === 4, "the slicer never listed the four regions", 15_000);
      const cell = await activeCellA8(page);

      // ---- Inside: Delete is refused, never a delete of the slicer.
      await clickHeader(page, sid);
      await focusGrid(page);
      await page.keyboard.press("Enter");
      await eventually(() => keyFocus(page), (f) => f?.slicerId === sid, "precondition: Enter went into the slicer");
      await page.keyboard.press("Delete");
      await page.waitForTimeout(600);
      expect((await slicersAll(page)).some((s) => s.id === sid), "Delete INSIDE the slicer deleted it").toBe(true);
      await cellUntouched(page, cell, "Delete inside the slicer");

      // ---- Escape leaves the items; Escape again goes back to the cells.
      await page.keyboard.press("Escape");
      await eventually(() => keyFocus(page), (f) => f === null, "the first Escape did not leave the items");
      expect((await objectOrNull(page, SLICER_REGION(sid)))?.selected, "the FIRST Escape deselected the slicer").toBe(true);
      await page.keyboard.press("Escape");
      await eventually(
        () => objectOrNull(page, SLICER_REGION(sid)),
        (o) => o !== null && !o.selected,
        "Escape did not deselect the slicer (back to the cells)",
      );
      await cellUntouched(page, cell, "Escape");

      // ---- The claim ended with the selection: typing reaches A8.
      await page.keyboard.press("y");
      await page.keyboard.press("Enter");
      await eventually(
        () => cellAt(page, 0, cell.startRow, cell.startCol),
        (c) => c?.display === "y",
        "after Escape, typing did not reach the active cell (the claim outlived the selection)",
      );
    } finally {
      await endClean(page);
    }
  });
});

// ---------------------------------------------------------------------------
// SK-3. A selected timeline on a worksheet
// ---------------------------------------------------------------------------

/** Date / Product / Sales: one product per month, January to May 2026 (TEXT dates). */
const TL_DATA: Array<Array<string | number | null>> = [
  ["Date", "Product", "Sales"],
  ["'2026-01-10", "Apples", 1],
  ["'2026-02-05", "Pears", 2],
  ["'2026-03-03", "Plums", 4],
  ["'2026-04-14", "Kiwis", 8],
  ["'2026-05-20", "Figs", 16],
];

/** Sheet1: TL_DATA, a pivot at E1 (Product rows, Sum of Sales) and a months timeline on its Date field. */
async function seedTimeline(page: Page): Promise<{ pid: string; tid: string }> {
  await writeTable(page, TL_DATA);
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

test.describe("a SELECTED timeline owns the keyboard (worksheet)", () => {
  test("SK-3 (worksheet): Backspace deletes a selected timeline; ONE Ctrl+Z brings it back with its range", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      const { tid } = await seedTimeline(page);
      await callModule(page, MOD.TIMELINE_STORE, "updateTimelineSelectionAsync", [tid, "2026-01-01", "2026-01-31"]);
      await timelineLanded(page);
      await eventually(() => timelineRange(page, tid), (r) => r === "2026-01..2026-01", "precondition: a script narrowed the timeline to January");

      const cell = await activeCellA8(page);
      await click(page, await timelineZonePoint(page, tid, "header"));
      await eventually(() => objectOrNull(page, TIMELINE_REGION(tid)), (o) => o?.selected === true, "a click on the timeline's header did not select it");
      await focusGrid(page);

      await page.keyboard.press("Backspace");
      await eventually(() => timelinesAll(page), (all) => !all.some((t) => t.id === tid), "Backspace did not delete the selected timeline");
      await cellUntouched(page, cell, "Backspace on a selected timeline");

      await pressUndo(page);
      const back = await eventually(() => timelinesAll(page), (all) => all.some((t) => t.name === "Date"), "ONE Ctrl+Z did not bring the timeline back");
      const restored = back.find((t) => t.name === "Date")!;
      await eventually(() => timelineRange(page, restored.id), (r) => r === "2026-01..2026-01", "ONE Ctrl+Z brought the timeline back without its range");
    } finally {
      await endClean(page);
    }
  });
});

// ---------------------------------------------------------------------------
// SK-4. A protected sheet: the delete is refused, nothing reaches the cell
// ---------------------------------------------------------------------------

test.describe("a protected sheet refuses the delete (worksheet)", () => {
  test("SK-4 (worksheet, protected without Edit Objects): Delete on a selected slicer leaves it standing, one toast says it was not deleted, A8 keeps its value and no undo step is taken", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    let protectedNow = false;
    try {
      await newFile(page);
      const pid = await seedPivot(page);
      const sid = await createSlicer(page, pid, 0, 320, 192);
      await eventually(() => slicerItemValues(page, sid), (v) => v.length === 4, "the slicer never listed the four regions", 15_000);
      const cell = await activeCellA8(page);
      await protectActiveSheet(page, { allowEditObjects: false });
      protectedNow = true;
      const before = await undoState(page);

      await clickHeader(page, sid);
      await focusGrid(page);
      await startToasts(page);
      await page.keyboard.press("Delete");
      await eventually(
        () => toasts(page),
        (all) => all.some((t) => t.text.includes("not deleted")),
        "no toast said the slicer was not deleted on a protected sheet",
      );
      expect((await slicersAll(page)).some((s) => s.id === sid), "a protected sheet's slicer was deleted").toBe(true);
      await cellUntouched(page, cell, "Delete on a protected sheet");
      const after = await undoState(page);
      expect({ d: after.undoDepth, desc: after.undoDescription }, "a refused delete took an undo step").toEqual({
        d: before.undoDepth,
        desc: before.undoDescription,
      });
    } finally {
      if (protectedNow) await unprotectActiveSheet(page).catch(() => undefined);
      await endClean(page);
    }
  });
});

// ---------------------------------------------------------------------------
// SK-5. A chart and a shape on a worksheet
// ---------------------------------------------------------------------------

test.describe("a SELECTED chart or shape owns the keyboard (worksheet)", () => {
  test("SK-5 (worksheet): x, F2 and Space with a chart selected open no edit and keep A8; Escape deselects the chart; a selected shape refuses x and Delete deletes it (Controls' own door)", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      await writeTable(page, DATA);
      const cell = await activeCellA8(page);

      // ---- A chart, selected by a click on its body.
      const chartId = await createChart(page, barSpec(undefined, "Sales"), { sheetIndex: 0, x: 320, y: 40, width: 320, height: 200 });
      const chart = await eventually(
        async () => (await objects(page)).find((o) => o.chartId === chartId) ?? null,
        (o) => o !== null,
        "precondition: the chart is published",
      );
      await clickObject(page, chart!);
      await eventually(async () => (await objects(page)).find((o) => o.chartId === chartId)?.selected === true, (v) => v, "a click on the chart did not select it");
      await focusGrid(page);
      for (const k of ["x", "F2", "Space"]) {
        await page.keyboard.press(k);
        await page.waitForTimeout(300);
        await cellUntouched(page, cell, `${k} with a chart selected`);
      }
      await page.keyboard.press("Escape");
      await eventually(async () => (await objects(page)).find((o) => o.chartId === chartId)?.selected === false, (v) => v, "Escape did not deselect the chart");

      // ---- A shape, selected by a click; Delete is Controls' own door.
      await createShape(page, { sheetIndex: 0, x: 320, y: 300, width: 128, height: 80 });
      await eventually(() => controlsOn(page, 0), (c) => c.length === 1, "precondition: the shape exists");
      const shape = await eventually(
        async () => (await objects(page)).find((o) => o.type === "floating-control") ?? null,
        (o) => o !== null,
        "precondition: the shape is published",
      );
      await clickObject(page, shape!);
      await eventually(async () => (await objects(page)).find((o) => o.id === shape!.id)?.selected === true, (v) => v, "a click on the shape did not select it");
      await focusGrid(page);
      await page.keyboard.press("x");
      await page.waitForTimeout(300);
      await cellUntouched(page, cell, "x with a shape selected");
      await page.keyboard.press("Delete");
      await eventually(() => controlsOn(page, 0), (c) => c.length === 0, "Delete did not delete the selected shape");
      expect((await cellAt(page, 0, cell.startRow, cell.startCol))?.display, "Delete cleared the cell behind the shape").toBe(BEHIND);
    } finally {
      await endClean(page);
    }
  });
});

// ---------------------------------------------------------------------------
// SK-6. A canvas: ONE selected slicer -- the dead key is closed
// ---------------------------------------------------------------------------

test.describe("ONE selected slicer on a canvas (the dead key)", () => {
  test("SK-6 (canvas): Delete with ONE slicer selected deletes it; ONE Ctrl+Z brings it back", async ({ appPage: page }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      const pid = await seedPivot(page);
      const canvas = await addCanvas(page);
      const box = await gridBox(page);
      const pageWidth = Math.min(1280, Math.floor((box.width - 32) / 16) * 16);
      const pageHeight = Math.min(720, Math.floor((box.height - 32) / 16) * 16);
      await patchActiveCanvas(page, { pagePreset: "custom", pageWidth, pageHeight });
      const sid = await createSlicer(page, pid, canvas.index, 64, 64);
      await eventually(() => slicerItemValues(page, sid), (v) => v.length === 4, "the slicer never listed the four regions", 15_000);
      const name = (await slicersAll(page)).find((x) => x.id === sid)?.name ?? "";
      expect(name, "precondition: the backend names the slicer").not.toBe("");

      await clickHeader(page, sid);
      await focusGrid(page);
      await page.keyboard.press("Delete");
      await eventually(() => slicersAll(page), (all) => !all.some((s) => s.id === sid), "Delete with ONE slicer selected on a canvas did nothing");
      expect((await undoState(page)).undoDescription, "the delete is not ONE undo step named for it").toBe("Delete Objects");

      await pressUndo(page);
      await eventually(() => slicersAll(page), (all) => all.some((s) => s.name === name), "ONE Ctrl+Z did not bring the slicer back");
    } finally {
      await endClean(page);
    }
  });
});

// ---------------------------------------------------------------------------
// SK-7 / SK-8. The review of the fix (2026-10-01): worksheet press parity, the
// way back to the cells, the formula bar
// ---------------------------------------------------------------------------

/** The CLIENT point of a slicer's header (its frame). */
async function headerPoint(page: Page, sid: string): Promise<{ x: number; y: number }> {
  const s = await slicerRow(page, sid);
  return clientOf(page, s.x + s.width / 2, s.y + 10);
}

/** The formula bar's value and read-only state, as the user sees them. */
async function formulaBar(page: Page): Promise<{ value: string; readOnly: boolean; focused: boolean }> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>("[data-formula-bar]");
    return { value: el?.value ?? "<none>", readOnly: el?.readOnly ?? false, focused: el !== null && document.activeElement === el };
  });
}

test.describe("the review's worksheet cases", () => {
  test("SK-7 (worksheet, press parity): a chart clicked, then a slicer -- the chart is deselected and Delete deletes ONLY the slicer; a Ctrl+click selection of both is deleted WHOLE as ONE undo step", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      const pid = await seedPivot(page);
      const sid = await createSlicer(page, pid, 0, 320, 192);
      await eventually(() => slicerItemValues(page, sid), (v) => v.length === 4, "the slicer never listed the four regions", 15_000);
      const name = (await slicersAll(page)).find((x) => x.id === sid)?.name ?? "";
      const chartId = await createChart(page, barSpec(undefined, "Sales"), { sheetIndex: 0, x: 520, y: 40, width: 320, height: 200 });
      const chartOf = async () => (await objects(page)).find((o) => o.chartId === chartId) ?? null;
      const chart = await eventually(chartOf, (o) => o !== null, "precondition: the chart is published");
      const cell = await activeCellA8(page);

      // ---- Plain clicks: chart, then slicer. Only the slicer stays selected.
      await clickObject(page, chart!);
      await eventually(chartOf, (o) => o?.selected === true, "a click on the chart did not select it");
      await click(page, await headerPoint(page, sid));
      await eventually(() => objectOrNull(page, SLICER_REGION(sid)), (o) => o?.selected === true, "a click on the slicer's header did not select it");
      expect((await chartOf())?.selected, "the chart clicked EARLIER stayed selected beside the slicer").toBe(false);
      await focusGrid(page);
      await page.keyboard.press("Delete");
      await eventually(() => slicersAll(page), (all) => !all.some((s) => s.id === sid), "Delete did not delete the slicer just clicked");
      expect(await chartOf(), "Delete deleted the chart the user clicked BEFORE the slicer").not.toBeNull();
      expect((await cellAt(page, 0, cell.startRow, cell.startCol))?.display).toBe(BEHIND);
      await pressUndo(page);
      const back = await eventually(() => slicersAll(page), (all) => all.some((s) => s.name === name), "ONE Ctrl+Z did not bring the slicer back");
      const sid2 = back.find((s) => s.name === name)!.id;
      await eventually(() => objectOrNull(page, SLICER_REGION(sid2)), (o) => o !== null, "precondition: the restored slicer is published");

      // ---- A deliberate Ctrl+click selection of both: Delete removes BOTH, ONE step.
      await clickObject(page, (await chartOf())!);
      await eventually(chartOf, (o) => o?.selected === true, "a click on the chart did not select it");
      await page.keyboard.down("Control");
      try {
        await click(page, await headerPoint(page, sid2));
      } finally {
        await page.keyboard.up("Control");
      }
      await eventually(() => objectOrNull(page, SLICER_REGION(sid2)), (o) => o?.selected === true, "a Ctrl+click on the slicer did not add it");
      expect((await chartOf())?.selected, "a Ctrl+click on the slicer dropped the chart").toBe(true);
      await focusGrid(page);
      const depth = (await undoState(page)).undoDepth;
      await page.keyboard.press("Delete");
      await eventually(chartOf, (o) => o === null, "Delete on a chart + slicer selection left the chart");
      await eventually(() => slicersAll(page), (all) => !all.some((s) => s.id === sid2), "Delete on a chart + slicer selection left the slicer");
      const after = await undoState(page);
      expect({ d: after.undoDepth, desc: after.undoDescription }, "the whole delete is not ONE undo step").toEqual({ d: depth + 1, desc: "Delete Objects" });
    } finally {
      await endClean(page);
    }
  });

  test("SK-8 (worksheet): a click on the ACTIVE cell ends the claim (typing reaches it); while a slicer is selected the formula bar is empty, read-only, and focusing it opens no edit of the hidden cell", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      const pid = await seedPivot(page);
      const sid = await createSlicer(page, pid, 0, 320, 192);
      await eventually(() => slicerItemValues(page, sid), (v) => v.length === 4, "the slicer never listed the four regions", 15_000);
      const cell = await activeCellA8(page);

      // ---- The formula bar while the slicer is selected.
      await clickHeader(page, sid);
      await eventually(() => formulaBar(page), (b) => b.readOnly && b.value === "", "the formula bar showed (or let you edit) the cell behind the selected slicer");
      await startToasts(page);
      await page.locator("[data-formula-bar]").first().click();
      await page.waitForTimeout(400);
      await cellUntouched(page, cell, "a click into the formula bar");
      expect((await formulaBar(page)).focused, "the formula bar kept the focus with nothing it may edit").toBe(false);
      await eventually(() => sawRefusal(page), (v) => v, "focusing the formula bar was refused silently");

      // ---- A click on the cell that is ALREADY active ends the claim.
      await clickHeader(page, sid);
      await click(page, await clientOf(page, 30, 150));
      await eventually(
        () => objectOrNull(page, SLICER_REGION(sid)),
        (o) => o !== null && !o.selected,
        "a click on the active cell left the slicer selected (the keyboard stays refused)",
      );
      await focusGrid(page);
      await page.keyboard.press("z");
      await page.keyboard.press("Enter");
      await eventually(
        () => cellAt(page, 0, cell.startRow, cell.startCol),
        (c) => c?.display === "z",
        "after a click on the active cell, typing did not reach it",
      );
    } finally {
      await endClean(page);
    }
  });
});

// ---------------------------------------------------------------------------
// SK-9. The object inserts stay available while an object is selected (owner call 25)
// ---------------------------------------------------------------------------

test.describe("the object inserts are not refused while an object is selected (worksheet)", () => {
  test("SK-9 (worksheet): with a slicer selected, a typed x is still refused, and Insert > Controls > Button from the menu bar inserts a button at A8 -- the active cell -- with no refusal; the slicer stays", async ({
    appPage: page,
  }) => {
    test.setTimeout(240_000);
    try {
      await newFile(page);
      const pid = await seedPivot(page);
      const sid = await createSlicer(page, pid, 0, 320, 192);
      await eventually(() => slicerItemValues(page, sid), (v) => v.length === 4, "the slicer never listed the four regions", 15_000);
      const cell = await activeCellA8(page);
      expect(
        (await controlsOn(page, 0)).some((c) => c.row === cell.startRow && c.col === cell.startCol),
        "precondition: nothing is anchored at A8 yet",
      ).toBe(false);

      // ---- The claim is on: a typed character is refused (the control for "nothing refused" below).
      await clickHeader(page, sid);
      await focusGrid(page);
      await startToasts(page);
      await page.keyboard.press("x");
      await page.waitForTimeout(300);
      await cellUntouched(page, cell, "x");
      await eventually(() => sawRefusal(page), (v) => v, "precondition: with the slicer selected, a typed x was not refused");

      // ---- Insert > Controls > Button, the way a user does it, from the menu bar.
      await startToasts(page);
      await page.locator("button").filter({ hasText: /^Insert$/ }).first().click();
      await page.waitForTimeout(300);
      const controls = page.locator("button").filter({ hasText: /^Controls/ }).first();
      await controls.hover();
      await page.waitForTimeout(300);
      expect((await objectOrNull(page, SLICER_REGION(sid)))?.selected, "precondition: opening the menu deselected the slicer").toBe(true);
      await controls.locator("xpath=..").locator("button").filter({ hasText: /^Button$/ }).first().click();
      await eventually(
        () => controlsOn(page, 0),
        (all) => all.some((c) => c.type === "button" && c.row === cell.startRow && c.col === cell.startCol),
        "Insert > Controls > Button was refused while the slicer is selected (no button anchored at the active cell A8)",
      );
      expect(await sawRefusal(page), "the insert showed the selected-object refusal").toBe(false);
      expect((await slicersAll(page)).some((s) => s.id === sid), "inserting a button deleted the selected slicer").toBe(true);
    } finally {
      await endClean(page);
    }
  });
});
