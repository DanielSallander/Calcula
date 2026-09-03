//! FILENAME: app/extensions/_shared/lib/buttonScriptRun.ts
// PURPOSE: THE ONE RULE for turning a button click into a program the workbook
//          script runtime will execute — shared by the three button surfaces
//          (in-cell Controls buttons, floating Controls buttons, and the
//          `calcula.button` cell type) so the rule exists once instead of three
//          times.
//
// WHY THIS FILE EXISTS
//
// All three surfaces used to build the program by TEXTUAL SPLICING: fan out over
// every module script in the workbook, wrap each one as
// `function Name() {\n<source>\n}`, join them into a preamble, and append the
// button's inline code. `listWorkbookScripts()` hides only `__calcula_`-prefixed
// reserved ids, so MODULES THAT ARRIVED IN A .calp WERE IN THAT PREAMBLE. Two
// things followed, both severe:
//
//  1. CONSENT WAS BYPASSED. The authoritative gate for distributed module code
//     is Rust-side: `require_distributed_module_consent` /
//     `distributed_module_refusal` (app/src-tauri/src/scripting/commands.rs).
//     It decides by EXACT SOURCE EQUALITY against the stored script records —
//     if the source being run is a stored record stamped with a `source_package`
//     and the user has not consented to that package, the run is refused. A
//     CONCATENATED program equals no stored record, so `owners` came back empty,
//     the gate read it as "an ad-hoc/editor run" and returned allow. That gate's
//     own doc comment names these very button paths as the thing it exists to
//     protect; the splice walked around it.
//
//  2. IT WAS A CODE INJECTION. The splice is textual, so a module body that
//     closes the wrapper early —
//
//         } doSomething(); function __pad() {
//
//     — produces `function Mod() {\n} doSomething(); function __pad() {\n}`,
//     which parses with `doSomething()` at TOP LEVEL. Every click on ANY button
//     in the workbook then ran it, including buttons the user built themselves
//     whose inline action never mentions the module. (The floating-button copy
//     did have a per-module validation step, but it compiled the ALREADY-WRAPPED
//     text — and the wrapped text above is perfectly valid JavaScript, so the
//     check passed the escape it was meant to stop. Verified: `new
//     Function("function Mod() {\n} evil(); function __pad() {\n}")` throws
//     nothing.)
//
// THE RULE THIS FILE ENFORCES, in one sentence:
//
//     Code that arrived in an application is NEVER composed with other code. It
//     either runs as its own stored source, unchanged — so the Rust consent gate
//     sees exactly what it is being asked to approve and can refuse it — or it
//     does not run at all.
//
// WHAT SURVIVES, DELIBERATELY. Deleting the feature was not an option:
//
//  * A USER-AUTHORED button calling a USER-AUTHORED module behaves exactly as it
//    did. Local modules are still wrapped as callable functions and prepended,
//    so `MyMacro()`, `if (x) MyMacro()` and any other inline code keep working.
//  * A DISTRIBUTED report's own button calling its own module keeps working once
//    the user has consented to that application — through `singleModuleCallName`
//    below. `PublisherMacro()` (exactly the text the Properties Pane's
//    autocomplete inserts) is recognised as an INVOCATION rather than as code to
//    splice, and the module's stored source is run VERBATIM. The gate then rules
//    on it: consented -> it runs; not consented -> it is refused by name.
//  * Anything else that mentions a distributed module gets an honest refusal
//    naming the module, the application, and the one form that can be approved —
//    never a silent no-op and never a silent execution.
//
// DEFENCE IN DEPTH. Local modules are the user's own code, but they are STILL
// validated as self-contained function bodies before being wrapped, so no module
// body that arrived in an application is never composed at all — see the
// note on the escape check below.

import {
  isLocalOrigin,
  originPackageName,
  scriptOriginForStoredRecord,
} from "@api/scriptHost/scriptOrigin";

// ============================================================================
// The record a button surface hands in
// ============================================================================

