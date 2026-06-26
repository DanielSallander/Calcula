//! FILENAME: app/src/api/scriptHost/__tests__/renderCacheChartMark.test.ts
// PURPOSE: B8.D — the renderCache bitmap layer gains a 'chartMark' kind. Verify
//          store/get/clear round-trip, that superseding a key closes the old
//          bitmap (no GPU leak), and that storing a chartMark bitmap fires the
//          "chartMark:bitmapReady" signal the Charts extension listens for (so a
//          version-gated chart raster re-renders) — without it the worker pixels
//          would never composite.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { storeBitmap, getBitmap, invalidateBitmap, clearBitmapCaches } from "../renderCache";

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
