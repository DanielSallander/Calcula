#!/usr/bin/env node
/**
 * FILENAME: tests/soak/soak-runner.mjs
 * PURPOSE: The deep-testing orchestrator. Runs long random walks with
 *          semantic oracles (undo round-trip, save/reload round-trip, recalc
 *          consistency), real-user workflow scenarios, automatic repro
 *          minimization, Claude-based triage, an optional auto-fix loop with
 *          orchestrator-side validation, and expected-behavior corpus
 *          maintenance.
 *
 * Usage:
 *   node tests/soak/soak-runner.mjs --mode=quick          # ~15 min sanity run
 *   node tests/soak/soak-runner.mjs --mode=overnight      # hours, triage-only
 *   node tests/soak/soak-runner.mjs --mode=overnight --fix=auto
 *   node tests/soak/soak-runner.mjs --replay=path/to/trace.json
 *   node tests/soak/soak-runner.mjs --generate-corpus
 *
 * Flags (defaults depend on --mode):
 *   --budget-min=N      total wall-clock budget   (quick 15, overnight 480)
 *   --walks=N           number of soak walks      (quick 1, overnight 12)
 *   --walk-actions=N    actions per walk          (quick 150, overnight 400)
 *   --oracle-every=N    oracle checkpoint cadence (default 25)
 *   --scenarios=all|none                          (quick none, overnight all)
 *   --fix=triage-only|auto                        (default triage-only)
 *   --max-fixes=N       cap on fix attempts       (default 5)
 *   --seed=N            base seed (default Date.now())
 *   --restart-every=N   proactive app restart cadence in walks (default 3)
 *   --e2e-manual        use an already-running app (CDP on 9222)
 *   --no-corpus         skip corpus updates
 *
 * Environment: CLAUDE_CMD / CLAUDE_MODEL / CLAUDE_EFFORT, CDP_PORT
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log, execCmd, ensureDir } from "../regression/lib/exec.mjs";
import { launchApp, waitForCDP, killApp, restartApp } from "../regression/lib/app-lifecycle.mjs";
import { invokeClaude, extractJson } from "../regression/lib/claude.mjs";
import { loadLedger, saveLedger, addBug, updateBug, findSimilarBug } from "./bug-ledger.mjs";
import { runTriage } from "./triage.mjs";
import { runFix, validateFix, revertFix } from "./fix-loop.mjs";
import { upsertEntries, coverage, parseCorpus } from "./corpus.mjs";
import { writeReport } from "./report.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const APP_DIR = path.join(PROJECT_ROOT, "app");
const SOAK_RESULTS = path.join(APP_DIR, "e2e", "results", "soak");
const FAILURES_DIR = path.join(SOAK_RESULTS, "failures");
const CDP_PORT = Number(process.env.CDP_PORT ?? 9222);
const SETUP_RUST_ENV = path.join(PROJECT_ROOT, "core", "setup-rust-env.ps1");
const CDP_TIMEOUT = 900_000; // 15 min for cold Rust builds

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);

const MODE = args.mode || "quick";
const MODE_DEFAULTS =
  MODE === "overnight"
    ? { budgetMin: 480, walks: 12, walkActions: 400, scenarios: "all", fix: "triage-only" }
    : { budgetMin: 15, walks: 1, walkActions: 150, scenarios: "none", fix: "triage-only" };

const BUDGET_MIN = Number(args["budget-min"] ?? MODE_DEFAULTS.budgetMin);
const WALKS = Number(args.walks ?? MODE_DEFAULTS.walks);
const WALK_ACTIONS = Number(args["walk-actions"] ?? MODE_DEFAULTS.walkActions);
const ORACLE_EVERY = Number(args["oracle-every"] ?? 25);
const SCENARIOS = args.scenarios ?? MODE_DEFAULTS.scenarios;
const FIX_MODE = args.fix ?? MODE_DEFAULTS.fix;
const MAX_FIXES = Number(args["max-fixes"] ?? 5);
const BASE_SEED = Number(args.seed ?? Date.now());
const RESTART_EVERY = Number(args["restart-every"] ?? 3);
const E2E_MANUAL = args["e2e-manual"] === "true";
const NO_CORPUS = args["no-corpus"] === "true";

const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const RUN_DIR = path.join(SOAK_RESULTS, "runs", RUN_ID);
const DEADLINE = Date.now() + BUDGET_MIN * 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minutesLeft() {
  return Math.max(0, Math.round((DEADLINE - Date.now()) / 60_000));
}

function listFailureDirs() {
  if (!fs.existsSync(FAILURES_DIR)) return [];
  return fs
    .readdirSync(FAILURES_DIR)
    .map((d) => path.join(FAILURES_DIR, d))
    .filter((d) => fs.statSync(d).isDirectory());
}

function playwright(cmd, env = {}, timeout = 1_800_000) {
  return execCmd(`yarn playwright test ${cmd} 2>&1`, {
    cwd: APP_DIR,
    timeout,
    env: { ...process.env, ...env },
  });
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

function runGate(summary) {
  log(`Gate: type-check${MODE === "overnight" ? " + unit tests" : ""}`);
  const tsc = execCmd("yarn check-types", { cwd: APP_DIR, timeout: 600_000 });
  if (!tsc.success) {
    summary.phases.push({ name: "gate", success: false, note: "type-check failed" });
    log("  [FAIL] type-check — aborting soak (do not soak a broken build)");
    return false;
  }
  if (MODE === "overnight") {
    const unit = execCmd("yarn test", { cwd: APP_DIR, timeout: 1_200_000 });
    if (!unit.success) {
      summary.phases.push({ name: "gate", success: false, note: "unit tests failed" });
      log("  [FAIL] unit tests — aborting soak");
      return false;
    }
  }
  summary.phases.push({ name: "gate", success: true });
  log("  [OK] gate passed");
  return true;
}

function runScenarios(summary) {
  if (SCENARIOS === "none") {
    summary.phases.push({ name: "scenarios", success: true, skipped: true, note: "disabled" });
    return;
  }
  const scenarioDir = path.join(APP_DIR, "e2e", "scenarios");
  const hasScenarios =
    fs.existsSync(scenarioDir) &&
    fs.readdirSync(scenarioDir).some((f) => f.endsWith(".scenario.ts"));
  if (!hasScenarios) {
    summary.phases.push({ name: "scenarios", success: true, skipped: true, note: "no scenario files" });
    return;
  }

  log("Scenarios: running workflow scenarios with oracle checkpoints");
  const result = playwright("--project=scenario", { E2E_MANUAL: "1" }, 3_600_000);
  summary.phases.push({
    name: "scenarios",
    success: result.success,
    note: result.success ? undefined : "see playwright report",
  });
  if (!result.success) {
    fs.writeFileSync(path.join(RUN_DIR, "scenario-failures.log"), result.output, "utf8");
    log("  [FAIL] one or more scenarios failed (logged)");
  } else {
    log("  [OK] scenarios passed");
  }
}

function runWalk(summary, walkIndex) {
  const seed = BASE_SEED + walkIndex;
  const before = new Set(listFailureDirs());
  const timeout = Math.max(1_800_000, WALK_ACTIONS * 2_000 + 1_800_000);

  log(`Walk ${walkIndex + 1}/${WALKS}: seed=${seed} actions=${WALK_ACTIONS} (${minutesLeft()} min left)`);
  const result = playwright(
    "--project=soak e2e/soak/soak-walk.spec.ts",
    {
      E2E_MANUAL: "1",
      SOAK_SEED: String(seed),
      SOAK_ACTIONS: String(WALK_ACTIONS),
      SOAK_ORACLE_EVERY: String(ORACLE_EVERY),
      SOAK_RESULTS_DIR: SOAK_RESULTS,
      SOAK_TIMEOUT_MS: String(timeout - 120_000),
    },
    timeout
  );

  const newDirs = listFailureDirs().filter((d) => !before.has(d));
  let violationId = null;
  let crashed = false;
  for (const dir of newDirs) {
    try {
      const failure = JSON.parse(fs.readFileSync(path.join(dir, "failure.json"), "utf8"));
      violationId = failure.violationId;
      if (["page-crashed", "oracle-infrastructure"].includes(failure.violationId)) {
        crashed = true;
      }
    } catch { /* incomplete bundle */ }
  }
  if (!result.success && newDirs.length === 0) {
    // Playwright failed without a bundle — infrastructure-class failure.
    crashed = true;
  }

  summary.walks.push({
    seed,
    passed: result.success,
    violationId,
    newFailures: newDirs.map((d) => path.basename(d)),
  });
  log(
    result.success
      ? `  [OK] walk passed`
      : `  [FAIL] walk failed (${violationId ?? "infrastructure"}) — ${newDirs.length} bundle(s)`
  );

  return { newDirs, crashed };
}

