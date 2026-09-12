//! FILENAME: tests/eval/run-intent-eval.mjs
// PURPOSE: Score intent routing against `intents.json` — starting with the
//          detectors that exist TODAY, so the router has a number to beat.
// CONTEXT: Step 5 of the AI programme (`docs/design/ai-intent-router.md`). The
//          design's exit criterion is "rules-only >= 80 %" with "100 % precision
//          on the decisive subset", and neither figure means anything until
//          somebody says what the current code scores. There is no router yet;
//          there are two independent detectors, so this measures them.
//
// WHAT "THE CURRENT DETECTORS" CAN EVEN SAY. `scriptIntent` answers script / not
// script. `analysisIntent` answers analysis / not analysis. Between them they
// can express THREE of the nine intents — `script`, `analyze`, and "neither,
// so the chat sends it to the model" — which is mapped here to `question`,
// because that is what actually happens: no specialist, no facts, the general
// tool loop. Six of the nine intents are therefore unreachable by construction,
// and the report says so rather than scoring them as ordinary misses.
//
// AND THEY ARE NOT MUTUALLY EXCLUSIVE. Both run unconditionally in `send()`, so
// a message can match both and today gets BOTH behaviours. That is counted
// separately as `bothFired`, because it is not a misroute — it is the absence of
// a route, and it is the thing M4 exists to add.
//
// NO PORT. The detectors are imported from the product through
// `lib/appBundle.mjs`, exactly as the design-query runner imports the drafting
// loop. A re-implementation of two keyword tables would score the copy.
//
// USAGE
//   node tests/eval/run-intent-eval.mjs                  score today's detectors
//   node tests/eval/run-intent-eval.mjs --show-misses    list every wrong route
//   node tests/eval/run-intent-eval.mjs --json out/i.json

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { bundleAppModules } from "./lib/appBundle.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const appRoot = path.join(repo, "app");

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

const showMisses = Boolean(arg("show-misses", false));
const jsonOut = arg("json");

const corpus = JSON.parse(readFileSync(path.join(here, "intents.json"), "utf8"));

const { mod } = await bundleAppModules({
  appRoot,
  tag: "intents",
  exports: [
    { from: "extensions/AIChat/lib/scriptIntent.ts", names: ["detectScriptIntent", "guessObjectType"] },
    { from: "extensions/AIChat/lib/analysisIntent.ts", names: ["detectAnalysisIntent"] },
  ],
});
const { detectScriptIntent, detectAnalysisIntent } = mod;

/** The three intents today's code can actually express. */
const REACHABLE = new Set(["script", "analyze", "question"]);

function routeToday(text) {
  const script = detectScriptIntent(text);
  const analysis = detectAnalysisIntent(text);
  return {
    script: script.looksLikeScript,
    analysis: analysis.looksLikeAnalysis,
    scriptMatched: script.matched,
    analysisMatched: analysis.matched,
    // What the chat DOES today, in order: the analysis pre-route appends facts,
    // and the script offer card is rendered beside it. When both fire the person
    // sees both; the first of the two is what the transcript leads with.
    routed: script.looksLikeScript ? "script" : analysis.looksLikeAnalysis ? "analyze" : "question",
  };
}

