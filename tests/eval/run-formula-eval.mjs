//! FILENAME: tests/eval/run-formula-eval.mjs
// PURPOSE: Measure how well a model writes Calcula formulas, graded by Calcula's
//          own engine.
// CONTEXT: The companion to `run-eval.mjs` (which measures SCRIPT authoring) and
//          the thing M0 of the AI plan exists to build. Every proposal is
//          evaluated against the task's fixture by
//          `core/calcula-format/examples/eval-formulas.rs`, so a pass means the
//          engine really produced the stated answer — not that a model's output
//          looked plausible.
//
//          WHY THE KNOBS ARE THE KNOBS. The plan's first decision is which model
//          to default to and what to put in its prompt, and the honest way to
//          settle that is a matrix rather than an argument:
//            --schema on|off      does constraining the reply shape help?
//            --retrieval 0|3      do worked examples earn their ~120 tokens?
//            --context on|off     does the ~300-token data description earn its
//                                 seconds of prompt processing?
//          Prompt length is the latency lever on a CPU, so each of these is a
//          real cost and none of them should be assumed.
//
//          A TASK CAN NEVER RETRIEVE ITSELF. Library-derived tasks are excluded
//          from the retrieval index by id. Without that the held-out half would
//          be scoring a lookup, and the number would be meaningless.
//
// USAGE
//   node tests/eval/run-formula-eval.mjs --provider ollama --model llama3.2:1b
//   node tests/eval/run-formula-eval.mjs --provider ollama --model qwen2.5-coder:3b \
//        --schema off --retrieval 0 --context off --json out/base.json
//
// A cloud provider reads its key from CALCULA_EVAL_API_KEY. This script never
// touches the OS keychain, where the PRODUCT stores keys.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { bundleAppModules } from "./lib/appBundle.mjs";
import { gradeJobs, resolveGrader } from "./lib/grader.mjs";

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
const schemaMode = String(arg("schema", "on"));
const useSchema = schemaMode !== "off";
// `lean` drops the free-text `assumptions` list from the schema. See the note on
// FORMULA_PROPOSAL_SCHEMA_LEAN: it is the field small models ramble in.
const leanSchema = schemaMode === "lean";
const retrievalK = Number(arg("retrieval", 3));
const useContext = String(arg("context", "on")) !== "off";
const repairRounds = Number(arg("repair", 0));
const split = String(arg("split", "all"));
const tagFilter = arg("tag", "");
const limit = Number(arg("limit", 0));
const jsonOut = arg("json");
// 600, not 300. A formula plus one sentence is well under 100 tokens, but a
// small model that starts repeating itself in `assumptions` will fill whatever
// it is given — and a truncated reply is the runner's fault, not the model's.
// The recovery in `extractProposal` handles the rest; this just makes it rarer.
const maxTokens = Number(arg("max-tokens", 600));
// Print the prompt and the raw reply for each task. The first thing to rule out
// when a score is bad is that the harness, not the model, is what is broken.
const showReplies = Boolean(arg("show-replies", false));
const requestTimeoutMs = Number(arg("timeout-ms", 180_000));

