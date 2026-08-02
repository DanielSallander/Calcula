//! FILENAME: app/src/api/scriptHost/extensionWorkerHost.ts
// PURPOSE: The TRUSTED side of the distributed-extension worker realm (Wave 3 /
//          S8-C7 Phase B; contribution surface added by the third-party add-in
//          slice — docs/design/third-party-addin-authoring.md). Spawns one
//          hardened worker per worker-supported extension, reads its manifest,
//          builds the authoritative declared-capability ceiling + ScriptHandle,
//          then:
//            - turns the worker's REGISTRATIONS (commands, event subscriptions,
//              worksheet functions, menu items, ribbon buttons, keybindings,
//              cell styling, file-format importers) into real host registrations
//              whose callbacks RPC back to the worker (the handler never leaves
//              the sandbox), and
//            - routes the worker's BROKER CALLS (capabilities, toast,
//              executeCommand, emitEvent) through the SAME tier broker object
//              scripts use, so the ceiling, JIT consent, and audit apply.
//          The extension code never touches the DOM, Tauri, or the network
//          directly — only through these mediated paths.
//
// THE CONTRIBUTION GATE (setupRegistration). Every registration is checked
// against the extension's DECLARED contribution ceiling before it reaches a real
// registry, and a refusal is loud: console + toast + an entry the manager UI
// renders + an audit-ring row. Three properties follow, and all three are the
// point:
//   - a registration nobody could have foreseen cannot appear (the ceiling comes
//     from the manifest, which is readable — and signable — WITHOUT running the
//     bundle);
//   - a refusal is never silent, so an author debugging "my function is missing"
//     is told exactly which declaration is absent;
//   - "not declared" is deny, not allow, for every kind — including kinds added
//     later, because the gate is driven by CONTRIBUTION_REGISTRATION_KINDS
//     rather than by a per-case `if`.

import {
  buildHandleFromDefinition,
  brokerCall,
  BrokerError,
  registerMountedHandle,
  scriptEmitEventName,
  scriptSubscribeEventName,
  type ScriptHandle,
} from "./broker";
import { appendAudit } from "./auditRing";
import { CAPABILITY_ID_SET, type CapabilityId } from "./capabilityIds";
import {
  ALLOWLIST,
  APP_EVENTS_CARRYING_CELL_CONTENTS,
  thinAppEventForScripts,
} from "./allowlist";
import { MAX_FILE_TEXT_CHARS } from "./validators";
import type { PickerTextEncoding } from "../filesystem";
import {
  fetchOriginOf,
  grantBackendCapability,
  grantNetOrigin,
  RUST_MIRRORED_CAPABILITIES,
  hasFetchOrigin,
  recordCapabilityGrant,
  requestCapabilityGrant,
  revokeBackendCapabilities,
  revokeScriptGrants,
  wasDeniedThisSession,
} from "./capabilities";
import {
  CONTRIBUTION_DECLARATION_KEY,
  CONTRIBUTION_REGISTRATION_KINDS,
  CONTRIBUTION_REQUIRED_CAPABILITY,
  EXTENSION_BROKER_METHODS,
  EXTENSION_PROTOCOL_VERSION,
  EXTENSION_HANDLER_TIMEOUT_MS,
  EXT_FORMULA_NAME_RE,
  MAX_EXT_FORMULA_NAME,
  isContributionDeclared,
  normalizeContributionDeclaration,
  type ExtContributionDeclaration,
  type ExtContributionKind,
  type ExtFormulaDef,
  type ExtRibbonButtonData,
  type HX2W,
  type WX2H,
  type ExtRegistration,
  type ExtRpcError,
  type WorkerExtensionManifest,
} from "./extensionProtocol";
import { registerCellRenderCache, invalidateCellRenderCache } from "./renderCache";
import { requestScriptDialog, revokeScriptDialogs } from "./scriptDialogs";
import type {
  ScriptDialogFormSpec,
  ScriptDialogPromptOptions,
  ScriptDialogTextOptions,
} from "./scriptDialogSpec";
import { AppEvents, emitAppEvent, onAppEvent } from "../events";
import { showToast } from "../notifications";
import { CommandRegistry } from "../commands";
import { registerMenuItem, unregisterMenuItem } from "../ui";
import { registerKeybinding, findConflicts, scriptComboRefusal } from "../keybindings";
import { registerFunction, hasCustomFunction } from "../formulaFunctions";
import { registerFileFormat, getFileFormats, type ImportResult } from "../fileFormats";
import type { IStyleOverride } from "../styleInterceptors";
import type { RenderCellRequest } from "./protocol";
import { toBiConnectionSummary } from "./biQuerySupport";

const SCRIPT_STORAGE_QUOTA_BYTES = 262_144; // 256 KB, matches the object-script store

/** One installed contribution, for the manager UI + the host-rendered ribbon. */
export interface ExtensionContribution {
  extId: string;
  extName: string;
  kind: ExtContributionKind;
  /** The id the extension registered under (uppercased for formulas). */
  id: string;
  /** What the user sees (function syntax, menu label, button label, ...). */
  label: string;
  /** Present when the contribution was REFUSED: why. */
  refusedReason?: string;
}

interface MountedExtension {
  extId: string;
  extName: string;
  handle: ScriptHandle;
  worker: Worker;
  /** The AUTHORITATIVE contribution ceiling (from the signed sidecar when there
   *  is one). A registration outside it is refused. */
  contributes: ExtContributionDeclaration;
  /** Host-side teardown: dereg handle, unregister commands, unsubscribe events. */
  cleanups: Array<() => void>;
  /** regId -> teardown for a single registration. */
  regCleanups: Map<number, () => void>;
  /** regId -> the contribution record, so teardown also un-lists it. */
  regContributions: Map<number, ExtensionContribution>;
  /** Refusals, kept for the manager UI (they have no regId to key on). Bounded
   *  by MAX_VISIBLE_REFUSALS so a hostile add-in cannot grow it without limit. */
  refusals: ExtensionContribution[];
  /** Every refusal, including the suppressed ones (audit is never rate-limited). */
  refusalCount: number;
  /** Cell-style cache ids this extension owns (for invalidate()). */
  cellStyleCacheIds: Set<string>;
  /** regId -> the declarative ribbon button the host paints. */
  ribbonButtons: Map<
    number,
    { extId: string; extName: string; button: ExtRibbonButtonData; commandId: string }
  >;
  /** Pending host->worker handler invocations (command click, etc.). */
  pendingInvokes: Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: number }>;
  nextReqId: number;
}

const mounted = new Map<string, MountedExtension>();

// ============================================================================
// Contribution registry (transparency + the host-rendered ribbon)
// ============================================================================
//
// Declared-but-not-yet-mounted extensions are recorded here too (by the
// ExtensionManager, before consent), so the user can see what an add-in WILL
// install before allowing it to run.

