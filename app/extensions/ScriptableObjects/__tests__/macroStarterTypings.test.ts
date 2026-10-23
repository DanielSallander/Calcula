//! FILENAME: app/extensions/ScriptableObjects/__tests__/macroStarterTypings.test.ts
// PURPOSE: The starter a new macro begins from must open in the Object Script
//          Editor with ZERO red squiggles, and `api.` / `context.` inside it
//          must complete. Proved with the real TypeScript language service over
//          the generated objectContexts.d.ts and the editor's per-script
//          context lib, under the editor's own compiler options (`checkJs`).
// CONTEXT: docs/design/open-items.md section 2.ap. Two defects were found in
//          the template's first draft by exactly this check and nowhere else:
//          `cell.value + AMOUNT` (TS2365, the union does not narrow on the
//          `type` check) and `context.onClick` on a `WorkbookContext` (TS2339,
//          a macro document's context has no click hook). The harness is the
//          one intellisenseResolution.test.ts uses; the sabotage case at the
//          end proves it still sees that class of defect.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import ts from "typescript";
import {
  OBJECT_SCRIPT_COMPILER_OPTIONS,
  OBJECT_CONTEXTS_LIB,
  ACTIVE_CONTEXT_LIB,
  buildActiveContextLib,
  readContextTypeMap,
} from "../lib/monacoTypings";
import { buildMacroStarterSource } from "@api/scriptHost/macroStarter";

const DTS = fs.readFileSync(path.resolve(__dirname, "../objectContexts.d.ts"), "utf8");
const CONTEXT_TYPES = readContextTypeMap(DTS);
const SCRIPT_FILE = "objectScript.js";

const COMPILER_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  noImplicitAny: false,
  strictNullChecks: false,
  target: ts.ScriptTarget.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowNonTsExtensions: true,
};

/**
 * A language service over exactly what Monaco is given for a MACRO document:
 * the generated typings, the workbook context alias (a module macro's document
 * synthesises objectType "workbook"), and the starter as the author's file.
 */
function makeService(source: string): ts.LanguageService {
  const files = new Map<string, string>([
    [OBJECT_CONTEXTS_LIB, DTS],
    [ACTIVE_CONTEXT_LIB, buildActiveContextLib("workbook", CONTEXT_TYPES)],
    [SCRIPT_FILE, source],
  ]);
  const defaultLib = ts.getDefaultLibFilePath(COMPILER_OPTIONS);
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: () => "1",
    getScriptSnapshot: (fileName) => {
      const inMemory = files.get(fileName);
      if (inMemory !== undefined) return ts.ScriptSnapshot.fromString(inMemory);
      if (!fs.existsSync(fileName)) return undefined;
      return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, "utf8"));
    },
    getCurrentDirectory: () => process.cwd(),
    getCompilationSettings: () => COMPILER_OPTIONS,
    getDefaultLibFileName: () => defaultLib,
    fileExists: (fileName) => files.has(fileName) || fs.existsSync(fileName),
    readFile: (fileName) => files.get(fileName) ?? (fs.existsSync(fileName) ? fs.readFileSync(fileName, "utf8") : undefined),
  };
  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

/** Every semantic and syntactic diagnostic, flattened to its message. */
function diagnosticsOf(source: string): string[] {
  const service = makeService(source);
  return [
    ...service.getSemanticDiagnostics(SCRIPT_FILE),
    ...service.getSyntacticDiagnostics(SCRIPT_FILE),
  ].map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
}

/** Completion names offered right after the FIRST occurrence of `marker`. */
function completionsAfter(source: string, marker: string): string[] {
  const at = source.indexOf(marker);
  expect(at, `marker ${JSON.stringify(marker)} is not in the starter`).toBeGreaterThanOrEqual(0);
  const service = makeService(source);
  const info = service.getCompletionsAtPosition(SCRIPT_FILE, at + marker.length, undefined);
  return (info?.entries ?? []).map((e) => e.name);
}

const STARTER = buildMacroStarterSource("Macro1");

describe("the macro starter under the editor's checkJs", () => {
  it("uses the same compiler options the editor installs", () => {
    for (const key of ["allowJs", "checkJs", "noEmit", "noImplicitAny", "strictNullChecks", "allowNonTsExtensions"] as const) {
      expect(COMPILER_OPTIONS[key], `${key} differs from the editor's setting`).toBe(
        OBJECT_SCRIPT_COMPILER_OPTIONS[key],
      );
    }
  });

  it("has zero semantic and zero syntactic diagnostics", () => {
    expect(diagnosticsOf(STARTER)).toEqual([]);
  });

  it("stays clean under a different name", () => {
    expect(diagnosticsOf(buildMacroStarterSource("Add one"))).toEqual([]);
    expect(diagnosticsOf(buildMacroStarterSource("setup"))).toEqual([]);
  });

  it("completes `api.` inside the work function with the cell API", () => {
    const names = completionsAfter(STARTER, "const selection = await api.");
    for (const expected of ["getSelection", "getRangeValues", "updateCellsBatch", "beginBatch", "commitBatch"]) {
      expect(names, `api.${expected} is not offered`).toContain(expected);
    }
  });

  it("completes `context.` inside setup with api, notify and the optional onClick", () => {
    const names = completionsAfter(STARTER, "const report = (n) => context.");
    for (const expected of ["api", "notify", "onClick", "log"]) {
      expect(names, `context.${expected} is not offered`).toContain(expected);
    }
  });

  it("still sees the defect class it guards against (the harness has teeth)", () => {
    // The first draft's mistake: the union `string | number | boolean | null`
    // does not narrow on `cell.type === "number"`, so `cell.value + AMOUNT` is
    // TS2365. If this stops being reported, the zero-diagnostics assertion
    // above proves nothing.
    const sabotaged = STARTER.replace("value: Number(cell.value) + AMOUNT,", "value: cell.value + AMOUNT,");
    expect(sabotaged).not.toBe(STARTER);
    expect(diagnosticsOf(sabotaged).join("\n")).toContain("TS2365");
  });
});
