// PURPOSE: Prove the TypeScript authoring path end to end without an app: that
//          a type error IS reported in the model an author actually edits, that
//          the save gate blocks anything that cannot run, and that the stored
//          artifact keeps the consent binding honest.
// CONTEXT: The product describes objects as "user-scriptable via TypeScript"
//          and ships a generated objectContexts.d.ts describing the whole
//          surface — but every editor model was `language: "javascript"`, so a
//          real annotation was a syntax error and the typings could only
//          complete, never check. This file pins the three things that had to
//          become true:
//
//            1. a TypeScript model, configured the way the editor configures it,
//               reports a misspelled method;
//            2. the save gate compiles TypeScript to the JavaScript that is
//               stored, and REFUSES to store anything that does not compile;
//            3. the stored artifact is stable, so the source hash that binds a
//               capability grant only moves when behaviour moves.
//
//          It uses the real TypeScript language service (the one Monaco embeds)
//          and the real lane registration, so a change to either shows up here.

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import ts from "typescript";
import {
  registerTypescriptLane,
  registerJavascriptLane,
  gateObjectScriptSave,
  objectScriptModelPath,
  OBJECT_SCRIPT_LANE_SUPPRESSIONS,
} from "../lib/authoringLanguage";
import {
  mergedLibs,
  mergedIgnoredCodes,
  SCRIPT_LANE_COMPILER_OPTIONS,
  resetScriptLanesForTest,
  type MonacoTypescriptNamespace,
} from "../../_shared/lib/monacoScriptLanes";
import {
  OBJECT_SCRIPT_DIAGNOSTICS,
  ACTIVE_CONTEXT_LIB,
  buildActiveContextLib,
  readContextTypeMap,
} from "../lib/monacoTypings";
import { sha256Hex } from "@api/distributedConsent";

const DTS = fs.readFileSync(path.resolve(__dirname, "../objectContexts.d.ts"), "utf8");

/** A Monaco stand-in that records what the editor registers. */
function makeMonacoTs(): MonacoTypescriptNamespace {
  const makeDefaults = () => ({
    addExtraLib: () => ({ dispose: () => {} }),
    setDiagnosticsOptions: () => {},
    setCompilerOptions: () => {},
  });
  return {
    javascriptDefaults: makeDefaults(),
    typescriptDefaults: makeDefaults(),
    // eslint-disable-next-line @typescript-eslint/naming-convention -- mirrors Monaco's own API surface
    ScriptTarget: { ESNext: ts.ScriptTarget.ESNext },
  };
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  ...(SCRIPT_LANE_COMPILER_OPTIONS as ts.CompilerOptions),
  target: ts.ScriptTarget.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};

/**
 * A language service over exactly the files the editor's lane holds, with the
 * script under the same kind of model name the editor uses — the extension is
 * what decides whether annotations are legal.
 */
