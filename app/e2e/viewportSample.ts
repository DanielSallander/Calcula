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
 * ---------------------------------------------------------------------------
 * RE-PROBED THE SAME DAY, ON THE SAME MACHINE, AND IT DID NOT REPRODUCE.
 * ---------------------------------------------------------------------------
 * Before migrating nine more call sites onto this helper the mechanism above
 * was re-measured against the running app (debug build, WebView2 Edg/153,
 * viewport 1280x800 CSS at dpr 2, Playwright 1.60, `connectOverCDP` with NO
 * emulated viewport — the same conditions every journey runs in). With the
 * pointer parked and held:
 *
 *   SURFACE                      idle 3s   full capture   CLIPPED capture
 *   a ribbon button's `:hover`   survives  survives       SURVIVES
 *   the chart renderer's own
 *     `getHoverState()` datum    survives  survives       SURVIVES
 *
 * Seven clip geometries were tried against the button (12x12 in-viewport, the
 * whole grid canvas, at the origin, a fractional origin, ON the parked
 * pointer, past the viewport bottom, `fullPage` + clip), with capture-phase
 * listeners on mousemove/mouseout/mouseover/mouseleave/mouseenter and the
 * pointer equivalents: NOT ONE event fired, `window.visualViewport` never
 * moved and `document.elementFromPoint` never changed. Playwright 1.60 passes
 * an in-viewport clip straight to `Page.captureScreenshot` with
 * `captureBeyondViewport: false` (`screenshotter.js` hard-codes `fitsViewport`
 * for the page path), so on this build there is no emulation override to move
 * anything.
 *
 * What DID reproduce, and is measured below, is a large TIMING difference: a
 * clipped sample of a 12x12 patch completes in ~63 ms end to end, an unclipped
 * one in ~194 ms. The preview that "never painted" was measured painting in
 * ~84 ms. A clipped sample taken immediately after arming a hover can
 * therefore photograph the frame BEFORE the product has painted, while the
 * slower unclipped path cannot — which fits "intermittent, then four
 * consecutive failures" at least as well as a cancelled hover does.
 *
 * NOTHING HERE IS A REASON TO PUT THE CLIP BACK. The unclipped path is the one
 * that has been proved 15/15 twice on the surface that failed, and it is the
 * one that cannot be wrong about the viewport. But a later reader chasing a
 * hover bug should know that the header's mechanism is UNCONFIRMED on this
 * build, and should re-run the probe on the exact surface rather than assume
 * it.
 *
 * WHEN A CLIP IS STILL FINE: when no hover is live and none is being measured.
 * Most journeys sample after parking the pointer somewhere harmless. This
 * helper is for the ones that cannot — and, since the nine migrated, for the
 * ones that simply should not each carry their own copy of the decode.
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
 * A cropped patch, with the geometry a caller needs to index into it.
 *
 * `width`/`height` are DEVICE pixels — the row stride of `data` — and `scale`
 * is device pixels per CSS pixel in this capture, which is what a measurement
 * taken in `data` columns must be divided by before it can be compared against
 * a CSS-space length (a cell width, a padding). `data` is RGBA, four entries
 * per pixel, exactly what `getImageData` produced.
 */
