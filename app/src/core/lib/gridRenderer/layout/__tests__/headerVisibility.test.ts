//! FILENAME: app/src/core/lib/gridRenderer/layout/__tests__/headerVisibility.test.ts
// PURPOSE: The header-gutter rule, and the MEASUREMENT that settles why a
//          floating control could not be clicked on a headings-off canvas.
// CONTEXT: `View > Headings` off makes the renderer paint both gutters at zero.
//          The rule used to be a private local inside `renderGrid`; it is a
//          module now because the E2E geometry helper has to apply the SAME rule
//          and a second spelling is how the two drift apart.
//
//          THE OPEN QUESTION THESE TESTS ANSWER
//          ------------------------------------
//          `docs/design/open-decisions-2026-08.md` Sec 1a recorded: "On that
//          headings-off canvas, a floating control could not be selected by
//          clicking it -- not at its painted position and not at the
//          config-offset position either. Measured, not characterised." The
//          tests below re-measure it deterministically with the shipped
//          hit-testers and the shipped numbers, and separate the two candidate
//          explanations: a shared geometry offset, or a hit-tester that is
//          independently wrong.
//
//          Several assertions below pin behaviour that is WRONG on purpose. They
//          are labelled DEFECT and they exist so the fix has a test to flip.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveHeaderSizes,
  effectiveGridConfig,
  rowHeaderGutter,
  colHeaderGutter,
  FALLBACK_ROW_HEADER_WIDTH,
  FALLBACK_COL_HEADER_HEIGHT,
} from "../headerVisibility";
import { findFloatingRegionAt } from "../../../../hooks/useMouseSelection/layout/overlayMoveHandlers";
import { setGridRegions, type GridRegion } from "../../../../../api/gridOverlays";
import { DEFAULT_GRID_CONFIG } from "../../../../types";
import type { GridConfig, Viewport } from "../../../../types";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(resolve(HERE, relative), "utf8");

/** The launch geometry: a 22px row gutter and a 20px column band. */
const CONFIG: GridConfig = { ...DEFAULT_GRID_CONFIG };
const VIEWPORT = { scrollX: 0, scrollY: 0 } as Viewport;

// ===========================================================================
// The rule
// ===========================================================================

describe("resolveHeaderSizes -- the rule itself", () => {
  it("collapses BOTH gutters to zero when the headings are hidden", () => {
    expect(resolveHeaderSizes(CONFIG, false)).toEqual({
      rowHeaderWidth: 0,
      colHeaderHeight: 0,
    });
  });

  it("keeps the configured sizes when the headings are shown", () => {
    expect(resolveHeaderSizes(CONFIG, true)).toEqual({
      rowHeaderWidth: CONFIG.rowHeaderWidth,
      colHeaderHeight: CONFIG.colHeaderHeight,
    });
  });

  it("treats an ABSENT flag as shown, so a caller that does not track it is unharmed", () => {
    expect(resolveHeaderSizes(CONFIG, undefined)).toEqual(resolveHeaderSizes(CONFIG, true));
  });

  it("defaults only a MISSING gutter, never a zero one", () => {
    // 0 is a legal gutter width now (it is what "headings off" means), so it
    // survives the read in both directions. Only an absent field is filled in.
    const zero = { rowHeaderWidth: 0, colHeaderHeight: 0 };
    expect(resolveHeaderSizes(zero, true)).toEqual(zero);
    expect(resolveHeaderSizes(zero, false)).toEqual(zero);

    expect(resolveHeaderSizes({}, true)).toEqual({
      rowHeaderWidth: FALLBACK_ROW_HEADER_WIDTH,
      colHeaderHeight: FALLBACK_COL_HEADER_HEIGHT,
    });
  });

  it("the fallbacks ARE the configured defaults, not a second copy of them", () => {
    // This is the assertion that would have caught the drift: the fallbacks
    // said 50/24 for as long as the product said 22/20.
    expect(FALLBACK_ROW_HEADER_WIDTH).toBe(DEFAULT_GRID_CONFIG.rowHeaderWidth);
    expect(FALLBACK_COL_HEADER_HEIGHT).toBe(DEFAULT_GRID_CONFIG.colHeaderHeight);
  });

  it("effectiveGridConfig returns the SAME object when nothing changes", () => {
    // A React memo keyed on the config must not invalidate every render.
    expect(effectiveGridConfig(CONFIG, true)).toBe(CONFIG);
    expect(effectiveGridConfig(CONFIG, undefined)).toBe(CONFIG);
    const collapsed = effectiveGridConfig(CONFIG, false);
    expect(collapsed).not.toBe(CONFIG);
    expect(effectiveGridConfig(collapsed, false)).toBe(collapsed);
  });

  it("touches ONLY the two gutter fields", () => {
    const collapsed = effectiveGridConfig(CONFIG, false);
    for (const key of Object.keys(CONFIG) as Array<keyof GridConfig>) {
      if (key === "rowHeaderWidth" || key === "colHeaderHeight") continue;
      expect(collapsed[key], `effectiveGridConfig changed ${String(key)}`).toEqual(CONFIG[key]);
    }
  });
});

