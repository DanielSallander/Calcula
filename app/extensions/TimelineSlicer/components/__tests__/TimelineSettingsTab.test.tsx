//! FILENAME: app/extensions/TimelineSlicer/components/__tests__/TimelineSettingsTab.test.tsx
// PURPOSE: The timeline's Settings tab in the object pane (WP-C S11, D-PANE):
//            - the provider offers ONE build tab, "settings", headed by the
//              timeline's name;
//            - the tab renders the Timeline Settings body in its pane layout
//              (name + the two "show" toggles; header and style are the Format
//              tab's), and a change is ONE "Timeline Settings" step that sends
//              only that setting;
//            - the dialog still renders every field.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TimelineSlicer } from "../../lib/timelineSlicerTypes";

const h = vi.hoisted(() => ({
  current: undefined as TimelineSlicer | undefined,
  update: vi.fn(async (..._a: unknown[]) => null),
  steps: [] as string[],
}));

vi.mock("../../lib/timelineSlicerStore", () => ({
  getTimelineById: () => h.current,
  updateTimelineAsync: (...a: unknown[]) => h.update(...a),
}));
vi.mock("@api/gridOverlays", () => ({ requestOverlayRedraw: vi.fn() }));
vi.mock("@api/objectGeometry", () => ({
  runInUndoTransaction: async (label: string, fn: () => Promise<unknown>) => {
    h.steps.push(label);
    return fn();
  },
}));

import { TimelineSettingsTab } from "../TimelineSettingsTab";
import { TimelineSettingsBody, timelineSettingsValuesOf } from "../TimelineSettingsBody";
import { createTimelineObjectPaneProvider, TIMELINE_PANE_TAB_SETTINGS } from "../../lib/timelineObjectPane";

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
    stylePreset: "TimelineStyleLight1",
    connectedPivotIds: [],
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  h.current = timeline();
  h.update.mockClear();
  h.steps.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe("the timeline's object-pane provider", () => {
  it("one build tab, Settings, headed by the timeline's name", () => {
    const p = createTimelineObjectPaneProvider({ getTimeline: () => h.current });
    const region = {
      id: "timeline-slicer-t1",
      type: "timeline-slicer",
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
      data: { timelineId: "t1" },
    };
    expect(p.types).toEqual(["timeline-slicer"]);
    expect(p.tabs(region).map((t) => [t.id, t.label])).toEqual([[TIMELINE_PANE_TAB_SETTINGS, "Settings"]]);
    expect(p.headerOf!(region)).toBe("Timeline - Order Date");
  });
});

describe("the Settings tab", () => {
  it("the pane layout: name and the two show toggles; the header and the style are the Format tab's", async () => {
    await act(async () => {
      root.render(<TimelineSettingsTab timelineId="t1" readOnly={false} readOnlyReason={null} />);
    });
    expect(byTestId("timeline-settings-body")?.getAttribute("data-variant")).toBe("pane");
    expect(byTestId("timeline-setting-name")).not.toBeNull();
    expect(byTestId("timeline-setting-showLevelSelector")).not.toBeNull();
    expect(byTestId("timeline-setting-showHeader")).toBeNull();
  });

  it("a toggle is ONE 'Timeline Settings' step sending only that setting", async () => {
    await act(async () => {
      root.render(<TimelineSettingsTab timelineId="t1" readOnly={false} readOnlyReason={null} />);
    });
    await act(async () => {
      byTestId("timeline-setting-showScrollbar")!.click();
    });
    await flush();
    expect(h.steps).toEqual(["Timeline Settings"]);
    expect(h.update).toHaveBeenCalledWith("t1", { showScrollbar: false });
    expect(h.update).toHaveBeenCalledTimes(1);
  });

  it("the dialog layout still has every field", async () => {
    await act(async () => {
      root.render(<TimelineSettingsBody variant="dialog" values={timelineSettingsValuesOf(timeline())} onChange={() => {}} />);
    });
    expect(byTestId("timeline-setting-showHeader")).not.toBeNull();
    expect(container.textContent).toContain("Style:");
  });
});
