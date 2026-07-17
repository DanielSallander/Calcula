// FILENAME: app/extensions/ModelEditor/cli/execute.ts
// PURPOSE: Command-run orchestration for the Model Editor CLI. Parses a run
//          (one prompt line or a whole script), previews its writes for the
//          confirmation step, then executes sequentially. Multi-write runs are
//          wrapped in a backend edit batch: ONE undo step, all-or-nothing
//          (any error rolls the whole run back via bi_model_batch_cancel).

import type { ModelMeasureInfo, ModelOverview } from "@api";
import { CliError } from "./lex";
import { parseScript } from "./parse";
import type { Command } from "./parse";
import type { CliGateway } from "./gateway";
import { runRead } from "./readers";
import { previewWriteCommand, runWrite } from "./writers";
import { helpText } from "./help";

export interface CliIo {
  /** Append a block of output. cls: "out" (default) | "err" | "info". */
  print(text: string, cls?: "out" | "err" | "info"): void;
  clear(): void;
}

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
}

export function createSession(
  connectionId: string,
  overview: ModelOverview,
  readOnly: boolean,
  gateway: CliGateway,
): CliSession {
  return { connectionId, overview, readOnly, gateway, hadEdits: false, overviewDirty: false };
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
// Run planning
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
}

/** Parse + statically preview a run. Throws CliError on parse/lookup errors. */
export function planRun(text: string, s: CliSession): RunPlan {
  const commands = parseScript(text);
  if (commands.length === 0) throw new CliError("Nothing to run");

  const undoRedo = commands.filter((c) => c.verb === "undo" || c.verb === "redo");
  if (undoRedo.length > 0 && commands.length > 1) {
    throw new CliError(
      "undo/redo must be run on their own (a batched script would swallow the step they restore)",
      undoRedo[0].line,
    );
  }

  const writeLabels: string[] = [];
  let hasWildcard = false;
  for (const cmd of commands) {
    const w = previewWriteCommand(cmd, s);
    if (w !== null) {
      writeLabels.push(...w.labels);
      hasWildcard = hasWildcard || w.wildcard;
    }
  }
  return {
    commands,
    writeLabels,
    hasWildcard,
    needsConfirm: writeLabels.length > 1 || hasWildcard,
  };
}

// ---------------------------------------------------------------------------
// Run execution
// ---------------------------------------------------------------------------

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
  const g = s.gateway;
  const useBatch = plan.writeLabels.length > 1 && !s.readOnly;
  let batchOpen = false;

  if (useBatch) {
    await g.batchBegin(s.connectionId);
    batchOpen = true;
  }
  try {
    for (const cmd of plan.commands) {
      await execCommand(cmd, s, io);
    }
    if (batchOpen) {
      batchOpen = false;
      await g.batchEnd(s.connectionId, s.hadEdits);
    }
  } catch (e) {
    const msg = e instanceof CliError && e.line !== null ? `line ${e.line}: ${errText(e)}` : errText(e);
    if (batchOpen) {
      batchOpen = false;
      try {
        const restored = await g.batchCancel(s.connectionId);
        s.overview = restored;
        io.print(`Error — ${msg}`, "err");
        io.print("All changes from this run were rolled back.", "info");
        return { ok: false, overview: restored };
      } catch (cancelErr) {
        io.print(`Error — ${msg}`, "err");
        io.print(`Rollback also failed: ${errText(cancelErr)}`, "err");
        return { ok: false, overview: await refreshOverview(s) };
      }
    }
    io.print(`Error — ${msg}`, "err");
    // No batch: a partial single-write run may still have changed the model.
    return { ok: false, overview: s.overviewDirty ? await refreshOverview(s) : null };
  }

  // Success: hand the host ONE fresh overview for the whole run (measure
  // renames can ripple into KPIs etc., so re-read rather than trust patches).
  return { ok: true, overview: s.overviewDirty ? await refreshOverview(s) : null };
}

async function refreshOverview(s: CliSession): Promise<ModelOverview> {
  try {
    s.overview = await s.gateway.getOverview(s.connectionId);
  } catch {
    // Keep the locally patched overview when the re-read fails.
  }
  return s.overview;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function execCommand(cmd: Command, s: CliSession, io: CliIo): Promise<void> {
  switch (cmd.verb) {
    case "help":
      io.print(helpText(cmd.pos.map((t) => t.text)));
      return;
    case "clear":
      io.clear();
      return;
    case "undo": {
      s.overview = await s.gateway.undo(s.connectionId);
      s.overviewDirty = true;
      io.print("Undone.", "info");
      return;
    }
    case "redo": {
      s.overview = await s.gateway.redo(s.connectionId);
      s.overviewDirty = true;
      io.print("Redone.", "info");
      return;
    }
    case "ls":
    case "show":
    case "validate":
      await runRead(cmd, s, io);
      return;
    default:
      await runWrite(cmd, s, io);
      return;
  }
}
