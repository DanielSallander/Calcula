//! FILENAME: app/src/core/hooks/useMouseSelection/__tests__/selectAllCornerWiring.test.tsx
// PURPOSE: A corner click reaches the whole-sheet inserter through the REAL
//          handleMouseDown, in formula mode as well as normal mode.
//
// CONTEXT: The defect was never in a handler -- it was MISSING WIRING over a
//          working primitive. `insertRowRangeReference` had been correct all
//          along; the formula-mode branch of `handleMouseDown` simply tried
//          three handlers that are structurally blind to the corner and then
//          fell out with no fallback, so the click inserted nothing and said
//          nothing.
//
//          selectAllCorner.test.ts calls the corner handler directly, which is
//          the right shape for the handler's own rules but CANNOT see this class
//          of bug: delete the call site in useMouseSelection.ts and every
//          assertion there stays green while the product goes back to doing
//          nothing. That is why this file drives the hook itself and asserts on
//          the props the host passed in -- the same seam the grid uses.
//
//          Measured while proving teeth: removing the
//          handleFormulaCornerMouseDown call from handleMouseDown reds the first
//          test here and NOTHING in selectAllCorner.test.ts (24/24 still green).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useMouseSelection } from "../useMouseSelection";
import type { UseMouseSelectionProps, UseMouseSelectionReturn } from "../types";
import { DEFAULT_GRID_CONFIG, type Viewport } from "../../../types";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const CONFIG = { ...DEFAULT_GRID_CONFIG };
const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 10 };

/** Dead centre of the 22x20 corner box. */
const CORNER = { x: 11, y: 10 };
/** A column-header pixel: past the row gutter, still above the cells. */
const COL_HEADER = { x: 60, y: 10 };

/** Every callback a corner press could plausibly reach, so a wrong one shows. */
function makeSpies() {
  return {
    onSelectCell: vi.fn(),
    onExtendTo: vi.fn(),
    onScroll: vi.fn(),
    onInsertRowRangeReference: vi.fn(),
    onInsertRowReference: vi.fn(),
    onInsertColumnReference: vi.fn(),
    onInsertReference: vi.fn(),
    onUpdatePendingColumnReference: vi.fn(),
  };
}

type Spies = ReturnType<typeof makeSpies>;

/** The hook's latest return value, republished after every render. */
type ApiSink = { current: UseMouseSelectionReturn | null };

let root: Root | null = null;

/**
 * Mounts the hook and hands back a sink holding its CURRENT return value. The
 * sink is filled from an effect rather than during render, so the value a test
 * presses on always carries the newest closures -- the same reason the hook's
 * own mouseup latch exists.
 *
 * The container is a real element: handleMouseDown reads getBoundingClientRect
 * off it, and jsdom's all-zero rect is exactly the canvas-origin case the corner
 * lives in.
 */
async function mountHook(props: Partial<UseMouseSelectionProps>, spies: Spies): Promise<ApiSink> {
  const sink: ApiSink = { current: null };

  function Harness(): React.ReactElement {
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const api = useMouseSelection({
      containerRef,
      scrollRef: { current: null },
      config: CONFIG,
      viewport: VIEWPORT,
      selection: null,
      ...spies,
      ...props,
    });
    React.useEffect(() => {
      sink.current = api;
    });
    return <div ref={containerRef} data-testid="grid" />;
  }

  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Harness />);
  });

  return sink;
}

/** The subset of MouseEvent handleMouseDown actually reads. */
function mouseDownAt(point: { x: number; y: number }): React.MouseEvent<HTMLElement> {
  return {
    clientX: point.x,
    clientY: point.y,
    button: 0,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.MouseEvent<HTMLElement>;
}

/**
 * handleMouseDown is declared void but is `async`, so awaiting the value it
 * returns is what makes the normal-mode path -- which awaits
 * onCommitBeforeSelect before it selects -- observable at all.
 */
async function press(sink: ApiSink, point: { x: number; y: number }): Promise<void> {
  await act(async () => {
    await (sink.current!.handleMouseDown(mouseDownAt(point)) as unknown as Promise<void>);
  });
}

beforeEach(() => {
  root = null;
});

afterEach(async () => {
  if (root) {
    const toUnmount = root;
    await act(async () => {
      toUnmount.unmount();
    });
    root = null;
  }
  document.body.innerHTML = "";
});

describe("formula entry: the corner is wired to the whole-sheet inserter", () => {
  it("a corner press asks for every row of the sheet", async () => {
    const spies = makeSpies();
    const sink = await mountHook({ isFormulaMode: true }, spies);

    await press(sink, CORNER);

    expect(spies.onInsertRowRangeReference).toHaveBeenCalledWith(0, CONFIG.totalRows - 1);
  });

  it("does not move the selection while a formula is being written", async () => {
    // The whole point of formula mode: the click builds a reference, it does not
    // navigate away from the cell being edited.
    const spies = makeSpies();
    const sink = await mountHook({ isFormulaMode: true }, spies);

    await press(sink, CORNER);

    expect(spies.onSelectCell).not.toHaveBeenCalled();
    expect(spies.onInsertRowReference).not.toHaveBeenCalled();
    expect(spies.onInsertColumnReference).not.toHaveBeenCalled();
  });

  it("still lets a column-header press start its own reference", async () => {
    // The corner handler runs FIRST in that branch; this is the control that it
    // claims only corner pixels and hands everything else on. The column header
    // is a DRAG -- mouse down seeds the pending highlight and the insert happens
    // on mouse up -- which is exactly the shape the corner refuses.
    const spies = makeSpies();
    const sink = await mountHook({ isFormulaMode: true }, spies);

    await press(sink, COL_HEADER);

    expect(spies.onUpdatePendingColumnReference).toHaveBeenCalledWith(0, 0);
    expect(spies.onInsertRowRangeReference).not.toHaveBeenCalled();
  });
});

describe("normal mode: the corner is wired to select-all", () => {
  it("a corner press selects A1 through the last cell", async () => {
    const spies = makeSpies();
    const sink = await mountHook({}, spies);

    await press(sink, CORNER);

    expect(spies.onSelectCell).toHaveBeenCalledWith(0, 0, "cells", CONFIG.totalRows - 1, CONFIG.totalCols - 1);
    expect(spies.onInsertRowRangeReference).not.toHaveBeenCalled();
  });

  it("commits a pending edit before it selects", async () => {
    const order: string[] = [];
    const spies = makeSpies();
    spies.onSelectCell.mockImplementation(() => { order.push("select"); });
    const onCommitBeforeSelect = vi.fn(async () => { order.push("commit"); });
    const sink = await mountHook({ onCommitBeforeSelect }, spies);

    await press(sink, CORNER);

    expect(order).toEqual(["commit", "select"]);
  });
});
