//! FILENAME: app/src/core/hooks/useMouseSelection/__tests__/overlayHandleHover.test.tsx
// PURPOSE: The hover pointer over a floating object's resize HANDLE is that
//          handle's own (BUG-0258 design phase 3), reached through the REAL
//          hook's handleMouseMove: 'nesw-resize' over a top-right corner,
//          'nwse-resize' over a top-left one, 'ew-resize' / 'ns-resize' over an
//          edge midpoint -- where the hook used to set 'nwse-resize' for every
//          handle. And an UNSELECTED object shows no resize pointer at all: it
//          has no live handle (core/lib/floatingHandles.ts).
// CONTEXT: The harness of overlayZoneHoverWiring.test.tsx. The resize handlers'
//          own answer (the `cursor` on checkOverlayResizeHandle's hit) is
//          pinned in layout/__tests__/overlayHandles.test.ts; this file pins
//          that the hook USES it.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useMouseSelection } from "../useMouseSelection";
import type { UseMouseSelectionProps, UseMouseSelectionReturn } from "../types";
import { DEFAULT_GRID_CONFIG, createEmptyDimensionOverrides, type Viewport } from "../../../types";
import { setGridRegions, type GridRegion } from "../../../../api/gridOverlays";
import {
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
} from "../../../../api/objectSelection";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const CONFIG = { ...DEFAULT_GRID_CONFIG };
const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 10 };
const TYPE = "handle-hover-test";
const RHW = CONFIG.rowHeaderWidth ?? 50;
const CHH = CONFIG.colHeaderHeight ?? 24;

/** 200 x 150 at sheet (100, 100). */
function region(): GridRegion {
  return {
    id: "obj-1",
    type: TYPE,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 100, y: 100, width: 200, height: 150 },
    data: {},
  };
}
const L = RHW + 100;
const T = CHH + 100;
const R = L + 200;
const B = T + 150;
const MIDDLE = { x: L + 100, y: T + 75 };

type ApiSink = { current: UseMouseSelectionReturn | null };
let root: Root | null = null;
let selected = true;
let unregisterProvider: (() => void) | null = null;

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

beforeEach(() => {
  root = null;
  selected = true;
  unregisterProvider = registerObjectSelectionProvider({
    types: [TYPE],
    isSelected: () => selected,
    select: () => {},
    deselectAll: () => {},
  });
  setGridRegions([region()]);
});

afterEach(async () => {
  if (root) {
    const toUnmount = root;
    await act(async () => {
      toUnmount.unmount();
    });
    root = null;
  }
  unregisterProvider?.();
  unregisterProvider = null;
  resetObjectSelectionProviders();
  setGridRegions([]);
  document.body.innerHTML = "";
});

describe("the hover pointer over a handle is that handle's own", () => {
  it("corners: top-right 'nesw-resize', top-left 'nwse-resize', bottom-left 'nesw-resize', bottom-right 'nwse-resize'", async () => {
    const sink = await mountHook();
    expect(await hover(sink, MIDDLE), "control: the body shows the frame's pointer").toBe("move");
    expect(await hover(sink, { x: R, y: T })).toBe("nesw-resize");
    expect(await hover(sink, { x: L, y: T })).toBe("nwse-resize");
    expect(await hover(sink, { x: L + 2, y: B - 2 })).toBe("nesw-resize");
    expect(await hover(sink, { x: R - 2, y: B + 2 })).toBe("nwse-resize");
  });

  it("edge midpoints: left/right 'ew-resize', top/bottom 'ns-resize'", async () => {
    const sink = await mountHook();
    expect(await hover(sink, { x: R, y: T + 75 })).toBe("ew-resize");
    expect(await hover(sink, { x: L - 3, y: T + 75 })).toBe("ew-resize");
    expect(await hover(sink, { x: L + 100, y: T })).toBe("ns-resize");
    expect(await hover(sink, { x: L + 100, y: B + 4 })).toBe("ns-resize");
  });

  it("an UNSELECTED object shows no resize pointer at its corners: the body's own pointer inside, the cell's outside", async () => {
    selected = false;
    const sink = await mountHook();
    expect(await hover(sink, { x: R - 3, y: T + 3 })).toBe("move");
    expect(await hover(sink, { x: R, y: T + 75 })).toBe("move");
    expect(await hover(sink, { x: R + 4, y: T - 4 })).not.toMatch(/resize/);
  });
});
