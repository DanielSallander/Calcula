//! FILENAME: app/src/api/__tests__/gridCanvasCursorCensus.test.ts
// PURPOSE: The census that keeps a SECOND POINTER WRITER off the grid (BUG-0258:
//          "press, pointer and modifiers from one answer"). Core shows the
//          pointer on the grid container from the zone answer of the object
//          under it (`zoneAt` -> @api/gridOverlays resolveFloatingZone), and
//          for cells from `getCellCursor` / `registerCellCursorInterceptor`.
//          An extension that writes `canvas.style.cursor` puts an INLINE
//          cursor on the <canvas> CHILD, which beats the container's: the
//          Charts mousemove did that over any chart's bars, points, slices,
//          axes and buttons, so a brushable plot showed a hand instead of its
//          crosshair, a movable chart's bars a hand instead of 'move' and a
//          locked chart's a hand instead of 'default' -- while the docs said
//          "there is no second answer".
//
//          Pinned, reading the source as TEXT (comments stripped):
//            1. every non-test file under app/extensions that assigns a
//               `.style.cursor` is in the list below, with the reason it may;
//               a new writer fails here and must route its pointer through the
//               zone answer or a cell cursor seam instead (or be added with a
//               reason a reviewer can check);
//            2. Charts/index.ts writes no cursor at all (its clickable chrome
//               is said in lib/chartZoneAt.ts);
//            3. the two CELL writers (checkbox cells, run-mode button cells)
//               ask `topFloatingRegionAtClient` before they write, so a
//               floating object lying on such a cell keeps its own pointer.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const APP = resolve(__dirname, "../../..");
const EXT = join(APP, "extensions");

function isTestPath(p: string): boolean {
  return p.split(sep).includes("__tests__") || /\.(test|spec)\.tsx?$/.test(p);
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules") continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts") && !isTestPath(full)) out.push(full);
    }
  };
  walk(EXT);
  return out;
}

const rel = (p: string) => relative(APP, p).split(sep).join("/");

/** Line and block comments stripped: a comment that QUOTES a write is not one. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** An ASSIGNMENT to some element's inline cursor (not a read, not a compare). */
const CURSOR_WRITE = /\.style\.cursor\s*=(?!=)/;

/**
 * The files allowed to write an inline cursor, and why. The grid canvas is
 * written only by the two cell writers, each behind the floating-object gate.
 */
const ALLOWED: Record<string, string> = {
  "extensions/Charts/components/ChartSpecEditorApp.tsx":
    "document.body, only while the spec editor's own splitter is dragged (its own window)",
  "extensions/Charts/components/tabs/SpecTab.tsx":
    "document.body, only while the spec tab's splitter is dragged",
  "extensions/Checkbox/index.ts":
    "the grid canvas over a checkbox CELL -- gated: never where a floating object lies (census 3)",
  "extensions/Controls/index.ts":
    "the grid canvas over a run-mode button CELL -- gated: never where a floating object lies (census 3)",
  "extensions/Controls/Shape/shapeHitRegions.ts":
    "a script shape's own DOM shim element (its declared hit region), not the grid canvas",
  "extensions/Pivot/components/PivotGrid/usePivotGridInteraction.ts":
    "the pivot editor's own grid element, not the sheet's canvas",
  "extensions/Print/lib/pageBreakOverlay.ts":
    "the grid canvas while a manual PAGE BREAK line is hovered or dragged in page-break preview (a mode of its own)",
};

const FILES = sourceFiles();
const WRITERS = FILES.filter((f) => CURSOR_WRITE.test(code(readFileSync(f, "utf8")))).map(rel).sort();

/** The brace-matched body of `function name(` in `src`, or "". */
function functionBody(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) return "";
  const open = src.indexOf("{", src.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return src.slice(at);
}

describe("no second pointer writer on the grid", () => {
  it("the walk is not vacuous: it sees the extensions and finds the known writers", () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(WRITERS).toContain("extensions/Checkbox/index.ts");
    expect(WRITERS).toContain("extensions/Print/lib/pageBreakOverlay.ts");
  });

  it("every file that writes an inline cursor is a known one, with its reason", () => {
    const unknown = WRITERS.filter((f) => !(f in ALLOWED));
    expect(
      unknown,
      "a new inline-cursor writer: an object's pointer belongs in its zoneAt, a cell's in getCellCursor / " +
        "registerCellCursorInterceptor -- or add the file to ALLOWED with the reason it may",
    ).toEqual([]);
  });

  it("Charts/index.ts writes no cursor: the chart's pointer is its zone answer (lib/chartZoneAt.ts)", () => {
    expect(WRITERS, "the Charts mousemove writes canvas.style.cursor again").not.toContain("extensions/Charts/index.ts");
    const src = code(readFileSync(join(EXT, "Charts/index.ts"), "utf8"));
    expect(src).not.toMatch(/\.style\.cursor/);
  });

  it("the two CELL writers ask for a floating object BEFORE they write the canvas cursor", () => {
    const cases: Array<[string, string, string]> = [
      ["Checkbox/index.ts", "setupCheckboxCursor", '"default"'],
      ["Controls/index.ts", "setupButtonCursor", '"pointer"'],
    ];
    for (const [file, fn, cursor] of cases) {
      const body = functionBody(code(readFileSync(join(EXT, file), "utf8")), fn);
      expect(body, `${file}: ${fn} is gone`).not.toBe("");
      const gate = body.search(/topFloatingRegionAtClient\(\s*event\.clientX,\s*event\.clientY\s*\)\s*!==\s*null/);
      const write = body.indexOf(`.style.cursor = ${cursor}`);
      expect(write, `${file}: ${fn} no longer writes ${cursor}`).toBeGreaterThan(0);
      expect(gate, `${file}: ${fn} writes the cell's pointer over a floating object`).toBeGreaterThan(0);
      expect(gate, `${file}: ${fn} asks for the object only AFTER writing`).toBeLessThan(write);
    }
  });
});