const declaredByExtension = new Map<string, ExtContributionDeclaration>();
const contributionListeners = new Set<() => void>();

function notifyContributions(): void {
  for (const cb of contributionListeners) {
    try {
      cb();
    } catch (e) {
      console.error("[ext-contrib] listener failed:", e);
    }
  }
}

/** Subscribe to contribution changes (manager UI / ribbon host). */
export function subscribeToExtensionContributions(cb: () => void): () => void {
  contributionListeners.add(cb);
  return () => {
    contributionListeners.delete(cb);
  };
}

/**
 * Record what an extension DECLARED, before (or without) mounting it. Called by
 * the ExtensionManager for pending-consent / disabled / blocked entries so the
 * manager UI can show "this add-in will add 3 worksheet functions" while its
 * code has never been imported.
 */
export function recordDeclaredContributions(extId: string, declared: unknown): void {
  declaredByExtension.set(extId, normalizeContributionDeclaration(declared));
  notifyContributions();
}

/** Forget a declaration (uninstall / re-scan). */
export function forgetDeclaredContributions(extId: string): void {
  if (declaredByExtension.delete(extId)) notifyContributions();
}

/** What an extension declared it would contribute (empty when unknown). */
export function getDeclaredContributions(extId: string): ExtContributionDeclaration {
  return declaredByExtension.get(extId) ?? {};
}

/** Every contribution currently INSTALLED, plus every refusal. */
export function listExtensionContributions(): ExtensionContribution[] {
  const out: ExtensionContribution[] = [];
  for (const mw of mounted.values()) {
    out.push(...mw.regContributions.values(), ...mw.refusals);
  }
  return out;
}

/** The ribbon buttons a host-rendered "Add-ins" surface should paint. */
export function listExtensionRibbonButtons(): Array<{
  extId: string;
  extName: string;
  button: ExtRibbonButtonData;
  /** The namespaced host command id to execute on click. */
  commandId: string;
}> {
  const out: Array<{ extId: string; extName: string; button: ExtRibbonButtonData; commandId: string }> = [];
  for (const mw of mounted.values()) {
    for (const b of mw.ribbonButtons.values()) out.push(b);
  }
  return out;
}

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
  // The CONTRIBUTION ceiling comes from the same authoritative manifest. Unlike
  // capabilities it is not zeroed for an unsigned bundle, because it grants
  // nothing: it only bounds which host surfaces the code may appear in, and for
  // an unsigned bundle the declaration and the code have the same author
  // anyway. Its value there is disclosure (the sidecar is read without running
  // the bundle); its value for a SIGNED bundle is a real ceiling the publisher
  // cannot widen after the fact. Formulas stay effectively signature-gated
  // regardless, because they additionally require the formula.udf capability —
  // which IS zeroed when the signature is missing or bad.
  const contributes = normalizeContributionDeclaration(manifest.contributes);
  const extName = manifest.name || displayName || extId;
  const handle = buildHandleFromDefinition({
    id: `extension:${extId}`,
    name: extName,
    objectType: "extension",
    instanceId: null,
    accessLevel: "restricted",
    provenance: "distributed",
    packageName: extId,
    declaredCapabilities: ceiling,
  });

  const mw: MountedExtension = {
    extId,
    extName,
    handle,
    worker,
    contributes,
    cleanups: [registerMountedHandle(handle)],
    regCleanups: new Map(),
    regContributions: new Map(),
    refusals: [],
    refusalCount: 0,
    cellStyleCacheIds: new Set(),
    ribbonButtons: new Map(),
    pendingInvokes: new Map(),
    nextReqId: 1,
  };
  mounted.set(extId, mw);
  declaredByExtension.set(extId, contributes);

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
    worker.postMessage({
      t: "activate",
      ceiling,
      // Provenance mirror (B5): a sandboxed extension can ask which bundle and
      // version it is running as. Sourced from the AUTHORITATIVE manifest (the
      // signed sidecar when there is one), never from what the bundle reported.
      package: {
        name: manifest.name || extId,
        version: manifest.version || null,
        provenance: "distributed",
      },
      // Same rule for the contribution ceiling: the extension is TOLD what it
      // may register (so it can degrade gracefully) but is never trusted to
      // enforce it — setupRegistration re-checks every registration below.
      contributes,
    } as HX2W);
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
  mw.regContributions.clear();
  mw.refusals.length = 0;
  mw.ribbonButtons.clear();
  mw.cellStyleCacheIds.clear();
  notifyContributions();
  for (const cleanup of mw.cleanups) {
    try {
      cleanup();
    } catch {
      /* best effort */
    }
  }
  await revokeBackendCapabilities(mw.handle.scriptId);
  revokeScriptGrants(mw.handle.scriptId);
  // Take down any modal this extension had on screen — otherwise it keeps
  // asking on behalf of code that no longer exists (same rule as hostUnmountScript).
  revokeScriptDialogs(mw.handle.scriptId);
  mw.worker.terminate();
}

