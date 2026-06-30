import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/animationBackend", () => ({
  animSnapshot: vi.fn().mockResolvedValue({ success: true, error: null }),
  animApplyFrame: vi
    .fn()
    .mockResolvedValue({ updatedCells: [{ row: 0, col: 1, display: "42", formula: null }], error: null }),
  animRestore: vi.fn().mockResolvedValue({ updatedCells: [], error: null }),
}));
vi.mock("../../lib/repaint", () => ({ repaintFromCells: vi.fn() }));

import { animSnapshot, animApplyFrame, animRestore } from "../../lib/animationBackend";
import { repaintFromCells } from "../../lib/repaint";
import { createClockCellDriver, computeFrameCount, valueAtFrame } from "../clockCellDriver";

describe("clock-cell driver math (pure)", () => {
  it("computeFrameCount counts inclusive sweeps and guards bad steps", () => {
    expect(computeFrameCount(0, 100, 1)).toBe(101);
    expect(computeFrameCount(0, 10, 2)).toBe(6);
    expect(computeFrameCount(0, 5, 3)).toBe(2); // values 0, 3
    expect(computeFrameCount(5, 5, 1)).toBe(1);
    expect(computeFrameCount(10, 0, -2)).toBe(6);
    expect(computeFrameCount(0, 100, 0)).toBe(1); // step 0 -> single frame
    expect(computeFrameCount(0, 10, -1)).toBe(1); // step points away from `to`
  });

  it("valueAtFrame computes from + t*step without FP noise", () => {
    expect(valueAtFrame({ sheetIndex: 0, row: 0, col: 0, from: 0, to: 100, step: 1 }, 42)).toBe(42);
    expect(valueAtFrame({ sheetIndex: 0, row: 0, col: 0, from: 0, to: 1, step: 0.1 }, 3)).toBe(0.3);
  });
});

describe("clock-cell driver backend wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("snapshot / applyFrame / restore call the gated backend + repaint", async () => {
    const d = createClockCellDriver({ sheetIndex: 2, row: 0, col: 1, from: 0, to: 100, step: 1 });
    expect(d.frameCount).toBe(101);

    await d.snapshot();
    expect(animSnapshot).toHaveBeenCalledWith(
      expect.stringMatching(/^anim-clock-2-0-1-/),
      2,
      [[0, 1]],
    );

    await d.applyFrame(42);
    expect(animApplyFrame).toHaveBeenCalledWith(2, [{ row: 0, col: 1, value: "42" }]);
    expect(repaintFromCells).toHaveBeenCalledTimes(1);

    await d.restore();
    expect(animRestore).toHaveBeenCalledWith(expect.stringMatching(/^anim-clock-2-0-1-/), 2);
    expect(repaintFromCells).toHaveBeenCalledTimes(2);
  });

  it("frameLabel reflects the driver value", () => {
    const d = createClockCellDriver({ sheetIndex: 0, row: 0, col: 0, from: 10, to: 20, step: 2 });
    expect(d.frameLabel?.(0)).toBe("10");
    expect(d.frameLabel?.(3)).toBe("16");
  });
});
