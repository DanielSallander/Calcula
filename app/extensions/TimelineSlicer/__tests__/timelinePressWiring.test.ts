//! FILENAME: app/extensions/TimelineSlicer/__tests__/timelinePressWiring.test.ts
// PURPOSE: What index.ts does with Core's two press events once the timeline
//          answers `zoneAt` (design phase 2, M5 T3), driven through the REAL
//          `activate()` with a fake host:
//            - the registration's one answer is `zoneAt: timelineOverlayZoneAt`
//              (no `getCursor`, no `claimsBodyDrag` beside it);
//            - `floatingObject:selected` takes Ctrl from Core's detail, which
//              Core zeroes on CONTENT -- a Ctrl press on the month tiles no
//              longer toggles the timeline out of the selection, whatever a
//              mousedown saw;
//            - `floatingObject:bodyDragStart` hands the RAW Shift to the
//              content gesture as `extend`, under the region Core pressed.
// CONTEXT: The gesture itself is pinned in lib/__tests__/timelineRangeDrag.test.ts
//          and Core's order in core/.../overlayZones.test.ts. This file pins
//          the lines in between, whose absence is silent at runtime: a
//          dropped `extend:` makes Shift+click a plain click, a capture
//          mousedown put back makes a Ctrl press on content toggle again.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  begin: vi.fn((..._args: unknown[]) => true),
  select: vi.fn(),
}));

vi.mock("../lib/timelineSlicerStore", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshCache: vi.fn(async () => undefined),
  refreshCacheAndReconcile: vi.fn(async () => undefined),
  getTimelineById: (id: string) =>
    id === "t1"
      ? {
          id: "t1",
          name: "Date",
          sheetIndex: 0,
          x: 0,
          y: 0,
          width: 420,
          height: 140,
          showHeader: true,
          showLevelSelector: true,
          showScrollbar: true,
          level: "months",
          selectionStart: null,
          selectionEnd: null,
        }
      : undefined,
}));

vi.mock("../lib/timelineRangeDrag", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginTimelineContentPress: h.begin,
}));

vi.mock("../handlers/selectionHandler", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  selectTimeline: h.select,
}));

import type { ExtensionContext } from "@api/contract";
import type { OverlayRegistration } from "@api/gridOverlays";
import extension from "../index";
import { timelineOverlayZoneAt } from "../lib/timelineView";
import { clearPendingTimelineClick, peekPendingTimelineClick } from "../lib/timelinePendingClick";

const registrations: OverlayRegistration[] = [];

const context = {
  invokeBackend: vi.fn(async () => null),
  ui: { dialogs: { register: vi.fn() } },
  grid: {
    overlays: {
      register: (r: OverlayRegistration) => {
        registrations.push(r);
        return () => {};
      },
    },
  },
  events: { on: vi.fn(() => () => {}) },
} as unknown as ExtensionContext;

/** Core's `floatingObject:selected` for a press on t1 (pressZone's detail). */
function selected(zone: "frame" | "content", ctrlKey: boolean, shiftKey = false): void {
  window.dispatchEvent(
    new CustomEvent("floatingObject:selected", {
      detail: {
        regionId: "timeline-slicer-t1",
        regionType: "timeline-slicer",
        data: { timelineId: "t1" },
        zone,
        part: zone === "content" ? "period" : "header",
        canvasX: 200,
        canvasY: 100,
        ctrlKey,
        shiftKey,
      },
    }),
  );
}

/** Core's `floatingObject:bodyDragStart` for a content press on t1 (the RAW modifiers). */
function bodyDragStart(mods: { ctrlKey?: boolean; shiftKey?: boolean }): void {
  window.dispatchEvent(
    new CustomEvent("floatingObject:bodyDragStart", {
      detail: {
        regionId: "timeline-slicer-t1",
        regionType: "timeline-slicer",
        data: { timelineId: "t1" },
        canvasX: 200,
        canvasY: 100,
        part: "period",
        ctrlKey: mods.ctrlKey === true,
        shiftKey: mods.shiftKey === true,
      },
    }),
  );
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  extension.activate(context);
});

afterAll(() => {
  extension.deactivate?.();
  vi.restoreAllMocks();
});

beforeEach(() => {
  h.begin.mockClear();
  h.select.mockClear();
  clearPendingTimelineClick();
  // A release closes any press a test left open (the frame click's mouseup).
  window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
});

