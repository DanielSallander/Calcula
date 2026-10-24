//! FILENAME: app/src/core/hooks/__tests__/editFollowsSheetIdentity.test.tsx
// PURPOSE: Core's cell edit commits and cancels on ITS OWN sheet -- found by the
//          sheet's identity (its name) -- when the sheets are renumbered under
//          it, and refuses rather than writing anywhere when that sheet is gone.
//          Driven through the REAL useEditing hook, the real reducer and Core's
//          real point-mode switch, against a fake backend that holds a sheet
//          list, an active sheet, and records every write ON THE SHEET IT LANDS.
// CONTEXT: Review TSHELL4-DISCARD-LANDS-UNDER-OPEN-EDIT. Sheets: Sales,
//          Drillthrough (temporary), Costs, Summary, Extra. The user left the
//          temporary sheet for Summary and started typing; the strip's discard
//          of the temporary sheet landed while the edit was open, Summary moved
//          from index 3 to 2, and Extra slid into 3. The edit still said 3: the
//          editor vanished, and Enter "switched back" to index 3 and wrote the
//          value into EXTRA (or, with no sheet after Summary, failed "out of
//          range" and lost it). MCP and script deletes renumber the same way and
//          tell the strip nothing, so the rule is identity, not a re-key.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const backend = vi.hoisted(() => {
  const b = {
    sheets: [] as string[],
    active: 0,
    writes: [] as Array<{ sheet: string; row: number; col: number; value: string }>,
    switches: [] as number[],
    reads: 0,
    /** Thrown by the next set_active_sheet calls (the backend refusing the switch). */
    failSwitch: null as Error | null,
    /** Thrown only by the SECOND set_active_sheet from here on (a retry the backend refuses). */
    failSecondSwitch: null as Error | null,
    /** Runs once, inside the next set_active_sheet, BEFORE it applies (a renumbering landing between a read and a switch). */
    beforeSwitch: null as (() => void) | null,
    /** Sheets HIDDEN (by name): listed as hidden, and set_active_sheet refuses them, as Rust's does. */
    hidden: new Set<string>(),
    list() {
      return {
        sheets: b.sheets.map((name, index) => ({
          index,
          name,
          visibility: b.hidden.has(name) ? ("hidden" as const) : ("visible" as const),
        })),
        activeIndex: b.active,
      };
    },
    /** The backend removes the sheet at `at`; the active sheet keeps its identity (Rust's delete_sheet arithmetic). */
    remove(at: number) {
      b.sheets.splice(at, 1);
      if (b.active > at) b.active -= 1;
    },
  };
  return b;
});

vi.mock("../../lib/tauri-api", () => ({
  getMergeInfo: vi.fn(async () => null),
  getCell: vi.fn(async () => null),
  updateCellOnSheets: vi.fn(async () => []),
  getSheets: vi.fn(async () => {
    backend.reads += 1;
    return backend.list();
  }),
  setActiveSheet: vi.fn(async (index: number) => {
    backend.switches.push(index);
    const before = backend.beforeSwitch;
    backend.beforeSwitch = null;
    before?.();
    if (backend.failSwitch) throw backend.failSwitch;
    if (backend.failSecondSwitch && backend.switches.length === 2) throw backend.failSecondSwitch;
    if (index < 0 || index >= backend.sheets.length) throw new Error(`Sheet index ${index} is out of range`);
    if (backend.hidden.has(backend.sheets[index])) {
      throw `Sheet '${backend.sheets[index]}' is hidden and cannot be activated. Unhide it first.`;
    }
    backend.active = index;
    return backend.list();
  }),
  updateCell: vi.fn(async (row: number, col: number, value: string) => {
    backend.writes.push({ sheet: backend.sheets[backend.active], row, col, value });
    return { cells: [{ row, col, display: value, formula: value.startsWith("=") ? value : null }] };
  }),
}));

const dialogs = vi.hoisted(() => ({ alerts: [] as string[] }));
vi.mock("../../lib/dialogs", () => ({
  alertAsync: vi.fn(async (message: string) => {
    dialogs.alerts.push(message);
  }),
}));

