/**
 * FILENAME: tests/soak/fix-loop.mjs
 * PURPOSE: Fix phase — for an app-bug verdict, invoke Claude with app-fix
 *          permissions and the minimized repro. VALIDATION IS DONE BY THE
 *          ORCHESTRATOR, never trusted to the fix agent:
 *            1. relaunch the app (tauri dev rebuilds Rust),
 *            2. replay the minimized trace — must now PASS,
 *            3. type-check gate.
 *          On any validation failure every file the fix touched is reverted.
 */

import fs from "fs";
import path from "path";
import {
  invokeClaude,
  changedFiles,
  revertFiles,
  revertForbiddenChanges,
} from "../regression/lib/claude.mjs";
import { execCmd, log } from "../regression/lib/exec.mjs";

/**
 * Invoke Claude to fix a ledgered app bug.
 * @returns {{applied: boolean, files: string[], expectedBehavior: boolean, responseExcerpt: string}}
 */
export function runFix({ bug, failureDir, projectRoot, resultsDir, maxFiles = 10 }) {
  const minimizedPath = path.join(failureDir, "minimized.trace.json");
  const tracePath = fs.existsSync(minimizedPath)
    ? minimizedPath
    : path.join(failureDir, "trace.json");
  const trace = JSON.parse(fs.readFileSync(tracePath, "utf8"));
  const failure = JSON.parse(
    fs.readFileSync(path.join(failureDir, "failure.json"), "utf8")
  );

  const before = new Set(changedFiles(projectRoot));

  const prompt = [
    "You are FIXING a confirmed application bug in Calcula, an open-source",
    "spreadsheet application (Tauri + Rust backend + React/Canvas frontend).",
    `Project root: ${projectRoot}`,
    "",
    `## Bug ${bug.id} (oracle: ${bug.violation?.oracleId})`,
    failure.violation?.message ?? bug.violation?.message ?? "",
    "",
    "## Triage verdict",
    JSON.stringify(bug.triage ?? {}, null, 2),
    "",
    "## Digest diff (state divergence)",
    JSON.stringify(failure.violation?.digestDiff?.diffs?.slice(0, 30) ?? [], null, 2),
    "",
    `## Minimized repro (${trace.actions.length} actions, replayed from an empty workbook)`,
    JSON.stringify(trace.actions, null, 2).slice(0, 8000),
    "",
    "The orchestrator will VALIDATE your fix after you finish by rebuilding",
    "the app and replaying this exact trace — the oracle must then pass. Do",
    "NOT try to run the app or the tests yourself; just fix the code.",
    "",
    "## Rules",
    "1. First confirm the root cause by reading the relevant source.",
    "2. Make the MINIMAL fix. No refactoring, no feature additions.",
    `3. Modify at most ${maxFiles} files.`,
    "4. ALLOWED: app/src/, app/src-tauri/, app/extensions/, core/ (app code)",
    "   and app/e2e/ (oracle/test code, ONLY if the oracle itself is wrong).",
    "5. FORBIDDEN: app/package.json, tests/regression/, tests/soak/, .gitignore.",
    "6. If you conclude the observed behavior is actually CORRECT/expected,",
    "   make NO edits and output exactly: VERDICT: expected-behavior",
    "   followed by a one-paragraph draft expected-behavior entry.",
    "7. End your response with a one-line summary: FIX: <what you changed>.",
  ].join("\n");

  const result = invokeClaude({
    prompt,
    label: `fix-${bug.id}`,
    resultsDir,
    cwd: projectRoot,
    allowedTools: "Edit,Write,Read,Grep,Glob,Bash",
    timeoutMs: 2_400_000, // 40 min
  });

  // Enforce path guardrails regardless of what the agent did.
  revertForbiddenChanges({ projectRoot, allowAppFixes: true });

  const after = changedFiles(projectRoot);
  const files = after.filter((f) => !before.has(f));
  const expectedBehavior = result.output.includes("VERDICT: expected-behavior");

  return {
    applied: files.length > 0,
    files,
    expectedBehavior,
    responseExcerpt: result.output.slice(-2000),
  };
}

/**
 * Validate a fix: type-check, then replay the minimized trace against the
 * (already relaunched) app — it must pass now.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateFix({ failureDir, projectRoot, appDir }) {
  // 1. Type-check gate (fast; catches broken frontend edits).
  log("  Validation: type-check...");
  const tsc = execCmd("yarn check-types", { cwd: appDir, timeout: 600_000 });
  if (!tsc.success) {
    return { ok: false, reason: "type-check failed:\n" + tsc.output.slice(-2000) };
  }

  // 2. Replay the minimized trace — must pass.
  const minimizedPath = path.join(failureDir, "minimized.trace.json");
  const tracePath = fs.existsSync(minimizedPath)
    ? minimizedPath
    : path.join(failureDir, "trace.json");

  log("  Validation: replaying minimized repro (must pass)...");
  const replay = execCmd(
    `yarn playwright test --project=soak e2e/soak/replay-trace.spec.ts 2>&1`,
    {
      cwd: appDir,
      timeout: 1_800_000,
      env: {
        ...process.env,
        E2E_MANUAL: "1",
        SOAK_TRACE: tracePath,
        SOAK_TIMEOUT_MS: "1500000",
      },
    }
  );
  if (!replay.success) {
    return {
      ok: false,
      reason: "minimized repro still fails:\n" + replay.output.slice(-3000),
    };
  }

  return { ok: true };
}

/** Revert everything a failed fix touched. */
export function revertFix({ projectRoot, files }) {
  if (files.length > 0) {
    log(`  Fix validation failed — reverting ${files.length} file(s)`);
    revertFiles(projectRoot, files);
  }
}
