//! FILENAME: app/src/api/scriptHost/allowlist.ts
// PURPOSE: The tier/capability policy for every method object scripts can
//          call (design: docs/design/script-sandbox-architecture.md §5.1).
// CONTEXT: This ONE object is consumed by (1) broker dispatch, (2) the
//          transparency panel, (3) consent-dialog text — the policy users
//          see is the object the broker executes, so drift is impossible.

import {
  vAny, vNotify, vExpose, vCall, vHook, vGetState, vSetState, vDecl, vNone,
  vHtml, vCellRef, vCellSet, vBatch, vIndex, vEvent, vCommand, vFetch, vSql,
  vKey, vKV, vUdf, type Validator,
} from "./validators";
import { AppEvents } from "../events";
import type { CapabilityId } from "./capabilityIds";

// CapabilityId now lives in the single-source-of-truth module (capabilityIds.ts);
// re-exported here so the many existing `import { CapabilityId } from "./allowlist"`
// consumers keep working unchanged.
export type { CapabilityId };

export type Tier = "restricted" | "unlocked";
export type MethodClass = "read" | "mutate" | "emit" | "net";

export interface MethodPolicy {
  /** Minimum tier ("restricted" = every script may call it). */
  tier: Tier;
  /** Additionally required capability grant. */
  capability?: CapabilityId;
  class: MethodClass;
  validate: Validator;
  limits?: Record<string, number>;
  /** Rendered verbatim in the transparency panel and consent UI. */
  desc: string;
}

