//! FILENAME: app/extensions/TimelineSlicer/components/__tests__/TimelineSlicerOptionsTab.test.tsx
// PURPOSE: The contextual Timeline tab's three sections on the Calcula
//          Clusters control grammar: no hardcoded colour in the band or a
//          panel; each band section is ONE TALL ROW (the fill rule); the time
//          level is one SegmentedChoice radio group rather than a row of loose
//          toggles; Clear Filter is really disabled when there is nothing to
//          clear; and every control still does what it did.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  type SurfaceLayout,
} from "@api/layout";
import type { TimelineSlicer } from "../../lib/timelineSlicerTypes";

// ---------------------------------------------------------------------------
// Mocks — the sections' whole outside world
// ---------------------------------------------------------------------------

const mockShowDialog = vi.fn();
vi.mock("@api", () => ({
  showDialog: (...a: unknown[]) => mockShowDialog(...a),
}));

vi.mock("@api/gridOverlays", () => ({
  requestOverlayRedraw: vi.fn(),
}));

let selectedTimeline: TimelineSlicer | null = null;
const mockUpdateTimeline = vi.fn(async (_id: string, patch: Partial<TimelineSlicer>) =>
  selectedTimeline ? { ...selectedTimeline, ...patch } : null,
);
const mockDeleteTimeline = vi.fn(async (..._a: unknown[]) => undefined);
const mockUpdateSelection = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("../../lib/timelineSlicerStore", () => ({
  getTimelineById: () => selectedTimeline ?? undefined,
  updateTimelineAsync: (id: string, patch: Partial<TimelineSlicer>) => mockUpdateTimeline(id, patch),
  deleteTimelineAsync: (...a: unknown[]) => mockDeleteTimeline(...a),
  updateTimelineSelectionAsync: (...a: unknown[]) => mockUpdateSelection(...a),
}));

vi.mock("../../handlers/selectionHandler", () => ({
  getSelectedTimelineId: () => selectedTimeline?.id ?? null,
}));

vi.mock("../../manifest", () => ({
  TIMELINE_SETTINGS_DIALOG_ID: "timelineSlicer:settingsDialog",
}));

import {
  TimelineLevelSection,
  TimelineFilterSection,
  TimelineActionsSection,
} from "../TimelineSlicerOptionsTab";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

function timeline(overrides: Partial<TimelineSlicer> = {}): TimelineSlicer {
  return {
    id: "tl-1",
    name: "Order Date",
    headerText: null,
    sheetIndex: 0,
    x: 10,
    y: 10,
    width: 320,
    height: 110,
    sourceType: "pivot",
    sourceId: "p-1",
    fieldName: "OrderDate",
    level: "months",
    selectionStart: "2024-01-01",
    selectionEnd: "2024-03-31",
    showHeader: true,
    showLevelSelector: true,
    showScrollbar: true,
    stylePreset: "timeline-light-1",
    connectedPivotIds: ["p-1"],
    ...overrides,
  } as TimelineSlicer;
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  selectedTimeline = timeline();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

type SectionComponent = () => React.ReactElement | null;

function mount(Section: SectionComponent, layout: SurfaceLayout): void {
  act(() => {
    root.render(
      <SurfaceLayoutProvider value={layout}>
        <Section />
      </SurfaceLayoutProvider>,
    );
  });
}

async function clickAsync(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!btn) throw new Error(`no button with text "${text}"`);
  return btn;
}

const SECTIONS: Array<[string, SectionComponent]> = [
  ["Level", TimelineLevelSection],
  ["Filter", TimelineFilterSection],
  ["Timeline", TimelineActionsSection],
];

const LAYOUTS: Array<[string, SurfaceLayout]> = [
  ["band", bandLayout()],
  ["panel", panelLayout(300)],
];

// ============================================================================
// Chrome
// ============================================================================

describe("Timeline sections — chrome", () => {
  for (const [sectionName, Section] of SECTIONS) {
    for (const [layoutName, layout] of LAYOUTS) {
      it(`${sectionName} paints no hardcoded colour in the ${layoutName}`, () => {
        mount(Section, layout);
        expect(container.childElementCount).toBeGreaterThan(0);
        expect(findHardcodedColours(container)).toEqual([]);
      });

      it(`${sectionName} draws its icons from the 24-grid set and fakes no state in the ${layoutName}`, () => {
        selectedTimeline = timeline({ selectionStart: null, selectionEnd: null });
        mount(Section, layout);
        for (const svg of Array.from(container.querySelectorAll("svg"))) {
          // RibbonIcon drawings and the primitives' chevrons are all 24-grid.
          expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
        }
        for (const el of Array.from(container.querySelectorAll<HTMLElement>("*"))) {
          expect(el.style.opacity).toBe("");
        }
        // No unicode glyph standing in for an icon (the old "✖").
        expect(container.textContent).not.toMatch(/[✀-➿]/);
      });
    }
  }

  it("renders nothing while no timeline is selected", () => {
    selectedTimeline = null;
    for (const [, Section] of SECTIONS) {
      mount(Section, bandLayout());
      expect(container.childElementCount).toBe(0);
    }
  });
});

