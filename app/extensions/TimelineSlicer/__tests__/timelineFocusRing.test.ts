//! FILENAME: app/extensions/TimelineSlicer/__tests__/timelineFocusRing.test.ts
// PURPOSE: What the keyboard inside a timeline (M8 S8) PAINTS, read from the
//          REAL renderer (rendering/timelineSlicerRenderer.ts) through a
//          recording canvas context:
//            - the focus ring is a 2px dark outline with a 1px light line
//              inside it, on the tile of the period the keys act on
//              (`resolveTimelineFocus`, which the key handler asks too) -- its
//              middle hit-tests to that period (paint == keys == hit), it
//              follows the period's START DATE through a refresh, it moves with
//              the scroll, and it is painted AFTER the selection bar so the bar
//              never covers its lower edge;
//            - no ring for no focus, a focus in another timeline, or a focus
//              taken at another level;
//            - the keyboard's Shift+arrow PREVIEW is painted as the range (the
//              selection bar) although nothing was written;
//            - on every colour set the renderer can paint, one of the ring's two
//              tones reaches 3:1 against the tile (WCAG 2.2 SC 1.4.11).

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  timeline: null as Record<string, unknown> | null,
  periods: [] as Array<Record<string, unknown>>,
}));

vi.mock("../lib/timelineSlicerStore", () => ({
  getTimelineById: (id: string) => (id === "t1" ? (h.timeline ?? undefined) : undefined),
  getCachedTimelineData: (id: string) => (id === "t1" ? { periods: h.periods } : undefined),
}));

import type { OverlayRenderContext } from "@api/gridOverlays";
import {
  TIMELINE_FOCUS_RING_DARK,
  TIMELINE_FOCUS_RING_LIGHT,
  getTimelineHitDetail,
  renderTimelineSlicer,
  timelinePresetColorSets,
} from "../rendering/timelineSlicerRenderer";
import { resetTimelineKeyFocus, setTimelineKeyFocus } from "../lib/timelineKeyFocus";
import {
  getTimelineRangePreview,
  holdLandingRange,
  resetTimelineGestureView,
  showTimelineGesture,
  showTimelineKeyPreview,
} from "../lib/timelineGestureView";
import { resetScrollOffsets, setScrollOffset } from "../lib/timelineView";
import { computeTimelineLayout } from "../lib/timelineZones";

/** The timeline on the canvas: 420 x 140 at canvas (100, 50); months are 50 px tiles. */
const B = { x: 100, y: 50, width: 420, height: 140 };
const PW = 50;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function load(range: [number, number] | null = null): void {
  h.timeline = {
    id: "t1",
    name: "Date",
    headerText: null,
    sheetIndex: 0,
    x: 0,
    y: 0,
    width: B.width,
    height: B.height,
    level: "months",
    selectionStart: range ? `2026-${pad(range[0] + 1)}-01` : null,
    selectionEnd: range ? `2026-${pad(range[1] + 1)}-28` : null,
    showHeader: true,
    showLevelSelector: true,
    showScrollbar: true,
    stylePreset: "TimelineStyleLight1",
  };
  h.periods = Array.from({ length: 12 }, (_, i) => ({
    label: `M${i + 1}`,
    groupLabel: "2026",
    startDate: `2026-${pad(i + 1)}-01`,
    endDate: `2026-${pad(i + 1)}-28`,
    hasData: true,
    isSelected: range !== null && i >= range[0] && i <= range[1],
    index: i,
  }));
}

const LAYOUT = () => computeTimelineLayout(h.timeline as never, h.periods.length);

interface Op {
  op: string;
  args: unknown[];
  strokeStyle: string;
  fillStyle: string;
  lineWidth: number;
}

function recorder(): { ctx: CanvasRenderingContext2D; ops: Op[] } {
  const ops: Op[] = [];
  const state: Record<string, unknown> = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    globalAlpha: 1,
  };
  const ctx = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop in state) return state[prop];
        return (...args: unknown[]) => {
          ops.push({
            op: prop,
            args,
            strokeStyle: String(state.strokeStyle),
            fillStyle: String(state.fillStyle),
            lineWidth: Number(state.lineWidth),
          });
        };
      },
      set(_t, prop: string, value: unknown) {
        state[prop] = value;
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, ops };
}

function paint(): Op[] {
  const { ctx, ops } = recorder();
  renderTimelineSlicer({
    ctx,
    region: {
      id: "timeline-slicer-t1",
      type: "timeline-slicer",
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
      floating: { x: 0, y: 0, width: B.width, height: B.height },
      data: { timelineId: "t1" },
    },
    config: { rowHeaderWidth: B.x, colHeaderHeight: B.y },
    viewport: { scrollX: 0, scrollY: 0 },
    dimensions: {},
    canvasWidth: 1000,
    canvasHeight: 800,
  } as unknown as OverlayRenderContext);
  return ops;
}

