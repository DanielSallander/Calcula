//! FILENAME: tests/eval/run-next-edit-eval.mjs
// PURPOSE: Measure the next-edit row's MODEL chip: how often the model's next
//          clause is the clause the corpus calls right, how often it stays
//          quiet on a query that is already finished, and how long a person
//          waits for it.
// CONTEXT: Layer B of the next-edit work. Layer A
//          (`nextEditCorpus.test.ts`) runs the Tier-0 rules over the same
//          prefixes in CI with no model at all; this drives a real runtime.
//
//          IT MEASURES THE PRODUCT, NOT A PORT OF IT. Every step the row takes
//          is imported, never re-typed: `rulesChips` is the row's own chip
//          loop, `buildNextClauseRequest` assembles the same prompt and the
//          same grammar the row sends, `nextClauseSuggestion` turns the reply
//          into a suggestion the same way, `applyEditOp` edits the text the
//          same way and `worseThan` is the same compile veto. What is left
//          here is the HTTP call and the arithmetic.
//
// THE THREE NUMBERS, and why each is separate:
//
//   1. EXACT NEXT CLAUSE, over prefixes of a correct query. The reference's own
//      next line is the answer. This is what the chip is FOR.
//   2. QUIET ON A FINISHED QUERY. A complete reference is fed in whole and the
//      right answer is nothing at all. The grammar permits the empty reply on
//      purpose; before it did, a model could not stay quiet even when told to,
//      so this number could only ever have been zero. A chip offered here is a
//      nag, and a nag is what makes people turn a feature off.
//   3. LATENCY, warm. The gate: median <= 400 ms. A suggestion that arrives
//      after the next keystroke is not a suggestion.
//
//      The rules' own recall over the same prefixes is reported beside them, so
//      the question the milestone actually asks — what does the model ADD over
//      Tier 0 — is answered by the same run rather than by comparing two.
//
// USAGE
//   node tests/eval/run-next-edit-eval.mjs --provider llamacpp --model default
//   node tests/eval/run-next-edit-eval.mjs --provider llamacpp --model default \
//        --grammar off --json out/ne-nogrammar.json
//   node tests/eval/run-next-edit-eval.mjs --provider ollama --model qwen2.5-coder:3b --limit 20
//
// A cloud provider reads its key from CALCULA_EVAL_API_KEY. This script never
// touches the OS keychain, where the PRODUCT stores keys.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { bundleAppModules } from "./lib/appBundle.mjs";
import { modelInfoFromFixture, strategySummaryFromFixture } from "./lib/modelFixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const appRoot = path.join(repo, "app");

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

const providerId = arg("provider");
const model = arg("model");
const baseUrl = arg("base-url", "");
// The row asks nothing at all of a runtime that does not honour a grammar, so
// `on` is the product's only shipping shape. `off` exists to measure what the
// grammar buys, the way the design-query runner does — the answer there was
// 100% compile rate and half the latency, and correctness unchanged.
const useGrammar = String(arg("grammar", "on")) !== "off";
const limit = Number(arg("limit", 0));
const jsonOut = arg("json");
const showReplies = Boolean(arg("show-replies", false));
const requestTimeoutMs = Number(arg("timeout-ms", 60_000));
/** Untimed requests before the measured run, so "warm" means warm. */
const warmups = Number(arg("warmup", 3));
/** The gate, in milliseconds of median latency. */
const gateMedianMs = Number(arg("gate-median-ms", 400));

