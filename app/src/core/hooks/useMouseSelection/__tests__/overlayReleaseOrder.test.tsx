//! FILENAME: app/src/core/hooks/useMouseSelection/__tests__/overlayReleaseOrder.test.tsx
// PURPOSE: Core ends a floating object's MOVE before any family hears the
//          release -- wherever the release lands (M5 T1, the release-order
//          defect found while designing BUG-0258's phase 2).
//
// THE DEFECT. A family that binds a bubble-phase window mouseup during the
//          press (the timeline binds one from its floatingObject:selected
//          handler; the Slicer's and the chart's are bound for the life of the
//          extension) sits BEFORE Core's own window mouseup: Core re-binds that
//          one from a useEffect once `isOverlayMoving` commits, i.e. after the
//          press. A release inside [data-grid-area] was fine -- React's
//          onMouseUp ends the move before any window bubble listener runs --
//          but a release over the ribbon, the formula bar, the sheet tabs or a
//          task pane reached the family FIRST. The family took its pending
//          click and dropped its multi-move snapshot, so the moveComplete that
//          followed saved only the lead; the co-moved objects snapped back at
//          the next refresh.
//
// THE FIX. Core binds a CAPTURE-phase window mouseup when it arms a move.
//          Window capture runs before React's root dispatch and before every
//          bubble listener, so moveComplete precedes the families' mouseups on
//          every release -- exactly today's in-grid order.
//
// CONTEXT: The REAL hook (overlayDoubleClickWiring.test.tsx's harness: a
//          createRoot, act, and the hook's own returned handlers). The family
//          is a double with the timeline's shape: its floatingObject:selected
//          listener binds a bubble window mouseup for that press only.

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
  type OverlayRegistration,
} from "../../../../api/gridOverlays";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const CONFIG = { ...DEFAULT_GRID_CONFIG };
const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 10 };
const TYPE = "release-order-test";

/** Canvas bounds [122..322] x [120..270] (22px row gutter, 20px header). */
const REGION: GridRegion = {
  id: "obj-1",
  type: TYPE,
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: 100, y: 100, width: 200, height: 150 },
  data: { objId: "o-1" },
};
/** The middle of the body: clear of every corner handle. */
const BODY = { x: 220, y: 195 };

type ApiSink = { current: UseMouseSelectionReturn | null };

let root: Root | null = null;
let gridEl: HTMLDivElement | null = null;

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
    } as UseMouseSelectionProps);
    React.useEffect(() => {
      sink.current = api;
    });
    // The grid area's own onMouseUp, as Spreadsheet.tsx wires it: an in-grid
    // release reaches the hook through React's root dispatch.
    return (
      <div
        ref={(el) => {
          containerRef.current = el;
          gridEl = el;
        }}
        data-grid-area=""
        onMouseUp={() => api.handleMouseUp()}
      />
    );
  }

  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Harness />);
  });
  return sink;
}

/** The subset of MouseEvent handleMouseDown reads. */
function pressAt(point: { x: number; y: number }): React.MouseEvent<HTMLElement> {
  return {
    clientX: point.x,
    clientY: point.y,
    button: 0,
    ctrlKey: false,
    shiftKey: false,
    target: document.createElement("canvas"),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.MouseEvent<HTMLElement>;
}

let order: string[];
const onMoveComplete = () => order.push("moveComplete");

/** The family double: the timeline's shape -- a press-scoped bubble mouseup. */
const familyUp = () => {
  window.removeEventListener("mouseup", familyUp);
  order.push("familyUp");
};
const onSelected = (e: Event) => {
  if ((e as CustomEvent<{ regionType?: string }>).detail?.regionType !== TYPE) return;
  window.addEventListener("mouseup", familyUp);
};

/** Capture-phase window mouseup listeners currently bound (Core's release). */
const liveCaptureUps = new Set<EventListenerOrEventListenerObject>();
function isCapture(options: boolean | AddEventListenerOptions | EventListenerOptions | undefined): boolean {
  return options === true || (typeof options === "object" && options !== null && options.capture === true);
}

function register(extra: Partial<OverlayRegistration> = {}): void {
  registerGridOverlay({ type: TYPE, render: () => {}, ...extra });
}

beforeEach(() => {
  root = null;
  gridEl = null;
  order = [];
  liveCaptureUps.clear();
  // The environment's own (bound) methods, taken before the spies replace them.
  const add = window.addEventListener;
  const remove = window.removeEventListener;
  const spyAdd = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void => {
    if (type === "mouseup" && isCapture(options)) liveCaptureUps.add(listener);
    add(type, listener, options);
  };
  const spyRemove = (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void => {
    if (type === "mouseup" && isCapture(options)) liveCaptureUps.delete(listener);
    remove(type, listener, options);
  };
  vi.spyOn(window, "addEventListener").mockImplementation(spyAdd as typeof window.addEventListener);
  vi.spyOn(window, "removeEventListener").mockImplementation(spyRemove as typeof window.removeEventListener);
  window.addEventListener("floatingObject:moveComplete", onMoveComplete);
  window.addEventListener("floatingObject:selected", onSelected);
  setGridRegions([REGION]);
});

afterEach(async () => {
  if (root) {
    const toUnmount = root;
    await act(async () => {
      toUnmount.unmount();
    });
    root = null;
  }
  window.removeEventListener("floatingObject:moveComplete", onMoveComplete);
  window.removeEventListener("floatingObject:selected", onSelected);
  window.removeEventListener("mouseup", familyUp);
  vi.restoreAllMocks();
  unregisterGridOverlay(TYPE);
  setGridRegions([]);
  document.body.innerHTML = "";
});

/** Press on the body and drag 40px, so `isOverlayMoving` has committed. */
async function pressAndDrag(sink: ApiSink): Promise<void> {
  await act(async () => {
    await sink.current!.handleMouseDown(pressAt(BODY));
  });
  await act(async () => {
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: BODY.x + 40, clientY: BODY.y, buttons: 1 }));
  });
}

