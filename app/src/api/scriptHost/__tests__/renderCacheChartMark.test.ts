//! FILENAME: app/src/api/scriptHost/__tests__/renderCacheChartMark.test.ts
// PURPOSE: B8.D — the renderCache bitmap layer gains a 'chartMark' kind. Verify
//          store/get/clear round-trip, that superseding a key closes the old
//          bitmap (no GPU leak), and that storing a chartMark bitmap fires the
//          "chartMark:bitmapReady" signal the Charts extension listens for (so a
//          version-gated chart raster re-renders) — without it the worker pixels
//          would never composite.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  storeBitmap,
  getBitmap,
  invalidateBitmap,
  clearBitmapCaches,
  getChartMarkGeometry,
  sanitizeSandboxGeometry,
} from "../renderCache";
import { MAX_SANDBOX_HIT_RECTS } from "../protocol";

/** A stand-in ImageBitmap — only .close()/.width/.height are touched here. */
function fakeBitmap(w = 10, h = 10) {
  return { width: w, height: h, close: vi.fn() } as unknown as ImageBitmap;
}

beforeEach(() => clearBitmapCaches());

describe("renderCache chartMark kind (B8.D)", () => {
  it("stores and retrieves a chartMark bitmap by key", () => {
    const bmp = fakeBitmap();
    storeBitmap("chartMark", "sandbox:demo:abc:480x320", { bitmap: bmp, w: 480, h: 320, dpr: 1 });
    expect(getBitmap("chartMark", "sandbox:demo:abc:480x320")?.bitmap).toBe(bmp);
    expect(getBitmap("chartMark", "nope")).toBeUndefined();
  });

  it("closes the prior bitmap when a key is superseded (no leak)", () => {
    const first = fakeBitmap();
    const second = fakeBitmap();
    storeBitmap("chartMark", "k", { bitmap: first, w: 1, h: 1, dpr: 1 });
    storeBitmap("chartMark", "k", { bitmap: second, w: 1, h: 1, dpr: 1 });
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(getBitmap("chartMark", "k")?.bitmap).toBe(second);
  });

  it("invalidateBitmap drops + closes a chartMark entry", () => {
    const bmp = fakeBitmap();
    storeBitmap("chartMark", "k", { bitmap: bmp, w: 1, h: 1, dpr: 1 });
    invalidateBitmap("chartMark", "k");
    expect(bmp.close).toHaveBeenCalledTimes(1);
    expect(getBitmap("chartMark", "k")).toBeUndefined();
  });

  it("clearBitmapCaches closes + clears chartMark bitmaps", () => {
    const bmp = fakeBitmap();
    storeBitmap("chartMark", "k", { bitmap: bmp, w: 1, h: 1, dpr: 1 });
    clearBitmapCaches();
    expect(bmp.close).toHaveBeenCalledTimes(1);
    expect(getBitmap("chartMark", "k")).toBeUndefined();
  });

  it("fires 'chartMark:bitmapReady' on a chartMark store (so the chart re-renders)", () => {
    const ready = vi.fn();
    window.addEventListener("chartMark:bitmapReady", ready);
    storeBitmap("chartMark", "k", { bitmap: fakeBitmap(), w: 1, h: 1, dpr: 1 });
    expect(ready).toHaveBeenCalledTimes(1);
    window.removeEventListener("chartMark:bitmapReady", ready);
  });

  it("does NOT fire 'chartMark:bitmapReady' for shape/slicer stores", () => {
    const ready = vi.fn();
    window.addEventListener("chartMark:bitmapReady", ready);
    storeBitmap("shape", "s", { bitmap: fakeBitmap(), w: 1, h: 1, dpr: 1 });
    storeBitmap("slicerItem", "sl:a:b:c:1x1", { bitmap: fakeBitmap(), w: 1, h: 1, dpr: 1 });
    expect(ready).not.toHaveBeenCalled();
    window.removeEventListener("chartMark:bitmapReady", ready);
  });
});