if (!providerId || !model) {
  console.error(
    "Usage: node tests/eval/run-next-edit-eval.mjs --provider <id> --model <name>\n" +
      "       [--grammar on|off] [--limit N] [--warmup N] [--gate-median-ms N]\n" +
      "       [--base-url URL] [--json out.json] [--show-replies]",
  );
  process.exit(2);
}
// A grammar is only ever HONOURED by llama.cpp's server. Every other runtime
// ignores an unknown body key in silence, so a run against Ollama would print
// `grammar=on`, send the field, have it dropped, and report the model's
// unconstrained answers as grammar-constrained ones. The sibling runner refuses
// exactly this, for exactly this reason: a run that thinks it measured a
// grammar and did not is worse than no run. The row itself is gated on
// `honorsGrammar()`, so a run without one is measuring something the product
// would never do — say so out loud rather than inferring it from a flag.
if (useGrammar && providerId !== "llamacpp") {
  console.error(
    `--grammar is only honoured by llama.cpp's server, not "${providerId}".\n` +
      `The next-edit row asks nothing of a runtime that does not honour one, so measuring that\n` +
      `runtime here means measuring a path the product does not take. Pass --grammar off if that\n` +
      `is genuinely what you want; the report then says grammar=off.`,
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// The product's own modules
// ---------------------------------------------------------------------------

const { mod } = await bundleAppModules({
  appRoot,
  tag: "next-edit",
  exports: [
    { from: "src/api/designQueryAssist/index.ts", names: "*" },
    {
      from: "extensions/_shared/dsl/pivotLayout/nextEditFacts.ts",
      names: ["applyEditOp", "factsFromDsl", "presentClauses", "rulesChips", "worseThan"],
    },
    { from: "extensions/_shared/dsl/pivotLayout/designQuery.ts", names: ["compileDesignQuery"] },
    { from: "extensions/_shared/dsl/pivotLayout/canonical.ts", names: ["sameDesignQuery"] },
  ],
});
const {
  applyEditOp, factsFromDsl, presentClauses, rulesChips, worseThan,
  compileDesignQuery, sameDesignQuery,
  buildNextClauseRequest, chooseCandidates, nextClauseSuggestion, estimateTokens,
} = mod;

// ---------------------------------------------------------------------------
// Fixture and tasks
// ---------------------------------------------------------------------------

const bundle = JSON.parse(readFileSync(path.join(repo, "tests/fixtures/model/sales_star.json"), "utf8"));
const strategyDoc = JSON.parse(readFileSync(path.join(repo, "tests/fixtures/model/sales_star_strategy.json"), "utf8"));
const biModel = { ...modelInfoFromFixture(bundle), strategy: strategySummaryFromFixture(strategyDoc, bundle) };
const tableNames = biModel.tables.map((t) => t.name);
const compile = (dsl) => compileDesignQuery(dsl, "fixture", biModel);

// The row asks with an EMPTY intent: a person typing a query has not described
// it in words, so there is nothing to rank the names by. Ranking them by the
// corpus task's intent would measure a pipeline the product does not run — and
// would flatter the result, because the intent names the very columns the
// reference uses.
const candidates = chooseCandidates(biModel, "");

const corpus = JSON.parse(readFileSync(path.join(here, "design-queries.json"), "utf8"));

/** Every prefix of every correct query, plus the finished query itself. */
function buildTasks() {
  const queries = [];
  for (const task of corpus.tasks) {
    queries.push({ id: task.id, dsl: task.reference });
    for (const [i, alt] of (task.alternatives ?? []).entries()) {
      queries.push({ id: `${task.id}#alt${i + 1}`, dsl: alt });
    }
  }
  const tasks = [];
  for (const { id, dsl } of queries) {
    const lines = dsl.split("\n");
    for (let k = 1; k < lines.length; k++) {
      tasks.push({
        id: `${id}:${k}`,
        kind: "next",
        prefix: lines.slice(0, k).join("\n"),
        target: lines.slice(0, k + 1).join("\n"),
        expected: lines[k],
      });
    }
    // The finished query: the right answer is silence.
    tasks.push({ id: `${id}:end`, kind: "end", prefix: dsl, target: dsl, expected: "" });
  }
  return tasks;
}

let tasks = buildTasks();
if (limit > 0) tasks = tasks.slice(0, limit);
if (tasks.length === 0) {
  console.error("no tasks selected");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

const PROVIDER_ENDPOINTS = {
  ollama: "http://127.0.0.1:11434/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
  llamacpp: "http://127.0.0.1:8080/v1",
  vllm: "http://127.0.0.1:8000/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

async function complete(request) {
  const base = baseUrl || PROVIDER_ENDPOINTS[providerId];
  if (!base) throw new Error(`No endpoint known for provider "${providerId}"; pass --base-url.`);
  const key = process.env.CALCULA_EVAL_API_KEY ?? "";
  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;

  const body = {
    model,
    // The request carries its own budget, so the row and this cannot diverge.
    max_tokens: request.maxTokens,
    temperature: 0,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
  };
  if (useGrammar) body.grammar = request.grammar;

  const started = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
  const parsed = await res.json();
  return {
    text: parsed.choices?.[0]?.message?.content ?? "",
    finishReason: parsed.choices?.[0]?.finish_reason ?? "",
    ms: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// One task, the way the row runs it
// ---------------------------------------------------------------------------

/**
 * The chip the row would show for `text`, or a reason it would show none.
 *
 * Every gate the row applies, in the row's order: a query that does not parse
 * is not asked about, a grammar that cannot express a next clause means no
 * request at all, an empty reply is an answer, an edit that changes nothing is
 * dropped, and an edit that makes the query worse is vetoed.
 */
async function modelChipFor(text) {
  const facts = factsFromDsl(text, tableNames);
  if (facts.hasParseErrors) return { outcome: "unparsed", ms: 0 };
  const request = buildNextClauseRequest(candidates, presentClauses(facts), text);
  if (!request) return { outcome: "no-grammar", ms: 0 };

  const reply = await complete(request);
  const promptTokens = estimateTokens(request.system) + estimateTokens(request.user);
  const base = { ms: reply.ms, promptTokens, reply: reply.text, finishReason: reply.finishReason };

  const suggestion = nextClauseSuggestion(reply.text, model);
  if (!suggestion) return { ...base, outcome: "silent" };
  const applied = applyEditOp(text, suggestion.op);
  if (applied === text) return { ...base, outcome: "no-op", line: suggestion.op.line };
  if (worseThan(compile(text), compile(applied))) {
    return { ...base, outcome: "vetoed", line: suggestion.op.line, applied };
  }
  return { ...base, outcome: "chip", line: suggestion.op.line, applied };
}

// ---------------------------------------------------------------------------
// Harness self-check
// ---------------------------------------------------------------------------

// A 0% score is a claim about the MODEL only if a right answer would have
// scored. Feed the scorer the oracle — each reference's own next line, the
// exact string the model is being asked for — through the same
// `nextClauseSuggestion` -> `applyEditOp` -> `sameDesignQuery` path, and refuse
// to run at all if it does not come back as a hit. A scorer that cannot
// recognise the right answer reports a perfect zero and looks like a finding.
//
// It runs the oracle through the WHOLE measured path, compile veto included —
// not just the scorer. Two different failures come out of that, and conflating
// them is how a harness lies in the reassuring direction:
//
//   BROKEN  the scorer cannot recognise the right answer. The run stops.
//   CAPPED  the scorer recognises it but the row's veto would refuse it, so
//           no model can ever score that task. The run continues and the
//           CEILING is printed, because "0 of 80" and "0 of 79 reachable" are
//           different claims and only one of them is true.
let unreachable = [];
{
  const broken = [];
  const prefixTasks = tasks.filter((t) => t.kind === "next");
  for (const task of prefixTasks) {
    const suggestion = nextClauseSuggestion(task.expected, "oracle");
    if (!suggestion) {
      broken.push(`${task.id}: the reference's own next line yields no suggestion — ${JSON.stringify(task.expected)}`);
      continue;
    }
    const applied = applyEditOp(task.prefix, suggestion.op);
    if (applied === task.prefix) {
      broken.push(`${task.id}: applying the reference's own next line changed nothing — ${JSON.stringify(task.expected)}`);
      continue;
    }
    if (!sameDesignQuery(applied, task.target)) {
      broken.push(`${task.id}: the oracle answer did not score — ${JSON.stringify(task.expected)}`);
      continue;
    }
    if (worseThan(compile(task.prefix), compile(applied))) {
      unreachable.push(`${task.id}: ${JSON.stringify(task.expected)} — the row's compile veto refuses the corpus's own answer`);
    }
  }
  if (broken.length > 0) {
    console.error(
      `[next-edit-eval] THE HARNESS CANNOT SCORE ITS OWN ORACLE on ${broken.length}/${prefixTasks.length} prefix tasks.\n` +
        broken.slice(0, 10).map((b) => `  ${b}`).join("\n") +
        `\nA model measured by this would score zero for the harness's reasons. Fix the harness first.`,
    );
    process.exit(3);
  }
  const ceiling = prefixTasks.length - unreachable.length;
  console.log(`[next-edit-eval] harness self-check: the oracle scores on ${ceiling}/${prefixTasks.length} prefix tasks.`);
  if (unreachable.length > 0) {
    console.log(
      `[next-edit-eval] ${unreachable.length} task(s) are UNREACHABLE — a perfect model scores ${ceiling}, not ${prefixTasks.length}:\n` +
        unreachable.map((u) => `  ${u}`).join("\n"),
    );
  }
}

// The Tier-0 baseline, computed BEFORE a single request and loudly.
//
// It needs no network, and it is the number the milestone decision rests on:
// "what does the model ADD over the rules". An earlier version computed it
// inside the measured loop behind a bare `catch {}`, which made a CRASHED
// baseline indistinguishable from an empty one — every row's `rulesHit` stayed
// false, the report printed "rules 0/80", and every model hit was then counted
// as something the model added. That is the same defect the oracle check above
// exists to prevent, so it gets the same treatment: one throw and the run stops.
const rulesHit = new Map();
{
  const failures = [];
  for (const task of tasks) {
    try {
      const chips = rulesChips(task.prefix, biModel, tableNames, compile);
      rulesHit.set(
        task.id,
        task.kind === "next" ? chips.some((c) => sameDesignQuery(c.applied, task.target)) : chips.length === 0,
      );
    } catch (e) {
      failures.push(`${task.id}: ${e && e.message ? e.message : e}`);
    }
  }
  if (failures.length > 0) {
    console.error(
      `[next-edit-eval] THE TIER-0 BASELINE THREW on ${failures.length}/${tasks.length} tasks.\n` +
        failures.slice(0, 10).map((f) => `  ${f}`).join("\n") +
        `\nWithout it "what the model adds over the rules" is unmeasurable, and a crashed baseline` +
        `\nreads as a baseline of zero. Fix the rules or the fixture first.`,
    );
    process.exit(3);
  }
  const hits = [...rulesHit.values()].filter(Boolean).length;
  console.log(`[next-edit-eval] Tier-0 baseline: ${hits}/${tasks.length} tasks answered by the rules alone.`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log(
  `[next-edit-eval] ${tasks.length} tasks | ${providerId}/${model} | grammar=${useGrammar ? "on" : "off"} | ` +
    `warmup=${warmups} | gate median <= ${gateMedianMs} ms`,
);

// Warm the prefix cache before anything is timed. The system prompt and the
// name blocks are byte-stable across every request in a run, so the first call
// pays for a prefill nobody else pays for; timing it would measure the cache
// miss rather than what a person typing a query experiences.
// It counts REQUESTS, not iterations: `modelChipFor` returns without sending
// anything when a query does not parse or the grammar cannot express a next
// clause, so a loop counting turns could warm nothing at all and still say it
// warmed three times. And it warms from the END of the list, so the tasks whose
// exact prompt sits in the cache afterwards are the ones measured LAST, by
// which time every other request has overwritten it — at `--limit 3` the old
// version pre-cached every task it then timed.
{
  let sent = 0;
  for (let i = 0; i < tasks.length && sent < warmups; i++) {
    const task = tasks[tasks.length - 1 - i];
    try {
      const got = await modelChipFor(task.prefix);
      if (got.ms > 0) sent++;
    } catch (e) {
      console.error(`[next-edit-eval] warm-up failed: ${e && e.message ? e.message : e}`);
      process.exit(1);
    }
  }
  if (warmups > 0 && sent < warmups) {
    console.log(`[next-edit-eval] warm-up sent ${sent} of ${warmups} requested (the rest needed none).`);
  }
}

const results = [];
for (const task of tasks) {
  const row = {
    id: task.id, kind: task.kind, expected: task.expected,
    // `passed` is the field name every sibling runner uses and the ONLY one
    // `compare-runs.mjs` reads. Without it a paired McNemar comparison of two
    // runs reads `undefined` on both sides, scores every task as "neither
    // passed", and prints "the setting changed nothing" with confidence — and
    // this runner invites exactly that comparison with `--grammar off`.
    // `exact` stays beside it because the reports speak of exact next clauses.
    outcome: "", line: "", reply: "", exact: false, passed: false,
    ms: 0, promptTokens: 0, finishReason: "", error: "",
    rulesHit: false, modelHit: false,
  };

  // Tier 0 over the same prefix, computed above so a crash there stops the run
  // instead of quietly reading as a baseline of zero.
  row.rulesHit = rulesHit.get(task.id) === true;

  try {
    const got = await modelChipFor(task.prefix);
    row.outcome = got.outcome;
    row.line = got.line ?? "";
    // The RAW reply, kept. `line` is the parsed first line of an op that
    // survived `nextClauseSuggestion`, so on a "silent" outcome it is empty and
    // on `--grammar off` it can be one line of prose. A headline of 0 of 80
    // that cannot be audited afterwards is a number nobody can act on.
    row.reply = got.reply ?? "";
    row.ms = got.ms ?? 0;
    row.promptTokens = got.promptTokens ?? 0;
    row.finishReason = got.finishReason ?? "";
    if (task.kind === "next") {
      row.exact = got.outcome === "chip" && sameDesignQuery(got.applied, task.target);
    } else {
      // On a finished query the right answer is no chip at all. A reply the
      // veto caught still counts as quiet FOR THE PERSON — nothing appeared —
      // but it is reported apart from real silence below, because a chip that
      // only the veto stopped is a model that wanted to nag.
      row.exact = got.outcome !== "chip";
    }
    row.modelHit = row.exact;
    row.passed = row.exact;
  } catch (e) {
    row.error = String(e && e.message ? e.message : e);
  }
  results.push(row);
  if (showReplies) {
    console.log(`\n--- ${task.id} (${task.kind}) ---\n${task.prefix}\n  want: ${task.expected || "(nothing)"}\n  got : ${row.line || `(${row.outcome})`}`);
  } else {
    const mark = row.error ? "ERROR" : row.exact ? "HIT  " : "MISS ";
    console.log(`  ${mark} ${row.id}  want ${JSON.stringify(task.expected)}  got ${JSON.stringify(row.line)} [${row.outcome}]${row.error ? `  ${row.error}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const ran = results.filter((r) => !r.error);
const next = ran.filter((r) => r.kind === "next");
const ends = ran.filter((r) => r.kind === "end");
const timed = ran.filter((r) => r.ms > 0).map((r) => r.ms).sort((a, b) => a - b);
const pick = (q) => (timed.length ? timed[Math.min(timed.length - 1, Math.floor(q * timed.length))] : 0);
const rate = (n, d) => (d ? n / d : 0);
const count = (rows, outcome) => rows.filter((r) => r.outcome === outcome).length;

const exact = next.filter((r) => r.exact).length;
const rulesOnly = next.filter((r) => r.rulesHit).length;
const union = next.filter((r) => r.rulesHit || r.modelHit).length;
const addedByModel = next.filter((r) => !r.rulesHit && r.modelHit).length;
const quiet = ends.filter((r) => r.exact).length;
const trulySilent = count(ends, "silent") + count(ends, "no-grammar");
const nagged = ends.filter((r) => r.outcome === "chip").length;
const medianMs = pick(0.5);

/** Every independent variable, one key per CLI knob (see run-design-query-eval.mjs). */
const knobs = {
  provider: String(providerId ?? ""),
  model: String(model ?? ""),
  baseUrl: String(baseUrl ?? ""),
  grammar: Boolean(useGrammar),
  limit: Number(limit),
  warmup: Number(warmups),
  gateMedianMs: Number(gateMedianMs),
};

const summary = {
  provider: providerId, model, grammar: useGrammar,
  knobs,
  tasks: results.length, ran: ran.length, errors: results.length - ran.length,
  prefixTasks: next.length,
  exact, exactRate: rate(exact, next.length),
  rulesOnly, rulesRate: rate(rulesOnly, next.length),
  union, unionRate: rate(union, next.length),
  addedByModel, addedRate: rate(addedByModel, next.length),
  silentOnPrefix: count(next, "silent"),
  vetoedOnPrefix: count(next, "vetoed"),
  noOpOnPrefix: count(next, "no-op"),
  endTasks: ends.length,
  quiet, quietRate: rate(quiet, ends.length),
  trulySilent, vetoSaved: count(ends, "vetoed") + count(ends, "no-op"), nagged,
  medianMs, p90Ms: pick(0.9),
  meanPromptTokens: ran.length ? Math.round(ran.reduce((a, r) => a + r.promptTokens, 0) / ran.length) : 0,
  truncated: ran.filter((r) => r.finishReason === "length").length,
  // What a PERFECT model could score: the veto refuses the corpus's own answer
  // on a few tasks, and reporting `exact/80` while the ceiling is 79 overstates
  // the miss.
  ceiling: next.length - unreachable.length,
  unreachable: unreachable.length,
  gateMedianMs,
  // ERRORS FAIL THE GATE. Per-request failures are caught per row and the loop
  // continues, so a server that times out or dies mid-run silently shrinks
  // every denominator: `exact/next.length` and the median are then computed
  // over survivors and can look fine. The all-or-nothing case was handled; the
  // realistic partial one was not.
  gatePassed: timed.length > 0 && medianMs <= gateMedianMs && results.length - ran.length === 0,
};

const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log(
  `\n[next-edit-eval] ${summary.provider}/${summary.model} grammar=${summary.grammar ? "on" : "off"}\n` +
    `  next clause   exact ${exact}/${next.length} (${pct(summary.exactRate)})` +
    (summary.unreachable > 0 ? ` [ceiling ${summary.ceiling}: ${summary.unreachable} vetoed for everyone]` : "") + ` | ` +
    `rules ${rulesOnly}/${next.length} (${pct(summary.rulesRate)}) | ` +
    `together ${union}/${next.length} (${pct(summary.unionRate)}) | model adds ${addedByModel} (${pct(summary.addedRate)})\n` +
    `  on a prefix   silent ${summary.silentOnPrefix} | vetoed ${summary.vetoedOnPrefix} | no-op ${summary.noOpOnPrefix}\n` +
    `  finished      quiet ${quiet}/${ends.length} (${pct(summary.quietRate)}) — ` +
    `said nothing ${trulySilent}, veto caught ${summary.vetoSaved}, nagged ${nagged}\n` +
    `  latency       median ${summary.medianMs} ms | p90 ${summary.p90Ms} ms | mean prompt ${summary.meanPromptTokens} tok | ` +
    `truncated ${summary.truncated} | errors ${summary.errors}\n` +
    `  GATE          median <= ${gateMedianMs} ms and no request errors: ${summary.gatePassed ? "PASS" : "FAIL"}`,
);

if (jsonOut) {
  mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
  writeFileSync(jsonOut, JSON.stringify({ summary, results }, null, 2) + "\n", "utf8");
  console.log(`[next-edit-eval] wrote ${jsonOut}`);
}

// The latency gate is the one this milestone commits to; the exact rate is
// recorded and decides whether the chip ships on by default, which is a
// judgement rather than a threshold.
process.exit(summary.gatePassed ? 0 : 1);
