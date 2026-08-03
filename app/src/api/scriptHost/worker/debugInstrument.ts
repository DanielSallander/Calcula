//! FILENAME: app/src/api/scriptHost/worker/debugInstrument.ts
// PURPOSE: The source-to-source pass that turns a user script into a
//          steppable one: it inserts a YIELD POINT at the head of every
//          statement it can safely reach, so the debug runtime can suspend
//          there. Runs INSIDE the worker realm, only for a script the user
//          explicitly put into a debug session — production mounts never see
//          it, and nothing here grants a script any reach it lacks.
//
// CONTEXT: We have no JS parser in the bundle (and will not ship one into the
//          sandbox for this), so this is a hand-written SCANNER: it tokenizes
//          well enough to know where it is (strings / templates / comments /
//          regex / brace kind / paren depth) and then refuses to insert
//          anywhere it is not certain. That conservatism is the whole design:
//          a line without a yield point is an UNVERIFIED breakpoint the editor
//          shows hollow — a line with one is guaranteed safe. Every insertion
//          is LINE-PRESERVING (no newlines are ever added), so line numbers in
//          stacks, errors and breakpoints mean the same thing before and after.
//
// SAFETY NET: bootstrap.ts compiles the instrumented source first; if the JS
//          engine rejects it, it falls back to the ORIGINAL source and reports
//          `instrumented: false` to the host, which says so in the UI. A bad
//          transform can therefore cost stepping — never the script.

// ============================================================================
// Result
// ============================================================================

export interface InstrumentResult {
  /** The instrumented source (identical to the input when `ok` is false). */
  code: string;
  /** Lines that got a PAUSABLE yield point (inside an async context). */
  pausableLines: number[];
  /**
   * Lines that got a NON-PAUSABLE yield point: a synchronous function body,
   * where JS cannot suspend. Execution continues; the runtime reports a
   * variable snapshot instead. The editor labels these honestly.
   */
  snapshotLines: number[];
  /** Functions the pass promoted to `async` so their bodies can pause. */
  promotedFunctions: string[];
  ok: boolean;
  error?: string;
}

/** Runtime global the inserted calls target. Deliberately unlikely to collide. */
export const DEBUG_GLOBAL = "__calculaDbg";

/** Max locals captured per yield point (bounds emitted code size). */
const MAX_LOCALS_PER_POINT = 24;

// ============================================================================
// Token model
// ============================================================================

type TokKind = "word" | "punc" | "num" | "str" | "tpl" | "regex";

interface Tok {
  kind: TokKind;
  text: string;
  start: number;
  end: number;
  line: number;
  /** First significant token on its physical line. */
  firstOnLine: boolean;
}

type BraceKind = "block" | "object" | "class" | "switch" | "template";

interface Scope {
  names: string[];
}

interface BraceFrame {
  kind: BraceKind;
  /** Paren/bracket depth captured when the brace opened. */
  parenDepth: number;
  bracketDepth: number;
  /** Set when this brace is a function body. */
  fn?: FnFrame;
  scope: Scope;
}

interface FnFrame {
  /** Whether `await` is legal directly inside this body. */
  canAwait: boolean;
  name: string;
}

/** Words that may not begin an inserted-before statement (continuations). */
const CONTINUATION_WORDS = new Set([
  "else", "catch", "finally", "while", "case", "default",
  "in", "of", "instanceof", "extends", "from", "as",
]);

/**
 * Words that unambiguously START a statement. When a line begins with one of
 * these, ASI has already terminated whatever came before, so we may insert even
 * if the previous token is not `;` / `{` / `}`.
 */
const STATEMENT_WORDS = new Set([
  "const", "let", "var", "if", "for", "while", "do", "switch", "try",
  "throw", "return", "break", "continue", "function", "class", "debugger",
]);

/** After these, a `/` starts a REGEX rather than a division. */
const REGEX_PRECEDERS = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", ";", "=>", "+", "-", "*",
  "%", "<", ">", "&&", "||", "??", "===", "!==", "==", "!=", "<=", ">=", "return",
  "typeof", "instanceof", "in", "of", "new", "delete", "void", "case", "do",
  "else", "yield", "await",
]);

/** Keyword-led parenthesised heads whose following `{` is NOT a function body. */
const CONTROL_HEADS = new Set(["if", "for", "while", "switch", "catch", "with"]);

