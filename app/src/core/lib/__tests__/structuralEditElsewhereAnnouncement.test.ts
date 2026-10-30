//! FILENAME: app/src/core/lib/__tests__/structuralEditElsewhereAnnouncement.test.ts
// PURPOSE: BUG-0357 follow-up -- a row/column edit OFF the active sheet's
//          canvas (a non-active `sheetIndex`, or a floating grid's backing
//          sheet through `{ target }`) announces the re-read of what it moved,
//          ONLY that, and ONCE per burst.
// CONTEXT: The backend moves chart and sparkline data ranges on those routes
//          too (chart_range_shift.rs), and the Charts / Sparklines stores cache
//          them and write a record back whole. These branches announced
//          NOTHING, so the stores kept the old range and the next persist of
//          such a chart wrote it back over the moved one (round 2). Round 2
//          then announced what the UNDO of the same edit announces --
//          STRUCTURAL_UNDO and the `objects` domain -- which reached far more
//          than the edit changed (review FU#5): every STRUCTURAL_UNDO listener
//          re-reads the VISIBLE sheet's store and several close open UI (an
//          AutoFilter dropdown, a validation prompt, the selected chart;
//          Controls reloads the sheet's controls), the `objects` fan-out clears
//          every chart's point selections and insight cues, and a script loop
//          of N edits set it all off N times. It now announces
//          STRUCTURAL_EDIT_ELSEWHERE (the chart and sparkline stores), the
//          table definitions, the sheet's cell refetch, and after a delete the
//          BUG-0054 cascade -- the first call of a burst at once, the rest of
//          the burst as ONE trailing announcement. Still NOT the ROWS_ family
//          (active-sheet coordinates) and still no recording. The end-to-end
//          half (the chart store actually re-reads and keeps the selected
//          chart) is extensions/_shared/lib/__tests__/structuralEditElsewhere.test.ts.
//          Only Tauri's `invoke` and the clock are doubled; the module under
//          test is real.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const calls: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];
let refusal: string | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "get_active_sheet") return Promise.resolve(0);
    if (refusal !== null) return Promise.reject(refusal);
    return Promise.resolve([]);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));

import {
  insertRows,
  insertColumns,
  deleteRows,
  deleteColumns,
  setGridRecorderHook,
  type RecordedGridEvent,
} from "../tauri-api";
import { AppEvents } from "../../../api/events";
import type { StructuralEditElsewhereEdit } from "../../../api/events";

/** The window one announcement covers (core/lib/tauri-api.ts, STRUCTURAL_EDIT_ELSEWHERE_WINDOW_MS). */
const WINDOW_MS = 50;
const GRID_DATA_REFRESH = "grid:refresh";

const WATCHED = [
  AppEvents.STRUCTURAL_EDIT_ELSEWHERE,
  AppEvents.TABLE_DEFINITIONS_UPDATED,
  GRID_DATA_REFRESH,
  AppEvents.STRUCTURAL_UNDO,
  AppEvents.MUTATION_REFRESH,
  AppEvents.ROWS_INSERTED,
  AppEvents.COLUMNS_INSERTED,
  AppEvents.ROWS_DELETED,
  AppEvents.COLUMNS_DELETED,
];
const heard: Array<{ type: string; detail: unknown }> = [];
const listener = (e: Event) => heard.push({ type: e.type, detail: (e as CustomEvent).detail });
const recorded: RecordedGridEvent[] = [];

const TARGET = { kind: "floatingRange" as const, id: "fr-1" };
const CASCADE = { domains: ["slicer", "pivot", "ribbonFilter"], source: "commit" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  calls.length = 0;
  heard.length = 0;
  recorded.length = 0;
  setGridRecorderHook((e) => recorded.push(e));
  for (const t of WATCHED) window.addEventListener(t, listener);
});
afterEach(() => {
  // Close every open burst window before the next test starts one.
  vi.runAllTimers();
  vi.useRealTimers();
  setGridRecorderHook(null);
  for (const t of WATCHED) window.removeEventListener(t, listener);
});

