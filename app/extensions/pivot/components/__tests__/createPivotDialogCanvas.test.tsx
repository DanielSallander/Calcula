//! FILENAME: app/extensions/Pivot/components/__tests__/createPivotDialogCanvas.test.tsx
// PURPOSE: M6 (canvas sheets) -- the Create PivotTable dialog, rendered:
//            - in CANVAS mode (a placement from the Canvas tab, or a canvas as
//              the active sheet) the request carries the frame, an EXPLICIT
//              non-canvas source sheet and the canvas as destination, and the
//              dialog never switches sheets or navigates afterwards;
//            - a canvas source, or a range without its sheet, is refused IN the
//              dialog -- nothing is sent;
//            - a data-model source goes through the BI door with the frame;
//            - WORKSHEET mode sends exactly the request it always sent (no
//              `canvasFrame` key at all) and still switches and navigates.
// CONTEXT: @testing-library/react is not installed; react-dom + `act`, as the
//          sibling component tests do. A text box is changed through the
//          prototype setter -- React tracks `value` on the instance, so
//          `el.value = x` would be swallowed as a no-op change.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Region = { startRow: number; startCol: number; endRow: number; endCol: number; empty: boolean };

const h = vi.hoisted(() => {
  const colLetters = (i: number): string => {
    let s = "";
    let n = i;
    while (n >= 0) {
      s = String.fromCharCode(65 + (n % 26)) + s;
      n = Math.floor(n / 26) - 1;
    }
    return s;
  };
  return {
    colLetters,
    gridState: {} as Record<string, unknown>,
    surface: null as Record<string, unknown> | null,
    sheets: [] as Array<Record<string, unknown>>,
    activeIndex: 0,
    usedRanges: new Map<number, Region>(),
    currentRegions: new Map<number, Region>(),
    create: vi.fn(),
    createFromBiModel: vi.fn(),
    getAll: vi.fn(),
    addSheet: vi.fn(),
    setActiveSheetApi: vi.fn(),
    detectDataRegion: vi.fn(),
    emitAppEvent: vi.fn(),
    getTableByName: vi.fn(),
    getConnections: vi.fn(),
    getConnectionBiModel: vi.fn(),
    openBiPivotEditor: vi.fn(),
    getUsedRange: vi.fn(),
    getCurrentRegion: vi.fn(),
  };
});

vi.mock("@api", () => ({
  addSheet: (...a: unknown[]) => h.addSheet(...a),
  getSheets: async () => ({ sheets: h.sheets, activeIndex: h.activeIndex }),
  setActiveSheetApi: (...a: unknown[]) => h.setActiveSheetApi(...a),
  indexToCol: (i: number) => h.colLetters(i),
  colToIndex: (letters: string) => {
    let col = 0;
    for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
    return col - 1;
  },
  detectDataRegion: (...a: unknown[]) => h.detectDataRegion(...a),
  useGridState: () => h.gridState,
  getUsedRange: (...a: unknown[]) => h.getUsedRange(...a),
  getCurrentRegion: (...a: unknown[]) => h.getCurrentRegion(...a),
  getPivotStoreService: () => ({ openBiPivotEditor: h.openBiPivotEditor }),
}));
vi.mock("@api/events", () => ({
  emitAppEvent: (...a: unknown[]) => h.emitAppEvent(...a),
  AppEvents: { SHEET_CHANGED: "app:sheet-changed", NAVIGATE_TO_CELL: "app:navigate-to-cell" },
}));
vi.mock("@api/pivot", () => ({
  pivot: {
    create: (...a: unknown[]) => h.create(...a),
    createFromBiModel: (...a: unknown[]) => h.createFromBiModel(...a),
    getAll: (...a: unknown[]) => h.getAll(...a),
  },
}));
vi.mock("@api/backend", () => ({ getTableByName: (...a: unknown[]) => h.getTableByName(...a) }));
vi.mock("@api/dialogWindow", () => ({
  useDialogWindow: () => ({ ref: { current: null }, style: {}, onHeaderMouseDown: () => {}, resizeHandles: null }),
}));
vi.mock("@api/layoutSurface", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/layoutSurface")>()),
  getLayoutSurface: () => h.surface,
}));
vi.mock("../../../_shared/lib/bi-api", () => ({ getConnections: (...a: unknown[]) => h.getConnections(...a) }));
vi.mock("../../lib/pivot-api", () => ({ getConnectionBiModel: (...a: unknown[]) => h.getConnectionBiModel(...a) }));

