//! FILENAME: app/extensions/Pivot/handlers/__tests__/pivotPaneSeeding.test.ts
// PURPOSE: The field-list pane is seeded from the pivot's field configuration
//          with each row/column chip's hidden items -- on BOTH seeding paths.
//
//          A calculation group's item subset lives ONLY on its chip: the
//          editor sends the chip's list, and the backend reads an absent list
//          on a calc-group placement as "every item". The hierarchy path
//          (`reconstitute`, taken whenever a hierarchy is placed) seeded the
//          non-hierarchy chips WITHOUT hidden items, so the first field-list
//          edit of such a pivot silently put every calculation item back. A
//          real field's list is seeded too, for DISPLAY (the DSL's NOT IN);
//          the editor never echoes it (biFieldsRequest.ts).

import { describe, it, expect, vi } from "vitest";
import type { PivotRegionInfo } from "@api/pivot";

vi.mock("@api", () => ({
  openTaskPane: vi.fn(),
  closeTaskPane: vi.fn(),
  getTaskPaneManuallyClosed: () => [] as string[],
  addTaskPaneContextKey: vi.fn(),
  removeTaskPaneContextKey: vi.fn(),
  registerPanel: vi.fn(),
  unregisterPanel: vi.fn(),
  emitAppEvent: vi.fn(),
}));
vi.mock("@api/pivot", () => ({ pivot: { getAtCell: vi.fn(async () => null) } }));
vi.mock("../../manifest", () => ({
  PIVOT_PANE_ID: "pivot-pane",
  PIVOT_ANALYZE_TAB_ID: "pivot-analyze",
  PIVOT_DESIGN_TAB_ID: "pivot-design",
  PivotAnalyzePanelDefinition: { id: "pivot-analyze", title: "Analyze" },
  PivotDesignPanelDefinition: { id: "pivot-design", title: "Design" },
}));

import { buildPivotPaneData } from "../selectionHandler";

const zone = (name: string, hiddenItems?: string[]) => ({
  sourceIndex: 0,
  name,
  isNumeric: false,
  ...(hiddenItems ? { hiddenItems } : {}),
});

function info(withHierarchy: boolean): PivotRegionInfo {
  return {
    pivotId: "pv",
    isEmpty: false,
    sourceFields: [],
    filterZones: [],
    biModel: {
      tables: [{ name: "Geo", columns: [] }, { name: "Date", columns: [] }],
      measures: [],
      connectionId: "c1",
      calculationGroups: [{ name: "Time Intelligence", items: [{ name: "Current" }, { name: "YoY" }] }],
    },
    fieldConfiguration: {
      rowFields: [
        // Hierarchy levels first (covered by hierarchyConfigs when present).
        zone("Date.Year"),
        zone("Date.Month"),
        zone("Time Intelligence", ["YoY"]),
        zone("Geo.Region", ["West"]),
      ],
      columnFields: [zone("Geo.City", ["Oslo"])],
      valueFields: [],
      filterFields: [],
      layout: {},
      hierarchyConfigs: withHierarchy
        ? [{ name: "Calendar", fieldStart: 0, fieldCount: 2, isRow: true }]
        : [],
    },
  } as unknown as PivotRegionInfo;
}

describe("buildPivotPaneData seeds row/column chips WITH their hidden items", () => {
  it("on the hierarchy path: a calculation group keeps its item subset, a real field its display list", () => {
    const pane = buildPivotPaneData(info(true));
    const rows = pane.initialRows ?? [];
    expect(rows.map((f) => f.name)).toEqual(["Date.__hierarchy__.Calendar", "Time Intelligence", "Geo.Region"]);
    expect(rows.find((f) => f.name === "Time Intelligence")!.hiddenItems).toEqual(["YoY"]);
    expect(rows.find((f) => f.name === "Geo.Region")!.hiddenItems).toEqual(["West"]);
    // Columns take the same path when a hierarchy is placed anywhere.
    expect((pane.initialColumns ?? [])[0].hiddenItems).toEqual(["Oslo"]);
  });

  it("on the flat path (no hierarchy) -- the path that was already right", () => {
    const pane = buildPivotPaneData(info(false));
    const rows = pane.initialRows ?? [];
    expect(rows.find((f) => f.name === "Time Intelligence")!.hiddenItems).toEqual(["YoY"]);
    expect(rows.find((f) => f.name === "Geo.Region")!.hiddenItems).toEqual(["West"]);
  });
});
