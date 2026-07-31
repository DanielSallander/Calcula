//! FILENAME: app/src/api/scriptConnectors.ts
// PURPOSE: The TRUSTED connector host for script-fed data sources
//          (model-extensibility Phase 3). A sandboxed connector script
//          registers itself (broker cap.connectorRegister, behind the
//          bi.connector capability + consent) and EXPOSES a `fetchTable`
//          method; this host orchestrates the feed cycle:
//              call the script's fetchTable in its worker realm
//              -> validate the row shape
//              -> hand rows to the Rust bi_script_source gate (which re-checks
//                 the grant, caps volume, materializes an in-memory engine
//                 source, and refreshes the bound tables).
//          The engine never calls into JS; secrets never enter the JS realm
//          (the script names a slot; net_commands.rs injects server-side).
// CONTEXT: design docs/design/model-extensibility.md §7. The live registry is
//          session-scoped: a connector script re-registers on mount
//          (idempotent install), which also re-arms its refresh schedule.
//
// REFRESH SCHEDULING (changed): `refreshEverySecs` used to arm a renderer-side
// setInterval that died at unmount — while the SAME number was being persisted
// into the model's extension_data (bi/script_source.rs), where nothing ever
// consumed it. The declared schedule and the running schedule were two
// different things, and only the ephemeral one had any effect.
//
// It now drives the persistent scheduler (scriptHost/scheduler.ts + the Rust
// script_scheduler command), so the persisted number IS the schedule: it
// survives unmount and reload, the user can see and cancel it in the
// transparency panel, and every refresh is audited and re-checked against the
// live grant. The 30s floor is unchanged (and re-applied in Rust).

import { invokeBackend } from "./backend";
import { callExposedMethod } from "./scriptableObjects";
import {
  scheduleEvery,
  cancelScheduledJobForScript,
  listScheduledJobsForScript,
} from "./scriptHost/scheduler";

/** One table a connector feeds (columns are the authoritative schema). */
export interface ScriptConnectorTableDef {
  name: string;
  columns: Array<{ name: string; dataType: "string" | "number" | "boolean" | "date" }>;
  /** Connector-defined parameters passed back to fetchTable(request). */
  params?: Record<string, unknown>;
}

/** A connector registration (from the script's connector.register call). */
export interface ScriptConnectorDef {
  /** Stable, namespaced source id — must start with "script:". */
  sourceId: string;
  tables: ScriptConnectorTableDef[];
  /** Declared secret-slot names (values are entered by the USER via the
   *  Connector Secrets UI and never seen by the script). */
  secretSlots?: string[];
  /** Host-scheduler refresh interval; omit for manual refresh only. */
  refreshEverySecs?: number;
}

interface LiveConnector {
  scriptId: string;
  objectType: string;
  instanceId: string | null;
  connectionId: string;
  def: ScriptConnectorDef;
}

/** sourceId -> live registration (session-scoped; rebuilt on script mount).
 *  The SCHEDULE is no longer session-scoped — only the ability to SERVICE it
 *  is, which is why the scheduler refuses to fire a job whose script is not
 *  mounted rather than firing it into an empty registry. */
const live = new Map<string, LiveConnector>();

/** Floor on connector refresh cadence. Must agree with the scheduler's
 *  MIN_INTERVAL_SECS (Rust re-applies it regardless). */
const MIN_REFRESH_SECS = 30;

function validateDef(def: ScriptConnectorDef): void {
  if (!def || typeof def.sourceId !== "string" || !def.sourceId.startsWith("script:")) {
    throw new Error("Connector sourceId must be a string starting with 'script:'");
  }
  if (!Array.isArray(def.tables) || def.tables.length === 0) {
    throw new Error("A connector must declare at least one table");
  }
  for (const t of def.tables) {
    if (!t?.name || !Array.isArray(t.columns) || t.columns.length === 0) {
      throw new Error(`Connector table '${t?.name ?? "?"}' must declare columns`);
    }
  }
}

/**
 * Drop a connector's persisted refresh job.
 *
 * Best-effort: failing to cancel must never fail the connector operation that
 * asked for it. A job left behind is harmless — the scheduler will not fire it
 * once the source is gone (the refresh throws, is recorded as a failed run, and
 * the user can cancel it from the transparency panel).
 */