import { CreatePivotDialog } from "../CreatePivotDialog";
import {
  CANVAS_SOURCE_EMPTY_MESSAGE,
  CANVAS_SOURCE_NEEDS_SHEET_MESSAGE,
  CANVAS_SOURCE_NO_DATA_NOTE,
  canvasSourceIsCanvasMessage,
} from "../../lib/canvasPivotCreate";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const WORKBOOK = [
  { index: 0, name: "Notes", visibility: "visible", kind: "worksheet" },
  { index: 1, name: "Sales Data", visibility: "visible", kind: "worksheet" },
  { index: 2, name: "Canvas1", visibility: "visible", kind: "canvas" },
];

const PLACEMENT = { sheetIndex: 2, x: 256, y: 144, width: 480, height: 320 };
const FRAME = { x: 256, y: 144, width: 480, height: 320, frozenHeaders: true };

let container: HTMLDivElement;
let root: Root;
let pivotRefreshes = 0;
const onPivotRefresh = (): void => {
  pivotRefreshes++;
};
const onCreated = vi.fn();
const onClose = vi.fn();

function canvasGridState(): Record<string, unknown> {
  return {
    selection: { startRow: 0, startCol: 0, endRow: 3, endCol: 2 },
    surface: "canvas",
    sheetContext: { activeSheetIndex: 2, activeSheetName: "Canvas1" },
    viewport: { scrollX: 0, scrollY: 0 },
    viewportDimensions: { width: 1000, height: 600 },
    zoom: 1,
  };
}

