//! FILENAME: app/extensions/_shared/dsl/pivotLayout/designQueryCorpus.test.ts
// PURPOSE: Layer A of the design-query eval: the corpus checks itself, with no
//          model, in CI.
// CONTEXT: A task whose reference does not compile is not a hard task, it is a
//          broken one; a task whose distractor equals its reference measures
//          nothing; and a reference that uses a name the assistant would never
//          SHOW a model for that intent grades the candidate chooser, not the
//          model. All three are asserted here, over the same fixture the Rust
//          tests read, so a Layer B score can only ever be about the model.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { chooseCandidates, type DesignQueryModel } from "@api/designQueryAssist";
import { compileDesignQuery } from "./designQuery";
import { canonicalDesignQuery, sameDesignQuery } from "./canonical";
import type { BiPivotModelInfo } from "../../components/types";
import { modelInfoFromFixture, strategySummaryFromFixture } from "../../../../../tests/eval/lib/modelFixture.mjs";

const REPO = path.resolve(__dirname, "../../../../..");
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf8"));

const bundle = read("tests/fixtures/model/sales_star.json");
const strategyDoc = read("tests/fixtures/model/sales_star_strategy.json");
const corpus = read("tests/eval/design-queries.json") as {
  tasks: Array<{
    id: string; lang: string; intent: string; reference: string; distractor: string;
    /** Other queries that answer the request equally well. Graded as passes. */
    alternatives?: string[];
  }>;
};

const model: BiPivotModelInfo = {
  ...modelInfoFromFixture(bundle),
  strategy: strategySummaryFromFixture(strategyDoc, bundle),
};

/** Every `Table.Column`, `[Table.Column]` and `[Measure]` name a query uses. */
function namesUsed(dsl: string): { dimensions: string[]; measures: string[] } {
  const dimensions = new Set<string>();
  const measures = new Set<string>();
  const showAs = /^(% |difference$|running total$|index$)/i;
  for (const line of dsl.split("\n")) {
    for (const m of line.matchAll(/\[([^\]]+)\]/g)) {
      const inner = m[1];
      if (inner.includes(".")) dimensions.add(`[${inner}]`);
      else if (!showAs.test(inner)) measures.add(inner);
    }
    for (const m of line.matchAll(/(?<![\[\w])([A-Za-z_]\w*\.[A-Za-z_]\w*)/g)) dimensions.add(m[1]);
  }
  return { dimensions: [...dimensions], measures: [...measures] };
}

