//! FILENAME: app/src/api/scriptHost/broker.ts
// PURPOSE: The tier broker (design §5) — the single mediation point for
//          every sanctioned object-script call. Enforcement order per call:
//          method in ALLOWLIST -> static arg validation (BEFORE the tier
//          check, so error messages can't probe policy) -> tier check ->
//          capability check -> limits -> execute -> audit-ring append.
// CONTEXT: Phase 2 — scripts still execute on the main thread; context
//          builders in scriptableObjects.ts route their calls here so the
//          policy lands and soaks before the worker realm (Phase 3) does.
//          In Phase 3 the script identity arrives with the worker port; in
//          Phase 2 it is the ScriptHandle the context builder closed over.

import { ALLOWLIST, SCRIPT_SUBSCRIBABLE_APP_EVENTS, type CapabilityId, type MethodPolicy } from "./allowlist";
import { CAPABILITY_ID_SET } from "./capabilityIds";
import { appendAudit } from "./auditRing";
import { getGrantSet } from "./capabilities";
import { USERSCRIPT_EVENT_PREFIX, namespaceUserEvent } from "../events";
import { invokeBackend } from "../backend";

// ============================================================================
// Script identity
// ============================================================================

export type ScriptTier = "restricted" | "unlocked";

/**
 * Host-side identity of a mounted script. Built by the host from the
 * authoritative registry at mount time — NEVER from anything the script
 * sends. (Phase 3: keyed by worker port.)
 */
export interface ScriptHandle {
  scriptId: string;
  scriptName: string;
  tier: ScriptTier;
  objectType: string;
  instanceId: string | null;
  /**
   * Trust origin for cross-script policy: "local" for locally authored
   * scripts, the package name for distributed ones.
   */
  origin: string;
  /** Granted capabilities (Phase 4 wires consent/JIT grants; ui.html is auto for local). */
  grants: ReadonlySet<CapabilityId>;
  /**
   * The R19 declared-capability CEILING. A capability not in this set is denied
   * (PermissionDenied) BEFORE the grant check, so a script can never use — nor
   * even be JIT-prompted for — a capability it did not declare. For local
   * scripts this is the source pragmas plus auto "ui.html"; for distributed
   * scripts it is exactly what the package manifest declared.
   */
  declaredCapabilities: ReadonlySet<CapabilityId>;
}

/** The recognized capability ids. Single source of truth: capabilityIds.ts
 *  (was duplicated here and in capabilities.ts pre-Wave 3). Used to filter the
 *  declared set so an unknown id from any source can never enter the ceiling. */
const VALID_CAPABILITY_IDS: ReadonlySet<CapabilityId> = CAPABILITY_ID_SET;

export type RpcErrorCode =
  | "PermissionDenied"
  | "CapabilityRequired"
  | "ValidationError"
  | "Timeout"
  | "HostError"
  | "UnknownMethod";

/** Error type thrown by the broker — scripts can inspect `code` to degrade gracefully. */
export class BrokerError extends Error {
  code: RpcErrorCode;
  capability?: CapabilityId;
  constructor(code: RpcErrorCode, message: string, capability?: CapabilityId) {
    super(message);
    this.name = "BrokerError";
    this.code = code;
    this.capability = capability;
  }
}

/**
 * Build the host-side identity for a script from its authoritative
 * definition — never from anything the script supplies. Single source of
 * truth for tier/origin/grant derivation (used by both the legacy
 * main-thread mount path and the worker host).
 */
