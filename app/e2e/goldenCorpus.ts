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
//          2026-08-11 by decoding all 71 committed goldens: 44 hold the dpr-2
//          hairline and 27 -- the whole `e2e/visual` tree, every one of them
//          re-recorded that afternoon -- hold the dpr-1 hairline. The display
//          this machine actually runs is 200% (GDI DESKTOPHORZRES 2944 /
//          HORZRES 1472 = 2), so dpr 2 is the truth and the visual corpus was
//          re-recorded against an environment that does not exist here.
//          `captureEnvironment.ts` says devicePixelRatio 2 and describes itself
//          as "the display configuration EVERY committed golden was captured
//          under". For 27 of 71 files that sentence is false, and no test could
//          say so, because no test ever looked at a golden.
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
}

/** Read the capture path off a decoded golden. PURE. */
export function readHairline(image: DecodedPng): HairlineReading {
  let dpr1Pixels = 0;
  let dpr2Pixels = 0;
  const count = image.width * image.height;
  for (let p = 0; p < count; p++) {
    const r = image.rgb[p * 3];
    const g = image.rgb[p * 3 + 1];
    const b = image.rgb[p * 3 + 2];
    if (r === g && g === b) {
      if (r === 226) dpr1Pixels++;
      else if (r === 241) dpr2Pixels++;
    }
  }

  const hi = Math.max(dpr1Pixels, dpr2Pixels);
  const lo = Math.min(dpr1Pixels, dpr2Pixels);
  let verdict: CaptureVerdict;
  if (hi < MIN_HAIRLINE_PIXELS) verdict = "no-grid";
  else if (lo * DOMINANCE_MARGIN > hi) verdict = "ambiguous";
  else verdict = dpr2Pixels > dpr1Pixels ? "dpr2" : "dpr1";

  return {
    dpr1Pixels,
    dpr2Pixels,
    verdict,
    devicePixelRatio: verdict === "dpr1" ? 1 : verdict === "dpr2" ? 2 : null,
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