function triageFailures(summary, ledger, failureDirs) {
  const triaged = [];
  for (const dir of failureDirs) {
    const failureJsonPath = path.join(dir, "failure.json");
    if (!fs.existsSync(failureJsonPath)) continue;
    const failure = JSON.parse(fs.readFileSync(failureJsonPath, "utf8"));

    if (["page-crashed", "oracle-infrastructure"].includes(failure.violationId)) {
      summary.findings.push({
        bugId: null,
        status: "infrastructure",
        violationId: failure.violationId,
        summary: "infrastructure-class failure (not ledgered unless reproducible)",
      });
      continue;
    }

    // Dedupe against existing open bugs.
    const diffPaths = (failure.violation?.digestDiff?.diffs ?? []).map((d) => d.path);
    const similar = findSimilarBug(ledger, failure.violationId, diffPaths);
    if (similar) {
      log(`  Failure in ${path.basename(dir)} matches existing ${similar.id} — skipping triage`);
      summary.findings.push({
        bugId: similar.id,
        status: "duplicate",
        violationId: failure.violationId,
        summary: `duplicate of ${similar.id}`,
      });
      continue;
    }

    if (minutesLeft() < 5) {
      log("  Budget exhausted — remaining failures left untriaged (bundles persist)");
      break;
    }

    log(`Triage: ${path.basename(dir)}`);
    const verdict = runTriage({
      failureDir: dir,
      projectRoot: PROJECT_ROOT,
      resultsDir: RUN_DIR,
    });

    const minimizedPath = path.join(dir, "minimized.trace.json");
    const tracePath = fs.existsSync(minimizedPath) ? minimizedPath : path.join(dir, "trace.json");
    const trace = JSON.parse(fs.readFileSync(tracePath, "utf8"));

    const bugId = addBug(ledger, {
      discovered: new Date().toISOString().slice(0, 10),
      source: { kind: "soak-walk", seed: trace.seed, runId: RUN_ID },
      violation: {
        oracleId: failure.violationId,
        message: failure.violation?.message ?? "",
        digestDiffPaths: diffPaths.slice(0, 10),
      },
      repro: {
        trace: path.relative(PROJECT_ROOT, tracePath),
        actionCount: trace.actions.length,
      },
      triage: verdict ?? { verdict: "untriaged", confidence: 0 },
      fix: { status: "open", filesChanged: [], diffSummary: "", validatedBy: [] },
      status: verdict ? "triaged" : "open",
    });
    saveLedger(ledger);

    if (verdict?.proposedBehaviorEntry?.id && !NO_CORPUS) {
      upsertEntries([
        {
          id: verdict.proposedBehaviorEntry.id,
          text: verdict.proposedBehaviorEntry.text,
          status: "unverified",
          coveredBy: [],
          source: `soak-run ${RUN_ID} (${bugId})`,
        },
      ]);
    }

    summary.findings.push({
      bugId,
      status: verdict?.verdict ?? "untriaged",
      violationId: failure.violationId,
      summary: verdict?.rootCauseHypothesis ?? failure.violation?.message?.slice(0, 120) ?? "",
      minimizedActions: failure.minimizedActionCount,
    });
    triaged.push({ bugId, dir, verdict });
  }
  return triaged;
}

