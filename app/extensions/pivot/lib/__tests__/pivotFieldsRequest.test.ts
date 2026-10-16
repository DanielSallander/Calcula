//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotFieldsRequest.test.ts
// PURPOSE: The ONE fields-request recipe (lib/pivotFieldsRequest.ts) that the
//          field-list editor and the value-cell menu's headless edits share.
//          - Identity round trip: for a range pivot and a data-model pivot,
//            `buildPivotFieldsRequest` over `mergeCalculatedIntoValues(
//            buildPivotPaneData(info))` equals what the editor hook's
//            `buildUpdateRequest` produced BEFORE the builder was moved (the
//            literals below were captured from the unmoved hook on 2026-10-15,
//            WP-A S10) -- the move changed nothing.
//          - BUG-0465: for the range pivot WITH a calculated field interleaved
//            [Value 0, Calculated 0, Value 1], the unmoved hook answered
//            [V0, V1, C0] (it appended the calculated fields). The recipe now
//            answers the pivot's own order, and so does the editor's first
//            edit and a Design-tab (DSL) apply.
//          - `sendPivotFieldsUpdate`: a model pivot goes through
//            `buildBiUpdateRequest` + updateBiFields, a range pivot through
//            `rangeRequestWithHiddenItemEdits` + updateFields.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  bi: [] as unknown[],
  range: [] as unknown[],
}));

vi.mock("@api/pivot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/pivot")>()),
  pivot: {
    updateBiFields: vi.fn((req: unknown) => {
      h.bi.push(req);
      return Promise.resolve({});
    }),
    updateFields: vi.fn((req: unknown) => {
      h.range.push(req);
      return Promise.resolve({});
    }),
    getAtCell: vi.fn(() => Promise.resolve(null)),
  },
}));

import {
  buildPivotFieldsRequest,
  mergeCalculatedIntoValues,
  renameCalculatedReferences,
  replaceValueField,
  sendPivotFieldsUpdate,
  valueFieldRequestName,
} from "../pivotFieldsRequest";
import { buildPivotPaneData } from "../../handlers/selectionHandler";
import { usePivotEditorState } from "../../components/usePivotEditorState";
import { CALC_GROUP_TABLE, type UpdatePivotFieldsRequest, type ZoneField } from "../../components/types";
import { rangeInfo, rangeWithCalculatedInfo, biInfo } from "./fixtures/pivotFieldsFixtures";
import type { PivotRegionInfo } from "@api/pivot";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** What the recipe builds for an info, with the editor's own layout. */
function recipe(info: PivotRegionInfo) {
  const pane = buildPivotPaneData(info);
  return buildPivotFieldsRequest(
    pane.pivotId,
    {
      rows: pane.initialRows,
      columns: pane.initialColumns,
      values: mergeCalculatedIntoValues(pane.initialValues, pane.initialCalculatedFields, pane.initialValueColumnOrder),
      filters: pane.initialFilters,
    },
    pane.initialLayout,
  );
}

// ---------------------------------------------------------------------------
// Captured from the UNMOVED usePivotEditorState.buildUpdateRequest.
// ---------------------------------------------------------------------------

const CAPTURED_RANGE = {
  pivotId: "7",
  rowFields: [{ sourceIndex: 0, name: "Region", hiddenItems: ["West"] }],
  columnFields: [{ sourceIndex: 1, name: "Quarter" }],
  valueFields: [
    {
      sourceIndex: 2,
      name: "Sum of Sales",
      aggregation: "sum",
      numberFormat: "#,##0",
      showValuesAs: "running_total",
      showAs: { calculation: "runningTotal", baseField: "Region" },
    },
    { sourceIndex: 3, name: "Count of Units", aggregation: "count" },
  ],
  filterFields: [{ sourceIndex: 4, name: "Year", hiddenItems: ["2020"] }],
  layout: {
    showRowGrandTotals: true,
    showColumnGrandTotals: false,
    reportLayout: "tabular",
    repeatRowLabels: true,
    showEmptyRows: false,
    showEmptyCols: false,
    valuesPosition: "columns",
  },
  valueColumnOrder: [
    { type: "value", index: 0 },
    { type: "value", index: 1 },
  ],
};

