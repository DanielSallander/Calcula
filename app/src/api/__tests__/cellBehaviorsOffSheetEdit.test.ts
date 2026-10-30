//! FILENAME: app/src/api/__tests__/cellBehaviorsOffSheetEdit.test.ts
// PURPOSE: rev4A#1 (BUG-0357 follow-up) -- an insert/delete of rows or columns
//          on a sheet the user is NOT looking at re-reads the workbook-wide
//          cell-behavior index, so a click handler or an onBeforeCommit
//          validator follows its cell there.
// CONTEXT: The index holds EVERY sheet's bindings (`get_all_cell_behaviors`,
//          keyed by sheet). The backend moves a binding with its cells on the
//          off-sheet route too (`off_sheet_structural_edit`, structure.rs). Its
//          only off-sheet trigger was the `objects` domain, which round 4
//          removed from that route's announcement (it deselected charts and
//          closed open UI on the sheet on screen); the route now announces
//          STRUCTURAL_EDIT_ELSEWHERE, which nothing in the index heard. So the
//          binding stayed at its OLD cell, also after switching to its sheet:
//          a click on the old cell ran the behavior script, a click on the new
//          one did nothing.
//          Real modules end to end: core/lib/tauri-api.ts's insert/delete
//          wrappers (their real off-sheet branch and burst announcement) and
//          @api/cellBehaviors. Only Tauri's `invoke` is doubled, by a backend
//          that moves its bindings as Rust does.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

interface Binding {
  id: string;
  scriptId: string;
  sheetIndex: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  claimClick: boolean;
  enabled: boolean;
  orphaned: boolean;
}

const backend = vi.hoisted(() => ({
  active: 0,
  bindings: [] as Array<{
    id: string;
    scriptId: string;
    sheetIndex: number;
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
    claimClick: boolean;
    enabled: boolean;
    orphaned: boolean;
  }>,
  reads: 0,
}));

/** What Rust's cell_behaviors::shift_* does to a binding on the edited sheet (whole-line moves). */
function shiftBindings(cmd: string, args: Record<string, unknown>): void {
  const sheet = typeof args.sheetIndex === "number" ? args.sheetIndex : backend.active;
  const count = args.count as number;
  for (const b of backend.bindings) {
    if (b.sheetIndex !== sheet) continue;
    if (cmd === "insert_rows" && b.startRow >= (args.row as number)) {
      b.startRow += count;
      b.endRow += count;
    }
    if (cmd === "delete_rows" && b.startRow >= (args.row as number) + count) {
      b.startRow -= count;
      b.endRow -= count;
    }
    if (cmd === "insert_columns" && b.startCol >= (args.col as number)) {
      b.startCol += count;
      b.endCol += count;
    }
    if (cmd === "delete_columns" && b.startCol >= (args.col as number) + count) {
      b.startCol -= count;
      b.endCol -= count;
    }
  }
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "get_active_sheet") return Promise.resolve(backend.active);
    if (cmd === "get_all_cell_behaviors") {
      backend.reads++;
      return Promise.resolve(backend.bindings.map((b) => ({ ...b })));
    }
    if (["insert_rows", "delete_rows", "insert_columns", "delete_columns"].includes(cmd)) {
      shiftBindings(cmd, args ?? {});
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async () => () => {}),
}));

import { insertRows, deleteRows, insertColumns, deleteColumns } from "../../core/lib/tauri-api";
import {
  refreshCellBehaviors,
  getCellBehaviorAt,
  activeBehaviorSheet,
  __resetCellBehaviorsForTests,
  CELL_BEHAVIORS_CHANGED_EVENT,
} from "../cellBehaviors";
import { AppEvents, emitAppEvent } from "../events";

/** The off-sheet announcement's burst window (core/lib/tauri-api.ts, STRUCTURAL_EDIT_ELSEWHERE_WINDOW_MS). */
const WINDOW_MS = 50;

