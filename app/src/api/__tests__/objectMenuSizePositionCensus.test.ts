//! FILENAME: app/src/api/__tests__/objectMenuSizePositionCensus.test.ts
// PURPOSE: The census that keeps "Size and Position..." in EVERY floating
//          object's right-click menu (BUG-0258 design phase 5b: "the same
//          command is in every object's right-click menu"). WCAG 2.2 SC 2.5.7's
//          no-drag route is only a route if every object has it, and a family
//          added later would otherwise ship without one.
// CONTEXT: The families are found the way overlayZoneCensus.test.ts finds them:
//          by what they PUBLISH (a `floating: {` box) -- so a new floating
//          family fails here until it is mapped to its menu module and that
//          module asks @api/objectPosition for the row. Reads the source as
//          TEXT (comments stripped), so this file imports no extension (@api
//          seams point one way). The rows' BEHAVIOUR -- the label, the click,
//          the opener receiving the right region -- is pinned per family next
//          to its menu: Slicer slicerMenuSizePosition.test.ts, TimelineSlicer
//          timelineMenuSizePosition.test.ts, FloatingRange frContextMenu.test.ts,
//          Controls controlMenuSizePosition.test.ts, Charts
//          chartMenuSizePosition.test.tsx, Pivot pivotVisualContextMenu.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const APP = resolve(__dirname, "../../..");
const ROOTS = ["src", "extensions"].map((d) => join(APP, d));

function isTestPath(p: string): boolean {
  return p.split(sep).includes("__tests__") || /\.(test|spec)\.tsx?$/.test(p) || p.split(sep).includes("node_modules");
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (name === "node_modules") continue;
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts") && !isTestPath(full)) out.push(full);
    }
  };
  ROOTS.forEach(walk);
  return out;
}

const rel = (p: string) => relative(APP, p).split(sep).join("/");
const FILES = sourceFiles();
/** Comments stripped (block, then line): a comment that NAMES the call is not the call. */
const CODE = new Map(
  FILES.map((f) => [
    rel(f),
    readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, ""),
  ]),
);

/** Each floating family: the store that publishes its region, and the module that builds its right-click menu. */
const FAMILY_MENUS = [
  { store: "extensions/Charts/lib/chartStore.ts", menu: "extensions/Charts/components/ChartContextMenu.tsx" },
  { store: "extensions/Slicer/lib/slicerStore.ts", menu: "extensions/Slicer/handlers/slicerContextMenu.ts" },
  {
    store: "extensions/TimelineSlicer/lib/timelineSlicerStore.ts",
    menu: "extensions/TimelineSlicer/handlers/timelineSlicerContextMenu.ts",
  },
  { store: "extensions/FloatingRange/lib/floatingRangeStore.ts", menu: "extensions/FloatingRange/lib/frContextMenu.ts" },
  { store: "extensions/Controls/lib/floatingStore.ts", menu: "extensions/Controls/lib/controlContextMenu.ts" },
  { store: "extensions/Pivot/lib/pivotVisualRegions.ts", menu: "extensions/Pivot/lib/pivotVisualContextMenu.ts" },
];

describe("Size and Position... is in every floating object's right-click menu", () => {
  it("the families are found by what they publish: exactly these stores publish a `floating` box", () => {
    expect(FILES.length, "the walk found no sources -- wrong root?").toBeGreaterThan(500);
    const publishing = [...CODE.entries()].filter(([, code]) => /\bfloating:\s*\{/.test(code)).map(([f]) => f).sort();
    // A NEW floating family fails here until it is added to FAMILY_MENUS -- and
    // so to the check below: give its menu the row on purpose.
    expect(publishing).toEqual(FAMILY_MENUS.map((f) => f.store).sort());
  });

  for (const fam of FAMILY_MENUS) {
    it(`${fam.menu} asks @api/objectPosition for the row`, () => {
      const code = CODE.get(fam.menu);
      expect(code, `${fam.menu} is gone`).toBeDefined();
      expect(code!).toMatch(/from\s+["']@api\/objectPosition["']/);
      expect(code!).toMatch(/\bsizeAndPositionMenuEntry\(/);
    });
  }

  it("nobody spells the label by hand: the row's text comes from the seam", () => {
    const offenders = [...CODE.entries()]
      .filter(([f]) => f !== "src/api/objectPosition.ts")
      .filter(([, code]) => code.includes('"Size and Position..."'))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });
});
