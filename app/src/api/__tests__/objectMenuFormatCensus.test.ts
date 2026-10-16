//! FILENAME: app/src/api/__tests__/objectMenuFormatCensus.test.ts
// PURPOSE: The census that keeps "Format..." -- the door to the ONE object
//          pane (@api/objectPane, WP-C D-PANE) -- in EVERY floating object's
//          right-click menu. The pane opens by itself only on a canvas press;
//          on a worksheet (and for a run-mode control, which never opens it on
//          press) the menu row and Ctrl+1 are the only ways in, so a family
//          whose menu lacks the row has a pane nobody can reach with a mouse.
// CONTEXT: The sibling of objectMenuSizePositionCensus.test.ts, with the same
//          FAMILY_MENUS list: the families are found by what they PUBLISH (a
//          `floating: {` box), so a new floating family fails here until it is
//          mapped to its menu module and that module asks @api/objectPane for
//          the row. Reads the source as TEXT (comments stripped), so this file
//          imports no extension (@api seams point one way). The rows'
//          BEHAVIOUR (label, disabled reason, the tab the click opens) is
//          pinned in app/src/api/__tests__/objectPane.test.ts and next to each
//          family's menu (frContextMenu.test.ts, pivotVisualContextMenu.test.ts,
//          the chart / slicer / timeline / control provider tests).

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

/** Whether a (comment-stripped) menu module asks the seam for the row. */
function asksObjectPaneForTheRow(code: string): boolean {
  return /from\s+["']@api\/objectPane["']/.test(code) && /\bobjectPaneMenuEntry\(/.test(code);
}

describe('"Format..." (the object pane) is in every floating object\'s right-click menu', () => {
  it("the families are found by what they publish: exactly these stores publish a `floating` box", () => {
    expect(FILES.length, "the walk found no sources -- wrong root?").toBeGreaterThan(500);
    const publishing = [...CODE.entries()].filter(([, code]) => /\bfloating:\s*\{/.test(code)).map(([f]) => f).sort();
    // A NEW floating family fails here until it is added to FAMILY_MENUS -- and
    // so to the check below: give its menu the row on purpose.
    expect(publishing).toEqual(FAMILY_MENUS.map((f) => f.store).sort());
  });

  for (const fam of FAMILY_MENUS) {
    it(`${fam.menu} asks @api/objectPane for the row`, () => {
      const code = CODE.get(fam.menu);
      expect(code, `${fam.menu} is gone`).toBeDefined();
      expect(asksObjectPaneForTheRow(code!), `${fam.menu} has no objectPaneMenuEntry( row`).toBe(true);
    });
  }

  it("nobody spells the label by hand: the row's text comes from the seam", () => {
    const offenders = [...CODE.entries()]
      .filter(([f]) => f !== "src/api/objectPane.ts")
      .filter(([, code]) => code.includes('"Format..."'))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it("teeth: a menu that names the call only in a comment, or imports without calling, is not counted", () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(asksObjectPaneForTheRow(strip('import { objectPaneMenuEntry } from "@api/objectPane";\n// objectPaneMenuEntry(region)\n'))).toBe(false);
    expect(asksObjectPaneForTheRow(strip('/* objectPaneMenuEntry(region) */\nconst x = 1;\n'))).toBe(false);
    expect(asksObjectPaneForTheRow(strip('import { objectPaneMenuEntry } from "@api/objectPane";\nconst f = objectPaneMenuEntry(region);\n'))).toBe(true);
  });
});
