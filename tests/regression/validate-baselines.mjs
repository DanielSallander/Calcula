#!/usr/bin/env node
/**
 * Baseline Screenshot Validator
 *
 * After generating golden baseline screenshots, this script feeds them to
 * Claude Code for visual review. Claude Code judges whether each screenshot
 * looks correct for a spreadsheet application and can flag issues or
 * request regeneration after fixes.
 *
 * Usage:
 *   node tests/regression/validate-baselines.mjs              # review all baselines
 *   node tests/regression/validate-baselines.mjs --auto-fix   # review + fix + regenerate
 *   node tests/regression/validate-baselines.mjs --dir=path   # review specific directory
 *
 * This is automatically called during baseline generation (yarn e2e:visual:baseline)
 * but can also be run standalone.
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const APP_DIR = path.join(PROJECT_ROOT, "app");
const VISUAL_DIR = path.join(APP_DIR, "e2e", "visual");
const RESULTS_DIR = path.join(APP_DIR, "e2e", "results");
const CLAUDE_CMD = process.env.CLAUDE_CMD || "claude";

// Parse CLI args
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);

const AUTO_FIX = args["auto-fix"] === "true";
const SEARCH_DIR = args.dir || VISUAL_DIR;
const MAX_FIX_ITERATIONS = parseInt(args["max-iterations"] || "3", 10);

function timestamp() {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z/, "");
}

function log(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Recursively find all PNG files in a directory.
 */
function findScreenshots(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findScreenshots(fullPath));
    } else if (entry.name.endsWith(".png")) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Group screenshots by their parent test file for context.
 */
function groupByTestFile(screenshots) {
  const groups = {};
  for (const s of screenshots) {
    // Path structure: __screenshots__/<testFileName>/<screenshotName>.png
    const parts = s.split(path.sep);
    const screenshotsIdx = parts.findIndex((p) => p === "__screenshots__");
    const testFile = screenshotsIdx >= 0 ? parts[screenshotsIdx + 1] : "unknown";
    if (!groups[testFile]) groups[testFile] = [];
    groups[testFile].push(s);
  }
  return groups;
}

/**
 * Build the prompt for Claude Code to review screenshots.
 */
function buildReviewPrompt(screenshotGroups, mode) {
  const screenshotList = Object.entries(screenshotGroups)
    .map(([testFile, files]) => {
      const fileList = files
        .map((f) => `  - ${path.relative(APP_DIR, f)}`)
        .join("\n");
      return `### ${testFile}\n${fileList}`;
    })
    .join("\n\n");

  return `You are reviewing golden baseline screenshots for the Calcula spreadsheet application.

Calcula is an open-source Excel alternative built with Tauri (Rust backend + React/Canvas frontend).
These screenshots serve as the visual "ground truth" for regression testing. Every future test run
will compare against these baselines, so they must represent a correctly functioning application.

## What to look for

Review each screenshot and judge whether it looks correct. Specifically check:

1. **Grid rendering**: Grid lines should be visible and evenly spaced. Row/column headers should
   be present on the left and top. Cell content should be readable and properly aligned.

2. **Text rendering**: Text should not be cut off, overlapping, or misaligned. Font sizes should
   be consistent. Bold/italic/underline should be visually distinguishable.

3. **UI chrome**: The ribbon/toolbar should look complete (no missing buttons, no broken layout).
   Menus should display properly when open. The status bar should be visible at the bottom.

4. **Formatting**: Number formats, colors, and borders should render correctly on the canvas.
   Formatted cells should be visually distinct from unformatted ones.

5. **Selection**: The active cell highlight should be visible. Range selections should show
   a highlighted area.

6. **General appearance**: The application should look like a professional spreadsheet application.
   No obvious rendering glitches, missing elements, or layout breakage.

## Screenshots to review

${screenshotList}

## Instructions

For each screenshot, provide one of these verdicts:
- **PASS** - Looks correct, suitable as a golden baseline
- **CONCERN** - Something looks slightly off but might be acceptable. Explain what.
- **FAIL** - Something is clearly wrong. Explain what needs to be fixed.

${mode === "auto-fix" ? `
## Auto-fix mode

For any screenshot marked FAIL:
1. Identify the likely root cause in the source code
2. Fix the issue
3. After fixing, I will regenerate the screenshots

Do NOT modify the test files or screenshot infrastructure - only fix the application source code
that causes the visual issue.
` : `
Report your findings. Do not modify any files.
`}

Format your response as:

## Review Results

### <screenshot-name>.png
**Verdict:** PASS/CONCERN/FAIL
**Notes:** <explanation if not PASS>

Provide a summary at the end with counts of PASS/CONCERN/FAIL.`;
}

/**
 * Invoke Claude Code to review the screenshots.
 */
