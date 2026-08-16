//! FILENAME: app/e2e/buildTarget.ts
// PURPOSE: Say WHICH binary an E2E run is about to exercise, and warn when the
//          build is going somewhere the project's own environment rules forbid.
// CONTEXT: `global-setup.ts` carefully constructs the MSVC environment before
//          spawning `cargo tauri dev` -- and says nothing about
//          CARGO_TARGET_DIR, which it does not set. There is no
//          .cargo/config.toml and no persistent user or machine value, so the
//          variable is whatever the invoking shell happens to export. When it is
//          absent, cargo builds into the in-repo `app/src-tauri/target`; when it
//          is present, somewhere else entirely. Two terminals therefore build
//          and run two DIFFERENT binaries, and nothing in the run's output says
//          which one it was.
//
//          Measured 2026-08-16: the in-repo tree failed to link `app_lib.dll`
//          with ~40 `LNK2001 unresolved external symbol anon.<hash>.llvm.<id>`
//          errors out of `libcalp`, while the SAME SOURCE linked cleanly in the
//          out-of-repo target. The first E2E launch of the day therefore died at
//          build time and read as "E2E is broken" rather than "this shell points
//          at a corrupted artifact tree".
//
//          For a programme whose thesis is that a green number must mean
//          something, a run that cannot name what it built is the defect --
//          independent of that day's corruption. This module makes the answer
//          part of the run's own output.
//
//          Note also what no gate in the tree covers: `cargo check
//          --all-targets` does not link at all, and `cargo test --lib` links an
//          executable, not the `app_lib.dll` the app loads. The E2E launcher is
//          the first thing that tries it.

import * as fs from "fs";
import * as path from "path";

export interface BuildTargetInfo {
  /** Absolute path cargo will use as its target directory. */
  targetDir: string;
  /** Where that value came from. */
  source: "CARGO_TARGET_DIR" | "workspace default";
  /**
   * True when the target directory sits inside the repository. On this machine
   * the repository lives in Dropbox, which is why the standing rule is to keep
   * build output out of it (see CLAUDE.md and open-decisions §37).
   */
  insideRepo: boolean;
}

/**
 * Resolve the target directory the way cargo will.
 *
 * PURE: takes the environment and the paths rather than reading either, so it
 * has a unit tier and cannot pass by accident on the machine that wrote it.
 */
export function resolveBuildTarget(
  env: Record<string, string | undefined>,
  cargoWorkspaceDir: string,
  repoRoot: string,
): BuildTargetInfo {
  const explicit = env.CARGO_TARGET_DIR;
  const targetDir =
    explicit && explicit.trim() !== ""
      ? path.resolve(explicit)
      : path.resolve(cargoWorkspaceDir, "target");
  const rel = path.relative(path.resolve(repoRoot), targetDir);
  // Inside the repo iff the relative path neither escapes upward nor is
  // absolute (a different drive yields an absolute path on Windows).
  const insideRepo = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  return {
    targetDir,
    source: explicit && explicit.trim() !== "" ? "CARGO_TARGET_DIR" : "workspace default",
    insideRepo,
  };
}

/** What is on disk at the binary this run will launch, or null if not built. */
export function describeBinary(
  targetDir: string,
  statSync: (p: string) => { size: number; mtime: Date } = fs.statSync,
): { path: string; sizeBytes: number; mtime: Date } | null {
  const exe = path.join(targetDir, "debug", "app.exe");
  try {
    const st = statSync(exe);
    return { path: exe, sizeBytes: st.size, mtime: st.mtime };
  } catch {
    return null;
  }
}

/**
 * The lines a run prints about its own build inputs.
 *
 * Returned rather than printed so the content is assertable. The warning is a
 * warning and not a refusal on purpose: building in-repo WORKS (the tree carries
 * `com.dropbox.ignored=1`), it is simply the configuration the environment rules
 * tell every operator to avoid, and a harness that refused to run would be
 * worse than one that says what it did.
 */
export function formatBuildTargetBanner(
  info: BuildTargetInfo,
  binary: { path: string; sizeBytes: number; mtime: Date } | null,
): string[] {
  const lines = [
    `[e2e] cargo target dir: ${info.targetDir}  (from ${info.source})`,
    binary === null
      ? `[e2e] app binary:       not built yet at ${path.join(info.targetDir, "debug", "app.exe")} — this run will build it`
      : `[e2e] app binary:       ${binary.path}  (${(binary.sizeBytes / 1_048_576).toFixed(1)} MB, built ${binary.mtime.toISOString()})`,
  ];
  if (info.insideRepo) {
    lines.push(
      "[e2e] [WARNING] the build target is INSIDE the repository. On this machine the " +
        "repo lives in Dropbox, and the standing rule is to point CARGO_TARGET_DIR at a " +
        "directory outside it. This run will still proceed, but which binary it exercises " +
        "now depends on a tree the environment rules do not cover. See open-decisions " +
        "2026-08 sections 37 and 39d.",
    );
  }
  return lines;
}
