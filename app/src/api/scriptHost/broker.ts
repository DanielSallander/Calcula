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
import { appendAudit } from "./auditRing";
import { getGrantSet } from "./capabilities";
import { USERSCRIPT_EVENT_PREFIX, namespaceUserEvent } from "../events";

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

/** The recognized capability ids (mirrors capabilities.ts KNOWN_CAPABILITY_IDS
 *  and the Rust KNOWN_CAPABILITY_IDS). Used to filter the declared set so an
 *  unknown id from any source can never enter the ceiling. */
const VALID_CAPABILITY_IDS: ReadonlySet<CapabilityId> = new Set<CapabilityId>([
  "net.fetch",
  "bi.query",
  "storage",
  "ui.html",
]);

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
