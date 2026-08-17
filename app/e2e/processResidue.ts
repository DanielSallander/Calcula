//! FILENAME: app/e2e/processResidue.ts
// PURPOSE: Prove, rather than assume, that a run starts on a machine nobody else
//          owns and leaves no process tree behind.
//
// WHAT WAS WRONG. `global-teardown.ts` fired ONE `taskkill /F /T /PID` with
// `stdio: "ignore"` inside a bare `catch {}` and then printed "[e2e] Tauri
// stopped." unconditionally — so "the kill was refused" and "it exited cleanly"
// produced the identical sentence. Nothing polled the pid, nothing probed 9222 or
// 5173, and nothing looked for a surviving `app.exe`.
//
// AND THE RECORDED PID IS NOT THE APP. `global-setup` spawns with `shell: true`,
// so `child.pid` is the `cmd.exe` wrapper; the real tree is
// cmd -> yarn(node) -> cargo-tauri -> cargo -> app.exe -> msedgewebview2.
// `taskkill /T` walks LIVE parent links at kill time, so as soon as an
// intermediate has exited — which is exactly what happens when a journey spec
// closes the window — the surviving app.exe and vite node are no longer reachable
// from that pid. A check that only polled the recorded pid would therefore have
// passed on every run that actually orphaned something. Recording the app's OWN
// pid is part of the fix, not a nicety.
//
// TWO RULES THIS FILE OBEYS, both already paid for in this repo:
//
//   1. **NEVER touch `msedgewebview2` by image name.** Those processes also
//      belong to Windows SearchHost, and Calcula itself renders in WebView2 —
//      killing them wholesale destroyed a journey run. Only pids this run
//      recorded, or executables under THIS run's target directory, are ever
//      killed.
//   2. **Never kill what this run did not start.** A second agent's app is built
//      from the same `CARGO_TARGET_DIR`, so "an app.exe I did not record" is
//      indistinguishable from "another agent's live suite". Those are REPORTED
//      and left alone; killing one is a measured past defect.
//
// WHY IT ALSO LOOKS AT THE TARGET DIRECTORY. `scripts/kill-stale-dev.mjs` matches
// executables under the IN-REPO `src-tauri/target` only — but this project's own
// rules mandate a `CARGO_TARGET_DIR` OUTSIDE the repo (Dropbox locks the in-repo
// tree mid-build), so the app the E2E harness actually runs lives somewhere that
// helper cannot recognise. `resolveBuildTarget` already answers "which target
// directory is this run using", the same way cargo does, so this asks it.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBuildTarget } from "./buildTarget";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(APP_DIR, "..");

/** One Calcula-owned process, as the survey found it. */
export interface CalculaProcess {
  pid: number;
  name: string;
  /** Absolute path to the image, lowercased; "" when it could not be read. */
  imagePath: string;
  /** Why the survey considers this ours: a recorded pid, or our target dir. */
  attribution: "recorded" | "our-target-dir" | "on-our-port";
}

export interface ResidueVerdict {
  clean: boolean;
  /** Ours, still alive after the kill and the wait. */
  blockers: string[];
  /** Calcula-shaped but NOT started by this run. Reported, never killed. */
  unattributed: string[];
  waitedMs: number;
}

const POLL_MS = 250;
const DEFAULT_BUDGET_MS = Number(process.env.E2E_RESIDUE_WAIT_MS ?? 15_000);

/** PowerShell one-liner -> parsed rows; [] on any failure. Never throws. */
function queryProcesses(): Array<{ ProcessId: number; Name: string; ExecutablePath: string | null }> {
  try {
    const json = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='app.exe' OR Name='Calcula.exe'\" " +
          "| Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress",
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    ).trim();
    if (!json) return [];
    const parsed: unknown = JSON.parse(json);
    return (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
      ProcessId: number;
      Name: string;
      ExecutablePath: string | null;
    }>;
  } catch {
    return [];
  }
}

