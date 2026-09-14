//! FILENAME: app/extensions/_shared/dsl/pivotLayout/nextEditFacts.ts
// PURPOSE: The two halves the rule engine cannot own: reduce a query's TEXT to
//          the facts the rules read, and apply the edit a rule proposes to
//          that text — as an edit, never as a re-serialisation.
// CONTEXT: `@api/designQueryAssist/nextEdit.ts` is pure and may not import
//          the DSL parser. This file parses with the real lexer and parser,
//          and it edits the person's text the way a person would: a field
//          added to the end of its clause, a clause created in the canonical
//          position, a field removed with its clause when it was the last one,
//          the serializer's one-field-per-line style kept when the text is in
//          it. Re-serialising the whole query would throw away every choice the
//          person made about spacing and order, and would make "accept" feel
//          like "replace".
//
// THIS FILE REWRITES TEXT THE PERSON TYPED, so it is written to lose nothing.
// An adversarial review of the first version found four ways it could, and all
// four are now closed and each has a test:
//
//   1. `[Customer.Owner's Key]` put the field splitter into a quote state that
//      the closing bracket did not end, so one edit swallowed the rest of the
//      clause. A quote is only a quote at bracket depth zero.
//   2. A `#` comment line was treated as a continuation of the clause above it,
//      so removing that clause's last field DELETED the comment. Comment lines
//      now end a block, and a block carrying a trailing comment is not edited
//      at all — a chip that quietly vanishes is a non-event; a deleted comment
//      is not.
//   3. `LOOKUP Customer.Key` and `"Order Date"` are both spellings the pivot's
//      own serializer writes, and neither matched the name the rules derive
//      from the AST, so every edit against them silently did nothing.
//   4. An `add-field` with a `before` anchor that did not match fell through to
//      an append — producing the OPPOSITE of the ordering the chip promised.

import { lex } from "./lexer";
import { parse } from "./parser";
import type { FieldNode } from "./ast";
import { splitBiFieldKey } from "../../lib/biFieldKey";
import {
  normalizeRef,
  roleOfSuggestion,
  suggestNextEdits,
  type NextEditRole,
  type DesignQueryModel,
  type EditOp,
  type FactField,
  type NextEditSuggestion,
  type PresentClauses,
  type QueryFacts,
} from "@api/designQueryAssist";

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/**
 * A field's DSL spelling and its `Table[Column]` key.
 *
 * The key is resolved with `splitBiFieldKey` and the MODEL's table names, never
 * with the parser's `node.table`/`node.column`: the parser documents that split
 * as non-semantic (it cuts at the first dot, and a table name may contain dots
 * — "BI.dim_product"). Every other consumer of this text re-splits the same way
 * (`designQuery.ts` does), and the strategy is keyed on the real table, so a
 * first-dot split makes every strategy rule silently miss on a schema-qualified
 * model.
 */
function fieldFacts(node: { name: string; table?: string; column?: string }, tableNames: readonly string[]): FactField {
  const ref = node.table && node.column ? dslRefOf(node.name) : node.name;
  const { table, column } = splitBiFieldKey(node.name, [...tableNames]);
  return { ref, qualified: table ? `${table}[${column}]` : null };
}

/** The DSL spelling of a dotted name: bracketed when a segment needs quoting. */
function dslRefOf(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(name) ? name : `[${name}]`;
}

/**
 * The facts of a query, from its text. Parse errors are reported, not thrown.
 *
 * `tableNames` comes from the model the rules will be run against; without it
 * the qualified keys fall back to a first-dot split, which is correct for every
 * model whose table names contain no dots.
 */