/**
 * One stored module script, as the button surfaces see it.
 *
 * `sourcePackage` is the field `core/calp/src/pull.rs` stamps on every module it
 * materializes out of a `.calp`; it is the ONLY authority on whether the code is
 * the user's or a publisher's, and it is read here through
 * `scriptOriginForStoredRecord` so this file cannot invent a second derivation.
 */
export interface ButtonScriptModule {
  id: string;
  name: string;
  /** Empty string when `loadError` is set — never a lie about what it holds. */
  source: string;
  sourcePackage?: string | null;
  /** Why the record could not be READ, when it could not. */
  loadError?: string | null;
}

/** A module a button cannot call, and the reason a user can act on. */
export interface UnavailableModule {
  id: string;
  name: string;
  reason: "distributed" | "unreadable";
  /** A full sentence for the user: what is unavailable, why, and the remedy. */
  message: string;
}

/**
 * What a click should actually run.
 *
 * `module` is non-null exactly when the plan runs ONE stored module's source
 * unchanged — the only shape the Rust consent gate can render a verdict on.
 */
export type ButtonScriptPlan =
  | {
      kind: "run";
      source: string;
      filename: string;
      module: ButtonScriptModule | null;
      unavailable: UnavailableModule[];
    }
  | { kind: "refuse"; message: string };

// ============================================================================
// Identifiers
// ============================================================================

/**
 * Sanitize a script module name into a valid JavaScript identifier.
 *
 * Must stay identical to the Properties Pane's copy
 * (Controls/PropertiesPane/CodePropertyInput.tsx), which is what generates the
 * `Name()` text a user's inline action contains — the two are the write and read
 * halves of one convention.
 */
export function sanitizeScriptName(name: string): string {
  let sanitized = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (sanitized && /^[0-9]/.test(sanitized)) {
    sanitized = "_" + sanitized;
  }
  return sanitized || "_unnamed";
}

/** A bare, complete, zero-argument call and nothing else: `Name()` / `Name();`. */
const SINGLE_CALL_RE = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(\s*\)\s*;?\s*$/;

/** Every identifier-shaped token in a snippet, for "did the user mention X?". */
const IDENTIFIER_TOKEN_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** A single JavaScript identifier and nothing else. */
const BARE_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The module name an inline action INVOKES, when that is all it does.
 *
 * This is the pivot the distributed path turns on, so it is deliberately narrow:
 * the whole snippet must be one zero-argument call. Anything else — an argument,
 * a second statement, a condition, a member expression — is code, not an
 * invocation, and is treated as code.
 */
export function singleModuleCallName(inlineSource: string): string | null {
  const match = SINGLE_CALL_RE.exec(inlineSource);
  return match ? match[1] : null;
}

/** The identifier-shaped tokens appearing in an inline action. */
function referencedIdentifiers(inlineSource: string): Set<string> {
  return new Set(inlineSource.match(IDENTIFIER_TOKEN_RE) ?? []);
}

// ============================================================================
// Why there is no escape check here any more
// ============================================================================

// THE ESCAPE CHECK IS GONE, AND ITS ABSENCE IS THE POINT.
//
// A first version of this module validated each body with `new Function(body)`,
// used as a parser, so that a body closing its own wrapper early —
// `} evil(); function __pad() {` — would be rejected rather than landing its
// payload at top level. That check was both UNNECESSARY and BROKEN:
//
//   BROKEN. The application ships a content-security policy with no
//   'unsafe-eval' (`app/src-tauri/tauri.conf.json`: `script-src 'self' blob:`),
//   so the Function constructor THROWS in the real app. Every module would have
//   been read as "not a function body" and silently dropped from every button
//   click. It passed its tests because jsdom enforces no CSP — the environment
//   gap this codebase has been bitten by before.
//
//   UNNECESSARY. The escape only ever mattered for code the user did not write.
//   A module that arrived in a distributed application is no longer composed
//   into anything: it is excluded from the preamble entirely and can run only
//   as its published source, through the consent gate (`isDistributedModule`
//   and the delegation below). What remains in the preamble is the user's OWN
//   modules in their OWN workbook, and a body of theirs that escapes its
//   wrapper is their own code doing what they wrote — the same thing the
//   preamble did before any of this work, not a boundary being crossed.
//
// So the security property rests on EXCLUSION, which a policy cannot switch
// off, rather than on a parse that the policy forbids.