// ===========================================================================
// THE MEASUREMENT: clicking a floating control on a headings-off canvas
// ===========================================================================
//
// The numbers are the shipped ones, not invented:
//   * the control is a real Insert > Controls > Button, whose box is
//     max(cellWidth, 80) x max(cellHeight, 28) = 80 x 28 (Controls/index.ts);
//   * the click is the one `app/e2e/journeys/shapes-hometab.spec.ts` performs to
//     select it -- the control's painted top-left plus (30, 10);
//   * `region.floating.{x,y}` is CONTENT-relative (it carries no gutter), so the
//     PAINTED top-left is `resolveHeaderSizes(...) + floating.{x,y}`, which is
//     the region's own coordinates once the headings are hidden.

describe("floating-control hit-testing on a headings-off canvas", () => {
  const ANCHOR = { x: 300, y: 200 };
  const BUTTON = { width: 80, height: 28 };
  const REGION: GridRegion = {
    id: "control-0-9-4",
    type: "floating-control",
    floating: { ...ANCHOR, ...BUTTON },
    data: { controlType: "button" },
  } as GridRegion;

  /** The click the spec performs, relative to the control's PAINTED top-left. */
  const CLICK_OFFSET = { x: 30, y: 10 };

  /** Where the control is actually PAINTED, for a given headings state. */
  const paintedTopLeft = (displayHeadings: boolean) => {
    const h = resolveHeaderSizes(CONFIG, displayHeadings);
    return { x: h.rowHeaderWidth + ANCHOR.x, y: h.colHeaderHeight + ANCHOR.y };
  };

  beforeEach(() => setGridRegions([REGION]));
  afterEach(() => setGridRegions([]));

  it("WAS THE DEFECT: handed the RAW config, the painted position selects nothing", () => {
    // Retained as the statement of the bug. `CONFIG` here is the stored config,
    // which is what the interaction layer used to receive; the block below
    // shows the same call succeeding once the header rule is applied first.
    const painted = paintedTopLeft(false);
    const hit = findFloatingRegionAt(
      painted.x + CLICK_OFFSET.x,
      painted.y + CLICK_OFFSET.y,
      CONFIG,
      VIEWPORT,
    );
    expect(hit, "the control the user can see is not where the click lands").toBeNull();
  });

  it("FIXED: handed the EFFECTIVE config, the painted position selects the control", () => {
    // This is the closure. Spreadsheet.tsx now applies `effectiveGridConfig`
    // once and hands the result to every consumer, so the config the
    // hit-tester sees is the one the painter drew with.
    const effective = effectiveGridConfig(CONFIG, false);
    const painted = paintedTopLeft(false);
    const hit = findFloatingRegionAt(
      painted.x + CLICK_OFFSET.x,
      painted.y + CLICK_OFFSET.y,
      effective,
      VIEWPORT,
    );
    expect(hit?.id).toBe(REGION.id);
  });

  it("FIXED: the CORNER of the control is clickable too, not just its middle", () => {
    // The reason the bug read as capricious: the painted and hit rectangles
    // overlapped through the middle, so a centre click worked and a corner
    // click did not. One pixel inside the top-left corner is the strict test.
    const effective = effectiveGridConfig(CONFIG, false);
    const painted = paintedTopLeft(false);
    expect(findFloatingRegionAt(painted.x + 1, painted.y + 1, effective, VIEWPORT)?.id).toBe(
      REGION.id,
    );
  });

  it("FIXED: painted origin and hit origin are the SAME point on both axes", () => {
    const effective = effectiveGridConfig(CONFIG, false);
    const firstHitX = (probeY: number): number => {
      for (let x = 0; x < 1000; x++) {
        if (findFloatingRegionAt(x, probeY, effective, VIEWPORT)) return x;
      }
      return -1;
    };
    const firstHitY = (probeX: number): number => {
      for (let y = 0; y < 1000; y++) {
        if (findFloatingRegionAt(probeX, y, effective, VIEWPORT)) return y;
      }
      return -1;
    };
    const painted = paintedTopLeft(false);
    // Was rowHeaderWidth (22) / colHeaderHeight (20); now zero on both axes.
    expect(firstHitX(painted.y + 5) - painted.x).toBe(0);
    expect(firstHitY(painted.x + 5) - painted.y).toBe(0);
  });

  it("and the miss is ARITHMETIC: the click is 10px above a hit rect pushed down 20px", () => {
    // `getFloatingCanvasBounds` adds `config.colHeaderHeight` (20) while the
    // painter added `resolveHeaderSizes(...).colHeaderHeight` (0). A click 10px
    // below the PAINTED top edge is therefore 10px ABOVE the hit rect.
    expect(CLICK_OFFSET.y).toBeLessThan(CONFIG.colHeaderHeight);
    // In x it is inside, because the click offset (30) exceeds the row gutter
    // (22) -- which is why the failure looked mysterious rather than uniform.
    expect(CLICK_OFFSET.x).toBeGreaterThan(CONFIG.rowHeaderWidth);
  });

  it("THE DIAGNOSIS: the hit-tester itself is not wrong", () => {
    // Same (unchanged) config, same region registry, same function -- but click
    // at the position that config DESCRIBES, i.e. the painted point plus the
    // gutters the config wrongly believes are drawn. The control is found.
    //
    // So `findFloatingRegionAt` / `getFloatingCanvasBounds` / the region
    // registry are all correct. The ONLY defect is that the painter and the
    // hit-tester disagree about the ORIGIN when the headings are hidden. It is
    // purely the geometry offset; nothing about control hit-testing is
    // independently broken.
    const painted = paintedTopLeft(false);
    const hit = findFloatingRegionAt(
      CONFIG.rowHeaderWidth + painted.x + CLICK_OFFSET.x,
      CONFIG.colHeaderHeight + painted.y + CLICK_OFFSET.y,
      CONFIG,
      VIEWPORT,
    );
    expect(hit?.id).toBe(REGION.id);
  });

  it("the two rectangles differ by EXACTLY the header sizes, on both axes", () => {
    const firstHitX = (probeY: number): number => {
      for (let x = 0; x < 1000; x++) {
        if (findFloatingRegionAt(x, probeY, CONFIG, VIEWPORT)) return x;
      }
      return -1;
    };
    const firstHitY = (probeX: number): number => {
      for (let y = 0; y < 1000; y++) {
        if (findFloatingRegionAt(probeX, y, CONFIG, VIEWPORT)) return y;
      }
      return -1;
    };
    const insideY = CONFIG.colHeaderHeight + ANCHOR.y + 5;
    const insideX = CONFIG.rowHeaderWidth + ANCHOR.x + 5;

    // The hit rect starts at config-gutter + anchor; the PAINTED rect starts at
    // resolveHeaderSizes-gutter + anchor. The difference is the whole story.
    expect(firstHitX(insideY) - paintedTopLeft(false).x).toBe(CONFIG.rowHeaderWidth);
    expect(firstHitY(insideX) - paintedTopLeft(false).y).toBe(CONFIG.colHeaderHeight);
  });

  it("AND IT FALLS OUT OF THE HEADINGS FIX: with the headings SHOWN the click lands", () => {
    // This is the verification the diagnosis is worth: restore the flag the
    // renderer follows and the very same click -- painted position, same offset,
    // same unchanged hit-tester -- selects the control. Nothing else had to
    // change, which is what "purely the geometry offset" means.
    const painted = paintedTopLeft(true);
    expect(painted).toEqual({
      x: CONFIG.rowHeaderWidth + ANCHOR.x,
      y: CONFIG.colHeaderHeight + ANCHOR.y,
    });
    const hit = findFloatingRegionAt(
      painted.x + CLICK_OFFSET.x,
      painted.y + CLICK_OFFSET.y,
      CONFIG,
      VIEWPORT,
    );
    expect(hit?.id).toBe(REGION.id);
  });
});

