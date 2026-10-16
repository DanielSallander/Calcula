//! FILENAME: app/extensions/BuiltIn/StatusBarAggregation/__tests__/useSelectionAggregation.test.tsx
// PURPOSE: The status bar aggregates the range an object published on
//          @api/statusBarRange instead of Core's selection (WP-A S11a): an
//          external range wins, its withdrawal falls back to Core's selection,
//          a single cell shows nothing, and a late answer for a selection the
//          bar has left is dropped.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type SelectionLike = {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  type: string;
  additionalRanges?: { startRow: number; startCol: number; endRow: number; endCol: number }[];
} | null;

const h = vi.hoisted(() => ({
  selectionListeners: new Set<(sel: unknown) => void>(),
  getSelectionAggregations: vi.fn(),
}));

vi.mock("@api", () => ({
  ExtensionRegistry: {
    onSelectionChange: (cb: (sel: unknown) => void) => {
      h.selectionListeners.add(cb);
      return () => h.selectionListeners.delete(cb);
    },
  },
  AppEvents: { CELLS_UPDATED: "app:cells-updated" },
  onAppEvent: () => () => {},
  getSelectionAggregations: h.getSelectionAggregations,
}));

import { useSelectionAggregation } from "../useSelectionAggregation";
import { publishStatusBarRange, __resetStatusBarRangeForTests } from "@api/statusBarRange";

/** The aggregate the fake backend answers: Sum = the number of cells, so the range asked is visible. */
function aggregateFor(startRow: number, startCol: number, endRow: number, endCol: number) {
  const cells = (endRow - startRow + 1) * (endCol - startCol + 1);
  return { sum: cells, average: 1, min: 1, max: 1, count: cells, numericalCount: cells };
}

let host: HTMLDivElement;
let root: Root;
const seen: { current: ReturnType<typeof useSelectionAggregation> | undefined } = { current: undefined };

function Probe(): null {
  seen.current = useSelectionAggregation();
  return null;
}

function announceCoreSelection(sel: SelectionLike): void {
  act(() => {
    for (const cb of [...h.selectionListeners]) cb(sel);
  });
}

/** Past the 150 ms debounce, and every IPC promise settled. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
}

beforeAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

beforeEach(() => {
  vi.useFakeTimers();
  __resetStatusBarRangeForTests();
  h.getSelectionAggregations.mockReset();
  h.getSelectionAggregations.mockImplementation((sr: number, sc: number, er: number, ec: number) =>
    Promise.resolve(aggregateFor(sr, sc, er, ec)),
  );
  seen.current = undefined;
  host = document.createElement("div");
  root = createRoot(host);
  act(() => {
    root.render(React.createElement(Probe));
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  __resetStatusBarRangeForTests();
  vi.useRealTimers();
});

describe("useSelectionAggregation + @api/statusBarRange", () => {
  it("Core's multi-cell selection is aggregated when nothing is published (unchanged behaviour)", async () => {
    announceCoreSelection({ startRow: 0, startCol: 0, endRow: 1, endCol: 1, type: "cells" });
    await settle();
    expect(h.getSelectionAggregations).toHaveBeenLastCalledWith(0, 0, 1, 1, "cells");
    expect(seen.current?.sum).toBe(4);
  });

  it("an external range wins over Core's selection, as a plain cell block", async () => {
    announceCoreSelection({ startRow: 0, startCol: 0, endRow: 1, endCol: 1, type: "columns" });
    await settle();
    act(() => {
      publishStatusBarRange("pivot-cells", { startRow: 4, startCol: 1, endRow: 8, endCol: 3 });
    });
    await settle();
    expect(h.getSelectionAggregations).toHaveBeenLastCalledWith(4, 1, 8, 3, "cells");
    expect(seen.current?.sum).toBe(15);
  });

  it("the external range keeps winning when Core's selection moves underneath it", async () => {
    act(() => {
      publishStatusBarRange("pivot-cells", { startRow: 4, startCol: 1, endRow: 8, endCol: 3 });
    });
    await settle();
    announceCoreSelection({ startRow: 20, startCol: 0, endRow: 29, endCol: 0, type: "cells" });
    await settle();
    expect(h.getSelectionAggregations).toHaveBeenLastCalledWith(4, 1, 8, 3, "cells");
    expect(seen.current?.sum).toBe(15);
  });

  it("withdrawing the range falls back to Core's selection as it stands now", async () => {
    act(() => {
      publishStatusBarRange("pivot-cells", { startRow: 4, startCol: 1, endRow: 8, endCol: 3 });
    });
    announceCoreSelection({ startRow: 0, startCol: 0, endRow: 0, endCol: 1, type: "cells" });
    await settle();
    expect(seen.current?.sum).toBe(15);
    act(() => {
      publishStatusBarRange("pivot-cells", null);
    });
    await settle();
    expect(h.getSelectionAggregations).toHaveBeenLastCalledWith(0, 0, 0, 1, "cells");
    expect(seen.current?.sum).toBe(2);
  });

  it("withdrawing to a single-cell Core selection shows nothing", async () => {
    announceCoreSelection({ startRow: 3, startCol: 3, endRow: 3, endCol: 3, type: "cells" });
    act(() => {
      publishStatusBarRange("pivot-cells", { startRow: 4, startCol: 1, endRow: 8, endCol: 3 });
    });
    await settle();
    expect(seen.current).not.toBeNull();
    act(() => {
      publishStatusBarRange("pivot-cells", null);
    });
    expect(seen.current).toBeNull();
  });

  it("a single published cell shows nothing, even over a multi-cell Core selection", async () => {
    announceCoreSelection({ startRow: 0, startCol: 0, endRow: 5, endCol: 5, type: "cells" });
    await settle();
    expect(seen.current?.sum).toBe(36);
    const callsBefore = h.getSelectionAggregations.mock.calls.length;
    act(() => {
      publishStatusBarRange("pivot-cells", { startRow: 4, startCol: 1, endRow: 4, endCol: 1 });
    });
    await settle();
    expect(seen.current).toBeNull();
    expect(h.getSelectionAggregations.mock.calls.length, "a single cell asked the backend").toBe(callsBefore);
  });

  it("a range published before the widget mounted wins from the start", async () => {
    act(() => {
      root.unmount();
    });
    act(() => {
      publishStatusBarRange("pivot-cells", { startRow: 0, startCol: 0, endRow: 2, endCol: 0 });
    });
    root = createRoot(host);
    act(() => {
      root.render(React.createElement(Probe));
    });
    await settle();
    expect(h.getSelectionAggregations).toHaveBeenLastCalledWith(0, 0, 2, 0, "cells");
    expect(seen.current?.sum).toBe(3);
  });

  it("a late answer for the range the bar has left does not overwrite the fallback", async () => {
    let resolveLate: (v: unknown) => void = () => {};
    h.getSelectionAggregations.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveLate = resolve;
      }),
    );
    act(() => {
      publishStatusBarRange("pivot-cells", { startRow: 4, startCol: 1, endRow: 8, endCol: 3 });
    });
    await settle(); // the pivot's request is now in flight, unanswered
    act(() => {
      publishStatusBarRange("pivot-cells", null);
    });
    expect(seen.current).toBeNull();
    await act(async () => {
      resolveLate(aggregateFor(4, 1, 8, 3));
      await Promise.resolve();
    });
    expect(seen.current, "the withdrawn pivot range's answer reappeared").toBeNull();
  });
});
