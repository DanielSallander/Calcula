//! FILENAME: app/extensions/FloatingRange/__tests__/frRenumberUnderEdit.test.ts
// PURPOSE: A RENUMBERING of the sheets under an open floating-grid edit is not a
//          switch of sheet: the half-typed entry survives it, open or parked,
//          and a genuine switch away still commits. The REAL extension is
//          activated against a model of the backend whose sheet list, active
//          sheet and range rows move together (the backend re-derives a range's
//          host index from its host's stable id on every list).
// CONTEXT: Review FR-RESYNC-COMMITS-ON-RENUMBER (2026-10-23). The extension
//          decided "did the sheet change under my edit" by INDEX: a script's
//          api.deleteSheet of an earlier sheet, an MCP delete, or a temporary
//          sheet's discard renumbered the host, the index test read that as a
//          switch, and COMMITTED "=SUM(" as literal text -- while parked too,
//          which the extension's own rule forbids. Every announcement below is
//          replayed in the order its door makes it:
//            - a temporary sheet's discard / the tab strip's delete
//              (announceSheetDeleted): the Shell fans `sheets` out BEFORE
//              `floatingRanges` -- a detail-less SHEET_CHANGED, then
//              FLOATING_RANGES_CHANGED;
//            - an MCP tool's delete: its cascade arrives sorted, `floatingRanges`
//              first;
//            - a script's api.deleteSheet: the delete's own fan-out, then
//              announceSheetsChanged's SHEET_CHANGED naming the ACTIVE sheet at
//              its NEW index.
//          Sheets: Sales, Drill (temporary), Costs, Report (the floating grid's
//          host, sheet 3), Extra.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FloatingRangeInfo } from "@api/floatingRanges";

const FR_ID = "fr-report";
const HOST_ID = "id-report";

const b = vi.hoisted(() => {
  interface ModelSheet {
    id: string;
    name: string;
    kind?: "worksheet" | "canvas";
  }
  const m = {
    sheets: [] as ModelSheet[],
    activeId: "",
    /** The range's host, by its stable id (the backend re-derives the index from it). */
    hostId: "",
    /** Every set_active_sheet, by the index it was asked for. */
    switches: [] as number[],
    contents: {} as Record<string, { row: number; col: number; formula?: string | null; display?: string }>,
  };
  const indexOfId = (id: string) => m.sheets.findIndex((s) => s.id === id);
  const list = () => ({
    sheets: m.sheets.map((s, index) => ({
      index,
      name: s.name,
      sheetId: s.id,
      visibility: "visible" as const,
      kind: s.kind ?? ("worksheet" as const),
    })),
    activeIndex: Math.max(0, indexOfId(m.activeId)),
  });
  /** The backend deletes the sheet at `at`; the active sheet keeps its identity (Rust's delete_sheet arithmetic). */
  const removeAt = (at: number) => {
    m.sheets.splice(at, 1);
  };
  /** The backend moves the sheet at `from` to `to` (a script's api.moveSheet): every id keeps its sheet. */
  const move = (from: number, to: number) => {
    const [sheet] = m.sheets.splice(from, 1);
    m.sheets.splice(to, 0, sheet);
  };
  const activate = (index: number) => {
    if (!Number.isInteger(index) || index < 0 || index >= m.sheets.length) throw `Sheet index ${index} out of range`;
    m.activeId = m.sheets[index].id;
    return list();
  };
  return { m, list, removeAt, move, activate, indexOfId };
});

function rangeRow(): FloatingRangeInfo {
  return {
    id: FR_ID,
    backingSheetId: "id-backing",
    hostSheetId: b.m.hostId,
    x: 0,
    y: 0,
    rotation: 0,
    pinToGrid: false,
    rowCount: 4,
    colCount: 3,
    colWidths: {},
    rowHeights: {},
    showTitle: true,
    showColumnHeaders: true,
    showRowHeaders: true,
    name: "Float1",
    backingSheetIndex: 50,
    hostSheetIndex: b.indexOfId(b.m.hostId),
  } as FloatingRangeInfo;
}

