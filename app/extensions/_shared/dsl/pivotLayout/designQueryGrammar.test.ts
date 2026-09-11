//! FILENAME: app/extensions/_shared/dsl/pivotLayout/designQueryGrammar.test.ts
// PURPOSE: The grammar the assistant hands a runtime and the parser the
//          product runs agree, in both directions.
// CONTEXT: Forward: hundreds of strings SAMPLED from the grammar all compile
//          against the fixture model with no error — so the grammar cannot
//          produce a query the compiler refuses. Reverse: every corpus
//          reference MATCHES the grammar built from its own intent's
//          candidates — so the grammar cannot forbid a query the corpus calls
//          right. A grammar that passed only one direction would either let a
//          runtime emit garbage or stop it from emitting the answer.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { buildDesignQueryGrammar, buildExamples, chooseCandidates, type DesignQueryModel } from "@api/designQueryAssist";
import { compileDesignQuery } from "./designQuery";
import { matchGbnf, parseGbnf, sampleGbnf } from "./gbnfTestKit";
import type { BiPivotModelInfo } from "../../components/types";
import { modelInfoFromFixture, strategySummaryFromFixture } from "../../../../../tests/eval/lib/modelFixture.mjs";

const REPO = path.resolve(__dirname, "../../../../..");
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf8"));

const bundle = read("tests/fixtures/model/sales_star.json");
const strategyDoc = read("tests/fixtures/model/sales_star_strategy.json");
const corpus = read("tests/eval/design-queries.json") as {
  tasks: Array<{ id: string; intent: string; reference: string }>;
};
const model: BiPivotModelInfo = {
  ...modelInfoFromFixture(bundle),
  strategy: strategySummaryFromFixture(strategyDoc, bundle),
};

describe("the GBNF test kit itself", () => {
  const g = parseGbnf('root ::= "a" ("b" | "c")* [x-z]? "!"\n');

  it("samples strings its own matcher accepts", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const s = sampleGbnf(g, seed);
      expect(matchGbnf(g, s), s).toBe(true);
    }
  });

  it("rejects what the grammar does not describe (a matcher that always says yes is no matcher)", () => {
    expect(matchGbnf(g, "a!")).toBe(true);
    expect(matchGbnf(g, "abcbz!")).toBe(true);
    expect(matchGbnf(g, "ad!")).toBe(false);
    expect(matchGbnf(g, "a")).toBe(false);
    expect(matchGbnf(g, "axx!")).toBe(false);
  });

  it("refuses a grammar outside the supported subset rather than guessing", () => {
    expect(() => parseGbnf('root ::= "a" {2,3}\n')).toThrow();
    expect(() => parseGbnf('root ::= missing\n')).toThrow();
  });
});

