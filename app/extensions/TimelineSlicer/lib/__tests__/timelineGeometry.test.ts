//! FILENAME: app/extensions/TimelineSlicer/lib/__tests__/timelineGeometry.test.ts
// PURPOSE: Timeline geometry batches (M8 part C2): a co-move of several
//          timelines is ONE undo step (joined when a canvas group drag holds a
//          transaction open), a refusal re-reads the cache and is told ONCE,
//          and the geometry provider rejects a refusal for the seam to report.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const log: string[] = [];
vi.mock("../../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/core/lib/tauri-api")>()),
  beginUndoTransaction: vi.fn(async (label: string) => {
    log.push(`begin:${label}`);
  }),
  commitUndoTransaction: vi.fn(async () => {
    log.push("commit");
  }),
}));

const updateTimelinePosition = vi.fn(async (id: string, x: number, _y: number, _w: number, _h: number) => {
  await new Promise((r) => setTimeout(r, 0));
  log.push(`update:${id}:${x}`);
});
const getAllTimelineSlicers = vi.fn(async () => [] as unknown[]);
vi.mock("../timeline-slicer-api", () => ({
  updateTimelinePosition: (id: string, x: number, y: number, w: number, h: number) =>
    updateTimelinePosition(id, x, y, w, h),
  getAllTimelineSlicers: () => getAllTimelineSlicers(),
  getTimelineData: vi.fn(async () => null),
}));

const toasts: string[] = [];
vi.mock("@api/notifications", () => ({
  showToast: (message: string) => {
    toasts.push(message);
  },
}));

import { commitTimelineGeometryAsync } from "../timelineSlicerStore";
import { createTimelineGeometryProvider } from "../timelineGeometry";
import { openUndoTransaction, resetObjectGeometryProviders } from "@api/objectGeometry";
import type { GridRegion } from "@api/gridOverlays";

const w = (timelineId: string, x: number) => ({ timelineId, x, y: 10, width: 300, height: 120 });

beforeEach(() => {
  resetObjectGeometryProviders();
  log.length = 0;
  toasts.length = 0;
  updateTimelinePosition.mockClear();
  getAllTimelineSlicers.mockClear();
});

describe("commitTimelineGeometryAsync", () => {
  it("two timelines moved: ONE begin, every write, ONE commit last", async () => {
    expect(await commitTimelineGeometryAsync([w("t1", 1), w("t2", 2)], "Move Timelines")).toBe(true);
    expect(log).toEqual(["begin:Move Timelines", "update:t1:1", "update:t2:2", "commit"]);
  });

  it("joins an open transaction instead of committing it early", async () => {
    const outer = openUndoTransaction("Move Objects");
    await commitTimelineGeometryAsync([w("t1", 1)], "Move Timeline");
    expect(log).toEqual(["begin:Move Objects", "update:t1:1"]);
    await outer.commit();
    expect(log.filter((l) => l === "commit")).toHaveLength(1);
  });

  it("a refusal re-reads the cache and is told once", async () => {
    updateTimelinePosition.mockImplementationOnce(async () => {
      throw new Error("The sheet is protected.");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await commitTimelineGeometryAsync([w("t1", 1)], "Move Timeline")).toBe(false);
    errors.mockRestore();
    expect(getAllTimelineSlicers).toHaveBeenCalledTimes(1);
    expect(toasts).toHaveLength(1);
  });
});

describe("the timeline geometry provider", () => {
  it("co-moves its own selection and rejects a refusal", async () => {
    const p = createTimelineGeometryProvider();
    expect(p.coMovesOwnSelection).toBe(true);
    updateTimelinePosition.mockImplementationOnce(async () => {
      throw new Error("The sheet is protected.");
    });
    const region: GridRegion = {
      id: "timeline-slicer-t1",
      type: "timeline-slicer",
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
      floating: { x: 0, y: 0, width: 300, height: 120 },
      data: { timelineId: "t1" },
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(p.commit([{ region, x: 5, y: 5, width: 300, height: 120 }])).rejects.toThrow("protected");
    errors.mockRestore();
    expect(toasts).toEqual([]);
  });
});

describe("the Timeline's own gestures use the batch (source wiring)", () => {
  it("moveComplete (the co-move loop) and resizeComplete persist through ONE commitTimelineGeometryAsync", () => {
    const src = readFileSync(path.resolve(__dirname, "../../index.ts"), "utf8");
    for (const name of ["handleMoveComplete", "handleResizeComplete"]) {
      const at = src.indexOf(`const ${name} = (e: Event) => {`);
      expect(at).toBeGreaterThan(0);
      const body = src.slice(at, src.indexOf("\n  };\n", at));
      expect(body.match(/commitTimelineGeometryAsync\(/g)).toHaveLength(1);
      expect(body).not.toContain("updateTimelinePositionAsync");
      expect(body).not.toContain(".catch(console.error)");
    }
  });
});
