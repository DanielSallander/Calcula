//! FILENAME: app/extensions/BuiltIn/ObjectPane/__tests__/objectFormatBindingPaths.test.ts
// PURPOSE: WP-D's required check on WP-C (D-bindings.md §3.4 item 4): every
//          container field a family's format provider offers to BIND names a
//          pointer WP-D's catalog accepts (`isBindablePath(kind, path)`). A
//          provider that offered a pointer the catalog refuses would show an fx
//          the backend then refuses on every commit.
// CONTEXT: SOURCE-READING, the census style. A test here may import only the
//          seams, not another family's provider (the Facade Rule the providers
//          are written under), so each family keeps its field -> pointer map as
//          ONE exported literal, `export const CONTAINER_BINDING_PATHS = {...}`
//          (nested per sub-type where it varies, e.g. per control type), next
//          to `export const CONTAINER_BINDING_KIND = "<kind>"`, in its
//          `*ObjectFormat.ts` provider file. This test reads those files as text,
//          extracts every "/..." pointer of the literal, and asks the catalog.
//          Each family's own provider test asserts at run time that
//          `bindingPath` answers FROM that table.
//
//          The providers land family by family (S9a-S13). A file that does not
//          exist yet is listed as pending, never silently passed; a file that
//          exists must carry both exports. The extractor's teeth are proved on
//          planted text below, so a family that lands is checked for real.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { isBindablePath, isObjectBindingKind, type ObjectBindingKind } from "@api/objectBindings";
import { VISUAL_CONTAINER_FIELD_IDS } from "@api/visualContainer";

const EXT_ROOT = path.resolve(__dirname, "../../..");

