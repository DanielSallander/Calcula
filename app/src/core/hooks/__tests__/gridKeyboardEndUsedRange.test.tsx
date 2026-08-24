//! FILENAME: app/src/core/hooks/__tests__/gridKeyboardEndUsedRange.test.tsx
// PURPOSE: The End key must mean the end of the DATA, and mean the same thing
//          whichever gesture asks.
// CONTEXT: Ctrl+Shift+End extended to the last used cell by awaiting
//          getUsedRange, while plain Ctrl+End travelled a
//          config.totalRows/totalCols delta that handleArrowNavigation clamps to
//          the sheet bounds — so it landed on XFD1048576 and never asked the
//          backend anything. Two gestures, two answers, both visible to the same
//          user in the same second.
//
//          Bare End had the same shape of bug one axis down: it jumped to column
//          XFD, where Excel arms "End mode" and moves nothing at all.
//
//          The oracle is the mocked used range: every assertion here is a place
//          the sheet's data actually reaches.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// --- The backend calls the navigation path makes ----------------------------
/** What get_used_range answers for the sheet under test. */
let usedRange = { startRow: 0, startCol: 0, endRow: 9, endCol: 4, empty: false };
/** How many times the hook asked for it — a hard-coded jump would ask zero. */
let usedRangeCalls = 0;
/** Every findCtrlArrowTarget call, as [row, col, direction]. */
let ctrlArrowCalls: Array<[number, number, string]> = [];
/** Where findCtrlArrowTarget claims the edge of the data is. */
const CTRL_ARROW_TARGET: [number, number] = [4, 7];

vi.mock("../../lib/tauri-api", () => ({
  getMergeInfo: vi.fn(async () => null), // no merges in this fixture
  findCtrlArrowTarget: vi.fn(
    async (row: number, col: number, direction: string) => {
      ctrlArrowCalls.push([row, col, direction]);
      return CTRL_ARROW_TARGET;
    },
  ),
  getUsedRange: vi.fn(async () => {
    usedRangeCalls += 1;
    return usedRange;
  }),
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

import { useGridKeyboard, setExtendMode, setEndMode } from "../useGridKeyboard";
import { GridProvider, useGridContext } from "../../state/GridContext";
import { getInitialState } from "../../state/gridReducer";
import { setSelection } from "../../state/gridActions";
import type { GridState, Selection } from "../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// ---------------------------------------------------------------------------
// Harness — same shape as gridKeyboardNavigationOrder.test.tsx
// ---------------------------------------------------------------------------

/** The selection the grid is currently showing, as the renderer would read it. */
let observedSelection: Selection | null = null;
let containerEl: HTMLDivElement;

function Harness(): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const ref = React.useRef<HTMLDivElement | null>(null);
  observedSelection = state.selection;

  useGridKeyboard({ containerRef: ref, enabled: true, isEditing: false });

  // Seed the starting cell once: A5.
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

/**
 * Drain the navigation chain. Every navigation is at least two awaits deep
 * (get_used_range, then get_merge_info), so a single microtask tick is not
 * enough to see where a key landed.
 */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
    }
  });
}

function cellOf(sel: Selection | null): string {
  if (!sel) return "none";
  return `r${sel.endRow}c${sel.endCol}`;
}

// The sheet bounds the pre-fix delta path clamped to — the wrong answer, named
// so a regression reads as "went to XFD1048576" rather than as two magic ints.
const LAST_CELL_OF_SHEET = `r${getInitialState().config.totalRows - 1}c${getInitialState().config.totalCols - 1}`;

// ---------------------------------------------------------------------------

