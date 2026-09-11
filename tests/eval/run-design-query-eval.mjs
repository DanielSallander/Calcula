//! FILENAME: tests/eval/run-design-query-eval.mjs
// PURPOSE: Measure how well a model writes Calcula design queries, graded by
//          Calcula's own compiler and canonical form.
// CONTEXT: The companion to `run-formula-eval.mjs`. It drives the PRODUCT's
//          own loop — `draftDesignQuery` in `_shared/dsl/pivotLayout/draft.ts`
//          — with a provider object that speaks to an OpenAI-compatible
//          endpoint, so the number is about the model and the pipeline the
//          product runs, never a port of it. Layer A
//          (`designQueryCorpus.test.ts`) holds the corpus honest in CI.
//
//          WHY THE KNOBS ARE THE KNOBS. The programme's standing rule is to
//          measure before polishing: does the schema help, does a grammar help
//          where a runtime honours one, do the shaped examples earn their
//          tokens, does one repair round pay. Each is a paired comparison
//          through `compare-runs.mjs`.
//
// USAGE
//   node tests/eval/run-design-query-eval.mjs --provider ollama --model qwen2.5-coder:1.5b
//   node tests/eval/run-design-query-eval.mjs --provider llamacpp --model default --grammar on
//   node tests/eval/run-design-query-eval.mjs --provider ollama --model qwen2.5-coder:3b \
//        --schema off --examples off --repair 1 --json out/dq.json
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
const useSchema = String(arg("schema", "on")) !== "off";
// A grammar is only ever sent to llama.cpp's server. `on` there means the
// reply is the bare query; anywhere else the flag is refused rather than
// silently ignored, because a run that thinks it measured a grammar and did
// not is worse than no run.
const useGrammar = String(arg("grammar", "off")) === "on";
const useExamples = String(arg("examples", "on")) !== "off";
const repairRounds = Number(arg("repair", 0));
const langFilter = arg("lang", "");
const tagFilter = arg("tag", "");
const limit = Number(arg("limit", 0));
const jsonOut = arg("json");
const showReplies = Boolean(arg("show-replies", false));
const requestTimeoutMs = Number(arg("timeout-ms", 180_000));

