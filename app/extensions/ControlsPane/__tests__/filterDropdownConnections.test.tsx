//! FILENAME: app/extensions/ControlsPane/__tests__/filterDropdownConnections.test.tsx
// PURPOSE: Report Connections on a ribbon filter: unticking a pivot and
//          pressing Save takes the filter off THAT column of that pivot --
//          named by its "Table.Column" key, never by a field index guessed here.
//
// The defect: FilterDropdown kept its own copy of a field-index lookup (exact
// name, else the text after the LAST dot) and cleared the disconnected pivot
// with `clear_pivot_filter { fieldIndex }`. A BI pivot's cache names are BARE,
// so a filter on "Customers.Region" matched the first "Region" in the cache --
// Stores.Region on the pivot's Rows -- and wiped the user's own row filter on
// it, with no undo. The clear now goes through the bridge by model key, where
// the Pivot owner resolves the column and a pivot without it is left alone.
//
// The real bridge runs here; only its backend is a double (every invoke
// returns a Promise, the Tauri shape).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SurfaceLayoutProvider, bandLayout } from "@api/layout";

interface Call {
  cmd: string;
  args: Record<string, unknown> | undefined;
}

const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: Record<string, unknown> | undefined }>,
  updateFilterAsync: vi.fn(),
}));

vi.mock("@api", () => ({
  emitAppEvent: vi.fn(),
  AppEvents: { GRID_REFRESH: "app:grid-refresh" },
  getSheets: async () => ({ sheets: [{ index: 0, name: "Report" }] }),
}));
vi.mock("@api/pivotNotices", () => ({ surfacePivotNotices: vi.fn() }));
vi.mock("@api/objectGeometry", () => ({
  runInUndoTransaction: async (_label: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../lib/filterPaneBackend", () => ({
  filterPaneBackend: {
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      mocks.calls.push({ cmd, args });
      if (cmd === "get_pivot_hierarchies") {
        // The pivot's cache: Stores.Region on Rows, under its BARE cache name.
        return Promise.resolve({ hierarchies: [{ index: 0, name: "Region" }, { index: 1, name: "Revenue" }], biModel: {} });
      }
      return Promise.resolve({ pivotId: (args as { request?: { pivotId?: string } })?.request?.pivotId });
    },
  },
}));
vi.mock("../lib/filterPaneStore", () => ({
  updateFilterAsync: mocks.updateFilterAsync,
  updateFilterSelectionAsync: vi.fn(),
  getAllFilters: () => [],
  getConnectionName: () => "Sales model",
}));
vi.mock("../lib/filterPaneApi", () => ({
  getAllSlicers: async () => [],
  getPivotsForBiConnection: async () => [{ id: "P", name: "Region pivot", sheetIndex: 0 }],
}));

import { FilterDropdown } from "../components/FilterDropdown";

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

async function clickAsync(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

function button(text: string): HTMLButtonElement {
  const b = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (x) => x.textContent?.trim() === text,
  );
  if (!b) throw new Error(`no "${text}" button`);
  return b;
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  mocks.calls.length = 0;
  // The filter after the edit: manual, connected to nothing, no selection
  // (so Save re-applies nothing and only the disconnect clear is under test).
  mocks.updateFilterAsync.mockReset().mockResolvedValue({ id: "f1", selectedItems: null });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("Report Connections: disconnecting a pivot", () => {
  it("clears the filter's column on that pivot BY MODEL KEY -- never by a field index found by a bare name", async () => {
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    act(() => {
      root.render(
        <SurfaceLayoutProvider value={bandLayout()}>
          <FilterDropdown
            filterId="f1"
            fieldName="Customers.Region"
            items={[{ value: "East", selected: true, hasData: true }]}
            selectedItems={["East"]}
            anchorEl={anchor}
            onApply={() => undefined}
            onClose={() => undefined}
            onDelete={() => undefined}
            connectionId="c1"
            connectionMode="manual"
            crossFilterTargets={[]}
            crossFilterSlicerTargets={[]}
            advancedFilter={null}
            fieldDataType="text"
            connectedPivots={["P"]}
            connectedSheets={[]}
            hideNoData={false}
            indicateNoData={true}
            sortNoDataLast={true}
            showSelectAll={false}
            singleSelect={false}
            filterLevel={1}
          />
        </SurfaceLayoutProvider>,
      );
    });
    await flush();

    await clickAsync(button("Connections"));
    await flush();
    // Untick the pivot the filter is connected to, then Save.
    const pivotRow = Array.from(document.querySelectorAll("label")).find((l) => l.textContent?.includes("Region pivot"));
    expect(pivotRow, "the connected pivot is listed").toBeTruthy();
    const box = pivotRow!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box.checked).toBe(true);
    await clickAsync(box);
    await clickAsync(button("Save"));
    await flush();

    const clears = mocks.calls.filter((c: Call) => c.cmd === "clear_pivot_filter");
    expect(clears.map((c) => (c.args as { request: unknown }).request)).toEqual([
      { pivotId: "P", biFieldKey: "Customers.Region" },
    ]);
    // Never an index: with the old lookup this was { pivotId: "P", fieldIndex: 0 }
    // -- Stores.Region, the user's own row field.
    expect(
      mocks.calls.some((c: Call) => JSON.stringify(c.args ?? {}).includes("fieldIndex")),
    ).toBe(false);
    expect(mocks.updateFilterAsync).toHaveBeenCalledTimes(1);
  });
});
