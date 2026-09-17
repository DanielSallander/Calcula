//! FILENAME: tests/eval/run-suite.mjs
// PURPOSE: `npm run eval:<surface>` and `npm run eval:all` — run the eval
//          suite on its pinned flags, against a llama-server THIS process
//          starts, and record what actually answered.
// CONTEXT: `suite.mjs` is the data (which runner, which knobs, which values)
//          and stays pure so CI can hold it to the runners; this file is the
//          process around it. It starts the product's runtime once (on the
//          product's flags, on a free port, with the model file hashed), runs
//          the selected runners one after another against it — one slot, so
//          in parallel they would only queue on each other and inflate every
//          latency figure — and writes one aggregate beside the per-surface
//          artifacts saying which binary, which GGUF, which flags, which
//          machine.
//
// USAGE
//   node tests/eval/run-suite.mjs all
//   node tests/eval/run-suite.mjs formulas
//   node tests/eval/run-suite.mjs all --dry-run                       the plan and the preflight, nothing runs
//   node tests/eval/run-suite.mjs all --only formulas,design-queries
//   node tests/eval/run-suite.mjs all --skip scripts
//   node tests/eval/run-suite.mjs all --model granite-4.0-1b-Q4_K_M --label granite-1b
//   node tests/eval/run-suite.mjs formulas --limit 5                  an OVERRIDE: written to out/, not runs/
//   node tests/eval/run-suite.mjs formulas --retrieval 0 --keep       an override kept as evidence
//   node tests/eval/run-suite.mjs design-queries --provider ollama --model qwen2.5-coder:3b --grammar off
//
// SUITE OPTIONS  --model <calcula-builtin | name | path.gguf>   --provider <id>   --base-url <ROOT, no /v1>
//                --only a,b   --skip a,b   --label <arm>   --out <dir>   --keep   --dry-run
// Anything else is `--knob value` and overrides that knob's pin on every selected runner that reads it.
//
// WHERE THE EVIDENCE GOES. A pinned run is written to `tests/eval/runs/`
// (committed, the .gitignore says why); a run with any override goes to
// `tests/eval/out/` (ignored) unless `--keep`. A second run on the same day
// gets a `--HHMM` suffix rather than overwriting the first — both happened.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SURFACES, surfaceById, parseCli, buildArgv, outputBucket, modelSlug, artifactFileName,
  localDate, localTime, headline,
} from "./suite.mjs";
import { resolveModel, describeModel, startServer, runtimeState } from "./lib/llamaServer.mjs";
import { resolveGrader, resolveExample } from "./lib/grader.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");

function usage(problem) {
  if (problem) console.error(`[suite] ${problem}\n`);
  console.error(
    `Usage: node tests/eval/run-suite.mjs <${SURFACES.map((s) => s.id).join("|")}|all> [options] [--knob value ...]\n` +
      `  --model M      calcula-builtin (default), a GGUF name under app/src-tauri/models or the bake-off folder, or a path\n` +
      `  --provider P   llamacpp (default; the suite starts the server) or any runner-known provider (no server started)\n` +
      `  --base-url U   an already-running server's ROOT url (no /v1); no server is started\n` +
      `  --only a,b     with "all": run only these     --skip a,b   with "all": run all but these\n` +
      `  --label L      a name for this arm in the artifact file names\n` +
      `  --out DIR      write artifacts here instead of runs/ or out/\n` +
      `  --keep         keep an overridden run under runs/ (evidence) instead of out/\n` +
      `  --dry-run      print the preflight and every command; run nothing`,
  );
  process.exit(2);
}

let cli;
try {
  cli = parseCli(process.argv.slice(2));
} catch (e) {
  usage(e.message);
}
const { target, options, overrides } = cli;
if (!target) usage("which surface?");

// ---------------------------------------------------------------------------
// Which surfaces
// ---------------------------------------------------------------------------

let selected;
if (target === "all") {
  selected = SURFACES.slice();
  for (const id of [...options.only, ...options.skip]) {
    if (!surfaceById(id)) usage(`unknown surface ${JSON.stringify(id)} in --only/--skip`);
  }
  if (options.only.length) selected = selected.filter((s) => options.only.includes(s.id));
  if (options.skip.length) selected = selected.filter((s) => !options.skip.includes(s.id));
} else {
  const one = surfaceById(target);
  if (!one) usage(`unknown surface ${JSON.stringify(target)}`);
  if (options.only.length || options.skip.length) usage("--only/--skip apply to \"all\"");
  selected = [one];
}
if (selected.length === 0) usage("nothing selected");

// A provider other than llama.cpp, or an explicit server, means the suite
// starts nothing and the runners are told where to go.
const provider = options.provider ?? "llamacpp";
const needsModel = selected.some((s) => s.needsModel);
const startsServer = needsModel && provider === "llamacpp" && !options.baseUrl;
const effectiveOverrides = { ...overrides };
if (options.provider) effectiveOverrides.provider = options.provider;

// ---------------------------------------------------------------------------
// Preflight: everything that would fail forty minutes in fails now
// ---------------------------------------------------------------------------

const problems = [];
const notes = [];

