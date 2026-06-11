/**
 * FILENAME: tests/regression/lib/claude.mjs
 * PURPOSE: Claude Code CLI invocation + guardrail enforcement, shared by the
 *          regression runner (auto-fix loop) and the soak runner (triage +
 *          fix phases).
 *
 * Environment:
 *   CLAUDE_CMD    - Claude Code CLI binary (default: "claude")
 *   CLAUDE_MODEL  - model id (default: "claude-opus-4-8")
 *   CLAUDE_EFFORT - effort level (default: "max")
 */

import fs from "fs";
import path from "path";
import { execCmd, log } from "./exec.mjs";

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";
const CLAUDE_EFFORT = process.env.CLAUDE_EFFORT || "max";
const CLAUDE_BASE = process.env.CLAUDE_CMD || "claude";

export const CLAUDE_CMD = `${CLAUDE_BASE} --model ${CLAUDE_MODEL} --effort ${CLAUDE_EFFORT}`;

/**
 * Invoke Claude Code with a prompt. The prompt is written to a file (avoids
 * shell escaping) and the response is saved next to it.
 *
 * @param {object} opts
 * @param {string} opts.prompt        Full prompt text.
 * @param {string} opts.label         Artifact basename, e.g. "triage-BUG-0003".
 * @param {string} opts.resultsDir    Where prompt/response artifacts go.
 * @param {string} opts.cwd           Working directory for the CLI.
 * @param {string} [opts.allowedTools] Tool allowlist (default: read-only).
 * @param {number} [opts.timeoutMs]   Default 30 min.
 * @returns {{success: boolean, output: string}}
 */
export function invokeClaude({
  prompt,
  label,
  resultsDir,
  cwd,
  allowedTools = "Read,Grep,Glob",
  timeoutMs = 1_800_000,
}) {
  fs.mkdirSync(resultsDir, { recursive: true });
  const promptFile = path.join(resultsDir, `${label}-prompt.txt`);
  fs.writeFileSync(promptFile, prompt);

  const cmd = `${CLAUDE_CMD} --print --allowedTools "${allowedTools}" -p "${promptFile}"`;
  log(`  Invoking Claude Code (${label}, tools: ${allowedTools})...`);
  const result = execCmd(cmd, { cwd, timeout: timeoutMs });

  const outFile = path.join(
    resultsDir,
    `${label}-${result.success ? "response.md" : "error.txt"}`
  );
  fs.writeFileSync(outFile, result.output);
  log(
    result.success
      ? `  Claude Code completed (${label})`
      : `  Claude Code failed or timed out (${label})`
  );

  return result;
}

/**
 * Extract the first JSON object from a Claude response (tolerates prose and
 * ```json fences around it). Returns null if none parses.
 */
export function extractJson(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const braceStart = text.indexOf("{");
  if (braceStart >= 0) candidates.push(text.slice(braceStart));

  for (const candidate of candidates) {
    // Try progressively shorter substrings ending at each closing brace.
    let depth = 0;
    for (let i = 0; i < candidate.length; i++) {
      if (candidate[i] === "{") depth++;
      else if (candidate[i] === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(0, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

/**
 * Revert uncommitted changes to forbidden paths after a Claude invocation.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {boolean} opts.allowAppFixes  When false, app/src/ and core/ are
 *                                      reverted too.
 * @param {string[]} [opts.extraForbidden] Additional forbidden path prefixes.
 */
export function revertForbiddenChanges({ projectRoot, allowAppFixes, extraForbidden = [] }) {
  const FORBIDDEN = [
    "tests/regression/regression-runner.mjs",
    "tests/regression/validate-baselines.mjs",
    "tests/regression/test-sampler.mjs",
    "tests/regression/lib/",
    "tests/soak/",
    "tests/regression/suggested-scenarios.md",
    "tests/regression/README.md",
    "app/package.json",
    ".gitignore",
    ...extraForbidden,
  ];
  if (!allowAppFixes) {
    FORBIDDEN.push("app/src/");
    FORBIDDEN.push("core/");
  }
  const status = execCmd("git status --porcelain", { cwd: projectRoot });
  for (const line of status.output.trim().split("\n").filter(Boolean)) {
    const filePath = line.trim().replace(/^[MADRCU? ]+\s+/, "");
    if (FORBIDDEN.some((p) => filePath.startsWith(p) || filePath === p)) {
      log(`  Reverting unauthorized change: ${filePath}`);
      execCmd(`git checkout -- "${filePath}"`, { cwd: projectRoot });
    }
  }
}

/**
 * Revert a specific list of files (used when fix validation fails).
 */
export function revertFiles(projectRoot, files) {
  for (const f of files) {
    log(`  Reverting: ${f}`);
    execCmd(`git checkout -- "${f}"`, { cwd: projectRoot });
  }
}

/**
 * List uncommitted changed files (paths relative to projectRoot).
 */
export function changedFiles(projectRoot) {
  const status = execCmd("git status --porcelain", { cwd: projectRoot });
  return status.output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.trim().replace(/^[MADRCU? ]+\s+/, ""));
}
