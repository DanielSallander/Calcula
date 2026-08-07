//! FILENAME: app/src/core/hooks/__tests__/gridKeyboardNavigationOrder.test.tsx
// PURPOSE: A keyboard navigation must not be lost because the next key arrived
//          before the backend answered.
// CONTEXT: The report was "Ctrl+Home is intermittently swallowed before reaching
//          the grid (WebView2 level)": from A5, Ctrl+Home followed by ArrowRight
//          landed on B5 instead of B1. Nothing was swallowed. Every navigation
//          awaits `getMergeInfo` before it dispatches, and each keydown computed
//          its target from the `selection` captured in the CURRENT React render.
//          Two keys inside one IPC round trip therefore both started from A5,
//          and the ArrowRight dispatch — issued second — won.
//
//          The oracle here is exactly the reported sequence, with the round trip
//          held open deliberately so the race is forced rather than hoped for.
//          Against the pre-fix code the last assertion reads B5.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// --- The backend calls the navigation path makes ----------------------------
/** Resolvers for every in-flight getMergeInfo, in call order. */
let mergeGate: Array<() => void> = [];
/** When true, getMergeInfo parks until `releaseMergeInfo()` is called. */
let holdMergeInfo = false;

vi.mock("../../lib/tauri-api", () => ({
  getMergeInfo: vi.fn(async () => {
    if (holdMergeInfo) {
      await new Promise<void>((resolve) => {
        mergeGate.push(resolve);
      });
    }
    return null; // no merges in this fixture
  }),
  findCtrlArrowTarget: vi.fn(async () => [0, 0] as [number, number]),
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 9, endCol: 9 })),
}));

vi.mock("../../../api/cellTypes", () => ({
  handleCellTypeKeyDown: vi.fn(async () => false),
}));

vi.mock("../../../utils/component-logger", () => {
  const noop = () => {};
  return {
    fnLog: { enter: noop, exit: noop },
    stateLog: { action: noop },
    eventLog: { keyboard: noop },
  };
});

import { useGridKeyboard } from "../useGridKeyboard";
import { GridProvider, useGridContext } from "../../state/GridContext";
import { getInitialState } from "../../state/gridReducer";
import { setSelection } from "../../state/gridActions";
import type { GridState, Selection } from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** The selection the grid is currently showing, as the renderer would read it. */
let observedSelection: Selection | null = null;
let containerEl: HTMLDivElement;

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const ref = React.useRef<HTMLDivElement | null>(null);
  observedSelection = state.selection;

  useGridKeyboard({ containerRef: ref, enabled: true, isEditing: false });

  // Seed the starting cell once.
  React.useEffect(() => {
    dispatch(
      setSelection({ startRow: 4, startCol: 0, endRow: 4, endCol: 0, type: "cells" }),
    );
  }, [dispatch]);

  return <div ref={ref} data-testid="grid" tabIndex={0} />;
}

let root: Root;

async function mount(): Promise<void> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const initial: GridState = getInitialState();
  await act(async () => {
    root.render(
      <GridProvider initialState={initial}>
        <Harness />
      </GridProvider>,
    );
  });
  containerEl = host.querySelector("[data-testid='grid']") as HTMLDivElement;
}

/** Dispatch a raw keydown at the grid container, as the browser would. */
function press(key: string, mods: { ctrl?: boolean; shift?: boolean } = {}): void {
  containerEl.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      ctrlKey: mods.ctrl ?? false,
      shiftKey: mods.shift ?? false,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/** Let every parked getMergeInfo through, then drain promises and React work. */
async function releaseMergeInfo(): Promise<void> {
  await act(async () => {
    const gates = mergeGate;
    mergeGate = [];
    for (const open of gates) open();
    // Each released navigation queues the next one, which parks again only if
    // `holdMergeInfo` is still set; drain repeatedly so the whole chain runs.
    for (let i = 0; i < 20; i++) {
      const more = mergeGate;
      mergeGate = [];
      for (const open of more) open();
      await Promise.resolve();
      await Promise.resolve();
    }
  });
}

function cellOf(sel: Selection | null): string {
  if (!sel) return "none";
  return `r${sel.endRow}c${sel.endCol}`;
}

// ---------------------------------------------------------------------------

describe("grid keyboard navigation is serialised, not fire-and-forget", () => {
  beforeEach(() => {
    mergeGate = [];
    holdMergeInfo = false;
    observedSelection = null;
  });

  it("precondition: a single navigation with an idle backend works", async () => {
    await mount();
    expect(cellOf(observedSelection)).toBe("r4c0"); // A5

    await act(async () => {
      press("Home", { ctrl: true });
      await Promise.resolve();
    });
    expect(cellOf(observedSelection)).toBe("r0c0"); // A1
  });

  // THE BUG, forced: Ctrl+Home then ArrowRight inside one round trip.
  it("Ctrl+Home then ArrowRight lands on B1, even when both keys arrive inside one round trip", async () => {
    await mount();
    expect(cellOf(observedSelection)).toBe("r4c0"); // A5

    holdMergeInfo = true;
    await act(async () => {
      press("Home", { ctrl: true });
      await Promise.resolve();
      // The backend has NOT answered yet — this is the reported timing.
      press("ArrowRight");
      await Promise.resolve();
    });
    // Nothing has landed while the round trip is open.
    expect(cellOf(observedSelection)).toBe("r4c0");

    holdMergeInfo = false;
    await releaseMergeInfo();

    // B1, not B5: the ArrowRight chained off where Ctrl+Home landed.
    expect(cellOf(observedSelection)).toBe("r0c1");
  });

  it("a burst of arrows applies every one of them in order", async () => {
    await mount();

    holdMergeInfo = true;
    await act(async () => {
      press("ArrowRight");
      press("ArrowRight");
      press("ArrowRight");
      press("ArrowDown");
      await Promise.resolve();
    });

    holdMergeInfo = false;
    await releaseMergeInfo();

    // From A5 (r4c0): three rights and one down.
    expect(cellOf(observedSelection)).toBe("r5c3");
  });

  it("Ctrl+End then Ctrl+Home returns to A1 rather than sticking at the end", async () => {
    await mount();

    holdMergeInfo = true;
    await act(async () => {
      press("End", { ctrl: true });
      await Promise.resolve();
      press("Home", { ctrl: true });
      await Promise.resolve();
    });

    holdMergeInfo = false;
    await releaseMergeInfo();

    expect(cellOf(observedSelection)).toBe("r0c0");
  });

  it("Shift+ArrowRight extends from where the previous navigation landed", async () => {
    await mount();

    holdMergeInfo = true;
    await act(async () => {
      press("Home", { ctrl: true });
      await Promise.resolve();
      press("ArrowRight", { shift: true });
      await Promise.resolve();
    });

    holdMergeInfo = false;
    await releaseMergeInfo();

    // Anchored at A1, extended to B1 — not anchored at the pre-Ctrl+Home A5.
    expect(observedSelection).toEqual(
      expect.objectContaining({ startRow: 0, startCol: 0, endRow: 0, endCol: 1 }),
    );
  });
});
