//! FILENAME: app/src/api/scriptHost/worker/debugWrapper.ts
// PURPOSE: The two pieces of TEXT the worker realm builds around a user script:
//          the blob-ESM module wrapper, and the run-target registration
//          statements a DEBUG mount appends after the user body.
// CONTEXT: They live here rather than inline in bootstrap.ts because they decide
//          WHETHER A DEBUG SESSION EXECUTES THE USER'S MACRO — the single
//          property this whole feature turns on — and bootstrap.ts cannot be
//          imported by a test (it is a worker entry point: it hardens the ambient
//          globals and installs `self.onmessage` at module load). Pure string
//          builders, no realm state, so the property can be proven directly.

import { DEBUG_GLOBAL, topLevelFunctions } from "./debugInstrument";

export interface WrapOptions {
  /**
   * Set for a DEBUG mount so the instrumented top level may `await` its yield
   * points. The wrapper's result is awaited by the caller either way.
   */
  asyncWrapper?: boolean;
  /**
   * Whether the wrapper's tail CALLS the script's `setup(context)`.
   *
   * False produces an INERT module: the body still runs — that is what declares
   * the functions and executes the run-target registrations appended after it —
   * but the entry point is not invoked. See DebugSpec.autoInvokeSetup: for a
   * recorded macro, calling `setup` under the synthetic `workbook` definition IS
   * running the macro, and a debug session that runs the macro before the user
   * has stepped a line is not a debugger.
   */
  invokeSetup?: boolean;
}

/**
 * Wrap one user source as a blob-ESM module whose default export is the module
 * body.
 *
 * The wrapper deliberately adds NO newline before the user source: line numbers
 * inside the blob are the user's line numbers, which is what breakpoints, error
 * stacks and the debugger's call-stack view all address. The tail's leading `;`
 * is what keeps a user source with no trailing semicolon from swallowing it via
 * ASI, and it is present in both forms.
 */
export function wrapModuleSource(source: string, options: WrapOptions = {}): string {
  const { asyncWrapper = false, invokeSetup = true } = options;
  // Cosmetic cleanup only (imports/exports won't resolve in a blob module).
  const cleaned = source
    .replace(/^\s*import\s+.*$/gm, "// [import removed]")
    .replace(/^\s*export\s+default\s+/gm, "");

  const tail = invokeSetup
    ? `; return typeof setup === "function" ? setup(context) : undefined; }`
    : `; return undefined; }`;
  return `export default ${asyncWrapper ? "async " : ""}function(context) { ${cleaned}\n` + tail;
}

/**
 * The statements the debug wrapper runs after the user body to register each
 * top-level function as a run-target (VBA F5).
 *
 * Appended on their own line, so no trailing user-line comment can swallow them
 * and no user line shifts. They run BEFORE the wrapper's tail, so the
 * run-targets exist whether or not that tail calls `setup` — which is what makes
 * an inert mount runnable at all.
 *
 * `setup` is included ONLY when the mount will not call it (`includeSetup`, i.e.
 * an inert module-macro mount). On an ordinary mount `setup` is the entry point
 * the mount itself invokes, so offering it as a "run this" target would just be
 * a second way to do what already happened. On an INERT mount the opposite is
 * true: nothing invoked it, it is the macro's real entry point (the thing a
 * button click runs), and for a macro whose whole body lives in `setup` it is
 * the ONLY runnable thing there is — leaving it out would leave the session with
 * no way to start the script at all.
 */
export function buildRunTargetRegistrations(source: string, includeSetup: boolean): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const fn of topLevelFunctions(source)) {
    const isSetup = fn.name === "setup";
    if ((isSetup && !includeSetup) || seen.has(fn.name)) continue;
    seen.add(fn.name);
    // `typeof <name> === "function"` guards a name the scan saw but the engine
    // did not hoist (a syntax the fallback tolerated); never a ReferenceError.
    // The 4th argument marks the ENTRY POINT, whose single parameter is the
    // whole `context` rather than `context.api`.
    parts.push(
      `${DEBUG_GLOBAL}.rt(${JSON.stringify(fn.name)},typeof ${fn.name}==="function"?${fn.name}:null,context${isSetup ? ",true" : ""});`,
    );
  }
  return parts.join("");
}

/** `code` with the run-target registrations appended (no-op when there are none). */
export function withRunTargets(code: string, registrations: string): string {
  return registrations ? `${code}\n${registrations}` : code;
}
