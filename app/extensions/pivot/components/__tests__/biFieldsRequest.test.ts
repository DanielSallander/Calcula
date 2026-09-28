//! FILENAME: app/extensions/Pivot/components/__tests__/biFieldsRequest.test.ts
// PURPOSE: The field-list editor's BI request carries a real field's hidden
//          items ONLY when the user edited that field's item filter in the
//          editor (review2 slicerbe findings 4 and 10, frontend half).
//
//          The wire is three-state (@api/pivotTypes BiFieldRef): absent =
//          keep what the pivot hides now, a list = set, [] = removed. A zone
//          chip's own list is a DISPLAY copy seeded when the pane mounted; a
//          slicer, the header dropdown or a ribbon filter can change the pivot
//          afterwards and nothing re-syncs the chip. Echoing it re-applied a
//          filter the user had cleared elsewhere on the next unrelated layout
//          edit, and a deleted NOT IN clause sent nothing ("keep") so it came
//          straight back.

import { describe, it, expect } from "vitest";
import {
  buildBiUpdateRequest,
  diffHiddenItemEdits,
  reconcileChipHiddenItems,
  sameHiddenItems,
  type BiRequestContext,
} from "../biFieldsRequest";
import { CALC_GROUP_TABLE } from "../types";

const ctx = (edits: Record<string, string[]> = {}, extra: Partial<BiRequestContext> = {}): BiRequestContext => ({
  calcGroupNames: new Set(["Time Intelligence"]),
  biTableNames: ["Sales", "Geo"],
  lookupColumns: new Set<string>(),
  hiddenItemEdits: new Map(Object.entries(edits)),
  ...extra,
});

const zones = {
  pivotId: "pv",
  rowFields: [{ name: "Geo.Region", hiddenItems: ["West"] }],
  columnFields: [{ name: "Sales.Year", hiddenItems: ["2023"] }],
  valueFields: [{ name: "[Revenue]", customName: "[Revenue]" }],
  filterFields: [{ name: "Sales.Channel", hiddenItems: ["Web"] }],
};

describe("buildBiUpdateRequest: which hidden items reach the wire", () => {
  it("an untouched real row, column or filter chip carries NO hiddenItems -- its list is a stale display copy", () => {
    const req = buildBiUpdateRequest(zones, ctx());
    expect(req.rowFields).toEqual([{ table: "Geo", column: "Region", isLookup: false }]);
    expect(req.rowFields[0]).not.toHaveProperty("hiddenItems");
    expect(req.columnFields[0]).not.toHaveProperty("hiddenItems");
    expect(req.filterFields[0]).not.toHaveProperty("hiddenItems");
    // And the key really is absent on the wire, not `undefined`-then-dropped by luck.
    expect(JSON.stringify(req.rowFields[0])).not.toContain("hiddenItems");
  });

  it("an item filter REMOVED in the editor is sent as [] (a clear), not as nothing (a keep)", () => {
    const req = buildBiUpdateRequest(zones, ctx({ "Geo.Region": [] }));
    expect(req.rowFields[0]).toEqual({ table: "Geo", column: "Region", isLookup: false, hiddenItems: [] });
    // The other chips are still untouched.
    expect(req.columnFields[0]).not.toHaveProperty("hiddenItems");
  });

  it("an item filter CHANGED in the editor is sent as the new list, whatever the chip's stale copy says", () => {
    const req = buildBiUpdateRequest(zones, ctx({ "Sales.Year": ["2022", "2023"] }));
    expect(req.columnFields[0].hiddenItems).toEqual(["2022", "2023"]);
  });

  it("a cleared FILTER-zone field is sent as []", () => {
    const req = buildBiUpdateRequest(zones, ctx({ "Sales.Channel": [] }));
    expect(req.filterFields[0]).toEqual({ table: "Sales", column: "Channel", isLookup: false, hiddenItems: [] });
  });

  it("a calculation-group chip always sends its OWN item subset (the chip is the only place it lives)", () => {
    const withGroup = {
      ...zones,
      rowFields: [...zones.rowFields, { name: "Time Intelligence", hiddenItems: ["YoY"] }],
    };
    const req = buildBiUpdateRequest(withGroup, ctx());
    expect(req.rowFields[1]).toEqual({ table: CALC_GROUP_TABLE, column: "Time Intelligence", hiddenItems: ["YoY"] });
    // An edit map naming it does not replace the chip's subset.
    const req2 = buildBiUpdateRequest(withGroup, ctx({ "Time Intelligence": [] }));
    expect(req2.rowFields[1].hiddenItems).toEqual(["YoY"]);
  });

  it("keeps the rest of the mapping: hierarchies, measures, lookups, no slicerFields", () => {
    const req = buildBiUpdateRequest(
      {
        ...zones,
        rowFields: [...zones.rowFields, { name: "Geo.__hierarchy__.Geography" }],
      },
      ctx({}, { lookupColumns: new Set(["Geo.Region"]) }),
    );
    expect(req.rowFields.map((f) => `${f.table}.${f.column}`)).toEqual(["Geo.Region"]);
    expect(req.rowFields[0].isLookup).toBe(true);
    expect(req.rowHierarchies).toEqual([{ table: "Geo", hierarchy: "Geography", expanded: [] }]);
    expect(req.valueFields).toEqual([{ measureName: "Revenue", customName: "[Revenue]" }]);
    expect(req.lookupColumns).toEqual(["Geo.Region"]);
    expect(req).not.toHaveProperty("slicerFields");
  });
});