export function factsFromDsl(text: string, tableNames: readonly string[] = []): QueryFacts {
  const { tokens, errors: lexErrors } = lex(text);
  const { ast, errors: parseErrors } = parse(tokens);
  const axis = (nodes: FieldNode[]): FactField[] => nodes.map((n) => fieldFacts(n, tableNames));
  return {
    rows: axis(ast.rows),
    columns: axis(ast.columns),
    values: ast.values.map((v) => ({
      ...(v.isMeasure
        ? { ref: v.fieldName, qualified: null }
        : fieldFacts({ name: v.fieldName, table: v.table, column: v.column }, tableNames)),
      isMeasure: v.isMeasure,
      aggregation: v.aggregation,
      showAs: v.showValuesAs,
    })),
    filters: ast.filters.map((f) => ({
      ...fieldFacts({ name: f.fieldName, table: f.table, column: f.column }, tableNames),
      exclude: f.exclude,
      valueCount: f.values.length,
    })),
    sort: ast.sort.map((s) => ({ ref: s.fieldName, direction: s.direction })),
    topN: ast.topN ? { top: ast.topN.top, count: ast.topN.count, by: ast.topN.byField } : null,
    layout: ast.layout.map((d) => d.key),
    hasParseErrors: lexErrors.length > 0 || parseErrors.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Editing the text
// ---------------------------------------------------------------------------

/** Canonical clause order; TOP and BOTTOM share a slot. */
const CLAUSE_ORDER = ["ROWS", "COLUMNS", "VALUES", "FILTERS", "SORT", "TOP", "LAYOUT", "CALC", "SAVE"];

function orderOf(clause: string): number {
  const key = clause === "BOTTOM" ? "TOP" : clause;
  const i = CLAUSE_ORDER.indexOf(key);
  return i < 0 ? CLAUSE_ORDER.length : i;
}

interface Block {
  /** Upper-case keyword: ROWS, COLUMNS, VALUES, FILTERS, SORT, TOP, BOTTOM, LAYOUT, CALC, SAVE. */
  clause: string;
  /** Line indexes, `end` exclusive. */
  start: number;
  end: number;
}

const CLAUSE_START = /^\s*(ROWS|COLUMNS|VALUES|FILTERS|SORT|LAYOUT|CALC)\s*:/i;
const RANK_START = /^\s*(TOP|BOTTOM)\s+\d/i;
const SAVE_START = /^\s*SAVE\s+AS\b/i;

/** A `#` comment on its own line. The lexer makes these first-class tokens. */
export function isCommentLine(line: string): boolean {
  return line.trimStart().startsWith("#");
}

function clauseOf(line: string): string | null {
  const m = CLAUSE_START.exec(line);
  if (m) return m[1].toUpperCase();
  const r = RANK_START.exec(line);
  if (r) return r[1].toUpperCase();
  if (SAVE_START.test(line)) return "SAVE";
  return null;
}

/**
 * The clause blocks of a text: a keyword line and the lines that CONTINUE it.
 *
 * A comment line ends a block, and so does a blank line: a continuation must be
 * contiguous with the clause it continues. Without that, `# the board's list`
 * sitting under a ROWS clause was part of the ROWS block, and removing the
 * clause's last field deleted the person's comment with it.
 */
export function clauseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line) || line.trim() === "") continue;
    const clause = clauseOf(line);
    if (clause) {
      blocks.push({ clause, start: i, end: i + 1 });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last && last.end === i) last.end = i + 1;
  }
  return blocks;
}

/**
 * Where a trailing `# comment` starts on a line, or -1.
 *
 * Quotes and brackets are tracked, because `FILTERS: Tag = ("#1")` carries no
 * comment at all — and, exactly as in `splitFieldList`, a quote only opens a
 * quoted span at DEPTH ZERO. Without that, the apostrophe in
 * `[Customer.Owner's Key]` opened a span that never closed, this function
 * never reached the `#`, and the line was reported as carrying no comment —
 * so an edit rewrote it and the comment went with it.
 */
export function trailingCommentAt(line: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if ((ch === '"' || ch === "'") && depth === 0) {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "#" && depth === 0) return i;
  }
  return -1;
}

/**
 * Split a field list on the commas that are not inside brackets, parentheses
 * or quotes.
 *
 * A quote only opens a quoted span at DEPTH ZERO. Inside `[...]` the lexer
 * treats an apostrophe as ordinary content, so `[Customer.Owner's Key]` must
 * not put this splitter into a quote state — it did, and the unterminated span
 * then swallowed every later field in the clause into one entry that a
 * remove or replace rewrote wholesale.
 */
export function splitFieldList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of list) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if ((ch === '"' || ch === "'") && depth === 0) {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * The name a field entry starts with, in the spelling the AST reports.
 *
 * Handles every spelling the DSL permits and the serializer writes: a `LOOKUP `
 * prefix (the parser records it as a flag, not part of the name), a
 * `"quoted name"` (the parser strips the quotes), a `[Table.Column]` bracket,
 * a dotted chain, and a `.group(...)` / `.bin(...)` suffix that the parser
 * stops before.
 */
export function leadingRef(entry: string): string {
  let trimmed = entry.trim().replace(/^LOOKUP\s+/i, "");
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    return close > 0 ? trimmed.slice(0, close + 1) : trimmed;
  }
  if (trimmed.startsWith('"')) {
    const close = trimmed.indexOf('"', 1);
    return close > 0 ? trimmed.slice(0, close + 1) : trimmed;
  }
  const m = /^[A-Za-z_][\w.]*/.exec(trimmed);
  if (!m) return trimmed;
  // `Date.Month.group(months)` is the field `Date.Month`: the grouping call is
  // a suffix the parser stops before, so the name must stop there too.
  const grouping = /\.(group|bin)$/i.exec(m[0]);
  if (grouping && trimmed.slice(m[0].length).startsWith("(")) return m[0].slice(0, grouping.index);
  return m[0];
}

