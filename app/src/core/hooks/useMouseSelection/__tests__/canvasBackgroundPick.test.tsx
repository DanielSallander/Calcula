//! FILENAME: app/src/core/hooks/useMouseSelection/__tests__/canvasBackgroundPick.test.tsx
// PURPOSE: D-PICK: a press on the EMPTY page of a canvas while a formula is
//          picking a reference is inert -- no `floatingObject:backgroundPointerDown`,
//          so no family clears the selection of the object whose formula is
//          being edited (the floating grid's cell editor stays open), and the
//          press is preventDefaulted so the editor keeps its focus.
// CONTEXT: The REAL hook (overlayReleaseOrder.test.tsx's harness); the canvas
//          surface comes from the mocked grid state snapshot.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { DEFAULT_GRID_CONFIG, createEmptyDimensionOverrides, type Viewport } from "../../../types";

const snapshot = vi.hoisted(() => ({
  surface: "canvas" as "grid" | "canvas",
  zoom: 1,
  sheetContext: { activeSheetIndex: 0, activeSheetName: "Canvas1" },
  displayHeadings: false,
}));
vi.mock("../../../state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../state/GridContext")>()),
  getGridStateSnapshot: () => snapshot,
}));

import { useMouseSelection } from "../useMouseSelection";
import type { UseMouseSelectionProps, UseMouseSelectionReturn } from "../types";
import { registerGridReferencePickProbe } from "../../../lib/referencePickState";
import { setGridRegions } from "../../../../api/gridOverlays";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const CONFIG = { ...DEFAULT_GRID_CONFIG };
const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 30, colCount: 10 };

type ApiSink = { current: UseMouseSelectionReturn | null };
let root: Root | null = null;

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
      onSelectCell: vi.fn(),
      onExtendTo: vi.fn(),
      onScroll: vi.fn(),
    } as UseMouseSelectionProps);
    React.useEffect(() => {
      sink.current = api;
    });
    return <div ref={containerRef} data-grid-area="" />;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Harness />);
  });
  return sink;
}

/** A press on the empty page, well clear of the header resize zones. */
function emptyPagePress(): React.MouseEvent<HTMLElement> {
  return {
    clientX: 400,
    clientY: 300,
    button: 0,
    buttons: 1,
    ctrlKey: false,
    shiftKey: false,
    target: document.createElement("canvas"),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.MouseEvent<HTMLElement>;
}

let picking = false;
let backgroundPresses: number;
const onBackground = () => {
  backgroundPresses += 1;
};
const cleanups: Array<() => void> = [];

beforeEach(() => {
  picking = false;
  backgroundPresses = 0;
  snapshot.surface = "canvas";
  setGridRegions([]);
  cleanups.push(registerGridReferencePickProbe(() => picking));
  window.addEventListener("floatingObject:backgroundPointerDown", onBackground);
});

afterEach(async () => {
  if (root) {
    const r = root;
    await act(async () => {
      r.unmount();
    });
    root = null;
  }
  window.removeEventListener("floatingObject:backgroundPointerDown", onBackground);
  while (cleanups.length) cleanups.pop()!();
  document.body.innerHTML = "";
});

describe("the canvas background during a reference pick", () => {
  it("is inert: no background press is announced, and the press keeps the editor's focus", async () => {
    picking = true;
    const sink = await mountHook();
    const ev = emptyPagePress();
    await act(async () => {
      await sink.current!.handleMouseDown(ev);
    });
    expect(backgroundPresses).toBe(0);
    expect(ev.preventDefault).toHaveBeenCalled();
  });

  it("control: with no pick in progress the background press is announced", async () => {
    const sink = await mountHook();
    await act(async () => {
      await sink.current!.handleMouseDown(emptyPagePress());
    });
    expect(backgroundPresses).toBe(1);
  });
});