export interface PixelSample {
  data: number[];
  width: number;
  height: number;
  scale: number;
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
 * Is this device rectangle wholly inside a bitmap of `width` x `height`?
 *
 * THIS REPLACES AN ERROR BEHAVIOUR THE CLIP USED TO PROVIDE FOR FREE.
 * `page.screenshot({ clip })` asserts "Clipped area is either empty or outside
 * the resulting image" when the rectangle leaves the viewport, and at least one
 * spec (`journeys/parity-21c.spec.ts`) learned from that throw that its probe
 * cells were below the fold. Cropping in-page has no such reflex: `drawImage`
 * happily returns transparent black for a rectangle off the edge of the
 * bitmap, and a sampler that returns zeroes for "not on screen" turns a
 * geometry mistake into a passing comparison of two identical blanks. So the
 * bounds are checked explicitly, and a sample that is not fully on screen
 * THROWS.
 */
export function rectFitsInside(rect: PixelClip, width: number, height: number): boolean {
  return (
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x + rect.width <= width &&
    rect.y + rect.height <= height
  );
}

/**
 * Raw RGBA of several clips, decoded in the page, WITHOUT moving the viewport.
 *
 * ONE CAPTURE FOR ALL OF THEM, and that is not only about cost. Two patches
 * sampled by two captures are two different frames: a repaint between them
 * (an overlay animating, a caret blinking, a debounced re-render landing) puts
 * half the evidence on each side of it, and the diff that results is a fact
 * about the schedule rather than about the product. Cropping N rectangles out
 * of ONE bitmap cannot straddle a repaint.
 *
 * Three round trips rather than one, deliberately: the device pixel ratio is
 * read from the page rather than assumed, so the crop is computed by
 * {@link deviceCropRect} — a pure function with its own tests — instead of by
 * arithmetic buried in a string that only a live browser can execute.
 */
export async function samplePixelGrids(page: Page, clips: PixelClip[]): Promise<PixelSample[]> {
  if (clips.length === 0) return [];
  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
  // NO `clip` HERE. See the header: the whole point of this module is that the
  // capture is of the WHOLE viewport and the cropping happens afterwards.
  const png = await page.screenshot();
  const rects = clips.map((clip) => deviceCropRect(clip, dpr));
  const decoded = await page.evaluate(
    async ({ b64, rects: rs }: { b64: string; rects: PixelClip[] }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context for pixel decode");
      const samples = rs.map((r) => {
        canvas.width = r.width;
        canvas.height = r.height;
        ctx.clearRect(0, 0, r.width, r.height);
        ctx.drawImage(bitmap, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
        return Array.from(ctx.getImageData(0, 0, r.width, r.height).data);
      });
      return { samples, bitmap: { width: bitmap.width, height: bitmap.height } };
    },
    { b64: png.toString("base64"), rects },
  );
  return rects.map((rect, i) => {
    if (!rectFitsInside(rect, decoded.bitmap.width, decoded.bitmap.height)) {
      throw new Error(
        `[viewportSample] the clip ${JSON.stringify(clips[i])} (CSS px) maps to ` +
          `${JSON.stringify(rect)} in a ${decoded.bitmap.width}x${decoded.bitmap.height} ` +
          `capture at dpr ${dpr} — it is not fully on screen, so the pixels it would ` +
          `return are transparent black and any comparison against them is vacuous. ` +
          `Scroll or navigate the target into view before sampling it.`,
      );
    }
    return {
      data: decoded.samples[i],
      width: rect.width,
      height: rect.height,
      scale: rect.width / clips[i].width,
    };
  });
}

/** {@link samplePixelGrids} for one clip. */
export async function samplePixelGrid(page: Page, clip: PixelClip): Promise<PixelSample> {
  return (await samplePixelGrids(page, [clip]))[0];
}

/**
 * Raw RGBA of `clip`, decoded in the page, WITHOUT moving the viewport.
 *
 * The flat form: device pixels, RGBA, four entries each, row-major — byte for
 * byte what `page.screenshot({ clip })` used to decode to.
 */
export async function samplePixels(page: Page, clip: PixelClip): Promise<number[]> {
  return (await samplePixelGrid(page, clip)).data;
}

/** {@link samplePixelGrids} for callers that only want the flat arrays. */
export async function samplePixelPatches(page: Page, clips: PixelClip[]): Promise<number[][]> {
  return (await samplePixelGrids(page, clips)).map((s) => s.data);
}

/**
 * Pixels differing by more than a hair between two same-sized samples.
 *
 * ONE COPY. This function existed nine times over, in nine journey specs, at
 * the same threshold, with the same "the clip moved" refusal spelled four
 * different ways — the same one-fact-many-spellings shape the product defects
 * of this wave were made of. Alpha is deliberately not compared: a screenshot
 * is opaque and an alpha difference would only ever be noise.
 *
 * THE SIZE CHECK IS THE POINT OF THE THROW. Two samples of different lengths
 * are not a small difference to be reported as a big number; they mean the
 * rectangle moved between the captures, so every number derived from them is
 * meaningless and a comparison must not silently return one.
 */
export function diffCount(
  a: number[] | PixelSample,
  b: number[] | PixelSample,
  tolerance = 8,
): number {
  const da = Array.isArray(a) ? a : a.data;
  const db = Array.isArray(b) ? b : b.data;
  if (da.length !== db.length) {
    const dim = (s: number[] | PixelSample): string =>
      Array.isArray(s) ? `${s.length} values` : `${s.width}x${s.height}`;
    throw new Error(
      `capture sizes differ (${dim(a)} vs ${dim(b)}) — the clip moved between ` +
        `captures, so the comparison means nothing`,
    );
  }
  let n = 0;
  for (let i = 0; i < da.length; i += 4) {
    if (
      Math.abs(da[i] - db[i]) > tolerance ||
      Math.abs(da[i + 1] - db[i + 1]) > tolerance ||
      Math.abs(da[i + 2] - db[i + 2]) > tolerance
    ) {
      n++;
    }
  }
  return n;
}
