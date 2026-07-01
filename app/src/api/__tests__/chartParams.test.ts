import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerChartParamController,
  getChartParamController,
  listAnimatableCharts,
  listChartParams,
  getChartParamValue,
  setChartParamValue,
  clearChartParamValue,
  type ChartParamController,
} from "../chartParams";

function makeController(o: Partial<ChartParamController> = {}): ChartParamController {
  return {
    listAnimatableCharts: vi.fn().mockReturnValue([]),
    listParams: vi.fn().mockReturnValue([]),
    getParamValue: vi.fn().mockReturnValue(undefined),
    setParamValue: vi.fn(),
    clearParamValue: vi.fn(),
    ...o,
  };
}

beforeEach(() => registerChartParamController(null));

describe("@api/chartParams IoC facade", () => {
  it("degrades gracefully when no controller is registered", () => {
    expect(getChartParamController()).toBeNull();
    expect(listAnimatableCharts()).toEqual([]);
    expect(listChartParams("c1")).toEqual([]);
    expect(getChartParamValue("c1", "p")).toBeUndefined();
    expect(() => setChartParamValue("c1", "p", 5)).not.toThrow();
    expect(() => clearChartParamValue("c1", "p")).not.toThrow();
  });

  it("delegates to the registered controller", () => {
    const ctl = makeController({
      listAnimatableCharts: vi.fn().mockReturnValue([{ chartId: "c1", name: "Chart 1", sheetIndex: 0 }]),
      listParams: vi
        .fn()
        .mockReturnValue([{ name: "year", bind: { input: "stepper", min: 2000, max: 2020, step: 1 } }]),
      getParamValue: vi.fn().mockReturnValue(2010),
    });
    registerChartParamController(ctl);

    expect(listAnimatableCharts(0)).toEqual([{ chartId: "c1", name: "Chart 1", sheetIndex: 0 }]);
    expect(ctl.listAnimatableCharts).toHaveBeenCalledWith(0);
    expect(listChartParams("c1")[0]?.name).toBe("year");
    expect(getChartParamValue("c1", "year")).toBe(2010);

    setChartParamValue("c1", "year", 2015);
    expect(ctl.setParamValue).toHaveBeenCalledWith("c1", "year", 2015);
    clearChartParamValue("c1", "year");
    expect(ctl.clearParamValue).toHaveBeenCalledWith("c1", "year");
  });
});
