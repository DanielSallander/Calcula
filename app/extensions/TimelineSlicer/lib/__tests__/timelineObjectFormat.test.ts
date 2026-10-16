//! FILENAME: app/extensions/TimelineSlicer/lib/__tests__/timelineObjectFormat.test.ts
// PURPOSE: The timeline's visual-container provider (WP-C S11, D-FORMAT), the
//          Slicer's twin:
//            - MAPPING: the title text / show ARE headerText / showHeader; the
//              rest lives in `container`, which never carries them;
//            - ONE update call per commit, none for a no-op;
//            - DEFAULTS from the style preset, 3 px corners, an 11 pt bold
//              title, the paint split;
//            - the content shape the zone table lays out on: Core's content
//              rect, the header's height from the title font;
//            - `bindingPath` answers FROM the exported table.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { GridRegion } from "@api/gridOverlays";
import { VISUAL_CONTAINER_FIELD_IDS, lineHeightFor } from "@api/visualContainer";
import { resetPaintedContainerLayouts } from "@api/visualContainerPaint";
import { resetCache } from "@api/objectBindings/cache";
import { timelineStyleColors } from "../timelineStyles";
import type { TimelineSlicer, UpdateTimelineParams } from "../timelineSlicerTypes";
import {
  CONTAINER_BINDING_PATHS,
  createTimelineObjectFormatProvider,
  readTimelineContainer,
  resetTimelineFormatPreviews,
  resolveTimelineContainer,
  timelineContainerDefaults,
  timelineContentShape,
  timelineUpdateFor,
} from "../timelineObjectFormat";

function timeline(over: Partial<TimelineSlicer> = {}): TimelineSlicer {
  return {
    id: "t1",
    name: "Order Date",
    headerText: null,
    sheetIndex: 0,
    x: 0,
    y: 0,
    width: 420,
    height: 140,
    sourceType: "pivot",
    sourceId: "p1",
    fieldName: "Order Date",
    level: "months",
    selectionStart: null,
    selectionEnd: null,
    showHeader: true,
    showLevelSelector: true,
    showScrollbar: true,
    stylePreset: "TimelineStyleDark1",
    connectedPivotIds: [],
    ...over,
  };
}

const REGION: GridRegion = {
  id: "timeline-slicer-t1",
  type: "timeline-slicer",
  startRow: 0,
  startCol: 0,
  endRow: 0,
  endCol: 0,
  floating: { x: 0, y: 0, width: 420, height: 140 },
  data: { timelineId: "t1" },
};

let current: TimelineSlicer;
const update = vi.fn(async (_id: string, _params: UpdateTimelineParams) => {});
const resync = vi.fn();

function provider() {
  return createTimelineObjectFormatProvider({
    getTimeline: (id) => (id === current.id ? current : undefined),
    update,
    resync,
  });
}

beforeEach(() => {
  current = timeline();
  update.mockClear();
  resync.mockClear();
  resetCache();
  resetTimelineFormatPreviews();
  resetPaintedContainerLayouts();
});

describe("mapping: one spelling per fact", () => {
  it("reads title text / show from headerText / showHeader, the rest from container", () => {
    const tl = timeline({ headerText: "Dates", showHeader: false, container: { shadow: { show: true } } });
    expect(readTimelineContainer(tl)).toEqual({ shadow: { show: true }, title: { show: false, text: "Dates" } });
  });

  it("splits a patch into headerText, showHeader and a container without them", () => {
    expect(timelineUpdateFor(current, { title: { text: "When", italic: true }, border: { show: false } })).toEqual({
      headerText: "When",
      container: { title: { italic: true }, border: { show: false } },
    });
    expect(timelineUpdateFor(current, { title: { show: true } })).toBeNull();
  });
});

describe("the provider's commit: ONE update_timeline_slicer", () => {
  it("one call with headerText, showHeader and container together", async () => {
    await provider().commit(REGION, { title: { text: "Period", show: false, fontSize: 16 } });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("t1", {
      headerText: "Period",
      showHeader: false,
      container: { title: { fontSize: 16 } },
    });
  });

  it("a no-op patch calls nothing", async () => {
    await provider().commit(REGION, { padding: { top: null } });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("defaults come from the style preset", () => {
  it("background, border and header colours from the preset; 3 px corners; 11 pt bold; the paint split", () => {
    const colors = timelineStyleColors("TimelineStyleDark1");
    const d = timelineContainerDefaults(current);
    expect(d.background).toMatchObject({ show: true, color: colors.bg, alpha: 1 });
    expect(d.border).toEqual({ show: true, color: colors.border, width: 1, radius: 3 });
    expect(d.title).toMatchObject({
      show: true,
      text: "Order Date",
      color: colors.headerFg,
      background: colors.headerBg,
      fontSize: 11,
      bold: true,
    });
    expect(d.paint).toEqual({ background: "core", border: "core", title: "family", shadow: "core" });
    expect(timelineContainerDefaults(timeline({ stylePreset: "TimelineStyleLight2" })).title.background).toBe(
      timelineStyleColors("TimelineStyleLight2").headerBg,
    );
  });
});

describe("the content shape the zone table lays out on", () => {
  it("default: inset by the 1 px border; the header 28 px", () => {
    const c = timelineContentShape(current);
    expect([c.offsetX, c.offsetY, c.shape.width, c.shape.height]).toEqual([1, 1, 418, 138]);
    expect(c.shape.headerHeight).toBe(28);
  });

  it("padding 12 and an 18 pt title: the content moves in, and the header grows", () => {
    current = timeline({
      container: { padding: { top: 12, right: 12, bottom: 12, left: 12 }, title: { fontSize: 18 } },
    });
    const c = timelineContentShape(current);
    expect([c.offsetX, c.offsetY, c.shape.width, c.shape.height]).toEqual([13, 13, 394, 114]);
    expect(c.shape.headerHeight).toBe(Math.max(28, lineHeightFor(18) + 12));
  });

  it("a hidden header (through the title) hides it for the shape too", () => {
    expect(timelineContentShape(timeline({ showHeader: false })).shape.showHeader).toBe(false);
  });
});

describe("bindings and preview", () => {
  it("bindingPath answers FROM the exported table, for every field", () => {
    const p = provider();
    for (const field of VISUAL_CONTAINER_FIELD_IDS) {
      expect(p.bindingPath!(REGION, field), field).toBe(CONTAINER_BINDING_PATHS[field]);
    }
  });

  it("a preview shows without a write and ends", () => {
    const p = provider();
    p.preview!(REGION, { padding: { left: 20 } });
    expect(resolveTimelineContainer(current).padding.left).toBe(20);
    expect(update).not.toHaveBeenCalled();
    p.endPreview!();
    expect(resolveTimelineContainer(current).padding.left).toBe(0);
  });
});
