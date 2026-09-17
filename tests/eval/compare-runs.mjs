//! FILENAME: tests/eval/compare-runs.mjs
// PURPOSE: Decide whether one formula-eval configuration is really better than
//          another, rather than eyeballing two pass rates.
// CONTEXT: A hundred-task corpus puts the standard error of a pass rate at
//          roughly five points, so two runs differing by "a few points" are
//          indistinguishable from noise — and the plan's design questions
//          ("does retrieval earn its tokens?") are exactly that size.
//
//          The runs are PAIRED: the same tasks, the same grader, one setting
//          changed. That makes McNemar's exact test the right instrument. It
//          ignores the tasks both runs agree on, which carry no information
//          about the difference, and asks only whether the DISCORDANT pairs are
//          lopsided enough to be surprising under the null.
//
//          Reporting the discordant counts alongside the p-value is deliberate:
//          "b=9 c=2, p=0.065" tells you what a bare p-value cannot, which is
//          that the evidence leans one way on eleven tasks.
//
// USAGE
//   node tests/eval/compare-runs.mjs out/base.json out/with-retrieval.json

import { readFileSync } from "node:fs";

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error("Usage: node tests/eval/compare-runs.mjs <a.json> <b.json>");
  process.exit(2);
}

const a = JSON.parse(readFileSync(aPath, "utf8"));
const b = JSON.parse(readFileSync(bPath, "utf8"));

const byId = (run) => new Map(run.results.map((r) => [r.id, r]));
const A = byId(a);
const B = byId(b);

const shared = [...A.keys()].filter((id) => B.has(id));
if (shared.length === 0) {
  console.error("the two runs share no tasks; they cannot be compared pairwise");
  process.exit(2);
}
if (shared.length !== A.size || shared.length !== B.size) {
  console.log(
    `[compare] NOTE: comparing the ${shared.length} tasks both runs contain ` +
      `(A had ${A.size}, B had ${B.size})`,
  );
}

/**
 * Tasks whose reply was CUT OFF by the runner's token limit, per side. A
 * failure on a truncated reply is the runner's doing, not the model's, so a
 * discordant pair whose losing side was truncated is marked `*` below rather
 * than counted as evidence in silence. Every runner records this per task
 * (`finishReason === "length"` on the chat runners, `truncated` on infill).
 */
const truncatedIn = (run) =>
  new Set(run.results.filter((r) => r.finishReason === "length" || r.truncated === true).map((r) => r.id));
const truncA = truncatedIn(a);
const truncB = truncatedIn(b);

let both = 0;
let neither = 0;
let onlyA = 0; // A passed, B failed
let onlyB = 0; // B passed, A failed
const flippedToB = [];
const flippedToA = [];
let flipsOnTruncation = 0;
for (const id of shared) {
  const pa = A.get(id).passed;
  const pb = B.get(id).passed;
  if (pa && pb) both++;
  else if (!pa && !pb) neither++;
  else if (pa) {
    onlyA++;
    // B failed here — was B cut off?
    const cut = truncB.has(id);
    if (cut) flipsOnTruncation++;
    flippedToA.push(cut ? `${id}*` : id);
  } else {
    onlyB++;
    const cut = truncA.has(id);
    if (cut) flipsOnTruncation++;
    flippedToB.push(cut ? `${id}*` : id);
  }
}

/** log(n choose k), via lgamma, so large n cannot overflow. */
function lgamma(x) {
  // Lanczos approximation; plenty for the counts this test sees.
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let sum = c[0];
  for (let i = 1; i < g + 2; i++) sum += c[i] / (x + i);
  const t = x + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(sum);
}
function logChoose(n, k) {
  return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
}

/**
 * McNemar's EXACT test: a two-sided binomial test on the discordant pairs.
 *
 * Exact rather than the chi-squared approximation because the discordant counts
 * here are routinely under 25, which is precisely where the approximation stops
 * being trustworthy.
 */
function mcnemarExact(b1, c1) {
  const n = b1 + c1;
  if (n === 0) return 1;
  const lo = Math.min(b1, c1);
  let tail = 0;
  for (let i = 0; i <= lo; i++) tail += Math.exp(logChoose(n, i) + n * Math.log(0.5));
  return Math.min(1, 2 * tail);
}

const p = mcnemarExact(onlyA, onlyB);
const rateA = (both + onlyA) / shared.length;
const rateB = (both + onlyB) / shared.length;

