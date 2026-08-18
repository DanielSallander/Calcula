//! FILENAME: app/e2e/goldenCorpus.ts
// PURPOSE: Ask the capture-environment question of the RIGHT POPULATION -- the
//          committed golden PNGs themselves, not one number describing the
//          display a run happens to be on.
// CONTEXT: `e2e/captureEnvironment.ts` states the display the corpus assumes and
//          asserts it ONCE PER RUN against the live app. That guard is correct
//          and stays. It has one blind spot, and the blind spot is the thing it
//          was written to prevent:
//
//            it compares the RUN to a constant.
//            Nothing compares the CORPUS to that constant.
//
//          So the corpus can quietly stop being a single corpus. Measured
//          2026-08-11 by decoding all 71 committed goldens: 44 held the dpr-2
//          hairline and 27 -- the whole `e2e/visual` tree, re-recorded that
//          afternoon -- held the dpr-1 hairline. `captureEnvironment.ts` said
//          devicePixelRatio 2 and described itself as "the display configuration
//          EVERY committed golden was captured under". For 27 of 71 files that
//          sentence was false, and no test could say so, because no test ever
//          looked at a golden.
//
//          RE-MEASURED 2026-08-18, after the corpus was re-recorded at dpr 1
//          (72 files): 58 classifiable, ALL dpr-1, none dpr-2. The numbers above
//          are kept because they are why this module exists, but do not quote
//          any of them as current -- read the bytes, which is the whole point of
//          the module. The remaining 14 are strips and bands carrying no
//          gridlines to classify, which is reported rather than guessed.
//
//          Why the corpus moved to dpr 1 rather than back to dpr 2: at 200%
//          scaling this display reports dpr 2 but shrinks the logical desktop to
//          1280x720, and the corpus needs an 800-tall viewport. The width is
//          exactly 1280 in both modes, so it is the panel, not the config, and
//          no setting recovers dpr 2 at the required size.
//
//          A bulk re-record is the single highest-risk operation in a visual
//          suite: it accepts whatever the app rendered that day as the new
//          truth. The only thing that makes it safe is being able to say
//          afterwards WHICH capture path each golden came from. That is what
//          this module measures.
//
// ============================================================================
// HOW A GOLDEN'S CAPTURE PATH IS READ OFF ITS BYTES
// ============================================================================
// `drawGridLines` (src/core/lib/gridRenderer/rendering/grid.ts) is the only
// stroke in the renderer at `lineWidth = 1 / deviceScale` -- a true ONE DEVICE
// PIXEL hairline, which is what makes the grid read like Excel's on a high-DPI
// screen. A `toHaveScreenshot` capture is taken at CSS scale, so that hairline
// resolves to a different constant on each side:
//
//     dpr 1  ->  the hairline fills one CSS pixel      ->  226,226,226
//     dpr 2  ->  it covers about half of one over white ->  241,241,241
//
// It repeats ~39,400 times in a full-grid capture, so it is the loudest signal
// in the image and it is exact -- these are flat fills, not antialiasing noise.
// Counting the two constants therefore recovers the device pixel ratio the file
// was recorded at, from the file alone, years later, with no run involved.

import { inflateSync } from "node:zlib";

/** The hairline constant a grid capture holds at dpr 1. */
export const HAIRLINE_DPR1 = "226,226,226";
/** The hairline constant a grid capture holds at dpr 2. */
export const HAIRLINE_DPR2 = "241,241,241";

/**
 * Below this many hairline pixels a capture is not showing enough grid to be
 * classified -- a status-bar strip or a ribbon band, which carry no gridlines
 * at all. Those files are outside this census's population and are reported as
 * such rather than guessed at.
 */
const MIN_HAIRLINE_PIXELS = 50;

/**
 * ...and a COUNT alone cannot make that call, which this module learned by
 * getting it wrong. After the 2026-08-18 re-record, two files still read as
 * dpr-2 in a corpus that was now uniformly dpr-1, and the guard reported the
 * corpus had "split across two capture paths". Both were false alarms:
 *
 *     ribbon-ribbon-tab-insert.png       172 px of 241,241,241, no grid at all
 *     autocomplete-dropdown-visible.png  916 px of 241,241,241, no grid at all
 *
 * `#F1F1F1` is ALSO the app's UI chrome grey, so a ribbon band and a dropdown
 * crop clear a 50-pixel floor without containing one gridline. Raising the
 * floor cannot fix it either, and that is the useful part: a genuine small
 * crop, `grid-comments-cell-with-indicator.png`, holds only 108 hairline
 * pixels -- FEWER than the 172-pixel false positive. The populations are not
 * separable by count in either direction.
 *
 * They separate completely by STRUCTURE, because a gridline is a LINE. Vertical
 * rules put the constant in nearly every row; horizontal rules put it in nearly
 * every column. Chrome painted in the same grey is a BLOB. Measured over all 60
 * goldens holding either constant -- the fraction of rows, and of columns, that
 * contain it, whichever is smaller:
 *
 *     0.2%   ribbon-ribbon-tab-insert.png          <- chrome
 *     2.4%   autocomplete-dropdown-visible.png     <- chrome
 *    65.1%   the lowest genuine grid capture
 *    96.1%   the typical full-grid capture
 *
 * A 27x gap with nothing in it. This threshold sits in the middle of that gap.
 */
const MIN_HAIRLINE_SPAN = 0.25;

/**
 * The dominant constant must beat the other by this factor. Menus and editor
 * overlays paint their own chrome in neutral greys that can collide with one of
 * the two constants; requiring a margin keeps a handful of chrome pixels from
 * outvoting 39,000 gridline pixels, and keeps a genuinely mixed image from
 * being silently assigned to a side.
 */
const DOMINANCE_MARGIN = 4;

export interface DecodedPng {
  width: number;
  height: number;
  /** Row-major RGB triples, 3 bytes per pixel. */
  rgb: Uint8Array;
}

/**
 * Decode a PNG to RGB triples.
 *
 * Deliberately dependency-free: the repo has no PNG decoder (only a small PNG
 * *encoder* in `journeys/image-ingress.spec.ts`, which builds fixture bytes and
 * cannot read them back), and a guard over the committed corpus must not be the
 * reason a native image dependency enters the build. Supports the 8-bit,
 * non-interlaced subset Playwright writes.
 */