async function cancelRefreshJob(lc: LiveConnector | undefined): Promise<void> {
  if (!lc) return;
  try {
    const jobs = await listScheduledJobsForScript(lc.scriptId);
    for (const job of jobs) {
      if (job.surface === "connector" && job.handler === lc.def.sourceId) {
        await cancelScheduledJobForScript(lc.scriptId, job.id);
      }
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Register (or re-register) a connector on behalf of its OWNING script — the
 * cap.connectorRegister broker executor calls this with the authoritative
 * script identity (never script-supplied). Installs the source + binding via
 * the Rust gate (one undoable model edit), runs an initial fetch, and arms
 * the refresh schedule.
 */
export async function registerScriptConnectorForScript(
  scriptId: string,
  objectType: string,
  instanceId: string | null,
  connectionId: string,
  def: ScriptConnectorDef,
): Promise<{ sourceId: string }> {
  validateDef(def);
  await invokeBackend("bi_script_source", {
    connectionId,
    scriptId,
    op: "install",
    sourceId: def.sourceId,
    tables: def.tables,
    secretSlots: def.secretSlots ?? [],
    refreshEverySecs: def.refreshEverySecs ?? null,
    table: null,
    rows: null,
  });

  const lc: LiveConnector = { scriptId, objectType, instanceId, connectionId, def };
  live.set(def.sourceId, lc);

  // Initial feed (errors propagate to the registering script so it can react).
  await refreshScriptConnector(def.sourceId);

  if (def.refreshEverySecs && def.refreshEverySecs > 0) {
    const secs = Math.max(MIN_REFRESH_SECS, Math.floor(def.refreshEverySecs));
    // Re-registration is idempotent in the scheduler (same script + surface +
    // handler + cadence updates the existing job), so a remount re-arms the
    // one persistent job instead of stacking a second.
    //
    // Best-effort on purpose: a connector whose SCHEDULE could not be armed is
    // still a working connector with a working manual refresh, and failing the
    // whole registration would be a worse outcome than an unscheduled one. The
    // usual cause is the script not holding `schedule` — which is exactly the
    // case where refusing to schedule is the correct behaviour, not an error.
    try {
      await scheduleEvery(
        {
          scriptId,
          surface: "connector",
          objectType,
          instanceId,
        },
        secs,
        def.sourceId,
        `Refresh ${def.sourceId}`,
      );
    } catch (e) {
      console.warn(
        `[scriptConnectors] could not arm the persistent refresh for ${def.sourceId} ` +
          `(the connector still works; refresh it manually or grant the 'schedule' capability):`,
        e,
      );
    }
  } else {
    // Cadence removed on re-registration — drop any job a previous
    // registration left behind rather than leaving an orphan firing.
    await cancelRefreshJob(lc);
  }
  return { sourceId: def.sourceId };
}

/**
 * Run one feed cycle for a registered connector: fetchTable in the owning
 * script's worker realm per declared table, then hand the rows to the Rust
 * gate. Refresh only works while the owning script is mounted (the live
 * registry is session-scoped) — a connector script re-registers on mount.
 */
export async function refreshScriptConnector(sourceId: string): Promise<void> {
  const lc = live.get(sourceId);
  if (!lc) {
    throw new Error(
      `Script connector '${sourceId}' is not live in this session (its script may not be mounted)`,
    );
  }
  for (const t of lc.def.tables) {
    const result = (await callExposedMethod(lc.objectType, lc.instanceId, "fetchTable", {
      table: t.name,
      params: t.params ?? {},
    })) as { rows?: unknown } | undefined;
    const rows = result?.rows;
    if (!Array.isArray(rows) || rows.some((r) => !Array.isArray(r))) {
      throw new Error(
        `Connector '${sourceId}': fetchTable('${t.name}') must return { rows: unknown[][] }`,
      );
    }
    await invokeBackend("bi_script_source", {
      connectionId: lc.connectionId,
      scriptId: lc.scriptId,
      op: "feedRows",
      sourceId,
      table: t.name,
      rows,
      tables: null,
      secretSlots: null,
      refreshEverySecs: null,
    });
  }
}

/**
 * Remove a connector on behalf of its owning script (cap.connectorRemove):
 * drops the binding, its fed tables and the catalog entry (one undoable model
 * edit in the Rust gate), and disarms the schedule.
 */
export async function removeScriptConnectorForScript(
  scriptId: string,
  connectionId: string,
  sourceId: string,
): Promise<void> {
  await invokeBackend("bi_script_source", {
    connectionId,
    scriptId,
    op: "removeBind",
    sourceId,
    tables: null,
    secretSlots: null,
    refreshEverySecs: null,
    table: null,
    rows: null,
  });
  await cancelRefreshJob(live.get(sourceId));
  live.delete(sourceId);
}

/** The session's live connectors (transparency / manual-refresh UI). */
export function listScriptConnectors(): Array<{
  sourceId: string;
  scriptId: string;
  connectionId: string;
  tables: string[];
  refreshEverySecs?: number;
}> {
  return [...live.values()].map((lc) => ({
    sourceId: lc.def.sourceId,
    scriptId: lc.scriptId,
    connectionId: lc.connectionId,
    tables: lc.def.tables.map((t) => t.name),
    refreshEverySecs: lc.def.refreshEverySecs,
  }));
}

/**
 * Forget the session registry (workbook close).
 *
 * Deliberately does NOT cancel the scheduled refresh jobs: they are persisted
 * workbook state, and closing a workbook must not silently erase the schedule
 * the user consented to. The scheduler's own reset clears the in-memory job
 * list at workbook close, and the mount check stops anything from firing in
 * the meantime.
 */
export function resetScriptConnectors(): void {
  live.clear();
}

// ---------------------------------------------------------------------------
// Connector secrets (privileged user-UI wrappers; the broker never routes
// here — connector_secrets sits in the `credentials` denylist group).
// ---------------------------------------------------------------------------

/** The declared slots of a connector with an isSet flag (never values). */
export async function connectorSecretsList(
  sourceId: string,
): Promise<Array<{ slot: string; isSet: boolean }>> {
  return invokeBackend("connector_secrets", { op: "list", sourceId, slot: null, value: null });
}

/** Store one secret value for a declared slot (OS credential store). */
export async function connectorSecretsSet(
  sourceId: string,
  slot: string,
  value: string,
): Promise<void> {
  await invokeBackend("connector_secrets", { op: "set", sourceId, slot, value });
}

/** Delete one stored secret. */
export async function connectorSecretsDelete(sourceId: string, slot: string): Promise<void> {
  await invokeBackend("connector_secrets", { op: "delete", sourceId, slot, value: null });
}
