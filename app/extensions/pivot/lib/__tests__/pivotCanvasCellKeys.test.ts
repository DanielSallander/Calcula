//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotCanvasCellKeys.test.ts
// PURPOSE: D-CELLS S6 -- the keyboard of a canvas pivot box's selected CELLS,
//          through the REAL keybinding dispatcher (initKeybindings: its
//          window-capture listener and the built-ins) and the REAL object
//          seam, with the canvas's own keys (Tab / Escape, nudge, Delete,
//          object clipboard) and the generic object Delete installed after the
//          pivot's, in the order extensions/manifest.ts activates them.
//            - the guard truth table (canvas / worksheet, focus, cells, the
//              selected box, an open box menu, a held press, an external edit);
//            - arrows move / Shift+arrows extend, hidden rows skipped, edges
//              clamp, the body scrolls to keep the cell in sight;
//            - Escape clears the cells, and the SECOND Escape is the canvas's
//              (it deselects the box);
//            - Ctrl+A selects the whole content;
//            - the edit keys REFUSE, and Delete never deletes the PivotTable --
//              `objectDeleteApplies()` is false while cells are selected (the
//              DELETE HAZARD);
//            - the canvas's nudge stands down, its Tab cycling does not;
//            - the provider's ownsKey rows and `innerClipboardCommand`;
//            - Copy (S7b): Ctrl+C / Ctrl+Insert and the Copy door copy the
//              selected block of the HIDDEN GRID (anchor offset, block-1 pivot,
//              the box's hidden rows left out, batched, capped), every refusal
//              is told, a DOM text selection wins, the canvas's object copy
//              stands down.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CellRangeCopyRequest, CellRangeCopyResult } from "@api/cellClipboard";

// Core's copy primitive is doubled: what the pivot ASKS it to copy is the
// subject here (copyCellRange's own reading is proved by its own tests).
const copyCellRangeMock = vi.hoisted(() =>
  vi.fn(async (_req: CellRangeCopyRequest): Promise<CellRangeCopyResult> => ({ copied: true, rows: 1, cols: 1 })),
);
vi.mock("@api/cellClipboard", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  copyCellRange: (req: CellRangeCopyRequest) => copyCellRangeMock(req),
}));

let surface: "canvas" | "grid" = "canvas";
vi.mock("../../../../src/core/state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/core/state/GridContext")>()),
  getGridStateSnapshot: () => ({
    surface,
    sheetContext: { activeSheetIndex: 0 },
    selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0, type: "cells" },
  }),
}));

vi.mock("@api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api")>()),
  openTaskPane: vi.fn(),
  closeTaskPane: vi.fn(),
  getTaskPaneManuallyClosed: () => [],
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
  emitAppEvent: vi.fn(),
}));

vi.mock("../../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: vi.fn(async () => {}),
  commitUndoTransaction: vi.fn(async () => {}),
}));

vi.mock("@api/pivot", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pivot: { getAtCell: vi.fn() },
}));

vi.mock("../../manifest", () => ({
  PIVOT_PANE_ID: "pivot-pane",
  PIVOT_ANALYZE_TAB_ID: "pivot-analyze",
  PIVOT_DESIGN_TAB_ID: "pivot-design",
  PivotAnalyzePanelDefinition: { id: "pivot-analyze", title: "Analyze" },
  PivotDesignPanelDefinition: { id: "pivot-design", title: "Design" },
}));

import { initKeybindings, getKeybinding, isGridFocused } from "@api/keybindings";
import { CommandRegistry } from "@api/commands";
import { registerToastSink, type ToastPayload } from "@api/notifications";
import { registerGridOverlay, setGridRegions, type GridRegion } from "@api/gridOverlays";
import { registerLayoutSurfaceProvider } from "@api/layoutSurface";
import {
  getSelectedObjectRegions,
  innerSelectionClipboardCommand,
  objectOwnsKey,
  resetObjectSelectionProviders,
} from "@api/objectSelection";
import { clipboardDoorCommand, objectClipboardHasClipboardKeys } from "@api/objectClipboard";
import { registerExternalFormulaTarget } from "@api/editing";
import { isExternalEditLive, type ExternalEditSession } from "@api/externalEdit";

import {
  canvasCellCopyApplies,
  canvasCellEditKeysApply,
  canvasCellKeysApply,
  canvasSelectAllApplies,
  installPivotCanvasCellKeys,
  pivotCanvasCellBindingId,
  PIVOT_CANVAS_COPY_KEYS,
  PIVOT_CANVAS_COPY_MAX_CELLS,
  PIVOT_CANVAS_COPY_TOO_LARGE,
  PIVOT_CANVAS_REFUSED_KEYS,
} from "../pivotCanvasCellKeys";
import {
  PIVOT_CANVAS_CLEAR_CELLS_COMMAND,
  PIVOT_CANVAS_COPY_CELLS_COMMAND,
  PIVOT_CANVAS_REFUSE_EDIT_COMMAND,
  PIVOT_CANVAS_SELECT_ALL_COMMAND,
  PIVOT_EDIT_REFUSAL,
  pivotCanvasMoveCommand,
} from "../pivotCanvasCellCommands";
import { createPivotVisualSelectionProvider, registerPivotVisualSelection } from "../pivotVisualSelection";
import {
  getPivotCellSelection,
  resetPivotCellSelection,
  setPivotCellAnchor,
  setPivotCellSelection,
} from "../pivotVisualCellSelection";
import { resetPivotVisualHits, setPivotVisualRecord } from "../pivotVisualHits";
import { ensurePivotCellVisible, getPivotVisualScroll, resetPivotVisualScrolls, setPivotVisualScroll } from "../pivotVisualScroll";
import { notePivotBoxMenuOpened, setPivotCellPressHeld, setPivotChromePressLive } from "../pivotVisualMenuState";
import { PIVOT_VISUAL_REGION_TYPE } from "../pivotVisualRegions";
import { deleteCachedPivotView, setCachedPivotView } from "../pivotViewStore";
import {
  getSelectedVisualPivotId,
  resetSelectionHandlerState,
  selectPivotVisual,
  updateCachedRegions,
} from "../../handlers/selectionHandler";
import type { PivotRegionData } from "@api/pivotTypes";
import type { PivotVisualGeometry } from "../../rendering/pivotVisualRenderer";
import { installCanvasObjectKeyboard, tabApplies } from "../../../CanvasSheet/lib/objectCycling";
import { installCanvasObjectNudge, nudgeApplies, resetCanvasObjectNudge } from "../../../CanvasSheet/lib/objectNudge";
import { installCanvasObjectDelete } from "../../../CanvasSheet/lib/canvasDelete";
import { canvasCopyApplies, installCanvasObjectClipboard } from "../../../CanvasSheet/lib/canvasClipboard";
import { installSelectedObjectKeys, objectDeleteApplies } from "../../../BuiltIn/ObjectPosition/lib/selectedObjectKeys";

