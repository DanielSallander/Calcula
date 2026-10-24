//! FILENAME: app/src/core/hooks/__tests__/editFollowsSheetRename.test.tsx
// PURPOSE: Core's cell edit follows its sheet by the sheet's STABLE id: a
//          RENAME of the edited sheet while the edit is open is followed -- the
//          entry is written to the renamed sheet -- and only a DELETED sheet is
//          refused. And EDIT_STARTED / EDIT_ENDED never report an index that
//          names another sheet.
//          Driven through the REAL useEditing hook, the real reducer and Core's
//          real point-mode switch, against a fake backend whose sheets carry
//          stable ids, which renames and deletes, and which records every write
//          ON THE SHEET IT LANDS.
// CONTEXT: Review F1-rename-refuses-entry (round 5). Round 4 identified an open
//          edit's sheet by NAME, so renaming the edited sheet while the edit was
//          open -- the formula bar holds a plain value, and the strip's rename
//          doors are open to it; or an MCP / script rename -- made the edit look
//          like it belonged to another sheet: Enter REFUSED the entry ("the sheet
//          was deleted or renamed while you were typing") and threw it away.
//          Review F4-edit-started-stale-index: EDIT_STARTED reported the index the
//          open read BEFORE its awaits, so a renumbering landing during them made
//          one edit start on one sheet and end on another; and a cancel whose
//          sheet was gone reported the stored index, which names whichever sheet
//          slid into it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const backend = vi.hoisted(() => {
  const b = {
    sheets: [] as Array<{ id: string; name: string }>,
    active: 0,
    writes: [] as Array<{ sheet: string; id: string; row: number; col: number; value: string }>,
    switches: [] as number[],
    /** When set, every set_active_sheet throws it (the backend refusing the switch). */
    failSwitch: null as Error | null,
    /** When set, getMergeInfo waits for it: the open's own await, which a renumbering can land in. */
    mergeGate: null as Promise<void> | null,
    list() {
      return {
        sheets: b.sheets.map((s, index) => ({ index, name: s.name, sheetId: s.id, visibility: "visible" as const })),
        activeIndex: b.active,
      };
    },
    /** The backend removes the sheet at `at`; the active sheet keeps its identity (Rust's delete arithmetic). */
    remove(at: number) {
      b.sheets.splice(at, 1);
      if (b.active > at) b.active -= 1;
      else if (b.active === at) b.active = Math.min(at, b.sheets.length - 1);
    },
    rename(at: number, name: string) {
      b.sheets[at] = { ...b.sheets[at], name };
    },
  };
  return b;
});

vi.mock("../../lib/tauri-api", () => ({
  getMergeInfo: vi.fn(async () => {
    const gate = backend.mergeGate;
    if (gate) await gate;
    return null;
  }),
  getCell: vi.fn(async () => null),
  updateCellOnSheets: vi.fn(async () => []),
  getSheets: vi.fn(async () => backend.list()),
  setActiveSheet: vi.fn(async (index: number) => {
    backend.switches.push(index);
    if (backend.failSwitch) throw backend.failSwitch;
    if (index < 0 || index >= backend.sheets.length) throw new Error(`Sheet index ${index} is out of range`);
    backend.active = index;
    return backend.list();
  }),
  updateCell: vi.fn(async (row: number, col: number, value: string) => {
    const sheet = backend.sheets[backend.active];
    backend.writes.push({ sheet: sheet.name, id: sheet.id, row, col, value });
    return { cells: [{ row, col, display: value, formula: value.startsWith("=") ? value : null }] };
  }),
}));

const dialogs = vi.hoisted(() => ({ alerts: [] as string[] }));
vi.mock("../../lib/dialogs", () => ({
  alertAsync: vi.fn(async (message: string) => {
    dialogs.alerts.push(message);
  }),
}));

import { useEditing, setGlobalIsEditing } from "../useEditing";
import { GridProvider, useGridContext } from "../../state/GridContext";
import { getInitialState } from "../../state/gridReducer";
import { setSheetContext } from "../../state/gridActions";
import { switchSheetForPointMode } from "../../lib/pointModeSheetSwitch";
import { __resetExternalEditForTests } from "../../lib/formulaEditTarget";
import { onAppEvent, AppEvents } from "../../lib/events";
import type { CellUpdateResult, GridState } from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let api: ReturnType<typeof useEditing> | null = null;
let grid: GridState | null = null;
let dispatchOut: ReturnType<typeof useGridContext>["dispatch"] | null = null;

