//! FILENAME: app/vitest.fakeFormulaEngine.ts
// PURPOSE: A TEST-ONLY formula oracle backing the global mock of @api/formulaEval
//          in vitest (see vitest.setup.ts). Production chart filter/calculate
//          evaluate via the REAL Rust engine (evaluate_scoped, A6); that engine
//          is not available in the jsdom/vitest environment, so unit tests would
//          otherwise lose all chart formula behavior. This module is a faithful
//          Excel-subset evaluator (the former in-extension chartFormula engine,
//          retired from production) used ONLY as a test double so the chart
//          transform tests keep verifying real filter/calculate behavior.
//          Real-engine parity is covered separately by the engine's Rust tests
//          and e2e/visual-regression. It must never be imported by production code.

import type { EvalScope, EvalResultValue } from "@api/formulaEval";

type FormulaValue = number | string | boolean;
type FormulaScope = Map<string, FormulaValue>;

class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormulaError";
  }
}

function toNumber(value: FormulaValue): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const s = value.trim();
  if (s === "") return 0;
  const n = Number(s);
  if (Number.isNaN(n)) throw new FormulaError(`#VALUE! not a number: "${value}"`);
  return n;
}
function toText(value: FormulaValue): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}
function toBoolean(value: FormulaValue): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const s = value.trim().toLowerCase();
  if (s === "true") return true;
  if (s === "false" || s === "") return false;
  throw new FormulaError(`#VALUE! not a boolean: "${value}"`);
}

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
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") { i++; continue; }
    if (ch === '"') {
      i++;
      let str = "";
      let closed = false;
      while (i < n) {
        if (input[i] === '"') {
          if (input[i + 1] === '"') { str += '"'; i += 2; continue; }
          closed = true; i++; break;
        }
        str += input[i++];
      }
      if (!closed) throw new FormulaError("#SYNTAX! unterminated string");
      tokens.push({ k: "str", v: str });
      continue;
    }
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
    if (nm && nm.index === i) { tokens.push({ k: "num", v: parseFloat(nm[0]) }); i = NUMBER_RE.lastIndex; continue; }
    IDENT_RE.lastIndex = i;
    const im = IDENT_RE.exec(input);
    if (im && im.index === i) { tokens.push({ k: "id", v: im[0] }); i = IDENT_RE.lastIndex; continue; }
    throw new FormulaError(`#SYNTAX! unexpected character '${ch}'`);
  }
  return tokens;
}

type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "var"; name: string }
  | { t: "neg"; x: Node }
  | { t: "pos"; x: Node }
  | { t: "bin"; op: string; l: Node; r: Node }
  | { t: "call"; name: string; args: Node[] };

