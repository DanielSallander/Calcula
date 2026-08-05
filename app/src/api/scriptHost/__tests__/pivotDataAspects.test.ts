//! FILENAME: app/src/api/scriptHost/__tests__/pivotDataAspects.test.ts
// PURPOSE: Wave 3 item 4 — pivot report filters / item visibility / sort /
//          value number format as object.setState aspects (NO new allowlist
//          rows: they ride object.setState and api.objectSetState exactly
//          like the PIVOT_LAYOUT_ASPECTS family).
// COVERS:  (1) the checkPivotDataAspect matrix behind vSetState AND
//              vObjectAspect (both doors, one gate);
//          (2) the HOST executors (executePivotDataAspect /
//              executePivotFieldInfo) against a registered fake PivotApi:
//              each aspect dispatches to the RIGHT facade method with the
//              RIGHT request shape — source-index addressing for
//              filter/visibility/sort, value-field POSITION for number
//              format — and unknown fields fail with the real names listed;
//          (3) the WORKER shims: api.pivot(id).setFilter(...) goes through
//              api.objectSetState, and the own-pivot context through
//              object.setState, both with the same aspect + argument order;
//          (4) the generated typings declare the new authoring surface.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { ALLOWLIST } from "../allowlist";
import {
  vSetState,
  vObjectAspect,
  checkPivotDataAspect,
  PIVOT_DATA_ASPECTS,
  PIVOT_SORT_DIRECTIONS,
  MAX_PIVOT_FILTER_ITEMS,
} from "../validators";
import { registerPivotApi, type PivotApi } from "../../pivot";
import { executePivotDataAspect, executePivotFieldInfo } from "../host";
import { buildWorkerContext, type WorkerRuntime } from "../worker/contextShims";
import type { MountSpec, W2H } from "../protocol";

// ============================================================================
// (1) validators: one gate, both doors
// ============================================================================

describe("PIVOT_DATA_ASPECTS", () => {
  it("is exactly the five Wave-3 data aspects", () => {
    expect([...PIVOT_DATA_ASPECTS].sort()).toEqual([
      "pivot.clearFilter",
      "pivot.setFilter",
      "pivot.setItemVisibility",
      "pivot.setNumberFormat",
      "pivot.sortField",
    ]);
  });

  it("adds NO allowlist rows — the aspects ride the existing setState doors", () => {
    for (const aspect of PIVOT_DATA_ASPECTS) {
      expect(ALLOWLIST[aspect], aspect).toBeUndefined();
      expect(ALLOWLIST[`api.${aspect.replace("pivot.", "pivot")}`]).toBeUndefined();
    }
    expect(ALLOWLIST["object.setState"]).toBeDefined();
    expect(ALLOWLIST["api.objectSetState"]).toBeDefined();
  });
});

