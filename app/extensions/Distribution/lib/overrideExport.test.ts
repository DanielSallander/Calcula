import { describe, it, expect, vi } from "vitest";
import { runOverrideExport, type OverrideExportDeps } from "./overrideExport";

/** Build a deps object with vi.fn() fakes; override per test. */
function makeDeps(over: Partial<OverrideExportDeps> = {}): OverrideExportDeps {
  return {
    getSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [] }),
    exportOverrides: vi.fn().mockResolvedValue({ patch: "data" }),
    saveJsonPatch: vi.fn().mockResolvedValue("C:/out.json"),
    prompt: vi.fn().mockReturnValue(null),
    alert: vi.fn(),
    ...over,
  };
}

describe("runOverrideExport (C2c)", () => {
  it("no subscription -> alerts and exports nothing", async () => {
    const deps = makeDeps({ getSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [] }) });
    const result = await runOverrideExport(deps);
    expect(result).toBeNull();
    expect(deps.alert).toHaveBeenCalledOnce();
    expect(deps.exportOverrides).not.toHaveBeenCalled();
    expect(deps.saveJsonPatch).not.toHaveBeenCalled();
  });

  it("single subscription -> exports it without prompting, saving the serialized patch", async () => {
    const deps = makeDeps({
      getSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [{ packageName: "pkg-a" }] }),
      exportOverrides: vi.fn().mockResolvedValue({ cells: [1, 2] }),
    });
    const result = await runOverrideExport(deps);
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(deps.exportOverrides).toHaveBeenCalledWith("pkg-a");
    expect(deps.saveJsonPatch).toHaveBeenCalledWith(
      JSON.stringify({ cells: [1, 2] }, null, 2),
      "pkg-a-overrides.json",
    );
    expect(result).toBe("C:/out.json");
  });

  it("multiple subscriptions -> the prompt picks the package", async () => {
    const deps = makeDeps({
      getSubscriptions: vi
        .fn()
        .mockResolvedValue({ subscriptions: [{ packageName: "pkg-a" }, { packageName: "pkg-b" }] }),
      prompt: vi.fn().mockReturnValue("pkg-b"),
    });
    await runOverrideExport(deps);
    expect(deps.prompt).toHaveBeenCalledOnce();
    expect(deps.exportOverrides).toHaveBeenCalledWith("pkg-b");
    expect(deps.saveJsonPatch).toHaveBeenCalledWith(expect.any(String), "pkg-b-overrides.json");
  });

  it("multiple subscriptions + cancelled prompt -> exports nothing", async () => {
    const deps = makeDeps({
      getSubscriptions: vi
        .fn()
        .mockResolvedValue({ subscriptions: [{ packageName: "pkg-a" }, { packageName: "pkg-b" }] }),
      prompt: vi.fn().mockReturnValue(null),
    });
    const result = await runOverrideExport(deps);
    expect(result).toBeNull();
    expect(deps.exportOverrides).not.toHaveBeenCalled();
    expect(deps.saveJsonPatch).not.toHaveBeenCalled();
  });

  it("trims a whitespace-padded prompt response", async () => {
    const deps = makeDeps({
      getSubscriptions: vi
        .fn()
        .mockResolvedValue({ subscriptions: [{ packageName: "pkg-a" }, { packageName: "pkg-b" }] }),
      prompt: vi.fn().mockReturnValue("  pkg-b  "),
    });
    await runOverrideExport(deps);
    expect(deps.exportOverrides).toHaveBeenCalledWith("pkg-b");
  });
});