export function decodePng(buffer: Buffer): DecodedPng {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("not a PNG: bad signature");
  }

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette: Buffer | null = null;
  const idat: Buffer[] = [];

  while (pos + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString("ascii", pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") {
      palette = Buffer.from(data);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + length;
  }

  if (bitDepth !== 8) {
    throw new Error(`unsupported PNG bit depth ${bitDepth} (only 8 is handled)`);
  }
  if (interlace !== 0) {
    throw new Error("unsupported interlaced PNG");
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (channels === undefined) {
    throw new Error(`unsupported PNG colour type ${colorType}`);
  }
  if (colorType === 3 && palette === null) {
    throw new Error("indexed PNG without a PLTE chunk");
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const flat = Buffer.alloc(height * stride);

  // Undo the per-scanline filters (PNG spec 9.2). `bpp` is the filter's notion
  // of "one pixel back", which for 8-bit depth is exactly the channel count.
  const bpp = channels;
  let read = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[read++];
    const line = raw.subarray(read, read + stride);
    read += stride;
    const cur = flat.subarray(y * stride, (y + 1) * stride);
    const prevRow = y > 0 ? flat.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prevRow ? prevRow[i] : 0;
      const c = prevRow && i >= bpp ? prevRow[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
  }

  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    let r: number;
    let g: number;
    let b: number;
    if (colorType === 2) {
      r = flat[i * 3];
      g = flat[i * 3 + 1];
      b = flat[i * 3 + 2];
    } else if (colorType === 6) {
      r = flat[i * 4];
      g = flat[i * 4 + 1];
      b = flat[i * 4 + 2];
    } else if (colorType === 0) {
      r = g = b = flat[i];
    } else if (colorType === 4) {
      r = g = b = flat[i * 2];
    } else {
      const idx = flat[i];
      r = palette![idx * 3];
      g = palette![idx * 3 + 1];
      b = palette![idx * 3 + 2];
    }
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }

  return { width, height, rgb };
}

export type CaptureVerdict = "dpr1" | "dpr2" | "no-grid" | "ambiguous";

export interface HairlineReading {
  /** Pixels holding the dpr-1 hairline constant. */
  dpr1Pixels: number;
  /** Pixels holding the dpr-2 hairline constant. */
  dpr2Pixels: number;
  verdict: CaptureVerdict;
  /** The device pixel ratio this file was recorded at, when it can be read. */
  devicePixelRatio: number | null;
  /**
   * How much of the image the dominant constant actually SPANS: the fraction of
   * rows, and of columns, containing it, whichever is smaller. Near 1 for
   * gridlines, near 0 for a patch of chrome that happens to share the colour.
   */
  span: number;
}

/** Read the capture path off a decoded golden. PURE. */
export function readHairline(image: DecodedPng): HairlineReading {
  let dpr1Pixels = 0;
  let dpr2Pixels = 0;
  // Which rows / columns the dominant constant touches. Tracked per constant so
  // the span belongs to the WINNING side rather than to both mixed together.
  const rowsHit = [new Uint8Array(image.height), new Uint8Array(image.height)];
  const colsHit = [new Uint8Array(image.width), new Uint8Array(image.width)];

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const p = (y * image.width + x) * 3;
      const r = image.rgb[p];
      const g = image.rgb[p + 1];
      const b = image.rgb[p + 2];
      if (r !== g || g !== b) continue;
      let side = -1;
      if (r === 226) {
        dpr1Pixels++;
        side = 0;
      } else if (r === 241) {
        dpr2Pixels++;
        side = 1;
      }
      if (side >= 0) {
        rowsHit[side][y] = 1;
        colsHit[side][x] = 1;
      }
    }
  }

  const hi = Math.max(dpr1Pixels, dpr2Pixels);
  const lo = Math.min(dpr1Pixels, dpr2Pixels);
  const winner = dpr2Pixels > dpr1Pixels ? 1 : 0;
  const covered = (flags: Uint8Array): number => {
    let n = 0;
    for (let i = 0; i < flags.length; i++) n += flags[i];
    return flags.length === 0 ? 0 : n / flags.length;
  };
  const span = Math.min(covered(rowsHit[winner]), covered(colsHit[winner]));

  let verdict: CaptureVerdict;
  if (hi < MIN_HAIRLINE_PIXELS || span < MIN_HAIRLINE_SPAN) verdict = "no-grid";
  else if (lo * DOMINANCE_MARGIN > hi) verdict = "ambiguous";
  else verdict = dpr2Pixels > dpr1Pixels ? "dpr2" : "dpr1";

  return {
    dpr1Pixels,
    dpr2Pixels,
    verdict,
    devicePixelRatio: verdict === "dpr1" ? 1 : verdict === "dpr2" ? 2 : null,
    span,
  };
}

// ============================================================================
// THE SECOND AXIS: THE COLOUR PROFILE, READ OFF THE BYTES THE SAME WAY
// ============================================================================
// The dpr axis above was built because the corpus had split across two DEVICE
// SCALE FACTORS and nothing could say so. It closed exactly one axis, and the
// corpus splits on two.
//
// MEASURED 2026-08-11, on a cold functional run of the fixed build: 31 of 31
// failures were goldens, and NONE of them was dpr -- every pair holds the same
// hairline on both sides. All 31 are the COLOUR PROFILE, which reached the
// manual launch path for the first time when `webview2Args.mjs` became the one
// definition (§3by §5). Before that no manual run had ever had the pin, so the
// whole committed corpus encodes the DISPLAY's profile and the app now renders
// sRGB.
//
// The two constants are not chosen, they are the app's own declared colours:
//
//     #217346  = 33,115,70   the status bar (`uiTypes.ts`, `extensions.ts`)
//     #10b981  = 16,185,129  the accent      (`ribbonIcons.tsx`, `darkTheme.ts`)
//
// A capture taken UNDER the pin reproduces the declared colour bit-exactly. A
// capture taken through the display profile lands on the wide-gamut->sRGB
// transform of it, and that transform is the identity on neutrals -- which is
// why this axis is invisible to any check that looks at greys, and why the dpr
// axis could not see it. The measured pairs:
//
//     63,112,75   -> 33,115,70     the status bar, 29,569 px of one capture
//     95,180,134  -> 16,185,129    the accent
//
// So the same question the dpr axis asks ("which capture path do these BYTES
// come from") is answerable for the profile too, from the file alone.