import { useEditing, getGlobalIsEditing, setGlobalIsEditing } from "../useEditing";
import { GridProvider, useGridContext } from "../../state/GridContext";
import { getInitialState } from "../../state/gridReducer";
import { setSheetContext } from "../../state/gridActions";
import { switchSheetForPointMode } from "../../lib/pointModeSheetSwitch";
import {
  __resetExternalEditForTests,
  getParkedViewSheetIndex,
  isExternalSessionParked,
} from "../../lib/formulaEditTarget";
import { createFakeExternalEdit } from "../../lib/__tests__/helpers/fakeExternalEdit";
import { updateCell } from "../../lib/tauri-api";
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
let ended: Array<{ sheetIndex: number; committed: boolean; value: string }> = [];
let offEnded: () => void = () => {};

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
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

/** The grid on `name` at `index`, A1 selected: what the strip dispatches after a switch. */
function stateOn(index: number, name: string): GridState {
  const base = getInitialState();
  return {
    ...base,
    sheetContext: { activeSheetIndex: index, activeSheetName: name },
    selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" },
  };
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

/** The tab strip's discard of the sheet at `at`, as it lands: the backend removes it, the strip moves Core's context. */
async function stripDiscards(at: number): Promise<void> {
  backend.remove(at);
  await act(async () => {
    dispatchOut!(setSheetContext(backend.active, backend.sheets[backend.active]));
  });
  await settle();
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
  backend.sheets = ["Sales", "Drillthrough", "Costs", "Summary", "Extra"];
  backend.active = 3;
  backend.writes = [];
  backend.switches = [];
  backend.reads = 0;
  backend.failSwitch = null;
  backend.failSecondSwitch = null;
  backend.beforeSwitch = null;
  backend.hidden = new Set<string>();
  dialogs.alerts = [];
  ended = [];
  offEnded = onAppEvent<{ sheetIndex: number; committed: boolean; value: string }>(AppEvents.EDIT_ENDED, (d) => {
    ended.push({ sheetIndex: d.sheetIndex, committed: d.committed, value: d.value });
  });
  __resetExternalEditForTests();
  setGlobalIsEditing(false);
});

