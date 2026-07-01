import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@api/chartParams", () => ({
  getChartParamValue: vi.fn(),
  setChartParamValue: vi.fn(),
  clearChartParamValue: vi.fn(),
}));

import { getChartParamValue, setChartParamValue, clearChartParamValue } from "@api/chartParams";
import { createChartParamDriver, buildSequence } from "../chartParamDriver";

beforeEach(() => vi.clearAllMocks());

describe("buildSequence", () => {
  it("range yields inclusive, FP-clean values", () => {
    expect(buildSequence({ kind: "range", from: 0, to: 4, step: 1 })).toEqual([0, 1, 2, 3, 4]);
    expect(buildSequence({ kind: "range", from: 0, to: 1, step: 0.1 })).toEqual([
      0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1,
    ]);
    expect(buildSequence({ kind: "range", from: 0, to: 10, step: 0 })).toEqual([0]);
    expect(buildSequence({ kind: "range", from: 0, to: 10, step: -1 })).toEqual([0]); // step away from `to`
  });

  it("options pass through unchanged", () => {
    expect(buildSequence({ kind: "options", options: ["a", "b", "c"] })).toEqual(["a", "b", "c"]);
  });
});

describe("chart-param driver", () => {
  it("frameCount = sequence length; applyFrame sets the param value (no IPC)", async () => {
    const d = createChartParamDriver({
      chartId: "c1",
      paramName: "year",
      sequence: { kind: "range", from: 2000, to: 2002, step: 1 },
    });
    expect(d.frameCount).toBe(3);
    await d.applyFrame(1);
    expect(setChartParamValue).toHaveBeenCalledWith("c1", "year", 2001);
    expect(d.frameLabel?.(2)).toBe("2002");
  });

  it("snapshot captures the prior value; restore sets it back", async () => {
    vi.mocked(getChartParamValue).mockReturnValue(2010);
    const d = createChartParamDriver({
      chartId: "c1",
      paramName: "year",
      sequence: { kind: "range", from: 2000, to: 2005, step: 1 },
    });
    await d.snapshot();
    expect(getChartParamValue).toHaveBeenCalledWith("c1", "year");
    await d.restore();
    expect(setChartParamValue).toHaveBeenLastCalledWith("c1", "year", 2010);
    expect(clearChartParamValue).not.toHaveBeenCalled();
  });

  it("restore clears the param when there was no prior value", async () => {
    vi.mocked(getChartParamValue).mockReturnValue(undefined);
    const d = createChartParamDriver({
      chartId: "c1",
      paramName: "mode",
      sequence: { kind: "options", options: ["x", "y"] },
    });
    await d.snapshot();
    await d.restore();
    expect(clearChartParamValue).toHaveBeenCalledWith("c1", "mode");
  });
});