function Harness(): null {
  api = useEditing();
  const { state, dispatch } = useGridContext();
  grid = state;
  dispatchOut = dispatch;
  return null;
}

let root: Root;
let host: HTMLDivElement;
let started: Array<{ row: number; col: number; sheetIndex: number }> = [];
let ended: Array<{ sheetIndex: number; committed: boolean; value: string }> = [];
const offs: Array<() => void> = [];

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** The grid on the backend's sheet at `index`, A1 selected: what the strip dispatches (WITH the stable id). */
function stateOn(index: number): GridState {
  const base = getInitialState();
  const sheet = backend.sheets[index];
  return {
    ...base,
    sheetContext: { activeSheetIndex: index, activeSheetName: sheet.name, activeSheetId: sheet.id },
    selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" },
  };
}

async function mount(initialState: GridState): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <GridProvider initialState={initialState}>
        <Harness />
      </GridProvider>,
    );
  });
  await settle();
}

/** The formula bar's open (FormulaInput calls `startEdit`). */
async function openEdit(value: string): Promise<void> {
  await act(async () => {
    await api!.startEdit(0, 0, value);
  });
  await settle();
}

async function typeValue(value: string): Promise<void> {
  await act(async () => {
    api!.updateValue(value);
  });
  await settle();
}

/** The strip's `loadSheets` after `sheets:refresh`: Core's context moves to the ACTIVE sheet, WITH its stable id. */
async function stripReRead(): Promise<void> {
  const active = backend.sheets[backend.active];
  await act(async () => {
    dispatchOut!(setSheetContext(backend.active, active.name, "grid", active.id));
  });
  await settle();
}

/** A rename of the sheet at `at` -- the strip's door, MCP or a script -- as it lands. */
async function renameLands(at: number, name: string): Promise<void> {
  backend.rename(at, name);
  await stripReRead();
}

/** A point-mode tab click (Core's own switch: the backend moves, the edit stays open). */
async function pointModeTo(index: number): Promise<void> {
  await act(async () => {
    await switchSheetForPointMode(index, dispatchOut!);
  });
  await settle();
}

async function commit(): Promise<CellUpdateResult | null> {
  let result: CellUpdateResult | null = null;
  await act(async () => {
    result = await api!.commitEdit();
  });
  await settle();
  return result;
}

async function cancel(): Promise<void> {
  await act(async () => {
    await api!.cancelEdit();
  });
  await settle();
}

beforeEach(() => {
  backend.sheets = [
    { id: "S-sales", name: "Sales" },
    { id: "S-drill", name: "Drillthrough" },
    { id: "S-costs", name: "Costs" },
    { id: "S-summary", name: "Summary" },
    { id: "S-extra", name: "Extra" },
  ];
  backend.active = 3;
  backend.writes = [];
  backend.switches = [];
  backend.failSwitch = null;
  backend.mergeGate = null;
  dialogs.alerts = [];
  started = [];
  ended = [];
  offs.push(
    onAppEvent<{ row: number; col: number; sheetIndex: number }>(AppEvents.EDIT_STARTED, (d) => {
      started.push({ row: d.row, col: d.col, sheetIndex: d.sheetIndex });
    }),
    onAppEvent<{ sheetIndex: number; committed: boolean; value: string }>(AppEvents.EDIT_ENDED, (d) => {
      ended.push({ sheetIndex: d.sheetIndex, committed: d.committed, value: d.value });
    }),
  );
  __resetExternalEditForTests();
  setGlobalIsEditing(false);
});

afterEach(async () => {
  for (const off of offs.splice(0)) off();
  await act(async () => {
    root.unmount();
  });
  host.remove();
  setGlobalIsEditing(false);
  __resetExternalEditForTests();
  api = null;
  grid = null;
  dispatchOut = null;
});

