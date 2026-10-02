//! FILENAME: app/src/core/hooks/useMouseSelection/__tests__/overlayZoneHoverWiring.test.tsx
// PURPOSE: The hover pointer over a floating object comes from the SAME zone
//          answer as the press (M5 T2), reached through the REAL hook's
//          handleMouseMove -- so a locked or subscribed object no longer shows
//          a 'move' pointer it will refuse, a content strip shows its own
//          pointer, and a live content gesture owns the pointer over its
//          object.
// CONTEXT: resolveFloatingZone has its own table (src/api/__tests__/
//          gridOverlays.test.ts) and the press has its own
//          (layout/__tests__/overlayZones.test.ts). Both are blind to the
//          hook's hover branch choosing a pointer of its own -- the local
//          `movable === false ? 'pointer' : 'move'` fallback this replaced,
//          which never looked at the lock. This file hovers the hook itself.

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
  holdContentGestureCursor,
  clearContentGestureCursor,
  type GridRegion,
  type OverlayZone,
  type OverlayHitTestContext,
} from "../../../../api/gridOverlays";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "../../../lib/layoutSurface";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const CONFIG = { ...DEFAULT_GRID_CONFIG };
const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 10 };
const TYPE = "zone-hover-test";

/** Canvas bounds [122..322] x [120..270]. */
function region(data: Record<string, unknown> = {}): GridRegion {
  return {
    id: "obj-1",
    type: TYPE,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 100, y: 100, width: 200, height: 150 },
    data,
  };
}
/** The left half is a content strip; the right half is frame. */
const CONTENT = { x: 160, y: 195 };
const FRAME = { x: 280, y: 195 };
const leftHalf = (ctx: OverlayHitTestContext): OverlayZone | null =>
  ctx.canvasX < (ctx.floatingCanvasBounds?.x ?? 0) + 100
    ? { kind: "content", cursor: "crosshair", part: "strip" }
    : null;

type ApiSink = { current: UseMouseSelectionReturn | null };
let root: Root | null = null;
let unregisterSurface: (() => void) | null = null;

async function mountHook(): Promise<ApiSink> {
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
    } as UseMouseSelectionProps);
    React.useEffect(() => {
      sink.current = api;
    });
    return <div ref={containerRef} />;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Harness />);
  });
  return sink;
}

/** Hover the hook at `point`; the pointer it settled on. */
async function hover(sink: ApiSink, point: { x: number; y: number }): Promise<string> {
  await act(async () => {
    sink.current!.handleMouseMove({
      clientX: point.x,
      clientY: point.y,
      altKey: false,
    } as unknown as React.MouseEvent<HTMLElement>);
  });
  return sink.current!.cursorStyle;
}