// ============================================================================
// THE THIRD AXIS — TEXT ANTIALIASING — AND WHY IT IS NOT IN THIS FILE
// ============================================================================
// BUG-0028 was a third capture-path split: three `menu-*` goldens and the
// functional corpus's `autocomplete-dropdown-visible` hold LCD (subpixel)
// antialiased text in their overlays, and a cold app renders the same overlays
// with GRAYSCALE antialiasing. ~2,900 differing pixels against a 200-pixel
// budget, with nothing about the product changed. The obvious move — "add a
// third reader here, next to the other two" — was ATTEMPTED, MEASURED, and
// REJECTED, and the measurement is written down so it is not attempted again.
//
// The two axes above are properties of the WHOLE CAPTURE. A display has one
// scale factor and one colour profile, so every pixel of a golden was produced
// through the same one and counting exact constants over the file answers the
// question.
//
// LCD text is a property of each COMPOSITED LAYER. Chromium will not use it on
// a layer it cannot prove opaque, so one capture can hold both kinds at once —
// and the failing ones do. Measured on `menu-file-open` (2026-08-12), same
// frame, same run:
//
//     menu-bar strip (root layer)      expected 1251 chromatic px   actual 1251
//     ribbon strip   (root layer)      expected 1373               actual 1373
//     the open dropdown (own layer)    expected 2914               actual    0
//
// A per-file statistic therefore cannot separate the two states: over the whole
// 1280x800 frame the counts are 195,201 against 193,272, a 1% difference in a
// number whose value depends mostly on how much coloured chrome is in shot.
// Three candidate readers were tried against the real pair — chromatic pixels,
// monotone-channel pixels, and chromatic pixels flanked by neutrals — and the
// closest separation any of them reached was 1.3x, against the 4x dominance
// margin the readers above are held to. A reader at that margin is the shape
// this program keeps deleting: it would report a verdict it cannot support.
//
// So the axis is asserted against the RUN instead, where it IS answerable in
// one number: `CAPTURE_ENVIRONMENT.compositedCanvasLayers`, read off the
// compositor's own layer tree by `assertCaptureEnvironment`
// (e2e/helpers/screenshots.ts). It is pinned by
// `--disable-accelerated-2d-canvas` in `webview2Args.mjs`, which is where the
// mechanism is written out.
//
// IF A FUTURE PASS WANTS THIS AXIS HERE, the population it can honestly serve
// is a capture whose ENTIRE FRAME is one overlay — a `takeDialogScreenshot`
// golden. There are none in the tree today, which is the other reason this file
// does not carry the reader.
//
// ----------------------------------------------------------------------------
// 2026-08-12: TRIED AGAIN, WITH A BETTER READER, AND STILL REJECTED. The reason
// is now MEASURED rather than argued, so nobody has to spend a third pass on it.
// ----------------------------------------------------------------------------
// The prompt for the retry was real: the first live `--project=functional` run
// under `--disable-accelerated-2d-canvas` found `ribbon-ribbon-tab-insert.png`
// on the grayscale side of this axis (BUG-0030), which is precisely the failure
// a corpus census is supposed to catch before a run does.
//
// A FOURTH reader was built and it looked decisive. Instead of counting
// chromatic pixels over a whole frame, it restricts the DENOMINATOR to MID-TONE
// pixels (luminance 40..200 — glyph-edge territory, excluding the flat
// background and the solid glyph core that dominate a frame) and asks what
// fraction of those are neutral. Compared WITHIN a cohort of captures of the
// same element — the eight 1280x136 `[data-testid='ribbon']` captures — it
// separated **11.9x**, against the 4x margin the readers above are held to:
//
//     seven ribbon goldens        162 / 4287  =  3.8%
//     ribbon-ribbon-tab-insert   2654 / 5920  = 44.8%   <-- the stale one
//
// It was built, wired into a cohort rule, and it FIRED on the real corpus,
// naming the file. Then the file was re-recorded against the pinned build, and
// the re-record is what killed the idea:
//
//     ribbon-ribbon-tab-insert, STALE      2654 / 5920  = 44.8%
//     ribbon-ribbon-tab-insert, CORRECT    1733 / 5908  = 29.3%   <-- still high
//     the rest of the cohort                162 / 4287  =  3.8%
//
// **The correct recording is 7.7x from its own cohort and only 1.5x from the
// stale one.** So the reader does not answer the question it was built for. It
// separates COMPOSITED from NOT-COMPOSITED, and part of the Insert ribbon is
// composited for its own reasons in the current, correctly-pinned build — a
// property of that tab's CONTENT, not of the environment the file was recorded
// in. A cohort-agreement rule over it reports a true sentence that is not a
// corpus defect, and would have been permanently red.
//
// That is the same shape as the 1.3x rejection above, one level subtler: a
// reader whose two populations are separated by less than the margin returns
// verdicts it cannot support. The axis stays asserted against the RUN, where it
// is answerable in one number, and BUG-0030's class stays guarded by
// `assertCaptureEnvironment` plus the discipline of re-running the other
// projects when a capture pin changes — which is the actual lesson, and it is
// a process one, not a reader.
// ============================================================================

/** The status-bar green as the app declares it (`#217346`), i.e. under the pin. */
export const CHROME_GREEN_SRGB = "33,115,70";
/** The same chrome as a capture through this machine's display profile holds it. */
export const CHROME_GREEN_DISPLAY = "63,112,75";
/** The accent as the app declares it (`#10b981`), i.e. under the pin. */
export const ACCENT_SRGB = "16,185,129";
/** The same accent as a capture through the display profile holds it. */
export const ACCENT_DISPLAY = "95,180,134";

/**
 * Below this many chrome pixels a capture is not showing enough saturated
 * colour to be classified -- a bare grid crop carries none at all. Those files
 * are outside this axis's population and are reported as such rather than
 * guessed at, exactly as `MIN_HAIRLINE_PIXELS` does for the other axis.
 */
const MIN_CHROME_PIXELS = 20;

export type ProfileVerdict = "srgb" | "display" | "no-chrome" | "ambiguous";