describe("checkPivotDataAspect", () => {
  it("setFilter accepts a values array and null-to-clear", () => {
    expect(checkPivotDataAspect("pivot.setFilter", [["Region"], null])).not.toBe(true); // field must be a string
    expect(checkPivotDataAspect("pivot.setFilter", ["Region", ["West", "East"]])).toBe(true);
    expect(checkPivotDataAspect("pivot.setFilter", ["Region", []])).toBe(true);
    expect(checkPivotDataAspect("pivot.setFilter", ["Region", null])).toBe(true);
  });

  it("setFilter rejects non-string items, undefined, and an oversized list", () => {
    expect(checkPivotDataAspect("pivot.setFilter", ["Region", [1]])).toContain("string");
    expect(checkPivotDataAspect("pivot.setFilter", ["Region", undefined])).toContain("null to clear");
    expect(checkPivotDataAspect("pivot.setFilter", ["Region", "West"])).toContain("array");
    const many = Array.from({ length: MAX_PIVOT_FILTER_ITEMS + 1 }, () => "x");
    expect(checkPivotDataAspect("pivot.setFilter", ["Region", many])).toContain(
      `${MAX_PIVOT_FILTER_ITEMS}`,
    );
  });

  it("clearFilter needs only a field name", () => {
    expect(checkPivotDataAspect("pivot.clearFilter", ["Region"])).toBe(true);
    expect(checkPivotDataAspect("pivot.clearFilter", [""])).not.toBe(true);
    expect(checkPivotDataAspect("pivot.clearFilter", [])).not.toBe(true);
  });

  it("setItemVisibility: field + item (may be EMPTY — a blank source cell) + boolean", () => {
    expect(checkPivotDataAspect("pivot.setItemVisibility", ["Region", "West", false])).toBe(true);
    expect(checkPivotDataAspect("pivot.setItemVisibility", ["Region", "", true])).toBe(true);
    expect(checkPivotDataAspect("pivot.setItemVisibility", ["Region", 3, true])).toContain("item");
    expect(checkPivotDataAspect("pivot.setItemVisibility", ["Region", "West", "no"])).toContain(
      "visible must be a boolean",
    );
  });

  it("sortField takes asc|desc ONLY (no null — the backend cannot clear a sort)", () => {
    expect([...PIVOT_SORT_DIRECTIONS].sort()).toEqual(["asc", "desc"]);
    expect(checkPivotDataAspect("pivot.sortField", ["Region", "asc"])).toBe(true);
    expect(checkPivotDataAspect("pivot.sortField", ["Region", "desc"])).toBe(true);
    for (const bad of [null, "ascending", "ASC", undefined, 1]) {
      expect(checkPivotDataAspect("pivot.sortField", ["Region", bad]), String(bad)).toContain(
        "asc, desc",
      );
    }
  });

  it("setNumberFormat requires a non-empty format string", () => {
    expect(checkPivotDataAspect("pivot.setNumberFormat", ["Sales", "#,##0.00"])).toBe(true);
    expect(checkPivotDataAspect("pivot.setNumberFormat", ["Sales", ""])).toContain("non-empty");
    expect(checkPivotDataAspect("pivot.setNumberFormat", ["Sales", 2])).toContain("format");
  });

  it("BOTH doors land on this gate: vSetState and vObjectAspect reject the same payload", () => {
    const bad = ["Region", "sideways"];
    expect(vSetState(["pivot.sortField", bad])).toContain("asc, desc");
    expect(vObjectAspect(["pivot", "pivot-1", "pivot.sortField", bad])).toContain("asc, desc");
    const good = ["Region", "desc"];
    expect(vSetState(["pivot.sortField", good])).toBe(true);
    expect(vObjectAspect(["pivot", "pivot-1", "pivot.sortField", good])).toBe(true);
  });
});

// ============================================================================
// (2) host executors against a fake PivotApi
// ============================================================================

const HIERARCHIES = {
  hierarchies: [
    { index: 0, name: "Region", isNumeric: false },
    { index: 1, name: "Sales", isNumeric: true },
    { index: 2, name: "Month", isNumeric: false },
  ],
  rowHierarchies: [{ id: 10, name: "Region", fieldIndex: 0, position: 0 }],
  columnHierarchies: [],
  dataHierarchies: [
    { id: 20, name: "Sum of Sales", fieldIndex: 1, summarizeBy: "sum", position: 0 },
  ],
  filterHierarchies: [{ id: 30, name: "Month", fieldIndex: 2, position: 0 }],
};

function makeFakePivotApi(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    getAll: vi.fn(async () => []),
    getHierarchies: vi.fn(async () => HIERARCHIES),
    applyFilter: vi.fn(async () => ({})),
    clearFilter: vi.fn(async () => ({})),
    setItemVisibility: vi.fn(async () => ({})),
    sortField: vi.fn(async () => ({})),
    setNumberFormat: vi.fn(async () => ({})),
    getFieldInfo: vi.fn(async () => ({
      id: 2,
      name: "Month",
      showAllItems: false,
      filters: { manualFilter: { selectedItems: ["Jan"] } },
      isFiltered: true,
      subtotals: {},
      items: [{ id: 0, name: "Jan", isExpanded: true, visible: true }],
    })),
  };
}

