//! FILENAME: app/src/core/components/Scrollbar/__tests__/wheelScrollExtent.test.tsx
// PURPOSE: The wheel may scroll the WHOLE sheet; the thumb's extent is the
//          used range. Found live 2026-09-29 (e2e fixall-edit K4): the wheel
//          clamped to the thumb's extent -- the used range plus a buffer, grown
//          to "where you are plus one viewport" -- so past the used range each
//          notch advanced about one row, and forty notches reached 818 px.
//          A canvas page stays page-bounded for both.

import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../../lib/tauri-api", () => ({ getGridBounds: vi.fn(async () => [1, 1]) }));

import { useScrollbarMetrics, type ScrollbarMetrics } from "../useScrollbarMetrics";
import { DEFAULT_GRID_CONFIG } from "../../../types";
import type { Viewport } from "../../../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 40, colCount: 15 } as Viewport;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function measure(page: { width: number; height: number } | null, scrollY = 0): ScrollbarMetrics {
  let out: ScrollbarMetrics | null = null;
  function Probe(): null {
    out = useScrollbarMetrics({
      config: DEFAULT_GRID_CONFIG,
      viewport: { ...viewport, scrollY },
      viewportDimensions: { width: 1200, height: 800 },
      dimensions: { columnWidths: new Map(), rowHeights: new Map() },
      page,
    });
    return null;
  }
  host = document.createElement("div");
  root = createRoot(host);
  act(() => root!.render(<Probe />));
  return out!;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host = null;
});

describe("the wheel's scroll extent", () => {
  it("on an empty worksheet the thumb extent is about one viewport, the wheel's the whole sheet", () => {
    const m = measure(null);
    expect(m.maxScrollY, "precondition: the thumb extent is the used range plus a viewport").toBeLessThan(200);
    const sheetBottom = DEFAULT_GRID_CONFIG.totalRows * DEFAULT_GRID_CONFIG.defaultCellHeight;
    expect(m.wheelMaxScrollY, "the wheel is held to the thumb's extent: one row per notch past the used range").toBeGreaterThan(sheetBottom - 2000);
    expect(m.wheelMaxScrollX).toBeGreaterThan(m.maxScrollX);
  });

  it("the wheel extent is never SMALLER than the thumb's", () => {
    const m = measure(null, 5000);
    expect(m.wheelMaxScrollY).toBeGreaterThanOrEqual(m.maxScrollY);
  });

  it("a canvas page bounds the wheel exactly as it bounds the thumb", () => {
    const m = measure({ width: 1280, height: 720 });
    expect(m.wheelMaxScrollY).toBe(m.maxScrollY);
    expect(m.wheelMaxScrollX).toBe(m.maxScrollX);
  });
});

describe("the wheel handler", () => {
  it("clamps to the WHEEL extent, never the thumb's", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../Spreadsheet/Spreadsheet.tsx"), "utf8");
    const at = src.indexOf("const handleWheel = useCallback(");
    expect(at, "the wheel handler moved").toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("\n  );\n", at));
    expect(body).toContain("scrollbarMetrics.wheelMaxScrollY");
    expect(body).toContain("scrollbarMetrics.wheelMaxScrollX");
    expect(body, "the wheel clamps to the thumb extent again").not.toMatch(/scrollbarMetrics\.maxScroll[XY]/);
  });
});
