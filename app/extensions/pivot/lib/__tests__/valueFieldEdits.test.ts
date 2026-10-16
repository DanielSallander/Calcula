//! FILENAME: app/extensions/Pivot/lib/__tests__/valueFieldEdits.test.ts
// PURPOSE: The value-cell menu's HEADLESS value-field edits
//          (`editPivotValueField`, lib/valueFieldEdits.ts) send the pivot's
//          whole fields request back with ONLY the one value field changed:
//          - remove / summarize / showValuesAs leave rows, columns, filters and
//            their item filters alone (no item filter is echoed -- absent KEEPS);
//          - on a pivot with a calculated field interleaved [V0, C0, V1],
//            summarize / showValuesAs send the calculated fields and the order
//            UNCHANGED, and removing B sends [V0, C0] with C still present;
//          - the model path calls updateBiFields, the range path updatePivotFields;
//          - refusals toast and send nothing: Show Values As on a model pivot,
//            a calculation-group expansion (index/name mismatch), an index past
//            the fields, a pivot not on the sheet, an edit that changes nothing.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  bi: [] as unknown[],
  range: [] as unknown[],
  regions: [] as Array<{ pivotId: string; startRow: number; startCol: number }>,
  info: null as unknown,
  viewNames: undefined as string[] | undefined,
  toasts: [] as Array<[string, unknown]>,
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
vi.mock("@api/notifications", () => ({
  showToast: vi.fn((message: string, options: unknown) => {
    h.toasts.push([message, options]);
  }),
}));
vi.mock("../pivot-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pivot-api")>()),
  getPivotAtCell: vi.fn(() => Promise.resolve(h.info)),
}));
vi.mock("../pivotViewStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pivotViewStore")>()),
  getCachedPivotView: vi.fn(() => (h.viewNames ? { valueFieldNames: h.viewNames } : undefined)),
}));
vi.mock("../../handlers/selectionHandler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../handlers/selectionHandler")>()),
  getCachedRegions: () => h.regions,
}));

import { editPivotValueField, MODEL_SHOW_VALUES_AS_REFUSAL, readPivotEditorZones, setPivotValueFieldFormat } from "../valueFieldEdits";
import { getPivotAtCell } from "../pivot-api";
import { pivot } from "@api/pivot";
import { CALC_GROUP_TABLE, type UpdatePivotFieldsRequest } from "../../components/types";
import { rangeInfo, rangeWithCalculatedInfo, biInfo } from "./fixtures/pivotFieldsFixtures";
import type { PivotRegionInfo } from "@api/pivot";

function install(info: PivotRegionInfo, viewNames?: string[]): void {
  h.info = info;
  h.regions = [{ pivotId: String(info.pivotId), startRow: 4, startCol: 1 }];
  h.viewNames = viewNames;
}

function lastRange(): UpdatePivotFieldsRequest {
  expect(h.range.length, "one update_pivot_fields request").toBe(1);
  return h.range[0] as UpdatePivotFieldsRequest;
}

let refreshes = 0;
const onRefresh = () => {
  refreshes++;
};

/** PIVOT_FIELDS_EDITED_ELSEWHERE announcements (BUG-0466: an open editor re-seeds on them). */
let elsewhere: unknown[] = [];
const onElsewhere = (e: Event) => {
  elsewhere.push((e as CustomEvent).detail);
};

beforeEach(() => {
  h.bi = [];
  h.range = [];
  h.toasts = [];
  h.info = null;
  h.viewNames = undefined;
  refreshes = 0;
  elsewhere = [];
  window.removeEventListener("app:pivot-fields-edited-elsewhere", onElsewhere);
  window.addEventListener("app:pivot-fields-edited-elsewhere", onElsewhere);
  vi.mocked(getPivotAtCell).mockClear();
  window.removeEventListener("pivot:refresh", onRefresh);
  window.addEventListener("pivot:refresh", onRefresh);
});

