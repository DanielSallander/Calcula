#!/usr/bin/env node
/**
 * Calcula Regression Runner
 *
 * Orchestrates all test layers (Rust, Vitest, Playwright E2E, Visual Regression)
 * into a single automated run. Supports two modes:
 *
 *   --mode=manual   (default) Run all tests, generate report, stop.
 *   --mode=auto     Run tests, feed failures to Claude Code for auto-fix,
 *                   re-run. Repeats up to --max-iterations times.
 *
 * Usage:
 *   node tests/regression/regression-runner.mjs                          # manual mode
 *   node tests/regression/regression-runner.mjs --mode=auto              # auto-fix mode
 *   node tests/regression/regression-runner.mjs --mode=auto --max-iterations=3
 *   node tests/regression/regression-runner.mjs --skip-rust              # skip cargo test
 *   node tests/regression/regression-runner.mjs --only=visual            # only visual tests
 *   node tests/regression/regression-runner.mjs --only=e2e               # only functional E2E
 *   node tests/regression/regression-runner.mjs --only=unit              # only Vitest unit tests
 *
 * Environment:
 *   CLAUDE_CMD    - Path to Claude Code CLI (default: "claude")
 *   CDP_PORT      - WebView2 CDP port (default: 9222)
 */

import { execSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const APP_DIR = path.join(PROJECT_ROOT, "app");
const RESULTS_DIR = path.join(APP_DIR, "e2e", "results");
const REPORT_FILE = path.join(RESULTS_DIR, "regression-report.html");
const CLAUDE_CMD = process.env.CLAUDE_CMD || "claude";

// ---------------------------------------------------------------------------
// Parse CLI arguments
// ---------------------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);

const MODE = args.mode || "manual";
const MAX_ITERATIONS = parseInt(args["max-iterations"] || "15", 10);
const SKIP_RUST = args["skip-rust"] === "true";
const ONLY = args.only || null; // "visual", "e2e", "unit", or null for all
const MAX_FILES_PER_ITERATION = parseInt(args["max-files"] || "10", 10);
const E2E_MANUAL = args["e2e-manual"] === "true"; // use already-running app for E2E
const EXPAND_COVERAGE = args["expand"] !== "false"; // auto-create new scenarios when green (default: true)
const EXPAND_ITERATIONS = parseInt(args["expand-iterations"] || "5", 10);

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function timestamp() {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z/, "");
}