function diagnosticsFor(
  lane: "javascript" | "typescript",
  source: string,
  objectType = "sheet",
): string[] {
  const fileName = objectScriptModelPath("script-1", lane).replace(/^objectScript\//, "");
  const files = new Map<string, string>(mergedLibs(lane));
  if (lane === "javascript") {
    // On the JavaScript lane the per-script alias is published by
    // monacoTypings.setActiveContextType (which owns its own disposable so it
    // can swap it when the open script changes), not by the lane registry.
    files.set(ACTIVE_CONTEXT_LIB, buildActiveContextLib(objectType, readContextTypeMap(DTS)));
  }
  files.set(fileName, source);
  const defaultLib = ts.getDefaultLibFilePath(COMPILER_OPTIONS);
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: () => "1",
    getScriptSnapshot: (name) => {
      const inMemory = files.get(name);
      if (inMemory !== undefined) return ts.ScriptSnapshot.fromString(inMemory);
      if (!fs.existsSync(name)) return undefined;
      return ts.ScriptSnapshot.fromString(fs.readFileSync(name, "utf8"));
    },
    getCurrentDirectory: () => process.cwd(),
    getCompilationSettings: () => COMPILER_OPTIONS,
    getDefaultLibFileName: () => defaultLib,
    fileExists: (name) => files.has(name) || fs.existsSync(name),
    readFile: (name) =>
      files.get(name) ?? (fs.existsSync(name) ? fs.readFileSync(name, "utf8") : undefined),
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const ignored = new Set(mergedIgnoredCodes(lane));
  return [...service.getSemanticDiagnostics(fileName), ...service.getSyntacticDiagnostics(fileName)]
    .filter((d) => !ignored.has(d.code))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
}

let monacoTs: MonacoTypescriptNamespace;

beforeEach(() => {
  resetScriptLanesForTest();
  monacoTs = makeMonacoTs();
});

describe("a TypeScript object script is type-checked in the editor", () => {
  beforeEach(() => {
    registerTypescriptLane(monacoTs, "sheet", DTS);
  });

  it("accepts a real type annotation — which the JavaScript model could not parse", () => {
    const source = `async function setup(context: ObjectScriptContext): Promise<() => void> {
  const values: unknown[][] = await context.range("A1:B2").getValues();
  const kind: string = context.objectType;
  context.log(kind + String(values.length));
  return () => context.log("bye");
}
`;
    expect(diagnosticsFor("typescript", source)).toEqual([]);
    // The same text in the JavaScript lane is a pile of syntax errors: that is
    // exactly what authors hit before this existed.
    expect(diagnosticsFor("javascript", source).join(" ")).toContain("can only be used in TypeScript files");
  });

  it("REPORTS a misspelled method instead of letting it fail in a sandboxed worker", () => {
    const source = `function setup(context: ObjectScriptContext) {
  context.caps.biQuerry("conn", {});
}
`;
    expect(diagnosticsFor("typescript", source).join(" ")).toContain("biQuerry");
  });

  it("reports a wrong argument type", () => {
    const source = `function setup(context: ObjectScriptContext) {
  context.range(42);
}
`;
    const messages = diagnosticsFor("typescript", source).join(" ");
    expect(messages).toMatch(/not assignable|Argument of type/);
  });

  it("narrows the context to the object type the script is attached to", () => {
    const source = `function setup(context: ObjectScriptContext) {
  context.getSelectedItems();
}
`;
    // A SHEET script has no slicer members...
    expect(diagnosticsFor("typescript", source).join(" ")).toContain("getSelectedItems");
    // ...but a slicer script does.
    resetScriptLanesForTest();
    registerTypescriptLane(monacoTs, "slicer", DTS);
    expect(diagnosticsFor("typescript", source)).toEqual([]);
  });

  it("keeps the editor's suppressions in step with monacoTypings", () => {
    // If OBJECT_SCRIPT_DIAGNOSTICS gains a code that the lane registration does
    // not contribute, an author sees different diagnostics depending on which
    // module last configured Monaco. That is the failure this whole mechanism
    // exists to prevent, so it is asserted rather than hoped for.
    const declared = OBJECT_SCRIPT_DIAGNOSTICS.diagnosticCodesToIgnore as number[];
    const live = mergedIgnoredCodes("typescript");
    for (const code of declared) {
      expect(live, `code ${code} is suppressed by monacoTypings but not by the lane`).toContain(code);
    }
    for (const entry of OBJECT_SCRIPT_LANE_SUPPRESSIONS) {
      expect(declared, `code ${entry.code} is suppressed by the lane but not by monacoTypings`).toContain(entry.code);
    }
  });
});

describe("JSDoc types work in the JavaScript lane — and ONLY there", () => {
  it("catches the same typo through a JSDoc annotation", () => {
    registerJavascriptLane(monacoTs, DTS);
    registerTypescriptLane(monacoTs, "sheet", DTS);
    const source = `/** @param {ObjectScriptContext} context */
function setup(context) {
  context.caps.biQuerry("conn", {});
}
`;
    expect(diagnosticsFor("javascript", source).join(" ")).toContain("biQuerry");
  });

  it("is silently ignored in a .ts model, which is why JavaScript stays the default", () => {
    registerTypescriptLane(monacoTs, "sheet", DTS);
    const source = `/** @param {ObjectScriptContext} context */
function setup(context) {
  context.caps.biQuerry("conn", {});
}
`;
    // TypeScript does not apply JSDoc types in .ts files, so `context` is
    // implicitly any and the typo goes unreported. An editor that switched
    // every existing script to TypeScript would therefore have SILENTLY LOST
    // the type-checking those scripts already had.
    expect(diagnosticsFor("typescript", source)).toEqual([]);
  });
});

describe("the save gate decides what may be stored", () => {
  const accept = async () => ({ valid: true });
  const reject = async () => ({ valid: false, error: "Unexpected token" });

  it("compiles TypeScript and hands back the JavaScript to store", async () => {
    const gate = await gateObjectScriptSave(
      "function setup(context: ObjectScriptContext) {\n  context.log('hi');\n}\n",
      "Sheet Script",
      accept,
    );
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    expect(gate.transformed).toBe(true);
    expect(gate.javascript).not.toContain(": ObjectScriptContext");
    expect(gate.javascript).toContain("function setup(context)");
  });

  it("passes an existing JavaScript script through byte for byte", async () => {
    const js = "/** @param {ObjectScriptContext} context */\nfunction setup(context) {\n\n  context.log('hi');\n}\n";
    const gate = await gateObjectScriptSave(js, "Sheet Script", accept);
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    expect(gate.javascript).toBe(js);
    expect(gate.transformed).toBe(false);
  });

  it("BLOCKS the save when the source does not compile, before the sandbox is even asked", async () => {
    let sandboxCalls = 0;
    const counting = async () => {
      sandboxCalls += 1;
      return { valid: true };
    };
    const gate = await gateObjectScriptSave("function setup(context: {\n", "Broken", counting);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.detail).toContain("Not saved");
    expect(gate.detail).toMatch(/Line \d+:\d+/);
    expect(sandboxCalls).toBe(0);
  });

  it("BLOCKS the save when the sandbox rejects the compiled JavaScript", async () => {
    const gate = await gateObjectScriptSave("function setup(context) {}\n", "Sheet Script", reject);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.detail).toContain("Unexpected token");
    expect(gate.detail).toContain("still in the editor");
  });
});