const updateFloatingRangeCell = vi.fn(async (..._args: unknown[]): Promise<number[]> => []);
vi.mock("@api/floatingRanges", () => ({
  FLOATING_RANGE_MAX_ROWS: 1000,
  FLOATING_RANGE_MAX_COLS: 256,
  FLOATING_RANGE_MIN_COL_W: 8,
  FLOATING_RANGE_MAX_COL_W: 1000,
  FLOATING_RANGE_MIN_ROW_H: 8,
  FLOATING_RANGE_MAX_ROW_H: 500,
  // The rows as the backend lists them NOW: the host's index re-derived from its id.
  listFloatingRanges: vi.fn(async () => (b.indexOfId(b.m.hostId) >= 0 ? [rangeRow()] : [])),
  createFloatingRange: vi.fn(),
  updateFloatingRange: vi.fn(async () => ({})),
  renameFloatingRange: vi.fn(),
  deleteFloatingRange: vi.fn(async () => {}),
  updateFloatingRangeCell: (...args: unknown[]) => updateFloatingRangeCell(...args),
  getFloatingRangeCells: vi.fn(async (...args: unknown[]) => {
    const c = b.m.contents[`${args[1]},${args[2]}`];
    return c ? [c] : [];
  }),
}));

vi.mock("@api/lib", () => ({
  getActiveSheet: vi.fn(async () => b.list().activeIndex),
  getSheets: vi.fn(async () => b.list()),
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true })),
}));

vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => null,
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showToast: vi.fn(),
  showDialog: vi.fn(),
  showOverlay: vi.fn(),
  registerFloatingRangeProvider: () => () => {},
  ExtensionRegistry: { onSelectionChange: () => () => {} },
}));

// Core's own reads and switches (the point-mode switch, the return to the host)
// reach the same backend model.
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (cmd === "set_active_sheet") {
      b.m.switches.push(args?.index as number);
      return b.activate(args?.index as number);
    }
    if (cmd === "get_sheets") return b.list();
    return null;
  },
}));

import extension from "../index";
import { registerGridOverlay, getGridRegions, type OverlayRegistration } from "@api/gridOverlays";
import { AppEvents, emitAppEvent, onAppEvent } from "@api/events";
import { endExternalFormulaSession, isExternalSessionParked, switchSheetForPointMode } from "@api/externalEdit";
import { getFrActiveSheetIndex, FLOATING_RANGE_REGION_TYPE } from "../lib/floatingRangeStore";
import { getLocalSelection, setLocalSelection } from "../lib/frSelection";
import { openFrEditor, isFrEditorOpen, getFrEditorSession } from "../editor/frEditor";

function stubContext(): never {
  return {
    grid: { overlays: { register: (registration: OverlayRegistration) => registerGridOverlay(registration) } },
    ui: {
      menus: { registerItem: vi.fn(), unregisterItem: vi.fn() },
      overlays: { register: vi.fn(), unregister: vi.fn() },
      dialogs: { register: vi.fn(), unregister: vi.fn() },
    },
    events: { on: (name: string, cb: (detail: unknown) => void) => onAppEvent(name, cb) },
  } as never;
}

function textarea(): HTMLTextAreaElement {
  return document.querySelector("textarea[data-fr-editor]") as HTMLTextAreaElement;
}

