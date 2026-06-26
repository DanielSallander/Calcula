//! FILENAME: app/src/api/__tests__/chartTransformScripts.test.ts
// PURPOSE: Feature 1 — the sandboxed chart-transform library lifecycle: generate/
//          validate a transform, mount the single library worker + record exposed
//          types, route runSandboxTransform via callExposedMethod, roll back to the
//          last-good library on a mount failure, serialize concurrent installs, and
//          parse the persisted library.

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above imports, so the mock fns must come from vi.hoisted.
const { hostMountScript, hostUnmountScript, callExposedMethod, invoke } = vi.hoisted(() => ({
  hostMountScript: vi.fn(),
  hostUnmountScript: vi.fn(),
  callExposedMethod: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock("../scriptHost/host", () => ({ hostMountScript, hostUnmountScript }));
vi.mock("../scriptableObjects", () => ({ callExposedMethod }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  generateTransformSource,
  validateTransformType,
  installChartTransformLibrary,
  uninstallChartTransforms,
  chartTransformsInstalled,
  isSandboxTransformMounted,
  runSandboxTransform,
  loadPersistedTransformLibrary,
  TRANSFORM_TYPE_PREFIX,
  type ChartTransformLibrary,
} from "../chartTransformScripts";

const lib = (...types: string[]): ChartTransformLibrary => ({
  transforms: types.map((type) => ({ type, label: type, body: "return data;" })),
});

beforeEach(() => {
  uninstallChartTransforms();
  hostMountScript.mockReset().mockResolvedValue(undefined);
  hostUnmountScript.mockReset();
  callExposedMethod.mockReset();
  invoke.mockReset();
});

describe("generateTransformSource", () => {
  it("exposes each transform NON-public as (data, spec, params) keyed by type", () => {
    const src = generateTransformSource([{ type: "sandbox:foo", label: "Foo", body: "return data;" }]);
    expect(src).toContain("function setup(context)");
    expect(src).toContain('context.expose("sandbox:foo", async (data, spec, params) =>');
    expect(src).toContain("{ public: false }");
    expect(src).toContain("return data;");
  });
  it("binds cube from the capability shim", () => {
    expect(generateTransformSource([])).toContain("const cube = caps.cube;");
  });
  it("throws on an invalid type (no breakout of the generated structure)", () => {
    expect(() => generateTransformSource([{ type: "bad space", label: "x", body: "return data;" }])).toThrow();
  });
});

describe("validateTransformType", () => {
  it("accepts a well-formed sandbox type", () => {
    expect(validateTransformType("sandbox:foo")).toBeNull();
    expect(validateTransformType("sandbox:my-t_2")).toBeNull();
  });
  it("rejects a non-sandbox namespace (so it can't shadow a built-in)", () => {
    expect(validateTransformType("filter")).toContain(TRANSFORM_TYPE_PREFIX);
    expect(validateTransformType("aggregate")).toContain(TRANSFORM_TYPE_PREFIX);
  });
  it("rejects an unsafe suffix", () => {
    expect(validateTransformType("sandbox:bad space")).toMatch(/suffix/);
    expect(validateTransformType("sandbox:")).toMatch(/suffix/);
    expect(validateTransformType("sandbox:a.b")).toMatch(/suffix/);
  });
});

describe("installChartTransformLibrary", () => {
  it("mounts ONE worker + records the exposed types", async () => {
    await installChartTransformLibrary(lib("sandbox:a", "sandbox:b"));
    expect(hostMountScript).toHaveBeenCalledTimes(1);
    const spec = hostMountScript.mock.calls[0][0];
    expect(spec.objectType).toBe("workbook");
    expect(spec.instanceId).toBe("__chart_transforms__");
    expect(isSandboxTransformMounted("sandbox:a")).toBe(true);
    expect(isSandboxTransformMounted("sandbox:b")).toBe(true);
    expect(isSandboxTransformMounted("sandbox:c")).toBe(false);
    expect(chartTransformsInstalled()).toBe(true);
  });

  it("passes declared capabilities through to the mount", async () => {
    await installChartTransformLibrary({ transforms: lib("sandbox:a").transforms, capabilities: ["bi.query"] });
    expect(hostMountScript.mock.calls[0][0].declaredCapabilities).toEqual(["bi.query"]);
  });

  it("throws on an invalid type BEFORE any mount", async () => {
    await expect(installChartTransformLibrary({ transforms: [{ type: "nope", label: "x", body: "return data;" }] }))
      .rejects.toThrow();
    expect(hostMountScript).not.toHaveBeenCalled();
  });

  it("rolls back to the last-good library when a mount fails", async () => {
    await installChartTransformLibrary(lib("sandbox:good"));
    hostMountScript.mockRejectedValueOnce(new Error("boom"));
    await expect(installChartTransformLibrary(lib("sandbox:bad"))).rejects.toThrow("boom");
    // Good library re-mounted; its type is still routable.
    expect(isSandboxTransformMounted("sandbox:good")).toBe(true);
    expect(isSandboxTransformMounted("sandbox:bad")).toBe(false);
    expect(chartTransformsInstalled()).toBe(true);
  });

  it("preserves the working library across TWO consecutive failed edits (lastGood not lost on rollback)", async () => {
    await installChartTransformLibrary(lib("sandbox:good"));
    // First failed edit -> rollback to good (rawInstall's teardown must NOT reset lastGood).
    hostMountScript.mockRejectedValueOnce(new Error("boom1"));
    await expect(installChartTransformLibrary(lib("sandbox:bad1"))).rejects.toThrow("boom1");
    // Second failed edit -> must STILL roll back to good (regression guard).
    hostMountScript.mockRejectedValueOnce(new Error("boom2"));
    await expect(installChartTransformLibrary(lib("sandbox:bad2"))).rejects.toThrow("boom2");
    expect(isSandboxTransformMounted("sandbox:good")).toBe(true);
    expect(chartTransformsInstalled()).toBe(true);
  });

  it("serializes concurrent installs (queue)", async () => {
    const order: string[] = [];
    hostMountScript.mockImplementation(async (sp: { id: string }) => { order.push(sp.id); });
    await Promise.all([
      installChartTransformLibrary(lib("sandbox:one")),
      installChartTransformLibrary(lib("sandbox:two")),
    ]);
    expect(isSandboxTransformMounted("sandbox:two")).toBe(true);
    expect(isSandboxTransformMounted("sandbox:one")).toBe(false); // replaced
  });
});

describe("runSandboxTransform", () => {
  it("invokes the exposed method with (data, spec, params)", async () => {
    await installChartTransformLibrary(lib("sandbox:foo"));
    callExposedMethod.mockResolvedValue({ categories: ["a"], series: [] });
    const data = { categories: ["a"], series: [] };
    const out = await runSandboxTransform("sandbox:foo", data, { type: "sandbox:foo" }, { threshold: 5 });
    expect(callExposedMethod).toHaveBeenCalledWith("workbook", "__chart_transforms__", "sandbox:foo", data, { type: "sandbox:foo" }, { threshold: 5 });
    expect(out).toEqual({ categories: ["a"], series: [] });
  });

  it("rejects when the type is not mounted", async () => {
    await expect(runSandboxTransform("sandbox:missing", {}, {})).rejects.toThrow(/not mounted/);
    expect(callExposedMethod).not.toHaveBeenCalled();
  });
});

describe("uninstallChartTransforms", () => {
  it("unmounts the worker and clears routing", async () => {
    await installChartTransformLibrary(lib("sandbox:a"));
    uninstallChartTransforms();
    expect(hostUnmountScript).toHaveBeenCalledTimes(1);
    expect(isSandboxTransformMounted("sandbox:a")).toBe(false);
    expect(chartTransformsInstalled()).toBe(false);
  });
});

describe("loadPersistedTransformLibrary", () => {
  it("parses the reserved-script JSON", async () => {
    invoke.mockResolvedValue({ source: JSON.stringify(lib("sandbox:x")) });
    const loaded = await loadPersistedTransformLibrary();
    expect(loaded?.transforms[0].type).toBe("sandbox:x");
  });
  it("returns null for missing / corrupt source", async () => {
    invoke.mockResolvedValue({ source: "" });
    expect(await loadPersistedTransformLibrary()).toBeNull();
    invoke.mockResolvedValue({ source: "{not json" });
    expect(await loadPersistedTransformLibrary()).toBeNull();
    invoke.mockRejectedValue(new Error("not found"));
    expect(await loadPersistedTransformLibrary()).toBeNull();
  });
});
