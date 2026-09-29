//! FILENAME: app/extensions/FloatingRange/__tests__/frWholeSelectionDelete.test.ts
// PURPOSE: A canvas Delete of a MULTI-selection that includes a floating range
//          deletes the range TOO (E11, wave A needs 1-2): the range's
//          object-selection provider has `deleteObjects` (resolves when the
//          delete has landed, rejects on a decline or a refusal), and the
//          range's own Delete door hands a cross-family selection to the seam.
// CONTEXT: The keybinding dispatcher runs ONE winner per Delete. The range's
//          guarded Delete binding wins with the range selected, and it deleted
//          only the range (after a confirmation), leaving a chart beside it
//          standing; when another family's door won, the seam's whole-set
//          delete left the range standing and named it in a "not deleted"
//          toast, because the range had no `deleteObjects`. Driven with the
//          REAL extension, the REAL dispatcher and the REAL seam; a stand-in
//          chart family carries the second member.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FloatingRangeInfo } from "@api/floatingRanges";

const FR_ID = "fr-whole";
const HOST = 0;

const INFO = {
  id: FR_ID,
  backingSheetId: "backing",
  hostSheetId: "host",
  x: 0,
  y: 0,
  rotation: 0,
  pinToGrid: false,
  rowCount: 2,
  colCount: 2,
  colWidths: {},
  rowHeights: {},
  showTitle: true,
  showColumnHeaders: true,
  showRowHeaders: true,
  name: "Float1",
  backingSheetIndex: 1,
  hostSheetIndex: HOST,
} as FloatingRangeInfo;

let surface: "grid" | "canvas" = "canvas";
vi.mock("../../../src/core/state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/state/GridContext")>()),
  getGridStateSnapshot: () => ({ surface, sheetContext: { activeSheetIndex: HOST } }),
}));
vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => ({ surface, sheetContext: { activeSheetIndex: HOST }, viewport: { scrollX: 0, scrollY: 0 } }),
}));

const log: string[] = [];
vi.mock("../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: vi.fn(async (label: string) => {
    log.push(`begin:${label}`);
  }),
  commitUndoTransaction: vi.fn(async () => {
    log.push("commit");
  }),
}));

let refuseDelete: string | null = null;
const deleteFloatingRange = vi.fn(async (id: string) => {
  if (refuseDelete !== null) throw new Error(refuseDelete);
  log.push(`deleteFR:${id}`);
});
vi.mock("@api/floatingRanges", () => ({
  FLOATING_RANGE_MAX_ROWS: 1000,
  FLOATING_RANGE_MAX_COLS: 256,
  FLOATING_RANGE_MIN_COL_W: 8,
  FLOATING_RANGE_MAX_COL_W: 1000,
  FLOATING_RANGE_MIN_ROW_H: 8,
  FLOATING_RANGE_MAX_ROW_H: 500,
  listFloatingRanges: vi.fn(async () => [INFO]),
  createFloatingRange: vi.fn(),
  updateFloatingRange: vi.fn(async () => ({})),
  renameFloatingRange: vi.fn(),
  deleteFloatingRange: (id: string) => deleteFloatingRange(id),
  updateFloatingRangeCell: vi.fn(async () => []),
  getFloatingRangeCells: vi.fn(async () => []),
}));

vi.mock("@api/lib", () => ({
  getActiveSheet: vi.fn(async () => HOST),
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true })),
}));

let confirmAnswer = true;
const confirmAsync = vi.fn(async (..._args: unknown[]) => confirmAnswer);
vi.mock("@api/dialogs", () => ({
  confirmAsync: (...args: unknown[]) => confirmAsync(...args),
  promptAsync: vi.fn(async () => null),
  alertAsync: vi.fn(async () => {}),
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showDialog: vi.fn(),
  showOverlay: vi.fn(),
  ExtensionRegistry: { onSelectionChange: () => () => {} },
}));

import { initKeybindings } from "@api/keybindings";
import { onAppEvent } from "@api/events";
import { registerToastSink, type ToastPayload } from "@api/notifications";
import { getGridRegions, registerGridOverlay, replaceGridRegionsByType, type GridRegion } from "@api/gridOverlays";
import {
  registerObjectSelectionProvider,
  setObjectSelectionSet,
  getSelectedObjectRegions,
  type ObjectSelectionProvider,
} from "@api/objectSelection";
import extension, { deleteFrObjectsConfirmed } from "../index";
import { clearLocalSelection, selectFloatingRange, setLocalSelection } from "../lib/frSelection";
import { FLOATING_RANGE_REGION_TYPE, getFloatingRangeById } from "../lib/floatingRangeStore";

initKeybindings();

const toasts: ToastPayload[] = [];
registerToastSink((t) => toasts.push(t));

function stubContext(): never {
  return {
    grid: { overlays: { register: (reg: { type: string }) => registerGridOverlay(reg as never) } },
    ui: {
      menus: { registerItem: vi.fn(), unregisterItem: vi.fn() },
      overlays: { register: vi.fn(), unregister: vi.fn() },
      dialogs: { register: vi.fn(), unregister: vi.fn() },
    },
    events: { on: (name: string, cb: (detail: unknown) => void) => onAppEvent(name, cb) },
  } as never;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

/** A stand-in SINGLE-select chart family with a delete (the seam's contract). */
const CHART_TYPE = "test-chart";
const chartRegion: GridRegion = {
  id: "chart-c1",
  type: CHART_TYPE,
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: 400, y: 0, width: 100, height: 100 },
  data: { name: "Sales" },
};
let chartSelected = false;
const chartDeleted = vi.fn(async (regions: readonly GridRegion[]) => {
  log.push(`deleteChart:${regions.map((r) => r.id).join(",")}`);
  replaceGridRegionsByType(CHART_TYPE, []);
});
const chartProvider: ObjectSelectionProvider = {
  types: [CHART_TYPE],
  isSelected: () => chartSelected,
  select: () => {
    chartSelected = true;
  },
  deselectAll: () => {
    chartSelected = false;
  },
  ownsKey: () => false,
  labelOf: (r) => (r.data?.name as string) ?? null,
  deleteObjects: (regions) => chartDeleted(regions),
};

