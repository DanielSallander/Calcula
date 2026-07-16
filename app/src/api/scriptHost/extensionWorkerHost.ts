//! FILENAME: app/src/api/scriptHost/extensionWorkerHost.ts
// PURPOSE: The TRUSTED side of the distributed-extension worker realm (Wave 3 /
//          S8-C7 Phase B). Spawns one hardened worker per worker-supported
//          extension, reads its manifest, builds the authoritative
//          declared-capability ceiling + ScriptHandle, then:
//            - turns the worker's REGISTRATIONS (commands, event subscriptions)
//              into real host registrations whose callbacks RPC back to the
//              worker (the handler never leaves the sandbox), and
//            - routes the worker's BROKER CALLS (capabilities, toast,
//              executeCommand, emitEvent) through the SAME tier broker object
//              scripts use, so the ceiling, JIT consent, and audit apply.
//          The extension code never touches the DOM, Tauri, or the network
//          directly — only through these mediated paths.

import {
  buildHandleFromDefinition,
  brokerCall,
  BrokerError,
  registerMountedHandle,
  scriptEmitEventName,
  scriptSubscribeEventName,
  type ScriptHandle,
} from "./broker";
import { CAPABILITY_ID_SET, type CapabilityId } from "./capabilityIds";
import { ALLOWLIST, thinAppEventForScripts } from "./allowlist";
import {
  fetchOriginOf,
  grantBiCapability,
  grantNetOrigin,
  RUST_MIRRORED_BI_CAPS,
  hasFetchOrigin,
  recordCapabilityGrant,
  requestCapabilityGrant,
  revokeBackendCapabilities,
  revokeScriptGrants,
  wasDeniedThisSession,
} from "./capabilities";
import {
  EXTENSION_PROTOCOL_VERSION,
  EXTENSION_HANDLER_TIMEOUT_MS,
  type HX2W,
  type WX2H,
  type ExtRegistration,
  type ExtRpcError,
  type WorkerExtensionManifest,
} from "./extensionProtocol";
import { emitAppEvent, onAppEvent } from "../events";
import { showToast } from "../notifications";
import { CommandRegistry } from "../commands";
import { registerMenuItem, unregisterMenuItem } from "../ui";
import { toBiConnectionSummary } from "./biQuerySupport";

const SCRIPT_STORAGE_QUOTA_BYTES = 262_144; // 256 KB, matches the object-script store

interface MountedExtension {
  extId: string;
  handle: ScriptHandle;
  worker: Worker;
  /** Host-side teardown: dereg handle, unregister commands, unsubscribe events. */
  cleanups: Array<() => void>;
  /** regId -> teardown for a single registration. */
  regCleanups: Map<number, () => void>;
  /** Pending host->worker handler invocations (command click, etc.). */
  pendingInvokes: Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: number }>;
  nextReqId: number;
}

const mounted = new Map<string, MountedExtension>();

function spawnExtensionWorker(): Worker {
  return new Worker(new URL("./worker/extensionBootstrap.ts", import.meta.url), { type: "module" });
}