async function fixBugs(summary, ledger, triaged, appChild) {
  let child = appChild;
  const candidates = triaged
    .filter((t) => t.verdict?.verdict === "app-bug")
    .sort((a, b) => (b.verdict.confidence ?? 0) - (a.verdict.confidence ?? 0))
    .slice(0, MAX_FIXES);

  for (const { bugId, dir } of candidates) {
    if (minutesLeft() < 30) {
      log("Fix loop: budget too low for another fix attempt — stopping");
      break;
    }
    const bug = ledger.bugs.find((b) => b.id === bugId);
    log(`Fix attempt: ${bugId}`);

    const fix = runFix({
      bug,
      failureDir: dir,
      projectRoot: PROJECT_ROOT,
      resultsDir: RUN_DIR,
    });

    if (fix.expectedBehavior) {
      updateBug(ledger, bugId, { status: "expected-behavior", fix: { ...bug.fix, status: "expected-behavior" } });
      saveLedger(ledger);
      summary.fixes.push({ bugId, outcome: "expected-behavior (no code change)" });
      continue;
    }
    if (!fix.applied) {
      summary.fixes.push({ bugId, outcome: "no changes made" });
      continue;
    }

    // Relaunch the app so Rust changes rebuild, then validate.
    log("  Restarting app to pick up the fix (Rust rebuild)...");
    child = await restartApp(child, { appDir: APP_DIR, setupRustEnvPath: SETUP_RUST_ENV, cdpPort: CDP_PORT }, CDP_TIMEOUT);
    if (!child) {
      log("  App failed to restart after fix — reverting");
      revertFix({ projectRoot: PROJECT_ROOT, files: fix.files });
      updateBug(ledger, bugId, { fix: { ...bug.fix, status: "fix-failed", filesChanged: fix.files } });
      saveLedger(ledger);
      summary.fixes.push({ bugId, outcome: "fix-failed (app did not rebuild)", files: fix.files });
      child = await restartApp(null, { appDir: APP_DIR, setupRustEnvPath: SETUP_RUST_ENV, cdpPort: CDP_PORT }, CDP_TIMEOUT);
      continue;
    }

    const validation = validateFix({ failureDir: dir, projectRoot: PROJECT_ROOT, appDir: APP_DIR });
    if (validation.ok) {
      updateBug(ledger, bugId, {
        status: "fixed",
        fix: {
          status: "fixed",
          filesChanged: fix.files,
          diffSummary: fix.responseExcerpt.split("FIX:").pop()?.trim().slice(0, 300) ?? "",
          validatedBy: ["replay-minimized-trace", "type-check"],
        },
      });
      saveLedger(ledger);
      summary.fixes.push({ bugId, outcome: "FIXED + validated", files: fix.files });
      log(`  [OK] ${bugId} fixed and validated (changes left uncommitted for review)`);
    } else {
      fs.writeFileSync(path.join(RUN_DIR, `fix-${bugId}-validation-failure.log`), validation.reason ?? "", "utf8");
      revertFix({ projectRoot: PROJECT_ROOT, files: fix.files });
      updateBug(ledger, bugId, { fix: { ...bug.fix, status: "fix-failed", filesChanged: fix.files } });
      saveLedger(ledger);
      summary.fixes.push({ bugId, outcome: "fix-failed (validation) — reverted", files: fix.files });
      log(`  [FAIL] ${bugId} fix did not validate — reverted`);
      // Rebuild once more so later phases run against clean code.
      child = await restartApp(child, { appDir: APP_DIR, setupRustEnvPath: SETUP_RUST_ENV, cdpPort: CDP_PORT }, CDP_TIMEOUT);
    }
  }
  return child;
}

