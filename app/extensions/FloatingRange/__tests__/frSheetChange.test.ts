//! FILENAME: app/extensions/FloatingRange/__tests__/frSheetChange.test.ts
// PURPOSE: The floating-range extension's EDIT / SELECTION / SHEET-CHANGE
//          wiring (index.ts), activated for real against a stub context:
//          - a GENUINE sheet switch commits an open edit at once (never a
//            cancel: a plain value left by a tab click is Excel's commit),
//            while a detail-less structural SHEET_CHANGED on the same sheet
//            touches nothing;
//          - PARKED (a formula picking a reference on another sheet): the
//            backend's active sheet is the viewed one BY DESIGN, so neither a
//            structural SHEET_CHANGED nor a backend reload may re-filter the
//            host's ranges away, and the grid-selection listener keeps
//            everything;
//          - the selection doors the formula bar depends on: drag-extend
//            announces the range, another object's press drops only the CELL
//            selection, `sheet:beforeSwitch` commits and withdraws at once;
//          - the right-click menu stays shut while the grid shows another
//            sheet; deleting a range being edited discards the edit;
//          - the bar's content follows writes (CELLS_UPDATED, grid:refresh);
//          - the Name Box resolver lives exactly as long as the extension.
// CONTEXT: Owner findings #9/#10 (2026-09-27), fr-edit-design.md §3.4.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FloatingRangeInfo } from "@api/floatingRanges";

const FR_ID = "fr-sheet";
const HOST = 2;

const INFO = {
  id: FR_ID,
  backingSheetId: "backing",
  hostSheetId: "host",
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
  backingSheetIndex: 3,
  hostSheetIndex: HOST,
} as FloatingRangeInfo;

const h = vi.hoisted(() => ({
  backendActive: 2,
  ranges: [] as unknown[],
  contents: {} as Record<string, { row: number; col: number; formula?: string | null; display?: string }>,
  selectionListener: null as ((sel: unknown) => void) | null,
  provider: null as null | { delete: (id: string) => Promise<void> },
  /** A getActiveSheet answer the test releases by hand (consumed once). */
  activeHold: null as null | Promise<number>,
  /** The items the extension registered in the main menus. */
  menuItems: [] as { id: string; action: () => void }[],
  /** What Core's grid-state snapshot answers (null = no grid mounted). */
  gridState: null as null | { surface?: string },
  /** The listeners the extension gave Core's after-press announcement. */
  pressListeners: new Set<(press: { row: number; col: number; button: number; shiftKey: boolean; ctrlKey: boolean }) => void>(),
}));

// Core's AFTER-press announcement: its `notifyGridCellPressed` is Core-only (an
// extension listens, never presses), so the test holds the listeners the
// extension registered and plays Core's part.
vi.mock("@api/cellClickInterceptors", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@api/cellClickInterceptors")>();
  return {
    ...orig,
    onGridCellPressed: (listener: Parameters<typeof orig.onGridCellPressed>[0]) => {
      h.pressListeners.add(listener);
      const off = orig.onGridCellPressed(listener);
      return () => {
        h.pressListeners.delete(listener);
        off();
      };
    },
  };
});

/** Core announces a handled press on grid cell (row, col). */
function corePress(row: number, col: number): void {
  for (const listener of [...h.pressListeners]) listener({ row, col, button: 0, shiftKey: false, ctrlKey: false });
}

vi.mock("@api/grid", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/grid")>()),
  getGridStateSnapshot: () => h.gridState,
}));

const updateFloatingRangeCell = vi.fn(async (..._args: unknown[]): Promise<number[]> => []);
const getFloatingRangeCells = vi.fn(async (...args: unknown[]) => {
  const c = h.contents[`${args[1]},${args[2]}`];
  return c ? [c] : [];
});
const deleteFloatingRange = vi.fn(async (_id: string) => {});
vi.mock("@api/floatingRanges", () => ({
  FLOATING_RANGE_MAX_ROWS: 1000,
  FLOATING_RANGE_MAX_COLS: 256,
  FLOATING_RANGE_MIN_COL_W: 8,
  FLOATING_RANGE_MAX_COL_W: 1000,
  FLOATING_RANGE_MIN_ROW_H: 8,
  FLOATING_RANGE_MAX_ROW_H: 500,
  listFloatingRanges: vi.fn(async () => h.ranges),
  createFloatingRange: vi.fn(),
  updateFloatingRange: vi.fn(async () => ({})),
  renameFloatingRange: vi.fn(),
  deleteFloatingRange: (id: string) => deleteFloatingRange(id),
  updateFloatingRangeCell: (...args: unknown[]) => updateFloatingRangeCell(...args),
  getFloatingRangeCells: (...args: unknown[]) => getFloatingRangeCells(...args),
}));