export const ALLOWLIST: Record<string, MethodPolicy> = {
  // ---- base: every script ----
  "base.log":              { tier: "restricted", class: "emit",   validate: vAny,      desc: "Write to the script console" },
  "base.notify":           { tier: "restricted", class: "emit",   validate: vNotify,   desc: "Show a toast notification" },
  "base.expose":           { tier: "restricted", class: "emit",   validate: vExpose,   desc: "Expose a method to other scripts" },
  "base.callMethod":       { tier: "restricted", class: "emit",   validate: vCall,     desc: "Call a method exposed by another script (cross-tier requires the target to be public)" },
  "events.subscribe":      { tier: "restricted", class: "read",   validate: vHook,     desc: "Listen to its object's events" },
  // ---- own-object scope (instance pinned at mount; a script cannot name another instance) ----
  "object.getState":       { tier: "restricted", class: "read",   validate: vGetState, desc: "Read its own object's properties / selection / spec" },
  "object.setState":       { tier: "restricted", class: "mutate", validate: vSetState, desc: "Change its own object (slicer selection, shape properties, chart spec, panel badge, ...)" },
  "object.declareProperties": { tier: "restricted", class: "mutate", validate: vDecl,  desc: "Declare custom properties (shapes)" },
  "render.invalidate":     { tier: "restricted", class: "emit",   validate: vNone,     desc: "Request a re-render of its own visuals" },
  // ui.html is auto-granted for local scripts; consent-gated for distributed
  // ones (wired in Phase 4 — until then the gate is provenance-based).
  "render.setHtml":        { tier: "restricted", capability: "ui.html", class: "mutate", validate: vHtml, desc: "Render sandboxed HTML inside its shape" },
  "sheet.getCellValue":    { tier: "restricted", class: "read",   validate: vCellRef,  desc: "Read cells on its own sheet (sheet scripts; clamped to the bound sheet)" },
  "sheet.setCellValue":    { tier: "restricted", class: "mutate", validate: vCellSet,  desc: "Write cells on its own sheet (sheet scripts; clamped to the bound sheet)" },
  // ---- unlocked: whole-workbook reach ----
  "api.getCellValue":      { tier: "unlocked", class: "read",   validate: vCellRef,  desc: "Read any cell" },
  "api.setCellValue":      { tier: "unlocked", class: "mutate", validate: vCellSet,  desc: "Write any cell" },
  "api.updateCellsBatch":  { tier: "unlocked", class: "mutate", validate: vBatch,    limits: { maxCells: 100_000 }, desc: "Write many cells at once" },
  "api.getSheetNames":     { tier: "unlocked", class: "read",   validate: vNone,     desc: "List sheets" },
  "api.getActiveSheet":    { tier: "unlocked", class: "read",   validate: vNone,     desc: "Read the active sheet" },
  "api.setActiveSheet":    { tier: "unlocked", class: "mutate", validate: vIndex,    desc: "Switch sheets" },
  "api.emitEvent":         { tier: "unlocked", class: "emit",   validate: vEvent,    desc: "Emit a custom app event (auto-namespaced userscript:*)" },
  "api.onEvent":           { tier: "unlocked", class: "read",   validate: vHook,     desc: "Listen for custom events (userscript:*) and a read-only set of app events" },
  "api.executeCommand":    { tier: "unlocked", class: "mutate", validate: vCommand,  desc: "Run commands flagged scriptSafe by their extension" },
  "api.beginBatch":        { tier: "unlocked", class: "mutate", validate: vAny,      desc: "Group changes for undo" },
  "api.commitBatch":       { tier: "unlocked", class: "mutate", validate: vNone,     desc: "Commit a grouped change" },
  "api.cancelBatch":       { tier: "unlocked", class: "mutate", validate: vNone,     desc: "Cancel a grouped change" },
  // ---- capabilities (grantable to restricted scripts via consent / JIT — Phase 4) ----
  "cap.fetch":             { tier: "restricted", capability: "net.fetch", class: "net",
                             validate: vFetch, limits: { maxResponseBytes: 5_242_880, perMinute: 10 },
                             desc: "Fetch from the granted web origins (https only, no cookies)" },
  "cap.biQuery":           { tier: "restricted", capability: "bi.query", class: "net",
                             validate: vSql, limits: { maxRows: 100_000 },
                             desc: "Run read-only queries on this workbook's BI connections" },
  "cap.storageGet":        { tier: "restricted", capability: "storage", class: "read",
                             validate: vKey, desc: "Read script-private data stored in the workbook" },
  "cap.storageSet":        { tier: "restricted", capability: "storage", class: "mutate",
                             validate: vKV, limits: { maxBytes: 262_144 },
                             desc: "Store script-private data in the workbook (quota 256 KB)" },
  // ---- formula UDF (Wave 3 / C1): a registered user-defined function invoked
  //      from a worksheet formula. Restricted-tier + the formula.udf capability,
  //      so a distributed script's UDFs cannot run without package consent; the
  //      JS impl executes in its owning script's realm through this one method,
  //      giving the same audit + R19 ceiling every other privileged call gets. ----
  "formula.udf.invoke":    { tier: "restricted", capability: "formula.udf", class: "read",
                             validate: vUdf, limits: { maxArgs: 255 },
                             desc: "Evaluate a registered user-defined formula function" },
  // ---- worker-realm extensions (Wave 3 / S8-C7 Phase B): a distributed
  //      extension running sandboxed in a worker reaches the host ONLY through
  //      these restricted-tier methods, audited like every other broker call.
  //      (Capability-bearing reach — net/storage — uses the cap.* rows above.) ----
  "ext.notify":            { tier: "restricted", class: "emit",   validate: vNotify,  desc: "Show a toast notification" },
  "ext.log":               { tier: "restricted", class: "emit",   validate: vAny,     desc: "Write to the extension console" },
  "ext.executeCommand":    { tier: "restricted", class: "mutate", validate: vCommand, desc: "Run a command flagged scriptSafe by its extension" },
  "ext.emitEvent":         { tier: "restricted", class: "emit",   validate: vEvent,   desc: "Emit a custom app event (auto-namespaced userscript:*)" },
};

/**
 * App events that unlocked scripts may subscribe to RAW (read-only
 * notifications). Anything else passed to api.onEvent is treated as a custom
 * name and force-namespaced to userscript:* — symmetric with api.emitEvent,
 * so scripts can never observe (or forge) internal control events.
 */
export const SCRIPT_SUBSCRIBABLE_APP_EVENTS: ReadonlySet<string> = new Set([
  AppEvents.SHEET_CHANGED,
  AppEvents.CELL_VALUES_CHANGED,
  AppEvents.SELECTION_CHANGED,
  AppEvents.AFTER_OPEN,
  AppEvents.AFTER_SAVE,
  AppEvents.AFTER_NEW,
  AppEvents.THEME_CHANGED,
  AppEvents.EDIT_STARTED,
  AppEvents.EDIT_ENDED,
  AppEvents.ROWS_INSERTED,
  AppEvents.ROWS_DELETED,
  AppEvents.COLUMNS_INSERTED,
  AppEvents.COLUMNS_DELETED,
  AppEvents.ROW_RESIZED,
  AppEvents.COLUMN_RESIZED,
]);