const CAPTURED_BI = {
  pivotId: "9",
  rowFields: [
    { sourceIndex: -3, name: "Calendar.__hierarchy__.Calendar" },
    { sourceIndex: -1, name: "Time Intelligence", hiddenItems: ["YTD"] },
  ],
  columnFields: [{ sourceIndex: -1, name: "Product.Category" }],
  valueFields: [
    { sourceIndex: -1, name: "[Revenue]", aggregation: "sum", customName: "Total Revenue" },
    { sourceIndex: -1, name: "[Cost]", aggregation: "sum", customName: "[Cost]" },
  ],
  filterFields: [{ sourceIndex: -1, name: "Geo.Country", hiddenItems: ["Mars"] }],
  layout: { showRowGrandTotals: true, showColumnGrandTotals: true, reportLayout: "compact" },
  valueColumnOrder: [
    { type: "value", index: 0 },
    { type: "value", index: 1 },
  ],
};

/** The unmoved hook's answer for the interleaved fixture: the calculated field moved to the END. */
const CAPTURED_CALC_ORDER_BEFORE = [
  { type: "value", index: 0 },
  { type: "value", index: 1 },
  { type: "calculated", index: 0 },
];

const INTERLEAVED = [
  { type: "value", index: 0 },
  { type: "calculated", index: 0 },
  { type: "value", index: 1 },
];

beforeEach(() => {
  h.bi = [];
  h.range = [];
});

describe("identity round trip (the move changed nothing)", () => {
  it("a range pivot builds exactly what the editor sent before the move", () => {
    expect(recipe(rangeInfo()).request).toEqual(CAPTURED_RANGE);
  });

  it("a data-model pivot (hierarchy, calculation group, hidden items) builds exactly what the editor sent", () => {
    expect(recipe(biInfo()).request).toEqual(CAPTURED_BI);
  });

  it("the returned calculated fields and order are the request's own", () => {
    const built = recipe(rangeInfo());
    expect(built.calculatedFields).toBeUndefined();
    expect(built.valueColumnOrder).toEqual(CAPTURED_RANGE.valueColumnOrder);
  });

  it("no layout given (a headless edit): the request carries none, the rest is unchanged", () => {
    const pane = buildPivotPaneData(rangeInfo());
    const { request } = buildPivotFieldsRequest(pane.pivotId, {
      rows: pane.initialRows,
      columns: pane.initialColumns,
      values: pane.initialValues,
      filters: pane.initialFilters,
    });
    expect(request.layout).toBeUndefined();
    expect({ ...request, layout: CAPTURED_RANGE.layout }).toEqual(CAPTURED_RANGE);
  });
});

describe("BUG-0465: a calculated field keeps its place", () => {
  it("the interleaved fixture is sent back [V0, C0, V1] with its calculated field (the unmoved hook sent [V0, V1, C0])", () => {
    const built = recipe(rangeWithCalculatedInfo());
    expect(built.request.valueColumnOrder).toEqual(INTERLEAVED);
    expect(built.request.valueColumnOrder).not.toEqual(CAPTURED_CALC_ORDER_BEFORE);
    expect(built.request.calculatedFields).toEqual([{ name: "Margin", formula: "='Sales'-'Units'", numberFormat: "0.0" }]);
    expect(built.request.valueFields?.map((v) => v.name)).toEqual(["Sum of Sales", "Sum of Units"]);
    expect(built.calculatedFields).toEqual(built.request.calculatedFields);
    expect(built.valueColumnOrder).toEqual(INTERLEAVED);
  });

  it("buildPivotPaneData carries the transported order to the editor", () => {
    expect(buildPivotPaneData(rangeWithCalculatedInfo()).initialValueColumnOrder).toEqual(INTERLEAVED);
    expect(buildPivotPaneData(rangeInfo()).initialValueColumnOrder).toBeUndefined();
  });
});

