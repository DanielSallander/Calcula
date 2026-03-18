import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock gridCommands before importing the module
vi.mock("../core/lib/gridCommands", () => ({
  gridCommands: {
    hasHandler: vi.fn(() => false),
    execute: vi.fn(() => Promise.resolve(false)),
  },
}));

import { CommandRegistry, CoreCommands } from "./commands";
import { gridCommands } from "../core/lib/gridCommands";

// Cast to access clear() for test cleanup
const registry = CommandRegistry as CommandRegistry & { clear(): void };

describe("CommandRegistry", () => {
  beforeEach(() => {
    registry.clear();
    vi.clearAllMocks();
  });

  it("registers and checks a command", () => {
    const handler = vi.fn();
    registry.register("test.cmd", handler);
    expect(registry.has("test.cmd")).toBe(true);
  });

  it("returns false for unregistered command", () => {
    expect(registry.has("nonexistent")).toBe(false);
  });

  it("executes a registered handler", async () => {
    const handler = vi.fn();
    registry.register("test.cmd", handler);
    await registry.execute("test.cmd", { data: 42 });
    expect(handler).toHaveBeenCalledWith({ data: 42 });
  });

  it("unregisters a command", () => {
    registry.register("test.cmd", vi.fn());
    registry.unregister("test.cmd");
    expect(registry.has("test.cmd")).toBe(false);
  });

  it("overwrites existing handler on re-register", async () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    registry.register("test.cmd", handler1);
    registry.register("test.cmd", handler2);
    await registry.execute("test.cmd");
    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
  });

  it("logs warning when executing unregistered command", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await registry.execute("nonexistent");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("No handler registered")
    );
    warnSpy.mockRestore();
  });

  it("bridges to gridCommands for core commands", () => {
    vi.mocked(gridCommands.hasHandler).mockReturnValue(true);
    expect(registry.has(CoreCommands.CUT)).toBe(true);
    expect(gridCommands.hasHandler).toHaveBeenCalledWith("cut");
  });

  it("executes via gridCommands bridge when no local handler", async () => {
    vi.mocked(gridCommands.execute).mockResolvedValue(true);
    await registry.execute(CoreCommands.CUT);
    expect(gridCommands.execute).toHaveBeenCalledWith("cut");
  });

  it("prefers local handler over gridCommands bridge", async () => {
    const handler = vi.fn();
    registry.register(CoreCommands.CUT, handler);
    await registry.execute(CoreCommands.CUT);
    expect(handler).toHaveBeenCalled();
    expect(gridCommands.execute).not.toHaveBeenCalled();
  });
});
