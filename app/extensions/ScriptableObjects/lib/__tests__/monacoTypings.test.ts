// PURPOSE: Prove the generated typings are actually REACHABLE from the editor —
//          registered on both language services, and bound to the open script's
//          context type. Unit-level evidence for "IntelliSense shows the new
//          surface", since the real Monaco cannot be driven in jsdom.
// CONTEXT: The bug this guards is subtle and was live: objectContexts.d.ts
//          declared forty interfaces and zero values, and a script's context is
//          a PARAMETER of setup(context), so nothing ever resolved. Registering
//          the lib is necessary and was NOT sufficient.

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  configureObjectScriptTypings,
  setActiveContextType,
  resetObjectScriptTypingsForTest,
  readContextTypeMap,
  buildActiveContextLib,
  annotateScaffold,
  OBJECT_CONTEXTS_LIB,
  ACTIVE_CONTEXT_LIB,
  CONTEXT_ANNOTATION,
  type MonacoTypescriptNamespace,
  type MonacoLanguageDefaults,
} from "../monacoTypings";

const DTS = fs.readFileSync(path.resolve(__dirname, "../../objectContexts.d.ts"), "utf8");

interface RecordedLib {
  content: string;
  filePath?: string;
  disposed: boolean;
}

function makeDefaults(): MonacoLanguageDefaults & {
  libs: RecordedLib[];
  compilerOptions: Record<string, unknown> | null;
  diagnostics: Record<string, unknown> | null;
  eager: boolean;
} {
  const libs: RecordedLib[] = [];
  const state = {
    libs,
    compilerOptions: null as Record<string, unknown> | null,
    diagnostics: null as Record<string, unknown> | null,
    eager: false,
    addExtraLib(content: string, filePath?: string) {
      const entry: RecordedLib = { content, filePath, disposed: false };
      libs.push(entry);
      return {
        dispose() {
          entry.disposed = true;
        },
      };
    },
    setCompilerOptions(options: Record<string, unknown>) {
      state.compilerOptions = options;
    },
    setDiagnosticsOptions(options: Record<string, unknown>) {
      state.diagnostics = options;
    },
    setEagerModelSync(value: boolean) {
      state.eager = value;
    },
  };
  return state;
}

function makeMonaco() {
  const javascriptDefaults = makeDefaults();
  const typescriptDefaults = makeDefaults();
  const ns: MonacoTypescriptNamespace = {
    javascriptDefaults,
    typescriptDefaults,
    ScriptTarget: { ESNext: 99 },
  };
  return { ns, javascriptDefaults, typescriptDefaults };
}

describe("configureObjectScriptTypings", () => {
  beforeEach(() => resetObjectScriptTypingsForTest());

  it("registers the generated typings on BOTH language services", () => {
    const { ns, javascriptDefaults, typescriptDefaults } = makeMonaco();
    configureObjectScriptTypings(ns, DTS);
    for (const defaults of [javascriptDefaults, typescriptDefaults]) {
      const lib = defaults.libs.find((l) => l.filePath === OBJECT_CONTEXTS_LIB);
      expect(lib, "objectContexts.d.ts was not registered").toBeTruthy();
      expect(lib!.content).toContain("declare interface ScriptCapabilities");
    }
  });

  it("enables semantic checking of JavaScript (the checker is the whole point)", () => {
    const { ns, javascriptDefaults } = makeMonaco();
    configureObjectScriptTypings(ns, DTS);
    expect(javascriptDefaults.compilerOptions).toMatchObject({ allowJs: true, checkJs: true, target: 99 });
    expect(javascriptDefaults.diagnostics).toMatchObject({
      noSemanticValidation: false,
      noSyntaxValidation: false,
    });
    expect(javascriptDefaults.eager).toBe(true);
  });

  it("is idempotent — two editors can both call it", () => {
    const { ns, javascriptDefaults } = makeMonaco();
    configureObjectScriptTypings(ns, DTS);
    configureObjectScriptTypings(ns, DTS);
    expect(javascriptDefaults.libs.filter((l) => l.filePath === OBJECT_CONTEXTS_LIB)).toHaveLength(1);
  });
});