/** True when `pid` is alive. `kill(pid, 0)` is the cheap, portable probe. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pids LISTENING on `port`.
 *
 * Plain `netstat -ano`, NOT `netstat -p TCP`: on Windows that filters to IPv4
 * only, and Vite binds "localhost" which resolves to `::1` here — so the listener
 * that actually blocks a restart shows up as `[::1]:5173` under TCPv6 and a
 * `-p TCP` scan never sees it. That cost a debugging session once already.
 */
export function pidsOnPort(port: number): number[] {
  try {
    const out = execFileSync("netstat", ["-ano"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const pids = new Set<number>();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes("LISTENING")) continue;
      // `[::1]:5173` and `127.0.0.1:5173` both end the address with `:<port>`.
      const cols = line.trim().split(/\s+/);
      const local = cols[1] ?? "";
      if (!local.endsWith(`:${port}`)) continue;
      const pid = Number(cols[cols.length - 1]);
      if (Number.isFinite(pid) && pid > 0) pids.add(pid);
    }
    return [...pids];
  } catch {
    return [];
  }
}

/** The target directory THIS run builds and runs from, lowercased. */
function ourTargetDir(): string {
  try {
    const info = resolveBuildTarget(
      process.env,
      path.join(APP_DIR, "src-tauri"),
      REPO_ROOT,
    );
    return String(info.targetDir).toLowerCase();
  } catch {
    return path.join(APP_DIR, "src-tauri", "target").toLowerCase();
  }
}

/**
 * Every Calcula-shaped process, attributed.
 *
 * `recordedPids` are the ones this run wrote down (see `recordAppPid`). Anything
 * else under our target directory is Calcula's but not ours — most likely another
 * agent's suite — and is reported rather than killed.
 */
