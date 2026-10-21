//! FILENAME: app/extensions/TimelineSlicer/__tests__/timelineLocaleRefresh.test.ts
// PURPOSE: A timeline's period labels ("Jan", "Q1" / "jan.", "Kv1") are
//          written by Rust in the APP locale and cached per timeline
//          (`refreshCache` -> `getTimelineData`). A runtime locale switch must
//          re-read them: driven through the REAL `activate()` with a fake host,
//          AppEvents.LOCALE_CHANGED re-reads the cache. Before the listener
//          existed nothing reached the timeline store on a locale switch (the
//          shell only dispatches grid:refresh, Pivot's handler never
//          dispatches pivot:refresh), so labels kept the old language.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const h = vi.hoisted(() => ({
  refresh: vi.fn(async () => undefined),
}));

vi.mock("../lib/timelineSlicerStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshCache: h.refresh,
  refreshCacheAndReconcile: vi.fn(async () => undefined),
}));

import type { ExtensionContext } from "@api/contract";
import { AppEvents } from "@api/events";
import extension from "../index";

const handlers = new Map<string, Array<(...args: unknown[]) => void>>();

const context = {
  invokeBackend: vi.fn(async () => null),
  ui: { dialogs: { register: vi.fn() } },
  grid: { overlays: { register: () => () => {} } },
  events: {
    on: vi.fn((name: string, cb: (...args: unknown[]) => void) => {
      const list = handlers.get(name) ?? [];
      list.push(cb);
      handlers.set(name, list);
      return () => {};
    }),
  },
} as unknown as ExtensionContext;

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  extension.activate(context);
});

afterAll(() => {
  extension.deactivate?.();
  vi.restoreAllMocks();
});

describe("a locale switch", () => {
  it("re-reads every timeline (its period labels are written in the app locale)", async () => {
    const listeners = handlers.get(AppEvents.LOCALE_CHANGED) ?? [];
    expect(listeners.length, "TimelineSlicer does not listen for LOCALE_CHANGED").toBeGreaterThan(0);
    h.refresh.mockClear();
    for (const cb of listeners) cb({ localeId: "sv-SE" });
    await Promise.resolve();
    expect(h.refresh, "a locale switch did not re-read the timelines' labels").toHaveBeenCalled();
  });
});
