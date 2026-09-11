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
import {
  allowedNextClauses,
  buildDesignQueryGrammar,
  buildExamples,
  buildNextClauseGrammar,
  chooseCandidates,
  type DesignQueryModel,
} from "@api/designQueryAssist";
import { compileDesignQuery } from "./designQuery";
import { factsFromDsl, presentClauses } from "./nextEditFacts";
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

describe("the NEXT-CLAUSE grammar (the next-edit row's model chip)", () => {
  // One set of clause bodies serves both grammars, so a shape the whole-query
  // grammar allows is a shape this one allows too. What differs is the root:
  // exactly one clause, and only one that may legally come next.
  const candidates = chooseCandidates(model as DesignQueryModel, "");

  const grammarAfter = (dsl: string): string | null =>
    buildNextClauseGrammar(candidates, presentClauses(factsFromDsl(dsl, model.tables.map((t) => t.name))));

  it("offers the clauses the query does not yet have, in canonical order", () => {
    expect(allowedNextClauses({ rows: false, columns: false, values: false, filters: false, sort: false, topN: false, layout: false }))
      .toEqual(["ROWS", "COLUMNS", "VALUES", "FILTERS", "SORT", "TOP", "LAYOUT"]);
    expect(allowedNextClauses({ rows: true, columns: false, values: true, filters: false, sort: false, topN: false, layout: false }))
      .toEqual(["COLUMNS", "FILTERS", "SORT", "TOP", "LAYOUT"]);
    // A LAYOUT already typed does not close the door on a FILTERS: where a new
    // clause GOES is `applyEditOp`'s job, not the model's.
    expect(allowedNextClauses({ rows: true, columns: false, values: true, filters: false, sort: false, topN: false, layout: true }))
      .toEqual(["COLUMNS", "FILTERS", "SORT", "TOP"]);
    // A complete query has nothing to add.
    expect(allowedNextClauses({ rows: true, columns: true, values: true, filters: true, sort: true, topN: true, layout: true }))
      .toEqual([]);
  });

  it("is null for a query that is already complete", () => {
    expect(grammarAfter("ROWS: Geography.Region\nCOLUMNS: Product.Category\nVALUES: [Revenue]\nFILTERS: Geography.Region = (\"Europe\")\nSORT: Geography.Region DESC\nTOP 3 BY [Revenue]\nLAYOUT: tabular")).toBeNull();
  });

  it("offers every legal next clause, not a favourite", () => {
    // A first version narrowed this to VALUES whenever VALUES was missing, and
    // five corpus references write COLUMNS as their second line — the grammar
    // would have forbidden the model from ever writing the clause the corpus
    // itself calls right. Supplying a missing VALUES is the rules' job.
    const g = parseGbnf(grammarAfter("ROWS: Product.Category")!);
    expect(matchGbnf(g, "VALUES: [Revenue]")).toBe(true);
    expect(matchGbnf(g, "COLUMNS: Customer.Segment")).toBe(true);
    expect(matchGbnf(g, 'FILTERS: Geography.Region = ("Europe")')).toBe(true);
    // ...but never a clause the query already has: each appears once.
    expect(matchGbnf(g, "ROWS: Customer.Segment"), "ROWS is already there").toBe(false);
  });

  it("emits exactly ONE clause, never a whole query", () => {
    const g = parseGbnf(grammarAfter("ROWS: Product.Category\nVALUES: [Revenue]")!);
    expect(matchGbnf(g, "TOP 3 BY [Revenue]")).toBe(true);
    expect(matchGbnf(g, "TOP 3 BY [Revenue]\nLAYOUT: tabular"), "two clauses is not one clause").toBe(false);
    expect(matchGbnf(g, "ROWS: Geography.Region"), "a clause the query already has").toBe(false);
    expect(matchGbnf(g, "VALUES: [Cost]"), "a clause the query already has").toBe(false);
  });

  it("closes every clause's repetition, so a clause cannot list everything", () => {
    // Measured: with an unbounded `*`, asked for the clause after `ROWS:
    // Product.Category`, the built-in 1.5B answered `VALUES: [Revenue],
    // [MarginPct], [Margin], [Cost], [Customers], [Quantity]` — every measure
    // it had been shown — on every prefix of every corpus query. A repetition
    // the grammar leaves open is one a small model fills.
    const g = parseGbnf(grammarAfter("ROWS: Product.Category")!);
    expect(matchGbnf(g, "VALUES: [Revenue]")).toBe(true);
    expect(matchGbnf(g, "VALUES: [Revenue], [Cost]"), "the widest clause in the corpus").toBe(true);
    expect(matchGbnf(g, "VALUES: [Revenue], [Cost], [Margin], [Quantity]"), "four is the ceiling").toBe(true);
    expect(matchGbnf(g, "VALUES: [Revenue], [Cost], [Margin], [Quantity], [Customers]"), "five is past it").toBe(false);
    // The same ceiling on a dimension list and on a filter's value list.
    expect(matchGbnf(g, "COLUMNS: Geography.Region, Geography.Country, Customer.Segment, Date.Year")).toBe(true);
    expect(matchGbnf(g, "COLUMNS: Geography.Region, Geography.Country, Customer.Segment, Date.Year, Date.MonthName")).toBe(false);
    // ...but a FILTER's value list is deliberately NOT held to four. Cutting a
    // clause short costs a field the person adds back; cutting a filter short
    // changes what the query means, silently and unrecoverably.
    expect(matchGbnf(g, 'FILTERS: Geography.Country = ("a", "b", "c", "d", "e", "f", "g", "h")')).toBe(true);
    const twenty = Array.from({ length: 20 }, (_, i) => `"v${i}"`).join(", ");
    expect(matchGbnf(g, `FILTERS: Geography.Country = (${twenty})`), "twenty members is still a filter").toBe(true);
    const twentyOne = Array.from({ length: 21 }, (_, i) => `"v${i}"`).join(", ");
    expect(matchGbnf(g, `FILTERS: Geography.Country = (${twentyOne})`), "but it is still bounded").toBe(false);
  });

  it("lets the model answer NOTHING, because the prompt tells it to", () => {
    // The prompt ends "If the query is already complete, reply with nothing at
    // all". A root that demanded a clause made that sentence unobeyable: on a
    // finished query every legal token spelled a clause, so the model always
    // proposed one and only the row's compile veto stood in the way — and a
    // syntactically fine LAYOUT adds no error and no warning, so the veto lets
    // it through. The empty string has to be in the language.
    const g = parseGbnf(grammarAfter("ROWS: Product.Category\nVALUES: [Revenue]")!);
    expect(matchGbnf(g, ""), "the empty reply is what 'nothing at all' means to a grammar").toBe(true);
    // ...and it is still the only way to say nothing: half a clause is not one.
    expect(matchGbnf(g, "LAYOUT: ")).toBe(false);
    expect(matchGbnf(g, "TOP ")).toBe(false);
  });

  it("cannot name a column it was not shown", () => {
    const g = parseGbnf(grammarAfter("ROWS: Product.Category\nVALUES: [Revenue]")!);
    expect(matchGbnf(g, 'FILTERS: Geography.Region = ("Europe")')).toBe(true);
    expect(matchGbnf(g, 'FILTERS: Product.Name = ("Widget")'), "never-slice-by for Revenue, so never a candidate").toBe(false);
    expect(matchGbnf(g, "TOP 3 BY [Invented]")).toBe(false);
  });

  it("every sample, appended to the query it was built for, compiles", () => {
    const prefixes = [
      "ROWS: Product.Category\nVALUES: [Revenue]",
      "ROWS: Geography.Region\nCOLUMNS: Customer.Segment\nVALUES: [Revenue], [Cost]",
      "ROWS: Date.Year\nVALUES: [Revenue]\nFILTERS: Geography.Region = (\"Europe\")",
    ];
    let checked = 0;
    let empty = 0;
    for (const prefix of prefixes) {
      const text = grammarAfter(prefix);
      expect(text, prefix).not.toBeNull();
      const g = parseGbnf(text!);
      // 220 seeds, not 100: the root's clause is OPTIONAL so the sampler draws
      // the empty reply about half the time, and a run that kept 100 seeds
      // would have quietly halved the compile coverage while still passing.
      for (let seed = 1; seed <= 220; seed++) {
        const clause = sampleGbnf(g, seed, { maxRepeat: 2, maxDepth: 8 }).trim();
        if (!clause) {
          empty++;
          continue;
        }
        const whole = `${prefix}\n${clause}`;
        const compiled = compileDesignQuery(whole, "fixture", model);
        expect(compiled.errors.map((e) => e.message), `seed ${seed}:\n${whole}`).toEqual([]);
        expect(compiled.request, `seed ${seed}:\n${whole}`).not.toBeNull();
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(200);
    expect(empty, "the empty reply must be reachable, or 'reply with nothing' is unobeyable").toBeGreaterThan(0);
  });

  it("accepts the real next line of every corpus reference that has one", () => {
    // The reverse direction: the grammar must not forbid the clause the corpus
    // itself calls right. Any reference line the grammar refuses is a shape the
    // model would be prevented from ever producing.
    let checked = 0;
    const refused: string[] = [];
    for (const task of corpus.tasks) {
      const lines = task.reference.split("\n");
      for (let k = 1; k < lines.length; k++) {
        const prefix = lines.slice(0, k).join("\n");
        const next = lines[k];
        const perIntent = chooseCandidates(model as DesignQueryModel, task.intent);
        const text = buildNextClauseGrammar(perIntent, presentClauses(factsFromDsl(prefix, model.tables.map((t) => t.name))));
        if (!text) {
          refused.push(`${task.id}: no grammar after ${k} line(s)`);
          continue;
        }
        if (!matchGbnf(parseGbnf(text), next)) refused.push(`${task.id} line ${k + 1}: ${next}`);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
    expect(refused, "clauses the next-clause grammar would forbid the model from writing").toEqual([]);
  });
});
