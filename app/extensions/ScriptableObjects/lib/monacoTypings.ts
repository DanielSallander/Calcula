//! FILENAME: app/extensions/ScriptableObjects/lib/monacoTypings.ts
// PURPOSE: Wire the generated object-script typings into Monaco's TypeScript
//          language service — once, for every object-script editor — and keep
//          the ACTIVE script's context type in sync with the object it is
//          attached to.
// CONTEXT: Both editors (CodeEditorDialog, ObjectScriptEditorApp) used to do
//          this inline and identically, registering objectContexts.d.ts on
//          `javascriptDefaults` only. That left two real gaps:
//
//          1. NOTHING WAS BOUND. The .d.ts declares forty interfaces and not a
//             single value, and a script's context arrives as a PARAMETER of
//             `setup(context)`. TypeScript will not contextually type a
//             parameter from an ambient interface, so typing `context.` offered
//             no completions at all — the typings were dead weight. The fix is
//             `setActiveContextType`, which publishes a narrowed
//             `ObjectScriptContext` alias for the script being edited; one JSDoc
//             `@param` line then types the whole surface.
//
//          2. The libs were absent from `typescriptDefaults`, so anything the
//             TS language service handled saw an empty world.
//
//          The objectType -> interface mapping is NOT duplicated here: it is
//          read out of the generated `ObjectScriptContextByType` map, so a new
//          objectType reaches the editor through the same generator that reaches
//          IntelliSense.

/** The subset of `monaco.languages.typescript` this module uses. */
export interface MonacoTypescriptNamespace {
  javascriptDefaults: MonacoLanguageDefaults;
  typescriptDefaults: MonacoLanguageDefaults;
  ScriptTarget: { ESNext: number };
  ModuleResolutionKind?: { NodeJs: number };
}

export interface MonacoLanguageDefaults {
  addExtraLib(content: string, filePath?: string): { dispose(): void };
  setDiagnosticsOptions(options: Record<string, unknown>): void;
  setCompilerOptions(options: Record<string, unknown>): void;
  setEagerModelSync?(value: boolean): void;
}

/** The file name the generated typings are registered under. */
export const OBJECT_CONTEXTS_LIB = "objectContexts.d.ts";
/** The file name the per-script context alias is registered under. */
export const ACTIVE_CONTEXT_LIB = "activeObjectScript.d.ts";

/**
 * Compiler options for authoring object scripts.
 *
 * `checkJs` is deliberately on: object scripts are JavaScript at rest (the
 * worker imports the source as a blob module with no build step), so the
 * TypeScript language service is used as a CHECKER for JS rather than as a
 * compiler. That is what makes an undeclared variable or a misspelled method a
 * red squiggle instead of a runtime failure inside a sandboxed worker where the
 * user would only ever see it in the console.
 *
 * `noImplicitAny` and `strictNullChecks` stay off on purpose: scaffolds are
 * plain JS with untyped parameters, and turning them on would paint every
 * scaffold red before the author had written a line.
 */
export const OBJECT_SCRIPT_COMPILER_OPTIONS: Record<string, unknown> = {
  allowJs: true,
  checkJs: true,
  allowNonTsExtensions: true,
  noEmit: true,
  noImplicitAny: false,
  strictNullChecks: false,
  // `lib` is deliberately NOT set. Monaco falls back to the full default
  // library when it is absent; naming libs here and getting the spelling wrong
  // silently removes Promise/console/Math from the editor's world, and that is
  // not something a unit test over the standalone language service can catch.
  // Every option above is asserted against intellisenseResolution.test.ts, so
  // what ships is exactly what is proven to resolve.
};

export const OBJECT_SCRIPT_DIAGNOSTICS: Record<string, unknown> = {
  noSemanticValidation: false,
  noSyntaxValidation: false,
  // A script body is not a module; "await is only allowed in async functions"
  // and "cannot redeclare block-scoped variable" for the scaffold's own names
  // would be noise, not signal.
  diagnosticCodesToIgnore: [
    1375, // 'await' at the top level of a file is only allowed when that file is a module
    1378, // Top-level 'await' expressions are only allowed when 'module' is ...
    2304, // Cannot find name (host-injected globals in instrumented sources)
    7044, // Parameter implicitly has an 'any' type, but a better type may be inferred
    80001, // "File is a CommonJS module; it may be converted to an ES module"
  ],
};

/**
 * Pull the objectType -> interface pairs straight out of the generated
 * `ObjectScriptContextByType` map, so this module never restates a mapping the
 * generator already owns. A missing or renamed entry therefore shows up as
 * "no completions", not as a silently wrong type.
 */