function sameField(entry: string, ref: string): boolean {
  return normalizeRef(leadingRef(entry)) === normalizeRef(ref);
}

/** The header (`ROWS:` with its spacing) and the list text of a block. */
function splitHeader(blockText: string): { header: string; list: string } {
  const m = /^(\s*[A-Za-z]+\s*:\s*)([\s\S]*)$/.exec(blockText);
  return m ? { header: m[1], list: m[2] } : { header: "", list: blockText };
}

/** Whether the text pads its keywords the serializer's way (`ROWS:    `). */
function usesPaddedHeaders(lines: string[]): boolean {
  return lines.some((l) => /^[A-Za-z]+:\s{2,}\S/.test(l));
}

function headerFor(clause: string, padded: boolean): string {
  const keyword = `${clause}:`;
  return padded ? keyword.padEnd(9, " ") : `${keyword} `;
}

function renderList(header: string, entries: string[], multiLine: boolean): string {
  if (!multiLine) return header + entries.join(", ");
  const indent = " ".repeat(header.length);
  return header + entries.join(`,\n${indent}`);
}

function insertLine(lines: string[], clause: string, line: string): string[] {
  const blocks = clauseBlocks(lines);
  const mine = orderOf(clause);
  let at = 0;
  for (const b of blocks) {
    if (orderOf(b.clause) <= mine) at = b.end;
  }
  const out = [...lines];
  out.splice(at, 0, line);
  return out;
}

/**
 * Apply one edit to the text. Returns the text UNCHANGED when the edit does
 * not apply — an unknown clause, a field that is not there, an anchor that is
 * not recognised, or a block carrying a trailing comment. The caller drops a
 * chip whose edit changed nothing, so "unchanged" is how this function refuses:
 * it never guesses, and it never rewrites a line it does not fully understand.
 */
export function applyEditOp(text: string, op: EditOp): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const padded = usesPaddedHeaders(lines);
  const blocks = clauseBlocks(lines);
  const find = (clause: string): Block | undefined => blocks.find((b) => b.clause === clause);
  /** A block whose own lines carry a trailing comment is not ours to rewrite. */
  const commented = (block: Block): boolean =>
    lines.slice(block.start, block.end).some((l) => trailingCommentAt(l) >= 0);
  const replaceBlock = (block: Block, replacement: string[]): string => {
    const out = [...lines];
    out.splice(block.start, block.end - block.start, ...replacement);
    return out.join("\n");
  };
  const listOf = (block: Block): { header: string; entries: string[]; multiLine: boolean } => {
    const blockText = lines.slice(block.start, block.end).join("\n");
    const { header, list } = splitHeader(blockText);
    return { header: header.replace(/\n[\s\S]*$/, ""), entries: splitFieldList(list), multiLine: list.includes("\n") };
  };

  switch (op.op) {
    case "add-field": {
      const block = find(op.clause);
      if (!block) {
        // A new clause cannot disturb anything: nothing is rewritten.
        if (op.before !== undefined) return text;
        const line = `${headerFor(op.clause, padded)}${op.text}`;
        return insertLine(lines, op.clause, line).join("\n");
      }
      if (commented(block)) return text;
      const { header, entries, multiLine } = listOf(block);
      if (entries.some((e) => sameField(e, op.text))) return text;
      const next = [...entries];
      if (op.before !== undefined) {
        const at = entries.findIndex((e) => sameField(e, op.before as string));
        // The anchor is the whole point of a positional add: appending instead
        // would produce the opposite ordering while the chip claimed otherwise.
        if (at < 0) return text;
        next.splice(at, 0, op.text);
      } else {
        next.push(op.text);
      }
      return replaceBlock(block, renderList(header, next, multiLine).split("\n"));
    }
    case "remove-field": {
      const block = find(op.clause);
      if (!block || commented(block)) return text;
      const { header, entries, multiLine } = listOf(block);
      const next = entries.filter((e) => !sameField(e, op.ref));
      if (next.length === entries.length) return text;
      if (next.length === 0) return replaceBlock(block, []);
      return replaceBlock(block, renderList(header, next, multiLine).split("\n"));
    }
    case "replace-field": {
      const block = find(op.clause);
      if (!block || commented(block)) return text;
      const { header, entries, multiLine } = listOf(block);
      if (!entries.some((e) => sameField(e, op.ref))) return text;
      const next = entries.map((e) => (sameField(e, op.ref) ? op.text : e));
      return replaceBlock(block, renderList(header, next, multiLine).split("\n"));
    }
    case "replace-clause": {
      const block = find("TOP") ?? find("BOTTOM");
      if (!block) return insertLine(lines, op.clause, op.line).join("\n");
      if (commented(block)) return text;
      return replaceBlock(block, [op.line]);
    }
    case "add-clause": {
      // A whole clause line, in canonical position. Refused when the query
      // already has that clause: this op only ever GROWS a query, so it can
      // never rewrite a line and therefore never lose anything.
      const clause = op.clause.toUpperCase();
      const already = clause === "TOP" || clause === "BOTTOM" ? find("TOP") ?? find("BOTTOM") : find(clause);
      if (already) return text;
      return insertLine(lines, clause, op.line).join("\n");
    }
  }
}

