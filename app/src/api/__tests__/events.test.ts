import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { emitAppEvent, onAppEvent, AppEvents } from "../events";

describe("events", () => {
  describe("emitAppEvent / onAppEvent", () => {
    it("delivers event to subscriber", () => {
      const cb = vi.fn();
      const unsub = onAppEvent(AppEvents.GRID_REFRESH, cb);

      emitAppEvent(AppEvents.GRID_REFRESH, { foo: 42 });

      expect(cb).toHaveBeenCalledWith({ foo: 42 });
      unsub();
    });

    it("delivers event without payload", () => {
      const cb = vi.fn();
      const unsub = onAppEvent(AppEvents.GRID_REFRESH, cb);

      emitAppEvent(AppEvents.GRID_REFRESH);

      // CustomEvent.detail defaults to null when no detail is provided
      expect(cb).toHaveBeenCalledWith(null);
      unsub();
    });

    it("unsubscribe prevents further delivery", () => {
      const cb = vi.fn();
      const unsub = onAppEvent(AppEvents.SHEET_CHANGED, cb);

      unsub();
      emitAppEvent(AppEvents.SHEET_CHANGED, 1);

      expect(cb).not.toHaveBeenCalled();
    });

    it("multiple subscribers all receive the event", () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      const unsub1 = onAppEvent(AppEvents.DATA_CHANGED, cb1);
      const unsub2 = onAppEvent(AppEvents.DATA_CHANGED, cb2);

      emitAppEvent(AppEvents.DATA_CHANGED, "test");

      expect(cb1).toHaveBeenCalledWith("test");
      expect(cb2).toHaveBeenCalledWith("test");

      unsub1();
      unsub2();
    });

    it("events do not leak across different event names", () => {
      const cb = vi.fn();
      const unsub = onAppEvent(AppEvents.CUT, cb);

      emitAppEvent(AppEvents.COPY, null);

      expect(cb).not.toHaveBeenCalled();
      unsub();
    });

    it("supports custom event names", () => {
      const cb = vi.fn();
      const unsub = onAppEvent("custom:my-event", cb);

      emitAppEvent("custom:my-event", { data: true });

      expect(cb).toHaveBeenCalledWith({ data: true });
      unsub();
    });

    it("handles 100+ subscribers to the same event", () => {
      const callbacks: ReturnType<typeof vi.fn>[] = [];
      const unsubs: (() => void)[] = [];

      for (let i = 0; i < 120; i++) {
        const cb = vi.fn();
        callbacks.push(cb);
        unsubs.push(onAppEvent(AppEvents.GRID_REFRESH, cb));
      }

      emitAppEvent(AppEvents.GRID_REFRESH, "mass-event");

      for (const cb of callbacks) {
        expect(cb).toHaveBeenCalledOnce();
        expect(cb).toHaveBeenCalledWith("mass-event");
      }

      for (const unsub of unsubs) {
        unsub();
      }
    });

    it("emitting during a subscriber callback (re-entrant emit)", () => {
      const order: string[] = [];
      const innerCb = vi.fn(() => {
        order.push("inner");
      });
      const unsub2 = onAppEvent(AppEvents.DATA_CHANGED, innerCb);

      const outerCb = vi.fn(() => {
        order.push("outer");
        emitAppEvent(AppEvents.DATA_CHANGED, "from-outer");
      });
      const unsub1 = onAppEvent(AppEvents.GRID_REFRESH, outerCb);

      emitAppEvent(AppEvents.GRID_REFRESH, "trigger");

      expect(outerCb).toHaveBeenCalledOnce();
      expect(innerCb).toHaveBeenCalledWith("from-outer");
      expect(order).toEqual(["outer", "inner"]);

      unsub1();
      unsub2();
    });

    it("unsubscribe during iteration does not throw", () => {
      let unsub2: () => void;
      const cb1 = vi.fn(() => {
        // Unsubscribe cb2 while event is being dispatched
        unsub2();
      });
      const cb2 = vi.fn();

      const unsub1 = onAppEvent(AppEvents.GRID_REFRESH, cb1);
      unsub2 = onAppEvent(AppEvents.GRID_REFRESH, cb2);

      // Should not throw
      expect(() => emitAppEvent(AppEvents.GRID_REFRESH, "test")).not.toThrow();

      expect(cb1).toHaveBeenCalledOnce();
      // cb2 may or may not be called depending on dispatch order, but no error
      unsub1();
    });

    it("subscribe/unsubscribe cycle does not leak listeners", () => {
      const eventName = "custom:leak-test";
      const cb = vi.fn();

      // Subscribe and unsubscribe many times
      for (let i = 0; i < 1000; i++) {
        const unsub = onAppEvent(eventName, cb);
        unsub();
      }

      // After all unsubscribes, emitting should not call the callback
      emitAppEvent(eventName, "should-not-arrive");
      expect(cb).not.toHaveBeenCalled();
    });

    it("handles complex payload types", () => {
      interface ComplexPayload {
        nested: { values: number[]; metadata: { tag: string } };
        timestamp: number;
      }

      const cb = vi.fn<(detail: ComplexPayload) => void>();
      const unsub = onAppEvent(AppEvents.DATA_CHANGED, cb);

      const payload: ComplexPayload = {
        nested: { values: [1, 2, 3], metadata: { tag: "test" } },
        timestamp: Date.now(),
      };

      emitAppEvent(AppEvents.DATA_CHANGED, payload);

      expect(cb).toHaveBeenCalledWith(payload);
      expect(cb.mock.calls[0][0].nested.values).toEqual([1, 2, 3]);
      unsub();
    });

    it("emit with no subscribers does not throw", () => {
      expect(() => emitAppEvent("custom:nobody-listening", { data: 42 })).not.toThrow();
    });

    it("emit with undefined payload", () => {
      const cb = vi.fn();
      const unsub = onAppEvent(AppEvents.GRID_REFRESH, cb);

      emitAppEvent(AppEvents.GRID_REFRESH, undefined);

      // CustomEvent.detail defaults to null when detail is undefined
      expect(cb).toHaveBeenCalledWith(null);
      unsub();
    });

    it("same callback registered twice receives event twice", () => {
      const cb = vi.fn();
      const unsub1 = onAppEvent(AppEvents.GRID_REFRESH, cb);
      const unsub2 = onAppEvent(AppEvents.GRID_REFRESH, cb);

      emitAppEvent(AppEvents.GRID_REFRESH, "double");

      expect(cb).toHaveBeenCalledTimes(2);
      unsub1();
      unsub2();
    });

    it("unsubscribing one duplicate leaves the other active", () => {
      const cb = vi.fn();
      const unsub1 = onAppEvent(AppEvents.GRID_REFRESH, cb);
      const unsub2 = onAppEvent(AppEvents.GRID_REFRESH, cb);

      unsub1();
      emitAppEvent(AppEvents.GRID_REFRESH, "single");

      expect(cb).toHaveBeenCalledTimes(1);
      unsub2();
    });

    it("unsubscribe is idempotent (calling twice does not throw)", () => {
      const cb = vi.fn();
      const unsub = onAppEvent(AppEvents.GRID_REFRESH, cb);

      unsub();
      expect(() => unsub()).not.toThrow();
    });

    it("payload with null value is delivered as null", () => {
      const cb = vi.fn();
      const unsub = onAppEvent(AppEvents.DATA_CHANGED, cb);

      emitAppEvent(AppEvents.DATA_CHANGED, null);

      expect(cb).toHaveBeenCalledWith(null);
      unsub();
    });

    it("payload with array is delivered correctly", () => {
      const cb = vi.fn();
      const unsub = onAppEvent(AppEvents.DATA_CHANGED, cb);

      emitAppEvent(AppEvents.DATA_CHANGED, [1, "two", { three: 3 }]);

      expect(cb).toHaveBeenCalledWith([1, "two", { three: 3 }]);
      unsub();
    });

    it("multiple rapid emits are all delivered in order", () => {
      const received: number[] = [];
      const cb = vi.fn((val: number) => received.push(val));
      const unsub = onAppEvent(AppEvents.GRID_REFRESH, cb);

      for (let i = 0; i < 50; i++) {
        emitAppEvent(AppEvents.GRID_REFRESH, i);
      }

      expect(cb).toHaveBeenCalledTimes(50);
      expect(received).toEqual(Array.from({ length: 50 }, (_, i) => i));
      unsub();
    });
  });

  describe("AppEvents constants", () => {
    it("has expected event names", () => {
      expect(AppEvents.CUT).toBe("app:cut");
      expect(AppEvents.COPY).toBe("app:copy");
      expect(AppEvents.PASTE).toBe("app:paste");
      expect(AppEvents.SELECTION_CHANGED).toBe("app:selection-changed");
      expect(AppEvents.SHEET_CHANGED).toBe("app:sheet-changed");
      expect(AppEvents.GRID_REFRESH).toBe("app:grid-refresh");
    });

    it("all event names start with 'app:'", () => {
      for (const [, value] of Object.entries(AppEvents)) {
        expect(value).toMatch(/^app:/);
      }
    });
  });
});
