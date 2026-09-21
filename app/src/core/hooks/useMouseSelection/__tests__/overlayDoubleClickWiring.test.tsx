//! FILENAME: app/src/core/hooks/useMouseSelection/__tests__/overlayDoubleClickWiring.test.tsx
// PURPOSE: The double-click seam reached through the REAL hook — the branch in
//          `handleDoubleClick` that resolves the floating region under the
//          point and offers the gesture to its owner — together with the three
//          branches BELOW it that must keep working: column auto-fit, row
//          auto-fit, and the ordinary cell double-click that opens the editor.
//
// CONTEXT: overlayDoubleClick.test.ts drives the handler directly, which is the
//          right shape for the handler's own rules but is blind to a missing
//          CALL: delete the `handleOverlayDoubleClick(...)` line in
//          useMouseSelection.ts and every assertion there stays green while the
//          product goes back to swallowing every double-click on an overlay.
//          This file presses on the hook's own return value instead.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useMouseSelection } from "../useMouseSelection";
import type { UseMouseSelectionProps, UseMouseSelectionReturn } from "../types";
import { DEFAULT_GRID_CONFIG, createEmptyDimensionOverrides, type Viewport } from "../../../types";
import {
  registerGridOverlay,
  unregisterGridOverlay,
  setGridRegions,
  type GridRegion,
  type OverlayHitTestContext,
} from "../../../../api/gridOverlays";
import { claimPointer } from "../../../lib/pointerClaims";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const CONFIG = { ...DEFAULT_GRID_CONFIG };
const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 10 };

const REGION: GridRegion = {
  id: "fr-region",
  type: "test-overlay",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: 100, y: 100, width: 200, height: 150 },
  data: { frId: "fr-1" },
};

/**
 * Canvas bounds with the default 22px row gutter / 20px header:
 * [122..322] x [120..270]. (200,200) is inside the overlay body.
 */
const OVER_OVERLAY = { x: 200, y: 200 };
/** A plain cell, well clear of the overlay and of every handle. */
const OVER_CELL = { x: 100, y: 60 };
/** The right edge of column A in the column header (22 + 64.29). */
const COL_HANDLE = { x: 86, y: 10 };
/** The bottom edge of row 1 in the row header (20 + 20). */
const ROW_HANDLE = { x: 10, y: 40 };

type ApiSink = { current: UseMouseSelectionReturn | null };

let root: Root | null = null;

async function mountHook(props: Partial<UseMouseSelectionProps> = {}): Promise<ApiSink> {
  const sink: ApiSink = { current: null };

  function Harness(): React.ReactElement {
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const api = useMouseSelection({
      containerRef,
      scrollRef: { current: null },
      config: CONFIG,
      viewport: VIEWPORT,
      selection: null,
      dimensions: createEmptyDimensionOverrides(),
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

/** The subset of MouseEvent handleDoubleClick actually reads. */
function dblClickAt(
  point: { x: number; y: number },
  target: EventTarget | null = null,
): React.MouseEvent<HTMLElement> {
  return {
    clientX: point.x,
    clientY: point.y,
    button: 0,
    target,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.MouseEvent<HTMLElement>;
}

beforeEach(() => {
  root = null;
  setGridRegions([]);
});

afterEach(async () => {
  if (root) {
    const toUnmount = root;
    await act(async () => {
      toUnmount.unmount();
    });
    root = null;
  }
  unregisterGridOverlay("test-overlay");
  setGridRegions([]);
  document.body.innerHTML = "";
});

describe("a double-click on a floating overlay reaches its owner", () => {
  it("offers the gesture to the overlay that owns the region under the point", async () => {
    const seen: OverlayHitTestContext[] = [];
    registerGridOverlay({
      type: "test-overlay",
      render: () => {},
      onDoubleClick: (ctx) => {
        seen.push(ctx);
        return true;
      },
    });
    setGridRegions([REGION]);

    const sink = await mountHook();
    const result = sink.current!.handleDoubleClick(dblClickAt(OVER_OVERLAY));

    expect(seen).toHaveLength(1);
    expect(seen[0].region.data?.frId).toBe("fr-1");
    expect(seen[0].canvasX).toBe(OVER_OVERLAY.x);
    expect(seen[0].floatingCanvasBounds).toEqual({ x: 122, y: 120, width: 200, height: 150 });
    // Handled: no cell is returned, so no editor opens under the object.
    expect(result).toBeNull();
  });

  it("still opens no cell editor when the owner declines", async () => {
    const onDoubleClick = vi.fn(() => false);
    registerGridOverlay({ type: "test-overlay", render: () => {}, onDoubleClick });
    setGridRegions([REGION]);

    const sink = await mountHook();

    expect(sink.current!.handleDoubleClick(dblClickAt(OVER_OVERLAY))).toBeNull();
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });

  it("preserves today's behaviour for an overlay with no handler", async () => {
    registerGridOverlay({ type: "test-overlay", render: () => {} });
    setGridRegions([REGION]);

    const sink = await mountHook();

    expect(sink.current!.handleDoubleClick(dblClickAt(OVER_OVERLAY))).toBeNull();
  });

  it("short-circuits before the owner when the pointer is claimed", async () => {
    const onDoubleClick = vi.fn(() => true);
    registerGridOverlay({ type: "test-overlay", render: () => {}, onDoubleClick });
    setGridRegions([REGION]);

    const card = document.createElement("div");
    claimPointer(card, "placement-1");
    const field = document.createElement("span");
    card.appendChild(field);
    document.body.appendChild(card);

    const sink = await mountHook();

    expect(sink.current!.handleDoubleClick(dblClickAt(OVER_OVERLAY, field))).toBeNull();
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it("short-circuits before the owner inside an on-canvas editor", async () => {
    const onDoubleClick = vi.fn(() => true);
    registerGridOverlay({ type: "test-overlay", render: () => {}, onDoubleClick });
    setGridRegions([REGION]);

    const editor = document.createElement("textarea");
    document.body.appendChild(editor);

    const sink = await mountHook();

    expect(sink.current!.handleDoubleClick(dblClickAt(OVER_OVERLAY, editor))).toBeNull();
    expect(onDoubleClick).not.toHaveBeenCalled();
  });
});

describe("the branches below the overlay check are untouched", () => {
  it("an ordinary cell double-click still returns the cell to edit", async () => {
    const onDoubleClick = vi.fn(() => true);
    registerGridOverlay({ type: "test-overlay", render: () => {}, onDoubleClick });
    setGridRegions([REGION]);

    const sink = await mountHook();
    const result = sink.current!.handleDoubleClick(dblClickAt(OVER_CELL));

    expect(result).toEqual({ row: 2, col: 1 });
    expect(onDoubleClick).not.toHaveBeenCalled(); // the point is outside the region
  });

  it("a column resize handle still auto-fits the column", async () => {
    const onAutoFitColumn = vi.fn();
    const sink = await mountHook({ onAutoFitColumn });

    expect(sink.current!.handleDoubleClick(dblClickAt(COL_HANDLE))).toBeNull();
    expect(onAutoFitColumn).toHaveBeenCalledWith(0);
  });

  it("a row resize handle still auto-fits the row", async () => {
    const onAutoFitRow = vi.fn();
    const sink = await mountHook({ onAutoFitRow });

    expect(sink.current!.handleDoubleClick(dblClickAt(ROW_HANDLE))).toBeNull();
    expect(onAutoFitRow).toHaveBeenCalledWith(0);
  });
});