/**
 * Reserved words. A preceding token that is a reserved word means the position
 * is mid-construct (`else` <stmt>, `return` <expr>, `new` <expr>, ...), so no
 * yield point may be inserted there; a preceding IDENTIFIER, by contrast, ends
 * a value and ASI can safely terminate the statement.
 */
const RESERVED_WORDS = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "enum", "export", "extends", "false",
  "finally", "for", "function", "if", "import", "in", "instanceof", "new",
  "null", "return", "super", "switch", "this", "throw", "true", "try", "typeof",
  "var", "void", "while", "with", "yield", "let", "static", "get", "set",
  "async", "of", "as", "from",
]);

const MULTI_PUNC = [
  ">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
  "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=",
  "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>",
];

function isIdentStart(c: string): boolean {
  return /[A-Za-z_$]/.test(c);
}
function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c);
}

// ============================================================================
// Pass 1 — tokenize
// ============================================================================

interface TokenizeResult {
  toks: Tok[];
  error?: string;
}

/**
 * Tokenize far enough to be *positionally* correct: we need to know, for every
 * offset, whether it is code, and what the previous significant token was. We do
 * NOT need a syntax tree.
 */
function tokenize(src: string): TokenizeResult {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  let lineHasTok = false;
  // Template-literal nesting: each entry is the brace depth at which a `${`
  // expression was opened, so the matching `}` returns to template text.
  const tplStack: number[] = [];
  let braceDepth = 0;

  const push = (kind: TokKind, text: string, start: number, end: number): void => {
    toks.push({ kind, text, start, end, line, firstOnLine: !lineHasTok });
    lineHasTok = true;
  };

  const prevSig = (): Tok | undefined => toks[toks.length - 1];

  while (i < src.length) {
    const c = src[i];

    if (c === "\n") {
      line++;
      lineHasTok = false;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }

    // Comments
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") {
          line++;
          lineHasTok = false;
        }
        i++;
      }
      if (i >= src.length) return { toks, error: "unterminated block comment" };
      i += 2;
      continue;
    }

    // Strings
    if (c === '"' || c === "'") {
      const start = i;
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++;
        else if (src[i] === "\n") return { toks, error: "unterminated string" };
        i++;
      }
      if (i >= src.length) return { toks, error: "unterminated string" };
      i++;
      push("str", "''", start, i);
      continue;
    }

    // Template literals (with ${} expression nesting)
    if (c === "`") {
      const start = i;
      i++;
      let closed = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === "\n") {
          line++;
          i++;
          continue;
        }
        if (ch === "`") {
          i++;
          closed = true;
          break;
        }
        if (ch === "$" && src[i + 1] === "{") {
          // Emit the template head as a token, then continue tokenizing the
          // expression normally; the matching `}` pops back to template text.
          push("tpl", "``", start, i);
          i += 2;
          braceDepth++;
          tplStack.push(braceDepth);
          push("punc", "${", i - 2, i);
          closed = true; // handled by the ${} branch below
          break;
        }
        i++;
      }
      if (!closed) return { toks, error: "unterminated template literal" };
      if (src[i - 1] === "`") push("tpl", "``", start, i);
      continue;
    }

    // Numbers
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const start = i;
      while (i < src.length && /[0-9a-fA-FxXoObBeE._n]/.test(src[i])) {
        // Exponent sign
        if ((src[i] === "e" || src[i] === "E") && (src[i + 1] === "+" || src[i + 1] === "-")) {
          i += 2;
          continue;
        }
        i++;
      }
      push("num", src.slice(start, i), start, i);
      continue;
    }

    // Identifiers / keywords
    if (isIdentStart(c)) {
      const start = i;
      while (i < src.length && isIdentPart(src[i])) i++;
      push("word", src.slice(start, i), start, i);
      continue;
    }

    // Regex literal vs division
    if (c === "/") {
      const p = prevSig();
      const regexOk =
        !p ||
        (p.kind === "punc" && REGEX_PRECEDERS.has(p.text)) ||
        (p.kind === "word" && REGEX_PRECEDERS.has(p.text));
      if (regexOk) {
        const start = i;
        i++;
        let inClass = false;
        let closed = false;
        while (i < src.length) {
          const ch = src[i];
          if (ch === "\\") {
            i += 2;
            continue;
          }
          if (ch === "\n") break;
          if (ch === "[") inClass = true;
          else if (ch === "]") inClass = false;
          else if (ch === "/" && !inClass) {
            i++;
            closed = true;
            break;
          }
          i++;
        }
        if (!closed) return { toks, error: "unterminated regular expression" };
        while (i < src.length && isIdentPart(src[i])) i++; // flags
        push("regex", "//", start, i);
        continue;
      }
    }

    // Punctuation
    if (c === "}" && tplStack.length > 0 && tplStack[tplStack.length - 1] === braceDepth) {
      // Close of a `${}` expression — resume template text.
      tplStack.pop();
      braceDepth--;
      push("punc", "}", i, i + 1);
      i++;
      // Continue scanning the rest of the template literal.
      const start = i;
      let closed = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === "\n") {
          line++;
          i++;
          continue;
        }
        if (ch === "`") {
          i++;
          closed = true;
          break;
        }
        if (ch === "$" && src[i + 1] === "{") {
          push("tpl", "``", start, i);
          i += 2;
          braceDepth++;
          tplStack.push(braceDepth);
          push("punc", "${", i - 2, i);
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return { toks, error: "unterminated template literal" };
      if (src[i - 1] === "`") push("tpl", "``", start, i);
      continue;
    }

    if (c === "{") braceDepth++;
    if (c === "}") braceDepth--;

    let matched = "";
    for (const op of MULTI_PUNC) {
      if (src.startsWith(op, i)) {
        matched = op;
        break;
      }
    }
    if (!matched) matched = c;
    push("punc", matched, i, i + matched.length);
    i += matched.length;
  }

  if (tplStack.length > 0) return { toks, error: "unterminated template literal" };
  return { toks };
}

