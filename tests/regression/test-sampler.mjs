/**
 * Smart Test Sampler with Quarantine
 *
 * Instead of running all 350+ tests every sweep, samples a subset that
 * keeps sweep time constant (~5 min for ~100 tests) while ensuring
 * full coverage over time.
 *
 * Strategy:
 *   ALWAYS run:
 *     - Tests that failed in the last sweep (carry-forward)
 *     - Tests for features affected by recent code changes (git diff)
 *     - Newly created tests (never quarantined until they pass once)
 *
 *   SAMPLE from the rest:
 *     - Pick up to SAMPLE_SIZE from the quarantine pool
 *     - Weighted by how long since they last ran (older = higher priority)
 *
 *   QUARANTINE:
 *     - A test that passes gets quarantined for N sweeps
 *     - Quarantine counter decrements each sweep
 *     - When counter reaches 0, test re-enters the sample pool
 *
 * History is stored in tests/regression/test-history.json
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const APP_DIR = path.join(PROJECT_ROOT, "app");
const HISTORY_FILE = path.join(__dirname, "test-history.json");

// Defaults
const DEFAULT_SAMPLE_SIZE = 100;       // max tests per sweep
const DEFAULT_QUARANTINE_SWEEPS = 10;  // how many sweeps a passing test sits out

/**
 * Load test history from disk, or create empty history.
 */
export function loadHistory() {
  if (fs.existsSync(HISTORY_FILE)) {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
  }
  return {
    version: 1,
    sweepCount: 0,
    tests: {},
    // tests[specPath] = {
    //   lastRun: <sweep number>,
    //   lastResult: "pass" | "fail" | "skip",
    //   quarantineUntil: <sweep number>,  // 0 = not quarantined
    //   passCount: <number>,
    //   failCount: <number>,
    //   created: <sweep number>,
    // }
  };
}

/**
 * Save test history to disk.
 */
export function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

/**
 * Discover all spec files in the project.
 */
export function discoverAllSpecs() {
  const specs = [];
  const dirs = [
    path.join(APP_DIR, "e2e", "tests"),
    path.join(APP_DIR, "e2e", "visual"),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".spec.ts"));
    for (const f of files) {
      specs.push(path.relative(APP_DIR, path.join(dir, f)).replace(/\\/g, "/"));
    }
  }
  return specs;
}

/**
 * Find spec files that are likely affected by recent code changes.
 * Maps changed source files to related test specs using naming conventions
 * and the registry.
 */
