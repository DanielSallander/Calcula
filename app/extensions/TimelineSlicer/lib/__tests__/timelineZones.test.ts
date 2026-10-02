//! FILENAME: app/extensions/TimelineSlicer/lib/__tests__/timelineZones.test.ts
// PURPOSE: Which part of a timeline MOVES it and which part WORKS -- the zone
//          table (lib/timelineZones.ts) -- and the ONE answer the overlay
//          registration gives Core from it: `zoneAt` (lib/timelineView.ts
//          `timelineOverlayZoneAt`), from which Core derives the press, the
//          pointer shape and the meaning of Ctrl/Shift
//          (@api/gridOverlays `resolveFloatingZone`).
// CONTEXT: BUG-0258: the cursor promised a hand over the month tiles and a
//          sideways arrow over the range ends, while a drag from either MOVED
//          the whole timeline, so a date range could not be dragged. The
//          frMoveZones.test.ts precedent: walk a grid of points over several
//          fixture timelines and require, at EVERY point, that the zone answer
//          is the table's row -- content names the table's cursor, the frame
//          names none (Core's 'move', or 'default' where it cannot move) --
//          and that Core's resolution of it agrees. Design phase 2 (M5 T3)
//          replaced the phase-1 pair `claimsBodyDrag` + `getCursor` with this
//          single answer.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const h = vi.hoisted(() => ({
  timelines: new Map<string, Record<string, unknown>>(),
  data: new Map<string, { periods: Array<Record<string, unknown>> }>(),
}));

vi.mock("../timelineSlicerStore", () => ({
  getTimelineById: (id: string) => h.timelines.get(id),
  getCachedTimelineData: (id: string) => h.data.get(id),
}));

import {
  registerGridOverlay,
  resolveFloatingZone,
  unregisterGridOverlay,
  type GridRegion,
  type OverlayHitTestContext,
} from "@api/gridOverlays";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "@api/layoutSurface";
import { resetScrollOffsets, setScrollOffset, timelineOverlayZoneAt, timelineZoneOf } from "../timelineView";
import {
  TIMELINE_ZONE_TABLE,
  computeTimelineLayout,
  levelButtonLeft,
  type TimelineZonePart,
} from "../timelineZones";
import type { TimelineLevel } from "../timelineSlicerTypes";

const BOUNDS = { x: 100, y: 50, width: 420, height: 140 };

interface Fixture {
  showHeader: boolean;
  showLevelSelector: boolean;
  showScrollbar: boolean;
  periods: number;
  /** Inclusive selected period indices, or null. */
  selected: [number, number] | null;
  scroll: number;
  level?: TimelineLevel;
}

function load(f: Fixture): void {
  h.timelines.set("t1", {
    id: "t1",
    name: "Date",
    sheetIndex: 0,
    x: 0,
    y: 0,
    width: BOUNDS.width,
    height: BOUNDS.height,
    showHeader: f.showHeader,
    showLevelSelector: f.showLevelSelector,
    showScrollbar: f.showScrollbar,
    level: f.level ?? "months",
    selectionStart: f.selected ? "sel" : null,
    selectionEnd: f.selected ? "sel" : null,
  });
  h.data.set("t1", {
    periods: Array.from({ length: f.periods }, (_, i) => ({
      label: `M${i}`,
      groupLabel: "2026",
      startDate: `2026-${String(i + 1).padStart(2, "0")}-01`,
      endDate: `2026-${String(i + 1).padStart(2, "0")}-28`,
      hasData: true,
      isSelected: f.selected ? i >= f.selected[0] && i <= f.selected[1] : false,
      index: i,
    })),
  });
  resetScrollOffsets();
  setScrollOffset("t1", f.scroll);
}

const REGION: GridRegion = {
  id: "timeline-slicer-t1",
  type: "timeline-slicer",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: 0, y: 0, width: BOUNDS.width, height: BOUNDS.height },
  data: { timelineId: "t1" },
};

/** The context Core hands `zoneAt`, at a point relative to the timeline. */
function ctx(relX: number, relY: number): OverlayHitTestContext {
  return {
    region: REGION,
    canvasX: BOUNDS.x + relX,
    canvasY: BOUNDS.y + relY,
    row: 0,
    col: 0,
    floatingCanvasBounds: BOUNDS,
  };
}

function partAt(relX: number, relY: number): TimelineZonePart | undefined {
  return timelineZoneOf(ctx(relX, relY))?.part;
}

/** Whether the registration gives the press at `c` to the CONTENT. */
function isContent(c: OverlayHitTestContext): boolean {
  return timelineOverlayZoneAt(c)?.kind === "content";
}

