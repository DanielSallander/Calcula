//! FILENAME: app/extensions/_shared/lib/monacoScriptLanes.ts
// PURPOSE: ONE writer for Monaco's JavaScript/TypeScript language-service
//          configuration, shared by every script-authoring surface in the app.
// CONTEXT: Monaco has exactly two TypeScript language services per window —
//          `languages.typescript.javascriptDefaults` and `typescriptDefaults` —
//          and their diagnostics options, compiler options and extra libs are
//          GLOBAL. Three extensions were each configuring them at module load:
//
//            * ScriptableObjects  -> validation ON  (lib/monacoTypings.ts)
//            * ScriptNotebook     -> validation ON  (calcula.d.ts)
//            * CustomFunctions    -> validation OFF (noSemanticValidation:true,
//                                    noSyntaxValidation:true) because a custom
//                                    function BODY is a fragment with a
//                                    top-level `return`.
//
//          All three run at startup (the manifest imports every extension), so
//          which one won was module-load order. In practice CustomFunctions ran
//          last and switched validation OFF for everybody: object-script authors
//          got completions from a 110 KB generated .d.ts and not one diagnostic
//          from it. That is the bug behind "the editor cannot type-check the
//          language its own typings describe".
//
//          The fix is not "turn it back on" — that would drown custom-function
//          authors in false errors on their own fragment shape. It is to make
//          the configuration ADDITIVE and single-writer:
//
//            * every surface registers what IT needs (libs + the diagnostic
//              codes its text SHAPE makes meaningless),
//            * this module merges the registrations per lane and applies the
//              merged result,
//            * surfaces re-register when their editors mount, so the merged
//              configuration is what is live no matter which module loaded
//              first.
//
//          LANE SHARING IS A REAL CONSTRAINT, NOT A DETAIL. Everything on one
//          lane sees every lib and every suppression registered on that lane.
//          The split we chose:
//
//            javascript lane : object scripts (JavaScript mode), notebook cells,
//                              custom-function fragments. All are JavaScript at
//                              rest; JSDoc types work here and ONLY here (a .ts
//                              file ignores `@param {T}`), which is why the
//                              object-script editor stays on this lane by
//                              default.
//            typescript lane : object scripts in TypeScript mode, and nothing
//                              else — so a TypeScript author is not offered
//                              `cube.*` or `Calcula.*` globals that do not exist
//                              in a script worker.
//
//          The price of the javascript lane sharing is that the fragment
//          suppressions (top-level `return`) also apply to whole-file surfaces
//          there. That is safe: a top-level `return` in an object script is
//          caught at save by the transpile gate (scriptTranspile.ts) and by
//          hostValidateScript before anything is stored.

/** The two language services Monaco exposes. */
export type ScriptLane = "javascript" | "typescript";

/** The subset of a Monaco language-defaults object this module uses. */
export interface MonacoLanguageDefaults {
  addExtraLib(content: string, filePath?: string): { dispose(): void };
  setDiagnosticsOptions(options: Record<string, unknown>): void;
  setCompilerOptions(options: Record<string, unknown>): void;
  setEagerModelSync?(value: boolean): void;
}

/** The subset of `monaco.languages.typescript` this module uses. */
export interface MonacoTypescriptNamespace {
  javascriptDefaults: MonacoLanguageDefaults;
  typescriptDefaults: MonacoLanguageDefaults;
  // eslint-disable-next-line @typescript-eslint/naming-convention -- mirrors Monaco's own API surface; renaming would stop it matching the object we are handed
  ScriptTarget: { ESNext: number };
}

/** A diagnostic a surface suppresses, and WHY. The reason is not decoration:
 *  a suppression with no stated reason is indistinguishable from hiding a bug. */
export interface SuppressedDiagnostic {
  code: number;
  reason: string;
}

/** An ambient .d.ts a surface publishes, under the path Monaco files it as. */
export interface ScriptLibrary {
  /** The file path Monaco stores it under; re-registering the path replaces it. */
  path: string;
  content: string;
}

/** What one authoring surface contributes to a lane. */
export interface ScriptSurfaceRegistration {
  /** Which language service the surface's models live on. */
  lane: ScriptLane;
  /** Stable id of the surface. Re-registering the same id REPLACES its entry. */
  surface: string;
  /** Ambient .d.ts files the surface needs. */
  libs?: readonly ScriptLibrary[];
  /**
   * Diagnostics this surface must suppress because of the SHAPE of the text it
   * edits, each with the reason. Merged across the lane, so only add a code
   * that is genuinely meaningless for the shape — never to hide a real mistake.
   */
  ignoreDiagnosticCodes?: readonly SuppressedDiagnostic[];
}

/**
 * Codes suppressed on every lane, because every surface here edits a script
 * body rather than a module compiled by a bundler.
 */
export const BASE_IGNORED_DIAGNOSTIC_CODES: readonly SuppressedDiagnostic[] = [
  { code: 1375, reason: "'await' at the top level of a file is only allowed when that file is a module" },
  { code: 1378, reason: "Top-level 'await' expressions are only allowed when module is esnext/system" },
  { code: 80001, reason: "'File is a CommonJS module; it may be converted to an ES module' — a suggestion, not an error" },
];

