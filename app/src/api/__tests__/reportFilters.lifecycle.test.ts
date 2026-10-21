//! FILENAME: app/src/api/__tests__/reportFilters.lifecycle.test.ts
// PURPOSE: @api/reportFilters' lifetime: importing it reads nothing from
//          @api/events at module load (a suite that mocks the events module
//          PARTIALLY must still import every extension that uses the seam),
//          and `startReportFilters()` is reference-counted -- two starters
//          start the page list ONCE, and it stops only after the LAST stop.
// CONTEXT: P4 review A7: selections that installed their own File > New reset
//          at module load, and a page list nobody started, were both defects of
//          the first plan. reportPages.ts:266-273 is the precedent for the
//          "never at module load" rule.

import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ starts: 0, stops: 0, listeners: [] as string[], offs: 0 }));

// A PARTIAL events mock: no AppEvents at all. Reading it at module load would
// throw "No AppEvents export is defined on the mock" at import.
vi.mock("../events", () => ({
  onAppEvent: (name: string) => {
    h.listeners.push(name);
    return () => {
      h.offs++;
    };
  },
}));

vi.mock("../reportPages", () => ({
  startReportPages: () => {
    h.starts++;
    return () => {
      h.stops++;
    };
  },
}));

describe("@api/reportFilters lifetime", () => {
  it("imports under a partial @api/events mock without throwing", async () => {
    const mod = await import("../reportFilters");
    expect(typeof mod.startReportFilters).toBe("function");
    expect(typeof mod.resolveFiltersFor).toBe("function");
    expect(h.listeners).toEqual([]);
    expect(h.starts).toBe(0);
  });

  it("two starters start the page list once; it stops after the last stop; a stop is idempotent", async () => {
    vi.doMock("../events", () => ({
      AppEvents: { AFTER_NEW: "app:after-new", AFTER_OPEN: "app:after-open" },
      onAppEvent: (name: string) => {
        h.listeners.push(name);
        return () => {
          h.offs++;
        };
      },
    }));
    vi.resetModules();
    const { startReportFilters } = await import("../reportFilters");

    const a = startReportFilters();
    const b = startReportFilters();
    expect(h.starts).toBe(1);
    expect(h.listeners).toEqual(["app:after-new", "app:after-open"]);

    a();
    a();
    expect(h.stops).toBe(0);
    expect(h.offs).toBe(0);

    b();
    expect(h.stops).toBe(1);
    expect(h.offs).toBe(2);

    // Started again after a full stop: installed afresh.
    const c = startReportFilters();
    expect(h.starts).toBe(2);
    c();
    expect(h.stops).toBe(2);
  });
});
