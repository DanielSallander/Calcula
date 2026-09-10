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
  it("is non-trivial", () => {
    expect(corpus.tasks.length).toBeGreaterThanOrEqual(40);
    expect(corpus.tasks.filter((t) => t.lang === "sv").length).toBeGreaterThanOrEqual(10);
    const ids = corpus.tasks.map((t) => t.id);
    expect(new Set(ids).size, "duplicate ids").toBe(ids.length);
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