/** The rectangle (x, y, w, h) of every path stroked in `colour`, with the op's index. */
function strokedRects(ops: Op[], colour: string): Array<{ rect: number[]; at: number; lineWidth: number }> {
  const rects: Array<{ rect: number[]; at: number; lineWidth: number }> = [];
  let last: number[] | null = null;
  ops.forEach((o, i) => {
    if (o.op === "roundRect" || o.op === "rect") last = (o.args as number[]).slice(0, 4);
    if (o.op === "stroke" && o.strokeStyle === colour && last) rects.push({ rect: last, at: i, lineWidth: o.lineWidth });
  });
  return rects;
}

const focusOn = (periodStart: string, level = "months") =>
  setTimelineKeyFocus({ timelineId: "t1", level, periodStart, anchorStart: null });

beforeEach(() => {
  load();
  resetTimelineKeyFocus();
  resetTimelineGestureView();
  resetScrollOffsets();
});

describe("the focus ring is painted on the period the keys act on", () => {
  it("a 2px dark outline and a 1px light line INSIDE the focused period's tile", () => {
    focusOn("2026-04-01");
    const ops = paint();
    const tileX = B.x + 3 * PW;
    const tileY = B.y + LAYOUT().tileTop;
    const dark = strokedRects(ops, TIMELINE_FOCUS_RING_DARK);
    expect(dark.map((d) => d.rect)).toEqual([[tileX + 1, tileY + 1, PW - 2, LAYOUT().periodH - 2]]);
    expect(dark[0].lineWidth).toBe(2);
    const light = strokedRects(ops, TIMELINE_FOCUS_RING_LIGHT);
    expect(light.map((d) => d.rect)).toEqual([[tileX + 2.5, tileY + 2.5, PW - 5, LAYOUT().periodH - 5]]);
    expect(light[0].lineWidth).toBe(1);
  });

  it("the ring's middle hit-tests to the FOCUSED period (paint == keys == hit)", () => {
    focusOn("2026-06-01");
    const [ring] = strokedRects(paint(), TIMELINE_FOCUS_RING_DARK);
    expect(ring, "no ring was painted").toBeDefined();
    const [x, y, w, hh] = ring.rect;
    const hit = getTimelineHitDetail(x + w / 2, y + hh / 2, B, "t1");
    expect(hit, "the ring is painted on another period than the one the keys act on").toEqual({ type: "period", periodIndex: 5 });
  });

  it("it moves with the periods' scroll", () => {
    focusOn("2026-09-01");
    setScrollOffset("t1", 150);
    const [ring] = strokedRects(paint(), TIMELINE_FOCUS_RING_DARK);
    expect(ring.rect[0]).toBe(B.x + 8 * PW - 150 + 1);
  });

  it("it follows the period's START DATE after a refresh put another period in front", () => {
    focusOn("2026-04-01");
    h.periods = [
      { label: "M12", groupLabel: "2025", startDate: "2025-12-01", endDate: "2025-12-28", hasData: true, isSelected: false, index: 0 },
      ...h.periods,
    ];
    const [ring] = strokedRects(paint(), TIMELINE_FOCUS_RING_DARK);
    expect(ring.rect[0], "the ring stayed on the old index (now March)").toBe(B.x + 4 * PW + 1);
  });

  it("it is painted AFTER the selection bar, so the bar does not cover its lower edge", () => {
    load([2, 5]);
    focusOn("2026-04-01");
    const ops = paint();
    const layout = LAYOUT();
    const barTop = B.y + layout.headerH + layout.groupLabelH + layout.periodH - 4;
    const bar = ops.findIndex((o) => o.op === "fillRect" && (o.args as number[])[1] === barTop && (o.args as number[])[3] === 4);
    expect(bar, "fixture: the selection bar was painted").toBeGreaterThan(-1);
    const [ring] = strokedRects(ops, TIMELINE_FOCUS_RING_DARK);
    expect(ring.at, "the selection bar is painted over the ring").toBeGreaterThan(bar);
  });

  it("no ring: no focus, a focus in ANOTHER timeline, or a focus taken at ANOTHER level", () => {
    expect(strokedRects(paint(), TIMELINE_FOCUS_RING_DARK)).toEqual([]);
    setTimelineKeyFocus({ timelineId: "t2", level: "months", periodStart: "2026-04-01", anchorStart: null });
    expect(strokedRects(paint(), TIMELINE_FOCUS_RING_DARK)).toEqual([]);
    focusOn("2026-04-01", "quarters");
    expect(strokedRects(paint(), TIMELINE_FOCUS_RING_DARK)).toEqual([]);
  });
});

