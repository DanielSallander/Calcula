//! FILENAME: app/extensions/Charts/lib/chartFormula.ts
// PURPOSE: Translate a chart `calculate`/`filter` expression into the REAL Rust
//          formula engine's input, and coerce its results. Computation lives in
//          Rust ("The Bridge, not the Monolith", A6): the former hand-rolled
//          recursive-descent EVALUATOR + function library was retired — chart
//          expressions now evaluate via @api `evaluateScoped` (Rust parser +
//          engine::Evaluator). What remains here is a thin SYNTAX ADAPTER, not a
//          second engine:
//            - a lexer (tokenize) used only to rewrite chart-specific variable
//              references — `$category`/`$index`/`$value`, the filter `value`
//              keyword, and `[Bracketed Series Names]` (spaces) — into plain
//              engine-legal identifiers the engine binds by name;
//            - value coercion (toNumber/toText/toBoolean) shared by chart params
//              and widget-value formatting;
//            - scope/result mapping between the chart value model and the engine.
// CONTEXT: runs under a no-unsafe-eval CSP; no eval / no new Function.

import type { EvalScope, EvalResultValue } from "@api/formulaEval";

// ============================================================================
// Public value model (shared by chartParams / chartWidgetValues / transforms)
// ============================================================================

export type FormulaValue = number | string | boolean;
export type FormulaScope = Map<string, FormulaValue>;

/** Thrown for a tokenize failure (mirrors Excel #SYNTAX). */
export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormulaError";
  }
}

// ============================================================================
// Coercion helpers
// ============================================================================

/** Coerce a value to a number (booleans → 1/0, numeric strings parsed). Throws on failure. */
export function toNumber(value: FormulaValue): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const s = value.trim();
  if (s === "") return 0;
  const n = Number(s);
  if (Number.isNaN(n)) throw new FormulaError(`#VALUE! not a number: "${value}"`);
  return n;
}

/** Coerce a value to its text form (numbers canonical, booleans → TRUE/FALSE). */
export function toText(value: FormulaValue): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

/** Coerce a value to a boolean (numbers → nonzero, "TRUE"/"FALSE" recognized). Throws otherwise. */
export function toBoolean(value: FormulaValue): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const s = value.trim().toLowerCase();
  if (s === "true") return true;
  if (s === "false" || s === "") return false;
  throw new FormulaError(`#VALUE! not a boolean: "${value}"`);
}

// ============================================================================
// Lexer (used ONLY to rewrite variable references for the engine)
// ============================================================================

type Token =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "id"; v: string }
  | { k: "op"; v: string }
  | { k: "lp" }
  | { k: "rp" }
  | { k: "comma" };

const NUMBER_RE = /\d*\.?\d+(?:[eE][+-]?\d+)?/y;
const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/y;

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i];

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") {
      i++;
      continue;
    }

    // String literal: "..." with "" as an escaped quote.
    if (ch === '"') {
      i++;
      let str = "";
      let closed = false;
      while (i < n) {
        if (input[i] === '"') {
          if (input[i + 1] === '"') { str += '"'; i += 2; continue; }
          closed = true;
          i++;
          break;
        }
        str += input[i++];
      }
      if (!closed) throw new FormulaError("#SYNTAX! unterminated string");
      tokens.push({ k: "str", v: str });
      continue;
    }

    // Bracketed identifier: [Any Name] — trimmed so [ Name ] == [Name].
    if (ch === "[") {
      const end = input.indexOf("]", i + 1);
      if (end === -1) throw new FormulaError("#SYNTAX! unterminated [reference]");
      tokens.push({ k: "id", v: input.slice(i + 1, end).trim() });
      i = end + 1;
      continue;
    }

    if (ch === "(") { tokens.push({ k: "lp" }); i++; continue; }
    if (ch === ")") { tokens.push({ k: "rp" }); i++; continue; }
    if (ch === ",") { tokens.push({ k: "comma" }); i++; continue; }

    const two = input.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") { tokens.push({ k: "op", v: two }); i += 2; continue; }
    if (two === "!=") { tokens.push({ k: "op", v: "<>" }); i += 2; continue; }

    if ("+-*/^&=<>".includes(ch)) { tokens.push({ k: "op", v: ch }); i++; continue; }

    NUMBER_RE.lastIndex = i;
    const nm = NUMBER_RE.exec(input);
    if (nm && nm.index === i) {
      tokens.push({ k: "num", v: parseFloat(nm[0]) });
      i = NUMBER_RE.lastIndex;
      continue;
    }

    IDENT_RE.lastIndex = i;
    const im = IDENT_RE.exec(input);
    if (im && im.index === i) {
      tokens.push({ k: "id", v: im[0] });
      i = IDENT_RE.lastIndex;
      continue;
    }

    throw new FormulaError(`#SYNTAX! unexpected character '${ch}'`);
  }

  return tokens;
}

