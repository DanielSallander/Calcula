//! FILENAME: app/extensions/_shared/lib/queryObjectRefresh.test.ts
// PURPOSE: Tests for the shared query-object refresh service — targeting,
//   refresh-all, provider isolation, pass coalescing, and the debounced
//   control-change subscription lifecycle.

import { describe, it, expect, vi, afterEach } from "vitest";
import { CONTROL_VALUE_CHANGED } from "@api/controlValues";
import {
  registerQueryObjectProvider,
  refreshBoundQueryObjects,
  type QueryObjectProvider,
} from "./queryObjectRefresh";

const cleanups: Array<() => void> = [];

function register(provider: QueryObjectProvider): void {
  cleanups.push(registerQueryObjectProvider(provider));
}

afterEach(() => {
  for (const fn of cleanups) fn();
  cleanups.length = 0;
  vi.useRealTimers();
});

function makeProvider(
  kind: string,
  bindings: Array<{ id: string; boundControls: string[] }>,
): { provider: QueryObjectProvider; refreshed: Array<{ ids: string[]; names: string[] | null }> } {
  const refreshed: Array<{ ids: string[]; names: string[] | null }> = [];
  return {
    refreshed,
    provider: {
      kind,
      listBindings: async () => bindings.map((b) => ({ ...b, name: b.id })),
      refreshObjects: async (ids, names) => {
        refreshed.push({ ids, names });
      },
    },
  };
}

describe("refreshBoundQueryObjects targeting", () => {
  it("refreshes only objects bound to a changed name (case-insensitive)", async () => {
    const { provider, refreshed } = makeProvider("report", [
      { id: "r-1", boundControls: ["Region"] },
      { id: "r-2", boundControls: ["Products.Category"] },
      { id: "r-3", boundControls: [] },
    ]);
    register(provider);

    await refreshBoundQueryObjects(["REGION"]);

    expect(refreshed).toEqual([{ ids: ["r-1"], names: ["REGION"] }]);
  });

  it("refreshes every bound object when no names are given", async () => {
    const { provider, refreshed } = makeProvider("report", [
      { id: "r-1", boundControls: ["A"] },
      { id: "r-2", boundControls: [] },
    ]);
    register(provider);

    await refreshBoundQueryObjects();

    expect(refreshed).toEqual([{ ids: ["r-1"], names: null }]);
  });

  it("does not call refreshObjects when nothing matches", async () => {
    const { provider, refreshed } = makeProvider("report", [
      { id: "r-1", boundControls: ["Other"] },
    ]);
    register(provider);

    await refreshBoundQueryObjects(["Region"]);

    expect(refreshed).toEqual([]);
  });

  it("spans multiple families in one pass", async () => {
    const reports = makeProvider("report", [{ id: "r-1", boundControls: ["Region"] }]);
    const charts = makeProvider("chart", [{ id: "c-1", boundControls: ["Region"] }]);
    register(reports.provider);
    register(charts.provider);

    await refreshBoundQueryObjects(["Region"]);

    expect(reports.refreshed).toHaveLength(1);
    expect(charts.refreshed).toHaveLength(1);
  });

  it("one failing provider does not block the others", async () => {
    const bad: QueryObjectProvider = {
      kind: "report",
      listBindings: async () => {
        throw new Error("boom");
      },
      refreshObjects: async () => {},
    };
    const good = makeProvider("chart", [{ id: "c-1", boundControls: ["Region"] }]);
    register(bad);
    register(good.provider);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await refreshBoundQueryObjects(["Region"]);

    expect(good.refreshed).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("coalesces calls arriving while a pass is in flight", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let listCalls = 0;
    const refreshed: string[][] = [];
    register({
      kind: "report",
      listBindings: async () => {
        listCalls++;
        if (listCalls === 1) await gate;
        return [{ id: "r-1", name: "r-1", boundControls: ["Region"] }];
      },
      refreshObjects: async (ids) => {
        refreshed.push(ids);
      },
    });

    const first = refreshBoundQueryObjects(["Region"]);
    void refreshBoundQueryObjects(["Region"]);
    void refreshBoundQueryObjects(["Region"]);
    release!();
    await first;

    expect(listCalls).toBe(2); // initial pass + ONE coalesced follow-up
    expect(refreshed).toHaveLength(2);
  });
});

describe("control-change subscription", () => {
  function dispatchControlChange(name: string, transient = false): void {
    window.dispatchEvent(
      new CustomEvent(CONTROL_VALUE_CHANGED, {
        detail: { id: "x", name, value: { kind: "text", value: "v" }, transient },
      }),
    );
  }

  it("debounces + accumulates changed names, skipping transient previews", async () => {
    vi.useFakeTimers();
    const { provider, refreshed } = makeProvider("report", [
      { id: "r-1", boundControls: ["A"] },
      { id: "r-2", boundControls: ["B"] },
      { id: "r-3", boundControls: ["C"] },
    ]);
    register(provider);

    dispatchControlChange("A");
    dispatchControlChange("B");
    dispatchControlChange("C", true); // transient — must not count

    await vi.advanceTimersByTimeAsync(200);

    expect(refreshed).toHaveLength(1);
    expect(refreshed[0].ids.sort()).toEqual(["r-1", "r-2"]);
  });

  it("stops listening after the last provider unregisters", async () => {
    vi.useFakeTimers();
    const { provider, refreshed } = makeProvider("report", [
      { id: "r-1", boundControls: ["A"] },
    ]);
    const unregister = registerQueryObjectProvider(provider);
    unregister();

    dispatchControlChange("A");
    await vi.advanceTimersByTimeAsync(200);

    expect(refreshed).toEqual([]);
  });
});