afterEach(async () => {
  offEnded();
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

describe("an edit opened, then its sheet renumbered under it (the discard landed)", () => {
  it("Enter: ONE write, on the edited sheet, and no switch to the old index", async () => {
    await mount(stateOn(3, "Summary"));
    await openEdit("42");
    expect(grid!.editing).toMatchObject({ sourceSheetIndex: 3, sourceSheetName: "Summary" });

    await stripDiscards(1); // Drillthrough goes: Summary 3 -> 2, Extra slides into 3
    expect(grid!.sheetContext).toEqual({ activeSheetIndex: 2, activeSheetName: "Summary" });
    // Soft: when the edit does not follow, the commit below must STILL land on
    // Summary -- and when it does not, that is the failure worth reading.
    expect.soft(grid!.editing?.sourceSheetIndex, "the edit did not follow its sheet to its new index").toBe(2);

    const result = await commit();
    expect(backend.switches, "the commit switched sheets (to the old index)").toEqual([]);
    expect(backend.writes, "the value did not land once, on Summary").toEqual([
      { sheet: "Summary", row: 0, col: 0, value: "42" },
    ]);
    expect(result).toMatchObject({ success: true });
    expect(grid!.editing).toBeNull();
    expect(grid!.sheetContext).toEqual({ activeSheetIndex: 2, activeSheetName: "Summary" });
    expect(ended).toEqual([{ sheetIndex: 2, committed: true, value: "42" }]);
    expect(dialogs.alerts).toEqual([]);
  });

  it("Enter with NO sheet after the edited one: not lost to 'out of range' either", async () => {
    backend.sheets = ["Sales", "Drillthrough", "Costs", "Summary"];
    await mount(stateOn(3, "Summary"));
    await openEdit("42");
    await stripDiscards(1);
    const result = await commit();
    expect(result).toMatchObject({ success: true });
    expect(backend.switches).toEqual([]);
    expect(backend.writes).toEqual([{ sheet: "Summary", row: 0, col: 0, value: "42" }]);
  });

  it("Escape: no switch, no write, and the edit ends", async () => {
    await mount(stateOn(3, "Summary"));
    await openEdit("42");
    await stripDiscards(1);
    await cancel();
    expect(backend.switches, "the cancel switched sheets (to the old index)").toEqual([]);
    expect(backend.writes).toEqual([]);
    expect(grid!.editing).toBeNull();
    expect(grid!.sheetContext).toEqual({ activeSheetIndex: 2, activeSheetName: "Summary" });
    expect(ended).toEqual([{ sheetIndex: 2, committed: false, value: "42" }]);
  });
});

describe("the commit and cancel decide by the sheet's NAME, whatever index the edit stored", () => {
  // The edit's index is stale and the reducer never got a chance to rebase it:
  // what commitEdit / cancelEdit decide on their own.
  function staleEditOnSummary(): GridState {
    return {
      ...stateOn(2, "Summary"),
      editing: { row: 0, col: 0, value: "42", sourceSheetIndex: 3, sourceSheetName: "Summary" },
    };
  }

  it("Enter on the edit's own sheet at a new index writes there -- not into Extra, which holds the old index", async () => {
    backend.sheets = ["Sales", "Costs", "Summary", "Extra"];
    backend.active = 2;
    await mount(staleEditOnSummary());
    const result = await commit();
    expect(backend.switches, "the commit switched sheets although the grid shows the edit's sheet").toEqual([]);
    expect(backend.writes, "the value went into another sheet").toEqual([
      { sheet: "Summary", row: 0, col: 0, value: "42" },
    ]);
    expect(result).toMatchObject({ success: true });
  });

  it("Escape on the edit's own sheet at a new index switches nowhere", async () => {
    backend.sheets = ["Sales", "Costs", "Summary", "Extra"];
    backend.active = 2;
    await mount(staleEditOnSummary());
    await cancel();
    expect(backend.switches, "the cancel switched sheets although the grid shows the edit's sheet").toEqual([]);
    expect(grid!.sheetContext).toEqual({ activeSheetIndex: 2, activeSheetName: "Summary" });
    expect(grid!.editing).toBeNull();
  });
});

describe("point mode: the user went to another sheet to pick a reference, and the sheets renumbered meanwhile", () => {
  it("Enter returns to the edit's sheet by NAME (its new index), never its old one, and writes there", async () => {
    await mount(stateOn(3, "Summary"));
    await openEdit("=");
    await pointModeTo(2); // Costs
    expect(grid!.sheetContext).toEqual({ activeSheetIndex: 2, activeSheetName: "Costs" });
    await typeValue("=Costs!B2");

    await stripDiscards(1); // Costs 2 -> 1, Summary 3 -> 2, Extra slides into 3
    expect(grid!.sheetContext.activeSheetName).toBe("Costs");
    expect(grid!.editing?.sourceSheetIndex, "point mode: the reducer cannot know where the edit's sheet went").toBe(3);
    backend.switches = [];

    const result = await commit();
    expect(backend.switches, "the return went to the stored index instead of the edit's sheet").toEqual([2]);
    expect(backend.writes).toEqual([{ sheet: "Summary", row: 0, col: 0, value: "=Costs!B2" }]);
    expect(result).toMatchObject({ success: true });
    expect(grid!.sheetContext).toEqual({ activeSheetIndex: 2, activeSheetName: "Summary" });
    expect(grid!.editing).toBeNull();
    expect(ended).toEqual([{ sheetIndex: 2, committed: true, value: "=Costs!B2" }]);
  });

  it("Escape returns to the edit's sheet by NAME as well, and writes nothing", async () => {
    await mount(stateOn(3, "Summary"));
    await openEdit("=");
    await pointModeTo(2);
    await stripDiscards(1);
    backend.switches = [];

    await cancel();
    expect(backend.switches, "the cancel returned to the stored index instead of the edit's sheet").toEqual([2]);
    expect(backend.writes).toEqual([]);
    expect(grid!.sheetContext).toEqual({ activeSheetIndex: 2, activeSheetName: "Summary" });
    expect(grid!.editing).toBeNull();
    expect(ended).toEqual([{ sheetIndex: 2, committed: false, value: "=" }]);
  });

  it("control (no renumbering): Enter still returns to the source sheet and writes there -- the point-mode trip as before", async () => {
    await mount(stateOn(3, "Summary"));
    await openEdit("=");
    await pointModeTo(2);
    await typeValue("=Costs!B2");
    backend.switches = [];
    const result = await commit();
    expect(backend.switches).toEqual([3]);
    expect(backend.writes).toEqual([{ sheet: "Summary", row: 0, col: 0, value: "=Costs!B2" }]);
    expect(result).toMatchObject({ success: true });
    expect(grid!.sheetContext).toEqual({ activeSheetIndex: 3, activeSheetName: "Summary" });
  });

  it("a renumbering that lands BETWEEN the fresh read and the switch is caught by the switch's own answer", async () => {
    await mount(stateOn(3, "Summary"));
    await openEdit("=");
    await pointModeTo(2);
    await typeValue("=Costs!B2");
    backend.switches = [];
    // The discard is already on its way: it lands inside the commit's first switch.
    backend.beforeSwitch = () => backend.remove(1);

    const result = await commit();
    expect(backend.switches, "the switch that landed on Extra was trusted").toEqual([3, 2]);
    expect(backend.writes).toEqual([{ sheet: "Summary", row: 0, col: 0, value: "=Costs!B2" }]);
    expect(result).toMatchObject({ success: true });
    expect(grid!.sheetContext).toEqual({ activeSheetIndex: 2, activeSheetName: "Summary" });
  });
});

describe("a return that lands on the wrong sheet and whose retry is REFUSED", () => {
  it("refuses the entry, writes nothing, and the grid follows the sheet the backend was left on", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mount(stateOn(3, "Summary"));
    await openEdit("=");
    await pointModeTo(2);
    await typeValue("=Costs!B2");
    backend.switches = [];
    // The discard lands inside the first switch (which therefore lands on
    // Extra), and the backend refuses the retry.
    backend.beforeSwitch = () => backend.remove(1);
    backend.failSecondSwitch = new Error("Protect Workbook refuses the switch");

    const result = await commit();
    expect(backend.switches).toEqual([3, 2]);
    expect(backend.writes).toEqual([]);
    expect(result).toMatchObject({ success: false });
    expect(dialogs.alerts).toHaveLength(1);
    expect(grid!.sheetContext, "the grid shows one sheet while the backend is on another").toEqual({
      activeSheetIndex: 3,
      activeSheetName: "Extra",
    });
    expect(grid!.editing).toBeNull();
    quiet.mockRestore();
  });
});

describe("the edit's sheet deleted while the edit was open: REFUSED, nothing written anywhere", () => {
  it("Enter: no write, no switch, one message naming the sheet, and the edit ends where the grid is", async () => {
    await mount(stateOn(3, "Summary"));
    await openEdit("=");
    await pointModeTo(2);
    await typeValue("=Costs!B2");
    backend.remove(3); // a script deletes Summary; Extra slides into 3
    backend.switches = [];

    const result = await commit();
    expect(backend.writes, "the entry was written somewhere").toEqual([]);
    expect(backend.switches, "the commit switched to the stored index").toEqual([]);
    expect(result).toMatchObject({ success: false });
    expect(dialogs.alerts, "the refusal was not told").toHaveLength(1);
    expect(dialogs.alerts[0]).toContain('"Summary"');
    expect(dialogs.alerts[0]).toContain("=Costs!B2");
    expect(grid!.editing).toBeNull();
    expect(getGlobalIsEditing()).toBe(false);
    expect(grid!.sheetContext).toEqual({ activeSheetIndex: 2, activeSheetName: "Costs" });
  });

  it("Escape: no switch, and the edit ends where the grid is", async () => {
    await mount(stateOn(3, "Summary"));
    await openEdit("=");
    await pointModeTo(2);
    backend.remove(3);
    backend.switches = [];

    await cancel();
    expect(backend.switches).toEqual([]);
    expect(backend.writes).toEqual([]);
    expect(grid!.editing).toBeNull();
    expect(grid!.sheetContext).toEqual({ activeSheetIndex: 2, activeSheetName: "Costs" });
  });
});

describe("a cancel whose return is REFUSED by the backend does not leave the edit open", () => {
  it("the switch rejects: cancelEdit still resolves, and the edit is gone", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mount(stateOn(3, "Summary"));
    await openEdit("=");
    await pointModeTo(2);
    backend.failSwitch = new Error("Protect Workbook refuses the switch");

    let rejected: unknown = null;
    await act(async () => {
      await api!.cancelEdit().catch((err: unknown) => {
        rejected = err;
      });
    });
    await settle();
    expect(rejected, "cancelEdit rejected").toBeNull();
    expect(grid!.editing, "the refused switch left the edit set").toBeNull();
    expect(getGlobalIsEditing()).toBe(false);
    expect(ended).toEqual([{ sheetIndex: 3, committed: false, value: "=" }]);
    quiet.mockRestore();
  });
});

