//! FILENAME: app/extensions/Slicer/components/__tests__/InsertSlicerDialog.test.tsx
// PURPOSE: The owner's case (finding 4, 2026-09-27), rendered: a workbook with
//          a Calcula model and NO table and NO pivot. Insert Slicers used to say
//          "No Tables or PivotTables found" and offer nothing. Now the model is
//          offered first as "Sales (Model)", the dialog says what a model
//          slicer reaches, and Create makes a MODEL slicer (sourceType
//          "biConnection", its connection = the model's page) without ever
//          rebuilding a pivot.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// ---------------------------------------------------------------------------
// Mocks — the dialog's whole outside world
// ---------------------------------------------------------------------------

vi.mock("@api", () => ({
  getSheets: async () => ({
    activeIndex: 2,
    sheets: [
      { index: 0, name: "Data" },
      { index: 1, name: "Sheet1" },
      { index: 2, name: "Report" },
    ],
  }),
}));

vi.mock("@api/dialogWindow", () => ({
  useDialogWindow: () => ({
    ref: () => undefined,
    style: {},
    onHeaderMouseDown: () => undefined,
    resizeHandles: null,
  }),
}));

let connections: Array<{ id: string; name: string }> = [];
let models: Record<string, unknown> = {};
const mockUpdateBiPivotFields = vi.fn();
vi.mock("@api/backend", () => ({
  getAllTables: async () => [],
  getAllPivotTables: async () => [],
  getPivotHierarchies: async () => ({ hierarchies: [] }),
  biGetConnections: async () => connections,
  biGetModelInfo: async (id: string) => models[id] ?? null,
  updateBiPivotFields: (...a: unknown[]) => mockUpdateBiPivotFields(...a),
}));

const txLabels: string[] = [];
vi.mock("@api/objectGeometry", () => ({
  runInUndoTransaction: async (label: string, fn: () => Promise<unknown>) => {
    txLabels.push(label);
    return fn();
  },
}));

const mockCreate = vi.fn(async (params: Record<string, unknown>) => ({ id: "new", ...params }));
vi.mock("../../lib/slicerStore", () => ({
  createSlicerAsync: (params: Record<string, unknown>) => mockCreate(params),
}));

import { InsertSlicerDialog, NO_SLICER_SOURCES_TEXT, slicerParamsFor } from "../InsertSlicerDialog";
import { MODEL_SLICER_REACH } from "../../lib/insertSlicerPlan";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

const SALES = {
  tables: [
    { name: "Customers", columns: [{ name: "Region", dataType: "Utf8" }] },
    { name: "Sales", columns: [{ name: "Amount", dataType: "Float64" }] },
  ],
  measures: [{ name: "Total" }],
  relationships: [],
};

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  txLabels.length = 0;
  connections = [{ id: "c1", name: "Sales" }];
  models = { c1: SALES };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

async function open(data?: Record<string, unknown>): Promise<void> {
  await act(async () => {
    root.render(<InsertSlicerDialog isOpen onClose={onClose} data={data} />);
  });
  // Let loadDataSources' awaits settle.
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function checkboxFor(label: string): HTMLInputElement {
  const row = Array.from(container.querySelectorAll("label")).find((l) => l.textContent?.includes(label));
  const box = row?.querySelector("input[type=checkbox]") as HTMLInputElement | null;
  if (!box) throw new Error(`no checkbox for "${label}"`);
  return box;
}

function okButton(): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "OK");
  if (!btn) throw new Error("no OK button");
  return btn;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Insert Slicers with only a model", () => {
  it("offers the model, says what it reaches, and creates a MODEL slicer -- no pivot rebuild", async () => {
    await open();

    expect(container.textContent).not.toContain(NO_SLICER_SOURCES_TEXT);
    const options = Array.from(container.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toContain("Sales (Model)");
    // The only source is auto-selected, and the dialog names what it reaches.
    expect(container.querySelector('[data-testid="model-slicer-reach"]')?.textContent).toBe(MODEL_SLICER_REACH);

    await act(async () => {
      checkboxFor("Region").click();
    });
    await act(async () => {
      okButton().click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0]).toMatchObject({
      name: "Region",
      sheetIndex: 2,
      sourceType: "biConnection",
      cacheSourceId: "c1",
      fieldName: "Customers.Region",
      connectedSources: [{ sourceType: "biConnection", sourceId: "c1" }],
    });
    expect(mockUpdateBiPivotFields).not.toHaveBeenCalled();
    expect(txLabels).toEqual(["Insert Slicer"]);
    expect(onClose).toHaveBeenCalled();
  });

  it("a connection whose model is not loaded is not offered; with nothing else the empty state names models too", async () => {
    models = {};
    await open();
    expect(container.textContent).toContain(NO_SLICER_SOURCES_TEXT);
    expect(NO_SLICER_SOURCES_TEXT).toMatch(/models/);
  });
});

describe("slicerParamsFor (pure)", () => {
  it("names a model slicer by its COLUMN, split against the model's table names", () => {
    const source = {
      type: "biConnection" as const,
      id: "c9",
      name: "Warehouse",
      sheetIndex: null,
      sheetName: null,
      fields: ["BI.dim_customer.full.name"],
      biModel: {
        tables: [{ name: "BI.dim_customer", columns: [{ name: "full.name", dataType: "Utf8", isNumeric: false }] }],
        measures: [],
      },
    };
    expect(slicerParamsFor(source, "BI.dim_customer.full.name")).toEqual({
      name: "full.name",
      sourceType: "biConnection",
      cacheSourceId: "c9",
      fieldName: "BI.dim_customer.full.name",
      connectedSources: [{ sourceType: "biConnection", sourceId: "c9" }],
    });
  });

  it("a table source keeps the column name as it is", () => {
    const source = { type: "table" as const, id: "t1", name: "T", sheetIndex: 0, sheetName: "Data", fields: ["No. of items"] };
    expect(slicerParamsFor(source, "No. of items")).toMatchObject({ name: "No. of items", sourceType: "table" });
  });
});
