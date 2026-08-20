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
/**
 * Every character replaced by a space, except line breaks.
 *
 * Length AND line count are preserved, so a strip never moves the code after
 * it: breakpoints, error stacks and the debugger's call-stack view all address
 * the author's own line and column.
 */
function blankOut(text: string): string {
  return text.replace(/[^\r\n]/g, " ");
}

/**
 * Neutralise module syntax that cannot appear where the user body is spliced.
 *
 * `wrapModuleSource` puts the body INSIDE a function, where `import` and
 * `export` are SyntaxErrors. `export function setup(context)` — the form the
 * docs, the generated IntelliSense typings and the AI authoring prompt all teach
 * — therefore failed to compile at mount while passing every static check before
 * it, because acorn parses the source with `sourceType: "module"` and accepts
 * what the blob then rejects.
 *
 * Exported separately so a DEBUG mount can apply it BEFORE instrumentation.
 * The instrumentation pass inserts a yield point at offset 0, which pushes
 * `export` off column 0 and out of reach of a line-anchored strip — the blob
 * threw, bootstrap swallowed it and silently recompiled un-instrumented, so
 * every breakpoint in the script was dead. Blanking (rather than deleting) is
 * what makes running it first safe: offsets computed later still line up.
 *
 * Idempotent — nothing matches on a second pass.
 *
 * Every pattern matches HORIZONTAL whitespace only. `\s` includes `\n`, and `^`
 * matches at the start of a blank line under `/m`, so a `\s*` prefix ate the
 * preceding blank line's newline and shifted every following line up by one.
 */
export function stripModuleSyntax(source: string): string {
  return (
    source
      // `import …` — inert here, so the whole statement goes.
      .replace(/^[^\S\r\n]*import\b[^\r\n]*/gm, blankOut)
      // `export { setup };` and `export { a } from "m";` — the specifier form
      // survives a declaration-only strip, and may span lines.
      .replace(/^[^\S\r\n]*export[^\S\r\n]*\{[^}]*\}[^\r\n]*/gm, blankOut)
      // `export * from "m";`
      .replace(/^[^\S\r\n]*export[^\S\r\n]+\*[^\r\n]*/gm, blankOut)
      // `export default <decl>` / `export <decl>` — the keyword only; the
      // declaration itself stays exactly where the author put it.
      .replace(/^[^\S\r\n]*export[^\S\r\n]+default\b/gm, blankOut)
      .replace(
        /^[^\S\r\n]*export[^\S\r\n]+(?=(?:async[^\S\r\n]+)?(?:function|const|let|var|class)\b)/gm,
        blankOut,
      )
  );
}

export function wrapModuleSource(source: string, options: WrapOptions = {}): string {
  const { asyncWrapper = false, invokeSetup = true } = options;
  const cleaned = stripModuleSyntax(source);

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
