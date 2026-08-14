// FILENAME: app/extensions/ModelEditor/cli/execute.ts
// PURPOSE: Command-run orchestration for the Model Editor CLI, now a typed
//          wrapper over the shared CLI engine (_shared/cli/engine.ts) running
//          the single MODEL domain. The public surface (CliSession,
//          createSession, planRun, executeRun, RunPlan, RunOutcome) is
//          unchanged — the panel and the tests drive it exactly as before;
//          the engine underneath is the same one the main-window CLI uses.

import type { ModelMeasureInfo, ModelOverview } from "@api";
import { CliError } from "./lex";
import type { Command } from "./parse";
import type { CliGateway } from "./gateway";
import { createCliEngine } from "../../_shared/cli/engine";
import type { CliEngine } from "../../_shared/cli/engine";
import type { CliIo } from "../../_shared/cli/registry";
import { createModelDomain } from "./modelDomain";

export type { CliIo };

/** Mutable state threaded through one run. `overview` is kept fresh from
 *  every mutation result so later commands (and wildcard re-expansion)
 *  operate on what earlier commands produced. */
export interface CliSession {
  connectionId: string;
  overview: ModelOverview;
  readOnly: boolean;
  gateway: CliGateway;
  /** True once any undoable model edit ran (drives batch bookkeeping). */
  hadEdits: boolean;
  /** True once the on-screen overview may differ from `overview` at entry. */
  overviewDirty: boolean;
  /** True when a failed batch run was rolled back (the restored overview is
   *  already installed on the session). */
  rolledBack: boolean;
}

export function createSession(
  connectionId: string,
  overview: ModelOverview,
  readOnly: boolean,
  gateway: CliGateway,
): CliSession {
  return {
    connectionId,
    overview,
    readOnly,
    gateway,
    hadEdits: false,
    overviewDirty: false,
    rolledBack: false,
  };
}

/** The fused engine with this session's model domain bound. */
export function createModelEngine(s: CliSession): CliEngine {
  return createCliEngine([{ domain: createModelDomain(), session: s }], "model");
}

// ---------------------------------------------------------------------------
// Session mutation helpers (used by writers.ts)
// ---------------------------------------------------------------------------

export function requireWritable(s: CliSession, line: number): void {
  if (s.readOnly) {
    throw new CliError("The model is read-only — edits are not allowed", line);
  }
}

/** Run one overview-returning edit and install its result on the session. */
export async function mutOverview(
  s: CliSession,
  fn: () => Promise<ModelOverview>,
): Promise<void> {
  s.overview = await fn();
  s.hadEdits = true;
  s.overviewDirty = true;
}

/** Run one measures-returning edit and patch the session's measure list. */
export async function mutMeasures(
  s: CliSession,
  fn: () => Promise<ModelMeasureInfo[]>,
): Promise<void> {
  const measures = await fn();
  s.overview = { ...s.overview, measures };
  s.hadEdits = true;
  s.overviewDirty = true;
}

// ---------------------------------------------------------------------------
// Run planning / execution (typed wrappers over the shared engine)
// ---------------------------------------------------------------------------

export interface RunPlan {
  commands: Command[];
  /** One label per planned write (wildcards expanded against the CURRENT
   *  model — a script's later lines may shift what re-expands at run time). */
  writeLabels: string[];
  /** True when any write target used a * / ? wildcard. */
  hasWildcard: boolean;
  /** Confirmation required before executing (multi-write or wildcard). */
  needsConfirm: boolean;
  /** The engine plan executeRun replays (carried opaquely). */
  engine: CliEngine;
  enginePlan: import("../../_shared/cli/engine").RunPlan;
}

/** Parse + statically preview a run. Throws CliError on parse/lookup errors. */
export function planRun(text: string, s: CliSession): RunPlan {
  const engine = createModelEngine(s);
  const plan = engine.planRun(text);
  return {
    commands: plan.items.map((i) => i.cmd as Command),
    writeLabels: plan.writeLabels,
    hasWildcard: plan.hasWildcard,
    needsConfirm: plan.needsConfirm,
    engine,
    enginePlan: plan,
  };
}

export interface RunOutcome {
  ok: boolean;
  /** Fresh overview to install in the host app (null = nothing changed). */
  overview: ModelOverview | null;
}

/** Execute a planned run sequentially. Multi-write runs open a backend batch:
 *  the whole run is one undo step, and any error rolls everything back. */
export async function executeRun(
  plan: RunPlan,
  s: CliSession,
  io: CliIo,
): Promise<RunOutcome> {
  const { ok } = await plan.engine.executeRun(plan.enginePlan, io);
  if (!ok && s.rolledBack) {
    // The batch strategy already installed the restored overview.
    s.rolledBack = false;
    return { ok, overview: s.overview };
  }
  // Success (or an unbatched failure): hand the host ONE fresh overview for
  // the whole run (measure renames can ripple into KPIs etc., so re-read
  // rather than trust patches).
  return { ok, overview: s.overviewDirty ? await refreshOverview(s) : null };
}

async function refreshOverview(s: CliSession): Promise<ModelOverview> {
  try {
    s.overview = await s.gateway.getOverview(s.connectionId);
  } catch {
    // Keep the locally patched overview when the re-read fails.
  }
  return s.overview;
}