// Review COMMIT-RETURN-THROW-DROPS-ENTRY (round 6): the return's FIRST switch
// could throw -- the edit's sheet hidden under the edit (set_active_sheet
// refuses a hidden sheet), or an index gone out of range after a renumbering in
// the read -> switch gap -- and the error was rethrown: commitEdit alerted only
// the backend's bare sentence and the typed entry was gone.
describe("a return whose first switch would THROW never drops the entry", () => {
  it("the edit's sheet HIDDEN during point mode: no switch is attempted, nothing is written, and the message shows the entry", async () => {
    await mount(stateOn(3, "Summary"));
    await openEdit("=");
    await pointModeTo(2);
    await typeValue("=Costs!B2");
    backend.hidden.add("Summary"); // a script's api.setSheetVisibility, or an MCP tool
    backend.switches = [];

    const result = await commit();
    expect(backend.switches, "a switch to the hidden sheet was attempted").toEqual([]);
    expect(backend.writes, "the entry was written somewhere").toEqual([]);
    expect(result).toMatchObject({ success: false });
    expect(dialogs.alerts).toHaveLength(1);
    expect(dialogs.alerts[0]).toContain('the sheet "Summary" was hidden');
    expect(dialogs.alerts[0]).toContain("The entry was: =Costs!B2");
    expect(grid!.editing).toBeNull();
    expect(getGlobalIsEditing()).toBe(false);
    expect(grid!.sheetContext).toEqual({ activeSheetIndex: 2, activeSheetName: "Costs" });
  });

  it("Escape with the edit's sheet hidden: no switch, the edit ends, and EDIT_ENDED names the edit's sheet where the read found it", async () => {
    await mount(stateOn(3, "Summary"));
    await openEdit("=");
    await pointModeTo(2);
    await typeValue("=Costs!B2");
    backend.hidden.add("Summary");
    backend.switches = [];

    await cancel();
    expect(backend.switches).toEqual([]);
    expect(backend.writes).toEqual([]);
    expect(grid!.editing).toBeNull();
    expect(grid!.sheetContext).toEqual({ activeSheetIndex: 2, activeSheetName: "Costs" });
    expect(ended).toEqual([{ sheetIndex: 3, committed: false, value: "=Costs!B2" }]);
  });

  it("the edit's sheet hidden INSIDE the switch (between the read and the switch): refused as hidden, with the entry -- not as the backend's raw refusal", async () => {
    await mount(stateOn(3, "Summary"));
    await openEdit("=");
    await pointModeTo(2);
    await typeValue("=Costs!B2");
    backend.switches = [];
    backend.beforeSwitch = () => backend.hidden.add("Summary");

    const result = await commit();
    expect(backend.switches).toEqual([3]);
    expect(backend.writes).toEqual([]);
    expect(result).toMatchObject({ success: false });
    expect(dialogs.alerts).toHaveLength(1);
    expect(dialogs.alerts[0]).toContain('the sheet "Summary" was hidden while you were typing');
    expect(dialogs.alerts[0]).toContain("The entry was: =Costs!B2");
    expect(grid!.editing).toBeNull();
  });

  it("the edit's sheet is the LAST one and an earlier sheet goes inside the first switch ('out of range'): re-read, retried at its new index, written there", async () => {
    backend.sheets = ["Sales", "Drillthrough", "Costs", "Summary"];
    await mount(stateOn(3, "Summary"));
    await openEdit("=");
    await pointModeTo(2);
    await typeValue("=Costs!B2");
    backend.switches = [];
    // An MCP delete of an earlier sheet lands between the commit's read and its switch.
    backend.beforeSwitch = () => backend.remove(1);

    const result = await commit();
    expect(backend.switches, "the out-of-range switch was not retried at the sheet's new index").toEqual([3, 2]);
    expect(backend.writes).toEqual([{ sheet: "Summary", row: 0, col: 0, value: "=Costs!B2" }]);
    expect(result).toMatchObject({ success: true });
    expect(dialogs.alerts).toEqual([]);
    expect(grid!.sheetContext).toEqual({ activeSheetIndex: 2, activeSheetName: "Summary" });
    expect(grid!.editing).toBeNull();
  });

  it("the first switch REFUSED by the backend (Protect Workbook): a refusal that names it, the backend's sentence AND the entry", async () => {
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await mount(stateOn(3, "Summary"));
    await openEdit("=");
    await pointModeTo(2);
    await typeValue("=Costs!B2");
    backend.switches = [];
    backend.failSwitch = new Error("Protect Workbook refuses the switch");

    const result = await commit();
    expect(backend.switches).toEqual([3]);
    expect(backend.writes).toEqual([]);
    expect(result).toMatchObject({ success: false });
    expect(dialogs.alerts).toHaveLength(1);
    expect(dialogs.alerts[0]).toContain('could not go back to the sheet "Summary"');
    expect(dialogs.alerts[0]).toContain("Protect Workbook refuses the switch");
    expect(dialogs.alerts[0]).toContain("The entry was: =Costs!B2");
    expect(grid!.editing).toBeNull();
    expect(getGlobalIsEditing()).toBe(false);
    quiet.mockRestore();
  });

  it("a write the backend refuses (the safety net): the alert carries its sentence AND the entry", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mount(stateOn(3, "Summary"));
    await openEdit("=A1+1");
    vi.mocked(updateCell).mockRejectedValueOnce("Cannot change part of an array.");

    const result = await commit();
    expect(result).toMatchObject({ success: false });
    expect(dialogs.alerts).toEqual(["Cannot change part of an array.\n\nThe entry was: =A1+1"]);
    expect(grid!.editing).toBeNull();
    quiet.mockRestore();
  });
});