export function buildHandleFromDefinition(definition: {
  id: string;
  name: string;
  objectType: string;
  instanceId: string | null;
  accessLevel: string;
  provenance?: string;
  packageName?: string;
  /** The authoritative declared-capability ceiling (R19). For distributed
   *  scripts this is the manifest set; for local scripts the source pragmas. */
  declaredCapabilities?: string[];
}): ScriptHandle {
  const isDistributed = definition.provenance === "distributed";
  // grants is the LIVE per-script set owned by capabilities.ts — so a JIT or
  // consent grant recorded after mount takes effect for checkPolicy without
  // rebuilding the handle. ui.html is auto-granted for local scripts;
  // distributed scripts acquire it (and every other cap) only through consent.
  const grants = getGrantSet(definition.id);
  if (!isDistributed) {
    grants.add("ui.html");
  }
  // R19 ceiling. Filter to recognized cap ids so an unknown/garbage id from any
  // source can never enter the ceiling. ui.html is auto for LOCAL scripts, so
  // declare it too — otherwise the auto-granted local ui.html grant would be
  // rejected by its own ceiling. For distributed scripts ui.html is in the
  // ceiling only when the manifest declared it.
  const declaredCapabilities = new Set<CapabilityId>();
  for (const cap of definition.declaredCapabilities ?? []) {
    if (VALID_CAPABILITY_IDS.has(cap as CapabilityId)) {
      declaredCapabilities.add(cap as CapabilityId);
    }
  }
  if (!isDistributed) {
    declaredCapabilities.add("ui.html");
  }
  return {
    scriptId: definition.id,
    scriptName: definition.name,
    tier: definition.accessLevel === "unlocked" ? "unlocked" : "restricted",
    objectType: definition.objectType,
    instanceId: definition.instanceId,
    origin: isDistributed ? (definition.packageName || "(unknown package)") : "local",
    grants,
    declaredCapabilities,
  };
}

// ============================================================================
// Policy check (shared by sync + async dispatch)
// ============================================================================

function checkPolicy(handle: ScriptHandle, method: string, args: unknown[]): MethodPolicy {
  const policy = ALLOWLIST[method];
  if (!policy) {
    audit(handle, method, "emit", false, "UnknownMethod");
    throw new BrokerError("UnknownMethod", `Unknown script method: ${method}`);
  }

  // Validation FIRST (before tier) so error messages can't probe policy.
  const valid = policy.validate(args);
  if (valid !== true) {
    audit(handle, method, policy.class, false, "ValidationError");
    throw new BrokerError("ValidationError", `${method}: ${valid}`);
  }

  if (policy.tier === "unlocked" && handle.tier !== "unlocked") {
    audit(handle, method, policy.class, false, "PermissionDenied");
    throw new BrokerError(
      "PermissionDenied",
      `${method} requires unlocked access; this script is restricted`,
    );
  }

  // R19 ceiling: a capability the script never DECLARED can never be used —
  // denied here (PermissionDenied) before the grant check, so it is also never
  // JIT-prompted. A distributed script's tampered source can't widen this set;
  // the ceiling came from the package manifest.
  if (policy.capability && !handle.declaredCapabilities.has(policy.capability)) {
    audit(handle, method, policy.class, false, "PermissionDenied");
    throw new BrokerError(
      "PermissionDenied",
      `${method} requires the '${policy.capability}' capability, which this script did not declare`,
      policy.capability,
    );
  }

  if (policy.capability && !handle.grants.has(policy.capability)) {
    audit(handle, method, policy.class, false, "CapabilityRequired");
    throw new BrokerError(
      "CapabilityRequired",
      `${method} requires the '${policy.capability}' capability`,
      policy.capability,
    );
  }

  return policy;
}

/**
 * Methods whose backend-reaching Rust gate records the call ITSELF (authoritative
 * server-side audit: success + the gate's own denial). The broker must NOT also
 * persist their invoke results, or each call double-records. It DOES still
 * persist their broker-side POLICY denials (which never reach the gate).
 *
 * A MAP, not a set, because the value is the evidence: each entry names the Rust
 * gate whose `record_capability_call` makes the broker's own write redundant. An
 * entry with no such gate is a SILENT AUDIT HOLE — the broker skips the write and
 * nobody else makes it — so the reason has to be checkable, and
 * `__tests__/serverAuditedMethods.test.ts` checks it.
 *
 * THIS SET WENT STALE ONCE. It was written in Wave A/B and never extended, so
 * every gate Waves C-I added (script_writeback, script_scheduler,
 * script_distribution, the cube UDFs, the bi.model diagnostics/batch actions)
 * double-recorded: one row from the Rust gate, one from the broker, for the same
 * call. The guard test now fails when a `cap.*` row is neither listed here nor
 * listed as broker-audited below, so the next gate cannot be forgotten.
 */
