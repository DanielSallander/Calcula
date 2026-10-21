//! FILENAME: app/src/api/__tests__/modelVisuals.test.ts
// PURPOSE: @api/modelVisuals (P4): each family registers ONE provider that
//          lists its visuals with their cross-filter roles; readers list and
//          look up across families without importing any of them.
// CONTEXT: The P4 spec's first plan also had an EFFECT registry here (run in
//          registration order, one failure rejecting the run). The revised
//          spec (DC-9, review B4) moved the one side effect -- a model slicer
//          -> BI pivot pair moving to or from none -- into Rust, inside
//          set_canvas_layout's own undo step on every door, so this seam has
//          no effects; what is pinned instead is that one failing PROVIDER
//          hides no other family's visuals.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  listModelVisuals,
  modelVisualOf,
  registerModelVisualProvider,
  type ModelVisualInfo,
} from "../modelVisuals";

const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
  vi.restoreAllMocks();
});

function info(kind: ModelVisualInfo["ref"]["kind"], id: string, over: Partial<ModelVisualInfo> = {}): ModelVisualInfo {
  return {
    ref: { kind, id },
    name: id,
    sheetIndex: 1,
    sheetId: "p1",
    connectionId: "conn-a",
    role: { source: true, target: true, canHighlight: kind === "chart", reason: null },
    label: kind === "chart" ? "Column chart" : kind === "pivot" ? "PivotTable" : "Slicer",
    ...over,
  };
}

describe("@api/modelVisuals", () => {
  it("lists every provider's visuals in registration order, and unregister removes them", () => {
    offs.push(registerModelVisualProvider({ kind: "chart", list: () => [info("chart", "c1"), info("chart", "c2")] }));
    const offPivot = registerModelVisualProvider({ kind: "pivot", list: () => [info("pivot", "pv1")] });
    offs.push(registerModelVisualProvider({ kind: "slicer", list: () => [info("slicer", "s1")] }));

    expect(listModelVisuals().map((v) => `${v.ref.kind}:${v.ref.id}`)).toEqual([
      "chart:c1",
      "chart:c2",
      "pivot:pv1",
      "slicer:s1",
    ]);
    offPivot();
    offPivot();
    expect(listModelVisuals().map((v) => v.ref.id)).toEqual(["c1", "c2", "s1"]);
  });

  it("filters by connection and by page; a visual that reads cells has connectionId null and a reason", () => {
    offs.push(
      registerModelVisualProvider({
        kind: "chart",
        list: () => [
          info("chart", "dq", { sheetId: "p1" }),
          info("chart", "other-model", { connectionId: "conn-b" }),
          info("chart", "elsewhere", { sheetId: "p2" }),
          info("chart", "range", {
            connectionId: null,
            role: { source: false, target: false, canHighlight: false, reason: "Reads cells, not the model" },
          }),
        ],
      }),
    );

    expect(listModelVisuals({ connectionId: "conn-a" }).map((v) => v.ref.id)).toEqual(["dq", "elsewhere"]);
    expect(listModelVisuals({ sheetId: "p1" }).map((v) => v.ref.id)).toEqual(["dq", "other-model", "range"]);
    expect(listModelVisuals({ connectionId: "conn-a", sheetId: "p1" }).map((v) => v.ref.id)).toEqual(["dq"]);
    expect(modelVisualOf({ kind: "chart", id: "range" })?.role.reason).toBe("Reads cells, not the model");
  });

  it("looks one visual up by ref (kind AND id), null when no provider lists it", () => {
    offs.push(registerModelVisualProvider({ kind: "chart", list: () => [info("chart", "x")] }));
    offs.push(registerModelVisualProvider({ kind: "pivot", list: () => [info("pivot", "x")] }));
    expect(modelVisualOf({ kind: "pivot", id: "x" })?.label).toBe("PivotTable");
    expect(modelVisualOf({ kind: "slicer", id: "x" })).toBeNull();
  });

  it("one failing provider hides no other family's visuals (and says so in the console)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    offs.push(
      registerModelVisualProvider({
        kind: "chart",
        list: () => {
          throw new Error("store not ready");
        },
      }),
    );
    offs.push(registerModelVisualProvider({ kind: "slicer", list: () => [info("slicer", "s1")] }));
    expect(listModelVisuals().map((v) => v.ref.id)).toEqual(["s1"]);
    expect(warn).toHaveBeenCalled();
  });
});
