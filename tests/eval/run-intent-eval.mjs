//! FILENAME: tests/eval/run-intent-eval.mjs
// PURPOSE: Score the intent router against `intents.json`, on a split that
//          says how much of its number was earned on utterances it was never
//          tuned against.
// CONTEXT: Step 5 of the AI programme (`docs/design/ai-intent-router.md`). The
//          design's exit criterion is "rules-only >= 80 %" with "100 % precision
//          on the decisive subset". Both figures are reported here; the
//          precision figure is ALSO a CI gate (`intentRouter.corpus.test.ts`).
//
//   node tests/eval/run-intent-eval.mjs
//
// THE BASELINE IS A RECORDED NUMBER, NOT A MODE. The two detectors the router
// replaced (`scriptIntent`'s trigger list and `analysisIntent.ts`) scored
// macro 24/214 raw on this corpus on 2026-09-16 — three of nine intents
// reachable, 23 of 35 script requests missed. `analysisIntent.ts` was deleted
// the same day and the trigger list rewritten, so that arm cannot be re-run;
// the figure lives in `open-items.md` 2.AI.10 and in the router's own tests.
//
// THE HEADLINE IS A MACRO AVERAGE. The corpus is 122 `bi-query` rows out of 214
// — every design-query task is one — so a raw accuracy is mostly a score for one
// intent. The macro average weights the nine intents equally; the raw figure is
// printed beside it, never instead of it.
//
// THE SPLIT, and why it is spelled out. The router's rules were derived from
// this corpus's own vocabulary (design §4b) and its author read every failure
// of the prototype on the full corpus before writing them. So `held-out` is
// defined as: rows whose id hashes odd AND whose failure was never inspected
// during rule authoring — the sixteen inspected ids are pinned to `tune` by
// name. Nothing in `held-out` was looked at while the rules were written. Its
// number is the honest one; `tune` is the fitted one; `all` is what CI pins.
//
//   --split all|tune|held-out   (default: all, with every split's number printed)
//   --show-misses               list every wrong route
//   --json out.json             write {summary, rows}
//
// NO PORT. The router and the field index are imported from the product through
// `lib/appBundle.mjs`; the index is built from `tests/fixtures/model/sales_star.json`
// with the same function the product uses, so the runner scores exactly what the
// chat would route with that model open.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { bundleAppModules } from "./lib/appBundle.mjs";
// The split lives in its own pure module so the CI corpus test imports the SAME
// one and the two cannot disagree about which rows were held out.
import { splitOf } from "./run-intent-eval-split.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const appRoot = path.join(repo, "app");

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

const splitArg = String(arg("split", "all"));
const showMisses = Boolean(arg("show-misses", false));
const jsonOut = arg("json");

if (!["all", "tune", "held-out"].includes(splitArg)) {
  console.error(`--split must be all, tune or held-out (got ${splitArg})`);
  process.exit(2);
}

const corpus = JSON.parse(readFileSync(path.join(here, "intents.json"), "utf8"));
const INTENTS = corpus.intents;

// ---------------------------------------------------------------------------
// The router, bundled from the product
// ---------------------------------------------------------------------------

const { mod } = await bundleAppModules({
  appRoot,
  tag: "intents-router",
  exports: [
    { from: "extensions/AIChat/lib/intentRouter.ts", names: ["routeIntent"] },
    { from: "src/api/biModelFields.ts", names: ["buildModelFieldIndex"] },
  ],
});
const fixture = JSON.parse(readFileSync(path.join(repo, "tests/fixtures/model/sales_star.json"), "utf8"));
const fields = mod.buildModelFieldIndex([fixture.model ?? fixture]);
const route = (text) => {
  const r = mod.routeIntent(text, { fields });
  return { routed: r.intent, decisive: r.decisive, clarify: r.clarify ?? null, why: r.matched.join(" | ") };
};
const label = "the router";

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

const rows = corpus.utterances.map((u) => {
  const r = route(u.text);
  // A clarify pair that CONTAINS the expected intent is the designed answer for
  // a non-decisive utterance ("genuinely two requests; the design says ask") —
  // credited there, and never on a row the rules were expected to settle.
  const clarifyCredit = Boolean(r.clarify && !u.decisive && r.clarify.includes(u.intent));
  return {
    id: u.id,
    split: splitOf(u.id),
    text: u.text,
    expected: u.intent,
    got: r.routed,
    gotDecisive: r.decisive,
    clarify: r.clarify,
    correct: r.routed === u.intent || clarifyCredit,
    clarifyCredit,
    expectedDecisive: u.decisive,
    // THE PRECISION FAILURE: the router SETTLED on a wrong answer. A wrong lean
    // is a recall miss; a wrong decision is the defect the design forbids.
    decisiveWrong: r.decisive && r.routed !== u.intent,
    isRegression: u.id.startsWith("rg-"),
    why: r.why,
  };
});

