//! FILENAME: tests/eval/classify-design-failures.mjs
// PURPOSE: Why each design-query failure failed, per TASK, offline.
// CONTEXT: `open-items.md` records the remaining failures as "an unasked share
//          label (6), an unasked TOP (6), an extra name (6), a filtered column
//          repeated (2)". Those are DEFECT counts, and the number that decides
//          whether restraint is worth building is a TASK count — a task carrying
//          both an unasked TOP and an extra name is not recovered by suppressing
//          the TOP.
//
//          The arithmetic is why this had to be measured before anything was
//          built: on 40 tasks McNemar exact needs b=6, c=0 for p = 0.031. If
//          fewer than six failing tasks have a gateable defect as their SOLE
//          difference from the reference, the corpus cannot certify a restraint
//          fix however well it works — and writing a clause detector first would
//          have been weeks spent on something unprovable.
//
//          NO MODEL AND NO NETWORK. It joins a saved run to the corpus by id and
//          diffs the parsed queries, so it re-reads an experiment already paid
//          for. Run it over any artifact in tests/eval/runs/.
//
// USAGE
//   node tests/eval/classify-design-failures.mjs tests/eval/runs/<run>.json
//   node tests/eval/classify-design-failures.mjs <run>.json --self-test

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { bundleAppModules } from "./lib/appBundle.mjs";
import { modelInfoFromFixture } from "./lib/modelFixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const appRoot = path.join(repo, "app");

const runPath = process.argv[2];
const selfTest = process.argv.includes("--self-test");
if (!runPath) {
  console.error("Usage: node tests/eval/classify-design-failures.mjs <run.json> [--self-test]");
  process.exit(2);
}

const { mod } = await bundleAppModules({
  appRoot,
  tag: "classify",
  exports: [
    { from: "extensions/_shared/dsl/pivotLayout/nextEditFacts.ts", names: ["factsFromDsl"] },
    { from: "extensions/_shared/dsl/pivotLayout/canonical.ts", names: ["canonicalDesignQuery"] },
  ],
});
const { factsFromDsl } = mod;

const bundle = JSON.parse(readFileSync(path.join(repo, "tests/fixtures/model/sales_star.json"), "utf8"));
const TABLE_NAMES = modelInfoFromFixture(bundle).tables.map((t) => t.name);
const corpus = JSON.parse(readFileSync(path.join(here, "design-queries.json"), "utf8"));
const byId = new Map(corpus.tasks.map((t) => [t.id, t]));

const norm = (s) => String(s ?? "").trim().replace(/^\[(.*)\]$/s, "$1").toLowerCase();

/**
 * Everything one query says, as comparable sets.
 *
 * Compared as CONTENT rather than text: the reference and the reply may order
 * their clauses differently and mean the same thing, which is the same reason
 * the runner grades on the canonical form.
 */
function shapeOf(dsl) {
  const f = factsFromDsl(dsl, TABLE_NAMES);
  return {
    rows: new Set(f.rows.map((x) => norm(x.ref))),
    columns: new Set(f.columns.map((x) => norm(x.ref))),
    values: new Set(f.values.map((x) => norm(x.ref))),
    showAs: new Set(f.values.filter((v) => v.showAs).map((v) => `${norm(v.ref)}:${norm(v.showAs)}`)),
    filters: new Set(f.filters.map((x) => norm(x.ref))),
    sort: new Set(f.sort.map((x) => norm(x.ref))),
    topN: f.topN ? `${f.topN.top ? "TOP" : "BOTTOM"} ${f.topN.count} BY ${norm(f.topN.by)}` : null,
  };
}

const minus = (a, b) => [...a].filter((x) => !b.has(x));

/**
 * The defects in one reply against its reference.
 *
 * `extra-name` is separated from the three GATEABLE classes deliberately: no
 * per-request context-free grammar can forbid a name that is legal elsewhere in
 * the same query, so a clause gate cannot reach it however well it works.
 */