/** The pointer the registration names at `c` itself; null = Core's own answer. */
function ownCursor(c: OverlayHitTestContext): string | null {
  return timelineOverlayZoneAt(c)?.cursor ?? null;
}

const FIXTURES: Fixture[] = [
  { showHeader: true, showLevelSelector: true, showScrollbar: true, periods: 12, selected: [2, 5], scroll: 0 },
  { showHeader: true, showLevelSelector: true, showScrollbar: true, periods: 24, selected: [3, 9], scroll: 130 },
  { showHeader: false, showLevelSelector: false, showScrollbar: false, periods: 6, selected: null, scroll: 0 },
  { showHeader: false, showLevelSelector: true, showScrollbar: true, periods: 30, selected: [0, 0], scroll: 900 },
  { showHeader: true, showLevelSelector: false, showScrollbar: true, periods: 8, selected: [7, 7], scroll: 0, level: "years" },
];

let unregisterOverlay: (() => void) | null = null;
let unregisterSurface: (() => void) | null = null;

beforeEach(() => {
  h.timelines.clear();
  h.data.clear();
  resetScrollOffsets();
  // Core resolves a zone through the REGISTRATION: register the timeline's
  // exactly as index.ts does (its zoneAt), so resolveFloatingZone asks it.
  unregisterOverlay = registerGridOverlay({ type: "timeline-slicer", render: () => {}, zoneAt: timelineOverlayZoneAt });
});

afterEach(() => {
  unregisterOverlay?.();
  unregisterOverlay = null;
  unregisterSurface?.();
  unregisterSurface = null;
  unregisterGridOverlay("timeline-slicer");
});

describe("the press and the pointer shape come from ONE zone answer", () => {
  it("at every point of every fixture: zoneAt is the table's row, and Core's resolution agrees", () => {
    let content = 0;
    let frame = 0;
    for (const f of FIXTURES) {
      load(f);
      for (let relY = 0; relY <= BOUNDS.height; relY += 2) {
        for (let relX = 0; relX <= BOUNDS.width; relX += 2) {
          const c = ctx(relX, relY);
          const zone = timelineZoneOf(c);
          expect(zone, `no zone at ${relX},${relY}`).not.toBeNull();
          const row = TIMELINE_ZONE_TABLE[zone!.part];
          const answer = timelineOverlayZoneAt(c);
          const where = `${relX},${relY} (${zone!.part})`;
          expect(answer?.kind, `kind at ${where}`).toBe(row.kind);
          expect(answer?.part, `part at ${where}`).toBe(zone!.part);
          if (row.kind === "content") {
            // Content always names the table's cursor.
            expect(answer?.cursor, `cursor at ${where}`).toBe(row.cursor);
            content++;
          } else {
            // The frame names none: Core's answer applies.
            expect(answer?.cursor ?? null, `frame cursor at ${where}`).toBeNull();
            frame++;
          }
          // Core's view of the same point (a worksheet: everything can move).
          const resolved = resolveFloatingZone(c);
          expect(resolved.kind, `resolved kind at ${where}`).toBe(row.kind);
          expect(resolved.cursor, `resolved cursor at ${where}`).toBe(row.kind === "content" ? row.cursor : "move");
        }
      }
    }
    // Neither answer is vacuous.
    expect(content).toBeGreaterThan(1000);
    expect(frame).toBeGreaterThan(1000);
  });

  it("the table itself: content always names a cursor, the frame never does", () => {
    for (const [part, row] of Object.entries(TIMELINE_ZONE_TABLE)) {
      expect(row.cursor !== null, part).toBe(row.kind === "content");
    }
  });

  it("off the timeline (or an unknown one) zoneAt answers null, which Core treats as frame", () => {
    load(FIXTURES[0]);
    expect(timelineOverlayZoneAt(ctx(-5, 10))).toBeNull();
    expect(timelineOverlayZoneAt({ ...ctx(40, 10), region: { ...REGION, data: { timelineId: "gone" } } })).toBeNull();
  });
});