/** The untouched zones of rangeInfo() as a headless request sends them (no item filter echoed). */
const RANGE_ZONES = {
  rowFields: [{ sourceIndex: 0, name: "Region" }],
  columnFields: [{ sourceIndex: 1, name: "Quarter" }],
  filterFields: [{ sourceIndex: 4, name: "Year" }],
};

const SALES_WITH_RUNNING_TOTAL = {
  sourceIndex: 2,
  name: "Sum of Sales",
  aggregation: "sum",
  numberFormat: "#,##0",
  showValuesAs: "running_total",
  showAs: { calculation: "runningTotal", baseField: "Region" },
};

describe("range pivot: only the value field changes", () => {
  it("summarize: the field's aggregation and name change; zones, item filters and the other field are untouched", async () => {
    install(rangeInfo(), ["Sum of Sales", "Count of Units"]);
    await editPivotValueField("7", 1, { kind: "summarize", aggregation: "average" });
    expect(getPivotAtCell).toHaveBeenCalledWith(4, 1);
    const sent = lastRange();
    expect(sent).toMatchObject(RANGE_ZONES);
    for (const zone of [sent.rowFields, sent.columnFields, sent.filterFields]) {
      for (const f of zone ?? []) expect(f, "no item filter echoed").not.toHaveProperty("hiddenItems");
    }
    expect(sent.valueFields).toEqual([
      SALES_WITH_RUNNING_TOTAL,
      { sourceIndex: 3, name: "Average of Units", aggregation: "average" },
    ]);
    expect(sent.layout, "a headless edit sends no layout").toBeUndefined();
    expect(h.bi).toEqual([]);
    expect(refreshes).toBe(1);
    expect(h.toasts).toEqual([]);
  });

  it("remove: the field leaves, the rest stays", async () => {
    install(rangeInfo());
    await editPivotValueField("7", 0, { kind: "remove" });
    const sent = lastRange();
    expect(sent).toMatchObject(RANGE_ZONES);
    expect(sent.valueFields).toEqual([{ sourceIndex: 3, name: "Count of Units", aggregation: "count" }]);
    expect(sent.valueColumnOrder).toEqual([{ type: "value", index: 0 }]);
  });

  it("showValuesAs: a based calculation is replaced by the plain one (no stale showAs rule)", async () => {
    install(rangeInfo());
    await editPivotValueField("7", 0, { kind: "showValuesAs", showValuesAs: "percent_of_total" });
    const sent = lastRange();
    expect(sent).toMatchObject(RANGE_ZONES);
    expect(sent.valueFields?.[0]).toEqual({
      sourceIndex: 2,
      name: "Sum of Sales",
      aggregation: "sum",
      numberFormat: "#,##0",
      showValuesAs: "percent_of_total",
    });
    expect(sent.valueFields?.[1]).toEqual({ sourceIndex: 3, name: "Count of Units", aggregation: "count" });
  });
});