describe("F1: the edited sheet RENAMED while the edit is open -- followed by its stable id, never refused", () => {
  it("formula-bar edit: rename its sheet through the strip, press Enter -- ONE write, on the renamed sheet, no alert", async () => {
    backend.active = 0;
    await mount(stateOn(0));
    await openEdit("hello");
    expect(grid!.editing).toMatchObject({ sourceSheetIndex: 0, sourceSheetName: "Sales", sourceSheetId: "S-sales" });

    await renameLands(0, "Data");
    expect(grid!.editing, "the edit did not follow the rename of its own sheet").toMatchObject({
      sourceSheetName: "Data",
      sourceSheetId: "S-sales",
    });

    const result = await commit();
    expect(dialogs.alerts, "the entry was refused").toEqual([]);
    expect(backend.switches, "the commit switched sheets").toEqual([]);
    expect(backend.writes).toEqual([{ sheet: "Data", id: "S-sales", row: 0, col: 0, value: "hello" }]);
    expect(result).toMatchObject({ success: true });
    expect(ended).toEqual([{ sheetIndex: 0, committed: true, value: "hello" }]);
  });

  it("in-cell edit opened by typing: rename its sheet (an MCP rename re-reads the same way), keep typing, Enter -- written to the renamed sheet", async () => {
    await mount(stateOn(3));
    await act(async () => {
      await api!.startEditing("h");
    });
    await settle();
    await renameLands(3, "Totals");
    expect(grid!.editing, "the in-cell edit did not follow the rename of its own sheet").toMatchObject({
      sourceSheetName: "Totals",
      sourceSheetId: "S-summary",
    });
    await typeValue("hello");

    const result = await commit();
    expect(dialogs.alerts).toEqual([]);
    expect(backend.writes).toEqual([{ sheet: "Totals", id: "S-summary", row: 0, col: 0, value: "hello" }]);
    expect(result).toMatchObject({ success: true });
  });

  it("point mode: the edit's sheet renamed (by a script) while the user picks on another sheet -- Enter returns to it BY ID and writes there", async () => {
    await mount(stateOn(3));
    await openEdit("=");
    await pointModeTo(2); // Costs
    await typeValue("=Costs!B2");
    backend.rename(3, "Totals"); // the strip re-reads the ACTIVE sheet (Costs): nothing tells the edit
    await stripReRead();
    backend.switches = [];

    const result = await commit();
    expect(dialogs.alerts, "the renamed sheet was taken for a deleted one").toEqual([]);
    expect(backend.switches).toEqual([3]);
    expect(backend.writes).toEqual([{ sheet: "Totals", id: "S-summary", row: 0, col: 0, value: "=Costs!B2" }]);
    expect(result).toMatchObject({ success: true });
    expect(grid!.sheetContext).toEqual({ activeSheetIndex: 3, activeSheetName: "Totals", activeSheetId: "S-summary" });
  });

  it("point mode: RENUMBERED and RENAMED together -- followed by id to its new index under its new name", async () => {
    await mount(stateOn(3));
    await openEdit("=");
    await pointModeTo(2);
    await typeValue("=Costs!B2");
    backend.remove(1); // Costs 2 -> 1, Summary 3 -> 2, Extra slides into 3
    backend.rename(2, "Totals");
    await stripReRead();
    backend.switches = [];

    const result = await commit();
    expect(backend.switches, "the return went to the stored index (now Extra)").toEqual([2]);
    expect(backend.writes).toEqual([{ sheet: "Totals", id: "S-summary", row: 0, col: 0, value: "=Costs!B2" }]);
    expect(result).toMatchObject({ success: true });
    expect(dialogs.alerts).toEqual([]);
  });
});

describe("F1: a rename that lands while the edit is still OPENING", () => {
  it("the open records the sheet's stable id, so a rename landing during its await is followed: Enter writes to the renamed sheet", async () => {
    backend.active = 0;
    await mount(stateOn(0));
    let release!: () => void;
    backend.mergeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opening: Promise<void> | undefined;
    await act(async () => {
      opening = api!.startEdit(0, 0, "hello");
    });
    // The open waits on its merge-info read (it named its sheet "Sales" before
    // the await); the rename lands NOW.
    await renameLands(0, "Data");
    await act(async () => {
      release();
      await opening;
    });
    await settle();
    expect(grid!.editing, "the open did not record its sheet's id").toMatchObject({
      sourceSheetName: "Data",
      sourceSheetId: "S-sales",
    });

    const result = await commit();
    expect(dialogs.alerts, "the entry was refused").toEqual([]);
    expect(backend.writes).toEqual([{ sheet: "Data", id: "S-sales", row: 0, col: 0, value: "hello" }]);
    expect(result).toMatchObject({ success: true });
  });
});

