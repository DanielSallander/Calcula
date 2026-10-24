//! FILENAME: app/src/core/hooks/__tests__/editGroupReplication.test.tsx
// PURPOSE: A committed edit is replicated to every GROUPED sheet other than the
//          edit's OWN -- including the sheet the user pointed at during a
//          cross-sheet point-mode trip, when that sheet is itself grouped -- and
//          a replication that did not reach every requested sheet is said out
//          loud. Driven through the REAL useEditing hook, the real reducer, the
//          real sheet-grouping store and Core's real point-mode switch, against
//          a fake backend whose `update_cell_on_sheets` skips its own ACTIVE
//          sheet and answers the sheets it actually wrote, as the Rust one does
//          (commands/data.rs).
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
    /** Every sheet list the replication was asked for. */
    replications: [] as number[][],
    /** Sheets the replication silently does not write (a backend skip the frontend must not miss). */
    skip: new Set<number>(),
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
  updateCell: vi.fn(async (row: number, col: number, value: string) => {
    backend.writes.push({ sheet: backend.sheets[backend.active].name, value });
    return { cells: [{ row, col, display: value, formula: value.startsWith("=") ? value : null }] };
  }),
  // Rust's `update_cell_on_sheets`: the ACTIVE sheet is skipped (`update_cell`
  // wrote it), and the answer is the sheets it actually wrote.
  updateCellOnSheets: vi.fn(async (indices: number[], _row: number, _col: number, value: string) => {
    backend.replications.push([...indices]);
    const wrote: number[] = [];
    for (const index of indices) {
      if (index === backend.active || backend.skip.has(index)) continue;
      backend.writes.push({ sheet: backend.sheets[index].name, value });
      wrote.push(index);
    }
    return wrote;
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