/**
 * What actually differs between two runs, read off their own knob blocks.
 *
 * THE OLD LABEL NAMED FOUR HARDCODED KEYS and `grammar` was not one of them —
 * so the two most important design-query arms printed IDENTICAL headers, and
 * `retrieval`/`context` printed `undefined` for a pipeline that has no such
 * knobs. A comparison tool that cannot say what was varied is a tool that
 * invites a conclusion about the wrong variable.
 *
 * Diffing the blocks also catches the case nobody can catch by eye: two runs
 * that were MEANT to differ and do not. If this prints "the two runs were
 * configured identically", the experiment did not happen.
 */
function knobsOf(run) {
  if (run.summary && run.summary.knobs) return run.summary.knobs;
  // A pre-2026-09-15 artifact has no knob block. Recover what is recoverable
  // and say so, rather than silently comparing against absent keys.
  const s = run.summary || {};
  return {
    provider: s.provider,
    model: s.model,
    schema: s.schema,
    grammar: s.grammar,
    retrieval: s.retrieval,
    context: s.context,
    repair: s.repair,
    __legacy: true,
  };
}

function knobDiff(ka, kb) {
  const keys = [...new Set([...Object.keys(ka), ...Object.keys(kb)])].filter((k) => k !== "__legacy");
  const changed = [];
  for (const k of keys) {
    const va = ka[k];
    const vb = kb[k];
    if (JSON.stringify(va) !== JSON.stringify(vb)) changed.push(`${k}: ${JSON.stringify(va)} -> ${JSON.stringify(vb)}`);
  }
  return changed;
}

const ka = knobsOf(a);
const kb = knobsOf(b);
const changedKnobs = knobDiff(ka, kb);

console.log(`A: ${ka.model ?? "?"}  [${aPath}]`);
console.log(`B: ${kb.model ?? "?"}  [${bPath}]`);
if (ka.__legacy || kb.__legacy) {
  console.log("  (one or both runs predate the knob block; the diff below may be incomplete)");
}
console.log("");
if (changedKnobs.length === 0) {
  console.log("  WHAT CHANGED: nothing — the two runs were configured identically.");
  console.log("                Any difference below is run-to-run noise, not an effect.");
} else {
  console.log("  WHAT CHANGED:");
  for (const line of changedKnobs) console.log(`    ${line}`);
}
console.log("");
console.log(`  tasks compared          ${shared.length}`);
console.log(`  A pass rate             ${(rateA * 100).toFixed(1)}%`);
console.log(`  B pass rate             ${(rateB * 100).toFixed(1)}%`);
console.log(`  both passed             ${both}`);
console.log(`  neither passed          ${neither}`);
console.log(`  A only (B broke these)  ${onlyA}`);
console.log(`  B only (B fixed these)  ${onlyB}`);
console.log(`  McNemar exact p         ${p.toFixed(4)}`);
console.log(`  truncated replies       A ${truncA.size}, B ${truncB.size}`);
if (flipsOnTruncation > 0) {
  console.log(
    `  CAUTION: ${flipsOnTruncation} of the ${onlyA + onlyB} discordant pairs failed on a CUT-OFF reply (marked *).\n` +
      "           Those are the runner's token limit, not the model. Raise --max-tokens and re-run before deciding.",
  );
}
console.log("");
if (onlyA + onlyB === 0) {
  console.log("  VERDICT: the two runs agree on every task. The setting changed nothing.");
} else if (p < 0.05) {
  console.log(
    `  VERDICT: ${onlyB > onlyA ? "B" : "A"} is better, and the difference is unlikely to be chance (p < 0.05).`,
  );
} else {
  console.log(
    "  VERDICT: not significant. The runs differ on some tasks, but not lopsidedly enough\n" +
      "           to conclude one setting is better. Do not decide a design on this.",
  );
}

if (flippedToB.length) console.log(`\n  fixed by B: ${flippedToB.slice(0, 12).join(", ")}`);
if (flippedToA.length) console.log(`  broken by B: ${flippedToA.slice(0, 12).join(", ")}`);

console.log(
  `\n  prompt tokens: A ~${a.summary.meanPromptTokens}, B ~${b.summary.meanPromptTokens}` +
    ` | median latency: A ${a.summary.medianMs}ms, B ${b.summary.medianMs}ms`,
);