/**
 * Compiler options shared by both lanes.
 *
 * `checkJs` is on so the TypeScript service acts as a CHECKER for JavaScript:
 * that is what makes a misspelled method a red squiggle instead of a failure
 * inside a sandboxed worker where the author would only see it in a console.
 *
 * `noImplicitAny` and `strictNullChecks` stay off: scaffolds are plain JS with
 * untyped parameters and turning them on would paint every scaffold red.
 *
 * `lib` is deliberately unset — Monaco falls back to the full default library,
 * and naming libs here with one wrong spelling would silently remove
 * Promise/console/Math from the editor's world.
 */
export const SCRIPT_LANE_COMPILER_OPTIONS: Readonly<Record<string, unknown>> = {
  allowJs: true,
  checkJs: true,
  allowNonTsExtensions: true,
  noEmit: true,
  noImplicitAny: false,
  strictNullChecks: false,
};

interface LaneState {
  surfaces: Map<string, ScriptSurfaceRegistration>;
  installedLibs: Map<string, { content: string; dispose(): void }>;
  lastApplied: { diagnostics: Record<string, unknown>; compilerOptions: Record<string, unknown> } | null;
}

const lanes = new Map<ScriptLane, LaneState>();

function laneState(lane: ScriptLane): LaneState {
  let state = lanes.get(lane);
  if (!state) {
    state = { surfaces: new Map(), installedLibs: new Map(), lastApplied: null };
    lanes.set(lane, state);
  }
  return state;
}

function defaultsFor(monacoTs: MonacoTypescriptNamespace, lane: ScriptLane): MonacoLanguageDefaults {
  return lane === "javascript" ? monacoTs.javascriptDefaults : monacoTs.typescriptDefaults;
}

/** The merged, ordered list of suppressed codes for a lane. */
export function mergedIgnoredCodes(lane: ScriptLane): number[] {
  const state = laneState(lane);
  const codes = new Set<number>(BASE_IGNORED_DIAGNOSTIC_CODES.map((d) => d.code));
  for (const reg of state.surfaces.values()) {
    for (const entry of reg.ignoreDiagnosticCodes ?? []) codes.add(entry.code);
  }
  return [...codes].sort((a, b) => a - b);
}

/** The merged lib set for a lane, keyed by file path. */
export function mergedLibs(lane: ScriptLane): Map<string, string> {
  const state = laneState(lane);
  const libs = new Map<string, string>();
  for (const reg of state.surfaces.values()) {
    for (const lib of reg.libs ?? []) libs.set(lib.path, lib.content);
  }
  return libs;
}

/**
 * Register (or re-register) a surface and apply the merged configuration for
 * its lane.
 *
 * Idempotent and cheap: Monaco's `addExtraLib` is a no-op when the path and
 * content are unchanged, so calling this on every editor mount costs nothing
 * and guarantees the merged configuration is the live one — whatever order the
 * extensions were imported in.
 */
export function registerScriptSurface(
  monacoTs: MonacoTypescriptNamespace,
  registration: ScriptSurfaceRegistration,
): void {
  const state = laneState(registration.lane);
  state.surfaces.set(registration.surface, registration);
  applyLane(monacoTs, registration.lane);
}

function applyLane(monacoTs: MonacoTypescriptNamespace, lane: ScriptLane): void {
  const state = laneState(lane);
  const defaults = defaultsFor(monacoTs, lane);

  const wanted = mergedLibs(lane);
  // Drop libs no surface asks for any more, so a removed lib cannot keep
  // completing names the runtime does not have.
  for (const [path, installed] of state.installedLibs) {
    if (!wanted.has(path)) {
      installed.dispose();
      state.installedLibs.delete(path);
    }
  }
  for (const [path, content] of wanted) {
    const installed = state.installedLibs.get(path);
    if (installed && installed.content === content) continue;
    installed?.dispose();
    const handle = defaults.addExtraLib(content, path);
    state.installedLibs.set(path, { content, dispose: handle.dispose.bind(handle) });
  }

  const diagnostics: Record<string, unknown> = {
    noSemanticValidation: false,
    noSyntaxValidation: false,
    diagnosticCodesToIgnore: mergedIgnoredCodes(lane),
  };
  const compilerOptions: Record<string, unknown> = {
    ...SCRIPT_LANE_COMPILER_OPTIONS,
    target: monacoTs.ScriptTarget.ESNext,
  };
  defaults.setDiagnosticsOptions(diagnostics);
  defaults.setCompilerOptions(compilerOptions);
  defaults.setEagerModelSync?.(true);
  state.lastApplied = { diagnostics, compilerOptions };
}

/** What was last pushed into Monaco for a lane. Test seam. */
export function lastAppliedLaneConfig(
  lane: ScriptLane,
): { diagnostics: Record<string, unknown>; compilerOptions: Record<string, unknown> } | null {
  return laneState(lane).lastApplied;
}

/** Test seam: forget every registration and installed lib. */
export function resetScriptLanesForTest(): void {
  for (const state of lanes.values()) {
    for (const installed of state.installedLibs.values()) installed.dispose();
  }
  lanes.clear();
}