describe("the design-query grammar", () => {
  const intents = ["revenue by region", "customers per segment over time", "a breakdown please"];

  for (const intent of intents) {
    it(`every sampled query compiles without error — "${intent}"`, () => {
      const candidates = chooseCandidates(model as DesignQueryModel, intent);
      const text = buildDesignQueryGrammar(candidates);
      expect(text).not.toBeNull();
      const grammar = parseGbnf(text!);
      let compiledCount = 0;
      for (let seed = 1; seed <= 300; seed++) {
        const query = sampleGbnf(grammar, seed, { maxRepeat: 2, maxDepth: 10 });
        const compiled = compileDesignQuery(query, "fixture", model);
        const errors = compiled.errors.map((e) => `line ${e.location.line}: ${e.message}`);
        expect(errors, `sample ${seed}:\n${query}`).toEqual([]);
        compiledCount++;
      }
      expect(compiledCount).toBe(300);
    });
  }

  it("accepts every corpus reference, built from that reference's own intent", () => {
    for (const task of corpus.tasks) {
      const candidates = chooseCandidates(model as DesignQueryModel, task.intent);
      const text = buildDesignQueryGrammar(candidates);
      expect(text, task.id).not.toBeNull();
      const grammar = parseGbnf(text!);
      expect(matchGbnf(grammar, task.reference), `${task.id}: the grammar forbids its own reference:\n${task.reference}`).toBe(true);
    }
  });

  it("every worked example the prompt shows compiles and matches the grammar", () => {
    // Measured 2026-09-10: the prompt's own second example sorted by a
    // measure, which the compiler refuses, and both small models copied it
    // into a quarter of their answers. A worked example is the strongest
    // instruction a small model gets; one that teaches a refused shape is a
    // defect in the prompt, not the model.
    for (const intent of [...intents, ...corpus.tasks.slice(0, 8).map((t) => t.intent)]) {
      const candidates = chooseCandidates(model as DesignQueryModel, intent);
      const grammar = parseGbnf(buildDesignQueryGrammar(candidates)!);
      const examples = buildExamples(candidates);
      expect(examples.length, intent).toBeGreaterThanOrEqual(3);
      for (const example of examples) {
        const dsl = (JSON.parse(example.slice(example.indexOf("{"))) as { dsl: string }).dsl;
        const compiled = compileDesignQuery(dsl, "fixture", model);
        expect(compiled.errors.map((e) => e.message), `example does not compile:\n${dsl}`).toEqual([]);
        expect(matchGbnf(grammar, dsl), `example outside the grammar:\n${dsl}`).toBe(true);
      }
      // The grammar path shows the same examples as bare query text — what
      // the grammar can actually emit — and each must be the same query.
      const bare = buildExamples(candidates, "bare");
      expect(bare.length).toBe(examples.length);
      bare.forEach((text, i) => {
        expect(text.startsWith("Request: "), text).toBe(true);
        expect(text.includes("{"), `a bare example must carry no JSON:\n${text}`).toBe(false);
        const dsl = text.slice(text.indexOf("\n") + 1);
        const jsonDsl = (JSON.parse(examples[i].slice(examples[i].indexOf("{"))) as { dsl: string }).dsl;
        expect(dsl, "the bare and JSON examples teach the same query").toBe(jsonDsl);
        expect(matchGbnf(grammar, dsl), `bare example outside the grammar:\n${dsl}`).toBe(true);
      });
    }
  });

  it("rejects a query that names a column it was not shown", () => {
    const candidates = chooseCandidates(model as DesignQueryModel, "revenue by region");
    const grammar = parseGbnf(buildDesignQueryGrammar(candidates)!);
    // Product.Name is never-slice-by for Revenue and Subcategory is snowflaked
    // out of the list; neither may appear.
    expect(matchGbnf(grammar, "ROWS: Product.Name\nVALUES: [Revenue]")).toBe(false);
    expect(matchGbnf(grammar, "ROWS: Geography.Region\nVALUES: [Invented]")).toBe(false);
    expect(matchGbnf(grammar, "ROWS: Geography.Region\nVALUES: [Revenue]")).toBe(true);
  });

  it("holds the clauses to the canonical order, each at most once", () => {
    // Measured on the built-in runtime 2026-09-10 with a free-order grammar:
    // a second VALUES after COLUMNS, a LAYOUT first, a trailing TOP nobody
    // asked for. The serializer's order is the only one the model may write.
    const candidates = chooseCandidates(model as DesignQueryModel, "revenue by region");
    const grammar = parseGbnf(buildDesignQueryGrammar(candidates)!);
    const ok = (q: string) => matchGbnf(grammar, q);
    expect(ok("ROWS: Geography.Region\nCOLUMNS: Product.Category\nVALUES: [Revenue]\nFILTERS: Geography.Region = (\"Europe\")\nSORT: Geography.Region DESC\nTOP 3 BY [Revenue]\nLAYOUT: tabular")).toBe(true);
    expect(ok("COLUMNS: Product.Category\nVALUES: [Revenue]"), "COLUMNS alone is a valid head").toBe(true);
    expect(ok("ROWS: Geography.Region\nVALUES: [Revenue]\nCOLUMNS: Product.Category\nVALUES: [Revenue]"), "a second VALUES").toBe(false);
    expect(ok("LAYOUT: tabular\nROWS: Geography.Region\nVALUES: [Revenue]"), "LAYOUT before ROWS").toBe(false);
    expect(ok("VALUES: [Revenue]"), "no ROWS or COLUMNS").toBe(false);
    expect(ok("ROWS: Geography.Region"), "no VALUES").toBe(false);
    expect(ok("ROWS: Geography.Region\nTOP 3 BY [Revenue]\nVALUES: [Revenue]"), "TOP before VALUES").toBe(false);
  });
});