function parse(tokens: Token[]): Node {
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const next = (): Token | undefined => tokens[pos++];

  function parseComparison(): Node {
    let node = parseConcat();
    for (;;) {
      const t = peek();
      if (t && t.k === "op" && (t.v === "=" || t.v === "<>" || t.v === "<" || t.v === ">" || t.v === "<=" || t.v === ">=")) {
        next(); node = { t: "bin", op: t.v, l: node, r: parseConcat() };
      } else break;
    }
    return node;
  }
  function parseConcat(): Node {
    let node = parseAdd();
    for (;;) {
      const t = peek();
      if (t && t.k === "op" && t.v === "&") { next(); node = { t: "bin", op: "&", l: node, r: parseAdd() }; } else break;
    }
    return node;
  }
  function parseAdd(): Node {
    let node = parseMul();
    for (;;) {
      const t = peek();
      if (t && t.k === "op" && (t.v === "+" || t.v === "-")) { next(); node = { t: "bin", op: t.v, l: node, r: parseMul() }; } else break;
    }
    return node;
  }
  function parseMul(): Node {
    let node = parseUnary();
    for (;;) {
      const t = peek();
      if (t && t.k === "op" && (t.v === "*" || t.v === "/")) { next(); node = { t: "bin", op: t.v, l: node, r: parseUnary() }; } else break;
    }
    return node;
  }
  function parseUnary(): Node {
    const t = peek();
    if (t && t.k === "op" && (t.v === "-" || t.v === "+")) { next(); const x = parseUnary(); return t.v === "-" ? { t: "neg", x } : { t: "pos", x }; }
    return parsePower();
  }
  function parsePower(): Node {
    const base = parsePrimary();
    const t = peek();
    if (t && t.k === "op" && t.v === "^") { next(); return { t: "bin", op: "^", l: base, r: parseUnary() }; }
    return base;
  }
  function parsePrimary(): Node {
    const t = next();
    if (!t) throw new FormulaError("#SYNTAX! unexpected end of expression");
    if (t.k === "num") return { t: "num", v: t.v };
    if (t.k === "str") return { t: "str", v: t.v };
    if (t.k === "lp") {
      const inner = parseComparison();
      const close = next();
      if (!close || close.k !== "rp") throw new FormulaError("#SYNTAX! expected ')'");
      return inner;
    }
    if (t.k === "id") {
      const after = peek();
      if (after && after.k === "lp") {
        next();
        const args: Node[] = [];
        if (peek() && peek()!.k !== "rp") {
          args.push(parseComparison());
          while (peek() && peek()!.k === "comma") { next(); args.push(parseComparison()); }
        }
        const close = next();
        if (!close || close.k !== "rp") throw new FormulaError("#SYNTAX! expected ')' in function call");
        return { t: "call", name: t.v, args };
      }
      if (/^true$/i.test(t.v)) return { t: "bool", v: true };
      if (/^false$/i.test(t.v)) return { t: "bool", v: false };
      return { t: "var", name: t.v };
    }
    throw new FormulaError("#SYNTAX! unexpected token");
  }

  const ast = parseComparison();
  if (pos !== tokens.length) throw new FormulaError("#SYNTAX! unexpected trailing input");
  return ast;
}

function compareValues(l: FormulaValue, r: FormulaValue, op: string): boolean {
  const numeric = (typeof l === "number" || typeof l === "boolean") && (typeof r === "number" || typeof r === "boolean");
  let cmp: number;
  if (numeric) {
    const a = toNumber(l), b = toNumber(r);
    cmp = a < b ? -1 : a > b ? 1 : 0;
    if (Number.isNaN(a) || Number.isNaN(b)) return op === "<>";
  } else {
    const a = toText(l).toLowerCase(), b = toText(r).toLowerCase();
    cmp = a < b ? -1 : a > b ? 1 : 0;
  }
  switch (op) {
    case "=": return cmp === 0;
    case "<>": return cmp !== 0;
    case "<": return cmp < 0;
    case ">": return cmp > 0;
    case "<=": return cmp <= 0;
    case ">=": return cmp >= 0;
    default: throw new FormulaError(`#SYNTAX! unknown comparison '${op}'`);
  }
}

function evalNode(node: Node, scope: FormulaScope): FormulaValue {
  switch (node.t) {
    case "num": return node.v;
    case "str": return node.v;
    case "bool": return node.v;
    case "var":
      if (!scope.has(node.name)) throw new FormulaError(`#NAME? unknown name '${node.name}'`);
      return scope.get(node.name)!;
    case "neg": return -toNumber(evalNode(node.x, scope));
    case "pos": return +toNumber(evalNode(node.x, scope));
    case "bin": {
      const op = node.op;
      if (op === "&") return toText(evalNode(node.l, scope)) + toText(evalNode(node.r, scope));
      if (op === "=" || op === "<>" || op === "<" || op === ">" || op === "<=" || op === ">=") {
        return compareValues(evalNode(node.l, scope), evalNode(node.r, scope), op);
      }
      const a = toNumber(evalNode(node.l, scope)), b = toNumber(evalNode(node.r, scope));
      switch (op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return a / b;
        case "^": return Math.pow(a, b);
        default: throw new FormulaError(`#SYNTAX! unknown operator '${op}'`);
      }
    }
    case "call": return evalCall(node, scope);
  }
}