const SERVER_AUDITED_METHODS: ReadonlyMap<string, string> = new Map([
  ["cap.fetch", "script_http_fetch"],
  ["cap.biQuery", "bi_query"],
  ["cap.biSql", "script_bi_sql"],
  ["cap.biModelInfo", "script_bi_model (info)"],
  ["cap.biModelUpsert", "script_bi_model (upsert)"],
  ["cap.biModelDelete", "script_bi_model (delete)"],
  ["cap.biModelValidate", "script_bi_model (validate)"],
  ["cap.biModelLineage", "script_bi_model (lineage)"],
  ["cap.biModelBatch", "script_bi_model (batch)"],
  ["cap.connectorRegister", "bi_script_source (install)"],
  ["cap.connectorRemove", "bi_script_source (removeBind)"],
  ["cap.cubeValue", "cube_udf_value"],
  ["cap.cubeKpi", "cube_udf_kpi"],
  ["cap.cubeMembers", "cube_udf_members"],
  // script_writeback: always-on audit of the outcome (success + failure), plus
  // its own grant/publisher-key denials.
  ["cap.writebackListRegions", "script_writeback"],
  ["cap.writebackGetLayer", "script_writeback"],
  ["cap.writebackSaveDraft", "script_writeback"],
  ["cap.writebackSubmit", "script_writeback"],
  ["cap.writebackPreview", "script_writeback"],
  ["cap.writebackListSubmissions", "script_writeback"],
  ["cap.writebackReview", "script_writeback"],
  // script_distribution: same shape — step (8) audits both outcomes and every
  // earlier refusal.
  ["cap.pkgListRegistries", "script_distribution"],
  ["cap.pkgListSubscriptions", "script_distribution"],
  ["cap.pkgBrowse", "script_distribution"],
  ["cap.pkgInspect", "script_distribution"],
  ["cap.pkgPull", "script_distribution"],
  ["cap.pkgRefreshPreview", "script_distribution"],
  ["cap.pkgRefreshApply", "script_distribution"],
  ["cap.pkgPublishPreview", "script_distribution"],
  ["cap.pkgNextVersion", "script_distribution"],
  ["cap.pkgPublish", "script_distribution"],
  ["cap.pkgPublishModel", "script_distribution"],
  // script_scheduler records the three REGISTRATION ops on both outcomes.
  ["cap.scheduleEvery", "script_scheduler (every)"],
  ["cap.scheduleAt", "script_scheduler (at)"],
  ["cap.scheduleOnce", "script_scheduler (once)"],
  // The "cancel" arm records UNCONDITIONALLY (the former records-only-on-removed
  // gap is closed in Rust): a cancel naming a missing job, or another script's
  // job, is audited as a refusal — exactly the probing shape a trail exists to
  // show — while the broker still skips its own write to avoid double-recording
  // the real cancellations.
  ["cap.scheduleCancel", "script_scheduler (cancel; both outcomes)"],
]);

/**
 * The capability-bearing methods the BROKER is the only auditor for: they never
 * reach a Rust gate that records, so `persistCapabilityAudit` must write their
 * outcome or nothing will. Listed explicitly (with the reason) rather than left
 * as "everything not above", so adding a `cap.*` row is a decision somebody made
 * and a test can see, instead of a default nobody looked at.
 */