/** Which clauses a query already has, for `buildNextClauseGrammar`. */
export function presentClauses(facts: QueryFacts): PresentClauses {
  return {
    rows: facts.rows.length > 0,
    columns: facts.columns.length > 0,
    values: facts.values.length > 0,
    filters: facts.filters.length > 0,
    sort: facts.sort.length > 0,
    topN: facts.topN !== null,
    layout: facts.layout.length > 0,
  };
}

// ---------------------------------------------------------------------------
// What the row would actually show
// ---------------------------------------------------------------------------

/** How many chips the row shows. Three is what a person reads; the rest wait their turn. */
export const MAX_CHIPS = 3;

/**
 * What the row needs back from a compile. Structural on purpose: the real
 * `CompiledDesignQuery` satisfies it, and so does a test's double, without this
 * file importing `./designQuery` — that module re-exports through `./index`,
 * and a cycle through a barrel is a debugging afternoon nobody needs.
 */
export interface CompileVerdict {
  readonly request: unknown;
  readonly errors: readonly unknown[];
  readonly warnings?: readonly unknown[];
}

/**
 * Did the edit make the query worse than it already was?
 *
 * "NO WORSE", not "clean". An absolute bar looked stricter and was wrong: the
 * hosts substitute `@Name` control parameters before they compile and this
 * check does not, so every query using the Reports binding failed an absolute
 * bar and the whole row vanished — on exactly the half-finished queries where a
 * suggestion is worth most.
 */
export function worseThan(before: CompileVerdict, after: CompileVerdict): boolean {
  if (before.request !== null && after.request === null) return true;
  if (after.errors.length > before.errors.length) return true;
  if ((after.warnings?.length ?? 0) > (before.warnings?.length ?? 0)) return true;
  return false;
}

/** A chip the row shows. `applied` is the preview the veto judged, never what accept writes. */
export interface NextEditChip {
  suggestion: NextEditSuggestion;
  applied: string;
}

/**
 * The Tier-0 chips for a text: the rules' suggestions, each applied and judged,
 * the dismissed ones left out, at most `MAX_CHIPS`.
 *
 * ONE definition of "what the row would show", because three places need it and
 * they must not drift: the row itself, the corpus gate in
 * `nextEditCorpus.test.ts`, and the offline runner
 * `tests/eval/run-next-edit-eval.mjs`. A runner measuring its own copy of this
 * loop would report a number about the copy — and the copy is where a veto
 * quietly turns from "no worse" into "must compile clean" and the measured
 * recall moves for a reason nobody can find.
 */
export function rulesChips(
  text: string,
  model: DesignQueryModel,
  tableNames: readonly string[],
  compile: ((dsl: string) => CompileVerdict) | null,
  dismissed: ReadonlySet<string> = new Set(),
  max: number = MAX_CHIPS,
  /**
   * Which roles may be returned. Defaults to both.
   *
   * The GHOST TEXT passes `["correction"]`. Owner decision 2026-09-14: an
   * exploration is an idea you can ignore, and a chip lets you ignore it, while
   * text at the cursor does not. The inline surface also asks for up to EIGHT
   * suggestions against the row's three, so letting the family through there
   * would put the most speculative material in the most intrusive place at
   * nearly triple the volume.
   */
  roles: ReadonlyArray<NextEditRole> = ["correction", "exploration"],
): NextEditChip[] {
  if (!text.trim()) return [];
  const facts = factsFromDsl(text, tableNames);
  const before = compile ? compile(text) : null;
  const chips: NextEditChip[] = [];
  for (const suggestion of suggestNextEdits(facts, model)) {
    if (!roles.includes(roleOfSuggestion(suggestion))) continue;
    if (dismissed.has(suggestion.id)) continue;
    const applied = applyEditOp(text, suggestion.op);
    if (applied === text) continue;
    if (compile && before && worseThan(before, compile(applied))) continue;
    chips.push({ suggestion, applied });
    if (chips.length >= max) break;
  }
  return chips;
}
