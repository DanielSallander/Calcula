//! FILENAME: app/extensions/Animation/lib/__tests__/animationOrphanBuffers.test.ts
// PURPOSE: A restore buffer a reloaded page left on file is restored when the
//          Animation extension starts again, so it can no longer block every
//          what-if command for the rest of the session.
// CONTEXT: Round-16 fix lane "whatif4" (2026-10-31). While a buffer is on file
//          the backend refuses Goal Seek, Data Table, Solver and scenarios
//          ("Stop the animation"); a webview reload mid-playback dropped the
//          clock that would press Stop, and nothing else ever restored it.
//          Every buffer this window files is noted in sessionStorage until its
//          restore answers; activation restores what a previous page left.

import { describe, it, expect, vi, beforeEach } from "vitest";

const LEDGER_KEY = "calcula.animation.restoreBuffers";

async function freshModule() {
  vi.resetModules();
  return import("../animationBackend");
}

beforeEach(() => {
  sessionStorage.clear();
});

describe("restore buffers outlive their page no longer", () => {
  it("a buffer filed and never restored is restored by the next page's activation", async () => {
    // Page 1: snapshot, then the page goes away (no restore).
    const page1 = await freshModule();
    const invoke1 = vi.fn().mockResolvedValue({ success: true, error: null });
    page1.animationBackend.set(invoke1);
    await page1.animSnapshot("anim-clock-1", 2, [[0, 0]]);
    expect(sessionStorage.getItem(LEDGER_KEY)).toContain("anim-clock-1");

    // Page 2 (reload): activation releases the orphan.
    const page2 = await freshModule();
    const invoke2 = vi.fn().mockResolvedValue({ updatedCells: [], error: null });
    page2.animationBackend.set(invoke2);
    const released = await page2.releaseOrphanedBuffers();

    expect(released).toBe(1);
    expect(invoke2).toHaveBeenCalledWith("anim_restore", {
      params: { token: "anim-clock-1", sheetIndex: 2 },
    });
    expect(sessionStorage.getItem(LEDGER_KEY)).toBeNull();

    // And only once.
    expect(await page2.releaseOrphanedBuffers()).toBe(0);
    expect(invoke2).toHaveBeenCalledTimes(1);
  });

  it("a buffer whose restore answered is not restored again", async () => {
    const page1 = await freshModule();
    const invoke = vi.fn(async (cmd: string) =>
      cmd === "anim_snapshot" ? { success: true, error: null } : { updatedCells: [], error: null },
    );
    page1.animationBackend.set(invoke);
    await page1.animSnapshot("anim-clock-2", 0, [[1, 1]]);
    await page1.animRestore("anim-clock-2", 0);
    expect(sessionStorage.getItem(LEDGER_KEY)).toBeNull();

    const page2 = await freshModule();
    const invoke2 = vi.fn();
    page2.animationBackend.set(invoke2);
    expect(await page2.releaseOrphanedBuffers()).toBe(0);
    expect(invoke2).not.toHaveBeenCalled();
  });

  it("a refused snapshot files nothing to release", async () => {
    const page1 = await freshModule();
    page1.animationBackend.set(vi.fn().mockResolvedValue({ success: false, error: "busy" }));
    await page1.animSnapshot("anim-clock-3", 0, [[0, 0]]);
    expect(sessionStorage.getItem(LEDGER_KEY)).toBeNull();
  });
});