/** The family provider files (WP-C S9a-S13) and the WP-D kind each binds under. */
export const PROVIDER_FILES: ReadonlyArray<{ file: string; kind: ObjectBindingKind }> = [
  { file: "Charts/lib/chartObjectFormat.ts", kind: "chart" },
  { file: "Pivot/lib/pivotObjectFormat.ts", kind: "pivot" },
  { file: "Slicer/lib/slicerObjectFormat.ts", kind: "slicer" },
  { file: "TimelineSlicer/lib/timelineObjectFormat.ts", kind: "timelineSlicer" },
  { file: "FloatingRange/lib/frObjectFormat.ts", kind: "floatingRange" },
  { file: "Controls/lib/controlObjectFormat.ts", kind: "control" },
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The brace-matched body of `export const NAME = { ... }` (or with a type annotation), or null. */
export function exportedLiteral(src: string, name: string): string | null {
  const text = stripComments(src);
  const m = new RegExp(`export\\s+const\\s+${name}\\b[^=]*=\\s*(?:Object\\.freeze\\()?\\s*\\{`).exec(text);
  if (!m) return null;
  let depth = 0;
  const start = m.index + m[0].length - 1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** `export const CONTAINER_BINDING_KIND = "chart"` -> "chart", or null. */
export function exportedKind(src: string): string | null {
  const m = /export\s+const\s+CONTAINER_BINDING_KIND\b[^=]*=\s*["']([^"']+)["']/.exec(stripComments(src));
  return m ? m[1] : null;
}

/** Every quoted VALUE in the literal that is a JSON Pointer ("/..."). Keys never start with "/". */
export function pointersIn(literal: string): string[] {
  const out: string[] = [];
  for (const m of literal.matchAll(/:\s*(["'])(\/[^"']*)\1/g)) out.push(m[2]);
  return out;
}

/** Every key of the literal that is a container field id (a typo there would never be asked). */
export function fieldKeysIn(literal: string): string[] {
  const out: string[] = [];
  for (const m of literal.matchAll(/(?:^|[{,\s])(["']?)([A-Za-z][\w.]*)\1\s*:/g)) out.push(m[2]);
  return out;
}

/** What a provider file's table asks of the catalog: one sentence per refused pointer. */
export function refusedPointers(src: string, kind: ObjectBindingKind): string[] {
  const literal = exportedLiteral(src, "CONTAINER_BINDING_PATHS");
  if (literal === null) return ["no `export const CONTAINER_BINDING_PATHS = { ... }` literal"];
  const declared = exportedKind(src);
  if (declared !== kind) return [`CONTAINER_BINDING_KIND is ${JSON.stringify(declared)}, expected "${kind}"`];
  const out: string[] = [];
  for (const p of pointersIn(literal)) {
    if (!isBindablePath(kind, p)) out.push(`${kind} ${p} is not a WP-D catalog row`);
  }
  const known = new Set<string>(VISUAL_CONTAINER_FIELD_IDS);
  const dotted = fieldKeysIn(literal).filter((k) => k.includes(".") || k === "lockAspect");
  for (const k of dotted) {
    if (!known.has(k)) out.push(`${k} is not a container field id`);
  }
  return out;
}

describe("every family provider's bindable container pointers are WP-D catalog rows", () => {
  for (const { file, kind } of PROVIDER_FILES) {
    const abs = path.join(EXT_ROOT, file);
    const exists = fs.existsSync(abs);
    it.skipIf(!exists)(`${file} (${kind})`, () => {
      const src = fs.readFileSync(abs, "utf8");
      expect(refusedPointers(src, kind)).toEqual([]);
      // NON-VACUITY: a provider that binds nothing still writes its table, and
      // one that binds something lists at least one pointer.
      const literal = exportedLiteral(src, "CONTAINER_BINDING_PATHS")!;
      expect(literal.length).toBeGreaterThan(2);
    });
  }

  it("the list names real WP-D kinds", () => {
    for (const { kind } of PROVIDER_FILES) expect(isObjectBindingKind(kind)).toBe(true);
  });

  it("reports which providers have not landed yet (so the skip above is visible, not silent)", () => {
    const pending = PROVIDER_FILES.filter(({ file }) => !fs.existsSync(path.join(EXT_ROOT, file))).map((p) => p.file);
    // Not a failure: S9a-S13 add them. The list only ever SHRINKS -- a file
    // that is not in PROVIDER_FILES is caught by the next test.
    expect(pending.every((f) => PROVIDER_FILES.some((p) => p.file === f))).toBe(true);
  });

  it("every *ObjectFormat.ts provider file in the tree is in the list", () => {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "__tests__") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/ObjectFormat\.tsx?$/.test(entry.name)) {
          found.push(path.relative(EXT_ROOT, full).split(path.sep).join("/"));
        }
      }
    };
    walk(EXT_ROOT);
    const listed = new Set(PROVIDER_FILES.map((p) => p.file));
    expect(found.filter((f) => !listed.has(f))).toEqual([]);
  });
});

describe("the extractor has teeth (planted provider text)", () => {
  const GOOD = `
    // a comment with "/not/a/pointer" in it
    export const CONTAINER_BINDING_KIND = "slicer";
    export const CONTAINER_BINDING_PATHS: Partial<Record<ContainerFieldId, string | null>> = {
      "title.text": "/headerText",
      "title.show": "/showHeader",
      "border.radius": "/container/border/radius",
      lockAspect: null,
    };
  `;

  it("a table of real catalog rows passes", () => {
    expect(pointersIn(exportedLiteral(GOOD, "CONTAINER_BINDING_PATHS")!)).toEqual([
      "/headerText",
      "/showHeader",
      "/container/border/radius",
    ]);
    expect(refusedPointers(GOOD, "slicer")).toEqual([]);
  });

  it("a pointer the catalog refuses is reported", () => {
    const bad = GOOD.replace('"/container/border/radius"', '"/container/border/nope"');
    expect(refusedPointers(bad, "slicer")).toEqual(["slicer /container/border/nope is not a WP-D catalog row"]);
  });

  it("a field key that is not a container field is reported", () => {
    const bad = GOOD.replace('"border.radius"', '"border.radios"');
    expect(refusedPointers(bad, "slicer")).toContain("border.radios is not a container field id");
  });

  it("a nested per-type table is read whole", () => {
    const nested = `
      export const CONTAINER_BINDING_KIND = "control";
      export const CONTAINER_BINDING_PATHS = {
        shape: { "background.color": "/properties/fill", "padding.top": "/properties/containerPaddingTop" },
        button: { "border.color": "/properties/borderColor", "padding.top": null },
      };
    `;
    expect(pointersIn(exportedLiteral(nested, "CONTAINER_BINDING_PATHS")!)).toEqual([
      "/properties/fill",
      "/properties/containerPaddingTop",
      "/properties/borderColor",
    ]);
    expect(refusedPointers(nested, "control")).toEqual([]);
  });

  it("a missing table or a wrong kind is reported, never passed", () => {
    expect(refusedPointers('export const CONTAINER_BINDING_KIND = "slicer";', "slicer")).toEqual([
      "no `export const CONTAINER_BINDING_PATHS = { ... }` literal",
    ]);
    expect(refusedPointers(GOOD, "chart")[0]).toContain('expected "chart"');
  });
});
