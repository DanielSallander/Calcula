import { describe, it, expect } from "vitest";
import { delayCsForFps } from "../gifExporter";

describe("delayCsForFps", () => {
  it("converts fps to a centisecond frame delay, clamped to a sane minimum", () => {
    expect(delayCsForFps(10)).toBe(10);
    expect(delayCsForFps(12)).toBe(8); // round(100/12) = round(8.33) = 8
    expect(delayCsForFps(1)).toBe(100);
    expect(delayCsForFps(100)).toBe(2); // 100/100 = 1 -> clamped to 2
    expect(delayCsForFps(0)).toBe(100); // fps clamped to >= 1
  });
});
