//! FILENAME: app/extensions/Slicer/components/__tests__/SlicerConnectionsDialog.test.tsx
// PURPOSE: Report Connections for a MODEL slicer shows its page -- the BI
//          pivots of its model on its own sheet -- READ-ONLY, and writes
//          nothing on OK (the backend refuses any other connection list for a
//          model slicer). It used to list every pivot and table with live
//          ticks, keep the hidden "biConnection" key, and let the user add
//          pivots, which gave the slicer mixed semantics.
//
//          P4: the page is every VISUAL of the model there -- its BI pivots
//          and its design-query charts (@api/modelVisuals) -- and a visual the
//          page's Edit interactions set to None for this slicer is listed
//          unticked with "(None -- Edit interactions)".
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
  undoCommitsSettled: () => Promise.resolve(),
  runInUndoTransaction: async (label: string, fn: () => Promise<unknown>) => {
    h.txLabels.push(label);
    return fn();
  },
  // The Tauri shape of the gesture's step: the BEGIN answers whether it opened
  // the step, and it joins (opens nothing) while a script holds one open.
  openUndoTransaction: (label: string) => {
    h.txLabels.push(label);
    const opened = !h.backendTxOpen;
    return {
      joined: !opened,
      run: async (fn: () => Promise<unknown>) => fn(),
      commit: async () => undefined,
      openedBackend: async () => opened,
    };
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
/** The page's Edit interactions for the slicer, "kind:id" -> mode (absent = filter). */
const interactionModes = new Map<string, "filter" | "none">();
vi.mock("../../lib/slicerFilterBridge", () => ({
  getModelSlicerPagePivots: (conn: string, sheet: number) => mockPage(conn, sheet),
  slicerVisualRef: (id: string) => ({ kind: "slicer", id }),
  slicerInteractionLookup:
    () =>
    (_slicer: { kind: string; id: string }, target: { kind: string; id: string }) =>
      interactionModes.get(`${target.kind}:${target.id}`) ?? "filter",
  syncReportConnections: (...a: unknown[]) => mockSync(...a),
}));

import { SlicerConnectionsDialog, NONE_INTERACTION_NOTE } from "../SlicerConnectionsDialog";
import { registerModelVisualProvider, type ModelVisualInfo } from "@api/modelVisuals";

/** A design-query chart of model c1 as the Charts provider would list it. */
function chartVisual(id: string, name: string, overrides: Partial<ModelVisualInfo> = {}): ModelVisualInfo {
  return {
    ref: { kind: "chart", id },
    name,
    sheetIndex: 2,
    sheetId: "canvas-2",
    connectionId: "c1",
    role: { source: true, target: true, canHighlight: true, reason: null },
    label: "Column chart",
    ...overrides,
  };
}

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

let offProvider: (() => void) | null = null;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  interactionModes.clear();
  h.backendTxOpen = false;
  h.txLabels.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  offProvider?.();
  offProvider = null;
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
    // Design-query charts on the page follow the slicer (@api/reportFilters,
    // owner decision 5 of 2026-10-08): the dialog names them, and never says
    // the old "not filtered yet" any more -- that would be a lie now.
    expect(page?.textContent).toContain("every chart that queries this model directly");
    expect(page?.textContent).not.toContain("not filtered yet");
    const boxes = Array.from(page!.querySelectorAll("input[type=checkbox]")) as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    expect(boxes.every((b) => b.checked && b.disabled)).toBe(true);
  });

  it("names VISUALS of the page: the header, the pivots and the model's charts there, read-only", async () => {
    offProvider = registerModelVisualProvider({
      kind: "chart",
      list: () => [
        chartVisual("bar", "Sales by Year"),
        chartVisual("card", "Total", { label: "Card", role: { source: false, target: true, canHighlight: false, reason: "x" } }),
        // Not this page, not this model, not a target: never listed.
        chartVisual("elsewhere", "Other page", { sheetIndex: 3, sheetId: "canvas-3" }),
        chartVisual("other-model", "Other model", { connectionId: "c2" }),
        chartVisual("range", "Range chart", {
          connectionId: null,
          role: { source: false, target: false, canHighlight: false, reason: "Reads cells, not the model" },
        }),
      ],
    });
    current = slicer();
    await open();

    const page = container.querySelector('[data-testid="model-slicer-page"]')!;
    expect(page.textContent).toContain("Visuals this model slicer filters (this page):");
    expect(page.textContent).not.toContain("PivotTables this model slicer filters");
    const rows = Array.from(page.querySelectorAll("label[data-visual-ref]")).map((l) => l.getAttribute("data-visual-ref"));
    expect(rows).toEqual(["pivot:p-a", "pivot:p-b", "chart:bar", "chart:card"]);
    const bar = page.querySelector('label[data-visual-ref="chart:bar"]')!;
    expect(bar.textContent).toContain("Sales by Year");
    expect(bar.textContent).toContain("Column chart");
    expect(page.querySelector('label[data-visual-ref="chart:card"]')!.textContent).toContain("Card");
    expect(page.querySelector('label[data-visual-ref="pivot:p-a"]')!.textContent).toContain("PivotTable");
    const boxes = Array.from(page.querySelectorAll("input[type=checkbox]")) as HTMLInputElement[];
    expect(boxes.every((b) => b.checked && b.disabled)).toBe(true);
    expect(page.textContent).not.toContain(NONE_INTERACTION_NOTE);
  });

  it("a visual set to None in Edit interactions is listed UNticked with the None note", async () => {
    offProvider = registerModelVisualProvider({ kind: "chart", list: () => [chartVisual("bar", "Sales by Year")] });
    interactionModes.set("pivot:p-b", "none");
    interactionModes.set("chart:bar", "none");
    current = slicer();
    await open();

    const row = (ref: string) =>
      container.querySelector(`label[data-visual-ref="${ref}"]`) as HTMLLabelElement;
    const box = (ref: string) => row(ref).querySelector("input") as HTMLInputElement;
    expect(NONE_INTERACTION_NOTE).toBe("(None -- Edit interactions)");
    expect(box("pivot:p-a").checked).toBe(true);
    expect(row("pivot:p-a").textContent).not.toContain(NONE_INTERACTION_NOTE);
    expect(box("pivot:p-b").checked).toBe(false);
    expect(row("pivot:p-b").textContent).toContain(NONE_INTERACTION_NOTE);
    expect(box("chart:bar").checked).toBe(false);
    expect(row("chart:bar").textContent).toContain("Column chart (None -- Edit interactions)");
    expect([box("pivot:p-b"), box("chart:bar")].every((b) => b.disabled)).toBe(true);
  });

  it("an empty page says visuals added later are filtered automatically", async () => {
    mockPage.mockResolvedValueOnce([]);
    current = slicer();
    await open();
    const page = container.querySelector('[data-testid="model-slicer-page"]')!;
    expect(page.textContent).toContain(
      "No visual of this model on this page yet. Visuals added here later are filtered automatically.",
    );
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
    expect(h.undo).toHaveBeenCalledWith("p-other", [41]);
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