describe("diffHiddenItemEdits: what a Pivot Layout DSL apply changed", () => {
  const before = [
    { name: "Geo.Region", hiddenItems: ["West"] },
    { name: "Sales.Year", hiddenItems: ["2023", "2022"] },
    { name: "Sales.Channel" },
  ];

  it("a deleted NOT IN clause becomes an edit to [] AND is stored as []", () => {
    const { fields, edits } = diffHiddenItemEdits(before, [{ name: "Geo.Region" }]);
    expect(edits.get("Geo.Region")).toEqual([]);
    expect(fields[0].hiddenItems).toEqual([]);
  });

  it("a changed clause becomes an edit to the new list", () => {
    const { edits } = diffHiddenItemEdits(before, [{ name: "Geo.Region", hiddenItems: ["East"] }]);
    expect(edits.get("Geo.Region")).toEqual(["East"]);
  });

  it("an unchanged field is no edit -- order does not matter", () => {
    const { fields, edits } = diffHiddenItemEdits(before, [
      { name: "Sales.Year", hiddenItems: ["2022", "2023"] },
      { name: "Sales.Channel" },
    ]);
    expect(edits.size).toBe(0);
    expect(fields[1].hiddenItems).toBeUndefined();
  });

  it("moving a field to another zone with the same list is no edit (the backend keys by Table.Column)", () => {
    // `before` holds every zone; the field arriving in COLUMNS still matches.
    const { edits } = diffHiddenItemEdits(before, [{ name: "Geo.Region", hiddenItems: ["West"] }]);
    expect(edits.size).toBe(0);
  });

  it("a newly placed field: a list is an edit, no list is not (a slicer's filter on it is kept)", () => {
    expect(diffHiddenItemEdits(before, [{ name: "Geo.City", hiddenItems: ["Oslo"] }]).edits.get("Geo.City")).toEqual(["Oslo"]);
    expect(diffHiddenItemEdits(before, [{ name: "Geo.City" }]).edits.size).toBe(0);
  });

  it("sameHiddenItems ignores order and repeats, treats absent as empty", () => {
    expect(sameHiddenItems(["a", "b"], ["b", "a", "a"])).toBe(true);
    expect(sameHiddenItems(undefined, [])).toBe(true);
    expect(sameHiddenItems(["a"], [])).toBe(false);
  });
});

describe("diffHiddenItemEdits: a filter the DSL could not resolve is no edit (review3 finding 3)", () => {
  const before = [{ name: "Sales.Channel", hiddenItems: ["Web"] }];

  it("an unresolved inclusion keeps the previous list and records nothing -- it is not a deleted clause", () => {
    // What the compiler hands back for `Sales.Channel = ("Store")` with no item list loaded.
    const { fields, edits } = diffHiddenItemEdits(before, [{ name: "Sales.Channel" }], new Set(["Sales.Channel"]));
    expect(edits.size).toBe(0);
    expect(fields[0].hiddenItems).toEqual(["Web"]);
  });

  it("the same field NOT named unresolved is still read as a removed clause (control)", () => {
    expect(diffHiddenItemEdits(before, [{ name: "Sales.Channel" }]).edits.get("Sales.Channel")).toEqual([]);
  });
});

describe("reconcileChipHiddenItems: the chips follow the pivot (review3 findings 1 and 6)", () => {
  const snapshot = {
    rowFields: [
      { sourceIndex: 0, name: "Region", hiddenItems: [] as string[] },
      { sourceIndex: 3, name: "Geo.City", hiddenItems: ["Oslo"] },
    ],
    columnFields: [{ sourceIndex: 1, name: "Time Intelligence", hiddenItems: ["YoY", "MoM"] }],
    filterFields: [{ sourceIndex: 2, name: "Channel" }],
  };

  it("a RANGE chip is matched by source index and takes the definition's list ([] when it hides nothing)", () => {
    const chips = [
      { sourceIndex: 0, name: "Region", hiddenItems: ["West"] },
      { sourceIndex: 2, name: "Chan", hiddenItems: ["Web"] },
    ];
    const next = reconcileChipHiddenItems(chips, snapshot, new Map());
    expect(next[0].hiddenItems).toEqual([]);
    expect(next[1].hiddenItems).toEqual([]);
  });

  it("a model or calculation-group chip is matched by NAME, in any zone", () => {
    const chips = [
      { sourceIndex: -1, name: "Geo.City" },
      { sourceIndex: -1, name: "Time Intelligence", hiddenItems: ["YoY"] },
    ];
    const next = reconcileChipHiddenItems(chips, snapshot, new Map());
    expect(next[0].hiddenItems).toEqual(["Oslo"]);
    expect(next[1].hiddenItems).toEqual(["YoY", "MoM"]);
  });

  it("a chip with a PENDING edit is left alone: the user's edit is newer than the definition", () => {
    const chips = [{ sourceIndex: -1, name: "Geo.City", hiddenItems: ["Bergen"] }];
    const next = reconcileChipHiddenItems(chips, snapshot, new Map([["Geo.City", ["Bergen"]]]));
    expect(next[0].hiddenItems).toEqual(["Bergen"]);
  });

  it("returns the SAME array when nothing differs, and never touches a hierarchy chip or a field the pivot lacks", () => {
    const chips = [
      { sourceIndex: -1, name: "Geo.City", hiddenItems: ["Oslo"] },
      { sourceIndex: -3, name: "Geo.__hierarchy__.Place", hiddenItems: ["x"] },
      { sourceIndex: -1, name: "Geo.Country", hiddenItems: ["SE"] },
    ];
    expect(reconcileChipHiddenItems(chips, snapshot, new Map())).toBe(chips);
  });
});
