//! FILENAME: app/extensions/Charts/lib/__tests__/chartStoreMergePreview.test.ts
// PURPOSE: B8 slice A — mergeSpecPreview computes the deep-merged spec WITHOUT
//          committing, so the broker chart-write path can validate the merged
//          result and reject (throw) before any mutation reaches the store. This
//          test proves preview is non-mutating and composes with the validator.

import { describe, it, expect, vi, beforeEach } from "vitest";

// chartStore persists via @api/backend (Tauri). Stub it so the store is testable
// off the desktop shell — createChart fire-and-forgets the save.
vi.mock("@api/backend", () => ({ invokeBackend: vi.fn().mockResolvedValue(undefined) }));

import { createChart, getChartById, mergeSpecPreview, replaceChartSpec, resetChartStore } from "../chartStore";
import { validateMergedSpec } from "../chartSpecValidate";
import type { ChartSpec } from "../../types";

const baseSpec: ChartSpec = {
  mark: "bar",
  data: "Sheet1!A1:D13",
  hasHeaders: true,
  seriesOrientation: "columns",
  categoryIndex: 0,
  series: [{ name: "Revenue", sourceIndex: 1, color: null }],
  title: "Original",
  xAxis: { title: null, gridLines: false, showLabels: true, labelAngle: 0, min: null, max: null },
  yAxis: { title: null, gridLines: true, showLabels: true, labelAngle: 0, min: null, max: null },
  legend: { visible: false, position: "bottom" },
  palette: "default",
};

beforeEach(() => resetChartStore());

function makeChart(): string {
  return createChart(structuredClone(baseSpec), { sheetIndex: 0, x: 0, y: 0, width: 400, height: 300 }).chartId;
}

describe("mergeSpecPreview + validate (B8 chart-write gate composition)", () => {
  it("returns the deep-merged spec WITHOUT mutating the stored chart", () => {
    const id = makeChart();
    const merged = mergeSpecPreview(id, { title: "Patched" });
    expect(merged?.title).toBe("Patched");
    // The store is untouched until the caller decides to commit.
    expect(getChartById(id)?.spec.title).toBe("Original");
  });

  it("deep-merges nested objects (axis siblings preserved)", () => {
    const id = makeChart();
    const merged = mergeSpecPreview(id, { yAxis: { min: 5 } } as Partial<ChartSpec>);
    expect(merged?.yAxis.min).toBe(5);
    expect(merged?.yAxis.showLabels).toBe(true); // sibling kept
  });

  it("returns null for an unknown chart (impl no-ops)", () => {
    expect(mergeSpecPreview("does-not-exist", { title: "x" })).toBeNull();
  });

  it("a valid patch produces a clean merged spec; a garbage patch is caught", () => {
    const id = makeChart();
    const good = mergeSpecPreview(id, { title: "New" })!;
    expect(validateMergedSpec(good)).toEqual([]);

    const bad = mergeSpecPreview(id, { bogusKey: 1 } as unknown as Partial<ChartSpec>)!;
    expect(validateMergedSpec(bad).join(" ")).toContain("bogusKey");
    // Crucially the chart was never mutated by the (rejected) preview.
    expect(getChartById(id)?.spec).not.toHaveProperty("bogusKey");
  });

  it("commit path: replaceChartSpec applies a validated merged spec", () => {
    const id = makeChart();
    const merged = mergeSpecPreview(id, { title: "Committed" })!;
    expect(validateMergedSpec(merged)).toEqual([]);
    replaceChartSpec(id, merged);
    expect(getChartById(id)?.spec.title).toBe("Committed");
  });
});
