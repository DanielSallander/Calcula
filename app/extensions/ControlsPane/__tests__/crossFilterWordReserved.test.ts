//! FILENAME: app/extensions/ControlsPane/__tests__/crossFilterWordReserved.test.ts
// PURPOSE: Keep the ribbon-to-ribbon "dependent filters" concept from drifting
//          back to the word "cross-filter".
// CONTEXT: A ribbon filter narrows the value lists of the filters and slicers
//          it names: Calcula calls those its DEPENDENT FILTERS. "Cross-filter"
//          is reserved for the canvas visual-to-visual interaction (Power BI's
//          meaning), which another package owns. This census guards exactly
//          what the rename protects and nothing that package may need:
//          (1) user-visible text in the Controls pane components -- JSX text
//              and string/template literals, with import/export specifiers
//              EXEMPT, so the pane may import a resolver named
//              `@api/crossFilter`;
//          (2) the six RETIRED identifiers, in non-test ControlsPane code,
//              app/src and the Rust ribbon_filter module.
//          Each group lists what it scanned and fails on zero files, so it
//          cannot pass vacuously.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const CONTROLS_PANE = path.resolve(__dirname, "..");
const COMPONENTS = path.join(CONTROLS_PANE, "components");
const APP_SRC = path.resolve(__dirname, "../../../src");
const RUST_RIBBON_FILTER = path.resolve(__dirname, "../../../src-tauri/src/ribbon_filter");

const RESERVED_WORD = /cross[\s_-]?filter/i;

const RETIRED_IDENTIFIERS = [
  "crossFilterTargets",
  "crossFilterSlicerTargets",
  "cross_filter_targets",
  "cross_filter_slicer_targets",
  "BiCrossFilter",
  "crossTargets",
];

function isTestPath(file: string): boolean {
  const parts = file.split(/[\\/]/);
  return (
    parts.includes("__tests__") ||
    parts.includes("__snapshots__") ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)
  );
}

function walk(dir: string, accept: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...walk(full, accept));
    } else if (accept(full)) {
      out.push(full);
    }
  }
  return out;
}

/** True when `node` is the module specifier of an import/export (or a type
 *  import / dynamic import argument): those name a module, not a user. */
function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) {
    return parent.moduleSpecifier === node;
  }
  if (ts.isExternalModuleReference(parent)) return true;
  if (ts.isLiteralTypeNode(parent) && parent.parent && ts.isImportTypeNode(parent.parent)) {
    return true;
  }
  if (
    ts.isCallExpression(parent) &&
    parent.expression.kind === ts.SyntaxKind.ImportKeyword
  ) {
    return true;
  }
  return false;
}

interface TextHit {
  line: number;
  text: string;
}

/** Every JSX text and string/template literal text in a source, excluding
 *  module specifiers. Comments are not tokens and are never visited. */
function userVisibleTexts(fileName: string, source: string): TextHit[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: TextHit[] = [];
  const add = (node: ts.Node, text: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    hits.push({ line: line + 1, text });
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      add(node, node.text);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isModuleSpecifier(node)) add(node, node.text);
    } else if (
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      add(node, (node as ts.TemplateLiteralLikeNode).text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function rel(file: string): string {
  return path.relative(path.resolve(__dirname, "../../.."), file).replace(/\\/g, "/");
}

describe("the word 'cross-filter' is reserved (dependent filters rename)", () => {
  describe("(1) user-visible text in ControlsPane components", () => {
    const files = walk(COMPONENTS, (f) => f.endsWith(".tsx") && !isTestPath(f));

    it("scans the component files", () => {
      expect(files.length).toBeGreaterThan(0);
      const names = files.map((f) => path.basename(f));
      // The two components that carried the old words.
      expect(names).toContain("FilterDropdown.tsx");
      expect(names).toContain("RibbonFilterCard.tsx");
    });

    it("no JSX text or string literal says cross-filter", () => {
      const offenders: string[] = [];
      for (const file of files) {
        for (const hit of userVisibleTexts(file, fs.readFileSync(file, "utf8"))) {
          if (RESERVED_WORD.test(hit.text)) {
            offenders.push(`${rel(file)}:${hit.line}: ${JSON.stringify(hit.text.trim())}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  });

  describe("(2) retired identifiers", () => {
    const groups: Array<{ name: string; files: string[] }> = [
      {
        name: "ControlsPane (non-test)",
        files: walk(CONTROLS_PANE, (f) => /\.[cm]?[jt]sx?$/.test(f) && !isTestPath(f)),
      },
      {
        name: "app/src (non-test)",
        files: walk(APP_SRC, (f) => /\.[cm]?[jt]sx?$/.test(f) && !isTestPath(f)),
      },
      {
        name: "app/src-tauri/src/ribbon_filter",
        files: walk(RUST_RIBBON_FILTER, (f) => f.endsWith(".rs")),
      },
    ];

    for (const group of groups) {
      it(`${group.name}: scans files and none names a retired identifier`, () => {
        expect(group.files.length, `${group.name} scanned no files`).toBeGreaterThan(0);
        const offenders: string[] = [];
        for (const file of group.files) {
          const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
          lines.forEach((line, i) => {
            for (const id of RETIRED_IDENTIFIERS) {
              if (new RegExp(`\\b${id}\\b`).test(line)) {
                offenders.push(`${rel(file)}:${i + 1}: ${id}`);
              }
            }
          });
        }
        expect(offenders).toEqual([]);
      });
    }

    it("the Rust module group includes types.rs (the wire)", () => {
      const rust = groups[2].files.map((f) => path.basename(f));
      expect(rust).toContain("types.rs");
      expect(rust).toContain("commands.rs");
    });
  });

  it("the text extractor exempts module specifiers but sees literals and JSX text (self-test)", () => {
    const src = `import type {} from "@api/crossFilter";
export { x } from "./crossFilterThing";
const t = await import("@api/crossFilter");
const a = "Cross-filter";
const b = \`cross filter \${a}\`;
const el = <div title="ok">cross_filter here</div>;
// cross-filter in a comment is not user-visible
`;
    const texts = userVisibleTexts("probe.tsx", src).map((h) => h.text);
    const matching = texts.filter((t) => RESERVED_WORD.test(t));
    expect(matching).toEqual(["Cross-filter", "cross filter ", "cross_filter here"]);
  });
});
