//! FILENAME: app/src/core/hooks/__tests__/editGroupReplication.test.tsx
// PURPOSE: A committed edit is replicated to every GROUPED sheet other than the
//          edit's OWN -- including the sheet the user pointed at during a
//          cross-sheet point-mode trip, when that sheet is itself grouped -- and
//          a replication that did not reach every requested sheet is said out
//          loud. Driven through the REAL useEditing hook, the real reducer, the
//          real sheet-grouping store and Core's real point-mode switch, against
//          a fake backend whose grouped `update_cell` skips its own ACTIVE
//          sheet and answers the sheets it actually wrote, as the Rust one does
//          (commands/data.rs `update_cell_grouped`).
// CONTEXT: Review F2-group-replication-excludes-pointed-sheet. After a point-mode
//          commit the replication excluded the closure's sheet context -- the
//          sheet the user POINTED at -- instead of the edit's own sheet. With
//          Sheet1 and Sheet2 grouped, "=" on Sheet1, a click on the Sheet2 tab and
//          Enter: the replication asked for [Sheet1], the backend skipped it as
//          its active sheet, and Sheet2 silently never got the entry.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const backend = vi.hoisted(() => {
  const b = {
    sheets: [] as Array<{ id: string; name: string }>,
    active: 0,
    writes: [] as Array<{ sheet: string; value: string }>,
    /**
     * The undo history as Rust keeps it: ONE open slot that update_cell and
     * update_cell_on_sheets JOIN when it is open, and otherwise each records a
     * step of its own (commands/data.rs, core/engine/src/undo.rs). `log` is the
     * order of every write and transaction call.
     */
    open: null as null | { ticket: number; sheets: string[] },
    steps: [] as string[][],
    log: [] as string[],
    nextTicket: 1,
    record(sheets: string[]) {
      if (b.open) b.open.sheets.push(...sheets);
      else b.steps.push(sheets);
    },
    /** Every sheet list the replication was asked for. */
    replications: [] as number[][],
    /** Sheets the replication silently does not write (a backend skip the frontend must not miss). */
    skip: new Set<number>(),
    /** A refusal of the whole replication (a grouped sheet protects the cell). */
    refuse: null as string | null,
    list() {
      return {
        sheets: b.sheets.map((s, index) => ({ index, name: s.name, sheetId: s.id, visibility: "visible" as const })),
        activeIndex: b.active,
      };
    },
  };
  return b;
});

