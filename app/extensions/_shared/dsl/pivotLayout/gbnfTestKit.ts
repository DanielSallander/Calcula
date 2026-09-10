//! FILENAME: app/extensions/_shared/dsl/pivotLayout/gbnfTestKit.ts
// PURPOSE: A small GBNF engine — parse, sample, match — so a test can prove
//          that the grammar the assistant hands a runtime and the parser the
//          product runs agree.
// CONTEXT: TEST SUPPORT ONLY. Nothing in the product imports this. It covers
//          the subset of llama.cpp's GBNF the assistant emits: rules `name ::=
//          ...`, quoted terminals with `\"` `\\` `\n` `\t` escapes, character
//          classes with ranges and `^` negation, alternation, parentheses and
//          the `?` `*` `+` repetitions. Anything else is a parse error here,
//          which is the right answer for a grammar the runtime would also
//          refuse.
//
//          Sampling is deterministic from a seed and bounded in depth and
//          repetition, so a run that finds a defect can be re-run to the same
//          string. Matching is a backtracking search; the strings are short.

export type GbnfRep = "" | "?" | "*" | "+";

export type GbnfItem =
  | { kind: "term"; text: string }
  | { kind: "class"; negate: boolean; ranges: Array<[number, number]> }
  | { kind: "ref"; name: string }
  | { kind: "group"; alternatives: GbnfSeq[] };

export interface GbnfSeq {
  items: Array<{ item: GbnfItem; rep: GbnfRep }>;
}

export type GbnfGrammar = Map<string, GbnfSeq[]>;

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

class Reader {
  pos = 0;
  constructor(readonly text: string) {}
  peek(): string {
    return this.text[this.pos] ?? "";
  }
  next(): string {
    return this.text[this.pos++] ?? "";
  }
  done(): boolean {
    return this.pos >= this.text.length;
  }
  skipSpaces(): void {
    while (!this.done() && (this.peek() === " " || this.peek() === "\t")) this.pos++;
  }
}

function unescape(ch: string): string {
  switch (ch) {
    case "n": return "\n";
    case "t": return "\t";
    case "r": return "\r";
    case '"': return '"';
    case "\\": return "\\";
    case "]": return "]";
    case "[": return "[";
    case "-": return "-";
    default: throw new Error(`gbnf: unsupported escape \\${ch}`);
  }
}

function parseTerminal(r: Reader): GbnfItem {
  r.next(); // opening quote
  let text = "";
  for (;;) {
    if (r.done()) throw new Error("gbnf: unterminated terminal");
    const ch = r.next();
    if (ch === '"') break;
    if (ch === "\\") text += unescape(r.next());
    else text += ch;
  }
  return { kind: "term", text };
}

function parseClass(r: Reader): GbnfItem {
  r.next(); // [
  let negate = false;
  if (r.peek() === "^") {
    negate = true;
    r.next();
  }
  const ranges: Array<[number, number]> = [];
  for (;;) {
    if (r.done()) throw new Error("gbnf: unterminated class");
    let ch = r.next();
    if (ch === "]") break;
    if (ch === "\\") ch = unescape(r.next());
    let lo = ch.codePointAt(0)!;
    let hi = lo;
    if (r.peek() === "-" && r.text[r.pos + 1] !== "]") {
      r.next();
      let end = r.next();
      if (end === "\\") end = unescape(r.next());
      hi = end.codePointAt(0)!;
    }
    ranges.push([lo, hi]);
  }
  return { kind: "class", negate, ranges };
}

function parseAlternatives(r: Reader, stopAtParen: boolean): GbnfSeq[] {
  const alternatives: GbnfSeq[] = [];
  let seq: GbnfSeq = { items: [] };
  for (;;) {
    r.skipSpaces();
    if (r.done() || r.peek() === "\n") break;
    const ch = r.peek();
    if (ch === ")") {
      if (!stopAtParen) throw new Error("gbnf: unexpected )");
      break;
    }
    if (ch === "|") {
      r.next();
      alternatives.push(seq);
      seq = { items: [] };
      continue;
    }
    let item: GbnfItem;
    if (ch === '"') item = parseTerminal(r);
    else if (ch === "[") item = parseClass(r);
    else if (ch === "(") {
      r.next();
      const inner = parseAlternatives(r, true);
      if (r.next() !== ")") throw new Error("gbnf: expected )");
      item = { kind: "group", alternatives: inner };
    } else if (/[A-Za-z0-9-]/.test(ch)) {
      let name = "";
      while (!r.done() && /[A-Za-z0-9-]/.test(r.peek())) name += r.next();
      item = { kind: "ref", name };
    } else {
      throw new Error(`gbnf: unexpected character ${JSON.stringify(ch)} at ${r.pos}`);
    }
    let rep: GbnfRep = "";
    const post = r.peek();
    if (post === "?" || post === "*" || post === "+") {
      rep = post;
      r.next();
    }
    seq.items.push({ item, rep });
  }
  alternatives.push(seq);
  return alternatives;
}