export interface ProfileReading {
  /** Pixels holding a colour the app DECLARES (the pin is in force). */
  srgbPixels: number;
  /** Pixels holding that colour's display-profile transform. */
  displayPixels: number;
  profileVerdict: ProfileVerdict;
}

/** Read the colour-profile capture path off a decoded golden. PURE. */
export function readColourProfile(image: DecodedPng): ProfileReading {
  let srgbPixels = 0;
  let displayPixels = 0;
  const count = image.width * image.height;
  for (let p = 0; p < count; p++) {
    const r = image.rgb[p * 3];
    const g = image.rgb[p * 3 + 1];
    const b = image.rgb[p * 3 + 2];
    // Neutrals carry no information on this axis at all -- the transform is the
    // identity on them -- so they are skipped rather than counted as agreement.
    if (r === g && g === b) continue;
    if ((r === 33 && g === 115 && b === 70) || (r === 16 && g === 185 && b === 129)) {
      srgbPixels++;
    } else if ((r === 63 && g === 112 && b === 75) || (r === 95 && g === 180 && b === 134)) {
      displayPixels++;
    }
  }

  const hi = Math.max(srgbPixels, displayPixels);
  const lo = Math.min(srgbPixels, displayPixels);
  let profileVerdict: ProfileVerdict;
  if (hi < MIN_CHROME_PIXELS) profileVerdict = "no-chrome";
  else if (lo * DOMINANCE_MARGIN > hi) profileVerdict = "ambiguous";
  else profileVerdict = srgbPixels > displayPixels ? "srgb" : "display";

  return { srgbPixels, displayPixels, profileVerdict };
}

export interface GoldenReading extends HairlineReading, ProfileReading {
  /** Path relative to `app/e2e`, forward-slashed. */
  file: string;
}

/**
 * The corpora that are NOT recorded at the run environment's device pixel
 * ratio, enumerated FILE BY FILE.
 *
 * This is a quarantine, not a suppression, and the difference is enforced
 * below: every entry must still measure exactly `recordedAt`, and the file list
 * must exactly equal the classifiable goldens under `dir`. So the entry cannot
 * outlive the defect (re-record one file correctly and this list is stale and
 * fails), and it cannot grow to cover a second defect (add a golden on the
 * wrong path and the set no longer matches).
 *
 * The prefix-shaped alternative -- "ignore anything under visual/" -- is
 * exactly the shape that let the undo oracle report a green it could not have
 * seen a pivot defect through since 2026-06-11. It is not repeated here.
 */
export interface MisRecordedCorpus {
  /** Directory under `app/e2e`, forward-slashed, no trailing slash. */
  dir: string;
  /** The device pixel ratio these files were actually recorded at. */
  recordedAt: number;
  /** Bug ledger id. */
  ledgerId: string;
  reason: string;
  /** Every classifiable golden under `dir`, relative to `app/e2e`. */
  files: string[];
}

export const MIS_RECORDED_CORPORA: MisRecordedCorpus[] = [
  // EMPTY, and that is the intended end state rather than an oversight.
  //
  // BUG-0023 WAS HERE: the whole `visual` tree, 25 files, re-recorded on
  // 2026-08-11 at dpr 1 on a machine whose display is 200%. It is gone because
  // the defect is FIXED -- the tree was re-recorded at dpr 2 on 2026-08-11
  // against a cold app of the fixed build, and `classify` now reads dpr 2 off
  // all 72 committed goldens. That is the self-expiry the two cases below were
  // built to force: the moment a quarantined file measures something other than
  // `recordedAt`, the entry fails and has to go.
  //
  // The re-record absorbed no structural change, and this is the evidence
  // rather than the assurance: fitting the untouched dpr-2
  // `grid-empty-grid-default` against the dpr-1 `grid-core-empty-canvas` left
  // 0.83% residual, symmetric (1980 px of 241->255 against 1980 px of
  // 255->226 -- a gridline moving one pixel), with no localized bounding box.
  //
  // A new entry here needs a bug id, a written reason, and an exact file list.
  // A directory prefix is NOT acceptable: that shape is what let the undo
  // oracle report a green it could not have seen a pivot defect through for two
  // months (see `oracles/knownIssues.ts`).
];

/** Which quarantine, if any, claims this golden. PURE. */
export function quarantineFor(
  file: string,
  corpora: MisRecordedCorpus[] = MIS_RECORDED_CORPORA,
): MisRecordedCorpus | undefined {
  return corpora.find((c) => c.files.includes(file));
}

/**
 * The sentence a corpus that has split across two capture paths should carry.
 *
 * Returns null when every golden agrees with the environment it is supposed to
 * have been recorded under. PURE, so the wording has a unit tier -- the whole
 * value of this guard is that it names the FILES and the MECHANISM instead of
 * leaving forty diffs to be explained by eye.
 */
export function describeCorpusSplit(
  readings: GoldenReading[],
  expectedDevicePixelRatio: number,
  corpora: MisRecordedCorpus[] = MIS_RECORDED_CORPORA,
): string | null {
  const strays = readings.filter(
    (r) =>
      r.devicePixelRatio !== null &&
      r.devicePixelRatio !== expectedDevicePixelRatio &&
      quarantineFor(r.file, corpora) === undefined,
  );
  if (strays.length === 0) return null;

  const byDpr = new Map<number, string[]>();
  for (const s of strays) {
    const list = byDpr.get(s.devicePixelRatio!) ?? [];
    list.push(s.file);
    byDpr.set(s.devicePixelRatio!, list);
  }

  const groups = [...byDpr.entries()].map(
    ([dpr, files]) =>
      `  - ${files.length} golden(s) hold the dpr-${dpr} hairline ` +
      `(${dpr === 1 ? HAIRLINE_DPR1 : HAIRLINE_DPR2}) but the corpus is ` +
      `recorded at dpr ${expectedDevicePixelRatio}:\n` +
      files.map((f) => `      ${f}`).join("\n"),
  );

  return (
    `[goldens] THE GOLDEN CORPUS HAS SPLIT ACROSS TWO CAPTURE PATHS.\n` +
    groups.join("\n") +
    `\n  These files were recorded through a different device pixel ratio than the ` +
    `rest of the corpus. The grid hairline is stroked at 1 DEVICE pixel and captured ` +
    `at CSS scale, so it lands on ${HAIRLINE_DPR2} at dpr 2 and ${HAIRLINE_DPR1} at ` +
    `dpr 1 -- about 39,400 pixels of every grid capture against a 200-pixel budget.\n` +
    `  A bulk re-record accepts whatever the app rendered that day as the new truth, ` +
    `so this must be attributed BEFORE it is accepted: re-record on the corpus's own ` +
    `capture path, or, if the path is deliberately changing, move the whole corpus at ` +
    `once and update e2e/captureEnvironment.ts in the same change.`
  );
}

