//! FILENAME: tests/eval/run-macro-fim-eval.mjs
// PURPOSE: Measure whether the on-board model can fill in the middle of a
//          Calcula object script — one held-out line, given everything above
//          and below it.
// CONTEXT: Milestone D, and the measurement that decides whether the milestone
//          is built at all. The Object Script Editor already has a
//          REQUEST-shaped AI composer ("say what to change, get a diff",
//          `AiEditStrip.tsx`, 2026-08-25). What it has never had is anything
//          EDIT-triggered at the cursor. That is what fill-in-the-middle would
//          be, and it is only worth a new Tauri command if a model can do it.
//
// WHY THIS CANNOT GO THROUGH THE EXISTING COMPLETION SEAM. Measured:
//   - `/infill` lives at the ROOT of llama-server, not under `/v1`, while the
//     built-in runtime's base URL hardcodes the `/v1` suffix.
//   - `ai_chat_complete` picks its URL from a closed two-armed match on the
//     provider kind, and `ChatRequest` has no prefix/suffix fields at all.
//   - The runtime is started with `--jinja`, so a chat request wraps the prompt
//     in Qwen's chat template and DESTROYS the fill-in-the-middle conditioning:
//     the same bytes sent as a chat message came back as a conversational
//     fenced block, and through `/infill` came back as a cursor continuation.
// So this runner talks to `/infill` directly, exactly as the sibling runners
// talk to `/v1/chat/completions` directly, and no product code is written until
// the number justifies it.
//
// THE CORPUS IS DERIVED, NOT WRITTEN. Every `reference` in `tasks.json` is a
// correct object script stored as an array of LINES. Holing out each eligible
// line gives a task whose right answer is known and whose context is real — the
// same trick `run-next-edit-eval.mjs` plays with query prefixes. The coupling is
// worth stating out loud: these references exist to grade AUTHORING, so
// improving them moves this number too.
//
// WHAT IT MEASURED, AND WHY MILESTONE D IS NOT BUILT ON IT YET (2026-09-11).
// Best score 26 of 141 held-out lines (18.4%), and the sweep below shows the
// ceiling is the MODEL rather than anything the harness withholds: covering 98
// of 103 answers' vocabulary instead of 42 moved the score by one task
// (p = 1.0000). It is still real signal — the design-query model chip measured
// 0 of 80 — but two things about the runtime matter more than the score. It runs
// with `-np 1`, so an infill fired during a chat generation was measured at
// 3238 ms; and `ai_chat_cancel_stream` reaches only the streaming path, so a
// superseded keystroke's buffered completion runs to completion holding the only
// slot. That rules out automatic per-keystroke ghost text and points at an
// ON-DEMAND completion instead. The number decides the milestone; the milestone
// does not decide the number.
//
// USAGE
//   node tests/eval/run-macro-fim-eval.mjs --provider llamacpp
//   node tests/eval/run-macro-fim-eval.mjs --provider llamacpp --surface 0   (baseline)
//   node tests/eval/run-macro-fim-eval.mjs --provider llamacpp --hints buffer
//   node tests/eval/run-macro-fim-eval.mjs --provider llamacpp --limit 20 --show-replies
//   node tests/eval/run-macro-fim-eval.mjs --provider llamacpp --json out/fim.json
//
// Pair two runs with `compare-runs.mjs` — the rows carry `passed` for exactly
// that, and every claim above is a McNemar exact test over 141 paired tasks.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { bundleAppModules } from "./lib/appBundle.mjs";

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

