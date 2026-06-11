/**
 * FILENAME: tests/soak/triage.mjs
 * PURPOSE: Triage phase — classify each soak failure as app-bug / test-bug /
 *          flake / known-issue via a read-only Claude invocation grounded in
 *          the expected-behavior corpus.
 */

import fs from "fs";
import path from "path";
import { invokeClaude, extractJson } from "../regression/lib/claude.mjs";
import { log } from "../regression/lib/exec.mjs";
import { selectRelevant, renderEntry } from "./corpus.mjs";

/**
 * @param {object} opts
 * @param {string} opts.failureDir   Directory with failure.json/trace.json
 * @param {string} opts.projectRoot
 * @param {string} opts.resultsDir   Where to store prompt/response artifacts
 * @returns triage verdict object or null
 */
export function runTriage({ failureDir, projectRoot, resultsDir }) {
  const failure = JSON.parse(
    fs.readFileSync(path.join(failureDir, "failure.json"), "utf8")
  );
  const minimizedPath = path.join(failureDir, "minimized.trace.json");
  const tracePath = fs.existsSync(minimizedPath)
    ? minimizedPath
    : path.join(failureDir, "trace.json");
  const trace = JSON.parse(fs.readFileSync(tracePath, "utf8"));

  const corpusEntries = selectRelevant(trace.actions.map((a) => a.id));
  const corpusText = corpusEntries.length
    ? corpusEntries.map(renderEntry).join("\n\n")
    : "(corpus is empty — judge from first principles and Excel conventions)";

  const digestDiff = failure.violation?.digestDiff;
  const diffExcerpt = digestDiff
    ? JSON.stringify(digestDiff.diffs.slice(0, 30), null, 2)
    : "(no digest diff — see violation message)";

  const prompt = [
    "You are TRIAGING an automated test failure in Calcula, an open-source",
    "spreadsheet application (Tauri + Rust backend + React/Canvas frontend).",
    `Project root: ${projectRoot}`,
    "",
    "The failure was found by a SEMANTIC ORACLE during a random action walk:",
    "- undo-round-trip: after N actions, undoing N times must restore the",
    "  exact prior workbook state (then redo must restore the post-state).",
    "- save-reload-round-trip: saving to .cala and reopening must reproduce",
    "  the same state.",
    "- recalc-consistency: a full recalculation must not change any value.",
    "Other ids are UI invariants (contextual-ribbon-tabs, no-js-exceptions...).",
    "",
    `## Violation (id: ${failure.violationId})`,
    failure.violation?.message ?? "(no message)",
    "",
    "## Digest diff (state divergence, path: before -> after)",
    diffExcerpt,
    "",
    `## Minimized action trace (${trace.actions.length} actions, replayConfirmed=${failure.replayConfirmed})`,
    JSON.stringify(trace.actions, null, 2).slice(0, 8000),
    "",
    "## Documented expected behaviors (the reference; [verified] entries are",
    "## user-confirmed truth, [unverified] are drafts)",
    corpusText.slice(0, 12000),
    "",
    "## Your task",
    "Classify this failure. Investigate the source code (Read/Grep/Glob) as",
    "needed. PRIORS:",
    "- Oracle round-trip violations are APP BUGS by default. Only answer",
    "  test-bug if the ORACLE itself mis-normalized a volatile field (e.g. a",
    "  timestamp or derived cache leaked into the digest) — cite the digest",
    "  path that proves it.",
    "- Answer flake ONLY if replayConfirmed is false.",
    "- If the observed behavior is actually CORRECT and the corpus/oracle",
    "  expectation is wrong, answer test-bug and explain.",
    "",
    "Respond with STRICT JSON only (no prose outside the JSON):",
    "{",
    '  "verdict": "app-bug" | "test-bug" | "flake" | "known-issue",',
    '  "confidence": 0.0-1.0,',
    '  "behaviorIds": ["area.feature", ...],',
    '  "rootCauseHypothesis": "one or two sentences",',
    '  "suggestedFixArea": "frontend" | "rust" | "test",',
    '  "knownIssueMatch": "BUG-nnnn or null",',
    '  "proposedBehaviorEntry": { "id": "area.kebab-name", "text": "..." } | null',
    "}",
  ].join("\n");

  const result = invokeClaude({
    prompt,
    label: `triage-${path.basename(failureDir)}`,
    resultsDir,
    cwd: projectRoot,
    allowedTools: "Read,Grep,Glob",
    timeoutMs: 900_000, // 15 min
  });

  if (!result.success) return null;

  const verdict = extractJson(result.output);
  if (!verdict || !verdict.verdict) {
    log("  Triage produced no parseable JSON verdict");
    return null;
  }
  return verdict;
}
