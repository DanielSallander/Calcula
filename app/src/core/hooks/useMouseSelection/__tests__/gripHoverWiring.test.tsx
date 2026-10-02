//! FILENAME: app/src/core/hooks/useMouseSelection/__tests__/gripHoverWiring.test.tsx
// PURPOSE: The grip through the REAL hook (BUG-0258 design phase 5):
//            - the hover pass IS Core's hover (core/lib/objectHover.ts): over the
//              body of a `grip: "hover"` region it names that region; moving from
//              the body up onto its grip KEEPS it (and the pointer there is
//              'move'); moving onto a cell, or `handleMouseLeave`, clears it; a
//              pointer arriving at the grip's square from outside finds no grip;
//            - `isOverFloatingOverlay` says yes on a visible grip (so the mouse-down
//              wrapper hands the press to the object before the fill handle and
//              the cell click interceptors);
//            - a double-click on a grip opens no cell editor;
//            - the PRESS order: a Core handle overlapping a grip wins (1.5 before
//              1.6), and a grip over a NEIGHBOUR's body wins the press (1.6 before
//              1.7);
//            - THE REACH on a NARROW object (60 px: its grip beside the left
//              edge) at zoom 0.5 and 1: every move of the straight path from the
//              body to the grip keeps the object hovered, so its hover grip never
//              vanishes before the hand gets there (BUG-0258 M7 review).
// CONTEXT: The overlayZoneHoverWiring.test.tsx harness. The handler functions
//          themselves are pinned in layout/__tests__/overlayGripPress.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";

// The grid state the grip reads its zoom from (null: before mount, zoom 1).
const gridSnap = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
vi.mock("../../../state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../state/GridContext")>()),
  getGridStateSnapshot: () => gridSnap.value,
}));
import { createRoot, type Root } from "react-dom/client";

import { useMouseSelection } from "../useMouseSelection";
import type { UseMouseSelectionProps, UseMouseSelectionReturn } from "../types";
import { DEFAULT_GRID_CONFIG, createEmptyDimensionOverrides, type Viewport } from "../../../types";
import {
  registerGridOverlay,
  unregisterGridOverlay,
  setGridRegions,
  type GridRegion,
} from "../../../../api/gridOverlays";
import {
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
} from "../../../../api/objectSelection";
import { floatingGripOf } from "../../../lib/floatingGrip";
import { getHoveredFloatingRegionId, resetObjectHoverForTests } from "../../../lib/objectHover";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const CONFIG = { ...DEFAULT_GRID_CONFIG };
const RHW = CONFIG.rowHeaderWidth ?? 22;
const CHH = CONFIG.colHeaderHeight ?? 20;
const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 10 };
const TYPE = "grip-hover-test";

function region(id: string, box: { x: number; y: number; width: number; height: number }, data: Record<string, unknown> = {}): GridRegion {
  return { id, type: TYPE, startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: box, data };
}

/** A header-less slicer stand-in: its body is CONTENT with a hand, so 'move' on the grip is the grip's. */
const A = region("a", { x: 100, y: 100, width: 200, height: 150 }, { grip: "hover" });
const BODY_A = { x: RHW + 200, y: CHH + 175 };

function gripCentre(r: GridRegion): { x: number; y: number } {
  const g = floatingGripOf(r, { rowHeaderWidth: RHW, colHeaderHeight: CHH }, { scrollX: 0, scrollY: 0 }, 1, null)!;
  return { x: g.hit.x + g.hit.width / 2, y: g.hit.y + g.hit.height / 2 };
}

type ApiSink = { current: UseMouseSelectionReturn | null };
let root: Root | null = null;
const selected = new Set<string>();
const cleanups: Array<() => void> = [];
let pressed: Array<Record<string, unknown>>;
const onSelected = (e: Event) => pressed.push((e as CustomEvent).detail);

