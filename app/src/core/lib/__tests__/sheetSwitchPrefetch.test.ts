//! FILENAME: app/src/core/lib/__tests__/sheetSwitchPrefetch.test.ts
// PURPOSE: Pin the handoff slot BUG-0052's fix rides on: a primed payload is
//          consumed by exactly the switch it was primed for, exactly once,
//          and every failure mode degrades to "no payload" (the old
//          fetch-after-swap path), never to a stale or foreign paint.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  primeSheetSwitch,
  registerSheetSwitchPrefetcher,
  resetSheetSwitchPrefetchForTests,
  takePrefetchedSheetSwitch,
  type SheetSwitchPrefetchPayload,
} from "../sheetSwitchPrefetch";
import { readGridRenderSignal, resetGridRenderSignal } from "../renderSignal";

function payload(marker: number): SheetSwitchPrefetchPayload {
  return {
    fetchRange: { startRow: 0, endRow: 40, startCol: 0, endCol: 20 },
    cells: [{ row: 0, col: 0, display: `cell-${marker}`, styleIndex: 0 } as never],
    spillRanges: [],
  };
}

describe("sheetSwitchPrefetch", () => {
  beforeEach(() => {
    resetSheetSwitchPrefetchForTests();
    resetGridRenderSignal();
  });

  afterEach(() => {
    resetSheetSwitchPrefetchForTests();
    resetGridRenderSignal();
    vi.restoreAllMocks();
  });

  it("hands a primed payload to the switch it was primed for, exactly once", async () => {
    registerSheetSwitchPrefetcher(async () => payload(1));

    await primeSheetSwitch(2);

    expect(takePrefetchedSheetSwitch(2)).toEqual(payload(1));
    // The take CLEARED the slot: a second identical switch must fall back.
    expect(takePrefetchedSheetSwitch(2)).toBeNull();
  });

  it("refuses a payload primed for ANOTHER sheet — a foreign paint is worse than a slow one", async () => {
    registerSheetSwitchPrefetcher(async () => payload(7));

    await primeSheetSwitch(2);

    expect(takePrefetchedSheetSwitch(3)).toBeNull();
    // And the refusal also cleared the slot rather than leaving a trap armed.
    expect(takePrefetchedSheetSwitch(2)).toBeNull();
  });

  it("primes nothing when no prefetcher is registered (grid not mounted)", async () => {
    await primeSheetSwitch(1);
    expect(takePrefetchedSheetSwitch(1)).toBeNull();
  });

  it("a prime that throws leaves the slot empty and does not propagate", async () => {
    registerSheetSwitchPrefetcher(async () => {
      throw new Error("ipc down");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(primeSheetSwitch(1)).resolves.toBeUndefined();

    expect(takePrefetchedSheetSwitch(1)).toBeNull();
    expect(consoleError).toHaveBeenCalled();
  });

  it("a prime that answers null (canvas has no size yet) leaves the slot empty", async () => {
    registerSheetSwitchPrefetcher(async () => null);
    await primeSheetSwitch(1);
    expect(takePrefetchedSheetSwitch(1)).toBeNull();
  });

  it("a NEW prime replaces an abandoned one", async () => {
    let marker = 1;
    registerSheetSwitchPrefetcher(async () => payload(marker));

    await primeSheetSwitch(1); // abandoned: never taken
    marker = 2;
    await primeSheetSwitch(4);

    // The second prime evicted the first's payload wholesale.
    expect(takePrefetchedSheetSwitch(4)).toEqual(payload(2));
    expect(takePrefetchedSheetSwitch(1)).toBeNull();
  });

  it("a payload older than the freshness bound is refused", async () => {
    registerSheetSwitchPrefetcher(async () => payload(1));
    const now = vi.spyOn(performance, "now");

    now.mockReturnValue(1_000);
    await primeSheetSwitch(2);

    now.mockReturnValue(1_000 + 5_001);
    expect(takePrefetchedSheetSwitch(2)).toBeNull();
  });

  it("unregistering the prefetcher also drops any primed payload", async () => {
    const dispose = registerSheetSwitchPrefetcher(async () => payload(1));
    await primeSheetSwitch(2);

    dispose();

    expect(takePrefetchedSheetSwitch(2)).toBeNull();
    // And a prime after disposal is a no-op, not a crash.
    await primeSheetSwitch(2);
    expect(takePrefetchedSheetSwitch(2)).toBeNull();
  });

  it("disposal is ownership-checked: an old canvas unmounting cannot unregister its successor", async () => {
    const disposeFirst = registerSheetSwitchPrefetcher(async () => payload(1));
    registerSheetSwitchPrefetcher(async () => payload(2));

    disposeFirst(); // stale unmount, e.g. StrictMode double-mount ordering

    await primeSheetSwitch(5);
    expect(takePrefetchedSheetSwitch(5)).toEqual(payload(2));
  });

  it("brackets the fetch with the renderSignal in-flight marks so a capture cannot photograph mid-prime", async () => {
    let inFlightDuringFetch = -1;
    registerSheetSwitchPrefetcher(async () => {
      inFlightDuringFetch = readGridRenderSignal().fetchesInFlight;
      return payload(1);
    });

    await primeSheetSwitch(2);

    expect(inFlightDuringFetch).toBe(1);
    expect(readGridRenderSignal().fetchesInFlight).toBe(0);
  });

  it("settles the in-flight mark even when the fetch throws", async () => {
    registerSheetSwitchPrefetcher(async () => {
      throw new Error("ipc down");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await primeSheetSwitch(2);

    expect(readGridRenderSignal().fetchesInFlight).toBe(0);
  });
});
