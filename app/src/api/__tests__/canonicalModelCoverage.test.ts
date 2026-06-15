//! FILENAME: app/src/api/__tests__/canonicalModelCoverage.test.ts
// PURPOSE: Drift guard for the canonical shared object model (C3 step 4). Asserts
//          every runtime surface that binds the model — the extension classes,
//          the object-script @api interfaces, the worker implementation, and the
//          Monaco IntelliSense .d.ts — declares the full canonical member set
//          (canonicalModelSpec.ts). A method added to the model in one place but
//          not the others fails here, so the surfaces can't drift apart.
// CONTEXT: Mirrors calculaDtsCoverage.test.ts (the flat-op drift guard). The
//          notebook (Rust-QuickJS) surface joins this guard when C3 step 5 binds
//          the model there; today it exposes the flat Calcula.* ops instead.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  CANONICAL_RANGE_MEMBERS,
  CANONICAL_SHEET_MEMBERS,
  CANONICAL_WORKBOOK_MEMBERS,
} from "../canonicalModelSpec";

const API_DIR = path.resolve(__dirname, "..");
const DTS_PATH = path.resolve(
  __dirname,
  "../../../extensions/ScriptableObjects/objectContexts.d.ts",
);

/** Remove block + line comments so doc text can't mask a missing member or skew
 *  brace matching. (The canonical decls contain no `//`/`/*` inside strings.) */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Extract a `class X {...}` / `interface X {...}` body by brace matching. */
function extractBlock(src: string, declRe: RegExp): string {
  const m = declRe.exec(src);
  if (!m) return "";
  const open = src.indexOf("{", m.index);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** True iff `name` is DECLARED as a member of the block (method/getter/property/
 *  constructor parameter property) — at a declaration boundary, not a usage. */
function declaresMember(block: string, name: string): boolean {
  const re = new RegExp(
    `(^|[\\n;{])\\s*` +
      `(?:public\\s+|private\\s+|protected\\s+|static\\s+|readonly\\s+|async\\s+|get\\s+|set\\s+)*` +
      `${name}\\s*[(:?<]`,
  );
  return re.test(block);
}

interface Surface {
  label: string;
  file: string;
  decl: RegExp;
  manifest: readonly string[];
}

const SURFACES: Surface[] = [
  // Extension runtime (concrete classes)
  { label: "extension CellRange (range.ts)", file: path.join(API_DIR, "range.ts"), decl: /class\s+CellRange\b/, manifest: CANONICAL_RANGE_MEMBERS },
  { label: "extension Sheet (objectModel.ts)", file: path.join(API_DIR, "objectModel.ts"), decl: /class\s+Sheet\b/, manifest: CANONICAL_SHEET_MEMBERS },
  { label: "extension Workbook (objectModel.ts)", file: path.join(API_DIR, "objectModel.ts"), decl: /class\s+Workbook\b/, manifest: CANONICAL_WORKBOOK_MEMBERS },
  // Object-script @api types (interfaces)
  { label: "object-script ScriptRange (scriptableObjects.ts)", file: path.join(API_DIR, "scriptableObjects.ts"), decl: /interface\s+ScriptRange\b/, manifest: CANONICAL_RANGE_MEMBERS },
  { label: "object-script ScriptSheet (scriptableObjects.ts)", file: path.join(API_DIR, "scriptableObjects.ts"), decl: /interface\s+ScriptSheet\b/, manifest: CANONICAL_SHEET_MEMBERS },
  { label: "object-script ScriptWorkbook (scriptableObjects.ts)", file: path.join(API_DIR, "scriptableObjects.ts"), decl: /interface\s+ScriptWorkbook\b/, manifest: CANONICAL_WORKBOOK_MEMBERS },
  // Object-script worker implementation
  { label: "worker ScriptRange (canonicalModel.ts)", file: path.join(API_DIR, "scriptHost/worker/canonicalModel.ts"), decl: /interface\s+ScriptRange\b/, manifest: CANONICAL_RANGE_MEMBERS },
  { label: "worker ScriptSheet (canonicalModel.ts)", file: path.join(API_DIR, "scriptHost/worker/canonicalModel.ts"), decl: /interface\s+ScriptSheet\b/, manifest: CANONICAL_SHEET_MEMBERS },
  { label: "worker ScriptWorkbook (canonicalModel.ts)", file: path.join(API_DIR, "scriptHost/worker/canonicalModel.ts"), decl: /interface\s+ScriptWorkbook\b/, manifest: CANONICAL_WORKBOOK_MEMBERS },
  // Monaco IntelliSense .d.ts
  { label: "d.ts ScriptRange (objectContexts.d.ts)", file: DTS_PATH, decl: /interface\s+ScriptRange\b/, manifest: CANONICAL_RANGE_MEMBERS },
  { label: "d.ts ScriptSheet (objectContexts.d.ts)", file: DTS_PATH, decl: /interface\s+ScriptSheet\b/, manifest: CANONICAL_SHEET_MEMBERS },
  { label: "d.ts ScriptWorkbook (objectContexts.d.ts)", file: DTS_PATH, decl: /interface\s+ScriptWorkbook\b/, manifest: CANONICAL_WORKBOOK_MEMBERS },
];

describe("canonical model spec sanity", () => {
  it("manifests are non-empty and duplicate-free", () => {
    for (const m of [CANONICAL_RANGE_MEMBERS, CANONICAL_SHEET_MEMBERS, CANONICAL_WORKBOOK_MEMBERS]) {
      expect(m.length).toBeGreaterThan(0);
      expect(new Set(m).size).toBe(m.length);
    }
  });
});

describe("canonical model coverage across runtime surfaces (C3 step 4)", () => {
  it.each(SURFACES)("$label declares the full canonical member set", ({ file, decl, manifest, label }) => {
    const src = stripComments(fs.readFileSync(file, "utf8"));
    const block = extractBlock(src, decl);
    expect(block, `could not locate ${label}`).not.toBe("");
    const missing = manifest.filter((member) => !declaresMember(block, member));
    expect(missing, `${label} is missing canonical members: ${missing.join(", ")}`).toEqual([]);
  });

  it("the object-script .d.ts mirrors the @api interfaces (no member drift)", () => {
    const api = stripComments(fs.readFileSync(path.join(API_DIR, "scriptableObjects.ts"), "utf8"));
    const dts = stripComments(fs.readFileSync(DTS_PATH, "utf8"));
    for (const [iface, manifest] of [
      ["ScriptRange", CANONICAL_RANGE_MEMBERS],
      ["ScriptSheet", CANONICAL_SHEET_MEMBERS],
      ["ScriptWorkbook", CANONICAL_WORKBOOK_MEMBERS],
    ] as const) {
      const apiBlock = extractBlock(api, new RegExp(`interface\\s+${iface}\\b`));
      const dtsBlock = extractBlock(dts, new RegExp(`interface\\s+${iface}\\b`));
      for (const member of manifest) {
        const inApi = declaresMember(apiBlock, member);
        const inDts = declaresMember(dtsBlock, member);
        expect(inApi, `${iface}.${member} in @api but not .d.ts`).toBe(inDts);
      }
    }
  });
});
