//! FILENAME: tests/eval/suite.mjs
// PURPOSE: The eval suite as DATA — every runner, every knob it reads, pinned
//          to one value — so that a number is reproducible from a script name
//          and an arm differs from the baseline by exactly the flags named.
// CONTEXT: Until 2026-09-17 every measurement this programme recorded was a
//          hand-typed command, and the flags decided the number: two runs of
//          the same design-query arm were written up as 17/40 and 16/40 and
//          nobody could say which conditions produced either. The SERVER was
//          hand-typed too — `llama-server.exe -m <some gguf> -c 8192 -np 1 …`
//          in a second terminal — and no artifact recorded which GGUF it had
//          been given, so an arm was labelled by what the runner was TOLD
//          (`--model calcula-builtin`) rather than by what answered.
//
//          This module is PURE: no I/O, no process state, so `evalSuite.test.mjs`
//          can hold it to the runners' actual argument lists in CI. The process
//          around it is `run-suite.mjs`; `npm run eval:<surface>` and
//          `npm run eval:all` are the sanctioned way to produce a number.
//
//          THE PINS ARE THE BAKE-OFF ARMS. Each `pinned` block reproduces the
//          knob block of the 2026-09-15 baseline artifact for its surface
//          (`runs/2026-09-15--*--incumbent.json`), so the suite's first run on
//          the incumbent is comparable with everything recorded before it. A
//          pin is EXPLICIT even where it equals the runner's default: a default
//          that changes in a runner must not change what `eval:all` measures.
//
//          EVERY KNOB IS PINNED. `evalSuite.test.mjs` reads each runner's
//          `arg("…")` calls and fails the build when one is neither pinned
//          here nor supplied by the suite nor output-only — a knob added in a
//          hurry cannot silently ride on its default.

/**
 * The context the product starts its runtime with. Mirrors `CONTEXT_TOKENS`
 * in `app/src-tauri/src/ai/runtime.rs`; `evalSuite.test.mjs` diffs the two so
 * the suite cannot measure a server the product would not start.
 */
export const CONTEXT_TOKENS = 8192;

/**
 * The command line the product starts llama-server with — `engine_args` in
 * `ai/runtime.rs`, argument for argument. A run on these flags is a run on the
 * product's runtime; only the port and the model file differ.
 */
export function serverArgs(modelPath, port) {
  return [
    "-m", modelPath,
    "--host", "127.0.0.1",
    "--port", String(port),
    "-c", String(CONTEXT_TOKENS),
    "-np", "1",
    "--jinja",
    "--no-webui",
  ];
}

/** Flags the suite supplies itself. Never pinned, never accepted as overrides. */
export const SUPPLIED_FLAGS = ["model", "base-url", "json"];

/** Flags that change what is PRINTED, never what is measured. Not pinned. */
export const OUTPUT_FLAGS = ["show-replies", "show-misses", "timeout-ms", "help", "quiet", "concurrency"];

/**
 * One entry per runner in this directory.
 *
 *  - `pinned`: every knob the runner reads, with the baseline value. `""` and
 *    `false` mean "the runner's own default, not passed" — an empty string
 *    cannot be passed at all (`arg()` reads `--tag ""` as `--tag` and returns
 *    `true`), and a boolean flag is presence-only.
 *  - `endpoint`: how `--base-url` is shaped for it. The chat runners append
 *    `/chat/completions` to what they are given, so they get `<root>/v1`;
 *    `/infill` lives at the server ROOT.
 *  - `exitOne`: what the runner's exit code 1 means, so the suite can tell a
 *    failed gate (a result) from a runner that could not run (not a result).
 */