describe("the zones (design Part 2, phase 1)", () => {
  const fixture = FIXTURES[0];
  const layout = () =>
    computeTimelineLayout(
      { width: BOUNDS.width, height: BOUNDS.height, showHeader: true, showLevelSelector: true, showScrollbar: true, level: "months" },
      12,
    );

  it("BUG-0258: a press on a month tile is the timeline's own -- content, with a hand", () => {
    load(fixture);
    const tileMid = layout().tileTop + 14;
    // Period 7 (x 350..400): well away from the range [2..5]'s end markers.
    const c = ctx(7 * 50 + 25, tileMid);
    expect(timelineZoneOf(c)).toMatchObject({ part: "period", periodIndex: 7 });
    expect(timelineOverlayZoneAt(c)).toEqual({ kind: "content", cursor: "pointer", part: "period" });
  });

  it("the range-end markers are content with a sideways arrow, IN the tile row only", () => {
    load(fixture);
    const L = layout();
    const tileMid = L.tileTop + 14;
    expect(partAt(2 * 50 + 2, tileMid)).toBe("rangeStart");
    expect(partAt(6 * 50 - 3, tileMid)).toBe("rangeEnd");
    expect(ownCursor(ctx(2 * 50, tileMid))).toBe("ew-resize");
    // The same x in the year strip above is FRAME: it moves the timeline.
    expect(partAt(2 * 50, L.yearStripTop + 9)).toBe("yearStrip");
    expect(isContent(ctx(2 * 50, L.yearStripTop + 9))).toBe(false);
  });

  it("owner decision: the year-label strip MOVES the timeline (frame, Core's cursor)", () => {
    for (const f of FIXTURES) {
      load(f);
      const L = computeTimelineLayout(
        { width: BOUNDS.width, height: BOUNDS.height, showHeader: f.showHeader, showLevelSelector: f.showLevelSelector, showScrollbar: f.showScrollbar, level: f.level ?? "months" },
        f.periods,
      );
      for (let relX = 0; relX <= BOUNDS.width; relX += 10) {
        for (let relY = L.yearStripTop; relY < L.tileTop; relY += 3) {
          const c = ctx(relX, relY);
          expect(timelineOverlayZoneAt(c), `${relX},${relY}`).toEqual({ kind: "frame", part: "yearStrip" });
          expect(resolveFloatingZone(c)).toMatchObject({ kind: "frame", cursor: "move", canMove: true });
        }
      }
    }
  });

  it("the header and the empty space under the tiles are frame; the clear button is content", () => {
    load(fixture);
    const L = layout();
    expect(partAt(40, 10)).toBe("header");
    expect(isContent(ctx(40, 10))).toBe(false);
    expect(partAt(BOUNDS.width - 12, 14)).toBe("clearButton");
    expect(isContent(ctx(BOUNDS.width - 12, 14))).toBe(true);
    // Between the tile row and the level row.
    const below = L.tileBottom + Math.floor((L.levelTop - L.tileBottom) / 2);
    expect(below).toBeLessThan(L.levelTop);
    expect(partAt(200, below)).toBe("empty");
    expect(ownCursor(ctx(200, below))).toBeNull();
  });

  it("the clear button is content only while there IS a filter to clear; unfiltered, its corner is header", () => {
    // Unfiltered, the renderer draws the button dimmed and a release on it
    // does nothing -- a hand there would promise a click that is inert, and
    // the corner would neither move the timeline nor act.
    load({ ...fixture, selected: null });
    const corner = ctx(BOUNDS.width - 12, 14);
    expect(timelineZoneOf(corner)?.part).toBe("header");
    expect(isContent(corner)).toBe(false);
    expect(ownCursor(corner)).toBeNull();
    // Filtered: the same point is the button.
    load(fixture);
    expect(timelineZoneOf(corner)?.part).toBe("clearButton");
    expect(isContent(corner)).toBe(true);
    expect(ownCursor(corner)).toBe("pointer");
  });

  it("a level button is content; the gaps in the level row are frame", () => {
    load(fixture);
    const L = layout();
    const rowMid = L.levelTop + 12;
    const firstLeft = levelButtonLeft(BOUNDS.width, 0);
    expect(timelineZoneOf(ctx(firstLeft + 30, rowMid))).toMatchObject({ part: "levelButton", level: "years" });
    expect(partAt(firstLeft - 5, rowMid)).toBe("levelGap");
    expect(partAt(levelButtonLeft(BOUNDS.width, 1) - 2, rowMid)).toBe("levelGap");
    expect(isContent(ctx(firstLeft - 5, rowMid))).toBe(false);
  });

  it("the scrollbar is content only while the periods overflow; otherwise its strip is empty frame", () => {
    load(fixture); // 12 x 50 = 600 > 420: overflows
    const L = layout();
    expect(partAt(200, L.scrollbarTop + 4)).toBe("scrollbar");
    expect(ownCursor(ctx(200, L.scrollbarTop + 4))).toBe("default");
    load({ ...fixture, periods: 6 }); // 300 < 420: fits
    expect(partAt(200, L.scrollbarTop + 4)).toBe("empty");
  });

  it("the tile row past the last period is empty frame", () => {
    load({ ...FIXTURES[2] }); // 6 periods x 50 = 300 < 420, header off
    expect(partAt(350, 18 + 14)).toBe("empty");
    expect(partAt(250, 18 + 14)).toBe("period");
  });

  it("a scrolled timeline hits the period under the pointer, not the unscrolled one", () => {
    load(FIXTURES[1]); // scroll 130
    const L = computeTimelineLayout(
      { width: BOUNDS.width, height: BOUNDS.height, showHeader: true, showLevelSelector: true, showScrollbar: true, level: "months" },
      24,
    );
    // relX 40 + scroll 130 = 170 -> period 3 (150..200). The range [3..9]
    // starts at relX 20, so 20px further in is the period, not the marker.
    expect(timelineZoneOf(ctx(40, L.tileTop + 14))).toMatchObject({ part: "period", periodIndex: 3 });
  });
});