/**
 * The same statement for the COLOUR-PROFILE axis.
 *
 * Deliberately a separate function rather than a flag on the one above: the two
 * axes have different populations (a bare grid crop has a hairline and no
 * chrome; a status-bar strip has chrome and no hairline), different remedies,
 * and different evidence. Folding them together would produce a message that
 * has to hedge about which one it means, and the whole value of these guards is
 * that they name the mechanism.
 *
 * PURE. Returns null when every classifiable golden is on `expected`.
 */
export function describeProfileSplit(
  readings: GoldenReading[],
  expected: "srgb" | "display",
  corpora: MisRecordedCorpus[] = MIS_RECORDED_CORPORA,
): string | null {
  const strays = readings.filter(
    (r) =>
      (r.profileVerdict === "srgb" || r.profileVerdict === "display") &&
      r.profileVerdict !== expected &&
      quarantineFor(r.file, corpora) === undefined,
  );
  if (strays.length === 0) return null;

  return (
    `[goldens] THE GOLDEN CORPUS HAS SPLIT ACROSS TWO COLOUR PROFILES.\n` +
    `  - ${strays.length} golden(s) hold the ${strays[0].profileVerdict} palette ` +
    `but the corpus is recorded under "${expected}":\n` +
    strays.map((s) => `      ${s.file}`).join("\n") +
    `\n  The app declares its chrome as #217346 (${CHROME_GREEN_SRGB}) and #10b981 ` +
    `(${ACCENT_SRGB}). A capture taken with --force-color-profile=sRGB reproduces ` +
    `those bit-exactly; one taken through this machine's display profile lands on ` +
    `${CHROME_GREEN_DISPLAY} and ${ACCENT_DISPLAY} instead. The status bar alone is ` +
    `~29,600 pixels against a 15-pixel budget, so a golden on the wrong side of this ` +
    `cannot pass.\n` +
    `  THIS AXIS IS INVISIBLE TO THE DEVICE-PIXEL-RATIO CHECK ABOVE: the profile ` +
    `transform is the IDENTITY on neutrals, and both hairline constants are neutral. ` +
    `A corpus can agree perfectly about dpr and still be two corpora.\n` +
    `  The pin is delivered by e2e/webview2Args.mjs, which both launch paths import. ` +
    `If these goldens predate that, re-record them; if the pin has been LOST, fix the ` +
    `launcher rather than the corpus -- a re-record would then bake this display into ` +
    `every golden and the suite would stop being portable at all.`
  );
}

// ============================================================================
// A THIRD AXIS, AND IT IS NOT A CAPTURE PATH AT ALL -- IT IS PRODUCT STATE
// ============================================================================
// The two axes above answer "which machine took this picture". They cannot
// answer the question that actually broke a project on 2026-08-12:
//
//     WHICH BUILD OF THE PRODUCT took this picture?
//
// BUG-0028 fixed a real product defect: `useHomeTabState` keyed its style read
// on the selection alone and, when `getCell` returned null, returned WITHOUT
// clearing -- so the Home tab kept the previous cell's format state over a cell
// that holds nothing, and File > New / undo / Clear-Formats never re-read at
// all. Five `visual` goldens were re-recorded against the fixed build.
//
// Nothing looked at the OTHER projects. `tests/.../empty-grid-full-window.png`
// photographs the same brand-new workbook through the same
// `resetToNewWorkbook` helper, in the `functional` project, and still carried
// the residue at the time: 546 pressed-accent pixels where THAT fixed build
// painted 36. The pressed fill alone is 590 differing pixels against a
// 200-pixel budget, so it could not pass -- and no test in the tree could say
// so, because every guard was about the capture environment and this is about
// the application.
//
// THE TARGET MOVED ONCE, DELIBERATELY (2026-08-14, open-decisions §21).
// BUG-0028's fix cleared to a NULL style, which was its own defect one layer
// down: the font box fell back to "system-ui" and every toggle went dark,
// where the document default (style 0, Calibri 11) is what an empty cell truly
// carries. BUG-0062 made the ribbon report that default, so the build paints
// exactly ONE lit toggle on a brand-new workbook. "Unlit" stopped being the
// fixed build's face; every empty-document golden was re-recorded with the
// diff attributed, and the axis below pins each file's expected reading
// instead of asserting zero.
//
// THE TARGET MOVED AGAIN, DELIBERATELY (2026-08-15, open-decisions §21c item
// 2). Which toggle that one lit box IS has changed. Calcula's document default
// carried `VerticalAlign::Middle`; Excel's is `Bottom` (Excel's default cell is
// Horizontal: General, Vertical: Bottom, and `Range.VerticalAlignment` returns
// `xlBottom` for a fresh cell), so `CellStyle::new()` now carries
// `VerticalAlign::Bottom` and the lit toggle is BOTTOM ALIGN, not Center
// Vertically. Horizontal stays unlit either way: a default cell is
// `TextAlign::General` and the ribbon has no General button to light.
//
// THAT CHANGE IS INVISIBLE TO A PIXEL COUNT, WHICH IS WHY THIS AXIS NOW READS
// GEOMETRY TOO. The two boxes are the same 30x26 at the same y, 33 px apart in
// the alignment cluster (measured live: alignTop x=379, alignMiddle x=412,
// alignBottom x=445, wrapText x=478, each 30 wide). A count-only axis reads
// ~546 for either one and cannot tell a correct golden from a golden of the
// previous build. So each entry also pins the MEDIAN X of the fill, and the
// median -- not the mean or the bounding box -- because it has a 50% breakdown
// point: the ~29 stray anti-aliasing pixels scattered across the whole ribbon
// width cannot move it, while the box moving one button over does.
//
// HOW THE STATE IS READ OFF THE BYTES. A latched Home-tab toggle paints
// `rgba(16,185,129,0.14)` over white -- (222,245,237) -- inside a 30x26 box.
// Counting that fill recovers "was a format toggle lit" from the file alone,
// with no run involved, exactly as the hairline recovers the device pixel
// ratio. Measured over the committed goldens: a capture with no lit toggle in
// frame holds 0..36 such pixels (stray anti-aliasing in the ribbon
// iconography) and one lit box reads ~533..546 depending on what overlaps it.
// There is no golden between 36 and 533, so the floor below sits an order of
// magnitude clear of both sides.

