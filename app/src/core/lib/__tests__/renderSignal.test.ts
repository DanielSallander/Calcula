//! FILENAME: app/src/core/lib/__tests__/renderSignal.test.ts
// PURPOSE: Prove the render signal can actually SAY "not settled yet" in each of
//          the three states a screenshot must not be taken in.
// CONTEXT: The signal exists because `waitForGridStable` used to be a 500 ms
//          sleep, and two visual goldens differed between two runs of the same
//          suite as a result. A signal that is quiescent in every state would be
//          the same defect wearing a counter, so each case below drives the
//          predicate to FALSE first and only then back to TRUE — the detector is
//          tested, not just the happy path.

import { describe, it, expect, beforeEach } from "vitest";
import {
  isGridRenderQuiescent,
  markDataCommitted,
  markFetchSettled,
  markFetchStarted,
  markPainted,
  markRefetchQueued,
  readGridRenderSignal,
  resetGridRenderSignal,
} from "../renderSignal";

describe("grid render signal", () => {
  beforeEach(() => {
    resetGridRenderSignal();
  });

  it("starts quiescent", () => {
    expect(isGridRenderQuiescent()).toBe(true);
  });

  it("is NOT quiescent while a viewport fetch is in flight", () => {
    markFetchStarted();
    expect(isGridRenderQuiescent()).toBe(false);
    markFetchSettled();
    markPainted();
    expect(isGridRenderQuiescent()).toBe(true);
  });

  it("counts concurrent fetches rather than toggling a flag", () => {
    markFetchStarted();
    markFetchStarted();
    markFetchSettled();
    expect(isGridRenderQuiescent()).toBe(false);
    markFetchSettled();
    expect(isGridRenderQuiescent()).toBe(true);
  });

  it("is NOT quiescent between committing data and painting it", () => {
    // This is the case a boolean "is anything running" cannot express: the
    // fetch has finished, nothing is in flight, and the canvas still shows the
    // PREVIOUS frame.
    markFetchStarted();
    markDataCommitted();
    markFetchSettled();
    expect(readGridRenderSignal().fetchesInFlight).toBe(0);
    expect(isGridRenderQuiescent()).toBe(false);
    markPainted();
    expect(isGridRenderQuiescent()).toBe(true);
  });

  it("is NOT quiescent while a deferred re-fetch is owed", () => {
    // The gap that has no other observable: the deferred request has been
    // recorded, the in-flight one has finished and painted, and a re-fetch is
    // still to come.
    markRefetchQueued(true);
    markPainted();
    expect(isGridRenderQuiescent()).toBe(false);
    markRefetchQueued(false);
    expect(isGridRenderQuiescent()).toBe(true);
  });

  it("a paint stamps the data it drew, so a later commit un-settles it again", () => {
    markDataCommitted();
    markPainted();
    expect(isGridRenderQuiescent()).toBe(true);
    markDataCommitted();
    expect(isGridRenderQuiescent()).toBe(false);
  });

  it("publishes the LIVE object on window, not a snapshot", () => {
    const published = (window as unknown as Record<string, unknown>)
      .__CALCULA_GRID_RENDER__ as { paintSeq: number };
    expect(published).toBeDefined();
    const before = published.paintSeq;
    markPainted();
    // A snapshot would still read `before` here, and every harness poll would
    // see a grid frozen in the state it was in at page load.
    expect(published.paintSeq).toBe(before + 1);
  });
});
