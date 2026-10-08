//! FILENAME: app/extensions/Pivot/components/__tests__/createPivotDialogPreset.test.tsx
// PURPOSE: Canvas contract §4.6 -- the Canvas tab's TABLE visual is a pivot in
//          tabular form with no column field. The Create PivotTable dialog
//          takes a `preset` in its dialog data (@api/pivotPresets); with
//          `{ layout: "tabular" }` it creates the pivot exactly as before and
//          then lays it out tabular with repeated row labels, BEFORE it hands
//          the pivot on (so the field list opens on a pivot already in its
//          final form). No preset sends no layout request at all. A refused
//          layout (the overwrite question declined) keeps the pivot and says
//          why it is not in table form.
// CONTEXT: The CreatePivotDialog harness of createPivotDialogCanvas.test.tsx:
//          react-dom + act, the backend doubled at @api/pivot.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  gridState: {} as Record<string, unknown>,
  sheets: [] as Array<Record<string, unknown>>,
  calls: [] as string[],
  create: vi.fn(),
  createFromBiModel: vi.fn(),
  updateLayout: vi.fn(),
  getAll: vi.fn(),
  getTableByName: vi.fn(),
  getConnections: vi.fn(),
  toasts: [] as Array<{ message: string; variant?: string }>,
}));

vi.mock("@api", () => ({
  addSheet: vi.fn(),
  getSheets: async () => ({ sheets: h.sheets, activeIndex: 2 }),
  setActiveSheetApi: vi.fn(),
  indexToCol: (i: number) => String.fromCharCode(65 + i),
  colToIndex: (letters: string) => letters.charCodeAt(0) - 65,
  detectDataRegion: vi.fn(async () => null),
  useGridState: () => h.gridState,
  getUsedRange: vi.fn(async (sheetIndex: number) =>
    sheetIndex === 1
      ? { startRow: 0, startCol: 0, endRow: 9, endCol: 3, empty: false }
      : { startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true },
  ),
  getCurrentRegion: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 9, endCol: 3, empty: false })),
  getPivotStoreService: () => ({ openBiPivotEditor: vi.fn() }),
}));
vi.mock("@api/events", () => ({
  emitAppEvent: vi.fn(),
  AppEvents: { SHEET_CHANGED: "app:sheet-changed", NAVIGATE_TO_CELL: "app:navigate-to-cell" },
}));
vi.mock("@api/pivot", () => ({
  pivot: {
    create: (...a: unknown[]) => h.create(...a),
    createFromBiModel: (...a: unknown[]) => h.createFromBiModel(...a),
    updateLayout: (...a: unknown[]) => h.updateLayout(...a),
    getAll: (...a: unknown[]) => h.getAll(...a),
  },
}));
vi.mock("@api/notifications", () => ({
  showToast: (message: string, options?: { variant?: string; type?: string }) => {
    h.toasts.push({ message, variant: options?.variant ?? options?.type });
  },
}));
vi.mock("@api/backend", () => ({ getTableByName: (...a: unknown[]) => h.getTableByName(...a) }));
vi.mock("@api/dialogWindow", () => ({
  useDialogWindow: () => ({ ref: { current: null }, style: {}, onHeaderMouseDown: () => {}, resizeHandles: null }),
}));
vi.mock("../../../_shared/lib/bi-api", () => ({ getConnections: (...a: unknown[]) => h.getConnections(...a) }));
vi.mock("../../lib/pivot-api", () => ({ getConnectionBiModel: vi.fn(async () => null) }));

import { CreatePivotDialog } from "../CreatePivotDialog";
import { TABLE_VISUAL_PIVOT_PRESET, readPivotCreatePreset, pivotPresetLayout } from "@api/pivotPresets";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const PLACEMENT = { sheetIndex: 2, x: 256, y: 144, width: 480, height: 320 };

let container: HTMLDivElement;
let root: Root;
const onCreated = vi.fn();
const onClose = vi.fn();

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