describe("F1: the edited sheet DELETED -- still refused, nothing written anywhere", () => {
  it("point mode: a namesake created after the delete is NOT the edit's sheet -- refused, one message saying it was deleted", async () => {
    await mount(stateOn(3));
    await openEdit("=");
    await pointModeTo(2);
    await typeValue("=Costs!B2");
    backend.remove(3); // Summary deleted; Extra slides into 3
    backend.sheets.push({ id: "S-new", name: "Summary" }); // a NEW sheet takes the name
    backend.switches = [];

    const result = await commit();
    expect(backend.writes, "the entry was written into the namesake").toEqual([]);
    expect(backend.switches).toEqual([]);
    expect(result).toMatchObject({ success: false });
    expect(dialogs.alerts).toHaveLength(1);
    expect(dialogs.alerts[0]).toContain('the sheet "Summary" was deleted while you were typing');
    expect(dialogs.alerts[0]).toContain("=Costs!B2");
    expect(grid!.editing).toBeNull();
  });

  it("no point mode: the shown sheet deleted under an open edit (the strip moves to another sheet) -- refused, nothing written", async () => {
    await mount(stateOn(3));
    await openEdit("hello");
    backend.remove(3); // the active Summary goes; the backend activates the sheet now at 3 (Extra)
    await stripReRead();
    expect(grid!.sheetContext.activeSheetId).toBe("S-extra");

    const result = await commit();
    expect(backend.writes, "the entry was written into the sheet that slid into place").toEqual([]);
    expect(result).toMatchObject({ success: false });
    expect(dialogs.alerts).toHaveLength(1);
  });
});

describe("F4: EDIT_STARTED and EDIT_ENDED name the edit's sheet as it is NOW", () => {
  it("a renumbering that lands DURING the open's await: EDIT_STARTED carries the index the reducer stores, and EDIT_ENDED the same", async () => {
    await mount(stateOn(3));
    let release!: () => void;
    backend.mergeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opening: Promise<void> | undefined;
    await act(async () => {
      opening = api!.startEdit(0, 0, "4");
    });
    // The open waits on its merge-info read; the strip's discard lands NOW:
    // Summary 3 -> 2, and Extra slides into 3.
    backend.remove(1);
    await stripReRead();
    expect(grid!.editing, "precondition: the open has not dispatched yet").toBeNull();

    await act(async () => {
      release();
      await opening;
    });
    await settle();
    expect(grid!.editing?.sourceSheetIndex).toBe(2);
    expect(started, "EDIT_STARTED named the sheet that slid into the old index").toEqual([{ row: 0, col: 0, sheetIndex: 2 }]);

    await commit();
    expect(ended).toEqual([{ sheetIndex: 2, committed: true, value: "4" }]);
    expect(backend.writes).toEqual([{ sheet: "Summary", id: "S-summary", row: 0, col: 0, value: "4" }]);
  });

  it("control: no renumbering -- EDIT_STARTED carries the sheet's index as the open read it", async () => {
    await mount(stateOn(3));
    await openEdit("4");
    expect(started).toEqual([{ row: 0, col: 0, sheetIndex: 3 }]);
  });

  it("a CANCEL whose sheet is GONE reports where the grid is -- never the stored index, which now names another sheet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await mount(stateOn(3));
    await openEdit("=");
    await pointModeTo(2); // Costs
    backend.remove(3); // Summary deleted; Extra slides into the stored index 3
    backend.switches = [];

    await cancel();
    expect(backend.switches).toEqual([]);
    expect(grid!.editing).toBeNull();
    expect(ended, "the cancel reported the sheet that slid into the stored index").toEqual([
      { sheetIndex: 2, committed: false, value: "=" },
    ]);
    warn.mockRestore();
  });

  it("a cancel whose switch back is REFUSED after a renumbering reports the edit's sheet where the fresh read found it", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mount(stateOn(3));
    await openEdit("=");
    await pointModeTo(2); // Costs
    backend.remove(1); // Costs 2 -> 1, Summary 3 -> 2, Extra slides into the stored index 3
    await stripReRead();
    backend.failSwitch = new Error("Protect Workbook refuses the switch");

    await cancel();
    expect(grid!.editing).toBeNull();
    expect(ended, "the cancel reported the stored index (now Extra)").toEqual([{ sheetIndex: 2, committed: false, value: "=" }]);
    quiet.mockRestore();
  });
});