describe("executePivotDataAspect", () => {
  let fake: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    fake = makeFakePivotApi();
    registerPivotApi(fake as unknown as PivotApi);
  });

  it("setFilter dispatches applyFilter with a MANUAL filter at the SOURCE index", async () => {
    await executePivotDataAspect("p1", "pivot.setFilter", ["Month", ["Jan", "Feb"]]);
    expect(fake.applyFilter).toHaveBeenCalledWith({
      pivotId: "p1",
      fieldIndex: 2,
      filters: { manualFilter: { selectedItems: ["Jan", "Feb"] } },
    });
    expect(fake.clearFilter).not.toHaveBeenCalled();
  });

  it("setFilter(field, null) dispatches clearFilter — null means NO filter", async () => {
    await executePivotDataAspect("p1", "pivot.setFilter", ["Month", null]);
    expect(fake.clearFilter).toHaveBeenCalledWith({ pivotId: "p1", fieldIndex: 2 });
    expect(fake.applyFilter).not.toHaveBeenCalled();
  });

  it("clearFilter dispatches clearFilter with NO filterType (clear every kind)", async () => {
    await executePivotDataAspect("p1", "pivot.clearFilter", ["region"]); // case-insensitive
    expect(fake.clearFilter).toHaveBeenCalledWith({ pivotId: "p1", fieldIndex: 0 });
  });

  it("setItemVisibility dispatches with the item name and flag", async () => {
    await executePivotDataAspect("p1", "pivot.setItemVisibility", ["Region", "West", false]);
    expect(fake.setItemVisibility).toHaveBeenCalledWith({
      pivotId: "p1",
      fieldIndex: 0,
      itemName: "West",
      visible: false,
    });
  });

  it("sortField translates asc/desc to the backend's ascending/descending", async () => {
    await executePivotDataAspect("p1", "pivot.sortField", ["Region", "desc"]);
    expect(fake.sortField).toHaveBeenCalledWith({
      pivotId: "p1",
      fieldIndex: 0,
      sortBy: "descending",
    });
    await executePivotDataAspect("p1", "pivot.sortField", ["Region", "asc"]);
    expect(fake.sortField).toHaveBeenLastCalledWith({
      pivotId: "p1",
      fieldIndex: 0,
      sortBy: "ascending",
    });
  });

  it("setNumberFormat addresses the value field by POSITION (like setAggregation)", async () => {
    // By display alias...
    await executePivotDataAspect("p1", "pivot.setNumberFormat", ["Sum of Sales", "#,##0.00"]);
    expect(fake.setNumberFormat).toHaveBeenCalledWith({
      pivotId: "p1",
      valueFieldIndex: 0,
      numberFormat: "#,##0.00",
    });
    // ...and by SOURCE column name.
    await executePivotDataAspect("p1", "pivot.setNumberFormat", ["Sales", "0.0%"]);
    expect(fake.setNumberFormat).toHaveBeenLastCalledWith({
      pivotId: "p1",
      valueFieldIndex: 0,
      numberFormat: "0.0%",
    });
  });

  it("setNumberFormat on a NON-value field lists the real value fields", async () => {
    await expect(
      executePivotDataAspect("p1", "pivot.setNumberFormat", ["Region", "0.00"]),
    ).rejects.toThrow('not a value field of this pivot. Value fields: Sum of Sales');
    expect(fake.setNumberFormat).not.toHaveBeenCalled();
  });

  it("an unknown FIELD fails with the available source fields listed", async () => {
    await expect(
      executePivotDataAspect("p1", "pivot.setFilter", ["Regoin", ["West"]]),
    ).rejects.toThrow("Available fields: Region, Sales, Month");
  });
});

describe("executePivotFieldInfo (the read twin)", () => {
  it("resolves the field name to its source index and returns the info", async () => {
    const fake = makeFakePivotApi();
    registerPivotApi(fake as unknown as PivotApi);
    const info = (await executePivotFieldInfo("p1", "Month")) as { isFiltered: boolean };
    expect(fake.getFieldInfo).toHaveBeenCalledWith("p1", 2);
    expect(info.isFiltered).toBe(true);
  });

  it("refuses an empty field name before touching the pivot", async () => {
    const fake = makeFakePivotApi();
    registerPivotApi(fake as unknown as PivotApi);
    await expect(executePivotFieldInfo("p1", "  ")).rejects.toThrow("non-empty field name");
    expect(fake.getFieldInfo).not.toHaveBeenCalled();
  });
});

// ============================================================================
// (3) worker shims: cross-instance handle + own-object context
// ============================================================================

interface PostedCall {
  callId: number;
  method: string;
  args: unknown[];
}

