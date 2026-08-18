//! FILENAME: app/e2e/__tests__/goldenCorpus.test.ts
// PURPOSE: The capture-environment census, run over the COMMITTED GOLDEN BYTES.
// CONTEXT: `captureEnvironment.test.ts` pins the wording of the run-time guard
//          against synthetic readings. It cannot see the corpus. This one reads
//          every committed PNG, so the question "which capture path did this
//          golden come from" is answered from the file rather than from memory
//          of which afternoon it was recorded on.
//
//          It is the check that was missing when 27 goldens were re-recorded on
//          2026-08-11 onto a dpr the machine does not produce, while a file
//          declaring "the display configuration EVERY committed golden was
//          captured under" sat two directories away and stayed green.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { CAPTURE_ENVIRONMENT } from "../captureEnvironment";
import {
  decodePng,
  describeCorpusSplit,
  describeProfileSplit,
  readHairline,
  readColourProfile,
  quarantineFor,
  MIS_RECORDED_CORPORA,
  HAIRLINE_DPR1,
  HAIRLINE_DPR2,
  CHROME_GREEN_SRGB,
  CHROME_GREEN_DISPLAY,
  ACCENT_SRGB,
  readPressedAccentFill,
  describeStaleRibbonState,
  staleProductStateFor,
  EMPTY_DOCUMENT_GOLDENS,
  STALE_PRODUCT_STATE_GOLDENS,
  PRESSED_ACCENT_FLOOR,
  PRESSED_ACCENT_MEDIAN_BAND,
  DOCUMENT_DEFAULT_VERTICAL_ALIGN,
  DEFAULT_LIT_ALIGNMENT_TOGGLE,
  readPressedAccentGeometry,
  type GoldenReading,
  type MisRecordedCorpus,
  type RibbonStateReading,
  type StaleProductStateGolden,
  type EmptyDocumentGolden,
} from "../goldenCorpus";

// vitest's root is `app/`, and this file is loaded through a transform whose
// `import.meta.url` is not a file: URL under the jsdom environment. The corpus
// is addressed from the project root instead, which is stable in both.
const E2E_ROOT = join(process.cwd(), "e2e");

function walkPngs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "test-results") continue;
      walkPngs(full, acc);
    } else if (entry.name.endsWith(".png") && full.includes("__screenshots__")) {
      acc.push(full);
    }
  }
  return acc;
}

/** Every committed golden, read once and shared by the cases below. */
const readings: GoldenReading[] = walkPngs(E2E_ROOT)
  .map((full) => {
    const file = relative(E2E_ROOT, full).split(sep).join("/");
    const image = decodePng(readFileSync(full));
    return { file, ...readHairline(image), ...readColourProfile(image) };
  })
  .sort((a, b) => a.file.localeCompare(b.file));

/**
 * The PRODUCT-STATE axis, read off the same bytes. Kept separate from
 * `readings` because it has a different population -- only the goldens that
 * contain a Home ribbon can hold a latched toggle -- and a different remedy.
 */
const ribbonStates: RibbonStateReading[] = walkPngs(E2E_ROOT)
  .map((full) => {
    // BOTH axes off the same decode: how much fill, and WHERE it is. The
    // second one is what tells Bottom Align from Center Vertically -- the
    // count cannot, because they are the same box in the same row.
    const g = readPressedAccentGeometry(decodePng(readFileSync(full)));
    return {
      file: relative(E2E_ROOT, full).split(sep).join("/"),
      pressedAccentPixels: g.pixels,
      pressedAccentMedianX: g.medianX,
    };
  })
  .sort((a, b) => a.file.localeCompare(b.file));

