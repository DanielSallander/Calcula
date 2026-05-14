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
