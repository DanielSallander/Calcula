//! FILENAME: app/extensions/_shared/dsl/pivotLayout/nextEditCorpus.test.ts
// PURPOSE: Layer A of the next-edit engine, over the same corpus the drafting
//          assistant is measured on: no rule may fight a correct query, and
//          the recall on the corpus's own prefixes is a number, written down.
// CONTEXT: Every reference in `tests/eval/design-queries.json` is a correct
//          query for a stated request. Two things follow. First, the GATE: run
//          the rules over each complete reference and each alternative — a
//          suggestion that changes the text and compiles is a rule that would
//          nag a person who wrote the right thing, and that is a defect in the
//          rule, not in the query. Second, the NUMBER: feed the rules each
//          prefix of a reference (its first k clause lines) and count how
//          often a suggestion is the reference's next line. Rules cannot know
//          the request, so the number is reported, not gated; it says what
//          the model's chip is worth in the next milestone.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { roleOfSuggestion, type DesignQueryModel } from "@api/designQueryAssist";
import { factsFromDsl, rulesChips } from "./nextEditFacts";
import { compileDesignQuery } from "./designQuery";
import { sameDesignQuery } from "./canonical";
import type { BiPivotModelInfo } from "../../components/types";
import { modelInfoFromFixture, strategySummaryFromFixture } from "../../../../../tests/eval/lib/modelFixture.mjs";

const REPO = path.resolve(__dirname, "../../../../..");
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf8"));

const bundle = read("tests/fixtures/model/sales_star.json");
const strategyDoc = read("tests/fixtures/model/sales_star_strategy.json");
const corpus = read("tests/eval/design-queries.json") as {
  tasks: Array<{ id: string; intent: string; reference: string; alternatives?: string[] }>;
};

const model: BiPivotModelInfo = {
  ...modelInfoFromFixture(bundle),
  strategy: strategySummaryFromFixture(strategyDoc, bundle),
};

const TABLE_NAMES = model.tables.map((t) => t.name);

/**
 * The suggestions that would actually become chips.
 *
 * `rulesChips` is the ROW's own loop — the same applied-edit, the same compile
 * veto — so a rule that passes here is a rule a person would really be offered.
 * A first version of this gate re-implemented the loop with an ABSOLUTE compile
 * bar, which is stricter than the row's "no worse" veto: it hid every rule
 * whose edit merely kept an existing error, so the gate was quietly weaker than
 * the thing it guards. The cap is lifted: a harmful suggestion ranked fourth is
 * still harmful, and becomes visible the moment the first three are dismissed.
 */
function liveSuggestions(text: string) {
  return rulesChips(
    text,
    model as DesignQueryModel,
    TABLE_NAMES,
    (dsl) => compileDesignQuery(dsl, "fixture", model),
    new Set(),
    50,
  ).map((chip) => ({ s: chip.suggestion, applied: chip.applied }));
}

/**
 * Correct queries the DRAFTING corpus happens not to contain.
 *
 * The corpus is a set of request/answer pairs for the drafting assistant, so
 * its coverage is a coverage of REQUESTS people make, not of query SHAPES. An
 * adversarial review found a rule firing on the most ordinary shape in the
 * language — months down, years across — purely because no task in the corpus
 * puts a calendar column on COLUMNS. A shape that the gate should cover but the
 * corpus does not reach belongs here, with the defect it was added for.
 */
const ALSO_CORRECT: Array<{ id: string; dsl: string }> = [
  {
    // The coarser-time rule looked for the year on ROWS only, called this wrong,
    // and its edit put Date.Year on BOTH axes.
    id: "shape:month-down-year-across",
    dsl: "ROWS: Date.MonthName\nCOLUMNS: Date.Year\nVALUES: [Revenue]",
  },
  {
    // `Date.Quarter` stood here and the fixture has no such column, so this row
    // never compiled and gated nothing. It survived because the gate's first
    // version dropped any suggestion whose result did not compile CLEANLY —
    // which is every suggestion on a query built from an invented name. A
    // fixture that cannot compile is a test that cannot fail.
    id: "shape:month-number-down-year-across",
    dsl: "ROWS: Date.Month\nCOLUMNS: Date.Year\nVALUES: [Revenue], [Cost]",
  },
  {
    // key-to-label offered Product.Name, which Revenue may never be sliced by,
    // so accepting its chip produced a query never-slice-by then demanded you
    // undo — two chips taking turns. The shape has to put an actual KEY on an
    // axis or the rule is never reached: this row used `Product.Category`,
    // whose role is "analysis", so it exercised nothing it claimed to.
    // `Product.ProductKey` has role "key", Product's label column is "Name",
    // and Revenue's neverSliceBy is exactly `Product[Name]`.
    id: "shape:product-key-with-revenue",
    dsl: "ROWS: Product.ProductKey\nVALUES: [Revenue]\nFILTERS: Geography.Region = (\"Europe\", \"Asia\")",
  },
];

