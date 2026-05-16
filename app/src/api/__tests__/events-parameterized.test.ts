//! FILENAME: app/src/api/__tests__/events-parameterized.test.ts
// PURPOSE: Parameterized tests for the AppEvents event system.
// CONTEXT: Subscribe/emit/unsubscribe for all AppEvents with varied payload types.

import { describe, it, expect, vi, afterEach } from "vitest";
import { emitAppEvent, onAppEvent, AppEvents } from "../events";

// ============================================================================
// All AppEvents as [name, value] tuples
// ============================================================================

const ALL_EVENTS = Object.entries(AppEvents) as [string, string][];

// Pick 30 events for subscribe/emit/unsubscribe cycle
const EVENT_ENTRIES = ALL_EVENTS.slice(0, 30);

// ============================================================================
// Subscribe, emit, unsubscribe for each event
// ============================================================================

describe("AppEvents subscribe/emit/unsubscribe parameterized", () => {
  const cleanups: (() => void)[] = [];

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
  });

  describe.each(EVENT_ENTRIES)("event %s (%s)", (_name, eventValue) => {
    it("delivers payload to subscriber", () => {
      const cb = vi.fn();
      const unsub = onAppEvent(eventValue, cb);
      cleanups.push(unsub);

      emitAppEvent(eventValue, { test: true });
      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith({ test: true });
    });

    it("unsubscribe prevents delivery", () => {
      const cb = vi.fn();
      const unsub = onAppEvent(eventValue, cb);
      unsub();

      emitAppEvent(eventValue, "after-unsub");
      expect(cb).not.toHaveBeenCalled();
    });
  });
});

// ============================================================================
// Payload type variants for 5 representative events
// ============================================================================

const PAYLOAD_EVENTS: [string, string][] = [
  ["CUT", AppEvents.CUT],
  ["SELECTION_CHANGED", AppEvents.SELECTION_CHANGED],
  ["DATA_CHANGED", AppEvents.DATA_CHANGED],
  ["GRID_REFRESH", AppEvents.GRID_REFRESH],
  ["SHEET_CHANGED", AppEvents.SHEET_CHANGED],
];

const PAYLOAD_CASES: [string, unknown][] = [
  ["string", "hello"],
  ["number", 42],
  ["boolean", true],
  ["null", null],
  ["object", { key: "value", nested: { a: 1 } }],
  ["array", [1, "two", { three: 3 }]],
];

describe("AppEvents payload types parameterized", () => {
  const cleanups: (() => void)[] = [];

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
  });

  describe.each(PAYLOAD_EVENTS)("event %s (%s)", (_name, eventValue) => {
    it.each(PAYLOAD_CASES)(
      "delivers %s payload correctly",
      (_typeName, payload) => {
        const cb = vi.fn();
        const unsub = onAppEvent(eventValue, cb);
        cleanups.push(unsub);

        emitAppEvent(eventValue, payload);

        expect(cb).toHaveBeenCalledOnce();
        expect(cb).toHaveBeenCalledWith(payload);
      },
    );
  });
});