/** The fill a latched Home-tab toggle paints: `rgba(16,185,129,0.14)` on white. */
export const PRESSED_ACCENT_FILL: readonly [number, number, number] = [222, 245, 237];

/**
 * Per-channel slack when matching the fill. The button's rounded corners and
 * its 0.45-alpha border blend against neighbouring pixels, so an exact match
 * would count only the interior and under-report a partially covered button.
 */
const PRESSED_ACCENT_TOLERANCE = 3;

/**
 * Above this many pressed-accent pixels a capture is showing a LATCHED toggle.
 * Measured, not chosen: unlit goldens hold 23..36, lit ones 546+.
 */
export const PRESSED_ACCENT_FLOOR = 200;

/**
 * Where the latched-toggle fill IS, not just how much of it there is.
 *
 * `medianX` / `medianY` are the medians of the matching pixels' coordinates,
 * and the median is the whole point: the ribbon's own iconography contributes
 * ~29 stray anti-aliased pixels spread from x=39 to x=985 in a 1280-wide
 * golden, which would drag a MEAN by tens of pixels and would blow a BOUNDING
 * BOX out to the full ribbon width. A statistic with a 50% breakdown point sits
 * inside the 30x26 box as long as the box is the majority of the fill, which is
 * exactly the condition `PRESSED_ACCENT_FLOOR` already tests.
 *
 * Both are `null` when nothing matched at all.
 */
export interface PressedAccentGeometry {
  pixels: number;
  medianX: number | null;
  medianY: number | null;
}

/** Count AND locate the latched-toggle fill in a decoded golden. PURE. */
export function readPressedAccentGeometry(image: DecodedPng): PressedAccentGeometry {
  const [tr, tg, tb] = PRESSED_ACCENT_FILL;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < image.rgb.length; i += 3) {
    if (
      Math.abs(image.rgb[i] - tr) <= PRESSED_ACCENT_TOLERANCE &&
      Math.abs(image.rgb[i + 1] - tg) <= PRESSED_ACCENT_TOLERANCE &&
      Math.abs(image.rgb[i + 2] - tb) <= PRESSED_ACCENT_TOLERANCE
    ) {
      const p = i / 3;
      xs.push(p % image.width);
      ys.push(Math.floor(p / image.width));
    }
  }
  if (xs.length === 0) return { pixels: 0, medianX: null, medianY: null };
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  return {
    pixels: xs.length,
    medianX: xs[xs.length >> 1],
    medianY: ys[ys.length >> 1],
  };
}

/** Count the latched-toggle fill in a decoded golden. PURE. */
export function readPressedAccentFill(image: DecodedPng): number {
  return readPressedAccentGeometry(image).pixels;
}

/** One golden's latched-toggle measurement. */
export interface RibbonStateReading {
  /** Path relative to `app/e2e`, forward-slashed. */
  file: string;
  pressedAccentPixels: number;
  /**
   * Median x of the fill, or null when the file holds none. Optional so the
   * synthetic populations in the self-test can exercise the count axis alone,
   * but every real reading carries it.
   */
  pressedAccentMedianX?: number | null;
}

/**
 * The document default this corpus is describing, named ONCE so the prose
 * cannot drift from the product the way it did before.
 *
 * `goldenCorpus.test.ts` reads `core/engine/src/style.rs` and
 * `app/src/core/types/types.ts` and fails if either disagrees with this
 * constant. That is the guard the previous re-aim lacked: its comment said
 * Calcula lit Center Vertically "the same way Excel shows Bottom Align pressed
 * on a fresh sheet" -- documenting a MATCH IN ARITY as if it were a match in
 * identity, and going stale silently the moment the default moved.
 */
export const DOCUMENT_DEFAULT_VERTICAL_ALIGN = "bottom";

/**
 * The one Home-tab toggle a brand-new workbook lights, and its `data-testid`.
 *
 * Measured live 2026-08-15 on the changed build: on a brand-new workbook
 * `fmt-alignBottom` carries `data-active="true"` while `fmt-alignTop` and
 * `fmt-alignMiddle` do not, and no horizontal-alignment button is lit at all
 * (a default cell is `TextAlign::General`, and the ribbon has no General
 * button). Same on any never-touched cell.
 */
export const DEFAULT_LIT_ALIGNMENT_TOGGLE = "alignBottom";

/**
 * A golden whose capture is taken on a BRAND-NEW, EMPTY workbook, so the Home
 * tab must read the DEFAULT-STATE ribbon — which, since BUG-0062, is NOT
 * unlit.
 *
 * WHAT THE DEFAULT STATE LOOKS LIKE, and why this axis pins numbers instead of
 * asserting zero. BUG-0028 made the ribbon stop keeping the PREVIOUS cell's
 * format state over an empty cell — but its fix cleared to null, and a null
 * style made the font box read "system-ui" (a font no cell renders in) with
 * every toggle dark. BUG-0062 replaced the null with the DOCUMENT DEFAULT style
 * (index 0), so the build paints exactly ONE lit toggle (546 pressed-accent px
 * when fully visible) on a brand-new workbook. "Unlit everywhere" is therefore
 * no longer the fixed build's face: it is the PRE-BUG-0062 build's face, and a
 * golden reading it is stale in the other direction.
 *
 * WHICH toggle it is moved on 2026-08-15 (§21c item 2): the document default
 * went from `VerticalAlign::Middle` to Excel's `Bottom`, so the lit box is
 * BOTTOM ALIGN and sits 33 px to the right of where Center Vertically sat.
 * The COUNT is blind to that — same 30x26 box, same fill, same row — so each
 * entry also pins `expectedPressedAccentMedianX`. Without it this axis would
 * pass over a golden of the previous build and go on describing it as current,
 * which is the exact failure the axis exists to prevent.
 *
 * Each entry pins the reading its file measures against the CURRENT build,
 * captured deliberately and attributed pixel-by-pixel (open-decisions §21).
 * A future build change in either direction — a toggle un-lighting, a
 * BUG-0028-style latch adding a second box (~+500 px) — leaves the band and
 * fails with a sentence instead of a mystery diff.
 *
 * Declared rather than inferred, and then CHECKED AGAINST THE SPEC in
 * `goldenCorpus.test.ts`: every entry must name a test that really calls
 * `resetToNewWorkbook` before the capture, with no cell write in between. So
 * the table cannot quietly claim a populated capture is empty, and an entry
 * whose test is rewritten fails instead of going stale.
 */
