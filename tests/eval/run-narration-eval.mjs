//! FILENAME: tests/eval/run-narration-eval.mjs
// PURPOSE: Measure whether the on-board model can narrate computed facts
//          without inventing a number — and how much of the run it covers when
//          it does.
// CONTEXT: M6, Step 4 of the AI programme. The rule came first and is already
//          enforced in `core/insights/src/narrate/cite.rs`: a sentence is
//          deleted unless it cites a fact the run produced and prints only
//          numbers those facts account for. So the question this answers is not
//          "is the model honest" — it cannot be dishonest and still reach a
//          reader — it is "is anything LEFT once the check has run, and does it
//          cover the findings that mattered".
//
// NOTHING HERE RE-IMPLEMENTS THE PRODUCT. The fixtures, the prompt, the reply
// schema and the check all come out of the `narration` example in
// `core/insights`, which is the same code the product will call:
//
//   narration facts  [localeId]   real bundles from the real engine, plus the
//                                 deterministic narration as a control
//   narration prompt [localeId]   the product's system prompt and reply schema
//   narration check               stdin -> the real citation check
//
// A JavaScript port of that check would be a second opinion about `number.rs`'s
// rounding bands, its scientific cut-off and the sv-SE non-breaking space, and
// the run would then be measuring the port. The design-query runner avoids the
// same trap by bundling the product's modules; this one shells out, because the
// code it needs is Rust.
//
// THE CONTROL IS THE ENGINE ITSELF. Every run first pushes the DETERMINISTIC
// narration through the same check and asserts all of it survives. If that ever
// fails, the harness is broken and the model's number would be meaningless — so
// the run stops rather than reporting a zero that looks like a finding. It is
// the same discipline as the design-query runner's oracle self-check.
//
// USAGE
//   node tests/eval/run-narration-eval.mjs --provider llamacpp
//   node tests/eval/run-narration-eval.mjs --provider llamacpp --locale sv-SE
//   node tests/eval/run-narration-eval.mjs --provider llamacpp --json out/m6.json

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

const providerId = arg("provider", "llamacpp");
const model = arg("model", "default");
const localeId = String(arg("locale", "en-US"));
const baseUrl = arg("base-url", "");
const jsonOut = arg("json");
const showReplies = Boolean(arg("show-replies", false));
const requestTimeoutMs = Number(arg("timeout-ms", 180_000));
const maxTokens = Number(arg("max-tokens", 700));
const gateMedianMs = Number(arg("gate-median-ms", 8000));

