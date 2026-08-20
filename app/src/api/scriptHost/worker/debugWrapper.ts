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
 * Neutralise module syntax that cannot appear where the user body is spliced.
 *
 * `wrapModuleSource` puts the body INSIDE a function, where `import` and
 * `export` are SyntaxErrors. `export function setup(context)` — the form the
 * docs, the generated IntelliSense typings and the AI authoring prompt all teach
 * — therefore failed to compile at mount while passing every static check before
 * it, because acorn parses the source with `sourceType: "module"` and accepts
 * what the blob then rejects.
 *
 * A SINGLE TOKENIZER-AWARE PASS, not regexes. The regex version accumulated six
 * confirmed defects because a regex cannot know its context: it blanked lines
 * INSIDE multi-line template literals (silently corrupting the string's runtime
 * value), was truncated by a `}` in a comment inside a specifier list, blanked
 * real code trailing an import on the same line, missed an `export` split from
 * its declaration by a newline, and missed a mid-line `export` after another
 * statement — while the validator, which parses, accepted every one of those
 * forms. This pass tracks string / template (including `${…}` nesting) / comment
 * state character by character, so it touches module syntax exactly where a
 * parser would see module syntax, and nothing else.
 *
 * Everything blanked is replaced with SPACES, never removed: line AND column
 * numbers survive, which is what lets a DEBUG mount apply this before
 * instrumentation (the yield point at offset 0 pushed `export` off column 0 and
 * out of reach of the old line-anchored strip — every breakpoint died) and what
 * keeps breakpoints, stacks and the call-stack view on the author's own
 * coordinates.
 *
 * Unknown or malformed module syntax is left UNTOUCHED: a loud SyntaxError at
 * mount beats a silent partial rewrite.
 *
 * Idempotent — a second pass finds nothing in code context to match.
 */
