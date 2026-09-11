//! FILENAME: app/extensions/FormulaAssist/__tests__/formulaGrammar.test.ts
// PURPOSE: The formula grammar and the product agree in BOTH directions:
//          every real formula the repo vouches for is accepted, and every
//          string the grammar can produce is a proposal the extractor reads.
// CONTEXT: The same discipline as the design-query grammar test. The
//          acceptance direction is the one that matters most: a grammar that
//          forbade a shape the engine accepts would make a runtime that
//          honours it WORSE than one that ignores it, silently, on exactly the
//          formulas that shape appears in. So every reference in the eval
//          corpus and every formula in the verified pattern library is
//          rendered the way a model must render it (inside the JSON envelope,
//          via JSON.stringify) and matched against the grammar.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildFormulaGrammar, extractProposal } from "@api/formulaAssist";
import { FORMULA_PATTERNS } from "@api/formulaAssist/generated/formulaPatterns";
import { matchGbnf, parseGbnf, sampleGbnf } from "../../_shared/dsl/pivotLayout/gbnfTestKit";

const corpus = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../../tests/eval/formulas.json"), "utf8"),
) as { tasks: Array<{ id: string; reference: string; distractor?: string | { formula: string } }> };

const grammar = parseGbnf(buildFormulaGrammar());
const lean = parseGbnf(buildFormulaGrammar({ lean: true }));

/** The reply a model would produce for `formula`, rendered as JSON renders it. */
function reply(formula: string, extra: Partial<{ explanation: string; assumptions: string[]; fillDown: boolean }> = {}): string {
  return JSON.stringify({
    formula,
    explanation: extra.explanation ?? "One sentence.",
    assumptions: extra.assumptions ?? [],
    fillDown: extra.fillDown ?? false,
  });
}

function accepts(formula: string, g = grammar): boolean {
  return matchGbnf(g, reply(formula));
}

describe("the grammar parses in the kit (the subset llama.cpp documents)", () => {
  it("has a root and the rules the envelope needs", () => {
    expect(grammar.has("root")).toBe(true);
    expect(grammar.has("expr")).toBe(true);
    expect(lean.has("root")).toBe(true);
  });
});

describe("every formula the repo vouches for is accepted", () => {
  it("accepts every reference in the eval corpus", () => {
    const refused = corpus.tasks.filter((t) => !accepts(t.reference)).map((t) => `${t.id}: ${t.reference}`);
    expect(corpus.tasks.length).toBeGreaterThan(40);
    expect(refused, "corpus references the grammar refuses").toEqual([]);
  });

  it("accepts every distractor too — the grammar is about syntax, not meaning", () => {
    const distractors = corpus.tasks
      .map((t) => (typeof t.distractor === "string" ? t.distractor : t.distractor?.formula))
      .filter((d): d is string => Boolean(d));
    expect(distractors.length).toBeGreaterThan(20);
    const refused = distractors.filter((d) => !accepts(d));
    expect(refused).toEqual([]);
  });

  it("accepts every formula in the verified pattern library", () => {
    expect(FORMULA_PATTERNS.length).toBeGreaterThan(200);
    const refused = FORMULA_PATTERNS.filter((p) => !accepts(p.formula)).map((p) => `${p.id}: ${p.formula}`);
    expect(refused, "pattern-library formulas the grammar refuses").toEqual([]);
  });
});

