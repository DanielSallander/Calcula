//! FILENAME: app/extensions/Charts/rendering/__tests__/paramWidgets.test.ts
// PURPOSE: C5 S5 on-canvas controls — layout (zones per control kind) + hit-test.

import { describe, it, expect } from "vitest";
import { computeWidgetControls, hitTestWidgetControls, hasWidgetControls } from "../paramWidgets";
import type { ChartSpec, ParamSpec } from "../../types";

const spec = (params: ParamSpec[]): ChartSpec => ({ params } as unknown as ChartSpec);
const val = () => "5";

describe("hasWidgetControls", () => {
  it("is true only when a param declares a bind", () => {
    expect(hasWidgetControls(spec([{ name: "T", bind: { input: "stepper" } }]))).toBe(true);
    expect(hasWidgetControls(spec([{ name: "T" }]))).toBe(false);
    expect(hasWidgetControls(spec([{ name: "", bind: { input: "cycle" } }]))).toBe(false); // no name
    expect(hasWidgetControls({} as ChartSpec)).toBe(false);
  });
});

describe("computeWidgetControls", () => {
  it("stepper has two zones (- / +)", () => {
    const [c] = computeWidgetControls(spec([{ name: "T", bind: { input: "stepper", min: 0, max: 10 } }]), 100, 50, val);
    expect(c.bind.input).toBe("stepper");
    expect(c.zones.map((z) => z.action)).toEqual([{ dir: -1 }, { dir: 1 }]);
  });

  it("cycle has one forward zone", () => {
    const [c] = computeWidgetControls(spec([{ name: "T", bind: { input: "cycle", options: ["a", "b"] } }]), 100, 50, val);
    expect(c.zones.map((z) => z.action)).toEqual([{ dir: 1 }]);
  });

  it("segment has one zone per option", () => {
    const [c] = computeWidgetControls(spec([{ name: "T", bind: { input: "segment", options: ["x", "y", "z"] } }]), 100, 50, val);
    expect(c.zones.map((z) => z.action)).toEqual([{ option: "x" }, { option: "y" }, { option: "z" }]);
  });

  it("lays out multiple controls left-to-right", () => {
    const controls = computeWidgetControls(
      spec([{ name: "A", bind: { input: "cycle", options: ["1"] } }, { name: "B", bind: { input: "cycle", options: ["2"] } }]),
      100, 50, val,
    );
    expect(controls).toHaveLength(2);
    expect(controls[1].x).toBeGreaterThan(controls[0].x);
  });
});

describe("hitTestWidgetControls", () => {
  it("returns the action of the zone under the point, else null", () => {
    const [c] = computeWidgetControls(spec([{ name: "T", bind: { input: "stepper", min: 0, max: 10 } }]), 100, 50, val);
    const plus = c.zones[1]; // +
    const hit = hitTestWidgetControls(plus.x + plus.width / 2, plus.y + plus.height / 2, [c]);
    expect(hit).toMatchObject({ paramName: "T", action: { dir: 1 } });
    expect(hitTestWidgetControls(5000, 5000, [c])).toBeNull();
  });
});