describe("End goes to the end of the data, not the end of the sheet", () => {
  beforeEach(() => {
    usedRange = { startRow: 0, startCol: 0, endRow: 9, endCol: 4, empty: false };
    usedRangeCalls = 0;
    ctrlArrowCalls = [];
    observedSelection = null;
    // Both modes are MODULE state: a test that leaves one armed arms it for the
    // next test too. That is exactly how "End then arrow" first failed here.
    setExtendMode(false);
    setEndMode(false);
  });

  it("Ctrl+End lands on the last used cell, not on the sheet's last cell", async () => {
    await mount();
    expect(cellOf(observedSelection)).toBe("r4c0"); // A5

    press("End", { ctrl: true });
    await settle();

    expect(cellOf(observedSelection)).toBe("r9c4"); // E10, the used range's corner
    expect(cellOf(observedSelection)).not.toBe(LAST_CELL_OF_SHEET);
  });

  it("Ctrl+End asks the backend where the used range is", async () => {
    await mount();

    press("End", { ctrl: true });
    await settle();

    expect(usedRangeCalls).toBe(1);
  });

  it("Ctrl+End and Ctrl+Shift+End agree about where the end is", async () => {
    await mount();
    press("End", { ctrl: true });
    await settle();
    const wentTo = { row: observedSelection!.endRow, col: observedSelection!.endCol };

    await mount(); // a second grid, seeded at A5 again
    press("End", { ctrl: true, shift: true });
    await settle();
    const extendedTo = { row: observedSelection!.endRow, col: observedSelection!.endCol };

    expect(extendedTo).toEqual(wentTo);
    // ...and the extend gesture still anchors where it started.
    expect(observedSelection).toEqual(
      expect.objectContaining({ startRow: 4, startCol: 0 }),
    );
  });

  it("Ctrl+End on an empty sheet goes to A1", async () => {
    usedRange = { startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true };
    await mount();

    press("End", { ctrl: true });
    await settle();

    expect(cellOf(observedSelection)).toBe("r0c0");
  });

  it("Ctrl+End selects a single cell rather than dragging the old anchor along", async () => {
    await mount();

    press("End", { ctrl: true });
    await settle();

    expect(observedSelection).toEqual(
      expect.objectContaining({ startRow: 9, startCol: 4, endRow: 9, endCol: 4 }),
    );
  });

  it("Ctrl+End extends while F8 extend mode is on, as every other navigation does", async () => {
    await mount();
    setExtendMode(true);

    press("End", { ctrl: true });
    await settle();

    expect(observedSelection).toEqual(
      expect.objectContaining({ startRow: 4, startCol: 0, endRow: 9, endCol: 4 }),
    );
  });
});

describe("bare End arms End mode instead of jumping to column XFD", () => {
  beforeEach(() => {
    usedRange = { startRow: 0, startCol: 0, endRow: 9, endCol: 4, empty: false };
    usedRangeCalls = 0;
    ctrlArrowCalls = [];
    observedSelection = null;
    // Both modes are MODULE state: a test that leaves one armed arms it for the
    // next test too. That is exactly how "End then arrow" first failed here.
    setExtendMode(false);
    setEndMode(false);
  });

  it("End alone moves nothing", async () => {
    await mount();

    press("End");
    await settle();

    expect(cellOf(observedSelection)).toBe("r4c0");
  });

  it("End then an arrow jumps to the edge of the data, like Ctrl+Arrow", async () => {
    await mount();

    press("End");
    press("ArrowRight");
    await settle();

    expect(ctrlArrowCalls).toEqual([[4, 0, "right"]]);
    expect(cellOf(observedSelection)).toBe("r4c7");
  });

  it("End mode is spent by the key it serves: the next arrow moves one cell", async () => {
    await mount();

    press("End");
    press("ArrowRight");
    await settle();
    press("ArrowRight");
    await settle();

    expect(ctrlArrowCalls).toHaveLength(1);
    expect(cellOf(observedSelection)).toBe("r4c8"); // one column on from the jump
  });

  it("a modifier keydown between End and the arrow does not spend End mode", async () => {
    await mount();

    press("End");
    press("Shift"); // the keydown the browser fires for the modifier itself
    press("ArrowRight", { shift: true });
    await settle();

    expect(ctrlArrowCalls).toEqual([[4, 0, "right"]]);
    expect(observedSelection).toEqual(
      expect.objectContaining({ startRow: 4, startCol: 0, endRow: 4, endCol: 7 }),
    );
  });

  it("a second End turns End mode back off", async () => {
    await mount();

    press("End");
    press("End");
    press("ArrowRight");
    await settle();

    expect(ctrlArrowCalls).toEqual([]);
    expect(cellOf(observedSelection)).toBe("r4c1");
  });

  it("any other key cancels End mode", async () => {
    await mount();

    press("End");
    press("Escape");
    press("ArrowRight");
    await settle();

    expect(ctrlArrowCalls).toEqual([]);
    expect(cellOf(observedSelection)).toBe("r4c1");
  });

  it("End then Home goes to the last used cell", async () => {
    await mount();

    press("End");
    press("Home");
    await settle();

    expect(usedRangeCalls).toBe(1);
    expect(cellOf(observedSelection)).toBe("r9c4");
  });

  it("Ctrl+Home still goes to A1 with End mode armed", async () => {
    await mount();

    press("End");
    press("Home", { ctrl: true });
    await settle();

    expect(usedRangeCalls).toBe(0);
    expect(cellOf(observedSelection)).toBe("r0c0");
  });
});
