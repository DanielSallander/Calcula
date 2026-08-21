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

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
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
// --repair N runs the M7 authoring loop (generate -> validate -> correct) instead
// of scoring a single shot. It is what the product actually does; the one-shot
// mode remains the default so the two can be compared.
const repairRounds = Number(arg("repair", 0));

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

  const cacheRoot = path.join(appRoot, "node_modules", ".cache");
  // Sweep bundle dirs leaked by crashed runs: the exit handler cannot fire on
  // a SIGKILL or a task-manager kill, pids recycle, and nothing else reclaims
  // them. Anything older than an hour is not a concurrent run.
  try {
    for (const entry of readdirSync(cacheRoot)) {
      if (!entry.startsWith("calcula-eval-")) continue;
      const dir = path.join(cacheRoot, entry);
      if (Date.now() - statSync(dir).mtimeMs > 60 * 60 * 1000) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } catch {
    /* a missing cache dir or a locked stale dir is not worth failing the run */
  }
  const outDir = path.join(cacheRoot, `calcula-eval-${process.pid}`);
  mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, "eval.mjs");
  const entry = path.join(outDir, "entry.ts");
  writeFileSync(
    entry,
    [
      `export * from ${JSON.stringify(path.join(appRoot, "src/api/scriptHost/scriptEval/index.ts").replace(/\\/g, "/"))};`,
      `export { runTaskOutcome } from ${JSON.stringify(path.join(appRoot, "src/api/scriptHost/scriptEval/harness.ts").replace(/\\/g, "/"))};`,
      `export { buildSurfacePrompt } from ${JSON.stringify(path.join(appRoot, "src/api/scriptHost/scriptPrompt/index.ts").replace(/\\/g, "/"))};`,
      `export { authorScript } from ${JSON.stringify(path.join(appRoot, "src/api/scriptHost/scriptAuthoring/index.ts").replace(/\\/g, "/"))};`,
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
  // The bundle stays on disk for the grading subprocesses; removed at exit.
  process.on("exit", () => {
    try {
      rmSync(outDir, { recursive: true, force: true });
    } catch {
      /* a transient lock on a temp dir is not worth failing the run over */
    }
  });
  return { mod, bundlePath: outfile };
}

const { mod: appModules, bundlePath } = await loadAppModules();
const { scoreCandidate, gradeOutcome, extractScript, summarize, referenceSource, buildSurfacePrompt, authorScript } =
  appModules;

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

// ---------------------------------------------------------------------------
// Expected-diff grading (the corpus half of L3)
// ---------------------------------------------------------------------------
//
// A task with an `outcome` block is GRADED: the candidate is executed against
// the task's fixture in the outcome harness and the resulting cell values and
// output are compared to the expectations. Execution happens in a SUBPROCESS,
// never here: model output is untrusted, and this process holds the provider
// key in its environment. The child gets a scrubbed env, Node's permission
// model where this Node supports it, and a hard kill after GRADE_TIMEOUT_MS —
// which is also the only defence that works against a synchronous infinite
// loop, the one thing no in-process timeout can interrupt.

const GRADE_TIMEOUT_MS = 10_000;
const gradeChild = path.join(here, "grade-child.mjs");

/**
 * The strictest permission flag this Node accepts, probed once.
 *
 * `--permission` (Node 23+) / `--experimental-permission` (Node 20-22) deny
 * file WRITES, child processes and worker threads to the graded script. When
 * neither works the run proceeds — this is an opt-in dev CLI, not the product
 * sandbox — but says so loudly rather than pretending.
 */
function detectPermissionArgs() {
  for (const flag of ["--permission", "--experimental-permission"]) {
    const probe = spawnSync(
      process.execPath,
      [flag, `--allow-fs-read=${here}`, `--allow-fs-read=${path.dirname(bundlePath)}`, gradeChild, bundlePath],
      { input: "", env: childEnv(), timeout: 15_000 },
    );
    // The probe sends no payload, so the child exits on a JSON parse failure —
    // status 1 with our own stack on stderr means the flag itself was accepted.
    if (probe.status !== 9 && !String(probe.stderr).includes("bad option")) {
      return [flag, `--allow-fs-read=${here}`, `--allow-fs-read=${path.dirname(bundlePath)}`];
    }
  }
  console.log(
    "[eval] WARNING: this Node has no --permission support; graded scripts run without an OS-level sandbox.",
  );
  return [];
}

/** No provider key, no user profile — just enough for Node to start on Windows. */
function childEnv() {
  const env = {};
  for (const k of ["SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
}

let permissionArgs;

/** Run one candidate against one task's fixture; returns an OutcomeObservation. */
function observeOutcome(task, source) {
  if (permissionArgs === undefined) permissionArgs = detectPermissionArgs();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...permissionArgs, gradeChild, bundlePath], {
      env: childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Capped: the candidate can reach process.stderr in the child, and an
    // unbounded `out += d` under a tight write loop grows past V8's string
    // limit and crashes THIS process mid-run. A real observation is small.
    const MAX_OUT = 1_000_000;
    const MAX_ERR = 262_144;
    let out = "";
    let err = "";
    let settled = false;
    const finish = (obs) => {
      if (!settled) {
        settled = true;
        resolve(obs);
      }
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      // The observation may already be complete on stdout with the child kept
      // alive only by a candidate's stray timer — prefer the real result over
      // a fabricated verdict.
      try {
        finish(JSON.parse(out));
        return;
      } catch {
        /* nothing parseable — fall through to the honest timeout */
      }
      finish({
        ran: false,
        error: `did not finish within ${GRADE_TIMEOUT_MS / 1000}s (killed) — a runaway loop is a wrong answer`,
        readBack: [],
        output: [],
        totalChanges: 0,
      });
    }, GRADE_TIMEOUT_MS);
    child.stdout.on("data", (d) => {
      if (out.length < MAX_OUT) out += d;
      else child.kill("SIGKILL");
    });
    child.stderr.on("data", (d) => {
      if (err.length < MAX_ERR) err += d;
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        finish(JSON.parse(out));
      } catch {
        finish({
          ran: false,
          error: `grading subprocess failed: ${(err || out || "no output").slice(0, 300)}`,
          readBack: [],
          output: [],
          totalChanges: 0,
        });
      }
    });
    child.stdin.write(JSON.stringify({ task, source }));
    child.stdin.end();
  });
}

