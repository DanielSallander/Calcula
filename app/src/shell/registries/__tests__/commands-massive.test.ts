import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock gridCommands to isolate CommandRegistry
vi.mock("../../../../src/core/lib/gridCommands", () => ({
  gridCommands: {
    hasHandler: vi.fn(() => false),
    execute: vi.fn(() => Promise.resolve(false)),
  },
}));

// Import after mock
import { CommandRegistry } from "../../../../src/api/commands";

// Cast to access clear() for test isolation
const registry = CommandRegistry as unknown as {
  register: typeof CommandRegistry.register;
  unregister: typeof CommandRegistry.unregister;
  execute: typeof CommandRegistry.execute;
  has: typeof CommandRegistry.has;
  getAll: typeof CommandRegistry.getAll;
  clear: () => void;
};

// Generate 100 unique command IDs
const COMMAND_IDS = Array.from({ length: 100 }, (_, i) => ({
  id: `test.command.${String(i).padStart(3, "0")}`,
  index: i,
}));

// Arg type variants
const ARG_VARIANTS = [
  { label: "number arg", args: 42 },
  { label: "object arg", args: { key: "value", nested: { a: 1 } } },
  { label: "string arg", args: "hello-world" },
];

// ============================================================================
// 1. Register/execute/unregister for 100 command IDs (300 assertions)
// ============================================================================

describe("register/execute/unregister - 100 commands", () => {
  beforeEach(() => {
    registry.clear();
  });

  it.each(COMMAND_IDS)(
    "should register command $id",
    ({ id }) => {
      const handler = vi.fn();
      registry.register(id, handler);
      expect(registry.has(id)).toBe(true);
    }
  );

  it.each(COMMAND_IDS)(
    "should execute command $id",
    async ({ id }) => {
      const handler = vi.fn();
      registry.register(id, handler);
      await registry.execute(id, { data: id });
      expect(handler).toHaveBeenCalledWith({ data: id });
    }
  );

  it.each(COMMAND_IDS)(
    "should unregister command $id",
    ({ id }) => {
      const handler = vi.fn();
      registry.register(id, handler);
      registry.unregister(id);
      expect(registry.has(id)).toBe(false);
    }
  );
});

// ============================================================================
// 2. Command with args: 50 commands x 3 arg types = 150 tests
// ============================================================================

describe("command execution with various arg types", () => {
  beforeEach(() => {
    registry.clear();
  });

  const cases = COMMAND_IDS.slice(0, 50).flatMap((cmd) =>
    ARG_VARIANTS.map((av) => ({
      id: cmd.id,
      ...av,
    }))
  );

  it.each(cases)(
    "should pass $label to $id",
    async ({ id, args }) => {
      const handler = vi.fn();
      registry.register(id, handler);
      await registry.execute(id, args);
      expect(handler).toHaveBeenCalledWith(args);
    }
  );
});

// ============================================================================
// 3. Overwrite behavior: 50 commands overwritten = 50 tests
// ============================================================================

describe("command overwrite behavior", () => {
  beforeEach(() => {
    registry.clear();
  });

  it.each(COMMAND_IDS.slice(0, 50))(
    "overwriting $id should use new handler",
    async ({ id }) => {
      const oldHandler = vi.fn();
      const newHandler = vi.fn();

      registry.register(id, oldHandler);
      registry.register(id, newHandler);

      await registry.execute(id);

      expect(oldHandler).not.toHaveBeenCalled();
      expect(newHandler).toHaveBeenCalled();
    }
  );
});
