import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/animationBackend", () => ({ animRerollAndRead: vi.fn() }));
vi.mock("../../lib/monteCarloStore", () => ({ mcReset: vi.fn(), mcPush: vi.fn() }));
vi.mock("@api/events", () => ({ emitAppEvent: vi.fn() }));

import { animRerollAndRead } from "../../lib/animationBackend";
import { mcReset, mcPush } from "../../lib/monteCarloStore";
import { emitAppEvent } from "@api/events";
import { createMonteCarloDriver } from "../monteCarloDriver";

beforeEach(() => vi.clearAllMocks());

describe("monte carlo driver", () => {
  it("frameCount = trials; snapshot resets; applyFrame rolls + pushes finite outcomes", async () => {
    const d = createMonteCarloDriver({ sheetIndex: 0, outcomeRow: 9, outcomeCol: 1, trials: 500 });
    expect(d.frameCount).toBe(500);

    await d.snapshot();
    expect(mcReset).toHaveBeenCalled();

    vi.mocked(animRerollAndRead).mockResolvedValue({ value: 42, error: null });
    await d.applyFrame(0);
    expect(animRerollAndRead).toHaveBeenCalledWith(0, 9, 1);
    expect(mcPush).toHaveBeenCalledWith(42);
  });

  it("ignores non-numeric outcomes", async () => {
    const d = createMonteCarloDriver({ sheetIndex: 0, outcomeRow: 0, outcomeCol: 0, trials: 10 });
    vi.mocked(animRerollAndRead).mockResolvedValue({ value: null, error: null });
    await d.applyFrame(0);
    expect(mcPush).not.toHaveBeenCalled();
  });

  it("restore refreshes the grid (no cell restore — RAND is volatile)", async () => {
    const d = createMonteCarloDriver({ sheetIndex: 0, outcomeRow: 0, outcomeCol: 0, trials: 10 });
    await d.restore();
    expect(emitAppEvent).toHaveBeenCalledWith("grid:refresh");
  });
});