/** The wrapper. Only ever called on a LOCAL module's source (see above). */
function wrapAsFunction(fnName: string, source: string): string {
  return `function ${fnName}() {\n${source}\n}`;
}

// ============================================================================
// Provenance
// ============================================================================

/** True when the module arrived inside a distributed application. */
export function isDistributedModule(module: ButtonScriptModule): boolean {
  return !isLocalOrigin(
    scriptOriginForStoredRecord({ sourcePackage: module.sourcePackage ?? null }),
  );
}

/** The application a module arrived in, or null for the user's own code. */
export function moduleApplicationName(module: ButtonScriptModule): string | null {
  return originPackageName(
    scriptOriginForStoredRecord({ sourcePackage: module.sourcePackage ?? null }),
  );
}

function distributedUnavailable(module: ButtonScriptModule): UnavailableModule {
  const app = moduleApplicationName(module) ?? "an application";
  const fnName = sanitizeScriptName(module.name);
  return {
    id: module.id,
    name: module.name,
    reason: "distributed",
    message:
      `The script module "${module.name}" arrived in the application "${app}", ` +
      "so this button cannot mix it into other code — that would run a " +
      `publisher's code without your approval, and \`${fnName}()\` is therefore ` +
      "not defined here. A button can run it only as the published module " +
      `itself: set the button's action to exactly "${fnName}()".`,
  };
}

// ============================================================================
// The preamble (local modules ONLY)
// ============================================================================

/**
 * Wrap the workbook's LOCAL module scripts as callable functions.
 *
 * Distributed modules are not merely skipped — they are never seen by this
 * function, because its caller partitions first. Two independent consequences
 * both matter: a publisher's module cannot run because an unrelated button was
 * clicked, and a publisher's module cannot shadow one of the user's own by
 * choosing a colliding name (later declaration wins in the composed program).
 */
export function buildLocalPreamble(localModules: ButtonScriptModule[]): {
  preamble: string;
  unavailable: UnavailableModule[];
} {
  const parts: string[] = [];
  const unavailable: UnavailableModule[] = [];

  for (const module of localModules) {
    if (module.loadError) {
      unavailable.push({
        id: module.id,
        name: module.name,
        reason: "unreadable",
        message:
          `The script module "${module.name}" could not be read ` +
          `(${module.loadError}), so buttons cannot call it.`,
      });
      continue;
    }
    if (!module.source) continue;

    parts.push(wrapAsFunction(sanitizeScriptName(module.name), module.source));
  }

  return {
    preamble: parts.length > 0 ? parts.join("\n") + "\n" : "",
    unavailable,
  };
}

// ============================================================================
// The two planners
// ============================================================================

/**
 * Plan the run for a button whose action is INLINE CODE (the `onSelect`
 * property of a Controls button).
 *
 * Order matters, and local wins: a bare `Name()` is only treated as a
 * distributed invocation when no LOCAL module answers to that name, so a
 * user-authored button calling a user-authored module takes exactly the path it
 * always took.
 */