type Route = "offSheet" | "target";
interface Case {
  name: string;
  command: string;
  description: string;
  kind: "rowInsert" | "rowDelete" | "colInsert" | "colDelete";
  deletes: boolean;
  run: (route: Route) => Promise<unknown>;
}

const CASES: Case[] = [
  {
    name: "insertRows",
    command: "insert_rows",
    description: "Insert Rows",
    kind: "rowInsert",
    deletes: false,
    run: (route) => (route === "offSheet" ? insertRows(2, 1, 1) : insertRows(2, 1, undefined, { target: TARGET })),
  },
  {
    name: "insertColumns",
    command: "insert_columns",
    description: "Insert Columns",
    kind: "colInsert",
    deletes: false,
    run: (route) =>
      route === "offSheet" ? insertColumns(2, 1, 1) : insertColumns(2, 1, undefined, { target: TARGET }),
  },
  {
    name: "deleteRows",
    command: "delete_rows",
    description: "Delete Rows",
    kind: "rowDelete",
    deletes: true,
    run: (route) => (route === "offSheet" ? deleteRows(2, 1, 1) : deleteRows(2, 1, undefined, { target: TARGET })),
  },
  {
    name: "deleteColumns",
    command: "delete_columns",
    description: "Delete Columns",
    kind: "colDelete",
    deletes: true,
    run: (route) =>
      route === "offSheet" ? deleteColumns(2, 1, 1) : deleteColumns(2, 1, undefined, { target: TARGET }),
  },
];

type Edit = StructuralEditElsewhereEdit;

/** One announced edit, as the payload carries it. */
function edit(sheetIndex: number | null, kind: Edit["kind"], at: number, count = 1): Edit {
  return { sheetIndex, kind, at, count };
}

/**
 * What one flush of the off-canvas announcement emits, in order.
 *
 * CHANGED DELIBERATELY (round 7, NEW-offsheet-structural-frontend-only-state):
 * the payload carries `edits` beside `descriptions` -- every edit of the
 * flush, in order, never folded -- so a store whose coordinates the backend
 * never holds (an embedded form's anchor, Controls' anchor-derived ids) can
 * replay the shift on the sheet named.
 */
function announcement(
  descriptions: string[],
  cascade: boolean,
  edits: Edit[],
): Array<{ type: string; detail: unknown }> {
  return [
    { type: AppEvents.STRUCTURAL_EDIT_ELSEWHERE, detail: { descriptions, edits } },
    // A CustomEvent without a detail carries null (the DOM's default).
    { type: AppEvents.TABLE_DEFINITIONS_UPDATED, detail: null },
    { type: GRID_DATA_REFRESH, detail: null },
    ...(cascade ? [{ type: AppEvents.MUTATION_REFRESH, detail: CASCADE }] : []),
  ];
}

/** Events that would disturb the sheet on screen, which an off-canvas edit never touched. */
function expectNothingOnScreenDisturbed(): void {
  const types = heard.map((h) => h.type);
  // STRUCTURAL_UNDO: every listener re-reads the VISIBLE sheet's store, and
  // AutoFilter / DataValidation close their open dropdown or prompt, Controls
  // reloads the sheet's controls, the chart store deselects the chart.
  expect(types, "STRUCTURAL_UNDO disturbs the sheet on screen").not.toContain(AppEvents.STRUCTURAL_UNDO);
  // The `objects` domain fans out to charts:refresh, which clears every
  // chart's point selections, widget values and insight cues.
  for (const h of heard) {
    if (h.type === AppEvents.MUTATION_REFRESH) {
      expect((h.detail as { domains: string[] }).domains, "the objects domain clears chart point selections").not.toContain(
        "objects",
      );
    }
  }
  for (const coordinated of [
    AppEvents.ROWS_INSERTED,
    AppEvents.COLUMNS_INSERTED,
    AppEvents.ROWS_DELETED,
    AppEvents.COLUMNS_DELETED,
  ]) {
    expect(types, "active-sheet coordinates would shift the VISIBLE sheet's stores").not.toContain(coordinated);
  }
}