describe("the design-query corpus", () => {
  it("is non-trivial, and ENGLISH ONLY", () => {
    // THE SIZE IS LOAD-BEARING, not a round number. McNemar exact needs six
    // clean flips for p < 0.05 whatever the corpus size, so every task removed
    // makes the bar a larger FRACTION of the corpus: six of forty is a seventh,
    // six of thirty is a fifth. When the ten Swedish tasks were dropped
    // (2026-09-15, owner decision — the AI programme is English only) they were
    // replaced one for one rather than simply deleted, for exactly this reason.
    expect(corpus.tasks.length).toBeGreaterThanOrEqual(120);

    // This assertion used to require at least ten SWEDISH tasks. It is inverted
    // rather than deleted: a floor that is gone says nothing, while this pins
    // the decision, so a Swedish task added later fails here and has to be a
    // choice rather than a drift.
    const other = corpus.tasks.filter((t) => t.lang !== "en").map((t) => `${t.id} (${t.lang})`);
    expect(other, "the AI corpus is English only; see open-items 2.AI.12").toEqual([]);

    const ids = corpus.tasks.map((t) => t.id);
    expect(new Set(ids).size, "duplicate ids").toBe(ids.length);
  });

  it("samples every CLAUSE often enough for a difference in it to be measurable", () => {
    // The corpus used to answer "is this model better OVERALL" and could never
    // answer "better at WHAT" — and a model bake-off on 2026-09-15 turned on
    // exactly that question, because the two candidates were complementary
    // rather than ranked. McNemar's six-flip floor applies to every SUBSET, so
    // a clause carried by three tasks cannot reach p < 0.05 however much compute
    // is spent on it. It was SORT=2, BOTTOM=2, LAYOUT=3, TOP=4.
    //
    // Twelve is the working floor: six flips is then half the tasks carrying the
    // clause rather than all of them.
    const MIN_PER_CLAUSE = 12;
    const clauses = ["ROWS", "COLUMNS", "VALUES", "FILTERS", "SORT", "TOP", "BOTTOM", "LAYOUT"];
    const thin = clauses
      .map((clause) => {
        const re = new RegExp(`^\\s*${clause}\\b`, "mi");
        return { clause, n: corpus.tasks.filter((t) => re.test(t.reference)).length };
      })
      .filter((c) => c.n < MIN_PER_CLAUSE);
    expect(
      thin,
      `these clauses are sampled too thinly to measure: ${thin.map((c) => `${c.clause}=${c.n}`).join(", ")}`,
    ).toEqual([]);
  });

  it("never filters on a member the fixture does not contain", () => {
    // THE COMPILER CHECKS NAMES, NOT VALUES. `Geography.Region = ("Europe")`
    // compiles perfectly against a fixture whose regions are Nordics, DACH,
    // Benelux and UK and Ireland, so every other gate in this file passed three
    // such tasks for as long as they existed — while the query they describe is
    // unanswerable and any model that picked a REAL region was marked wrong for
    // being more sensible than the reference. Two asked for "Europe" and one for
    // a "Consumer" segment; all three were removed on 2026-09-15 and replaced
    // with the same shapes over real members.
    const members = new Map<string, Set<string>>();
    for (const [table, block] of Object.entries(bundle.data ?? {})) {
      const { columns, rows } = block as { columns?: string[]; rows?: unknown[][] };
      if (!columns || !rows) continue;
      columns.forEach((col, i) => {
        members.set(`${table}.${col}`, new Set(rows.map((r) => String(r[i]))));
      });
    }
    // Guard the guard: a typo in the fixture's shape would empty `members` and
    // this test would then pass by knowing nothing.
    expect(members.get("Geography.Region"), "the fixture's members were not read").toBeDefined();
    expect(members.get("Geography.Region")?.has("Nordics")).toBe(true);

    const bad: string[] = [];
    for (const task of corpus.tasks) {
      for (const dsl of [task.reference, ...(task.alternatives ?? [])]) {
        for (const line of dsl.matchAll(/^\s*FILTERS:\s*(.+)$/gim)) {
          const terms = line[1].matchAll(
            /([A-Za-z_]\w*\.[A-Za-z_]\w*)\s*(?:=|NOT\s+IN|IN)\s*\(([^)]*)\)/gi,
          );
          for (const term of terms) {
            const known = members.get(term[1]);
            for (const lit of [...term[2].matchAll(/"([^"]*)"/g)].map((m) => m[1])) {
              if (!known) bad.push(`${task.id}: no fixture data for ${term[1]}`);
              else if (!known.has(lit)) bad.push(`${task.id}: ${term[1]} has no member "${lit}"`);
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("the fixture derivation produced the model and the strategy", () => {
    expect(model.tables.map((t) => t.name)).toContain("Product");
    expect(model.measures.map((m) => m.name)).toContain("Revenue");
    expect(model.strategy?.measureOrder.slice(0, 4)).toEqual(["Revenue", "MarginPct", "Margin", "Cost"]);
    expect(model.strategy?.measures.Revenue.neverSliceBy).toEqual(["Product[Name]"]);
    expect(model.strategy?.columnRoles["Product[Category]"]).toBe("analysis");
    expect(model.strategy?.timeAxis).toBe("Date[Date]");
    expect(model.strategy?.calendarTable).toBe("Date");
  });

  for (const task of corpus.tasks) {
    describe(task.id, () => {
      it("reference compiles against the fixture with no errors", () => {
        const compiled = compileDesignQuery(task.reference, "fixture", model);
        expect(compiled.errors.map((e) => `line ${e.location.line}: ${e.message}`)).toEqual([]);
        expect(compiled.request).not.toBeNull();
      });

      it("distractor differs from the reference and from every alternative in canonical form", () => {
        expect(canonicalDesignQuery(task.reference)).not.toBeNull();
        expect(sameDesignQuery(task.reference, task.distractor)).toBe(false);
        for (const alt of task.alternatives ?? []) {
          expect(sameDesignQuery(alt, task.distractor), `alternative equals the distractor: ${alt}`).toBe(false);
        }
      });

      it("every alternative compiles and differs from the reference (or it is not an alternative)", () => {
        for (const alt of task.alternatives ?? []) {
          const compiled = compileDesignQuery(alt, "fixture", model);
          expect(compiled.errors.map((e) => e.message), alt).toEqual([]);
          expect(sameDesignQuery(alt, task.reference), `alternative is the reference itself: ${alt}`).toBe(false);
        }
      });

      it("uses only names the assistant would show a model for this intent", () => {
        const c = chooseCandidates(model as DesignQueryModel, task.intent);
        const offered = new Set([...c.dimensions, ...c.timeGroupings, ...c.numericColumns]);
        const used = namesUsed(task.reference);
        for (const d of used.dimensions) {
          expect(offered.has(d), `${d} is not among the candidates for "${task.intent}"`).toBe(true);
        }
        for (const m of used.measures) {
          expect(c.measures.includes(m), `[${m}] is not among the candidate measures for "${task.intent}"`).toBe(true);
        }
      });
    });
  }
});