const BROKER_AUDITED_CAPABILITY_METHODS: ReadonlyMap<string, string> = new Map([
  ["render.setHtml", "renders in the host window; no backend call"],
  ["formula.udf.invoke", "runs in the UDF worker; no backend call"],
  ["cap.biListConnections", "bi_get_connections takes no scriptId and records nothing"],
  ["cap.scheduleList", "script_scheduler's 'list' arm records nothing (a read of own jobs)"],
  ["cap.dialogAlert", "host-window dialog; no backend call"],
  ["cap.dialogConfirm", "host-window dialog; no backend call"],
  ["cap.dialogPrompt", "host-window dialog; no backend call"],
  ["cap.dialogForm", "host-window dialog; no backend call"],
  ["cap.fileExportText", "native picker + write, driven from the host; not a gated command"],
  ["cap.fileImportText", "native picker + read, driven from the host; not a gated command"],
  ["cap.filePrintPdf", "native picker + host-side render; not a gated command"],
  ["cap.shortcutBind", "host-side shortcut registry; no backend call"],
  ["cap.shortcutUnbind", "host-side shortcut registry; no backend call"],
  ["cap.shortcutList", "host-side shortcut registry; no backend call"],
  ["cap.storageGet", "workbook VFS read through the host; not a capability-gated command"],
  ["cap.storageSet", "workbook VFS write through the host; not a capability-gated command"],
]);

/** Exported for the drift guard: every capability-bearing ALLOWLIST row must
 *  appear in exactly one of these two maps. */
export function capabilityAuditClassification(): {
  serverAudited: ReadonlyMap<string, string>;
  brokerAudited: ReadonlyMap<string, string>;
} {
  return { serverAudited: SERVER_AUDITED_METHODS, brokerAudited: BROKER_AUDITED_CAPABILITY_METHODS };
}

/** Broker-side policy denial codes — raised by checkPolicy BEFORE any backend gate. */
const BROKER_POLICY_CODES: ReadonlySet<string> = new Set([
  "UnknownMethod",
  "ValidationError",
  "PermissionDenied",
  "CapabilityRequired",
]);

/**
 * Persist a capability-call outcome into the per-workbook audit log (write-through
 * from the in-memory ring), so capability use survives reload. Fire-and-forget +
 * best-effort. Skips the backend-reaching caps' invoke results (recorded
 * server-side by their Rust gate) to avoid double-recording — but still persists
 * their broker-side policy denials, which the gate never sees.
 */
function persistCapabilityAudit(handle: ScriptHandle, method: string, ok: boolean, error?: string): void {
  // Only CAPABILITY-bearing methods are persisted (net.fetch / bi.query / bi.sql /
  // storage / ui.html / formula.udf). Grid reads/writes, log, notify etc. carry no
  // capability and are NOT persisted here — they would flood the log, and script
  // grid mutations are already audited server-side as ScriptExecuted.
  const capability = ALLOWLIST[method]?.capability;
  if (!capability) return;
  if (SERVER_AUDITED_METHODS.has(method)) {
    const isBrokerPolicyDenial = ok === false && error !== undefined && BROKER_POLICY_CODES.has(error);
    if (!isBrokerPolicyDenial) return; // success + gate-denial are recorded server-side
  }
  void invokeBackend("audit_record_capability", {
    scriptId: handle.scriptId,
    capability,
    ok,
    error,
  }).catch(() => {
    /* audit is best-effort; never fail a capability call because persistence failed */
  });
}

function audit(
  handle: ScriptHandle,
  method: string,
  cls: MethodPolicy["class"],
  ok: boolean,
  error?: string,
): void {
  appendAudit({
    ts: Date.now(),
    scriptId: handle.scriptId,
    scriptName: handle.scriptName,
    method,
    class: cls,
    ok,
    error,
  });
  persistCapabilityAudit(handle, method, ok, error);
}

// ============================================================================
// Dispatch
// ============================================================================

/**
 * Mediate a synchronous, fire-and-forget call (log, notify, emitEvent, ...).
 * The executor is the existing implementation supplied by the call site;
 * the broker wraps it with policy + audit. Throws BrokerError on denial.
 */
export function brokerCallSync<T>(
  handle: ScriptHandle,
  method: string,
  args: unknown[],
  executor: () => T,
): T {
  const policy = checkPolicy(handle, method, args);
  try {
    const result = executor();
    audit(handle, method, policy.class, true);
    return result;
  } catch (e) {
    audit(handle, method, policy.class, false, e instanceof BrokerError ? e.code : "HostError");
    throw e;
  }
}

