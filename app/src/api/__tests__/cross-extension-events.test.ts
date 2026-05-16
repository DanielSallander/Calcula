import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { emitAppEvent, onAppEvent, AppEvents } from "../events";

// ============================================================================
// Helpers
// ============================================================================

/** Collect calls into an array and return it along with the unsubscribe fn. */
function collectEvents<T>(eventName: string) {
  const received: T[] = [];
  const unsub = onAppEvent<T>(eventName, (detail) => received.push(detail));
  return { received, unsub };
}

// ============================================================================
// Tests
// ============================================================================

describe("Cross-extension event communication", () => {
  const unsubs: (() => void)[] = [];

  afterEach(() => {
    unsubs.forEach((u) => u());
    unsubs.length = 0;
  });

  // =========================================================================
  // Filter change -> chart refresh pattern
  // =========================================================================

  describe("filter change -> chart refresh pattern", () => {
    it("chart extension refreshes when filter changes", () => {
      const chartRefreshSpy = vi.fn();
      // Simulate chart extension subscribing to data changes
      unsubs.push(onAppEvent(AppEvents.DATA_CHANGED, chartRefreshSpy));

      // Simulate filter extension emitting data changed after applying filter
      emitAppEvent(AppEvents.DATA_CHANGED, { source: "filter", sheetIndex: 0 });

      expect(chartRefreshSpy).toHaveBeenCalledTimes(1);
      expect(chartRefreshSpy).toHaveBeenCalledWith({ source: "filter", sheetIndex: 0 });
    });

    it("chart receives grid refresh after filter toggles visibility", () => {
      const refreshSpy = vi.fn();
      unsubs.push(onAppEvent(AppEvents.GRID_REFRESH, refreshSpy));

      emitAppEvent(AppEvents.GRID_REFRESH, { reason: "filter-applied" });

      expect(refreshSpy).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Selection change -> multiple listeners
  // =========================================================================

  describe("selection change -> multiple listeners", () => {
    it("all subscribers receive the same selection payload", () => {
      const spies = Array.from({ length: 5 }, () => vi.fn());
      spies.forEach((spy) => unsubs.push(onAppEvent(AppEvents.SELECTION_CHANGED, spy)));

      const payload = { row: 3, col: 7, sheetIndex: 0 };
      emitAppEvent(AppEvents.SELECTION_CHANGED, payload);

      spies.forEach((spy) => {
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(payload);
      });
    });

    it("20+ listeners all receive the event", () => {
      const spies = Array.from({ length: 25 }, () => vi.fn());
      spies.forEach((spy) => unsubs.push(onAppEvent(AppEvents.SELECTION_CHANGED, spy)));

      emitAppEvent(AppEvents.SELECTION_CHANGED, { row: 0, col: 0 });

      spies.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
    });
  });

  // =========================================================================
  // Cell edit -> validation check -> error indicator refresh
  // =========================================================================

  describe("cell edit -> validation -> error indicator chain", () => {
    it("validation extension reacts to cell value changes", () => {
      const validationSpy = vi.fn();
      unsubs.push(onAppEvent(AppEvents.CELL_VALUES_CHANGED, validationSpy));

      emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
        changes: [{ row: 1, col: 2, oldValue: "10", newValue: "abc" }],
        source: "user",
      });

      expect(validationSpy).toHaveBeenCalledTimes(1);
      expect(validationSpy.mock.calls[0][0].changes[0].newValue).toBe("abc");
    });

    it("chained events: edit ends -> cell values changed -> grid refresh", () => {
      const order: string[] = [];

      unsubs.push(onAppEvent(AppEvents.EDIT_ENDED, () => {
        order.push("edit-ended");
        // Simulate validation extension emitting cell values changed
        emitAppEvent(AppEvents.CELL_VALUES_CHANGED, {
          changes: [{ row: 0, col: 0, newValue: "x" }],
          source: "user",
        });
      }));

      unsubs.push(onAppEvent(AppEvents.CELL_VALUES_CHANGED, () => {
        order.push("cell-values-changed");
        // Simulate error indicator triggering grid refresh
        emitAppEvent(AppEvents.GRID_REFRESH, {});
      }));

      unsubs.push(onAppEvent(AppEvents.GRID_REFRESH, () => {
        order.push("grid-refresh");
      }));

      emitAppEvent(AppEvents.EDIT_ENDED, {});

      expect(order).toEqual(["edit-ended", "cell-values-changed", "grid-refresh"]);
    });
  });

  // =========================================================================
  // Event ordering: emit order matches subscribe order
  // =========================================================================

  describe("event ordering", () => {
    it("listeners fire in subscription order", () => {
      const order: number[] = [];

      for (let i = 0; i < 10; i++) {
        const idx = i;
        unsubs.push(onAppEvent("test:ordering", () => order.push(idx)));
      }

      emitAppEvent("test:ordering");

      expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it("multiple emits preserve listener order each time", () => {
      const calls: string[] = [];
      unsubs.push(onAppEvent("test:multi-emit", () => calls.push("A")));
      unsubs.push(onAppEvent("test:multi-emit", () => calls.push("B")));

      emitAppEvent("test:multi-emit");
      emitAppEvent("test:multi-emit");

      expect(calls).toEqual(["A", "B", "A", "B"]);
    });
  });

  // =========================================================================
  // Payload preservation
  // =========================================================================

  describe("event payloads preserved through dispatch", () => {
    it("primitive payload arrives unchanged", () => {
      const { received, unsub } = collectEvents<number>("test:primitive");
      unsubs.push(unsub);

      emitAppEvent("test:primitive", 42);
      expect(received).toEqual([42]);
    });

    it("object payload arrives with all fields", () => {
      const payload = { a: 1, nested: { b: [2, 3] }, flag: true };
      const { received, unsub } = collectEvents<typeof payload>("test:object");
      unsubs.push(unsub);

      emitAppEvent("test:object", payload);
      expect(received[0]).toEqual(payload);
      // Same reference since CustomEvent passes detail by reference
      expect(received[0]).toBe(payload);
    });

    it("null and undefined payloads arrive as null (CustomEvent coerces undefined to null)", () => {
      const { received: nullR, unsub: u1 } = collectEvents<null>("test:null");
      const { received: undefR, unsub: u2 } = collectEvents<null>("test:undef");
      unsubs.push(u1, u2);

      emitAppEvent("test:null", null);
      emitAppEvent("test:undef", undefined);

      expect(nullR).toEqual([null]);
      // CustomEvent detail defaults to null when undefined is passed
      expect(undefR).toEqual([null]);
    });

    it("large payload is not truncated", () => {
      const bigArray = Array.from({ length: 10000 }, (_, i) => i);
      const { received, unsub } = collectEvents<number[]>("test:big");
      unsubs.push(unsub);

      emitAppEvent("test:big", bigArray);
      expect(received[0]).toHaveLength(10000);
    });
  });

  // =========================================================================
  // Unsubscribe isolation
  // =========================================================================

  describe("unsubscribe one listener doesn't affect others", () => {
    it("remaining listeners still receive events after one unsubscribes", () => {
      const spyA = vi.fn();
      const spyB = vi.fn();
      const spyC = vi.fn();

      unsubs.push(onAppEvent("test:unsub", spyA));
      const unsubB = onAppEvent("test:unsub", spyB);
      unsubs.push(onAppEvent("test:unsub", spyC));

      // Emit once - all three get it
      emitAppEvent("test:unsub", 1);
      expect(spyA).toHaveBeenCalledTimes(1);
      expect(spyB).toHaveBeenCalledTimes(1);
      expect(spyC).toHaveBeenCalledTimes(1);

      // Unsubscribe B
      unsubB();

      // Emit again - only A and C get it
      emitAppEvent("test:unsub", 2);
      expect(spyA).toHaveBeenCalledTimes(2);
      expect(spyB).toHaveBeenCalledTimes(1); // still 1
      expect(spyC).toHaveBeenCalledTimes(2);
    });

    it("double unsubscribe is safe", () => {
      const spy = vi.fn();
      const unsub = onAppEvent("test:double-unsub", spy);
      unsub();
      unsub(); // should not throw

      emitAppEvent("test:double-unsub", "x");
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 50 different event types with dedicated listeners
  // =========================================================================

  describe("50 different event types with dedicated listeners", () => {
    it("each event type routes only to its own listener", () => {
      const results = new Map<string, number[]>();

      for (let i = 0; i < 50; i++) {
        const name = `test:type-${i}`;
        results.set(name, []);
        unsubs.push(onAppEvent<number>(name, (val) => results.get(name)!.push(val)));
      }

      // Emit each event once with its index as payload
      for (let i = 0; i < 50; i++) {
        emitAppEvent(`test:type-${i}`, i);
      }

      for (let i = 0; i < 50; i++) {
        const name = `test:type-${i}`;
        expect(results.get(name)).toEqual([i]);
      }
    });
  });

  // =========================================================================
  // Event storm: 1000 rapid emits
  // =========================================================================

  describe("event storm: 1000 rapid emits", () => {
    it("all 1000 events are received in order", () => {
      const received: number[] = [];
      unsubs.push(onAppEvent<number>("test:storm", (v) => received.push(v)));

      for (let i = 0; i < 1000; i++) {
        emitAppEvent("test:storm", i);
      }

      expect(received).toHaveLength(1000);
      expect(received[0]).toBe(0);
      expect(received[999]).toBe(999);
      // Verify monotonically increasing
      for (let i = 1; i < 1000; i++) {
        expect(received[i]).toBe(received[i - 1] + 1);
      }
    });

    it("multiple listeners all receive 1000 events", () => {
      const counts = [0, 0, 0];
      counts.forEach((_, idx) => {
        unsubs.push(onAppEvent("test:storm-multi", () => { counts[idx]++; }));
      });

      for (let i = 0; i < 1000; i++) {
        emitAppEvent("test:storm-multi");
      }

      expect(counts).toEqual([1000, 1000, 1000]);
    });
  });

  // =========================================================================
  // Cross-event isolation
  // =========================================================================

  describe("cross-event isolation", () => {
    it("emitting event A does not trigger event B listeners", () => {
      const spyA = vi.fn();
      const spyB = vi.fn();

      unsubs.push(onAppEvent("test:isolate-a", spyA));
      unsubs.push(onAppEvent("test:isolate-b", spyB));

      emitAppEvent("test:isolate-a", "hello");

      expect(spyA).toHaveBeenCalledTimes(1);
      expect(spyB).not.toHaveBeenCalled();
    });

    it("similarly named events are distinct", () => {
      const spy1 = vi.fn();
      const spy2 = vi.fn();

      unsubs.push(onAppEvent("test:event", spy1));
      unsubs.push(onAppEvent("test:event-extra", spy2));

      emitAppEvent("test:event", "x");

      expect(spy1).toHaveBeenCalledTimes(1);
      expect(spy2).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Late subscriber
  // =========================================================================

  describe("late subscriber receives future events but not past ones", () => {
    it("subscriber added after emit does not see earlier events", () => {
      emitAppEvent("test:late", "before");

      const { received, unsub } = collectEvents<string>("test:late");
      unsubs.push(unsub);

      emitAppEvent("test:late", "after");

      expect(received).toEqual(["after"]);
    });

    it("late subscriber coexists with early subscriber", () => {
      const early: string[] = [];
      unsubs.push(onAppEvent<string>("test:late2", (v) => early.push(v)));

      emitAppEvent("test:late2", "first");

      const late: string[] = [];
      unsubs.push(onAppEvent<string>("test:late2", (v) => late.push(v)));

      emitAppEvent("test:late2", "second");

      expect(early).toEqual(["first", "second"]);
      expect(late).toEqual(["second"]);
    });
  });

  // =========================================================================
  // Real-world AppEvents constants
  // =========================================================================

  describe("real AppEvents event names", () => {
    it("SHEET_CHANGED event carries sheet index", () => {
      const { received, unsub } = collectEvents<{ sheetIndex: number }>(AppEvents.SHEET_CHANGED);
      unsubs.push(unsub);

      emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: 2 });
      expect(received[0].sheetIndex).toBe(2);
    });

    it("EDIT_STARTED and EDIT_ENDED are distinct events", () => {
      const started = vi.fn();
      const ended = vi.fn();
      unsubs.push(onAppEvent(AppEvents.EDIT_STARTED, started));
      unsubs.push(onAppEvent(AppEvents.EDIT_ENDED, ended));

      emitAppEvent(AppEvents.EDIT_STARTED, { row: 0, col: 0 });

      expect(started).toHaveBeenCalledTimes(1);
      expect(ended).not.toHaveBeenCalled();
    });

    it("THEME_CHANGED propagates to chart and formatting listeners", () => {
      const chartSpy = vi.fn();
      const formatSpy = vi.fn();
      unsubs.push(onAppEvent(AppEvents.THEME_CHANGED, chartSpy));
      unsubs.push(onAppEvent(AppEvents.THEME_CHANGED, formatSpy));

      emitAppEvent(AppEvents.THEME_CHANGED, { theme: "dark" });

      expect(chartSpy).toHaveBeenCalledWith({ theme: "dark" });
      expect(formatSpy).toHaveBeenCalledWith({ theme: "dark" });
    });
  });

  // =========================================================================
  // Error handling in listeners
  // =========================================================================

  describe("listener error isolation", () => {
    it("a listener that calls console.error does not affect other listeners", () => {
      const spyBefore = vi.fn();
      const spyAfter = vi.fn();
      const errorSpy = vi.fn();

      unsubs.push(onAppEvent("test:err", spyBefore));
      unsubs.push(onAppEvent("test:err", () => { errorSpy("something went wrong"); }));
      unsubs.push(onAppEvent("test:err", spyAfter));

      emitAppEvent("test:err", "data");

      expect(spyBefore).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(spyAfter).toHaveBeenCalledTimes(1);
    });
  });
});