describe("a structural edit off the active sheet's canvas announces the re-read of what it moved, and only that", () => {
  for (const c of CASES) {
    // SABOTAGE: announce STRUCTURAL_UNDO again in flushStructuralEditElsewhere
    // (tauri-api.ts) -> expectNothingOnScreenDisturbed fails.
    it(`${c.name} on a NON-ACTIVE sheet: STRUCTURAL_EDIT_ELSEWHERE, tables, the cell refetch${c.deletes ? ", the cascade" : ""}; nothing on screen disturbed; no recording`, async () => {
      await c.run("offSheet");
      const sent = calls.find((x) => x.cmd === c.command);
      expect(sent?.args?.sheetIndex, "the edit still goes to the named sheet").toBe(1);
      expect(heard, "the first edit of a burst is announced at once").toEqual(
        announcement([c.description], c.deletes, [edit(1, c.kind, 2)]),
      );
      expectNothingOnScreenDisturbed();
      expect(recorded, "an off-sheet edit is not a gesture on the visible sheet").toEqual([]);
    });

    it(`${c.name} on a floating grid's BACKING sheet ({ target }): the same re-read, no cascade`, async () => {
      await c.run("target");
      const sent = calls.find((x) => x.cmd === c.command);
      expect(sent?.args?.target).toEqual(TARGET);
      // A backing sheet has no index here: the edit says null.
      expect(heard).toEqual(announcement([c.description], false, [edit(null, c.kind, 2)]));
      expectNothingOnScreenDisturbed();
      expect(recorded).toEqual([]);
    });
  }

  it("the ACTIVE sheet named explicitly is an on-sheet edit: the ROWS_ family, not the re-read", async () => {
    await insertRows(2, 1, 0);
    expect(heard.map((h) => h.type)).toEqual([AppEvents.ROWS_INSERTED]);
    expect(recorded).toEqual([{ kind: "insertRows", startRow: 2, count: 1 }]);
  });

  it("a refused off-sheet or target edit announces nothing", async () => {
    refusal = "Cannot insert rows on a protected sheet.";
    try {
      await expect(insertRows(2, 1, 1)).rejects.toBe(refusal);
      await expect(deleteColumns(2, 1, undefined, { target: TARGET })).rejects.toBe(refusal);
      vi.runAllTimers();
      expect(heard).toEqual([]);
    } finally {
      refusal = null;
    }
  });
});