/** Mounted worker extensions (transparency / debugging). */
export function listWorkerExtensions(): Array<{
  extId: string;
  declaredCapabilities: CapabilityId[];
  declaredContributions: ExtContributionDeclaration;
  installedContributions: number;
  refusedContributions: number;
}> {
  return [...mounted.values()].map((mw) => ({
    extId: mw.extId,
    declaredCapabilities: [...mw.handle.declaredCapabilities],
    declaredContributions: mw.contributes,
    installedContributions: mw.regContributions.size,
    refusedContributions: mw.refusals.length,
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
      if (mw.regContributions.delete(msg.regId)) notifyContributions();
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

// ============================================================================
// The contribution gate
// ============================================================================

/** The id a registration claims, per kind — what the ceiling is checked against. */
function contributionIdOf(reg: ExtRegistration): string {
  switch (reg.kind) {
    case "command":
      return reg.id;
    case "menuItem":
      return `${reg.menuId}/${reg.item.id}`;
    case "formula":
      return String(reg.def?.name ?? "").trim().toUpperCase();
    case "ribbonButton":
      return reg.button?.id ?? "";
    case "keybinding":
      return reg.binding?.id ?? "";
    case "cellStyle":
      return reg.id;
    case "fileFormat":
      return reg.format?.id ?? "";
    default:
      return "";
  }
}

/** How many refusals one extension may make VISIBLE before it is muted.
 *
 *  A refusal is loud on purpose, and "loud" is exactly what a hostile add-in
 *  would weaponize: `register` is a worker->host message it can post in a loop,
 *  and every refused one raised a toast carrying an EXTENSION-SUPPLIED string.
 *  That is an unbounded, attacker-authored notification channel — a phishing and
 *  denial-of-attention surface dressed as a security warning. Past this cap the
 *  refusals are still counted, still audited and still refused; only the toast
 *  and the per-refusal row stop, and one final row says why. */
const MAX_VISIBLE_REFUSALS = 8;
/** Longest attacker-supplied fragment we will echo into a toast. */
const MAX_REFUSAL_ECHO = 64;

/** Trim an untrusted id/reason before it is shown to the user: one line, short,
 *  no control characters — a refusal notice must never become a canvas. */
function echoSafe(text: string, max: number): string {
  let flat = "";
  for (const ch of String(text)) {
    const code = ch.codePointAt(0) ?? 0;
    // C0/C1 controls, zero-width + bidi-override characters: a refusal notice
    // must be one plain line, never a canvas for spoofed chrome.
    const unsafe =
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    flat += unsafe ? " " : ch;
  }
  flat = flat.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/**
 * Report a refused contribution. LOUD by construction: console, a toast the
 * user sees, a manager-UI row, and an audit-ring entry. A silently dropped
 * registration is the failure mode that makes an author distrust the platform —
 * and the failure mode that lets a refusal go unnoticed by the user too.
 *
 * BOUNDED by construction too (MAX_VISIBLE_REFUSALS): the audit entry is always
 * written, but the user-visible half stops after a handful, so "loud" cannot be
 * turned into a message channel by an add-in that registers garbage in a loop.
 */
function refuseContribution(
  mw: MountedExtension,
  kind: ExtContributionKind,
  id: string,
  reason: string,
): void {
  // Always audited — the record of a refusal is not rate-limited, only its noise.
  appendAudit({
    ts: Date.now(),
    scriptId: mw.handle.scriptId,
    scriptName: mw.handle.scriptName,
    method: `ext.contribute.${kind}`,
    class: "emit",
    ok: false,
    error: "PermissionDenied",
  });
  mw.refusalCount += 1;
  const message =
    `Extension "${mw.extName}" tried to add a ${kind} ("${echoSafe(id, MAX_REFUSAL_ECHO)}") ` +
    `that it did not declare or is not allowed: ${echoSafe(reason, 200)}`;
  console.warn(`[ext:${mw.extId}] ${message}`);
  if (mw.refusalCount > MAX_VISIBLE_REFUSALS) {
    if (mw.refusalCount === MAX_VISIBLE_REFUSALS + 1) {
      mw.refusals.push({
        extId: mw.extId,
        extName: mw.extName,
        kind,
        id: "(further refusals suppressed)",
        label: "(further refusals suppressed)",
        refusedReason:
          `this extension has been refused more than ${MAX_VISIBLE_REFUSALS} registrations; ` +
          `the rest are still refused and audited, but are no longer shown`,
      });
      showToast(
        `Extension "${mw.extName}" keeps trying to add things it did not declare. Further notices are suppressed; see Extensions.`,
        { type: "warning" },
      );
      notifyContributions();
    }
    return;
  }
  mw.refusals.push({
    extId: mw.extId,
    extName: mw.extName,
    kind,
    id,
    label: id,
    refusedReason: reason,
  });
  showToast(message, { type: "warning" });
  notifyContributions();
}

/** Record an ACCEPTED contribution (manager UI + audit trail). */
function acceptContribution(
  mw: MountedExtension,
  regId: number,
  kind: ExtContributionKind,
  id: string,
  label: string,
): void {
  mw.regContributions.set(regId, { extId: mw.extId, extName: mw.extName, kind, id, label });
  appendAudit({
    ts: Date.now(),
    scriptId: mw.handle.scriptId,
    scriptName: mw.handle.scriptName,
    method: `ext.contribute.${kind}`,
    class: "emit",
    ok: true,
  });
  notifyContributions();
}

/**
 * Ceiling check for one registration. Returns the claimed id when the
 * contribution may proceed, or null when it was refused (and reported).
 *
 * Driven by CONTRIBUTION_REGISTRATION_KINDS rather than a per-kind `if`, so a
 * kind added to the protocol later is deny-by-default here until it is
 * explicitly declared — the same fail-closed shape as the broker allowlist.
 */
function admitContribution(mw: MountedExtension, reg: ExtRegistration): string | null {
  if (!CONTRIBUTION_REGISTRATION_KINDS.has(reg.kind)) return null;
  const kind = reg.kind as ExtContributionKind;
  const id = contributionIdOf(reg);
  if (!id) {
    refuseContribution(mw, kind, "(unnamed)", "the registration has no id");
    return null;
  }
  if (!isContributionDeclared(mw.contributes, kind, id)) {
    refuseContribution(
      mw,
      kind,
      id,
      `its manifest does not list "${id}" under contributes.${CONTRIBUTION_DECLARATION_KEY[kind]}`,
    );
    return null;
  }
  const required = CONTRIBUTION_REQUIRED_CAPABILITY[kind];
  if (required && !mw.handle.declaredCapabilities.has(required)) {
    refuseContribution(
      mw,
      kind,
      id,
      `it requires the '${required}' capability, which this extension did not declare (an unsigned or tampered manifest also lands here)`,
    );
    return null;
  }
  return id;
}

/** Install a host-side proxy for a worker registration. */
function setupRegistration(mw: MountedExtension, reg: ExtRegistration): void {
  // Contributions are ceiling-gated; `event` is a subscription, not a surface.
  let contributionId: string | null = null;
  if (CONTRIBUTION_REGISTRATION_KINDS.has(reg.kind)) {
    contributionId = admitContribution(mw, reg);
    if (contributionId === null) return;
  }

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
    acceptContribution(mw, reg.regId, "command", reg.id, cmdId);
    return;
  }
  if (reg.kind === "event") {
    // Forward a host app-event to the worker's subscribed handler. The event
    // name is namespaced the same way scripts' subscriptions are; payloads
    // crossing into the sandbox are THINNED for events whose full payload
    // carries capability-gated metadata (BI model events).
    const eventName = scriptSubscribeEventName(reg.eventName);
    // THE SECOND UNDISCLOSED READER (B2). A subscription is not a contribution:
    // it is never named in the sidecar manifest and never appears in the consent
    // prompt, so an add-in could subscribe to CELL_VALUES_CHANGED and be handed
    // every changed cell's old value, new value and formula — the same workbook
    // data the cell-style contributor gets, through a door nobody had counted.
    // It is now behind the SAME capability, decided per delivery (not captured
    // here) so a ceiling change or a revoke bites the next event rather than the
    // next mount. Without grid.read the handler still fires and still learns
    // WHERE the change was; it is the contents that do not cross.
    if (APP_EVENTS_CARRYING_CELL_CONTENTS.has(eventName)) {
      // The subscription IS the use of the capability, so write the grant down
      // now — otherwise an add-in that reads the workbook only through events
      // would be the one holder of grid.read that never appears in the
      // transparency panel.
      if (mw.handle.declaredCapabilities.has("grid.read")) {
        recordCapabilityGrant(mw.handle.scriptId, "grid.read");
      }
      appendAudit({
        ts: Date.now(),
        scriptId: mw.handle.scriptId,
        scriptName: mw.handle.scriptName,
        method: `ext.subscribe.${eventName}`,
        class: "read",
        ok: true,
      });
    }
    const unsub = onAppEvent(eventName as never, (payload: unknown) => {
      mw.worker.postMessage({
        t: "appEvent",
        handlerId: reg.handlerId,
        payload: thinAppEventForScripts(eventName, payload, {
          redactCellContents: !mw.handle.declaredCapabilities.has("grid.read"),
        }),
      } as HX2W);
    });
    // WRITEBACK_SUBMISSION_RECEIVED does not fire on its own — it is raised by
    // the demand-driven publisher-inbox poll in @api/distribution.ts, which runs
    // only while somebody holds a watch. Subscribing IS the demand, so take one
    // and give it back with the subscription; an extension that is unloaded (or
    // faults) must not leave a timer polling a registry on its behalf.
    if (eventName === AppEvents.WRITEBACK_SUBMISSION_RECEIVED) {
      const releasing = import("../distribution")
        .then((mod) => mod.acquireSubmissionWatch())
        .catch(() => null);
      mw.regCleanups.set(reg.regId, () => {
        unsub();
        void releasing.then((release) => release?.());
      });
      return;
    }
    mw.regCleanups.set(reg.regId, unsub);
    return;
  }
  if (reg.kind === "menuItem") {
    // Register a real menu item whose click either runs the extension's own
    // (namespaced) command or relays to its worker-side onClick handler. The
    // item id is namespaced so two extensions can't collide and cleanup is exact.
    const itemId = `ext:${mw.extId}:${reg.item.id}`;
    // HOST-DRAWN ATTRIBUTION. The declared ceiling pins the menu id and the item
    // id, but NOT the label — so an add-in that legitimately declared
    // "File/refresh" could still render it as "Save As...". Every other surface in
    // this file names its author (formula category, keybinding category, file
    // format name, ribbon group heading); the menu was the one that did not, and
    // a menu is the surface a user is most likely to read as first-party. The
    // suffix is not overridable and is stripped of control/bidi characters, so a
    // label can neither impersonate the app nor rewrite the attribution after it.
    const menuLabel = `${echoSafe(String(reg.item.label ?? reg.item.id), 96)} (${mw.extName})`;
    const action = () => {
      if (reg.commandId) {
        void CommandRegistry.execute(hostCommandId(mw.extId, reg.commandId));
      } else if (reg.handlerId !== undefined) {
        void invokeWorkerHandler(mw, reg.handlerId, []);
      }
    };
    registerMenuItem(reg.menuId, {
      id: itemId,
      label: menuLabel,
      icon: reg.item.icon,
      order: reg.item.order,
      separator: reg.item.separator,
      action,
    });
    mw.regCleanups.set(reg.regId, () => unregisterMenuItem(reg.menuId, itemId));
    acceptContribution(mw, reg.regId, "menuItem", contributionId ?? itemId, menuLabel);
    return;
  }
  if (reg.kind === "formula") {
    setupFormulaRegistration(mw, reg.regId, reg.handlerId, reg.def, contributionId ?? "");
    return;
  }
  if (reg.kind === "ribbonButton") {
    // Declarative only: the host paints the button and executes the extension's
    // OWN (namespaced) command. There is no click callback, so a sandboxed
    // add-in cannot draw arbitrary chrome or capture input in the app frame.
    const commandId = hostCommandId(mw.extId, reg.button.command);
    mw.ribbonButtons.set(reg.regId, {
      extId: mw.extId,
      extName: mw.extName,
      button: reg.button,
      commandId,
    });
    mw.regCleanups.set(reg.regId, () => {
      mw.ribbonButtons.delete(reg.regId);
      notifyContributions();
    });
    acceptContribution(mw, reg.regId, "ribbonButton", reg.button.id, reg.button.label);
    return;
  }
  if (reg.kind === "keybinding") {
    // A shortcut is a combo bound to one of the extension's OWN commands. The
    // host owns the key listener and the conflict report, so the extension
    // never observes a keystroke it was not bound to.
    const bindingId = `ext:${mw.extId}:${reg.binding.id}`;
    // A COMBO ALREADY IN USE IS REFUSED. The consent prompt can only show the
    // shortcut's declared ID (the combo lives in the bundle, not the manifest),
    // so "keyboard shortcuts: quickTax" tells the user nothing about which keys
    // are being taken. Rather than let an add-in claim Ctrl+S and rely on the
    // dispatcher's registration-order tiebreak to save us, refuse any combo that
    // is already bound — by a built-in, by another add-in, or by the user. What
    // the user is consenting to is then bounded and true: an add-in can only take
    // a shortcut nothing else uses.
    // A COMBINATION CALCULA NEEDS IS REFUSED FIRST, before the conflict check,
    // because the conflict check cannot see everything that matters. It reads
    // the keybinding REGISTRY — which does not contain the keys the grid owns
    // (Escape, Tab, Enter, the arrows, F2/F5/F9/F11, Ctrl+A, Ctrl+B/I/U,
    // Ctrl+;, Ctrl+`, the Ctrl+Shift number formats), does not contain plain
    // typing at all, and stops containing a built-in the moment a user remaps
    // it. `scriptComboRefusal` answers from a fixed rule instead: a sandboxed
    // contribution may hold Ctrl+Shift+<letter> and nothing else.
    //
    // This is the SAME rule an object script's ui.shortcut binding is held to,
    // deliberately: two sandboxed surfaces claiming keys under two different
    // policies is how one of them ends up being the lenient one. It applies
    // here even though a contribution is declared in the signed sidecar,
    // because the declaration names the shortcut's ID, not its COMBINATION —
    // "keyboard shortcuts: quickTax" tells the user nothing about which keys
    // are about to be taken, so consent cannot be what bounds this.
    const reserved = scriptComboRefusal(reg.binding.combo);
    if (reserved) {
      refuseContribution(mw, "keybinding", reg.binding.id, reserved);
      return;
    }
    const conflicts = findConflicts(reg.binding.combo);
    if (conflicts.length > 0) {
      refuseContribution(
        mw,
        "keybinding",
        reg.binding.id,
        `the shortcut ${reg.binding.combo} is already bound to "${conflicts[0].label}" — an add-in may only claim an unused shortcut`,
      );
      return;
    }
    const cleanup = registerKeybinding({
      id: bindingId,
      combo: reg.binding.combo,
      commandId: hostCommandId(mw.extId, reg.binding.command),
      label: reg.binding.label || reg.binding.id,
      // Attribution is HOST-supplied: the category names the extension so a
      // shortcut can never present itself as a built-in in the keybinding list.
      category: mw.extName,
      context: reg.binding.context ?? "always",
      source: "extension",
      extensionId: mw.extId,
    });
    mw.regCleanups.set(reg.regId, cleanup);
    acceptContribution(mw, reg.regId, "keybinding", reg.binding.id, `${reg.binding.combo} — ${reg.binding.label}`);
    return;
  }
  if (reg.kind === "cellStyle") {
    setupCellStyleRegistration(mw, reg.regId, reg.id, reg.handlerId);
    return;
  }
  if (reg.kind === "fileFormat") {
    const format = reg.format;
    const extensions = (format.extensions ?? [])
      .filter((e): e is string => typeof e === "string")
      .map((e) => e.replace(/^\./, "").toLowerCase())
      .filter((e) => /^[a-z0-9]{1,16}$/.test(e))
      .slice(0, 16);
    if (extensions.length === 0) {
      refuseContribution(
        mw,
        "fileFormat",
        format.id,
        "it names no usable file extension (letters and digits, 1-16 characters)",
      );
      return;
    }
    // NO TAKEOVER OF AN EXISTING FORMAT. findImporter picks the highest-priority
    // registration for an extension, and `priority` arrived from the sandbox — so
    // declaring `extensions: ["csv"], priority: 9999` would have silently replaced
    // the built-in CSV importer for every CSV the user ever opens, with a handler
    // that returns whatever cells it likes. The manifest declares only the format
    // ID, so consent could not have warned about it either. First registration
    // wins, exactly like the flat worksheet-function namespace: a claimed
    // extension is refused BY NAME rather than silently overriding.
    const claimed = new Set<string>();
    for (const existing of getFileFormats()) {
      for (const e of existing.extensions) claimed.add(e.toLowerCase());
    }
    const collision = extensions.find((e) => claimed.has(e));
    if (collision) {
      refuseContribution(
        mw,
        "fileFormat",
        format.id,
        `".${collision}" is already handled by another importer — an add-in may only claim a file extension nothing else handles`,
      );
      return;
    }
    const cleanup = registerFileFormat({
      id: `ext:${mw.extId}:${format.id}`,
      // Host-supplied attribution again: a format cannot masquerade as a
      // first-party importer in the Open dialog.
      name: `${echoSafe(String(format.name ?? format.id), 96)} (${mw.extName})`,
      extensions,
      // Priority is HOST-decided and negative: even if a built-in registers a
      // colliding extension LATER (load order is not a security boundary), the
      // add-in sorts below it and never wins the lookup.
      priority: -1000,
      importer: async (data: ArrayBuffer, fileName: string): Promise<ImportResult> => {
        const raw = await invokeWorkerHandler(mw, reg.handlerId, [data, fileName]);
        return sanitizeImportResult(raw);
      },
      // No exporter: an ExportContext carries live getCell/getUsedRange
      // functions — whole-workbook read authority with no capability behind it.
    });
    mw.regCleanups.set(reg.regId, cleanup);
    acceptContribution(mw, reg.regId, "fileFormat", format.id, `.${extensions.join(", .")}`);
    return;
  }
}

// ============================================================================
// Worksheet functions (the .xlam case)
// ============================================================================

/**
 * Register one extension-authored worksheet function.
 *
 * Enforcement order, all of it at REGISTRATION rather than at call time — an
 * add-in that may not contribute a function must never have that function
 * appear in the catalog or in IntelliSense, let alone evaluate:
 *   1. contribution ceiling + formula.udf capability (already applied by
 *      admitContribution before we get here);
 *   2. name shape — a formula name is a bare identifier, so a dotted or spaced
 *      name is refused rather than silently mangled;
 *   3. COLLISION — first registration wins, later ones are refused BY NAME.
 *      The formula namespace is flat and must stay Excel-compatible (prefixing
 *      would break formula portability), so a collision has to be a loud
 *      refusal; it can never be a silent rename or a silent overwrite.
 *
 * The implementation never crosses: `implementation` RPCs back into the worker
 * through the same relay a command click uses, and every invocation is brokered
 * under the formula.udf capability by formulaUdf.ts.
 *
 * NOTE ON BUILT-INS: the engine consults the UDF hook only for names it does
 * not itself know (evaluator.rs — the hook lives in the unknown-function
 * branch), so an extension cannot shadow SUM. Such a registration is inert
 * rather than dangerous; we cannot detect it synchronously here because the
 * built-in catalog lives in the backend.
 */
function setupFormulaRegistration(
  mw: MountedExtension,
  regId: number,
  handlerId: number,
  def: ExtFormulaDef,
  declaredId: string,
): void {
  const name = String(def?.name ?? "").trim().toUpperCase();
  if (name.length > MAX_EXT_FORMULA_NAME || !EXT_FORMULA_NAME_RE.test(name)) {
    refuseContribution(
      mw,
      "formula",
      declaredId || name || "(unnamed)",
      `"${def?.name}" is not a valid function name (letters, digits and underscore; no dots or spaces; max ${MAX_EXT_FORMULA_NAME} characters)`,
    );
    return;
  }
  if (hasCustomFunction(name)) {
    refuseContribution(
      mw,
      "formula",
      name,
      `a function named ${name} is already registered — the worksheet function namespace is flat, so the first registration wins`,
    );
    return;
  }

  const params = (def?.params ?? [])
    .filter((p): p is string => typeof p === "string")
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 255);
  const minArgs = clampArity(def?.minArgs, params.length, 0);
  const maxArgs =
    def?.maxArgs === -1 ? -1 : clampArity(def?.maxArgs, params.length, minArgs);

  const cleanup = registerFunction({
    name,
    description: (typeof def?.description === "string" ? def.description : "").slice(0, 1024) ||
      `Provided by the "${mw.extName}" extension`,
    syntax: `${name}(${params.join(", ")})`,
    // Attribution is HOST-supplied, never extension-supplied: the function
    // catalog must always say which add-in a function came from.
    category: mw.extName,
    minArgs,
    maxArgs,
    volatile: def?.volatile === true,
    implementation: (...args: unknown[]) => invokeWorkerHandler(mw, handlerId, args),
  });
  mw.regCleanups.set(regId, cleanup);
  // Record the capability as GRANTED to this extension, because it now genuinely
  // is: the function is live in the catalog and will run on every recalculation.
  //
  // Where the consent for it came from, precisely — this is the one place the
  // chain is not obvious. The invocation path (formulaUdf.ts) brokers each call
  // under its OWN `udf:<NAME>` handle, so the extension's grant set is never
  // consulted at call time; the real gate is here, at registration:
  // declared-in-a-signed-manifest + the package consent that ENUMERATED these
  // function names ("It adds worksheet functions: ... its code runs against your
  // data every time those cells recalculate"). Writing the grant down means the
  // transparency panel shows formula.udf in use rather than leaving the most
  // consequential contribution the only one with no capability record.
  recordCapabilityGrant(mw.handle.scriptId, "formula.udf");
  acceptContribution(mw, regId, "formula", name, `${name}(${params.join(", ")})`);
}

function clampArity(value: unknown, fallback: number, floor: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return Math.max(fallback, floor);
  return Math.min(255, Math.max(floor, Math.trunc(value)));
}

// ============================================================================
// Cell styling (the safe subset of "grid decorations")
// ============================================================================

/** Every key a style override may carry — the IStyleOverride surface, enumerated
 *  so an unknown key from untrusted code is DROPPED rather than passed to the
 *  renderer. */
const STYLE_BORDER_SIDES = ["Top", "Bottom", "Left", "Right"] as const;
const STYLE_BORDER_STYLES: ReadonlySet<string> = new Set([
  "none", "thin", "medium", "thick", "dashed", "dotted", "double",
]);
const HEX_COLOR_RE = /^#?[0-9a-fA-F]{3,8}$/;

function safeColor(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length > 32) return undefined;
  const trimmed = v.trim();
  if (trimmed.toLowerCase() === "transparent") return "transparent";
  return HEX_COLOR_RE.test(trimmed) ? trimmed : undefined;
}

/**
 * Sanitize one style override returned by SANDBOXED code before it reaches the
 * renderer. Enumerated, not filtered: an unknown property is dropped, a color
 * that is not a hex literal is dropped, a font size outside Excel's range is
 * dropped. The renderer must never receive a string it did not ask for.
 */
export function sanitizeStyleOverride(raw: unknown): IStyleOverride | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const out: IStyleOverride = {};
  const bg = safeColor(src.backgroundColor);
  if (bg) out.backgroundColor = bg;
  const fg = safeColor(src.textColor);
  if (fg) out.textColor = fg;
  for (const flag of ["bold", "italic", "underline", "strikethrough"] as const) {
    if (typeof src[flag] === "boolean") out[flag] = src[flag] as boolean;
  }
  if (typeof src.fontSize === "number" && Number.isFinite(src.fontSize)) {
    const size = src.fontSize as number;
    if (size >= 1 && size <= 409) out.fontSize = size;
  }
  if (typeof src.fontFamily === "string" && src.fontFamily.length > 0 && src.fontFamily.length <= 128) {
    // eslint-disable-next-line no-control-regex
    if (!/[\u0000-\u001f]/.test(src.fontFamily)) out.fontFamily = src.fontFamily;
  }
  for (const side of STYLE_BORDER_SIDES) {
    const color = safeColor(src[`border${side}Color`]);
    if (color) out[`border${side}Color` as keyof IStyleOverride] = color as never;
    const style = src[`border${side}Style`];
    if (typeof style === "string" && STYLE_BORDER_STYLES.has(style)) {
      out[`border${side}Style` as keyof IStyleOverride] = style as never;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Install an extension's cell-style contributor as a stale-while-revalidate
 * render cache — the SAME mechanism object scripts' `cell.onRender` uses.
 *
 * This is the honest answer to "the render path is synchronous and the
 * extension is not". We do not build a synchronous bridge (there is no safe
 * one); we cache. The interceptor body is a Map lookup, misses are batched off
 * the paint path, and a hostile or slow extension can therefore delay a
 * highlight by a frame but can never stall a frame.
 *
 * GATED BY grid.read (B2). Reaching this function already means the ceiling
 * check in admitContribution passed — CONTRIBUTION_REQUIRED_CAPABILITY maps
 * `cellStyle` to grid.read, so an add-in that did not declare it (including
 * every unsigned one, whose capability list is zeroed) was refused loudly
 * before a single cell was collected. The re-check in the resolver below is
 * deliberate belt-and-braces: the render cache outlives the registration
 * message, so the question "may this add-in be shown these cells?" is asked
 * again at the moment the cells would actually cross.
 */
function setupCellStyleRegistration(
  mw: MountedExtension,
  regId: number,
  id: string,
  handlerId: number,
): void {
  const cacheId = `extension:${mw.extId}:${id}`;
  mw.cellStyleCacheIds.add(cacheId);
  const cleanup = registerCellRenderCache(cacheId, async (cells: RenderCellRequest[]) => {
    // FAIL CLOSED, NOT BLIND. If the capability is gone by the time a batch is
    // due, return null — the documented "degraded" answer, which keeps the
    // user's own base styling. We must NOT hand the handler a stripped batch
    // (coordinates with empty values): that would look to the add-in like a
    // workbook full of blanks and to the user like styling that silently
    // stopped matching the data.
    if (!mw.handle.declaredCapabilities.has("grid.read")) return null;
    try {
      const raw = await invokeWorkerHandler(mw, handlerId, [cells]);
      if (!Array.isArray(raw)) return null;
      // Length is host-controlled: a short/long answer must not shift styles
      // onto the wrong cells.
      return cells.map((_, i) => sanitizeStyleOverride(raw[i]));
    } catch {
      // Degraded: keep base styling rather than blanking the grid.
      return null;
    }
  });
  mw.regCleanups.set(regId, () => {
    cleanup();
    mw.cellStyleCacheIds.delete(cacheId);
  });
  // Record the capability as GRANTED, for the same reason setupFormulaRegistration
  // does: from here on the contributor really will be handed the cells on
  // screen, and the transparency panel must show grid.read in use rather than
  // leaving the reach visible only in this label. The consent behind it is the
  // install-time package consent, which enumerated both the declared
  // capabilities and the cellStyles contribution with its reach note.
  recordCapabilityGrant(mw.handle.scriptId, "grid.read");
  // The label is what the transparency UI prints. A cell-style contributor is
  // the one contribution whose reach is wider than its name (it is shown the
  // DISPLAYED VALUE of every cell it is asked about), so the reach is in the
  // label rather than only in the install-time consent the user saw once.
  acceptContribution(mw, regId, "cellStyle", id, `${id} (is shown the cells it styles)`);
}

// ============================================================================
// File-format import (host does the I/O; the extension transforms bytes)
// ============================================================================

const MAX_IMPORT_SHEETS = 64;
const MAX_IMPORT_CELLS = 500_000;
const MAX_IMPORT_VALUE_CHARS = 32_768;

/** Rebuild an ImportResult field-by-field from untrusted worker output. */
function sanitizeImportResult(raw: unknown): ImportResult {
  const sheetsIn = Array.isArray((raw as { sheets?: unknown })?.sheets)
    ? ((raw as { sheets: unknown[] }).sheets)
    : [];
  const sheets: ImportResult["sheets"] = [];
  let cellBudget = MAX_IMPORT_CELLS;
  for (const s of sheetsIn.slice(0, MAX_IMPORT_SHEETS)) {
    if (!s || typeof s !== "object") continue;
    const sheet = s as { name?: unknown; cells?: unknown };
    const cellsIn = Array.isArray(sheet.cells) ? sheet.cells : [];
    const cells: ImportResult["sheets"][number]["cells"] = [];
    for (const c of cellsIn) {
      if (cellBudget <= 0) break;
      if (!c || typeof c !== "object") continue;
      const cell = c as Record<string, unknown>;
      const row = cell.row;
      const col = cell.col;
      const sheetIndex = cell.sheetIndex;
      if (!isGridIndex(row) || !isGridIndex(col)) continue;
      cells.push({
        sheetIndex: isGridIndex(sheetIndex) ? (sheetIndex as number) : 0,
        row: row as number,
        col: col as number,
        value: typeof cell.value === "string" ? cell.value.slice(0, MAX_IMPORT_VALUE_CHARS) : "",
        isFormula: cell.isFormula === true,
      });
      cellBudget--;
    }
    sheets.push({
      name: typeof sheet.name === "string" && sheet.name.trim() ? sheet.name.slice(0, 255) : "Imported",
      cells,
    });
  }
  return { sheets };
}

function isGridIndex(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10_000_000;
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
    // FAIL-CLOSED GATE. The ALLOWLIST is shared with object scripts and holds
    // restricted-tier rows a sandboxed extension must never reach (base.*,
    // sheet.*, events.subscribe, ...). Until now the only thing stopping them
    // was executeExtensionImpl's `default:` arm — fail-closed by accident, not
    // by policy, and the accident evaporates the moment someone adds a case.
    // EXTENSION_BROKER_METHODS is the policy; enforce it here, before the
    // broker, so an undeclared method never reaches capability prompting either.
    if (!EXTENSION_BROKER_METHODS.has(method)) {
      throw new BrokerError(
        "UnknownMethod",
        `Method '${method}' is not available to a sandboxed extension`,
      );
    }
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
    if (RUST_MIRRORED_CAPABILITIES.has(cap)) {
      await grantBackendCapability(handle.scriptId, cap);
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
    case "ext.invalidateCellStyles": {
      // Scope is HOST-supplied: the extension names no target, so it can only
      // ever clear the caches ITS OWN cellStyle contributions created.
      for (const cacheId of mw.cellStyleCacheIds) {
        invalidateCellRenderCache(cacheId);
      }
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
    // CUBE convenience over the SAME bi.query trust class as cap.biQuery above
    // (member-expression ergonomics instead of a hand-built QueryRequest).
    // extensionWorkerContext.ts has exposed capabilities.cube.* since it was
    // written, but these three cases were never implemented, so every call fell
    // through to `default:` and died with UnknownMethod — the identical defect
    // B5 fixed for capabilities.dialog.*, one surface over. There is no new
    // reach here: the backend commands and the bi.query grant are the same ones
    // cap.biQuery already goes through.
    case "cap.cubeValue": {
      const [connection, members] = args as [string, string[]];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("cube_udf_value", { connection, members, scriptId });
    }
    case "cap.cubeKpi": {
      const [connection, kpi, property] = args as [string, string, number];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("cube_udf_kpi", { connection, kpi, property, scriptId });
    }
    case "cap.cubeMembers": {
      const [connection, level] = args as [string, string];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("cube_udf_members", { connection, level, scriptId });
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
    case "cap.biModelValidate":
    case "cap.biModelLineage": {
      // Read-only diagnostics on the same gateway (separate Rust rate bucket).
      // Answers are rebuilt field-by-field and error text scrubbed Rust-side.
      const [connectionId, action, payload] = args as [string, string, unknown];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_bi_model", {
        connectionId,
        scriptId,
        action,
        kind: null,
        payload: payload ?? null,
      });
    }
    case "cap.biModelBatch": {
      // Atomic multi-edit: many changes, ONE undo entry. Ownership + a
      // wall-clock deadline (rollback, never commit) are enforced Rust-side.
      const [connectionId, action] = args as [string, string];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_bi_model", {
        connectionId,
        scriptId,
        action,
        kind: null,
        payload: null,
      });
    }
    // ---- distribution.writeback: the .calp collection loop ----
    case "cap.writebackListRegions":
    case "cap.writebackGetLayer": {
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_writeback", {
        scriptId,
        action: method === "cap.writebackListRegions" ? "listRegions" : "getLayer",
        payload: {},
      });
    }
    case "cap.writebackSaveDraft": {
      const [regionId, sheetId, row, col, value] = args as
        [string, string, number, number, unknown];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_writeback", {
        scriptId,
        action: "saveDraft",
        payload: { regionId, sheetId, row, col, value },
      });
    }
    case "cap.writebackSubmit": {
      const [regionId] = args as [string];
      const { invokeBackend } = await import("../backend");
      const result = await invokeBackend<{ submitted: number }>("script_writeback", {
        scriptId,
        action: "submitRegion",
        payload: { regionId },
      });
      return result?.submitted ?? 0;
    }
    case "cap.writebackPreview": {
      const [regionId] = args as [string];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_writeback", {
        scriptId,
        action: "previewSubmission",
        payload: { regionId },
      });
    }
    case "cap.writebackListSubmissions": {
      // PUBLISHER ONLY (Rust require_publisher over the signed manifest).
      const [target] = args as [Record<string, unknown>];
      const { invokeBackend } = await import("../backend");
      return invokeBackend("script_writeback", {
        scriptId,
        action: "listSubmissions",
        payload: target,
      });
    }
    case "cap.writebackReview": {
      // PUBLISHER ONLY (Rust require_publisher over the signed manifest).
      const [decision] = args as [Record<string, unknown>];
      const { invokeBackend } = await import("../backend");
      await invokeBackend("script_writeback", {
        scriptId,
        action: "setSubmissionState",
        payload: decision,
      });
      return undefined;
    }
    // ---- schedule: persistent recurring jobs (the OnTime replacement) ----
    // A sandboxed extension's CODE lives in %APPDATA%, but the SCHEDULE it
    // registers lives in the workbook, so the user reviews and cancels it in
    // the same place as a local script's. Owner identity is host-supplied from
    // the mount handle — an extension cannot schedule under another's name.
    //
    // objectType/instanceId are the extension's own id and null: a worker
    // extension exposes methods against its extension identity, not against a
    // grid object, and that is the address the scheduler calls back on.
    case "cap.scheduleEvery": {
      const [intervalSecs, handler, options] = args as [
        number,
        string,
        { label?: string } | undefined,
      ];
      const { scheduleEvery } = await import("./scheduler");
      return scheduleEvery(
        { scriptId, surface: "extension-worker", objectType: mw.extId, instanceId: null },
        intervalSecs,
        handler,
        options?.label,
      );
    }
    case "cap.scheduleAt": {
      const [timeOfDay, handler, options] = args as [
        string,
        string,
        { label?: string } | undefined,
      ];
      const { scheduleAt } = await import("./scheduler");
      return scheduleAt(
        { scriptId, surface: "extension-worker", objectType: mw.extId, instanceId: null },
        timeOfDay,
        handler,
        options?.label,
      );
    }
    case "cap.scheduleList": {
      const { listScheduledJobsForScript } = await import("./scheduler");
      return listScheduledJobsForScript(scriptId);
    }
    case "cap.scheduleCancel": {
      const [jobId] = args as [string];
      const { cancelScheduledJobForScript } = await import("./scheduler");
      return cancelScheduledJobForScript(scriptId, jobId);
    }
    // ---- ui.dialog: the sandboxed extension's only route to the user ----
    // Identity is HOST-supplied (name + origin from the mount handle), the
    // guards and every dismissal path live in scriptDialogs.ts, and a dismissal
    // resolves rather than rejecting — identical to the object-script path.
    case "cap.dialogAlert": {
      const [message, options] = args as [string, ScriptDialogTextOptions | undefined];
      await requestScriptDialog({
        scriptId,
        scriptName: mw.handle.scriptName,
        scriptOrigin: mw.handle.origin,
        kind: "alert",
        message,
        textOptions: options,
      });
      return undefined;
    }
    case "cap.dialogConfirm": {
      const [message, options] = args as [string, ScriptDialogTextOptions | undefined];
      const answer = await requestScriptDialog({
        scriptId,
        scriptName: mw.handle.scriptName,
        scriptOrigin: mw.handle.origin,
        kind: "confirm",
        message,
        textOptions: options,
      });
      return answer.dismissed === false;
    }
    case "cap.dialogPrompt": {
      const [message, options] = args as [string, ScriptDialogPromptOptions | undefined];
      const answer = await requestScriptDialog({
        scriptId,
        scriptName: mw.handle.scriptName,
        scriptOrigin: mw.handle.origin,
        kind: "prompt",
        message,
        promptOptions: options,
      });
      if (answer.dismissed) return null;
      return typeof answer.value === "string" ? answer.value : null;
    }
    case "cap.dialogForm": {
      const [spec] = args as [ScriptDialogFormSpec];
      const answer = await requestScriptDialog({
        scriptId,
        scriptName: mw.handle.scriptName,
        scriptOrigin: mw.handle.origin,
        kind: "form",
        form: spec,
      });
      if (answer.dismissed) return null;
      return answer.value !== null && typeof answer.value === "object" ? answer.value : null;
    }
    // ---- file.picker: the user picks the file, the host does the I/O ----
    // Identical construction to the object-script path: the extension supplies a
    // bare file NAME and the CONTENT (both already validated by vFileExport /
    // vFileImport), the host opens a native picker, and the human chooses where
    // it goes. The picker's title names the extension, so a file dialog can
    // never appear to have come from Calcula itself.
    case "cap.fileExportText": {
      const [suggestedName, content, options] = args as [
        string,
        string,
        { mimeType?: string; encoding?: PickerTextEncoding; description?: string } | undefined,
      ];
      const fs = await import("../filesystem");
      const extension = extFileExtensionOf(suggestedName);
      return fs.exportTextViaPicker({
        suggestedName,
        content,
        title: `${mw.handle.scriptName} — save a file`,
        filterName: extFilterLabelFor(options?.description, options?.mimeType, extension),
        filterExtensions: extension ? [extension] : [],
        encoding: options?.encoding,
      });
    }
    case "cap.fileImportText": {
      const [options] = args as [{ extensions?: string[]; description?: string } | undefined];
      const fs = await import("../filesystem");
      const extensions = (options?.extensions ?? []).map((e) => e.toLowerCase());
      return fs.importTextViaPicker({
        title: `${mw.handle.scriptName} — open a file`,
        filterName: extFilterLabelFor(options?.description, undefined, extensions[0]),
        filterExtensions: extensions,
        maxChars: MAX_FILE_TEXT_CHARS,
      });
    }
    // PDF export (G4). The extension supplies a FILE NAME and nothing else; the
    // document is rendered by trusted host code through the feature-neutral
    // @api/printService seam, from the workbook's own print settings. Rendered
    // BEFORE the picker opens, so "no print provider" is a clear refusal rather
    // than a file dialog that ends in an empty file.
    case "cap.filePrintPdf": {
      const [suggestedName] = args as [string?];
      const printService = await import("../printService");
      const bytes = await printService.renderWorkbookPdf();
      const fs = await import("../filesystem");
      return fs.exportBinaryViaPicker({
        suggestedName: suggestedName ?? "workbook.pdf",
        bytes,
        title: `${mw.handle.scriptName} — save a PDF`,
        filterName: "PDF file",
        filterExtensions: ["pdf"],
      });
    }
    default:
      throw new BrokerError("UnknownMethod", `No extension host implementation for ${method}`);
  }
}

// ---- file.picker labelling (G1) ---------------------------------------------
//
// Deliberately duplicated from host.ts rather than shared: extensionWorkerHost
// is the NARROWER door and must not start importing the object-script host, and
// these two helpers are pure string cosmetics over already-validated input. A
// mimeType or description an extension sends can only change the words on one
// filter row — never which file is written, nor where.

const EXT_MIME_FILTER_LABELS: Record<string, string> = {
  "text/csv": "CSV file",
  "text/plain": "Text file",
  "text/tab-separated-values": "Tab-separated file",
  "text/markdown": "Markdown file",
  "text/html": "HTML file",
  "application/json": "JSON file",
  "application/xml": "XML file",
  "text/xml": "XML file",
};

function extFileExtensionOf(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return undefined;
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(ext) ? ext : undefined;
}

function extFilterLabelFor(
  description: string | undefined,
  mimeType: string | undefined,
  extension: string | undefined,
): string {
  if (description && description.trim().length > 0) return description.trim();
  if (mimeType && EXT_MIME_FILTER_LABELS[mimeType]) return EXT_MIME_FILTER_LABELS[mimeType];
  if (extension) return `${extension.toUpperCase()} file`;
  return "File";
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
