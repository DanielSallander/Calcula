//! FILENAME: app/e2e/__tests__/viewportSample.test.ts
// PURPOSE: Unit tier for the hover-safe pixel sampler -- the helper that exists
//          because `page.screenshot({ clip })` was measured ending a live hover,
//          which made the Charts live colour preview look broken for four
//          consecutive journey runs while the product was doing exactly the
//          right thing (docs/design/e2e-pixel-sampling.md; open-items §2.1).
//
//          SAY "MEASURED", NOT "CANCELS". A re-probe the same day on the same
//          machine could not reproduce the unearned `mouseleave` against two
//          hover state machines across seven clip geometries, and found a ~130 ms
//          timing gap between the clipped and unclipped paths instead -- which
//          fits the same symptom. `../viewportSample.ts` carries both accounts in
//          full. Nothing in this file depends on which one is right: the unclipped
//          capture is correct under either, and these are its unit guards.
//
// THE GUARD WITH THE TEETH IS `does not clip the capture`. The whole point of
// `samplePixels` is the thing it does NOT do, and "does not pass an option" is
// invisible to a type checker and to every green run on a page with no hover
// on it. So the capture is made against a fake page that RECORDS what it was
// handed, and the assertion is on the absence -- for EVERY exported sampler,
// from one table, so a tenth entry point added later cannot quietly reintroduce
// the clip.
//
// THE SECOND GUARD IS `one capture for many clips`. The multi-patch form is
// what nine journeys migrate onto, and it is not only a cost mitigation: two
// patches taken by two captures are two frames, and a repaint between them
// splits the evidence. "One screenshot" is again an absence -- of the second
// call -- so it is asserted by counting, not by reading the code.

import { describe, it, expect } from "vitest";
import type { Page } from "@playwright/test";
import {
  deviceCropRect,
  diffCount,
  rectFitsInside,
  samplePixelGrid,
  samplePixelGrids,
  samplePixelPatches,
  samplePixels,
  type PixelClip,
} from "../viewportSample";

// ---------------------------------------------------------------------------
// deviceCropRect: CSS pixels -> the device pixels an unclipped capture is in
// ---------------------------------------------------------------------------