export function planInlineButtonRun(
  inlineSource: string,
  modules: ButtonScriptModule[],
): ButtonScriptPlan {
  const local: ButtonScriptModule[] = [];
  const distributed: ButtonScriptModule[] = [];
  for (const module of modules) {
    (isDistributedModule(module) ? distributed : local).push(module);
  }

  // 1. An invocation of a DISTRIBUTED module runs that module's stored source
  //    VERBATIM, which is the only shape the Rust consent gate can rule on.
  const called = singleModuleCallName(inlineSource);
  if (called !== null && !local.some((m) => sanitizeScriptName(m.name) === called)) {
    const target = distributed.find((m) => sanitizeScriptName(m.name) === called);
    if (target) {
      if (target.loadError) {
        return {
          kind: "refuse",
          message:
            `This button runs the script module "${target.name}" from the ` +
            `application "${moduleApplicationName(target) ?? "an application"}", ` +
            `but that module could not be read (${target.loadError}).`,
        };
      }
      return {
        kind: "run",
        source: target.source,
        filename: `button_module_${target.id}.js`,
        module: target,
        unavailable: [],
      };
    }
  }

  // 2. Anything else is the user's own inline code, with the user's own modules
  //    available as functions — and nothing else.
  const { preamble, unavailable } = buildLocalPreamble(local);
  const referenced = referencedIdentifiers(inlineSource);
  for (const module of distributed) {
    if (referenced.has(sanitizeScriptName(module.name))) {
      unavailable.push(distributedUnavailable(module));
    }
  }

  return {
    kind: "run",
    source: preamble + inlineSource,
    filename: "button_onSelect.js",
    module: null,
    unavailable,
  };
}

/**
 * Plan the run for a button bound to ONE stored module by id (the
 * `calcula.button` cell type's `{ kind: "script", scriptId, functionName? }`).
 *
 * With no `functionName` the module's stored source runs unchanged — the gate
 * sees it and rules on it. With one, the call has to be APPENDED, which is a
 * composition; that is allowed for the user's own code and refused for a
 * publisher's, by the rule at the top of this file.
 */
export function planStoredModuleRun(
  module: ButtonScriptModule,
  functionName?: string | null,
): ButtonScriptPlan {
  if (module.loadError) {
    return {
      kind: "refuse",
      message: `The button's script module could not be read (${module.loadError}).`,
    };
  }
  if (!module.source) {
    return { kind: "refuse", message: "Button script not found in this workbook" };
  }

  const fn = typeof functionName === "string" ? functionName.trim() : "";
  const filename = `button_${module.name || "script"}.js`;

  if (fn === "") {
    return {
      kind: "run",
      source: module.source,
      filename,
      module,
      unavailable: [],
    };
  }

  // A free-text field, and the button's params can themselves have arrived in a
  // .calp — so it is an IDENTIFIER or it is nothing. Without this,
  // `functionName: "x(); stealTheWorkbook()"` would append arbitrary code to the
  // user's own module.
  if (!BARE_IDENTIFIER_RE.test(fn)) {
    return {
      kind: "refuse",
      message:
        `"${fn}" is not a function name, so this button will not run. The ` +
        '"Function to call" field takes a single name, e.g. RunReport.',
    };
  }

  if (isDistributedModule(module)) {
    const app = moduleApplicationName(module) ?? "an application";
    return {
      kind: "refuse",
      message:
        `This button asks to call ${fn}() inside "${module.name}", which arrived ` +
        `in the application "${app}". Code from an application runs only as its ` +
        "published module, unchanged — adding a call to it is code you have not " +
        'approved. Clear the button\'s "Function to call" field to run the module ' +
        "as published.",
    };
  }

  return {
    kind: "run",
    source: `${module.source}\n${fn}();`,
    filename,
    module: null,
    unavailable: [],
  };
}

// ============================================================================
// Loading
// ============================================================================

/**
 * Every module script in the workbook, with its provenance, for the planners.
 *
 * Dynamic so this module's static import graph stays the single leaf
 * `@api/scriptHost/scriptOrigin` — the planners above are pure and unit-testable
 * without a backend.
 */
export async function loadButtonScriptModules(): Promise<ButtonScriptModule[]> {
  const { listWorkbookScriptRecords } = await import("@api/workbookScripts");
  const records = await listWorkbookScriptRecords();
  return records.map((record) => ({
    id: record.id,
    name: record.name,
    source: record.source,
    sourcePackage: record.sourcePackage ?? null,
    loadError: record.loadError,
  }));
}