vi.mock("@api/lib", () => ({
  getActiveSheet: vi.fn(async () => {
    const hold = h.activeHold;
    if (hold) {
      h.activeHold = null;
      return hold;
    }
    return h.backendActive;
  }),
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true })),
}));

const showOverlay = vi.fn();
vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  showToast: vi.fn(),
  showDialog: vi.fn(),
  showOverlay: (...args: unknown[]) => showOverlay(...args),
  registerFloatingRangeProvider: (p: { delete: (id: string) => Promise<void> }) => {
    h.provider = p;
    return () => {
      h.provider = null;
    };
  },
  ExtensionRegistry: {
    onSelectionChange: (cb: (sel: unknown) => void) => {
      h.selectionListener = cb;
      return () => {
        h.selectionListener = null;
      };
    },
  },
}));

// The frame sits at the canvas origin; client coordinates ARE canvas ones.
vi.mock("../lib/frCanvasGeometry", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/frCanvasGeometry")>();
  return {
    ...orig,
    clientToCanvas: (x: number, y: number) => ({ x, y }),
    frameCanvasBounds: () => ({ x: 0, y: 0, width: 400, height: 300 }),
    frameAtCanvasPoint: (x: number, y: number) => {
      const store = h.ranges.length ? (h.ranges[0] as { id: string }) : null;
      if (!store || x < 0 || y < 0 || x > 400 || y > 300) return null;
      return { id: store.id } as never;
    },
  };
});

// The point-mode switch reaches the backend's `set_active_sheet`.
const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (cmd === "set_active_sheet") {
      const index = args?.index as number;
      return {
        sheets: [
          { index: 0, name: "Sheet1", kind: "worksheet" },
          { index: 2, name: "Canvas1", kind: "canvas" },
        ],
        activeIndex: index,
      };
    }
    return null;
  }),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "set_active_sheet") h.backendActive = args?.index as number;
    return tauri.invoke(cmd, args);
  },
}));

import extension, { claimsBodyDrag } from "../index";
import { checkCellClickInterceptors } from "@api/cellClickInterceptors";
import { registerLayoutSurfaceProvider } from "@api/layoutSurface";
import { createFloatingRange } from "@api/floatingRanges";
import { showToast } from "@api";
import { AppEvents, emitAppEvent, onAppEvent } from "@api/events";
import { getGridRegions } from "@api/gridOverlays";
import {
  endExternalFormulaSession,
  getExternalCellTarget,
  isExternalSessionParked,
  resolveExternalAddress,
  switchSheetForPointMode,
} from "@api/externalEdit";
import {
  getFloatingRangeById,
  getFrActiveSheetIndex,
  upsertFromInfo,
  FLOATING_RANGE_REGION_TYPE,
} from "../lib/floatingRangeStore";
import {
  getLocalSelection,
  setLocalSelection,
  selectFloatingRange,
  isFloatingRangeSelected,
  onLocalSelectionChanged,
} from "../lib/frSelection";
import { openFrEditor, isFrEditorOpen, getFrEditorSession } from "../editor/frEditor";
import { FR_TITLE_H, FR_COL_HDR_H, FR_ROW_HDR_W, FR_DEFAULT_COL_W, FR_DEFAULT_ROW_H } from "../lib/frDimensions";

