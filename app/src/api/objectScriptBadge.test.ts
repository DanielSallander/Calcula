//! FILENAME: app/src/api/objectScriptBadge.test.ts
// PURPOSE: Tests for the shared object script-presence cache + badge gating (T4):
//          keying, refresh from the persisted-script list, and that the badge is
//          drawn only when design mode is on AND the object has a script.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./objectScriptBackend", () => ({ loadAllObjectScripts: vi.fn() }));
vi.mock("./designMode", () => ({
  getDesignMode: vi.fn(),
  onDesignModeChange: vi.fn(() => () => {}),
}));
vi.mock("./events", () => ({ onAppEvent: vi.fn(() => () => {}) }));
vi.mock("./gridOverlays", () => ({ requestOverlayRedraw: vi.fn() }));

import { loadAllObjectScripts } from "./objectScriptBackend";
import { getDesignMode } from "./designMode";
import {
  hasObjectScript,
  markObjectScript,
  unmarkObjectScript,
  refreshObjectScriptPresence,
  drawObjectScriptBadgeIfPresent,
} from "./objectScriptBadge";

/** A minimal CanvasRenderingContext2D stand-in that records draw calls. */
function fakeCtx() {
  const calls: string[] = [];
  const rec = (name: string) => () => void calls.push(name);
  return {
    calls,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "",
    lineJoin: "",
    beginPath: rec("beginPath"),
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    arcTo: rec("arcTo"),
    closePath: rec("closePath"),
    fill: rec("fill"),
    stroke: rec("stroke"),
  } as unknown as CanvasRenderingContext2D & { calls: string[] };
}

beforeEach(async () => {
  vi.clearAllMocks();
  // Reset the module-level cache to empty.
  (loadAllObjectScripts as any).mockResolvedValue([]);
  await refreshObjectScriptPresence();
});

describe("presence cache keying", () => {
  it("marks/unmarks a component by type+instance", () => {
    expect(hasObjectScript("slicer", "s1")).toBe(false);
    markObjectScript("slicer", "s1");
    expect(hasObjectScript("slicer", "s1")).toBe(true);
    expect(hasObjectScript("slicer", "other")).toBe(false);
    expect(hasObjectScript("chart", "s1")).toBe(false); // type is part of the key
    unmarkObjectScript("slicer", "s1");
    expect(hasObjectScript("slicer", "s1")).toBe(false);
  });

  it("keys a primitive (no instanceId) by type alone", () => {
    markObjectScript("sheet", null);
    expect(hasObjectScript("sheet")).toBe(true);
    expect(hasObjectScript("sheet", null)).toBe(true);
    expect(hasObjectScript("sheet", "x")).toBe(false);
  });
});

describe("refreshObjectScriptPresence", () => {
  it("rebuilds the cache from the persisted-script list", async () => {
    (loadAllObjectScripts as any).mockResolvedValue([
      { objectType: "chart", instanceId: "c1" },
      { objectType: "slicer", instanceId: "s2" },
      { objectType: "workbook", instanceId: null },
    ]);
    await refreshObjectScriptPresence();
    expect(hasObjectScript("chart", "c1")).toBe(true);
    expect(hasObjectScript("slicer", "s2")).toBe(true);
    expect(hasObjectScript("workbook")).toBe(true);
    expect(hasObjectScript("chart", "gone")).toBe(false);
  });

  it("clears stale entries on refresh", async () => {
    markObjectScript("chart", "old");
    (loadAllObjectScripts as any).mockResolvedValue([{ objectType: "chart", instanceId: "new" }]);
    await refreshObjectScriptPresence();
    expect(hasObjectScript("chart", "old")).toBe(false);
    expect(hasObjectScript("chart", "new")).toBe(true);
  });

  it("leaves the cache intact if the backend throws", async () => {
    markObjectScript("slicer", "keep");
    (loadAllObjectScripts as any).mockRejectedValue(new Error("no backend"));
    await refreshObjectScriptPresence();
    expect(hasObjectScript("slicer", "keep")).toBe(true);
  });
});

describe("drawObjectScriptBadgeIfPresent gating", () => {
  it("does NOT draw when design mode is off", () => {
    (getDesignMode as any).mockReturnValue(false);
    markObjectScript("chart", "c1");
    const ctx = fakeCtx() as any;
    drawObjectScriptBadgeIfPresent(ctx, "chart", "c1", 0, 0, 100);
    expect(ctx.calls).toHaveLength(0);
  });

  it("does NOT draw when the object has no script", () => {
    (getDesignMode as any).mockReturnValue(true);
    const ctx = fakeCtx() as any;
    drawObjectScriptBadgeIfPresent(ctx, "chart", "c1", 0, 0, 100);
    expect(ctx.calls).toHaveLength(0);
  });

  it("draws when design mode is on AND the object has a script", () => {
    (getDesignMode as any).mockReturnValue(true);
    markObjectScript("chart", "c1");
    const ctx = fakeCtx() as any;
    drawObjectScriptBadgeIfPresent(ctx, "chart", "c1", 0, 0, 100);
    expect(ctx.calls).toContain("fill"); // pill background drawn
    expect(ctx.calls).toContain("stroke"); // < > glyph drawn
  });
});
