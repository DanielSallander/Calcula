//! FILENAME: app/extensions/ScriptableObjects/__tests__/embeddedFormOffSheetEdit.test.ts
// PURPOSE: A form embedded on a sheet the user is NOT looking at follows an
//          insert/delete of that sheet's rows or columns -- a script's or the
//          command line's `sheetIndex` (round 7, NEW-offsheet-structural-
//          frontend-only-state).
// CONTEXT: Placements are this session's own state (`@api/scriptHost/
//          embeddedFormPlacements`): the backend never sees them, so no re-read
//          can move them. The layer shifted them only on the four on-screen
//          events (ROWS_INSERTED ...), and an edit on another sheet announces
//          STRUCTURAL_EDIT_ELSEWHERE instead -- so a form on Log stayed over its
//          OLD anchor after `api.insertRows(2, 3, "Log")`, and came up over the
//          wrong cells when the user switched there. The announcement now
//          carries its edits in order, and the layer replays each on the sheet
//          it names.
//          Real modules end to end: @api/lib's insert/delete wrappers (Core's
//          tauri-api: their off-sheet branch, the burst and the payload), the
//          real event bus, the real placement store and the real layer. Doubled:
//          Tauri's `invoke`, and the overlay/paint primitives the layer draws
//          with (nothing here is painted).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** The backend's active sheet: the sheet on screen. */
  active: 0,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "get_active_sheet") return Promise.resolve(h.active);
    return Promise.resolve([]);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));

// The barrel the layer imports: the REAL event bus (the announcement arrives on
// it from Core's wrappers), and inert stand-ins for the paint primitives.
vi.mock("@api", async () => {
  const events = await vi.importActual<typeof import("@api/events")>("@api/events");
  return {
    AppEvents: events.AppEvents,
    emitAppEvent: events.emitAppEvent,
    onAppEvent: events.onAppEvent,
    getDesignMode: () => false,
    onDesignModeChange: () => () => undefined,
    overlayGetColumnX: (_ctx: unknown, col: number) => 50 + col * 100,
    overlayGetRowY: (_ctx: unknown, row: number) => 24 + row * 20,
    overlayGetRowHeaderWidth: () => 50,
    overlayGetColHeaderHeight: () => 24,
    registerGridOverlay: () => () => undefined,
    replaceGridRegionsByType: () => undefined,
    removeGridRegionsByType: () => undefined,
  };
});
vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render: () => undefined, unmount: () => undefined }),
}));
vi.mock("../components/scriptEmbed", () => ({
  ScriptEmbeddedFormView: () => null,
}));

import { insertRows, deleteRows, insertColumns, deleteColumns } from "@api/lib";
import { AppEvents, emitAppEvent } from "@api/events";
import { installEmbeddedFormLayer, ORPHANED_DELETES_KEPT, rememberNewest } from "../lib/embeddedFormLayer";
import {
  __resetEmbeddedFormPlacementsForTests,
  __setEmbeddedFormIdMinterForTests,
  getEmbeddedFormPlacement,
  placeEmbeddedForm,
} from "@api/scriptHost/embeddedFormPlacements";

/** The off-sheet announcement's burst window (core/lib/tauri-api.ts, STRUCTURAL_EDIT_ELSEWHERE_WINDOW_MS). */
const WINDOW_MS = 50;

let dispose: (() => void) | null = null;

/** Let the announcement, the burst's trailing flush and the layer's queue settle (the clock is fake). */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);
  await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);
}

function anchorOf(id: string): { row: number; col: number; orphaned: boolean } {
  const p = getEmbeddedFormPlacement(id);
  expect(p, `placement ${id} is gone`).not.toBeNull();
  return { row: p!.anchorRow, col: p!.anchorCol, orphaned: p!.orphaned };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  __resetEmbeddedFormPlacementsForTests();
  let n = 0;
  __setEmbeddedFormIdMinterForTests(() => `form-${++n}`);
  h.active = 0;
  const layer = installEmbeddedFormLayer({
    openSession: (async () => undefined) as never,
    closeSession: (() => undefined) as never,
    activeSheetIndex: async () => h.active,
  });
  dispose = layer.dispose;
  await settle();
});

