//! FILENAME: app/src/api/designQueryAssist/extract.ts
// PURPOSE: Get a design query out of whatever the model actually said.
// CONTEXT: A schema-honouring runtime returns a clean object; a grammar-
//          constrained one returns the bare query; a runtime that ignores both
//          returns prose with the query somewhere inside it, often in a code
//          fence, sometimes with every clause on one line. Refusing the
//          untidy cases would measure the RUNTIME rather than the model, so
//          extraction is tolerant and the compiler downstream is not — which
//          is where the strictness belongs.

import type { DesignQueryProposal } from "./types";
import { DSL_CLAUSE_KEYWORDS } from "./vocabulary";

/**
 * A line that starts a clause: a keyword and a colon, TOP/BOTTOM and a count,
 * or SAVE AS. `DSL_CLAUSE_KEYWORDS` is the closed list; the three shapes are
 * the parser's.
 */
const COLON_KEYWORDS = DSL_CLAUSE_KEYWORDS.filter((k) => !["TOP", "BOTTOM", "SAVE"].includes(k));
const CLAUSE_LINE = new RegExp(
  `^\\s*(?:(?:${COLON_KEYWORDS.join("|")})\\s*:|(?:TOP|BOTTOM)\\s+\\d|SAVE\\s+AS\\b)`,
  "i",
);

/**
 * Split clauses a model ran together on one line ("ROWS: X VALUES: [Y]") so
 * each starts its own line. Only a keyword followed by a colon, or TOP/BOTTOM
 * followed by a number, counts — a dimension called "Top Products" is not a
 * clause.
 */
export function normalizeDsl(raw: string): string {
  let text = raw.replace(/\r\n?/g, "\n");
  text = text.replace(/^```[a-zA-Z]*\s*/m, "").replace(/```\s*$/m, "");
  // Clauses glued to a preceding clause on the same line.
  text = text.replace(/[ \t]+(?=(?:ROWS|COLUMNS|VALUES|FILTERS|SORT|LAYOUT|CALC)\s*:)/gi, "\n");
  text = text.replace(/[ \t]+(?=(?:TOP|BOTTOM)\s+\d)/gi, "\n");
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .join("\n")
    .trim();
}

/** True when the text has at least one line that starts a clause. */
export function looksLikeDsl(text: string): boolean {
  return text.split("\n").some((l) => CLAUSE_LINE.test(l));
}

/** The first balanced `{...}` in a string, or null. */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\") {
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function coerce(value: unknown): DesignQueryProposal | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.dsl !== "string") return null;
  const dsl = normalizeDsl(o.dsl);
  if (!dsl || !looksLikeDsl(dsl)) return null;
  return { dsl, explanation: typeof o.explanation === "string" ? o.explanation : "" };
}

/**
 * Pull a proposal out of a reply.
 *
 * Three attempts, most trustworthy first: the whole reply as JSON, the first
 * balanced object inside it, then the reply itself as a bare query (the
 * grammar-constrained shape). Null when no clause line exists anywhere, which
 * is a real outcome and must not be confused with an empty query.
 */
export function extractDesignQuery(reply: string): DesignQueryProposal | null {
  const text = reply.trim();
  if (!text) return null;

  try {
    const whole = coerce(JSON.parse(text));
    if (whole) return whole;
  } catch {
    /* not JSON as a whole */
  }

  const inner = firstJsonObject(text);
  if (inner) {
    try {
      const found = coerce(JSON.parse(inner));
      if (found) return found;
    } catch {
      /* a brace that was not JSON */
    }
  }

  const bare = normalizeDsl(text);
  if (looksLikeDsl(bare)) {
    // Keep only the clause lines and what follows them: a model that wrote a
    // sentence before the query is not asking for the sentence to compile.
    const lines = bare.split("\n");
    const first = lines.findIndex((l) => CLAUSE_LINE.test(l));
    const kept: string[] = [];
    for (const line of lines.slice(first)) {
      if (CLAUSE_LINE.test(line) || /^\s+/.test(line) || kept.length === 0) kept.push(line.trim());
      else break;
    }
    return { dsl: kept.join("\n"), explanation: "" };
  }
  return null;
}