// ============================================================================
// Chart-expression → engine-expression translation
// ============================================================================

/**
 * Canonical engine-legal identifier for a chart scope name. The engine binds
 * bare identifiers ([A-Za-z_][A-Za-z0-9_]*, case-insensitive) the way LET/LAMBDA
 * do; `$`, spaces and other chart-name chars are not valid there, so every
 * variable maps to a `v_`-prefixed sanitized alias. A series' exact name and its
 * underscore form (e.g. "Revenue Total" / "Revenue_Total") collapse to the same
 * alias — which is correct, since the scope binds both to the same value.
 */
export function aliasName(name: string): string {
  return "v_" + name.replace(/[^A-Za-z0-9_]/g, "_");
}

function numberToExpr(v: number): string {
  // Finite engine-parseable literal; tokenizer never produces a signed/NaN num.
  return Number.isFinite(v) ? String(v) : "0";
}

/**
 * Rewrite a chart expression into engine syntax: variable references (bare
 * identifiers not used as a call, and `[Bracketed]` names) become `v_…` aliases;
 * function names (identifier immediately followed by `(`) and TRUE/FALSE literals
 * are preserved; numbers, strings and operators pass through. The result is fed
 * to the real engine via `evaluateScoped`. Throws FormulaError on a lex failure
 * (the caller treats that exactly like the old compile failure).
 */
export function translateChartExpr(expr: string): string {
  const tokens = tokenize(expr);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t.k) {
      case "num": out.push(numberToExpr(t.v)); break;
      case "str": out.push('"' + t.v.replace(/"/g, '""') + '"'); break;
      case "op": out.push(t.v); break;
      case "lp": out.push("("); break;
      case "rp": out.push(")"); break;
      case "comma": out.push(","); break;
      case "id": {
        const next = tokens[i + 1];
        if (next && next.k === "lp") { out.push(t.v); break; } // function call — keep name
        if (/^(?:true|false)$/i.test(t.v)) { out.push(t.v.toUpperCase()); break; } // boolean literal
        out.push(aliasName(t.v)); // variable reference — alias
        break;
      }
    }
  }
  return out.join(" ");
}

/** Map a chart row scope to an engine scope (keys aliased to engine identifiers). */
export function toEngineScope(scope: FormulaScope): EvalScope {
  const out: EvalScope = {};
  for (const [k, v] of scope) out[aliasName(k)] = v;
  return out;
}

// ============================================================================
// Engine-result coercion (mirrors the old evaluator's keep/zero fallbacks)
// ============================================================================

/** A result is an engine error when it is a "#…" string (e.g. #NAME?, #DIV/0!). */
export function isEngineError(r: EvalResultValue): r is string {
  return typeof r === "string" && r.startsWith("#");
}

/** Coerce an engine result to boolean (for filter predicates). Throws on a value
 *  that has no boolean reading — the caller treats that like the old eval error. */
export function resultToBoolean(r: EvalResultValue): boolean {
  if (typeof r === "boolean") return r;
  if (typeof r === "number") return r !== 0;
  if (typeof r === "string") return toBoolean(r);
  if (r === null) return false;
  throw new FormulaError("#VALUE! array result has no boolean value");
}

/** Coerce an engine result to a finite number (for calculate); non-finite → 0. */
export function resultToNumber(r: EvalResultValue): number {
  let n: number;
  if (typeof r === "number") n = r;
  else if (typeof r === "boolean") n = r ? 1 : 0;
  else if (typeof r === "string") n = toNumber(r);
  else if (r === null) n = 0;
  else throw new FormulaError("#VALUE! array result has no numeric value");
  return Number.isFinite(n) ? n : 0;
}
