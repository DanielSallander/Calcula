//! FILENAME: app/src/core/lib/gridRenderer/canvasSurface.test.ts
// PURPOSE: The renderer's CANVAS pass, through the real `renderGrid`. A canvas
//          sheet keeps a real engine grid that can hold cells (a canvas pivot
//          materializes there), so the cell passes must be SKIPPED, not merely
//          left with nothing to draw -- and the object passes must still run,
//          or a canvas would be blank.
// CONTEXT: A recording 2D context stands in for the canvas; the assertions are
//          about WHICH passes ran, compared against the same frame on a
//          worksheet surface (the positive control for every "did not paint").

import { describe, it, expect, afterEach } from "vitest";
import { renderGrid } from "./core";
import { DEFAULT_THEME } from "./types";
import { registerGridLayer, type GridLayerAnchor } from "../../../api/gridLayers";
import {
  DEFAULT_GRID_CONFIG,
  createDefaultStyleCache,
  cellKey,
  type CellData,
  type CellDataMap,
  type GridConfig,
  type Viewport,
} from "../../types";
import type { GridRegion, OverlayRegistration } from "./core";

const W = 400;
const H = 240;

function recordingCtx() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const state: Record<string | symbol, unknown> = {
    canvas: { width: W, height: H },
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    font: "11px Calibri",
    textAlign: "left",
    textBaseline: "alphabetic",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    lineCap: "butt",
    lineJoin: "miter",
    imageSmoothingEnabled: true,
    shadowBlur: 0,
    shadowColor: "transparent",
    direction: "ltr",
  };
  const ctx = new Proxy(state, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === "measureText") {
        return (s: string) => ({ width: String(s).length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
      }
      if (prop === "createLinearGradient" || prop === "createRadialGradient" || prop === "createPattern") {
        return () => ({ addColorStop() {} });
      }
      if (prop === "getLineDash") return () => [];
      if (prop === "getTransform") return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      return (...args: unknown[]) => {
        calls.push({ name: String(prop), args });
      };
    },
    set(t, prop, v) {
      t[prop] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const CONFIG: GridConfig = { ...DEFAULT_GRID_CONFIG, defaultCellWidth: 64, defaultCellHeight: 20, totalRows: 100, totalCols: 26 };
const VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, startRow: 0, startCol: 0, rowCount: 12, colCount: 6 };

/** A cell with text: stands in for a canvas pivot's hidden output. */
function cells(): CellDataMap {
  const m: CellDataMap = new Map();
  m.set(cellKey(1, 1), { row: 1, col: 1, value: "HIDDEN", display: "HIDDEN", styleIndex: 0 } as CellData);
  return m;
}

const FLOATING: GridRegion = {
  id: "chart-1",
  type: "chart",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: 20, y: 20, width: 120, height: 80 },
};
const CELL_ANCHORED: GridRegion = { id: "table-1", type: "table", startRow: 2, startCol: 2, endRow: 4, endCol: 4 };

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

interface FrameOptions {
  selection?: boolean;
  clipboard?: boolean;
  pageLayout?: boolean;
}

const PAGE_SETUP = {
  marginTop: 20, marginBottom: 20, marginLeft: 20, marginRight: 20,
  paperWidth: 300, paperHeight: 200, header: "HEADER", footer: "FOOTER",
};

function frame(surface: "grid" | "canvas", opts: FrameOptions = { selection: true }) {
  const layersRun: GridLayerAnchor[] = [];
  for (const anchor of ["under-cells", "under-selection", "over-selection", "over-headers"] as GridLayerAnchor[]) {
    cleanups.push(registerGridLayer({ id: `probe-${anchor}`, anchor, paint: () => layersRun.push(anchor) }));
  }
  const rendered: string[] = [];
  const renderers: OverlayRegistration[] = [
    { type: "chart", render: (c) => rendered.push(c.region.id) },
    { type: "table", render: (c) => rendered.push(c.region.id) },
  ] as OverlayRegistration[];
  const { ctx, calls } = recordingCtx();
  const cell = { startRow: 2, startCol: 2, endRow: 3, endCol: 3, type: "cells" as const };
  renderGrid(
    ctx, W, H, CONFIG, VIEWPORT,
    opts.selection ? { startRow: 1, startCol: 1, endRow: 1, endCol: 1, type: "cells" } : null,
    null, cells(), DEFAULT_THEME, [],
    { columnWidths: new Map(), rowHeights: new Map() },
    createDefaultStyleCache(),
    null, null, undefined,
    opts.clipboard ? cell : null, opts.clipboard ? "copy" : undefined, 0,
    null, undefined,
    [FLOATING, CELL_ANCHORED], renderers,
    "Sheet1", [], [], undefined, undefined,
    opts.pageLayout ? "pageLayout" : undefined, opts.pageLayout ? PAGE_SETUP : undefined,
    false, true, true, true, "A1",
    surface,
  );
  const texts = calls.filter((c) => c.name === "fillText").map((c) => String(c.args[0]));
  const writes = calls.length;
  // Every draw call, serialised: two frames are "the same picture" when these
  // are equal.
  const trace = JSON.stringify(calls.map((c) => [c.name, c.args]));
  cleanups.splice(0).forEach((f) => f());
  return { layersRun, rendered, texts, writes, trace };
}

describe("renderGrid on a CANVAS surface", () => {
  it("POSITIVE CONTROL: the same frame on a worksheet paints the cell text and headers", () => {
    const g = frame("grid");
    expect(g.texts).toContain("HIDDEN");
    expect(g.texts).toContain("A");
    expect(g.rendered).toEqual(expect.arrayContaining(["chart-1", "table-1"]));
  });

  it("skips the cell pass: a hidden cell's text never paints", () => {
    expect(frame("canvas").texts).not.toContain("HIDDEN");
  });

  it("paints no headers (no column letters, no row numbers)", () => {
    const texts = frame("canvas").texts;
    expect(texts).not.toContain("A");
    expect(texts).not.toContain("1");
  });

  it("still runs every grid-layer anchor (the page painter lives on one)", () => {
    expect(new Set(frame("canvas").layersRun)).toEqual(
      new Set(["under-cells", "under-selection", "over-selection", "over-headers"]),
    );
  });

  it("paints FLOATING objects and drops cell-anchored regions", () => {
    const rendered = frame("canvas").rendered;
    expect(rendered).toContain("chart-1");
    expect(rendered).not.toContain("table-1");
  });

  // Each chrome below CHANGES a worksheet frame (the positive control) and
  // leaves a canvas frame IDENTICAL to one without it.
  it.each([
    ["the selection", { selection: true }],
    ["the clipboard marquee", { clipboard: true }],
    ["the page-layout view", { pageLayout: true }],
  ] as const)("%s never paints on a canvas", (_label, opts) => {
    const plain: FrameOptions = {};
    expect(frame("grid", opts).trace, "positive control: it paints on a worksheet").not.toBe(frame("grid", plain).trace);
    expect(frame("canvas", opts).trace).toBe(frame("canvas", plain).trace);
  });
});
