import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/animationBackend", () => ({
  animSnapshot: vi.fn().mockResolvedValue({ success: true, error: null }),
  animApplyFrame: vi.fn().mockResolvedValue({ updatedCells: [], error: null }),
  animRestore: vi.fn().mockResolvedValue({ updatedCells: [], error: null }),
  listScenarios: vi.fn(),
}));
vi.mock("../../lib/repaint", () => ({ repaintFromCells: vi.fn() }));

import { animSnapshot, animApplyFrame, listScenarios } from "../../lib/animationBackend";
import { createScenarioDriver, scenarioFrameCount, scenarioWritesForFrame } from "../scenarioDriver";
import type { ScenarioSpec } from "../../types";

const spec: ScenarioSpec = { sheetIndex: 0, keyframes: ["A", "B"], framesPerSegment: 10, interpolate: "linear" };

function kf(name: string, cells: { row: number; col: number; value: string }[]) {
  return { name, cells: new Map(cells.map((c) => [`${c.row},${c.col}`, c])) };
}

describe("scenarioFrameCount", () => {
  it("step = keyframe count; linear = (k-1)*per + 1", () => {
    expect(scenarioFrameCount({ ...spec, keyframes: ["A", "B", "C"], interpolate: "step" })).toBe(3);
    expect(scenarioFrameCount({ ...spec, keyframes: ["A", "B", "C"], interpolate: "linear" })).toBe(21);
    expect(scenarioFrameCount({ ...spec, keyframes: ["A"] })).toBe(1);
  });
});

describe("scenarioWritesForFrame (pure)", () => {
  const A = kf("A", [{ row: 0, col: 0, value: "0" }, { row: 0, col: 1, value: "lo" }]);
  const B = kf("B", [{ row: 0, col: 0, value: "100" }, { row: 0, col: 1, value: "hi" }]);
  const union: [number, number][] = [[0, 0], [0, 1]];

  it("lerps numeric cells and snaps non-numeric ones (linear)", () => {
    const w = scenarioWritesForFrame(spec, [A, B], union, 5); // seg 0, u = 0.5
    expect(w.find((x) => x.col === 0)?.value).toBe("50");
    expect(w.find((x) => x.col === 1)?.value).toBe("hi"); // u=0.5 -> not < 0.5 -> "to"
  });

  it("step mode returns the keyframe's cells verbatim", () => {
    const w = scenarioWritesForFrame({ ...spec, interpolate: "step" }, [A, B], union, 1);
    expect(w).toHaveLength(2);
    expect(w.find((x) => x.col === 0)?.value).toBe("100"); // keyframe B
  });
});

describe("scenario driver backend wiring", () => {
  beforeEach(() => vi.clearAllMocks());

  it("snapshot loads scenarios + snapshots the union; applyFrame writes the tween", async () => {
    vi.mocked(listScenarios).mockResolvedValue([
      { name: "A", changingCells: [{ row: 0, col: 0, value: "0" }] },
      { name: "B", changingCells: [{ row: 0, col: 0, value: "10" }] },
    ]);
    const d = createScenarioDriver(spec);
    expect(d.frameCount).toBe(11);

    await d.snapshot();
    expect(listScenarios).toHaveBeenCalledWith(0);
    expect(animSnapshot).toHaveBeenCalledWith(expect.stringMatching(/^anim-scenario-0-/), 0, [[0, 0]]);

    await d.applyFrame(5); // lerp 0 -> 10 at u=0.5 = 5
    expect(animApplyFrame).toHaveBeenCalledWith(0, [{ row: 0, col: 0, value: "5" }]);

    expect(d.frameLabel?.(5)).toBe("A → B 50%");
  });
});
