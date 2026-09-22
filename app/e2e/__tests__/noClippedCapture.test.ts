//! FILENAME: app/e2e/__tests__/noClippedCapture.test.ts
// PURPOSE: Keep the clipped capture out of the E2E tree -- by READING THE TREE,
//          not by restating a list of files that was true once.
//
// THE HAZARD. `page.screenshot({ clip })` is not a passive read. To capture a
// sub-rectangle Chromium is asked to put that rectangle on screen. On
// 2026-09-22 a control the pointer was PARKED on was measured receiving a
// `mouseleave` it never earned, carrying the CLIP'S OWN ORIGIN as its pointer
// position, with no matching `mouseenter` afterwards -- so the Charts live
// colour preview looked broken for four consecutive journey runs while the
// product painted it in ~84 ms every time. (A re-probe the same day could not
// reproduce the unearned event and found a ~130 ms timing gap between the two
// paths instead. `../viewportSample.ts` carries both accounts; the unclipped
// capture is correct under either, which is why this guard does not depend on
// which is right.)
//
// WHY A TEST AND NOT A LINT RULE. The repo's other repo-wide ban -- the dialog
// globals -- IS a lint rule (`dialogGuardConfigs` in `eslint.boundaries.js`),
// and that was the first home considered. Three things ruled it out:
//
//   1. THE ALLOWLIST HAS TO CARRY A REASON, AND THE REASON HAS TO BE ENFORCED.
//      A legitimate clipped capture exists (below), so a blanket ban is wrong.
//      ESLint expresses an exemption as a path in `ignores` -- there is no way
//      to make an exemption without a written justification FAIL. Here the
//      allowlist is data this file owns, so "an entry with no reason is itself
//      a failure" is just another assertion.
//   2. `// eslint-disable-next-line` IS A REASON-FREE BYPASS. It would put the
//      exemption at the call site, invisible to anyone auditing the ban, which
//      is precisely how nine near-copies of one helper came to exist.
//   3. EVERY BOUNDARY BLOCK IGNORES `**/*.spec.{ts,tsx}` AND `**/__tests__/**`,
//      and all nine migrated files are `.spec.ts`. The gate would have had to
//      carve an exception to a convention that holds everywhere else in it, and
//      `eslint.boundaries.js` is explicitly "architecture boundaries, single
//      source of truth" -- `app/e2e` is not in any of its `files` globs.
//
// SO IT IS A CENSUS, in the shape `document_effect.rs`'s lock census uses: parse
// the real source at test time and assert against what is actually there. A new
// clipped call site, in a NEW file nobody listed here, fails this test.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Directories with no hand-written source in them. */
const SKIP_DIRS = new Set([
  "node_modules",
  "results",
  "screenshots",
  "__snapshots__",
  ".tmp",
  "traces",
]);

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

/**
 * BOTH SPELLINGS OF THE SAME FACT, because that is the mistake this whole wave
 * was made of. `page.screenshot({ clip })` and `expect(page).toHaveScreenshot({
 * clip })` both reach `Page.captureScreenshot` with a clip; banning only the
 * first would leave the second as an unguarded way to write the same thing.
 */
const CAPTURE_METHODS = new Set(["screenshot", "toHaveScreenshot"]);

export interface ClippedCapture {
  /** Path relative to `app/e2e`, forward slashes -- the allowlist's key. */
  file: string;
  /** 1-based line of the call, for the failure message only. */
  line: number;
  /** `screenshot` or `toHaveScreenshot`. */
  api: string;
  /** Nearest enclosing named function -- a key that survives edits above it. */
  holder: string;
  /** `clip-property` (a visible `clip:`) or `opaque-options` (unprovable). */
  why: "clip-property" | "opaque-options";
}

/**
 * The nearest enclosing NAMED function, walking up the parent chain.
 *
 * The allowlist is keyed on this rather than on a line number: a line number
 * drifts on every edit above it and would turn the guard into a chore, while a
 * function name changes only when the code really moves.
 */