// THE SHELL'S ORDER: the dispatcher's listener is installed at bootstrap,
// before any extension activates, and the built-ins are registered first.
initKeybindings();

const toasts: ToastPayload[] = [];
registerToastSink((t) => toasts.push(t));
const refusals = (): number => toasts.filter((t) => t.message === PIVOT_EDIT_REFUSAL).length;

// ============================================================================
// Fixture: one pivot box P on a canvas, painted with a known geometry
// ============================================================================

const P = "p1";
const Q = "p2";

function boxRegion(pivotId: string, x = 0): GridRegion {
  return {
    id: `pivot-visual-${pivotId}`,
    type: PIVOT_VISUAL_REGION_TYPE,
    startRow: 0,
    startCol: 0,
    endRow: 9,
    endCol: 3,
    floating: { x, y: 0, width: 200, height: 60 },
    data: { pivotId, name: `PivotTable ${pivotId}` },
  };
}

function offsets(sizes: number[]): Float64Array {
  const o = new Float64Array(sizes.length + 1);
  for (let i = 0; i < sizes.length; i++) o[i + 1] = o[i] + sizes[i];
  return o;
}

function geometry(rowHeights: number[], colWidths: number[], frozenRowCount = 0, frozenColCount = 0): PivotVisualGeometry {
  return {
    rowCount: rowHeights.length,
    colCount: colWidths.length,
    rowHeights,
    colWidths,
    rowOffsets: offsets(rowHeights),
    colOffsets: offsets(colWidths),
    frozenRowCount,
    frozenColCount,
  };
}

/** 10 rows of 20 px (row 2 HIDDEN), 4 columns of 80 px; header row frozen; box 200 x 60. */
function paint(pivotId: string, g: PivotVisualGeometry = geometry([20, 20, 0, 20, 20, 20, 20, 20, 20, 20], [80, 80, 80, 80], 1, 0)): void {
  setPivotVisualRecord({
    pivotId,
    box: { x: 0, y: 0, width: 200, height: 60 },
    bounds: null,
    cancel: null,
    geometry: g,
    scroll: getPivotVisualScroll(pivotId),
    startRow: 0,
    startCol: 0,
  });
}

const deletePivot = vi.fn(async () => {});

/**
 * A live EXTERNAL edit session (a floating grid's cell edit: the shape
 * core/lib/formulaEditTarget.ts contracts), registered through @api/editing.
 */
let endSession: (() => void) | null = null;
function startExternalEdit(): void {
  const session: ExternalEditSession = {
    address: "Float1!A1",
    hostSheetIndex: 0,
    anchor: { row: 0, col: 0 },
    getText: () => "=SUM(",
    getCursor: () => 5,
    getView: () => "cell",
    setText: () => {},
    setCursor: () => {},
    adoptBarView: () => {},
    focusCellView: () => {},
    commit: async () => true,
    cancel: () => endExternalEdit(),
    onParkedChanged: () => {},
  };
  endSession = registerExternalFormulaTarget({ isExpectingReference: () => true, insertReference: () => {}, session });
}
function endExternalEdit(): void {
  const off = endSession;
  endSession = null;
  off?.();
}
const cleanups: Array<() => void> = [];
let container: HTMLDivElement;

/** Install the pivot's keys, then the canvas's, then the generic object keys -- the manifest's order. */
function installAll(): void {
  cleanups.push(registerPivotVisualSelection({ deletePivot }));
  cleanups.push(...installPivotCanvasCellKeys("calcula.pivot"));
  cleanups.push(...installCanvasObjectKeyboard("calcula.canvas-sheet"));
  cleanups.push(...installCanvasObjectNudge("calcula.canvas-sheet"));
  cleanups.push(...installCanvasObjectDelete("calcula.canvas-sheet"));
  cleanups.push(...installCanvasObjectClipboard("calcula.canvas-sheet"));
  cleanups.push(installSelectedObjectKeys({ commands: CommandRegistry }, "calcula.object-position"));
}

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

/** The box P selected (keyboard semantics) with cell (row, col) active. */
function selectCell(row: number, col: number): void {
  selectPivotVisual(P, { openPane: false });
  setPivotCellAnchor(P, row, col);
}

const rect = () => {
  const s = getPivotCellSelection();
  return s && [s.anchorRow, s.anchorCol, s.endRow, s.endCol];
};