const providerId = arg("provider", "llamacpp");
const baseUrl = arg("base-url", "http://127.0.0.1:8080");
const limit = Number(arg("limit", 0));
const jsonOut = arg("json");
const showReplies = Boolean(arg("show-replies", false));
const requestTimeoutMs = Number(arg("timeout-ms", 60_000));
const warmups = Number(arg("warmup", 3));
const gateMedianMs = Number(arg("gate-median-ms", 1000));
/** How many tokens one line is allowed. A line of object script is short. */
const maxTokens = Number(arg("max-tokens", 64));
/**
 * Token budget for the API surface handed to the model as `input_extra`.
 * 0 turns it off, which is the other half of the paired comparison.
 *
 * The first run without it scored 8 of 141, and almost every miss was an
 * INVENTED name — `getValue` for `getCellValue`, `getCells` for
 * `getRangeValues`, `context.api.on('cellChanged', …)` for `context.onClick`.
 * `buildSurfacePrompt` is the product's own retrieval over its generated
 * signature rows, so this measures the retrieval the editor would really use.
 *
 * MEASURED, 2026-09-11, built-in runtime (qwen2.5-coder-1.5b-instruct Q4_K_M),
 * 141 held-out lines. "reachable" is how many of the 103 answers that name a
 * `context.<chain>` had EVERY chain they name present in the surface actually
 * sent; p is McNemar exact against the 600-token run.
 *
 *   budget   reachable  exact        median   p
 *   off      —          8  (5.7%)    712 ms   0.0001
 *   300      38/103     13 (9.2%)    924 ms   0.0018
 *   600      42/103     25 (17.7%)   1033 ms  —
 *   1500     60/103     20 (14.2%)   1360 ms  0.1797
 *   2500     98/103     26 (18.4%)   1558 ms  1.0000
 *
 * READ THE REACHABLE COLUMN BEFORE THE EXACT ONE. `rankSurface` puts the
 * capability chains ahead of every grid member, so no budget below 1500 carries
 * a single `api.*` method and `getCellValue`/`setCellValue` first appear at
 * 2500. The obvious story — "the surface fixes the invented method names" — was
 * mine, and the 2500 row refutes it: going from 42 of 103 answers fully covered
 * to 98 of 103 moved the score from 25 to 26, p = 1.0000. **Vocabulary coverage
 * is not the binding constraint.** What the first ~600 tokens buy is the
 * capability names and the `onClick` idiom — the flipped tasks are
 * `cap-fetch-rate`, `cap-schedule-refresh`, `cap-dialog-*`,
 * `cap-two-capabilities`, `cap-form-*` and the three `trap-*` idiom cases — and
 * past that the model cannot infer the line however much of the API it holds.
 *
 * Two corollaries worth having. `--hints buffer`, the obvious way to re-rank
 * toward what the open document mentions, measured WORSE (18 of 141,
 * p = 0.0391). And there is no point investing in better surface retrieval for
 * fill-in-the-middle at this model size, because the ceiling is not the surface.
 * 600 stays the default as the cheapest point that captures the whole effect.
 */
const surfaceTokens = Number(arg("surface", 600));
/**
 * Where the ranking hints come from: `none`, or `buffer`.
 *
 * This is the knob the first sweep's own result pointed at. `buildSurfacePrompt`
 * RANKS 428 chains and keeps what fits, and at 600 tokens what fits is
 * `instanceId, onClick, caps.biQuery, caps.biSql, caps.fetch, …` — ten chains,
 * 418 omitted, and NEITHER `getCellValue` NOR `setCellValue`, which are the
 * methods most of this corpus actually calls. So the sweep did not measure
 * "shown the API"; it measured "shown the capability names", and the tasks it
 * fixed say so — `cap-fetch-rate`, `cap-schedule-refresh`, `cap-dialog-*`,
 * `cap-two-capabilities`, plus the idiom traps. The BUDGET was never the
 * constraint; the RANKING is.
 *
 * `buffer` passes words from the open script as hints, which is what the editor
 * would genuinely have — `calledMembers()` already derives them from an AST walk
 * of the buffer. The task's own authoring `hints` are NOT used: they name the
 * very methods the reference calls, and feeding those in would be marking the
 * model's own homework.
 */
const hintsMode = String(arg("hints", "none"));
if (!["none", "buffer"].includes(hintsMode)) {
  console.error(`--hints must be "none" or "buffer", not "${hintsMode}".`);
  process.exit(2);
}