// ---------------------------------------------------------------------------
// Corpus generation (--generate-corpus)
// ---------------------------------------------------------------------------

function generateCorpus() {
  ensureDir(RUN_DIR);
  log("Generating expected-behavior corpus draft (Claude scan)...");
  const existing = parseCorpus().entries.map((e) => e.id);

  const prompt = [
    "You are documenting the EXPECTED BEHAVIOR of Calcula, an open-source",
    "spreadsheet application (Excel alternative; Tauri + Rust + React).",
    `Project root: ${PROJECT_ROOT}`,
    "",
    "Scan these sources to derive behavior statements:",
    "- app/extensions/ (each folder is a user-facing feature)",
    "- app/e2e/tests/*.spec.ts (what the tests assert today)",
    "- tests/regression/registry.json (feature inventory)",
    "",
    "Write concise, testable behavior statements a user would recognize, e.g.",
    '"Sorting a range with merged cells shows an error dialog and changes',
    'nothing" or "Undo after deleting a sheet restores the sheet with all its',
    'data, formatting and objects". Focus on behaviors involving STATE',
    "(undo/redo, save/load, recalculation) and FEATURE INTERACTIONS.",
    "",
    `Existing entry IDs (do NOT repeat): ${existing.join(", ") || "(none)"}`,
    "",
    "Areas (id prefix): undo, save, recalc, edit, format, structure, pivot,",
    "chart, table, slicer, filter, sheet, names, validation, cf, clipboard, ui",
    "",
    "Output STRICT JSON only:",
    '{ "entries": [ { "id": "area.kebab-name", "text": "behavior statement",',
    '  "coveredBy": ["app/e2e/tests/x.spec.ts"] }, ... ] }',
    "Aim for 40-80 high-value entries. coveredBy lists existing spec files",
    "that genuinely exercise the behavior (empty array if none).",
  ].join("\n");

  const result = invokeClaude({
    prompt,
    label: "generate-corpus",
    resultsDir: RUN_DIR,
    cwd: PROJECT_ROOT,
    allowedTools: "Read,Grep,Glob",
    timeoutMs: 1_800_000,
  });
  if (!result.success) {
    log("  Corpus generation failed");
    process.exit(1);
  }

  const parsed = extractJson(result.output);
  const entries = parsed?.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    log("  No parseable entries in Claude's response");
    process.exit(1);
  }

  const stamped = entries.map((e) => ({
    ...e,
    status: "unverified",
    source: `corpus-scan ${RUN_ID}`,
  }));
  const stats = upsertEntries(stamped);
  log(`  Corpus updated: +${stats.added} added, ${stats.updated} updated, ${stats.skipped} skipped`);
  log(`  Review docs/expected-behavior.md and flip good entries to [verified].`);
}

