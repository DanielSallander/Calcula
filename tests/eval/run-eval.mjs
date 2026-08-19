//! FILENAME: tests/eval/run-eval.mjs
// PURPOSE: LAYER B of the script-authoring eval — run the corpus intents through
//          a real model and score what comes back.
// CONTEXT: docs/design/local-model-script-authoring.md M5, §11.3.
//
//          This is the opt-in half: it needs a provider and costs tokens, so it
//          is a CLI rather than a test. Layer A (every reference solution really
//          validates) runs in CI with no model at all and is what keeps this
//          corpus from measuring nothing.
//
//          WHY IT SHELLS OUT TO THE APP'S OWN MODULES rather than reimplementing
//          scoring: the validator, the prompt assembler and the scorer are the
//          SAME code the product runs. A separate eval implementation would
//          drift, and then the number it reports would describe a pipeline
//          nobody ships.
//
// USAGE
//   node tests/eval/run-eval.mjs --provider ollama --model qwen3-coder:30b
//   node tests/eval/run-eval.mjs --provider anthropic --model claude-opus-4-8 --canary
//   node tests/eval/run-eval.mjs --provider ollama --model x --json results.json
//
// The provider must be one `ai_providers_list` knows, and its key (if any) must
// already be stored — this script never asks for or handles a secret.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";

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
const canaryOnly = Boolean(arg("canary", false));
const jsonOut = arg("json");
const budgetTokens = Number(arg("budget", 8000));
const baseUrl = arg("base-url", "");

if (!providerId || !model) {
  console.error("Usage: node tests/eval/run-eval.mjs --provider <id> --model <name> [--canary] [--budget N] [--json out.json]");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Load the app's own scorer + prompt assembler
// ---------------------------------------------------------------------------

/**
 * Bundle the TypeScript modules the product uses, rather than porting them.
 *
 * Same trick (and same reason) as gen-script-typings.mjs: Node cannot import the
 * .ts sources directly and adding a loader for one script is a dependency for no
 * gain.
 */
async function loadAppModules() {
  // esbuild lives in app/node_modules, and this script runs from tests/, so it
  // is resolved from the app's package rather than from here. Imported lazily so
  // the usage message above works in a checkout with no npm install.
  const appRequire = createRequire(path.join(appRoot, "package.json"));
  const { build } = await import(pathToFileURL(appRequire.resolve("esbuild")).href);

  const outDir = path.join(appRoot, "node_modules", ".cache", `calcula-eval-${process.pid}`);
  mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, "eval.mjs");
  const entry = path.join(outDir, "entry.ts");
  writeFileSync(
    entry,
    [
      `export * from ${JSON.stringify(path.join(appRoot, "src/api/scriptHost/scriptEval/index.ts").replace(/\\/g, "/"))};`,
      `export { buildSurfacePrompt } from ${JSON.stringify(path.join(appRoot, "src/api/scriptHost/scriptPrompt/index.ts").replace(/\\/g, "/"))};`,
    ].join("\n"),
    "utf8",
  );
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile,
    logLevel: "silent",
  });
  const mod = await import(`file://${outfile.replace(/\\/g, "/")}`);
  rmSync(outDir, { recursive: true, force: true });
  return mod;
}

const { scoreCandidate, extractScript, summarize, referenceSource, buildSurfacePrompt } =
  await loadAppModules();

const corpus = JSON.parse(readFileSync(path.join(here, "tasks.json"), "utf8"));
const tasks = corpus.tasks.filter((t) => (canaryOnly ? t.canary : true));

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

/**
 * One completion, OpenAI-compatible.
 *
 * Deliberately NOT going through the Tauri command: this runs headless, with no
 * app and no keychain. A cloud provider therefore reads its key from the
 * environment, which is a CI convention and keeps the OS keychain (where the
 * PRODUCT stores keys) out of a script that has no business touching it.
 */
async function complete(systemPrompt, userPrompt) {
  const base = baseUrl || PROVIDER_ENDPOINTS[providerId];
  if (!base) throw new Error(`No endpoint known for provider "${providerId}"; pass --base-url.`);
  const key = process.env.CALCULA_EVAL_API_KEY ?? "";
  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  return body.choices?.[0]?.message?.content ?? "";
}

const SYSTEM = [
  "You write Calcula object scripts.",
  "Reply with ONE fenced JavaScript code block and nothing else.",
  "The script must export `setup(context)` and reach the API through `context`.",
  "Declare any privileged capability with a `// @capability <id>` comment at the top.",
].join("\n");

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log(`[eval] ${tasks.length} task(s) against ${providerId}/${model} at a ${budgetTokens}-token surface budget\n`);

const scores = [];
for (const task of tasks) {
  const surface = buildSurfacePrompt({
    objectType: task.objectType,
    budgetTokens,
    hints: [...task.hints, task.intent],
  });
  const userPrompt = [
    surface.text,
    "",
    `# Task (the script is attached to a "${task.objectType}")`,
    task.intent,
  ].join("\n");

  let score;
  let candidate = "";
  try {
    const reply = await complete(SYSTEM, userPrompt);
    candidate = extractScript(reply);
    score = scoreCandidate(task, candidate);
  } catch (err) {
    // A transport failure is NOT a zero for the model — recording it as one
    // would quietly blame the model for a laptop that went to sleep.
    console.log(`  ERROR ${task.id}: ${err.message}`);
    continue;
  }
  // The CANDIDATE is kept on every failure. Without it a low score is just a
  // number: there is no way to tell a weak model from a broken prompt, and the
  // first real run of this corpus turned out to be diagnosing the VALIDATOR
  // rather than the model.
  scores.push(score.passed ? score : { ...score, candidate });
  const mark = score.passed ? "PASS" : "FAIL";
  const why = score.passed
    ? ""
    : `  (${[
        !score.parsed && "no parse",
        !score.reachClean && `invented ${score.inventedMethods.length}`,
        !score.capabilitiesDeclared && "undeclared capability",
        !score.capabilitiesExact && "over-declared",
        !score.behavioural && `missing ${score.missingCalls.join(",")}`,
      ]
        .filter(Boolean)
        .join("; ")})`;
  console.log(`  ${mark} ${task.id} ${score.score.toFixed(2)}${why}`);
}

const summary = summarize(scores);
console.log("");
console.log(`[eval] ${summary.passed}/${summary.total} passed, mean score ${summary.meanScore.toFixed(3)}`);
if (scores.length < tasks.length) {
  // Never let a partial run masquerade as a complete one.
  console.log(`[eval] WARNING: ${tasks.length - scores.length} task(s) errored and are NOT counted above.`);
}

if (jsonOut && typeof jsonOut === "string") {
  writeFileSync(
    jsonOut,
    JSON.stringify(
      { provider: providerId, model, budgetTokens, canaryOnly, corpusVersion: corpus.version, summary, scores },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`[eval] wrote ${jsonOut}`);
}

// A run that could not attempt every task is not a green run.
process.exit(scores.length === tasks.length && summary.failures.length === 0 ? 0 : 1);

// Referenced so the import is not dropped as unused when --json is absent.
void referenceSource;