export function surveyCalculaProcesses(recordedPids: readonly number[] = []): CalculaProcess[] {
  const target = ourTargetDir();
  const recorded = new Set(recordedPids);
  const out: CalculaProcess[] = [];
  for (const row of queryProcesses()) {
    const pid = Number(row.ProcessId);
    if (!Number.isFinite(pid)) continue;
    const imagePath = (row.ExecutablePath ?? "").toLowerCase();
    // Only ours. An unrelated `app.exe` elsewhere on the machine (there are
    // several — "ollama app.exe" is the standing example) is never listed.
    const underTarget = imagePath.length > 0 && imagePath.startsWith(target);
    if (!recorded.has(pid) && !underTarget) continue;
    out.push({
      pid,
      name: String(row.Name ?? "app.exe"),
      imagePath,
      attribution: recorded.has(pid) ? "recorded" : "our-target-dir",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The pid ledger — what this run started, so teardown can be specific
// ---------------------------------------------------------------------------

/**
 * Where the pid ledger lives.
 *
 * `E2E_RESIDUE_STATE_DIR` exists so this module's own unit tests can point it at
 * a temp directory. Against the real path a test would write and delete the
 * ledger of a CONCURRENTLY RUNNING suite, and that suite's teardown would then
 * either kill nothing or kill something it no longer recognises. Same reasoning
 * as `E2E_WEDGE_STATE_DIR`; unset in every normal run.
 */
const PID_LEDGER = path.join(
  process.env.E2E_RESIDUE_STATE_DIR ?? HERE,
  ".run-pids",
);

/** Record a pid this run is responsible for. Idempotent, never throws. */
export function recordAppPid(pid: number): void {
  try {
    const have = readRecordedPids();
    if (have.includes(pid)) return;
    fs.mkdirSync(path.dirname(PID_LEDGER), { recursive: true });
    fs.writeFileSync(PID_LEDGER, [...have, pid].join("\n"), "utf-8");
  } catch {
    /* the ledger is an aid; a run must not fail because it could not be written */
  }
}

export function readRecordedPids(): number[] {
  try {
    return fs
      .readFileSync(PID_LEDGER, "utf-8")
      .split(/\r?\n/)
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

export function clearRecordedPids(): void {
  try {
    if (fs.existsSync(PID_LEDGER)) fs.unlinkSync(PID_LEDGER);
  } catch {
    /* nothing to clear */
  }
}

// ---------------------------------------------------------------------------
// The two entry points
// ---------------------------------------------------------------------------

function killTree(pid: number): void {
  try {
    execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    /* already gone, or refused — the POLL below is what decides, not this */
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Kill everything this run started, then PROVE it is gone.
 *
 * The proof is the point. The old code's success message was printed
 * unconditionally; this one is printed only after a poll says the pids are dead
 * and the ports are free.
 */
export async function killRunAndVerify(opts: {
  pidFile: string;
  cdpPort: number;
  vitePort: number;
  budgetMs?: number;
}): Promise<ResidueVerdict> {
  const budget = opts.budgetMs ?? DEFAULT_BUDGET_MS;

  // Everything we know we own: the shell wrapper from the pid file, plus every
  // app pid the fixtures recorded (which is what survives when the wrapper does
  // not).
  const owned = new Set<number>(readRecordedPids());
  try {
    const fromFile = Number(fs.readFileSync(opts.pidFile, "utf-8").trim());
    if (Number.isFinite(fromFile) && fromFile > 0) owned.add(fromFile);
  } catch {
    /* no pid file: auto-launch never happened, or it was already cleaned */
  }
  for (const p of surveyCalculaProcesses([...owned])) {
    if (p.attribution === "recorded") owned.add(p.pid);
  }

  for (const pid of owned) killTree(pid);

  const started = Date.now();
  let blockers: string[] = [];
  for (;;) {
    const aliveOwned = [...owned].filter(isAlive).map((p) => `pid ${p} (ours) still alive`);
    const vite = pidsOnPort(opts.vitePort).map(
      (p) => `port ${opts.vitePort} still LISTENING (pid ${p})`,
    );
    const cdp = pidsOnPort(opts.cdpPort).map(
      (p) => `port ${opts.cdpPort} still LISTENING (pid ${p})`,
    );
    blockers = [...aliveOwned, ...vite, ...cdp];
    if (blockers.length === 0) break;
    if (Date.now() - started >= budget) break;
    await sleep(POLL_MS);
  }

  // Calcula-shaped, under our target dir, but NOT ours: another agent's suite.
  // Named so a human can decide; never killed.
  const unattributed = surveyCalculaProcesses([...owned])
    .filter((p) => p.attribution !== "recorded" && !owned.has(p.pid))
    .map((p) => `${p.name} pid ${p.pid} — ${p.imagePath || "(image path unreadable)"}`);

  const verdict: ResidueVerdict = {
    clean: blockers.length === 0,
    blockers,
    unattributed,
    waitedMs: Date.now() - started,
  };
  if (verdict.clean) clearRecordedPids();
  return verdict;
}

/**
 * The precondition, for the START of a run.
 *
 * IT LIVES IN `global-setup`, NOT the teardown, and that is the whole point of
 * the item: `global-teardown` returns before its kill when `E2E_MANUAL=1`, and
 * manual mode is how 11 of the `e2e:*` scripts are driven. A residue check in the
 * teardown would therefore never run on the very paths that leak.
 *
 * It REPORTS rather than kills, for the same reason the teardown does not kill
 * unattributed processes: at the start of a run, an app on our ports may well be
 * the operator's own manual instance, and in manual mode it is *supposed* to be
 * there.
 */
export function describeInheritedResidue(opts: {
  cdpPort: number;
  vitePort: number;
}): string[] {
  const notes: string[] = [];
  const stale = surveyCalculaProcesses(readRecordedPids()).filter(
    (p) => p.attribution !== "recorded",
  );
  for (const p of stale) {
    notes.push(`${p.name} pid ${p.pid} is alive from an earlier run or another agent`);
  }
  const leftoverPids = readRecordedPids().filter(isAlive);
  for (const pid of leftoverPids) {
    notes.push(`pid ${pid} was recorded by a PREVIOUS run and is still alive`);
  }
  return notes;
}

/** True when nothing is listening on `port`. Used only for reporting. */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    // 127.0.0.1 specifically: measured, binding `localhost:9222` SUCCEEDS while
    // 127.0.0.1:9222 is occupied, so the loose form answers the wrong question.
    srv.listen(port, "127.0.0.1");
  });
}