/**
 * The L3 hook for the repair loop, backed by the harness instead of a live
 * workbook. `applicable: false` on a harness gap — a member the harness cannot
 * service says nothing about the script, exactly like the realm mismatch the
 * in-app dry run declines on.
 */
function harnessDryRun(task) {
  return async (source) => {
    const obs = await observeOutcome(task, source);
    if (obs.harnessGap) {
      return {
        ok: true,
        error: null,
        durationMs: 0,
        changes: [],
        truncated: false,
        totalChanges: 0,
        output: obs.output,
        readBack: obs.readBack,
        applicable: false,
        declinedReason: `the offline harness does not implement ${obs.harnessGap}`,
      };
    }
    return {
      ok: obs.ran,
      error: obs.ran ? null : (obs.error ?? "unknown error"),
      durationMs: 0,
      changes: [],
      truncated: false,
      totalChanges: obs.totalChanges,
      output: obs.output,
      readBack: obs.readBack,
      applicable: true,
    };
  };
}

const SYSTEM = [
  "You write Calcula object scripts.",
  "Reply with ONE fenced JavaScript code block and nothing else.",
  "The script must export `setup(context)` and reach the API through `context`.",
  "React to the object's events through its hooks: a button's click handler is `context.onClick(handler)`.",
  "Use `context.expose(name, handler)` only for named commands — an exposed handler does NOT run on click.",
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
  let rounds = 0;
  let grade;
  try {
    if (repairRounds > 0) {
      // The product path: generate, validate, hand the errors back. A gradable
      // task also gets the harness as its L3 hook, so "it throws when run" and
      // "it runs and changes nothing" become repairable offline too.
      const authored = await authorScript({
        intent: task.intent,
        objectType: task.objectType,
        hints: task.hints,
        plan: { tier: "standard", surfaceBudgetTokens: budgetTokens, repairRounds, rationale: "" },
        complete: (system, user) => complete(system, user),
        dryRun: task.outcome ? harnessDryRun(task) : undefined,
        expectsWrites: Boolean(task.outcome?.expect?.length),
      });
      candidate = authored.source;
      rounds = authored.attempts.length - 1;
    } else {
      const reply = await complete(SYSTEM, userPrompt);
      candidate = extractScript(reply);
    }
    if (task.outcome) {
      grade = gradeOutcome(task.outcome, await observeOutcome(task, candidate));
    }
    score = scoreCandidate(task, candidate, grade);
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
  const fixes = rounds > 0 ? ` [+${rounds} repair${rounds === 1 ? "" : "s"}]` : "";
  const graded = score.graded
    ? ` [graded ${score.outcome.checksPassed}/${score.outcome.checksTotal}]`
    : grade && !grade.gradable
      ? ` [ungradable: harness lacks ${grade.harnessGap}]`
      : "";
  const why = score.passed
    ? ""
    : `  (${[
        !score.parsed && "no parse",
        !score.reachClean && `invented ${score.inventedMethods.length}`,
        !score.capabilitiesDeclared && "undeclared capability",
        !score.capabilitiesExact && "over-declared",
        !score.behavioural && `missing ${score.missingCalls.join(",")}`,
        score.graded && !score.outcome.ran && `run failed: ${score.outcome.error ?? "?"}`,
        score.graded &&
          score.outcome.ran &&
          score.outcome.grade < 1 &&
          `wrong outcome: ${[
            ...score.outcome.wrongCells.map(
              (w) => `R${w.row + 1}C${w.col + 1} holds ${JSON.stringify(w.actual)}, expected ${JSON.stringify(w.expected)}`,
            ),
            ...score.outcome.missingOutput.map((m) => `output never mentions ${JSON.stringify(m)}`),
          ].join("; ")}`,
      ]
        .filter(Boolean)
        .join("; ")})`;
  console.log(`  ${mark} ${task.id} ${score.score.toFixed(2)}${fixes}${graded}${why}`);
}

const summary = summarize(scores);
// A harness gap silently downgrades a task to static-only scoring; a run with
// many of them is measuring less than it appears to, and must say so.
const gapped = scores.filter((s) => s.outcome && !s.outcome.gradable);
console.log("");
console.log(`[eval] ${summary.passed}/${summary.total} passed, mean score ${summary.meanScore.toFixed(3)}`);
if (gapped.length > 0) {
  console.log(
    `[eval] WARNING: ${gapped.length} gradable task(s) fell back to static scoring on a harness gap: ` +
      gapped.map((s) => `${s.taskId} (${s.outcome.harnessGap})`).join(", "),
  );
}
if (scores.length < tasks.length) {
  // Never let a partial run masquerade as a complete one.
  console.log(`[eval] WARNING: ${tasks.length - scores.length} task(s) errored and are NOT counted above.`);
}

if (jsonOut && typeof jsonOut === "string") {
  writeFileSync(
    jsonOut,
    JSON.stringify(
      {
        provider: providerId,
        model,
        budgetTokens,
        canaryOnly,
        corpusVersion: corpus.version,
        ungradable: gapped.map((s) => ({ taskId: s.taskId, harnessGap: s.outcome.harnessGap })),
        summary,
        scores,
      },
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