describe("mergeCalculatedIntoValues", () => {
  const v = (name: string): ZoneField => ({ sourceIndex: 1, name, isNumeric: true, aggregation: "sum" });
  const calc = [
    { name: "C0", formula: "=1" },
    { name: "C1", formula: "=2", numberFormat: "0%" },
  ];
  const names = (zone: ZoneField[]) => zone.map((z) => (z.isCalculated ? `calc:${z.name}` : z.name));

  it("with an empty or absent order appends the calculated fields after the values (the engine default)", () => {
    expect(names(mergeCalculatedIntoValues([v("A"), v("B")], calc, []))).toEqual(["A", "B", "calc:C0", "calc:C1"]);
    expect(names(mergeCalculatedIntoValues([v("A"), v("B")], calc, undefined))).toEqual(["A", "B", "calc:C0", "calc:C1"]);
    expect(names(mergeCalculatedIntoValues([v("A")], undefined, undefined))).toEqual(["A"]);
  });

  it("places each field by the order", () => {
    const merged = mergeCalculatedIntoValues([v("A"), v("B")], calc, [
      { type: "calculated", index: 1 },
      { type: "value", index: 1 },
      { type: "calculated", index: 0 },
      { type: "value", index: 0 },
    ]);
    expect(names(merged)).toEqual(["calc:C1", "B", "calc:C0", "A"]);
    expect(merged[0]).toEqual({
      sourceIndex: -2,
      name: "C1",
      isNumeric: true,
      isCalculated: true,
      customName: "C1",
      calculatedFormula: "=2",
      numberFormat: "0%",
    });
  });

  it("never loses a field: out-of-range and repeated entries are skipped, unnamed fields appended", () => {
    const merged = mergeCalculatedIntoValues([v("A"), v("B")], calc, [
      { type: "value", index: 1 },
      { type: "value", index: 1 },
      { type: "value", index: 9 },
      { type: "calculated", index: -1 },
      { type: "calculated", index: 1 },
    ]);
    expect(names(merged)).toEqual(["B", "calc:C1", "A", "calc:C0"]);
  });
});

describe("sendPivotFieldsUpdate", () => {
  it("a range pivot: updateFields, with no field's item filter echoed unless edited", async () => {
    const { request } = recipe(rangeInfo());
    await sendPivotFieldsUpdate(request, new Map([["Year", ["2021"]]]), null);
    expect(h.bi).toEqual([]);
    expect(h.range).toHaveLength(1);
    const sent = h.range[0] as UpdatePivotFieldsRequest;
    expect(sent.rowFields).toEqual([{ sourceIndex: 0, name: "Region" }]);
    expect(sent.rowFields?.[0]).not.toHaveProperty("hiddenItems");
    expect(sent.filterFields).toEqual([{ sourceIndex: 4, name: "Year", hiddenItems: ["2021"] }]);
    expect(sent.valueFields).toEqual(CAPTURED_RANGE.valueFields);
  });

  it("a model pivot: updateBiFields with the hierarchy, the calculation group's subset and the lookup set", async () => {
    const { request } = recipe(biInfo());
    await sendPivotFieldsUpdate(request, new Map(), {
      calcGroupNames: new Set(["Time Intelligence"]),
      biTableNames: ["Calendar", "Product", "Geo"],
      lookupColumns: new Set(["Product.Category"]),
    });
    expect(h.range).toEqual([]);
    expect(h.bi).toHaveLength(1);
    expect(h.bi[0]).toEqual({
      pivotId: "9",
      rowFields: [{ table: CALC_GROUP_TABLE, column: "Time Intelligence", hiddenItems: ["YTD"] }],
      columnFields: [{ table: "Product", column: "Category", isLookup: true }],
      valueFields: [
        { measureName: "Revenue", customName: "Total Revenue" },
        { measureName: "Cost", customName: "[Cost]" },
      ],
      filterFields: [{ table: "Geo", column: "Country", isLookup: false }],
      rowHierarchies: [{ table: "Calendar", hierarchy: "Calendar", expanded: [] }],
      layout: CAPTURED_BI.layout,
      lookupColumns: ["Product.Category"],
      valueColumnOrder: CAPTURED_BI.valueColumnOrder,
    });
    const filter = (h.bi[0] as { filterFields: object[] }).filterFields[0];
    expect(filter, "an unedited model filter is never echoed").not.toHaveProperty("hiddenItems");
  });

  it("rejects with the backend's error", async () => {
    const { pivot } = await import("@api/pivot");
    vi.mocked(pivot.updateFields).mockRejectedValueOnce(new Error("locked"));
    await expect(sendPivotFieldsUpdate(recipe(rangeInfo()).request, new Map(), null)).rejects.toThrow("locked");
  });
});

// ---------------------------------------------------------------------------
// The editor hook, through the shared recipe.
// ---------------------------------------------------------------------------