function typeInto(value: string): void {
  const el = textarea();
  el.value = value;
  el.setSelectionRange(value.length, value.length);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Every queued re-sync and every Core IPC answered (microtasks, then a macrotask turn, twice). */
async function settle(): Promise<void> {
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function publishesTheRange(): boolean {
  return getGridRegions().some((r) => r.type === FLOATING_RANGE_REGION_TYPE);
}

/** The writes the edit made: [frId, row, col, value] each. */
function writes(): unknown[][] {
  return updateFloatingRangeCell.mock.calls.map((call) => call.slice(0, 4));
}

/** "=SUM(" typed into cell A1 of the floating grid on Report; the grid shows Report. */
async function halfTypedOnReport(): Promise<void> {
  setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
  openFrEditor(FR_ID, 0, 0, null);
  typeInto("=SUM(");
  await settle();
  expect(getFrActiveSheetIndex(), "precondition: the range is published on Report").toBe(3);
}

/** The edit's state after a renumbering: OPEN, its text intact, nothing written. */
function expectEntryKept(text = "=SUM("): void {
  expect(writes(), "the renumbering COMMITTED the half-typed entry").toEqual([]);
  expect(isFrEditorOpen(), "the renumbering ended the edit").toBe(true);
  expect(getFrEditorSession()?.getText()).toBe(text);
}

let layer: HTMLElement;

beforeEach(async () => {
  b.m.sheets = [
    { id: "id-sales", name: "Sales" },
    { id: "id-drill", name: "Drill" },
    { id: "id-costs", name: "Costs" },
    { id: HOST_ID, name: "Report" },
    { id: "id-extra", name: "Extra" },
  ];
  b.m.activeId = HOST_ID;
  b.m.hostId = HOST_ID;
  b.m.switches = [];
  b.m.contents = { "0,0": { row: 0, col: 0, formula: null, display: "" } };
  updateFloatingRangeCell.mockReset();
  updateFloatingRangeCell.mockResolvedValue([]);
  layer = document.createElement("div");
  layer.setAttribute("data-grid-canvas-layer", "");
  document.body.appendChild(layer);
  extension.activate(stubContext());
  await settle();
});

afterEach(() => {
  extension.deactivate?.();
  layer.remove();
});

describe("a renumbering under an OPEN floating-grid edit keeps the half-typed entry", () => {
  it("a temporary sheet's discard (`sheets` fanned out BEFORE `floatingRanges`)", async () => {
    await halfTypedOnReport();
    b.removeAt(1); // Drill goes: Report 3 -> 2, Extra slides into 3
    emitAppEvent(AppEvents.SHEET_CHANGED);
    emitAppEvent(AppEvents.FLOATING_RANGES_CHANGED);
    await settle();
    expectEntryKept();
    expect(getFrActiveSheetIndex(), "the range was not re-filtered to the host's new index").toBe(2);
    expect(publishesTheRange()).toBe(true);
    expect(getLocalSelection(), "a renumbering dropped the edited cell's selection").not.toBeNull();
  });

  it("an MCP delete (its cascade sorted: `floatingRanges` FIRST)", async () => {
    await halfTypedOnReport();
    b.removeAt(1);
    emitAppEvent(AppEvents.FLOATING_RANGES_CHANGED);
    emitAppEvent(AppEvents.SHEET_CHANGED);
    await settle();
    expectEntryKept();
    expect(getFrActiveSheetIndex()).toBe(2);
    expect(publishesTheRange()).toBe(true);
  });

  it("a script's api.deleteSheet: the SHEET_CHANGED naming the host's NEW index commits nothing -- not even before the re-sync", async () => {
    await halfTypedOnReport();
    b.removeAt(1);
    emitAppEvent(AppEvents.SHEET_CHANGED);
    emitAppEvent(AppEvents.FLOATING_RANGES_CHANGED);
    // announceSheetsChanged: the active sheet (Report) at its NEW index.
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 2, sheetName: "Report" });
    expect(writes(), "the index-carrying SHEET_CHANGED committed at once").toEqual([]);
    expect(isFrEditorOpen()).toBe(true);
    await settle();
    expectEntryKept();
    expect(getFrActiveSheetIndex()).toBe(2);
  });

  it("a script's api.moveSheet (announceSheetsChanged ALONE -- a move refreshes no floating range): the re-sync itself follows the host", async () => {
    await halfTypedOnReport();
    b.move(1, 4); // Drill to the end: Report 3 -> 2
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 2, sheetName: "Report" });
    await settle();
    expectEntryKept();
    expect(getFrActiveSheetIndex(), "the range was left filtered on the host's old index").toBe(2);
    expect(publishesTheRange()).toBe(true);
  });

  it("no edit open: a renumbering keeps the selected floating cell (a switch away is what drops it)", async () => {
    setLocalSelection({ frId: FR_ID, anchorRow: 1, anchorCol: 1, endRow: 1, endCol: 1 });
    await settle();
    b.removeAt(1);
    emitAppEvent(AppEvents.SHEET_CHANGED);
    emitAppEvent(AppEvents.FLOATING_RANGES_CHANGED);
    await settle();
    expect(getLocalSelection(), "a renumbering dropped the selected floating cell").toMatchObject({
      frId: FR_ID,
      anchorRow: 1,
      anchorCol: 1,
    });
    expect(getFrActiveSheetIndex()).toBe(2);
  });

  it("the entry survives to be finished: Enter then writes it ONCE, into the range", async () => {
    await halfTypedOnReport();
    b.removeAt(1);
    emitAppEvent(AppEvents.SHEET_CHANGED);
    emitAppEvent(AppEvents.FLOATING_RANGES_CHANGED);
    await settle();
    typeInto("=SUM(Sales!A1)");
    textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    expect(writes()).toEqual([[FR_ID, 0, 0, "=SUM(Sales!A1)"]]);
    expect(isFrEditorOpen()).toBe(false);
  });
});