// Review FR-RESYNC-COMMITS-ON-RENUMBER (round 6): an EXTERNAL session's parked
// view was a bare index nothing followed. The doors that renumber the sheets
// move the grid by dispatching its sheet context; this hook hands every
// rendered context to Core's follower, so the park follows its sheet.
describe("an EXTERNAL session's parked view follows the sheet the grid is moved to (this hook's effect)", () => {
  it("parked on Costs, a discard renumbers Costs: the park follows it to its new index, and the edit stays parked", async () => {
    await mount(stateOn(3, "Summary"));
    const fake = createFakeExternalEdit({ hostSheetIndex: 3, text: "=" });
    fake.register();
    await pointModeTo(2); // Costs
    expect(isExternalSessionParked()).toBe(true);
    expect(getParkedViewSheetIndex()).toBe(2);

    await stripDiscards(1); // Drillthrough goes: Costs 2 -> 1, and the strip moves Core's context there
    expect(grid!.sheetContext).toEqual({ activeSheetIndex: 1, activeSheetName: "Costs" });
    expect(getParkedViewSheetIndex(), "the parked view kept the index the discard took from it").toBe(1);
    expect(isExternalSessionParked()).toBe(true);
    expect(fake.session.parkedFlips).toEqual([true]);
  });

  it("parked, and a script moves the grid back to the host (at its new index): the edit un-parks there", async () => {
    await mount(stateOn(3, "Summary"));
    const fake = createFakeExternalEdit({ hostSheetIndex: 3, text: "=" });
    fake.register();
    await pointModeTo(2);
    backend.remove(1); // Summary 3 -> 2, Costs 2 -> 1
    backend.active = 2; // the script activates Summary
    await act(async () => {
      dispatchOut!(setSheetContext(2, "Summary"));
    });
    await settle();
    expect(isExternalSessionParked(), "the grid shows the host and the edit stayed parked").toBe(false);
    expect(fake.session.parkedFlips).toEqual([true, false]);
  });
});