const PROVIDER_ENDPOINTS = {
  ollama: "http://127.0.0.1:11434/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
  llamacpp: "http://127.0.0.1:8080/v1",
  vllm: "http://127.0.0.1:8000/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

// ---------------------------------------------------------------------------
// The product's own pieces, through the example binary
// ---------------------------------------------------------------------------

const EXE = path.join(
  process.env.CARGO_TARGET_DIR || path.join(repo, "core", "target"),
  "debug",
  "examples",
  process.platform === "win32" ? "narration.exe" : "narration",
);

if (!existsSync(EXE)) {
  console.error(
    `The narration helper is not built: ${EXE}\n` +
      `Build it first (PowerShell, because the MSVC environment is a PowerShell script):\n` +
      `  . .\\core\\setup-rust-env.ps1\n` +
      `  $env:CARGO_TARGET_DIR='C:\\Users\\Salle\\AppData\\Local\\calcula-target'\n` +
      `  cd core; cargo build -p insights --example narration`,
  );
  process.exit(2);
}

const helper = (args, input) =>
  execFileSync(EXE, args, { input, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

const bundles = JSON.parse(helper(["facts", localeId]));
const { system, schemaName, schema } = JSON.parse(helper(["prompt", localeId]));
const check = (bundle, sentences) =>
  JSON.parse(
    helper(["check"], JSON.stringify({ localeId: bundle.localeId, factsJson: bundle.factsJson, sentences })),
  );

// ---------------------------------------------------------------------------
// Harness self-check: the engine's own narration must survive
// ---------------------------------------------------------------------------

{
  const broken = [];
  for (const bundle of bundles) {
    const verdict = check(
      bundle,
      bundle.deterministic.map((d) => ({ text: d.text, factIds: [d.id] })),
    );
    if (verdict.dropped.length > 0) {
      broken.push(`${bundle.label}: ${JSON.stringify(verdict.dropped.slice(0, 2))}`);
    }
  }
  if (broken.length > 0) {
    console.error(
      `[narration-eval] THE CHECK REJECTS THE ENGINE'S OWN NARRATION on ${broken.length}/${bundles.length} bundles.\n` +
        broken.map((b) => `  ${b}`).join("\n") +
        `\nA narrator that only prints numbers its fact contains is the definition of what must pass.\n` +
        `Any model measured against this would score low for the harness's reasons. Fix the check first.`,
    );
    process.exit(3);
  }
  const facts = bundles.reduce((n, b) => n + b.deterministic.length, 0);
  console.log(
    `[narration-eval] harness self-check: all ${facts} deterministic sentences across ` +
      `${bundles.length} bundles survive the citation check.`,
  );
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function narrate(bundle) {
  const base = baseUrl || PROVIDER_ENDPOINTS[providerId];
  if (!base) throw new Error(`No endpoint known for provider "${providerId}"; pass --base-url.`);
  const key = process.env.CALCULA_EVAL_API_KEY ?? "";
  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;

  const started = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: bundle.userMessage },
      ],
      response_format: { type: "json_schema", json_schema: { name: schemaName, schema } },
    }),
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

console.log(
  `[narration-eval] ${bundles.length} bundles | ${providerId}/${model} | locale ${localeId} | ` +
    `schema on | gate median <= ${gateMedianMs} ms`,
);

const results = [];
for (const bundle of bundles) {
  const factCount = JSON.parse(bundle.factsJson).facts.length;
  const row = {
    id: bundle.label,
    facts: factCount,
    offered: 0,
    kept: 0,
    droppedUncited: 0,
    droppedUnknownFact: 0,
    droppedNoCitation: 0,
    coverage: 0,
    ms: 0,
    finishReason: "",
    unparsable: false,
    error: "",
    passed: false,
  };
  try {
    const reply = await narrate(bundle);
    row.ms = reply.ms;
    row.finishReason = reply.finishReason;

    let sentences = [];
    try {
      const obj = JSON.parse(reply.text);
      sentences = Array.isArray(obj.sentences) ? obj.sentences : [];
    } catch {
      // A reply that is not the schema is not a narration. Counted, not
      // crashed on: "the model could not produce the envelope" is a result.
      row.unparsable = true;
    }
    row.offered = sentences.length;

    if (sentences.length > 0) {
      const verdict = check(
        bundle,
        sentences.map((s) => ({ text: String(s.text ?? ""), factIds: Array.isArray(s.factIds) ? s.factIds : [] })),
      );
      row.kept = verdict.kept.length;
      row.coverage = verdict.coverage;
      for (const d of verdict.dropped) {
        if (d.reason === "uncitedNumber") row.droppedUncited++;
        else if (d.reason === "unknownFact") row.droppedUnknownFact++;
        else row.droppedNoCitation++;
      }
      if (showReplies) {
        console.log(`\n--- ${bundle.label} ---`);
        for (const s of verdict.kept) console.log(`  KEPT  ${s.text}`);
        for (const d of verdict.dropped) console.log(`  DROP  [${d.reason}${d.detail ? " " + d.detail : ""}] ${d.text}`);
      }
    }
    // A bundle "passes" when the model produced at least one showable sentence
    // and invented nothing. Both halves matter: all-dropped is a failure, and so
    // is one good sentence beside three deleted ones, because a reader would
    // have seen the deleted ones from a narrator without this check.
    row.passed = row.kept > 0 && row.droppedUncited === 0;
  } catch (e) {
    row.error = String(e && e.message ? e.message : e);
  }
  results.push(row);
  const mark = row.error ? "ERROR" : row.passed ? "PASS " : "FAIL ";
  console.log(
    `  ${mark} ${row.id.padEnd(34)} kept ${row.kept}/${row.offered} of ${row.facts} facts | ` +
      `coverage ${(row.coverage * 100).toFixed(0)}% | invented ${row.droppedUncited} | ${row.ms} ms` +
      `${row.unparsable ? " | UNPARSABLE" : ""}${row.error ? `  ${row.error}` : ""}`,
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const ran = results.filter((r) => !r.error);
const timed = ran.map((r) => r.ms).sort((a, b) => a - b);
const pick = (q) => (timed.length ? timed[Math.min(timed.length - 1, Math.floor(q * timed.length))] : 0);
const sum = (f) => ran.reduce((n, r) => n + f(r), 0);
const offered = sum((r) => r.offered);
const kept = sum((r) => r.kept);
const invented = sum((r) => r.droppedUncited);
const medianMs = pick(0.5);

const summary = {
  provider: providerId, model, localeId,
  bundles: results.length, ran: ran.length, errors: results.length - ran.length,
  passed: ran.filter((r) => r.passed).length,
  sentencesOffered: offered,
  sentencesKept: kept,
  survivalRate: offered ? kept / offered : 0,
  inventedNumbers: invented,
  inventionRate: offered ? invented / offered : 0,
  unknownFactCitations: sum((r) => r.droppedUnknownFact),
  uncitedSentences: sum((r) => r.droppedNoCitation),
  unparsableReplies: ran.filter((r) => r.unparsable).length,
  meanCoverage: ran.length ? sum((r) => r.coverage) / ran.length : 0,
  totalFacts: sum((r) => r.facts),
  medianMs, p90Ms: pick(0.9),
  truncated: ran.filter((r) => r.finishReason === "length").length,
  gateMedianMs,
  gatePassed: timed.length > 0 && medianMs <= gateMedianMs && results.length - ran.length === 0,
};

const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log(
  `\n[narration-eval] ${summary.provider}/${summary.model} ${summary.localeId}\n` +
    `  bundles        ${summary.passed}/${summary.ran} produced a showable sentence and invented nothing\n` +
    `  sentences      ${kept}/${offered} survived the citation check (${pct(summary.survivalRate)})\n` +
    `  inventions     ${invented} numbers the cited facts could not account for (${pct(summary.inventionRate)}) | ` +
    `${summary.unknownFactCitations} unknown fact ids | ${summary.uncitedSentences} uncited\n` +
    `  coverage       ${pct(summary.meanCoverage)} of the ${summary.totalFacts} ranked facts, on average\n` +
    `  envelope       ${summary.unparsableReplies} replies were not the schema | truncated ${summary.truncated}\n` +
    `  latency        median ${summary.medianMs} ms | p90 ${summary.p90Ms} ms | errors ${summary.errors}\n` +
    `  GATE           median <= ${gateMedianMs} ms and no request errors: ${summary.gatePassed ? "PASS" : "FAIL"}`,
);

if (jsonOut) {
  mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
  writeFileSync(jsonOut, JSON.stringify({ summary, results }, null, 2) + "\n", "utf8");
  console.log(`[narration-eval] wrote ${jsonOut}`);
}

process.exit(summary.gatePassed ? 0 : 1);