// ---------------------------------------------------------------------------
// Replay mode (--replay=path)
// ---------------------------------------------------------------------------

async function replayMode(tracePath) {
  const abs = path.resolve(PROJECT_ROOT, tracePath);
  if (!fs.existsSync(abs)) {
    log(`Trace not found: ${abs}`);
    process.exit(1);
  }
  let child = null;
  if (!E2E_MANUAL) {
    child = launchApp({ appDir: APP_DIR, setupRustEnvPath: SETUP_RUST_ENV, cdpPort: CDP_PORT });
    if (!(await waitForCDP(CDP_PORT, CDP_TIMEOUT))) {
      killApp(child, CDP_PORT);
      process.exit(1);
    }
  }
  const result = playwright(
    "--project=soak e2e/soak/replay-trace.spec.ts",
    { E2E_MANUAL: "1", SOAK_TRACE: abs, SOAK_RESULTS_DIR: SOAK_RESULTS },
    1_800_000
  );
  console.log(result.output.slice(-4000));
  if (!E2E_MANUAL) killApp(child, CDP_PORT);
  process.exit(result.success ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  ensureDir(RUN_DIR);
  ensureDir(FAILURES_DIR);

  if (args["generate-corpus"] === "true") {
    generateCorpus();
    return;
  }
  if (args.replay && args.replay !== "true") {
    await replayMode(args.replay);
    return;
  }

  log(`Soak run ${RUN_ID}: mode=${MODE} budget=${BUDGET_MIN}min walks=${WALKS}x${WALK_ACTIONS} fix=${FIX_MODE}`);

  const summary = {
    runId: RUN_ID,
    mode: MODE,
    startedAt: new Date().toISOString(),
    elapsedMs: 0,
    phases: [],
    walks: [],
    findings: [],
    fixes: [],
    corpus: null,
    failuresDir: path.relative(PROJECT_ROOT, FAILURES_DIR),
  };
  const startedAt = Date.now();
  const ledger = loadLedger();
  let child = null;

  let exitCode = 0;
  try {
    // Phase 1: gate
    if (!runGate(summary)) {
      return 1;
    }

    // Phase 2: launch app
    if (!E2E_MANUAL) {
      child = launchApp({ appDir: APP_DIR, setupRustEnvPath: SETUP_RUST_ENV, cdpPort: CDP_PORT });
      if (!(await waitForCDP(CDP_PORT, CDP_TIMEOUT))) {
        summary.phases.push({ name: "launch", success: false, note: "CDP never became ready" });
        return 1;
      }
    }
    summary.phases.push({ name: "launch", success: true });

    // Phase 3: scenarios
    runScenarios(summary);

    // Phase 4: walks
    const reserveMin = FIX_MODE === "auto" ? 60 : 10;
    const allNewFailureDirs = [];
    let sinceRestart = 0;
    for (let i = 0; i < WALKS; i++) {
      if (minutesLeft() <= reserveMin) {
        log(`Walks: stopping — ${minutesLeft()} min left (reserve ${reserveMin})`);
        break;
      }
      const { newDirs, crashed } = runWalk(summary, i);
      allNewFailureDirs.push(...newDirs);
      sinceRestart++;

      if (crashed || sinceRestart >= RESTART_EVERY) {
        if (!E2E_MANUAL) {
          log(crashed ? "  Restarting app after crash-class failure" : "  Proactive app restart");
          child = await restartApp(child, { appDir: APP_DIR, setupRustEnvPath: SETUP_RUST_ENV, cdpPort: CDP_PORT }, CDP_TIMEOUT);
          if (!child) {
            summary.phases.push({ name: "walks", success: false, note: "app failed to restart" });
            break;
          }
        }
        sinceRestart = 0;
      }
    }
    summary.phases.push({ name: "walks", success: true, note: `${summary.walks.length} walk(s)` });

    // Phase 5: triage
    const triaged = triageFailures(summary, ledger, allNewFailureDirs);
    summary.phases.push({ name: "triage", success: true, note: `${triaged.length} new finding(s)` });

    // Phase 6: fix loop
    if (FIX_MODE === "auto" && triaged.length > 0) {
      child = await fixBugs(summary, ledger, triaged, child);
      summary.phases.push({ name: "fix", success: true, note: `${summary.fixes.length} attempt(s)` });
    } else {
      summary.phases.push({
        name: "fix",
        success: true,
        skipped: true,
        note: FIX_MODE === "auto" ? "no app-bug verdicts" : "triage-only mode",
      });
    }

    // Phase 7: corpus coverage note
    if (!NO_CORPUS) {
      const cov = coverage();
      summary.corpus = {
        added: 0,
        updated: 0,
        note: `${cov.covered.length} covered / ${cov.uncovered.length} uncovered behaviors`,
      };
    }

    const unresolved = summary.findings.filter(
      (f) => !["duplicate", "infrastructure"].includes(f.status)
    );
    const fixedIds = new Set(
      summary.fixes.filter((f) => f.outcome.startsWith("FIXED")).map((f) => f.bugId)
    );
    if (unresolved.some((f) => !fixedIds.has(f.bugId))) exitCode = 1;
    return exitCode;
  } finally {
    if (child && !E2E_MANUAL) killApp(child, CDP_PORT);
    summary.elapsedMs = Date.now() - startedAt;
    writeReport(RUN_DIR, summary);
    log(`Report: ${path.join(RUN_DIR, "soak-summary.md")}`);

    const failed = summary.findings.filter((f) => f.status !== "duplicate").length;
    log(
      `Soak run complete: ${summary.walks.length} walks, ${failed} new finding(s), ` +
        `${summary.fixes.filter((f) => f.outcome.startsWith("FIXED")).length} validated fix(es)`
    );
  }
}

main().then((code) => process.exit(code ?? 0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
