//! FILENAME: app/extensions/__tests__/extension-performance.test.ts
// PURPOSE: Performance benchmarks for core extension infrastructure.
// CONTEXT: Ensures command registration, event emission, edit guards,
//          and style interceptors scale well under load.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

// ============================================================================
// Inline implementations (mirrors core modules for isolated benchmarking)
// ============================================================================

// --- Command Registry ---

type CommandHandler = (args?: unknown) => void | Promise<void>;

class CommandRegistry {
  private handlers = new Map<string, CommandHandler>();

  register(id: string, handler: CommandHandler): void {
    this.handlers.set(id, handler);
  }

  unregister(id: string): void {
    this.handlers.delete(id);
  }

  has(id: string): boolean {
    return this.handlers.has(id);
  }

  async execute(id: string, args?: unknown): Promise<void> {
    const handler = this.handlers.get(id);
    if (handler) await handler(args);
  }

  clear(): void {
    this.handlers.clear();
  }
}

// --- Event Bus ---

type EventCallback = (...args: unknown[]) => void;

class EventBus {
  private listeners = new Map<string, Set<EventCallback>>();

  on(event: string, cb: EventCallback): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(cb);
    return () => {
      this.listeners.get(event)?.delete(cb);
    };
  }

  emit(event: string, ...args: unknown[]): void {
    const cbs = this.listeners.get(event);
    if (cbs) {
      for (const cb of cbs) {
        cb(...args);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

// --- Edit Guard Registry ---

interface EditGuardResult {
  blocked: boolean;
  message?: string;
}

type EditGuardFn = (row: number, col: number) => Promise<EditGuardResult | null>;

class EditGuardRegistry {
  private guards = new Set<EditGuardFn>();

  register(guard: EditGuardFn): () => void {
    this.guards.add(guard);
    return () => {
      this.guards.delete(guard);
    };
  }

  async check(row: number, col: number): Promise<EditGuardResult | null> {
    for (const guard of this.guards) {
      const result = await guard(row, col);
      if (result?.blocked) return result;
    }
    return null;
  }

  clear(): void {
    this.guards.clear();
  }
}

// --- Style Interceptor Registry ---

interface StyleOverride {
  backgroundColor?: string;
  textColor?: string;
  bold?: boolean;
}

interface BaseStyleInfo extends StyleOverride {
  styleIndex: number;
}

interface CellCoords {
  row: number;
  col: number;
}

type StyleInterceptorFn = (
  cellValue: string,
  baseStyle: BaseStyleInfo,
  coords: CellCoords,
) => StyleOverride | null;

interface InterceptorEntry {
  id: string;
  fn: StyleInterceptorFn;
  priority: number;
}

class StyleInterceptorRegistry {
  private entries = new Map<string, InterceptorEntry>();
  private sorted: InterceptorEntry[] = [];
  private dirty = true;

  register(id: string, fn: StyleInterceptorFn, priority = 0): () => void {
    this.entries.set(id, { id, fn, priority });
    this.dirty = true;
    return () => {
      this.entries.delete(id);
      this.dirty = true;
    };
  }

  apply(cellValue: string, baseStyle: BaseStyleInfo, coords: CellCoords): BaseStyleInfo {
    if (this.dirty) {
      this.sorted = Array.from(this.entries.values()).sort(
        (a, b) => a.priority - b.priority,
      );
      this.dirty = false;
    }
    let style = { ...baseStyle };
    for (const entry of this.sorted) {
      const override = entry.fn(cellValue, style, coords);
      if (override) style = { ...style, ...override };
    }
    return style;
  }

  clear(): void {
    this.entries.clear();
    this.sorted = [];
    this.dirty = true;
  }
}

// --- Menu Registry ---

interface MenuItem {
  id: string;
  label: string;
  action?: () => void;
}

class MenuRegistry {
  private menus = new Map<string, MenuItem[]>();

  registerMenu(id: string): void {
    if (!this.menus.has(id)) this.menus.set(id, []);
  }

  addItem(menuId: string, item: MenuItem): void {
    if (!this.menus.has(menuId)) this.menus.set(menuId, []);
    this.menus.get(menuId)!.push(item);
  }

  getItems(menuId: string): MenuItem[] {
    return this.menus.get(menuId) ?? [];
  }

  clear(): void {
    this.menus.clear();
  }
}

// ============================================================================
// Helpers
// ============================================================================

function measureMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

async function measureMsAsync(fn: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

// ============================================================================
// Tests
// ============================================================================

describe("Extension Performance", () => {
  const commands = new CommandRegistry();
  const events = new EventBus();
  const editGuards = new EditGuardRegistry();
  const styleInterceptors = new StyleInterceptorRegistry();
  const menus = new MenuRegistry();

  beforeEach(() => {
    commands.clear();
    events.clear();
    editGuards.clear();
    styleInterceptors.clear();
    menus.clear();
  });

  // --------------------------------------------------------------------------
  // Command Registration
  // --------------------------------------------------------------------------

  describe("command registration (50 extensions x 10 commands)", () => {
    it("registers 500 commands under 50ms", () => {
      const elapsed = measureMs(() => {
        for (let ext = 0; ext < 50; ext++) {
          for (let cmd = 0; cmd < 10; cmd++) {
            commands.register(`ext${ext}.cmd${cmd}`, () => {});
          }
        }
      });
      expect(elapsed).toBeLessThan(50);
    });

    it("all 500 commands are findable", () => {
      for (let ext = 0; ext < 50; ext++) {
        for (let cmd = 0; cmd < 10; cmd++) {
          commands.register(`ext${ext}.cmd${cmd}`, () => {});
        }
      }
      for (let ext = 0; ext < 50; ext++) {
        for (let cmd = 0; cmd < 10; cmd++) {
          expect(commands.has(`ext${ext}.cmd${cmd}`)).toBe(true);
        }
      }
    });

    it("executes a command among 500 registered under 1ms", async () => {
      let called = false;
      for (let ext = 0; ext < 50; ext++) {
        for (let cmd = 0; cmd < 10; cmd++) {
          const handler = ext === 49 && cmd === 9 ? () => { called = true; } : () => {};
          commands.register(`ext${ext}.cmd${cmd}`, handler);
        }
      }
      const elapsed = await measureMsAsync(async () => {
        await commands.execute("ext49.cmd9");
      });
      expect(called).toBe(true);
      expect(elapsed).toBeLessThan(1);
    });

    it("unregisters 500 commands under 50ms", () => {
      for (let ext = 0; ext < 50; ext++) {
        for (let cmd = 0; cmd < 10; cmd++) {
          commands.register(`ext${ext}.cmd${cmd}`, () => {});
        }
      }
      const elapsed = measureMs(() => {
        for (let ext = 0; ext < 50; ext++) {
          for (let cmd = 0; cmd < 10; cmd++) {
            commands.unregister(`ext${ext}.cmd${cmd}`);
          }
        }
      });
      expect(elapsed).toBeLessThan(50);
      expect(commands.has("ext0.cmd0")).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Menu Registration
  // --------------------------------------------------------------------------

  describe("menu registration (50 extensions x 5 items)", () => {
    it("registers 50 menus with 250 items under 50ms", () => {
      const elapsed = measureMs(() => {
        for (let ext = 0; ext < 50; ext++) {
          menus.registerMenu(`menu-${ext}`);
          for (let item = 0; item < 5; item++) {
            menus.addItem(`menu-${ext}`, {
              id: `ext${ext}.item${item}`,
              label: `Item ${item}`,
              action: () => {},
            });
          }
        }
      });
      expect(elapsed).toBeLessThan(50);
    });

    it("returns empty array for unregistered menu", () => {
      expect(menus.getItems("nonexistent")).toEqual([]);
    });

    it("retrieves all items for a menu correctly", () => {
      menus.registerMenu("testMenu");
      for (let i = 0; i < 50; i++) {
        menus.addItem("testMenu", { id: `item-${i}`, label: `Label ${i}` });
      }
      expect(menus.getItems("testMenu")).toHaveLength(50);
    });
  });

  // --------------------------------------------------------------------------
  // Event Emission
  // --------------------------------------------------------------------------

  describe("event emission (100 subscribers)", () => {
    it("emits to 100 subscribers under 5ms", () => {
      let count = 0;
      for (let i = 0; i < 100; i++) {
        events.on("test-event", () => { count++; });
      }
      const elapsed = measureMs(() => {
        events.emit("test-event", { data: "payload" });
      });
      expect(count).toBe(100);
      expect(elapsed).toBeLessThan(5);
    });

    it("emits 1000 events to 10 subscribers under 50ms", () => {
      let count = 0;
      for (let i = 0; i < 10; i++) {
        events.on("rapid-event", () => { count++; });
      }
      const elapsed = measureMs(() => {
        for (let i = 0; i < 1000; i++) {
          events.emit("rapid-event");
        }
      });
      expect(count).toBe(10000);
      expect(elapsed).toBeLessThan(50);
    });

    it("unsubscribing one of 100 listeners does not affect others", () => {
      let count = 0;
      const unsubs: (() => void)[] = [];
      for (let i = 0; i < 100; i++) {
        unsubs.push(events.on("unsub-test", () => { count++; }));
      }
      // Remove 50 listeners
      for (let i = 0; i < 50; i++) {
        unsubs[i]();
      }
      events.emit("unsub-test");
      expect(count).toBe(50);
    });

    it("emitting to nonexistent event is a no-op", () => {
      // Should not throw
      events.emit("nonexistent-event", "data");
    });

    it("emits to subscribers on different event channels independently", () => {
      let countA = 0;
      let countB = 0;
      for (let i = 0; i < 50; i++) {
        events.on("channel-a", () => { countA++; });
        events.on("channel-b", () => { countB++; });
      }
      events.emit("channel-a");
      expect(countA).toBe(50);
      expect(countB).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Edit Guards
  // --------------------------------------------------------------------------

  describe("edit guards (50 guards)", () => {
    it("checks 50 allowing guards under 5ms", async () => {
      for (let i = 0; i < 50; i++) {
        editGuards.register(async () => null);
      }
      const elapsed = await measureMsAsync(async () => {
        const result = await editGuards.check(5, 5);
        expect(result).toBeNull();
      });
      expect(elapsed).toBeLessThan(5);
    });

    it("first blocking guard short-circuits", async () => {
      let guardsCalled = 0;
      // First 10 allow
      for (let i = 0; i < 10; i++) {
        editGuards.register(async () => { guardsCalled++; return null; });
      }
      // 11th blocks
      editGuards.register(async () => {
        guardsCalled++;
        return { blocked: true, message: "Blocked by guard 11" };
      });
      // Remaining 39 should not be called
      for (let i = 0; i < 39; i++) {
        editGuards.register(async () => { guardsCalled++; return null; });
      }
      const result = await editGuards.check(0, 0);
      expect(result?.blocked).toBe(true);
      expect(result?.message).toBe("Blocked by guard 11");
      expect(guardsCalled).toBe(11);
    });

    it("50 guards with none blocking returns null", async () => {
      for (let i = 0; i < 50; i++) {
        editGuards.register(async (_r, _c) => null);
      }
      const result = await editGuards.check(99, 99);
      expect(result).toBeNull();
    });

    it("checks 50 guards across multiple cells under 10ms", async () => {
      for (let i = 0; i < 50; i++) {
        editGuards.register(async () => null);
      }
      const elapsed = await measureMsAsync(async () => {
        for (let cell = 0; cell < 10; cell++) {
          await editGuards.check(cell, cell);
        }
      });
      expect(elapsed).toBeLessThan(10);
    });

    it("cleanup function removes guard", async () => {
      let called = false;
      const cleanup = editGuards.register(async () => {
        called = true;
        return { blocked: true, message: "blocked" };
      });
      cleanup();
      const result = await editGuards.check(0, 0);
      expect(result).toBeNull();
      expect(called).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Style Interceptors
  // --------------------------------------------------------------------------

  describe("style interceptors (20 interceptors)", () => {
    const baseStyle: BaseStyleInfo = {
      styleIndex: 0,
      backgroundColor: "#ffffff",
      textColor: "#000000",
      bold: false,
    };

    it("runs 20 interceptors on a cell under 1ms", () => {
      for (let i = 0; i < 20; i++) {
        styleInterceptors.register(`interceptor-${i}`, () => null, i);
      }
      const elapsed = measureMs(() => {
        styleInterceptors.apply("hello", baseStyle, { row: 0, col: 0 });
      });
      expect(elapsed).toBeLessThan(1);
    });

    it("interceptors accumulate style changes", () => {
      styleInterceptors.register("bold-maker", () => ({ bold: true }), 0);
      styleInterceptors.register("red-bg", () => ({ backgroundColor: "#ff0000" }), 1);
      styleInterceptors.register("white-text", () => ({ textColor: "#ffffff" }), 2);

      const result = styleInterceptors.apply("test", baseStyle, { row: 0, col: 0 });
      expect(result.bold).toBe(true);
      expect(result.backgroundColor).toBe("#ff0000");
      expect(result.textColor).toBe("#ffffff");
      expect(result.styleIndex).toBe(0); // Unchanged
    });

    it("null-returning interceptors do not affect style", () => {
      styleInterceptors.register("noop1", () => null, 0);
      styleInterceptors.register("noop2", () => null, 1);
      const result = styleInterceptors.apply("test", baseStyle, { row: 0, col: 0 });
      expect(result).toEqual(baseStyle);
    });

    it("later interceptor overrides earlier one", () => {
      styleInterceptors.register("first", () => ({ backgroundColor: "#ff0000" }), 0);
      styleInterceptors.register("second", () => ({ backgroundColor: "#00ff00" }), 1);
      const result = styleInterceptors.apply("test", baseStyle, { row: 0, col: 0 });
      expect(result.backgroundColor).toBe("#00ff00");
    });

    it("applies 20 interceptors across 1000 cells under 50ms", () => {
      for (let i = 0; i < 20; i++) {
        styleInterceptors.register(
          `interceptor-${i}`,
          (val) => (Number(val) > 50 ? { bold: true } : null),
          i,
        );
      }
      const elapsed = measureMs(() => {
        for (let r = 0; r < 100; r++) {
          for (let c = 0; c < 10; c++) {
            styleInterceptors.apply(String(r * 10 + c), baseStyle, { row: r, col: c });
          }
        }
      });
      expect(elapsed).toBeLessThan(50);
    });

    it("cleanup removes interceptor from pipeline", () => {
      const cleanup = styleInterceptors.register("temp", () => ({ bold: true }), 0);
      cleanup();
      const result = styleInterceptors.apply("test", baseStyle, { row: 0, col: 0 });
      expect(result.bold).toBe(false);
    });

    it("priority order is respected", () => {
      const order: string[] = [];
      styleInterceptors.register("c", () => { order.push("c"); return null; }, 30);
      styleInterceptors.register("a", () => { order.push("a"); return null; }, 10);
      styleInterceptors.register("b", () => { order.push("b"); return null; }, 20);
      styleInterceptors.apply("test", baseStyle, { row: 0, col: 0 });
      expect(order).toEqual(["a", "b", "c"]);
    });
  });

  // --------------------------------------------------------------------------
  // Combined: Full extension lifecycle simulation
  // --------------------------------------------------------------------------

  describe("combined lifecycle simulation", () => {
    it("registers and tears down 50 extensions under 100ms", () => {
      const cleanups: (() => void)[] = [];

      const elapsed = measureMs(() => {
        for (let ext = 0; ext < 50; ext++) {
          // Each extension registers: 5 commands, 3 menu items, 1 event listener, 1 style interceptor
          for (let cmd = 0; cmd < 5; cmd++) {
            commands.register(`ext${ext}.cmd${cmd}`, () => {});
          }
          menus.registerMenu(`ext${ext}`);
          for (let item = 0; item < 3; item++) {
            menus.addItem(`ext${ext}`, { id: `ext${ext}.item${item}`, label: `Item ${item}` });
          }
          cleanups.push(events.on(`ext${ext}.event`, () => {}));
          cleanups.push(styleInterceptors.register(`ext${ext}.style`, () => null, ext));
        }
      });

      expect(elapsed).toBeLessThan(100);

      // Verify counts
      expect(commands.has("ext49.cmd4")).toBe(true);
      expect(menus.getItems("ext25")).toHaveLength(3);

      // Teardown
      const teardownElapsed = measureMs(() => {
        for (const fn of cleanups) fn();
        for (let ext = 0; ext < 50; ext++) {
          for (let cmd = 0; cmd < 5; cmd++) {
            commands.unregister(`ext${ext}.cmd${cmd}`);
          }
        }
      });
      expect(teardownElapsed).toBeLessThan(100);
    });
  });
});