if (!providerId || !model) {
  console.error(
    "Usage: node tests/eval/run-formula-eval.mjs --provider <id> --model <name>\n" +
      "       [--schema on|off] [--retrieval N] [--context on|off] [--repair N]\n" +
      "       [--split all|hand|library] [--tag family] [--limit N] [--json out.json]",
  );
  process.exit(2);
}
if (!["all", "hand", "library"].includes(split)) {
  console.error(`--split must be all, hand or library (got ${split})`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// The product's own modules
// ---------------------------------------------------------------------------

const { mod: fa } = await bundleAppModules({
  appRoot,
  tag: "formula",
  exports: [
    { from: "src/api/formulaAssist/index.ts", names: "*" },
    { from: "src/api/formulaAssist/generated/formulaPatterns.ts", names: ["FORMULA_PATTERNS"] },
  ],
});

const {
  FORMULA_SYSTEM_PROMPT,
  buildFixtureContext,
  buildRepairPrompt,
  buildUserPrompt,
  buildIndex,
  rankPatterns,
  extractProposal,
  looksLocalized,
  estimateTokens,
  responseFormat,
  FORMULA_PATTERNS,
} = fa;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const corpus = JSON.parse(readFileSync(path.join(here, "formulas.json"), "utf8"));

/**
 * Held-out tasks mined from the verified pattern library.
 *
 * Only `doc` patterns qualify: those are the ones where the function document
 * AND the engine independently agree, so the expectation is evidence rather than
 * the engine grading its own homework. Selection is by a stable hash of the
 * FUNCTION name, so a function is wholly in or wholly out and a near-duplicate
 * example of a held-out function cannot leak into retrieval.
 */
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const heldOutFunctions = new Set(
  FORMULA_PATTERNS.filter((p) => p.oracle === "doc")
    .map((p) => p.fn)
    .filter((fn) => hash(fn) % 2 === 1),
);

const libraryTasks = FORMULA_PATTERNS.filter(
  (p) => p.oracle === "doc" && heldOutFunctions.has(p.fn),
).map((p) => ({
  id: `lib:${p.id}`,
  family: "library",
  lang: "en",
  intent: p.intent,
  fixture: { sheet: "Sheet1", cells: p.fixture },
  target: p.target,
  expect: p.expect,
  reference: p.formula,
  sourcePatternId: p.id,
}));

let tasks = [];
if (split === "all" || split === "hand") tasks = tasks.concat(corpus.tasks);
if (split === "all" || split === "library") tasks = tasks.concat(libraryTasks);
if (tagFilter) {
  tasks = tasks.filter(
    (t) => t.family === tagFilter || (t.tags ?? []).includes(tagFilter),
  );
}
if (limit > 0) tasks = tasks.slice(0, limit);
if (tasks.length === 0) {
  console.error("no tasks selected");
  process.exit(2);
}

// The retrieval index EXCLUDES every pattern that is being used as a task, so a
// task cannot be answered by retrieving itself.
//
// The FUNCTION-level exclusion is applied only when library tasks are actually
// in the run. Held-out functions are held out to stop a library task retrieving
// a sibling example of its own function; when no library task is present there
// is nothing to leak, and excluding them anyway would throw away half the
// corpus and understate what retrieval is worth.
const runsLibraryTasks = tasks.some((t) => t.sourcePatternId);
const taskPatternIds = new Set(tasks.map((t) => t.sourcePatternId).filter(Boolean));
const retrievalCorpus = FORMULA_PATTERNS.filter(
  (p) => !taskPatternIds.has(p.id) && (!runsLibraryTasks || !heldOutFunctions.has(p.fn)),
);
const index = retrievalK > 0 ? buildIndex(retrievalCorpus) : null;

// ---------------------------------------------------------------------------
// The provider call
// ---------------------------------------------------------------------------

const PROVIDER_ENDPOINTS = {
  ollama: "http://127.0.0.1:11434/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
  llamacpp: "http://127.0.0.1:8080/v1",
  vllm: "http://127.0.0.1:8000/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

async function complete(messages) {
  const base = baseUrl || PROVIDER_ENDPOINTS[providerId];
  if (!base) throw new Error(`No endpoint known for provider "${providerId}"; pass --base-url.`);
  const key = process.env.CALCULA_EVAL_API_KEY ?? "";
  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;

  const body = { model, max_tokens: maxTokens, temperature: 0, messages };
  if (useSchema) body.response_format = responseFormat(leanSchema);

  const started = Date.now();
  // A batch runner with no timeout hangs forever on a stalled endpoint, and the
  // symptom is indistinguishable from a slow model. A formula is a short
  // generation even on a 7B, so this is generous rather than tight.
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
    // CAPTURED AND REPORTED, because a truncated reply is indistinguishable
    // from a model that writes half a formula — and if `max_tokens` is doing
    // the truncating then the run is measuring this script's setting rather
    // than the model. A silent version of this would poison every number.
    finishReason: parsed.choices?.[0]?.finish_reason ?? "",
    ms: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Grading, through the engine
// ---------------------------------------------------------------------------

// Resolved once, up front and PRINTED, so a run can never be scored by a binary
// nobody meant to use.
const grader = resolveGrader({ repo });
console.log(
  `[formula-eval] grader: ${grader.exe}${grader.builtAt ? ` (built ${grader.builtAt})` : ""}`,
);

function gradeAll(entries) {
  if (entries.length === 0) return new Map();
  const parsed = gradeJobs(
    {
      sheetName: "Sheet1",
      jobs: entries.map(({ task, formula }) => ({
        id: task.id,
        fixture: task.fixture.cells,
        formulas: [{ a1: task.target, formula, expect: task.expect }],
      })),
    },
    grader,
  );
  return new Map(parsed.results.map((r) => [r.id, r]));
}

/** One line the model can act on, from a grader result. */
function findingsFrom(result) {
  if (!result) return ["the grader returned nothing for this formula"];
  if (result.error) return [result.error];
  const cell = result.cells[0];
  if (cell.outcome.parseError) return [`the formula does not parse: ${cell.outcome.parseError}`];
  if (!result.converged) return ["the sheet did not settle; the formula may be circular"];
  return [cell.verdict ? cell.verdict.reason : "the answer did not match"];
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const started = Date.now();
const state = tasks.map((task) => {
  const context = useContext
    ? buildFixtureContext(task.fixture.cells, task.target, task.fixture.sheet ?? "Sheet1")
    : null;
  const headers = context ? context.columns.map((c) => c.header ?? "").filter(Boolean) : [];
  const examples =
    index && retrievalK > 0
      ? rankPatterns(index, { intent: task.intent, headers }, retrievalK).map((r) => r.pattern)
      : [];
  const user = buildUserPrompt({ intent: task.intent, context, examples });
  return {
    task,
    messages: [
      { role: "system", content: FORMULA_SYSTEM_PROMPT },
      { role: "user", content: user },
    ],
    promptTokens: estimateTokens(FORMULA_SYSTEM_PROMPT) + estimateTokens(user),
    exampleIds: examples.map((e) => e.id),
    formula: "",
    reply: "",
    ms: 0,
    rounds: 0,
    localized: false,
    finishReason: "",
    error: "",
    passed: false,
    why: "",
  };
});

console.log(
  `[formula-eval] ${tasks.length} tasks | ${providerId}/${model} | schema=${schemaMode} ` +
    `retrieval=${retrievalK} context=${useContext ? "on" : "off"} repair=${repairRounds} split=${split}`,
);

for (let round = 0; round <= repairRounds; round++) {
  const pending = state.filter((s) => !s.passed && !s.error);
  if (pending.length === 0) break;
  if (round > 0) console.log(`[formula-eval] repair round ${round}: ${pending.length} task(s)`);

  for (const s of pending) {
    try {
      if (showReplies) {
        console.log(`\n--- ${s.task.id} PROMPT ---\n${s.messages[s.messages.length - 1].content}`);
      }
      const { text, ms, finishReason } = await complete(s.messages);
      s.reply = text;
      s.ms += ms;
      s.rounds = round + 1;
      s.finishReason = finishReason;
      if (showReplies) console.log(`--- ${s.task.id} REPLY ---\n${text}\n`);
      const proposal = extractProposal(text);
      if (!proposal) {
        s.formula = "";
        s.why = "the reply contained no formula";
        // Told, not silently retried. Without this the next round re-sends a
        // byte-identical prompt at temperature 0 and buys the same reply, which
        // spends a model call to learn nothing.
        if (round < repairRounds) {
          s.messages = [
            ...s.messages,
            { role: "assistant", content: text },
            {
              role: "user",
              content:
                "That reply contained no formula. Answer with JSON matching the schema, where \"formula\" is a single spreadsheet formula.",
            },
          ];
        }
        continue;
      }
      s.formula = proposal.formula;
      s.localized = looksLocalized(proposal.formula);
    } catch (e) {
      s.error = String(e && e.message ? e.message : e);
    }
  }

  const gradable = pending.filter((s) => !s.error && s.formula);
  const results = gradeAll(gradable);
  for (const s of gradable) {
    const r = results.get(s.task.id);
    const cell = r && !r.error ? r.cells[0] : null;
    s.passed = Boolean(cell && cell.verdict && cell.verdict.matched && r.converged);
    s.why = s.passed ? "" : findingsFrom(r)[0];
    if (!s.passed && round < repairRounds) {
      s.messages = [
        ...s.messages,
        { role: "assistant", content: s.reply },
        { role: "user", content: buildRepairPrompt(s.formula, findingsFrom(r)) },
      ];
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

for (const s of state) {
  const mark = s.error ? "ERROR" : s.passed ? "PASS " : "FAIL ";
  const why = s.error ? s.error : s.passed ? "" : `  (${s.why})`;
  console.log(`  ${mark} ${s.task.id}  ${s.formula || "-"}${why}`);
}

const ran = state.filter((s) => !s.error);
const passed = ran.filter((s) => s.passed);
const latencies = ran.map((s) => s.ms).sort((a, b) => a - b);
const pick = (q) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] : 0);
const meanPrompt = ran.length ? Math.round(ran.reduce((a, s) => a + s.promptTokens, 0) / ran.length) : 0;

const summary = {
  provider: providerId,
  model,
  schema: schemaMode,
  retrieval: retrievalK,
  context: useContext,
  repair: repairRounds,
  split,
  total: state.length,
  ran: ran.length,
  errored: state.length - ran.length,
  passed: passed.length,
  passRate: ran.length ? Number((passed.length / ran.length).toFixed(4)) : 0,
  medianMs: pick(0.5),
  p90Ms: pick(0.9),
  meanPromptTokens: meanPrompt,
  localizedReplies: ran.filter((s) => s.localized).length,
  noFormulaReplies: ran.filter((s) => !s.formula).length,
  truncatedReplies: ran.filter((s) => s.finishReason === "length").length,
  wallClockSec: Math.round((Date.now() - started) / 1000),
};

console.log(
  `\n[formula-eval] ${summary.passed}/${summary.ran} passed (${(summary.passRate * 100).toFixed(1)}%)` +
    `${summary.errored ? `, ${summary.errored} errored` : ""}` +
    ` | median ${summary.medianMs}ms, p90 ${summary.p90Ms}ms | ~${summary.meanPromptTokens} prompt tokens` +
    ` | ${summary.wallClockSec}s wall clock`,
);
if (summary.noFormulaReplies) {
  console.log(`[formula-eval] ${summary.noFormulaReplies} reply/replies contained no formula at all`);
}
if (summary.localizedReplies) {
  console.log(`[formula-eval] ${summary.localizedReplies} reply/replies used a locale separator`);
}
if (summary.truncatedReplies) {
  console.log(
    `[formula-eval] WARNING: ${summary.truncatedReplies} reply/replies hit the ${maxTokens}-token limit.\n` +
      "               Those are this runner's truncation, not the model's answer. Raise --max-tokens and re-run.",
  );
}

if (jsonOut && typeof jsonOut === "string") {
  mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
  writeFileSync(
    path.resolve(jsonOut),
    `${JSON.stringify(
      {
        summary,
        // Per task, so two runs can be compared pairwise (see compare-runs.mjs).
        results: state.map((s) => ({
          id: s.task.id,
          family: s.task.family,
          passed: s.passed,
          errored: Boolean(s.error),
          formula: s.formula,
          why: s.why || s.error,
          ms: s.ms,
          promptTokens: s.promptTokens,
          rounds: s.rounds,
          examples: s.exampleIds,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`[formula-eval] per-task results written to ${jsonOut}`);
}

process.exit(summary.errored > 0 ? 1 : 0);