vi.mock("../../lib/tauri-api", () => ({
  getMergeInfo: vi.fn(async () => null),
  getCell: vi.fn(async () => null),
  getSheets: vi.fn(async () => backend.list()),
  setActiveSheet: vi.fn(async (index: number) => {
    if (index < 0 || index >= backend.sheets.length) throw new Error(`Sheet index ${index} is out of range`);
    backend.active = index;
    return backend.list();
  }),
  // Rust's `update_cell`: with `groupSheets` it is `update_cell_grouped` --
  // the edit's own sheet, then the other grouped sheets (its ACTIVE sheet
  // skipped, the answer the sheets it actually wrote), in ONE undo step the
  // call opens and closes itself; a refused replication (`backend.refuse`)
  // leaves the own sheet written and is answered in `groupError`.
  updateCell: vi.fn(async (row: number, col: number, value: string, groupSheets?: number[]) => {
    const own = backend.sheets[backend.active].name;
    backend.writes.push({ sheet: own, value });
    backend.log.push("update_cell");
    const cells = [{ row, col, display: value, formula: value.startsWith("=") ? value : null }];
    if (!groupSheets || groupSheets.length === 0) {
      backend.record([own]);
      return { cells };
    }
    backend.replications.push([...groupSheets]);
    if (backend.refuse) {
      backend.record([own]);
      return { cells, groupError: backend.refuse };
    }
    const wrote: number[] = [];
    for (const index of groupSheets) {
      if (index === backend.active || backend.skip.has(index)) continue;
      backend.writes.push({ sheet: backend.sheets[index].name, value });
      wrote.push(index);
    }
    backend.record([own, ...wrote.map((i) => backend.sheets[i].name)]);
    return { cells, groupWritten: wrote };
  }),
  // The separate replication door the entry no longer uses (scripts still do).
  updateCellOnSheets: vi.fn(async (indices: number[], _row: number, _col: number, value: string) => {
    backend.replications.push([...indices]);
    const wrote: number[] = [];
    for (const index of indices) {
      if (index === backend.active || backend.skip.has(index)) continue;
      backend.writes.push({ sheet: backend.sheets[index].name, value });
      wrote.push(index);
    }
    if (wrote.length > 0) backend.record(wrote.map((i) => backend.sheets[i].name));
    backend.log.push("update_cell_on_sheets");
    return wrote;
  }),
  beginUndoTransaction: vi.fn(async () => {
    backend.log.push("begin");
    if (backend.open) return null;
    backend.open = { ticket: backend.nextTicket++, sheets: [] };
    return backend.open.ticket;
  }),
  commitUndoTransaction: vi.fn(async (ticket?: number | null) => {
    backend.log.push(`commit:${ticket ?? "bare"}`);
    if (backend.open && (ticket == null || ticket === backend.open.ticket)) {
      if (backend.open.sheets.length > 0) backend.steps.push(backend.open.sheets);
      backend.open = null;
    }
  }),
  cancelUndoTransaction: vi.fn(async () => {
    backend.log.push("cancel");
    backend.open = null;
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
import { switchSheetForPointMode } from "../../lib/pointModeSheetSwitch";
import { __resetExternalEditForTests } from "../../lib/formulaEditTarget";
import { clearSheetGrouping, setSelectedSheetIndices } from "../../state/sheetGrouping";
import type { CellUpdateResult, GridState } from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let api: ReturnType<typeof useEditing> | null = null;
let dispatchOut: ReturnType<typeof useGridContext>["dispatch"] | null = null;

function Harness(): null {
  api = useEditing();
  dispatchOut = useGridContext().dispatch;
  return null;
}

let root: Root;
let host: HTMLDivElement;

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function stateOn(index: number): GridState {
  const sheet = backend.sheets[index];
  return {
    ...getInitialState(),
    sheetContext: { activeSheetIndex: index, activeSheetName: sheet.name, activeSheetId: sheet.id },
    selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" },
  };
}

async function mountOn(index: number): Promise<void> {
  backend.active = index;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <GridProvider initialState={stateOn(index)}>
        <Harness />
      </GridProvider>,
    );
  });
  await settle();
}

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

beforeEach(() => {
  backend.sheets = [
    { id: "S1", name: "Sheet1" },
    { id: "S2", name: "Sheet2" },
    { id: "S3", name: "Sheet3" },
  ];
  backend.active = 0;
  backend.writes = [];
  backend.replications = [];
  backend.skip = new Set();
  backend.refuse = null;
  backend.open = null;
  backend.steps = [];
  backend.log = [];
  backend.nextTicket = 1;
  dialogs.alerts = [];
  __resetExternalEditForTests();
  setGlobalIsEditing(false);
  clearSheetGrouping();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  setGlobalIsEditing(false);
  __resetExternalEditForTests();
  clearSheetGrouping();
  api = null;
  dispatchOut = null;
});

describe("F2: the replication excludes the EDIT'S own sheet, never the sheet pointed at", () => {
  it("Sheet1 + Sheet2 grouped, '=' on Sheet1, point at Sheet2, Enter: the replication asks for Sheet2 and Sheet2 gets the entry", async () => {
    setSelectedSheetIndices([0, 1]);
    await mountOn(0);
    await openEdit("=");
    await pointModeTo(1); // Sheet2: a GROUPED sheet
    await typeValue("=Sheet2!B2");

    const result = await commit();
    expect(result).toMatchObject({ success: true });
    expect(backend.replications, "the replication excluded the pointed-at sheet").toEqual([[1]]);
    expect(backend.writes).toEqual([
      { sheet: "Sheet1", value: "=Sheet2!B2" },
      { sheet: "Sheet2", value: "=Sheet2!B2" },
    ]);
    expect(dialogs.alerts).toEqual([]);
  });

  it("the mirror: '=' on Sheet2, point at Sheet1 (grouped): the replication asks for Sheet1", async () => {
    setSelectedSheetIndices([0, 1]);
    await mountOn(1);
    await openEdit("=");
    await pointModeTo(0);
    await typeValue("=Sheet1!B2");

    await commit();
    expect(backend.replications).toEqual([[0]]);
    expect(backend.writes).toEqual([
      { sheet: "Sheet2", value: "=Sheet1!B2" },
      { sheet: "Sheet1", value: "=Sheet1!B2" },
    ]);
    expect(dialogs.alerts).toEqual([]);
  });

  it("control: pointing at an UNGROUPED sheet still replicates to exactly the other grouped sheet", async () => {
    setSelectedSheetIndices([0, 1]);
    await mountOn(0);
    await openEdit("=");
    await pointModeTo(2); // Sheet3 is not in the group
    await typeValue("=Sheet3!B2");

    await commit();
    expect(backend.replications).toEqual([[1]]);
    expect(backend.writes.map((w) => w.sheet)).toEqual(["Sheet1", "Sheet2"]);
    expect(dialogs.alerts).toEqual([]);
  });

  it("control: no point mode -- the replication asks for every grouped sheet but the edit's own", async () => {
    setSelectedSheetIndices([0, 1, 2]);
    await mountOn(0);
    await openEdit("7");

    await commit();
    expect(backend.replications).toEqual([[1, 2]]);
    expect(backend.writes.map((w) => w.sheet)).toEqual(["Sheet1", "Sheet2", "Sheet3"]);
    expect(dialogs.alerts).toEqual([]);
  });
});

describe("F2: a replication that did not reach every grouped sheet is said out loud", () => {
  it("the backend writes fewer sheets than were asked for: ONE alert naming the shortfall; the edit itself still lands", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setSelectedSheetIndices([0, 1, 2]);
    backend.skip = new Set([2]);
    await mountOn(0);
    await openEdit("7");

    const result = await commit();
    expect(result).toMatchObject({ success: true });
    expect(backend.writes.map((w) => w.sheet)).toEqual(["Sheet1", "Sheet2"]);
    expect(dialogs.alerts, "a grouped sheet missed the entry and nobody was told").toHaveLength(1);
    expect(dialogs.alerts[0]).toContain("The edit was applied to this sheet but NOT to the other grouped sheets.");
    expect(dialogs.alerts[0]).toContain("1 of the 2 other grouped sheets did not receive it.");
    quiet.mockRestore();
  });
});

// Round 17 (whatif4's NEW-grouped-edit-two-undo-steps). Excel [LIVE, whatif4
// round 16, Excel 16 + SendKeys on a visible instance]: a value typed with
// sheets grouped is ONE undo step -- one Ctrl+Z undoes every grouped sheet and
// lands on the sheet active at the entry. update_cell and update_cell_on_sheets
// each recorded their own step, so it took two, the first moving to the OTHER
// sheet. Round 19 (misc19): the step is now ONE backend call
// (`update_cell_grouped`), because a transaction held open across the awaits
// between the two doors took in any other writer's step. The backend half is
// pinned by cross_sheet_recalc_tests::
// a_grouped_entry_is_one_call_that_closes_its_own_undo_step.
describe("a grouped entry is ONE undo step, as Excel's is", () => {
  it("Sheet1+Sheet2+Sheet3 grouped, 7 typed on Sheet1: ONE backend call, one step holding every sheet, the edit's own first", async () => {
    setSelectedSheetIndices([0, 1, 2]);
    await mountOn(0);
    await openEdit("7");

    await commit();
    expect(backend.steps, "a grouped entry was more than one undo step").toEqual([["Sheet1", "Sheet2", "Sheet3"]]);
    expect(
      backend.log,
      "the grouped entry held a frontend transaction open across awaits (another writer could join it)",
    ).toEqual(["update_cell"]);
    expect(backend.open, "the grouped entry's transaction was left open").toBeNull();
  });

  it("a replication the backend refuses: the edit's own sheet stays one step, and the refusal is said", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    backend.refuse = "Sheet2 protects this cell";
    setSelectedSheetIndices([0, 1]);
    await mountOn(0);
    await openEdit("7");

    const result = await commit();
    expect(result).toMatchObject({ success: true });
    expect(backend.steps).toEqual([["Sheet1"]]);
    expect(backend.open, "a refused replication left the transaction open").toBeNull();
    expect(dialogs.alerts, "a refused replication was swallowed").toHaveLength(1);
    expect(dialogs.alerts[0]).toContain("Sheet2 protects this cell");
    quiet.mockRestore();
  });

  it("control: with no other sheet grouped, no transaction is opened", async () => {
    setSelectedSheetIndices([0]);
    await mountOn(0);
    await openEdit("7");

    await commit();
    expect(backend.log).toEqual(["update_cell"]);
    expect(backend.steps).toEqual([["Sheet1"]]);
  });
});
