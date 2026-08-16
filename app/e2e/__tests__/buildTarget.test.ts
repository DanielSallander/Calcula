//! FILENAME: app/e2e/__tests__/buildTarget.test.ts
// PURPOSE: The run must be able to say which binary it exercised.
// CONTEXT: See buildTarget.ts. The defect this covers is not a crash, it is an
//          UNRECORDED VARIABLE: `global-setup.ts` sets the MSVC environment and
//          not CARGO_TARGET_DIR, so the target directory is ambient shell state
//          and no run output named it. On 2026-08-16 that produced a build
//          failure (~40 LNK2001 out of libcalp linking app_lib.dll) in the
//          in-repo tree while the same source linked cleanly out-of-repo, and
//          the run read as "E2E is broken".
//
//          Every assertion here is on PURE functions, so the guard cannot pass
//          by agreeing with the machine it runs on.

import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  resolveBuildTarget,
  describeBinary,
  formatBuildTargetBanner,
} from "../buildTarget";

const REPO = "C:\\Dropbox\\Projekt\\Calcula";
const WORKSPACE = path.join(REPO, "app", "src-tauri");

describe("resolveBuildTarget", () => {
  it("uses CARGO_TARGET_DIR when it is set, and says so", () => {
    const info = resolveBuildTarget(
      { CARGO_TARGET_DIR: "C:\\Users\\Salle\\AppData\\Local\\calcula-target" },
      WORKSPACE,
      REPO,
    );
    expect(info.source).toBe("CARGO_TARGET_DIR");
    expect(info.targetDir).toBe(
      path.resolve("C:\\Users\\Salle\\AppData\\Local\\calcula-target"),
    );
    expect(info.insideRepo).toBe(false);
  });

  it("falls back to the workspace target -- which is INSIDE the repo", () => {
    // This is the case that shipped, and the one nothing ever printed.
    const info = resolveBuildTarget({}, WORKSPACE, REPO);
    expect(info.source).toBe("workspace default");
    expect(info.targetDir).toBe(path.join(WORKSPACE, "target"));
    expect(info.insideRepo).toBe(true);
  });

  it("treats an empty or whitespace value as absent, not as the current directory", () => {
    for (const value of ["", "   "]) {
      const info = resolveBuildTarget({ CARGO_TARGET_DIR: value }, WORKSPACE, REPO);
      expect(info.source, JSON.stringify(value)).toBe("workspace default");
      expect(info.targetDir).toBe(path.join(WORKSPACE, "target"));
    }
  });

  it("recognises an out-of-repo target on another drive as outside", () => {
    const info = resolveBuildTarget({ CARGO_TARGET_DIR: "D:\\builds\\calcula" }, WORKSPACE, REPO);
    expect(info.insideRepo).toBe(false);
  });

  it("does not mistake a sibling directory with the same prefix for the repo", () => {
    // `C:\Dropbox\Projekt\Calcula-scratch` starts with the repo path as a
    // STRING but is not inside it. A naive startsWith() gets this wrong.
    const info = resolveBuildTarget(
      { CARGO_TARGET_DIR: REPO + "-scratch\\target" },
      WORKSPACE,
      REPO,
    );
    expect(info.insideRepo).toBe(false);
  });
});

describe("describeBinary", () => {
  const mtime = new Date("2026-08-16T01:01:00.000Z");

  it("reports what is on disk at the app binary", () => {
    const info = describeBinary("C:\\t", () => ({ size: 177_083_904, mtime }));
    expect(info).not.toBeNull();
    expect(info!.path).toBe(path.join("C:\\t", "debug", "app.exe"));
    expect(info!.sizeBytes).toBe(177_083_904);
    expect(info!.mtime).toBe(mtime);
  });

  it("returns null rather than throwing when nothing is built yet", () => {
    expect(
      describeBinary("C:\\t", () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });
});

describe("formatBuildTargetBanner", () => {
  const binary = {
    path: "C:\\t\\debug\\app.exe",
    sizeBytes: 177_083_904,
    mtime: new Date("2026-08-16T01:01:00.000Z"),
  };

  it("names the target directory AND where the value came from", () => {
    const out = formatBuildTargetBanner(
      { targetDir: "C:\\t", source: "CARGO_TARGET_DIR", insideRepo: false },
      binary,
    ).join("\n");
    expect(out).toContain("C:\\t");
    expect(out).toContain("from CARGO_TARGET_DIR");
  });

  it("names the binary, its size and WHEN it was built", () => {
    // "which binary did this run exercise" is the whole question; a path with
    // no timestamp cannot distinguish today's build from last week's.
    const out = formatBuildTargetBanner(
      { targetDir: "C:\\t", source: "CARGO_TARGET_DIR", insideRepo: false },
      binary,
    ).join("\n");
    expect(out).toContain("app.exe");
    expect(out).toContain("168.9 MB");
    expect(out).toContain("2026-08-16T01:01:00.000Z");
  });

  it("says the binary is not built yet instead of pretending it is", () => {
    const out = formatBuildTargetBanner(
      { targetDir: "C:\\t", source: "workspace default", insideRepo: true },
      null,
    ).join("\n");
    expect(out).toContain("not built yet");
    expect(out).not.toContain("MB, built");
  });

  it("WARNS when the build target is inside the repository", () => {
    const out = formatBuildTargetBanner(
      { targetDir: "C:\\repo\\app\\src-tauri\\target", source: "workspace default", insideRepo: true },
      binary,
    ).join("\n");
    expect(out).toContain("[WARNING]");
    expect(out).toContain("INSIDE the repository");
    expect(out).toContain("CARGO_TARGET_DIR");
  });

  it("is SILENT when the target is where the rules want it", () => {
    // The other direction: a warning that always fires is noise, and noise is
    // how the "[WARNING] the undo round-trip decided NOTHING" line survived
    // under a green verdict for a fortnight.
    const out = formatBuildTargetBanner(
      { targetDir: "C:\\out\\calcula-target", source: "CARGO_TARGET_DIR", insideRepo: false },
      binary,
    ).join("\n");
    expect(out).not.toContain("[WARNING]");
  });
});