export function findAffectedSpecs(allSpecs) {
  // Get files changed since last commit
  let changedFiles;
  try {
    const diff = execSync("git diff --name-only HEAD", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    changedFiles = diff.trim().split("\n").filter(Boolean);
  } catch {
    return []; // no git or no changes
  }

  if (changedFiles.length === 0) return [];

  const affected = new Set();

  for (const changed of changedFiles) {
    // If a spec file itself changed, always include it
    if (changed.endsWith(".spec.ts")) {
      const rel = changed.replace(/^app\//, "");
      if (allSpecs.includes(rel)) affected.add(rel);
      continue;
    }

    // Map source files to related specs by name/keyword matching
    const baseName = path.basename(changed, path.extname(changed)).toLowerCase();

    for (const spec of allSpecs) {
      const specBase = path.basename(spec, ".spec.ts").toLowerCase();

      // Direct name match: clipboard.ts -> clipboard.spec.ts
      if (specBase.includes(baseName) || baseName.includes(specBase)) {
        affected.add(spec);
      }

      // Extension folder match: extensions/Charts/ -> charts.spec.ts
      if (changed.includes("extensions/")) {
        const extName = changed.split("extensions/")[1]?.split("/")[0]?.toLowerCase();
        if (extName && specBase.includes(extName)) {
          affected.add(spec);
        }
      }

      // Core component match: core/components/Spreadsheet/ -> editing.spec.ts, navigation.spec.ts
      if (changed.includes("core/") && (
        specBase === "editing" || specBase === "navigation" ||
        specBase === "formatting" || specBase === "formula"
      )) {
        affected.add(spec);
      }
    }
  }

  return [...affected];
}

/**
 * Select which tests to run for this sweep.
 *
 * @param {object} options
 * @param {number} options.sampleSize - Max tests to run (default 100)
 * @param {number} options.quarantineSweeps - How many sweeps a passing test sits out (default 10)
 * @param {string[]} options.lastFailedSpecs - Specs that failed in the previous sweep
 * @param {boolean} options.fullSweep - Force running all tests (ignores sampling)
 * @returns {{ specs: string[], reason: Record<string, string>, history: object }}
 */
export function selectTests(options = {}) {
  const {
    sampleSize = DEFAULT_SAMPLE_SIZE,
    quarantineSweeps = DEFAULT_QUARANTINE_SWEEPS,
    lastFailedSpecs = [],
    fullSweep = false,
  } = options;

  const history = loadHistory();
  history.sweepCount++;
  const currentSweep = history.sweepCount;

  const allSpecs = discoverAllSpecs();
  const reasons = {}; // specPath -> reason for inclusion

  // If full sweep requested, run everything
  if (fullSweep) {
    for (const spec of allSpecs) reasons[spec] = "full-sweep";
    return { specs: allSpecs, reasons, history };
  }

  const selected = new Set();

  // --- ALWAYS RUN ---

  // 1. Tests that failed last time
  for (const spec of lastFailedSpecs) {
    if (allSpecs.includes(spec)) {
      selected.add(spec);
      reasons[spec] = "failed-last-sweep";
    }
  }

  // Also check history for recent failures
  for (const spec of allSpecs) {
    const entry = history.tests[spec];
    if (entry && entry.lastResult === "fail") {
      selected.add(spec);
      reasons[spec] = reasons[spec] || "failed-previously";
    }
  }

  // 2. Tests affected by code changes
  const affectedSpecs = findAffectedSpecs(allSpecs);
  for (const spec of affectedSpecs) {
    selected.add(spec);
    reasons[spec] = reasons[spec] || "code-changed";
  }

  // 3. New tests (never run before)
  for (const spec of allSpecs) {
    if (!history.tests[spec]) {
      selected.add(spec);
      reasons[spec] = reasons[spec] || "new-test";
    }
  }

  // --- SAMPLE FROM QUARANTINE POOL ---

  // Remaining specs that aren't already selected
  const remaining = allSpecs.filter((s) => !selected.has(s));

  // Separate into: ready (quarantine expired) and quarantined (still waiting)
  const ready = [];
  const quarantined = [];

  for (const spec of remaining) {
    const entry = history.tests[spec];
    if (!entry || currentSweep >= (entry.quarantineUntil || 0)) {
      ready.push(spec);
    } else {
      quarantined.push(spec);
    }
  }

  // Sort ready specs by how long since they last ran (oldest first)
  ready.sort((a, b) => {
    const aLastRun = history.tests[a]?.lastRun || 0;
    const bLastRun = history.tests[b]?.lastRun || 0;
    return aLastRun - bLastRun;
  });

  // Fill up to sampleSize
  const spotsLeft = Math.max(0, sampleSize - selected.size);
  const sampled = ready.slice(0, spotsLeft);

  for (const spec of sampled) {
    selected.add(spec);
    reasons[spec] = "sampled";
  }

  // If we still have spots and all ready specs are taken, dip into quarantined
  // (sorted by nearest quarantine expiry)
  if (selected.size < sampleSize && quarantined.length > 0) {
    quarantined.sort((a, b) => {
      const aUntil = history.tests[a]?.quarantineUntil || 0;
      const bUntil = history.tests[b]?.quarantineUntil || 0;
      return aUntil - bUntil;
    });

    const extraSpots = sampleSize - selected.size;
    const extras = quarantined.slice(0, extraSpots);
    for (const spec of extras) {
      selected.add(spec);
      reasons[spec] = "quarantine-early";
    }
  }

  return {
    specs: [...selected],
    reasons,
    history,
    stats: {
      total: allSpecs.length,
      selected: selected.size,
      alwaysRun: Object.values(reasons).filter((r) =>
        r === "failed-last-sweep" || r === "failed-previously" ||
        r === "code-changed" || r === "new-test"
      ).length,
      sampled: Object.values(reasons).filter((r) => r === "sampled").length,
      quarantined: remaining.length - ready.length,
      ready: ready.length,
    },
  };
}

/**
 * Update history after a sweep completes.
 *
 * @param {object} history - The history object from selectTests
 * @param {Record<string, "pass"|"fail">} results - specPath -> result
 * @param {number} quarantineSweeps - How many sweeps to quarantine passing tests
 */
export function updateHistory(history, results, quarantineSweeps = DEFAULT_QUARANTINE_SWEEPS) {
  const currentSweep = history.sweepCount;

  for (const [spec, result] of Object.entries(results)) {
    if (!history.tests[spec]) {
      history.tests[spec] = {
        lastRun: 0,
        lastResult: "skip",
        quarantineUntil: 0,
        passCount: 0,
        failCount: 0,
        created: currentSweep,
      };
    }

    const entry = history.tests[spec];
    entry.lastRun = currentSweep;
    entry.lastResult = result;

    if (result === "pass") {
      entry.passCount++;
      entry.quarantineUntil = currentSweep + quarantineSweeps;
    } else {
      entry.failCount++;
      entry.quarantineUntil = 0; // failed tests are never quarantined
    }
  }

  // Clean up entries for specs that no longer exist
  const allSpecs = new Set(discoverAllSpecs());
  for (const spec of Object.keys(history.tests)) {
    if (!allSpecs.has(spec)) {
      delete history.tests[spec];
    }
  }

  saveHistory(history);
}

/**
 * Print a summary of the sampling decision.
 */
export function logSamplingReport(selection, log) {
  const { specs, reasons, stats } = selection;
  log(`  Test sampling: ${stats.selected} of ${stats.total} specs selected`);
  log(`    Always run: ${stats.alwaysRun} (failed/changed/new)`);
  log(`    Sampled:    ${stats.sampled} (from quarantine pool)`);
  log(`    Quarantined: ${stats.quarantined} (sitting out this sweep)`);

  // Show reasons for always-run specs
  const alwaysRun = Object.entries(reasons)
    .filter(([, r]) => r !== "sampled" && r !== "quarantine-early")
    .slice(0, 10);
  if (alwaysRun.length > 0) {
    log("    Forced inclusions:");
    for (const [spec, reason] of alwaysRun) {
      log(`      ${path.basename(spec)} — ${reason}`);
    }
    if (alwaysRun.length < Object.entries(reasons).filter(([, r]) => r !== "sampled").length) {
      log(`      ... and ${Object.entries(reasons).filter(([, r]) => r !== "sampled").length - alwaysRun.length} more`);
    }
  }
}

/**
 * Parse Playwright JSON results to determine which specs passed/failed.
 */
export function parsePlaywrightResults(resultsJsonPath) {
  if (!fs.existsSync(resultsJsonPath)) return {};

  const data = JSON.parse(fs.readFileSync(resultsJsonPath, "utf-8"));
  const results = {};

  function processSuite(suite) {
    // Get the spec file path from the suite
    const file = suite.file;
    if (file) {
      const relPath = file.replace(/\\/g, "/");
      // Check all specs in this suite
      let hasFailure = false;
      let hasTests = false;

      function checkSpecs(s) {
        for (const spec of (s.specs || [])) {
          for (const test of (spec.tests || [])) {
            hasTests = true;
            if (test.status === "unexpected" || test.status === "flaky") {
              hasFailure = true;
            }
          }
        }
        for (const child of (s.suites || [])) {
          checkSpecs(child);
        }
      }
      checkSpecs(suite);

      if (hasTests) {
        // Normalize the path to match our spec format
        const normalized = relPath
          .replace(/^.*?e2e\//, "e2e/")
          .replace(/\\/g, "/");
        results[normalized] = hasFailure ? "fail" : "pass";
      }
    }

    // Process child suites
    for (const child of (suite.suites || [])) {
      processSuite(child);
    }
  }

  for (const suite of (data.suites || [])) {
    processSuite(suite);
  }

  return results;
}