describe("a calculated field keeps its place (the backend REPLACES the order)", () => {
  const INTERLEAVED = [
    { type: "value", index: 0 },
    { type: "calculated", index: 0 },
    { type: "value", index: 1 },
  ];
  const MARGIN = [{ name: "Margin", formula: "='Sales'-'Units'", numberFormat: "0.0" }];

  it("summarize sends the calculated fields and the order unchanged", async () => {
    install(rangeWithCalculatedInfo(), ["Sum of Sales", "Sum of Units"]);
    await editPivotValueField("8", 1, { kind: "summarize", aggregation: "max" });
    const sent = lastRange();
    expect(sent.calculatedFields).toEqual(MARGIN);
    expect(sent.valueColumnOrder).toEqual(INTERLEAVED);
    expect(sent.valueFields?.map((v) => [v.name, v.aggregation])).toEqual([
      ["Sum of Sales", "sum"],
      ["Max of Units", "max"],
    ]);
  });

  it("showValuesAs sends the calculated fields and the order unchanged", async () => {
    install(rangeWithCalculatedInfo());
    await editPivotValueField("8", 0, { kind: "showValuesAs", showValuesAs: "percent_of_column" });
    const sent = lastRange();
    expect(sent.calculatedFields).toEqual(MARGIN);
    expect(sent.valueColumnOrder).toEqual(INTERLEAVED);
    expect(sent.valueFields?.[0].showValuesAs).toBe("percent_of_column");
  });

  it("summarize RENAMES the field, and a calculated field naming it follows the rename (e2e canvas-pick-cells J13)", async () => {
    const info = rangeWithCalculatedInfo();
    info.fieldConfiguration!.calculatedFields = [{ name: "Double", formula: "'Sum of Units' * 2" }];
    install(info, ["Sum of Sales", "Sum of Units"]);
    await editPivotValueField("8", 1, { kind: "summarize", aggregation: "max" });
    const sent = lastRange();
    expect(sent.valueFields?.map((v) => v.name)).toEqual(["Sum of Sales", "Max of Units"]);
    // Without the rename the formula still named "Sum of Units", which no
    // field carries any more: the Double column went blank, silently.
    expect(sent.calculatedFields).toEqual([{ name: "Double", formula: "'Max of Units' * 2" }]);
    expect(sent.valueColumnOrder).toEqual(INTERLEAVED);
  });

  it("showValuesAs keeps the name, so a calculated field naming the field is sent untouched", async () => {
    const info = rangeWithCalculatedInfo();
    info.fieldConfiguration!.calculatedFields = [{ name: "Double", formula: "'Sum of Units' * 2" }];
    install(info);
    await editPivotValueField("8", 1, { kind: "showValuesAs", showValuesAs: "percent_of_total" });
    expect(lastRange().calculatedFields).toEqual([{ name: "Double", formula: "'Sum of Units' * 2" }]);
  });

  it("removing B sends [V0, C0] with the calculated field still present", async () => {
    install(rangeWithCalculatedInfo());
    await editPivotValueField("8", 1, { kind: "remove" });
    const sent = lastRange();
    expect(sent.valueFields?.map((v) => v.name)).toEqual(["Sum of Sales"]);
    expect(sent.calculatedFields).toEqual(MARGIN);
    expect(sent.valueColumnOrder).toEqual([
      { type: "value", index: 0 },
      { type: "calculated", index: 0 },
    ]);
  });
});

describe("data-model pivot", () => {
  it("remove goes through updateBiFields; the hierarchy, the calculation group's subset and the lookup set ride along", async () => {
    install(biInfo(), ["[Revenue]", "[Cost]"]);
    await editPivotValueField("9", 1, { kind: "remove" });
    expect(h.range).toEqual([]);
    expect(pivot.updateBiFields).toHaveBeenCalledTimes(1);
    expect(h.bi[0]).toMatchObject({
      pivotId: "9",
      rowFields: [{ table: CALC_GROUP_TABLE, column: "Time Intelligence", hiddenItems: ["YTD"] }],
      columnFields: [{ table: "Product", column: "Category", isLookup: true }],
      valueFields: [{ measureName: "Revenue", customName: "Total Revenue" }],
      filterFields: [{ table: "Geo", column: "Country", isLookup: false }],
      rowHierarchies: [{ table: "Calendar", hierarchy: "Calendar", expanded: [] }],
      lookupColumns: ["Product.Category"],
    });
    const filter = (h.bi[0] as { filterFields: object[] }).filterFields[0];
    expect(filter).not.toHaveProperty("hiddenItems");
    expect(refreshes).toBe(1);
  });

  it("Show Values As refuses with a toast and sends nothing (the transport cannot carry it)", async () => {
    install(biInfo());
    await editPivotValueField("9", 0, { kind: "showValuesAs", showValuesAs: "percent_of_total" });
    expect(h.bi).toEqual([]);
    expect(h.range).toEqual([]);
    expect(h.toasts).toEqual([[MODEL_SHOW_VALUES_AS_REFUSAL, { variant: "info" }]]);
    expect(refreshes).toBe(0);
  });

  it("a calculation-group expansion (the view's names do not line up) refuses with a toast", async () => {
    install(biInfo(), ["[Revenue]", "[Revenue]", "[Cost]", "[Cost]"]);
    await editPivotValueField("9", 1, { kind: "remove" });
    expect(h.bi).toEqual([]);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0][0]).toMatch(/cannot be changed from here/);
    // Positive control: index 0 lines up and is sent.
    h.toasts = [];
    await editPivotValueField("9", 0, { kind: "remove" });
    expect(h.bi).toHaveLength(1);
    expect(h.toasts).toEqual([]);
  });
});