function score(subset) {
  const n = subset.length;
  const correct = subset.filter((r) => r.correct).length;
  const perIntent = {};
  for (const intent of INTENTS) {
    const of = subset.filter((r) => r.expected === intent);
    perIntent[intent] = { n: of.length, correct: of.filter((r) => r.correct).length };
  }
  const present = INTENTS.filter((i) => perIntent[i].n > 0);
  const macro = present.length
    ? present.reduce((a, i) => a + perIntent[i].correct / perIntent[i].n, 0) / present.length
    : 0;
  const decided = subset.filter((r) => r.gotDecisive);
  const decisiveWrong = subset.filter((r) => r.decisiveWrong);
  return {
    n,
    correct,
    raw: n ? correct / n : 0,
    macro,
    perIntent,
    decided: decided.length,
    decisiveWrong: decisiveWrong.length,
    decisivePrecision: decided.length ? 1 - decisiveWrong.length / decided.length : 1,
    falseScript: subset.filter((r) => r.got === "script" && r.expected !== "script").length,
    missedScript: subset.filter((r) => r.expected === "script" && !r.correct).length,
    clarified: subset.filter((r) => r.clarify).length,
    regressions: subset.filter((r) => r.isRegression).length,
    regressionsCorrect: subset.filter((r) => r.isRegression && r.correct).length,
  };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const bySplit = {
  all: score(rows),
  tune: score(rows.filter((r) => r.split === "tune")),
  "held-out": score(rows.filter((r) => r.split === "held-out")),
};

const knobs = { split: splitArg, showMisses, corpus: rows.length };

console.log(`\n[intent-eval] ${label}, over ${rows.length} utterances`);
for (const name of ["all", "tune", "held-out"]) {
  const s = bySplit[name];
  console.log(
    `  ${name.padEnd(9)} n=${String(s.n).padStart(3)}  macro ${pct(s.macro)}  raw ${s.correct}/${s.n} (${pct(s.raw)})  ` +
      `decisive precision ${pct(s.decisivePrecision)} (${s.decisiveWrong} wrong of ${s.decided} decided)  ` +
      `false script ${s.falseScript}  clarified ${s.clarified}`,
  );
}

const focus = bySplit[splitArg];
console.log(`\n  per intent, ${splitArg} split (recall):`);
for (const intent of INTENTS) {
  const p = focus.perIntent[intent];
  if (p.n === 0) continue;
  console.log(`    ${intent.padEnd(9)} ${String(p.correct).padStart(3)}/${String(p.n).padEnd(3)} ${pct(p.correct / p.n)}`);
}
console.log(`  regressions ${focus.regressionsCorrect}/${focus.regressions} of the known-defect cases route correctly`);

const wrongDecisions = rows.filter((r) => r.decisiveWrong);
if (wrongDecisions.length) {
  console.log(`\n  DECISIVE AND WRONG — each of these is a precision failure the design forbids:`);
  for (const r of wrongDecisions) {
    console.log(`    [${r.split}] want ${r.expected.padEnd(9)} decided ${r.got.padEnd(9)} (${r.why}) ${JSON.stringify(r.text).slice(0, 90)}`);
  }
}

if (showMisses) {
  console.log(`\n  every wrong route (${splitArg}):`);
  for (const r of rows.filter((x) => !x.correct && (splitArg === "all" || x.split === splitArg))) {
    const got = r.clarify ? `ask(${r.clarify.join("/")})` : r.got;
    console.log(`    [${r.split}] want ${r.expected.padEnd(9)} got ${got.padEnd(18)} ${r.gotDecisive ? "DECISIVE " : "lean     "} (${r.why}) ${JSON.stringify(r.text).slice(0, 80)}`);
  }
}

if (jsonOut) {
  mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
  writeFileSync(jsonOut, JSON.stringify({ knobs, summary: bySplit, rows }, null, 2) + "\n", "utf8");
  console.log(`\n[intent-eval] wrote ${jsonOut}`);
}

// Reports; the CI gate is the corpus test, which fails the build on one
// decisive miss. This exits 0 so both modes stay runnable as measurements.
