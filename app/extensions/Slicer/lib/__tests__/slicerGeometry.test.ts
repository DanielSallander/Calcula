//! FILENAME: app/extensions/Slicer/lib/__tests__/slicerGeometry.test.ts
// PURPOSE: Slicer geometry batches (M8 part C2): a co-move of several slicers,
//          and the Size fields applied to several, are ONE undo step (one
//          begin, every write, one commit -- joined when a canvas group drag
//          already holds a transaction open); a backend refusal is NOT left
//          standing (the cache is re-read) and is told ONCE; and the geometry
//          provider rejects a refusal for the seam to report.

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

const updateSlicerPosition = vi.fn(async (id: string, x: number, _y: number, _w: number, _h: number) => {
  await new Promise((r) => setTimeout(r, 0));
  log.push(`update:${id}:${x}`);
});
const getAllSlicers = vi.fn(async () => [] as unknown[]);
vi.mock("../slicer-api", () => ({
  updateSlicerPosition: (id: string, x: number, y: number, w: number, h: number) => updateSlicerPosition(id, x, y, w, h),
  getAllSlicers: () => getAllSlicers(),
  getSlicerItems: vi.fn(async () => []),
}));

const toasts: string[] = [];
vi.mock("@api/notifications", () => ({
  showToast: (message: string) => {
    toasts.push(message);
  },
}));

import { commitSlicerGeometryAsync } from "../slicerStore";
import { createSlicerGeometryProvider } from "../slicerGeometry";
import { openUndoTransaction, resetObjectGeometryProviders } from "@api/objectGeometry";
import type { GridRegion } from "@api/gridOverlays";

const w = (slicerId: string, x: number) => ({ slicerId, x, y: 10, width: 180, height: 240 });

beforeEach(() => {
  resetObjectGeometryProviders();
  log.length = 0;
  toasts.length = 0;
  updateSlicerPosition.mockClear();
  getAllSlicers.mockClear();
});

describe("commitSlicerGeometryAsync", () => {
  it("three slicers moved: ONE begin, every write in order, ONE commit last", async () => {
    expect(await commitSlicerGeometryAsync([w("a", 1), w("b", 2), w("c", 3)], "Move Slicers")).toBe(true);
    expect(log).toEqual(["begin:Move Slicers", "update:a:1", "update:b:2", "update:c:3", "commit"]);
    expect(toasts).toEqual([]);
  });

  it("inside a canvas group drag's open transaction it JOINS: no begin/commit of its own", async () => {
    const outer = openUndoTransaction("Move Objects");
    await commitSlicerGeometryAsync([w("a", 1), w("b", 2)], "Move Slicers");
    expect(log).toEqual(["begin:Move Objects", "update:a:1", "update:b:2"]);
    await outer.commit();
    expect(log.at(-1)).toBe("commit");
    expect(log.filter((l) => l === "commit")).toHaveLength(1);
  });

  it("a REFUSED write re-reads the cache (no moved-looking slicer) and is told ONCE", async () => {
    updateSlicerPosition.mockImplementationOnce(async () => {
      throw new Error("The sheet is protected.");
    });
    updateSlicerPosition.mockImplementationOnce(async () => {
      throw new Error("The sheet is protected.");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await commitSlicerGeometryAsync([w("a", 1), w("b", 2)], "Move Slicers")).toBe(false);
    errors.mockRestore();
    expect(getAllSlicers).toHaveBeenCalledTimes(1);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain("The sheet is protected.");
    expect(log.filter((l) => l.startsWith("begin"))).toHaveLength(1);
    expect(log.at(-1)).toBe("commit");
  });
});

describe("the slicer geometry provider", () => {
  const region = (id: string): GridRegion => ({
    id: `slicer-${id}`,
    type: "slicer",
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 0, y: 0, width: 180, height: 240 },
    data: { slicerId: id },
  });

  it("co-moves its own selection, and REJECTS a refusal for the seam to report (no toast of its own)", async () => {
    const p = createSlicerGeometryProvider();
    expect(p.coMovesOwnSelection).toBe(true);
    updateSlicerPosition.mockImplementationOnce(async () => {
      throw new Error("The sheet is protected.");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(p.commit([{ region: region("a"), x: 5, y: 5, width: 180, height: 240 }])).rejects.toThrow(
      "The sheet is protected.",
    );
    errors.mockRestore();
    expect(toasts).toEqual([]);
    expect(getAllSlicers).toHaveBeenCalledTimes(1);
  });
});

describe("Slicer's own gestures use the batch (source wiring)", () => {
  const src = readFileSync(path.resolve(__dirname, "../../index.ts"), "utf8");
  const handler = (name: string) => {
    const at = src.indexOf(`const ${name} = (e: Event) => {`);
    expect(at).toBeGreaterThan(0);
    return src.slice(at, src.indexOf("\n  };\n", at));
  };

  it("moveComplete (the co-move loop) and resizeComplete persist through ONE commitSlicerGeometryAsync", () => {
    for (const name of ["handleMoveComplete", "handleResizeComplete"]) {
      const body = handler(name);
      expect(body.match(/commitSlicerGeometryAsync\(/g)).toHaveLength(1);
      expect(body).not.toContain("updateSlicerPositionAsync");
      expect(body).not.toContain(".catch(console.error)");
    }
  });

  it("the Size fields apply one batch to every selected slicer", () => {
    const sizes = readFileSync(path.resolve(__dirname, "../../components/SlicerOptionsSections.tsx"), "utf8");
    expect(sizes).not.toContain("updateSlicerPositionAsync");
    expect(sizes.match(/commitSlicerGeometryAsync\(writes/g)).toHaveLength(2);
  });
});
