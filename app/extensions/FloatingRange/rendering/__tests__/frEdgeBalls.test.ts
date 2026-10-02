//! FILENAME: app/extensions/FloatingRange/rendering/__tests__/frEdgeBalls.test.ts
// PURPOSE: The floating grid's yellow EDGE BALLS (they scale the CELLS) after
//          BUG-0258 design phase 3. Core now paints every selected object's
//          outline and corner handles AFTER every object; a ball painted in the
//          range's own overlay pass would have that outline drawn across it,
//          so the balls moved into a grid layer at "over-selection"
//          (`paintFrEdgeBalls`), which runs after Core's chrome. Pinned here:
//            - a selected range with live handles gets exactly the balls
//              `frEdgeHandles` offers, at the frame's own canvas position;
//            - an unselected range, or one whose handles are not live, none;
//            - a ball whose centre lies under an object stacked above the
//              range is NOT painted (it is not grabbable there either: the ball
//              is the range's own content zone, reached only where the range is
//              on top) -- the others still are;
//            - the range's overlay pass paints NO ball and NO selection chrome
//              any more;
//            - the extension registers the layer.
// CONTEXT: The frRendererScroll.test.ts set-up (store, mocks); a context
//          double that records arc centres and the fill colour.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FloatingRangeInfo } from "@api/floatingRanges";

vi.mock("@api/floatingRanges", () => ({
  FLOATING_RANGE_MAX_ROWS: 1000,
  FLOATING_RANGE_MAX_COLS: 256,
  listFloatingRanges: vi.fn(async () => []),
  updateFloatingRange: vi.fn(async () => ({})),
  getFloatingRangeCells: vi.fn(async () => []),
}));
vi.mock("@api/lib", () => ({
  getUsedRange: vi.fn(async () => ({ startRow: 0, startCol: 0, endRow: 0, endCol: 0, empty: true })),
}));
vi.mock("../../editor/frEditor", () => ({
  layoutFrEditorForFrame: vi.fn(),
  getFrEditorCell: () => null,
}));

import type { GridLayerContext } from "@api";
import type { GridRegion, OverlayRenderContext } from "@api/gridOverlays";
import { paintFrEdgeBalls, renderFloatingRange, resetFrRenderCaches, FR_EDGE_BALL_LAYER_ID } from "../frRenderer";
import {
  upsertFromInfo,
  resetFloatingRangeStore,
  getFloatingRangeById,
  FLOATING_RANGE_REGION_TYPE,
} from "../../lib/floatingRangeStore";
import { frEdgeHandles, frameWidth, frameHeight } from "../../lib/frDimensions";
import { selectFloatingRange, resetFrSelection, isFloatingRangeSelected } from "../../lib/frSelection";
import {
  registerObjectSelectionProvider,
  resetObjectSelectionProviders,
  setObjectSelectionSet,
} from "@api/objectSelection";

const FR_ID = "fr-balls";
const FRAME_X = 100;
const FRAME_Y = 60;
const BALL_FILL = "#f2c744";

function info(): FloatingRangeInfo {
  return {
    id: FR_ID,
    backingSheetId: "backing",
    hostSheetId: "host",
    x: FRAME_X,
    y: FRAME_Y,
    rotation: 0,
    pinToGrid: false,
    rowCount: 6,
    colCount: 4,
    colWidths: {},
    rowHeights: {},
    showTitle: true,
    showColumnHeaders: true,
    showRowHeaders: true,
    name: "Float1",
    backingSheetIndex: 2,
    hostSheetIndex: 0,
  } as FloatingRangeInfo;
}

function frRegion(data: Record<string, unknown> = { resizable: true }): GridRegion {
  const e = getFloatingRangeById(FR_ID)!;
  return {
    id: `fr-${FR_ID}`,
    type: FLOATING_RANGE_REGION_TYPE,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: FRAME_X, y: FRAME_Y, width: frameWidth(e), height: frameHeight(e) },
    data: { frId: FR_ID, handles: "corners", ...data },
  };
}

type Arc = { x: number; y: number; fill: string };