function nums(values: FormulaValue[]): number[] { return values.map(toNumber); }
function excelRound(x: number, digits: number): number {
  const f = Math.pow(10, digits);
  const y = Math.abs(x) * f;
  return (Math.sign(x) * Math.round(y)) / f;
}

const FUNCTIONS: Record<string, (args: FormulaValue[]) => FormulaValue> = {
  ABS: (a) => Math.abs(toNumber(a[0])),
  SIGN: (a) => Math.sign(toNumber(a[0])),
  INT: (a) => Math.floor(toNumber(a[0])),
  SQRT: (a) => { const x = toNumber(a[0]); if (x < 0) throw new FormulaError("#NUM! SQRT of negative"); return Math.sqrt(x); },
  EXP: (a) => Math.exp(toNumber(a[0])),
  LN: (a) => { const x = toNumber(a[0]); if (x <= 0) throw new FormulaError("#NUM! LN domain"); return Math.log(x); },
  LOG10: (a) => { const x = toNumber(a[0]); if (x <= 0) throw new FormulaError("#NUM! LOG10 domain"); return Math.log10(x); },
  LOG: (a) => { const x = toNumber(a[0]); const base = a.length > 1 ? toNumber(a[1]) : 10; if (x <= 0 || base <= 0) throw new FormulaError("#NUM! LOG domain"); return Math.log(x) / Math.log(base); },
  POWER: (a) => Math.pow(toNumber(a[0]), toNumber(a[1])),
  MOD: (a) => { const x = toNumber(a[0]); const d = toNumber(a[1]); if (d === 0) throw new FormulaError("#DIV/0! MOD"); return x - d * Math.floor(x / d); },
  TRUNC: (a) => { const x = toNumber(a[0]); const d = a.length > 1 ? toNumber(a[1]) : 0; const f = Math.pow(10, d); return Math.trunc(x * f) / f; },
  ROUND: (a) => excelRound(toNumber(a[0]), a.length > 1 ? toNumber(a[1]) : 0),
  ROUNDUP: (a) => { const d = a.length > 1 ? toNumber(a[1]) : 0; const f = Math.pow(10, d); const x = toNumber(a[0]); return (Math.sign(x) * Math.ceil(Math.abs(x) * f)) / f; },
  ROUNDDOWN: (a) => { const d = a.length > 1 ? toNumber(a[1]) : 0; const f = Math.pow(10, d); const x = toNumber(a[0]); return (Math.sign(x) * Math.floor(Math.abs(x) * f)) / f; },
  CEILING: (a) => { const x = toNumber(a[0]); const sig = a.length > 1 ? toNumber(a[1]) : 1; if (sig === 0) return 0; return Math.ceil(x / sig) * sig; },
  FLOOR: (a) => { const x = toNumber(a[0]); const sig = a.length > 1 ? toNumber(a[1]) : 1; if (sig === 0) return 0; return Math.floor(x / sig) * sig; },
  MIN: (a) => Math.min(...nums(a)),
  MAX: (a) => Math.max(...nums(a)),
  SUM: (a) => nums(a).reduce((x, y) => x + y, 0),
  PRODUCT: (a) => nums(a).reduce((x, y) => x * y, 1),
  AVERAGE: (a) => { const n = nums(a); if (n.length === 0) throw new FormulaError("#DIV/0! AVERAGE"); return n.reduce((x, y) => x + y, 0) / n.length; },
  COUNT: (a) => a.filter((v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)))).length,
  ISNUMBER: (a) => typeof a[0] === "number",
  ISBLANK: (a) => a[0] === "" || a[0] === undefined,
  CONCAT: (a) => a.map(toText).join(""),
  CONCATENATE: (a) => a.map(toText).join(""),
  LEFT: (a) => { const s = toText(a[0]); const n = a.length > 1 ? toNumber(a[1]) : 1; return s.slice(0, Math.max(0, n)); },
  RIGHT: (a) => { const s = toText(a[0]); const n = a.length > 1 ? toNumber(a[1]) : 1; return n <= 0 ? "" : s.slice(-n); },
  MID: (a) => { const s = toText(a[0]); const start = toNumber(a[1]); const len = toNumber(a[2]); return s.slice(Math.max(0, start - 1), Math.max(0, start - 1) + Math.max(0, len)); },
  LEN: (a) => toText(a[0]).length,
  UPPER: (a) => toText(a[0]).toUpperCase(),
  LOWER: (a) => toText(a[0]).toLowerCase(),
  TRIM: (a) => toText(a[0]).trim().replace(/\s+/g, " "),
  EXACT: (a) => toText(a[0]) === toText(a[1]),
  VALUE: (a) => toNumber(a[0]),
};

