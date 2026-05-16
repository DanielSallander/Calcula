//! FILENAME: app/src/api/__tests__/concurrent-operations.test.ts
// PURPOSE: Stress tests for concurrent/rapid operations on the API layer.
// CONTEXT: Simulates race conditions: rapid subscribe/unsubscribe, command
//          register/execute interleaving, and settings mutations during iteration.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { emitAppEvent, onAppEvent, AppEvents } from "../events";
import { ExtensionRegistry } from "../extensionRegistry";
import { CommandRegistry } from "../commands";
import {
  setSetting,
  getSetting,
  subscribeToSettings,
  registerSettingDefinitions,
} from "../settings";

// ============================================================================
// Helpers
// ============================================================================

/** Cast CommandRegistry to access the `clear` method on the implementation. */
const clearCommands = () => (CommandRegistry as any).clear();

beforeEach(() => {
  ExtensionRegistry.clear();
  clearCommands();
});

// ============================================================================
// 1. Rapid subscribe/unsubscribe while emitting events
// ============================================================================

describe("concurrent event subscribe/unsubscribe", () => {
  it("rapidly registers and unregisters 50 listeners while emitting", () => {
    const received: number[] = [];
    const unsubs: (() => void)[] = [];

    // Register 50 listeners
    for (let i = 0; i < 50; i++) {
      const idx = i;
      unsubs.push(onAppEvent(AppEvents.DATA_CHANGED, () => received.push(idx)));
    }

    // Emit once - all 50 should fire
    emitAppEvent(AppEvents.DATA_CHANGED, "burst");
    expect(received).toHaveLength(50);

    // Unsubscribe odd-indexed listeners, then emit again
    received.length = 0;
    for (let i = 1; i < 50; i += 2) {
      unsubs[i]();
    }
    emitAppEvent(AppEvents.DATA_CHANGED, "burst2");
    expect(received).toHaveLength(25);
    // Only even indices should remain
    expect(received.every((v) => v % 2 === 0)).toBe(true);

    // Cleanup remaining
    for (let i = 0; i < 50; i += 2) {
      unsubs[i]();
    }
  });

  it("unsubscribe during emit does not corrupt listener list", () => {
    const order: string[] = [];
    const unsubs: (() => void)[] = [];

    // Listener A unsubscribes B when triggered
    let unsubB: () => void;
    unsubs.push(
      onAppEvent(AppEvents.GRID_REFRESH, () => {
        order.push("A");
        unsubB();
      })
    );
    unsubB = onAppEvent(AppEvents.GRID_REFRESH, () => {
      order.push("B");
    });
    unsubs.push(unsubB);
    unsubs.push(
      onAppEvent(AppEvents.GRID_REFRESH, () => {
        order.push("C");
      })
    );

    expect(() => emitAppEvent(AppEvents.GRID_REFRESH, null)).not.toThrow();
    // A always fires; B may or may not depending on browser event dispatch; C fires
    expect(order).toContain("A");
    expect(order).toContain("C");

    // After the emit, B is definitely gone
    order.length = 0;
    emitAppEvent(AppEvents.GRID_REFRESH, null);
    expect(order).not.toContain("B");

    unsubs.forEach((u) => u());
  });

  it("subscribe inside an emit callback does not receive the current event", () => {
    let lateReceived = false;
    const unsub = onAppEvent(AppEvents.DATA_CHANGED, () => {
      // Subscribe a new listener during dispatch
      const inner = onAppEvent(AppEvents.DATA_CHANGED, () => {
        lateReceived = true;
      });
      // Cleanup later
      setTimeout(() => inner(), 0);
    });

    emitAppEvent(AppEvents.DATA_CHANGED, "trigger");
    // The newly registered listener should NOT fire for this same event dispatch
    // (browser CustomEvent dispatch is synchronous over current listener snapshot)
    // Actually for DOM events, a listener added during dispatch on the same target
    // is NOT called for the current dispatch.
    expect(lateReceived).toBe(false);

    unsub();
  });

  it("rapid subscribe-emit-unsubscribe cycle x100 does not leak", () => {
    const spy = vi.fn();
    for (let i = 0; i < 100; i++) {
      const unsub = onAppEvent("custom:cycle-test", spy);
      emitAppEvent("custom:cycle-test", i);
      unsub();
    }
    expect(spy).toHaveBeenCalledTimes(100);

    // After all unsubs, no more deliveries
    spy.mockClear();
    emitAppEvent("custom:cycle-test", "stale");
    expect(spy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 2. Command register/unregister while executing
// ============================================================================

describe("concurrent command register/execute", () => {
  it("register and execute 50 commands concurrently with Promise.all", async () => {
    const results: string[] = [];

    // Register 50 commands
    for (let i = 0; i < 50; i++) {
      CommandRegistry.register(`test.cmd.${i}`, () => {
        results.push(`cmd-${i}`);
      });
    }

    // Execute all 50 in parallel
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => CommandRegistry.execute(`test.cmd.${i}`))
    );

    expect(results).toHaveLength(50);
    // All commands should have executed (order may vary with async)
    for (let i = 0; i < 50; i++) {
      expect(results).toContain(`cmd-${i}`);
    }
  });

  it("unregister command while another command is executing", async () => {
    let slowResolved = false;
    CommandRegistry.register("test.slow", async () => {
      await new Promise((r) => setTimeout(r, 10));
      slowResolved = true;
    });
    CommandRegistry.register("test.fast", () => {
      // Unregister slow while it might be running
      CommandRegistry.unregister("test.slow");
    });

    // Start both
    const slowPromise = CommandRegistry.execute("test.slow");
    await CommandRegistry.execute("test.fast");
    await slowPromise;

    // Slow still completed (unregister doesn't cancel in-flight)
    expect(slowResolved).toBe(true);
    // But it's now gone from the registry
    expect(CommandRegistry.has("test.slow")).toBe(false);
  });

  it("overwrite handler mid-execution batch", async () => {
    const log: string[] = [];

    CommandRegistry.register("test.overwrite", async () => {
      log.push("v1-start");
      await new Promise((r) => setTimeout(r, 5));
      log.push("v1-end");
    });

    const p1 = CommandRegistry.execute("test.overwrite");

    // Overwrite the handler immediately
    CommandRegistry.register("test.overwrite", () => {
      log.push("v2");
    });

    const p2 = CommandRegistry.execute("test.overwrite");
    await Promise.all([p1, p2]);

    // v1 should have started before overwrite, v2 uses new handler
    expect(log).toContain("v1-start");
    expect(log).toContain("v2");
  });

  it("execute non-existent command does not throw", async () => {
    await expect(CommandRegistry.execute("test.ghost")).resolves.toBeUndefined();
  });

  it("register-unregister-register same ID preserves latest handler", async () => {
    const log: string[] = [];

    CommandRegistry.register("test.cycle", () => log.push("first"));
    CommandRegistry.unregister("test.cycle");
    CommandRegistry.register("test.cycle", () => log.push("second"));

    await CommandRegistry.execute("test.cycle");
    expect(log).toEqual(["second"]);
  });
});

// ============================================================================
// 3. Multiple subscribe/emit cycles with Promise.all
// ============================================================================

describe("multiple async subscribe/emit cycles", () => {
  it("parallel async listeners all complete", async () => {
    const results: number[] = [];

    // 20 async listeners that each push after a microtask
    const unsubs: (() => void)[] = [];
    for (let i = 0; i < 20; i++) {
      const idx = i;
      unsubs.push(
        onAppEvent(AppEvents.CELLS_UPDATED, () => {
          results.push(idx);
        })
      );
    }

    // Emit 5 times in parallel via Promise.all (emitAppEvent is sync, but wrapping)
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        Promise.resolve().then(() => emitAppEvent(AppEvents.CELLS_UPDATED, i))
      )
    );

    // 20 listeners x 5 emits = 100 calls
    expect(results).toHaveLength(100);

    unsubs.forEach((u) => u());
  });

  it("interleaved subscribe/emit across event types", async () => {
    const log: string[] = [];
    const unsubs: (() => void)[] = [];

    const events = [
      AppEvents.DATA_CHANGED,
      AppEvents.GRID_REFRESH,
      AppEvents.SELECTION_CHANGED,
      AppEvents.SHEET_CHANGED,
    ];

    // Subscribe to each
    for (const ev of events) {
      unsubs.push(onAppEvent(ev, () => log.push(ev)));
    }

    // Emit all in parallel
    await Promise.all(events.map((ev) => Promise.resolve().then(() => emitAppEvent(ev, null))));

    expect(log).toHaveLength(4);
    for (const ev of events) {
      expect(log).toContain(ev);
    }

    unsubs.forEach((u) => u());
  });

  it("50 parallel emit-then-subscribe cycles on unique events", async () => {
    const received = new Set<number>();

    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        Promise.resolve().then(() => {
          const unsub = onAppEvent(`custom:parallel-${i}`, () => received.add(i));
          emitAppEvent(`custom:parallel-${i}`, i);
          unsub();
        })
      )
    );

    expect(received.size).toBe(50);
  });
});

