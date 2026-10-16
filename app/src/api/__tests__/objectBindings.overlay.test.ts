//! FILENAME: app/src/api/__tests__/objectBindings.overlay.test.ts
// PURPOSE: `overlayResolved` is how charts, slicers, timelines and canvas pages
//          PAINT a bound property: a copy of the literal JSON with the resolved
//          values applied by the D §3.16 rules -- pending skipped, a non-text
//          error keeps the literal, a text slot shows `display` (errors
//          included), array items never padded, object members created, and
//          the input is never mutated.
// CONTEXT: The real cache and catalog; values are put in the cache the way the
//          bridge does (`applyResolvedValues`).

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ObjectBindingRef, ResolvedBinding } from "../types";

vi.mock("../backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backend")>()),
  invokeBackend: async () => {
    throw new Error("no backend in this test");
  },
}));

let cache: typeof import("../objectBindings/cache");
let overlay: typeof import("../objectBindings/overlay");

const CHART: ObjectBindingRef = { kind: "chart", id: "c1" };
const SLICER: ObjectBindingRef = { kind: "slicer", id: "s1" };

function rb(object: ObjectBindingRef, p: string, over: Partial<ResolvedBinding>): ResolvedBinding {
  return { object, path: p, value: null, display: "", error: null, pending: false, ...over };
}

beforeEach(async () => {
  vi.resetModules();
  cache = await import("../objectBindings/cache");
  overlay = await import("../objectBindings/overlay");
});

describe("overlayResolved", () => {
  it("returns the very input when the object has no resolved binding (no copy cost)", () => {
    const spec = { title: "Literal" };
    expect(overlay.overlayResolved(CHART, "/spec", spec)).toBe(spec);
  });

  it("applies a text binding's display and a number binding's value under the root", () => {
    cache.applyResolvedValues([
      rb(CHART, "/spec/title", { value: "Revenue 2025", display: "Revenue 2025" }),
      rb(CHART, "/spec/markOptions/goal", { value: 1200, display: "1,200" }),
    ]);
    const spec = { title: "Literal", markOptions: { goal: 5 } };
    const out = overlay.overlayResolved(CHART, "/spec", spec);
    expect(out).toEqual({ title: "Revenue 2025", markOptions: { goal: 1200 } });
  });

  it("does not mutate its input", () => {
    cache.applyResolvedValues([rb(CHART, "/spec/xAxis/title", { value: "Month", display: "Month" })]);
    const spec = { title: "T", xAxis: { title: "x", min: 0 } };
    const frozen = JSON.stringify(spec);
    const out = overlay.overlayResolved(CHART, "/spec", spec);
    expect(JSON.stringify(spec)).toBe(frozen);
    expect(out).not.toBe(spec);
    expect((out as typeof spec).xAxis).not.toBe(spec.xAxis);
    expect(out).toEqual({ title: "T", xAxis: { title: "Month", min: 0 } });
  });

  it("skips a PENDING value: the literal stays (a measure not fetched yet never flashes blank)", () => {
    cache.applyResolvedValues([
      rb(CHART, "/spec/title", { value: null, display: "", pending: true }),
      rb(CHART, "/spec/markOptions/goal", { value: null, pending: true }),
    ]);
    const spec = { title: "Literal", markOptions: { goal: 5 } };
    expect(overlay.overlayResolved(CHART, "/spec", spec)).toEqual(spec);
  });

  it("keeps the literal on a NON-TEXT error, but a TEXT slot shows the error display", () => {
    cache.applyResolvedValues([
      rb(CHART, "/spec/markOptions/goal", { value: null, display: "#REF!", error: "The cell was deleted." }),
      rb(CHART, "/spec/config/theme/titleColor", { value: null, display: "#VALUE!", error: "Not a colour." }),
      rb(CHART, "/spec/title", { value: null, display: "#REF!", error: "The cell was deleted." }),
    ]);
    const spec = { title: "Literal", markOptions: { goal: 5 }, config: { theme: { titleColor: "#000000" } } };
    expect(overlay.overlayResolved(CHART, "/spec", spec)).toEqual({
      title: "#REF!",
      markOptions: { goal: 5 },
      config: { theme: { titleColor: "#000000" } },
    });
  });

  it("applies array-wildcard paths to an existing item and never pads an array", () => {
    cache.applyResolvedValues([
      rb(CHART, "/spec/series/1/name", { value: "East", display: "East" }),
      rb(CHART, "/spec/series/5/name", { value: "Ghost", display: "Ghost" }),
      rb(CHART, "/spec/seriesColors/Revenue 2024", { value: "#ff0000", display: "#ff0000" }),
    ]);
    const spec = { series: [{ name: "A" }, { name: "B" }], seriesColors: {} };
    const out = overlay.overlayResolved(CHART, "/spec", spec) as typeof spec;
    expect(out.series).toEqual([{ name: "A" }, { name: "East" }]);
    expect(out.series.length).toBe(2);
    expect(out.seriesColors).toEqual({ "Revenue 2024": "#ff0000" });
  });

  it("creates a missing OBJECT member on the way (a chart without an xAxis gains one)", () => {
    cache.applyResolvedValues([rb(CHART, "/spec/xAxis/title", { value: "Month", display: "Month" })]);
    expect(overlay.overlayResolved(CHART, "/spec", { title: "T" })).toEqual({ title: "T", xAxis: { title: "Month" } });
  });

  it("ignores values outside the root and reads a whole record at root ''", () => {
    cache.applyResolvedValues([
      rb(SLICER, "/headerText", { value: "Region", display: "Region" }),
      rb(SLICER, "/showHeader", { value: false, display: "FALSE" }),
    ]);
    const slicer = { id: "s1", headerText: "Literal", showHeader: true };
    expect(overlay.overlayResolved(SLICER, "", slicer)).toEqual({ id: "s1", headerText: "Region", showHeader: false });
    // A chart root that is not "/spec" sees nothing of the spec's values.
    cache.applyResolvedValues([rb(CHART, "/spec/title", { value: "X", display: "X" })]);
    const other = { title: "keep" };
    expect(overlay.overlayResolved(CHART, "/spec/config", other)).toBe(other);
  });

  it("paints nothing for a path the catalog does not know (a stale value of a removed row)", () => {
    cache.applyResolvedValues([rb(CHART, "/spec/legend/position", { value: "top", display: "top" })]);
    const spec = { legend: { position: "right" } };
    expect(overlay.overlayResolved(CHART, "/spec", spec)).toEqual(spec);
  });

  it("only touches the object it is asked about", () => {
    cache.applyResolvedValues([rb({ kind: "chart", id: "other" }, "/spec/title", { value: "Other", display: "Other" })]);
    const spec = { title: "Mine" };
    expect(overlay.overlayResolved(CHART, "/spec", spec)).toBe(spec);
  });
});
