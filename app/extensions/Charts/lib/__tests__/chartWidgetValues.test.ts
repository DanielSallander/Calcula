//! FILENAME: app/extensions/Charts/lib/__tests__/chartWidgetValues.test.ts
// PURPOSE: C5 S5 (bind widgets) data foundation — ephemeral widget-value store,
//          the stepper/cycle next-value semantics, and the resolveParams
//          precedence (widget value > cellRef > literal). The on-canvas control
//          that SETS these is a follow-up; this is the testable foundation.

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../dataSourceResolver", () => ({ resolveParamCell: vi.fn() }));

import { resolveParamCell } from "../dataSourceResolver";
import {
  getWidgetValue, setWidgetValue, clearWidgetValues, clearAllWidgetValues, nextWidgetValue,
} from "../../handlers/chartWidgetValues";
import { resolveParams } from "../chartParams";
import type { ChartSpec, ParamSpec, ParamBinding } from "../../types";

const mockCell = resolveParamCell as unknown as ReturnType<typeof vi.fn>;
const spec = (params: ParamSpec[]): ChartSpec => ({ data: "Sheet1!A1:B3", params } as unknown as ChartSpec);

beforeEach(() => { clearAllWidgetValues(); mockCell.mockReset(); });

describe("widget-value store", () => {
  it("sets, gets, and clears per chart + param", () => {
    expect(getWidgetValue("c1", "p")).toBeUndefined();
    setWidgetValue("c1", "p", 5);
    setWidgetValue("c1", "q", "x");
    expect(getWidgetValue("c1", "p")).toBe(5);
    expect(getWidgetValue("c1", "q")).toBe("x");
    expect(clearWidgetValues("c1")).toBe(true);
    expect(getWidgetValue("c1", "p")).toBeUndefined();
  });
});

describe("nextWidgetValue", () => {
  const stepper: ParamBinding = { input: "stepper", min: 0, max: 10, step: 2 };
  it("steps and clamps to min/max", () => {
    expect(nextWidgetValue(stepper, 4, 1)).toBe(6);
    expect(nextWidgetValue(stepper, 10, 1)).toBe(10); // clamp max
    expect(nextWidgetValue(stepper, 0, -1)).toBe(0);  // clamp min
    expect(nextWidgetValue(stepper, undefined, 1)).toBe(2); // from min default
  });

  it("cycles options with wraparound", () => {
    const cycle: ParamBinding = { input: "cycle", options: ["a", "b", "c"] };
    expect(nextWidgetValue(cycle, "a", 1)).toBe("b");
    expect(nextWidgetValue(cycle, "c", 1)).toBe("a"); // wrap forward
    expect(nextWidgetValue(cycle, "a", -1)).toBe("c"); // wrap back
    expect(nextWidgetValue(cycle, undefined, 1)).toBe("a"); // unknown -> first
  });
});

describe("resolveParams widget precedence (S5)", () => {
  it("prefers the live widget value over cellRef and literal", async () => {
    mockCell.mockResolvedValue("42");
    setWidgetValue("c1", "T", 7);
    const map = await resolveParams(spec([{ name: "T", value: 100, cellRef: "=B1" }]), "c1");
    expect(map.get("T")).toBe(7); // widget wins over both
    expect(mockCell).not.toHaveBeenCalled(); // widget short-circuits the cell read
  });

  it("falls back to cellRef/literal when no widget value is set", async () => {
    mockCell.mockResolvedValue("42");
    const map = await resolveParams(spec([{ name: "T", value: 100, cellRef: "=B1" }]), "c1");
    expect(map.get("T")).toBe(42);
  });

  it("ignores widget values when no chartId is passed (previews/export)", async () => {
    setWidgetValue("c1", "T", 7);
    const map = await resolveParams(spec([{ name: "T", value: 100 }]));
    expect(map.get("T")).toBe(100);
  });
});
