//! FILENAME: app/src/api/scriptHost/__tests__/validators.test.ts
// PURPOSE: B8 slice A — vSetState's broker-side shape+size pre-filter for chart
//          spec writes (runs before the tier check, no state reads). The deep
//          schema check lives in the Charts extension; this only rejects an
//          obviously-malformed / oversized / non-object spec uniformly.

import { describe, it, expect } from "vitest";
import { vSetState } from "../validators";

describe("vSetState chart spec pre-filter", () => {
  it("passes a well-formed chart.updateSpec patch", () => {
    expect(vSetState(["chart.updateSpec", [{ title: "X" }]])).toBe(true);
  });

  it("passes a well-formed chart.replaceSpec full spec", () => {
    expect(vSetState(["chart.replaceSpec", [{ mark: "bar", series: [] }]])).toBe(true);
  });

  it("rejects a non-object spec", () => {
    expect(vSetState(["chart.updateSpec", ["nope"]])).not.toBe(true);
    expect(vSetState(["chart.updateSpec", [42]])).not.toBe(true);
    expect(vSetState(["chart.replaceSpec", [null]])).not.toBe(true);
    expect(vSetState(["chart.updateSpec", [["an", "array"]]])).not.toBe(true);
  });

  it("rejects a missing spec argument", () => {
    expect(vSetState(["chart.updateSpec", []])).not.toBe(true);
    expect(vSetState(["chart.replaceSpec", "notArray"])).not.toBe(true);
  });

  it("rejects an oversized spec (> 2 MB)", () => {
    const huge = { title: "x".repeat(2_100_000) };
    expect(vSetState(["chart.updateSpec", [huge]])).not.toBe(true);
  });

  it("does NOT constrain other setState aspects (slicer/shape/etc.)", () => {
    expect(vSetState(["slicer.setSelectedItems", [["a", "b"]]])).toBe(true);
    expect(vSetState(["shape.setProperty", ["fill", "#fff"]])).toBe(true);
    expect(vSetState(["chart.setStyleProperty", ["bg", "#fff"]])).toBe(true);
  });
});