// ===========================================================================
// 0 IS A LEGAL GUTTER WIDTH (was the blocker; closed 2026-08-08)
// ===========================================================================

describe("0 is a legal gutter width", () => {
  it("a collapsed gutter survives the read instead of becoming a bigger one", () => {
    // The blocker was `config.rowHeaderWidth || 50` in 90 places: `||` cannot
    // tell a legitimate 0 from a missing value, so hiding the headings produced
    // a 50px offset -- larger than the 22/20 it was meant to remove.
    const collapsed = effectiveGridConfig(CONFIG, false);
    expect(collapsed.rowHeaderWidth).toBe(0);
    expect(rowHeaderGutter(collapsed)).toBe(0);
    expect(colHeaderGutter(collapsed)).toBe(0);
  });

  it("still fills in a gutter that is genuinely absent", () => {
    expect(rowHeaderGutter({})).toBe(FALLBACK_ROW_HEADER_WIDTH);
    expect(colHeaderGutter({})).toBe(FALLBACK_COL_HEADER_HEIGHT);
  });

  it("the `|| <literal>` idiom is GONE from Core and the extensions", () => {
    // Read from source, because one straggler resurrects the offset for the
    // whole canvas -- the halves only agree if every reader agrees.
    const files = [
      "../../interaction/hitTesting.ts",
      "../../rendering/selection.ts",
      "../../rendering/headers.ts",
      "../../rendering/grid.ts",
      "../../rendering/cells.ts",
      "../../rendering/spillBorder.ts",
      "../../rendering/references.ts",
      "../viewport.ts",
      "../dimensions.ts",
      "../../core.ts",
      "../../../../components/Spreadsheet/Spreadsheet.tsx",
      "../../../../components/InlineEditor/InlineEditor.tsx",
      "../../../../hooks/useMouseSelection/useMouseSelection.ts",
      "../../../../hooks/useMouseSelection/utils/fillHandleUtils.ts",
      "../../../../hooks/useMouseSelection/selection/headerSelectionHandlers.ts",
      "../../../../hooks/useMouseSelection/layout/overlayResizeHandlers.ts",
      "../../../../../../extensions/Print/lib/pageBreakOverlay.ts",
    ];
    for (const f of files) {
      // Line comments are stripped first: several of these files DESCRIBE the
      // old idiom in prose, and a test that cannot tell code from commentary
      // would fail on its own explanation.
      const code = read(f)
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      const occurrences = code.match(/(rowHeaderWidth|colHeaderHeight)\s*\|\|\s*\d+/g) ?? [];
      expect(occurrences, `${f} still recovers a gutter with ||`).toEqual([]);
    }
  });

  it("no second gutter literal is written down anywhere in the renderer", () => {
    // The fallbacks said 50/24 while the product said 22/20 -- the same shape
    // as the 64.29 column-width drift. They are derived now; this asserts that
    // the stale pair has not crept back into the module that owns the rule.
    const rule = read("../headerVisibility.ts");
    const body = rule.slice(rule.indexOf("import "));
    expect(body).not.toMatch(/=\s*50\s*;/);
    expect(body).not.toMatch(/=\s*24\s*;/);
  });
});

