// PURPOSE: Regression test for the bug that made the generated object-script
//          typings decorative — one extension turning Monaco's diagnostics OFF
//          for every other extension — and for the lane isolation the notebook
//          and object-script surfaces now rely on.
// CONTEXT: Monaco's `javascriptDefaults` / `typescriptDefaults` are global and
//          last-writer-wins. Three extensions configured them at import time, so
//          which settings were live depended on module load order — something no
//          test could observe and no author could explain. This file pins the
//          merged behaviour instead.

import { describe, it, expect, beforeEach } from "vitest";
import {
  registerScriptSurface,
  mergedIgnoredCodes,
  mergedLibs,
  lastAppliedLaneConfig,
  resetScriptLanesForTest,
  BASE_IGNORED_DIAGNOSTIC_CODES,
  type MonacoTypescriptNamespace,
} from "../monacoScriptLanes";

interface FakeDefaults {
  libs: Map<string, string>;
  diagnostics: Record<string, unknown> | null;
  compilerOptions: Record<string, unknown> | null;
  addExtraLibCalls: number;
  addExtraLib(content: string, filePath?: string): { dispose(): void };
  setDiagnosticsOptions(options: Record<string, unknown>): void;
  setCompilerOptions(options: Record<string, unknown>): void;
}

function makeDefaults(): FakeDefaults {
  const self: FakeDefaults = {
    libs: new Map(),
    diagnostics: null,
    compilerOptions: null,
    addExtraLibCalls: 0,
    addExtraLib(content: string, filePath?: string) {
      self.addExtraLibCalls += 1;
      const path = filePath ?? `anonymous-${self.addExtraLibCalls}`;
      self.libs.set(path, content);
      return { dispose: () => { self.libs.delete(path); } };
    },
    setDiagnosticsOptions(options) {
      self.diagnostics = options;
    },
    setCompilerOptions(options) {
      self.compilerOptions = options;
    },
  };
  return self;
}

let js: FakeDefaults;
let ts: FakeDefaults;
let monacoTs: MonacoTypescriptNamespace;

beforeEach(() => {
  resetScriptLanesForTest();
  js = makeDefaults();
  ts = makeDefaults();
  monacoTs = {
    javascriptDefaults: js,
    typescriptDefaults: ts,
    // eslint-disable-next-line @typescript-eslint/naming-convention -- mirrors Monaco's own API surface
    ScriptTarget: { ESNext: 99 },
  };
});

/** The custom-function editor: a fragment, so top-level `return` is legal. */
function registerCustomFunctions(): void {
  registerScriptSurface(monacoTs, {
    lane: "javascript",
    surface: "customFunctions",
    libs: [{ path: "calcula-cube.d.ts", content: "declare const cube: { value(): number };" }],
    ignoreDiagnosticCodes: [
      { code: 1108, reason: "return outside a function — this IS a function body" },
    ],
  });
}

/** The object-script editor: a whole module. */
function registerObjectScripts(): void {
  registerScriptSurface(monacoTs, {
    lane: "javascript",
    surface: "objectScripts",
    libs: [
      { path: "objectContexts.d.ts", content: "declare interface BaseObjectContext { log(m: string): void }" },
    ],
    ignoreDiagnosticCodes: [{ code: 2304, reason: "host-injected globals" }],
  });
}

describe("one surface can no longer switch diagnostics off for the others", () => {
  it("keeps validation ON no matter which surface registers last", () => {
    registerObjectScripts();
    registerCustomFunctions();
    // THE REGRESSION: CustomFunctions used to call setDiagnosticsOptions with
    // noSemanticValidation/noSyntaxValidation true, which silenced the object
    // script editor's 110 KB of generated typings.
    expect(js.diagnostics).toMatchObject({ noSemanticValidation: false, noSyntaxValidation: false });

    resetScriptLanesForTest();
    registerCustomFunctions();
    registerObjectScripts();
    expect(js.diagnostics).toMatchObject({ noSemanticValidation: false, noSyntaxValidation: false });
  });

  it("merges the shape-specific suppressions instead of replacing them", () => {
    registerObjectScripts();
    registerCustomFunctions();
    const codes = mergedIgnoredCodes("javascript");
    expect(codes).toContain(1108); // fragment: top-level return
    expect(codes).toContain(2304); // object scripts: host-injected globals
    for (const base of BASE_IGNORED_DIAGNOSTIC_CODES) {
      expect(codes).toContain(base.code);
    }
    expect(js.diagnostics?.diagnosticCodesToIgnore).toEqual(codes);
  });

  it("re-registering the same surface does not accumulate duplicates", () => {
    registerObjectScripts();
    registerObjectScripts();
    registerObjectScripts();
    expect(mergedLibs("javascript").size).toBe(1);
    // Same path + same content: installed once, not three times.
    expect(js.addExtraLibCalls).toBe(1);
  });
});

describe("the lanes are isolated", () => {
  it("does not leak the object-script typings into the TypeScript lane by accident", () => {
    registerObjectScripts();
    expect(mergedLibs("javascript").has("objectContexts.d.ts")).toBe(true);
    expect(mergedLibs("typescript").size).toBe(0);
    expect(ts.libs.size).toBe(0);
    expect(lastAppliedLaneConfig("typescript")).toBeNull();
  });

  it("configures each lane independently when both are used", () => {
    registerObjectScripts();
    registerScriptSurface(monacoTs, {
      lane: "typescript",
      surface: "objectScripts",
      libs: [
        { path: "objectContexts.d.ts", content: "declare interface BaseObjectContext { log(m: string): void }" },
        { path: "activeObjectScript.d.ts", content: "declare type ObjectScriptContext = BaseObjectContext;" },
      ],
    });
    expect(ts.libs.size).toBe(2);
    expect(js.libs.size).toBe(1);
    expect(ts.compilerOptions).toMatchObject({ allowJs: true, checkJs: true, target: 99 });
  });

  it("replaces a lib when its content changes and drops it when it goes away", () => {
    registerScriptSurface(monacoTs, {
      lane: "typescript",
      surface: "objectScripts",
      libs: [{ path: "activeObjectScript.d.ts", content: "declare type ObjectScriptContext = SheetContext;" }],
    });
    expect(ts.libs.get("activeObjectScript.d.ts")).toContain("SheetContext");

    // Switching scripts republishes the alias — two live aliases would make the
    // language service resolve neither.
    registerScriptSurface(monacoTs, {
      lane: "typescript",
      surface: "objectScripts",
      libs: [{ path: "activeObjectScript.d.ts", content: "declare type ObjectScriptContext = SlicerContext;" }],
    });
    expect(ts.libs.size).toBe(1);
    expect(ts.libs.get("activeObjectScript.d.ts")).toContain("SlicerContext");

    registerScriptSurface(monacoTs, { lane: "typescript", surface: "objectScripts", libs: [] });
    expect(ts.libs.size).toBe(0);
  });
});
