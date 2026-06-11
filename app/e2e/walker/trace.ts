//! FILENAME: app/e2e/walker/trace.ts
// PURPOSE: Concrete action traces — the replayable record of a walk.
//          Traces (not seeds) are the unit of replay and minimization:
//          context-aware generation makes seed-replay of subsequences
//          impossible, so every executed action is recorded with its
//          concrete parameters.

import * as fs from "node:fs";
import * as path from "node:path";

/** One concrete, executed (or executable) action. */
export interface ActionInstance {
  id: string;
  /** JSON-serializable parameters chosen at generation time. */
  params: Record<string, unknown>;
}

export interface ActionTrace {
  version: 1;
  /** Seed that generated this trace, or null for hand-written traces. */
  seed: number | null;
  startedAt: string;
  actions: ActionInstance[];
}

export function createTrace(seed: number | null): ActionTrace {
  return {
    version: 1,
    seed,
    startedAt: new Date().toISOString(),
    actions: [],
  };
}

/** Write a trace to disk (atomically enough for crash forensics).
 *  Windows quirk: Dropbox/antivirus can briefly lock the destination and
 *  make rename fail with EPERM — retry, then fall back to a direct write. */
export function saveTrace(trace: ActionTrace, filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const json = JSON.stringify(trace, null, 2);
  const tmp = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmp, json, "utf8");
    fs.renameSync(tmp, filePath);
    return;
  } catch {
    // fall through to direct write
  }
  try {
    fs.writeFileSync(filePath, json, "utf8");
  } catch {
    // Trace flushing is best-effort; never fail the walk over it.
  }
}

export function loadTrace(filePath: string): ActionTrace {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as ActionTrace;
  if (raw.version !== 1 || !Array.isArray(raw.actions)) {
    throw new Error(`Not a valid action trace: ${filePath}`);
  }
  return raw;
}

/** A trace with a subset of actions (used by the shrinker). */
export function subTrace(trace: ActionTrace, keep: boolean[]): ActionTrace {
  return {
    ...trace,
    actions: trace.actions.filter((_, i) => keep[i]),
  };
}