export function stripModuleSyntax(source: string): string {
  const n = source.length;
  const out = source.split("");
  const isWord = (ch: string | undefined): boolean =>
    ch !== undefined && /[A-Za-z0-9_$]/.test(ch);

  /** Blank [from, to), preserving line breaks. */
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
    }
  };

  /** Index just past a '…' / "…" literal starting at `at`. Bails at a newline. */
  const skipString = (at: number): number => {
    const quote = source[at];
    let k = at + 1;
    while (k < n) {
      if (source[k] === "\\") { k += 2; continue; }
      if (source[k] === quote) return k + 1;
      if (source[k] === "\n") return k; // unterminated — stop damage here
      k++;
    }
    return k;
  };

  /** Index just past a `…` template starting at `at`, ${…} nesting included. */
  const skipTemplate = (at: number): number => {
    let k = at + 1;
    while (k < n) {
      if (source[k] === "\\") { k += 2; continue; }
      if (source[k] === "`") return k + 1;
      if (source[k] === "$" && source[k + 1] === "{") {
        k = skipInterpolation(k + 2);
        continue;
      }
      k++;
    }
    return k;
  };

  /** Inside `${…}`: skip code (strings/templates/comments) to the matching `}`. */
  const skipInterpolation = (at: number): number => {
    let depth = 0;
    let k = at;
    while (k < n) {
      const ch = source[k];
      if (ch === "'" || ch === '"') { k = skipString(k); continue; }
      if (ch === "`") { k = skipTemplate(k); continue; }
      if (ch === "/" && source[k + 1] === "/") { while (k < n && source[k] !== "\n") k++; continue; }
      if (ch === "/" && source[k + 1] === "*") { k = skipBlockComment(k); continue; }
      if (ch === "{") { depth++; k++; continue; }
      if (ch === "}") { if (depth === 0) return k + 1; depth--; k++; continue; }
      k++;
    }
    return k;
  };

  const skipBlockComment = (at: number): number => {
    const end = source.indexOf("*/", at + 2);
    return end === -1 ? n : end + 2;
  };

  /** Next significant position at/after `at`: past whitespace and comments. */
  const nextSignificant = (at: number): number => {
    let k = at;
    while (k < n) {
      const ch = source[k];
      if (/\s/.test(ch)) { k++; continue; }
      if (ch === "/" && source[k + 1] === "/") { while (k < n && source[k] !== "\n") k++; continue; }
      if (ch === "/" && source[k + 1] === "*") { k = skipBlockComment(k); continue; }
      return k;
    }
    return n;
  };

  const wordAt = (at: number): string => {
    let k = at;
    while (k < n && isWord(source[k])) k++;
    return source.slice(at, k);
  };

  /**
   * Blank one `import …` statement starting at the keyword. Ends at the first
   * code-level `;`, or — the ASI form — at a newline that directly follows the
   * module-specifier string. Anything else (dynamic `import(`, `import.meta`,
   * malformed) is left alone.
   */
  const blankImport = (start: number, afterKeyword: number): number => {
    const sig = nextSignificant(afterKeyword);
    // `import(` is an expression and `import.meta` is a value — both are the
    // script's own business, and blanking a line around them was the old
    // behaviour's collateral damage.
    if (source[sig] === "(" || source[sig] === ".") return afterKeyword;
    let k = afterKeyword;
    let lastWasString = false;
    while (k < n) {
      const ch = source[k];
      if (ch === "'" || ch === '"') { k = skipString(k); lastWasString = true; continue; }
      if (ch === "`") { k = skipTemplate(k); lastWasString = true; continue; }
      if (ch === "/" && source[k + 1] === "/") { while (k < n && source[k] !== "\n") k++; continue; }
      if (ch === "/" && source[k + 1] === "*") { k = skipBlockComment(k); continue; }
      if (ch === ";") { blank(start, k + 1); return k + 1; }
      if (ch === "\n") {
        if (lastWasString) { blank(start, k); return k; } // ASI: `import x from 'y'` ⏎
        k++;
        continue;
      }
      if (!/\s/.test(ch)) lastWasString = false;
      k++;
    }
    blank(start, n);
    return n;
  };

  /**
   * Handle one `export` at a statement position. Blanks exactly what the module
   * grammar owns: the keyword before a declaration, `default`, a specifier list
   * `{ … }` (with its `from '…'` and `;` when present), or `* from '…';`.
   */
  const blankExport = (start: number, afterKeyword: number): number => {
    const sig = nextSignificant(afterKeyword);
    if (sig >= n) return afterKeyword;
    const ch = source[sig];

    if (ch === "{") {
      // Specifier list — tokenizer-aware to the matching `}`, so a `}` inside a
      // comment or string in the list cannot truncate it.
      let k = sig + 1;
      let depth = 0;
      while (k < n) {
        const c = source[k];
        if (c === "'" || c === '"') { k = skipString(k); continue; }
        if (c === "`") { k = skipTemplate(k); continue; }
        if (c === "/" && source[k + 1] === "/") { while (k < n && source[k] !== "\n") k++; continue; }
        if (c === "/" && source[k + 1] === "*") { k = skipBlockComment(k); continue; }
        if (c === "{") { depth++; k++; continue; }
        if (c === "}") { if (depth === 0) { k++; break; } depth--; k++; continue; }
        k++;
      }
      // `from '…'` re-export, then an optional `;`.
      let end = k;
      const afterBrace = nextSignificant(k);
      if (wordAt(afterBrace) === "from") {
        const spec = nextSignificant(afterBrace + 4);
        if (source[spec] === "'" || source[spec] === '"') end = skipString(spec);
      }
      const semi = nextSignificant(end);
      if (source[semi] === ";") end = semi + 1;
      blank(start, end);
      return end;
    }

    if (ch === "*") {
      // `export * from '…';` (with or without `as ns`).
      let k = sig + 1;
      let end = -1;
      while (k < n && source[k] !== "\n") {
        if (source[k] === "'" || source[k] === '"') { k = skipString(k); end = k; continue; }
        if (source[k] === ";") { end = k + 1; break; }
        k++;
      }
      if (end === -1) return afterKeyword; // malformed — leave it loud
      blank(start, end);
      return end;
    }

    const word = wordAt(sig);
    if (word === "default") {
      blank(start, sig + "default".length);
      return sig + "default".length;
    }
    if (["function", "const", "let", "var", "class", "async"].includes(word)) {
      // The declaration stays exactly where the author put it.
      blank(start, afterKeyword);
      return afterKeyword;
    }
    return afterKeyword; // unknown form — leave it loud
  };

  let i = 0;
  let prevSig = ""; // previous significant char in CODE context
  while (i < n) {
    const ch = source[i];
    if (ch === "'" || ch === '"') { i = skipString(i); prevSig = "s"; continue; }
    if (ch === "`") { i = skipTemplate(i); prevSig = "s"; continue; }
    if (ch === "/" && source[i + 1] === "/") { while (i < n && source[i] !== "\n") i++; continue; }
    if (ch === "/" && source[i + 1] === "*") { i = skipBlockComment(i); continue; }
    if (/\s/.test(ch)) { i++; continue; }

    if (isWord(ch) && (!isWord(source[i - 1]) || i === 0)) {
      const word = wordAt(i);
      const after = i + word.length;
      if ((word === "import" || word === "export") && prevSig !== ".") {
        // `{ export: 1 }` / `obj = { import: x }` — a property key, not syntax.
        const sig = nextSignificant(after);
        if (source[sig] === ":") { prevSig = "w"; i = after; continue; }
        i = word === "import" ? blankImport(i, after) : blankExport(i, after);
        prevSig = ";";
        continue;
      }
      prevSig = "w";
      i = after;
      continue;
    }

    prevSig = ch;
    i++;
  }

  return out.join("");
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