// ============================================================================
// 4. Settings changes during listener iteration
// ============================================================================

describe("settings changes during listener iteration", () => {
  it("setting changes inside a settings listener do not cause infinite loop", () => {
    let callCount = 0;
    const unsub = subscribeToSettings(() => {
      callCount++;
      if (callCount === 1) {
        // Mutate settings inside the listener
        setSetting("test-ext", "nested", "triggered");
      }
    });

    setSetting("test-ext", "key1", "value1");

    // The listener fires for the initial set, then again for the nested set
    // but should NOT recurse infinitely
    expect(callCount).toBe(2);

    unsub();
  });

  it("unsubscribe settings listener during notification", () => {
    let unsub1: () => void;
    let called1 = 0;
    let called2 = 0;

    unsub1 = subscribeToSettings(() => {
      called1++;
      unsub1(); // Unsubscribe self during iteration
    });
    const unsub2 = subscribeToSettings(() => {
      called2++;
    });

    setSetting("test-ext", "x", "y");

    expect(called1).toBe(1);
    expect(called2).toBe(1);

    // After self-unsubscribe, only listener 2 remains
    called1 = 0;
    called2 = 0;
    setSetting("test-ext", "x", "z");
    expect(called1).toBe(0);
    expect(called2).toBe(1);

    unsub2();
  });

  it("rapid setting updates converge to final value", () => {
    const observed: string[] = [];
    const unsub = subscribeToSettings(() => {
      observed.push(getSetting("test-ext", "rapid", ""));
    });

    for (let i = 0; i < 30; i++) {
      setSetting("test-ext", "rapid", `v${i}`);
    }

    // Each set triggers a notification synchronously
    expect(observed).toHaveLength(30);
    // Final value is correct
    expect(getSetting("test-ext", "rapid", "")).toBe("v29");

    unsub();
  });

  it("registerSettingDefinitions + unregister during listener does not throw", () => {
    let unregister: (() => void) | null = null;
    const unsub = subscribeToSettings(() => {
      if (unregister) {
        unregister();
        unregister = null;
      }
    });

    unregister = registerSettingDefinitions("test-ext", [
      { key: "foo", label: "Foo", type: "string", defaultValue: "bar" },
    ]);

    // The registerSettingDefinitions call triggers the listener, which unregisters
    expect(() => {
      setSetting("test-ext", "trigger", "1");
    }).not.toThrow();

    unsub();
  });
});