describe("setActiveContextType", () => {
  beforeEach(() => resetObjectScriptTypingsForTest());

  it("binds ObjectScriptContext to the edited script's own context interface", () => {
    const { ns, javascriptDefaults } = makeMonaco();
    configureObjectScriptTypings(ns, DTS);
    setActiveContextType(ns, "slicer", DTS);
    const lib = javascriptDefaults.libs.find((l) => l.filePath === ACTIVE_CONTEXT_LIB);
    expect(lib).toBeTruthy();
    expect(lib!.content).toContain('declare type ObjectScriptContext = ObjectScriptContextByType["slicer"];');
    expect(lib!.content).toContain("SlicerContext");
  });

  it("disposes the previous alias so two aliases never collide", () => {
    const { ns, javascriptDefaults } = makeMonaco();
    configureObjectScriptTypings(ns, DTS);
    setActiveContextType(ns, "slicer", DTS);
    setActiveContextType(ns, "pivot", DTS);
    const aliases = javascriptDefaults.libs.filter((l) => l.filePath === ACTIVE_CONTEXT_LIB);
    expect(aliases).toHaveLength(2);
    expect(aliases[0].disposed).toBe(true);
    expect(aliases[1].disposed).toBe(false);
    expect(aliases[1].content).toContain("PivotContext");
  });

  it("does no work when the objectType has not changed", () => {
    const { ns, javascriptDefaults } = makeMonaco();
    configureObjectScriptTypings(ns, DTS);
    setActiveContextType(ns, "chart", DTS);
    setActiveContextType(ns, "chart", DTS);
    expect(javascriptDefaults.libs.filter((l) => l.filePath === ACTIVE_CONTEXT_LIB)).toHaveLength(1);
  });
});

describe("readContextTypeMap", () => {
  it("reads the objectType -> interface map out of the GENERATED file", () => {
    // No mapping is restated in the editor; it comes from the generator, so a
    // new objectType reaches IntelliSense and the editor by the same route.
    const map = readContextTypeMap(DTS);
    expect(map.size).toBeGreaterThanOrEqual(16);
    expect(map.get("workbook")).toBe("WorkbookContext");
    expect(map.get("range")).toBe("RangeContext");
    expect(map.get("chartMark")).toBe("ChartMarkContext");
    expect(map.get("textbox")).toBe("BaseObjectContext");
  });

  it("every mapped interface is actually declared in the typings", () => {
    for (const iface of readContextTypeMap(DTS).values()) {
      expect(DTS, `${iface} is mapped but never declared`).toContain(`declare interface ${iface} `);
    }
  });

  it("falls back to the base context for an unknown objectType", () => {
    const lib = buildActiveContextLib("somethingNew", readContextTypeMap(DTS));
    expect(lib).toContain("BaseObjectContext");
  });
});

describe("annotateScaffold", () => {
  it("adds the annotation that makes `context.` complete", () => {
    const out = annotateScaffold("// Slicer Script\n\nfunction setup(slicer) {\n}\n");
    expect(out).toContain(CONTEXT_ANNOTATION);
    expect(out.indexOf(CONTEXT_ANNOTATION)).toBeLessThan(out.indexOf("function setup"));
  });

  it("handles an async setup and preserves indentation", () => {
    const out = annotateScaffold("  async function setup(ctx) {}\n");
    expect(out).toBe("  /** @param {ObjectScriptContext} context */\n  async function setup(ctx) {}\n");
  });

  it("never annotates twice", () => {
    const once = annotateScaffold("function setup(c) {}\n");
    expect(annotateScaffold(once)).toBe(once);
  });

  it("leaves a script with no setup(...) shape alone", () => {
    const src = "context.log('hello');\n";
    expect(annotateScaffold(src)).toBe(src);
  });
});