/** A context double recording each filled arc's centre and colour, and every strokeRect. */
function ballCtx() {
  const arcs: Arc[] = [];
  const strokes: Array<{ args: number[]; style: string }> = [];
  let pending: { x: number; y: number } | null = null;
  const state: Record<string, unknown> = { fillStyle: "", strokeStyle: "", lineWidth: 1 };
  const ctx = new Proxy(state, {
    get(t, prop) {
      if (prop in t) return t[prop as string];
      if (prop === "arc") return (x: number, y: number) => {
        pending = { x, y };
      };
      if (prop === "beginPath") return () => {
        pending = null;
      };
      if (prop === "fill") return () => {
        if (pending) arcs.push({ ...pending, fill: String(t.fillStyle) });
      };
      if (prop === "strokeRect") return (...a: number[]) => strokes.push({ args: a, style: String(t.strokeStyle) });
      if (prop === "measureText") return (s: string) => ({ width: String(s).length * 6 });
      return () => {};
    },
    set(t, prop, v) {
      t[prop as string] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, arcs, strokes };
}

function layerContext(ctx: CanvasRenderingContext2D): GridLayerContext {
  return {
    ctx,
    config: { rowHeaderWidth: 0, colHeaderHeight: 0 },
    viewport: { scrollX: 0, scrollY: 0 },
    dimensions: {},
    canvasWidth: 2000,
    canvasHeight: 2000,
    freezeConfig: null,
  } as unknown as GridLayerContext;
}

/** Where `frEdgeHandles` says the balls are, on this canvas (gutters 0, no scroll). */
function expectedBalls(): Array<{ x: number; y: number }> {
  return frEdgeHandles(getFloatingRangeById(FR_ID)!).map((h) => ({ x: FRAME_X + h.x, y: FRAME_Y + h.y }));
}

beforeEach(() => {
  resetFloatingRangeStore();
  resetFrRenderCaches();
  resetFrSelection();
  upsertFromInfo(info());
});

afterEach(() => {
  resetFrSelection();
  resetFloatingRangeStore();
});

describe("the yellow edge balls paint in a layer above Core's selection chrome", () => {
  it("a SELECTED range with live handles gets exactly the balls frEdgeHandles offers, where the frame is", () => {
    selectFloatingRange(FR_ID);
    const rec = ballCtx();
    paintFrEdgeBalls(layerContext(rec.ctx), [frRegion()]);
    const want = expectedBalls();
    expect(want.length, "precondition: the frame offers balls").toBe(4);
    expect(rec.arcs.map(({ x, y }) => ({ x, y }))).toEqual(want);
    expect(new Set(rec.arcs.map((a) => a.fill))).toEqual(new Set([BALL_FILL]));
  });

  it("an UNSELECTED range, or one whose handles are not live, gets none", () => {
    const off = ballCtx();
    paintFrEdgeBalls(layerContext(off.ctx), [frRegion()]);
    expect(off.arcs, "unselected").toEqual([]);

    selectFloatingRange(FR_ID);
    const frozen = ballCtx();
    paintFrEdgeBalls(layerContext(frozen.ctx), [frRegion({ resizable: false })]);
    expect(frozen.arcs, "resizable: false (a locked range, a subscribed page)").toEqual([]);
  });

  it("a range the canvas selection SET holds (a second grid of a multi-selection) gets its balls too -- the zone that grabs them already answers there", () => {
    // frZoneAt's edge zone and the extended hit area gate on `frHandlesLive`
    // (the published `resizable`, which a set-held range now carries); a
    // painter asking the FAMILY's selection alone left those balls grabbable
    // and unpainted.
    const off = registerObjectSelectionProvider({
      types: [FLOATING_RANGE_REGION_TYPE],
      isSelected: (r) => isFloatingRangeSelected(r.data?.frId as string),
      select: (r) => selectFloatingRange(r.data?.frId as string),
      deselectAll: () => resetFrSelection(),
    });
    try {
      const other: GridRegion = {
        ...frRegion(),
        id: "fr-other",
        floating: { x: 900, y: 900, width: 60, height: 60 },
        data: { frId: "other", handles: "corners", resizable: true },
      };
      setObjectSelectionSet([other, frRegion()], other);
      expect(isFloatingRangeSelected(FR_ID), "precondition: the SET holds it, not the family").toBe(false);
      const rec = ballCtx();
      paintFrEdgeBalls(layerContext(rec.ctx), [frRegion()]);
      expect(rec.arcs.map(({ x, y }) => ({ x, y }))).toEqual(expectedBalls());
    } finally {
      off();
      resetObjectSelectionProviders();
    }
  });

  it("a ball whose centre lies under an object stacked above the range is not painted; the others are", () => {
    selectFloatingRange(FR_ID);
    const e = getFloatingRangeById(FR_ID)!;
    const right = { x: FRAME_X + frameWidth(e), y: FRAME_Y + frameHeight(e) / 2 };
    // A chart published AFTER the range (so on top without z) over the right ball only.
    const cover: GridRegion = {
      id: "chart-over",
      type: "chart",
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
      floating: { x: right.x - 10, y: right.y - 10, width: 60, height: 20 },
      data: {},
    };
    const rec = ballCtx();
    paintFrEdgeBalls(layerContext(rec.ctx), [frRegion(), cover]);
    const painted = rec.arcs.map(({ x, y }) => ({ x, y }));
    expect(painted).not.toContainEqual(right);
    expect(painted).toHaveLength(3);
    // Control: the same chart published FIRST (under the range) hides nothing.
    const under = ballCtx();
    paintFrEdgeBalls(layerContext(under.ctx), [cover, frRegion()]);
    expect(under.arcs).toHaveLength(4);
  });

  it("the range's own overlay pass paints NO ball and NO selection outline any more (Core's chrome, the layer's balls)", () => {
    selectFloatingRange(FR_ID);
    const rec = ballCtx();
    renderFloatingRange({
      ctx: rec.ctx,
      region: frRegion(),
      config: { rowHeaderWidth: 0, colHeaderHeight: 0 },
      viewport: { scrollX: 0, scrollY: 0 },
      dimensions: {},
      canvasWidth: 2000,
      canvasHeight: 2000,
    } as unknown as OverlayRenderContext);
    expect(rec.arcs.filter((a) => a.fill === BALL_FILL), "the overlay pass painted a ball").toEqual([]);
    expect(rec.strokes.filter((s) => s.style === "#0e639c"), "the overlay pass painted a selection outline").toEqual([]);
  });

  it("the extension registers the layer at 'over-selection'", () => {
    const src = readFileSync(resolve(__dirname, "../../index.ts"), "utf8");
    expect(src).toMatch(/registerGridLayer\(\{\s*id:\s*FR_EDGE_BALL_LAYER_ID,\s*anchor:\s*"over-selection"/);
    expect(src).toMatch(/paint:\s*\(\w+\)\s*=>\s*paintFrEdgeBalls\(/);
    expect(FR_EDGE_BALL_LAYER_ID).toBe("floating-range-edge-balls");
  });
});