function stubContext(): never {
  return {
    grid: { overlays: { register: () => () => {} } },
    ui: {
      menus: {
        registerItem: (_menu: string, item: { id: string; action: () => void }) => {
          h.menuItems.push(item);
        },
        unregisterItem: vi.fn(),
      },
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

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function selectA1(): void {
  setLocalSelection({ frId: FR_ID, anchorRow: 0, anchorCol: 0, endRow: 0, endCol: 0 });
}

/** Canvas point at the centre of local cell (row, col) -- frame at the origin. */
function cellPoint(row: number, col: number): { x: number; y: number } {
  return {
    x: FR_ROW_HDR_W + col * FR_DEFAULT_COL_W + FR_DEFAULT_COL_W / 2,
    y: FR_TITLE_H + FR_COL_HDR_H + row * FR_DEFAULT_ROW_H + FR_DEFAULT_ROW_H / 2,
  };
}

let layer: HTMLElement;

beforeEach(async () => {
  h.backendActive = HOST;
  h.activeHold = null;
  h.menuItems = [];
  h.gridState = null;
  h.ranges = [INFO];
  h.contents = {
    "0,0": { row: 0, col: 0, formula: "=1", display: "1" },
  };
  updateFloatingRangeCell.mockReset();
  updateFloatingRangeCell.mockResolvedValue([]);
  getFloatingRangeCells.mockClear();
  deleteFloatingRange.mockClear();
  showOverlay.mockClear();
  tauri.invoke.mockClear();
  layer = document.createElement("div");
  layer.setAttribute("data-grid-canvas-layer", "");
  document.body.appendChild(layer);
  extension.activate(stubContext());
  await flush();
});

afterEach(() => {
  extension.deactivate();
  layer.remove();
});

describe("activation", () => {
  it("publishes the host's range, the selected cell, and the Name Box resolver", async () => {
    expect(getFrActiveSheetIndex()).toBe(HOST);
    expect(getGridRegions().some((r) => r.type === FLOATING_RANGE_REGION_TYPE)).toBe(true);
    selectA1();
    await flush();
    expect(getExternalCellTarget()).toMatchObject({ address: "Float1!A1", content: "=1" });
    expect(resolveExternalAddress("Float1!B2")?.hostSheetIndex).toBe(HOST);
  });

  it("deactivation withdraws the cell and the resolver", async () => {
    selectA1();
    await flush();
    extension.deactivate();
    expect(getExternalCellTarget()).toBeNull();
    expect(resolveExternalAddress("Float1!B2")).toBeNull();
    extension.activate(stubContext());
    await flush();
  });
});

describe("SHEET_CHANGED keeps the 'did the sheet change' condition", () => {
  it("(a) a GENUINE switch commits a plain value synchronously -- never a cancel", () => {
    openFrEditor(FR_ID, 0, 0, null);
    typeInto("7");
    h.backendActive = 0;
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 0, sheetName: "Sheet1" });
    // Before any await: the commit is deterministic, not a race.
    expect(updateFloatingRangeCell).toHaveBeenCalledWith(FR_ID, 0, 0, "7");
    expect(isFrEditorOpen()).toBe(false);
  });

  it("(b) a detail-less structural SHEET_CHANGED on the SAME sheet commits nothing", async () => {
    openFrEditor(FR_ID, 0, 0, null);
    typeInto("=SUM(");
    emitAppEvent(AppEvents.SHEET_CHANGED);
    await flush();
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
    expect(isFrEditorOpen()).toBe(true);
    expect(getFrActiveSheetIndex()).toBe(HOST);
  });

  it("(c) PARKED: a detail-less SHEET_CHANGED reads the viewed sheet -- commit nothing, keep the host", async () => {
    selectA1();
    openFrEditor(FR_ID, 0, 0, null);
    typeInto("=");
    await switchSheetForPointMode(0, vi.fn());
    expect(isExternalSessionParked()).toBe(true);
    emitAppEvent(AppEvents.SHEET_CHANGED);
    await flush();
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
    expect(isFrEditorOpen()).toBe(true);
    expect(getFrActiveSheetIndex()).toBe(HOST);
    expect(getLocalSelection()).not.toBeNull();
  });

  it("PARKED: a SHEET_CHANGED naming the VIEWED sheet is no switch either", async () => {
    openFrEditor(FR_ID, 0, 0, null);
    typeInto("=");
    await switchSheetForPointMode(0, vi.fn());
    emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 0, sheetName: "Sheet1" });
    await flush();
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
    expect(isFrEditorOpen()).toBe(true);
  });

  it("(h) sheet:beforeSwitch commits at once and withdraws the selected cell", async () => {
    selectA1();
    await flush();
    openFrEditor(FR_ID, 0, 0, null);
    typeInto("9");
    window.dispatchEvent(new CustomEvent("sheet:beforeSwitch", { detail: { oldSheetIndex: HOST, newSheetIndex: 0 } }));
    expect(updateFloatingRangeCell).toHaveBeenCalledWith(FR_ID, 0, 0, "9");
    expect(getLocalSelection()).toBeNull();
    expect(getExternalCellTarget()).toBeNull();
  });
});