// Fill-in-the-middle is NOT portable across the ladder, and pretending
// otherwise would produce a number about the wrong thing. llama.cpp serves it at
// `/infill`; Ollama serves it only on its NATIVE `/api/generate` with a `suffix`
// field and 404s `/v1/infill`; Anthropic and OpenAI have no infill at all. A
// FIM surface is Tier-1-first, and reaching Tier 2 means a per-runtime
// rendering rather than one more URL.
if (providerId !== "llamacpp") {
  console.error(
    `Fill-in-the-middle is only reachable on llama.cpp's server, not "${providerId}".\n` +
      `Ollama exposes it only on its native /api/generate with a "suffix" field, and the\n` +
      `cloud providers have no infill endpoint at all. Adding one here means a per-runtime\n` +
      `rendering, not another --provider value.`,
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Tasks: every eligible held-out line of every reference
// ---------------------------------------------------------------------------

// The PRODUCT's own surface retrieval, bundled rather than re-implemented, so
// a run measures the text the editor would really send.
const { mod } = await bundleAppModules({
  appRoot,
  tag: "macro-fim",
  exports: [{ from: "src/api/scriptHost/scriptPrompt/index.ts", names: ["buildSurfacePrompt"] }],
});
const { buildSurfacePrompt } = mod;

const corpus = JSON.parse(readFileSync(path.join(here, "tasks.json"), "utf8"));
const allTasks = corpus.tasks ?? corpus;

/**
 * A line worth holing out.
 *
 * Closers and blanks are excluded: `}` is guessable from the brace depth alone,
 * so a corpus full of them would report a score about indentation. The floor of
 * eight characters keeps the task about code rather than punctuation.
 */
function eligible(line) {
  const s = line.trim();
  return s.length >= 8 && !/^[})\];]+$/.test(s);
}

function buildTasks() {
  const out = [];
  for (const task of allTasks) {
    const lines = task.reference ?? [];
    if (lines.length < 2) continue;
    // FROM THE SECOND LINE ON. Holing line 1 leaves an EMPTY prefix, and a
    // model handed no prefix is being asked to invent a file rather than fill a
    // gap — measured, it answered `filename='src/components/MyComponent.js'`,
    // which is a sensible guess about a document it was never shown. The editor
    // asks for a completion where the CURSOR is, and a cursor at the top of an
    // empty buffer is not the case this milestone is about.
    for (let i = 1; i < lines.length; i++) {
      if (!eligible(lines[i])) continue;
      out.push({
        id: `${task.id}:${i + 1}`,
        objectType: task.objectType,
        // The newline placement matters: the prefix ENDS with a break and the
        // suffix BEGINS with one, so the model's job is exactly one line and the
        // reassembly below is byte-exact.
        prefix: lines.slice(0, i).map((l) => `${l}\n`).join(""),
        suffix: lines.slice(i + 1).map((l) => `\n${l}`).join(""),
        expected: lines[i],
        whole: lines.join("\n"),
        /**
         * The naive zero-cost predictor: say what the line above said.
         *
         * STRUCTURALLY NEAR-ZERO ON THIS CORPUS, and the report says so rather
         * than presenting it as a cleared bar. The corpus has exactly five
         * positions where a line repeats the one above it, and all five are
         * closers (`  }`, `  });`) that `eligible` rejects — so the same filter
         * that builds the tasks removes the only class of line this predictor
         * could ever catch. It is kept because a floor that is zero FOR A KNOWN
         * REASON is still worth printing; it is not evidence that a low score is
         * a good score.
         */
        naive: lines[i - 1],
      });
    }
  }
  return out;
}