function invokeClaudeReview(screenshotGroups, mode) {
  const prompt = buildReviewPrompt(screenshotGroups, mode);
  const promptFile = path.join(RESULTS_DIR, "baseline-review-prompt.md");
  ensureDir(RESULTS_DIR);
  fs.writeFileSync(promptFile, prompt);

  const allScreenshots = Object.values(screenshotGroups).flat();

  const allowedTools = mode === "auto-fix"
    ? '"Edit,Read,Grep,Glob,Bash"'
    : '"Read,Grep,Glob"';

  // Build the full prompt with explicit instructions to read each screenshot file.
  // Claude Code's Read tool can view image files natively.
  const screenshotReadInstructions = allScreenshots
    .map((f) => `- ${f}`)
    .join("\n");

  const fullPrompt = [
    "IMPORTANT: Do NOT ask questions. Perform the full review immediately.",
    "You MUST use the Read tool to open and view each PNG screenshot file listed below.",
    "After viewing ALL screenshots, provide your verdict for each one.",
    "",
    prompt,
    "",
    "## Screenshot Files To Read",
    "",
    "Read each of these PNG image files using the Read tool, then provide your verdict:",
    "",
    screenshotReadInstructions,
    "",
    "START NOW: Read the first screenshot file and begin your review.",
  ].join("\n");

  // Write prompt to a temp file to avoid shell escaping issues
  const tempPromptFile = path.join(RESULTS_DIR, "baseline-review-input.txt");
  fs.writeFileSync(tempPromptFile, fullPrompt);

  const cmd = `${CLAUDE_CMD} --print --allowedTools ${allowedTools} -p "${tempPromptFile}"`;

  log("Invoking Claude Code for baseline review...");
  log(`  Screenshots: ${allScreenshots.length}`);
  log(`  Mode: ${mode}`);

  try {
    const output = execSync(cmd, {
      cwd: PROJECT_ROOT,
      timeout: 600_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Save the review
    const reviewFile = path.join(RESULTS_DIR, "baseline-review-result.md");
    fs.writeFileSync(reviewFile, output);
    log(`Review saved to: ${reviewFile}`);

    return { success: true, output };
  } catch (err) {
    const output = (err.stdout?.toString() || "") + "\n" + (err.stderr?.toString() || "");
    log("Claude Code review failed or timed out");
    fs.writeFileSync(path.join(RESULTS_DIR, "baseline-review-error.txt"), output);
    return { success: false, output };
  }
}

/**
 * Parse Claude's review output to check for failures.
 */
function parseReviewResults(output) {
  const lines = output.split("\n");
  let passCount = 0;
  let concernCount = 0;
  let failCount = 0;

  for (const line of lines) {
    const lower = line.toLowerCase();
    // Match various verdict formats Claude might use:
    // "**Verdict:** PASS", "Verdict: PASS", "- PASS", "PASS -", etc.
    if (
      lower.includes("verdict") ||
      lower.includes("**pass**") ||
      lower.includes("**fail**") ||
      lower.includes("**concern**")
    ) {
      if (lower.includes("pass")) passCount++;
      else if (lower.includes("concern")) concernCount++;
      else if (lower.includes("fail")) failCount++;
    }
  }

  // If structured parsing found nothing, try counting keywords in the full output
  if (passCount === 0 && concernCount === 0 && failCount === 0) {
    const fullLower = output.toLowerCase();
    // Count occurrences of "pass" near screenshot names (rough heuristic)
    const passMatches = fullLower.match(/\bpass\b/g);
    const failMatches = fullLower.match(/\bfail\b/g);
    const concernMatches = fullLower.match(/\bconcern\b/g);
    passCount = passMatches ? passMatches.length : 0;
    failCount = failMatches ? failMatches.length : 0;
    concernCount = concernMatches ? concernMatches.length : 0;
    // Subtract common false positives ("all pass", "passed")
    // This is approximate but better than reporting 0/0/0
  }

  return { passCount, concernCount, failCount };
}

/**
 * Regenerate screenshots after fixes.
 */
function regenerateScreenshots() {
  log("Regenerating screenshots after fixes...");
  try {
    // Non-manual mode: Playwright global-setup launches the app automatically
    execSync("yarn playwright test --project=visual --update-snapshots", {
      cwd: APP_DIR,
      timeout: 600_000,
      stdio: "inherit",
    });
    return true;
  } catch {
    log("Screenshot regeneration failed");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("=== Calcula Baseline Screenshot Validator ===");

  // Find all baseline screenshots
  const screenshots = findScreenshots(SEARCH_DIR);

  if (screenshots.length === 0) {
    log("No baseline screenshots found. Run 'yarn e2e:visual:update' first to generate them.");
    process.exit(0);
  }

  log(`Found ${screenshots.length} baseline screenshot(s)`);

  const groups = groupByTestFile(screenshots);
  log(`Grouped into ${Object.keys(groups).length} test file(s)`);

  for (let iteration = 1; iteration <= (AUTO_FIX ? MAX_FIX_ITERATIONS : 1); iteration++) {
    if (AUTO_FIX && iteration > 1) {
      log(`\n--- Fix iteration ${iteration} ---`);
    }

    const mode = AUTO_FIX ? "auto-fix" : "review-only";
    const result = invokeClaudeReview(groups, mode);

    if (!result.success) {
      log("Review could not be completed. Check the error log.");
      process.exit(1);
    }

    const { passCount, concernCount, failCount } = parseReviewResults(result.output);
    log(`\nResults: ${passCount} PASS, ${concernCount} CONCERN, ${failCount} FAIL`);

    if (failCount === 0) {
      log("All baselines approved!");
      if (concernCount > 0) {
        log(`(${concernCount} concern(s) noted - review baseline-review-result.md for details)`);
      }
      process.exit(0);
    }

    if (!AUTO_FIX) {
      log(`${failCount} baseline(s) need attention. Review baseline-review-result.md for details.`);
      log("Run with --auto-fix to let Claude Code fix the issues and regenerate.");
      process.exit(1);
    }

    // Auto-fix mode: Claude should have already made fixes, regenerate screenshots
    if (iteration < MAX_FIX_ITERATIONS) {
      const regen = regenerateScreenshots();
      if (!regen) {
        log("Could not regenerate screenshots. Stopping.");
        process.exit(1);
      }

      // Re-scan screenshots for next iteration
      const newScreenshots = findScreenshots(SEARCH_DIR);
      const newGroups = groupByTestFile(newScreenshots);
      Object.keys(groups).forEach((k) => delete groups[k]);
      Object.assign(groups, newGroups);
    }
  }

  log("Max iterations reached. Some baselines may still need attention.");
  process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