afterEach(async () => {
  // Close any burst window still open before the next test starts one.
  await vi.runAllTimersAsync();
  dispose?.();
  dispose = null;
  __resetEmbeddedFormPlacementsForTests();
  vi.useRealTimers();
});

describe("a form embedded on another sheet follows an insert/delete there (round 7)", () => {
  // SABOTAGE: drop the STRUCTURAL_EDIT_ELSEWHERE subscription from
  // installEmbeddedFormLayer (embeddedFormLayer.ts) -> the Log form stays at
  // row 5 and this fails at "the form moved down with its cell".
  it("api.insertRows(2, 3, 'Log') with Sheet1 on screen: the Log form hangs from row 8, the Sheet1 form stays", async () => {
    const onLog = placeEmbeddedForm({ scriptId: "s", sheetIndex: 1, anchorRow: 5, anchorCol: 1 }).id;
    const onScreen = placeEmbeddedForm({ scriptId: "s", sheetIndex: 0, anchorRow: 5, anchorCol: 1 }).id;

    await insertRows(2, 3, 1);
    await settle();

    expect(anchorOf(onLog), "the form moved down with its cell").toEqual({ row: 8, col: 1, orphaned: false });
    expect(anchorOf(onScreen), "the sheet on screen was not edited").toEqual({ row: 5, col: 1, orphaned: false });
  });

  it("deleteRows / insertColumns / deleteColumns there: each lands where the cells went; a deleted anchor orphans the form", async () => {
    const form = placeEmbeddedForm({ scriptId: "s", sheetIndex: 1, anchorRow: 5, anchorCol: 2 }).id;
    const doomed = placeEmbeddedForm({ scriptId: "s", sheetIndex: 1, anchorRow: 1, anchorCol: 2 }).id;

    await deleteRows(0, 2, 1); // rows 1-2 go: row 5 -> 3; the anchor on row 1 is deleted
    await settle();
    expect(anchorOf(form)).toEqual({ row: 3, col: 2, orphaned: false });
    expect(anchorOf(doomed).orphaned, "its anchor row was deleted: orphaned, never dropped").toBe(true);

    await insertColumns(0, 3, 1); // C -> F
    await settle();
    expect(anchorOf(form)).toEqual({ row: 3, col: 5, orphaned: false });

    await deleteColumns(1, 2, 1); // B:C go: F -> D
    await settle();
    expect(anchorOf(form)).toEqual({ row: 3, col: 3, orphaned: false });
  });

  it("a script loop of off-sheet inserts: every insert of the burst moves the form, not only the first", async () => {
    const form = placeEmbeddedForm({ scriptId: "s", sheetIndex: 1, anchorRow: 5, anchorCol: 0 }).id;
    for (let i = 0; i < 10; i++) await insertRows(0, 1, 1);
    await settle();
    expect(anchorOf(form)).toEqual({ row: 15, col: 0, orphaned: false });
  });

  it("a floating grid's own lines (the cell-target route) move no form", async () => {
    const form = placeEmbeddedForm({ scriptId: "s", sheetIndex: 0, anchorRow: 5, anchorCol: 0 }).id;
    await insertRows(0, 2, undefined, { target: { kind: "floatingRange", id: "fr-1" } });
    await settle();
    expect(anchorOf(form)).toEqual({ row: 5, col: 0, orphaned: false });
  });

  // SABOTAGE: drop flushPendingStructuralEditsElsewhere() from tauri-api.ts's
  // emitStructuralEvent -> the on-screen insert is applied before the trailing
  // off-sheet one made earlier, and the form ends one row short (7, not 8).
  it("an off-sheet insert still in its burst window, then the user's sheet switch and an on-screen insert: applied in the order made", async () => {
    const form = placeEmbeddedForm({ scriptId: "s", sheetIndex: 1, anchorRow: 5, anchorCol: 0 }).id;

    await insertRows(0, 1, 1); // Log, announced at once: row 5 -> 6
    await insertRows(3, 1, 1); // Log, inside the window: 6 -> 7, announced later
    h.active = 1; // the script activates Log...
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 1 });
    await insertRows(7, 1); // ...and inserts on it, now the sheet on screen: 7 -> 8
    await settle();

    expect(anchorOf(form), "every shift applied in the order the backend made it").toEqual({
      row: 8,
      col: 0,
      orphaned: false,
    });
  });
});