let tasks = buildTasks();
if (limit > 0) tasks = tasks.slice(0, limit);
if (tasks.length === 0) {
  console.error("no tasks built from the corpus");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Harness self-check: the splice must be byte-exact
// ---------------------------------------------------------------------------

// Before a single request, prove that prefix + the RIGHT answer + suffix is the
// original file, byte for byte. If it is not, every task is scored against a
// file the corpus never contained and a perfect model still reads as zero. This
// is the same splice-and-verify `formDesigner/writeFormRegion.ts` already does
// when it writes a region back into a script.
{
  const broken = [];
  for (const t of tasks) {
    const rebuilt = `${t.prefix}${t.expected}${t.suffix}`;
    if (rebuilt !== t.whole) {
      broken.push(`${t.id}: prefix + expected + suffix is not the original reference`);
    }
  }
  if (broken.length > 0) {
    console.error(
      `[macro-fim-eval] THE HARNESS CANNOT REBUILD ITS OWN CORPUS on ${broken.length}/${tasks.length} tasks.\n` +
        broken.slice(0, 8).map((b) => `  ${b}`).join("\n") +
        `\nEvery task would then be graded against a file that never existed. Fix the splice first.`,
    );
    process.exit(3);
  }
  console.log(`[macro-fim-eval] harness self-check: the splice is byte-exact on all ${tasks.length} tasks.`);
}

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

/** Whitespace-insensitive comparison — indentation is the editor's business. */
const norm = (s) => s.replace(/\s+/g, " ").trim();

/**
 * The API surface for one object type, as llama-server's `input_extra` wants
 * it: named context blocks placed before the prefix.
 *
 * NO HINTS ARE PASSED. `tasks.json` carries authoring `hints` that name the very
 * methods the reference calls, and feeding those in would be marking the model's
 * own homework. The editor has the open buffer and the object type; so does
 * this.
 */
const surfaceCache = new Map();
let surfaceChains = 0;

/** Identifier-ish words in the open buffer, as the editor's own hint source would give them. */
function bufferHints(task) {
  const words = `${task.prefix}\n${task.suffix}`.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [];
  return [...new Set(words)].slice(0, 40);
}

function surfaceFor(task) {
  if (surfaceTokens <= 0) return undefined;
  const hints = hintsMode === "buffer" ? bufferHints(task) : undefined;
  // Cached on the object type AND the hints, because hints change the ranking —
  // caching on the type alone would serve the first task's ranking to all of
  // them and quietly measure one document's hints against every other.
  const key = `${task.objectType ?? ""}|${(hints ?? []).join(",")}`;
  if (!surfaceCache.has(key)) {
    const built = buildSurfacePrompt({
      objectType: task.objectType || "button",
      budgetTokens: surfaceTokens,
      ...(hints ? { hints } : {}),
    });
    surfaceChains = Math.max(surfaceChains, built.includedChains.length);
    surfaceCache.set(key, built.text ? [{ filename: "calcula-api.d.ts", text: built.text }] : undefined);
  }
  return surfaceCache.get(key);
}

async function infill(task) {
  const extra = surfaceFor(task);
  const body = {
    ...(extra ? { input_extra: extra } : {}),
    input_prefix: task.prefix,
    // MANDATORY. llama-server answers 500 with a raw nlohmann exception when it
    // is missing, which is a confusing way to learn that infill is not
    // "completion with extra context".
    input_suffix: task.suffix,
    n_predict: maxTokens,
    temperature: 0,
    // One line is the whole job. Without a stop the model runs on and the
    // reassembled file gains lines nobody asked for.
    stop: ["\n"],
  };
  const started = Date.now();
  const res = await fetch(`${baseUrl}/infill`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
  const parsed = await res.json();
  return {
    // llama.cpp's native frame, not an OpenAI one: `content`, not `choices`.
    text: parsed.content ?? "",
    stoppedOn: parsed.stopping_word ?? "",
    truncated: parsed.stopped_limit === true,
    ms: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log(
  `[macro-fim-eval] ${tasks.length} tasks | ${providerId} ${baseUrl}/infill | ` +
    `n_predict=${maxTokens} | surface=${surfaceTokens > 0 ? `${surfaceTokens} tok` : "off"} hints=${hintsMode} | ` +
    `warmup=${warmups} | gate median <= ${gateMedianMs} ms`,
);

// The naive baseline is free and computed up front, loudly, for the same reason
// the next-edit runner computes Tier 0 before asking a model: "the model got 12"
// means nothing until something says what 12 is worth.
const naiveHits = tasks.filter((t) => norm(t.naive) === norm(t.expected)).length;
console.log(
  `[macro-fim-eval] naive baseline (repeat the line above): ${naiveHits}/${tasks.length} ` +
    `(${((naiveHits / tasks.length) * 100).toFixed(1)}%)` +
    (naiveHits === 0 ? "  — structurally near-zero here; see the note on `naive`" : ""),
);

// ---------------------------------------------------------------------------
// The reachability ceiling
// ---------------------------------------------------------------------------

// HOW MANY OF THESE THE MODEL WAS EVEN SHOWN THE VOCABULARY FOR.
//
// The sibling runner prints a ceiling because scoring an unwinnable task as a
// miss overstates the miss. This one needs it more, and for a sharper reason:
// `buildSurfacePrompt` RANKS capability chains ahead of every grid member, so no
// budget below 1500 contains a single `api.*` method and `getCellValue` /
// `setCellValue` — the two this corpus calls most — first appear at 2500. Worse,
// the surface ends with "If the task needs something not listed above, do NOT
// guess a name. Say which capability you need and stop." That is right in an
// authoring chat and actively wrong here: on every task whose answer names an
// omitted chain, the harness is instructing the model to refuse.
//
// So the ceiling is printed beside the score. A run that scores 25 of 141 while
// only 74 were reachable is a different claim from one where all 141 were.
const CHAIN_RE = /context\.((?:[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*)/g;
function reachability() {
  if (surfaceTokens <= 0) return null;
  let named = 0;
  let reachable = 0;
  const missing = new Map();
  for (const t of tasks) {
    const chains = [...t.expected.matchAll(CHAIN_RE)].map((m) => m[1]);
    if (chains.length === 0) continue;
    named++;
    const extra = surfaceFor(t);
    const text = extra ? extra.map((b) => b.text).join("\n") : "";
    // A chain counts as shown when its LAST segment appears in the surface —
    // `api.getCellValue` is rendered under its own group, not as that literal
    // dotted path.
    const shown = chains.every((c) => text.includes(c.split(".").pop()));
    if (shown) reachable++;
    else for (const c of chains) if (!text.includes(c.split(".").pop())) missing.set(c, (missing.get(c) ?? 0) + 1);
  }
  return { named, reachable, unreachable: named - reachable, missing };
}
const reach = reachability();
if (reach) {
  const top = [...reach.missing.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log(
    `[macro-fim-eval] reachability: ${reach.named} of ${tasks.length} answers name a context chain; ` +
      `${reach.reachable} have every chain in the surface sent, ${reach.unreachable} do NOT.\n` +
      `[macro-fim-eval]   most-omitted: ${top.map(([c, n]) => `${c} (${n})`).join(", ") || "none"}`,
  );
}

for (let i = 0, sent = 0; i < tasks.length && sent < warmups; i++) {
  try {
    await infill(tasks[tasks.length - 1 - i]);
    sent++;
  } catch (e) {
    console.error(`[macro-fim-eval] warm-up failed: ${e && e.message ? e.message : e}`);
    console.error(`Is the runtime up? app/src-tauri/binaries/llama-server-<triple>/llama-server.exe`);
    process.exit(1);
  }
}

// Which model actually answered. A summary without it cannot be paired later.
let loadedModel = 'unknown';
try {
  const props = await (await fetch(`${baseUrl}/props`, { signal: AbortSignal.timeout(5000) })).json();
  loadedModel = props.model_path ? String(props.model_path).split(/[\\/]/).pop() : "unknown";
} catch {
  /* a runtime that will not describe itself still answers infill */
}

const results = [];
for (const task of tasks) {
  const row = {
    id: task.id, objectType: task.objectType, expected: task.expected,
    got: "", passed: false, exact: false, normalized: false, naiveHit: norm(task.naive) === norm(task.expected),
    ms: 0, truncated: false, error: "",
  };
  try {
    const reply = await infill(task);
    row.ms = reply.ms;
    row.truncated = reply.truncated;
    // The model is asked for one line; anything past the first is not its
    // answer, it is the model failing to stop.
    row.got = reply.text.split("\n")[0] ?? "";
    row.exact = row.got === task.expected;
    row.normalized = norm(row.got) === norm(task.expected);
    // `passed` is the field every sibling runner uses and the only one
    // `compare-runs.mjs` reads. Whitespace-insensitive, because indentation is
    // the editor's job and a tab-vs-spaces miss is not a wrong answer.
    row.passed = row.normalized;
  } catch (e) {
    row.error = String(e && e.message ? e.message : e);
  }
  results.push(row);
  if (showReplies) {
    console.log(`\n--- ${row.id} ---\n  want: ${JSON.stringify(task.expected)}\n  got : ${JSON.stringify(row.got)}`);
  } else {
    const mark = row.error ? "ERROR" : row.passed ? "PASS " : "FAIL ";
    console.log(`  ${mark} ${row.id}  want ${JSON.stringify(task.expected)}  got ${JSON.stringify(row.got)}${row.error ? `  ${row.error}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const ran = results.filter((r) => !r.error);
const timed = ran.map((r) => r.ms).sort((a, b) => a - b);
const pick = (q) => (timed.length ? timed[Math.min(timed.length - 1, Math.floor(q * timed.length))] : 0);
const rate = (n) => (ran.length ? n / ran.length : 0);
const exact = ran.filter((r) => r.exact).length;
const normalized = ran.filter((r) => r.normalized).length;
const naiveOnRan = ran.filter((r) => r.naiveHit).length;

const medianMs = pick(0.5);

/** Every independent variable, one key per CLI knob (see run-design-query-eval.mjs). */
const knobs = {
  provider: String(providerId ?? ""),
  baseUrl: String(baseUrl ?? ""),
  // Not a flag: read from the server's /props, and recorded here because it
  // is the one variable that matters most and the one no flag could tell.
  model: String(loadedModel),
  surface: Number(surfaceTokens),
  hints: String(hintsMode),
  maxTokens: Number(maxTokens),
  limit: Number(limit),
  warmup: Number(warmups),
  gateMedianMs: Number(gateMedianMs),
};

const summary = {
  // THE INDEPENDENT VARIABLES BELONG IN THE SUMMARY. `compare-runs.mjs` pairs
  // two JSON files and this header invites exactly that, so a file that does
  // not record which surface budget produced it — or which model answered —
  // cannot be told apart from another six months later.
  provider: providerId, baseUrl, maxTokens,
  knobs,
  surfaceTokens, surfaceChains, hintsFrom: hintsMode, model: loadedModel,
  tasks: results.length, ran: ran.length, errors: results.length - ran.length,
  exact, exactRate: rate(exact),
  normalized, passRate: rate(normalized),
  naive: naiveOnRan, naiveRate: rate(naiveOnRan),
  reachableOfNamed: reach ? reach.reachable : null,
  namedAChain: reach ? reach.named : null,
  truncated: ran.filter((r) => r.truncated).length,
  medianMs, p90Ms: pick(0.9),
  gateMedianMs,
  gatePassed: timed.length > 0 && medianMs <= gateMedianMs && results.length - ran.length === 0,
};

const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log(
  `\n[macro-fim-eval] ${summary.provider} ${summary.baseUrl}\n` +
    `  held-out line  exact ${exact}/${ran.length} (${pct(summary.exactRate)}) | ` +
    `ignoring whitespace ${normalized}/${ran.length} (${pct(summary.passRate)})\n` +
    // NO "model right where naive is wrong" COLUMN. It was arithmetically
    // identical to the pass count, because the eligibility filter removes every
    // line the naive predictor could hit, and printing an identical number under
    // a second heading reads as a second piece of evidence.
    `  against naive  repeat-the-line-above ${naiveOnRan}/${ran.length} (${pct(summary.naiveRate)})` +
    `${naiveOnRan === 0 ? " — a floor the eligibility filter holds near zero" : ""}\n` +
    (reach
      ? `  reachability   ${reach.reachable} of ${reach.named} answers had every chain they name in the surface sent\n`
      : "") +
    `  latency        median ${summary.medianMs} ms | p90 ${summary.p90Ms} ms | ` +
    `truncated ${summary.truncated} | errors ${summary.errors}\n` +
    `  GATE           median <= ${gateMedianMs} ms and no request errors: ${summary.gatePassed ? "PASS" : "FAIL"}`,
);

if (jsonOut) {
  mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
  writeFileSync(jsonOut, JSON.stringify({ summary, results }, null, 2) + "\n", "utf8");
  console.log(`[macro-fim-eval] wrote ${jsonOut}`);
}

process.exit(summary.gatePassed ? 0 : 1);