describe("the registration in index.ts uses the ONE zone answer", () => {
  // Source-level: `activate` is not callable without the whole host here (the
  // wiring test __tests__/timelinePressWiring.test.ts drives it with a fake
  // host). What must never come back is a SECOND answer -- a `getCursor` or a
  // `claimsBodyDrag` written beside `zoneAt`, which is how the cursor and the
  // press drifted apart in the first place -- or a modifier read from a
  // capture mousedown of its own instead of Core's zone-filtered press.
  const src = readFileSync(resolve(__dirname, "../../index.ts"), "utf8").replace(/\/\/.*$/gm, "");
  const at = src.indexOf('type: "timeline-slicer"');
  const block = src.slice(src.lastIndexOf("register({", at), src.indexOf("}),", at));

  it("answers zoneAt with timelineOverlayZoneAt and declares no press or cursor answer of its own", () => {
    expect(at, "the timeline registration is gone").toBeGreaterThan(0);
    expect(block).toMatch(/zoneAt\s*:\s*timelineOverlayZoneAt\b/);
    expect(block).not.toMatch(/getCursor\s*:/);
    expect(block).not.toMatch(/claimsBodyDrag\s*:/);
    expect(block).not.toMatch(/\.\.\.\w*[Zz]one\w*Hooks/);
  });

  it("reads no modifier from a mousedown of its own: Core's press carries it", () => {
    expect(src).not.toMatch(/addEventListener\(\s*["']mousedown["']/);
    expect(src).not.toMatch(/lastMousedownCtrl/);
  });

  it("hands content presses on, and no longer re-publishes a resize flag (Core gates the handles on the selection)", () => {
    expect(src).toMatch(/addEventListener\("floatingObject:bodyDragStart",/);
    expect(src).not.toMatch(/installTimelineRegionResyncs/);
  });
});

describe("a LOCKED timeline on a SUBSCRIBED page still filters (owner decision)", () => {
  function useSurface(s: Partial<LayoutSurface>): void {
    const surface: LayoutSurface = {
      snapToGrid: false,
      gridSize: 25,
      showGrid: false,
      page: { width: 1280, height: 720 },
      editable: true,
      ...s,
    };
    unregisterSurface = registerLayoutSurfaceProvider({ get: () => surface });
  }

  it("through Core's rule: the tiles are content with a hand; the header cannot move ('default')", () => {
    useSurface({ editable: false, isLocked: () => true });
    load(FIXTURES[0]);
    const tile = ctx(7 * 50 + 25, 28 + 18 + 14);
    expect(resolveFloatingZone(tile)).toEqual({ kind: "content", part: "period", cursor: "pointer", canMove: false });
    // The frame: Core refuses the move, and the pointer does not promise one.
    expect(resolveFloatingZone(ctx(40, 10))).toEqual({ kind: "frame", part: "header", cursor: "default", canMove: false });
  });

  it("locked alone (an editable canvas) is the same; unlocked, the header shows 'move'", () => {
    useSurface({ isLocked: () => true });
    load(FIXTURES[0]);
    expect(resolveFloatingZone(ctx(40, 10))).toMatchObject({ kind: "frame", cursor: "default", canMove: false });
    expect(resolveFloatingZone(ctx(7 * 50 + 25, 28 + 18 + 14))).toMatchObject({ kind: "content", cursor: "pointer" });
    unregisterSurface!();
    unregisterSurface = null;

    useSurface({ isLocked: () => false });
    expect(resolveFloatingZone(ctx(40, 10))).toMatchObject({ kind: "frame", cursor: "move", canMove: true });
  });
});
