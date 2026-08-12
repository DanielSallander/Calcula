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
  type GoldenReading,
  type MisRecordedCorpus,
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
  const noChrome = { srgbPixels: 0, displayPixels: 0, profileVerdict: "no-chrome" as const };
  const clean: GoldenReading[] = [
    { file: "tests/__screenshots__/a.spec.ts/one.png", dpr1Pixels: 0, dpr2Pixels: 39000, verdict: "dpr2", devicePixelRatio: 2, ...noChrome },
    { file: "tests/__screenshots__/a.spec.ts/two.png", dpr1Pixels: 0, dpr2Pixels: 38000, verdict: "dpr2", devicePixelRatio: 2, ...noChrome },
  ];

  it("says nothing when the whole corpus is on one path", () => {
    expect(describeCorpusSplit(clean, 2, [])).toBeNull();
  });

  it("names the stray FILE, both hairline constants, and the re-record trap", () => {
    const strayed: GoldenReading[] = [
      ...clean,
      { file: "tests/__screenshots__/a.spec.ts/three.png", dpr1Pixels: 39961, dpr2Pixels: 0, verdict: "dpr1", devicePixelRatio: 1, ...noChrome },
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
      { file: "visual/__screenshots__/v.spec.ts/known.png", dpr1Pixels: 39961, dpr2Pixels: 0, verdict: "dpr1", devicePixelRatio: 1, ...noChrome },
      { file: "visual/__screenshots__/v.spec.ts/fresh.png", dpr1Pixels: 39961, dpr2Pixels: 0, verdict: "dpr1", devicePixelRatio: 1, ...noChrome },
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
  const base = { dpr1Pixels: 0, dpr2Pixels: 39000, verdict: "dpr2" as const, devicePixelRatio: 2 };
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
    // And the file it is measured against really does hold the dpr-2 hairline,
    // in the quantity the mechanism predicts.
    expect(readHairline(img).dpr2Pixels).toBeGreaterThan(30_000);
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
