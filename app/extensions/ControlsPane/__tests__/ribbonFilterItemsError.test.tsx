//! FILENAME: app/extensions/ControlsPane/__tests__/ribbonFilterItemsError.test.tsx
// PURPOSE: A ribbon filter whose values cannot be loaded SAYS so (P1 S5, G2-A).
//
//          The defect: a filter added from Controls on a model whose table
//          names contain dots ("BI.dim_date") split its key at the first dot,
//          sent table "BI" to the engine, and the engine refused. The store
//          only console.error'ed it, the card marked the items loaded anyway
//          (so it never retried), and the checklist printed "No matching
//          values" -- a failure that read as an empty column.
//
//          Here the REAL card, checklist and store run; only the backend
//          wrappers (filterPaneApi) are doubles of the Tauri shape -- every
//          call returns a Promise and a refusal rejects with the command's
//          Err string.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SurfaceLayoutProvider, bandLayout } from "@api/layout";
import type { RibbonFilter } from "../lib/filterPaneTypes";

const mocks = vi.hoisted(() => ({
  filters: [] as unknown[],
  tables: ["BI.dim_date", "BI.dim_territory"] as string[],
  /** Queued results of bi_get_column_values: a string[] resolves, an Error rejects. */
  columnValues: [] as Array<string[] | Error>,
  /** Queued results of bi_get_column_available_values. */
  availableValues: [] as Array<string[] | Error>,
  getBiColumnValues: vi.fn(),
  getBiColumnAvailableValues: vi.fn(),
}));

vi.mock("@api", async () => {
  const icons = await vi.importActual<typeof import("@api/ribbonIcons")>("@api/ribbonIcons");
  return {
    RibbonIcon: icons.RibbonIcon,
    emitAppEvent: vi.fn(),
    AppEvents: { GRID_REFRESH: "app:grid-refresh" },
    getSheets: async () => ({ sheets: [{ index: 0, name: "Sheet1" }] }),
  };
});
vi.mock("../lib/filterPaneFilterBridge", () => ({
  applyRibbonFilter: vi.fn(async () => undefined),
  clearRibbonFilter: vi.fn(async () => undefined),
  clearModelColumnOnPivots: vi.fn(async () => undefined),
  reportRibbonFilterFailures: vi.fn(),
  resolveTargetPivots: vi.fn(async () => []),
  runRibbonFilterSelectionGesture: vi.fn(),
}));

function next(queue: Array<string[] | Error>): Promise<string[]> {
  const result = queue.shift();
  if (result === undefined) return Promise.reject("test: no queued result");
  return result instanceof Error ? Promise.reject(result.message) : Promise.resolve(result);
}

vi.mock("../lib/filterPaneApi", () => ({
  getAllRibbonFilters: async () => mocks.filters,
  getBiConnections: async () => [
    { id: "c1", name: "AdventureWorks", description: "", isConnected: true, modelPath: null },
  ],
  getBiModelInfo: async () => ({
    tables: mocks.tables.map((name) => ({ name, columns: [] })),
    measures: [],
    relationships: [],
  }),
  getBiColumnValues: (...a: unknown[]) => {
    mocks.getBiColumnValues(...a);
    // The backend answers MEMBERS (P2): key = label for plain text.
    return next(mocks.columnValues).then((keys) => keys.map((key) => ({ key, label: key })));
  },
  getBiColumnAvailableValues: (...a: unknown[]) => {
    mocks.getBiColumnAvailableValues(...a);
    return next(mocks.availableValues);
  },
  recalcControlDependents: async () => [],
  getAllSlicers: async () => [],
  getPivotsForBiConnection: async () => [],
}));

import { RibbonFilterCard } from "../components/RibbonFilterCard";
import { FilterPaneEvents } from "../lib/filterPaneEvents";
import {
  clearCache,
  getFilterLoadAttempts,
  refreshCache,
} from "../lib/filterPaneStore";

// ============================================================================
// Fixtures and helpers
// ============================================================================

