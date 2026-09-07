//! FILENAME: tests/eval/lib/grader.mjs
// PURPOSE: Find and run the offline formula grader, without depending on which
//          shell happens to be invoking it.
// CONTEXT: The first version of this shelled out to `cargo run`, and it worked
//          from PowerShell and failed from Git Bash — twice over, in the two
//          ways CLAUDE.md warns about:
//
//            * `CARGO_TARGET_DIR` is ambient. Nothing in the repo sets it, so a
//              shell without it builds into the IN-REPO `core/target`, which is
//              both Dropbox-synced (files locked mid-build, os error 32) and
//              known-corrupt.
//            * Git Bash ships its own `link` on PATH, which shadows MSVC's
//              `link.exe`. Any cargo command that needs to LINK then dies with
//              "link: extra operand", which names neither cause.
//
//          So this resolves the already-built binary and executes it directly.
//          No cargo, no linker, no build, no ambient state — and, as a bonus, no
//          per-batch cargo freshness check. When the binary is missing it says
//          exactly how to build it rather than trying and failing obscurely.
//          Same reasoning as `app/e2e/buildTarget.ts`, which resolves the target
//          directory the way cargo will and PRINTS what it is about to run.

import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const EXAMPLE = "eval-formulas";

/** Where cargo would put things, given the environment cargo would see. */
export function cargoTargetDir() {
  if (process.env.CARGO_TARGET_DIR) return process.env.CARGO_TARGET_DIR;
  const local = process.env.LOCALAPPDATA;
  if (local) return path.join(local, "calcula-target");
  return null;
}

const BUILD_HINT = [
  "Build it first, from PowerShell (Git Bash's `link` shadows MSVC's):",
  "",
  "    . .\\core\\setup-rust-env.ps1",
  "    cd core; cargo build -q -p calcula-format --example eval-formulas --release",
  "",
  "Or point CALCULA_FORMULA_GRADER at an existing binary.",
].join("\n");

/**
 * The grader executable, newest-wins between release and debug.
 *
 * Release first because that is what the build hint produces and what a
 * hundred-task run wants; a debug build is accepted so a developer mid-change is
 * not blocked, and the choice is REPORTED rather than silent — running
 * yesterday's binary and not knowing it is the stale-binary trap this repo has
 * paid for more than once.
 */
export function resolveGrader({ repo }) {
  const override = process.env.CALCULA_FORMULA_GRADER;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`CALCULA_FORMULA_GRADER points at ${override}, which does not exist.`);
    }
    return { exe: override, source: "CALCULA_FORMULA_GRADER" };
  }

  const roots = [];
  const target = cargoTargetDir();
  if (target) roots.push(target);
  // The in-repo tree last, and only because a checkout that has never had the
  // variable set may still have one.
  roots.push(path.join(repo, "core", "target"));

  const candidates = [];
  for (const root of roots) {
    for (const profile of ["release", "debug"]) {
      const exe = path.join(root, profile, "examples", `${EXAMPLE}.exe`);
      const plain = path.join(root, profile, "examples", EXAMPLE);
      for (const p of [exe, plain]) {
        if (existsSync(p)) candidates.push({ exe: p, mtime: statSync(p).mtimeMs, profile, root });
      }
    }
  }
  if (candidates.length === 0) {
    throw new Error(`The formula grader has not been built.\n\n${BUILD_HINT}`);
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const best = candidates[0];
  return {
    exe: best.exe,
    source: `${best.profile} build in ${best.root}`,
    builtAt: new Date(best.mtime).toISOString(),
  };
}

/**
 * Grade a batch of formulas.
 *
 * One process for the whole batch: a hundred-task corpus spends more time
 * launching processes than evaluating if each task gets its own.
 */
export function gradeJobs(request, { exe }) {
  const stdout = execFileSync(exe, [], {
    input: JSON.stringify(request),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  if (parsed.version !== 1) {
    throw new Error(
      `the grader answered with response version ${parsed.version}; this caller understands 1`,
    );
  }
  return parsed;
}