describe("the keyboard's preview has its OWN slot (timelineGestureView.ts)", () => {
  it("a live drag's range wins over it, and dropping the keyboard's preview never erases the drag's", () => {
    showTimelineGesture({ timelineId: "t1", span: { first: 5, last: 5 } });
    showTimelineKeyPreview({ timelineId: "t1", span: { first: 0, last: 1 } });
    expect(getTimelineRangePreview("t1"), "the keyboard's preview was painted over a live drag").toEqual({ first: 5, last: 5 });
    showTimelineKeyPreview(null);
    expect(getTimelineRangePreview("t1"), "ending the keyboard's preview erased the drag's range (one shared slot)").toEqual({ first: 5, last: 5 });
    showTimelineGesture(null);
    expect(getTimelineRangePreview("t1")).toBeNull();
  });

  it("it wins over a landing commit's range, which shows again once the preview goes", () => {
    holdLandingRange("t1", { first: 2, last: 2 });
    showTimelineKeyPreview({ timelineId: "t1", span: { first: 4, last: 6 } });
    expect(getTimelineRangePreview("t1")).toEqual({ first: 4, last: 6 });
    showTimelineKeyPreview(null);
    expect(getTimelineRangePreview("t1")).toEqual({ first: 2, last: 2 });
  });

  it("another timeline's preview is not this one's", () => {
    showTimelineKeyPreview({ timelineId: "t2", span: { first: 0, last: 1 } });
    expect(getTimelineRangePreview("t1")).toBeNull();
  });
});

describe("the keyboard's preview is painted, and nothing is written", () => {
  it("a Shift+arrow preview over periods 1..3 paints the selection bar over exactly those tiles", () => {
    showTimelineKeyPreview({ timelineId: "t1", span: { first: 1, last: 3 } });
    const ops = paint();
    const layout = LAYOUT();
    const barTop = B.y + layout.headerH + layout.groupLabelH + layout.periodH - 4;
    const bars = ops.filter((o) => o.op === "fillRect" && (o.args as number[])[1] === barTop && (o.args as number[])[3] === 4);
    expect(bars.map((o) => (o.args as number[]).slice(0, 3))).toEqual([[B.x + PW, barTop, 3 * PW]]);
  });
});

// ============================================================================
// Contrast
// ============================================================================

/** WCAG relative luminance of an opaque [r, g, b] (0..255). */
function luminance([r, g, b]: number[]): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** A colour as opaque RGB: #rrggbb, or rgba(...) composited over `under`. */
function rgb(colour: string, under: number[] = [255, 255, 255]): number[] {
  const hex = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour.trim());
  if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)];
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(colour.trim());
  if (!m) throw new Error(`not a colour: ${colour}`);
  const a = m[4] === undefined ? 1 : Number(m[4]);
  return [1, 2, 3].map((k, i) => Number(m[k]) * a + under[i] * (1 - a));
}

function contrast(a: number[], b: number[]): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const ringAgainst = (fill: number[]) =>
  Math.max(contrast(rgb(TIMELINE_FOCUS_RING_DARK), fill), contrast(rgb(TIMELINE_FOCUS_RING_LIGHT), fill));

describe("the timeline focus ring's contrast (WCAG 2.2 SC 1.4.11)", () => {
  const presets = timelinePresetColorSets();

  it("measures every colour set the renderer can paint: the gallery's six and the unknown-id fallback", () => {
    expect(presets.length).toBe(7);
    expect(presets.map((p) => p.id)).toEqual(expect.arrayContaining(["TimelineStyleLight1", "TimelineStyleDark2", "<unknown preset>"]));
  });

  it("one of the two tones reaches 3:1 against every tile: the background, and the selection highlight over it", () => {
    const failures: string[] = [];
    for (const { id, colors } of presets) {
      const bg = rgb(colors.bg);
      for (const [name, fill] of [
        ["bg", bg],
        ["selectionBarBg over bg", rgb(colors.selectionBarBg, bg)],
        ["selectedBg", rgb(colors.selectedBg)],
      ] as const) {
        const ratio = ringAgainst(fill as number[]);
        if (ratio < 3) failures.push(`${id} ${name}: ${ratio.toFixed(2)}:1`);
      }
    }
    expect(failures, "the focus ring is invisible on these tiles").toEqual([]);
  });

  it("the two tones reach 3:1 against each other (each line stays visible beside the other)", () => {
    expect(contrast(rgb(TIMELINE_FOCUS_RING_DARK), rgb(TIMELINE_FOCUS_RING_LIGHT))).toBeGreaterThanOrEqual(3);
  });
});