function holderOf(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
    if (
      (ts.isFunctionExpression(n) || ts.isArrowFunction(n)) &&
      n.parent &&
      ts.isVariableDeclaration(n.parent) &&
      ts.isIdentifier(n.parent.name)
    ) {
      return n.parent.name.text;
    }
  }
  return "<top level>";
}

/**
 * Which argument is the OPTIONS bag for this API.
 *
 * Positional, not "any argument that happens to be an object": `screenshot`
 * takes options first, `toHaveScreenshot` takes a name first and options
 * second. Getting this wrong in the permissive direction misses the hazard;
 * getting it wrong in the strict direction flags `toHaveScreenshot(name, …)`
 * where `name` is a plain string variable, and a guard that fires on correct
 * code teaches people to route around it.
 */
function optionsArgument(api: string, args: readonly ts.Expression[]): ts.Expression | undefined {
  if (api === "screenshot") return args.length > 0 ? args[0] : undefined;
  if (args.length > 1) return args[1];
  if (args.length === 1 && ts.isObjectLiteralExpression(args[0])) return args[0];
  return undefined;
}

/** Does this object literal set a `clip` property? */
function setsClip(obj: ts.ObjectLiteralExpression): boolean {
  return obj.properties.some((p) => {
    const name = p.name;
    if (!name) return false;
    if (ts.isIdentifier(name)) return name.text === "clip";
    if (ts.isStringLiteral(name)) return name.text === "clip";
    return false;
  });
}

/**
 * Every clipped capture in one source file.
 *
 * EXPORTED AND EXERCISED ON SYNTHETIC SOURCES BELOW. A scanner that silently
 * finds nothing passes a census vacuously, which is the same failure mode as a
 * sabotage that is a no-op, so the detector is tested as a function in its own
 * right and not only through the tree.
 *
 * KNOWN LIMIT, stated rather than hidden: a spread (`{ ...options }`) whose
 * source is out of sight is NOT reported. `helpers/screenshots.ts` spreads
 * narrowly-typed option bags in seven places and none of them can carry a clip,
 * so reporting spreads would mean seven exemptions for a hazard that is not
 * there -- and an allowlist padded with non-hazards is an allowlist nobody
 * reads. A whole argument that is opaque (an identifier, a call) IS reported,
 * because there the guard can prove nothing at all.
 */
