//! FILENAME: app/extensions/Charts/lib/__tests__/stackModeCombo.test.ts
// PURPOSE: The one stack-mode reader/writer (lib/stackMode.ts) knows the combo:
//          Grouped and Stacked (Power BI's "Line and clustered column" / "Line
//          and stacked column"), and never 100%, which a combo cannot draw.

import { describe, it, expect } from "vitest";
import type { ChartSpec } from "../../types";
import { getStackModeFromSpec, setStackModeInOptions, supportsStacking, stackModesFor } from "../stackMode";

function combo(markOptions?: Record<string, unknown>): ChartSpec {
  return { mark: "combo", markOptions } as unknown as ChartSpec;
}

describe("stackMode: combo", () => {
  it("a combo can stack", () => {
    expect(supportsStacking("combo")).toBe(true);
  });

  it("offers grouped and stacked to a combo, all three to a column, none to a scatter", () => {
    expect(stackModesFor("combo")).toEqual(["none", "stacked"]);
    expect(stackModesFor("bar")).toEqual(["none", "stacked", "percentStacked"]);
    expect(stackModesFor("scatter")).toEqual([]);
  });

  it("reads 'stacked' only when the combo says stacked", () => {
    expect(getStackModeFromSpec(combo())).toBe("none");
    expect(getStackModeFromSpec(combo({ stackMode: "stacked" }))).toBe("stacked");
    // A leftover 100% from a column chart is not something a combo draws.
    expect(getStackModeFromSpec(combo({ stackMode: "percentStacked" }))).toBe("none");
  });

  it("writes the combo's stackMode and keeps its other options", () => {
    expect(setStackModeInOptions(combo({ secondaryYAxis: true }), "stacked")).toEqual({ secondaryYAxis: true, stackMode: "stacked" });
    expect(setStackModeInOptions(combo({ stackMode: "stacked" }), "none")).toEqual({ stackMode: "none" });
  });

  it("refuses to write a 100% stack on a combo (the options come back unchanged)", () => {
    expect(setStackModeInOptions(combo({ stackMode: "stacked" }), "percentStacked")).toEqual({ stackMode: "stacked" });
  });
});