describe("chartMark hit geometry (Feature 2)", () => {
  it("stores + retrieves geometry alongside the bitmap, keyed the same", () => {
    const geo = { rects: [{ x: 1, y: 2, w: 3, h: 4, seriesIndex: 0, categoryIndex: 1, value: 9 }] };
    storeBitmap("chartMark", "k", { bitmap: fakeBitmap(), w: 10, h: 10, dpr: 1, geometry: geo });
    expect(getChartMarkGeometry("k")).toEqual(geo);
  });

  it("returns undefined geometry for a bitmap stored without it", () => {
    storeBitmap("chartMark", "k", { bitmap: fakeBitmap(), w: 10, h: 10, dpr: 1 });
    expect(getChartMarkGeometry("k")).toBeUndefined();
    expect(getChartMarkGeometry("missing")).toBeUndefined();
  });
});

describe("sanitizeSandboxGeometry (untrusted mark geometry)", () => {
  it("clamps rects to the bitmap bounds", () => {
    const out = sanitizeSandboxGeometry({ rects: [{ x: -5, y: -5, w: 200, h: 200 }] }, 100, 80);
    expect(out).toEqual({ rects: [{ x: 0, y: 0, w: 100, h: 80 }] });
  });

  it("drops rects with non-finite coordinates", () => {
    const out = sanitizeSandboxGeometry(
      { rects: [{ x: NaN, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: Infinity, h: 10 }, { x: 1, y: 1, w: 5, h: 5 }] },
      100, 100,
    );
    expect(out).toEqual({ rects: [{ x: 1, y: 1, w: 5, h: 5 }] });
  });

  it("drops zero/negative-area rects (e.g. entirely outside the plot)", () => {
    const out = sanitizeSandboxGeometry({ rects: [{ x: 200, y: 200, w: 10, h: 10 }, { x: 5, y: 5, w: 0, h: 10 }] }, 100, 100);
    expect(out).toBeUndefined();
  });

  it("keeps and sanitizes optional label/index/value fields", () => {
    const out = sanitizeSandboxGeometry(
      { rects: [{ x: 0, y: 0, w: 10, h: 10, seriesIndex: 2, categoryIndex: 3, value: 42, seriesName: "S", categoryName: "C" }] },
      100, 100,
    );
    expect(out?.rects[0]).toMatchObject({ seriesIndex: 2, categoryIndex: 3, value: 42, seriesName: "S", categoryName: "C" });
  });

  it("drops non-finite optional numeric fields but keeps the rect", () => {
    const out = sanitizeSandboxGeometry({ rects: [{ x: 0, y: 0, w: 10, h: 10, seriesIndex: NaN, value: Infinity }] }, 100, 100);
    expect(out?.rects[0]).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });

  it("caps the rect count at MAX_SANDBOX_HIT_RECTS", () => {
    const many = Array.from({ length: MAX_SANDBOX_HIT_RECTS + 50 }, () => ({ x: 0, y: 0, w: 1, h: 1 }));
    const out = sanitizeSandboxGeometry({ rects: many }, 100, 100);
    expect(out?.rects.length).toBe(MAX_SANDBOX_HIT_RECTS);
  });

  it("bounds the INPUT scan so an all-invalid giant array can't pin the loop", () => {
    // All rects are zero-area -> none survive, so the output cap never fires; the
    // INPUT-scan bound (Math.min(len, MAX)) is what keeps this from scanning all 1e6.
    const huge = Array.from({ length: 1_000_000 }, () => ({ x: 0, y: 0, w: 0, h: 0 }));
    const out = sanitizeSandboxGeometry({ rects: huge }, 100, 100);
    expect(out).toBeUndefined();
  });

  it("returns undefined for an empty / malformed geometry", () => {
    expect(sanitizeSandboxGeometry({ rects: [] }, 10, 10)).toBeUndefined();
    expect(sanitizeSandboxGeometry({ rects: [null, "x", 5] as never }, 10, 10)).toBeUndefined();
  });
});