/**
 * Mediate an async call. Exactly one settle per call — executor exceptions
 * become rejected promises, never hung ones.
 */
export async function brokerCall<T>(
  handle: ScriptHandle,
  method: string,
  args: unknown[],
  executor: () => Promise<T>,
): Promise<T> {
  const policy = checkPolicy(handle, method, args);

  // Limits that are statically checkable land here (per-method, data-driven).
  if (policy.limits?.maxCells !== undefined && Array.isArray(args[0])
      && args[0].length > policy.limits.maxCells) {
    audit(handle, method, policy.class, false, "ValidationError");
    throw new BrokerError(
      "ValidationError",
      `${method}: batch of ${args[0].length} exceeds the limit of ${policy.limits.maxCells} cells`,
    );
  }

  try {
    const result = await executor();
    audit(handle, method, policy.class, true);
    return result;
  } catch (e) {
    audit(handle, method, policy.class, false, e instanceof BrokerError ? e.code : "HostError");
    throw e;
  }
}

// ============================================================================
// Exposed-method registry (replaces globalExposedMethods — R7)
// ============================================================================

interface ExposedMethod {
  handler: (...args: unknown[]) => unknown;
  owner: ScriptHandle;
  /** Callable across tiers/origins. Same-tier same-origin calls don't need it. */
  isPublic: boolean;
}

const exposedMethods = new Map<string, ExposedMethod>();

/**
 * Name prefix reserved for entry points that ONLY trusted host code may invoke.
 *
 * WHY IT EXISTS. `expose(name, fn, { public: false })` is enough for ordinary
 * script-to-script policy — a non-public method is reachable only by a script of
 * the SAME tier AND the SAME trust origin. That is not enough for a HOST RELAY
 * entry point, because "same origin" is a package name: a distributed script
 * shipped in package `acme.http` and a library realm mounted for package
 * `acme.http` share an origin, so the script would be same-trust with the realm
 * and could call the relay directly, jumping over the host-side authorization
 * that the relay exists to enforce (host.ts `authorizeImportCall`).
 *
 * So the shared-library relay is named with this prefix and `callExposed` — the
 * SCRIPT-facing door — refuses the whole namespace unconditionally, before it
 * even looks the method up (an "unknown name" and a "forbidden name" must not be
 * distinguishable, or the refusal becomes a probe). `hostCallExposed`, the
 * TRUSTED door, is unaffected: that is the only way in.
 */
export const HOST_ONLY_EXPOSED_PREFIX = "__calcula_host__";

function exposedKey(objectType: string, instanceId: string | null, methodName: string): string {
  return `${objectType}:${instanceId || ""}:${methodName}`;
}

/** Register an exposed method under its owner's identity. Returns cleanup. */
export function registerExposed(
  owner: ScriptHandle,
  methodName: string,
  handler: (...args: unknown[]) => unknown,
  isPublic: boolean,
): () => void {
  const key = exposedKey(owner.objectType, owner.instanceId, methodName);
  exposedMethods.set(key, { handler, owner, isPublic });
  return () => {
    // Only the current registration may remove itself (a remount must not
    // delete its successor's entry).
    const current = exposedMethods.get(key);
    if (current && current.handler === handler) {
      exposedMethods.delete(key);
    }
  };
}

/**
 * Withdraw a method the OWNER previously exposed (the cleanup returned by
 * `context.expose(...)` being invoked while the script is still mounted).
 *
 * Owner-checked, not just key-checked: a remount registers the successor under
 * the same key, so an unexpose that raced a remount must not delete the new
 * script's entry. Returns true if an entry was actually removed.
 */
export function unregisterExposed(owner: ScriptHandle, methodName: string): boolean {
  const key = exposedKey(owner.objectType, owner.instanceId, methodName);
  const current = exposedMethods.get(key);
  if (!current || current.owner !== owner) return false;
  exposedMethods.delete(key);
  return true;
}

/**
 * Call a method exposed by another script, enforcing R7: cross-tier or
 * cross-origin calls require the target to have opted in with {public: true}.
 * Returns a Promise (RESHAPE — already-awaiting scripts are unaffected).
 */