/** A release over something that is not the grid area (the ribbon). */
async function releaseOutside(): Promise<void> {
  const ribbon = document.createElement("div");
  document.body.appendChild(ribbon);
  await act(async () => {
    ribbon.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
}

/** A release over the grid area: React's onMouseUp, then the window. */
async function releaseInGrid(): Promise<void> {
  await act(async () => {
    gridEl!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
}

describe("Core ends a frame move before any family hears the release", () => {
  it("a release OUTSIDE the grid area: moveComplete first, then the family's mouseup", async () => {
    register();
    const sink = await mountHook();
    await pressAndDrag(sink);
    await releaseOutside();

    // Before the fix: ['familyUp', 'moveComplete'] -- the family dropped its
    // multi-move snapshot before Core said where the lead had gone.
    expect(order).toEqual(["moveComplete", "familyUp"]);
  });

  it("control: a release INSIDE the grid area gives the same order", async () => {
    register();
    const sink = await mountHook();
    await pressAndDrag(sink);
    await releaseInGrid();

    expect(order).toEqual(["moveComplete", "familyUp"]);
  });

  it("the release listener lives exactly as long as the move, and a later mouseup ends nothing", async () => {
    register();
    const sink = await mountHook();
    expect(liveCaptureUps.size).toBe(0);

    await pressAndDrag(sink);
    // Bound by the press that armed the move...
    expect(liveCaptureUps.size).toBe(1);

    await releaseOutside();
    // ...and gone at its release.
    expect(liveCaptureUps.size).toBe(0);
    expect(order.filter((t) => t === "moveComplete")).toHaveLength(1);

    order = [];
    await releaseOutside();
    await releaseInGrid();
    expect(order).toEqual([]);
    expect(sink.current!.isOverlayMoving).toBe(false);
  });

  it("a zoneAt family: its FRAME move ends at the release the same way; a CONTENT press arms nothing", async () => {
    // The left 60px are content; the rest (where BODY is) frame.
    register({
      zoneAt: (ctx) =>
        ctx.canvasX < (ctx.floatingCanvasBounds?.x ?? 0) + 60 ? { kind: "content", cursor: "pointer" } : null,
    });
    const sink = await mountHook();
    await pressAndDrag(sink);
    expect(liveCaptureUps.size).toBe(1);
    await releaseOutside();
    expect(order).toEqual(["moveComplete", "familyUp"]);
    expect(liveCaptureUps.size).toBe(0);

    order = [];
    await act(async () => {
      await sink.current!.handleMouseDown(pressAt({ x: 140, y: BODY.y }));
    });
    expect(liveCaptureUps.size).toBe(0);
    expect(sink.current!.isOverlayMoving).toBe(false);
    await releaseOutside();
    expect(order).toEqual(["familyUp"]);
  });

  it("a release that never came is dropped at the next armed press, never doubled", async () => {
    register();
    const sink = await mountHook();

    // First gesture: the button goes up outside the window (no mouseup).
    await pressAndDrag(sink);
    expect(liveCaptureUps.size).toBe(1);

    // Second gesture: Core arms a new move; still exactly one listener.
    await act(async () => {
      await sink.current!.handleMouseDown(pressAt(BODY));
    });
    expect(liveCaptureUps.size).toBe(1);

    await releaseOutside();
    expect(liveCaptureUps.size).toBe(0);
  });
});