describe("(d) the grid-selection listener", () => {
  it("PARKED: a grid-selection change keeps the edit, the object and the cell", async () => {
    selectFloatingRange(FR_ID);
    selectA1();
    openFrEditor(FR_ID, 0, 0, "5"); // complete: only the park protects it
    await switchSheetForPointMode(0, vi.fn());
    h.selectionListener!({ startRow: 4, startCol: 4, endRow: 4, endCol: 4, type: "cells" });
    await flush();
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
    expect(isFrEditorOpen()).toBe(true);
    expect(getLocalSelection()).not.toBeNull();
    expect(isFloatingRangeSelected(FR_ID)).toBe(true);
  });

  it("a NULL selection (a canvas surface) is not a grid click: nothing is dropped", () => {
    selectFloatingRange(FR_ID);
    selectA1();
    h.selectionListener!(null);
    expect(getLocalSelection()).not.toBeNull();
    expect(isFloatingRangeSelected(FR_ID)).toBe(true);
  });

  it("a GENUINE grid click commits the edit and drops both selections", async () => {
    selectFloatingRange(FR_ID);
    selectA1();
    openFrEditor(FR_ID, 0, 0, "6");
    h.selectionListener!({ startRow: 4, startCol: 4, endRow: 4, endCol: 4, type: "cells" });
    expect(updateFloatingRangeCell).toHaveBeenCalledWith(FR_ID, 0, 0, "6");
    expect(getLocalSelection()).toBeNull();
    expect(isFloatingRangeSelected(FR_ID)).toBe(false);
  });
});

describe("(e) a backend reload while parked", () => {
  it("keeps the HOST sheet (the backend's active sheet is the viewed one)", async () => {
    openFrEditor(FR_ID, 0, 0, null);
    typeInto("=");
    await switchSheetForPointMode(0, vi.fn());
    emitAppEvent(AppEvents.FLOATING_RANGES_CHANGED);
    await flush();
    expect(getFrActiveSheetIndex()).toBe(HOST);
    expect(getGridRegions().some((r) => r.type === FLOATING_RANGE_REGION_TYPE)).toBe(true);
    expect(isFrEditorOpen()).toBe(true);
  });

  it("an edit of a range the reload removed is DISCARDED, returning to its sheet first", async () => {
    openFrEditor(FR_ID, 0, 0, null);
    typeInto("=");
    await switchSheetForPointMode(0, vi.fn());
    h.ranges = [];
    tauri.invoke.mockClear();
    emitAppEvent(AppEvents.FLOATING_RANGES_CHANGED);
    await flush();
    expect(tauri.invoke).toHaveBeenCalledWith("set_active_sheet", { index: HOST });
    expect(isFrEditorOpen()).toBe(false);
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
  });
});

