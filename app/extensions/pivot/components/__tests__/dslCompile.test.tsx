//! FILENAME: app/extensions/Pivot/components/__tests__/dslCompile.test.tsx
// PURPOSE: An inclusion filter the Pivot Layout DSL cannot resolve
//          (`Field = ("a")` with the field's item list not loaded) is named,
//          warned about, and handed to the editor as NOT a cleared filter
//          (review3 finding 3).
//
//          The compiler inverts `= (...)` against the field's full item list;
//          without one it returns the field with NO hidden items -- the shape of
//          a deleted clause -- and no diagnostic, so the field pane sent it as
//          "remove the filter". The first block pins `compileForEditor` itself;
//          the second drives the REAL DesignEditor (Monaco is a double that
//          exposes its onChange) to prove the pane passes the names on and
//          shows the warning.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BiPivotModelInfo } from "../types";

const h = vi.hoisted(() => ({
  onChange: null as ((value: string | undefined) => void) | null,
  markers: [] as Array<{ severity: number; message: string; startLineNumber: number }>,
}));

vi.mock("@monaco-editor/react", async () => {
  const react = await import("react");
  return {
    default: ({
      onMount,
      onChange,
    }: {
      onMount?: (editor: unknown, monaco: unknown) => void;
      onChange?: (value: string | undefined) => void;
    }) => {
      h.onChange = onChange ?? null;
      react.useEffect(() => {
        const model = { getFullModelRange: () => ({}), pushEditOperations: () => null, uri: { toString: () => "m1" } };
        onMount?.(
          { setValue: () => undefined, getModel: () => model, layout: () => undefined },
          {
            editor: {
              setModelMarkers: (_m: unknown, _owner: string, markers: typeof h.markers) => {
                h.markers = markers;
              },
            },
            MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
          },
        );
      }, [onMount]);
      return null;
    },
    loader: { config: () => {}, init: () => Promise.resolve({}) },
    useMonaco: () => null,
  };
});
vi.mock("../../../_shared/dsl/pivotLayout/pivotDslLanguage", () => ({
  LANGUAGE_ID: "pivot-layout-dsl",
  registerPivotDslLanguage: () => undefined,
  setDslEditorContext: () => undefined,
  setDslModelContext: () => undefined,
  clearDslModelContext: () => undefined,
}));
vi.mock("../../../_shared/dsl/pivotLayout/describeQuery", () => ({ DescribeQueryPanel: () => null }));
vi.mock("../../../_shared/dsl/pivotLayout/NextEditRow", () => ({ NextEditRow: () => null }));
vi.mock("@api/controlValues", () => ({ getControlValue: () => undefined }));

const { compileForEditor } = await import("../dslCompile");
const { DesignEditor } = await import("../DesignEditor");

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const col = (name: string) => ({ name, dataType: "string", isNumeric: false });
const biModel: BiPivotModelInfo = {
  tables: [
    { name: "Geo", columns: [col("Region")] },
    { name: "Sales", columns: [col("Channel"), col("Year")] },
  ],
  measures: [{ name: "Revenue" } as BiPivotModelInfo["measures"][number]],
  connectionId: "c1",
};

const TEXT = 'ROWS: Geo.Region\nVALUES: [Revenue]\nFILTERS: Sales.Channel = ("Store"), Sales.Year NOT IN ("2023")';

describe("compileForEditor", () => {
  it("names an inclusion whose item list is not loaded, and warns on its own clause", () => {
    const res = compileForEditor(TEXT, { sourceFields: [], biModel, filterUniqueValues: new Map() });
    expect([...res.unresolvedInclusions]).toEqual(["Sales.Channel"]);
    const warning = res.errors.find((e) => e.severity === "warning" && e.message.includes("Sales.Channel"));
    expect(warning, JSON.stringify(res.errors)).toBeDefined();
    expect(warning!.location.line).toBe(3);
    // The compile itself is unchanged: no hard error, the field is still placed.
    expect(res.parseErrors).toEqual([]);
    expect(res.filters.map((f) => f.name)).toEqual(["Sales.Channel", "Sales.Year"]);
  });

  it("names nothing when the list IS loaded (the inclusion is inverted) or the clause is NOT IN", () => {
    const res = compileForEditor(TEXT, {
      sourceFields: [],
      biModel,
      filterUniqueValues: new Map([["Sales.Channel", ["Store", "Web", "Phone"]]]),
    });
    expect(res.unresolvedInclusions.size).toBe(0);
    expect(res.filters[0].hiddenItems).toEqual(["Web", "Phone"]);
    expect(res.errors.filter((e) => e.severity === "warning")).toEqual([]);
  });
});

describe("the Design tab hands an unresolved inclusion on as NOT a cleared filter", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    h.onChange = null;
    h.markers = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("typed `= (...)` reaches onZoneStateChange with the field named unresolved, and shows a warning marker", async () => {
    const onZoneStateChange = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(DesignEditor, {
          sourceFields: [],
          biModel,
          rows: [],
          columns: [],
          values: [],
          filters: [],
          layout: {},
          filterUniqueValues: new Map(),
          onZoneStateChange,
          isActive: true,
        }),
      );
    });
    expect(h.onChange).not.toBeNull();

    await act(async () => {
      h.onChange!(TEXT);
      await new Promise((r) => setTimeout(r, 350)); // the editor's 300 ms debounce
    });

    expect(onZoneStateChange).toHaveBeenCalledTimes(1);
    const unresolved = onZoneStateChange.mock.calls[0][7] as ReadonlySet<string> | undefined;
    expect(unresolved && [...unresolved]).toEqual(["Sales.Channel"]);
    expect(h.markers.some((m) => m.severity === 4 && m.message.includes("Sales.Channel"))).toBe(true);
  });
});