beforeEach(() => {
  surface = "canvas";
  toasts.length = 0;
  deletePivot.mockClear();
  copyCellRangeMock.mockClear();
  resetObjectSelectionProviders();
  resetSelectionHandlerState();
  resetPivotCellSelection();
  resetPivotVisualHits();
  resetPivotVisualScrolls();
  endExternalEdit();
  cleanups.push(
    registerGridOverlay({ type: PIVOT_VISUAL_REGION_TYPE, render: () => {}, priority: 10 }),
    registerLayoutSurfaceProvider({
      get: () => ({ snapToGrid: false, gridSize: 8, showGrid: false, page: null, editable: true }),
    }),
  );
  setGridRegions([boxRegion(P), boxRegion(Q, 300)]);
  paint(P);
  paint(Q);
  container = document.createElement("div");
  container.setAttribute("data-focus-container", "spreadsheet");
  container.tabIndex = 0;
  document.body.appendChild(container);
  container.focus();
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetCanvasObjectNudge();
  setPivotChromePressLive(false);
  setPivotCellPressHeld(false);
  resetObjectSelectionProviders();
  resetSelectionHandlerState();
  resetPivotCellSelection();
  resetPivotVisualHits();
  resetPivotVisualScrolls();
  endExternalEdit();
  setGridRegions([]);
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

// ============================================================================
// The guards
// ============================================================================

describe("the guard truth table", () => {
  it("fixture: the grid has the keyboard", () => {
    expect(isGridFocused()).toBe(true);
  });

  it("canvas + focus + cells in the SELECTED box: the cell keys apply", () => {
    installAll();
    expect(canvasCellKeysApply(), "control: nothing selected").toBe(false);
    selectPivotVisual(P, { openPane: false });
    expect(canvasCellKeysApply(), "a selected box WITHOUT cells: no cell keys").toBe(false);
    expect(canvasSelectAllApplies(), "a selected box: Ctrl+A applies").toBe(true);
    setPivotCellAnchor(P, 1, 1);
    expect(canvasCellKeysApply()).toBe(true);
    expect(canvasCellEditKeysApply()).toBe(true);
  });

  it("a WORKSHEET: none apply", () => {
    installAll();
    selectCell(1, 1);
    surface = "grid";
    expect(canvasCellKeysApply()).toBe(false);
    expect(canvasCellEditKeysApply()).toBe(false);
    expect(canvasSelectAllApplies()).toBe(false);
  });

  it("the keyboard outside the grid (a task pane's button): none apply", () => {
    installAll();
    selectCell(1, 1);
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    expect(canvasCellKeysApply()).toBe(false);
    expect(canvasCellEditKeysApply()).toBe(false);
    expect(canvasSelectAllApplies()).toBe(false);
  });

  it("cells of a box that is NOT the selected one: none apply", () => {
    installAll();
    selectPivotVisual(Q, { openPane: false });
    setPivotCellSelection({ pivotId: P, anchorRow: 1, anchorCol: 1, endRow: 1, endCol: 1 });
    expect(getPivotCellSelection()?.pivotId, "fixture: P's cells are held").toBe(P);
    expect(canvasCellKeysApply()).toBe(false);
    expect(canvasCellEditKeysApply()).toBe(false);
  });

  it("an open box menu or a held press: navigation and Escape stand down, the refusals do not", () => {
    installAll();
    selectCell(1, 1);
    const release = notePivotBoxMenuOpened();
    try {
      expect(canvasCellKeysApply(), "the menu's own listener takes the arrows and Escape").toBe(false);
      expect(canvasSelectAllApplies()).toBe(false);
      expect(canvasCellEditKeysApply(), "Delete behind the open menu must still refuse").toBe(true);
    } finally {
      release();
    }
    setPivotChromePressLive(true);
    expect(canvasCellKeysApply()).toBe(false);
    setPivotChromePressLive(false);
    setPivotCellPressHeld(true);
    expect(canvasCellKeysApply(), "Escape during a cell drag ends the drag and KEEPS the cells").toBe(false);
    setPivotCellPressHeld(false);
    expect(canvasCellKeysApply(), "control: nothing held").toBe(true);
  });

  it("Escape during a held cell drag does not clear the cells (the drag's own Escape answers)", () => {
    installAll();
    selectCell(3, 1);
    setPivotCellPressHeld(true);
    press("Escape");
    expect(rect(), "Escape cleared the cells under a held drag").toEqual([3, 1, 3, 1]);
    expect(getSelectedVisualPivotId(), "the canvas's Escape deselected the box under a held drag").toBe(P);
  });

  it("an EXTERNAL edit is live (a floating grid's cell edit): the dispatcher's not-editing context stands down", async () => {
    installAll();
    selectCell(3, 1);
    startExternalEdit();
    expect(isExternalEditLive(), "fixture: the session is live").toBe(true);
    const down = press("ArrowDown");
    expect(down.defaultPrevented, "the dispatcher took an arrow from the open edit").toBe(false);
    expect(rect(), "an arrow of the edit moved the pivot's cells").toEqual([3, 1, 3, 1]);
    const del = press("Delete");
    await settle();
    expect(del.defaultPrevented).toBe(false);
    expect(refusals(), "a Delete of the edit was refused as a pivot edit").toBe(0);
    expect(deletePivot).not.toHaveBeenCalled();
    // Control: the session ends and the same keys are the pivot's again.
    endExternalEdit();
    expect(press("ArrowDown").defaultPrevented).toBe(true);
    expect(rect()).toEqual([4, 1, 4, 1]);
  });

  it("a pick-only external target (no session) does not stand them down", () => {
    installAll();
    selectCell(3, 1);
    const off = registerExternalFormulaTarget({ isExpectingReference: () => false, insertReference: vi.fn() });
    try {
      expect(press("ArrowDown").defaultPrevented).toBe(true);
      expect(rect()).toEqual([4, 1, 4, 1]);
    } finally {
      off();
    }
  });
});

// ============================================================================
// Arrows
// ============================================================================

describe("arrows move, Shift+arrows extend", () => {
  it("ArrowDown/Up move the active cell and SKIP the hidden row; the selection collapses onto it", () => {
    installAll();
    selectCell(1, 1);
    setPivotCellSelection({ pivotId: P, anchorRow: 1, anchorCol: 1, endRow: 4, endCol: 3 });
    expect(press("ArrowDown").defaultPrevented).toBe(true);
    expect(rect(), "row 2 is hidden: the step lands on row 3, and a plain arrow collapses the block").toEqual([3, 1, 3, 1]);
    press("ArrowUp");
    expect(rect(), "back up over the hidden row").toEqual([1, 1, 1, 1]);
  });

  it("Left/Right move one column; every edge clamps", () => {
    installAll();
    selectCell(0, 0);
    press("ArrowUp");
    press("ArrowLeft");
    expect(rect(), "top-left edge").toEqual([0, 0, 0, 0]);
    for (let i = 0; i < 6; i++) press("ArrowRight");
    expect(rect(), "right edge").toEqual([0, 3, 0, 3]);
    for (let i = 0; i < 15; i++) press("ArrowDown");
    expect(rect(), "bottom edge").toEqual([9, 3, 9, 3]);
  });

  it("Shift+arrows move the FAR corner, the active cell stays", () => {
    installAll();
    selectCell(1, 1);
    press("ArrowDown", { shiftKey: true });
    press("ArrowRight", { shiftKey: true });
    expect(rect(), "anchor (1,1); the far corner skipped hidden row 2").toEqual([1, 1, 3, 2]);
    press("ArrowUp", { shiftKey: true });
    press("ArrowUp", { shiftKey: true });
    press("ArrowLeft", { shiftKey: true });
    press("ArrowLeft", { shiftKey: true });
    expect(rect(), "the far corner crosses the anchor").toEqual([1, 1, 0, 0]);
  });

  it("the body scrolls to keep the moved-to cell in sight (frozen header row: 20 px, box 60 px)", () => {
    // Row tops: r0 0 (frozen), r1 20, r2 hidden (40, 0 px), r3 40, r4 60, r5 80. Body shown at [20, 60).
    installAll();
    selectCell(1, 0);
    press("ArrowDown"); // row 3 [40, 60): in sight
    expect(getPivotVisualScroll(P).top).toBe(0);
    press("ArrowDown"); // row 4 [60, 80): below the box
    expect(getPivotVisualScroll(P).top, "row 4's bottom (80) at the box bottom (60)").toBe(20);
    press("ArrowDown"); // row 5 [80, 100)
    expect(getPivotVisualScroll(P).top).toBe(40);
    press("ArrowUp"); // row 4 at 60 - 40 = 20: just below the frozen band, in sight
    expect(getPivotVisualScroll(P).top).toBe(40);
    press("ArrowUp"); // row 3 at 40 - 40 = 0: under the frozen band
    expect(getPivotVisualScroll(P).top, "row 3's top at the frozen band's edge").toBe(20);
    press("ArrowUp"); // row 1 at 20 - 20 = 0: under the band again
    expect(getPivotVisualScroll(P).top).toBe(0);
    press("ArrowUp"); // row 0 is frozen: always shown, no scroll
    expect(getPivotVisualScroll(P).top).toBe(0);
    expect(rect()).toEqual([0, 0, 0, 0]);
  });

  it("an unpainted box (off screen) steps by its cached VIEW: hidden rows skipped there too", () => {
    installAll();
    resetPivotVisualHits();
    selectCell(1, 1);
    expect(press("ArrowDown").defaultPrevented, "the key is the pivot's even with nothing to step by").toBe(true);
    expect(rect(), "no geometry and no view: nothing moves, nothing throws").toEqual([1, 1, 1, 1]);
    const row = (visible: boolean) => ({ cells: [{}, {}], visible });
    setCachedPivotView(P, {
      rows: [row(true), row(true), row(false), row(true)],
      colCount: 2,
      columnHeaderRowCount: 1,
      rowLabelColCount: 1,
    } as never);
    try {
      press("ArrowDown");
      expect(rect(), "the view's hidden row 2 was not skipped").toEqual([3, 1, 3, 1]);
      press("ArrowRight");
      press("ArrowRight");
      expect(rect(), "the view's 2 columns clamp").toEqual([3, 1, 3, 1]);
    } finally {
      deleteCachedPivotView(P);
    }
  });

  it("the canvas's NUDGE stands down while cells are selected (and applies to the box without them)", () => {
    installAll();
    selectPivotVisual(P, { openPane: false });
    expect(getSelectedObjectRegions().map((r) => r.id), "fixture: the box is selected").toEqual(["pivot-visual-p1"]);
    expect(nudgeApplies(), "control: a selected box without cells is nudged").toBe(true);
    setPivotCellAnchor(P, 1, 1);
    expect(objectOwnsKey("Arrow")).toBe(true);
    expect(nudgeApplies(), "an arrow on the box's cells nudged the box").toBe(false);
  });

  it("Tab keeps cycling the canvas's objects while cells are selected", () => {
    installAll();
    selectCell(1, 1);
    expect(objectOwnsKey("Tab")).toBe(false);
    expect(tabApplies(), "the cells took Tab from the canvas").toBe(true);
    press("Tab");
    expect(getSelectedVisualPivotId(), "Tab stepped to the next object").toBe(Q);
    expect(getPivotCellSelection(), "the cells outlived their box").toBeNull();
  });
});

// ============================================================================
// Escape
// ============================================================================

describe("Escape: the cells first, then the box", () => {
  it("the first Escape clears the cells and keeps the box; the second is the canvas's and deselects it", () => {
    installAll();
    selectCell(3, 2);
    expect(objectOwnsKey("Escape")).toBe(true);
    expect(press("Escape").defaultPrevented).toBe(true);
    expect(getPivotCellSelection(), "Escape did not clear the cells").toBeNull();
    expect(getSelectedVisualPivotId(), "the first Escape deselected the box").toBe(P);
    expect(objectOwnsKey("Escape"), "no cells: the box no longer owns Escape").toBe(false);
    expect(press("Escape").defaultPrevented).toBe(true);
    expect(getSelectedVisualPivotId(), "the second Escape left the box selected").toBeNull();
  });
});

// ============================================================================
// Ctrl+A
// ============================================================================

describe("Ctrl+A selects the whole content", () => {
  it("with the box selected and no cells: first shown row to last, every column", () => {
    installAll();
    selectPivotVisual(P, { openPane: false });
    expect(press("a", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(rect()).toEqual([0, 0, 9, 3]);
  });

  it("with cells: the same block; hidden first/last rows are left out of the corners", () => {
    installAll();
    paint(P, geometry([0, 20, 20, 20, 0], [80, 80], 0, 0));
    selectCell(2, 1);
    press("a", { ctrlKey: true });
    expect(rect()).toEqual([1, 0, 3, 1]);
  });

  it("nothing selected: Ctrl+A is not the pivot's", () => {
    installAll();
    press("a", { ctrlKey: true });
    expect(getPivotCellSelection()).toBeNull();
  });
});

// ============================================================================
// The refusals and the DELETE HAZARD
// ============================================================================

describe("the edit keys refuse; Delete never deletes the PivotTable", () => {
  const combos: Array<[string, string, KeyboardEventInit]> = [
    ["Delete", "Delete", {}],
    ["Backspace", "Backspace", {}],
    ["Ctrl+X", "x", { ctrlKey: true }],
    ["Shift+Delete", "Delete", { shiftKey: true }],
    ["Ctrl+V", "v", { ctrlKey: true }],
    ["Shift+Insert", "Insert", { shiftKey: true }],
    ["Ctrl+D", "d", { ctrlKey: true }],
  ];

  it("the binding list is exactly the seven combos", () => {
    expect(PIVOT_CANVAS_REFUSED_KEYS.map((k) => k.combo)).toEqual(combos.map(([c]) => c));
  });

  for (const [label, key, init] of combos) {
    it(`${label}: the pivot's sentence, the cells and the box stay, nothing deleted`, async () => {
      installAll();
      selectCell(3, 1);
      const e = press(key, init);
      await settle();
      expect(e.defaultPrevented, `${label} was not taken`).toBe(true);
      expect(refusals(), `${label} said nothing`).toBe(1);
      expect(toasts[0].variant).toBe("info");
      expect(deletePivot, `${label} deleted the PivotTable`).not.toHaveBeenCalled();
      expect(rect()).toEqual([3, 1, 3, 1]);
      expect(getSelectedVisualPivotId()).toBe(P);
    });
  }

  it("THE DELETE HAZARD: the generic object Delete stands down while cells are selected", () => {
    installAll();
    selectPivotVisual(P, { openPane: false });
    expect(objectDeleteApplies(), "control: the selected box WITHOUT cells is deleted by Delete").toBe(true);
    setPivotCellAnchor(P, 1, 1);
    expect(objectOwnsKey("Delete")).toBe(true);
    expect(objectDeleteApplies(), "Delete on the box's cells would delete the whole PivotTable").toBe(false);
  });

  it("Delete behind the box's open menu still refuses (never the generic Delete)", async () => {
    installAll();
    selectCell(3, 1);
    const release = notePivotBoxMenuOpened();
    try {
      expect(press("Delete").defaultPrevented).toBe(true);
      await settle();
      expect(refusals()).toBe(1);
      expect(deletePivot).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it("control: with the box selected and NO cells, Delete deletes it (the generic door), and nothing refuses", async () => {
    installAll();
    selectPivotVisual(P, { openPane: false });
    press("Delete");
    await settle();
    expect(deletePivot).toHaveBeenCalledWith(P);
    expect(refusals()).toBe(0);
  });
});

// ============================================================================
// The provider: ownsKey rows and innerClipboardCommand
// ============================================================================

describe("the provider while cells are selected", () => {
  it("owns Arrow, Escape, Clipboard and Delete -- never Tab; nothing without cells", () => {
    const p = createPivotVisualSelectionProvider();
    for (const key of ["Arrow", "Escape", "Clipboard", "Delete", "Tab"] as const) {
      expect(p.ownsKey!(key), `${key} owned with no cells`).toBe(false);
    }
    setPivotCellSelection({ pivotId: P, anchorRow: 0, anchorCol: 0, endRow: 1, endCol: 1 });
    for (const key of ["Arrow", "Escape", "Clipboard", "Delete"] as const) {
      expect(p.ownsKey!(key), `${key} not owned with cells selected`).toBe(true);
    }
    expect(p.ownsKey!("Tab"), "Tab must keep cycling objects").toBe(false);
  });

  it("innerClipboardCommand: Copy copies the cells, Paste refuses; null without cells", () => {
    const p = createPivotVisualSelectionProvider();
    expect(p.innerClipboardCommand!("copy")).toBeNull();
    expect(p.innerClipboardCommand!("paste")).toBeNull();
    setPivotCellSelection({ pivotId: P, anchorRow: 0, anchorCol: 0, endRow: 1, endCol: 1 });
    expect(p.innerClipboardCommand!("copy")).toBe(PIVOT_CANVAS_COPY_CELLS_COMMAND);
    expect(p.innerClipboardCommand!("paste")).toBe(PIVOT_CANVAS_REFUSE_EDIT_COMMAND);
  });

  it("through the seam: the doors answer the cells' commands, the canvas's object clipboard stands down", async () => {
    installAll();
    selectCell(1, 1);
    expect(innerSelectionClipboardCommand("copy")).toBe(PIVOT_CANVAS_COPY_CELLS_COMMAND);
    expect(objectClipboardHasClipboardKeys(), "the canvas's object copy would copy the box, not its cells").toBe(false);
    expect(clipboardDoorCommand("paste"), "Home > Paste with cells selected").toBe(PIVOT_CANVAS_REFUSE_EDIT_COMMAND);
    // The Paste DOOR runs that command: the pivot's sentence.
    await CommandRegistry.execute(clipboardDoorCommand("paste"));
    expect(refusals()).toBe(1);
  });

  it("deselectAll clears the cells too", () => {
    const p = createPivotVisualSelectionProvider();
    setPivotCellSelection({ pivotId: P, anchorRow: 0, anchorCol: 0, endRow: 1, endCol: 1 });
    p.deselectAll();
    expect(getPivotCellSelection()).toBeNull();
  });
});

// ============================================================================
// Commands, bindings, and their cleanup
// ============================================================================

describe("installPivotCanvasCellKeys", () => {
  const bindingIds = [
    ...["Left", "Right", "Up", "Down"].flatMap((d) => [`move${d}`, `extend${d}`]),
    "clear",
    "selectAll",
    ...PIVOT_CANVAS_REFUSED_KEYS.map((k) => k.slug),
    ...PIVOT_CANVAS_COPY_KEYS.map((k) => k.slug),
  ].map(pivotCanvasCellBindingId);
  const commandIds = [
    ...(["left", "right", "up", "down"] as const).flatMap((d) => [pivotCanvasMoveCommand(d, false), pivotCanvasMoveCommand(d, true)]),
    PIVOT_CANVAS_CLEAR_CELLS_COMMAND,
    PIVOT_CANVAS_SELECT_ALL_COMMAND,
    PIVOT_CANVAS_REFUSE_EDIT_COMMAND,
    PIVOT_CANVAS_COPY_CELLS_COMMAND,
  ];

  it("registers every command and binding (PivotTable category, not-editing, extension) and removes them all", () => {
    const off = installPivotCanvasCellKeys("calcula.pivot");
    for (const id of commandIds) expect(CommandRegistry.has(id), `${id} not registered`).toBe(true);
    for (const id of bindingIds) {
      const b = getKeybinding(id);
      expect(b, `${id} not bound`).toBeDefined();
      expect(b!.category).toBe("PivotTable");
      expect(b!.context).toBe("not-editing");
      expect(b!.source).toBe("extension");
      expect(b!.extensionId).toBe("calcula.pivot");
    }
    expect(getKeybinding(pivotCanvasCellBindingId("moveLeft"))!.combo).toBe("ArrowLeft");
    expect(getKeybinding(pivotCanvasCellBindingId("extendLeft"))!.combo).toBe("Shift+ArrowLeft");
    expect(getKeybinding(pivotCanvasCellBindingId("selectAll"))!.combo).toBe("Ctrl+A");
    expect(getKeybinding(pivotCanvasCellBindingId("copy"))!.combo).toBe("Ctrl+C");
    expect(getKeybinding(pivotCanvasCellBindingId("copyInsert"))!.combo).toBe("Ctrl+Insert");
    expect(getKeybinding(pivotCanvasCellBindingId("copy"))!.commandId).toBe(PIVOT_CANVAS_COPY_CELLS_COMMAND);
    for (const f of off) f();
    for (const id of commandIds) expect(CommandRegistry.has(id), `${id} outlived the cleanup`).toBe(false);
    for (const id of bindingIds) expect(getKeybinding(id), `${id} outlived the cleanup`).toBeUndefined();
  });

  it("the commands re-check at run time: on a worksheet, or with no cells, they do nothing", async () => {
    installAll();
    selectCell(3, 1);
    surface = "grid";
    await CommandRegistry.execute(pivotCanvasMoveCommand("down", false));
    await CommandRegistry.execute(PIVOT_CANVAS_CLEAR_CELLS_COMMAND);
    await CommandRegistry.execute(PIVOT_CANVAS_REFUSE_EDIT_COMMAND);
    await CommandRegistry.execute(PIVOT_CANVAS_COPY_CELLS_COMMAND);
    expect(rect()).toEqual([3, 1, 3, 1]);
    expect(refusals()).toBe(0);
    expect(copyCellRangeMock, "the copy ran on a worksheet").not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
  });
});

// ============================================================================
// Copy (S7b)
// ============================================================================

/** The backend's region of a canvas pivot (cachedRegions): its anchor places the cells. */
function cachedRegion(pivotId: string, startRow: number, startCol: number): PivotRegionData {
  return {
    pivotId,
    name: `PivotTable ${pivotId}`,
    startRow,
    startCol,
    endRow: startRow + 9,
    endCol: startCol + 3,
    isEmpty: false,
    isModel: false,
    canvasFrame: { x: 0, y: 0, width: 200, height: 60 } as PivotRegionData["canvasFrame"],
  };
}

describe("Copy: the selected cells, from the hidden grid", () => {
  beforeEach(() => {
    copyCellRangeMock.mockReset();
    copyCellRangeMock.mockImplementation(async () => ({ copied: true, rows: 1, cols: 1 }));
    updateCachedRegions([cachedRegion(P, 0, 0), cachedRegion(Q, 0, 4)]);
  });

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  const lastRequest = (): CellRangeCopyRequest => {
    const calls = copyCellRangeMock.mock.calls;
    expect(calls.length, "nothing was copied").toBeGreaterThan(0);
    return calls[calls.length - 1][0];
  };

  it("Ctrl+C copies the block at the pivot's anchor: the box's hidden row left out, batched, capped at 200,000", async () => {
    installAll();
    selectCell(1, 1);
    setPivotCellSelection({ pivotId: P, anchorRow: 1, anchorCol: 1, endRow: 4, endCol: 3 });
    const e = press("c", { ctrlKey: true });
    await settle();
    expect(e.defaultPrevented, "Ctrl+C was not taken").toBe(true);
    expect(copyCellRangeMock).toHaveBeenCalledTimes(1);
    const req = lastRequest();
    expect([req.startRow, req.startCol, req.endRow, req.endCol]).toEqual([1, 1, 4, 3]);
    expect([...(req.skipRows ?? [])], "view row 2 is painted 0 px high: its grid row must not be copied").toEqual([2]);
    expect(req.batchRead).toBe(true);
    expect(req.maxCells).toBe(200_000);
    expect(PIVOT_CANVAS_COPY_MAX_CELLS).toBe(200_000);
    expect(toasts, "a successful copy said something").toEqual([]);
    expect(rect(), "the copy changed the cells").toEqual([1, 1, 4, 3]);
    expect(getSelectedVisualPivotId()).toBe(P);
    expect(deletePivot).not.toHaveBeenCalled();
  });

  it("a pivot further down the hidden grid (block 1: AMK31): the grid range and the skipped row carry the offset; a reversed drag is normalized", async () => {
    updateCachedRegions([cachedRegion(P, 30, 1024)]);
    installAll();
    selectCell(4, 3);
    setPivotCellSelection({ pivotId: P, anchorRow: 4, anchorCol: 3, endRow: 1, endCol: 0 });
    press("c", { ctrlKey: true });
    await settle();
    const req = lastRequest();
    expect([req.startRow, req.startCol, req.endRow, req.endCol]).toEqual([31, 1024, 34, 1027]);
    expect([...(req.skipRows ?? [])]).toEqual([32]);
  });

  it("a block of shown rows only skips nothing", async () => {
    installAll();
    selectCell(3, 0);
    setPivotCellSelection({ pivotId: P, anchorRow: 3, anchorCol: 0, endRow: 5, endCol: 1 });
    press("c", { ctrlKey: true });
    await settle();
    expect([...(lastRequest().skipRows ?? [])]).toEqual([]);
  });

  it("Ctrl+Insert copies the same block", async () => {
    installAll();
    selectCell(1, 1);
    setPivotCellSelection({ pivotId: P, anchorRow: 1, anchorCol: 1, endRow: 3, endCol: 2 });
    const e = press("Insert", { ctrlKey: true });
    await settle();
    expect(e.defaultPrevented).toBe(true);
    const req = lastRequest();
    expect([req.startRow, req.startCol, req.endRow, req.endCol]).toEqual([1, 1, 3, 2]);
    expect([...(req.skipRows ?? [])]).toEqual([2]);
  });

  it("an unpainted box (off screen) skips the rows its cached VIEW hides", async () => {
    installAll();
    resetPivotVisualHits();
    const row = (visible: boolean) => ({ cells: [{}, {}], visible });
    setCachedPivotView(P, {
      rows: [row(true), row(false), row(true), row(true)],
      colCount: 2,
      columnHeaderRowCount: 1,
      rowLabelColCount: 1,
    } as never);
    try {
      selectCell(0, 0);
      setPivotCellSelection({ pivotId: P, anchorRow: 0, anchorCol: 0, endRow: 3, endCol: 1 });
      press("c", { ctrlKey: true });
      await settle();
      expect([...(lastRequest().skipRows ?? [])]).toEqual([1]);
    } finally {
      deleteCachedPivotView(P);
    }
  });

  it("the Copy DOOR (Home > Copy, Edit > Copy) runs the same copy, and awaits it", async () => {
    installAll();
    selectCell(1, 1);
    expect(clipboardDoorCommand("copy")).toBe(PIVOT_CANVAS_COPY_CELLS_COMMAND);
    await CommandRegistry.execute(clipboardDoorCommand("copy"));
    expect(copyCellRangeMock).toHaveBeenCalledTimes(1);
    expect([lastRequest().startRow, lastRequest().startCol]).toEqual([1, 1]);
  });

  it("over the cap: the user is told, in the spec's sentence", async () => {
    copyCellRangeMock.mockImplementation(async () => ({ copied: false, reason: "tooLarge" }));
    installAll();
    selectCell(1, 1);
    press("c", { ctrlKey: true });
    await settle();
    expect(PIVOT_CANVAS_COPY_TOO_LARGE).toBe("That selection is too large to copy (more than 200,000 cells).");
    expect(toasts.map((t) => t.message)).toEqual([PIVOT_CANVAS_COPY_TOO_LARGE]);
    expect(toasts[0].variant).toBe("warning");
  });

  it("a failed read or clipboard write is told; so is a copy that throws", async () => {
    copyCellRangeMock.mockImplementation(async () => ({ copied: false, reason: "failed" }));
    installAll();
    selectCell(1, 1);
    press("c", { ctrlKey: true });
    await settle();
    expect(toasts.length).toBe(1);
    expect(toasts[0].message.startsWith("Copy failed")).toBe(true);
    expect(toasts[0].variant).toBe("error");

    toasts.length = 0;
    copyCellRangeMock.mockImplementation(async () => {
      throw new Error("the backend went away");
    });
    await CommandRegistry.execute(PIVOT_CANVAS_COPY_CELLS_COMMAND);
    expect(toasts.map((t) => t.message)).toEqual(["Copy failed: the backend went away"]);
  });

  it("a block with nothing to copy (every row hidden) is told", async () => {
    copyCellRangeMock.mockImplementation(async () => ({ copied: false, reason: "empty" }));
    installAll();
    selectCell(1, 1);
    await CommandRegistry.execute(PIVOT_CANVAS_COPY_CELLS_COMMAND);
    expect(toasts.length).toBe(1);
    expect(toasts[0].variant).toBe("info");
  });

  it("the pivot's region is not known on this page: told, nothing copied", async () => {
    updateCachedRegions([cachedRegion(Q, 0, 4)]);
    installAll();
    selectCell(1, 1);
    await CommandRegistry.execute(PIVOT_CANVAS_COPY_CELLS_COMMAND);
    expect(copyCellRangeMock).not.toHaveBeenCalled();
    expect(toasts.map((t) => t.message)).toEqual(["Copy failed: the PivotTable is not on this page."]);
  });

  it("a real DOM text selection wins: Ctrl+C is not the pivot's (the browser copies the text)", async () => {
    installAll();
    selectCell(1, 1);
    const text = document.createElement("div");
    text.textContent = "a toast's text";
    document.body.appendChild(text);
    window.getSelection()!.selectAllChildren(text);
    expect(window.getSelection()!.toString(), "fixture: the text is selected").toBe("a toast's text");
    expect(canvasCellCopyApplies()).toBe(false);
    const e = press("c", { ctrlKey: true });
    await settle();
    expect(copyCellRangeMock, "the pivot copied over a text selection").not.toHaveBeenCalled();
    expect(e.defaultPrevented, "Ctrl+C was taken from the browser's text copy").toBe(false);
    // Control: the text selection goes, and the key is the pivot's again.
    window.getSelection()!.removeAllRanges();
    expect(canvasCellCopyApplies()).toBe(true);
    expect(press("c", { ctrlKey: true }).defaultPrevented).toBe(true);
    await settle();
    expect(copyCellRangeMock).toHaveBeenCalledTimes(1);
  });

  it("the canvas's object copy stands down while the cells own the clipboard (and copies the box without them)", async () => {
    installAll();
    selectPivotVisual(P, { openPane: false });
    expect(canvasCopyApplies(), "control: a selected box without cells is copied as an object").toBe(true);
    expect(canvasCellCopyApplies(), "no cells: Ctrl+C is not the cells'").toBe(false);
    press("c", { ctrlKey: true });
    await settle();
    expect(copyCellRangeMock, "the box's object copy ran the cell copy").not.toHaveBeenCalled();
    setPivotCellAnchor(P, 1, 1);
    expect(objectOwnsKey("Clipboard")).toBe(true);
    expect(canvasCopyApplies(), "Ctrl+C on the box's cells would copy the whole box").toBe(false);
    expect(canvasCellCopyApplies()).toBe(true);
  });

  it("behind the box's open menu Ctrl+C still copies the cells (never Core's Copy of a hidden selection)", async () => {
    installAll();
    selectCell(1, 1);
    const release = notePivotBoxMenuOpened();
    try {
      expect(press("c", { ctrlKey: true }).defaultPrevented).toBe(true);
      await settle();
      expect(copyCellRangeMock).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
  });

  it("an EXTERNAL edit is live: Ctrl+C belongs to the edit", async () => {
    installAll();
    selectCell(1, 1);
    startExternalEdit();
    press("c", { ctrlKey: true });
    await settle();
    expect(copyCellRangeMock, "the edit's Ctrl+C copied the pivot's cells").not.toHaveBeenCalled();
  });

  it("the keyboard outside the grid: Ctrl+C is not the cells'", () => {
    installAll();
    selectCell(1, 1);
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    expect(canvasCellCopyApplies()).toBe(false);
  });
});

// ============================================================================
// ensurePivotCellVisible
// ============================================================================

describe("ensurePivotCellVisible", () => {
  it("no painted record: false, nothing set", () => {
    resetPivotVisualHits();
    expect(ensurePivotCellVisible(P, 5, 0)).toBe(false);
    expect(getPivotVisualScroll(P)).toEqual({ left: 0, top: 0 });
  });

  it("a cell in sight changes nothing", () => {
    expect(ensurePivotCellVisible(P, 1, 1)).toBe(false);
  });

  it("columns: right of the box scrolls its far edge in; back left scrolls its near edge in", () => {
    // 4 columns of 80 px in a 200 px box, nothing frozen.
    expect(ensurePivotCellVisible(P, 1, 3)).toBe(true);
    expect(getPivotVisualScroll(P).left, "column 3 [240, 320) ends at the box edge 200").toBe(120);
    expect(ensurePivotCellVisible(P, 1, 0)).toBe(true);
    expect(getPivotVisualScroll(P).left).toBe(0);
  });

  it("a frozen row or column scrolls nothing on its axis", () => {
    paint(P, geometry([20, 20, 20, 20, 20, 20], [80, 80, 80, 80], 1, 1));
    setPivotVisualScroll(P, { left: 40, top: 40 });
    expect(ensurePivotCellVisible(P, 0, 0)).toBe(false);
    expect(getPivotVisualScroll(P)).toEqual({ left: 40, top: 40 });
  });

  it("a cell taller than the body shows its TOP", () => {
    paint(P, geometry([20, 100, 20], [80], 1, 0));
    setPivotVisualScroll(P, { left: 0, top: 0 });
    expect(ensurePivotCellVisible(P, 2, 0)).toBe(true); // row 2 [120, 140)
    expect(getPivotVisualScroll(P).top).toBe(80);
    expect(ensurePivotCellVisible(P, 1, 0)).toBe(true); // row 1 [20, 120): 100 px > body 40
    expect(getPivotVisualScroll(P).top, "its top at the frozen band's edge").toBe(0);
  });

  it("the result is clamped to the content", () => {
    expect(ensurePivotCellVisible(P, 9, 0)).toBe(true);
    // content 180 (row 2 hidden: 9 x 20), box 60: max top 120.
    expect(getPivotVisualScroll(P).top).toBe(120);
  });
});