// ============================================================================
// Pass 2 — walk tokens, decide insertions
// ============================================================================

interface Insertion {
  offset: number;
  text: string;
}

/** Collect binding identifiers out of a token slice (params / declarators). */
function collectBindings(toks: Tok[], from: number, to: number): string[] {
  const out: string[] = [];
  let depth = 0;
  for (let i = from; i < to && i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === "punc") {
      if (t.text === "{" || t.text === "[" || t.text === "(") depth++;
      else if (t.text === "}" || t.text === "]" || t.text === ")") depth--;
      else if (t.text === "=" && depth === 0) {
        // Skip an initializer at depth 0 up to the next comma at depth 0.
        let d = 0;
        i++;
        while (i < to && i < toks.length) {
          const u = toks[i];
          if (u.kind === "punc") {
            if (u.text === "(" || u.text === "[" || u.text === "{") d++;
            else if (u.text === ")" || u.text === "]" || u.text === "}") d--;
            else if (u.text === "," && d <= 0) break;
          }
          i++;
        }
      }
      continue;
    }
    if (t.kind !== "word") continue;
    const prev = toks[i - 1];
    const next = toks[i + 1];
    if (prev && prev.kind === "punc" && (prev.text === "." || prev.text === "?.")) continue;
    // `{ key: name }` — the BOUND name is after the colon.
    if (next && next.kind === "punc" && next.text === ":") continue;
    if (CONTINUATION_WORDS.has(t.text) || STATEMENT_WORDS.has(t.text)) continue;
    if (t.text === "async" || t.text === "await" || t.text === "new" || t.text === "typeof") continue;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t.text)) continue;
    out.push(t.text);
  }
  return out;
}

