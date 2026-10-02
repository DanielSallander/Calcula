//! FILENAME: app/src/api/__tests__/overlayZoneCensus.test.ts
// PURPOSE: The census that keeps BUG-0258's grammar from drifting back (M5 T6).
//          A floating object has ONE per-point answer -- `zoneAt` -- from which
//          Core derives the press, the pointer and the meaning of Ctrl/Shift.
//          Before M5 the pointer (`getCursor`) and the press (a per-press
//          body-drag claim) were two answers kept in step by hand, and they
//          drifted: the timeline showed a hand over month tiles that MOVED it.
//          T6 deleted the claim and renamed the pointer callback to
//          `getCellCursor`, consulted only for CELL-ANCHORED regions. This
//          file reads the source as TEXT (the timelineZones.test.ts
//          precedent) and pins:
//            1. no non-test source under app/src or app/extensions names the
//               deleted claim at all (code or comment);
//            2. no overlay registration anywhere carries `getCursor:` -- an
//               `as OverlayRegistration` cast (AutoFilter, DataValidation)
//               silences the excess-property check, so the compiler alone
//               would not catch a forgotten rename;
//            3. every FLOATING family -- found by what it publishes (a
//               `floating: {` box), so a new one cannot slip past -- registers
//               `zoneAt` and no cell or pointer callback beside it;
//            4. the cell-anchored users are exactly the three that need it.
// CONTEXT: The type-level half (the fields are gone from OverlayRegistration)
//          is gridOverlays-interactions.test.ts's @ts-expect-error pin.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const APP = resolve(__dirname, "../../..");
const ROOTS = ["src", "extensions"].map((d) => join(APP, d));
/** The deleted claim's name, assembled so this file does not name it itself. */
const DELETED_CLAIM = ["claims", "Body", "Drag"].join("");

function isTestPath(p: string): boolean {
  return (
    p.split(sep).includes("__tests__") ||
    /\.(test|spec)\.tsx?$/.test(p) ||
    p.split(sep).includes("node_modules")
  );
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
const TEXT = new Map(FILES.map((f) => [f, readFileSync(f, "utf8")]));
/** Line comments stripped: a comment that NAMES a field is not a field. */
const CODE = new Map(FILES.map((f) => [f, TEXT.get(f)!.replace(/\/\/.*$/gm, "")]));

/**
 * The object literal around `needle` (the `{` that encloses it, to its
 * matching `}`), in comment-stripped code; null when `needle` is absent.
 */
function enclosingObject(code: string, needle: string): string | null {
  const at = code.indexOf(needle);
  if (at < 0) return null;
  let depth = 0;
  let open = -1;
  for (let i = at; i >= 0; i--) {
    const ch = code[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) {
        open = i;
        break;
      }
      depth--;
    }
  }
  if (open < 0) return null;
  depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * The six floating families: the store that PUBLISHES the region (a
 * `floating: {` box) and the file whose registration answers for its type.
 */
const FLOATING_FAMILIES = [
  { store: "extensions/Charts/lib/chartStore.ts", registration: "extensions/Charts/index.ts", type: 'type: "chart"' },
  { store: "extensions/Slicer/lib/slicerStore.ts", registration: "extensions/Slicer/index.ts", type: 'type: "slicer"' },
  {
    store: "extensions/TimelineSlicer/lib/timelineSlicerStore.ts",
    registration: "extensions/TimelineSlicer/index.ts",
    type: 'type: "timeline-slicer"',
  },
  {
    store: "extensions/FloatingRange/lib/floatingRangeStore.ts",
    registration: "extensions/FloatingRange/index.ts",
    type: "type: FLOATING_RANGE_REGION_TYPE",
  },
  { store: "extensions/Controls/lib/floatingStore.ts", registration: "extensions/Controls/index.ts", type: 'type: "floating-control"' },
  {
    store: "extensions/Pivot/lib/pivotVisualRegions.ts",
    registration: "extensions/Pivot/lib/pivotVisualOverlay.ts",
    type: "type: PIVOT_VISUAL_REGION_TYPE",
  },
];

/** A file that registers a grid overlay or builds a registration. */
function registersOverlays(code: string): boolean {
  return /\boverlays\.register\(|\bregisterGridOverlay\(|\bOverlayRegistration\b/.test(code);
}

describe("the deleted per-press body-drag claim", () => {
  it("is named by no non-test source under app/src or app/extensions (code or comment)", () => {
    expect(FILES.length, "the walk found no sources -- wrong root?").toBeGreaterThan(500);
    const offenders = FILES.filter((f) => TEXT.get(f)!.includes(DELETED_CLAIM)).map(rel);
    expect(offenders).toEqual([]);
  });
});

describe("the pointer callback is `getCellCursor`, for cell-anchored regions only", () => {
  it("no file that registers a grid overlay carries a `getCursor:` (a cast would hide a forgotten rename)", () => {
    const registering = FILES.filter((f) => registersOverlays(CODE.get(f)!));
    // Non-vacuous: the six floating families and the cell-anchored users are all in here.
    expect(registering.length).toBeGreaterThan(8);
    const offenders = registering.filter((f) => /\bgetCursor\s*:/.test(CODE.get(f)!)).map(rel);
    expect(offenders).toEqual([]);
  });

  it("exactly the three cell-anchored users register `getCellCursor` (AutoFilter, DataValidation, the worksheet pivot)", () => {
    const users = FILES.filter((f) => /\bgetCellCursor\s*:/.test(CODE.get(f)!)).map(rel).sort();
    expect(users).toEqual(["extensions/AutoFilter/index.ts", "extensions/DataValidation/index.ts", "extensions/Pivot/index.ts"]);
    // The worksheet pivot's is on its CELL-anchored "pivot" type, never on the floating box.
    const pivot = CODE.get(join(APP, "extensions/Pivot/index.ts"))!;
    const block = enclosingObject(pivot, 'type: "pivot"');
    expect(block, "the worksheet pivot's registration is gone").not.toBeNull();
    expect(block!).toMatch(/\bgetCellCursor\s*:/);
    expect(block!).not.toMatch(/\bzoneAt\s*:/);
  });
});

describe("every FLOATING family answers `zoneAt`, and nothing beside it", () => {
  it("the families are found by what they publish: exactly these stores publish a `floating` box", () => {
    const publishing = FILES.filter((f) => /\bfloating:\s*\{/.test(CODE.get(f)!)).map(rel).sort();
    // A NEW floating family fails here until it is added to FLOATING_FAMILIES
    // -- and so to the checks below: decide its zones on purpose.
    expect(publishing).toEqual(FLOATING_FAMILIES.map((f) => f.store).sort());
  });

  for (const fam of FLOATING_FAMILIES) {
    it(`${fam.registration} (${fam.type}): zoneAt, no getCursor, no getCellCursor, no claim`, () => {
      const code = CODE.get(join(APP, fam.registration));
      expect(code, `${fam.registration} is gone`).toBeDefined();
      const block = enclosingObject(code!, fam.type);
      expect(block, `no registration with ${fam.type} in ${fam.registration}`).not.toBeNull();
      expect(block!).toMatch(/\brender\s*:/); // it IS the registration, not some other object
      expect(block!).toMatch(/\bzoneAt\s*:/);
      expect(block!).not.toMatch(/\bgetCursor\s*:/);
      expect(block!).not.toMatch(/\bgetCellCursor\s*:/);
      expect(block!).not.toContain(DELETED_CLAIM);
    });
  }
});