export async function callExposed(
  caller: ScriptHandle,
  targetType: string,
  targetInstanceId: string | null,
  methodName: string,
  args: unknown[],
): Promise<unknown> {
  // Host-only namespace: refused for EVERY script, before the lookup, whatever
  // its tier/origin and whatever the target's `public` flag says. Refusing
  // before the lookup keeps "no such method" and "not yours to call" the same
  // observation, so the rule cannot be used to enumerate host relays.
  if (methodName.startsWith(HOST_ONLY_EXPOSED_PREFIX)) {
    throw new BrokerError(
      "PermissionDenied",
      `Method '${methodName}' is a host-only entry point and cannot be called by a script`,
    );
  }
  const key = exposedKey(targetType, targetInstanceId, methodName);
  const target = exposedMethods.get(key);
  if (!target) {
    return undefined; // preserved semantics: missing method -> undefined
  }
  const sameTrust = target.owner.tier === caller.tier && target.owner.origin === caller.origin;
  if (!sameTrust && !target.isPublic) {
    throw new BrokerError(
      "PermissionDenied",
      `Method '${methodName}' on ${targetType} is not public; cross-tier/cross-package calls require expose(name, fn, { public: true })`,
    );
  }
  return target.handler(...args);
}

/**
 * Call an exposed method from TRUSTED host code (extensions, tests). Host
 * callers bypass the cross-tier public policy — that policy governs
 * script-to-script calls; host code already holds full authority.
 */
export function hostCallExposed(
  targetType: string,
  targetInstanceId: string | null,
  methodName: string,
  args: unknown[],
): unknown {
  const target = exposedMethods.get(exposedKey(targetType, targetInstanceId, methodName));
  if (!target) {
    console.warn(`[ScriptBroker] Method not found: ${targetType}:${targetInstanceId || ""}:${methodName}`);
    return undefined;
  }
  return target.handler(...args);
}

/** All exposed methods (transparency panel / debugging). */
export function listExposed(): Array<{
  objectType: string;
  instanceId: string | null;
  methodName: string;
  ownerScriptId: string;
  isPublic: boolean;
}> {
  const result: Array<{
    objectType: string;
    instanceId: string | null;
    methodName: string;
    ownerScriptId: string;
    isPublic: boolean;
  }> = [];
  for (const [key, entry] of exposedMethods) {
    const firstSep = key.indexOf(":");
    const secondSep = key.indexOf(":", firstSep + 1);
    result.push({
      objectType: key.slice(0, firstSep),
      instanceId: key.slice(firstSep + 1, secondSep) || null,
      methodName: key.slice(secondSep + 1),
      ownerScriptId: entry.owner.scriptId,
      isPublic: entry.isPublic,
    });
  }
  return result;
}

/** Drop every exposed method (workbook close / manager reset). */
export function clearExposed(): void {
  exposedMethods.clear();
}

// ============================================================================
// Event namespacing helpers (R5 — symmetric on emit and subscribe)
// ============================================================================

/** The name a script's emitEvent(name) actually dispatches. */
export function scriptEmitEventName(name: string): string {
  return namespaceUserEvent(name);
}

/**
 * The name a script's onEvent(name) actually subscribes to: raw for the
 * read-only allowlisted AppEvents subset, force-namespaced otherwise.
 */
export function scriptSubscribeEventName(name: string): string {
  if (SCRIPT_SUBSCRIBABLE_APP_EVENTS.has(name)) {
    return name;
  }
  return namespaceUserEvent(name);
}

export { USERSCRIPT_EVENT_PREFIX };

// ============================================================================
// Mounted-script registry (transparency panel)
// ============================================================================

const mountedHandles = new Map<string, ScriptHandle>();

export function registerMountedHandle(handle: ScriptHandle): () => void {
  mountedHandles.set(handle.scriptId, handle);
  return () => mountedHandles.delete(handle.scriptId);
}

export function listMountedHandles(): ScriptHandle[] {
  return [...mountedHandles.values()];
}
