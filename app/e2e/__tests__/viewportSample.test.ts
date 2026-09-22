//! FILENAME: app/e2e/__tests__/viewportSample.test.ts
// PURPOSE: Unit tier for the hover-safe pixel sampler -- the helper that exists
//          because `page.screenshot({ clip })` CANCELS a live hover, which made
//          the Charts live colour preview look broken for four consecutive
//          journey runs while the product was doing exactly the right thing
//          (docs/design/chart-interaction.md, Wave V; open-items §2.1).
//
// THE GUARD WITH THE TEETH IS `does not clip the capture`. The whole point of
// `samplePixels` is the thing it does NOT do, and "does not pass an option" is
// invisible to a type checker and to every green run on a page with no hover
// on it. So the capture is made against a fake page that RECORDS what it was
// handed, and the assertion is on the absence.

import { describe, it, expect } from "vitest";
import type { Page } from "@playwright/test";
import { deviceCropRect, samplePixels, type PixelClip } from "../viewportSample";

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
// samplePixels: the capture must be UNCLIPPED
// ---------------------------------------------------------------------------

/** A page double that records the screenshot options and echoes the crop back. */
function fakePage(): {
  page: Page;
  screenshotCalls: Array<unknown>;
  evaluateArgs: Array<unknown>;
} {
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
      return Promise.resolve([1, 2, 3, 4]);
    },
  } as unknown as Page;
  return { page, screenshotCalls, evaluateArgs };
}

describe("samplePixels", () => {
  const clip: PixelClip = { x: 305, y: 541, width: 12, height: 12 };

  it("does not clip the capture -- a clipped capture moves the viewport and cancels a live hover", async () => {
    const { page, screenshotCalls } = fakePage();
    await samplePixels(page, clip);
    expect(screenshotCalls).toHaveLength(1);
    // Undefined, or at any rate carrying no `clip`. Either spelling is safe;
    // a `clip` of any shape is the defect this helper was written to remove.
    const options = screenshotCalls[0] as Record<string, unknown> | undefined;
    expect(options === undefined || options.clip === undefined).toBe(true);
  });

  it("crops afterwards, in DEVICE pixels, from the page's own dpr", async () => {
    const { page, evaluateArgs } = fakePage();
    await samplePixels(page, clip);
    expect(evaluateArgs).toHaveLength(1);
    const arg = evaluateArgs[0] as { b64: string; rect: PixelClip };
    expect(arg.rect).toEqual(deviceCropRect(clip, 2));
    expect(arg.b64).toBe(Buffer.from("not-a-real-png").toString("base64"));
  });

  it("returns whatever the page decoded", async () => {
    const { page } = fakePage();
    await expect(samplePixels(page, clip)).resolves.toEqual([1, 2, 3, 4]);
  });
});
