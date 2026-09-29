//! FILENAME: app/extensions/Pivot/components/__tests__/changeDataSourceDialog.test.tsx
// PURPOSE: Wave D fix-up -- the Change Data Source dialog decides "this pivot
//          reads a data model" from the BACKEND (`get_pivot_hierarchies`'
//          `biModel`), never from the source text. The old text pattern read a
//          quoted sheet ('Sales Data'!A1:D10), a sheet whose name starts with a
//          digit (2024!A1:D10) and a table name (Table1) as a BI model: the
//          dialog showed the read-only "connected to a BI model" note and OK
//          only closed it.
// CONTEXT: @testing-library/react is not installed; react-dom + `act`, as the
//          sibling component tests do.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  getPivotTableInfo: vi.fn(),
  getPivotHierarchies: vi.fn(),
  changePivotDataSource: vi.fn(),
}));

vi.mock("@api/dialogWindow", () => ({
  useDialogWindow: () => ({ ref: { current: null }, style: {}, onHeaderMouseDown: () => {}, resizeHandles: null }),
}));
vi.mock("../../lib/pivot-api", () => ({
  getPivotTableInfo: (...a: unknown[]) => h.getPivotTableInfo(...a),
  getPivotHierarchies: (...a: unknown[]) => h.getPivotHierarchies(...a),
  changePivotDataSource: (...a: unknown[]) => h.changePivotDataSource(...a),
}));

import { ChangeDataSourceDialog } from "../ChangeDataSourceDialog";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const RANGE_HIERARCHIES = {
  hierarchies: [],
  rowHierarchies: [],
  columnHierarchies: [],
  dataHierarchies: [],
  filterHierarchies: [],
};
const BI_HIERARCHIES = { ...RANGE_HIERARCHIES, biModel: { connectionId: "c-1", tables: [], measures: [] } };

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
const onChanged = vi.fn();

beforeEach(() => {
  for (const f of [h.getPivotTableInfo, h.getPivotHierarchies, h.changePivotDataSource, onClose, onChanged]) {
    f.mockReset();
  }
  h.changePivotDataSource.mockResolvedValue({ pivotId: "pv-1" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function open(sourceRange: string, hierarchies: unknown): Promise<void> {
  h.getPivotTableInfo.mockResolvedValue({ id: "pv-1", name: "PivotTable1", sourceRange });
  h.getPivotHierarchies.mockResolvedValue(hierarchies);
  act(() => {
    root.render(<ChangeDataSourceDialog isOpen onClose={onClose} pivotId="pv-1" onChanged={onChanged} />);
  });
  await flush();
}

function okButton(): HTMLButtonElement {
  const ok = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "OK");
  if (!ok) throw new Error("no OK button");
  return ok as HTMLButtonElement;
}

describe("ChangeDataSourceDialog: a data-model pivot is the backend's answer", () => {
  it.each(["'Sales Data'!A1:D10", "2024!A1:D10", "Table1", "Sheet1!A1:D10"])(
    "a RANGE pivot sourced from %s offers an editable range and OK applies it",
    async (sourceRange) => {
      await open(sourceRange, RANGE_HIERARCHIES);
      const input = container.querySelector("input");
      expect(input, `an editable Table/Range box for ${sourceRange}`).not.toBeNull();
      expect(input!.value).toBe(sourceRange);
      expect(container.textContent).not.toContain("connected to a BI model");

      await act(async () => {
        okButton().click();
      });
      await flush();
      expect(h.changePivotDataSource).toHaveBeenCalledTimes(1);
      expect(h.changePivotDataSource).toHaveBeenCalledWith({ pivotId: "pv-1", sourceRange });
      expect(onChanged).toHaveBeenCalledTimes(1);
    },
  );

  it("a DATA-MODEL pivot shows its source read-only and OK only closes", async () => {
    await open("Sales", BI_HIERARCHIES);
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).toContain("connected to a BI model");
    await act(async () => {
      okButton().click();
    });
    await flush();
    expect(h.changePivotDataSource).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