describe("the timeline's registration", () => {
  it("answers ONE zone: zoneAt is timelineOverlayZoneAt, with no second press or cursor answer", () => {
    const mine = registrations.filter((r) => r.type === "timeline-slicer");
    expect(mine).toHaveLength(1);
    expect(mine[0].zoneAt).toBe(timelineOverlayZoneAt);
    // The old fields are gone from the type (M5 T6); read what the object carries.
    const fields = mine[0] as unknown as Record<string, unknown>;
    expect(fields.getCursor).toBeUndefined();
    expect(fields.getCellCursor).toBeUndefined();
    expect(fields.claimsBodyDrag).toBeUndefined();
  });
});

describe("floatingObject:selected takes the OBJECT-selection Ctrl from Core", () => {
  it("a Ctrl press on the FRAME adds the timeline (Core passes Ctrl there)", () => {
    selected("frame", true);
    expect(h.select).toHaveBeenCalledWith("t1", true);
  });

  it("a plain press on the frame selects it alone", () => {
    selected("frame", false);
    expect(h.select).toHaveBeenCalledWith("t1", false);
  });

  it("a Ctrl press on the CONTENT is a plain press: the mousedown's Ctrl never reaches the selection", () => {
    // The real sequence: the native mousedown (Ctrl held) reaches the window
    // first, then Core's filtered press says ctrlKey:false for the content.
    window.dispatchEvent(new MouseEvent("mousedown", { ctrlKey: true, button: 0 }));
    selected("content", false);
    expect(h.select).toHaveBeenCalledTimes(1);
    expect(h.select).toHaveBeenCalledWith("t1", false);
  });
});

describe("floatingObject:bodyDragStart hands the raw Shift to the content gesture", () => {
  it("Shift held: the gesture EXTENDS the range, under the region Core pressed", () => {
    selected("content", false);
    bodyDragStart({ shiftKey: true });
    expect(h.begin).toHaveBeenCalledTimes(1);
    expect(h.begin.mock.calls[0][0]).toMatchObject({
      timelineId: "t1",
      regionId: "timeline-slicer-t1",
      canvasX: 200,
      canvasY: 100,
      extend: true,
    });
  });

  it("no Shift: a plain range press (Ctrl alone does not extend)", () => {
    selected("content", false);
    bodyDragStart({ ctrlKey: true });
    expect(h.begin).toHaveBeenCalledTimes(1);
    expect(h.begin.mock.calls[0][0]).toMatchObject({ timelineId: "t1", extend: false });
  });

  it("a detail without Core's region id starts nothing (the gesture could not hold Core's pointer)", () => {
    window.dispatchEvent(
      new CustomEvent("floatingObject:bodyDragStart", {
        detail: { regionType: "timeline-slicer", data: { timelineId: "t1" }, canvasX: 1, canvasY: 1, shiftKey: true },
      }),
    );
    expect(h.begin).not.toHaveBeenCalled();
  });
});

describe("a press on the GRIP (Core's chrome, BUG-0258 design phase 5) arms nothing", () => {
  /** Core's `floatingObject:selected` for a press on t1's grip: a frame press, part 'grip'. */
  function gripPress(): void {
    window.dispatchEvent(
      new CustomEvent("floatingObject:selected", {
        detail: {
          regionId: "timeline-slicer-t1",
          regionType: "timeline-slicer",
          data: { timelineId: "t1" },
          zone: "frame",
          part: "grip",
          canvasX: 30,
          canvasY: -12,
          ctrlKey: false,
          shiftKey: false,
        },
      }),
    );
  }

  it("it selects the timeline, but arms NO pending click and binds NO mouseup (its click opens the grip's menu)", () => {
    const add = vi.spyOn(window, "addEventListener");
    gripPress();
    expect(h.select).toHaveBeenCalledWith("t1", false);
    expect(peekPendingTimelineClick(), "a grip press armed the timeline's pending click").toBeNull();
    expect(add.mock.calls.filter((c) => c[0] === "mouseup"), "a grip press bound the click's mouseup").toEqual([]);
    add.mockRestore();
  });

  it("control: a press on the HEADER (frame) arms the pending click and binds its mouseup", () => {
    const add = vi.spyOn(window, "addEventListener");
    selected("frame", false);
    expect(peekPendingTimelineClick()).toMatchObject({ timelineId: "t1" });
    expect(add.mock.calls.filter((c) => c[0] === "mouseup")).toHaveLength(1);
    add.mockRestore();
  });
});