/** Storage filename for an extension (sanitize the ":" in the handle id). */
function storageScriptId(extId: string): string {
  return `extension_${extId.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
}

function hostCommandId(extId: string, localId: string): string {
  return `ext:${extId}:${localId}`;
}

// ============================================================================
// Mount / unmount
// ============================================================================

export interface WorkerExtensionMountResult {
  ok: boolean;
  extId?: string;
  error?: string;
  /** The worker-reported manifest (present on success), for the manager's record. */
  manifest?: WorkerExtensionManifest;
}

/**
 * Mount a distributed extension into a worker realm. The bundle is imported
 * INSIDE the worker (never on the main thread); only manifests declaring
 * `workerSupport: true` are accepted here — others are the caller's signal to
 * fall back to the main-thread (Phase A) path.
 */
export async function mountWorkerExtension(
  source: string,
  displayName: string,
  authoritative?: WorkerExtensionManifest,
): Promise<WorkerExtensionMountResult> {
  const worker = spawnExtensionWorker();

  // 1. Import + manifest report (no host-thread execution of extension code).
  let reported: WorkerExtensionManifest;
  try {
    reported = await readManifest(worker, source);
  } catch (e) {
    worker.terminate();
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // A verified SIDECAR manifest (Ed25519-signed, read without executing the
  // bundle) is AUTHORITATIVE over the worker-reported one. Cross-check the id so
  // a bundle swapped under a signed manifest is rejected; the ceiling then comes
  // from the signed manifest (capabilities already trust-gated by the caller).
  if (authoritative && reported.id && authoritative.id && reported.id !== authoritative.id) {
    worker.terminate();
    return {
      ok: false,
      error: `bundle id '${reported.id}' does not match the signed manifest id '${authoritative.id}'`,
    };
  }
  const manifest = authoritative ?? reported;

  if (manifest.workerSupport !== true) {
    worker.terminate();
    return { ok: false, error: "manifest does not declare workerSupport: true" };
  }
  const extId = manifest.id;
  if (!extId) {
    worker.terminate();
    return { ok: false, error: "manifest is missing an id" };
  }
  if (mounted.has(extId)) {
    worker.terminate();
    return { ok: false, error: `extension '${extId}' is already mounted` };
  }

  // 2. Authoritative ceiling + handle (the worker-reported caps are filtered to
  //    the recognized set; a grant still requires JIT consent).
  const ceiling: CapabilityId[] = (manifest.capabilities ?? []).filter(
    (c): c is CapabilityId => CAPABILITY_ID_SET.has(c as CapabilityId),
  );
  const handle = buildHandleFromDefinition({
    id: `extension:${extId}`,
    name: manifest.name || displayName || extId,
    objectType: "extension",
    instanceId: null,
    accessLevel: "restricted",
    provenance: "distributed",
    packageName: extId,
    declaredCapabilities: ceiling,
  });

  const mw: MountedExtension = {
    extId,
    handle,
    worker,
    cleanups: [registerMountedHandle(handle)],
    regCleanups: new Map(),
    pendingInvokes: new Map(),
    nextReqId: 1,
  };
  mounted.set(extId, mw);

  worker.addEventListener("message", (e: MessageEvent<WX2H>) => handleWorkerMessage(mw, e.data));
  worker.addEventListener("error", (e) => {
    console.error(`[ext-worker:${extId}] worker error:`, e.message);
  });

  // 3. Activate.
  const activated = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const onAct = (e: MessageEvent<WX2H>) => {
      if (e.data.t === "activated") {
        worker.removeEventListener("message", onAct);
        resolve({ ok: e.data.ok, error: e.data.error });
      }
    };
    worker.addEventListener("message", onAct);
    worker.postMessage({ t: "activate", ceiling } as HX2W);
    setTimeout(() => {
      worker.removeEventListener("message", onAct);
      resolve({ ok: false, error: "activate timed out" });
    }, 10_000);
  });

  if (!activated.ok) {
    await unmountWorkerExtension(extId);
    return { ok: false, error: activated.error ?? "extension activate failed" };
  }
  return { ok: true, extId, manifest };
}

function readManifest(worker: Worker, source: string): Promise<WorkerExtensionManifest> {
  return new Promise<WorkerExtensionManifest>((resolve, reject) => {
    const onMsg = (e: MessageEvent<WX2H>) => {
      const m = e.data;
      if (m.t === "manifest") {
        worker.removeEventListener("message", onMsg);
        resolve(m.manifest);
      } else if (m.t === "manifestError") {
        worker.removeEventListener("message", onMsg);
        reject(new Error(m.message));
      }
      // console messages during import are ignored here.
    };
    worker.addEventListener("message", onMsg);
    worker.postMessage({ t: "init", protocolVersion: EXTENSION_PROTOCOL_VERSION, source } as HX2W);
    setTimeout(() => {
      worker.removeEventListener("message", onMsg);
      reject(new Error("extension init timed out"));
    }, 10_000);
  });
}

/** Tear down a worker extension: deactivate, drop all proxies, terminate. */
export async function unmountWorkerExtension(extId: string): Promise<void> {
  const mw = mounted.get(extId);
  if (!mw) return;
  mounted.delete(extId);
  try {
    mw.worker.postMessage({ t: "deactivate" } as HX2W);
  } catch {
    /* worker may already be dead */
  }
  // Reject any in-flight handler invocations.
  for (const p of mw.pendingInvokes.values()) {
    clearTimeout(p.timer);
    p.reject(new Error("extension unmounted"));
  }
  mw.pendingInvokes.clear();
  for (const cleanup of mw.regCleanups.values()) {
    try {
      cleanup();
    } catch {
      /* best effort */
    }
  }
  mw.regCleanups.clear();
  for (const cleanup of mw.cleanups) {
    try {
      cleanup();
    } catch {
      /* best effort */
    }
  }
  await revokeBackendCapabilities(mw.handle.scriptId);
  revokeScriptGrants(mw.handle.scriptId);
  mw.worker.terminate();
}

/** Mounted worker extensions (transparency / debugging). */
export function listWorkerExtensions(): Array<{ extId: string; declaredCapabilities: CapabilityId[] }> {
  return [...mounted.values()].map((mw) => ({
    extId: mw.extId,
    declaredCapabilities: [...mw.handle.declaredCapabilities],
  }));
}

/** Drop every worker extension (workbook close / manager reset). */
export async function resetWorkerExtensions(): Promise<void> {
  await Promise.all([...mounted.keys()].map((id) => unmountWorkerExtension(id)));
}

// ============================================================================
// Worker -> host message handling
// ============================================================================

function handleWorkerMessage(mw: MountedExtension, msg: WX2H): void {
  switch (msg.t) {
    case "register":
      setupRegistration(mw, msg.reg);
      break;
    case "unregister": {
      const cleanup = mw.regCleanups.get(msg.regId);
      if (cleanup) {
        mw.regCleanups.delete(msg.regId);
        try {
          cleanup();
        } catch {
          /* best effort */
        }
      }
      break;
    }
    case "call":
      void handleBrokerCall(mw, msg.callId, msg.method, msg.args);
      break;
    case "handlerResult": {
      const p = mw.pendingInvokes.get(msg.reqId);
      if (p) {
        mw.pendingInvokes.delete(msg.reqId);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new BrokerError(msg.error?.code ?? "HostError", msg.error?.message ?? "handler failed"));
      }
      break;
    }
    case "console":
      console[msg.level === "warn" ? "warn" : msg.level === "error" ? "error" : "log"](
        `[ext:${mw.extId}]`,
        ...msg.args,
      );
      emitAppEvent("objectscript:console", { scriptId: mw.handle.scriptId, level: msg.level, args: msg.args });
      break;
    case "error":
      console.error(`[ext:${mw.extId}] uncaught:`, msg.message, msg.stack ?? "");
      break;
    // manifest / manifestError / activated are handled by the mount promises.
    default:
      break;
  }
}

/** Install a host-side proxy for a worker registration. */
function setupRegistration(mw: MountedExtension, reg: ExtRegistration): void {
  if (reg.kind === "command") {
    // Registration must be SYNCHRONOUS so the proxy command exists the moment
    // activate() returns (a caller may invoke it immediately after mount).
    const cmdId = hostCommandId(mw.extId, reg.id);
    // The proxy command relays to the worker handler. Not scriptSafe by default:
    // other scripts cannot invoke an extension's command unless the extension
    // opts in (future). The extension itself runs it via its UI.
    // Returns the worker handler's result, so a caller of CommandRegistry.execute
    // (or another script via ext.executeCommand) receives the command's value.
    CommandRegistry.register(
      cmdId,
      (args: unknown) => invokeWorkerHandler(mw, reg.handlerId, [args]),
      { scriptSafe: false },
    );
    mw.regCleanups.set(reg.regId, () => CommandRegistry.unregister(cmdId));
    return;
  }
  if (reg.kind === "event") {
    // Forward a host app-event to the worker's subscribed handler. The event
    // name is namespaced the same way scripts' subscriptions are; payloads
    // crossing into the sandbox are THINNED for events whose full payload
    // carries capability-gated metadata (BI model events).
    const eventName = scriptSubscribeEventName(reg.eventName);
    const unsub = onAppEvent(eventName as never, (payload: unknown) => {
      mw.worker.postMessage({
        t: "appEvent",
        handlerId: reg.handlerId,
        payload: thinAppEventForScripts(eventName, payload),
      } as HX2W);
    });
    mw.regCleanups.set(reg.regId, unsub);
    return;
  }
  if (reg.kind === "menuItem") {
    // Register a real menu item whose click either runs the extension's own
    // (namespaced) command or relays to its worker-side onClick handler. The
    // item id is namespaced so two extensions can't collide and cleanup is exact.
    const itemId = `ext:${mw.extId}:${reg.item.id}`;
    const action = () => {
      if (reg.commandId) {
        void CommandRegistry.execute(hostCommandId(mw.extId, reg.commandId));
      } else if (reg.handlerId !== undefined) {
        void invokeWorkerHandler(mw, reg.handlerId, []);
      }
    };
    registerMenuItem(reg.menuId, {
      id: itemId,
      label: reg.item.label,
      icon: reg.item.icon,
      order: reg.item.order,
      separator: reg.item.separator,
      action,
    });
    mw.regCleanups.set(reg.regId, () => unregisterMenuItem(reg.menuId, itemId));
    return;
  }
}

/** RPC a worker-held handler and await its result (with a deadline). */
function invokeWorkerHandler(mw: MountedExtension, handlerId: number, args: unknown[]): Promise<unknown> {
  const reqId = mw.nextReqId++;
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (mw.pendingInvokes.delete(reqId)) reject(new Error("extension handler timed out"));
    }, EXTENSION_HANDLER_TIMEOUT_MS) as unknown as number;
    mw.pendingInvokes.set(reqId, { resolve, reject, timer });
    mw.worker.postMessage({ t: "invokeHandler", reqId, handlerId, args } as HX2W);
  });
}

// ============================================================================
// Broker-mediated calls (capabilities + side effects)
// ============================================================================

async function handleBrokerCall(
  mw: MountedExtension,
  callId: number,
  method: string,
  args: unknown[],
): Promise<void> {
  try {
    await maybeRequestCapabilityGrant(mw, method, args);
    const value = await brokerCall(mw.handle, method, args, () => executeExtensionImpl(mw, method, args));
    mw.worker.postMessage({ t: "callResult", callId, ok: true, value } as HX2W);
  } catch (err) {
    const error: ExtRpcError =
      err instanceof BrokerError
        ? { code: err.code, message: err.message, detail: err.capability ? { capability: err.capability } : undefined }
        : { code: "HostError", message: err instanceof Error ? err.message : String(err) };
    mw.worker.postMessage({ t: "callResult", callId, ok: false, error } as HX2W);
  }
}

/**
 * JIT capability grant for a worker extension. Unlike distributed SCRIPTS (which
 * acquire caps only via package consent), a worker extension has no package
 * consent flow yet, so the user is prompted on first use — but only for a
 * capability the extension actually DECLARED (R19 ceiling); an undeclared cap is
 * denied by the broker and never prompted.
 */
async function maybeRequestCapabilityGrant(mw: MountedExtension, method: string, args: unknown[]): Promise<void> {
  const cap = ALLOWLIST[method]?.capability;
  if (!cap) return;
  const { handle } = mw;
  if (!handle.declaredCapabilities.has(cap)) return; // above the ceiling -> broker denies

  if (cap === "net.fetch") {
    const origin = fetchOriginOf(args[0]);
    if (!origin) return;
    if (handle.grants.has(cap) && hasFetchOrigin(handle.scriptId, origin)) return;
    if (wasDeniedThisSession(handle.scriptId, cap, origin)) return;
    const decision = await requestCapabilityGrant({
      scriptId: handle.scriptId,
      scriptName: handle.scriptName,
      capability: cap,
      origin,
    });
    if (decision === "deny") return;
    recordCapabilityGrant(handle.scriptId, cap, origin);
    try {
      await grantNetOrigin(handle.scriptId, origin);
    } catch (e) {
      console.error("[ext-caps] failed to mirror net.fetch origin:", e);
    }
    return;
  }

  if (handle.grants.has(cap)) return;
  if (wasDeniedThisSession(handle.scriptId, cap, null)) return;
  const decision = await requestCapabilityGrant({
    scriptId: handle.scriptId,
    scriptName: handle.scriptName,
    capability: cap,
    origin: null,
  });
  if (decision !== "deny") {
    recordCapabilityGrant(handle.scriptId, cap);
    // Mirror BI-family grants into the authoritative Rust store (the Rust
    // gates re-check it). net.fetch is mirrored above per-origin.
    if (RUST_MIRRORED_BI_CAPS.has(cap)) {
      await grantBiCapability(handle.scriptId, cap);
    }
  }
}

async function executeExtensionImpl(mw: MountedExtension, method: string, args: unknown[]): Promise<unknown> {
  const scriptId = mw.handle.scriptId;
  switch (method) {
    case "ext.log": {
      console.log(`[ext:${mw.extId}]`, ...args);
      emitAppEvent("objectscript:console", { scriptId, level: "log", args });
      return undefined;
    }
    case "ext.notify": {
      const [message, type] = args as [string, string?];
      showToast(message, { type: (type as "info" | "success" | "warning" | "error") || "info" });
      return undefined;
    }
    case "ext.emitEvent": {
      const [name, detail] = args as [string, unknown];
      emitAppEvent(scriptEmitEventName(name), detail);
      return undefined;
    }
    case "ext.executeCommand": {
      const [commandId, cmdArgs] = args as [string, unknown];
      if (!CommandRegistry.isScriptSafe(commandId)) {
        throw new BrokerError(
          "PermissionDenied",
          `Command '${commandId}' is not flagged scriptSafe; extensions may only run script-safe commands`,
        );
      }
      // Surface the command's result back to the caller.
      return await CommandRegistry.execute(commandId, cmdArgs);
    }
    case "cap.fetch": {
      const [url, init] = args as [
        string,
        { method?: string; headers?: Record<string, string>; body?: string } | undefined,
      ];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_http_fetch", {
        request: { scriptId, url, method: init?.method, headers: init?.headers, body: init?.body },
      });
    }
    case "cap.storageGet": {
      const [key] = args as [string];
      const store = await readExtStorage(mw.extId);
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    }
    case "cap.storageSet": {
      const [key, value] = args as [string, string];
      const store = await readExtStorage(mw.extId);
      store[key] = value;
      const serialized = JSON.stringify(store);
      if (serialized.length > SCRIPT_STORAGE_QUOTA_BYTES) {
        throw new BrokerError("HostError", "extension storage quota exceeded (256 KB)");
      }
      await writeExtStorage(mw.extId, store);
      return undefined;
    }
    case "cap.biQuery": {
      // Structured, model-scoped query via the cached engine path (no raw SQL).
      const [connectionId, request] = args as [string, unknown];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("bi_query", { connectionId, request, scriptId });
    }
    case "cap.biListConnections": {
      const { invokeBackend } = await import("../backend");
      const conns = await invokeBackend<Array<Record<string, unknown>>>("bi_get_connections");
      return (conns ?? []).map(toBiConnectionSummary);
    }
    case "cap.biSql": {
      const [connectionId, sql] = args as [string, string];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_bi_sql", { connectionId, sql, scriptId });
    }
    case "cap.biModelInfo": {
      // Sanitized model read (never security roles / connection targets).
      const [connectionId] = args as [string];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_bi_model", {
        connectionId,
        scriptId,
        action: "info",
        kind: null,
        payload: null,
      });
    }
    case "cap.biModelUpsert":
    case "cap.biModelDelete": {
      // Governed model mutation via the authoritative Rust gateway (grant +
      // kind set + rate limit re-checked there; undoable; audited).
      const [connectionId, kind, payload] = args as [string, string, unknown];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_bi_model", {
        connectionId,
        scriptId,
        action: method === "cap.biModelUpsert" ? "upsert" : "delete",
        kind,
        payload: payload ?? null,
      });
    }
    default:
      throw new BrokerError("UnknownMethod", `No extension host implementation for ${method}`);
  }
}

// ============================================================================
// Per-extension storage (workbook-local, .calcula/script-data/<id>.json)
// ============================================================================

function extStoragePath(extId: string): string {
  return `.calcula/script-data/${storageScriptId(extId)}.json`;
}

async function readExtStorage(extId: string): Promise<Record<string, string>> {
  const { readVirtualFile } = await import("../backend");
  try {
    const raw = await readVirtualFile(extStoragePath(extId));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeExtStorage(extId: string, store: Record<string, string>): Promise<void> {
  const { createVirtualFile } = await import("../backend");
  await createVirtualFile(extStoragePath(extId), JSON.stringify(store));
}
