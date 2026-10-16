//! FILENAME: app/extensions/TimelineSlicer/__tests__/timelineBindings.test.ts
// PURPOSE: A timeline's BOUND header (D-BIND S8c, @api/objectBindings), read
//          from the REAL renderer and the REAL zone answer:
//            - the resolved header text is painted, never the literal, and the
//              store keeps the literal; a pending value keeps the literal;
//            - a bound show-header = FALSE hides the header for the painter AND
//              the zone table (what is painted is what a press hits);
//            - the registration answers the seam (region and script instance
//              -> ref, the two catalog rows), and a timeline's binding change
//              -- only a timeline's -- resyncs the regions and redraws.
// CONTEXT: The real seam cache, filled the way the bridge fills it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  timeline: null as Record<string, unknown> | null,
  periods: [] as Array<Record<string, unknown>>,
}));

vi.mock("../lib/timelineSlicerStore", () => ({
  getTimelineById: (id: string) => (id === "t1" ? (h.timeline ?? undefined) : undefined),
  getCachedTimelineData: (id: string) => (id === "t1" ? { periods: h.periods } : undefined),
}));

import type { GridRegion, OverlayRenderContext } from "@api/gridOverlays";
import type { ResolvedBinding } from "@api/objectBindings";
import { bindingRefForInstance, getBindableProperties } from "@api/objectBindings";
import { applyResolvedValues, notifyBindingsChanged, resetCache } from "@api/objectBindings/cache";
import { getTimelineHitDetail, renderTimelineSlicer } from "../rendering/timelineSlicerRenderer";
import { resetScrollOffsets } from "../lib/timelineView";
import {
  TIMELINE_BINDABLE_PROPERTIES,
  TIMELINE_REGION_TYPE,
  installTimelineBindings,
  shownTimeline,
  timelineBindingRef,
} from "../lib/timelineBindings";
import { TIMELINE_REGION_TYPE as SELECTION_REGION_TYPE } from "../lib/timelineObjectSelection";

const B = { x: 100, y: 50, width: 420, height: 140 };
const REF = timelineBindingRef("t1");

function rb(path: string, over: Partial<ResolvedBinding>): ResolvedBinding {
  return { object: REF, path, value: null, display: "", error: null, pending: false, ...over };
}

function region(): GridRegion {
  return {
    id: "timeline-slicer-t1",
    type: "timeline-slicer",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 0, y: 0, width: B.width, height: B.height },
    data: { timelineId: "t1" },
  };
}

function paintTexts(): string[] {
  const texts: string[] = [];
  const state: Record<string, unknown> = { fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "left", textBaseline: "alphabetic", globalAlpha: 1 };
  const ctx = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop in state) return state[prop];
        if (prop === "measureText") return (s: string) => ({ width: String(s).length * 6 });
        return (...args: unknown[]) => {
          if (prop === "fillText") texts.push(String(args[0]));
        };
      },
      set(_t, prop: string, value: unknown) {
        state[prop] = value;
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  renderTimelineSlicer({
    ctx,
    region: region(),
    config: { rowHeaderWidth: B.x, colHeaderHeight: B.y },
    viewport: { scrollX: 0, scrollY: 0 },
    dimensions: {},
    canvasWidth: 1000,
    canvasHeight: 800,
  } as unknown as OverlayRenderContext);
  return texts;
}

beforeEach(() => {
  resetCache();
  resetScrollOffsets();
  h.timeline = {
    id: "t1",
    name: "Date",
    headerText: "Literal header",
    sheetIndex: 0,
    x: 0,
    y: 0,
    width: B.width,
    height: B.height,
    level: "months",
    selectionStart: null,
    selectionEnd: null,
    showHeader: true,
    showLevelSelector: true,
    showScrollbar: true,
    stylePreset: "TimelineStyleLight1",
  };
  h.periods = Array.from({ length: 6 }, (_, i) => ({
    label: `M${i + 1}`,
    groupLabel: "2026",
    startDate: `2026-0${i + 1}-01`,
    endDate: `2026-0${i + 1}-28`,
    hasData: true,
    isSelected: false,
    index: i,
  }));
});

afterEach(() => {
  resetCache();
});

describe("a timeline's bound header text is painted; the literal stays in the store", () => {
  it("control: unbound, the literal header text is painted", () => {
    expect(paintTexts()).toContain("Literal header");
  });

  it("a resolved header text is painted instead of the literal", () => {
    applyResolvedValues([rb("/headerText", { value: "Order date", display: "Order date" })]);
    const texts = paintTexts();
    expect(texts).toContain("Order date");
    expect(texts).not.toContain("Literal header");
    expect(h.timeline!.headerText).toBe("Literal header");
  });

  it("a PENDING value keeps the literal", () => {
    applyResolvedValues([rb("/headerText", { pending: true })]);
    expect(paintTexts()).toContain("Literal header");
  });
});

describe("a bound show-header hides the header for the painter AND the zones", () => {
  it("control: a press at the header's height hits the header", () => {
    expect(getTimelineHitDetail(B.x + 40, B.y + 8, B, "t1")).toEqual({ type: "header" });
  });

  it("bound to FALSE: no header painted, and the same press is no longer a header press", () => {
    applyResolvedValues([rb("/showHeader", { value: false, display: "FALSE" })]);
    expect(paintTexts()).not.toContain("Literal header");
    expect(getTimelineHitDetail(B.x + 40, B.y + 8, B, "t1")).not.toEqual({ type: "header" });
    expect(h.timeline!.showHeader).toBe(true);
  });

  it("shownTimeline returns the very record when nothing is bound", () => {
    const t = h.timeline as { id: string };
    expect(shownTimeline(t)).toBe(t);
  });
});

describe("the timeline registration and the repaint on change", () => {
  let uninstall: (() => void) | null = null;
  const deps = {
    timelineExists: vi.fn((id: string) => id === "t1"),
    resyncRegions: vi.fn(),
    redraw: vi.fn(),
  };

  beforeEach(() => {
    deps.resyncRegions.mockClear();
    deps.redraw.mockClear();
    uninstall = installTimelineBindings(deps);
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("registers for the region type the timeline publishes its regions as", () => {
    expect(TIMELINE_REGION_TYPE).toBe(SELECTION_REGION_TYPE);
  });

  it("a timeline region -> its ref and the two catalog rows", async () => {
    const answer = await getBindableProperties(region());
    expect(answer?.ref).toEqual({ kind: "timelineSlicer", id: "t1" });
    expect(answer?.properties).toEqual(TIMELINE_BINDABLE_PROPERTIES);
  });

  it("a script's timeline instance -> its ref; an unknown id -> null", async () => {
    expect(await bindingRefForInstance("timeline", "t1")).toEqual({ kind: "timelineSlicer", id: "t1" });
    expect(await bindingRefForInstance("timeline", "nope")).toBeNull();
  });

  it("a timeline's binding change resyncs the regions and redraws; a slicer's does not", () => {
    notifyBindingsChanged({ objects: [{ kind: "slicer", id: "t1" }], reload: false });
    expect(deps.redraw).not.toHaveBeenCalled();
    notifyBindingsChanged({ objects: [REF], reload: false });
    expect(deps.resyncRegions).toHaveBeenCalledTimes(1);
    expect(deps.redraw).toHaveBeenCalledTimes(1);
  });
});