describe("refusals send nothing and say why", () => {
  it("an index past the value fields (calculated fields are not counted)", async () => {
    install(rangeWithCalculatedInfo());
    await editPivotValueField("8", 2, { kind: "remove" });
    expect(h.range).toEqual([]);
    expect(h.toasts).toEqual([["That value field is no longer in the PivotTable.", { variant: "info" }]]);
  });

  it("a pivot not on this sheet (no cached region): not even read", async () => {
    install(rangeInfo());
    h.regions = [];
    await editPivotValueField("7", 0, { kind: "remove" });
    expect(getPivotAtCell).not.toHaveBeenCalled();
    expect(h.range).toEqual([]);
    expect(h.toasts[0][0]).toBe("The PivotTable is not on this sheet.");
  });

  it("an anchor that now answers another pivot", async () => {
    install(rangeInfo());
    h.regions = [{ pivotId: "99", startRow: 4, startCol: 1 }];
    await editPivotValueField("99", 0, { kind: "remove" });
    expect(h.range).toEqual([]);
    expect(h.toasts[0][0]).toBe("The PivotTable could not be read.");
  });

  it("an edit that changes nothing (same aggregation, same Show Values As)", async () => {
    install(rangeInfo());
    await editPivotValueField("7", 1, { kind: "summarize", aggregation: "count" });
    await editPivotValueField("7", 1, { kind: "showValuesAs", showValuesAs: "normal" });
    expect(h.range).toEqual([]);
    expect(h.toasts.map((t) => t[0])).toEqual([
      '"Count of Units" is already summarized that way.',
      '"Count of Units" already shows No Calculation.',
    ]);
  });

  it("a backend failure rejects (the menu action toasts it)", async () => {
    install(rangeInfo());
    vi.mocked(pivot.updateFields).mockRejectedValueOnce(new Error("locked"));
    await expect(editPivotValueField("7", 0, { kind: "remove" })).rejects.toThrow("locked");
    expect(refreshes).toBe(0);
  });
});

describe("BUG-0466: an open editor is told, and can re-seed from the same recipe", () => {
  it("a successful edit announces PIVOT_FIELDS_EDITED_ELSEWHERE for its pivot", async () => {
    install(rangeInfo());
    await editPivotValueField("7", 0, { kind: "remove" });
    expect(elsewhere).toEqual([{ pivotId: "7" }]);
  });

  it("a refusal and a failed send announce nothing", async () => {
    install(rangeInfo());
    await editPivotValueField("7", 1, { kind: "summarize", aggregation: "count" });
    vi.mocked(pivot.updateFields).mockRejectedValueOnce(new Error("locked"));
    await expect(editPivotValueField("7", 0, { kind: "remove" })).rejects.toThrow("locked");
    expect(elsewhere).toEqual([]);
  });

  it("readPivotEditorZones seeds the zones as the editor does (calculated field in its place)", async () => {
    install(rangeWithCalculatedInfo());
    const zones = await readPivotEditorZones("8");
    expect(zones).not.toBeNull();
    expect(zones!.values.map((v) => (v.isCalculated ? "calc:" + v.name : v.name))).toEqual([
      expect.any(String),
      "calc:Margin",
      expect.any(String),
    ]);
    expect(zones!.rows.length + zones!.columns.length).toBeGreaterThan(0);
  });

  it("readPivotEditorZones is null for a pivot not on the sheet or answering as another", async () => {
    install(rangeInfo());
    expect(await readPivotEditorZones("42")).toBeNull();
    h.regions = [{ pivotId: "99", startRow: 4, startCol: 1 }];
    expect(await readPivotEditorZones("99")).toBeNull();
  });
});

