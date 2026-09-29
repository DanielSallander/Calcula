//! FILENAME: app/extensions/ControlsPane/__tests__/filterDropdownOverwrite.test.tsx
// PURPOSE: S2 (BUG-0200): "the FilterDropdown level-change and connections
//          saves do not ask on overwrite". Both saves are now ONE undo step
//          (the ribbon backend's settings update joins it instead of
//          committing its own) and a save whose pivots grew over the user's
//          cells is asked about ONCE after the step committed, through
//          `@api/pivotOverwrite` (Tauri-shaped `confirmAsync` double, failing
//          closed); a decline hands back the save's tokens.
//
// The real FilterDropdown, bridge and @api/pivotOverwrite run here; the
// backend and the undo transaction are doubles.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SurfaceLayoutProvider, bandLayout } from "@api/layout";

const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: Record<string, unknown> | undefined }>,
  updateFilterAsync: vi.fn(),
  confirm: vi.fn((..._a: unknown[]): Promise<boolean> => Promise.resolve(false)),
  undo: vi.fn((..._a: unknown[]) => Promise.resolve({ stepsUndone: 1, complete: true, refreshDomains: [] })),
  order: [] as string[],
}));

vi.mock("@api", () => ({
  emitAppEvent: vi.fn(),
  AppEvents: { GRID_REFRESH: "app:grid-refresh" },
  getSheets: async () => ({ sheets: [{ index: 0, name: "Report" }] }),
}));
vi.mock("@api/pivotNotices", () => ({ surfacePivotNotices: vi.fn() }));
vi.mock("@api/notifications", () => ({ showToast: vi.fn() }));
vi.mock("../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/lib/tauri-api")>()),
  getUndoState: async () => ({ undoSeqs: [], transactionOpen: false }),
}));
vi.mock("@api/objectGeometry", () => {
  let depth = 0;
  return {
    isUndoTransactionOpen: () => depth > 0,
    undoCommitsSettled: () => Promise.resolve(),
    runInUndoTransaction: async (_label: string, fn: () => Promise<unknown>) => {
      const opener = depth === 0;
      depth++;
      try {
        return await fn();
      } finally {
        depth--;
        if (opener) mocks.order.push("commit");
      }
    },
    // The same step as a handle: the outermost opens it, a nested one joins.
    openUndoTransaction: (_label: string) => {
      const opener = depth === 0;
      depth++;
      let closed = false;
      return {
        joined: !opener,
        run: async (fn: () => Promise<unknown>) => fn(),
        commit: async () => {
          if (closed) return;
          closed = true;
          depth--;
          if (opener) mocks.order.push("commit");
        },
        openedBackend: async () => opener,
      };
    },
  };
});
vi.mock("@api/dialogs", () => ({
  confirmAsync: (...a: unknown[]) => {
    mocks.order.push("ask");
    return mocks.confirm(...a);
  },
}));
vi.mock("@api/backend", () => ({ undoPivotOverwrite: (...a: unknown[]) => mocks.undo(...a) }));
vi.mock("../lib/filterPaneBackend", () => ({
  filterPaneBackend: {
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      mocks.calls.push({ cmd, args });
      const pivotId = (args as { request?: { pivotId?: string } })?.request?.pivotId;
      // Every pivot write grows its pivot over 3 of the user's cells.
      return Promise.resolve({ pivotId, overwrittenCellCount: 3, overwriteToken: 61 });
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
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

async function clickAsync(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

function button(text: string): HTMLButtonElement {
  const b = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (x) => x.textContent?.trim() === text,
  );
  if (!b) throw new Error(`no "${text}" button`);
  return b;
}

function render(connectedPivots: string[]): void {
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
          connectedPivots={connectedPivots}
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
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  mocks.calls.length = 0;
  mocks.order.length = 0;
  mocks.confirm.mockReset().mockImplementation(() => Promise.resolve(false));
  mocks.undo.mockClear();
  mocks.updateFilterAsync.mockReset().mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({
    id: "f1",
    name: "Region",
    fieldName: "Customers.Region",
    selectedItems: ["East"],
    connectionMode: "manual",
    connectedPivots: (updates.connectedPivots as string[] | undefined) ?? ["P"],
    connectedSheets: [],
    filterLevel: (updates.filterLevel as number | undefined) ?? 1,
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("the FilterDropdown saves ask about an overwrite ONCE, after their ONE step", () => {
  it("a Connections Save that grows a pivot over the user's cells asks once; a decline hands back its token", async () => {
    render([]);
    await flush();
    await clickAsync(button("Connections"));
    await flush();
    // Tick the pivot: the Save applies the active selection to it.
    const pivotRow = Array.from(document.querySelectorAll("label")).find((l) => l.textContent?.includes("Region pivot"));
    const box = pivotRow!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await clickAsync(box);
    await clickAsync(button("Save"));
    await flush();

    expect(mocks.calls.some((c) => c.cmd === "apply_pivot_filter")).toBe(true);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.confirm.mock.calls[0][0]).toContain("3 cells");
    expect(mocks.order.indexOf("ask")).toBeGreaterThan(mocks.order.indexOf("commit"));
    expect(mocks.undo).toHaveBeenCalledWith("P", [61]);
  });

  it("a Settings Save whose level change re-routes the selection over the user's cells asks once", async () => {
    render(["P"]);
    await flush();
    await clickAsync(button("Settings"));
    await flush();
    const level = document.querySelector<HTMLSelectElement>('select[aria-label="Filter level"]')!;
    await act(async () => {
      level.value = "2";
      level.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await clickAsync(button("Save"));
    await flush();

    expect(mocks.calls.some((c) => c.cmd === "apply_pivot_filter")).toBe(true);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.undo).toHaveBeenCalledWith("P", [61]);
  });
});