function filterFixture(overrides: Partial<RibbonFilter> = {}): RibbonFilter {
  return {
    id: "f-year",
    name: "Year",
    connectionId: "c1",
    fieldName: "BI.dim_date.year",
    fieldDataType: "text",
    connectionMode: "workbook",
    connectedPivots: [],
    connectedSheets: [],
    displayMode: "dropdown" as RibbonFilter["displayMode"],
    selectedItems: null,
    dependentFilters: [],
    dependentSlicers: [],
    advancedFilter: null,
    hideNoData: false,
    indicateNoData: true,
    sortNoDataLast: true,
    showSelectAll: false,
    singleSelect: false,
    order: 0,
    buttonColumns: 1,
    buttonRows: 1,
    filterLevel: 1,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function seed(filters: RibbonFilter[]): Promise<void> {
  mocks.filters = filters;
  await refreshCache();
}

function render(filter: RibbonFilter): void {
  act(() => {
    root.render(
      <SurfaceLayoutProvider value={bandLayout()}>
        <RibbonFilterCard filter={filter} />
      </SurfaceLayoutProvider>,
    );
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

function query(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function openButton(): HTMLElement {
  const el = container.querySelector<HTMLElement>(
    '[data-testid="controls-pane-filter-open"][data-filter-id="f-year"]',
  );
  if (!el) throw new Error("no open button for f-year");
  return el;
}

function itemValues(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="controls-pane-filter-item"]'),
  ).map((el) => el.getAttribute("data-value") ?? "");
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  clearCache();
  mocks.tables = ["BI.dim_date", "BI.dim_territory"];
  mocks.columnValues = [];
  mocks.availableValues = [];
  mocks.getBiColumnValues.mockClear();
  mocks.getBiColumnAvailableValues.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

// ============================================================================
// Tests
// ============================================================================

describe("a ribbon filter whose values cannot be loaded says so", () => {
  it("the card root and its open button carry the filter id", async () => {
    const filter = filterFixture();
    await seed([filter]);
    render(filter);
    expect(container.querySelector('[data-pane-card="filter"]')?.getAttribute("data-filter-id")).toBe(
      "f-year",
    );
    expect(openButton()).toBeTruthy();
  });

  it("a dotted table name loads its values: the engine is asked for table 'BI.dim_date'", async () => {
    const filter = filterFixture();
    await seed([filter]);
    mocks.columnValues.push(["2023", "2024"]);
    render(filter);

    await click(openButton());

    expect(mocks.getBiColumnValues).toHaveBeenCalledWith("c1", "BI.dim_date", "year");
    expect(itemValues()).toEqual(["2023", "2024"]);
    expect(query("controls-pane-filter-items-error")).toBeNull();
    const item = document.querySelector('[data-testid="controls-pane-filter-item"][data-value="2024"]');
    expect(item?.getAttribute("data-has-data")).toBe("true");
  });

  it("a failed load shows the alert (the whole field key named), never 'No matching values'; Retry loads", async () => {
    const filter = filterFixture();
    await seed([filter]);
    mocks.columnValues.push(new Error("Table 'BI' not found"));
    render(filter);

    await click(openButton());

    const alert = query("controls-pane-filter-items-error");
    expect(alert).not.toBeNull();
    expect(alert!.getAttribute("role")).toBe("alert");
    expect(alert!.textContent).toBe(
      "Could not load the values of BI.dim_date.year: Table 'BI' not found",
    );
    const dropdown = query("controls-pane-filter-dropdown")!;
    expect(dropdown.textContent).not.toContain("No matching values");
    expect(itemValues()).toEqual([]);
    expect(getFilterLoadAttempts("f-year")).toBe(1);

    // Retry runs the load again, inside the open checklist.
    mocks.columnValues.push(["2023", "2024"]);
    await click(query("controls-pane-filter-items-retry")!);

    expect(getFilterLoadAttempts("f-year")).toBe(2);
    expect(query("controls-pane-filter-items-error")).toBeNull();
    expect(itemValues()).toEqual(["2023", "2024"]);
    // "(All)": the values that arrived after the checklist opened are ticked,
    // so OK would not apply an empty selection the user never chose.
    const boxes = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        '[data-testid="controls-pane-filter-item"] input[type="checkbox"]',
      ),
    );
    expect(boxes.map((b) => b.checked)).toEqual([true, true]);
  });

  it("a failed load is not marked loaded: the next open fetches again", async () => {
    const filter = filterFixture();
    await seed([filter]);
    mocks.columnValues.push(new Error("engine busy"));
    render(filter);

    await click(openButton()); // open: fails
    await click(openButton()); // close
    expect(query("controls-pane-filter-dropdown")).toBeNull();

    mocks.columnValues.push(["2024"]);
    await click(openButton()); // open again: re-fetches

    expect(mocks.getBiColumnValues).toHaveBeenCalledTimes(2);
    expect(getFilterLoadAttempts("f-year")).toBe(2);
    expect(itemValues()).toEqual(["2024"]);
    expect(query("controls-pane-filter-items-error")).toBeNull();
  });

  it("a sibling's selection change whose refresh FAILS drops the stale values and shows the alert", async () => {
    const filter = filterFixture();
    await seed([filter]);
    mocks.columnValues.push(["2023", "2024"]);
    render(filter);
    await click(openButton());
    expect(itemValues()).toEqual(["2023", "2024"]);

    mocks.columnValues.push(new Error("connection lost"));
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(FilterPaneEvents.FILTER_SELECTION_CHANGED, {
          detail: { filterId: "f-territory", selectedItems: ["Europe"] },
        }),
      );
    });
    await settle();

    expect(itemValues()).toEqual([]);
    expect(query("controls-pane-filter-items-error")?.textContent).toBe(
      "Could not load the values of BI.dim_date.year: connection lost",
    );
  });

  it("a failed dependent-filter narrowing keeps the values and says why above the list", async () => {
    const filter = filterFixture();
    const sibling = filterFixture({
      id: "f-territory",
      name: "Territory",
      fieldName: "BI.dim_territory.territorygroup",
      selectedItems: ["Europe"],
      dependentFilters: ["f-year"],
      order: 1,
    });
    await seed([filter, sibling]);
    mocks.columnValues.push(["2023", "2024"]);
    mocks.availableValues.push(new Error("no relationship path"));
    render(filter);

    await click(openButton());

    expect(mocks.getBiColumnAvailableValues).toHaveBeenCalledWith("c1", "BI.dim_date", "year", [
      { table: "BI.dim_territory", column: "territorygroup", values: ["Europe"] },
    ]);
    expect(query("controls-pane-filter-narrowing-error")?.textContent).toBe(
      "Values are not narrowed by dependent filters: no relationship path",
    );
    expect(itemValues()).toEqual(["2023", "2024"]);
    expect(query("controls-pane-filter-items-error")).toBeNull();
  });
});