describe("selection doors the formula bar depends on", () => {
  it("(f) drag-extend announces the range through the selection's own door", async () => {
    // The published address alone cannot tell: every overlay redraw also
    // republishes (requestOverlayRedraw fires the region-change listeners), so
    // an in-place write followed by a redraw still LOOKS right. The contract
    // is that the change is ANNOUNCED -- the edit-lifetime rule listens there.
    const heard = vi.fn();
    const off = onLocalSelectionChanged(heard);
    const start = cellPoint(0, 0);
    window.dispatchEvent(
      new CustomEvent("floatingObject:bodyDragStart", {
        detail: {
          regionType: FLOATING_RANGE_REGION_TYPE,
          data: { frId: FR_ID },
          canvasX: start.x,
          canvasY: start.y,
        },
      }),
    );
    await flush();
    expect(getExternalCellTarget()?.address).toBe("Float1!A1");
    heard.mockClear();
    const before = getLocalSelection();
    const to = cellPoint(1, 1);
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: to.x, clientY: to.y }));
    try {
      expect(heard).toHaveBeenCalledTimes(1);
      expect(getExternalCellTarget()?.address).toBe("Float1!A1:B2");
      // Replaced, never mutated: a snapshot held before the drag is intact.
      expect(before).toMatchObject({ endRow: 0, endCol: 0 });
    } finally {
      window.dispatchEvent(new MouseEvent("mouseup"));
      off();
    }
  });

  it("(g) another object's press drops the CELL selection, not the object selection", () => {
    selectFloatingRange(FR_ID);
    selectA1();
    window.dispatchEvent(
      new CustomEvent("floatingObject:selected", { detail: { regionType: "chart", data: { chartId: 1 } } }),
    );
    expect(getLocalSelection()).toBeNull();
    expect(isFloatingRangeSelected(FR_ID)).toBe(true);
  });

  it("another object's press COMMITS a bar-hosted edit of the cell", async () => {
    selectA1();
    await flush();
    getExternalCellTarget()!.beginEdit("12");
    window.dispatchEvent(
      new CustomEvent("floatingObject:selected", { detail: { regionType: "chart", data: { chartId: 1 } } }),
    );
    expect(updateFloatingRangeCell).toHaveBeenCalledWith(FR_ID, 0, 0, "12");
    expect(isFrEditorOpen()).toBe(false);
  });
});

describe("(i) the right-click menu while the grid shows another sheet", () => {
  function rightClickOnFrame(): void {
    const inner = document.createElement("div");
    layer.appendChild(inner);
    const p = cellPoint(0, 0);
    inner.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y }),
    );
    inner.remove();
  }

  it("opens on the host (positive control)", () => {
    rightClickOnFrame();
    expect(showOverlay).toHaveBeenCalledTimes(1);
  });

  it("stays shut while parked", async () => {
    openFrEditor(FR_ID, 0, 0, "=");
    await switchSheetForPointMode(0, vi.fn());
    rightClickOnFrame();
    expect(showOverlay).not.toHaveBeenCalled();
  });
});

describe("(j) deleting the range being edited", () => {
  it("discards the edit: nothing is written into a deleted range", async () => {
    selectA1();
    openFrEditor(FR_ID, 0, 0, null);
    typeInto("5");
    await h.provider!.delete(FR_ID);
    await flush();
    expect(deleteFloatingRange).toHaveBeenCalledWith(FR_ID);
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
    expect(isFrEditorOpen()).toBe(false);
    expect(getFrEditorSession()).toBeNull();
  });
});

describe("the bar's content follows writes", () => {
  it("CELLS_UPDATED (a cell commit) re-reads the selected cell", async () => {
    selectA1();
    await flush();
    h.contents["0,0"] = { row: 0, col: 0, formula: "=2", display: "2" };
    emitAppEvent(AppEvents.CELLS_UPDATED);
    await flush();
    expect(getExternalCellTarget()?.content).toBe("=2");
  });

  it("grid:refresh (a rename, a formula rewrite) re-reads it too", async () => {
    selectA1();
    await flush();
    h.contents["0,0"] = { row: 0, col: 0, formula: "=Renamed!A1", display: "0" };
    window.dispatchEvent(new CustomEvent("grid:refresh"));
    await flush();
    expect(getExternalCellTarget()?.content).toBe("=Renamed!A1");
  });

  it("a change on the range's BACKING sheet re-reads it", async () => {
    selectA1();
    await flush();
    h.contents["0,0"] = { row: 0, col: 0, formula: "=3", display: "3" };
    emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
      changes: [{ sheetIndex: getFloatingRangeById(FR_ID)!.backingSheetIndex, row: 0, col: 0 }],
    });
    await flush();
    expect(getExternalCellTarget()?.content).toBe("=3");
  });
});

// ============================================================================
// Review 2026-09-27 (FR findings 6, 9, 10, 11, 13)
// ============================================================================

const INFO2 = { ...INFO, id: "fr-two", name: "Float2", backingSheetIndex: 4 } as FloatingRangeInfo;

/** The press Core runs over a range: selected, then the claim, then (on a
 *  claim) bodyDragStart -- synchronously, in that order, in one mousedown. */