describe("the shapes a person types", () => {
  it.each([
    ["a quoted sheet name", "='Sheet 1'!A1"],
    ["a bare sheet name", "=Sales!B2:B9"],
    ["an omitted argument", "=IF(A1>0,,B1)"],
    ["a doubled quote inside text", '="a""b"'],
    ["a backslash inside text", '="C:\\temp"'],
    ["a structured reference with a special item", "=SUM(Table1[[#Headers],[Amount]])"],
    ["an @ structured reference", "=[@Amount]*2"],
    ["a percent postfix", "=-A1%"],
    ["a spill reference", "=SUM(A1#)"],
    ["an array constant", "={1,2;3,4}"],
    ["a range built from a function", "=SUM(A1:INDEX(B:B,3))"],
    ["scientific notation", "=1E-5*2.5"],
    ["an error literal", "=IFERROR(#N/A,0)"],
    ["a whole-column and whole-row range", "=SUMPRODUCT(A:A,1:1)"],
    ["absolute references", "=$A$1+A$2+$A3"],
    ["a LET with names", "=LET(x,A1,y,B1,x*y)"],
    ["a LAMBDA", "=LAMBDA(a,b,a+b)(1,2)"],
    ["spaces around operators", "=A1 + B1 * 2"],
    ["comparison operators", "=IF(A1<>B1,A1<=B1,A1>=B1)"],
    ["the concatenation operator and a string", '=A1&" "&B1'],
    ["implicit intersection", "=@A:A"],
    ["a decimal without a leading digit", "=.5*A1"],
    ["a Swedish text literal", '=COUNTIF(A:A,"Skickad")'],
  ])("accepts %s", (_label, formula) => {
    expect(accepts(formula)).toBe(true);
  });

  it("refuses what the engine would refuse: a localized separator, an open parenthesis, a raw quote", () => {
    expect(accepts("=SUMMA(A1;B1)"), "semicolon separators are the localized failure").toBe(false);
    expect(accepts("=SUM(A1,B1"), "an unbalanced call").toBe(false);
    expect(accepts("=SUM(A1,B1))"), "an extra parenthesis").toBe(false);
    expect(accepts('="unterminated'), "an open text literal").toBe(false);
    expect(accepts("SUM(A1)"), "no leading = is not a proposal").toBe(false);
    expect(accepts("=A1 B1"), "two operands with no operator").toBe(false);
  });

  it("bounds every repetition, so a model cannot loop inside the law", () => {
    // Measured on the built-in runtime: `TEXTSPLIT(B2, '|)` — a single quote
    // where a text literal belonged opened a "sheet name" that swallowed the
    // rest of the formula, and twelve replies ran to the token limit.
    expect(accepts("=TEXTSPLIT(B2, '|)"), "punctuation inside a quoted sheet name").toBe(false);
    expect(accepts("='Sheet (1)'!A1"), "parentheses in a sheet name").toBe(false);
    expect(accepts("='Försäljning 2024'!A1"), "a Swedish sheet name is fine").toBe(true);
    expect(accepts(`='${"x".repeat(32)}'!A1`), "past Excel's 31-character sheet-name limit").toBe(false);
    expect(accepts(`="${"x".repeat(121)}"`), "a 121-character text literal").toBe(false);
    expect(accepts(`="${"x".repeat(120)}"`)).toBe(true);
    expect(matchGbnf(grammar, reply("=A1").replace('{"', '{' + " ".repeat(5) + '"')), "five spaces of JSON whitespace").toBe(false);
    expect(matchGbnf(grammar, reply("=A1").replace('{"', '{' + " ".repeat(4) + '"'))).toBe(true);
    // No unbounded repetition survives in the grammar text itself.
    const text = buildFormulaGrammar();
    const unbounded = text.split("\n").filter((l) => /[\]")]\s*[*+](\s|$)/.test(l));
    expect(unbounded, "rules with a * or + repetition").toEqual([]);
  });

  it("holds the envelope to the schema's shape", () => {
    // The lean grammar has no assumptions field, and the full one requires it.
    expect(matchGbnf(lean, JSON.stringify({ formula: "=A1", explanation: "x", fillDown: true }))).toBe(true);
    expect(matchGbnf(grammar, JSON.stringify({ formula: "=A1", explanation: "x", fillDown: true }))).toBe(false);
    expect(matchGbnf(lean, reply("=A1"))).toBe(false);
    // At most three assumptions, and an explanation bounded like the schema's.
    expect(accepts("=A1") && matchGbnf(grammar, reply("=A1", { assumptions: ["a", "b", "c"] }))).toBe(true);
    expect(matchGbnf(grammar, reply("=A1", { assumptions: ["a", "b", "c", "d"] }))).toBe(false);
    expect(matchGbnf(grammar, reply("=A1", { explanation: "x".repeat(240) }))).toBe(true);
    expect(matchGbnf(grammar, reply("=A1", { explanation: "x".repeat(241) }))).toBe(false);
    // Pretty-printed JSON is still JSON.
    expect(matchGbnf(grammar, JSON.stringify({ formula: "=A1", explanation: "x", assumptions: [], fillDown: false }, null, 2))).toBe(true);
  });
});

describe("everything the grammar produces is a proposal the extractor reads", () => {
  it("samples parse as proposals with balanced formulas", () => {
    let seen = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const sample = sampleGbnf(grammar, seed, { maxRepeat: 2, maxDepth: 10 });
      const proposal = extractProposal(sample);
      expect(proposal, `seed ${seed} produced no proposal: ${sample}`).not.toBeNull();
      const formula = proposal!.formula;
      expect(formula.startsWith("="), `seed ${seed}: ${formula}`).toBe(true);
      let depth = 0;
      let inText = false;
      for (let i = 0; i < formula.length; i++) {
        const c = formula[i];
        if (c === '"') inText = !inText;
        if (inText) continue;
        if (c === "(") depth++;
        if (c === ")") depth--;
        expect(depth, `seed ${seed}: unbalanced at ${i} in ${formula}`).toBeGreaterThanOrEqual(0);
      }
      expect(depth, `seed ${seed}: unbalanced ${formula}`).toBe(0);
      expect(inText, `seed ${seed}: open text literal ${formula}`).toBe(false);
      expect(formula.includes(";") && !formula.includes("{"), `seed ${seed}: a semicolon outside an array ${formula}`).toBe(false);
      seen++;
    }
    expect(seen).toBe(300);
  });
});