export interface EmptyDocumentGolden {
  /** Path relative to `app/e2e`, forward-slashed. */
  file: string;
  /** Spec source relative to `app/e2e`, forward-slashed. */
  spec: string;
  /** The exact capture name passed to the helper. */
  capture: string;
  /**
   * The pressed-accent reading this file measures against the CURRENT build.
   * 546 = the one default-lit toggle fully visible; the two menu goldens dip
   * slightly where the open dropdown's shadow grazes the box; menu-data-open
   * reads near zero because the Data menu covers the toggle cluster entirely.
   */
  expectedPressedAccent: number;
  /**
   * WHERE that fill sits — the median x of the matching pixels, which is what
   * identifies WHICH toggle is lit.
   *
   * `null` for a golden whose reading is below `PRESSED_ACCENT_FLOOR`: there is
   * no box in frame, so the median is a statistic over anti-aliasing noise and
   * pinning it would be pinning nothing.
   */
  expectedPressedAccentMedianX: number | null;
}

/**
 * How far a reading may drift from its pinned value before the axis fails.
 * A whole toggle is ~500 px, so the band cannot absorb one appearing or
 * disappearing; it exists for antialiasing-level variance only.
 */
export const PRESSED_ACCENT_BAND = 150;

/**
 * How far the fill's median x may drift before the axis fails.
 *
 * MUST stay well under the alignment cluster's 33 px button pitch, or the axis
 * goes back to being unable to tell one lit toggle from its neighbour. It is
 * also comfortably above the observed jitter: every lit golden in the corpus
 * measures its median to the SAME pixel (427 before the parity change), and the
 * two shadow-grazed menu goldens lose ~13 pixels off one edge, which moves a
 * median by about one.
 */
export const PRESSED_ACCENT_MEDIAN_BAND = 12;

/**
 * WHERE THE `expectedPressedAccentMedianX` NUMBERS COME FROM. They are not
 * predictions and they are not carried over.
 *
 * The five lit goldens in this corpus all measured their median at x=427 with
 * Center Vertically lit — one pixel, five files, because the box is the
 * overwhelming majority of the fill. The alignment cluster's button pitch was
 * measured live off the running app on 2026-08-15 (`getBoundingClientRect` of
 * `fmt-alignTop` / `fmt-alignMiddle` / `fmt-alignBottom` / `fmt-wrapText`:
 * x = 379 / 412 / 445 / 478, each 30 wide), so Bottom Align sits exactly 33 px
 * right of Center Vertically and the median lands at 427 + 33 = 460.
 *
 * That derivation was then CHECKED against the running app rather than trusted:
 * a full-window capture of the changed build measures its pressed-accent median
 * at 921 device px at dpr 2 — 460.5 in the CSS coordinates these goldens are
 * recorded in. The pin is a measurement of the build, taken twice by different
 * routes.
 *
 * THE COUNTS ARE DELIBERATELY UNCHANGED. The box is the same size, the same
 * fill and the same row; only its column moved. The two shadow-grazed menu
 * goldens (534, 533) may drift a few pixels now that the box sits 33 px further
 * from the open dropdown, and `PRESSED_ACCENT_BAND` (150) exists for exactly
 * that: a drift of a dozen pixels is antialiasing, a drift of 500 is a toggle
 * appearing or disappearing.
 */
export const EMPTY_DOCUMENT_GOLDENS: EmptyDocumentGolden[] = [
  {
    file: "visual/__screenshots__/core-visual.spec.ts/core-empty-grid.png",
    spec: "visual/core-visual.spec.ts",
    capture: "core-empty-grid",
    expectedPressedAccent: 546,
    expectedPressedAccentMedianX: 460,
  },
  {
    file: "visual/__screenshots__/core-visual.spec.ts/ribbon-core-default-ribbon.png",
    spec: "visual/core-visual.spec.ts",
    capture: "core-default-ribbon",
    expectedPressedAccent: 546,
    expectedPressedAccentMedianX: 460,
  },
  {
    file: "visual/__screenshots__/core-visual.spec.ts/menu-file-open.png",
    spec: "visual/core-visual.spec.ts",
    capture: "menu-file-open",
    expectedPressedAccent: 534,
    expectedPressedAccentMedianX: 460,
  },
  {
    file: "visual/__screenshots__/core-visual.spec.ts/menu-edit-open.png",
    spec: "visual/core-visual.spec.ts",
    capture: "menu-edit-open",
    expectedPressedAccent: 533,
    expectedPressedAccentMedianX: 460,
  },
  {
    // The open Data menu covers the alignment-toggle cluster, so the lit
    // toggle is not in frame at all — the reading is ribbon-iconography AA,
    // and its median is a statistic over that noise rather than over a box.
    file: "visual/__screenshots__/core-visual.spec.ts/menu-data-open.png",
    spec: "visual/core-visual.spec.ts",
    capture: "menu-data-open",
    expectedPressedAccent: 29,
    expectedPressedAccentMedianX: null,
  },
  {
    file: "tests/__screenshots__/grid-rendering.spec.ts/empty-grid-full-window.png",
    spec: "tests/grid-rendering.spec.ts",
    capture: "empty-grid-full-window",
    expectedPressedAccent: 546,
    expectedPressedAccentMedianX: 460,
  },
];

/**
 * Goldens that STILL hold a product state the current build no longer produces.
 *
 * The same two-sided quarantine as `MIS_RECORDED_CORPORA`, for the same reason:
 * every entry must still measure exactly `pressedAccentPixels`, so re-recording
 * the file correctly makes the entry stale and fails, and the entry cannot be
 * widened to cover a second file without measuring that one too.
 */
