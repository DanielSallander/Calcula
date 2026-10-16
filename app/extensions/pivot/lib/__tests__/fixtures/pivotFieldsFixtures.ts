//! FILENAME: app/extensions/Pivot/lib/__tests__/fixtures/pivotFieldsFixtures.ts
// PURPOSE: The pivot infos (`get_pivot_at_cell` answers) the fields-request
//          tests build from: a range pivot, a range pivot WITH a calculated
//          field interleaved between its two value fields, and a data-model
//          pivot with a hierarchy, a calculation group and hidden items.
// CONTEXT: Shared by pivotFieldsRequest.test.ts (the identity round trip of
//          the editor's own request builder) and valueFieldEdits.test.ts (the
//          menu's headless value-field edits). Plain data, no imports at run
//          time.

import type { PivotRegionInfo } from "@api/pivot";

/** A range pivot: Region (hides West) by Quarter, two value fields, a Year filter. */
export function rangeInfo(): PivotRegionInfo {
  return {
    pivotId: "7",
    isEmpty: false,
    sourceFields: [
      { index: 0, name: "Region", isNumeric: false },
      { index: 1, name: "Quarter", isNumeric: false },
      { index: 2, name: "Sales", isNumeric: true },
      { index: 3, name: "Units", isNumeric: true },
      { index: 4, name: "Year", isNumeric: false },
    ],
    fieldConfiguration: {
      rowFields: [{ sourceIndex: 0, name: "Region", isNumeric: false, hiddenItems: ["West"] }],
      columnFields: [{ sourceIndex: 1, name: "Quarter", isNumeric: false }],
      valueFields: [
        {
          sourceIndex: 2,
          name: "Sum of Sales",
          isNumeric: true,
          aggregation: "sum",
          numberFormat: "#,##0",
          showAs: { calculation: "runningTotal", baseField: "Region" },
        },
        { sourceIndex: 3, name: "Count of Units", isNumeric: true, aggregation: "count" },
      ],
      filterFields: [{ sourceIndex: 4, name: "Year", isNumeric: false, hiddenItems: ["2020"] }],
      layout: {
        showRowGrandTotals: true,
        showColumnGrandTotals: false,
        reportLayout: "tabular",
        repeatRowLabels: true,
        showEmptyRows: false,
        showEmptyCols: false,
        valuesPosition: "columns",
      },
    },
    filterZones: [],
  } as PivotRegionInfo;
}

/**
 * A range pivot with values [A = Sum of Sales, B = Sum of Units] and the
 * calculated field C = Margin, interleaved [Value 0, Calculated 0, Value 1].
 */
export function rangeWithCalculatedInfo(): PivotRegionInfo {
  return {
    pivotId: "8",
    isEmpty: false,
    sourceFields: [
      { index: 0, name: "Region", isNumeric: false },
      { index: 2, name: "Sales", isNumeric: true },
      { index: 3, name: "Units", isNumeric: true },
    ],
    fieldConfiguration: {
      rowFields: [{ sourceIndex: 0, name: "Region", isNumeric: false }],
      columnFields: [],
      valueFields: [
        { sourceIndex: 2, name: "Sum of Sales", isNumeric: true, aggregation: "sum" },
        { sourceIndex: 3, name: "Sum of Units", isNumeric: true, aggregation: "sum" },
      ],
      filterFields: [],
      layout: { showRowGrandTotals: true, showColumnGrandTotals: true, reportLayout: "compact" },
      calculatedFields: [{ name: "Margin", formula: "='Sales'-'Units'", numberFormat: "0.0" }],
      valueColumnOrder: [
        { type: "value", index: 0 },
        { type: "calculated", index: 0 },
        { type: "value", index: 1 },
      ],
    },
    filterZones: [],
  } as PivotRegionInfo;
}

/**
 * A data-model pivot: rows = the Calendar hierarchy (two level fields) then the
 * calculation group "Time Intelligence" (hides "YTD"); columns = Product.Category
 * (a LOOKUP column); one measure with a custom name; a filter hiding an item.
 */
export function biInfo(): PivotRegionInfo {
  return {
    pivotId: "9",
    isEmpty: false,
    sourceFields: [],
    fieldConfiguration: {
      rowFields: [
        { sourceIndex: 0, name: "Calendar.Year", isNumeric: false },
        { sourceIndex: 1, name: "Calendar.Month", isNumeric: false },
        { sourceIndex: 2, name: "Time Intelligence", isNumeric: false, hiddenItems: ["YTD"] },
      ],
      columnFields: [{ sourceIndex: 3, name: "Product.Category", isNumeric: false, isLookup: true }],
      valueFields: [
        { sourceIndex: 0, name: "[Revenue]", isNumeric: true, aggregation: "sum", customName: "Total Revenue" },
        { sourceIndex: 1, name: "[Cost]", isNumeric: true, aggregation: "sum" },
      ],
      filterFields: [{ sourceIndex: 4, name: "Geo.Country", isNumeric: false, hiddenItems: ["Mars"] }],
      layout: { showRowGrandTotals: true, showColumnGrandTotals: true, reportLayout: "compact" },
      hierarchyConfigs: [{ name: "Calendar", fieldStart: 0, fieldCount: 2, isRow: true }],
    },
    filterZones: [],
    biModel: {
      connectionId: "conn-1",
      tables: [
        {
          name: "Calendar",
          columns: [
            { name: "Year", dataType: "int", isNumeric: false },
            { name: "Month", dataType: "string", isNumeric: false },
          ],
        },
        { name: "Product", columns: [{ name: "Category", dataType: "string", isNumeric: false }] },
        { name: "Geo", columns: [{ name: "Country", dataType: "string", isNumeric: false }] },
      ],
      measures: [
        { name: "Revenue", table: "Sales", sourceColumn: "amount", aggregation: "sum" },
        { name: "Cost", table: "Sales", sourceColumn: "cost", aggregation: "sum" },
      ],
      lookupColumns: ["Product.Category"],
      hierarchies: [
        { name: "Calendar", table: "Calendar", levels: [{ column: "Year" }, { column: "Month" }] },
      ],
      calculationGroups: [{ name: "Time Intelligence", items: [{ name: "Current" }, { name: "YTD" }] }],
    },
  } as PivotRegionInfo;
}
