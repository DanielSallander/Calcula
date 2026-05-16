import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AppEvents, emitAppEvent, onAppEvent } from "../events";

// Build array of all event entries for parameterized tests
const ALL_EVENTS = Object.entries(AppEvents).map(([key, value]) => ({
  key,
  eventName: value,
}));

// Payload variants for testing
const PAYLOAD_VARIANTS = [
  { label: "string payload", payload: "test-value-123" },
  { label: "object payload", payload: { row: 1, col: 2, data: "hello" } },
  { label: "array payload", payload: [1, 2, 3, "a", "b"] },
];

// ============================================================================
// 1. Subscribe, emit, verify, unsubscribe for all AppEvents (~55 tests)
// ============================================================================

describe("emitAppEvent/onAppEvent - all events", () => {
  it.each(ALL_EVENTS)(
    "should emit and receive $key ($eventName)",
    ({ eventName }) => {
      let received: unknown = undefined;
      const unsub = onAppEvent(eventName, (detail) => {
        received = detail;
      });

      emitAppEvent(eventName, { test: true });
      expect(received).toEqual({ test: true });

      unsub();
      emitAppEvent(eventName, { test: false });
      expect(received).toEqual({ test: true }); // unchanged after unsub
    }
  );
});

// ============================================================================
// 2. Multi-subscriber per event (~55 events x 3 subscribers = ~165 tests)
// ============================================================================

describe("multi-subscriber per event", () => {
  const subscriberCounts = [0, 1, 2] as const;

  const cases = ALL_EVENTS.flatMap((ev) =>
    subscriberCounts.map((subIdx) => ({
      ...ev,
      subIdx,
      label: `${ev.key} subscriber #${subIdx}`,
    }))
  );

  it.each(cases)(
    "should deliver to subscriber #$subIdx for $key",
    ({ eventName, subIdx }) => {
      const results: unknown[] = [];
      const unsubs = [0, 1, 2].map((i) =>
        onAppEvent(eventName, (detail) => {
          results[i] = detail;
        })
      );

      emitAppEvent(eventName, `payload-${subIdx}`);

      // All three subscribers should receive the same payload
      expect(results[subIdx]).toBe(`payload-${subIdx}`);

      unsubs.forEach((u) => u());
    }
  );
});

// ============================================================================
// 3. Payload types per event (~55 events x 3 payload types = ~165 tests)
// ============================================================================

describe("payload types per event", () => {
  const cases = ALL_EVENTS.flatMap((ev) =>
    PAYLOAD_VARIANTS.map((pv) => ({
      ...ev,
      ...pv,
    }))
  );

  it.each(cases)(
    "should handle $label for $key",
    ({ eventName, payload }) => {
      let received: unknown = undefined;
      const unsub = onAppEvent(eventName, (detail) => {
        received = detail;
      });

      emitAppEvent(eventName, payload);
      expect(received).toEqual(payload);

      unsub();
    }
  );
});

// ============================================================================
// 4. Unsubscribe isolation (~55 tests)
// ============================================================================

describe("unsubscribe isolation", () => {
  it.each(ALL_EVENTS)(
    "unsubscribing one listener should not affect others for $key",
    ({ eventName }) => {
      let countA = 0;
      let countB = 0;

      const unsubA = onAppEvent(eventName, () => {
        countA++;
      });
      const unsubB = onAppEvent(eventName, () => {
        countB++;
      });

      emitAppEvent(eventName);
      expect(countA).toBe(1);
      expect(countB).toBe(1);

      // Unsub A only
      unsubA();

      emitAppEvent(eventName);
      expect(countA).toBe(1); // unchanged
      expect(countB).toBe(2); // still receives

      unsubB();
    }
  );
});
