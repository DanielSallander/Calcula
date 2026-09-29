//! FILENAME: app/extensions/Pivot/components/__tests__/showValuesAsBaseSent.test.tsx
// PURPOSE: A value field's Show Values As reaches the backend WITH its base,
//          and survives the editor reopening.
// CONTEXT: Found live 2026-09-29 (e2e fixall-pivot X1): Value Field Settings >
//          Show Values As "Running Total In" with Base field Region changed
//          nothing. The editor kept neither the Base field nor the Base item
//          and sent only the plain `showValuesAs` string, which has no room for
//          a base -- so the backend had none to resolve. The way back was
//          broken the same way: the update REPLACES the value fields, and the
//          editor's seed (from the backend's field info) carried no Show Values
//          As and no number format, so the first change after a reopen cleared
//          both.

import { describe, it, expect, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { usePivotEditorState } from "../usePivotEditorState";
import { showAsRuleFor, showValuesAsFromRule } from "../../lib/showAsRule";
import type { SourceField, UpdatePivotFieldsRequest, ZoneField } from "../types";
import type { ShowAsCalculation, ShowValuesAs } from "@api/pivot";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sourceFields: SourceField[] = [
  { index: 0, name: "Region", isNumeric: false },
  { index: 1, name: "Sales", isNumeric: true },
] as SourceField[];

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

type Editor = ReturnType<typeof usePivotEditorState>;

function mount(initialValues: ZoneField[]): { editor: () => Editor; sent: UpdatePivotFieldsRequest[] } {
  const sent: UpdatePivotFieldsRequest[] = [];
  let current: Editor | null = null;
  function Probe(): null {
    current = usePivotEditorState({
      pivotId: 1 as never,
      sourceFields,
      initialRows: [{ sourceIndex: 0, name: "Region", isNumeric: false }],
      initialValues,
      onUpdate: (req) => sent.push(req),
    });
    return null;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Probe />));
  return { editor: () => current!, sent };
}

describe("Show Values As with a base", () => {
  it("Running Total In Region is sent as the showAs rule naming its base field", () => {
    const { editor, sent } = mount([{ sourceIndex: 1, name: "Sales", isNumeric: true, aggregation: "sum" }]);
    act(() =>
      editor().handleValueFieldSettings(0, {
        customName: "",
        aggregation: "sum",
        showValuesAs: "running_total",
        baseField: "Region",
      }),
    );
    expect(sent.length).toBeGreaterThan(0);
    const vf = sent[sent.length - 1].valueFields[0];
    expect(vf.showValuesAs).toBe("running_total");
    expect(vf.showAs, "the base never reached the backend").toEqual({ calculation: "runningTotal", baseField: "Region" });
  });

  it("Difference From (previous) sends the base item too", () => {
    const { editor, sent } = mount([{ sourceIndex: 1, name: "Sales", isNumeric: true, aggregation: "sum" }]);
    act(() =>
      editor().handleValueFieldSettings(0, {
        customName: "",
        aggregation: "sum",
        showValuesAs: "difference",
        baseField: "Region",
        baseItem: "(previous)",
      }),
    );
    expect(sent[sent.length - 1].valueFields[0].showAs).toEqual({
      calculation: "differenceFrom",
      baseField: "Region",
      baseItem: "(previous)",
    });
  });

  it("a reopened editor seeded from the backend's field info sends the rule and the format back on its next change", () => {
    // What selectionHandler seeds from a value field the backend reports with
    // showAs + numberFormat.
    const seeded: ZoneField = {
      sourceIndex: 1,
      name: "Sales",
      isNumeric: true,
      aggregation: "sum",
      numberFormat: "0.0%",
      ...showValuesAsFromRule({ calculation: "runningTotal", baseField: "Region" }),
    };
    const { editor, sent } = mount([seeded]);
    // An unrelated change: the layout's grand totals.
    act(() => editor().handleLayoutChange({ showRowGrandTotals: false }));
    expect(sent.length).toBeGreaterThan(0);
    const vf = sent[sent.length - 1].valueFields[0];
    expect(vf.showAs, "an unrelated change cleared Show Values As").toEqual({ calculation: "runningTotal", baseField: "Region" });
    expect(vf.numberFormat, "an unrelated change cleared the number format").toBe("0.0%");
  });
});

describe("showAsRule round trip", () => {
  const all: ShowValuesAs[] = [
    "percent_of_total",
    "percent_of_row",
    "percent_of_column",
    "percent_of_parent_row",
    "percent_of_parent_column",
    "difference",
    "percent_difference",
    "running_total",
    "percent_of_running_total",
    "rank_ascending",
    "rank_descending",
    "index",
  ];

  it.each(all)("%s goes out and comes back unchanged", (s) => {
    const rule = showAsRuleFor(s, "Region", "East");
    expect(rule).toBeDefined();
    expect(showValuesAsFromRule(rule)).toEqual({ showValuesAs: s, baseField: "Region", baseItem: "East" });
  });

  it("no calculation, or no base, sends no rule; a none rule seeds nothing", () => {
    expect(showAsRuleFor("normal", "Region", undefined)).toBeUndefined();
    expect(showAsRuleFor("running_total", undefined, undefined)).toBeUndefined();
    expect(showValuesAsFromRule({ calculation: "none" as ShowAsCalculation })).toEqual({});
    expect(showValuesAsFromRule(undefined)).toEqual({});
  });
});

describe("the editor's seed from the backend's field info", () => {
  it("carries a value field's Show Values As, base and number format into the Values zone", async () => {
    const { buildPivotPaneData } = await import("../../handlers/selectionHandler");
    const pane = buildPivotPaneData({
      pivotId: 1 as never,
      isEmpty: false,
      sourceFields: [
        { index: 0, name: "Region", isNumeric: false },
        { index: 1, name: "Sales", isNumeric: true },
      ],
      fieldConfiguration: {
        rowFields: [{ sourceIndex: 0, name: "Region", isNumeric: false }],
        columnFields: [],
        valueFields: [
          {
            sourceIndex: 1,
            name: "Sum of Sales",
            isNumeric: true,
            aggregation: "sum",
            numberFormat: "0.0%",
            showAs: { calculation: "differenceFrom", baseField: "Region", baseItem: "(previous)" },
          },
        ],
        filterFields: [],
        layout: {},
      },
      filterZones: [],
    } as never);
    expect(pane.initialValues[0]).toMatchObject({
      showValuesAs: "difference",
      baseField: "Region",
      baseItem: "(previous)",
      numberFormat: "0.0%",
    });
  });
});
