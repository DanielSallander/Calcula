// PURPOSE: Prove IntelliSense actually WORKS — by running the real TypeScript
//          language service (the same one Monaco embeds) over the generated
//          objectContexts.d.ts plus the editor's per-script context lib, and
//          asserting the completions and hover text an author would see.
// CONTEXT: "The typings are registered" was already true and meant nothing:
//          nothing bound them, so `context.` completed to zero entries. This
//          test is the evidence for that claim being fixed, and it is
//          reproducible in CI — no app, no window, no screenshot.
//
//          It uses the exact compiler options the editor sets
//          (OBJECT_SCRIPT_COMPILER_OPTIONS) and the exact libs it registers, so
//          a change to either that breaks resolution fails here.

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
  CONTEXT_ANNOTATION,
} from "../lib/monacoTypings";

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
  // Mirrors what the editor sets; asserted below so the two cannot drift.
  allowNonTsExtensions: true,
};

/**
 * A language service over exactly what Monaco is given: the generated typings,
 * the per-script context alias, and the author's file.
 */
function makeService(objectType: string, source: string): { service: ts.LanguageService; source: string } {
  const files = new Map<string, string>([
    [OBJECT_CONTEXTS_LIB, DTS],
    [ACTIVE_CONTEXT_LIB, buildActiveContextLib(objectType, CONTEXT_TYPES)],
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
  return { service: ts.createLanguageService(host, ts.createDocumentRegistry()), source };
}

/** Completion names offered where `marker` appears in `source`. */
function completionsAt(objectType: string, source: string, marker: string): string[] {
  const position = source.indexOf(marker) + marker.length;
  const { service } = makeService(objectType, source);
  const info = service.getCompletionsAtPosition(SCRIPT_FILE, position, undefined);
  return (info?.entries ?? []).map((e) => e.name);
}

/** The hover card for the identifier at `marker`. */
function hoverAt(objectType: string, source: string, marker: string): string {
  const position = source.indexOf(marker) + marker.length - 1;
  const { service } = makeService(objectType, source);
  const info = service.getQuickInfoAtPosition(SCRIPT_FILE, position);
  return (
    ts.displayPartsToString(info?.displayParts ?? []) +
    "\n" +
    ts.displayPartsToString(info?.documentation ?? [])
  );
}

const SHEET_SCRIPT = `${CONTEXT_ANNOTATION}
function setup(context) {
  context.CTX
  context.caps.CAPS
  context.api.API
  context.range("A1").RANGE
}
`;

describe("the generated typings resolve in the TypeScript language service", () => {
  it("uses the same compiler options the editor installs", () => {
    // If these drift, the test proves nothing about the real editor.
    for (const key of ["allowJs", "checkJs", "noEmit", "noImplicitAny", "strictNullChecks", "allowNonTsExtensions"] as const) {
      expect(COMPILER_OPTIONS[key], `${key} differs from the editor's setting`).toBe(
        OBJECT_SCRIPT_COMPILER_OPTIONS[key],
      );
    }
  });

  it("completes `context.` with the whole base surface (this returned NOTHING before)", () => {
    const names = completionsAt("sheet", SHEET_SCRIPT, "context.CTX".replace("CTX", ""));
    for (const expected of ["caps", "api", "log", "notify", "expose", "callMethod", "objectType", "package"]) {
      expect(names, `context.${expected} is not offered`).toContain(expected);
    }
  });

  it("completes the SHEET-specific members, not another objectType's", () => {
    const names = completionsAt("sheet", SHEET_SCRIPT, "context.".slice(0, 8));
    expect(names).toContain("range");
    expect(names).toContain("onSelectionChange");
    expect(names).toContain("setRangeFormat");
    // A sheet script has no slicer/pivot members.
    expect(names).not.toContain("getSelectedItems");
    expect(names).not.toContain("addField");
  });

  it("narrows to the OPEN script's objectType", () => {
    const source = `${CONTEXT_ANNOTATION}\nfunction setup(context) {\n  context.\n}\n`;
    const slicer = completionsAt("slicer", source, "  context.");
    expect(slicer).toContain("getSelectedItems");
    expect(slicer).toContain("selectAll");
    expect(slicer).not.toContain("addField");

    const pivot = completionsAt("pivot", source, "  context.");
    expect(pivot).toContain("addField");
    expect(pivot).toContain("setLayout");
    expect(pivot).not.toContain("getSelectedItems");
  });

  it("completes the capability surface that used to be invisible", () => {
    const names = completionsAt("sheet", SHEET_SCRIPT, "context.caps.");
    for (const expected of [
      "fetch",
      "storage",
      "biQuery",
      "biSql",
      "listBiConnections",
      "cube",
      "biModel",
      "connector",
      "schedule",
      "writeback",
      "dialog",
    ]) {
      expect(names, `caps.${expected} is not offered`).toContain(expected);
    }
  });

  it("completes cube.* and connector.* (absent from the typings entirely before)", () => {
    const cube = completionsAt("sheet", `${CONTEXT_ANNOTATION}\nfunction setup(context) {\n  context.caps.cube.\n}\n`, "cube.");
    expect(cube).toEqual(expect.arrayContaining(["value", "kpi", "members"]));

    const connector = completionsAt(
      "sheet",
      `${CONTEXT_ANNOTATION}\nfunction setup(context) {\n  context.caps.connector.\n}\n`,
      "connector.",
    );
    expect(connector).toEqual(expect.arrayContaining(["register", "remove"]));
  });

  it("completes the canonical Range facet through sheet.range(...)", () => {
    const names = completionsAt("sheet", SHEET_SCRIPT, 'context.range("A1").');
    for (const expected of ["getValues", "getData", "setValues", "format", "clearFormat", "offset", "resize"]) {
      expect(names, `range.${expected} is not offered`).toContain(expected);
    }
  });

  it("completes the unlocked whole-workbook API", () => {
    const names = completionsAt("sheet", SHEET_SCRIPT, "context.api.");
    for (const expected of ["createChart", "createPivot", "sortRange", "findAll", "workbook", "charts"]) {
      expect(names, `api.${expected} is not offered`).toContain(expected);
    }
  });
});

describe("hovering a method explains what it can touch", () => {
  it("shows the allowlist consent sentence and the required capability", () => {
    const source = `${CONTEXT_ANNOTATION}\nfunction setup(context) {\n  context.caps.biQuery(id, req);\n}\n`;
    const hover = hoverAt("sheet", source, "context.caps.biQuery");
    expect(hover).toContain("biQuery");
    expect(hover).toContain("Run read-only, model-scoped queries on this workbook's BI connections");
    expect(hover).toContain("bi.query");
    expect(hover).toContain("cap.biQuery");
  });

  it("names the reach of a whole-workbook write", () => {
    const source = `${CONTEXT_ANNOTATION}\nfunction setup(context) {\n  context.api.deleteSheet(0);\n}\n`;
    const hover = hoverAt("sheet", source, "context.api.deleteSheet");
    expect(hover).toContain("Delete a sheet and everything on it");
    expect(hover).toContain("unlocked tier");
  });

  it("states the schedule capability's honest limit", () => {
    const source = `${CONTEXT_ANNOTATION}\nfunction setup(context) {\n  context.caps.schedule.every(60, "h");\n}\n`;
    const hover = hoverAt("sheet", source, "context.caps.schedule.every");
    expect(hover).toContain("only while Calcula is open");
    expect(hover).toContain("schedule");
  });
});

describe("the typings do not break real scripts", () => {
  it("reports no semantic errors for an annotated scaffold-shaped script", () => {
    const source = `${CONTEXT_ANNOTATION}
function setup(context) {
  context.log("hello");
  context.onDataChange(({ sheetIndex }) => {
    context.log(sheetIndex);
  });
  return () => context.log("bye");
}
`;
    const { service } = makeService("sheet", source);
    const diagnostics = [
      ...service.getSemanticDiagnostics(SCRIPT_FILE),
      ...service.getSyntacticDiagnostics(SCRIPT_FILE),
    ];
    const messages = diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
    expect(messages).toEqual([]);
  });

  it("catches a misspelled method instead of letting it fail in a sandboxed worker", () => {
    const source = `${CONTEXT_ANNOTATION}\nfunction setup(context) {\n  context.caps.biQuerry("a", {});\n}\n`;
    const { service } = makeService("sheet", source);
    const messages = service
      .getSemanticDiagnostics(SCRIPT_FILE)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
    expect(messages.join(" ")).toContain("biQuerry");
  });
});