/** No grid is mounted, so the active sheet is 0. */
function useSurface(s: Partial<LayoutSurface>): void {
  const surface: LayoutSurface = {
    snapToGrid: false,
    gridSize: 25,
    showGrid: false,
    page: { width: 1280, height: 720 },
    editable: true,
    ...s,
  };
  unregisterSurface = registerLayoutSurfaceProvider({ get: (i) => (i === 0 ? surface : null) });
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
  unregisterSurface?.();
  unregisterSurface = null;
  clearContentGestureCursor();
  unregisterGridOverlay(TYPE);
  setGridRegions([]);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("the hover pointer is the zone's (a zoneAt family)", () => {
  it("over a content strip: the content's own pointer", async () => {
    registerGridOverlay({ type: TYPE, render: () => {}, zoneAt: leftHalf });
    setGridRegions([region()]);
    useSurface({});
    const sink = await mountHook();
    expect(await hover(sink, CONTENT)).toBe("crosshair");
  });

  it("over an unlocked frame: 'move'", async () => {
    registerGridOverlay({ type: TYPE, render: () => {}, zoneAt: leftHalf });
    setGridRegions([region()]);
    useSurface({});
    const sink = await mountHook();
    expect(await hover(sink, FRAME)).toBe("move");
  });

  it("over a LOCKED frame: 'default' -- never a move the press would refuse", async () => {
    registerGridOverlay({ type: TYPE, render: () => {}, zoneAt: leftHalf });
    setGridRegions([region()]);
    useSurface({ isLocked: () => true });
    const sink = await mountHook();
    // The content still works on a locked object, and says so...
    expect(await hover(sink, CONTENT)).toBe("crosshair");
    // ...and the frame, hovered AFTER it (the hook starts at 'default', so
    // this row would pass vacuously first), refuses to promise a move.
    expect(await hover(sink, FRAME)).toBe("default");
  });

  it("over a SUBSCRIBED page's frame (consume mode): 'default'", async () => {
    registerGridOverlay({ type: TYPE, render: () => {}, zoneAt: leftHalf });
    setGridRegions([region()]);
    useSurface({ editable: false });
    const sink = await mountHook();
    expect(await hover(sink, CONTENT)).toBe("crosshair");
    expect(await hover(sink, FRAME)).toBe("default");
  });

  it("a held content-gesture pointer owns the pointer over its object, in any zone", async () => {
    registerGridOverlay({ type: TYPE, render: () => {}, zoneAt: leftHalf });
    setGridRegions([region()]);
    useSurface({});
    const sink = await mountHook();
    const release = holdContentGestureCursor("obj-1", "ew-resize");
    expect(await hover(sink, FRAME)).toBe("ew-resize");
    expect(await hover(sink, CONTENT)).toBe("ew-resize");
    release();
    expect(await hover(sink, FRAME)).toBe("move");
  });
});

describe("a registration WITHOUT zoneAt is all frame (M5 T6: the legacy fallback is gone)", () => {
  it("'move' where it can move; 'default' where it is published movable: false -- never the old 'pointer'", async () => {
    registerGridOverlay({ type: TYPE, render: () => {} });
    setGridRegions([region()]);
    const sink = await mountHook();
    expect(await hover(sink, FRAME)).toBe("move");
    setGridRegions([region({ movable: false })]);
    // Hovered AFTER 'move', so a 'default' here is the answer, not the start.
    expect(await hover(sink, FRAME)).toBe("default");
  });

  it("a leftover cell-cursor callback on a FLOATING registration is never asked", async () => {
    const getCellCursor = vi.fn(() => "wait");
    registerGridOverlay({ type: TYPE, render: () => {}, getCellCursor });
    setGridRegions([region()]);
    const sink = await mountHook();
    expect(await hover(sink, FRAME)).toBe("move");
    expect(getCellCursor).not.toHaveBeenCalled();
  });
});

describe("a CELL-ANCHORED region's pointer is its getCellCursor answer", () => {
  /** Rows 1..4, cols 1..2 (B2:C5); no floating box. */
  const CELL_REGION: GridRegion = { id: "cells-1", type: TYPE, startRow: 1, startCol: 1, endRow: 4, endCol: 2 };
  /** B3: col 1 starts at 22 + 64.29, row 2 at 20 + 40. */
  const IN_B3 = { x: 22 + 64.29 + 20, y: 20 + 40 + 10 };
  /** A1: outside the region. */
  const IN_A1 = { x: 22 + 20, y: 20 + 10 };

  it("over one of its cells: the callback's pointer, asked with that cell; elsewhere the grid's own", async () => {
    const getCellCursor = vi.fn(() => "pointer");
    registerGridOverlay({ type: TYPE, render: () => {}, getCellCursor });
    setGridRegions([CELL_REGION]);
    const sink = await mountHook();
    expect(await hover(sink, IN_B3)).toBe("pointer");
    expect(getCellCursor).toHaveBeenCalledWith(expect.objectContaining({ row: 2, col: 1 }));
    expect(await hover(sink, IN_A1)).toBe("cell");
  });

  it("a null answer leaves the grid's own cell pointer", async () => {
    registerGridOverlay({ type: TYPE, render: () => {}, getCellCursor: () => null });
    setGridRegions([CELL_REGION]);
    const sink = await mountHook();
    expect(await hover(sink, IN_B3)).toBe("cell");
  });
});
