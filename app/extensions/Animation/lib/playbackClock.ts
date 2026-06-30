//! FILENAME: app/extensions/Animation/lib/playbackClock.ts
// PURPOSE: The async, back-pressured playback clock that advances a Driver over a
//          frame range (play / pause / stop / step / seek / loop / speed).
// CONTEXT: A single async loop awaits each frame's applyFrame BEFORE pacing to the
//          target fps, so frame N+1 never starts while N is still in flight (no
//          queueing — if recalc is slower than the target rate, the rate simply
//          drops). Only one loop runs at a time: every transition that must
//          restart/stop it (pause/stop/seek) awaits the current loop's promise
//          first, so there are never two concurrent loops or stale in-flight frames
//          — which is why no generation counter is needed. stop() always restores
//          the model (the transient guarantee).

import type { Driver } from "./driver";

export type ClockStatus = "idle" | "playing" | "paused";

export interface ClockState {
  status: ClockStatus;
  frame: number;
  frameCount: number;
  fps: number;
  loop: boolean;
  rangeStart: number;
  rangeEnd: number;
  /** Driver-provided label for the current frame value (e.g. "t = 3.5"), or null. */
  frameLabel: string | null;
}

export interface PlaybackClock {
  play(): void;
  pause(): void;
  stop(): Promise<void>;
  step(delta: 1 | -1): Promise<void>;
  seek(frame: number): Promise<void>;
  setFps(fps: number): void;
  setRange(start: number, end: number): void;
  setLoop(on: boolean): void;
  setDriver(driver: Driver | null): Promise<void>;
  getState(): ClockState;
  subscribe(cb: (s: ClockState) => void): () => void;
  dispose(): Promise<void>;
}

export interface ClockDeps {
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
}

const DEFAULT_FPS = 12;

/** The next frame to show after `current`, honoring range + loop. null = finished. */
export function nextFrameIndex(
  current: number,
  rangeStart: number,
  rangeEnd: number,
  loop: boolean,
): number | null {
  if (current < rangeStart) return rangeStart;
  if (current < rangeEnd) return current + 1;
  return loop ? rangeStart : null;
}