// ===========================================================================
// ONE RULE, TWO CALLERS -- read from source, because a second spelling is
// exactly how this class of defect comes back.
// ===========================================================================

describe("the rule has one home", () => {
  it("renderGrid applies it instead of substituting the gutters itself", () => {
    const core = read("../../core.ts");
    expect(core).toContain("resolveHeaderSizes(config, displayHeadings)");
    expect(core).toContain("effectiveGridConfig(config, displayHeadings)");
    // The old private substitution, in either spelling.
    expect(core).not.toMatch(
      /\{\s*\.\.\.config,\s*rowHeaderWidth:\s*0,\s*colHeaderHeight:\s*0\s*\}/,
    );
  });

  it("the E2E geometry helper IMPORTS the rule rather than re-spelling it", () => {
    const helper = read("../../../../../../e2e/helpers/grid.ts");
    expect(helper).toContain("resolveHeaderSizes");
    expect(helper).toContain("gridRenderer/layout/headerVisibility.ts");
    // It must publish the PAINTED sizes, not the config's.
    expect(helper).toContain("rowHeaderWidth: headers.rowHeaderWidth");
    expect(helper).toContain("colHeaderHeight: headers.colHeaderHeight");
    expect(helper).not.toContain("rowHeaderWidth: cfg.rowHeaderWidth");
  });

  it("and the spec that hand-rolled the rule no longer does", () => {
    const spec = read("../../../../../../e2e/journeys/shapes-hometab.spec.ts");
    expect(spec).not.toContain("headingsShown ? geo.rowHeaderWidth : 0");
  });
});