const rows = [];
for (const u of corpus.utterances) {
  const r = routeToday(u.text);
  rows.push({
    id: u.id,
    lang: u.lang,
    text: u.text,
    expected: u.intent,
    got: r.routed,
    correct: r.routed === u.intent,
    reachable: REACHABLE.has(u.intent),
    decisive: u.decisive,
    bothFired: r.script && r.analysis,
    scriptMatched: r.scriptMatched,
    analysisMatched: r.analysisMatched,
    isRegression: u.id.startsWith("rg-"),
    why: u.why,
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const reachable = rows.filter((r) => r.reachable);
const unreachable = rows.filter((r) => !r.reachable);
const decisive = rows.filter((r) => r.decisive);
const regressions = rows.filter((r) => r.isRegression);

const correct = rows.filter((r) => r.correct).length;
const correctReachable = reachable.filter((r) => r.correct).length;
const bothFired = rows.filter((r) => r.bothFired).length;

// A FALSE SCRIPT is the expensive mistake: it renders an offer card and builds
// the ~6,000-token API surface for a message that never wanted either.
const falseScript = rows.filter((r) => r.got === "script" && r.expected !== "script");
const missedScript = rows.filter((r) => r.expected === "script" && r.got !== "script");
const falseAnalyze = rows.filter((r) => r.got === "analyze" && r.expected !== "analyze");
const missedAnalyze = rows.filter((r) => r.expected === "analyze" && r.got !== "analyze");
const decisiveWrong = decisive.filter((r) => r.reachable && !r.correct);

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : "n/a");

const summary = {
  utterances: rows.length,
  swedish: rows.filter((r) => r.lang === "sv").length,
  overallCorrect: correct,
  overallRate: correct / rows.length,
  reachable: reachable.length,
  reachableCorrect: correctReachable,
  reachableRate: reachable.length ? correctReachable / reachable.length : 0,
  unreachableByConstruction: unreachable.length,
  decisiveTotal: decisive.length,
  decisiveWrong: decisiveWrong.length,
  decisivePrecision: decisive.length ? 1 - decisiveWrong.length / decisive.length : 0,
  bothDetectorsFired: bothFired,
  falseScript: falseScript.length,
  missedScript: missedScript.length,
  falseAnalyze: falseAnalyze.length,
  missedAnalyze: missedAnalyze.length,
  regressionsTotal: regressions.length,
  regressionsCorrect: regressions.filter((r) => r.correct).length,
};

console.log(
  `\n[intent-eval] today's detectors, over ${summary.utterances} utterances ` +
    `(${summary.swedish} Swedish)\n` +
    `  overall        ${correct}/${rows.length} routed correctly (${pct(correct, rows.length)})\n` +
    `  of the three   ${correctReachable}/${reachable.length} (${pct(correctReachable, reachable.length)}) ` +
    `— the rest of the taxonomy is UNREACHABLE: ${unreachable.length} utterances have an intent ` +
    `today's code cannot express\n` +
    `  decisive       ${decisiveWrong.length} wrong of ${decisive.length} the rules should settle ` +
    `(precision ${pct(decisive.length - decisiveWrong.length, decisive.length)}; the design pins 100%)\n` +
    `  both fired     ${bothFired} messages match BOTH detectors and get both behaviours — the absence ` +
    `of a route, which is what M4 adds\n` +
    `  script         ${falseScript.length} false (an offer card and a ~6,000-token surface nobody asked for), ` +
    `${missedScript.length} missed\n` +
    `  analyze        ${falseAnalyze.length} false, ${missedAnalyze.length} missed\n` +
    `  regressions    ${summary.regressionsCorrect}/${summary.regressionsTotal} of the known-defect cases route correctly`,
);

if (regressions.length > 0) {
  console.log(`\n[intent-eval] the known-defect cases, one line each:`);
  for (const r of regressions) {
    console.log(
      `  ${r.correct ? "ok  " : "WRONG"} ${r.expected.padEnd(8)} got ${r.got.padEnd(8)} ` +
        `${r.scriptMatched ? `[script matched ${JSON.stringify(r.scriptMatched)}] ` : ""}${r.text}`,
    );
  }
}

if (showMisses) {
  console.log(`\n[intent-eval] every wrong route:`);
  for (const r of rows.filter((x) => !x.correct)) {
    console.log(
      `  want ${r.expected.padEnd(8)} got ${r.got.padEnd(8)} ${r.reachable ? "        " : "[UNREACHABLE]"} ` +
        `${r.lang} ${JSON.stringify(r.text)}`,
    );
  }
}

if (jsonOut) {
  mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
  writeFileSync(jsonOut, JSON.stringify({ summary, rows }, null, 2) + "\n", "utf8");
  console.log(`\n[intent-eval] wrote ${jsonOut}`);
}

// This is a BASELINE, not a gate: today's code cannot express six of the nine
// intents, so failing the run would only ever say "the router is unbuilt", which
// is already written down. It exits 0 and reports.
