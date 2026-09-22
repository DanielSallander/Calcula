/**
 * Sampling screen pixels WITHOUT disturbing what the pointer is hovering.
 *
 * WHY THIS EXISTS — measured 2026-09-22, and it cost a defect report.
 *
 * `page.screenshot({ clip })` is not a passive read. To capture a sub-rectangle
 * Chromium is asked to put that rectangle on screen, and the pointer's
 * hit-test moves with the viewport. A control the pointer is PARKED ON
 * therefore receives a `mouseleave` it never earned: the event arrives with
 * `clientX/clientY` equal to the CLIP'S OWN ORIGIN and a `relatedTarget` that
 * is not an element, and no matching `mouseenter` follows when the override is
 * lifted. The element's own `getBoundingClientRect()` is unchanged throughout,
 * so nothing in the page moved — only the viewport did.
 *
 * Measured on the Charts Format pane's live colour preview, with the pointer
 * held on one swatch for the whole probe:
 *
 *   PROBE idle 3s, no screenshot ... previewing before=true  after=true
 *   PROBE FULL-viewport screenshot . previewing before=true  after=true
 *   PROBE CLIPPED screenshot ...... previewing before=true  after=FALSE
 *   PROBE in-page canvas readback .. previewing before=true  after=true
 *
 * The feature was fine. The instrument was cancelling the state it had been
 * pointed at, and then reporting that the state was not there — for four
 * consecutive runs, after being intermittent for four more (the capture used
 * to sometimes beat the product's own restore repaint, which is what made it
 * look like a race in the product).
 *
 * So the screenshot is taken UNCLIPPED — proved harmless above — and the crop
 * happens afterwards, inside the page, against the decoded bitmap. The
 * returned array is byte-for-byte the shape the clipped call produced (device
 * pixels, RGBA), so thresholds tuned against the old helper still mean what
 * they meant.
 *
 * WHEN A CLIP IS STILL FINE: when no hover is live and none is being measured.
 * Most journeys sample after parking the pointer somewhere harmless. This
 * helper is for the ones that cannot.
 */
import type { Page } from "@playwright/test";

/** A rectangle in CSS pixels, as `page.screenshot({ clip })` would take it. */
export interface PixelClip {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The same rectangle in DEVICE pixels — the space an unclipped screenshot is
 * returned in, because Playwright's default `scale` is `"device"`.
 *
 * Rounded rather than floored, and the extent is computed from the ROUNDED
 * EDGES rather than by scaling the width: `round(x*dpr) + round(w*dpr)` drifts
 * from `round((x+w)*dpr)` by a pixel at half-pixel origins, and a one-pixel
 * drift between two samples makes `diffCount` throw "the clip moved" on a
 * chart that never moved. Width and height are clamped to at least one pixel
 * so a degenerate clip yields a readable (if useless) sample instead of an
 * exception from `getImageData`.
 */
export function deviceCropRect(clip: PixelClip, devicePixelRatio: number): PixelClip {
  const x = Math.round(clip.x * devicePixelRatio);
  const y = Math.round(clip.y * devicePixelRatio);
  const right = Math.round((clip.x + clip.width) * devicePixelRatio);
  const bottom = Math.round((clip.y + clip.height) * devicePixelRatio);
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

/**
 * Raw RGBA of `clip`, decoded in the page, WITHOUT moving the viewport.
 *
 * Three round trips rather than one, deliberately: the device pixel ratio is
 * read from the page rather than assumed, so the crop is computed by
 * {@link deviceCropRect} — a pure function with its own tests — instead of by
 * arithmetic buried in a string that only a live browser can execute.
 */
export async function samplePixels(page: Page, clip: PixelClip): Promise<number[]> {
  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
  // NO `clip` HERE. See the header: a clipped capture cancels a live hover.
  const png = await page.screenshot();
  const rect = deviceCropRect(clip, dpr);
  return page.evaluate(
    async ({ b64, rect: r }: { b64: string; rect: PixelClip }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = r.width;
      canvas.height = r.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context for pixel decode");
      ctx.drawImage(bitmap, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
      return Array.from(ctx.getImageData(0, 0, r.width, r.height).data);
    },
    { b64: png.toString("base64"), rect },
  );
}
