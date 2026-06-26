//! FILENAME: app/extensions/Charts/lib/__tests__/chartSelection.test.ts
// PURPOSE: C5 slice 3 — point selection -> highlight. Covers the inSelection
//          conditional-encoding branch (empty = all-in), the ephemeral store,
//          and the pure click-to-key helpers.

import { describe, it, expect, beforeEach } from "vitest";
import { resolvePointColor, resolvePointOpacity } from "../encodingResolver";
import {
  getPointSelection, setPointSelection, clearPointSelection, clearAllPointSelections,
  pointSelectionKey, buildPointSelection, isDataHit, SELECTION_SUPPORTED_MARKS,
} from "../../handlers/chartPointSelection";
import type { SeriesEncoding, ChartSelectionMap } from "../../types";

const HOT = "#hot";
const DIM = "#dim";
// A color encoding that highlights datums in the "sel" selection, dims the rest.
const enc: SeriesEncoding = { color: { condition: { field: "category", inSelection: "sel" }, value: HOT, otherwise: DIM } };
const color = (category: string, seriesName: string, selection?: ChartSelectionMap) =>
  resolvePointColor(enc, "default", 0, null, 1, category, { seriesName, selection });

describe("inSelection conditional encoding", () => {
  it("treats an empty/absent selection as all-in (normal before first click)", () => {
    expect(color("North", "S", undefined)).toBe(HOT);
    expect(color("North", "S", {})).toBe(HOT);
    expect(color("North", "S", { sel: { on: "category", values: [] } })).toBe(HOT);
  });

  it("highlights members and dims non-members (on: category)", () => {
    const selection: ChartSelectionMap = { sel: { on: "category", values: ["North"] } };
    expect(color("North", "S", selection)).toBe(HOT);
    expect(color("South", "S", selection)).toBe(DIM);
  });

  it("keys on series name when on: series", () => {
    const selection: ChartSelectionMap = { sel: { on: "series", values: ["S1"] } };
    expect(color("North", "S1", selection)).toBe(HOT);
    expect(color("North", "S2", selection)).toBe(DIM);
  });

  it("does not affect non-inSelection conditions or static encodings", () => {
    // Static color: unaffected by selection.
    expect(resolvePointColor({ color: "#abc" }, "default", 0, null, 1, "North", { seriesName: "S", selection: { sel: { on: "category", values: ["X"] } } })).toBe("#abc");
    // A value-threshold condition still works with no selection context.
    const threshold: SeriesEncoding = { opacity: { condition: { field: "value", lt: 0 }, value: 0.3, otherwise: 1 } };
    expect(resolvePointOpacity(threshold, -5, "North")).toBe(0.3);
    expect(resolvePointOpacity(threshold, 5, "North")).toBe(1);
  });
});

describe("ephemeral point-selection store", () => {
  beforeEach(() => clearAllPointSelections());

  it("sets, gets, and clears per chart", () => {
    const sel: ChartSelectionMap = { sel: { on: "category", values: ["North"] } };
    expect(getPointSelection("c1")).toBeUndefined();
    setPointSelection("c1", sel);
    expect(getPointSelection("c1")).toEqual(sel);
    expect(clearPointSelection("c1")).toBe(true);
    expect(getPointSelection("c1")).toBeUndefined();
  });

  it("isolates charts and clears all", () => {
    setPointSelection("a", { s: { on: "category", values: ["1"] } });
    setPointSelection("b", { s: { on: "series", values: ["2"] } });
    clearAllPointSelections();
    expect(getPointSelection("a")).toBeUndefined();
    expect(getPointSelection("b")).toBeUndefined();
  });
});

describe("click-to-key helpers", () => {
  it("pointSelectionKey picks category or series per mode", () => {
    const hit = { seriesName: "Revenue", categoryName: "Jan" };
    expect(pointSelectionKey(hit, "category")).toBe("Jan");
    expect(pointSelectionKey(hit, "series")).toBe("Revenue");
    expect(pointSelectionKey({}, "category")).toBe("");
  });

  it("buildPointSelection produces a single-datum map", () => {
    expect(buildPointSelection("sel", "category", "Jan")).toEqual({ sel: { on: "category", values: ["Jan"] } });
  });

  it("isDataHit distinguishes real datums from background/axis/miss", () => {
    // hitTestGeometry always returns an object — a background click must NOT set
    // a selection (it would store an empty-string key and dim the whole chart).
    expect(isDataHit({ type: "bar" })).toBe(true);
    expect(isDataHit({ type: "point" })).toBe(true);
    expect(isDataHit({ type: "slice" })).toBe(true);
    expect(isDataHit({ type: "plotArea" })).toBe(false);
    expect(isDataHit({ type: "axis" })).toBe(false);
    expect(isDataHit({ type: "none" })).toBe(false);
    expect(isDataHit(null)).toBe(false);
  });

  it("gates click capture to marks whose painters consume the selection", () => {
    for (const m of ["bar", "horizontalBar", "scatter", "bubble"]) expect(SELECTION_SUPPORTED_MARKS.has(m)).toBe(true);
    for (const m of ["pie", "donut", "line", "area", "radar"]) expect(SELECTION_SUPPORTED_MARKS.has(m)).toBe(false);
  });
});