function binding(id: string, sheetIndex: number, row: number, col: number): Binding {
  return {
    id,
    scriptId: `script-${id}`,
    sheetIndex,
    startRow: row,
    startCol: col,
    endRow: row,
    endCol: col,
    claimClick: true,
    enabled: true,
    orphaned: false,
  };
}

/** Let the announcement's listeners and the index's re-read settle (the clock is fake). */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);
  await vi.advanceTimersByTimeAsync(WINDOW_MS + 1);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  __resetCellBehaviorsForTests();
  backend.active = 0;
  backend.reads = 0;
  // "Log" (sheet 1) is not the sheet on screen: a binding on A6 (row 5), and
  // one on Sheet1 (the active sheet) that no off-sheet edit may move.
  backend.bindings = [binding("log-a6", 1, 5, 0), binding("sheet1-c3", 0, 2, 2)];
  await refreshCellBehaviors();
  expect(getCellBehaviorAt(5, 0, 1)?.id).toBe("log-a6");
});

afterEach(async () => {
  // Close any burst window still open before the next test starts one.
  await vi.runAllTimersAsync();
  vi.useRealTimers();
});

describe("the cell-behavior index follows an insert/delete OFF the sheet on screen (rev4A#1)", () => {
  // SABOTAGE: drop AppEvents.STRUCTURAL_EDIT_ELSEWHERE from cellBehaviors.ts's
  // refreshEvents -> no re-read; the binding stays at row 5 and row 6 is null.
  it("api.insertRows(2, 1, 'Log') while Sheet1 is on screen: the binding is found at A7, not at A6", async () => {
    const readsBefore = backend.reads;
    await insertRows(2, 1, 1);
    await settle();

    expect(backend.reads - readsBefore, "the index re-read after the off-sheet insert").toBeGreaterThan(0);
    expect(getCellBehaviorAt(6, 0, 1)?.id, "the behavior moved down with its cell").toBe("log-a6");
    expect(getCellBehaviorAt(5, 0, 1), "nothing is bound to the cell that slid into A6").toBeNull();
    // The sheet on screen was not touched.
    expect(getCellBehaviorAt(2, 2, 0)?.id).toBe("sheet1-c3");

    // Switching to Log: the gesture interceptors and the commit guard ask with
    // the active sheet, and now find the binding at its NEW cell.
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 1 });
    expect(activeBehaviorSheet()).toBe(1);
    expect(getCellBehaviorAt(6, 0)?.id).toBe("log-a6");
    expect(getCellBehaviorAt(5, 0)).toBeNull();
  });

  it("deleteRows / insertColumns / deleteColumns on another sheet: each re-reads, the binding ends where the backend put it", async () => {
    await deleteRows(0, 2, 1); // A6 -> A4 (row 3)
    await settle();
    expect(getCellBehaviorAt(3, 0, 1)?.id).toBe("log-a6");

    await insertColumns(0, 3, 1); // A4 -> D4
    await settle();
    expect(getCellBehaviorAt(3, 3, 1)?.id).toBe("log-a6");
    expect(getCellBehaviorAt(3, 0, 1)).toBeNull();

    await deleteColumns(1, 1, 1); // D4 -> C4
    await settle();
    expect(getCellBehaviorAt(3, 2, 1)?.id).toBe("log-a6");
    expect(getCellBehaviorAt(3, 3, 1)).toBeNull();
  });

  it("a script loop of off-sheet inserts: the index ends at the final cell, re-read once per announcement (not once per insert)", async () => {
    const changed = vi.fn();
    window.addEventListener(CELL_BEHAVIORS_CHANGED_EVENT, changed);
    try {
      const readsBefore = backend.reads;
      for (let i = 0; i < 25; i++) await insertRows(0, 1, 1);
      await settle();

      expect(getCellBehaviorAt(30, 0, 1)?.id, "25 rows inserted above A6").toBe("log-a6");
      // The burst is announced at once and then once at the end of its window.
      expect(backend.reads - readsBefore).toBeLessThanOrEqual(2);
      expect(changed).toHaveBeenCalled();
    } finally {
      window.removeEventListener(CELL_BEHAVIORS_CHANGED_EVENT, changed);
    }
  });
});