async function mountHook(zoom = 1): Promise<ApiSink> {
  const sink: ApiSink = { current: null };
  function Harness(): React.ReactElement {
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const api = useMouseSelection({
      containerRef,
      scrollRef: { current: null },
      config: CONFIG,
      viewport: VIEWPORT,
      zoom,
      selection: null,
      dimensions: createEmptyDimensionOverrides(),
      onSelectCell: vi.fn(),
      onExtendTo: vi.fn(),
    } as unknown as UseMouseSelectionProps);
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

async function hover(sink: ApiSink, p: { x: number; y: number }): Promise<string> {
  await act(async () => {
    sink.current!.handleMouseMove({ clientX: p.x, clientY: p.y, altKey: false } as unknown as React.MouseEvent<HTMLElement>);
  });
  return sink.current!.cursorStyle;
}

function mouse(p: { x: number; y: number }, button = 0): React.MouseEvent<HTMLElement> {
  return {
    clientX: p.x,
    clientY: p.y,
    button,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: document.createElement("canvas"),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.MouseEvent<HTMLElement>;
}

beforeEach(() => {
  root = null;
  gridSnap.value = null;
  pressed = [];
  selected.clear();
  resetObjectHoverForTests();
  setGridRegions([]);
  registerGridOverlay({
    type: TYPE,
    render: () => {},
    zoneAt: () => ({ kind: "content", cursor: "pointer", part: "item" }),
  });
  cleanups.push(
    registerObjectSelectionProvider({
      types: [TYPE],
      isSelected: (r) => selected.has(r.id),
      select: (r) => {
        selected.clear();
        selected.add(r.id);
      },
      deselectAll: () => selected.clear(),
    }),
  );
  window.addEventListener("floatingObject:selected", onSelected);
});

afterEach(async () => {
  if (root) {
    const toUnmount = root;
    await act(async () => {
      toUnmount.unmount();
    });
    root = null;
  }
  window.removeEventListener("floatingObject:selected", onSelected);
  window.dispatchEvent(new MouseEvent("mouseup"));
  while (cleanups.length) cleanups.pop()!();
  resetObjectSelectionProviders();
  resetObjectHoverForTests();
  unregisterGridOverlay(TYPE);
  setGridRegions([]);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("the hover pass is Core's hover", () => {
  it("over the body of a grip:'hover' region it names that region; up onto its grip it KEEPS it, and the pointer is 'move'", async () => {
    setGridRegions([A]);
    const sink = await mountHook();
    expect(await hover(sink, BODY_A)).toBe("pointer");
    expect(getHoveredFloatingRegionId()).toBe("a");
    // Up onto the grip, just outside the object's top edge.
    expect(await hover(sink, gripCentre(A)), "the grip's pointer").toBe("move");
    expect(getHoveredFloatingRegionId(), "moving from the body onto its grip dropped the hover").toBe("a");
  });

  it("handleMouseLeave clears it (the pointer left the grid area)", async () => {
    setGridRegions([A]);
    const sink = await mountHook();
    await hover(sink, BODY_A);
    expect(getHoveredFloatingRegionId()).toBe("a");
    await act(async () => {
      sink.current!.handleMouseLeave();
    });
    expect(getHoveredFloatingRegionId()).toBeNull();
  });

  it("moving onto a cell clears it", async () => {
    setGridRegions([A]);
    const sink = await mountHook();
    await hover(sink, BODY_A);
    expect(await hover(sink, { x: RHW + 600, y: CHH + 400 })).toBe("cell");
    expect(getHoveredFloatingRegionId()).toBeNull();
  });

  it("a pointer arriving at the grip's square from OUTSIDE the object finds no grip (it shows only once the object is hovered)", async () => {
    setGridRegions([A]);
    const sink = await mountHook();
    await hover(sink, { x: RHW + 600, y: CHH + 400 });
    expect(await hover(sink, gripCentre(A))).toBe("cell");
    expect(getHoveredFloatingRegionId()).toBeNull();
  });

  it("isOverFloatingOverlay is true on a VISIBLE grip (and false there while it is hidden)", async () => {
    setGridRegions([A]);
    const sink = await mountHook();
    const g = gripCentre(A);
    expect(sink.current!.isOverFloatingOverlay(g.x, g.y), "hidden grip").toBe(false);
    await hover(sink, BODY_A);
    expect(sink.current!.isOverFloatingOverlay(g.x, g.y)).toBe(true);
  });

  it("a double-click on a visible grip opens no cell editor (the same point with the grip hidden is a cell)", async () => {
    setGridRegions([A]);
    const sink = await mountHook();
    const g = gripCentre(A);
    expect(sink.current!.handleDoubleClick(mouse(g)), "control: a hidden grip is the cell under it").not.toBeNull();
    await hover(sink, BODY_A);
    expect(sink.current!.handleDoubleClick(mouse(g))).toBeNull();
  });
});

describe("the press order: handles (1.5), then the grip (1.6), then the bodies (1.7)", () => {
  it("a grip over a NEIGHBOUR's body wins the press: the grip's object is pressed, as a frame press on its grip", async () => {
    // B lies over A's grip square (and is published later: on top).
    const B = region("b", { x: 60, y: 40, width: 200, height: 70 });
    setGridRegions([A, B]);
    const sink = await mountHook();
    await hover(sink, BODY_A);
    const g = gripCentre(A);
    expect(await hover(sink, g)).toBe("move");
    await act(async () => {
      await sink.current!.handleMouseDown(mouse(g));
    });
    expect(pressed).toHaveLength(1);
    expect(pressed[0], "the neighbour's body took a press on A's grip").toMatchObject({ regionId: "a", part: "grip", zone: "frame" });
  });

  it("a Core handle overlapping the grip wins (a narrow SELECTED object: its left-hand grip meets its nw handle)", async () => {
    const N = region("n", { x: 100, y: 100, width: 60, height: 100 }, { grip: "hover" });
    setGridRegions([N]);
    selected.add("n");
    const sink = await mountHook();
    // The nw handle's hit square [x-6, x+6] x [y-6, y+6] overlaps the grip
    // [x-24, x) x [y, y+24] (beside the left edge, level with the top).
    const nw = { x: RHW + 100 - 3, y: CHH + 100 + 3 };
    expect(await hover(sink, nw), "the overlap shows the handle's pointer").toBe("nwse-resize");
    await act(async () => {
      await sink.current!.handleMouseDown(mouse(nw));
    });
    expect(sink.current!.isOverlayResizing, "the handle did not win the press").toBe(true);
    expect(pressed.filter((d) => d.part === "grip"), "the grip took a press its handle owns").toEqual([]);
    // ...and a point of the grip clear of the handle is the grip's.
    await act(async () => {
      sink.current!.handleMouseUp();
    });
    const clear = { x: RHW + 100 - 18, y: CHH + 100 + 18 };
    expect(await hover(sink, clear)).toBe("move");
  });
});

describe("THE REACH: a narrow object's hover grip stays shown all the way from its body (BUG-0258 M7 review)", () => {
  // 60 px wide: its grip sits beside the LEFT edge at zoom 1 (under 80) and at
  // zoom 0.5 (under 128). The hand goes straight from the body's centre to
  // the grip's plate, one CLIENT px per move, the way a pointer reports it.
  const N = region("n", { x: 100, y: 100, width: 60, height: 100 }, { grip: "hover" });

  for (const zoom of [0.5, 1]) {
    it(`at zoom ${zoom}: every move from the body to the grip keeps the object hovered, and the grip answers at the end`, async () => {
      gridSnap.value = {
        zoom,
        surface: "grid",
        displayHeadings: true,
        config: CONFIG,
        viewport: VIEWPORT,
        sheetContext: { activeSheetIndex: 0 },
        editing: null,
      };
      setGridRegions([N]);
      const sink = await mountHook(zoom);
      const g = floatingGripOf(N, { rowHeaderWidth: RHW, colHeaderHeight: CHH }, { scrollX: 0, scrollY: 0 }, zoom, null)!;
      expect(g.outsideLeft, "precondition: the grip is beside the left edge").toBe(true);
      // Logical canvas px -> client px (the grid area sits at the client origin here).
      const from = { x: (RHW + 100 + 30) * zoom, y: (CHH + 100 + 50) * zoom };
      const to = { x: (g.plate.x + g.plate.width / 2) * zoom, y: (g.plate.y + g.plate.height / 2) * zoom };
      expect(await hover(sink, from)).toBe("pointer");
      expect(getHoveredFloatingRegionId()).toBe("n");
      const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y));
      const lost: string[] = [];
      for (let i = 1; i <= steps; i++) {
        const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
        await hover(sink, p);
        if (getHoveredFloatingRegionId() !== "n") lost.push(`(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`);
      }
      expect(lost, "moves on the way to the grip that ended the hover (the grip vanished there)").toEqual([]);
      expect(sink.current!.cursorStyle, "the grip's pointer at the end of the path").toBe("move");
      expect(sink.current!.isOverFloatingOverlay(to.x / zoom, to.y / zoom), "the grip is live under the hand").toBe(true);
    });
  }
});