// Round 16 (rev14A): the layer heard only the FORWARD edits, so a form moved by
// an insert stayed moved after the insert's Undo -- or after the take-back of a
// refused Insert Copied Cells (STRUCTURAL_UNDO source "rollback") -- put the
// line back out. It now follows through @api/structuralFollow, like bookmarks.
describe("a form follows the Undo / Redo / take-back of a line edit (round 16)", () => {
  it("Insert Copied Cells over row 2 moves a row-10 form to row 11; the refused paste's take-back puts it back on row 10", async () => {
    const form = placeEmbeddedForm({ scriptId: "s", sheetIndex: 0, anchorRow: 9, anchorCol: 0 }).id;
    await insertRows(1, 1); // the room the copy was to land in, on the sheet on screen
    await settle();
    expect(anchorOf(form)).toEqual({ row: 10, col: 0, orphaned: false });

    emitAppEvent(AppEvents.STRUCTURAL_UNDO, {
      description: "Insert Copied Cells",
      source: "rollback",
      deltas: [{ kind: "rowDelete", sheetIndex: 0, at: 1, count: 1 }],
    });
    await settle();
    expect(anchorOf(form), "the take-back put the row back out, and the form with it").toEqual({
      row: 9,
      col: 0,
      orphaned: false,
    });
  });

  it("Ctrl+Z of a row delete that took the anchor puts the form back on its cell; Ctrl+Y takes it again", async () => {
    const form = placeEmbeddedForm({ scriptId: "s", sheetIndex: 0, anchorRow: 4, anchorCol: 2 }).id;
    await deleteRows(3, 2); // rows 4-5 go: the anchor row 5 (index 4) is deleted
    await settle();
    expect(anchorOf(form).orphaned).toBe(true);

    emitAppEvent(AppEvents.STRUCTURAL_UNDO, {
      description: "Delete Rows",
      source: "undo",
      deltas: [{ kind: "rowInsert", sheetIndex: 0, at: 3, count: 2 }],
    });
    await settle();
    expect(anchorOf(form), "the Undo brought the row back, and the form on it").toEqual({
      row: 4,
      col: 2,
      orphaned: false,
    });

    emitAppEvent(AppEvents.STRUCTURAL_UNDO, {
      description: "Delete Rows",
      source: "redo",
      deltas: [{ kind: "rowDelete", sheetIndex: 0, at: 3, count: 2 }],
    });
    await settle();
    expect(anchorOf(form).orphaned, "the Redo deleted the anchor row again").toBe(true);
  });

  // Round 18 (rev16B nit): the memory of orphaning deletes is BOUNDED (the
  // newest ORPHANED_DELETES_KEPT, above the 100-step undo history), so a
  // delete that is never undone is not kept for the session. (Its clear on
  // File > Open / New is memory hygiene only: after a document swap no undo
  // can name an old seq, so no test can observe it.)
  // SABOTAGE: drop the bound in rememberNewest -> fails at "the oldest".
  it("only the newest ORPHANED_DELETES_KEPT orphaning deletes are remembered", () => {
    const memory = new Map<number, string>();
    for (let seq = 1; seq <= ORPHANED_DELETES_KEPT + 5; seq++) rememberNewest(memory, seq, `d${seq}`, ORPHANED_DELETES_KEPT);
    expect(memory.size, "the oldest deletes past the bound were still remembered").toBe(ORPHANED_DELETES_KEPT);
    expect(memory.has(1) || memory.has(5)).toBe(false);
    expect(memory.get(ORPHANED_DELETES_KEPT + 5)).toBe(`d${ORPHANED_DELETES_KEPT + 5}`);
    expect(ORPHANED_DELETES_KEPT, "the bound must exceed the 100-step undo history").toBeGreaterThan(100);
  });
});