function evalCall(node: { name: string; args: Node[] }, scope: FormulaScope): FormulaValue {
  const name = node.name.toUpperCase();
  const args = node.args;
  switch (name) {
    case "IF":
      if (args.length < 2 || args.length > 3) throw new FormulaError("#VALUE! IF expects 2-3 args");
      if (toBoolean(evalNode(args[0], scope))) return evalNode(args[1], scope);
      return args.length === 3 ? evalNode(args[2], scope) : false;
    case "IFS":
      if (args.length < 2 || args.length % 2 !== 0) throw new FormulaError("#VALUE! IFS expects condition/value pairs");
      for (let i = 0; i + 1 < args.length; i += 2) if (toBoolean(evalNode(args[i], scope))) return evalNode(args[i + 1], scope);
      throw new FormulaError("#N/A IFS no match");
    case "AND":
      if (args.length === 0) throw new FormulaError("#VALUE! AND expects args");
      for (const a of args) if (!toBoolean(evalNode(a, scope))) return false;
      return true;
    case "OR":
      if (args.length === 0) throw new FormulaError("#VALUE! OR expects args");
      for (const a of args) if (toBoolean(evalNode(a, scope))) return true;
      return false;
    case "NOT":
      if (args.length !== 1) throw new FormulaError("#VALUE! NOT expects 1 arg");
      return !toBoolean(evalNode(args[0], scope));
    case "IFERROR":
      if (args.length !== 2) throw new FormulaError("#VALUE! IFERROR expects 2 args");
      try { return evalNode(args[0], scope); } catch { return evalNode(args[1], scope); }
    case "TRUE": return true;
    case "FALSE": return false;
  }
  const values = args.map((a) => evalNode(a, scope));
  const fn = FUNCTIONS[name];
  if (!fn) throw new FormulaError(`#NAME? unknown function '${name}'`);
  return fn(values);
}

function compile(expr: string): (scope: FormulaScope) => FormulaValue {
  const ast = parse(tokenize(expr));
  return (scope: FormulaScope) => evalNode(ast, scope);
}

function scopeFromEval(s: EvalScope): FormulaScope {
  const m: FormulaScope = new Map();
  for (const [k, v] of Object.entries(s)) if (v !== null) m.set(k, v);
  return m;
}

/** Test double for @api evaluateScoped: parse once (reject on syntax, like the
 *  real engine), evaluate per scope, surface per-row errors as "#…" strings. */
export async function fakeEvaluateScoped(expression: string, scopes: EvalScope[]): Promise<EvalResultValue[]> {
  const run = compile(expression); // throws on syntax → rejected promise (matches the engine)
  return scopes.map((s) => {
    try {
      return run(scopeFromEval(s)) as EvalResultValue;
    } catch (e) {
      return (e as Error).message; // "#…" error string
    }
  });
}

/** Test double for @api evaluateExpression. */
export async function fakeEvaluateExpression(expression: string, scope: EvalScope = {}): Promise<EvalResultValue> {
  const [r] = await fakeEvaluateScoped(expression, [scope]);
  return r;
}