// ===========================================================================
// ONE APPLICATION OF THE RULE, AND ONE DELIBERATE EXCEPTION
// ===========================================================================
//
// Read from source for the same reason the block below does it: the value of
// this fix is that there is exactly ONE place the rule is applied, and a second
// application (or a missed one) is invisible to a behavioural test that only
// ever exercises the function directly.

describe("Spreadsheet applies the header rule once, on the way to its consumers", () => {
  const SPREADSHEET = "../../../../components/Spreadsheet/Spreadsheet.tsx";

  it("derives the shared config through effectiveGridConfig", () => {
    const src = read(SPREADSHEET);
    expect(src).toMatch(/const config = useMemo\(\s*\(\) => effectiveGridConfig\(rawConfig, displayHeadings\)/);
  });

  it("keeps the stored config for the auto-widen effect, which would not settle otherwise", () => {
    // The one caller that must NOT see the collapsed value: it compares its
    // computed width against the stored one and dispatches on a difference, so
    // reading 0 with the headings hidden would dispatch on every render forever.
    const src = read(SPREADSHEET);
    expect(src).toMatch(/if \(desired !== rawConfig\.rowHeaderWidth\)/);
    expect(src).toMatch(/dispatch\(updateConfig\(\{ rowHeaderWidth: desired \}\)\)/);
  });

  it("does not leave a second `config` destructured straight out of state", () => {
    const src = read(SPREADSHEET);
    // `config: rawConfig` is the only way the stored config is taken out.
    expect(src).toMatch(/config: rawConfig,/);
    expect(src).not.toMatch(/^\s{4}config,\s*$/m);
  });
});
