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

import { invokeBackend } from "./backend";
import { callExposedMethod } from "./scriptableObjects";

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
  timer: ReturnType<typeof setInterval> | null;
}

/** sourceId -> live registration (session-scoped; rebuilt on script mount). */
const live = new Map<string, LiveConnector>();

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

function clearTimer(lc: LiveConnector | undefined): void {
  if (lc?.timer != null) {
    clearInterval(lc.timer);
    lc.timer = null;
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

  clearTimer(live.get(def.sourceId));
  const lc: LiveConnector = { scriptId, objectType, instanceId, connectionId, def, timer: null };
  live.set(def.sourceId, lc);

  // Initial feed (errors propagate to the registering script so it can react).
  await refreshScriptConnector(def.sourceId);

  if (def.refreshEverySecs && def.refreshEverySecs > 0) {
    const secs = Math.max(MIN_REFRESH_SECS, Math.floor(def.refreshEverySecs));
    lc.timer = setInterval(() => {
      void refreshScriptConnector(def.sourceId).catch((e) => {
        console.warn(`[scriptConnectors] scheduled refresh of ${def.sourceId} failed:`, e);
      });
    }, secs * 1000);
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
  clearTimer(live.get(sourceId));
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

/** Disarm every schedule and forget the session registry (workbook close). */
export function resetScriptConnectors(): void {
  for (const lc of live.values()) clearTimer(lc);
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