function pressLikeCore(frId: string, row: number, col: number): boolean {
  const p = cellPoint(row, col);
  const ctx = {
    region: {
      id: `fr-${frId}`,
      type: FLOATING_RANGE_REGION_TYPE,
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
      floating: { x: 0, y: 0, width: 400, height: 300 },
      data: { frId },
    },
    canvasX: p.x,
    canvasY: p.y,
    row: 0,
    col: 0,
    floatingCanvasBounds: { x: 0, y: 0, width: 400, height: 300 },
  } as never;
  const detail = { regionType: FLOATING_RANGE_REGION_TYPE, data: { frId }, canvasX: p.x, canvasY: p.y };
  window.dispatchEvent(new CustomEvent("floatingObject:selected", { detail }));
  const claimed = claimsBodyDrag(ctx);
  if (claimed) window.dispatchEvent(new CustomEvent("floatingObject:bodyDragStart", { detail }));
  window.dispatchEvent(new MouseEvent("mouseup"));
  return claimed;
}

describe("(6) a reference PICK on a floating cell feeds the edit -- it never commits it", () => {
  it("in-cell view, same range: '=SUM(' + a click on B1 stays open as '=SUM(Float1!B1'", async () => {
    selectA1();
    openFrEditor(FR_ID, 0, 0, null);
    typeInto("=SUM(");
    expect(pressLikeCore(FR_ID, 0, 1)).toBe(true);
    await flush();
    expect(isFrEditorOpen()).toBe(true);
    expect(getFrEditorSession()!.getText()).toBe("=SUM(Float1!B1");
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
    expect(getLocalSelection()).toMatchObject({ frId: FR_ID, anchorRow: 0, anchorCol: 0 });
  });

  it("bar view: the same pick lands at the bar's caret and the edit stays open", async () => {
    selectA1();
    await flush();
    const session = getExternalCellTarget()!.beginEdit("=SUM(")!;
    expect(session.getView()).toBe("bar");
    expect(pressLikeCore(FR_ID, 0, 1)).toBe(true);
    await flush();
    expect(isFrEditorOpen()).toBe(true);
    expect(session.getText()).toBe("=SUM(Float1!B1");
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
    expect(getLocalSelection()).toMatchObject({ frId: FR_ID, anchorRow: 0, anchorCol: 0 });
  });

  it("a pick in ANOTHER range: the edited cell keeps its selection and its edit", async () => {
    upsertFromInfo(INFO2);
    selectA1();
    openFrEditor(FR_ID, 0, 0, null);
    typeInto("=SUM(");
    expect(pressLikeCore("fr-two", 0, 1)).toBe(true);
    await flush();
    expect(getFrEditorSession()!.getText()).toBe("=SUM(Float2!B1");
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
    expect(getLocalSelection()).toMatchObject({ frId: FR_ID, anchorRow: 0, anchorCol: 0 });
  });

  it("control: a press with NO edit picking selects the pressed cell", async () => {
    selectA1();
    expect(pressLikeCore(FR_ID, 1, 1)).toBe(true);
    expect(getLocalSelection()).toMatchObject({ frId: FR_ID, anchorRow: 1, anchorCol: 1 });
  });
});

describe("(9) File > Open / New replaces the document under an open edit", () => {
  for (const evt of [AppEvents.AFTER_OPEN, AppEvents.AFTER_NEW]) {
    it(`${evt}, then its SHEET_CHANGED{0}: the OLD document's edit is discarded, never written into the new one`, async () => {
      selectA1();
      await flush();
      getExternalCellTarget()!.beginEdit("999");
      expect(getFrActiveSheetIndex()).toBe(HOST);
      // file-api: AFTER_OPEN, then announceBackendStateReplaced's SHEET_CHANGED
      // {sheetIndex: 0} -- both synchronous.
      emitAppEvent(evt);
      emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 0, sheetName: "Sheet1" });
      expect(updateFloatingRangeCell).not.toHaveBeenCalled();
      expect(isFrEditorOpen()).toBe(false);
      await flush();
      expect(updateFloatingRangeCell).not.toHaveBeenCalled();
    });
  }
});

