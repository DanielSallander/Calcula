//! FILENAME: app/src/api/formulaAssist/normalize.ts
// PURPOSE: Get a formula out of whatever the model actually said, and put it in
//          the one form the engine accepts.
// CONTEXT: This is rung F0 of the formula ladder, and it exists because a model
//          that was asked for JSON does not always send JSON. A schema-honouring
//          runtime returns a clean object; a runtime that ignores
//          `response_format` returns prose with the answer somewhere inside it.
//          Refusing the second case would measure the RUNTIME rather than the
//          model, so the extraction is tolerant — and the verifier downstream is
//          not, which is where the strictness belongs.
//
//          DELOCALIZATION IS DETECTED, NOT PERFORMED. A model that writes
//          `=SUMMA(A1;B1)` has produced a localized formula, and the honest
//          answer is to say so: rewriting it here would hide a real failure
//          behind a repair this module is not qualified to make. `looksLocalized`
//          reports it; the caller decides.

import type { FormulaProposal } from "./types";

/** Strip fences, backticks and a leading `=`, and trim. */
function bareFormula(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/```$/, "").trim();
  s = s.replace(/^`+|`+$/g, "").trim();
  return s;
}

/** The canonical stored form: exactly one leading `=`, no fences, trimmed. */
export function normalizeFormula(raw: string): string {
  const s = bareFormula(raw).replace(/^=+/, "").trim();
  return s ? `=${s}` : "";
}

/**
 * Does this formula use a locale's argument separator?
 *
 * A `;` OUTSIDE a string literal is the signal. Inside `{}` it is an array-row
 * separator and legitimate, so brace depth is tracked; without that check every
 * array constant would be misreported.
 */
export function looksLocalized(formula: string): boolean {
  let inString = false;
  let braces = 0;
  for (let i = 0; i < formula.length; i++) {
    const ch = formula[i];
    if (ch === '"') {
      // A doubled quote inside a string is an escaped quote, not a terminator.
      if (inString && formula[i + 1] === '"') {
        i++;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") braces++;
    else if (ch === "}") braces = Math.max(0, braces - 1);
    else if (ch === ";" && braces === 0) return true;
  }
  return false;
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

function coerce(value: unknown): FormulaProposal | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  const formula = typeof o.formula === "string" ? normalizeFormula(o.formula) : "";
  if (!formula) return null;
  return {
    formula,
    explanation: typeof o.explanation === "string" ? o.explanation : "",
    assumptions: Array.isArray(o.assumptions)
      ? o.assumptions.filter((a): a is string => typeof a === "string")
      : [],
    fillDown: o.fillDown === true,
  };
}

/**
 * Pull a proposal out of a model reply.
 *
 * Three attempts, most trustworthy first: the whole reply as JSON, the first
 * balanced object inside it, then a bare formula line. Returns null when the
 * reply contains no formula at all, which is a real outcome and must not be
 * confused with an empty one.
 */
export function extractProposal(reply: string): FormulaProposal | null {
  const text = reply.trim();
  if (!text) return null;

  try {
    const direct = coerce(JSON.parse(text));
    if (direct) return direct;
  } catch {
    /* not a bare JSON document; try the shapes below */
  }

  const embedded = firstJsonObject(text);
  if (embedded) {
    try {
      const parsed = coerce(JSON.parse(embedded));
      if (parsed) return parsed;
    } catch {
      /* a brace-looking span that is not JSON; fall through */
    }
  }

  // A TRUNCATED JSON object still contains the formula, and the formula is the
  // only field that decides anything.
  //
  // This is not a hypothetical. Measured 2026-09-07: qwen2.5-coder:1.5b wrote a
  // perfectly correct `=SUMIFS(...)` and then looped in `assumptions`, repeating
  // one sentence until it hit the reply limit. The object never closed, so
  // `JSON.parse` failed and the balanced-object scan found nothing — and 51 of
  // 60 tasks were scored as "no formula" against a model that had answered
  // every one of them. Without this the corpus measures the reply budget.
  const field = /"formula"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (field) {
    const unescaped = field[1]
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\\\/g, "\\");
    const formula = normalizeFormula(unescaped);
    if (formula) return { formula, explanation: "", assumptions: [], fillDown: false };
  }

  // A model that ignored the schema usually still writes the formula on a line
  // of its own, often fenced. Take the first line that starts with `=`.
  const lines = text.split(/\r?\n/).map((l) => bareFormula(l));
  const formulaLine = lines.find((l) => l.startsWith("="));
  if (formulaLine) {
    return {
      formula: normalizeFormula(formulaLine),
      explanation: "",
      assumptions: [],
      fillDown: false,
    };
  }
  return null;
}