describe("the field-list editor keeps the interleaving (BUG-0465)", () => {
  let root: Root | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
  });

  function mountEditor(info: PivotRegionInfo) {
    const pane = buildPivotPaneData(info);
    const sent: UpdatePivotFieldsRequest[] = [];
    let current: ReturnType<typeof usePivotEditorState> | null = null;
    function Probe(): null {
      current = usePivotEditorState({
        pivotId: pane.pivotId,
        sourceFields: pane.sourceFields,
        initialRows: pane.initialRows,
        initialColumns: pane.initialColumns,
        initialValues: pane.initialValues,
        initialFilters: pane.initialFilters,
        initialLayout: pane.initialLayout,
        initialCalculatedFields: pane.initialCalculatedFields,
        initialValueColumnOrder: pane.initialValueColumnOrder,
        onUpdate: (req) => sent.push(req),
      });
      return null;
    }
    root = createRoot(document.createElement("div"));
    act(() => root!.render(React.createElement(Probe)));
    return { editor: () => current!, sent };
  }

  it("the editor's first unrelated edit sends the pivot's own order", () => {
    const { editor, sent } = mountEditor(rangeWithCalculatedInfo());
    expect(editor().values.map((v) => v.name)).toEqual(["Sum of Sales", "Margin", "Sum of Units"]);
    act(() => editor().handleLayoutChange({ showRowGrandTotals: false }));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[sent.length - 1].valueColumnOrder).toEqual(INTERLEAVED);
  });

  it("the editor's request equals the recipe's (one recipe)", () => {
    const { editor } = mountEditor(rangeInfo());
    expect(editor().buildUpdateRequest()).toEqual(CAPTURED_RANGE);
  });

  it("a Design-tab (DSL) apply keeps an inline calculated column where the DSL put it", () => {
    const { editor, sent } = mountEditor(rangeInfo());
    const pane = buildPivotPaneData(rangeInfo());
    act(() =>
      editor().setAllZones(
        pane.initialRows,
        pane.initialColumns,
        pane.initialValues,
        pane.initialFilters,
        pane.initialLayout,
        [{ name: "Ratio", formula: "='Sales'/'Units'" }],
        [
          { type: "calculated", index: 0 },
          { type: "value", index: 0 },
          { type: "value", index: 1 },
        ],
      ),
    );
    expect(sent[sent.length - 1].valueColumnOrder).toEqual([
      { type: "calculated", index: 0 },
      { type: "value", index: 0 },
      { type: "value", index: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// A value field's RENAME reaches the calculated fields that name it (e2e
// canvas-pick-cells J13: Summarize Values By > Max renamed "Sum of Units" to
// "Max of Units", and the calculated column "Double" = 'Sum of Units' * 2 went
// blank -- no error, no toast).
// ---------------------------------------------------------------------------

describe("renameCalculatedReferences", () => {
  it("rewrites a quoted, a bracketed and a bare reference, keeping each spelling", () => {
    expect(renameCalculatedReferences("'Sum of Units' * 2", "Sum of Units", "Max of Units")).toBe("'Max of Units' * 2");
    expect(renameCalculatedReferences("[Sum of Units]/2", "Sum of Units", "Max of Units")).toBe("[Max of Units]/2");
    expect(renameCalculatedReferences("=Sum of Units + 1", "Sum of Units", "Max of Units")).toBe("=Max of Units + 1");
  });

  it("matches the engine's way: case-insensitive, brackets ignored", () => {
    expect(renameCalculatedReferences("'sum OF units'*2", "Sum of Units", "Max of Units")).toBe("'Max of Units'*2");
    expect(renameCalculatedReferences("[Sum of Units]*2", "[Sum of Units]", "Max of Units")).toBe("[Max of Units]*2");
  });

  it("leaves string literals, function names, source fields and other references alone", () => {
    const f = `IF('Sum of Units' > 1, "Sum of Units", RUNNINGSUM('Units')) + 'Sum of Sales'`;
    expect(renameCalculatedReferences(f, "Sum of Units", "Max of Units")).toBe(
      `IF('Max of Units' > 1, "Sum of Units", RUNNINGSUM('Units')) + 'Sum of Sales'`,
    );
    expect(renameCalculatedReferences("Units * 2", "Sum of Units", "Max of Units")).toBe("Units * 2");
    expect(renameCalculatedReferences("Sum(1)", "Sum", "Max")).toBe("Sum(1)");
  });

  it("a bare reference whose new name cannot be bare is quoted; a name holding ' is bracketed", () => {
    expect(renameCalculatedReferences("Total*2", "Total", "Total (EUR)")).toBe("'Total (EUR)'*2");
    expect(renameCalculatedReferences("'Total'*2", "Total", "Bob's total")).toBe("[Bob's total]*2");
  });

  it("returns the formula unchanged when nothing names the field", () => {
    expect(renameCalculatedReferences("='Sales'-'Units'", "Sum of Units", "Max of Units")).toBe("='Sales'-'Units'");
  });
});

describe("replaceValueField", () => {
  const units: ZoneField = { sourceIndex: 3, name: "Sum of Units", isNumeric: true, aggregation: "sum" };
  const sales: ZoneField = { sourceIndex: 2, name: "Sum of Sales", isNumeric: true, aggregation: "sum" };
  const double: ZoneField = {
    sourceIndex: -2,
    name: "Double",
    isNumeric: true,
    isCalculated: true,
    customName: "Double",
    calculatedFormula: "'Sum of Units' * 2",
  };

  it("an aggregation change renames the default name, and the calculated field follows", () => {
    const out = replaceValueField([sales, double, units], 2, { ...units, aggregation: "max" });
    expect(valueFieldRequestName(out[2])).toBe("Max of Units");
    expect(out[1].calculatedFormula).toBe("'Max of Units' * 2");
    expect(out[0]).toBe(sales);
  });

  it("a custom name is followed too; a change that keeps the name touches nothing", () => {
    expect(replaceValueField([units, double], 0, { ...units, customName: "Units Sold" })[1].calculatedFormula).toBe("'Units Sold' * 2");
    const same = replaceValueField([units, double], 0, { ...units, numberFormat: "0.0" });
    expect(same[1]).toBe(double);
  });

  it("a name another value field still carries is not renamed (the reference still resolves)", () => {
    const twin: ZoneField = { ...units, sourceIndex: 4 };
    const out = replaceValueField([units, twin, double], 0, { ...units, aggregation: "max" });
    expect(out[2].calculatedFormula).toBe("'Sum of Units' * 2");
  });

  it("a model measure keeps its [Measure] name whatever the aggregation", () => {
    const measure: ZoneField = { sourceIndex: -1, name: "[Revenue]", isNumeric: true, customName: "[Revenue]" };
    const calc: ZoneField = { ...double, calculatedFormula: "[Revenue]*2" };
    expect(replaceValueField([measure, calc], 0, { ...measure, aggregation: "max" })[1].calculatedFormula).toBe("[Revenue]*2");
  });
});

describe("the field-list editor carries a rename into the calculated fields", () => {
  let root: Root | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
  });

  function mount(info: PivotRegionInfo) {
    const pane = buildPivotPaneData(info);
    let current: ReturnType<typeof usePivotEditorState> | null = null;
    function Probe(): null {
      current = usePivotEditorState({
        pivotId: pane.pivotId,
        sourceFields: pane.sourceFields,
        initialRows: pane.initialRows,
        initialColumns: pane.initialColumns,
        initialValues: pane.initialValues,
        initialFilters: pane.initialFilters,
        initialLayout: pane.initialLayout,
        initialCalculatedFields: pane.initialCalculatedFields,
        initialValueColumnOrder: pane.initialValueColumnOrder,
        onUpdate: () => undefined,
      });
      return null;
    }
    root = createRoot(document.createElement("div"));
    act(() => root!.render(React.createElement(Probe)));
    return () => current!;
  }

  function withDouble(): PivotRegionInfo {
    const info = rangeWithCalculatedInfo();
    info.fieldConfiguration!.calculatedFields = [{ name: "Double", formula: "'Sum of Units' * 2" }];
    return info;
  }

  it("an aggregation change from the Values chip", () => {
    const editor = mount(withDouble());
    act(() => editor().handleAggregationChange(2, "max"));
    const req = editor().buildUpdateRequest();
    expect(req.valueFields?.map((v) => v.name)).toEqual(["Sum of Sales", "Max of Units"]);
    expect(req.calculatedFields).toEqual([{ name: "Double", formula: "'Max of Units' * 2" }]);
  });

  it("Value Field Settings (the modal sends the new default as the custom name)", () => {
    const editor = mount(withDouble());
    act(() =>
      editor().handleValueFieldSettings(2, {
        customName: "Average of Units",
        aggregation: "average",
        showValuesAs: "normal",
      } as Parameters<ReturnType<typeof usePivotEditorState>["handleValueFieldSettings"]>[1]),
    );
    expect(editor().buildUpdateRequest().calculatedFields).toEqual([{ name: "Double", formula: "'Average of Units' * 2" }]);
  });
});