describe("the committed golden corpus", () => {
  it("is not empty, and every file decodes", () => {
    // Non-vacuity: a walk that silently found nothing would make every
    // assertion below pass while checking no bytes at all.
    expect(readings.length).toBeGreaterThan(50);
  });

  it("classifies grid captures and abstains on the ones with no grid in them", () => {
    // The population is the goldens that actually contain gridlines. Status-bar
    // strips and ribbon bands carry none, so they are outside it -- stated,
    // rather than guessed at and quietly counted as agreeing.
    const classified = readings.filter((r) => r.devicePixelRatio !== null);
    const abstained = readings.filter((r) => r.verdict === "no-grid");
    const ambiguous = readings.filter((r) => r.verdict === "ambiguous");

    expect(classified.length).toBeGreaterThan(40);
    expect(classified.length + abstained.length).toBe(readings.length);
    expect(
      ambiguous.map((r) => r.file),
      "a golden whose two hairline constants are within a factor of 4 of each " +
        "other cannot be attributed to a capture path; investigate rather than " +
        "widening the margin",
    ).toEqual([]);
  });

  it("holds every golden on the run environment's capture path, except the quarantined ones", () => {
    const message = describeCorpusSplit(
      readings,
      CAPTURE_ENVIRONMENT.devicePixelRatio,
    );
    expect(message, message ?? "").toBeNull();
  });

  it("holds every golden on the run environment's COLOUR PROFILE", () => {
    // The second axis, and the one that actually failed 31 functional tests on
    // 2026-08-11. It is not a restatement of the case above: the profile
    // transform is the identity on neutrals and both hairline constants are
    // neutral, so a corpus can agree perfectly about dpr and still be two
    // corpora. There is no quarantine argument here on purpose -- the whole
    // corpus is being moved onto the pin in one change, which is the remedy the
    // message itself prescribes.
    const message = describeProfileSplit(readings, CAPTURE_ENVIRONMENT.colourProfile);
    expect(message, message ?? "").toBeNull();
  });

  it("classifies chrome captures and abstains on the ones with no saturated chrome", () => {
    // Non-vacuity for the case above. If nothing were classifiable, that
    // assertion would pass over an empty set and say nothing at all -- which is
    // exactly how the dpr axis stayed green over a split corpus for a day.
    const classified = readings.filter(
      (r) => r.profileVerdict === "srgb" || r.profileVerdict === "display",
    );
    const ambiguous = readings.filter((r) => r.profileVerdict === "ambiguous");
    expect(
      classified.length,
      "no golden holds enough of the app's declared chrome to be attributed to " +
        "a colour profile, so the profile census is checking nothing",
    ).toBeGreaterThan(5);
    expect(ambiguous.map((r) => r.file)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The quarantine cannot outlive the defect, and cannot grow to cover a second
  // one. These two cases are what makes it a quarantine rather than a blanket.
  // -------------------------------------------------------------------------

  it.each(MIS_RECORDED_CORPORA)(
    "quarantine $ledgerId still describes a real, unfixed split",
    (corpus: MisRecordedCorpus) => {
      const stale = corpus.files.filter((f) => {
        const r = readings.find((x) => x.file === f);
        return r === undefined || r.devicePixelRatio !== corpus.recordedAt;
      });
      expect(
        stale,
        `${corpus.ledgerId} claims these files are recorded at dpr ` +
          `${corpus.recordedAt}, but they no longer are (or no longer exist). ` +
          `If they were re-recorded correctly, DELETE the entry -- a quarantine ` +
          `that has stopped describing a real defect is a blanket.`,
      ).toEqual([]);
      expect(corpus.reason.length).toBeGreaterThan(80);
      expect(corpus.ledgerId).toMatch(/^BUG-\d{4}$/);
    },
  );

  it.each(MIS_RECORDED_CORPORA)(
    "quarantine $ledgerId names exactly the classifiable goldens under $dir",
    (corpus: MisRecordedCorpus) => {
      const actual = readings
        .filter(
          (r) =>
            r.file.startsWith(`${corpus.dir}/`) && r.devicePixelRatio !== null,
        )
        .map((r) => r.file)
        .sort();
      expect(
        [...corpus.files].sort(),
        `${corpus.ledgerId} must enumerate its files, so that a golden added ` +
          `to ${corpus.dir}/ on the WRONG capture path fails here by name ` +
          `instead of being absorbed by a directory prefix.`,
      ).toEqual(actual);
    },
  );
});

describe("the corpus-split detector actually fires", () => {
  // The census above is only worth its runtime if it can fail. Each arm is
  // driven to failure against synthetic readings, because the real corpus is
  // (by construction) always in the state the census accepts.
  // These fixtures exercise the DPR axis, so they carry no chrome at all: the
  // profile reader would abstain on them, and that is the honest shape for a
  // grid capture. Spelling it out keeps the two axes independent here as well
  // as in the production code.
  // ...and `span: 1` because they are GRID captures: gridlines run the full
  // height and width, which is exactly what separates them from a patch of
  // chrome that happens to share the hairline colour.
  const gridOnly = {
    srgbPixels: 0,
    displayPixels: 0,
    profileVerdict: "no-chrome" as const,
    span: 1,
  };
  const clean: GoldenReading[] = [
    { file: "tests/__screenshots__/a.spec.ts/one.png", dpr1Pixels: 0, dpr2Pixels: 39000, verdict: "dpr2", devicePixelRatio: 2, ...gridOnly },
    { file: "tests/__screenshots__/a.spec.ts/two.png", dpr1Pixels: 0, dpr2Pixels: 38000, verdict: "dpr2", devicePixelRatio: 2, ...gridOnly },
  ];

  it("says nothing when the whole corpus is on one path", () => {
    expect(describeCorpusSplit(clean, 2, [])).toBeNull();
  });

  it("names the stray FILE, both hairline constants, and the re-record trap", () => {
    const strayed: GoldenReading[] = [
      ...clean,
      { file: "tests/__screenshots__/a.spec.ts/three.png", dpr1Pixels: 39961, dpr2Pixels: 0, verdict: "dpr1", devicePixelRatio: 1, ...gridOnly },
    ];
    const msg = describeCorpusSplit(strayed, 2, []);
    expect(msg).not.toBeNull();
    expect(msg).toContain("tests/__screenshots__/a.spec.ts/three.png");
    // It must NOT accuse the files that are fine.
    expect(msg).not.toContain("one.png");
    expect(msg).toContain(HAIRLINE_DPR1);
    expect(msg).toContain(HAIRLINE_DPR2);
    // The mechanism and the consequence, so nobody re-derives them.
    expect(msg).toContain("1 DEVICE pixel");
    expect(msg).toContain("re-record");
  });

  it("goes quiet for a stray that a quarantine names, and only for that one", () => {
    const strayed: GoldenReading[] = [
      { file: "visual/__screenshots__/v.spec.ts/known.png", dpr1Pixels: 39961, dpr2Pixels: 0, verdict: "dpr1", devicePixelRatio: 1, ...gridOnly },
      { file: "visual/__screenshots__/v.spec.ts/fresh.png", dpr1Pixels: 39961, dpr2Pixels: 0, verdict: "dpr1", devicePixelRatio: 1, ...gridOnly },
    ];
    const quarantine: MisRecordedCorpus[] = [
      {
        dir: "visual",
        recordedAt: 1,
        ledgerId: "BUG-9999",
        reason: "x".repeat(90),
        files: ["visual/__screenshots__/v.spec.ts/known.png"],
      },
    ];
    const msg = describeCorpusSplit(strayed, 2, quarantine);
    expect(msg).not.toBeNull();
    expect(msg).toContain("fresh.png");
    expect(msg).not.toContain("known.png");
    expect(quarantineFor("visual/__screenshots__/v.spec.ts/known.png", quarantine)).toBeDefined();
    expect(quarantineFor("visual/__screenshots__/v.spec.ts/fresh.png", quarantine)).toBeUndefined();
  });
});

describe("the colour-profile detector actually fires", () => {
  // Same discipline as the dpr detector above: the real corpus is (by
  // construction) always in the state the census accepts, so every arm is
  // driven to failure against synthetic readings.
  const base = { dpr1Pixels: 0, dpr2Pixels: 39000, verdict: "dpr2" as const, devicePixelRatio: 2, span: 1 };
  const pinned: GoldenReading[] = [
    { file: "tests/__screenshots__/a.spec.ts/one.png", ...base, srgbPixels: 29569, displayPixels: 0, profileVerdict: "srgb" },
    { file: "tests/__screenshots__/a.spec.ts/two.png", ...base, srgbPixels: 1200, displayPixels: 0, profileVerdict: "srgb" },
  ];

  it("says nothing when the whole corpus is under the pin", () => {
    expect(describeProfileSplit(pinned, "srgb", [])).toBeNull();
  });

  it("names the stray FILE, both palettes, and why the dpr check cannot see this", () => {
    const strayed: GoldenReading[] = [
      ...pinned,
      { file: "tests/__screenshots__/a.spec.ts/three.png", ...base, srgbPixels: 0, displayPixels: 29569, profileVerdict: "display" },
    ];
    const msg = describeProfileSplit(strayed, "srgb", []);
    expect(msg).not.toBeNull();
    expect(msg).toContain("tests/__screenshots__/a.spec.ts/three.png");
    // It must not accuse the files that are fine.
    expect(msg).not.toContain("one.png");
    expect(msg).toContain(CHROME_GREEN_SRGB);
    expect(msg).toContain(CHROME_GREEN_DISPLAY);
    expect(msg).toContain(ACCENT_SRGB);
    // The two things a reader would otherwise have to rediscover.
    expect(msg).toContain("IDENTITY on neutrals");
    expect(msg).toContain("fix the launcher rather than the corpus");
  });

  it("fires in the OTHER direction too, so a lost pin is not read as a stale corpus", () => {
    // If the launcher ever stops delivering --force-color-profile=sRGB, the
    // whole corpus is suddenly on the wrong side and the correct fix is the
    // launcher. The detector must still speak.
    const msg = describeProfileSplit(pinned, "display", []);
    expect(msg).not.toBeNull();
    expect(msg).toContain("srgb palette");
  });

  it("abstains rather than guessing on a golden with no saturated chrome in it", () => {
    const bare: GoldenReading[] = [
      { file: "tests/__screenshots__/a.spec.ts/grid.png", ...base, srgbPixels: 0, displayPixels: 0, profileVerdict: "no-chrome" },
    ];
    expect(describeProfileSplit(bare, "srgb", [])).toBeNull();
  });
});

describe("the colour-profile reader", () => {
  function withColour(w: number, h: number, triple: [number, number, number]) {
    const rgb = new Uint8Array(w * h * 3);
    for (let p = 0; p < w * h; p++) {
      rgb[p * 3] = triple[0];
      rgb[p * 3 + 1] = triple[1];
      rgb[p * 3 + 2] = triple[2];
    }
    return { width: w, height: h, rgb };
  }

  it("reads the pin off #217346 and #10b981, and the display profile off their transforms", () => {
    expect(readColourProfile(withColour(40, 40, [33, 115, 70])).profileVerdict).toBe("srgb");
    expect(readColourProfile(withColour(40, 40, [16, 185, 129])).profileVerdict).toBe("srgb");
    expect(readColourProfile(withColour(40, 40, [63, 112, 75])).profileVerdict).toBe("display");
    expect(readColourProfile(withColour(40, 40, [95, 180, 134])).profileVerdict).toBe("display");
  });

  it("IGNORES NEUTRALS, which is the whole reason this axis needs its own reader", () => {
    // The wide-gamut -> sRGB transform is the identity on greys. A reader that
    // counted them would report agreement for a capture that carries no
    // evidence either way -- and every grid golden is mostly grey.
    const grey = readColourProfile(withColour(200, 200, [241, 241, 241]));
    expect(grey.srgbPixels).toBe(0);
    expect(grey.displayPixels).toBe(0);
    expect(grey.profileVerdict).toBe("no-chrome");
  });

  it("abstains below the chrome floor instead of deciding on a handful of pixels", () => {
    const tiny = withColour(4, 4, [33, 115, 70]); // 16 px, below MIN_CHROME_PIXELS
    expect(readColourProfile(tiny).profileVerdict).toBe("no-chrome");
  });
});

describe("the hairline reader", () => {
  function solid(w: number, h: number, rgbTriple: [number, number, number]) {
    const rgb = new Uint8Array(w * h * 3);
    for (let p = 0; p < w * h; p++) {
      rgb[p * 3] = rgbTriple[0];
      rgb[p * 3 + 1] = rgbTriple[1];
      rgb[p * 3 + 2] = rgbTriple[2];
    }
    return { width: w, height: h, rgb };
  }

  it("reads dpr 2 off the 241 constant and dpr 1 off the 226 constant", () => {
    expect(readHairline(solid(100, 100, [241, 241, 241])).devicePixelRatio).toBe(2);
    expect(readHairline(solid(100, 100, [226, 226, 226])).devicePixelRatio).toBe(1);
  });

  it("abstains on an image with no gridlines rather than guessing", () => {
    const r = readHairline(solid(100, 100, [255, 255, 255]));
    expect(r.verdict).toBe("no-grid");
    expect(r.devicePixelRatio).toBeNull();
  });

  it("refuses to attribute an image holding both constants in comparable amounts", () => {
    const img = solid(200, 100, [241, 241, 241]);
    // Repaint half the pixels with the other constant.
    for (let p = 0; p < 100 * 100; p++) {
      img.rgb[p * 3] = 226;
      img.rgb[p * 3 + 1] = 226;
      img.rgb[p * 3 + 2] = 226;
    }
    expect(readHairline(img).verdict).toBe("ambiguous");
  });

  it("does not mistake a coloured pixel for a grey hairline", () => {
    // 241,241,226 is not the hairline; only true greys count.
    const img = solid(100, 100, [241, 241, 226]);
    expect(img.rgb[2]).toBe(226);
    expect(readHairline(img).verdict).toBe("no-grid");
  });

  // --------------------------------------------------------------------------
  // The chrome-blob false positive, which a pixel COUNT cannot exclude.
  // --------------------------------------------------------------------------
  /** Paint an axis-aligned rectangle of `rgbTriple` into `img`. */
  function fill(
    img: { width: number; height: number; rgb: Uint8Array },
    x0: number,
    y0: number,
    w: number,
    h: number,
    rgbTriple: [number, number, number],
  ): void {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const p = (y * img.width + x) * 3;
        img.rgb[p] = rgbTriple[0];
        img.rgb[p + 1] = rgbTriple[1];
        img.rgb[p + 2] = rgbTriple[2];
      }
    }
  }

  it("abstains on a BLOB of chrome in the hairline colour, however many pixels it is", () => {
    // This is `ribbon-ribbon-tab-insert.png` and `autocomplete-dropdown-visible.png`
    // in miniature: #F1F1F1 is the app's chrome grey as well as the dpr-2
    // hairline, so a ribbon band clears any sane pixel floor while containing
    // no gridline at all. 900 pixels here -- eighteen times the floor.
    const img = solid(200, 200, [255, 255, 255]);
    fill(img, 10, 10, 30, 30, [241, 241, 241]);
    const r = readHairline(img);
    expect(r.dpr2Pixels).toBe(900);
    expect(r.span).toBeLessThan(0.25);
    expect(r.verdict).toBe("no-grid");
    expect(r.devicePixelRatio).toBeNull();
  });

  it("classifies a SPARSE genuine grid that holds fewer pixels than that blob", () => {
    // The other half of the trap, and the reason the floor could not simply be
    // raised: `grid-comments-cell-with-indicator.png` is a real grid capture
    // holding 108 hairline pixels -- fewer than the 172-pixel false positive it
    // sits next to. Count cannot separate these two populations in EITHER
    // direction; structure separates them completely.
    const img = solid(100, 100, [255, 255, 255]);
    for (let x = 0; x < 100; x += 50) fill(img, x, 0, 1, 100, [226, 226, 226]);
    for (let y = 0; y < 100; y += 50) fill(img, 0, y, 100, 1, [226, 226, 226]);
    const r = readHairline(img);
    expect(r.dpr1Pixels).toBeLessThan(900); // sparser than the blob above
    expect(r.span).toBeGreaterThan(0.9); // ...but it SPANS the image
    expect(r.verdict).toBe("dpr1");
  });

  it("reports span on the WINNING side, not on both constants mixed together", () => {
    // A full grid in one constant, plus a chrome blob in the other. The blob
    // must not be able to drag the winner's span down and disqualify a genuine
    // capture -- which a single shared row/column set would let it do.
    const img = solid(100, 100, [255, 255, 255]);
    for (let x = 0; x < 100; x += 25) fill(img, x, 0, 1, 100, [226, 226, 226]);
    for (let y = 0; y < 100; y += 25) fill(img, 0, y, 100, 1, [226, 226, 226]);
    fill(img, 80, 80, 5, 5, [241, 241, 241]);
    const r = readHairline(img);
    expect(r.dpr2Pixels).toBe(25);
    expect(r.verdict).toBe("dpr1");
    expect(r.span).toBeGreaterThan(0.9);
  });
});

describe("the PNG decoder", () => {
  it("round-trips a real committed golden to the size its IHDR declares", () => {
    const full = join(
      E2E_ROOT,
      "tests",
      "__screenshots__",
      "grid-rendering.spec.ts",
      "grid-empty-grid-default.png",
    );
    const bytes = readFileSync(full);
    const img = decodePng(bytes);
    expect(img.width).toBe(bytes.readUInt32BE(16));
    expect(img.height).toBe(bytes.readUInt32BE(20));
    expect(img.rgb.length).toBe(img.width * img.height * 3);
    // And the file it is measured against really does hold a hairline, in the
    // quantity the mechanism predicts -- on whichever side the corpus is
    // currently recorded at. Naming a side here hard-codes the very thing this
    // module exists to READ, and the 2026-08-18 re-record duly rotted the
    // assertion that did.
    const reading = readHairline(img);
    const dominant = Math.max(reading.dpr1Pixels, reading.dpr2Pixels);
    expect(dominant).toBeGreaterThan(30_000);
    expect(reading.devicePixelRatio).toBe(CAPTURE_ENVIRONMENT.devicePixelRatio);
  });

  it("refuses bytes that are not a PNG instead of returning garbage", () => {
    expect(() => decodePng(Buffer.from("not a png at all"))).toThrow(/signature/);
  });

  it("agrees with statSync that every golden it read is a real file", () => {
    expect(readings.length).toBe(walkPngs(E2E_ROOT).length);
    for (const r of readings.slice(0, 5)) {
      expect(statSync(join(E2E_ROOT, ...r.file.split("/"))).size).toBeGreaterThan(0);
    }
  });
});
// ===========================================================================
// THE THIRD AXIS: which BUILD took the picture, not which machine
// ===========================================================================
// dpr and colour profile both ask about the display. Neither can see a golden
// that photographs a product state the application no longer produces, which is
// what BUG-0029 is: `tests/.../empty-grid-full-window.png` still shows the
// latched Center-Vertically toggle that BUG-0028 removed from an empty
// workbook, because the pass that fixed the product re-recorded the `visual`
// project and no other.

/** Calls that put something in a cell, i.e. that end the "empty workbook" claim. */
const WRITE_CALLS = [
  "setCellValueDirect",
  "setCellValue",
  "typeIntoCell",
  "keyboard.type(",
  "applyFormatting",
  "insertRow",
  "insertColumn",
  "pasteInto",
];

function readSpec(spec: string): string {
  return readFileSync(join(E2E_ROOT, ...spec.split("/")), "utf8");
}

/** The `test(...)` block that contains `capture`, sliced out of the spec source. */
function testBlockFor(source: string, capture: string): string {
  const at = source.indexOf(`"${capture}"`);
  if (at < 0) return "";
  const starts = [...source.matchAll(/\n\s*test\(/g)].map((m) => m.index ?? 0);
  const start = starts.filter((i) => i < at).pop();
  if (start === undefined) return "";
  const end = starts.find((i) => i > at) ?? source.length;
  return source.slice(start, end);
}

/** The file's `test.beforeEach` body, near enough for a token scan. */
function beforeEachOf(source: string): string {
  const at = source.indexOf("test.beforeEach(");
  return at < 0 ? "" : source.slice(at, at + 600);
}

describe("the golden corpus and the build that produced it", () => {
  it("shows the DEFAULT-STATE Home tab on every golden taken on a brand-new workbook", () => {
    // Not "unlit": since BUG-0062 the fixed build lights exactly one toggle on
    // an empty workbook -- BOTTOM ALIGN since the 2026-08-15 Excel-parity
    // change (§21c item 2) moved the document default from
    // `VerticalAlign::Middle` to `Bottom`. Each declared golden pins BOTH the
    // amount of pressed-accent fill and WHERE it sits, because the two toggles
    // are the same box in the same row and differ only by 33 px of x.
    //
    // Off the band in EITHER direction, or at the wrong x, is a build this tree
    // no longer produces. EXPECTED RED until the empty-document goldens are
    // re-captured against the parity build: they still photograph Center
    // Vertically at x=427. That is the axis working -- it names the five files
    // and the mechanism instead of leaving five mystery diffs for the
    // comparator to report as "some pixels moved".
    const message = describeStaleRibbonState(ribbonStates);
    expect(message, message ?? "").toBeNull();
  });

  it("pins the SAME default the product actually ships, read out of the product's own sources", () => {
    // THE GUARD THE PREVIOUS RE-AIM DID NOT HAVE, and the reason it went stale
    // in the most expensive way available: its comment said the fixed build
    // lights Center Vertically "the same way Excel shows Bottom Align pressed
    // on a fresh sheet" -- documenting a coincidence of ARITY (one lit toggle
    // on each side) as if it were a match of IDENTITY. When the document
    // default moved to Excel's Bottom on 2026-08-15, that sentence became
    // false and nothing in the tree said so.
    //
    // So the corpus's claim about the product is now CHECKED against the
    // product. Four authorities, one number: whichever one a future pass
    // changes, this fails and names the others.
    const repoRoot = join(process.cwd(), "..");
    const read = (p: string) => readFileSync(join(repoRoot, ...p.split("/")), "utf8");

    // 1. The Rust authority: CellStyle::new().
    const styleRs = read("core/engine/src/style.rs");
    const rustDefault = /vertical_align:\s*VerticalAlign::(\w+),/.exec(styleRs)?.[1];
    expect(
      rustDefault?.toLowerCase(),
      "core/engine/src/style.rs CellStyle::new() is the authority for the " +
        "document default; goldenCorpus.ts describes a different one",
    ).toBe(DOCUMENT_DEFAULT_VERTICAL_ALIGN);

    // 2. The derived enum default, which is where a serde-defaulted field lands.
    expect(
      /#\[default\]\s*\r?\n\s*(\w+),/.exec(
        styleRs.slice(styleRs.indexOf("pub enum VerticalAlign")),
      )?.[1]?.toLowerCase(),
      "VerticalAlign's #[default] variant must agree with CellStyle::new()",
    ).toBe(DOCUMENT_DEFAULT_VERTICAL_ALIGN);

    // 3. The TypeScript mirror the frontend renders from.
    expect(
      /verticalAlign:\s*"(\w+)"/.exec(read("app/src/core/types/types.ts"))?.[1],
      "app/src/core/types/types.ts DEFAULT_STYLE mirrors the Rust default; a " +
        "disagreement renders one way and reports another",
    ).toBe(DOCUMENT_DEFAULT_VERTICAL_ALIGN);

    // 4. The renderer's OWN fallback, which fires for any style object that
    //    omits the field and is a second, independent default.
    expect(
      /const vAlign = baseCellStyle\.verticalAlign \|\| "(\w+)";/.exec(
        read("app/src/core/lib/gridRenderer/rendering/cells.ts"),
      )?.[1],
      "the canvas renderer's fallback is a SECOND default; leaving it behind " +
        "gives a build where Rust says one thing and the pixels say another",
    ).toBe(DOCUMENT_DEFAULT_VERTICAL_ALIGN);

    // And the toggle this corpus expects to see lit really is a ribbon item.
    expect(
      read("app/extensions/BuiltIn/HomeTab/homeTabConfig.ts"),
      `${DEFAULT_LIT_ALIGNMENT_TOGGLE} is not a Home-tab item any more`,
    ).toContain(`id: "${DEFAULT_LIT_ALIGNMENT_TOGGLE}"`);
  });

  it("measures a latched toggle at all - the reader is not returning zero everywhere", () => {
    // Non-vacuity, and the exact shape the dpr axis lacked for a day: if
    // nothing in the corpus ever measured LIT, the case above would be passing
    // over a reader that cannot see its own subject.
    const lit = ribbonStates.filter((r) => r.pressedAccentPixels > PRESSED_ACCENT_FLOOR);
    expect(
      lit.length,
      "no committed golden holds the latched-toggle fill, so the product-state " +
        "census is checking nothing",
    ).toBeGreaterThan(5);

    // And the two sides are separated by an order of magnitude, which is what
    // makes PRESSED_ACCENT_FLOOR a measurement rather than a guess.
    const unlit = ribbonStates
      .filter((r) => r.pressedAccentPixels > 0 && r.pressedAccentPixels <= PRESSED_ACCENT_FLOOR)
      .map((r) => r.pressedAccentPixels);
    expect(Math.max(...unlit)).toBeLessThan(
      Math.min(...lit.map((r) => r.pressedAccentPixels)) / 4,
    );
  });

  it.each(EMPTY_DOCUMENT_GOLDENS)(
    "$capture really is captured on an empty workbook - the population cannot lie",
    (golden: EmptyDocumentGolden) => {
      // The declared population is checked against the SPEC, so an entry cannot
      // claim a populated capture is empty and cannot survive its test being
      // rewritten to write a cell first.
      expect(
        ribbonStates.some((r) => r.file === golden.file),
        `${golden.file} is declared as an empty-document golden but no such file exists`,
      ).toBe(true);

      const source = readSpec(golden.spec);
      const block = testBlockFor(source, golden.capture);
      expect(
        block.length,
        `no test( ... ) block in ${golden.spec} contains the capture "${golden.capture}"`,
      ).toBeGreaterThan(0);

      const resetAt = block.indexOf("resetToNewWorkbook(");
      const inBeforeEach = beforeEachOf(source).includes("resetToNewWorkbook(");
      expect(
        resetAt >= 0 || inBeforeEach,
        `"${golden.capture}" is declared empty-document, but neither its test ` +
          `nor ${golden.spec}'s beforeEach calls resetToNewWorkbook`,
      ).toBe(true);

      const captureAt = block.indexOf(`"${golden.capture}"`);
      const between = block.slice(resetAt >= 0 ? resetAt : 0, captureAt);
      const writes = WRITE_CALLS.filter((w) => between.includes(w));
      expect(
        writes,
        `"${golden.capture}" writes to the grid before it is captured ` +
          `(${writes.join(", ")}), so it is NOT an empty-document golden`,
      ).toEqual([]);
    },
  );

  it.each(STALE_PRODUCT_STATE_GOLDENS)(
    "stale-state quarantine $ledgerId still describes a real, un-re-recorded golden",
    (entry: StaleProductStateGolden) => {
      const reading = ribbonStates.find((r) => r.file === entry.file);
      expect(
        reading,
        `${entry.ledgerId} names ${entry.file}, which no longer exists`,
      ).toBeDefined();
      expect(
        reading?.pressedAccentPixels,
        `${entry.ledgerId} claims ${entry.file} measures ${entry.pressedAccentPixels} ` +
          `pressed-accent pixels. It does not. If it was re-recorded against the ` +
          `fixed build, DELETE the entry - a quarantine that has stopped ` +
          `describing a real defect is a blanket.`,
      ).toBe(entry.pressedAccentPixels);
      expect(
        EMPTY_DOCUMENT_GOLDENS.some((g) => g.file === entry.file),
        `${entry.ledgerId} quarantines a golden that is not in the declared ` +
          `empty-document population, so the rule it suppresses never applied to it`,
      ).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(80);
      expect(entry.ledgerId).toMatch(/^BUG-\d{4}$/);
    },
  );
});

describe("the stale-product-state detector actually fires", () => {
  const population: EmptyDocumentGolden[] = [
    {
      file: "visual/__screenshots__/v.spec.ts/fresh.png",
      spec: "visual/v.spec.ts",
      capture: "fresh",
      expectedPressedAccent: 546,
      expectedPressedAccentMedianX: 460,
    },
    {
      file: "visual/__screenshots__/v.spec.ts/known.png",
      spec: "visual/v.spec.ts",
      capture: "known",
      expectedPressedAccent: 546,
      expectedPressedAccentMedianX: 460,
    },
  ];

  it("says nothing when every empty-document golden reads its pinned band", () => {
    expect(
      describeStaleRibbonState(
        [
          {
            file: "visual/__screenshots__/v.spec.ts/fresh.png",
            pressedAccentPixels: 546,
            pressedAccentMedianX: 460,
          },
          {
            file: "visual/__screenshots__/v.spec.ts/known.png",
            pressedAccentPixels: 533,
            pressedAccentMedianX: 459,
          },
        ],
        population,
        [],
      ),
    ).toBeNull();
  });

  it("fires in BOTH directions: the pre-BUG-0062 unlit face and a BUG-0028-style extra latch", () => {
    // Below the band: the null-style build (everything dark, ~36 px of AA).
    const unlit = describeStaleRibbonState(
      [{ file: "visual/__screenshots__/v.spec.ts/fresh.png", pressedAccentPixels: 36 }],
      population,
      [],
    );
    expect(unlit).toContain("fresh.png");
    expect(unlit).toContain("BUG-0062");
    // Above the band: a second lit box latched from the previous cell.
    const latched = describeStaleRibbonState(
      [{ file: "visual/__screenshots__/v.spec.ts/fresh.png", pressedAccentPixels: 1092 }],
      population,
      [],
    );
    expect(latched).toContain("fresh.png");
    expect(latched).toContain("BUG-0028");
  });

  it("fires on the RIGHT count at the WRONG position - a golden of the pre-parity build", () => {
    // THE CASE THE COUNT AXIS ALONE COULD NEVER SEE, and the reason this axis
    // was re-aimed rather than just re-worded (§21c item 2). Before the parity
    // change the one lit toggle was Center Vertically, 33 px to the LEFT:
    // identical box, identical fill, identical row, identical PIXEL COUNT.
    // A corpus still holding that picture is a corpus of a build this tree no
    // longer produces, and until the median was pinned it passed.
    const preParity = describeStaleRibbonState(
      [
        {
          file: "visual/__screenshots__/v.spec.ts/fresh.png",
          pressedAccentPixels: 546,
          pressedAccentMedianX: 427,
        },
      ],
      population,
      [],
    );
    expect(preParity).toContain("fresh.png");
    expect(preParity).toContain("WRONG TOGGLE");
    expect(preParity).toContain("427");
    expect(preParity).toContain("BOTTOM ALIGN");

    // ... and it does NOT fire for the same count at the RIGHT position, nor
    // for jitter inside the band. A guard that fired on everything would be
    // no guard at all.
    for (const medianX of [460, 460 - PRESSED_ACCENT_MEDIAN_BAND, 460 + PRESSED_ACCENT_MEDIAN_BAND]) {
      expect(
        describeStaleRibbonState(
          [
            {
              file: "visual/__screenshots__/v.spec.ts/fresh.png",
              pressedAccentPixels: 546,
              pressedAccentMedianX: medianX,
            },
          ],
          population,
          [],
        ),
        `median x=${medianX} is inside the band and must not fire`,
      ).toBeNull();
    }

    // The band is narrower than the 33 px button pitch, or the axis is back to
    // being unable to tell one toggle from its neighbour.
    expect(PRESSED_ACCENT_MEDIAN_BAND).toBeLessThan(33);
  });

  it("names the stray FILE, its count, and why the other two axes cannot see it", () => {
    const message = describeStaleRibbonState(
      [
        { file: "visual/__screenshots__/v.spec.ts/fresh.png", pressedAccentPixels: 23 },
        { file: "visual/__screenshots__/v.spec.ts/known.png", pressedAccentPixels: 546 },
      ],
      population,
      [],
    );
    expect(message).toContain("visual/__screenshots__/v.spec.ts/fresh.png");
    expect(message).toContain("23");
    expect(message).toContain("which BUILD");
    expect(message).toContain("--update-snapshots=changed");
    // The on-band sibling must NOT be named: a message that lists the whole
    // corpus is the blanket this program keeps refusing.
    expect(message).not.toContain("known.png");
  });

  it("goes quiet for a stray a quarantine names, and only for that one", () => {
    const quarantine: StaleProductStateGolden[] = [
      {
        file: "visual/__screenshots__/v.spec.ts/known.png",
        ledgerId: "BUG-9999",
        reason: "x".repeat(90),
        pressedAccentPixels: 36,
      },
    ];
    const message = describeStaleRibbonState(
      [
        { file: "visual/__screenshots__/v.spec.ts/fresh.png", pressedAccentPixels: 36 },
        { file: "visual/__screenshots__/v.spec.ts/known.png", pressedAccentPixels: 36 },
      ],
      population,
      quarantine,
    );
    expect(message).toContain("fresh.png");
    expect(message).not.toContain("known.png");
    expect(
      staleProductStateFor("visual/__screenshots__/v.spec.ts/known.png", quarantine),
    ).toBeDefined();
    expect(
      staleProductStateFor("visual/__screenshots__/v.spec.ts/fresh.png", quarantine),
    ).toBeUndefined();
  });

  it("ignores a lit golden that is NOT declared empty-document - a populated cell may latch", () => {
    // The rule is about empty workbooks, not about latched toggles. A capture
    // taken on a cell that exists SHOULD show the effective format, and six
    // committed goldens legitimately do.
    expect(
      describeStaleRibbonState(
        [{ file: "tests/__screenshots__/t.spec.ts/populated.png", pressedAccentPixels: 546 }],
        population,
        [],
      ),
    ).toBeNull();
  });
});

describe("the pressed-accent reader", () => {
  it("counts the latched fill and ignores the neutrals the other axes live on", () => {
    const solid = (rgb: [number, number, number], n: number) => {
      const buf = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) {
        buf[i * 3] = rgb[0];
        buf[i * 3 + 1] = rgb[1];
        buf[i * 3 + 2] = rgb[2];
      }
      return { width: n, height: 1, rgb: buf };
    };
    expect(readPressedAccentFill(solid([222, 245, 237], 100))).toBe(100);
    // Within tolerance (the button's blended edge) still counts.
    expect(readPressedAccentFill(solid([221, 245, 237], 40))).toBe(40);
    // The hairline constants and white must not.
    expect(readPressedAccentFill(solid([241, 241, 241], 100))).toBe(0);
    expect(readPressedAccentFill(solid([226, 226, 226], 100))).toBe(0);
    expect(readPressedAccentFill(solid([255, 255, 255], 100))).toBe(0);
    // Nor the accent at full strength - that is an ICON, not a latched fill.
    expect(readPressedAccentFill(solid([16, 185, 129], 100))).toBe(0);
  });

  it("locates the fill with a statistic the ribbon's stray antialiasing cannot move", () => {
    // A 1280-wide row: one 30-px run of fill (the toggle box) plus scattered
    // single pixels of the same colour spread across the whole ribbon, which
    // is what the real goldens hold (measured: 29 stray px from x=39 to
    // x=985 around a 546-px box).
    const w = 1280;
    const buf = new Uint8Array(w * 3);
    const paint = (x: number) => {
      buf[x * 3] = 222;
      buf[x * 3 + 1] = 245;
      buf[x * 3 + 2] = 237;
    };
    for (let x = 445; x < 475; x++) paint(x);
    for (const x of [39, 80, 140, 300, 700, 900, 985]) paint(x);
    const g = readPressedAccentGeometry({ width: w, height: 1, rgb: buf });
    expect(g.pixels).toBe(37);
    // The MEAN of those x values is ~437 - eight pixels off, and drifting with
    // however much iconography happens to be in frame. The MEDIAN sits inside
    // the box.
    expect(g.medianX).toBeGreaterThanOrEqual(445);
    expect(g.medianX).toBeLessThan(475);
    expect(g.medianY).toBe(0);

    // Nothing matching at all abstains rather than reporting a coordinate.
    const blank = readPressedAccentGeometry({ width: 4, height: 1, rgb: new Uint8Array(12) });
    expect(blank).toEqual({ pixels: 0, medianX: null, medianY: null });
  });

  it("reads the real pair: a COVERED-toggle capture is dark, a VISIBLE one is lit", () => {
    // THIS CASE HAS BEEN RE-ANCHORED TWICE, both times because the state it
    // leaned on was a defect's face and the defect got fixed. First it read
    // the BUG-0029 file as its lit example (re-recorded 2026-08-12). Then it
    // read `core-empty-grid` as its UNLIT example — and BUG-0062 fixed the
    // ribbon to report the DOCUMENT DEFAULT style for empty cells, so an
    // empty workbook now legitimately lights ONE alignment toggle -- Bottom
    // Align since the 2026-08-15 Excel-parity change moved the document
    // default from VerticalAlign::Middle to Bottom -- and there is no "unlit
    // empty workbook" in the corpus at all any more.
    //
    // The permanent pair is geometric, not behavioural: `menu-data-open`
    // photographs the SAME empty workbook with the Data menu covering the
    // alignment cluster (the lit box is simply not in frame), while
    // `core-empty-grid` shows it plainly. Same window, same product state —
    // the gap between the two readings IS the toggle, which is exactly what
    // the reader must be able to see.
    const read = (p: string) =>
      readPressedAccentFill(decodePng(readFileSync(join(E2E_ROOT, ...p.split("/")))));
    const covered = read("visual/__screenshots__/core-visual.spec.ts/menu-data-open.png");
    const visible = read("visual/__screenshots__/core-visual.spec.ts/core-empty-grid.png");
    expect(covered).toBeLessThan(PRESSED_ACCENT_FLOOR);
    expect(visible).toBeGreaterThan(PRESSED_ACCENT_FLOOR);
    // Both are 1280x800 captures of the same window; the gap is the toggle.
    expect(visible - covered).toBeGreaterThan(400);
  });
});

