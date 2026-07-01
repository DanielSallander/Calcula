import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerChartRenderingApi,
  getChartRenderingApi,
  getChartFrameBitmap,
  isChartRenderPending,
  isChartRenderCurrent,
  chartsIdle,
  awaitRenderSettled,
  type ChartRenderingApi,
} from "../rendering";

function makeApi(overrides: Partial<ChartRenderingApi> = {}): ChartRenderingApi {
  return {
    getChartFrameBitmap: vi.fn().mockResolvedValue(null),
    getChartFrameImageData: vi.fn().mockReturnValue(null),
    isChartRenderPending: vi.fn().mockReturnValue(false),
    isChartRenderCurrent: vi.fn().mockReturnValue(true),
    chartsIdle: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

beforeEach(() => {
  registerChartRenderingApi(null);
});

describe("@api/rendering IoC facade", () => {
  it("degrades gracefully when no charts API is registered", async () => {
    expect(getChartRenderingApi()).toBeNull();
    expect(chartsIdle()).toBe(true);
    expect(isChartRenderPending("c1")).toBe(false);
    expect(isChartRenderCurrent("c1")).toBe(true);
    await expect(getChartFrameBitmap("c1")).resolves.toBeNull();
  });

  it("delegates to the registered implementation", async () => {
    const blob = new Blob(["x"]);
    const api = makeApi({
      getChartFrameBitmap: vi.fn().mockResolvedValue(blob),
      chartsIdle: vi.fn().mockReturnValue(false),
      isChartRenderPending: vi.fn().mockReturnValue(true),
    });
    registerChartRenderingApi(api);

    expect(getChartRenderingApi()).toBe(api);
    expect(chartsIdle()).toBe(false);
    expect(isChartRenderPending("c1")).toBe(true);
    await expect(getChartFrameBitmap("c1")).resolves.toBe(blob);
    expect(api.getChartFrameBitmap).toHaveBeenCalledWith("c1");
  });
});

describe("awaitRenderSettled", () => {
  it("resolves immediately (after a paint flush) when no charts API is registered", async () => {
    await expect(awaitRenderSettled()).resolves.toBeUndefined();
  });

  it("waits for the coarse global idle, then resolves", async () => {
    const chartsIdleFn = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true);
    registerChartRenderingApi(makeApi({ chartsIdle: chartsIdleFn }));
    await awaitRenderSettled({ maxFrames: 50 });
    expect(chartsIdleFn).toHaveBeenCalled();
  });

  it("with chartId, waits until that chart is current AND not pending", async () => {
    // current=false for first 2 polls, then true; pending stays false.
    const isCurrent = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true);
    const isPending = vi.fn().mockReturnValue(false);
    registerChartRenderingApi(
      makeApi({ isChartRenderCurrent: isCurrent, isChartRenderPending: isPending }),
    );
    await awaitRenderSettled({ chartId: "c1", maxFrames: 50 });
    expect(isCurrent).toHaveBeenCalled();
    expect(isPending).toHaveBeenCalled();
  });

  it("gives up after maxFrames even if never settled (no hang)", async () => {
    registerChartRenderingApi(makeApi({ chartsIdle: vi.fn().mockReturnValue(false) }));
    await expect(awaitRenderSettled({ maxFrames: 3 })).resolves.toBeUndefined();
  });
});