let model = null;
if (startsServer) {
  const runtime = runtimeState();
  if (runtime.state === "missing" || runtime.state === "unknown-target") {
    problems.push(`llama-server is not on disk for ${runtime.triple} (${runtime.dir}) — run: cd app && npm run fetch:llama-server`);
  } else if (runtime.state === "stale") {
    notes.push(`llama-server on disk is ${runtime.recorded || "unstamped"}, the pin is ${runtime.pinnedBuild} — recorded, not refused`);
  }
  try {
    model = resolveModel(options.model ?? "calcula-builtin");
  } catch (e) {
    problems.push(e.message);
  }
} else if (needsModel && provider === "llamacpp") {
  notes.push(`using the server at ${options.baseUrl}; the suite is not starting one and cannot say which GGUF it serves`);
} else if (needsModel && !options.model) {
  problems.push(`--provider ${provider} needs --model`);
}

for (const s of selected) {
  for (const need of s.prerequisites) {
    if (need === "grader") {
      try {
        const g = resolveGrader({ repo });
        notes.push(`formula grader: ${g.exe}${g.builtAt ? ` (built ${g.builtAt})` : ""}`);
      } catch (e) {
        problems.push(`${s.id}: ${e.message}`);
      }
    } else if (need === "narration-helper") {
      try {
        const h = resolveExample("narration", { repo });
        notes.push(`narration helper: ${h.exe}${h.builtAt ? ` (built ${h.builtAt})` : ""}`);
      } catch (e) {
        problems.push(`${s.id}: ${e.message}`);
      }
    }
  }
}

// The runner label for the model: the FILE's stem when the suite serves it,
// whatever the caller said otherwise.
const modelLabel = startsServer ? model?.id : options.model;
// A run that involves no model at all is a run of the RULES; "no-model"
// would read as a run that lost track of its model.
const slug = needsModel ? modelSlug(modelLabel ?? "unknown-model") : "rules";
const bucket = options.out ? null : outputBucket({ overrides, keep: options.keep });
const outDir = options.out ? path.resolve(options.out) : path.join(here, bucket);
const date = localDate();

const plans = selected.map((s) => {
  // A surface that calls no model is named for what it is — rules — never
  // for the arm it happened to run beside.
  const own = s.needsModel ? slug : "rules";
  const file = path.join(outDir, artifactFileName({ date, surfaceId: s.id, slug: own, label: options.label }));
  const json = existsSync(file)
    ? path.join(outDir, artifactFileName({ date, surfaceId: s.id, slug: own, label: options.label, time: localTime() }))
    : file;
  let built;
  try {
    built = buildArgv(s, {
      runnerPath: path.join(here, s.runner),
      model: modelLabel,
      baseUrl: startsServer ? "<server>" : options.baseUrl,
      json,
      overrides: effectiveOverrides,
    });
  } catch (e) {
    usage(e.message);
  }
  return { surface: s, json, ...built };
});

const unusedOverrides = Object.keys(effectiveOverrides).filter((k) => plans.every((p) => !p.applied.includes(k)));
if (unusedOverrides.length) problems.push(`no selected runner reads ${unusedOverrides.map((k) => `--${k}`).join(", ")}`);

const minutes = selected.reduce((n, s) => n + s.minutes, 0);
console.log(`[suite] ${target === "all" ? "all" : target}: ${selected.map((s) => s.id).join(", ")} (~${minutes} min on this CPU)`);
console.log(`[suite] machine: ${os.cpus()[0]?.model?.trim() ?? "?"} x${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB, node ${process.version}`);
if (startsServer && model) {
  console.log(`[suite] model: ${model.path} (${(model.bytes / 2 ** 30).toFixed(2)} GB, ${model.source})`);
}
console.log(`[suite] evidence: ${outDir}${bucket === "out" ? "  (overrides present: an experiment, not evidence — pass --keep to retain it)" : ""}`);
for (const n of notes) console.log(`[suite] note: ${n}`);
for (const p of plans) {
  const shown = p.argv.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ");
  console.log(`\n[suite] ${p.surface.id} — ${p.surface.question}`);
  if (p.applied.length) console.log(`[suite]   overrides applied: ${p.applied.map((k) => `--${k} ${JSON.stringify(p.values[k])}`).join(" ")}`);
  console.log(`  node ${shown}`);
}
if (problems.length) {
  console.error(`\n[suite] ${options.dryRun ? "would refuse" : "refusing"} to run:`);
  for (const p of problems) console.error(`  - ${p}`);
  if (!options.dryRun) process.exit(2);
}
if (options.dryRun) {
  console.log("\n[suite] dry run: nothing was started.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

let server = null;
let serverRecord = null;
let modelDescribed = null;
if (startsServer) {
  console.log(`\n[suite] hashing ${path.basename(model.path)} ...`);
  modelDescribed = await describeModel(model);
  console.log(`[suite] sha256 ${modelDescribed.sha256}${modelDescribed.matchesPin ? " (matches the on-board pin)" : ""}`);
  server = await startServer({ modelPath: model.path });
  // Kept from the launch, because the handle is gone by the time the
  // aggregate is written and the aggregate must say what served the run.
  serverRecord = {
    exe: server.exe,
    args: server.args,
    triple: server.triple,
    build: server.build,
    buildState: server.buildState,
    pinnedBuild: server.pinnedBuild,
    port: server.port,
    props: server.props,
  };
  if (server.props) {
    console.log(
      `[suite] serving ${server.props.modelPath || "?"} | n_ctx ${server.props.nCtx ?? "?"} | slots ${server.props.totalSlots ?? "?"}` +
        `${server.props.buildInfo ? ` | ${server.props.buildInfo}` : ""}`,
    );
  }
}

const stopServer = async () => {
  if (server) {
    await server.stop();
    server = null;
  }
};
process.on("SIGINT", async () => {
  console.error("\n[suite] interrupted");
  await stopServer();
  process.exit(130);
});

// ---------------------------------------------------------------------------
// The runners, one after another
// ---------------------------------------------------------------------------

function runOne(argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { cwd: repo, stdio: "inherit", env: process.env });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    child.on("error", () => resolve(1));
  });
}