describe("one announcement per burst (review FU#5)", () => {
  // SABOTAGE: make announceStructuralEditElsewhere flush on every call
  // (tauri-api.ts) -> the loop is announced 10 times, not twice.
  it("a script loop of off-sheet edits: the first at once, the rest as ONE trailing announcement", async () => {
    for (let i = 0; i < 8; i++) await insertRows(2 + i, 1, 1);
    await deleteRows(4, 1, 1);
    await deleteColumns(1, 1, undefined, { target: TARGET });
    const elsewhere = () => heard.filter((h) => h.type === AppEvents.STRUCTURAL_EDIT_ELSEWHERE);
    expect(elsewhere(), "the first edit, at once").toEqual([
      {
        type: AppEvents.STRUCTURAL_EDIT_ELSEWHERE,
        detail: { descriptions: ["Insert Rows"], edits: [edit(1, "rowInsert", 2)] },
      },
    ]);
    expect(heard).toEqual(announcement(["Insert Rows"], false, [edit(1, "rowInsert", 2)]));

    vi.advanceTimersByTime(WINDOW_MS);
    // The other nine, as one -- each edit NAMED once and the cascade once, but
    // every edit LISTED, in the order made.
    expect(heard.slice(3)).toEqual(
      announcement(["Insert Rows", "Delete Rows", "Delete Columns"], true, [
        ...[3, 4, 5, 6, 7, 8, 9].map((at) => edit(1, "rowInsert", at)),
        edit(1, "rowDelete", 4),
        edit(null, "colDelete", 1),
      ]),
    );

    vi.advanceTimersByTime(WINDOW_MS * 4);
    expect(elsewhere(), "nothing more once the burst is over").toHaveLength(2);
    expectNothingOnScreenDisturbed();
  });

  it("every edit is announced within one window, and an edit after the burst is announced at once again", async () => {
    await insertColumns(3, 1, 1);
    vi.advanceTimersByTime(WINDOW_MS - 1);
    await insertColumns(4, 1, 1);
    expect(heard.filter((h) => h.type === AppEvents.STRUCTURAL_EDIT_ELSEWHERE)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(heard.filter((h) => h.type === AppEvents.STRUCTURAL_EDIT_ELSEWHERE)).toHaveLength(2);
    // The window stayed open for one more period after the trailing flush;
    // nothing came, so it closes, and the next edit is a new burst.
    vi.advanceTimersByTime(WINDOW_MS);
    heard.length = 0;
    await deleteRows(1, 1, 1);
    expect(heard).toEqual(announcement(["Delete Rows"], true, [edit(1, "rowDelete", 1)]));
  });
});

describe("the edits ride along, none lost and none folded (round 7, NEW-offsheet-structural-frontend-only-state)", () => {
  const elsewhereEdits = (): Edit[][] =>
    heard
      .filter((h) => h.type === AppEvents.STRUCTURAL_EDIT_ELSEWHERE)
      .map((h) => (h.detail as { edits: Edit[] }).edits);

  // SABOTAGE: fold the trailing edits like the descriptions (push only an edit
  // not already listed) in announceStructuralEditElsewhere -> three identical
  // inserts arrive as one, and a replay lands the anchor two rows short.
  it("the same insert three times in one window is three edits, because it moved the cells three times", async () => {
    await insertRows(0, 1, 2);
    await insertRows(0, 1, 2);
    await insertRows(0, 1, 2);
    await insertRows(0, 1, 2);
    vi.advanceTimersByTime(WINDOW_MS);
    expect(elsewhereEdits()).toEqual([
      [edit(2, "rowInsert", 0)],
      [edit(2, "rowInsert", 0), edit(2, "rowInsert", 0), edit(2, "rowInsert", 0)],
    ]);
  });

  // SABOTAGE: drop flushPendingStructuralEditsElsewhere() from
  // emitStructuralEvent -> ROWS_INSERTED is heard before the trailing edit made
  // earlier, and a store replaying both shifts applies them out of order.
  it("an on-screen insert delivers the open window's edits FIRST, so every shift is heard in the order made", async () => {
    await insertRows(2, 1, 1); // the burst's first edit: announced at once
    await insertRows(5, 1, 1); // inside the window: trailing
    await insertRows(0, 1); // on the sheet on screen
    const order = heard
      .filter((h) => h.type === AppEvents.STRUCTURAL_EDIT_ELSEWHERE || h.type === AppEvents.ROWS_INSERTED)
      .map((h) => h.type);
    expect(order).toEqual([
      AppEvents.STRUCTURAL_EDIT_ELSEWHERE,
      AppEvents.STRUCTURAL_EDIT_ELSEWHERE,
      AppEvents.ROWS_INSERTED,
    ]);
    expect(elsewhereEdits()).toEqual([[edit(1, "rowInsert", 2)], [edit(1, "rowInsert", 5)]]);

    // Delivered once: the window's timer finds nothing left and ends the burst.
    vi.advanceTimersByTime(WINDOW_MS * 4);
    expect(elsewhereEdits()).toHaveLength(2);
  });

  it("an on-screen insert with no edit waiting announces nothing off the canvas", async () => {
    await insertRows(2, 1, 1);
    vi.advanceTimersByTime(WINDOW_MS * 2);
    heard.length = 0;
    await insertColumns(0, 1);
    expect(heard.map((h) => h.type)).toEqual([AppEvents.COLUMNS_INSERTED]);
  });
});