export interface StaleProductStateGolden {
  /** Path relative to `app/e2e`, forward-slashed. */
  file: string;
  /** Bug ledger id. */
  ledgerId: string;
  reason: string;
  /** What the file measures TODAY, so the entry expires when that changes. */
  pressedAccentPixels: number;
}

// EMPTY, and BUG-0029's entry is gone because the quarantine EXPIRED ITSELF
// exactly as it was designed to (2026-08-12).
//
// The entry required `empty-grid-full-window.png` to still measure 546. The
// `--project=functional` run it was waiting for happened, the file was
// re-recorded against the fixed build, it now measures **36** -- the same 36 its
// re-recorded sibling `core-empty-grid.png` holds, which is the number §7c
// predicted from the bytes without running anything -- and the two-sided rule
// turned red on its own author's entry rather than going quietly stale. That is
// the whole point of the shape: a quarantine that stops describing a real defect
// is a blanket, so it is built to fail when it stops being true.
//
// The live run also confirmed the arithmetic exactly: the comparator reported
// **2,173** differing pixels against the 200-pixel budget, the same 2,173 §7c
// computed off the committed bytes, with 510 of them the predicted
// `221,245,237` fill.
export const STALE_PRODUCT_STATE_GOLDENS: StaleProductStateGolden[] = [];

/** Which stale-state quarantine, if any, claims this golden. PURE. */
export function staleProductStateFor(
  file: string,
  quarantine: StaleProductStateGolden[] = STALE_PRODUCT_STATE_GOLDENS,
): StaleProductStateGolden | undefined {
  return quarantine.find((q) => q.file === file);
}

/**
 * The sentence a corpus holding a product state the build no longer produces
 * should carry.
 *
 * Returns null when every empty-document golden reads unlit. PURE, so the
 * wording has a unit tier -- the point of this guard is to name the FILE and
 * the MECHANISM rather than leave one red screenshot to be explained by eye.
 */
export function describeStaleRibbonState(
  readings: RibbonStateReading[],
  population: EmptyDocumentGolden[] = EMPTY_DOCUMENT_GOLDENS,
  quarantine: StaleProductStateGolden[] = STALE_PRODUCT_STATE_GOLDENS,
): string | null {
  const byFile = new Map(readings.map((r) => [r.file, r]));
  const off = population
    .filter((p) => staleProductStateFor(p.file, quarantine) === undefined)
    .map((p) => {
      const reading = byFile.get(p.file);
      if (reading === undefined) return null;
      const countOff =
        Math.abs(reading.pressedAccentPixels - p.expectedPressedAccent) >
        PRESSED_ACCENT_BAND;
      // The position axis only applies where a box is actually in frame, and
      // only where the reading carries a median at all (the synthetic
      // populations in the self-test exercise the count axis on its own).
      const medianOff =
        p.expectedPressedAccentMedianX !== null &&
        reading.pressedAccentMedianX !== undefined &&
        reading.pressedAccentMedianX !== null &&
        Math.abs(reading.pressedAccentMedianX - p.expectedPressedAccentMedianX) >
          PRESSED_ACCENT_MEDIAN_BAND;
      if (!countOff && !medianOff) return null;
      return { ...p, reading, countOff, medianOff };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);
  if (off.length === 0) return null;

  return (
    `[goldens] A GOLDEN PHOTOGRAPHS A PRODUCT STATE THIS BUILD NO LONGER ` +
    `PRODUCES.\n` +
    `  - ${off.length} empty-workbook golden(s) read a Home-tab state off the ` +
    `pinned band:\n` +
    off
      .map((s) => {
        const parts: string[] = [];
        if (s.countOff) {
          parts.push(
            `${s.reading.pressedAccentPixels} pressed-accent px, pinned ` +
              `${s.expectedPressedAccent} +/- ${PRESSED_ACCENT_BAND}`,
          );
        }
        if (s.medianOff) {
          parts.push(
            `fill centred at x=${s.reading.pressedAccentMedianX}, pinned ` +
              `${s.expectedPressedAccentMedianX} +/- ${PRESSED_ACCENT_MEDIAN_BAND} ` +
              `-- that is the WRONG TOGGLE, not a wrong amount of one`,
          );
        }
        return `      ${s.file}  (${parts.join("; ")})`;
      })
      .join("\n") +
    `\n  The FIXED build paints exactly ONE lit toggle on a brand-new workbook ` +
    `-- BOTTOM ALIGN, because the document default style is ` +
    `VerticalAlign::${DOCUMENT_DEFAULT_VERTICAL_ALIGN.toUpperCase()} (Excel ` +
    `parity: a fresh cell is Horizontal General, Vertical Bottom) and the ` +
    `ribbon reports the DEFAULT style for an empty cell since BUG-0062 (~546 px ` +
    `when fully visible, centred at x=460 in a 1280-wide capture). No ` +
    `horizontal-alignment toggle lights at all: a default cell is General and ` +
    `the ribbon has no General button.\n` +
    `  A reading far BELOW the count pin is the pre-BUG-0062 face (null style, ` +
    `everything dark, font box "system-ui"); a reading far ABOVE it is a ` +
    `BUG-0028-style latch (the PREVIOUS cell's toggles still lit, ~+500 px per ` +
    `extra box). A reading with the RIGHT count at the WRONG x is a golden of ` +
    `the pre-parity build: Center Vertically sat 33 px to the LEFT of Bottom ` +
    `Align (median x=427 rather than 460), same box, same fill, same row -- ` +
    `which is precisely why counting alone stopped being enough.\n` +
    `  THIS AXIS IS INVISIBLE TO BOTH CHECKS ABOVE: dpr and colour profile ask ` +
    `which MACHINE took the picture. This asks which BUILD did. A corpus can be ` +
    `perfectly consistent about the display and still contain a screenshot of a ` +
    `bug that has been fixed.\n` +
    `  The toggle fill is ${PRESSED_ACCENT_FILL.join(",")} over a 30x26 box -- ` +
    `one box is ~590 pixels against a 200-pixel comparator budget, so a golden ` +
    `on the wrong side cannot pass its spec either. Re-record with ` +
    `--update-snapshots=changed, never "all", and attribute the diff first.`
  );
}