function log(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

function exec(cmd, options = {}) {
  const opts = {
    cwd: APP_DIR,
    stdio: "pipe",
    timeout: 600_000, // 10 min default
    encoding: "utf-8",
    ...options,
  };
  try {
    const result = execSync(cmd, opts);
    return { success: true, output: result?.toString() || "", code: 0 };
  } catch (err) {
    return {
      success: false,
      output: (err.stdout?.toString() || "") + "\n" + (err.stderr?.toString() || ""),
      code: err.status || 1,
    };
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Test phase runners
// ---------------------------------------------------------------------------

function runRustTests() {
  log("Phase 1: Rust backend tests (cargo test)");
  const result = exec("cargo test --workspace 2>&1", {
    cwd: path.join(PROJECT_ROOT, "core"),
    timeout: 300_000, // 5 min
  });
  log(result.success ? "  [PASS] Rust tests passed" : "  [FAIL] Rust tests failed");
  return {
    phase: "rust",
    success: result.success,
    output: result.output,
    duration: 0, // We don't track this precisely here
  };
}

function runUnitTests() {
  log("Phase 2: Vitest unit tests (yarn test)");
  const result = exec("yarn test 2>&1", { timeout: 300_000 });
  log(result.success ? "  [PASS] Unit tests passed" : "  [FAIL] Unit tests failed");
  return {
    phase: "unit",
    success: result.success,
    output: result.output,
  };
}

// E2E timeout: 30 min — app startup (~5 min) + 338+ tests (~15 min) + buffer
const E2E_TIMEOUT = 1_800_000;

/**
 * Pre-build the Rust backend so that `cargo tauri dev` starts fast.
 * Without this, each E2E iteration waits for a full Rust compile.
 */
function preBuildRust() {
  log("  Pre-building Rust backend (cargo build)...");
  const result = exec("cargo build 2>&1", {
    cwd: path.join(APP_DIR, "src-tauri"),
    timeout: 600_000, // 10 min for build
  });
  if (result.success) {
    log("  Rust build cache warm");
  } else {
    log("  Rust pre-build failed (E2E may still work if already built)");
  }
  return result.success;
}

/** Build the E2E command with optional manual mode (skip app launch) */
function e2eCmd(extraArgs = "") {
  const manual = E2E_MANUAL ? "cross-env E2E_MANUAL=1 " : "";
  return `${manual}yarn playwright test ${extraArgs} 2>&1`;
}

function runFunctionalE2E() {
  log(`Phase 3: Functional E2E tests${E2E_MANUAL ? " (manual — using running app)" : ""}`);
  const result = exec(e2eCmd("--project=functional"), { timeout: E2E_TIMEOUT });
  log(result.success ? "  [PASS] Functional E2E passed" : "  [FAIL] Functional E2E failed");
  return {
    phase: "e2e-functional",
    success: result.success,
    output: result.output,
  };
}

function runVisualRegression() {
  log(`Phase 4: Visual regression tests${E2E_MANUAL ? " (manual — using running app)" : ""}`);
  const result = exec(e2eCmd("--project=visual"), { timeout: E2E_TIMEOUT });
  log(result.success ? "  [PASS] Visual regression passed" : "  [FAIL] Visual regression failed");
  return {
    phase: "visual",
    success: result.success,
    output: result.output,
  };
}

/**
 * Run all E2E tests (functional + visual) in a single Playwright run.
 */
function runAllE2E() {
  log(`Phase 3+4: All E2E tests${E2E_MANUAL ? " (manual — using running app)" : ""}`);
  const result = exec(e2eCmd(""), { timeout: E2E_TIMEOUT });
  log(result.success ? "  [PASS] All E2E passed" : "  [FAIL] E2E tests failed");
  return {
    phase: "e2e-all",
    success: result.success,
    output: result.output,
  };
}

// ---------------------------------------------------------------------------
// Failure collection for Claude Code
// ---------------------------------------------------------------------------

/**
 * Check if a failure is an infrastructure/timeout issue rather than a code bug.
 * These shouldn't be sent to Claude Code since they can't be fixed in application code.
 */
function isInfrastructureFailure(result) {
  const output = result.output || "";
  // Only match specific global-setup/teardown failures, not general test output.
  // Check if tests actually ran by looking for test result counts.
  const hasTestResults = /\d+ passed/.test(output) || /\d+ failed/.test(output);
  if (hasTestResults) return false; // tests ran — real failures, not infrastructure

  return (
    output.includes("did not become ready within") ||
    output.includes("CDP on port") ||
    output.includes("ETIMEDOUT") ||
    (result.code === null && output.includes("killed")) // process killed by timeout
  );
}

function collectFailures(results) {
  const failures = results.filter((r) => !r.success);
  if (failures.length === 0) return null;

  // Check if all failures are infrastructure issues
  const infraFailures = failures.filter(isInfrastructureFailure);
  if (infraFailures.length === failures.length) {
    log("  All failures are infrastructure/timeout issues — skipping Claude Code");
    for (const f of infraFailures) {
      log(`    ${f.phase}: infrastructure failure (app didn't start in time)`);
    }
    return null;
  }

  let report = "# Regression Test Failures\n\n";

  for (const f of failures) {
    report += `## Phase: ${f.phase}\n\n`;

    // Extract just the failure lines (not the full output which can be huge)
    const lines = f.output.split("\n");
    const failureLines = lines.filter(
      (l) =>
        l.includes("FAIL") ||
        l.includes("Error") ||
        l.includes("error[") ||
        l.includes("FAILED") ||
        l.includes("Expected") ||
        l.includes("Received") ||
        l.includes("screenshot") ||
        l.includes("diff") ||
        l.includes("AssertionError") ||
        l.includes("timeout") ||
        l.includes("panicked")
    );

    if (failureLines.length > 0) {
      report += "```\n" + failureLines.slice(0, 100).join("\n") + "\n```\n\n";
    } else {
      // If we couldn't extract specific failures, include last 50 lines
      report += "```\n" + lines.slice(-50).join("\n") + "\n```\n\n";
    }
  }

  // Check for screenshot diffs
  const diffDir = path.join(APP_DIR, "test-results");
  if (fs.existsSync(diffDir)) {
    const diffs = findFiles(diffDir, "-diff.png");
    if (diffs.length > 0) {
      report += "## Screenshot Diffs\n\n";
      report += "The following visual regression screenshots failed:\n\n";
      for (const d of diffs) {
        const relPath = path.relative(APP_DIR, d);
        report += `- ${relPath}\n`;
        // Find corresponding expected and actual
        const expected = d.replace("-diff.png", "-expected.png");
        const actual = d.replace("-diff.png", "-actual.png");
        if (fs.existsSync(expected)) report += `  Expected: ${path.relative(APP_DIR, expected)}\n`;
        if (fs.existsSync(actual)) report += `  Actual: ${path.relative(APP_DIR, actual)}\n`;
      }
      report += "\n";
    }
  }

  return report;
}

function findFiles(dir, suffix) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(fullPath, suffix));
    } else if (entry.name.endsWith(suffix)) {
      results.push(fullPath);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Claude Code auto-fix
// ---------------------------------------------------------------------------

function invokeClaudeCodeFix(failureReport, iteration) {
  log(`  Invoking Claude Code for auto-fix (iteration ${iteration})...`);

  const promptFile = path.join(RESULTS_DIR, `claude-prompt-iter${iteration}.md`);
  fs.writeFileSync(promptFile, failureReport);

  // Build the prompt for Claude Code
  let prompt = [
    "You are fixing automated test failures in the Calcula spreadsheet application.",
    "Calcula is an open-source Excel alternative (Tauri + Rust backend + React/Canvas frontend).",
    "The project is at: " + PROJECT_ROOT,
    "",
    "Here are the test failures from the regression run:",
    "",
    failureReport,
    "",
    "If screenshot diff images are attached, review them carefully:",
    "- The EXPECTED image shows what the app should look like (golden baseline)",
    "- The ACTUAL image shows what the app currently produces",
    "- The DIFF image highlights the pixel differences",
    "Use your visual understanding to determine what went wrong in the rendering.",
    "",
    "Instructions:",
    "1. Analyze each failure to determine the root cause",
    "2. Fix the code (NOT the tests) unless the test itself is clearly wrong",
    "3. Only modify files that are directly related to the failures",
    "4. Do not modify more than " + MAX_FILES_PER_ITERATION + " files",
    "5. Do not add new features or refactor unrelated code",
    "6. After fixing, briefly explain what you changed and why",
  ].join("\n");

  // Include screenshot diff images as Read instructions in the prompt
  const diffImages = findFiles(path.join(APP_DIR, "test-results"), "-diff.png");
  if (diffImages.length > 0) {
    prompt += "\n\nScreenshot diff images to review (use the Read tool to view these PNGs):\n";
    for (const img of diffImages.slice(0, 5)) {
      prompt += `- ${img}\n`;
      const expected = img.replace("-diff.png", "-expected.png");
      const actual = img.replace("-diff.png", "-actual.png");
      if (fs.existsSync(expected)) prompt += `  Expected: ${expected}\n`;
      if (fs.existsSync(actual)) prompt += `  Actual: ${actual}\n`;
    }
  }

  // Write prompt to temp file to avoid shell escaping issues
  const tempPromptFile = path.join(RESULTS_DIR, `claude-prompt-iter${iteration}.txt`);
  fs.writeFileSync(tempPromptFile, prompt);

  const claudeCmd = `${CLAUDE_CMD} --print --allowedTools "Edit,Read,Grep,Glob,Bash" -p "${tempPromptFile}"`;

  const result = exec(claudeCmd, {
    cwd: PROJECT_ROOT,
    timeout: 1_800_000, // 30 min for Claude to work
  });

  if (result.success) {
    log("  Claude Code completed fixes");
    // Save Claude's response
    fs.writeFileSync(
      path.join(RESULTS_DIR, `claude-response-iter${iteration}.md`),
      result.output
    );
  } else {
    log("  Claude Code invocation failed or timed out");
    fs.writeFileSync(
      path.join(RESULTS_DIR, `claude-error-iter${iteration}.txt`),
      result.output
    );
  }

  return result.success;
}

function checkForChanges(iteration) {
  // Check if Claude Code made any changes
  const status = exec("git status --porcelain", { cwd: PROJECT_ROOT });
  if (!status.output.trim()) {
    log("  No changes made");
    return false;
  }

  // Log what was changed but do NOT commit — leave as uncommitted working changes
  // for the user to review and commit themselves.
  const changedFiles = status.output.trim().split("\n").map((l) => l.trim());
  log(`  Claude Code modified ${changedFiles.length} file(s):`);
  for (const f of changedFiles) {
    log(`    ${f}`);
  }

  return true;
}

// ---------------------------------------------------------------------------
// Coverage gap analysis (runs when all tests pass)
// ---------------------------------------------------------------------------

const REGISTRY_FILE = path.join(PROJECT_ROOT, "tests", "regression", "registry.json");
const SUGGESTIONS_FILE = path.join(PROJECT_ROOT, "tests", "regression", "suggested-scenarios.md");

/**
 * Get coverage gaps from the registry.
 */
function getCoverageGaps() {
  if (!fs.existsSync(REGISTRY_FILE)) return { gaps: {}, total: 0 };
  const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
  const gaps = { 1: [], 2: [], 3: [], 4: [] };
  for (const f of registry.features) {
    if (f.coverage === "none" || f.coverage === "unit-only") {
      gaps[f.tier].push(f);
    }
  }
  return { gaps, total: Object.values(gaps).flat().length, registry };
}

/**
 * Build a gap summary string for prompts.
 */
function buildGapSummary(gaps, registry) {
  return Object.entries(gaps)
    .filter(([, list]) => list.length > 0)
    .map(([tier, list]) => {
      const items = list
        .map((f) => `  - **${f.name}** (${f.id}): ${f.description} [coverage: ${f.coverage}]`)
        .join("\n");
      return `### Tier ${tier}: ${registry.tiers[tier]}\n${items}`;
    })
    .join("\n\n");
}

/**
 * Coverage expansion phase: when all tests pass, auto-create new test scenarios.
 *
 * Runs up to EXPAND_ITERATIONS loops:
 *   1. Pick the highest-priority uncovered features
 *   2. Ask Claude Code to IMPLEMENT test specs (not just suggest)
 *   3. Run the new tests
 *   4. If they pass, update registry.json and loop
 *   5. If they fail, ask Claude Code to fix, then re-run
 *
 * Also writes a summary to suggested-scenarios.md for tracking.
 */
function expandCoverage() {
  log("\n=== Coverage Expansion Phase ===");

  const { gaps, total, registry } = getCoverageGaps();
  if (total === 0) {
    log("  No coverage gaps — full coverage achieved!");
    return;
  }

  log(`  ${total} features with coverage gaps`);
  const gapSummary = buildGapSummary(gaps, registry);

  const scenarioLog = []; // track what was created

  for (let expandIter = 1; expandIter <= EXPAND_ITERATIONS; expandIter++) {
    log(`\n--- Expansion iteration ${expandIter} of ${EXPAND_ITERATIONS} ---`);

    // Re-read gaps (registry may have been updated)
    const current = getCoverageGaps();
    if (current.total === 0) {
      log("  All gaps covered!");
      break;
    }

    const currentSummary = buildGapSummary(current.gaps, current.registry);

    // Collect existing test file names to tell Claude what already exists
    const existingTests = exec("ls app/e2e/tests/*.spec.ts app/e2e/visual/*.spec.ts 2>/dev/null", {
      cwd: PROJECT_ROOT,
    }).output.trim().split("\n").filter(Boolean).map((f) => f.trim());

    const existingTestList = existingTests.map((f) => `  - ${path.basename(f)}`).join("\n");

    // Ask Claude Code to implement 3 test scenarios
    const prompt = `You are expanding test coverage for the Calcula spreadsheet application.
Calcula is an open-source Excel alternative (Tauri + Rust backend + React/Canvas frontend).
The project is at: ${PROJECT_ROOT}

## Existing Test Coverage

These E2E test specs ALREADY EXIST — do NOT recreate or duplicate their coverage:

${existingTestList}

BEFORE creating any new test, you MUST:
1. Read tests/regression/registry.json to see what features are already covered
2. Read the existing spec files listed above to understand what scenarios they test
3. Only create tests for features/scenarios that are NOT already covered

## Coverage Gaps

The following features need E2E test coverage:

${currentSummary}

## Your Task

Implement exactly 3 new E2E Playwright test specs for the highest-priority
uncovered features (Tier 1 first, then Tier 2, then Tier 3).

Each spec MUST test something genuinely new — a feature or use case not exercised
by any existing spec. Do not create a "tables.spec.ts" if table testing is already
partially covered in another spec. Instead, focus on the specific untested aspects.

## Implementation Rules

1. Create new test files in app/e2e/tests/ following the existing patterns
2. Import fixtures from "../fixtures" (NOT from "@playwright/test")
3. Use the GridHelper methods from "../helpers/grid" (see app/e2e/helpers/grid.ts)
4. Each test file should have 2-5 focused test cases
5. Tests must work against an already-running Calcula instance (CDP on port 9222)
6. After creating the test files, update tests/regression/registry.json:
   - Set coverage to "partial" for features you covered
   - Add the new test file paths to the e2eTests arrays
7. Keep tests practical — avoid testing features that require complex setup
   that the GridHelper doesn't support yet
8. Do NOT modify existing test files — only create new ones and update registry.json`;

    const tempFile = path.join(RESULTS_DIR, `expand-prompt-iter${expandIter}.txt`);
    ensureDir(RESULTS_DIR);
    fs.writeFileSync(tempFile, prompt);

    log("  Asking Claude Code to implement new test scenarios...");

    const result = exec(
      `${CLAUDE_CMD} --print --allowedTools "Edit,Read,Grep,Glob,Bash,Write" -p "${tempFile}"`,
      { cwd: PROJECT_ROOT, timeout: 1_800_000 }
    );

    if (!result.success) {
      log("  Claude Code failed to create scenarios");
      fs.writeFileSync(path.join(RESULTS_DIR, `expand-error-iter${expandIter}.txt`), result.output);
      break;
    }

    fs.writeFileSync(path.join(RESULTS_DIR, `expand-response-iter${expandIter}.md`), result.output);

    // Check if files were actually created
    const status = exec("git status --porcelain", { cwd: PROJECT_ROOT });
    const newFiles = status.output.split("\n").filter((l) => l.startsWith("??") || l.startsWith(" A") || l.startsWith("A "));
    const modifiedFiles = status.output.split("\n").filter((l) => l.trim().startsWith("M "));

    if (newFiles.length === 0 && modifiedFiles.length === 0) {
      log("  No new files created — stopping expansion");
      break;
    }

    log(`  Created/modified ${newFiles.length + modifiedFiles.length} file(s)`);
    for (const f of [...newFiles, ...modifiedFiles].slice(0, 10)) {
      log(`    ${f.trim()}`);
    }

    // Run the E2E tests to verify the new scenarios work
    log("  Running E2E tests to verify new scenarios...");
    const e2eResult = exec(e2eCmd(""), { timeout: E2E_TIMEOUT });

    if (e2eResult.success) {
      log("  [PASS] New scenarios pass!");

      // Track what was created
      const createdSpecs = newFiles
        .map((l) => l.trim().replace(/^\?\?\s*/, ""))
        .filter((f) => f.endsWith(".spec.ts"));
      scenarioLog.push({
        iteration: expandIter,
        specs: createdSpecs,
        status: "pass",
      });
    } else {
      log("  [FAIL] New scenarios have failures — asking Claude Code to fix...");

      // One fix attempt for the new tests
      const failureReport = collectFailures([{
        phase: "e2e-expansion",
        success: false,
        output: e2eResult.output,
      }]);

      if (failureReport) {
        invokeClaudeCodeFix(failureReport, `expand-${expandIter}`);

        // Re-run to verify fix
        log("  Re-running E2E after fix...");
        const retryResult = exec(e2eCmd(""), { timeout: E2E_TIMEOUT });
        if (retryResult.success) {
          log("  [PASS] Fixed — new scenarios pass!");
          scenarioLog.push({ iteration: expandIter, specs: [], status: "pass-after-fix" });
        } else {
          log("  [FAIL] Still failing — stopping expansion to avoid breaking the suite");
          scenarioLog.push({ iteration: expandIter, specs: [], status: "fail" });
          break;
        }
      } else {
        scenarioLog.push({ iteration: expandIter, specs: [], status: "infra-fail" });
        break;
      }
    }
  }

  // Write expansion summary
  const summary = `# Coverage Expansion Summary

> Generated: ${timestamp()}
> Expansion iterations: ${scenarioLog.length} of ${EXPAND_ITERATIONS}

## Scenarios Created

${scenarioLog.map((s) => `- **Iteration ${s.iteration}:** ${s.status}${s.specs.length ? "\n  " + s.specs.join("\n  ") : ""}`).join("\n")}

## Remaining Gaps

${(() => { const c = getCoverageGaps(); return `${c.total} features still need coverage.`; })()}

Check \`tests/regression/registry.json\` for the full coverage matrix.
`;

  fs.writeFileSync(SUGGESTIONS_FILE, summary);
  log(`  Expansion summary written to: ${SUGGESTIONS_FILE}`);
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function generateReport(allIterations) {
  log("Generating HTML report...");

  const totalPhases = allIterations.flatMap((i) => i.results).length;
  const totalPassed = allIterations.flatMap((i) => i.results).filter((r) => r.success).length;
  const totalFailed = totalPhases - totalPassed;
  const finalIteration = allIterations[allIterations.length - 1];
  const allGreen = finalIteration.results.every((r) => r.success);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Calcula Regression Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 2em; background: #f5f5f5; }
    h1 { color: #333; }
    .summary { display: flex; gap: 1em; margin: 1em 0; }
    .card { background: white; border-radius: 8px; padding: 1em 1.5em; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .card h3 { margin-top: 0; }
    .pass { color: #22863a; }
    .fail { color: #cb2431; }
    .big-number { font-size: 2em; font-weight: bold; }
    .iteration { background: white; border-radius: 8px; padding: 1.5em; margin: 1em 0; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .phase { border-left: 4px solid #ddd; padding: 0.5em 1em; margin: 0.5em 0; }
    .phase.passed { border-left-color: #22863a; }
    .phase.failed { border-left-color: #cb2431; }
    pre { background: #1e1e1e; color: #d4d4d4; padding: 1em; border-radius: 4px; overflow-x: auto; font-size: 0.85em; max-height: 400px; overflow-y: auto; }
    .status-badge { display: inline-block; padding: 0.2em 0.6em; border-radius: 4px; font-weight: bold; font-size: 0.9em; }
    .status-badge.pass { background: #dcffe4; }
    .status-badge.fail { background: #ffeef0; }
    details { margin: 0.5em 0; }
    summary { cursor: pointer; font-weight: bold; }
    .meta { color: #666; font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>Calcula Regression Report</h1>
  <p class="meta">Generated: ${timestamp()} | Mode: ${MODE} | Iterations: ${allIterations.length}</p>

  <div class="summary">
    <div class="card">
      <h3>Status</h3>
      <div class="big-number ${allGreen ? "pass" : "fail"}">${allGreen ? "ALL PASS" : "FAILURES"}</div>
    </div>
    <div class="card">
      <h3>Phases Run</h3>
      <div class="big-number">${totalPhases}</div>
    </div>
    <div class="card">
      <h3>Passed</h3>
      <div class="big-number pass">${totalPassed}</div>
    </div>
    <div class="card">
      <h3>Failed</h3>
      <div class="big-number ${totalFailed > 0 ? "fail" : ""}">${totalFailed}</div>
    </div>
  </div>

  ${allGreen && fs.existsSync(SUGGESTIONS_FILE) ? `
  <div class="card" style="margin: 1em 0; background: #f0f7ff;">
    <h3>Coverage Gap Analysis</h3>
    <p>All tests passed. New test scenarios have been suggested.</p>
    <p>Edit and review: <code>tests/regression/suggested-scenarios.md</code></p>
  </div>` : ""}

  ${allIterations
    .map(
      (iter, idx) => `
  <div class="iteration">
    <h2>Iteration ${idx + 1}</h2>
    ${iter.results
      .map(
        (r) => `
    <div class="phase ${r.success ? "passed" : "failed"}">
      <span class="status-badge ${r.success ? "pass" : "fail"}">${r.success ? "PASS" : "FAIL"}</span>
      <strong>${r.phase}</strong>
      ${
        !r.success
          ? `<details><summary>Show output</summary><pre>${escapeHtml(r.output.slice(-5000))}</pre></details>`
          : ""
      }
    </div>`
      )
      .join("")}
    ${
      iter.claudeResponse
        ? `<details><summary>Claude Code fixes (iteration ${idx + 1})</summary><pre>${escapeHtml(iter.claudeResponse)}</pre></details>`
        : ""
    }
  </div>`
    )
    .join("")}
</body>
</html>`;

  ensureDir(RESULTS_DIR);
  fs.writeFileSync(REPORT_FILE, html);
  log(`Report written to: ${REPORT_FILE}`);
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

async function main() {
  log("=== Calcula Regression Runner ===");
  log(`Mode: ${MODE} | Max iterations: ${MAX_ITERATIONS}`);
  log(`Skip Rust: ${SKIP_RUST} | Only: ${ONLY || "all"} | E2E manual: ${E2E_MANUAL}`);

  ensureDir(RESULTS_DIR);

  if (MODE === "auto") {
    const currentBranch = exec("git branch --show-current", { cwd: PROJECT_ROOT }).output.trim();
    log(`Current branch: ${currentBranch}`);
    log("Auto mode: fixes will be left as uncommitted changes for you to review");
  }

  const allIterations = [];
  let noChangeCount = 0;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    log(`\n--- Iteration ${iteration} of ${MAX_ITERATIONS} ---`);

    const results = [];

    // Phase 1: Rust tests
    if (!SKIP_RUST && (!ONLY || ONLY === "rust")) {
      results.push(runRustTests());
    }

    // Phase 2: Vitest unit tests
    if (!ONLY || ONLY === "unit") {
      results.push(runUnitTests());
    }

    // Phase 3+4: E2E tests (Playwright launches/kills the app automatically)
    if (!ONLY) {
      // Pre-build Rust so cargo tauri dev starts fast (skip in manual mode)
      if (!E2E_MANUAL) preBuildRust();
      // Run all E2E in one Playwright run (single app launch)
      results.push(runAllE2E());
    } else if (ONLY === "e2e") {
      results.push(runFunctionalE2E());
    } else if (ONLY === "visual") {
      results.push(runVisualRegression());
    }

    const iterationData = { iteration, results, claudeResponse: null };

    // Check results
    const allPassed = results.every((r) => r.success);

    if (allPassed) {
      log("\n[OK] All tests passed!");
      allIterations.push(iterationData);
      // When green and in auto mode, expand coverage with new scenarios
      if (MODE === "auto" && EXPAND_COVERAGE) {
        expandCoverage();
      } else {
        // Manual mode — just report the gaps
        const { total } = getCoverageGaps();
        if (total > 0) {
          log(`  ${total} features still need coverage (run with --mode=auto to auto-expand)`);
        }
      }
      break;
    }

    // Failures detected
    const failCount = results.filter((r) => !r.success).length;
    log(`\n${failCount} phase(s) failed`);

    if (MODE === "auto" && iteration < MAX_ITERATIONS) {
      // Collect failures and feed to Claude Code
      const failureReport = collectFailures(results);
      if (!failureReport) {
        // All failures are infrastructure issues — no point retrying with Claude
        log("  Stopping: failures are infrastructure issues, not fixable by code changes");
        allIterations.push(iterationData);
        break;
      }

      const fixApplied = invokeClaudeCodeFix(failureReport, iteration);
      if (fixApplied) {
        const hasChanges = checkForChanges(iteration);
        if (hasChanges) {
          // Read Claude's response for the report
          const responseFile = path.join(RESULTS_DIR, `claude-response-iter${iteration}.md`);
          if (fs.existsSync(responseFile)) {
            iterationData.claudeResponse = fs.readFileSync(responseFile, "utf-8");
          }
          noChangeCount = 0;
        } else {
          noChangeCount++;
          if (noChangeCount >= 3) {
            log("  Stopping: 3 consecutive iterations with no code changes");
            allIterations.push(iterationData);
            break;
          }
        }
      }
    } else if (MODE === "manual" || iteration >= MAX_ITERATIONS) {
      allIterations.push(iterationData);
      break;
    }

    allIterations.push(iterationData);
  }

  // In auto mode, remind the user about uncommitted changes
  if (MODE === "auto") {
    const status = exec("git status --porcelain", { cwd: PROJECT_ROOT });
    if (status.output.trim()) {
      log("\nAuto-fix changes are left as uncommitted modifications.");
      log("Review them in VSCode Source Control, then commit or discard.");
    }
  }

  // Generate report
  generateReport(allIterations);

  // Exit with appropriate code
  const finalResults = allIterations[allIterations.length - 1].results;
  const exitCode = finalResults.every((r) => r.success) ? 0 : 1;
  log(`\nDone. Exit code: ${exitCode}`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
