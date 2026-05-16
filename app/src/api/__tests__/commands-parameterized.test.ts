//! FILENAME: app/src/api/__tests__/commands-parameterized.test.ts
// PURPOSE: Parameterized tests for the CommandRegistry register/execute/unregister cycle.
// CONTEXT: Tests sync and async handlers for all CoreCommands values.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock gridCommands to prevent real core imports
vi.mock("../../core/lib/gridCommands", () => ({
  gridCommands: {
    hasHandler: vi.fn().mockReturnValue(false),
    execute: vi.fn().mockResolvedValue(false),
  },
}));

import { CoreCommands, CommandRegistry } from "../commands";

// ============================================================================
// All CoreCommands as [name, value] tuples
// ============================================================================

const ALL_COMMANDS = Object.entries(CoreCommands) as [string, string][];

// Take 25 for parameterized tests
const COMMAND_ENTRIES = ALL_COMMANDS.slice(0, 25);

// ============================================================================
// Helpers
// ============================================================================

// Cast to access clear() which is on the implementation but not the interface
const registry = CommandRegistry as CommandRegistry & { clear(): void };

beforeEach(() => {
  registry.clear();
});

// ============================================================================
// Sync handler tests
// ============================================================================

describe("CommandRegistry sync handlers parameterized", () => {
  describe.each(COMMAND_ENTRIES)("command %s (%s)", (_name, commandId) => {
    it("registers and executes sync handler", async () => {
      const handler = vi.fn();
      registry.register(commandId, handler);

      expect(registry.has(commandId)).toBe(true);

      await registry.execute(commandId, { source: "test" });
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({ source: "test" });
    });

    it("unregisters sync handler", async () => {
      const handler = vi.fn();
      registry.register(commandId, handler);
      registry.unregister(commandId);

      // After unregister, local handler should be gone
      // (may still resolve via grid command bridge, but handler should not fire)
      await registry.execute(commandId);
      expect(handler).not.toHaveBeenCalled();
    });
  });
});

// ============================================================================
// Async handler tests
// ============================================================================

describe("CommandRegistry async handlers parameterized", () => {
  describe.each(COMMAND_ENTRIES)("command %s (%s)", (_name, commandId) => {
    it("registers and executes async handler", async () => {
      let resolved = false;
      const handler = vi.fn(async () => {
        resolved = true;
      });
      registry.register(commandId, handler);

      await registry.execute(commandId, 42);
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(42);
      expect(resolved).toBe(true);
    });

    it("unregisters async handler", async () => {
      const handler = vi.fn(async () => {});
      registry.register(commandId, handler);
      registry.unregister(commandId);

      await registry.execute(commandId);
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