export const SURFACES = [
  {
    id: "intents",
    runner: "run-intent-eval.mjs",
    question: "does the chat decide what a message IS before any model turn?",
    needsModel: false,
    takesModel: false,
    endpoint: null,
    prerequisites: [],
    exitOne: "nothing — this runner exits 0",
    minutes: 1,
    pinned: { split: "all" },
  },
  {
    id: "formulas",
    runner: "run-formula-eval.mjs",
    question: "can the model write the formula, graded by the engine?",
    needsModel: true,
    takesModel: true,
    endpoint: "v1",
    prerequisites: ["grader"],
    exitOne: "a task errored (the artifact is still written)",
    minutes: 10,
    pinned: {
      provider: "llamacpp",
      schema: "on",
      grammar: "on",
      retrieval: 3,
      context: "on",
      repair: 0,
      split: "all",
      tag: "",
      limit: 0,
      "max-tokens": 600,
    },
  },
  {
    id: "design-queries",
    runner: "run-design-query-eval.mjs",
    question: "can the model write the design query, graded by the compiler?",
    needsModel: true,
    takesModel: true,
    endpoint: "v1",
    prerequisites: [],
    exitOne: "nothing — this runner exits 0",
    minutes: 4,
    pinned: {
      provider: "llamacpp",
      schema: "on",
      grammar: "on",
      examples: "on",
      repair: 0,
      "clause-gate": "off",
      fixture: "sales_star",
      lang: "",
      tag: "",
      limit: 0,
    },
  },
  {
    id: "scripts",
    runner: "run-eval.mjs",
    question: "can the model write an object script that validates and does what was asked?",
    needsModel: true,
    takesModel: true,
    endpoint: "v1",
    prerequisites: [],
    exitOne: "a task failed or errored (the artifact is still written)",
    minutes: 24,
    pinned: { provider: "llamacpp", budget: 8000, canary: false, repair: 0 },
  },
  {
    id: "narration",
    runner: "run-narration-eval.mjs",
    question: "can the model word computed facts without inventing a number?",
    needsModel: true,
    takesModel: true,
    endpoint: "v1",
    prerequisites: ["narration-helper"],
    exitOne: "the latency gate failed or a request errored (the artifact is still written)",
    minutes: 2,
    pinned: { provider: "llamacpp", locale: "en-US", "max-tokens": 700, "gate-median-ms": 8000 },
  },
  {
    id: "next-edit",
    runner: "run-next-edit-eval.mjs",
    question: "is the model's next-clause chip worth showing?",
    needsModel: true,
    takesModel: true,
    endpoint: "v1",
    prerequisites: [],
    exitOne: "the latency gate failed or a request errored (the artifact is still written)",
    minutes: 3,
    pinned: { provider: "llamacpp", grammar: "on", limit: 0, warmup: 3, "gate-median-ms": 400 },
  },
  {
    id: "macro-fim",
    runner: "run-macro-fim-eval.mjs",
    question: "can the model fill in a held-out line of a script?",
    needsModel: true,
    // Reads which model answered from the server's /props instead.
    takesModel: false,
    endpoint: "root",
    prerequisites: [],
    exitOne: "the latency gate failed or a request errored (the artifact is still written)",
    minutes: 2,
    pinned: {
      provider: "llamacpp",
      surface: 600,
      hints: "none",
      "max-tokens": 64,
      limit: 0,
      warmup: 3,
      "gate-median-ms": 1000,
    },
  },
];

