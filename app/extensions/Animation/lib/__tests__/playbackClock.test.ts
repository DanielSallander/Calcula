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

/** Resolves at the first state that is not `status` (the end of a play). */
function waitUntilNot(clock: PlaybackClock, status: ClockStatus): Promise<void> {
  return new Promise((resolve) => {
    const un = clock.subscribe((s) => {
      if (s.status !== status) {
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
  // Round 16 (whatif4): the end of a non-looping range used to PARK the clock
  // in "paused" with the restore buffer still on file, so every what-if
  // command was refused until the user pressed Stop on an animation that
  // looked finished. Finishing now ends the way Stop does: restored, released,
  // idle at the range start (this test used to assert "paused" at frame 4).
  it("plays through every frame in order, snapshotting once, then restores and goes idle at the end", async () => {
    const { driver, calls } = makeMockDriver(5);
    const clock = createPlaybackClock({ delay: immediate });
    await clock.setDriver(driver);

    clock.play();
    await waitUntilNot(clock, "playing");

    expect(calls.snapshot).toBe(1);
    expect(calls.applied).toEqual([0, 1, 2, 3, 4]);
    expect(calls.restore).toBe(1);
    expect(clock.getState().status).toBe("idle");
    expect(clock.getState().frame).toBe(0);

    // Nothing is on loan any more: Stop has nothing to restore, and Play
    // starts again from the beginning with a fresh snapshot.
    await clock.stop();
    expect(calls.restore).toBe(1);
    clock.play();
    await waitForStatus(clock, "idle");
    expect(calls.snapshot).toBe(2);
    expect(calls.restore).toBe(2);
  });

  it("a looping range never finishes on its own: it keeps the buffer until Stop", async () => {
    const { driver, calls } = makeMockDriver(3);
    // A macrotask per frame: an immediate pace would starve the timer below.
    const clock = createPlaybackClock({ delay: () => new Promise<void>((r) => setTimeout(r, 0)) });
    await clock.setDriver(driver);
    clock.setLoop(true);

    clock.play();
    while (calls.applied.length <= 4) await new Promise((r) => setTimeout(r, 1));
    expect(calls.applied.length).toBeGreaterThan(3);
    expect(calls.restore).toBe(0);
    await clock.stop();
    expect(calls.restore).toBe(1);
  });

  it("stop() restores the model and resets to the range start (transient guarantee)", async () => {
    const { driver, calls } = makeMockDriver(5);
    const clock = createPlaybackClock({ delay: immediate });
    await clock.setDriver(driver);

    await clock.seek(2);
    await clock.stop();

    expect(calls.restore).toBe(1);
    expect(clock.getState().status).toBe("idle");
    expect(clock.getState().frame).toBe(0);
  });

  // A frame shown by a scrub or a step FROM IDLE puts cells on loan (the
  // snapshot is filed) while the transport still said "idle" -- so a what-if
  // command was refused with "Stop the animation" while nothing looked
  // stopped-able. The clock is "paused" while it shows a frame.
  it("a seek from idle shows its frame as paused, so the transport offers Stop", async () => {
    const { driver } = makeMockDriver(5);
    const clock = createPlaybackClock({ delay: immediate });
    await clock.setDriver(driver);

    await clock.seek(3);
    expect(clock.getState().status).toBe("paused");
    await clock.step(1);
    expect(clock.getState().status).toBe("paused");
    expect(clock.getState().frame).toBe(4);
  });

  it("a restore that fails at the end keeps Stop able to retry it", async () => {
    let fail = true;
    const calls = { restore: 0 };
    const errors: string[] = [];
    const driver: Driver = {
      frameCount: 3,
      async snapshot() {},
      async applyFrame() {},
      async restore() {
        calls.restore++;
        if (fail) throw new Error("restore refused");
      },
    };
    const clock = createPlaybackClock({ delay: immediate, onError: (m) => errors.push(m) });
    await clock.setDriver(driver);
    clock.play();
    await waitForStatus(clock, "paused");
    expect(errors).toEqual(["restore refused"]);
    fail = false;
    await clock.stop();
    expect(calls.restore).toBe(2);
    expect(clock.getState().status).toBe("idle");
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

// NEW-anim-scenario-not-single-flight: the backend refuses an animation's
// snapshot while a what-if run (Data Table, Goal Seek, Solver, a scenario) is
// writing trials. Play used to throw out of its loop (an unhandled rejection)
// and leave the transport saying "playing" with no frame ever applied.
describe("a refused snapshot", () => {
  function refusingDriver(message: string) {
    const calls = { applied: [] as number[], restore: 0 };
    const driver: Driver = {
      frameCount: 5,
      async snapshot() {
        throw new Error(message);
      },
      async applyFrame(t: number) {
        calls.applied.push(t);
      },
      async restore() {
        calls.restore++;
      },
    };
    return { driver, calls };
  }

  it("play goes back to idle, applies nothing and says why", async () => {
    const errors: string[] = [];
    const { driver, calls } = refusingDriver("A what-if analysis is running.");
    const clock = createPlaybackClock({ delay: immediate, onError: (m) => errors.push(m) });
    await clock.setDriver(driver);

    clock.play();
    // Settle: the loop runs on the microtask queue (immediate pacing).
    await new Promise((r) => setTimeout(r, 20));

    expect(clock.getState().status).toBe("idle");
    expect(calls.applied).toEqual([]);
    expect(errors).toEqual(["A what-if analysis is running."]);

    // Nothing was snapshotted, so Stop restores nothing.
    await clock.stop();
    expect(calls.restore).toBe(0);
  });

  it("seek applies no frame and says why", async () => {
    const errors: string[] = [];
    const { driver, calls } = refusingDriver("busy");
    const clock = createPlaybackClock({ delay: immediate, onError: (m) => errors.push(m) });
    await clock.setDriver(driver);

    await clock.seek(2);
    expect(calls.applied).toEqual([]);
    expect(errors).toEqual(["busy"]);
    expect(clock.getState().status).toBe("idle");
  });

  it("a frame that fails mid-run is reported too", async () => {
    const errors: string[] = [];
    const calls = { restore: 0 };
    const driver: Driver = {
      frameCount: 5,
      async snapshot() {},
      async applyFrame(t: number) {
        if (t === 2) throw new Error("trial refused");
      },
      async restore() {
        calls.restore++;
      },
    };
    const clock = createPlaybackClock({ delay: immediate, onError: (m) => errors.push(m) });
    await clock.setDriver(driver);
    clock.play();
    await waitForStatus(clock, "idle");
    expect(errors).toEqual(["trial refused"]);
    expect(calls.restore).toBe(1);
  });
});