/** Parse a grammar. Throws on anything outside the supported subset. */
export function parseGbnf(text: string): GbnfGrammar {
  const grammar: GbnfGrammar = new Map();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const m = /^([A-Za-z0-9-]+)\s*::=\s*(.*)$/.exec(line);
    if (!m) throw new Error(`gbnf: not a rule: ${line}`);
    const r = new Reader(m[2]);
    const alternatives = parseAlternatives(r, false);
    if (!r.done()) throw new Error(`gbnf: trailing text in rule ${m[1]}`);
    grammar.set(m[1], alternatives);
  }
  if (!grammar.has("root")) throw new Error("gbnf: no root rule");
  for (const alternatives of grammar.values()) {
    for (const seq of alternatives) {
      for (const { item } of seq.items) checkRefs(item, grammar);
    }
  }
  return grammar;
}

function checkRefs(item: GbnfItem, grammar: GbnfGrammar): void {
  if (item.kind === "ref" && !grammar.has(item.name)) throw new Error(`gbnf: undefined rule ${item.name}`);
  if (item.kind === "group") {
    for (const seq of item.alternatives) for (const { item: inner } of seq.items) checkRefs(inner, grammar);
  }
}

// ---------------------------------------------------------------------------
// Sample
// ---------------------------------------------------------------------------

/** mulberry32: small, seedable, good enough for a sampler. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLASS_ALPHABET = "abcxyzABC 09_-.";

function sampleClass(item: Extract<GbnfItem, { kind: "class" }>, rnd: () => number): string {
  const inRanges = (code: number) => item.ranges.some(([lo, hi]) => code >= lo && code <= hi);
  if (item.negate) {
    const pool = [...CLASS_ALPHABET].filter((c) => !inRanges(c.codePointAt(0)!));
    return pool[Math.floor(rnd() * pool.length)];
  }
  const [lo, hi] = item.ranges[Math.floor(rnd() * item.ranges.length)];
  return String.fromCodePoint(lo + Math.floor(rnd() * (hi - lo + 1)));
}

export interface SampleOptions {
  /** Repetitions for `*` (0..maxRepeat) and `+` (1..maxRepeat). */
  maxRepeat?: number;
  /** Past this depth every `?`/`*` collapses to nothing and `+` to one. */
  maxDepth?: number;
}

/** One string from the grammar, from the seed. */
export function sampleGbnf(grammar: GbnfGrammar, seed: number, opts: SampleOptions = {}): string {
  const rnd = prng(seed);
  const maxRepeat = opts.maxRepeat ?? 2;
  const maxDepth = opts.maxDepth ?? 12;

  function alternatives(alts: GbnfSeq[], depth: number): string {
    const pick = alts[Math.floor(rnd() * alts.length)];
    return pick.items.map(({ item, rep }) => repeat(item, rep, depth)).join("");
  }

  function repeat(item: GbnfItem, rep: GbnfRep, depth: number): string {
    const deep = depth >= maxDepth;
    let count = 1;
    if (rep === "?") count = deep ? 0 : Math.floor(rnd() * 2);
    else if (rep === "*") count = deep ? 0 : Math.floor(rnd() * (maxRepeat + 1));
    else if (rep === "+") count = deep ? 1 : 1 + Math.floor(rnd() * maxRepeat);
    let out = "";
    for (let i = 0; i < count; i++) out += one(item, depth + 1);
    return out;
  }

  function one(item: GbnfItem, depth: number): string {
    switch (item.kind) {
      case "term": return item.text;
      case "class": return sampleClass(item, rnd);
      case "ref": return alternatives(grammar.get(item.name)!, depth);
      case "group": return alternatives(item.alternatives, depth);
    }
  }

  return alternatives(grammar.get("root")!, 0);
}

// ---------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------

/** True when the whole of `text` is derivable from `root`. */
export function matchGbnf(grammar: GbnfGrammar, text: string): boolean {
  type K = (pos: number) => boolean;

  function alternatives(alts: GbnfSeq[], pos: number, k: K): boolean {
    return alts.some((seq) => sequence(seq, 0, pos, k));
  }

  function sequence(seq: GbnfSeq, index: number, pos: number, k: K): boolean {
    if (index === seq.items.length) return k(pos);
    const { item, rep } = seq.items[index];
    return repeat(item, rep, pos, (p) => sequence(seq, index + 1, p, k));
  }

  function repeat(item: GbnfItem, rep: GbnfRep, pos: number, k: K): boolean {
    switch (rep) {
      case "": return one(item, pos, k);
      case "?": return one(item, pos, k) || k(pos);
      case "*": return one(item, pos, (p) => p > pos && repeat(item, "*", p, k)) || k(pos);
      case "+": return one(item, pos, (p) => repeat(item, "*", p, k));
    }
  }

  function one(item: GbnfItem, pos: number, k: K): boolean {
    switch (item.kind) {
      case "term":
        return text.startsWith(item.text, pos) && k(pos + item.text.length);
      case "class": {
        if (pos >= text.length) return false;
        const code = text.codePointAt(pos)!;
        const hit = item.ranges.some(([lo, hi]) => code >= lo && code <= hi);
        return hit !== item.negate && k(pos + String.fromCodePoint(code).length);
      }
      case "ref":
        return alternatives(grammar.get(item.name)!, pos, k);
      case "group":
        return alternatives(item.alternatives, pos, k);
    }
  }

  return alternatives(grammar.get("root")!, 0, (p) => p === text.length);
}