describe("deviceCropRect", () => {
  it("is the identity at dpr 1", () => {
    expect(deviceCropRect({ x: 10, y: 20, width: 12, height: 12 }, 1)).toEqual({
      x: 10,
      y: 20,
      width: 12,
      height: 12,
    });
  });

  it("scales origin and extent together at dpr 2", () => {
    expect(deviceCropRect({ x: 305, y: 541, width: 12, height: 12 }, 2)).toEqual({
      x: 610,
      y: 1082,
      width: 24,
      height: 24,
    });
  });

  // THE REASON THE EXTENT IS COMPUTED FROM THE ROUNDED EDGES. Scaling the
  // WIDTH instead would give `round(12 * 1.5) = 18` here and `18` there, and
  // the two samples would still agree -- but at a half-pixel origin the edges
  // land differently and the sizes diverge by one, which surfaces as
  // `diffCount` throwing "the clip moved" on a chart that never moved.
  it("keeps two samples the same size at a fractional dpr and a half-pixel origin", () => {
    const a = deviceCropRect({ x: 100.5, y: 40.5, width: 13, height: 13 }, 1.5);
    const b = deviceCropRect({ x: 100.5, y: 40.5, width: 13, height: 13 }, 1.5);
    expect(a).toEqual(b);
    expect(a.width).toBe(Math.round((100.5 + 13) * 1.5) - Math.round(100.5 * 1.5));
  });

  it("never yields a zero-sized read", () => {
    const r = deviceCropRect({ x: 0, y: 0, width: 0, height: 0 }, 2);
    expect(r.width).toBeGreaterThanOrEqual(1);
    expect(r.height).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// rectFitsInside: the refusal that replaces the clip's own "outside the image"
// ---------------------------------------------------------------------------

describe("rectFitsInside", () => {
  it("accepts a rectangle flush against both far edges", () => {
    expect(rectFitsInside({ x: 0, y: 0, width: 2560, height: 1600 }, 2560, 1600)).toBe(true);
    expect(rectFitsInside({ x: 2536, y: 1576, width: 24, height: 24 }, 2560, 1600)).toBe(true);
  });

  it("refuses a rectangle that runs one pixel past the edge", () => {
    expect(rectFitsInside({ x: 2537, y: 1576, width: 24, height: 24 }, 2560, 1600)).toBe(false);
    expect(rectFitsInside({ x: 2536, y: 1577, width: 24, height: 24 }, 2560, 1600)).toBe(false);
  });

  it("refuses a negative origin", () => {
    expect(rectFitsInside({ x: -1, y: 0, width: 10, height: 10 }, 100, 100)).toBe(false);
    expect(rectFitsInside({ x: 0, y: -1, width: 10, height: 10 }, 100, 100)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The page double
// ---------------------------------------------------------------------------

interface FakePage {
  page: Page;
  screenshotCalls: Array<unknown>;
  evaluateArgs: Array<unknown>;
}

/**
 * A page double that records the screenshot options and echoes crops back.
 *
 * The decode evaluate is answered with one array per requested rect, filled
 * with the rect's own index, so a test can tell the samples apart; the bitmap
 * it claims is big enough for every rect these tests use unless a test asks
 * for a small one.
 */
function fakePage(bitmap = { width: 2560, height: 1600 }): FakePage {
  const screenshotCalls: Array<unknown> = [];
  const evaluateArgs: Array<unknown> = [];
  let evaluateCall = 0;
  const page = {
    screenshot: (options?: unknown): Promise<Buffer> => {
      screenshotCalls.push(options);
      return Promise.resolve(Buffer.from("not-a-real-png"));
    },
    evaluate: (_fn: unknown, arg?: unknown): Promise<unknown> => {
      evaluateCall += 1;
      // Call 1 is the devicePixelRatio read; call 2 is the decode+crop, and
      // its argument is what the assertions below are about.
      if (evaluateCall === 1) return Promise.resolve(2);
      evaluateArgs.push(arg);
      const { rects } = arg as { rects: PixelClip[] };
      return Promise.resolve({
        samples: rects.map((_r, i) => [i, i, i, 255]),
        bitmap,
      });
    },
  } as unknown as Page;
  return { page, screenshotCalls, evaluateArgs };
}

// ---------------------------------------------------------------------------
// EVERY sampler must capture UNCLIPPED
// ---------------------------------------------------------------------------

const CLIP: PixelClip = { x: 305, y: 541, width: 12, height: 12 };
const OTHER: PixelClip = { x: 40, y: 40, width: 30, height: 20 };

/** One row per exported entry point. A new sampler belongs in this table. */
const SAMPLERS: Array<{ name: string; run: (page: Page) => Promise<unknown> }> = [
  { name: "samplePixels", run: (p) => samplePixels(p, CLIP) },
  { name: "samplePixelGrid", run: (p) => samplePixelGrid(p, CLIP) },
  { name: "samplePixelGrids", run: (p) => samplePixelGrids(p, [CLIP, OTHER]) },
  { name: "samplePixelPatches", run: (p) => samplePixelPatches(p, [CLIP, OTHER]) },
];

describe.each(SAMPLERS)("$name", ({ run }) => {
  it("does not clip the capture -- a clipped capture moves the viewport and cancels a live hover", async () => {
    const { page, screenshotCalls } = fakePage();
    await run(page);
    expect(screenshotCalls).toHaveLength(1);
    // Undefined, or at any rate carrying no `clip`. Either spelling is safe;
    // a `clip` of any shape is the defect this helper was written to remove.
    const options = screenshotCalls[0] as Record<string, unknown> | undefined;
    expect(options === undefined || options.clip === undefined).toBe(true);
  });
});

describe("samplePixelGrids", () => {
  it("takes ONE capture for many clips -- two captures are two frames", async () => {
    const { page, screenshotCalls, evaluateArgs } = fakePage();
    await samplePixelGrids(page, [CLIP, OTHER, CLIP]);
    expect(screenshotCalls, "three clips, one screenshot").toHaveLength(1);
    expect(evaluateArgs, "and one decode round trip").toHaveLength(1);
  });

  it("crops in DEVICE pixels, from the page's own dpr", async () => {
    const { page, evaluateArgs } = fakePage();
    await samplePixelGrids(page, [CLIP, OTHER]);
    const arg = evaluateArgs[0] as { b64: string; rects: PixelClip[] };
    expect(arg.rects).toEqual([deviceCropRect(CLIP, 2), deviceCropRect(OTHER, 2)]);
    expect(arg.b64).toBe(Buffer.from("not-a-real-png").toString("base64"));
  });

  it("returns the samples in the order they were asked for, with their geometry", async () => {
    const { page } = fakePage();
    const out = await samplePixelGrids(page, [CLIP, OTHER]);
    expect(out.map((s) => s.data)).toEqual([
      [0, 0, 0, 255],
      [1, 1, 1, 255],
    ]);
    expect(out[0].width).toBe(24);
    expect(out[0].height).toBe(24);
    // Device pixels per CSS pixel: what a measurement in `data` columns must be
    // divided by before it is compared against a CSS length.
    expect(out[0].scale).toBe(2);
    expect(out[1].scale).toBe(2);
  });

  it("asks the page for nothing at all when given no clips", async () => {
    const { page, screenshotCalls } = fakePage();
    await expect(samplePixelGrids(page, [])).resolves.toEqual([]);
    expect(screenshotCalls).toHaveLength(0);
  });

  // THE REFUSAL THAT REPLACES THE CLIP'S OWN. `page.screenshot({ clip })`
  // throws "Clipped area is either empty or outside the resulting image" when
  // the rectangle leaves the viewport; `drawImage` instead returns transparent
  // black, and two blanks compare equal. A sample that is not on screen must
  // fail loudly, not quietly.
  it("throws when the crop is not fully inside the capture", async () => {
    const { page } = fakePage({ width: 800, height: 600 });
    await expect(samplePixels(page, { x: 380, y: 280, width: 40, height: 40 })).rejects.toThrow(
      /not fully on screen/,
    );
  });

  it("names the offending clip, the device rect and the capture in the refusal", async () => {
    const { page } = fakePage({ width: 800, height: 600 });
    await expect(
      samplePixelGrids(page, [{ x: 0, y: 0, width: 10, height: 10 }, { x: 390, y: 10, width: 20, height: 20 }]),
    ).rejects.toThrow(/800x600/);
  });
});

describe("samplePixels", () => {
  it("returns the flat RGBA the page decoded", async () => {
    const { page } = fakePage();
    await expect(samplePixels(page, CLIP)).resolves.toEqual([0, 0, 0, 255]);
  });
});

// ---------------------------------------------------------------------------
// diffCount: the one copy of what used to live in nine specs
// ---------------------------------------------------------------------------

describe("diffCount", () => {
  const solid = (n: number, v: number): number[] => Array.from({ length: n * 4 }, (_, i) => (i % 4 === 3 ? 255 : v));

  it("counts nothing when two samples are identical", () => {
    expect(diffCount(solid(16, 10), solid(16, 10))).toBe(0);
  });

  it("counts a pixel per differing pixel, not per differing channel", () => {
    const a = solid(4, 0);
    const b = solid(4, 0);
    b[0] = 200;
    b[1] = 200;
    b[2] = 200; // one pixel, three channels
    expect(diffCount(a, b)).toBe(1);
  });

  // THE THRESHOLD IS EXCLUSIVE, AND EVERY JOURNEY'S NUMBERS WERE TUNED TO
  // THAT. A difference of exactly 8 is the compression/antialiasing hair the
  // old nine copies all ignored; making the comparison inclusive would count
  // it and shift every "greater than 0" and "less than 20" gate in the tree.
  it("ignores a difference of exactly the tolerance and counts one more", () => {
    const a = solid(1, 100);
    const at8 = solid(1, 108);
    const at9 = solid(1, 109);
    expect(diffCount(a, at8)).toBe(0);
    expect(diffCount(a, at9)).toBe(1);
  });

  it("never compares alpha -- a screenshot is opaque and alpha is noise", () => {
    const a = solid(2, 50);
    const b = solid(2, 50);
    b[3] = 0;
    b[7] = 0;
    expect(diffCount(a, b)).toBe(0);
  });

  it("refuses two samples of different sizes rather than returning a number", () => {
    expect(() => diffCount(solid(4, 0), solid(5, 0))).toThrow(/the clip moved/);
  });

  it("names the dimensions when it is given PixelSamples", () => {
    const a = { data: solid(4, 0), width: 2, height: 2, scale: 2 };
    const b = { data: solid(9, 0), width: 3, height: 3, scale: 2 };
    expect(() => diffCount(a, b)).toThrow(/2x2 vs 3x3/);
  });

  it("accepts a PixelSample on either side, so a migrated spec can mix the shapes", () => {
    const a = { data: solid(4, 0), width: 2, height: 2, scale: 2 };
    const b = solid(4, 0);
    b[0] = 255;
    expect(diffCount(a, b)).toBe(1);
    expect(diffCount(b, a)).toBe(1);
  });
});
