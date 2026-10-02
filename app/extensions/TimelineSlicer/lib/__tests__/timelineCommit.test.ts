//! FILENAME: app/extensions/TimelineSlicer/lib/__tests__/timelineCommit.test.ts
// PURPOSE: The ONE commit rule a timeline range gesture goes through
//          (lib/timelineCommit.ts `commitTimelineSpan`), moved out of the range
//          drag unchanged in M8 S8 so the keyboard inside a timeline shares it:
//            - a span whose DATES already are the timeline's range writes
//              nothing (no empty undo step) -- the dates, never the overlap
//              flags;
//            - any other span writes ONCE, asking before an overwrite, and
//              stays on screen until it lands;
//            - the anchor it leaves is remembered BY START DATE, at its level,
//              with the dates of the range it left -- and only while the range
//              shown still is exactly those dates;
//            - the memory is forgotten by its own reset AND by the drag's reset
//              (deactivation), which must keep calling it.
// CONTEXT: The drag's own behaviour (press, move, release, Shift+press) is
//          pinned in timelineRangeDrag.test.ts, unchanged by the extraction.

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  timeline: null as Record<string, unknown> | null,
  periods: [] as Array<Record<string, unknown>>,
  commits: [] as unknown[][],
  held: [] as Array<() => void>,
}));

vi.mock("../timelineSlicerStore", () => ({
  getTimelineById: (id: string) => (id === "t1" ? h.timeline ?? undefined : undefined),
  getCachedTimelineData: (id: string) => (id === "t1" ? { periods: h.periods } : undefined),
  updateTimelineSelectionAsync: (...args: unknown[]) => {
    h.commits.push(args);
    return new Promise<void>((resolve) => h.held.push(resolve));
  },
  updateTimelineAsync: vi.fn(async () => undefined),
}));

vi.mock("@api/gridOverlays", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestOverlayRedraw: vi.fn(),
}));

import { commitTimelineSpan, rememberedTimelineAnchor, resetTimelineCommit } from "../timelineCommit";
import { getTimelineRangePreview, resetTimelineGestureView } from "../timelineGestureView";
import { resetTimelineContentPress } from "../timelineRangeDrag";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Twelve months of 2026; `range` sets the committed DATES (whole months). */
function load(range: [number, number] | null = null): void {
  h.timeline = {
    id: "t1",
    name: "Date",
    level: "months",
    selectionStart: range ? `2026-${pad(range[0] + 1)}-01` : null,
    selectionEnd: range ? `2026-${pad(range[1] + 1)}-28` : null,
  };
  h.periods = Array.from({ length: 12 }, (_, i) => ({
    label: `M${i}`,
    groupLabel: "2026",
    startDate: `2026-${pad(i + 1)}-01`,
    endDate: `2026-${pad(i + 1)}-28`,
    hasData: true,
    isSelected: range ? i >= range[0] && i <= range[1] : false,
    index: i,
  }));
}

const P = (i: number) => h.periods[i] as { startDate: string; endDate: string };

/** The commit LANDS: the store carries its dates and flags, and its promise resolves. */
async function land(): Promise<void> {
  const c = h.commits[h.commits.length - 1] as [string, string, string];
  h.timeline!.selectionStart = c[1];
  h.timeline!.selectionEnd = c[2];
  for (const p of h.periods as Array<{ startDate: string; endDate: string; isSelected: boolean }>) {
    p.isSelected = p.startDate <= c[2] && p.endDate >= c[1];
  }
  for (const resolve of h.held.splice(0)) resolve();
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  resetTimelineCommit();
  resetTimelineGestureView();
  h.commits = [];
  h.held = [];
  load();
});

