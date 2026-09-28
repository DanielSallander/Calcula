//! FILENAME: app/extensions/Slicer/components/__tests__/SlicerConnectionsDialog.test.tsx
// PURPOSE: Report Connections for a MODEL slicer shows its page -- the BI
//          pivots of its model on its own sheet -- READ-ONLY, and writes
//          nothing on OK (the backend refuses any other connection list for a
//          model slicer). It used to list every pivot and table with live
//          ticks, keep the hidden "biConnection" key, and let the user add
//          pivots, which gave the slicer mixed semantics.
//
//          A PIVOT slicer's Save is ONE step asked about once when it grew a
//          pivot over the user's cells -- and never while a script batch holds
//          a transaction open on the BACKEND, which the frontend's own flag
//          cannot see (fix round 5 review, finding 3: the Save's step would be
//          the script's, and a decline would take back the script's writes).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Slicer } from "../../lib/slicerTypes";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  confirm: vi.fn((..._a: unknown[]): Promise<boolean> => Promise.resolve(false)),
  undo: vi.fn((..._a: unknown[]) => Promise.resolve({ stepsUndone: 1, complete: true, refreshDomains: ["slicer"] })),
  /** A transaction a script batch opened on the BACKEND directly. */
  backendTxOpen: false,
  txLabels: [] as string[],
}));

const mockAllPivots = vi.fn(async () => [{ id: "p-other", name: "Other pivot", sourceRange: "" }]);
vi.mock("@api/backend", () => ({
  getAllPivotTables: () => mockAllPivots(),
  getPivotHierarchies: async () => ({ hierarchies: [{ index: 0, name: "Region" }] }),
  getAllTables: async () => [],
  undoPivotOverwrite: (...a: unknown[]) => h.undo(...a),
}));
vi.mock("@api/dialogs", () => ({ confirmAsync: (...a: unknown[]) => h.confirm(...a) }));
vi.mock("@api/notifications", () => ({ showToast: vi.fn() }));
vi.mock("@api/objectGeometry", () => ({
  isUndoTransactionOpen: () => false,
  runInUndoTransaction: async (label: string, fn: () => Promise<unknown>) => {
    h.txLabels.push(label);
    return fn();
  },
}));
vi.mock("../../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/core/lib/tauri-api")>()),
  getUndoState: async () => ({ undoSeqs: [], transactionOpen: h.backendTxOpen }),
}));

let current: Slicer | undefined;
const mockUpdate = vi.fn(async () => null);
vi.mock("../../lib/slicerStore", () => ({
  getSlicerById: () => current,
  updateSlicerAsync: (...a: unknown[]) => mockUpdate(...(a as [])),
}));

vi.mock("../../handlers/selectionHandler", () => ({ broadcastSelectedSlicers: vi.fn() }));

const mockPage = vi.fn(async (_conn: string, _sheet: number) => [
  { id: "p-a", name: "Revenue by Region", sheetIndex: 2 },
  { id: "p-b", name: "Units by Year", sheetIndex: 2 },
]);
const mockSync = vi.fn();
vi.mock("../../lib/slicerFilterBridge", () => ({
  getModelSlicerPageTargets: (conn: string, sheet: number) => mockPage(conn, sheet),
  syncReportConnections: (...a: unknown[]) => mockSync(...a),
}));

import { SlicerConnectionsDialog } from "../SlicerConnectionsDialog";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

function slicer(overrides: Partial<Slicer> = {}): Slicer {
  return {
    id: "s-1",
    name: "Region",
    headerText: null,
    sheetIndex: 2,
    x: 0,
    y: 0,
    width: 180,
    height: 240,
    sourceType: "biConnection",
    cacheSourceId: "c1",
    fieldName: "Geo.Region",
    selectedItems: null,
    showHeader: true,
    columns: 1,
    stylePreset: "slicer-light-1",
    selectionMode: "standard",
    hideNoData: false,
    indicateNoData: true,
    sortNoDataLast: true,
    forceSelection: false,
    showSelectAll: false,
    arrangement: "vertical",
    rows: 0,
    itemGap: 4,
    autogrid: false,
    itemPadding: 4,
    buttonRadius: 2,
    connectedSources: [{ sourceType: "biConnection", sourceId: "c1" }],
    filterLevel: 1,
    ...overrides,
  };
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  h.backendTxOpen = false;
  h.txLabels.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

async function open(): Promise<void> {
  await act(async () => {
    root.render(<SlicerConnectionsDialog isOpen onClose={onClose} data={{ slicerId: "s-1" }} />);
  });
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function button(text: string): HTMLButtonElement {
  const b = Array.from(container.querySelectorAll("button")).find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`no button "${text}"`);
  return b;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Report Connections for a model slicer", () => {
  it("lists the page's pivots read-only and says what is reached", async () => {
    current = slicer();
    await open();

    expect(mockPage).toHaveBeenCalledWith("c1", 2);
    // Never the all-pivots / all-tables picker.
    expect(mockAllPivots).not.toHaveBeenCalled();

    const page = container.querySelector('[data-testid="model-slicer-page"]');
    expect(page?.textContent).toContain("Revenue by Region");
    expect(page?.textContent).toContain("Units by Year");
    expect(page?.textContent).toContain("Charts that query the model directly are not filtered yet");
    const boxes = Array.from(page!.querySelectorAll("input[type=checkbox]")) as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    expect(boxes.every((b) => b.checked && b.disabled)).toBe(true);
  });

  it("OK writes nothing -- the connection list of a model slicer is fixed", async () => {
    current = slicer();
    await open();
    await act(async () => {
      button("OK").click();
    });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("a pivot slicer's Save that grows a pivot over the user's cells is ONE step, asked about ONCE (declined: taken back)", async () => {
    current = slicer({
      sourceType: "pivot",
      cacheSourceId: "p-other",
      fieldName: "Region",
      connectedSources: [{ sourceType: "pivot", sourceId: "p-other" }],
    });
    mockSync.mockImplementation(async (...a: unknown[]) => {
      (a[3] as { note(r: unknown): void }).note({ pivotId: "p-other", overwrittenCellCount: 3, overwriteToken: 41 });
    });
    await open();
    await act(async () => {
      button("OK").click();
    });
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(h.txLabels).toEqual(["Slicer Connections"]);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.undo).toHaveBeenCalledWith("p-other", [41], undefined);
    expect(onClose).toHaveBeenCalled();
  });

  it("a Save while a script batch holds a BACKEND transaction open never asks (the step is the script's)", async () => {
    current = slicer({
      sourceType: "pivot",
      cacheSourceId: "p-other",
      fieldName: "Region",
      connectedSources: [{ sourceType: "pivot", sourceId: "p-other" }],
    });
    mockSync.mockImplementation(async (...a: unknown[]) => {
      (a[3] as { note(r: unknown): void }).note({ pivotId: "p-other", overwrittenCellCount: 3, overwriteToken: 41 });
    });
    h.backendTxOpen = true;
    await open();
    await act(async () => {
      button("OK").click();
    });
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.undo).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("a pivot slicer still gets the editable picker", async () => {
    current = slicer({
      sourceType: "pivot",
      cacheSourceId: "p-other",
      fieldName: "Region",
      connectedSources: [{ sourceType: "pivot", sourceId: "p-other" }],
    });
    await open();
    expect(mockPage).not.toHaveBeenCalled();
    expect(mockAllPivots).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="model-slicer-page"]')).toBeNull();
  });
});