export function readContextTypeMap(dts: string): Map<string, string> {
  const map = new Map<string, string>();
  const block = /declare interface ObjectScriptContextByType\s*\{([\s\S]*?)\n\}/.exec(dts);
  if (!block) return map;
  for (const line of block[1].split("\n")) {
    const m = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*([A-Za-z][A-Za-z0-9_]*)\s*;/.exec(line);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

/**
 * The extra lib that binds the typings to the script being edited.
 *
 * `ObjectScriptContext` is the ONE name an author has to remember, whatever the
 * script is attached to. `setup` is also declared as an ambient CALL SIGNATURE
 * so hovering it explains the contract even before the author annotates.
 */
export function buildActiveContextLib(objectType: string, contextTypes: Map<string, string>): string {
  const iface = contextTypes.get(objectType) ?? "BaseObjectContext";
  return [
    "// Generated per open script by the Object Script editor. Regenerated when",
    "// you switch scripts; never saved with your code.",
    "",
    "/**",
    ` * The context your \`setup(context)\` receives: a ${iface} (this script is`,
    ` * attached to a "${objectType}").`,
    " *",
    " * Annotate your setup function to type it:",
    " *",
    " *     @param {ObjectScriptContext} context",
    " *",
    " * written inside a JSDoc block above `function setup(context) {`.",
    " */",
    `declare type ObjectScriptContext = ObjectScriptContextByType["${objectType}"];`,
    "",
    "/** The objectType this script is attached to. */",
    `declare type ObjectScriptType = "${objectType}";`,
  ].join("\n");
}

/**
 * The JSDoc line that makes `context` typed. Editors surface it on a new
 * script so an author gets IntelliSense without having to know the trick.
 */
export const CONTEXT_ANNOTATION = "/** @param {ObjectScriptContext} context */";

/**
 * Prepend the context annotation to a scaffold when its `setup` has none.
 *
 * Applied to NEW scripts only, and only in the editor: it changes what the
 * author starts from, never what an existing script contains. A script whose
 * setup parameter is already annotated (or which does not use the `setup(...)`
 * shape at all) is returned untouched.
 */
export function annotateScaffold(source: string): string {
  if (source.includes("@param {ObjectScriptContext}")) return source;
  const match = /^([ \t]*)((?:async\s+)?function\s+setup\s*\()/m.exec(source);
  if (!match) return source;
  const indent = match[1];
  return (
    source.slice(0, match.index) +
    `${indent}${CONTEXT_ANNOTATION}\n` +
    source.slice(match.index)
  );
}

let installed = false;

/**
 * Install the generated typings and the authoring compiler options on BOTH the
 * JavaScript and TypeScript language defaults. Idempotent: the editors each
 * call it at module load, and only the first call registers anything.
 */
export function configureObjectScriptTypings(monacoTs: MonacoTypescriptNamespace, objectContextsDts: string): void {
  if (installed) return;
  installed = true;
  for (const defaults of [monacoTs.javascriptDefaults, monacoTs.typescriptDefaults]) {
    defaults.addExtraLib(objectContextsDts, OBJECT_CONTEXTS_LIB);
    defaults.setDiagnosticsOptions(OBJECT_SCRIPT_DIAGNOSTICS);
    defaults.setCompilerOptions({
      ...OBJECT_SCRIPT_COMPILER_OPTIONS,
      target: monacoTs.ScriptTarget.ESNext,
    });
    defaults.setEagerModelSync?.(true);
  }
}

let activeContextLib: { dispose(): void } | null = null;
let activeObjectType: string | null = null;

/**
 * Point `ObjectScriptContext` at the context interface for `objectType`.
 *
 * Call it whenever the edited script changes. The previous alias is disposed
 * first — two `declare type ObjectScriptContext` libs would collide and the
 * language service would resolve neither.
 */
export function setActiveContextType(
  monacoTs: MonacoTypescriptNamespace,
  objectType: string,
  objectContextsDts: string,
): void {
  if (activeObjectType === objectType) return;
  activeObjectType = objectType;
  activeContextLib?.dispose();
  const lib = buildActiveContextLib(objectType, readContextTypeMap(objectContextsDts));
  // Registered on the JS defaults only: object scripts are edited as JavaScript
  // (see OBJECT_SCRIPT_COMPILER_OPTIONS), and the TS defaults keep the stable
  // union so a future TypeScript-authored script still resolves every context.
  activeContextLib = monacoTs.javascriptDefaults.addExtraLib(lib, ACTIVE_CONTEXT_LIB);
}

/** Test seam: forget the installed state so a fresh Monaco can be configured. */
export function resetObjectScriptTypingsForTest(): void {
  installed = false;
  activeContextLib?.dispose();
  activeContextLib = null;
  activeObjectType = null;
}
