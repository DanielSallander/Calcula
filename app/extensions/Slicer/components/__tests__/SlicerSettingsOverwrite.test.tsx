//! FILENAME: app/extensions/Slicer/components/__tests__/SlicerSettingsOverwrite.test.tsx
// PURPOSE: The Slicer Settings OK is ONE undo step (the settings AND the
//          filter a level change re-routes). When that re-route grows a pivot
//          over the user's cells, the user is asked ONCE after the step
//          commits, and a decline takes back the whole step -- but NEVER
//          while a script batch holds a transaction open on the BACKEND,
//          which the frontend's own flag cannot see (fix round 5 review,
//          finding 3): the backend's begin is a no-op then, so the OK's
//          writes join the script's batch, its commit closes the batch, and a
//          decline took back the SCRIPT's writes with them.
//
// The dialog double has the Tauri shape (`confirmAsync` returns a Promise).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Slicer } from "../../lib/slicerTypes";

const h = vi.hoisted(() => ({
  confirm: vi.fn((..._a: unknown[]): Promise<boolean> => Promise.resolve(false)),
  undo: vi.fn((..._a: unknown[]) => Promise.resolve({ stepsUndone: 1, complete: true, refreshDomains: ["slicer"] })),
  /** A transaction a script batch opened on the BACKEND directly. */
  backendTxOpen: false,
  txLabels: [] as string[],
  current: undefined as Slicer | undefined,
  update: vi.fn(async () => null),
  apply: vi.fn(),
}));

vi.mock("@api/backend", () => ({ undoPivotOverwrite: (...a: unknown[]) => h.undo(...a) }));
vi.mock("@api/dialogs", () => ({ confirmAsync: (...a: unknown[]) => h.confirm(...a) }));
vi.mock("@api/notifications", () => ({ showToast: vi.fn() }));
vi.mock("@api/gridOverlays", () => ({ requestOverlayRedraw: vi.fn() }));
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
vi.mock("../../lib/slicerStore", () => ({
  getSlicerById: () => h.current,
  updateSlicerAsync: (...a: unknown[]) => h.update(...(a as [])),
}));
vi.mock("../../lib/slicerFilterBridge", () => ({
  applySlicerFilter: (...a: unknown[]) => h.apply(...a),
}));
vi.mock("../../lib/slicer-api", () => ({ getSlicerComputedAttributes: async () => [] }));
vi.mock("../../../_shared/components/jsonToggle", () => ({
  useJsonToggle: () => ({
    isJsonMode: false,
    toggle: () => undefined,
    json: "",
    setJson: () => undefined,
    apply: () => undefined,
    revert: () => undefined,
    dirty: false,
    error: null,
    loading: false,
  }),
  JsonToggleButton: () => null,
  JsonToggleEditor: () => null,
}));

import { SlicerSettingsDialog } from "../SlicerSettingsDialog";

function slicer(overrides: Partial<Slicer> = {}): Slicer {
  return {
    id: "s-1",
    name: "Region",
    headerText: null,
    sheetIndex: 0,
    x: 0,
    y: 0,
    width: 180,
    height: 240,
    sourceType: "pivot",
    cacheSourceId: "p-1",
    fieldName: "Region",
    selectedItems: ["East"],
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
    connectedSources: [{ sourceType: "pivot", sourceId: "p-1" }],
    filterLevel: 1,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  h.confirm.mockReset().mockImplementation(() => Promise.resolve(false));
  h.undo.mockClear();
  h.update.mockClear();
  h.apply.mockReset().mockImplementation(async (_s: unknown, options?: { overwrites?: { note(r: unknown): void } }) => {
    // The re-routed filter grew the pivot over 2 of the user's cells.
    options?.overwrites?.note({ pivotId: "p-1", overwrittenCellCount: 2, overwriteToken: 31 });
  });
  h.backendTxOpen = false;
  h.txLabels.length = 0;
  onClose.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** Open the dialog on a level-1 slicer, then let the stored level move so
 *  the OK sees a LEVEL CHANGE (the one path that re-routes the filter). */
async function openAndOkWithALevelChange(): Promise<void> {
  h.current = slicer({ filterLevel: 1 });
  await act(async () => {
    root.render(<SlicerSettingsDialog isOpen onClose={onClose} data={{ slicerId: "s-1" }} />);
  });
  await flush(4);
  h.current = slicer({ filterLevel: 2 });
  const ok = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "OK");
  if (!ok) throw new Error('no "OK" button');
  await act(async () => {
    ok.click();
  });
  await flush();
}

describe("Slicer Settings OK whose re-routed filter grows a pivot over the user's cells", () => {
  it("is ONE step, asked about ONCE after it commits; a decline takes back exactly its step", async () => {
    await openAndOkWithALevelChange();

    expect(h.apply, "fixture: the level change re-routed the filter").toHaveBeenCalledTimes(1);
    expect(h.txLabels).toEqual(["Slicer Settings"]);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirm.mock.calls[0][0]).toContain("2 cells");
    expect(h.undo).toHaveBeenCalledWith("p-1", [31]);
    expect(onClose).toHaveBeenCalled();
  });

  it("never asks while a script batch holds a BACKEND transaction open (the step is the script's)", async () => {
    h.backendTxOpen = true;

    await openAndOkWithALevelChange();

    expect(h.apply, "fixture: the level change re-routed the filter").toHaveBeenCalledTimes(1);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.undo).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