describe("a renumbering under a PARKED floating-grid edit (a formula picking on another sheet)", () => {
  it("the HOST renumbered while parked on Sales: nothing committed, the host followed, and Enter returns to its NEW index", async () => {
    await halfTypedOnReport();
    await switchSheetForPointMode(0, vi.fn()); // parked on Sales
    expect(isExternalSessionParked()).toBe(true);
    b.removeAt(1); // Report 3 -> 2; Sales stays 0 and active
    emitAppEvent(AppEvents.SHEET_CHANGED);
    emitAppEvent(AppEvents.FLOATING_RANGES_CHANGED);
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 0, sheetName: "Sales" });
    await settle();
    expectEntryKept();
    expect(isExternalSessionParked(), "the renumbering ended the park").toBe(true);
    expect(getFrActiveSheetIndex(), "the host was not followed to its new index (the FRESH row)").toBe(2);

    // The user finishes the formula and presses Enter in the formula bar.
    getFrEditorSession()!.setText("=SUM(Sales!A1)", 14);
    b.m.switches = [];
    expect(await endExternalFormulaSession("commit", null, vi.fn())).toBe(true);
    await settle();
    expect(b.m.switches, "the return went to the host's OLD index (now Extra)").toEqual([2]);
    expect(writes()).toEqual([[FR_ID, 0, 0, "=SUM(Sales!A1)"]]);
  });

  it("the VIEWED sheet renumbered while parked (the old index test committed exactly here)", async () => {
    await halfTypedOnReport();
    await switchSheetForPointMode(4, vi.fn()); // parked on Extra
    expect(isExternalSessionParked()).toBe(true);
    b.removeAt(1); // Report 3 -> 2, Extra 4 -> 3 (still active)
    // announceSheetsChanged names the ACTIVE sheet -- the viewed one -- at its new index.
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 3, sheetName: "Extra" });
    emitAppEvent(AppEvents.SHEET_CHANGED);
    emitAppEvent(AppEvents.FLOATING_RANGES_CHANGED);
    await settle();
    expectEntryKept();
    expect(isExternalSessionParked()).toBe(true);
    expect(getFrActiveSheetIndex()).toBe(2);
  });

  it("a script's api.moveSheet while parked (SHEET_CHANGED alone, naming the VIEWED sheet): the host is followed by the re-sync itself", async () => {
    await halfTypedOnReport();
    await switchSheetForPointMode(0, vi.fn()); // parked on Sales
    b.move(1, 4); // Drill to the end: Report 3 -> 2; Sales stays 0
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 0, sheetName: "Sales" });
    await settle();
    expectEntryKept();
    expect(isExternalSessionParked()).toBe(true);
    expect(getFrActiveSheetIndex(), "the parked edit's host was left on its old index").toBe(2);
  });

  it("the rows refreshed ALONE while parked after a renumbering (FLOATING_RANGES_CHANGED, an undo of a range edit): the host is taken from the fresh row", async () => {
    await halfTypedOnReport();
    await switchSheetForPointMode(0, vi.fn()); // parked on Sales
    b.removeAt(1); // Report 3 -> 2
    emitAppEvent(AppEvents.FLOATING_RANGES_CHANGED);
    await settle();
    expectEntryKept();
    expect(getFrActiveSheetIndex(), "the reload kept the host's old index under the parked edit").toBe(2);
  });

  it("a door that switches regardless while parked (a script's activateSheet) commits nothing either", async () => {
    await halfTypedOnReport();
    await switchSheetForPointMode(0, vi.fn()); // parked on Sales
    b.activate(2); // the script activates Costs
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 2, sheetName: "Costs" });
    await settle();
    expectEntryKept();
    expect(getFrActiveSheetIndex(), "the host's ranges were re-filtered away under the parked edit").toBe(3);
  });
});