export function findClippedCaptures(file: string, source: string): ClippedCapture[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const hits: ClippedCapture[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && CAPTURE_METHODS.has(callee.name.text)) {
        const api = callee.name.text;
        const opts = optionsArgument(api, node.arguments);
        if (opts) {
          let why: ClippedCapture["why"] | null = null;
          if (ts.isObjectLiteralExpression(opts)) {
            if (setsClip(opts)) why = "clip-property";
          } else {
            why = "opaque-options";
          }
          if (why) {
            hits.push({
              file,
              line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
              api,
              holder: holderOf(node),
              why,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(path.join(dir, entry.name), out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function scanTree(): { files: string[]; hits: ClippedCapture[] } {
  const files = sourceFiles(E2E_DIR);
  const hits: ClippedCapture[] = [];
  for (const abs of files) {
    const rel = path.relative(E2E_DIR, abs).split(path.sep).join("/");
    hits.push(...findClippedCaptures(rel, fs.readFileSync(abs, "utf8")));
  }
  return { files, hits };
}

// ---------------------------------------------------------------------------
// The allowlist -- every entry carries its reason, and the reason is checked
// ---------------------------------------------------------------------------

interface SanctionedClip {
  file: string;
  holder: string;
  api: string;
  /**
   * WHY THIS ONE IS NOT THE HAZARD. Not "legacy", not "TODO": what makes the
   * clip correct here, and what would have to change for it to stop being
   * correct. Enforced to be a real sentence by `MIN_REASON_CHARS` below --
   * an exemption nobody had to justify is how a ban becomes decoration.
   */
  reason: string;
}

/** Short enough to type, long enough that "ok" and "legacy" cannot pass. */
const MIN_REASON_CHARS = 120;

const SANCTIONED_CLIPS: SanctionedClip[] = [
  {
    file: "helpers/screenshots.ts",
    holder: "takeGridRegionScreenshot",
    api: "toHaveScreenshot",
    reason:
      "GOLDEN IMAGE, AND THE COMMITTED BASELINE *IS* THE CLIPPED PICTURE. This writes and compares " +
      "`grid-<name>.png` against a recorded file, so removing the clip would not change how the " +
      "capture is taken -- it would change what every baseline in the visual corpus depicts, and " +
      "every one of them would have to be re-recorded. It also parks the selection and calls " +
      "`waitForGridStable` immediately before the shutter, so no hover is live when it fires. " +
      "If this ever needs to measure a hovered control, it must move to `samplePixels` instead.",
  },
  {
    file: "helpers/screenshots.ts",
    holder: "takeRegionScreenshot",
    api: "toHaveScreenshot",
    reason:
      "GOLDEN IMAGE, same as `takeGridRegionScreenshot`: `region-<name>.png` baselines are stored " +
      "clipped, so the clip is part of the artifact rather than part of the instrument. It also " +
      "refuses a clip that is empty or outside the viewport BEFORE capturing, which is the check " +
      "an unclipped crop has to reimplement (`rectFitsInside`). Its journey callers park the " +
      "pointer at (4,4) first, so nothing is hovered when it fires.",
  },
  {
    file: "journeys/parity-21c.spec.ts",
    holder: "cellInk",
    api: "screenshot",
    reason:
      "NO HOVER EXISTS ANYWHERE NEAR IT, and the clip's own throw is load-bearing here. `cellInk` " +
      "returns a dark-pixel COUNT for one cell; the spec parks the selection via `bringIntoView` " +
      "and never issues a `mouse.move` at all. 'Clipped area is either empty or outside the " +
      "resulting image' is what taught this spec that its probe rows were below the fold, and its " +
      "own on-screen check now names the geometry before Playwright can. Migrating it would buy " +
      "nothing and would re-open a failure mode it already closed.",
  },
];

function keyOf(x: { file: string; holder: string; api: string }): string {
  return `${x.file}::${x.holder}::${x.api}`;
}

// ---------------------------------------------------------------------------

const HAZARD = [
  "A CLIPPED CAPTURE IS NOT A PASSIVE READ.",
  "",
  "`page.screenshot({ clip })` (and `toHaveScreenshot({ clip })`) asks Chromium to put that",
  "rectangle on screen. The pointer's hit-test travels with the viewport, so a control the",
  "pointer is PARKED on can receive a `mouseleave` it never earned, at the clip's own origin,",
  "with no matching `mouseenter`. That is how the Charts live colour preview was reported as a",
  "product defect for four consecutive runs while the product painted it in ~84 ms every time.",
  "",
  "USE `samplePixels` (or `samplePixelGrid` / `samplePixelGrids` / `samplePixelPatches`) FROM",
  "`app/e2e/viewportSample.ts`. They capture the WHOLE viewport and crop afterwards, in-page,",
  "against the decoded bitmap; the returned array is the same device-pixel RGBA the clipped",
  "call decoded to, so existing thresholds still mean what they meant. Compare with the shared",
  "`diffCount` from the same module.",
  "",
  "If the clip is genuinely correct here -- a golden image whose stored baseline IS the clipped",
  "picture, or a probe with no hover anywhere near it -- add it to SANCTIONED_CLIPS in",
  "`app/e2e/__tests__/noClippedCapture.test.ts` WITH A WRITTEN REASON. An entry without one",
  "fails this test too.",
].join("\n");

describe("no clipped capture in the E2E tree", () => {
  const { files, hits } = scanTree();

  // A CENSUS THAT SCANNED NOTHING PASSES. Before any absence is asserted, prove
  // the walk actually reached the tree and the files this work is about.
  it("actually read the e2e tree", () => {
    expect(files.length, "app/e2e should hold hundreds of sources").toBeGreaterThan(150);
    const rel = files.map((f) => path.relative(E2E_DIR, f).split(path.sep).join("/"));
    for (const expected of [
      "viewportSample.ts",
      "helpers/screenshots.ts",
      "journeys/chart-interaction.spec.ts",
      "journeys/census-followon.spec.ts",
      "journeys/computed-property-restore.spec.ts",
      "journeys/correctness-cluster.spec.ts",
      "journeys/insight-overlays.spec.ts",
      "journeys/insight-overlays-pivot.spec.ts",
      "journeys/remaining-correctness.spec.ts",
      "journeys/spill-delete.spec.ts",
      "journeys/structural-recalc.spec.ts",
      "tests/flagged-defects.spec.ts",
    ]) {
      expect(rel, `the scan must cover ${expected}`).toContain(expected);
    }
  });

  it("finds no clipped capture that is not sanctioned", () => {
    const sanctioned = new Set(SANCTIONED_CLIPS.map(keyOf));
    const offenders = hits.filter((h) => !sanctioned.has(keyOf(h)));
    const detail = offenders
      .map((h) => `  ${h.file}:${h.line}  ${h.api}(...)  in ${h.holder}  [${h.why}]`)
      .join("\n");
    expect(offenders.map((h) => `${h.file}:${h.line}`), `${HAZARD}\n\nFOUND:\n${detail}`).toEqual(
      [],
    );
  });

  // THE OTHER DIRECTION. An allowlist that outlives the code it exempts is a
  // standing licence for whatever lands at that name next.
  it("has no stale allowlist entry", () => {
    const live = new Set(hits.map(keyOf));
    const stale = SANCTIONED_CLIPS.filter((s) => !live.has(keyOf(s))).map(keyOf);
    expect(
      stale,
      "these SANCTIONED_CLIPS entries no longer match any clipped capture -- the code moved or " +
        "was migrated, so delete the entry rather than leaving a blanket exemption behind",
    ).toEqual([]);
  });

  it("requires a written reason on every allowlist entry", () => {
    const unjustified = SANCTIONED_CLIPS.filter(
      (s) => s.reason.trim().length < MIN_REASON_CHARS,
    ).map(keyOf);
    expect(
      unjustified,
      `every exemption must say WHY the clip is correct there, in at least ${MIN_REASON_CHARS} ` +
        "characters. An exemption nobody had to justify is how a ban becomes decoration.",
    ).toEqual([]);
  });

  it("names the sanctioned replacement in the failure message", () => {
    // The person who trips this guard will not know the history. The message
    // has to carry the hazard AND the way out, or it is just an obstacle.
    expect(HAZARD).toContain("samplePixels");
    expect(HAZARD).toContain("app/e2e/viewportSample.ts");
    expect(HAZARD).toContain("mouseleave");
    expect(HAZARD).toContain("SANCTIONED_CLIPS");
  });

  // -------------------------------------------------------------------------
  // The guard on the guard: the detector, on sources this file controls
  // -------------------------------------------------------------------------

  describe("the detector itself", () => {
    it("catches the plain `page.screenshot({ clip })`", () => {
      const hit = findClippedCaptures(
        "x.spec.ts",
        `async function probe(page: Page) {\n` +
          `  return page.screenshot({ clip: { x: 1, y: 2, width: 3, height: 4 } });\n` +
          `}\n`,
      );
      expect(hit).toHaveLength(1);
      expect(hit[0]).toMatchObject({ line: 2, api: "screenshot", holder: "probe", why: "clip-property" });
    });

    // THE RECEIVER IS NOT THE POINT. Journeys call the page `appPage`, and a
    // check anchored on the literal text `page.screenshot` would miss every
    // one of them -- which is how a ban comes to cover one spelling of two.
    it("does not care what the page variable is called", () => {
      expect(
        findClippedCaptures(
          "x.spec.ts",
          `const f = async () => appPage.screenshot({ clip: box });\n`,
        ),
      ).toHaveLength(1);
      expect(
        findClippedCaptures("x.spec.ts", `await ctx.pages()[0].screenshot({ clip: box });\n`),
      ).toHaveLength(1);
    });

    it("catches the clip hidden behind a shorthand property", () => {
      const hit = findClippedCaptures(
        "x.spec.ts",
        `async function probe(page: Page, clip: Clip) { return page.screenshot({ clip }); }\n`,
      );
      expect(hit).toHaveLength(1);
      expect(hit[0].why).toBe("clip-property");
    });

    it("catches the comparator spelling too", () => {
      const hit = findClippedCaptures(
        "x.spec.ts",
        `async function probe(page: Page) {\n` +
          `  await expect(page).toHaveScreenshot("a.png", { threshold: 0.02, clip: box });\n` +
          `}\n`,
      );
      expect(hit).toHaveLength(1);
      expect(hit[0].api).toBe("toHaveScreenshot");
    });

    it("reports an options bag it cannot see into", () => {
      const hit = findClippedCaptures("x.spec.ts", `await page.screenshot(options);\n`);
      expect(hit).toHaveLength(1);
      expect(hit[0].why).toBe("opaque-options");
    });

    // The negatives matter as much: a detector that flags everything gets
    // disabled, and then it guards nothing.
    it("passes the sanctioned unclipped shapes", () => {
      const clean = [
        `await page.screenshot();`,
        `await page.screenshot({ animations: "disabled" });`,
        `await page.screenshot({ path: "out.png", fullPage: false });`,
        `await expect(page).toHaveScreenshot(\`grid-\${name}.png\`, { ...DEFAULTS, ...compare });`,
        `await expect(page).toHaveScreenshot(name, { threshold: 0.02 });`,
        `const clip = { x: 1, y: 2, width: 3, height: 4 };`,
        `return samplePixels(page, clip);`,
      ];
      for (const line of clean) {
        expect(findClippedCaptures("x.spec.ts", `${line}\n`), line).toEqual([]);
      }
    });

    it("keys a finding by its enclosing function, not by a line number", () => {
      const body = `async function cellInk(page: Page) { return page.screenshot({ clip: r }); }\n`;
      const shifted = `// a comment added above\n// and another\n${body}`;
      const a = findClippedCaptures("p.spec.ts", body);
      const b = findClippedCaptures("p.spec.ts", shifted);
      expect(a[0].holder).toBe("cellInk");
      expect(b[0].holder).toBe("cellInk");
      expect(keyOf(a[0])).toBe(keyOf(b[0]));
      expect(b[0].line).toBe(a[0].line + 2);
    });
  });

  // -------------------------------------------------------------------------
  // The one decode, and the nine copies that are gone
  // -------------------------------------------------------------------------

  // `diffCount` existed TEN times over -- nine journey specs and
  // `chart-interaction` -- at the same threshold, with the refusal spelled four
  // different ways. Copies do not announce themselves when they drift, so the
  // count is asserted rather than remembered.
  it("keeps exactly one definition of diffCount under e2e/", () => {
    const owners: string[] = [];
    for (const abs of files) {
      const source = fs.readFileSync(abs, "utf8");
      if (/^\s*(export\s+)?(async\s+)?function\s+diffCount\s*\(/m.test(source)) {
        owners.push(path.relative(E2E_DIR, abs).split(path.sep).join("/"));
      }
    }
    expect(
      owners,
      "diffCount belongs to `e2e/viewportSample.ts` alone. A private copy is a second source of " +
        "truth for a threshold every journey's numbers are tuned to; import the shared one.",
    ).toEqual(["viewportSample.ts"]);
  });
});