if (!providerId || !model) {
  console.error(
    "Usage: node tests/eval/run-design-query-eval.mjs --provider <id> --model <name>\n" +
      "       [--schema on|off] [--grammar on|off] [--examples on|off] [--repair N]\n" +
      "       [--lang en|sv] [--tag t] [--limit N] [--json out.json] [--show-replies]",
  );
  process.exit(2);
}
if (useGrammar && providerId !== "llamacpp") {
  console.error("--grammar on is only honoured by llama.cpp's server (--provider llamacpp).");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// The product's own modules
// ---------------------------------------------------------------------------

const { mod } = await bundleAppModules({
  appRoot,
  tag: "design-query",
  exports: [
    { from: "src/api/designQueryAssist/index.ts", names: "*" },
    { from: "extensions/_shared/dsl/pivotLayout/draft.ts", names: ["draftDesignQuery"] },
    { from: "extensions/_shared/dsl/pivotLayout/designQuery.ts", names: ["compileDesignQuery"] },
    { from: "extensions/_shared/dsl/pivotLayout/canonical.ts", names: ["canonicalDesignQuery"] },
  ],
});
const {
  draftDesignQuery, compileDesignQuery, canonicalDesignQuery,
  chooseCandidates, buildUserPrompt, designQuerySystemPrompt, estimateTokens,
} = mod;
// The grammar path asks for the bare query and shows bare examples; the token
// estimate below must count the prompt the loop actually sends.
const replyFormat = useGrammar ? "bare" : "json";

// ---------------------------------------------------------------------------
// Fixture and tasks
// ---------------------------------------------------------------------------

const bundle = JSON.parse(readFileSync(path.join(repo, "tests/fixtures/model/sales_star.json"), "utf8"));
const strategyDoc = JSON.parse(readFileSync(path.join(repo, "tests/fixtures/model/sales_star_strategy.json"), "utf8"));
const biModel = { ...modelInfoFromFixture(bundle), strategy: strategySummaryFromFixture(strategyDoc, bundle) };

const corpus = JSON.parse(readFileSync(path.join(here, "design-queries.json"), "utf8"));
let tasks = corpus.tasks;
if (langFilter) tasks = tasks.filter((t) => t.lang === langFilter);
if (tagFilter) tasks = tasks.filter((t) => (t.tags ?? []).includes(tagFilter));
if (limit > 0) tasks = tasks.slice(0, limit);
if (tasks.length === 0) {
  console.error("no tasks selected");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// The provider: the seam's shape over a bare OpenAI-compatible endpoint
// ---------------------------------------------------------------------------

const PROVIDER_ENDPOINTS = {
  ollama: "http://127.0.0.1:11434/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
  llamacpp: "http://127.0.0.1:8080/v1",
  vllm: "http://127.0.0.1:8000/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

let lastFinishReason = "";
async function complete(req) {
  const base = baseUrl || PROVIDER_ENDPOINTS[providerId];
  if (!base) throw new Error(`No endpoint known for provider "${providerId}"; pass --base-url.`);
  const key = process.env.CALCULA_EVAL_API_KEY ?? "";
  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;

  const messages = [{ role: "system", content: req.system }];
  for (const m of req.messages) messages.push({ role: m.role, content: m.text });
  const body = { model, max_tokens: req.maxTokens ?? 320, temperature: req.temperature ?? 0, messages };
  if (req.grammar) body.grammar = req.grammar;
  else if (useSchema && req.responseSchema) {
    body.response_format = { type: "json_schema", json_schema: { name: req.responseSchema.name, schema: req.responseSchema.schema } };
  }

  const started = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
  const parsed = await res.json();
  lastFinishReason = parsed.choices?.[0]?.finish_reason ?? "";
  return {
    text: parsed.choices?.[0]?.message?.content ?? "",
    truncated: lastFinishReason === "length",
    model,
    durationMs: Date.now() - started,
  };
}

const provider = {
  isConfigured: () => true,
  modelLabel: () => model,
  isLocal: () => Boolean(PROVIDER_ENDPOINTS[providerId]?.startsWith("http://127.")),
  honorsSchema: () => useSchema,
  honorsGrammar: () => useGrammar,
  complete,
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log(
  `[design-query-eval] ${tasks.length} tasks | ${providerId}/${model} | schema=${useSchema ? "on" : "off"} ` +
    `grammar=${useGrammar ? "on" : "off"} examples=${useExamples ? "on" : "off"} repair=${repairRounds}`,
);

const results = [];
for (const task of tasks) {
  const candidates = chooseCandidates(biModel, task.intent);
  const promptTokens =
    estimateTokens(designQuerySystemPrompt(replyFormat)) +
    estimateTokens(buildUserPrompt({ intent: task.intent, candidates, examples: useExamples, format: replyFormat }));
  const started = Date.now();
  const row = {
    id: task.id, lang: task.lang, promptTokens, dsl: "", status: "", passed: false,
    compiled: false, rounds: 0, ms: 0, finishReason: "", why: "", error: "",
  };
  try {
    if (showReplies) console.log(`\n--- ${task.id} INTENT --- ${task.intent}`);
    const draft = await draftDesignQuery(task.intent, biModel, {
      provider,
      compile: (dsl) => compileDesignQuery(dsl, "fixture", biModel),
      maxRepairs: repairRounds,
    });
    row.ms = Date.now() - started;
    row.dsl = draft.dsl;
    row.status = draft.status;
    row.rounds = draft.rounds;
    row.finishReason = lastFinishReason;
    row.compiled = draft.status === "compiled";
    if (showReplies) console.log(`--- ${task.id} DRAFT (${draft.status}) ---\n${draft.dsl}\n`);
    if (draft.status === "compiled") {
      const got = canonicalDesignQuery(draft.dsl);
      const accepted = [task.reference, ...(task.alternatives ?? [])].map(canonicalDesignQuery);
      row.passed = got !== null && accepted.includes(got);
      if (!row.passed) row.why = "compiled, but not the reference query";
    } else {
      row.why = draft.status === "declined" ? "no query in the reply" : (draft.errors[0]?.message ?? "did not compile");
    }
  } catch (e) {
    row.ms = Date.now() - started;
    row.error = String(e && e.message ? e.message : e);
  }
  results.push(row);
  const mark = row.error ? "ERROR" : row.passed ? "PASS " : "FAIL ";
  console.log(`  ${mark} ${row.id}  ${row.dsl.replace(/\n/g, " | ") || "-"}${row.error ? `  ${row.error}` : row.passed ? "" : `  (${row.why})`}`);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const ran = results.filter((r) => !r.error);
const passed = ran.filter((r) => r.passed);
const compiled = ran.filter((r) => r.compiled);
const latencies = ran.map((r) => r.ms).sort((a, b) => a - b);
const pick = (q) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] : 0);
const meanPrompt = ran.length ? Math.round(ran.reduce((a, r) => a + r.promptTokens, 0) / ran.length) : 0;

const summary = {
  provider: providerId, model,
  schema: useSchema, grammar: useGrammar, examples: useExamples, repair: repairRounds,
  tasks: results.length, ran: ran.length, errors: results.length - ran.length,
  passed: passed.length, compiled: compiled.length,
  passRate: ran.length ? passed.length / ran.length : 0,
  compileRate: ran.length ? compiled.length / ran.length : 0,
  medianMs: pick(0.5), p90Ms: pick(0.9), meanPromptTokens: meanPrompt,
  truncated: ran.filter((r) => r.finishReason === "length").length,
};
console.log(
  `\n[design-query-eval] passed ${summary.passed}/${summary.ran} (${(summary.passRate * 100).toFixed(1)}%) | ` +
    `compiled ${summary.compiled}/${summary.ran} | median ${summary.medianMs} ms | p90 ${summary.p90Ms} ms | ` +
    `mean prompt ${summary.meanPromptTokens} tok | truncated ${summary.truncated} | errors ${summary.errors}`,
);

if (jsonOut) {
  mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
  writeFileSync(jsonOut, JSON.stringify({ summary, results }, null, 2) + "\n", "utf8");
  console.log(`[design-query-eval] wrote ${jsonOut}`);
}