let container: HTMLDivElement;
const cleanups: (() => void)[] = [];

function frRegion(): GridRegion {
  const r = getGridRegions().find((g) => g.type === FLOATING_RANGE_REGION_TYPE);
  if (!r) throw new Error("the floating range published no region");
  return r;
}

function press(key: string): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
}

beforeEach(async () => {
  surface = "canvas";
  log.length = 0;
  toasts.length = 0;
  refuseDelete = null;
  confirmAnswer = true;
  chartSelected = false;
  confirmAsync.mockClear();
  deleteFloatingRange.mockClear();
  chartDeleted.mockClear();
  cleanups.push(registerGridOverlay({ type: CHART_TYPE, render: () => {}, hitTest: () => false } as never));
  cleanups.push(registerObjectSelectionProvider(chartProvider));
  container = document.createElement("div");
  container.setAttribute("data-focus-container", "spreadsheet");
  container.tabIndex = 0;
  document.body.appendChild(container);
  extension.activate(stubContext());
  await flush();
  replaceGridRegionsByType(CHART_TYPE, [chartRegion]);
  container.focus();
});

afterEach(() => {
  extension.deactivate();
  replaceGridRegionsByType(CHART_TYPE, []);
  while (cleanups.length > 0) cleanups.pop()!();
  container.remove();
});

describe("the range's object-selection provider deletes (E11)", () => {
  it("Delete on a canvas selection of the range AND a chart deletes BOTH, as one undo step", async () => {
    selectFloatingRange(FR_ID);
    setObjectSelectionSet([frRegion(), chartRegion]);
    expect(getSelectedObjectRegions().map((r) => r.id).sort()).toEqual([frRegion().id, chartRegion.id].sort());

    const e = press("Delete");
    await flush();
    await flush();

    expect(e.defaultPrevented).toBe(true);
    expect(chartDeleted).toHaveBeenCalledTimes(1);
    expect(deleteFloatingRange).toHaveBeenCalledWith(FR_ID);
    expect(getFloatingRangeById(FR_ID)).toBeNull();
    // One confirmation (a range's delete ends the undo history), one step.
    expect(confirmAsync).toHaveBeenCalledTimes(1);
    expect(log[0]).toBe("begin:Delete Objects");
    expect(log[log.length - 1]).toBe("commit");
    expect(log.filter((l) => l.startsWith("begin:"))).toHaveLength(1);
    // Nothing was left standing, so nothing was named.
    expect(toasts.map((t) => t.message)).toEqual([]);
  });

  it("declining the confirmation keeps the range (the chart still goes) and names it once", async () => {
    confirmAnswer = false;
    selectFloatingRange(FR_ID);
    setObjectSelectionSet([frRegion(), chartRegion]);
    press("Delete");
    await flush();
    await flush();
    expect(chartDeleted).toHaveBeenCalledTimes(1);
    expect(deleteFloatingRange).not.toHaveBeenCalled();
    expect(getFloatingRangeById(FR_ID)).not.toBeNull();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toMatch(/not deleted \(Float1\)/);
    expect(toasts[0].message).toMatch(/cancelled/);
  });

  it("positive control: with an inner CELL selection, Delete clears the range's cells and hands nothing over", async () => {
    selectFloatingRange(FR_ID);
    setObjectSelectionSet([frRegion(), chartRegion]);
    setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
    press("Delete");
    await flush();
    expect(chartDeleted).not.toHaveBeenCalled();
    expect(deleteFloatingRange).not.toHaveBeenCalled();
    clearLocalSelection();
  });

  it("positive control: on a WORKSHEET the range's own Delete deletes the range alone", async () => {
    surface = "grid";
    selectFloatingRange(FR_ID);
    setObjectSelectionSet([frRegion(), chartRegion]);
    press("Delete");
    await flush();
    await flush();
    expect(chartDeleted).not.toHaveBeenCalled();
    expect(confirmAsync).toHaveBeenCalledTimes(1);
    expect(deleteFloatingRange).toHaveBeenCalledWith(FR_ID);
    expect(log.filter((l) => l.startsWith("begin:"))).toEqual([]);
  });
});

describe("deleteFrObjectsConfirmed (the provider's delete)", () => {
  it("resolves only after the delete has landed", async () => {
    await deleteFrObjectsConfirmed([FR_ID]);
    expect(deleteFloatingRange).toHaveBeenCalledTimes(1);
    expect(getFloatingRangeById(FR_ID)).toBeNull();
  });

  it("rejects on a decline, deleting nothing", async () => {
    confirmAnswer = false;
    await expect(deleteFrObjectsConfirmed([FR_ID])).rejects.toThrow(/cancelled/);
    expect(deleteFloatingRange).not.toHaveBeenCalled();
    expect(getFloatingRangeById(FR_ID)).not.toBeNull();
  });

  it("rejects with the backend's reason on a refusal, and the range stays", async () => {
    refuseDelete = "Sheet is protected: delete objects is not allowed.";
    await expect(deleteFrObjectsConfirmed([FR_ID])).rejects.toThrow(/Sheet is protected/);
    expect(getFloatingRangeById(FR_ID)).not.toBeNull();
  });
});