const startedAt = new Date();
const report = [];
mkdirSync(outDir, { recursive: true });
try {
  for (const p of plans) {
    const argv = server ? buildArgv(p.surface, {
      runnerPath: path.join(here, p.surface.runner),
      model: modelLabel,
      baseUrl: server.baseUrl,
      json: p.json,
      overrides: effectiveOverrides,
    }).argv : p.argv;
    console.log(`\n${"=".repeat(78)}\n[suite] ${p.surface.id}: ${p.surface.question}\n[suite] > node ${argv.join(" ")}\n`);
    const t0 = Date.now();
    const exitCode = await runOne(argv);
    const seconds = Math.round((Date.now() - t0) / 1000);
    let artifact = null;
    if (existsSync(p.json)) {
      try {
        artifact = JSON.parse(readFileSync(p.json, "utf8"));
      } catch (e) {
        console.error(`[suite] ${p.surface.id}: the artifact at ${p.json} is not JSON: ${e.message}`);
      }
    }
    const entry = {
      id: p.surface.id,
      runner: p.surface.runner,
      argv,
      values: p.values,
      overridesApplied: p.applied,
      artifact: artifact ? path.relative(repo, p.json) : null,
      exitCode,
      exitOneMeans: p.surface.exitOne,
      seconds,
      // The summary travels with the aggregate so one file answers "how did
      // it go"; the per-task rows stay in the surface's own artifact.
      summary: artifact ? artifact.summary ?? null : null,
      headline: artifact ? headline(p.surface.id, artifact) : `NO ARTIFACT (exit ${exitCode})`,
    };
    report.push(entry);
    console.log(`\n[suite] ${p.surface.id}: ${entry.headline} | ${seconds}s | exit ${exitCode}`);
  }
} finally {
  await stopServer();
}

// ---------------------------------------------------------------------------
// The aggregate
// ---------------------------------------------------------------------------

const finishedAt = new Date();
const aggregate = {
  suite: {
    target,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    wallClockSec: Math.round((finishedAt - startedAt) / 1000),
    overrides: effectiveOverrides,
    label: options.label,
    machine: {
      cpu: os.cpus()[0]?.model?.trim() ?? "",
      cores: os.cpus().length,
      memoryGb: Math.round(os.totalmem() / 2 ** 30),
      platform: `${os.platform()} ${os.release()}`,
      node: process.version,
    },
    model: modelDescribed
      ? { id: modelDescribed.id, file: modelDescribed.path, bytes: modelDescribed.bytes, sha256: modelDescribed.sha256, matchesPin: modelDescribed.matchesPin, source: modelDescribed.source }
      : { id: modelLabel ?? null, provider, baseUrl: options.baseUrl ?? null, note: "not served by the suite; identity as reported by the runners" },
    server: startsServer ? serverRecord : { provider, baseUrl: options.baseUrl ?? null, note: "not started by the suite" },
  },
  surfaces: report,
};

const aggregateFile = path.join(outDir, artifactFileName({ date, surfaceId: target === "all" ? "all" : `${target}-suite`, slug, label: options.label }));
const aggregatePath = existsSync(aggregateFile)
  ? path.join(outDir, artifactFileName({ date, surfaceId: target === "all" ? "all" : `${target}-suite`, slug, label: options.label, time: localTime() }))
  : aggregateFile;
writeFileSync(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");

console.log(`\n${"=".repeat(78)}\n[suite] ${aggregate.suite.wallClockSec}s wall clock | ${slug}${options.label ? ` (${options.label})` : ""}`);
for (const r of report) console.log(`  ${r.id.padEnd(15)} ${r.headline}`);
for (const r of report) if (r.artifact) console.log(`  ${r.id.padEnd(15)} -> ${r.artifact}`);
console.log(`  ${"aggregate".padEnd(15)} -> ${path.relative(repo, aggregatePath)}`);

const missing = report.filter((r) => !r.artifact);
if (missing.length) {
  console.error(`\n[suite] ${missing.length} runner(s) produced no artifact: ${missing.map((r) => r.id).join(", ")}`);
  process.exit(1);
}
process.exit(0);