function defectsOf(got, want) {
  const d = [];
  if (got.topN && !want.topN) d.push("unasked-top");
  if (!got.topN && want.topN) d.push("missing-top");
  if (got.topN && want.topN && got.topN !== want.topN) d.push("wrong-top");

  const extraShow = minus(got.showAs, want.showAs);
  const missShow = minus(want.showAs, got.showAs);
  if (extraShow.length) d.push("unasked-showas");
  if (missShow.length) d.push("missing-showas");

  // A column in FILTERS that the reply ALSO puts on an axis.
  const repeated = [...got.filters].filter((r) => got.rows.has(r) || got.columns.has(r));
  const wantRepeated = [...want.filters].filter((r) => want.rows.has(r) || want.columns.has(r));
  if (repeated.length > wantRepeated.length) d.push("filtered-column-repeated");

  for (const [axis, g, w] of [
    ["rows", got.rows, want.rows],
    ["columns", got.columns, want.columns],
    ["values", got.values, want.values],
    ["filters", got.filters, want.filters],
    ["sort", got.sort, want.sort],
  ]) {
    // The repeated-column case is already named; do not count it twice.
    const extra = minus(g, w).filter((r) => !(axis !== "filters" && repeated.includes(r)));
    if (extra.length) d.push(`extra-${axis}`);
    if (minus(w, g).length) d.push(`missing-${axis}`);
  }
  return d;
}

/** The classes a per-request clause gate could actually suppress. */
const GATEABLE = new Set(["unasked-top", "unasked-showas", "filtered-column-repeated"]);

// ---------------------------------------------------------------------------
// Positive control: the classifier must name known damage, and nothing else.
// ---------------------------------------------------------------------------
if (selfTest) {
  let bad = 0;
  for (const task of corpus.tasks) {
    const want = shapeOf(task.reference);
    if (want.topN) continue; // injecting a TOP where one belongs proves nothing
    const damaged = `${task.reference}\nTOP 10 BY [Revenue]`;
    const d = defectsOf(shapeOf(damaged), want);
    if (d.length !== 1 || d[0] !== "unasked-top") {
      bad++;
      console.log(`  self-test MISS ${task.id}: ${JSON.stringify(d)}`);
    }
  }
  console.log(bad === 0 ? "[self-test] OK — injected damage named exactly" : `[self-test] ${bad} MISCLASSIFIED`);
  if (bad > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------
const run = JSON.parse(readFileSync(path.resolve(repo, runPath), "utf8"));
const failures = run.results.filter((r) => !r.passed && r.dsl);

const defectTally = new Map();
const soleGateable = [];
const mixed = [];
const ungateable = [];

for (const r of failures) {
  const task = byId.get(r.id);
  if (!task) continue;
  const d = defectsOf(shapeOf(r.dsl), shapeOf(task.reference));
  for (const x of d) defectTally.set(x, (defectTally.get(x) ?? 0) + 1);
  const gate = d.filter((x) => GATEABLE.has(x));
  const other = d.filter((x) => !GATEABLE.has(x));
  if (gate.length > 0 && other.length === 0) soleGateable.push({ id: r.id, d });
  else if (gate.length > 0) mixed.push({ id: r.id, d });
  else ungateable.push({ id: r.id, d });
}

console.log(`\n[classify] ${runPath}`);
console.log(`  model ${run.summary.knobs?.model ?? run.summary.model}, ${run.summary.passed}/${run.summary.ran} passed\n`);
console.log("  DEFECTS (a task may carry several):");
for (const [k, n] of [...defectTally.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(3)}  ${k}`);
}
console.log("\n  TASKS, which is the number that decides whether a clause gate is worth building:");
console.log(`    ${String(soleGateable.length).padStart(3)}  recoverable by a clause gate ALONE`);
console.log(`    ${String(mixed.length).padStart(3)}  carry a gateable defect AND something else`);
console.log(`    ${String(ungateable.length).padStart(3)}  no gateable defect at all`);
console.log(`    ${String(failures.length).padStart(3)}  failures total`);
console.log(
  `\n  McNemar needs b=6, c=0 on 40 tasks for p<0.05. A perfect clause gate can flip at most ` +
    `${soleGateable.length}, so it is ${soleGateable.length >= 6 ? "CERTIFIABLE" : "NOT certifiable"} on this corpus.`,
);
if (soleGateable.length) console.log(`\n  sole-gateable: ${soleGateable.map((x) => x.id).join(", ")}`);
if (mixed.length) console.log(`  mixed:         ${mixed.map((x) => x.id).join(", ")}`);
