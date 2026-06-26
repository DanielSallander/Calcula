//! FILENAME: app/src/api/__tests__/chartMarkScripts.test.ts
// PURPOSE: B8.D.2 — the sandboxed chart-mark library lifecycle: generate/validate
//          a mark, mount+register each (registrar callback keeps registerSandboxMark
//          in the Charts extension), roll back to the last-good library on a mount
//          failure, serialize concurrent installs, and parse the persisted library.

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above imports, so the mock fns must come from vi.hoisted.
const { hostMountScript, hostUnmountScript, clearBitmapCaches, invoke } = vi.hoisted(() => ({
  hostMountScript: vi.fn(),
  hostUnmountScript: vi.fn(),
  clearBitmapCaches: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock("../scriptHost/host", () => ({ hostMountScript, hostUnmountScript }));
vi.mock("../scriptHost/renderCache", () => ({ clearBitmapCaches }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  generateMarkSource,
  validateMarkId,
  markScriptId,
  installChartMarkLibrary,
  uninstallChartMarks,
  chartMarksInstalled,
  loadPersistedMarkLibrary,
  MARK_ID_PREFIX,
  type ChartMarkLibrary,
} from "../chartMarkScripts";

const lib = (...markIds: string[]): ChartMarkLibrary => ({
  marks: markIds.map((markId) => ({
    markId, label: markId, layoutFamily: "cartesian" as const,
    body: "ctx.fillStyle='#f00'; ctx.fillRect(0,0,b.width,b.height);",
  })),
});

beforeEach(() => {
  uninstallChartMarks();
  hostMountScript.mockReset().mockResolvedValue(undefined);
  hostUnmountScript.mockReset();
  clearBitmapCaches.mockReset();
  invoke.mockReset();
});

describe("generateMarkSource", () => {
  it("wraps the body in setup() -> render.markRenderer((ctx,paint,b)=>{...})", () => {
    const src = generateMarkSource("ctx.fillRect(0,0,b.width,b.height);");
    expect(src).toContain("function setup(context)");
    expect(src).toContain("context.render.markRenderer((ctx, paint, b) =>");
    expect(src).toContain("ctx.fillRect(0,0,b.width,b.height);");
  });
});

describe("validateMarkId", () => {
  it("accepts a well-formed sandbox id", () => {
    expect(validateMarkId("sandbox:demo")).toBeNull();
    expect(validateMarkId("sandbox:my-mark_2")).toBeNull();
  });
  it("rejects a non-sandbox namespace", () => {
    expect(validateMarkId("bar")).toContain(MARK_ID_PREFIX);
    expect(validateMarkId("mymark")).toContain(MARK_ID_PREFIX);
  });
  it("rejects an unsafe suffix", () => {
    expect(validateMarkId("sandbox:bad space")).toMatch(/suffix/);
    expect(validateMarkId("sandbox:")).toMatch(/suffix/);
    expect(validateMarkId("sandbox:a.b")).toMatch(/suffix/);
  });
});

describe("markScriptId", () => {
  it("derives a stable scriptId from the markId", () => {
    expect(markScriptId("sandbox:demo")).toBe("__chartmark__:sandbox:demo");
  });
});

describe("installChartMarkLibrary", () => {
  it("mounts + registers each valid mark via the registrar", async () => {
    const registrar = vi.fn();
    await installChartMarkLibrary(lib("sandbox:a", "sandbox:b"), registrar);
    expect(hostMountScript).toHaveBeenCalledTimes(2);
    expect(registrar).toHaveBeenCalledTimes(2);
    expect(registrar).toHaveBeenCalledWith("__chartmark__:sandbox:a", "sandbox:a", { label: "sandbox:a", layoutFamily: "cartesian" });
    // mount carries objectType chartMark + instanceId===scriptId + no caps.
    const spec = hostMountScript.mock.calls[0][0];
    expect(spec.objectType).toBe("chartMark");
    expect(spec.instanceId).toBe(spec.id);
    expect(spec.declaredCapabilities).toEqual([]);
    expect(chartMarksInstalled()).toBe(true);
  });

  it("throws on an invalid markId BEFORE any mount/teardown", async () => {
    const registrar = vi.fn();
    await expect(installChartMarkLibrary({ marks: [{ markId: "nope", label: "x", layoutFamily: "cartesian", body: "x" }] }, registrar))
      .rejects.toThrow();
    expect(hostMountScript).not.toHaveBeenCalled();
    expect(registrar).not.toHaveBeenCalled();
  });

  it("rolls back to the last-good library when a mount fails", async () => {
    const registrar = vi.fn();
    await installChartMarkLibrary(lib("sandbox:good"), registrar);
    registrar.mockClear();
    // The new library's mount fails; rollback should re-mount the good one.
    hostMountScript.mockRejectedValueOnce(new Error("boom"));
    await expect(installChartMarkLibrary(lib("sandbox:bad"), registrar)).rejects.toThrow("boom");
    expect(registrar).toHaveBeenCalledWith("__chartmark__:sandbox:good", "sandbox:good", expect.anything());
    expect(chartMarksInstalled()).toBe(true);
  });

  it("preserves the working library across TWO consecutive failed edits (lastGood not lost on rollback)", async () => {
    const registrar = vi.fn();
    await installChartMarkLibrary(lib("sandbox:good"), registrar);
    // First failed edit -> rollback to good.
    hostMountScript.mockRejectedValueOnce(new Error("boom1"));
    await expect(installChartMarkLibrary(lib("sandbox:bad1"), registrar)).rejects.toThrow("boom1");
    // Second failed edit -> must STILL roll back to good (regression guard).
    registrar.mockClear();
    hostMountScript.mockRejectedValueOnce(new Error("boom2"));
    await expect(installChartMarkLibrary(lib("sandbox:bad2"), registrar)).rejects.toThrow("boom2");
    expect(registrar).toHaveBeenCalledWith("__chartmark__:sandbox:good", "sandbox:good", expect.anything());
    expect(chartMarksInstalled()).toBe(true);
  });

  it("serializes concurrent installs (queue)", async () => {
    const registrar = vi.fn();
    const order: string[] = [];
    hostMountScript.mockImplementation(async (s: { id: string }) => { order.push(s.id); });
    await Promise.all([
      installChartMarkLibrary(lib("sandbox:one"), registrar),
      installChartMarkLibrary(lib("sandbox:two"), registrar),
    ]);
    // Second install's uninstall+mount runs AFTER the first completes (no interleave).
    expect(order[order.length - 1]).toBe("__chartmark__:sandbox:two");
    expect(chartMarksInstalled()).toBe(true);
  });
});

describe("uninstallChartMarks", () => {
  it("unmounts every mark + clears bitmap caches", async () => {
    await installChartMarkLibrary(lib("sandbox:a", "sandbox:b"), vi.fn());
    uninstallChartMarks();
    expect(hostUnmountScript).toHaveBeenCalledTimes(2);
    expect(clearBitmapCaches).toHaveBeenCalledTimes(1);
    expect(chartMarksInstalled()).toBe(false);
  });
});

describe("loadPersistedMarkLibrary", () => {
  it("parses the reserved-script JSON", async () => {
    invoke.mockResolvedValue({ source: JSON.stringify(lib("sandbox:x")) });
    const loaded = await loadPersistedMarkLibrary();
    expect(loaded?.marks[0].markId).toBe("sandbox:x");
  });
  it("returns null for missing / corrupt source", async () => {
    invoke.mockResolvedValue({ source: "" });
    expect(await loadPersistedMarkLibrary()).toBeNull();
    invoke.mockResolvedValue({ source: "{not json" });
    expect(await loadPersistedMarkLibrary()).toBeNull();
    invoke.mockRejectedValue(new Error("not found"));
    expect(await loadPersistedMarkLibrary()).toBeNull();
  });
});