function makeContext(objectType: string, instanceId: string | null): {
  context: Record<string, unknown>;
  rt: WorkerRuntime;
  calls: PostedCall[];
  drain: () => void;
} {
  const calls: PostedCall[] = [];
  const spec = {
    protocolVersion: 1,
    scriptId: "wave3-pivot-test",
    objectType,
    instanceId,
    tier: "unlocked",
    capabilities: [],
    apiVersion: "1.0.0",
    scriptName: "Wave3Pivot",
    packageInfo: null,
    snapshot: {},
    source: "",
  } as unknown as MountSpec;
  const { context, rt } = buildWorkerContext(spec, (msg: W2H) => {
    if (msg.t === "call") calls.push({ callId: msg.callId, method: msg.method, args: msg.args });
  });
  const drain = (): void => {
    for (const entry of rt.pending.values()) clearTimeout(entry.timer);
    rt.pending.clear();
  };
  return { context, rt, calls, drain };
}

describe("worker shim: api.pivot(id) handle", () => {
  it("each data method dispatches api.objectSetState/GetState with the aspect + args", () => {
    const { context, calls, drain } = makeContext("sheet", null);
    const api = context.api as Record<string, unknown>;
    const handle = (api.pivot as (id: string) => Record<string, unknown>)("p9");
    void (handle.setFilter as (...a: unknown[]) => Promise<unknown>)("Region", ["West"]);
    void (handle.clearFilter as (...a: unknown[]) => Promise<unknown>)("Region");
    void (handle.setItemVisibility as (...a: unknown[]) => Promise<unknown>)("Region", "West", false);
    void (handle.sortField as (...a: unknown[]) => Promise<unknown>)("Region", "desc");
    void (handle.setNumberFormat as (...a: unknown[]) => Promise<unknown>)("Sales", "#,##0");
    void (handle.getFieldInfo as (...a: unknown[]) => Promise<unknown>)("Region");
    expect(calls.map((c) => [c.method, ...c.args])).toEqual([
      ["api.objectSetState", "pivot", "p9", "pivot.setFilter", ["Region", ["West"]]],
      ["api.objectSetState", "pivot", "p9", "pivot.clearFilter", ["Region"]],
      ["api.objectSetState", "pivot", "p9", "pivot.setItemVisibility", ["Region", "West", false]],
      ["api.objectSetState", "pivot", "p9", "pivot.sortField", ["Region", "desc"]],
      ["api.objectSetState", "pivot", "p9", "pivot.setNumberFormat", ["Sales", "#,##0"]],
      ["api.objectGetState", "pivot", "p9", "pivot.getFieldInfo", ["Region"]],
    ]);
    drain();
  });
});

describe("worker shim: own-pivot context", () => {
  it("the same methods go through object.setState/getState (instance pinned host-side)", () => {
    const { context, calls, drain } = makeContext("pivot", "pivot-own");
    void (context.setFilter as (...a: unknown[]) => Promise<unknown>)("Region", null);
    void (context.sortField as (...a: unknown[]) => Promise<unknown>)("Region", "asc");
    void (context.setNumberFormat as (...a: unknown[]) => Promise<unknown>)("Sales", "0%");
    void (context.getFieldInfo as (...a: unknown[]) => Promise<unknown>)("Region");
    expect(calls.map((c) => [c.method, ...c.args])).toEqual([
      ["object.setState", "pivot.setFilter", ["Region", null]],
      ["object.setState", "pivot.sortField", ["Region", "asc"]],
      ["object.setState", "pivot.setNumberFormat", ["Sales", "0%"]],
      ["object.getState", "pivot.getFieldInfo", ["Region"]],
    ]);
    drain();
  });
});

// ============================================================================
// (4) generated typings
// ============================================================================

describe("generated typings", () => {
  const typingsSrc = fs.readFileSync(
    path.resolve(__dirname, "../../../../extensions/ScriptableObjects/objectContexts.d.ts"),
    "utf8",
  );

  it("declare the data aspects on BOTH the handle and the own-pivot context", () => {
    for (const member of [
      "setFilter(field: string, values: string[] | null): Promise<void>;",
      "clearFilter(field: string): Promise<void>;",
      "setItemVisibility(field: string, item: string, visible: boolean): Promise<void>;",
      'sortField(field: string, direction: "asc" | "desc"): Promise<void>;',
      "setNumberFormat(valueField: string, format: string): Promise<void>;",
      "getFieldInfo(field: string): Promise<ScriptPivotFieldInfo>;",
    ]) {
      const hits = typingsSrc.split(member).length - 1;
      expect(hits, member).toBeGreaterThanOrEqual(2);
    }
  });
});
