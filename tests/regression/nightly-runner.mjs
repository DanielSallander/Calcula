#!/usr/bin/env node
/**
 * Calcula Nightly Regression Runner
 *
 * Orchestrates all test layers (Rust, Vitest, Playwright E2E, Visual Regression)
 * into a single automated run. Supports two modes:
 *
 *   --mode=manual   (default) Run all tests, generate report, stop.
 *   --mode=auto     Run tests, feed failures to Claude Code for auto-fix,
 *                   re-run. Repeats up to --max-iterations times.
 *
 * Usage:
 *   node tests/regression/nightly-runner.mjs                          # manual mode
 *   node tests/regression/nightly-runner.mjs --mode=auto              # auto-fix mode
 *   node tests/regression/nightly-runner.mjs --mode=auto --max-iterations=3
 *   node tests/regression/nightly-runner.mjs --skip-rust              # skip cargo test
 *   node tests/regression/nightly-runner.mjs --only=visual            # only visual tests
 *   node tests/regression/nightly-runner.mjs --only=e2e               # only functional E2E
 *   node tests/regression/nightly-runner.mjs --only=unit              # only Vitest unit tests
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
const REPORT_FILE = path.join(RESULTS_DIR, "nightly-report.html");
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
const MAX_ITERATIONS = parseInt(args["max-iterations"] || "5", 10);
const SKIP_RUST = args["skip-rust"] === "true";
const ONLY = args.only || null; // "visual", "e2e", "unit", or null for all
const MAX_FILES_PER_ITERATION = parseInt(args["max-files"] || "10", 10);

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
    cwd: PROJECT_ROOT,
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

function runFunctionalE2E() {
  log("Phase 3: Functional E2E tests (yarn e2e:manual)");
  const result = exec("yarn e2e:manual 2>&1", { timeout: 600_000 });
  log(result.success ? "  [PASS] Functional E2E passed" : "  [FAIL] Functional E2E failed");
  return {
    phase: "e2e-functional",
    success: result.success,
    output: result.output,
  };
}

function runVisualRegression() {
  log("Phase 4: Visual regression tests (yarn e2e:manual:all --project=visual)");
  const result = exec(
    "cross-env E2E_MANUAL=1 yarn playwright test --project=visual 2>&1",
    { timeout: 600_000 }
  );
  log(result.success ? "  [PASS] Visual regression passed" : "  [FAIL] Visual regression failed");
  return {
    phase: "visual",
    success: result.success,
    output: result.output,
  };
}

// ---------------------------------------------------------------------------
// Failure collection for Claude Code
// ---------------------------------------------------------------------------

function collectFailures(results) {
  const failures = results.filter((r) => !r.success);
  if (failures.length === 0) return null;

  let report = "# Nightly Test Failures\n\n";

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
  const prompt = [
    "You are fixing automated test failures in the Calcula spreadsheet application.",
    "Calcula is an open-source Excel alternative (Tauri + Rust backend + React/Canvas frontend).",
    "The project is at: " + PROJECT_ROOT,
    "",
    "Here are the test failures from the nightly regression run:",
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
    timeout: 600_000, // 10 min for Claude to work
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

function commitFixes(iteration) {
  log("  Committing fixes to nightly-fixes branch...");

  // Check if there are any changes
  const status = exec("git status --porcelain", { cwd: PROJECT_ROOT });
  if (!status.output.trim()) {
    log("  No changes to commit");
    return false;
  }

  // Create/switch to nightly-fixes branch if needed
  const currentBranch = exec("git branch --show-current", { cwd: PROJECT_ROOT }).output.trim();
  if (currentBranch !== "nightly-fixes") {
    exec("git checkout -B nightly-fixes", { cwd: PROJECT_ROOT });
  }

  exec("git add -A", { cwd: PROJECT_ROOT });
  exec(
    `git commit -m "nightly: auto-fix iteration ${iteration} [${timestamp()}]"`,
    { cwd: PROJECT_ROOT }
  );

  return true;
}

// ---------------------------------------------------------------------------
// Coverage gap analysis (runs when all tests pass)
// ---------------------------------------------------------------------------

const REGISTRY_FILE = path.join(PROJECT_ROOT, "tests", "regression", "registry.json");
const SUGGESTIONS_FILE = path.join(PROJECT_ROOT, "tests", "regression", "suggested-scenarios.md");

function generateCoverageGapReport() {
  log("All green — analyzing coverage gaps...");

  if (!fs.existsSync(REGISTRY_FILE)) {
    log("  Registry not found, skipping gap analysis");
    return;
  }

  const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
  const features = registry.features;

  // Group uncovered/undercovered features by tier
  const gaps = { 1: [], 2: [], 3: [], 4: [] };
  for (const f of features) {
    if (f.coverage === "none" || f.coverage === "unit-only") {
      gaps[f.tier].push(f);
    }
  }

  const totalGaps = Object.values(gaps).flat().length;
  if (totalGaps === 0) {
    log("  No coverage gaps found!");
    return;
  }

  // Build prompt for Claude Code to suggest scenarios
  const gapSummary = Object.entries(gaps)
    .filter(([, list]) => list.length > 0)
    .map(([tier, list]) => {
      const items = list
        .map((f) => `  - **${f.name}** (${f.id}): ${f.description} [coverage: ${f.coverage}]`)
        .join("\n");
      return `### Tier ${tier}: ${registry.tiers[tier]}\n${items}`;
    })
    .join("\n\n");

  const prompt = `You are analyzing test coverage gaps for the Calcula spreadsheet application.
Calcula is an open-source Excel alternative (Tauri + Rust backend + React/Canvas frontend).

The following features have insufficient automated test coverage:

${gapSummary}

For each feature, suggest ONE concrete E2E test scenario that would provide the most
regression protection. Focus on Tier 1 and Tier 2 first — these are the highest priority.

Write your suggestions in this exact markdown format (this file will be edited by the developer):

## Suggested Test Scenarios

### [feature-id] Feature Name
**Priority:** Tier N
**Current coverage:** none/unit-only
**Suggested scenario:**
> Step-by-step description of what the test should do

**What it would catch:**
> What kinds of regressions this test would prevent

**Estimated complexity:** Simple / Medium / Complex

---

Keep scenarios practical and focused. Each should be implementable as a single Playwright
spec that takes under 30 seconds to run. Prefer scenarios that exercise multiple sub-features
of the same feature area.

Limit to the top 15 most impactful suggestions (prioritize by tier, then by how fundamental
the feature is to daily spreadsheet use).`;

  // Write prompt to temp file
  const tempFile = path.join(RESULTS_DIR, "coverage-gap-prompt.txt");
  ensureDir(RESULTS_DIR);
  fs.writeFileSync(tempFile, prompt);

  log("  Invoking Claude Code for scenario suggestions...");

  try {
    const output = execSync(
      `${CLAUDE_CMD} --print --allowedTools "Read,Grep,Glob" -p "${tempFile}"`,
      {
        cwd: PROJECT_ROOT,
        timeout: 300_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    // Write suggestions file — this is the file the developer edits
    const header = `# Suggested Test Scenarios

> Generated: ${timestamp()}
> Based on coverage gaps in tests/regression/registry.json
>
> **How to use this file:**
> 1. Review the suggestions below
> 2. Edit any scenario you want to adjust (change steps, rename, etc.)
> 3. Delete scenarios you don't want
> 4. Add \`<!-- user-edited -->\` anywhere in this file to prevent it being overwritten
>    on the next nightly run (new suggestions will go to suggested-scenarios-new.md instead)
> 5. When ready, ask Claude Code: "Implement the scenarios in suggested-scenarios.md"
>    or implement them yourself in app/e2e/tests/ or app/e2e/visual/
> 6. After implementing, update registry.json to reflect the new coverage

---

`;

    // Preserve user edits: if the file exists and has been modified by the user
    // (contains edits beyond the generated header), write to a -new file instead.
    let targetFile = SUGGESTIONS_FILE;
    if (fs.existsSync(SUGGESTIONS_FILE)) {
      const existing = fs.readFileSync(SUGGESTIONS_FILE, "utf-8");
      // Check if user has edited it (added lines not starting with > or #, or changed content)
      const hasUserEdits = existing.includes("<!-- user-edited -->");
      if (hasUserEdits) {
        targetFile = SUGGESTIONS_FILE.replace(".md", "-new.md");
        log("  Existing file has user edits, writing to suggested-scenarios-new.md");
      }
    }

    fs.writeFileSync(targetFile, header + output);
    log(`  Suggestions written to: ${targetFile}`);
    log(`  ${totalGaps} features with coverage gaps analyzed`);
  } catch (err) {
    log("  Claude Code scenario generation failed");
    const errOutput = (err.stdout?.toString() || "") + "\n" + (err.stderr?.toString() || "");
    fs.writeFileSync(path.join(RESULTS_DIR, "coverage-gap-error.txt"), errOutput);
  }
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
  <title>Calcula Nightly Regression Report</title>
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
  <h1>Calcula Nightly Regression Report</h1>
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
  log("=== Calcula Nightly Regression Runner ===");
  log(`Mode: ${MODE} | Max iterations: ${MAX_ITERATIONS}`);
  log(`Skip Rust: ${SKIP_RUST} | Only: ${ONLY || "all"}`);

  ensureDir(RESULTS_DIR);

  // In auto mode, create the nightly-fixes branch from current HEAD
  if (MODE === "auto") {
    const currentBranch = exec("git branch --show-current", { cwd: PROJECT_ROOT }).output.trim();
    log(`Current branch: ${currentBranch}`);
    // Save the original branch so we can note it in the report
    fs.writeFileSync(path.join(RESULTS_DIR, "original-branch.txt"), currentBranch);
    exec("git checkout -B nightly-fixes", { cwd: PROJECT_ROOT });
    log("Created nightly-fixes branch");
  }

  const allIterations = [];

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

    // Phase 3: Functional E2E (requires running app)
    if (!ONLY || ONLY === "e2e" || ONLY === "all-e2e") {
      results.push(runFunctionalE2E());
    }

    // Phase 4: Visual regression (requires running app)
    if (!ONLY || ONLY === "visual" || ONLY === "all-e2e") {
      results.push(runVisualRegression());
    }

    const iterationData = { iteration, results, claudeResponse: null };

    // Check results
    const allPassed = results.every((r) => r.success);

    if (allPassed) {
      log("\n[OK] All tests passed!");
      allIterations.push(iterationData);
      // When green, analyze coverage gaps and suggest new scenarios
      generateCoverageGapReport();
      break;
    }

    // Failures detected
    const failCount = results.filter((r) => !r.success).length;
    log(`\n${failCount} phase(s) failed`);

    if (MODE === "auto" && iteration < MAX_ITERATIONS) {
      // Collect failures and feed to Claude Code
      const failureReport = collectFailures(results);
      if (failureReport) {
        const fixApplied = invokeClaudeCodeFix(failureReport, iteration);
        if (fixApplied) {
          const committed = commitFixes(iteration);
          if (committed) {
            // Read Claude's response for the report
            const responseFile = path.join(RESULTS_DIR, `claude-response-iter${iteration}.md`);
            if (fs.existsSync(responseFile)) {
              iterationData.claudeResponse = fs.readFileSync(responseFile, "utf-8");
            }
          }
        }
      }
    } else if (MODE === "manual" || iteration >= MAX_ITERATIONS) {
      allIterations.push(iterationData);
      break;
    }

    allIterations.push(iterationData);
  }

  // Switch back to original branch if in auto mode
  if (MODE === "auto") {
    const origBranchFile = path.join(RESULTS_DIR, "original-branch.txt");
    if (fs.existsSync(origBranchFile)) {
      const origBranch = fs.readFileSync(origBranchFile, "utf-8").trim();
      log(`Switching back to original branch: ${origBranch}`);
      exec(`git checkout ${origBranch}`, { cwd: PROJECT_ROOT });
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