const correct: Array<{ id: string; dsl: string }> = [];
for (const task of corpus.tasks) {
  correct.push({ id: task.id, dsl: task.reference });
  for (const [i, alt] of (task.alternatives ?? []).entries()) correct.push({ id: `${task.id}#alt${i + 1}`, dsl: alt });
}
correct.push(...ALSO_CORRECT);

/**
 * Every field reference a query carries, tagged by clause and sorted.
 *
 * Module-level because three tests need it: the additive-edit check, and the
 * two that hold explorations to "adds only". Counting CONTENT rather than
 * asking the compiler is the point — every editing defect the adversarial
 * review found was a silent loss (an apostrophe that swallowed the rest of a
 * clause, a `#` comment an edit deleted), and a query missing a field still
 * compiles perfectly well.
 */
function refsOf(dsl: string): string[] {
  const f = factsFromDsl(dsl, TABLE_NAMES);
  return [
    ...f.rows.map((x) => `r:${x.ref}`),
    ...f.columns.map((x) => `c:${x.ref}`),
    ...f.values.map((x) => `v:${x.ref}`),
    ...f.filters.map((x) => `f:${x.ref}`),
    ...f.sort.map((x) => `s:${x.ref}`),
  ].sort();
}

describe("the next-edit rules against the corpus", () => {
  it("no CORRECTION fights a complete, correct query (the gate)", () => {
    // THE ORIGINAL GATE, unchanged in strength and narrowed in scope.
    //
    // A correction fires because the query is broken. On a query that is right,
    // any correction at all is a rule fighting a correct query — the defect that
    // got an earlier rule deleted by name for firing on 44 of 44 references.
    // Explorations are held to a different standard below; they are the point
    // of the family, since this gate is precisely what kept the row silent.
    const harmful: string[] = [];
    for (const { id, dsl } of correct) {
      for (const { s } of liveSuggestions(dsl)) {
        if (roleOfSuggestion(s) !== "correction") continue;
        harmful.push(`${id}: ${s.text} (${s.kind})`);
      }
    }
    expect(correct.length).toBeGreaterThan(40);
    expect(harmful, "corrections offered on a query that is already right").toEqual([]);
  });

  it("every EXPLORATION only ever ADDS — it never removes what the person wrote", () => {
    // The standard an exploration is held to instead.
    //
    // An addition a reference query happens not to have is a difference of
    // taste: the corpus records one good answer to a request, not the only one,
    // and "you could also break this down by region" is not wrong merely
    // because the reference stopped earlier. A REMOVAL is different in kind —
    // it deletes something a person typed on a query that was already correct,
    // and no amount of taste makes that acceptable.
    const losses: string[] = [];
    for (const { id, dsl } of correct) {
      const before = refsOf(dsl);
      for (const { s, applied } of liveSuggestions(dsl)) {
        if (roleOfSuggestion(s) !== "exploration") continue;
        const after = refsOf(applied);
        for (const ref of before) {
          if (!after.includes(ref)) losses.push(`${id}: ${s.kind} dropped ${ref}`);
        }
      }
    }
    expect(losses, "an exploration removed something the query already had").toEqual([]);
  });

  it("every EXPLORATION terminates — accepting down the row runs out of ideas", () => {
    // The failure this prevents is a row that never runs out of ideas: accept
    // one and it offers another, accept that and the first comes back. Nothing
    // else in the suite can see it, because every individual suggestion looks
    // perfectly reasonable.
    //
    // TWO ASSERTIONS, AND THE SECOND IS THE LOAD-BEARING ONE. "The same id is
    // not re-offered" is nearly free — `applyEditOp` refuses to add a clause
    // that already exists, so the edit becomes a no-op and `rulesChips` drops
    // it upstream whatever the rule's own precondition says. A sabotage that
    // deleted an exploration's stop condition passed that check untouched.
    // What it cannot mask is the COUNT: a rule that keeps finding new things to
    // propose makes the list grow or hold steady instead of shrinking, and a
    // chain between two rules shows up here and nowhere else.
    // WHY A WALK AND NOT A COUNT. Taking one exploration can legitimately
    // ENABLE another — adding COLUMNS gives the time rule somewhere to put a
    // year, adding a field gives the drill rule a level to descend from — so
    // the number offered can hold steady for several steps while still
    // converging. Measured: a "strictly fewer each time" rule reds on 20 corpus
    // queries that all terminate perfectly well. What must be true is that the
    // process ENDS: keep taking the top exploration and the row eventually has
    // nothing left to say, without ever repeating itself on the way.
    const STEPS = 12;
    const loops: string[] = [];
    const nonterminating: string[] = [];
    for (const { id, dsl } of correct) {
      let text = dsl;
      const seen = new Set<string>();
      let step = 0;
      for (; step < STEPS; step++) {
        const next = liveSuggestions(text).filter(({ s }) => roleOfSuggestion(s) === "exploration");
        if (next.length === 0) break;
        const { s, applied } = next[0];
        if (seen.has(s.id)) {
          loops.push(`${id}: ${s.kind} offered twice in one walk (step ${step})`);
          break;
        }
        seen.add(s.id);
        if (applied === text) {
          loops.push(`${id}: ${s.kind} was offered but changes nothing`);
          break;
        }
        text = applied;
      }
      if (step >= STEPS) {
        nonterminating.push(`${id}: still offering explorations after ${STEPS} accepts`);
      }
    }
    expect(loops, "an exploration repeated itself while accepting down the row").toEqual([]);
    expect(nonterminating, "the row never runs out of ideas for this query").toEqual([]);
  });

  it("explorations are OFFERED on correct queries — the whole point of the family", () => {
    // Without this the family could be silently disabled — by a role filter, a
    // priority cap, or an `all.length === 0` guard that stops being reachable —
    // and every other test here would still pass, because all of them only
    // assert that explorations do no HARM.
    let offered = 0;
    const kinds = new Set<string>();
    for (const { dsl } of correct) {
      for (const { s } of liveSuggestions(dsl)) {
        if (roleOfSuggestion(s) !== "exploration") continue;
        offered++;
        kinds.add(s.kind);
      }
    }
    console.log(
      `[next-edit] explorations on ${correct.length} correct queries: ${offered} ` +
        `across ${kinds.size} kinds — ${[...kinds].sort().join(", ")}`,
    );
    expect(offered, "the row is silent on correct queries again").toBeGreaterThan(0);
    expect(kinds.size, "one rule doing all the work is a rule, not a family").toBeGreaterThan(2);
  });

  it("recall on the corpus's own prefixes is measured, non-zero, and written down", () => {
    let prefixes = 0;
    let hits = 0;
    const byKind = new Map<string, number>();
    for (const { dsl } of correct) {
      const lines = dsl.split("\n");
      for (let k = 1; k < lines.length; k++) {
        const prefix = lines.slice(0, k).join("\n");
        const target = lines.slice(0, k + 1).join("\n");
        prefixes++;
        const hit = liveSuggestions(prefix).find(({ applied }) => sameDesignQuery(applied, target));
        if (hit) {
          hits++;
          byKind.set(hit.s.kind, (byKind.get(hit.s.kind) ?? 0) + 1);
        }
      }
    }
    const recall = hits / prefixes;
    // Printed, because the number is the point: it is what the model's chip
    // has to beat. Not gated above a floor, because rules cannot know the
    // request — a prefix `ROWS: Geography.Region` is followed by whichever
    // measure the person wanted.
    console.log(
      `[next-edit] prefix recall ${hits}/${prefixes} (${(recall * 100).toFixed(1)}%) — ` +
        [...byKind.entries()].map(([k, n]) => `${k}: ${n}`).join(", "),
    );
    expect(prefixes).toBeGreaterThan(60);
    expect(hits, "a zero would mean the wiring is broken, not the rules").toBeGreaterThan(0);
  });

  it("no prefix's live suggestion loses a field the person typed", () => {
    // WHAT THIS DELIBERATELY DOES NOT ASSERT: that the edit is "no worse" by
    // the compiler. `liveSuggestions` is `rulesChips`, and `rulesChips` DROPS
    // anything `worseThan` rejects — so asserting `worseThan(...) === false`
    // over its output re-checks the filter that built the input and cannot
    // fail, however broken the rules become. The compile-still-compiles form is
    // tautological for the same reason: `worseThan` already returns true when
    // `request` goes null. A parse-error check is barely better, because this
    // parser is deliberately lenient and swallows most corruption.
    //
    // The invariant the veto has NO opinion about is CONTENT. Every defect the
    // adversarial review found in the editing layer was a silent loss — the
    // apostrophe in `[Customer.Owner's Key]` that swallowed the rest of its
    // clause, the `#` comment an edit deleted — and a query missing a field
    // still compiles perfectly well. So: count the field references before and
    // after, and hold each kind of op to what it promised. An ADDITIVE edit may
    // never drop one.
    const refs = refsOf;
    let additive = 0;
    let removing = 0;
    for (const { id, dsl } of correct) {
      const lines = dsl.split("\n");
      for (let k = 1; k < lines.length; k++) {
        const prefix = lines.slice(0, k).join("\n");
        const before = refs(prefix);
        for (const { s, applied } of liveSuggestions(prefix)) {
          const after = refs(applied);
          const where = `${id} prefix ${k}: ${s.text}`;
          if (s.op.op === "add-field" || s.op.op === "add-clause") {
            for (const ref of before) expect(after, where).toContain(ref);
            expect(after.length, where).toBeGreaterThan(before.length - 1);
            additive++;
          } else if (s.op.op === "remove-field") {
            expect(before.length - after.length, where).toBe(1);
            for (const ref of after) expect(before, where).toContain(ref);
            removing++;
          }
          // A comment the person wrote is never collateral damage.
          for (const line of prefix.split("\n")) {
            if (line.trim().startsWith("#")) expect(applied, where).toContain(line.trim());
          }
        }
      }
    }
    expect(additive, "no additive suggestion was examined at all").toBeGreaterThan(10);
    expect(removing + additive, "no suggestion was examined at all").toBeGreaterThan(10);
  });
});
