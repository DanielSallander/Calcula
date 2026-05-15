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

  // ==========================================================================
  // Edge cases: many commands
  // ==========================================================================

  it("handles registering 100+ commands", () => {
    for (let i = 0; i < 150; i++) {
      registry.register(`bulk.cmd.${i}`, vi.fn());
    }
    for (let i = 0; i < 150; i++) {
      expect(registry.has(`bulk.cmd.${i}`)).toBe(true);
    }
    const all = registry.getAll();
    expect(all.length).toBeGreaterThanOrEqual(150);
  });

  it("getAll returns sorted IDs including grid commands", () => {
    registry.register("z.last", vi.fn());
    registry.register("a.first", vi.fn());
    const all = registry.getAll();
    expect(all.indexOf("a.first")).toBeLessThan(all.indexOf("z.last"));
  });

  // ==========================================================================
  // Edge cases: command name collisions
  // ==========================================================================

  it("second register overwrites first silently", async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    registry.register("collision.cmd", h1);
    registry.register("collision.cmd", h2);
    await registry.execute("collision.cmd");
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it("logs a warning when overwriting a handler", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    registry.register("ow.cmd", vi.fn());
    registry.register("ow.cmd", vi.fn());
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Overwriting handler")
    );
    warnSpy.mockRestore();
  });

  // ==========================================================================
  // Edge cases: async handler errors
  // ==========================================================================

  it("propagates sync handler errors", async () => {
    registry.register("err.sync", () => {
      throw new Error("sync boom");
    });
    await expect(registry.execute("err.sync")).rejects.toThrow("sync boom");
  });

  it("propagates async handler rejection", async () => {
    registry.register("err.async", async () => {
      throw new Error("async boom");
    });
    await expect(registry.execute("err.async")).rejects.toThrow("async boom");
  });

  it("handler error does not corrupt registry", async () => {
    registry.register("err.recover", () => {
      throw new Error("oops");
    });
    try { await registry.execute("err.recover"); } catch { /* expected */ }
    // Registry still works
    const handler = vi.fn();
    registry.register("err.recover", handler);
    await registry.execute("err.recover");
    expect(handler).toHaveBeenCalled();
  });

  // ==========================================================================
  // Edge cases: re-register after unregister
  // ==========================================================================

  it("can re-register a command after unregistering it", async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    registry.register("reuse.cmd", h1);
    registry.unregister("reuse.cmd");
    expect(registry.has("reuse.cmd")).toBe(false);
    registry.register("reuse.cmd", h2);
    expect(registry.has("reuse.cmd")).toBe(true);
    await registry.execute("reuse.cmd");
    expect(h2).toHaveBeenCalled();
    expect(h1).not.toHaveBeenCalled();
  });

  it("unregistering a non-existent command is a no-op", () => {
    // Should not throw
    expect(() => registry.unregister("ghost.cmd")).not.toThrow();
  });

  // ==========================================================================
  // Edge cases: case sensitivity of command IDs
  // ==========================================================================

  it("command IDs are case-sensitive", () => {
    registry.register("Case.Cmd", vi.fn());
    expect(registry.has("Case.Cmd")).toBe(true);
    expect(registry.has("case.cmd")).toBe(false);
    expect(registry.has("CASE.CMD")).toBe(false);
  });

  it("two commands differing only in case are independent", async () => {
    const upper = vi.fn();
    const lower = vi.fn();
    registry.register("ABC", upper);
    registry.register("abc", lower);
    await registry.execute("ABC");
    expect(upper).toHaveBeenCalled();
    expect(lower).not.toHaveBeenCalled();
    await registry.execute("abc");
    expect(lower).toHaveBeenCalled();
  });

  // ==========================================================================
  // Edge cases: empty string command IDs
  // ==========================================================================

  it("can register a command with empty string ID", async () => {
    const handler = vi.fn();
    registry.register("", handler);
    expect(registry.has("")).toBe(true);
    await registry.execute("");
    expect(handler).toHaveBeenCalled();
  });

  it("can unregister empty string ID", () => {
    registry.register("", vi.fn());
    registry.unregister("");
    expect(registry.has("")).toBe(false);
  });

  // ==========================================================================
  // Edge cases: execute with various argument types
  // ==========================================================================

  it("passes undefined args when none provided", async () => {
    const handler = vi.fn();
    registry.register("noargs", handler);
    await registry.execute("noargs");
    expect(handler).toHaveBeenCalledWith(undefined);
  });

  it("passes complex object args through", async () => {
    const handler = vi.fn();
    registry.register("complex", handler);
    const args = { nested: { deep: [1, 2, 3] }, flag: true };
    await registry.execute("complex", args);
    expect(handler).toHaveBeenCalledWith(args);
  });

  // ==========================================================================
  // Edge cases: clear
  // ==========================================================================

  it("clear removes all registered commands", () => {
    registry.register("a", vi.fn());
    registry.register("b", vi.fn());
    registry.register("c", vi.fn());
    registry.clear();
    expect(registry.has("a")).toBe(false);
    expect(registry.has("b")).toBe(false);
    expect(registry.has("c")).toBe(false);
  });
});