// ============================================================================
// 5. ExtensionRegistry concurrent notifications
// ============================================================================

describe("ExtensionRegistry concurrent selection notifications", () => {
  it("50 rapid notifySelectionChange calls deliver all to all listeners", () => {
    const results: number[] = [];
    const unsubs: (() => void)[] = [];

    for (let i = 0; i < 10; i++) {
      unsubs.push(
        ExtensionRegistry.onSelectionChange(() => {
          results.push(i);
        })
      );
    }

    for (let i = 0; i < 50; i++) {
      ExtensionRegistry.notifySelectionChange(null);
    }

    // 10 listeners x 50 notifications = 500
    expect(results).toHaveLength(500);

    unsubs.forEach((u) => u());
  });

  it("unsubscribe half the listeners mid-burst", () => {
    const counts = new Map<number, number>();
    const unsubs: (() => void)[] = [];

    for (let i = 0; i < 20; i++) {
      counts.set(i, 0);
      unsubs.push(
        ExtensionRegistry.onSelectionChange(() => {
          counts.set(i, (counts.get(i) ?? 0) + 1);
        })
      );
    }

    // 10 notifications, then unsubscribe half, then 10 more
    for (let i = 0; i < 10; i++) {
      ExtensionRegistry.notifySelectionChange(null);
    }

    for (let i = 0; i < 20; i += 2) {
      unsubs[i]();
    }

    for (let i = 0; i < 10; i++) {
      ExtensionRegistry.notifySelectionChange(null);
    }

    // Even-indexed listeners got 10, odd-indexed got 20
    for (let i = 0; i < 20; i++) {
      if (i % 2 === 0) {
        expect(counts.get(i)).toBe(10);
      } else {
        expect(counts.get(i)).toBe(20);
      }
    }
  });

  it("listener that throws does not prevent other listeners from firing", () => {
    const results: string[] = [];

    ExtensionRegistry.onSelectionChange(() => results.push("before"));
    ExtensionRegistry.onSelectionChange(() => {
      throw new Error("boom");
    });
    ExtensionRegistry.onSelectionChange(() => results.push("after"));

    expect(() => ExtensionRegistry.notifySelectionChange(null)).not.toThrow();
    expect(results).toContain("before");
    expect(results).toContain("after");
  });
});
