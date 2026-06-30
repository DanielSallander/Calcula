import { describe, it, expect } from "vitest";
import {
  createPlaybackClock,
  nextFrameIndex,
  clampInt,
  type PlaybackClock,
  type ClockStatus,
} from "../playbackClock";
import type { Driver } from "../driver";

function makeMockDriver(frameCount: number) {
  const calls = { snapshot: 0, applied: [] as number[], restore: 0 };
  const driver: Driver = {
    frameCount,
    async snapshot() {
      calls.snapshot++;
    },
    async applyFrame(t: number) {
      calls.applied.push(t);
    },
    async restore() {
      calls.restore++;
    },
    frameLabel: (t) => `f${t}`,
  };
  return { driver, calls };
}

function waitForStatus(clock: PlaybackClock, status: ClockStatus): Promise<void> {
  return new Promise((resolve) => {
    const un = clock.subscribe((s) => {
      if (s.status === status) {
        un();
        resolve();
      }
    });
  });
}

// Immediate pacing so the async loop runs as fast as the microtask queue allows.
const immediate = () => Promise.resolve();

describe("frame math (pure)", () => {
  it("nextFrameIndex advances, clamps below range, stops/loops at end", () => {
    expect(nextFrameIndex(0, 0, 4, false)).toBe(1);
    expect(nextFrameIndex(3, 0, 4, false)).toBe(4);
    expect(nextFrameIndex(4, 0, 4, false)).toBeNull();
    expect(nextFrameIndex(4, 0, 4, true)).toBe(0);
    expect(nextFrameIndex(-1, 2, 5, false)).toBe(2);
  });

  it("clampInt rounds and clamps", () => {
    expect(clampInt(7, 0, 4)).toBe(4);
    expect(clampInt(-3, 0, 4)).toBe(0);
    expect(clampInt(2.6, 0, 4)).toBe(3);
    expect(clampInt(5, 4, 0)).toBe(4); // hi < lo -> lo
  });
});

describe("playback clock", () => {
  it("plays through every frame in order, snapshotting once, then pauses at the end", async () => {
    const { driver, calls } = makeMockDriver(5);
    const clock = createPlaybackClock({ delay: immediate });
    await clock.setDriver(driver);

    clock.play();
    await waitForStatus(clock, "paused");

    expect(calls.snapshot).toBe(1);
    expect(calls.applied).toEqual([0, 1, 2, 3, 4]);
    expect(clock.getState().frame).toBe(4);
  });

  it("stop() restores the model and resets to the range start (transient guarantee)", async () => {
    const { driver, calls } = makeMockDriver(5);
    const clock = createPlaybackClock({ delay: immediate });
    await clock.setDriver(driver);

    clock.play();
    await waitForStatus(clock, "paused");
    await clock.stop();

    expect(calls.restore).toBe(1);
    expect(clock.getState().status).toBe("idle");
    expect(clock.getState().frame).toBe(0);
  });

  it("seek snapshots then applies exactly the target frame", async () => {
    const { driver, calls } = makeMockDriver(10);
    const clock = createPlaybackClock({ delay: immediate });
    await clock.setDriver(driver);

    await clock.seek(3);

    expect(calls.snapshot).toBe(1);
    expect(calls.applied).toEqual([3]);
    expect(clock.getState().frame).toBe(3);
  });

  it("stop without any applied frame does not restore (nothing was snapshotted)", async () => {
    const { driver, calls } = makeMockDriver(5);
    const clock = createPlaybackClock({ delay: immediate });
    await clock.setDriver(driver);

    await clock.stop();
    expect(calls.snapshot).toBe(0);
    expect(calls.restore).toBe(0);
  });

  it("exposes the driver frame label via state", async () => {
    const { driver } = makeMockDriver(5);
    const clock = createPlaybackClock({ delay: immediate });
    await clock.setDriver(driver);
    await clock.seek(2);
    expect(clock.getState().frameLabel).toBe("f2");
  });
});