describe("a genuine switch AWAY from the host still commits", () => {
  it("sheet:beforeSwitch (a tab click, the Name Box) commits at once", () => {
    openFrEditor(FR_ID, 0, 0, null);
    typeInto("7");
    window.dispatchEvent(new CustomEvent("sheet:beforeSwitch", { detail: { oldSheetIndex: 3, newSheetIndex: 0 } }));
    expect(writes()).toEqual([[FR_ID, 0, 0, "7"]]);
    expect(isFrEditorOpen()).toBe(false);
  });

  it("a script's activateSheet (SHEET_CHANGED alone): the entry is COMMITTED once the rows are re-read -- never cancelled", async () => {
    await halfTypedOnReport();
    typeInto("7");
    b.activate(0); // Sales
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 0, sheetName: "Sales" });
    await settle();
    expect(writes(), "a genuine switch away from the host did not commit").toEqual([[FR_ID, 0, 0, "7"]]);
    expect(isFrEditorOpen()).toBe(false);
    expect(getFrActiveSheetIndex()).toBe(0);
    expect(getLocalSelection(), "the switch away kept the host's cell selected").toBeNull();
  });

  it("a script's activateSheet with '=SUM(' still EXPECTING a reference: the re-sync's own commit ends it (the lost-selection rule stands down while a formula picks)", async () => {
    await halfTypedOnReport();
    b.activate(0); // Sales
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 0, sheetName: "Sales" });
    await settle();
    expect(writes(), "a switch away left the half-typed formula open over another sheet").toEqual([[FR_ID, 0, 0, "=SUM("]]);
    expect(isFrEditorOpen()).toBe(false);
    expect(isExternalSessionParked()).toBe(false);
  });

  it("a renumbering AND a switch away in one go (an earlier sheet deleted, another activated): the switch still commits, once", async () => {
    await halfTypedOnReport();
    typeInto("8");
    b.removeAt(1); // Report 3 -> 2
    b.activate(1); // Costs, now sheet 1
    emitAppEvent(AppEvents.SHEET_CHANGED);
    emitAppEvent(AppEvents.FLOATING_RANGES_CHANGED);
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 1, sheetName: "Costs" });
    await settle();
    expect(writes()).toEqual([[FR_ID, 0, 0, "8"]]);
    expect(isFrEditorOpen()).toBe(false);
    expect(getFrActiveSheetIndex()).toBe(1);
  });
});