describe("(10) a backend reload racing a point-mode tab click", () => {
  it("reads the park AFTER its getActiveSheet: the viewed sheet never replaces the host", async () => {
    selectA1();
    openFrEditor(FR_ID, 0, 0, null);
    typeInto("=");
    let answer: (index: number) => void = () => {};
    h.activeHold = new Promise<number>((resolve) => {
      answer = resolve;
    });
    // A floatingRanges refresh is in flight...
    emitAppEvent(AppEvents.FLOATING_RANGES_CHANGED);
    await flush();
    // ...when the tab click parks the edit on sheet 0; the backend, which
    // handled set_active_sheet first, answers the reload's read with 0.
    await switchSheetForPointMode(0, vi.fn());
    expect(isExternalSessionParked()).toBe(true);
    answer(0);
    await flush();
    expect(getFrActiveSheetIndex()).toBe(HOST);
    expect(getGridRegions().some((r) => r.type === FLOATING_RANGE_REGION_TYPE)).toBe(true);
    expect(isFrEditorOpen()).toBe(true);
  });
});

describe("(11) a press on Core's ALREADY-active grid cell (Core's click interceptors)", () => {
  it("ends the range's selection: the formula bar and the Name Box stop naming the floating cell", async () => {
    selectFloatingRange(FR_ID);
    selectA1();
    await flush();
    expect(getExternalCellTarget()?.address).toBe("Float1!A1");
    // Core's grid selection does not change, so the selection listener hears
    // nothing -- only the press itself can say the user left the range.
    const claimed = await checkCellClickInterceptors(0, 0, { clientX: 5, clientY: 5 });
    expect(claimed).toBe(false);
    expect(getLocalSelection()).toBeNull();
    expect(isFloatingRangeSelected(FR_ID)).toBe(false);
    expect(getExternalCellTarget()).toBeNull();
  });

  it("never on a CANVAS: its background press is the marquee's (Shift/Ctrl ADD to the selection)", async () => {
    h.gridState = { surface: "canvas" };
    selectFloatingRange(FR_ID);
    selectA1();
    await checkCellClickInterceptors(0, 0, { clientX: 5, clientY: 5, ctrlKey: true });
    expect(getLocalSelection()).not.toBeNull();
    expect(isFloatingRangeSelected(FR_ID)).toBe(true);
  });

  it("never while the range's edit PICKS a reference (the pick owns the press)", async () => {
    selectA1();
    openFrEditor(FR_ID, 0, 0, null);
    typeInto("=");
    await checkCellClickInterceptors(0, 0, { clientX: 5, clientY: 5 });
    expect(isFrEditorOpen()).toBe(true);
    expect(getLocalSelection()).not.toBeNull();
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
  });
});

describe("(11 variant) Core's AFTER-press announcement (onGridCellPressed)", () => {
  it("a BAR session live on Core's already-active cell: Core's commit-before-select writes it, then the press drops the range's selection", async () => {
    // Round-3 fix: the interceptors (above) stand down while an edit is live,
    // so this press used to commit the bar's edit and leave the floating cell
    // selected -- the formula bar went on targeting it.
    h.gridState = { surface: "grid" };
    selectFloatingRange(FR_ID);
    selectA1();
    await flush();
    const session = getExternalCellTarget()!.beginEdit()!;
    session.setText("5", 1);
    // What Core's pointer door does for a live session that expects no
    // reference: commit-before-select...
    await endExternalFormulaSession("commit", null);
    expect(updateFloatingRangeCell).toHaveBeenCalledWith(FR_ID, 0, 0, "5");
    // ...Core's selection is unchanged (listener 8 hears nothing), so until
    // the announcement the range still owns the cell.
    expect(getExternalCellTarget()?.address).toBe("Float1!A1");
    corePress(0, 0);
    expect(getLocalSelection()).toBeNull();
    expect(isFloatingRangeSelected(FR_ID)).toBe(false);
    expect(getExternalCellTarget()).toBeNull();
  });

  it("never on a CANVAS", async () => {
    h.gridState = { surface: "canvas" };
    selectFloatingRange(FR_ID);
    selectA1();
    corePress(0, 0);
    expect(getLocalSelection()).not.toBeNull();
    expect(isFloatingRangeSelected(FR_ID)).toBe(true);
  });

  it("never while the range's edit PICKS a reference", async () => {
    h.gridState = { surface: "grid" };
    selectA1();
    openFrEditor(FR_ID, 0, 0, null);
    typeInto("=");
    corePress(0, 0);
    expect(isFrEditorOpen()).toBe(true);
    expect(getLocalSelection()).not.toBeNull();
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
  });

  it("is withdrawn with the extension", () => {
    expect(h.pressListeners.size).toBe(1);
    extension.deactivate();
    expect(h.pressListeners.size).toBe(0);
    extension.activate(stubContext());
  });
});