/** Clamp `v` to the integer range [lo, hi]. */
export function clampInt(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

export function createPlaybackClock(deps: ClockDeps = {}): PlaybackClock {
  const nowFn =
    deps.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const delayFn =
    deps.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms))));

  let driver: Driver | null = null;
  let status: ClockStatus = "idle";
  let frame = 0;
  let frameCount = 0;
  let fps = DEFAULT_FPS;
  let loop = false;
  let rangeStart = 0;
  let rangeEnd = 0;
  let snapshotted = false;
  let loopPromise: Promise<void> | null = null;
  const listeners = new Set<(s: ClockState) => void>();

  function frameLabel(): string | null {
    if (!driver || frameCount === 0) return null;
    return driver.frameLabel ? driver.frameLabel(frame) : String(frame);
  }

  function getState(): ClockState {
    return { status, frame, frameCount, fps, loop, rangeStart, rangeEnd, frameLabel: frameLabel() };
  }

  function notify(): void {
    const s = getState();
    for (const l of listeners) {
      try {
        l(s);
      } catch (e) {
        console.error("[Animation] clock listener error", e);
      }
    }
  }

  async function ensureSnapshot(): Promise<void> {
    if (!snapshotted && driver) {
      await driver.snapshot();
      snapshotted = true;
    }
  }

  async function runLoop(renderCurrentFirst: boolean): Promise<void> {
    await ensureSnapshot();
    let first = true;
    while (status === "playing") {
      const target =
        first && renderCurrentFirst
          ? clampInt(frame, rangeStart, rangeEnd)
          : nextFrameIndex(frame, rangeStart, rangeEnd, loop);
      first = false;
      if (target === null) {
        status = "paused";
        notify();
        break;
      }
      const t0 = nowFn();
      try {
        await driver!.applyFrame(target);
      } catch (e) {
        console.error("[Animation] applyFrame failed; stopping + restoring", e);
        status = "idle";
        try {
          if (driver) await driver.restore();
        } catch (re) {
          console.error("[Animation] restore failed", re);
        }
        snapshotted = false;
        notify();
        break;
      }
      frame = target;
      notify();
      if (status !== "playing") break;
      const elapsed = nowFn() - t0;
      const budget = 1000 / Math.max(1, fps);
      if (elapsed < budget) await delayFn(budget - elapsed);
    }
  }

  function startLoop(renderCurrentFirst: boolean): void {
    if (loopPromise) return; // a loop is already running
    loopPromise = runLoop(renderCurrentFirst).finally(() => {
      loopPromise = null;
    });
  }

  function play(): void {
    if (!driver || frameCount === 0) return;
    if (status === "playing") return;
    let renderCurrentFirst = status === "idle";
    // Replay from the start if we're sitting at the end of a non-looping range.
    if (frame >= rangeEnd && !loop) {
      frame = rangeStart;
      renderCurrentFirst = true;
    }
    status = "playing";
    notify();
    startLoop(renderCurrentFirst);
  }

  function pause(): void {
    if (status !== "playing") return;
    status = "paused";
    notify();
    // The loop exits on its next status check, after the in-flight frame settles.
  }

  async function stop(): Promise<void> {
    status = "idle";
    notify();
    if (loopPromise) {
      try {
        await loopPromise;
      } catch {
        /* loop swallows its own errors */
      }
    }
    if (snapshotted && driver) {
      try {
        await driver.restore();
      } catch (e) {
        console.error("[Animation] restore on stop failed", e);
      }
    }
    snapshotted = false;
    frame = rangeStart;
    notify();
  }

  async function seek(target: number): Promise<void> {
    if (!driver || frameCount === 0) return;
    const wasPlaying = status === "playing";
    if (wasPlaying) status = "paused";
    if (loopPromise) {
      try {
        await loopPromise;
      } catch {
        /* ignore */
      }
    }
    await ensureSnapshot();
    frame = clampInt(target, rangeStart, rangeEnd);
    try {
      await driver.applyFrame(frame);
    } catch (e) {
      console.error("[Animation] seek applyFrame failed", e);
    }
    notify();
    if (wasPlaying) {
      status = "playing";
      notify();
      startLoop(false);
    }
  }

  async function step(delta: 1 | -1): Promise<void> {
    if (status === "playing") {
      pause();
      if (loopPromise) {
        try {
          await loopPromise;
        } catch {
          /* ignore */
        }
      }
    }
    await seek(frame + delta);
  }

  function setFps(v: number): void {
    fps = clampInt(v, 1, 120);
    notify();
  }

  function setLoop(on: boolean): void {
    loop = on;
    notify();
  }

  function setRange(start: number, end: number): void {
    const hiBound = Math.max(0, frameCount - 1);
    const lo = clampInt(start, 0, hiBound);
    const hi = clampInt(end, 0, hiBound);
    rangeStart = Math.min(lo, hi);
    rangeEnd = Math.max(lo, hi);
    frame = clampInt(frame, rangeStart, rangeEnd);
    notify();
  }

  async function setDriver(next: Driver | null): Promise<void> {
    await stop(); // restores the old driver if needed
    driver = next;
    frameCount = next ? next.frameCount : 0;
    rangeStart = 0;
    rangeEnd = frameCount > 0 ? frameCount - 1 : 0;
    frame = 0;
    snapshotted = false;
    status = "idle";
    notify();
  }

  function subscribe(cb: (s: ClockState) => void): () => void {
    listeners.add(cb);
    cb(getState());
    return () => {
      listeners.delete(cb);
    };
  }

  async function dispose(): Promise<void> {
    await stop();
    listeners.clear();
    driver = null;
  }

  return {
    play,
    pause,
    stop,
    step,
    seek,
    setFps,
    setRange,
    setLoop,
    setDriver,
    getState,
    subscribe,
    dispose,
  };
}