// ============================================================================
// WP-C S10: the Format pane's Data format door (`setPivotValueFieldFormat`)
// ============================================================================

describe("number format OVERRIDE (the Data format card)", () => {
  it("range pivot: ONE fields update with only that field's format changed", async () => {
    install(rangeInfo(), ["Sum of Sales", "Count of Units"]);
    await setPivotValueFieldFormat("7", 1, "0.0%");
    const req = lastRange();
    expect(req.valueFields.map((v) => v.numberFormat)).toEqual(["#,##0", "0.0%"]);
    expect(req.rowFields).toEqual(RANGE_ZONES.rowFields);
    expect(elsewhere, "an open editor re-seeds (BUG-0466)").toHaveLength(1);
    expect(refreshes).toBe(1);
  });

  it("data-model pivot: the override rides BiValueFieldRef.numberFormat; an ADOPTED format of another field does not", async () => {
    const info = biInfo();
    info.fieldConfiguration.valueFields[0] = {
      ...info.fieldConfiguration.valueFields[0],
      numberFormat: "#,##0.00",
      numberFormatFromModel: true,
    };
    install(info, ["[Revenue]", "[Cost]"]);
    await setPivotValueFieldFormat("9", 1, "0.0");
    expect(h.bi).toHaveLength(1);
    const values = (h.bi[0] as { valueFields: Array<Record<string, unknown>> }).valueFields;
    expect(values[0]).not.toHaveProperty("numberFormat");
    expect(values[1]).toMatchObject({ measureName: "Cost", numberFormat: "0.0" });
  });

  it("null CLEARS the override (the model's format comes back on the query); an override equal to the current one sends nothing", async () => {
    const info = biInfo();
    info.fieldConfiguration.valueFields[1] = { ...info.fieldConfiguration.valueFields[1], numberFormat: "0.0" };
    install(info, ["[Revenue]", "[Cost]"]);
    await setPivotValueFieldFormat("9", 1, "0.0");
    expect(h.bi, "unchanged: nothing sent").toEqual([]);
    await setPivotValueFieldFormat("9", 1, null);
    const values = (h.bi[0] as { valueFields: Array<Record<string, unknown>> }).valueFields;
    expect(values[1]).not.toHaveProperty("numberFormat");
  });

  it("an ADOPTED format is not an override: clearing it sends nothing, and choosing a format makes it the user's", async () => {
    const info = biInfo();
    info.fieldConfiguration.valueFields[0] = {
      ...info.fieldConfiguration.valueFields[0],
      numberFormat: "#,##0.00",
      numberFormatFromModel: true,
    };
    install(info, ["[Revenue]", "[Cost]"]);
    await setPivotValueFieldFormat("9", 0, null);
    expect(h.bi).toEqual([]);
    await setPivotValueFieldFormat("9", 0, "#,##0.00");
    const values = (h.bi[0] as { valueFields: Array<Record<string, unknown>> }).valueFields;
    expect(values[0]).toMatchObject({ measureName: "Revenue", numberFormat: "#,##0.00" });
  });

  it("a refusal REJECTS with its sentence (the card toasts it) -- never a silent no-op, never a toast here", async () => {
    install(biInfo(), ["[Revenue]", "[Revenue]", "[Cost]", "[Cost]"]);
    await expect(setPivotValueFieldFormat("9", 1, "0")).rejects.toThrow(/cannot be changed from here/);
    await expect(setPivotValueFieldFormat("nope", 0, "0")).rejects.toThrow("not on this sheet");
    expect(h.toasts).toEqual([]);
    expect(h.bi).toEqual([]);
  });
});