describe("commitTimelineSpan: the dates decide, one write", () => {
  it("a span whose DATES already are the range writes nothing and resolves at once", async () => {
    load([2, 4]);
    let done = false;
    void commitTimelineSpan("t1", { first: 2, last: 4 }, 2).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(h.commits, "an empty undo step: the range was already exactly these dates").toEqual([]);
    expect(done).toBe(true);
  });

  it("the overlap FLAGS do not decide: a partial range (Apr 5 - Apr 20) flags April, and committing April still writes it whole", () => {
    load([3, 3]);
    h.timeline!.selectionStart = "2026-04-05";
    h.timeline!.selectionEnd = "2026-04-20";
    void commitTimelineSpan("t1", { first: 3, last: 3 }, 3);
    expect(h.commits).toEqual([["t1", P(3).startDate, P(3).endDate, { askBeforeOverwrite: true }]]);
  });

  it("any other span writes ONCE, asking before an overwrite, and is shown until it lands", async () => {
    load([0, 0]);
    let landed = false;
    void commitTimelineSpan("t1", { first: 1, last: 3 }, 1).then(() => {
      landed = true;
    });
    expect(h.commits).toEqual([["t1", P(1).startDate, P(3).endDate, { askBeforeOverwrite: true }]]);
    expect(getTimelineRangePreview("t1"), "the committed range is not held on screen while it lands").toEqual({ first: 1, last: 3 });
    expect(landed).toBe(false);
    await land();
    expect(landed, "the promise did not resolve once the commit landed").toBe(true);
    expect(getTimelineRangePreview("t1"), "the landed range is still held").toBeNull();
  });

  it("a span past the periods writes nothing", () => {
    void commitTimelineSpan("t1", { first: 10, last: 12 }, 10);
    expect(h.commits).toEqual([]);
  });
});

describe("the anchor the commit leaves", () => {
  it("is remembered while the range shown is exactly the dates it left", async () => {
    void commitTimelineSpan("t1", { first: 2, last: 5 }, 5);
    await land();
    expect(rememberedTimelineAnchor("t1", "months", { first: 2, last: 5 })).toBe(5);
  });

  it("is remembered when the range ALREADY was those dates (nothing written)", () => {
    load([2, 5]);
    void commitTimelineSpan("t1", { first: 2, last: 5 }, 2);
    expect(h.commits).toEqual([]);
    expect(rememberedTimelineAnchor("t1", "months", { first: 2, last: 5 })).toBe(2);
  });

  it("is NOT used at another level, or once the range shown is other dates", async () => {
    void commitTimelineSpan("t1", { first: 2, last: 5 }, 5);
    await land();
    expect(rememberedTimelineAnchor("t1", "quarters", { first: 2, last: 5 })).toBeNull();
    expect(rememberedTimelineAnchor("t1", "months", { first: 1, last: 5 })).toBeNull();
  });

  it("is kept by START DATE: a refresh that adds a period in front moves its index, not its period", async () => {
    void commitTimelineSpan("t1", { first: 2, last: 5 }, 5);
    await land();
    h.periods = [
      { label: "D", groupLabel: "2025", startDate: "2025-12-01", endDate: "2025-12-28", hasData: true, isSelected: false, index: 0 },
      ...h.periods,
    ];
    expect(rememberedTimelineAnchor("t1", "months", { first: 3, last: 6 })).toBe(6);
  });

  it("its OWN reset forgets it", async () => {
    void commitTimelineSpan("t1", { first: 2, last: 5 }, 5);
    await land();
    resetTimelineCommit();
    expect(rememberedTimelineAnchor("t1", "months", { first: 2, last: 5 })).toBeNull();
  });

  it("the DRAG's reset (deactivation) forgets it too -- the extraction must keep that call", async () => {
    void commitTimelineSpan("t1", { first: 2, last: 5 }, 5);
    await land();
    expect(rememberedTimelineAnchor("t1", "months", { first: 2, last: 5 }), "fixture: remembered").toBe(5);
    resetTimelineContentPress();
    expect(
      rememberedTimelineAnchor("t1", "months", { first: 2, last: 5 }),
      "deactivation left the anchor: the next session's Shift+press extends from a stale period",
    ).toBeNull();
  });
});