// ============================================================================
// The fill rule
// ============================================================================

describe("Timeline sections — the fill rule in the band", () => {
  it("Level is one TALL radio group, not a row of short toggles", () => {
    mount(TimelineLevelSection, bandLayout());
    const group = container.querySelector('[role="radiogroup"]') as HTMLElement;
    expect(group).not.toBeNull();
    expect(group.getAttribute("aria-label")).toBe("Time level");
    expect(group.getAttribute("data-size")).toBe("tall");
    expect(group.style.height).toBe("61px");
    const radios = Array.from(group.querySelectorAll('[role="radio"]'));
    expect(radios.map((r) => r.textContent)).toEqual(["Years", "Quarters", "Months", "Days"]);
    expect(container.querySelector("[aria-pressed]")).toBeNull();
  });

  it("Level is a standard 28px pill outside the band", () => {
    mount(TimelineLevelSection, panelLayout(300));
    const group = container.querySelector('[role="radiogroup"]') as HTMLElement;
    expect(group.getAttribute("data-size")).toBe("md");
  });

  it("Filter and Timeline are rows of heroes", () => {
    mount(TimelineFilterSection, bandLayout());
    expect(buttonByText("Clear Filter").querySelector("svg")?.getAttribute("width")).toBe("30");

    mount(TimelineActionsSection, bandLayout());
    const heroes = Array.from(container.querySelectorAll("button"));
    expect(heroes.map((b) => b.textContent)).toEqual(["Settings", "Delete"]);
    for (const b of heroes) {
      expect(b.querySelector("svg")?.getAttribute("width")).toBe("30");
    }
  });
});

// ============================================================================
// Behaviour
// ============================================================================

describe("Timeline sections — behaviour", () => {
  it("the checked level follows the timeline, and choosing one updates it", async () => {
    mount(TimelineLevelSection, bandLayout());
    const checked = container.querySelector('[role="radio"][aria-checked="true"]');
    expect(checked?.textContent).toBe("Months");

    const quarters = Array.from(container.querySelectorAll('[role="radio"]')).find(
      (r) => r.textContent === "Quarters",
    )!;
    await clickAsync(quarters);
    expect(mockUpdateTimeline).toHaveBeenCalledWith("tl-1", { level: "quarters" });
    expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe("Quarters");
  });

  it("arrow keys move the level (one radio group, one tab stop)", async () => {
    mount(TimelineLevelSection, bandLayout());
    const radios = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    expect(radios.filter((r) => r.tabIndex === 0)).toHaveLength(1);
    const months = radios.find((r) => r.textContent === "Months")!;
    await act(async () => {
      months.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await Promise.resolve();
    });
    expect(mockUpdateTimeline).toHaveBeenCalledWith("tl-1", { level: "days" });
  });

  it("Clear Filter clears the selected range", async () => {
    mount(TimelineFilterSection, bandLayout());
    const clear = buttonByText("Clear Filter");
    expect(clear.disabled).toBe(false);
    await clickAsync(clear);
    // A user gesture: it asks before a clear that overwrites (the review of S2).
    expect(mockUpdateSelection).toHaveBeenCalledWith("tl-1", null, null, { askBeforeOverwrite: true });
  });

  it("Clear Filter is really disabled when the timeline has no filter", () => {
    selectedTimeline = timeline({ selectionStart: null, selectionEnd: null });
    mount(TimelineFilterSection, bandLayout());
    expect(buttonByText("Clear Filter").disabled).toBe(true);
  });

  it("Settings opens the dialog and Delete deletes the timeline", async () => {
    mount(TimelineActionsSection, panelLayout(300));
    await clickAsync(buttonByText("Settings"));
    expect(mockShowDialog).toHaveBeenCalledWith("timelineSlicer:settingsDialog", { timelineId: "tl-1" });
    await clickAsync(buttonByText("Delete"));
    expect(mockDeleteTimeline).toHaveBeenCalledWith("tl-1");
  });
});