export function surfaceById(id) {
  return SURFACES.find((s) => s.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

/** The suite's own options; anything else on the command line is an override. */
const SUITE_OPTIONS = new Set(["model", "provider", "base-url", "only", "skip", "dry-run", "keep", "label", "out"]);

/**
 * `node run-suite.mjs <surface|all> [suite options] [--knob value …]`.
 *
 * Overrides are collected as raw strings (or `true` for a bare flag) and
 * coerced against the pinned value's type per surface in `buildArgv`, so a
 * typo in a number fails loudly rather than reaching a runner as `NaN`.
 */
export function parseCli(argv) {
  const options = { model: undefined, provider: undefined, baseUrl: undefined, only: [], skip: [], dryRun: false, keep: false, label: "", out: undefined };
  const overrides = {};
  let target;
  const valueAt = (i) => (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      if (target !== undefined) throw new Error(`one surface at a time: got ${JSON.stringify(target)} and ${JSON.stringify(a)}`);
      target = a;
      continue;
    }
    const name = a.slice(2);
    if (!SUITE_OPTIONS.has(name)) {
      const v = valueAt(i);
      if (v !== undefined) i++;
      overrides[name] = v === undefined ? true : v;
      continue;
    }
    if (name === "dry-run") { options.dryRun = true; continue; }
    if (name === "keep") { options.keep = true; continue; }
    const v = valueAt(i);
    if (v === undefined) throw new Error(`--${name} needs a value`);
    i++;
    if (name === "only" || name === "skip") options[name] = v.split(",").map((s) => s.trim()).filter(Boolean);
    else if (name === "base-url") options.baseUrl = v;
    else options[name] = v;
  }
  return { target, options, overrides };
}

/** An override, typed like the pin it replaces. */
export function coerce(pinnedValue, raw, flag) {
  if (typeof pinnedValue === "boolean") {
    if (raw === true) return true;
    const s = String(raw).toLowerCase();
    if (["true", "on", "1", "yes"].includes(s)) return true;
    if (["false", "off", "0", "no"].includes(s)) return false;
    throw new Error(`--${flag} takes on|off, not ${JSON.stringify(raw)}`);
  }
  if (typeof pinnedValue === "number") {
    const n = raw === true ? NaN : Number(raw);
    if (!Number.isFinite(n)) throw new Error(`--${flag} takes a number, not ${JSON.stringify(raw)}`);
    return n;
  }
  if (raw === true) throw new Error(`--${flag} needs a value`);
  return String(raw);
}

/**
 * The exact argument list for one runner: the pins, with overrides REPLACING
 * the pinned value rather than following it — the runners read the FIRST
 * occurrence of a flag, so an appended override would be a silent no-op.
 * Overrides for knobs this runner does not read are reported, not passed.
 */
export function buildArgv(surface, { runnerPath, model, baseUrl, json, overrides = {} }) {
  const values = { ...surface.pinned };
  const applied = [];
  const ignored = [];
  for (const [k, raw] of Object.entries(overrides)) {
    if (SUPPLIED_FLAGS.includes(k)) {
      throw new Error(`--${k} is set by the suite; use the suite's own --model / --base-url instead`);
    }
    if (!(k in surface.pinned)) {
      ignored.push(k);
      continue;
    }
    values[k] = coerce(surface.pinned[k], raw, k);
    applied.push(k);
  }
  const argv = [runnerPath];
  for (const [k, v] of Object.entries(values)) {
    if (v === "" || v === false) continue;
    if (v === true) argv.push(`--${k}`);
    else argv.push(`--${k}`, String(v));
  }
  if (surface.takesModel && model) argv.push("--model", model);
  if (surface.endpoint && baseUrl) {
    const root = String(baseUrl).replace(/\/+$/, "");
    argv.push("--base-url", surface.endpoint === "v1" ? `${root}/v1` : root);
  }
  if (json) argv.push("--json", json);
  return { argv, values, applied, ignored };
}

// ---------------------------------------------------------------------------
// Where a run's evidence goes
// ---------------------------------------------------------------------------

/**
 * A pinned run is EVIDENCE and is kept under `runs/` (committed); a run with
 * any override is an experiment and goes to `out/` (git-ignored) unless
 * `--keep` says otherwise. The .gitignore explains the asymmetry: two
 * baselines were written to `out/` and are gone.
 */
export function outputBucket({ overrides = {}, keep = false }) {
  return Object.keys(overrides).length > 0 && !keep ? "out" : "runs";
}

/** `qwen2.5-coder-1.5b-instruct-q4_k_m.gguf` -> `qwen2.5-coder-1.5b-instruct-q4_k_m`. */
export function modelSlug(fileOrId) {
  return String(fileOrId)
    .split(/[\\/]/)
    .pop()
    .replace(/\.gguf$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
}

/** The convention the retained bake-off artifacts already follow. */
export function artifactFileName({ date, surfaceId, slug, label = "", time = "" }) {
  return `${date}--${surfaceId}--${slug}${label ? `--${label}` : ""}${time ? `--${time}` : ""}.json`;
}

export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function localTime(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}${p(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// One line per surface, for the table at the end
// ---------------------------------------------------------------------------

const pct = (x) => `${(Number(x) * 100).toFixed(1)}%`;

/** The headline of one artifact, in that runner's own terms. */
export function headline(surfaceId, artifact) {
  if (!artifact) return "no artifact";
  const s = artifact.summary ?? {};
  switch (surfaceId) {
    case "intents": {
      const all = s.all ?? {};
      return `macro ${pct(all.macro ?? 0)} | raw ${all.correct ?? "?"}/${all.n ?? "?"} | decisive precision ${pct(all.decisivePrecision ?? 0)}`;
    }
    case "formulas":
      return `${s.passed}/${s.ran} passed (${pct(s.passRate ?? 0)}) | median ${s.medianMs} ms | truncated ${s.truncatedReplies ?? "?"}`;
    case "design-queries":
      return `${s.passed}/${s.ran} passed (${pct(s.passRate ?? 0)}) | compiled ${s.compiled}/${s.ran} | median ${s.medianMs} ms | truncated ${s.truncated ?? "?"}`;
    case "scripts":
      return `${s.passed}/${s.total} passed | mean score ${Number(s.meanScore ?? 0).toFixed(3)} | truncated ${s.truncatedReplies ?? "?"}`;
    case "narration":
      return `${s.passed}/${s.ran} bundles clean | invented ${s.inventedNumbers} | median ${s.medianMs} ms | gate ${s.gatePassed ? "PASS" : "FAIL"}`;
    case "next-edit":
      return `exact ${s.exact}/${s.prefixTasks} | rules ${s.rulesOnly}/${s.prefixTasks} | median ${s.medianMs} ms | gate ${s.gatePassed ? "PASS" : "FAIL"}`;
    case "macro-fim":
      return `exact ${s.exact}/${s.ran} (${pct(s.exactRate ?? 0)}) | median ${s.medianMs} ms | gate ${s.gatePassed ? "PASS" : "FAIL"}`;
    default:
      return JSON.stringify(s).slice(0, 80);
  }
}