function setText(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function render(preset: unknown): Promise<void> {
  act(() => {
    root.render(
      <CreatePivotDialog
        isOpen
        onClose={onClose}
        onCreated={onCreated}
        placement={PLACEMENT}
        preset={preset}
        activeSheetIndex={2}
      />,
    );
  });
  await flush();
}

async function submit(): Promise<void> {
  const source = document.body.querySelector<HTMLInputElement>('input[type="text"]');
  if (source && !source.value) setText(source, "'Sales Data'!A1:D10");
  const ok = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent?.trim() === "OK",
  );
  expect(ok, "no OK button").toBeDefined();
  act(() => ok!.click());
  await flush();
}

beforeEach(() => {
  h.sheets = [
    { index: 0, name: "Notes", visibility: "visible", kind: "worksheet" },
    { index: 1, name: "Sales Data", visibility: "visible", kind: "worksheet" },
    { index: 2, name: "Canvas1", visibility: "visible", kind: "canvas" },
  ];
  h.gridState = {
    selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
    surface: "canvas",
    sheetContext: { activeSheetIndex: 2, activeSheetName: "Canvas1" },
    viewport: { scrollX: 0, scrollY: 0 },
    viewportDimensions: { width: 1000, height: 600 },
    zoom: 1,
  };
  h.calls = [];
  h.toasts = [];
  h.create.mockReset().mockImplementation(async () => {
    h.calls.push("create");
    return { pivotId: 7 };
  });
  h.updateLayout.mockReset().mockImplementation(async () => {
    h.calls.push("layout");
    return {};
  });
  h.getAll.mockReset().mockResolvedValue([]);
  h.getTableByName.mockReset().mockResolvedValue(null);
  h.getConnections.mockReset().mockResolvedValue([]);
  onCreated.mockReset().mockImplementation(() => h.calls.push("handedOn"));
  onClose.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("the preset seam", () => {
  it("reads only what it understands", () => {
    expect(readPivotCreatePreset(TABLE_VISUAL_PIVOT_PRESET)).toEqual({ layout: "tabular", noColumnFields: true });
    expect(readPivotCreatePreset(undefined)).toBeNull();
    expect(readPivotCreatePreset("tabular")).toBeNull();
    expect(readPivotCreatePreset({ layout: "sideways" })).toBeNull();
    expect(readPivotCreatePreset({ noColumnFields: "yes" })).toBeNull();
    expect(readPivotCreatePreset({})).toBeNull();
  });

  it("asks for tabular with repeated labels for the Table visual", () => {
    expect(pivotPresetLayout(TABLE_VISUAL_PIVOT_PRESET)).toEqual({ reportLayout: "tabular", repeatRowLabels: true });
  });
});

describe("the Create PivotTable dialog with a preset", () => {
  // SABOTAGE: drop the applyPivotPreset call from handleCreateOnCanvas -> no
  // layout request is sent.
  it("lays the new pivot out tabular BEFORE handing it on", async () => {
    await render(TABLE_VISUAL_PIVOT_PRESET);
    await submit();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.updateLayout).toHaveBeenCalledWith({
      pivotId: 7,
      layout: { reportLayout: "tabular", repeatRowLabels: true },
    });
    expect(h.calls).toEqual(["create", "layout", "handedOn"]);
  });

  it("without a preset sends no layout request", async () => {
    await render(undefined);
    await submit();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.updateLayout).not.toHaveBeenCalled();
  });

  it("a refused layout keeps the pivot and says why it is not in table form", async () => {
    h.updateLayout.mockImplementation(async () => {
      throw new Error("Pivot operation cancelled - would overwrite data");
    });
    await render(TABLE_VISUAL_PIVOT_PRESET);
    await submit();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith(7);
    expect(h.toasts).toEqual([
      {
        message:
          "The PivotTable was created, but not in table form: Pivot operation cancelled - would overwrite data",
        variant: "warning",
      },
    ]);
  });
});