describe("(13) sheet:beforeSwitch while the edit is PARKED", () => {
  it("writes nothing: the edit cannot be returned to its host from inside that listener", async () => {
    selectA1();
    openFrEditor(FR_ID, 0, 0, null);
    typeInto("=SUM(");
    await switchSheetForPointMode(0, vi.fn());
    expect(isExternalSessionParked()).toBe(true);
    window.dispatchEvent(
      new CustomEvent("sheet:beforeSwitch", { detail: { oldSheetIndex: 0, newSheetIndex: 1 } }),
    );
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
    expect(isFrEditorOpen()).toBe(true);
    expect(isExternalSessionParked()).toBe(true);
    expect(getLocalSelection()).not.toBeNull();
  });

  it("the Name Box is no door while parked: any address is refused where the grid stands", async () => {
    selectA1();
    openFrEditor(FR_ID, 0, 0, null);
    typeInto("=SUM(");
    await switchSheetForPointMode(0, vi.fn());
    const resolution = resolveExternalAddress("Sheet3!A1");
    expect(resolution).not.toBeNull();
    // The sheet on screen: the Name Box switches nothing before go().
    expect(resolution!.hostSheetIndex).toBe(0);
    await expect(resolution!.go()).resolves.toMatch(/Finish the formula/);
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
    expect(isFrEditorOpen()).toBe(true);
  });

  it("a bare DEFINED NAME (the Name Box list's pick) is claimed and refused the same way, parked or picking", async () => {
    // The list asks this resolver first (NameBox.goToExternalAddress), so a
    // name must be claimed too -- not only a sheet-qualified address.
    selectA1();
    openFrEditor(FR_ID, 0, 0, null);
    typeInto("=SUM(");
    const picking = resolveExternalAddress("Totals");
    expect(picking).not.toBeNull();
    await expect(picking!.go()).resolves.toMatch(/Finish the formula/);
    await switchSheetForPointMode(0, vi.fn());
    const parked = resolveExternalAddress("Totals");
    expect(parked?.hostSheetIndex).toBe(0);
    await expect(parked!.go()).resolves.toMatch(/Finish the formula/);
    expect(updateFloatingRangeCell).not.toHaveBeenCalled();
  });

  it("control: with no edit open a bare name is NOT claimed (the box's own name route answers)", () => {
    selectA1();
    expect(resolveExternalAddress("Totals")).toBeNull();
  });
});

describe("(2) Insert > Floating Range on a SUBSCRIBED canvas", () => {
  function insertItem(): { action: () => void } {
    const item = h.menuItems.find((i) => i.id === "insert.floatingRange");
    if (!item) throw new Error("the Insert menu item is not registered");
    return item;
  }

  it("is refused with a sentence and asks the backend nothing (the Canvas tab's Insert group is disabled there too)", async () => {
    const off = registerLayoutSurfaceProvider({
      get: (i) =>
        i === HOST ? { snapToGrid: false, gridSize: 16, showGrid: false, page: null, editable: false } : null,
    });
    try {
      vi.mocked(createFloatingRange).mockClear();
      vi.mocked(showToast).mockClear();
      insertItem().action();
      await flush();
      expect(createFloatingRange).not.toHaveBeenCalled();
      expect(showToast).toHaveBeenCalledTimes(1);
      expect(String(vi.mocked(showToast).mock.calls[0][0])).toMatch(/subscribed/);
    } finally {
      off();
    }
  });

  it("control: on an editable sheet the menu creates", async () => {
    vi.mocked(createFloatingRange).mockClear();
    vi.mocked(createFloatingRange).mockResolvedValueOnce({ ...INFO, id: "fr-new", name: "Float9" } as never);
    insertItem().action();
    await flush();
    expect(createFloatingRange).toHaveBeenCalledTimes(1);
  });
});