/** Index of the `(` matching the `)` at `closeIdx`, or -1. */
function matchParenBack(toks: Tok[], closeIdx: number): number {
  let depth = 0;
  for (let i = closeIdx; i >= 0; i--) {
    const t = toks[i];
    if (t.kind !== "punc") continue;
    if (t.text === ")") depth++;
    else if (t.text === "(") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Whether the function whose parameter list opens at `openParen` is declared
 * `async`. Walks back over the name / `function` / `*` / accessor modifiers.
 */
function isAsyncBeforeParen(toks: Tok[], openParen: number): boolean {
  let i = openParen - 1;
  // `async(` with nothing between is a method literally NAMED async.
  if (toks[i] && toks[i].kind === "word" && toks[i].text === "async") return false;
  let steps = 0;
  while (i >= 0 && steps < 6) {
    const t = toks[i];
    if (t.kind === "word") {
      if (t.text === "async") return true;
      if (t.text === "function" || t.text === "get" || t.text === "set" || t.text === "static") {
        i--;
        steps++;
        continue;
      }
      // The function's own name — keep walking.
      i--;
      steps++;
      continue;
    }
    if (t.kind === "punc" && t.text === "*") {
      i--;
      steps++;
      continue;
    }
    return false;
  }
  return false;
}

/** Whether the function's parameter list at `openParen` belongs to a generator. */
function isGeneratorBeforeParen(toks: Tok[], openParen: number): boolean {
  for (let i = openParen - 1, steps = 0; i >= 0 && steps < 4; i--, steps++) {
    const t = toks[i];
    if (t.kind === "punc" && t.text === "*") return true;
    if (t.kind === "word") continue;
    return false;
  }
  return false;
}

interface PendingFn {
  /** Token index at which `async ` may be inserted to promote the function. */
  promoteIdx: number;
  canAwait: boolean;
  isGenerator: boolean;
  name: string;
  /** Parameter token range [from, to) for locals. */
  paramFrom: number;
  paramTo: number;
}

/**
 * Describe the function whose body brace sits at token index `braceIdx`
 * (previous significant token is `)` or `=>`), or null when the brace is not a
 * function body.
 */
function describeFunction(toks: Tok[], braceIdx: number): PendingFn | null {
  const prev = toks[braceIdx - 1];
  if (!prev || prev.kind !== "punc") return null;

  if (prev.text === "=>") {
    const before = toks[braceIdx - 2];
    if (!before) return null;
    if (before.kind === "punc" && before.text === ")") {
      const open = matchParenBack(toks, braceIdx - 2);
      if (open < 0) return null;
      const asyncTok = toks[open - 1];
      const isAsync = !!asyncTok && asyncTok.kind === "word" && asyncTok.text === "async";
      return {
        promoteIdx: isAsync ? -1 : open,
        canAwait: isAsync,
        isGenerator: false,
        name: "(arrow)",
        paramFrom: open + 1,
        paramTo: braceIdx - 2,
      };
    }
    if (before.kind === "word") {
      const asyncTok = toks[braceIdx - 3];
      const isAsync = !!asyncTok && asyncTok.kind === "word" && asyncTok.text === "async";
      return {
        promoteIdx: isAsync ? -1 : braceIdx - 2,
        canAwait: isAsync,
        isGenerator: false,
        name: "(arrow)",
        paramFrom: braceIdx - 2,
        paramTo: braceIdx - 1,
      };
    }
    return null;
  }

  if (prev.text !== ")") return null;
  const open = matchParenBack(toks, braceIdx - 1);
  if (open < 0) return null;
  const head = toks[open - 1];
  if (head && head.kind === "word" && CONTROL_HEADS.has(head.text)) return null;
  // `for (...)`, `if (...)`, `catch (...)` are not functions; a bare `(a) {`
  // is not valid JS either, so anything else here is a function body.
  const isAsync = isAsyncBeforeParen(toks, open);
  const isGen = isGeneratorBeforeParen(toks, open);
  // Where `async ` would go: before `function`, or before the method name.
  let promoteIdx = open;
  for (let i = open - 1, steps = 0; i >= 0 && steps < 6; i--, steps++) {
    const t = toks[i];
    if (t.kind === "word" && (t.text === "function" || t.text === "get" || t.text === "set")) {
      promoteIdx = i;
      continue;
    }
    if (t.kind === "word" && t.text === "static") break;
    if (t.kind === "word") {
      promoteIdx = i;
      continue;
    }
    if (t.kind === "punc" && t.text === "*") continue;
    break;
  }
  const nameTok = toks[open - 1];
  return {
    promoteIdx: isAsync ? -1 : promoteIdx,
    canAwait: isAsync,
    isGenerator: isGen,
    name: nameTok && nameTok.kind === "word" && nameTok.text !== "function" ? nameTok.text : "(anonymous)",
    paramFrom: open + 1,
    paramTo: braceIdx - 1,
  };
}

/**
 * The identifier the script uses for its context object: `setup`'s FIRST
 * PARAMETER, defaulting to `context` when there is no usable `setup(param)`.
 *
 * WHY IT IS NOT THE LITERAL "context". The parameter is a binding like any
 * other, and real scripts name it after the object they are attached to — the
 * macro recorder emits `function setup(button) { button.onClick(...) }`. Keying
 * callback promotion on the word "context" therefore silently refused to
 * promote handlers in exactly the script shape the recorder produces, and every
 * breakpoint inside such a handler degraded to a hollow snapshot-only dot.
 */
function setupContextName(toks: Tok[]): string {
  for (let i = 0; i + 3 < toks.length; i++) {
    const kw = toks[i];
    if (kw.kind !== "word" || kw.text !== "function") continue;
    const name = toks[i + 1];
    if (!name || name.kind !== "word" || name.text !== "setup") continue;
    const open = toks[i + 2];
    if (!open || open.kind !== "punc" || open.text !== "(") continue;
    const first = toks[i + 3];
    // A destructured (`{a, b}`) or absent parameter has no single name to key
    // on; `context` is then the only sane guess and costs nothing if wrong.
    if (!first || first.kind !== "word") return "context";
    return first.text;
  }
  return "context";
}

/**
 * Whether the function starting at token `startIdx` is an inline callback
 * handed straight to `<context>.onXxx(...)` / `<context>.expose(...)`, where
 * `<context>` is the context binding itself or a member path rooted at it
 * (`context.sheet.onDataChange`, `button.onClick`, ...).
 *
 * Those callbacks are reachable ONLY through the host dispatcher, which either
 * ignores the return value (dispatchEvent) or awaits it (exposed methods /
 * replying hooks) — so promoting them to `async` cannot change what the script
 * itself observes. `onRender` is excluded: its return value feeds the render
 * pipeline, which must never wait on a debugger.
 */
function isPromotableCallbackArg(toks: Tok[], startIdx: number, contextName: string): boolean {
  let i = startIdx - 1;
  // Allow an `async` we are about to add / a leading modifier position.
  if (i < 0) return false;
  const prev = toks[i];
  if (!prev || prev.kind !== "punc" || (prev.text !== "(" && prev.text !== ",")) return false;
  // Walk back to the opening paren of the enclosing call.
  let depth = 0;
  for (; i >= 0; i--) {
    const t = toks[i];
    if (t.kind !== "punc") continue;
    if (t.text === ")" || t.text === "]" || t.text === "}") depth++;
    else if (t.text === "[" || t.text === "{") depth--;
    else if (t.text === "(") {
      if (depth === 0) break;
      depth--;
    }
  }
  if (i < 0) return false;
  const method = toks[i - 1];
  if (!method || method.kind !== "word") return false;
  if (method.text !== "expose" && method.text !== "onRender" && !/^on[A-Z]/.test(method.text)) {
    return false;
  }
  if (method.text === "onRender") return false;
  // Walk the receiver back through `.name` links to its ROOT identifier, which
  // must be the context binding. Anything else — a user's own emitter, a
  // library object — is left alone: only the host dispatcher's own entry points
  // are safe to make awaitable.
  let r = i - 2;
  for (;;) {
    const dot = toks[r];
    if (!dot || dot.kind !== "punc" || dot.text !== ".") return false;
    const seg = toks[r - 1];
    if (!seg || seg.kind !== "word") return false;
    const before = toks[r - 2];
    if (before && before.kind === "punc" && before.text === ".") {
      r -= 2;
      continue;
    }
    return seg.text === contextName;
  }
}

/**
 * Whether a yield point may be inserted immediately before token `idx`.
 *
 * This is the single most safety-critical predicate in the pass. Inserting a
 * statement in the wrong place does not produce a syntax error — it silently
 * CHANGES THE PROGRAM: `if (x)\n  return;` would become
 * `if (x) <yield>; return;`, making the return unconditional. So the rule is a
 * strict allowlist of preceding tokens, not a blocklist:
 *
 *   - `;` `{` `}` — an unambiguous statement boundary.
 *   - `:` inside a switch body — after a `case`/`default` label.
 *   - anything that ENDS A VALUE (identifier, literal, `]`, postfix `++`/`--`,
 *     or a `)` that does NOT close an `if`/`for`/`while`/`with` head) — but only
 *     when the new line itself begins with a keyword that can only start a
 *     statement, which is exactly when ASI has already ended the previous one.
 */
function previousTokenAllowsInsert(
  toks: Tok[],
  idx: number,
  word: string,
  frameKind: BraceKind | undefined,
): boolean {
  const prev = toks[idx - 1];
  if (!prev) return true;
  if (prev.kind === "punc") {
    if (prev.text === ";" || prev.text === "{" || prev.text === "}") return true;
    if (prev.text === ":") return frameKind === "switch";
    if (!STATEMENT_WORDS.has(word)) return false;
    if (prev.text === "]" || prev.text === "++" || prev.text === "--") return true;
    if (prev.text === ")") {
      const open = matchParenBack(toks, idx - 1);
      const head = open > 0 ? toks[open - 1] : undefined;
      return !(head && head.kind === "word" && CONTROL_HEADS.has(head.text));
    }
    return false;
  }
  if (!STATEMENT_WORDS.has(word)) return false;
  if (prev.kind === "word") return !RESERVED_WORDS.has(prev.text);
  return true; // number / string / template / regex literal ends a value
}

/**
 * Instrument `source` with yield points.
 *
 * Every statement the pass can reach SAFELY gets one, regardless of where the
 * breakpoints currently are: the breakpoint set is live data the runtime
 * consults, so breakpoints can be added and removed mid-session without a
 * remount.
 */
export function instrumentForDebug(source: string): InstrumentResult {
  const fallback = (error: string): InstrumentResult => ({
    code: source,
    pausableLines: [],
    snapshotLines: [],
    promotedFunctions: [],
    ok: false,
    error,
  });

  const { toks, error } = tokenize(source);
  if (error) return fallback(error);

  const contextName = setupContextName(toks);
  const insertions: Insertion[] = [];
  const pausable = new Set<number>();
  const snapshot = new Set<number>();
  const promoted: string[] = [];

  const topScope: Scope = { names: [] };
  const stack: BraceFrame[] = [];
  let parenDepth = 0;
  let bracketDepth = 0;
  /** Function bodies currently open, innermost last. */
  const fnStack: FnFrame[] = [];

  const currentScopes = (): Scope[] => [topScope, ...stack.map((f) => f.scope)];
  const currentFrame = (): BraceFrame | undefined => stack[stack.length - 1];

  const localsExpr = (): string => {
    const seen = new Set<string>();
    const names: string[] = [];
    const scopes = currentScopes();
    for (let s = scopes.length - 1; s >= 0 && names.length < MAX_LOCALS_PER_POINT; s--) {
      for (const n of scopes[s].names) {
        if (seen.has(n)) continue;
        seen.add(n);
        names.push(n);
        if (names.length >= MAX_LOCALS_PER_POINT) break;
      }
    }
    if (names.length === 0) return "null";
    const pairs = names.map((n) => `["${n}",()=>${n}]`).join(",");
    return `${DEBUG_GLOBAL}.p([${pairs}])`;
  };

  for (let idx = 0; idx < toks.length; idx++) {
    const t = toks[idx];

    // ---- Insertion decision (must run BEFORE the token mutates the state) ---
    if (t.firstOnLine && t.kind === "word" && !CONTINUATION_WORDS.has(t.text)) {
      const frame = currentFrame();
      const kindOk = !frame || frame.kind === "block" || frame.kind === "switch";
      const depthOk =
        parenDepth === (frame ? frame.parenDepth : 0) &&
        bracketDepth === (frame ? frame.bracketDepth : 0);
      const prevOk = previousTokenAllowsInsert(toks, idx, t.text, frame?.kind);
      if (kindOk && depthOk && prevOk) {
        const canAwait = fnStack.length === 0 ? true : fnStack[fnStack.length - 1].canAwait;
        const locals = localsExpr();
        if (canAwait) {
          insertions.push({ offset: t.start, text: `await ${DEBUG_GLOBAL}.h(${t.line},()=>${locals});` });
          pausable.add(t.line);
        } else {
          insertions.push({ offset: t.start, text: `${DEBUG_GLOBAL}.s(${t.line},()=>${locals});` });
          snapshot.add(t.line);
        }
      }
    }

    // ---- State machine -----------------------------------------------------
    if (t.kind === "punc") {
      switch (t.text) {
        case "(":
          parenDepth++;
          break;
        case ")":
          parenDepth--;
          break;
        case "[":
          bracketDepth++;
          break;
        case "]":
          bracketDepth--;
          break;
        case "${": {
          stack.push({ kind: "template", parenDepth, bracketDepth, scope: { names: [] } });
          break;
        }
        case "{": {
          const fn = describeFunction(toks, idx);
          let kind: BraceKind = "object";
          let fnFrame: FnFrame | undefined;
          const scope: Scope = { names: [] };
          if (fn) {
            kind = "block";
            let canAwait = fn.canAwait;
            if (!canAwait && !fn.isGenerator && fn.promoteIdx >= 0) {
              const isTopLevelSetup =
                stack.length === 0 && fn.name === "setup" &&
                toks[fn.promoteIdx]?.text === "function";
              if (isTopLevelSetup || isPromotableCallbackArg(toks, fn.promoteIdx, contextName)) {
                insertions.push({ offset: toks[fn.promoteIdx].start, text: "async " });
                promoted.push(isTopLevelSetup ? "setup" : `${fn.name} (callback)`);
                canAwait = true;
              }
            }
            fnFrame = { canAwait, name: fn.name };
            scope.names.push(...collectBindings(toks, fn.paramFrom, fn.paramTo));
          } else {
            const prev = toks[idx - 1];
            if (prev && prev.kind === "punc" && prev.text === ")") {
              const open = matchParenBack(toks, idx - 1);
              const head = open > 0 ? toks[open - 1] : undefined;
              if (head && head.kind === "word" && CONTROL_HEADS.has(head.text)) {
                kind = head.text === "switch" ? "switch" : "block";
                if (head.text === "catch") {
                  scope.names.push(...collectBindings(toks, open + 1, idx - 1));
                }
              }
            } else if (prev && prev.kind === "word") {
              if (prev.text === "else" || prev.text === "try" || prev.text === "finally" || prev.text === "do") {
                kind = "block";
              } else {
                // `class X {` / `class X extends Y {`
                let classy = false;
                for (let k = idx - 1, steps = 0; k >= 0 && steps < 5; k--, steps++) {
                  const u = toks[k];
                  if (u.kind === "word" && u.text === "class") {
                    classy = true;
                    break;
                  }
                  if (u.kind === "word" || (u.kind === "punc" && u.text === ".")) continue;
                  break;
                }
                kind = classy ? "class" : "object";
              }
            } else if (
              prev && prev.kind === "punc" &&
              (prev.text === ";" || prev.text === "{" || prev.text === "}")
            ) {
              kind = "block";
            }
          }
          stack.push({ kind, parenDepth, bracketDepth, fn: fnFrame, scope });
          if (fnFrame) fnStack.push(fnFrame);
          break;
        }
        case "}": {
          const frame = stack.pop();
          if (frame?.fn) fnStack.pop();
          if (frame) {
            parenDepth = frame.parenDepth;
            bracketDepth = frame.bracketDepth;
          }
          break;
        }
        default:
          break;
      }
      continue;
    }

    if (t.kind === "word") {
      // Declarations contribute locals to the nearest scope.
      if (t.text === "const" || t.text === "let" || t.text === "var") {
        let end = idx + 1;
        let d = 0;
        while (end < toks.length) {
          const u = toks[end];
          if (u.kind === "punc") {
            if (u.text === "(" || u.text === "[" || u.text === "{") d++;
            else if (u.text === ")" || u.text === "]" || u.text === "}") {
              if (d === 0) break;
              d--;
            } else if (u.text === ";" && d === 0) break;
          }
          if (u.kind === "word" && d === 0 && (u.text === "of" || u.text === "in")) break;
          end++;
        }
        const scopes = currentScopes();
        scopes[scopes.length - 1].names.push(...collectBindings(toks, idx + 1, end));
      } else if (t.text === "function") {
        const nameTok = toks[idx + 1];
        if (nameTok && nameTok.kind === "word") {
          const scopes = currentScopes();
          scopes[scopes.length - 1].names.push(nameTok.text);
        }
      }
    }
  }

  if (insertions.length === 0 && promoted.length === 0) {
    return {
      code: source,
      pausableLines: [],
      snapshotLines: [],
      promotedFunctions: [],
      ok: true,
    };
  }

  insertions.sort((a, b) => a.offset - b.offset);
  let out = "";
  let cursor = 0;
  for (const ins of insertions) {
    out += source.slice(cursor, ins.offset) + ins.text;
    cursor = ins.offset;
  }
  out += source.slice(cursor);

  // Line-preservation is a hard invariant: stacks, breakpoints and error
  // messages all address the ORIGINAL line numbers.
  if (countLines(out) !== countLines(source)) {
    return fallback("instrumentation changed the line count");
  }

  return {
    code: out,
    pausableLines: [...pausable].sort((a, b) => a - b),
    snapshotLines: [...snapshot].sort((a, b) => a - b),
    promotedFunctions: promoted,
    ok: true,
  };
}

function countLines(s: string): number {
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s[i] === "\n") n++;
  return n;
}

// ============================================================================
// Top-level function inventory (run-at-cursor / VBA F5)
// ============================================================================

/**
 * One function DECLARED at the top level of a script's source — the unit
 * run-at-cursor runs. `setup` is included here (it is a top-level function like
 * any other); callers that want run-targets filter it out, because it is the
 * entry point the mount already calls, not a thing the user asks to run.
 */
export interface TopLevelFunction {
  /** Declared name (`function <name>`). */
  name: string;
  /**
   * Best-effort parameter count from the source. Advisory only — the worker
   * thunk binds arguments by the live `fn.length`, which is authoritative. The
   * editor uses this to pre-warn on an un-runnable arity without a round-trip.
   */
  arity: number;
  isAsync: boolean;
  /** 1-based line of the `function` keyword. */
  startLine: number;
  /** 1-based line of the body's closing brace. */
  endLine: number;
}

/** Whether a preceding token lets a `function` here begin a DECLARATION (not an expression). */
function isDeclarationAnchor(tok: Tok | undefined): boolean {
  if (!tok) return true; // start of source
  return tok.kind === "punc" && (tok.text === ";" || tok.text === "{" || tok.text === "}");
}

/** Forward index of the `)` matching the `(` at `openIdx`, or -1. */
function matchParenForward(toks: Tok[], openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== "punc") continue;
    if (t.text === "(") depth++;
    else if (t.text === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Forward index of the `}` matching the `{` at `openIdx` (counts `${` as a brace open), or -1. */
function matchBraceForward(toks: Tok[], openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== "punc") continue;
    if (t.text === "{" || t.text === "${") depth++;
    else if (t.text === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Count parameters in the range `(openIdx .. closeIdx)` — top-level commas + 1. */
function countParams(toks: Tok[], openIdx: number, closeIdx: number): number {
  if (closeIdx <= openIdx + 1) return 0; // `()`
  let commas = 0;
  let depth = 0;
  for (let i = openIdx + 1; i < closeIdx; i++) {
    const t = toks[i];
    if (t.kind !== "punc") continue;
    if (t.text === "(" || t.text === "[" || t.text === "{") depth++;
    else if (t.text === ")" || t.text === "]" || t.text === "}") depth--;
    else if (t.text === "," && depth === 0) commas++;
  }
  return commas + 1;
}

/**
 * Every function DECLARED at the top level of `source`.
 *
 * Only true declarations at brace depth 0 in statement position are returned —
 * function *expressions* (`const f = function(){}`, callbacks) live at depth > 0
 * or after a non-statement token and are deliberately excluded, because they are
 * not things a user can "run" on their own. Conservative by design: when the
 * scan is unsure it omits, so a returned entry is always a real run-target.
 *
 * Pure (no worker globals): safe to call from the editor to map a cursor line to
 * the function that encloses it.
 */
export function topLevelFunctions(source: string): TopLevelFunction[] {
  const { toks, error } = tokenize(source);
  if (error) return [];
  const out: TopLevelFunction[] = [];
  let depth = 0; // `{` / `${` open, `}` close
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === "punc") {
      if (t.text === "{" || t.text === "${") depth++;
      else if (t.text === "}") depth--;
      continue;
    }
    if (depth !== 0) continue;
    if (t.kind !== "word" || t.text !== "function") continue;

    // `function` or `async function`, in statement position.
    const prev = toks[i - 1];
    let anchor = prev;
    let isAsync = false;
    if (prev && prev.kind === "word" && prev.text === "async") {
      isAsync = true;
      anchor = toks[i - 2];
    }
    if (!isDeclarationAnchor(anchor)) continue;

    // Optional generator star, then the name.
    let j = i + 1;
    if (toks[j] && toks[j].kind === "punc" && toks[j].text === "*") j++;
    const nameTok = toks[j];
    if (!nameTok || nameTok.kind !== "word") continue; // anonymous — not a run-target
    const open = toks[j + 1];
    if (!open || open.kind !== "punc" || open.text !== "(") continue;
    const close = matchParenForward(toks, j + 1);
    if (close < 0) continue;
    const brace = toks[close + 1];
    if (!brace || brace.kind !== "punc" || brace.text !== "{") continue;
    const closeBrace = matchBraceForward(toks, close + 1);
    const endLine = closeBrace >= 0 ? toks[closeBrace].line : toks[toks.length - 1].line;

    out.push({
      name: nameTok.text,
      arity: countParams(toks, j + 1, close),
      isAsync,
      startLine: t.line,
      endLine,
    });
    // No manual skip: the loop keeps walking, and the `{`/`}` counting takes the
    // scan to depth > 0 through this body, so nested functions are excluded.
  }
  return out;
}

/**
 * The top-level function whose body encloses `line` (1-based), or null.
 *
 * Top-level declarations do not nest, so at most one contains the line; if the
 * cursor sits between declarations (blank line, header comment) the answer is
 * null and the caller falls back per its own rule.
 */
export function enclosingTopLevelFunction(source: string, line: number): TopLevelFunction | null {
  for (const fn of topLevelFunctions(source)) {
    if (line >= fn.startLine && line <= fn.endLine) return fn;
  }
  return null;
}