describe("the source-hash consent binding across an edit", () => {
  const accept = async () => ({ valid: true });

  it("does not lapse a grant when the script is re-saved unchanged", async () => {
    const js = "function setup(context) {\n  context.caps.fetch('https://example.com');\n}\n";
    const granted = await sha256Hex(js);
    const gate = await gateObjectScriptSave(js, "Sheet Script", accept);
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    // scriptSecurity.restorePersistedScriptCapabilityGrant compares exactly
    // this hash; a re-print here would drop the grant on every save.
    expect(await sha256Hex(gate.javascript)).toBe(granted);
  });

  it("does not lapse a grant when only TYPES change — types cannot change reach", async () => {
    const before = await gateObjectScriptSave(
      "function setup(context) {\n    context.caps.fetch('https://example.com');\n}\n",
      "Sheet Script",
      accept,
    );
    const after = await gateObjectScriptSave(
      "function setup(context: ObjectScriptContext): void {\n    context.caps.fetch('https://example.com');\n}\n",
      "Sheet Script",
      accept,
    );
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(await sha256Hex(after.javascript)).toBe(await sha256Hex(before.javascript));
  });

  it("DOES lapse a grant when the code's reach changes", async () => {
    const before = await gateObjectScriptSave(
      "function setup(context) {\n    context.log('hi');\n}\n",
      "Sheet Script",
      accept,
    );
    const after = await gateObjectScriptSave(
      "function setup(context: ObjectScriptContext) {\n    context.caps.fetch('https://evil.example');\n}\n",
      "Sheet Script",
      accept,
    );
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(await sha256Hex(after.javascript)).not.toBe(await sha256Hex(before.javascript));
  });

  it("hashes the text that RUNS: the stored artifact is the compiled output", async () => {
    const typescript = "function setup(context: ObjectScriptContext) {\n    context.log('hi');\n}\n";
    const gate = await gateObjectScriptSave(typescript, "Sheet Script", accept);
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    // The authored TypeScript is NOT what gets hashed, because it is not what
    // gets run. One artifact: what the worker imports, what the consent hash
    // covers and what the transparency panel shows are the same string.
    expect(await sha256Hex(gate.javascript)).not.toBe(await sha256Hex(typescript));
    expect(gate.javascript).not.toBe(typescript);
  });
});

describe("model naming", () => {
  it("names TypeScript models .ts and JavaScript models .js", () => {
    // Monaco's worker reads the script kind off the extension, so this is what
    // makes annotations legal — the `language` prop alone does not.
    expect(objectScriptModelPath("abc", "typescript")).toBe("objectScript/abc.ts");
    expect(objectScriptModelPath("abc", "javascript")).toBe("objectScript/abc.js");
    expect(objectScriptModelPath(null, "javascript")).toBe("objectScript/unsaved.js");
  });
});