beforeEach(() => {
  h.sheets = WORKBOOK.map((s) => ({ ...s }));
  h.activeIndex = 2;
  h.gridState = canvasGridState();
  h.surface = { snapToGrid: true, gridSize: 16, showGrid: true, page: { width: 1280, height: 720 }, editable: true };
  h.usedRanges = new Map([
    [0, { startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true }],
    [1, { startRow: 0, startCol: 0, endRow: 9, endCol: 3, empty: false }],
  ]);
  h.currentRegions = new Map([[1, { startRow: 0, startCol: 0, endRow: 9, endCol: 3, empty: false }]]);
  for (const f of [
    h.create,
    h.createFromBiModel,
    h.getAll,
    h.addSheet,
    h.setActiveSheetApi,
    h.detectDataRegion,
    h.emitAppEvent,
    h.getTableByName,
    h.getConnections,
    h.getConnectionBiModel,
    h.openBiPivotEditor,
    h.getUsedRange,
    h.getCurrentRegion,
    onCreated,
    onClose,
  ]) {
    f.mockReset();
  }
  h.getAll.mockResolvedValue([]);
  h.create.mockResolvedValue({ pivotId: "pv-1", rowCount: 3, colCount: 2 });
  h.createFromBiModel.mockResolvedValue({ pivotId: "pv-bi", rowCount: 0, colCount: 0 });
  h.getTableByName.mockResolvedValue(null);
  h.getConnections.mockResolvedValue([]);
  h.getConnectionBiModel.mockResolvedValue(null);
  h.setActiveSheetApi.mockResolvedValue(undefined);
  h.getUsedRange.mockImplementation(
    async (i: number) => h.usedRanges.get(i) ?? { startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true },
  );
  h.getCurrentRegion.mockImplementation(
    async (_r: number, _c: number, i: number) =>
      h.currentRegions.get(i) ?? { startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true },
  );
  pivotRefreshes = 0;
  window.addEventListener("pivot:refresh", onPivotRefresh);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.removeEventListener("pivot:refresh", onPivotRefresh);
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function open(props: Partial<React.ComponentProps<typeof CreatePivotDialog>> = {}): Promise<void> {
  act(() => {
    root.render(<CreatePivotDialog isOpen onClose={onClose} onCreated={onCreated} {...props} />);
  });
  await flush();
}

function byTestId<T extends HTMLElement>(id: string): T {
  const el = container.querySelector<T>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no [data-testid="${id}"]`);
  return el;
}

async function typeInto(el: HTMLInputElement, text: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

async function click(el: HTMLElement): Promise<void> {
  act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await flush();
}

async function clickOk(): Promise<void> {
  const ok = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "OK");
  if (!ok) throw new Error("no OK button");
  await click(ok);
}

/** Wait past the worksheet path's 150 ms navigation timer. */
async function afterNavigationWindow(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });
}

function emittedEventNames(): unknown[] {
  return h.emitAppEvent.mock.calls.map((c) => c[0]);
}

describe("canvas mode, opened by the Canvas tab's Insert group", () => {
  it("fixes the destination to this canvas and offers no worksheet destination", async () => {
    await open({ placement: PLACEMENT });
    expect(byTestId("pivot-canvas-destination").textContent).toContain("This canvas (Canvas1), 480 x 320 px");
    expect(container.querySelectorAll('input[name="destination"]')).toHaveLength(0);
    expect(container.textContent).not.toContain("New Worksheet");
  });

  it("never turns the canvas's 'selection' into a range; defaults to the first worksheet with data", async () => {
    await open({ placement: PLACEMENT });
    expect(h.detectDataRegion).not.toHaveBeenCalled();
    // Notes is empty; Sales Data holds A1:D10. The name needs quoting.
    expect(byTestId<HTMLInputElement>("pivot-canvas-source").value).toBe("'Sales Data'!A1:D10");
    // The canvas itself is never asked for data.
    expect(h.getUsedRange.mock.calls.map((c) => c[0])).not.toContain(2);
  });

  it("sends the frame, the explicit worksheet source and the canvas as destination -- and never navigates", async () => {
    await open({ placement: PLACEMENT });
    await clickOk();

    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create.mock.calls[0][0]).toEqual({
      sourceRange: "'Sales Data'!A1:D10",
      destinationCell: "A1",
      sourceSheet: 1,
      destinationSheet: 2,
      hasHeaders: true,
      name: "PivotTable1",
      sourceTableName: undefined,
      canvasFrame: FRAME,
    });
    expect(onCreated).toHaveBeenCalledWith("pv-1");
    // The new pivot's box paints where it was inserted.
    expect(pivotRefreshes).toBe(1);

    await afterNavigationWindow();
    expect(h.setActiveSheetApi).not.toHaveBeenCalled();
    expect(h.addSheet).not.toHaveBeenCalled();
    expect(emittedEventNames()).not.toContain("app:navigate-to-cell");
    expect(emittedEventNames()).not.toContain("app:sheet-changed");
  });

  it("refuses a canvas as the source in the dialog; nothing is sent", async () => {
    await open({ placement: PLACEMENT });
    await typeInto(byTestId<HTMLInputElement>("pivot-canvas-source"), "Canvas1!A1:B5");
    await clickOk();
    expect(h.create).not.toHaveBeenCalled();
    expect(container.textContent).toContain(canvasSourceIsCanvasMessage("Canvas1"));
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("refuses a range without its sheet (a canvas has no current sheet to mean)", async () => {
    await open({ placement: PLACEMENT });
    await typeInto(byTestId<HTMLInputElement>("pivot-canvas-source"), "A1:D10");
    await clickOk();
    expect(h.create).not.toHaveBeenCalled();
    expect(container.textContent).toContain(CANVAS_SOURCE_NEEDS_SHEET_MESSAGE);
  });

  it("takes a table by name, on the table's own sheet, linked by name", async () => {
    h.getTableByName.mockResolvedValue({
      name: "Orders",
      sheetIndex: 1,
      startRow: 2,
      startCol: 1,
      endRow: 20,
      endCol: 4,
    });
    await open({ placement: PLACEMENT });
    await typeInto(byTestId<HTMLInputElement>("pivot-canvas-source"), "Orders");
    await clickOk();
    expect(h.getTableByName).toHaveBeenCalledWith("Orders");
    expect(h.create.mock.calls[0][0]).toMatchObject({
      sourceRange: "'Sales Data'!B3:E21",
      sourceSheet: 1,
      destinationSheet: 2,
      sourceTableName: "Orders",
      canvasFrame: FRAME,
    });
  });

  it("with no worksheet data, leaves the source empty with a note, and refuses an empty source", async () => {
    h.usedRanges = new Map();
    await open({ placement: PLACEMENT });
    expect(byTestId<HTMLInputElement>("pivot-canvas-source").value).toBe("");
    expect(container.textContent).toContain(CANVAS_SOURCE_NO_DATA_NOTE);
    await clickOk();
    expect(h.create).not.toHaveBeenCalled();
    expect(container.textContent).toContain(CANVAS_SOURCE_EMPTY_MESSAGE);
  });

  it("a data-model source goes through the BI door with the frame and opens the model's field list", async () => {
    const model = { connectionId: "c1", tables: [], measures: [] };
    h.getConnections.mockResolvedValue([{ id: "c1", name: "Sales model", isConnected: true }]);
    h.getConnectionBiModel.mockResolvedValue(model);
    await open({ placement: PLACEMENT });
    await click(byTestId("pivot-canvas-source-model"));
    expect(byTestId<HTMLSelectElement>("pivot-canvas-connection").value).toBe("c1");
    await clickOk();

    expect(h.create).not.toHaveBeenCalled();
    expect(h.createFromBiModel).toHaveBeenCalledTimes(1);
    expect(h.createFromBiModel.mock.calls[0][0]).toEqual({
      destinationCell: "A1",
      destinationSheet: 2,
      name: "PivotTable1",
      connectionId: "c1",
      canvasFrame: FRAME,
    });
    expect(h.openBiPivotEditor).toHaveBeenCalledWith("pv-bi", model);
    expect(pivotRefreshes).toBe(1);
    await afterNavigationWindow();
    expect(emittedEventNames()).not.toContain("app:navigate-to-cell");
    expect(h.setActiveSheetApi).not.toHaveBeenCalled();
  });

  it("a data-model source with no connection chosen is refused in the dialog", async () => {
    await open({ placement: PLACEMENT });
    await click(byTestId("pivot-canvas-source-model"));
    await clickOk();
    expect(h.createFromBiModel).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Please choose a data model connection.");
  });
});

describe("canvas mode, opened from the Insert menu while a canvas is active (no placement)", () => {
  it("chooses a snapped, page-kept frame centred in the view, on the active canvas", async () => {
    await open();
    expect(byTestId("pivot-canvas-destination").textContent).toContain("This canvas (Canvas1), 480 x 320 px");
    await clickOk();
    // (1000-480)/2 = 260 -> 256, (600-320)/2 = 140 -> 144 on the 16 px grid.
    expect(h.create.mock.calls[0][0]).toMatchObject({ destinationSheet: 2, sourceSheet: 1, canvasFrame: FRAME });
  });

  it("keeps the frame on a small page", async () => {
    h.surface = { ...h.surface!, page: { width: 300, height: 200 } };
    await open();
    await clickOk();
    expect(h.create.mock.calls[0][0].canvasFrame).toEqual({ x: 0, y: 0, width: 300, height: 200, frozenHeaders: true });
  });
});

describe("worksheet mode is unchanged", () => {
  beforeEach(() => {
    h.sheets = [{ index: 0, name: "Sheet1", visibility: "visible" }];
    h.activeIndex = 0;
    h.gridState = {
      selection: null,
      surface: "grid",
      sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
      viewport: { scrollX: 0, scrollY: 0 },
      viewportDimensions: { width: 1000, height: 600 },
      zoom: 1,
    };
    h.detectDataRegion.mockResolvedValue([0, 0, 4, 2]);
    h.addSheet.mockImplementation(async (name: string) => ({
      sheets: [
        { index: 0, name: "Sheet1" },
        { index: 1, name },
      ],
      activeIndex: 1,
    }));
  });

  it("sends the same request as always -- no canvasFrame key -- then switches and navigates", async () => {
    await open({ selection: { startRow: 0, startCol: 0, endRow: 4, endCol: 2 } });
    expect(container.querySelector('[data-testid="pivot-canvas-destination"]')).toBeNull();
    expect(container.querySelectorAll('input[name="destination"]')).toHaveLength(2);
    await clickOk();

    expect(h.create).toHaveBeenCalledTimes(1);
    const request = h.create.mock.calls[0][0];
    expect(request).toEqual({
      sourceRange: "Sheet1!A1:C5",
      destinationCell: "PivotTable1!A1",
      sourceSheet: 0,
      destinationSheet: 1,
      hasHeaders: true,
      name: "PivotTable1",
      sourceTableName: undefined,
    });
    expect("canvasFrame" in request).toBe(false);
    expect(h.addSheet).toHaveBeenCalledWith("PivotTable1");
    expect(h.setActiveSheetApi).toHaveBeenCalledWith(1);
    expect(emittedEventNames()).toContain("app:sheet-changed");
    await afterNavigationWindow();
    expect(h.emitAppEvent).toHaveBeenCalledWith("app:navigate-to-cell", { row: 0, col: 0 });
    // The canvas-only reads never happen on a worksheet.
    expect(h.getConnections).not.toHaveBeenCalled();
    expect(h.getUsedRange).not.toHaveBeenCalled();
    expect(pivotRefreshes).toBe(0);
  });
});

// Wave D, X3 (completes W24): Insert > PivotTable asks for no prefill
// (`suppressAutoRange`) while a floating grid owns the selection: Core's
// selection is then a cell HIDDEN under it, and the dialog detected the data
// region around that cell and offered it as the source.
describe("worksheet mode: the opener asks for no prefill (suppressAutoRange)", () => {
  beforeEach(() => {
    h.sheets = [{ index: 0, name: "Sheet1", visibility: "visible" }];
    h.activeIndex = 0;
    h.gridState = {
      selection: { startRow: 0, startCol: 0, endRow: 4, endCol: 2 },
      surface: "grid",
      sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
      viewport: { scrollX: 0, scrollY: 0 },
      viewportDimensions: { width: 1000, height: 600 },
      zoom: 1,
    };
    h.detectDataRegion.mockResolvedValue([0, 0, 4, 2]);
  });

  const source = () => byTestId<HTMLInputElement>("pivot-worksheet-source-range").value;

  it("fixture: without the flag the source is detected around the selection", async () => {
    await open();
    expect(h.detectDataRegion).toHaveBeenCalled();
    expect(source()).toBe("Sheet1!A1:C5");
  });

  it("detects nothing and leaves the source empty", async () => {
    await open({ suppressAutoRange: true });
    expect(h.detectDataRegion).not.toHaveBeenCalled();
    expect(source()).toBe("");
  });

  it("does not offer the source a previous open detected", async () => {
    await open();
    expect(source()).toBe("Sheet1!A1:C5");
    act(() => {
      root.render(<CreatePivotDialog isOpen={false} onClose={onClose} onCreated={onCreated} />);
    });
    await flush();
    h.detectDataRegion.mockClear();
    await open({ suppressAutoRange: true });
    expect(h.detectDataRegion).not.toHaveBeenCalled();
    expect(source()).toBe("");
  });

  it("still takes a table the opener names: that is not a guess from the selection", async () => {
    await open({ suppressAutoRange: true, tableName: "Sales" });
    expect(h.detectDataRegion).not.toHaveBeenCalled();
    expect(source()).toBe("Sales");
  });
});

// BUG-0149: typing `Sheet2!A1:D9` on Sheet1 sent `sourceSheet` = the sheet
// active when the dialog opened, and the backend strips the prefix -- the
// pivot summarised Sheet1!A1:D9.
describe("worksheet mode: a typed sheet prefix names the source sheet (BUG-0149)", () => {
  beforeEach(() => {
    h.sheets = [
      { index: 0, name: "Sheet1", visibility: "visible" },
      { index: 1, name: "Sheet2", visibility: "visible" },
      { index: 2, name: "Canvas1", visibility: "visible", kind: "canvas" },
    ];
    h.activeIndex = 0;
    h.gridState = {
      selection: null,
      surface: "grid",
      sheetContext: { activeSheetIndex: 0, activeSheetName: "Sheet1" },
      viewport: { scrollX: 0, scrollY: 0 },
      viewportDimensions: { width: 1000, height: 600 },
      zoom: 1,
    };
    h.detectDataRegion.mockResolvedValue([0, 0, 4, 2]);
    h.addSheet.mockImplementation(async (name: string) => ({
      sheets: [...h.sheets, { index: 3, name }],
      activeIndex: 3,
    }));
  });

  it("sends the TYPED sheet (found ignoring case), not the sheet active when the dialog opened", async () => {
    await open({ selection: { startRow: 0, startCol: 0, endRow: 4, endCol: 2 } });
    await typeInto(byTestId<HTMLInputElement>("pivot-worksheet-source-range"), "sheet2!A1:D9");
    await clickOk();

    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create.mock.calls[0][0]).toMatchObject({ sourceRange: "Sheet2!A1:D9", sourceSheet: 1 });
  });

  it("refuses a sheet no tab is named, in the dialog -- no sheet is added, nothing is created", async () => {
    await open({ selection: { startRow: 0, startCol: 0, endRow: 4, endCol: 2 } });
    await typeInto(byTestId<HTMLInputElement>("pivot-worksheet-source-range"), "Nope!A1:D9");
    await clickOk();

    expect(container.textContent).toContain('There is no sheet named "Nope".');
    expect(h.addSheet).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it("refuses a canvas as the source, in the dialog", async () => {
    await open({ selection: { startRow: 0, startCol: 0, endRow: 4, endCol: 2 } });
    await typeInto(byTestId<HTMLInputElement>("pivot-worksheet-source-range"), "Canvas1!A1:D9");
    await clickOk();

    expect(container.textContent).toContain(canvasSourceIsCanvasMessage("Canvas1"));
    expect(h.addSheet).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  // A dialog opened from a TABLE (Table Design > Summarize with PivotTable
  // hands the table's name and cells). The table branch overwrote the range
  // with the table's cells on the dialog-open sheet while `sourceSheet` came
  // from the TYPED text: one request naming two sources, and the table link
  // switched the pivot to other data on its first refresh.
  const TABLE_CELLS = { startRow: 0, startCol: 0, endRow: 4, endCol: 2 };

  it("a table dialog sends the table on its own sheet, linked by name", async () => {
    await open({ tableName: "Table1", selection: TABLE_CELLS });
    await clickOk();

    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create.mock.calls[0][0]).toMatchObject({
      sourceRange: "Sheet1!A1:C5",
      sourceSheet: 0,
      sourceTableName: "Table1",
    });
  });

  it("the table's name typed in another case still names the table", async () => {
    await open({ tableName: "Table1", selection: TABLE_CELLS });
    await typeInto(byTestId<HTMLInputElement>("pivot-worksheet-source-range"), " table1 ");
    await clickOk();

    expect(h.create.mock.calls[0][0]).toMatchObject({
      sourceRange: "Sheet1!A1:C5",
      sourceSheet: 0,
      sourceTableName: "Table1",
    });
  });

  it("a table dialog whose source is retyped as another sheet's range sends THAT range, unlinked", async () => {
    await open({ tableName: "Table1", selection: TABLE_CELLS });
    await typeInto(byTestId<HTMLInputElement>("pivot-worksheet-source-range"), "Sheet2!A1:D9");
    await clickOk();

    expect(h.create).toHaveBeenCalledTimes(1);
    const request = h.create.mock.calls[0][0] as Record<string, unknown>;
    expect(request).toMatchObject({ sourceRange: "Sheet2!A1:D9", sourceSheet: 1 });
    expect(request.sourceTableName).toBeUndefined();
  });

  // The EXISTING destination named its sheet by an exact-case match and, when
  // nothing matched, sent no sheet at all: the backend then used the active
  // sheet, and `sheet2!B3` (or a sheet that does not exist) put the pivot on
  // the sheet the dialog was opened from -- over its cells.
  async function typeExistingDestination(text: string): Promise<void> {
    const existing = container.querySelector<HTMLInputElement>('input[name="destination"][value="existing"]');
    if (!existing) throw new Error("no Existing Worksheet option");
    await click(existing);
    const box = container.querySelector<HTMLInputElement>('input[placeholder="e.g., Sheet2!F1"]');
    if (!box) throw new Error("no destination box");
    await typeInto(box, text);
  }

  it("an existing destination names its sheet ignoring case, as the source does", async () => {
    await open({ selection: TABLE_CELLS });
    await typeExistingDestination("sheet2!$B$3");
    await clickOk();

    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create.mock.calls[0][0]).toMatchObject({ destinationSheet: 1 });
    expect(h.setActiveSheetApi).toHaveBeenCalledWith(1);
    expect(h.emitAppEvent).toHaveBeenCalledWith("app:sheet-changed", { sheetIndex: 1, sheetName: "Sheet2" });
    await afterNavigationWindow();
    expect(h.emitAppEvent).toHaveBeenCalledWith("app:navigate-to-cell", { row: 2, col: 1 });
  });

  it("refuses an existing destination on a sheet no tab is named, in the dialog", async () => {
    await open({ selection: TABLE_CELLS });
    await typeExistingDestination("Nope!B3");
    await clickOk();

    expect(container.textContent).toContain('There is no sheet named "Nope".');
    expect(h.create).not.toHaveBeenCalled();
  });
});
