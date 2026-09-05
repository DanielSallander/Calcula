// FILENAME: app/src/api/scriptHost/capabilities.ts
// PURPOSE: The host-side capability GRANT store + grant-flow orchestration
//          (Phase 4). The broker (broker.ts) only ENFORCES — it denies any
//          capability not in handle.grants. This module is where grants come
//          from: handle.grants is a live reference to getGrantSet(scriptId), so
//          a JIT/consent grant recorded here is seen immediately by the broker.
//
// SECURITY: this is the frontend half. For net.fetch the authoritative gate is
// Rust (capability_store.rs / script_http_fetch re-checks the origin per call).
// Every granted net.fetch origin is mirrored to the Rust store via
// grant_script_net_origin; the renderer's grant set is only the coarse "does
// this script have net.fetch at all" gate that lets the call reach Rust.
//
// Local scripts acquire caps via JIT (R10: Allow once / Always / Deny on first
// use). Distributed scripts acquire them via package consent (Phase 4.2) — JIT
// is suppressed for them here.
//
// GRANTS HAVE A SCOPE, and it is not the same one for both kinds. A PROMPTED
// grant is scoped to the workbook the dialog named ("remember it for this script
// in this workbook" — CapabilityRequestDialog.tsx), so the workbook reset drops
// it. A grant the INSTALL screen already promised — an add-in's grid.read /
// formula.udf, written down by the host with no prompt at all — is scoped to the
// MOUNT: a distributed add-in is NOT unmounted by a workbook swap, and there is
// no prompt that could hand the capability back, so dropping it there would
// silently break the add-in for the rest of the session. See
// `installScopedGrants` and `resetAllGrants` below.
//
// "ALWAYS" NOW MEANS ALWAYS (F1). A local script's "Allow always" decision is
// persisted per WORKBOOK + SCRIPT + SOURCE HASH in @api/scriptSecurity (local
// user state, localStorage, never inside the file) and re-established at mount
// by `restoreAndSyncGrants` below. Two rules keep that from being a widening:
//   * the restore goes through the SAME `grant_script_capability` /
//     `grant_script_net_origin` commands a fresh consent uses, so Rust remains
//     the authority and its own allowlist still validates every id; and
//   * only the exact ids/origins recorded are restored, so any escalation lands
//     outside the grant set and re-prompts.
// scriptSecurity.ts is DYNAMICALLY imported (it imports distributedConsent,
// which imports this module — a static edge would close that cycle).

import type { CapabilityId } from "./allowlist";
import { CAPABILITY_ID_SET } from "./capabilityIds";
import { isLocalOrigin, type ScriptOrigin } from "./scriptOrigin";
import { invokeBackend } from "../backend";
import { confirmAsync } from "../dialogs";
import { emitAppEvent } from "../events";

// ============================================================================
// Live in-memory grant store (session-scoped)
// ============================================================================

interface ScriptGrantState {
  /** The live capability set; handle.grants references this object. */
  caps: Set<CapabilityId>;
  /** Granted net.fetch origins (normalized "https://host[:port]"). */
  origins: Set<string>;
}

const grantState = new Map<string, ScriptGrantState>();

function ensureState(scriptId: string): ScriptGrantState {
  let s = grantState.get(scriptId);
  if (!s) {
    s = { caps: new Set(), origins: new Set() };
    grantState.set(scriptId, s);
  }
  return s;
}

/**
 * The LIVE capability set for a script. buildHandleFromDefinition stores this
 * object on handle.grants, so grants recorded after mount (JIT/consent) take
 * effect for the broker's checkPolicy without rebuilding the handle.
 */
export function getGrantSet(scriptId: string): Set<CapabilityId> {
  return ensureState(scriptId).caps;
}

export function hasFetchOrigin(scriptId: string, origin: string): boolean {
  return ensureState(scriptId).origins.has(origin);
}

export function getGrantedOrigins(scriptId: string): string[] {
  return [...ensureState(scriptId).origins];
}

/**
 * Capabilities the user REVOKED this session, per script. A revoke is a
 * DECISION, not a momentary state, so nothing that merely OBSERVES the code
 * about to use a capability may put it back.
 *
 * THE DEFECT THIS EXISTS FOR. An extension's `grid.read` is written down by the
 * host at contribution REGISTRATION — a form carrying a `bind`, a cell-style
 * contributor, a subscription to an event that carries cell contents — and a
 * `register` message is one the sandboxed worker may post at ANY moment after
 * activation (from a command click, an event handler, a scheduled job). So an
 * add-in whose grid.read the user had just revoked in the transparency panel
 * got it straight back by registering a second declared form, or merely by
 * unregistering and re-registering its only one. It was silent (no prompt, no
 * toast), and from that moment its cell-style contributor was again handed the
 * displayed value of every cell on screen, its CELL_VALUES_CHANGED deliveries
 * came un-redacted again, and its next form show read the bound cell again.
 *
 * Only two things clear an entry: a FRESH CONSENT (`recordCapabilityGrant`,
 * below — every one of its callers is a decision the user just made), and the
 * script's grants being dropped wholesale on UNMOUNT. Both are host- or
 * user-driven; no worker message reaches either. A workbook reset is neither: it
 * reloads nothing, and the add-in it would be lifting the decision for is still
 * running (see `resetAllGrants`).
 */
const revokedThisSession = new Map<string, Set<CapabilityId>>();

/** Did the user revoke this capability from this script during this session? */
export function wasRevokedThisSession(scriptId: string, cap: CapabilityId): boolean {
  return revokedThisSession.get(scriptId)?.has(cap) === true;
}

/**
 * Record a grant in the live set. The caller is responsible for mirroring a
 * net.fetch origin to the Rust store (grantNetOrigin) and persisting an
 * "always" grant (Phase 4.2).
 *
 * EVERY CALLER OF THIS FUNCTION IS A CONSENT: a JIT dialog the user answered,
 * the package consent screen, or the restore of a persisted "Always" recorded
 * for this exact source. That is why reaching here LIFTS a session revoke — the
 * question was asked again and answered yes. A grant nobody was asked about
 * (the host noticing that a registered contribution will use a capability) must
 * go through `recordCapabilityGrantUnlessRevoked` instead.
 */
export function recordCapabilityGrant(
  scriptId: string,
  cap: CapabilityId,
  origin?: string,
): void {
  const s = ensureState(scriptId);
  s.caps.add(cap);
  if (origin) s.origins.add(origin);
  revokedThisSession.get(scriptId)?.delete(cap);
}

/**
 * Capabilities a script holds because INSTALLING it was the consent, rather than
 * because somebody answered a prompt. Only the extension host writes these — an
 * add-in's `grid.read` for a contribution that is about to be handed cells, and
 * `formula.udf` for a worksheet function it registered — and the install screen
 * says so in those words: "granted by installing ... they take effect as soon as
 * the add-in loads, with no further prompt" (InstallAddInDialog.tsx, pinned by
 * installConsentText.test.ts).
 *
 * THE DEFECT THIS EXISTS FOR. `resetAllGrants` is the WORKBOOK reset, and a
 * distributed add-in is not unmounted on that path — nothing calls
 * `resetWorkerExtensions` from AFTER_OPEN / AFTER_NEW. Emptying its grants there
 * would contradict that install sentence in the one direction that cannot be
 * repaired: no prompt exists that would bring `grid.read` back, so the add-in
 * would quietly stop being shown cells the moment the user opened a second
 * workbook, and its worksheet functions would keep running while the
 * transparency panel reported no capability behind them.
 *
 * A PROMPTED grant is the opposite case and is deliberately NOT recorded here:
 * the JIT dialog scopes itself to "this script in this workbook", so the next
 * workbook asks again.
 */
const installScopedGrants = new Map<string, Set<CapabilityId>>();

/**
 * Record a grant whose consent is the INSTALL, not a prompt (see
 * `installScopedGrants`). It survives a workbook reset for as long as the code
 * holding it stays mounted, and goes with everything else when it is unmounted.
 */
export function recordCapabilityGrantAtInstall(scriptId: string, cap: CapabilityId): void {
  recordCapabilityGrant(scriptId, cap);
  let fromInstall = installScopedGrants.get(scriptId);
  if (!fromInstall) {
    fromInstall = new Set<CapabilityId>();
    installScopedGrants.set(scriptId, fromInstall);
  }
  fromInstall.add(cap);
}

/**
 * Record a grant that NOBODY WAS ASKED ABOUT — the host observing that a
 * contribution which will use the capability has been registered (an add-in's
 * cell-style contributor, a form with a bound field, a subscription to an event
 * carrying cell contents). Install-time consent is what backs these, which is
 * why they are written down with no prompt; that also makes them the one class
 * of grant an ATTACKER CAN TIME, because `register` is a worker message.
 *
 * Returns false — and writes NOTHING — when the user has revoked this
 * capability for this script since. The caller must then degrade (and say so),
 * never proceed as though it had been granted.
 *
 * Install-time consent is also this grant's SCOPE, so it is written down through
 * `recordCapabilityGrantAtInstall`: a workbook swap leaves the add-in mounted
 * and would leave it with no way of asking for the capability again.
 */
export function recordCapabilityGrantUnlessRevoked(
  scriptId: string,
  cap: CapabilityId,
): boolean {
  if (wasRevokedThisSession(scriptId, cap)) return false;
  recordCapabilityGrantAtInstall(scriptId, cap);
  return true;
}

/** Forget a script's session grants (unmount). Per-script Rust state is
 *  cleared via revokeBackendCapabilities on unmount. */
export function revokeScriptGrants(scriptId: string): void {
  // EMPTIED IN PLACE BEFORE THE ENTRY GOES. `handle.grants` is a live reference
  // to this exact Set (broker.ts `buildHandleFromDefinition`), so dropping only
  // the Map entry hands every holder of that reference a full grant set the
  // store no longer knows about — one nothing here can revoke any more.
  const s = grantState.get(scriptId);
  if (s) {
    s.caps.clear();
    s.origins.clear();
  }
  grantState.delete(scriptId);
  installScopedGrants.delete(scriptId);
  deniedThisSession.delete(scriptId);
  // The session revoke goes with them, for the same reason the session denials
  // do: this runs on UNMOUNT, which is host- or user-driven — no worker message
  // causes one — so the code that comes back is being loaded again under its
  // install consent, not sneaking past a decision. A WORKBOOK RESET is not that
  // case and does not reach here; see `resetAllGrants`.
  revokedThisSession.delete(scriptId);
  lapsedGrantNotices.delete(scriptId);
}

/**
 * The WORKBOOK reset — File > Open / File > New, via host.ts `hostResetAll`.
 *
 * IT NO LONGER DROPS THE MAP ENTRIES, and that is the whole of the fix.
 * `handle.grants` is a live reference to the `Set` inside an entry (broker.ts:
 * `getGrantSet(definition.id)`), taken ONCE at mount, and a distributed add-in
 * is not unmounted on this path — nothing calls `resetWorkerExtensions` from
 * AFTER_OPEN / AFTER_NEW. A bare `grantState.clear()` therefore left every
 * mounted add-in holding a Set the store no longer knew about, and all three
 * readers disagreed from then on: the transparency panel still listed the
 * capability and still drew its revoke button (PermissionsPanel renders
 * `handle.grants`), `revokeCapability` returned at its `if (!s) return;` guard
 * without touching the Set the broker actually reads, and the capability kept
 * working — so `extensionFormBindings.ts`'s promise that a revoke bites the next
 * show was false for the rest of the session after the user's first File > Open.
 * A grant recorded AFTER the reset was orphaned the other way, landing in a
 * fresh entry the handle does not reference, which made the JIT prompt re-ask
 * forever. Both directions are fixed by keeping the Set the handle holds.
 *
 * WHAT IS CLEARED is every grant a prompt or a per-workbook consent produced —
 * the JIT dialog scopes itself to "this script in this workbook" — including
 * every granted net.fetch origin, since an origin only ever comes from one of
 * those. WHAT SURVIVES is the install-scoped set (`installScopedGrants`), for
 * exactly as long as the code holding it stays mounted; `revokeScriptGrants`
 * takes those too when it goes.
 *
 * THE SESSION REVOKES SURVIVE IT AS WELL, unlike the denials. Nothing is
 * reloaded here — the add-in never left — so lifting its revoke would let it
 * take the capability straight back by registering another bound form, which is
 * the exact laundering `revokedThisSession` exists to stop, one workbook swap
 * later. A fresh consent still lifts it, as it always did.
 */
export function resetAllGrants(): void {
  for (const [scriptId, s] of grantState) {
    const fromInstall = installScopedGrants.get(scriptId);
    for (const cap of [...s.caps]) {
      if (!fromInstall?.has(cap)) s.caps.delete(cap);
    }
    s.origins.clear();
  }
  deniedThisSession.clear();
  lapsedGrantNotices.clear();
}

// ============================================================================
// Origin parsing — MUST agree with Rust normalize_origin (scheme://host[:port],
// lowercase, default 443 omitted). A mismatch only fails closed (Rust re-checks
// authoritatively), but agreement is what makes a granted fetch actually work.
// ============================================================================

export function fetchOriginOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    if (u.username || u.password) return null; // userinfo — Rust rejects it too
    const host = u.hostname.toLowerCase();
    const port = u.port && u.port !== "443" ? `:${u.port}` : "";
    return `https://${host}${port}`;
  } catch {
    return null;
  }
}

// ============================================================================
// Rust mirror (the authoritative net.fetch gate)
// ============================================================================

/** Mirror one granted origin to the Rust store (called immediately on grant). */
export async function grantNetOrigin(scriptId: string, origin: string): Promise<void> {
  await invokeBackend("grant_script_net_origin", { scriptId, origin });
}

/** Re-push all of a script's session-granted origins to Rust (called at mount,
 *  so grants survive an unmount/remount within the session). */
export async function syncNetOriginsToBackend(scriptId: string): Promise<void> {
  for (const origin of getGrantedOrigins(scriptId)) {
    try {
      await invokeBackend("grant_script_net_origin", { scriptId, origin });
    } catch {
      /* best-effort; the script will JIT-reprompt if Rust lacks the origin */
    }
  }
}

/** The capabilities whose authoritative gate lives in the Rust CapabilityStore
 *  (bi_query / script_bi_sql / script_bi_model / the connector host /
 *  script_writeback re-check it per call). Grants for these are mirrored to
 *  Rust on grant, on mount, and on reconcile.
 *
 *  MUST stay a subset of the backend's GRANTABLE_CAPABILITIES allowlist
 *  (app/src-tauri/src/scripting/writeback_gateway.rs) — an id the backend does
 *  not accept fails the mirror, and the script's next call is denied there. */
export const RUST_MIRRORED_CAPABILITIES: ReadonlySet<CapabilityId> = new Set([
  "bi.query",
  "bi.sql",
  "bi.model",
  "bi.connector",
  "distribution.writeback",
  // The scheduler re-checks this grant on EVERY firing (script_scheduler
  // "due"), which is the whole point: a revoke has to stop a job that is
  // already persisted in the workbook, not merely block new registrations.
  "schedule",
  // The .calp distribution gateway (script_distribution) re-checks the ACTION'S
  // OWN capability per call — and these two are never one grant, so both have
  // to be mirrored or one of them is silently unusable.
  "distribution.publish",
  "distribution.subscribe",
] as CapabilityId[]);

/** Mirror one consent-granted capability to the Rust store (called immediately
 *  on grant). The Rust gates re-check the store authoritatively per call.
 *  `grant_script_capability` is the GENERIC mirror — it replaced the bi-only
 *  `grant_script_bi`, whose id check rejected everything outside `bi.*`. */
export async function grantBackendCapability(
  scriptId: string,
  cap: CapabilityId,
): Promise<void> {
  await invokeBackend("grant_script_capability", { scriptId, capability: cap });
}

/** Re-push a script's session-granted backend capabilities to Rust (mount), so
 *  they survive an unmount/remount within the session — parallel to net origins. */
export async function syncBackendGrants(scriptId: string): Promise<void> {
  const { caps } = getScriptGrants(scriptId);
  for (const cap of caps) {
    if (RUST_MIRRORED_CAPABILITIES.has(cap)) {
      try {
        await grantBackendCapability(scriptId, cap);
      } catch {
        /* best-effort; the script JIT-reprompts if Rust lacks the grant */
      }
    }
  }
}

/** Reconcile the authoritative Rust store to a script's CURRENT live grant set
 *  (clear, then re-push net origins + BI caps). Used after a single-capability
 *  revoke so dropping one cap never leaves a sibling stale or accidentally nukes
 *  it (the coarse revoke_script_capabilities clears the whole entry). */
export async function reconcileBackendGrants(scriptId: string): Promise<void> {
  const { caps, origins } = getScriptGrants(scriptId);
  try {
    await invokeBackend("revoke_script_capabilities", { scriptId });
    for (const origin of origins) {
      await invokeBackend("grant_script_net_origin", { scriptId, origin });
    }
    for (const cap of caps) {
      if (RUST_MIRRORED_CAPABILITIES.has(cap)) {
        await grantBackendCapability(scriptId, cap);
      }
    }
  } catch {
    /* best-effort; the script JIT-reprompts / re-syncs if Rust lacks a grant */
  }
}

/**
 * Read a script's CURRENT backend grants. The only way to see what a
 * Rust-QuickJS surface (a notebook) may touch: its JIT consent grants live in
 * the Rust CapabilityStore and are never mirrored into `grantState` here.
 * Read-only; used by the "Code in This File" transparency inventory.
 *
 * The Rust store holds ONE capability set, so this returns EVERY granted id
 * (bi.* AND distribution.writeback) — which is the honest answer to "what can
 * this script touch?".
 */
export async function listBackendCapabilityGrants(scriptId: string): Promise<CapabilityId[]> {
  const caps = await invokeBackend<string[]>("list_script_capability_grants", { scriptId });
  return caps as CapabilityId[];
}

/** Drop a script's Rust-side grants (called on unmount). */
export async function revokeBackendCapabilities(scriptId: string): Promise<void> {
  try {
    await invokeBackend("revoke_script_capabilities", { scriptId });
  } catch {
    /* best-effort */
  }
}

/** Read-only snapshot of a script's current grants (for the transparency panel). */
export function getScriptGrants(scriptId: string): { caps: CapabilityId[]; origins: string[] } {
  const s = grantState.get(scriptId);
  return s ? { caps: [...s.caps], origins: [...s.origins] } : { caps: [], origins: [] };
}

/**
 * Revoke ONE capability from a (possibly still-mounted) script — the
 * transparency-panel "revoke" action (R10: grants are revocable). It MUTATES the
 * live grant set in place (handle.grants references it, so the broker's check
 * stops admitting the cap immediately) rather than replacing it. For net.fetch
 * it also clears the script's granted origins and the authoritative Rust store.
 * The script keeps running; its next use of the cap re-prompts (local) or is
 * denied (distributed). ui.html and other grants are untouched.
 *
 * IT ALSO STICKS. Deleting from the live set alone was undone by the next thing
 * that wrote the grant WITHOUT asking — for an add-in, its own next
 * registration (see `revokedThisSession`). The decision is remembered until a
 * fresh consent, or until the script's grants are dropped wholesale.
 */
export async function revokeCapability(scriptId: string, cap: CapabilityId): Promise<void> {
  // Remembered BEFORE the early return below: a script with no live grant state
  // yet must still not be handed this capability by a later silent write.
  let revoked = revokedThisSession.get(scriptId);
  if (!revoked) {
    revoked = new Set<CapabilityId>();
    revokedThisSession.set(scriptId, revoked);
  }
  revoked.add(cap);
  const s = grantState.get(scriptId);
  if (!s) return;
  s.caps.delete(cap);
  if (cap === "net.fetch") s.origins.clear();
  // For any capability the Rust store tracks (net origins + the BI family),
  // reconcile the authoritative store to the now-reduced live grant set rather
  // than coarse-dropping the whole entry — so revoking one cap leaves the
  // script's other grants intact in Rust.
  if (cap === "net.fetch" || RUST_MIRRORED_CAPABILITIES.has(cap)) {
    await reconcileBackendGrants(scriptId);
  }
}

// ============================================================================
// Persisted "Always allow in this workbook" grants (F1)
// ============================================================================

/** scriptId -> a user-facing explanation (with a diff) of a persisted grant that
 *  was DISCARDED at mount because the script's source changed. Consumed ONCE by
 *  the next JIT prompt, so the user re-approves against the change rather than
 *  blindly. Session-scoped by design: it is a notice, not a decision. */
const lapsedGrantNotices = new Map<string, string>();

/** Record a lapse notice for the next prompt (called by the mount-time restore). */
export function noteLapsedGrant(scriptId: string, notice: string): void {
  lapsedGrantNotices.set(scriptId, notice);
}

/** Take (and clear) a pending lapse notice for a script. */
export function consumeLapsedGrantNotice(scriptId: string): string | null {
  const notice = lapsedGrantNotices.get(scriptId) ?? null;
  lapsedGrantNotices.delete(scriptId);
  return notice;
}

/** Test/lifecycle hook: forget every pending lapse notice. */
export function resetLapsedGrantNotices(): void {
  lapsedGrantNotices.clear();
}

/** What `restoreAndSyncGrants` needs from a mount. Deliberately the AUTHORITATIVE
 *  pieces only — an id, the source the host is about to run, the origin the
 *  broker derived, and the R19 ceiling. Nothing script-supplied. */
export interface GrantRestoreTarget {
  scriptId: string;
  scriptName: string;
  source: string;
  /** `handle.origin` — the STRUCTURAL trust origin (`ScriptOrigin`). Only
   *  `{ kind: "local" }` restores persisted grants; distributed code never
   *  JIT-prompts and never persists here. It was a bare string, which made an
   *  application NAMED `local` eligible for a local script's persisted grants. */
  origin: ScriptOrigin;
  /** `handle.declaredCapabilities` — the ceiling a restored id must still fit. */
  declaredCapabilities: Iterable<CapabilityId>;
}

/**
 * Mount-time hydration + backend sync, in the one order that is correct:
 *
 *  1. restore this script's PERSISTED "Always" decisions for THIS EXACT SOURCE
 *     (dropped and replaced by a lapse notice if the source changed),
 *  2. push the resulting live grant set to the authoritative Rust store.
 *
 * Step 2 subsumes the old standalone `syncNetOriginsToBackend`/`syncBackendGrants`
 * pair for a remount, so a remount within the session still keeps its session
 * grants. Distributed scripts skip step 1 entirely: their capabilities come from
 * package consent, which is persisted INSIDE the workbook (it must survive a
 * copy) and applied before mount by `applyConsentedCapabilities`.
 */
export async function restoreAndSyncGrants(target: GrantRestoreTarget): Promise<void> {
  if (isLocalOrigin(target.origin)) {
    try {
      const { restorePersistedScriptCapabilityGrant } = await import("../scriptSecurity");
      const restored = await restorePersistedScriptCapabilityGrant({
        scriptId: target.scriptId,
        source: target.source,
        declaredCapabilities: [...target.declaredCapabilities],
      });
      for (const cap of restored.capabilities) {
        recordCapabilityGrant(target.scriptId, cap);
      }
      for (const origin of restored.netOrigins) {
        recordCapabilityGrant(target.scriptId, "net.fetch", origin);
      }
      if (restored.lapseNotice) noteLapsedGrant(target.scriptId, restored.lapseNotice);
    } catch (e) {
      // Fail CLOSED: no restore means the script simply JIT-prompts again.
      console.warn("[caps] could not restore persisted capability grants:", e);
    }
  }
  await syncNetOriginsToBackend(target.scriptId);
  await syncBackendGrants(target.scriptId);
}

/**
 * Persist an "Allow always" decision for a LOCAL script. Called from the JIT
 * path the moment the user chooses it. Best-effort: an unsaved workbook (no
 * path to bind to) simply keeps the grant session-only, which is what the
 * dialog's own scope wording ("in this workbook") already implies.
 */
export async function persistAlwaysGrant(args: {
  scriptId: string;
  scriptName: string;
  source: string;
  /** `handle.origin`; any kind but `local` is ignored (package consent path).
   *  Structural, so a package NAMED `local` cannot reach this store. */
  origin: ScriptOrigin;
  capability: CapabilityId;
  netOrigin?: string | null;
}): Promise<void> {
  if (!isLocalOrigin(args.origin)) return;
  try {
    const { persistScriptCapabilityGrant } = await import("../scriptSecurity");
    await persistScriptCapabilityGrant({
      scriptId: args.scriptId,
      scriptName: args.scriptName,
      source: args.source,
      capability: args.capability,
      netOrigin: args.netOrigin ?? null,
    });
  } catch (e) {
    console.warn("[caps] could not persist an 'always' capability grant:", e);
  }
}

// ============================================================================
// JIT grant request/response (R10) — request emitted host-side, the
// ScriptableObjects extension renders the dialog and resolves the decision.
// ============================================================================

export type CapabilityDecision = "once" | "always" | "deny";

export interface CapabilityRequestPayload {
  requestId: string;
  scriptId: string;
  scriptName: string;
  capability: CapabilityId;
  /** Human description of the capability for the dialog. */
  description: string;
  /** For net.fetch, the concrete origin being requested; null otherwise. */
  origin: string | null;
  /**
   * `<package>@<version>` when this prompt was raised because the script is
   * calling a SHARED LIBRARY that holds the capability, null when the script is
   * reaching for it directly.
   *
   * HONEST CONSENT: the two cases are not the same question. "This script wants
   * to fetch from the web" and "this script is calling acme.http, which fetches
   * from the web" have different answers for a user who trusts the script but
   * has never heard of the library, so the difference must reach the dialog.
   * `description` already carries it in prose (the dialog renders that verbatim);
   * this field is the machine-readable form for richer UI and for tests.
   */
  viaLibrary: string | null;
}

/** Human-facing capability descriptions for the JIT dialog. */
const CAP_DESCRIPTION: Record<CapabilityId, string> = {
  "net.fetch": "fetch data from the web",
  "bi.query": "run read-only BI queries (model-scoped)",
  "bi.sql": "run read-only RAW SQL against your BI database",
  // WHERE it stores, not just that it stores. "on this device" was wrong in the
  // one direction that misleads: the store is .calcula/script-data/<id>.json
  // INSIDE the .cala file (host.ts scriptStoragePath), so it is not a private
  // corner of the user's machine — it travels with the workbook. A user who
  // approves "store data on this device" and then mails the file has shared
  // whatever the script kept, which is the opposite of what they were told.
  storage:
    "store its own private data inside this workbook file (up to 256 KB; it travels with the file if you share it)",
  // Paint only. The frame cannot be clicked into OR TABBED INTO without
  // `ui.htmlInput` below, which is why this sentence is allowed to stay as
  // short as it is — and that is now true of EVERY host of such a document (the
  // on-grid overlay, the Controls-pane card and the Properties pane's preview),
  // not just the one the split was written for. The Controls-pane card took
  // clicks, focus and keystrokes on this sentence alone until the gate was put
  // in on both sides; hit-transparency then closed the mouse and left the
  // keyboard, because an iframe keeps its place in the tab order however it is
  // styled, so each host also marks the frame `inert`.
  // `htmlInputConsentHonesty.test.ts` now fails if a host drifts back on either.
  "ui.html": "render custom HTML UI",
  // The other half, split out in M6b. Says what the USER loses — the input goes
  // to the script instead of to Calcula — rather than naming the mechanism
  // ("hit regions"), because the mechanism is the part nobody can picture. It
  // names TYPING as well as clicking because the two hosts take different
  // amounts: on the grid the host forwards pointer events into rectangles the
  // script named, while a claimed pane card is an ordinary interactive frame the
  // user can focus and type into. A sentence that promised only clicks would be
  // true of the smaller host and false of the other, which is the exact failure
  // this id was split out to stop.
  "ui.htmlInput":
    "receive what you click and type inside the HTML it draws — where it claims your input, it reaches the script instead of Calcula: on the grid a click stops selecting a cell, and on a Controls-pane card the whole card is taken at once",
  // "evaluate worksheet formulas" described the wrong direction — it sounds like
  // the script gets to READ your sheet through the formula engine, and it is
  // asking for the reverse: to BE a formula. The consequence that matters is
  // that its code then runs on every recalculation of every cell that uses it,
  // without the user invoking anything.
  "formula.udf":
    "provide formula functions your cells can call — its code then runs every time such a cell recalculates",
  "bi.model": "modify your BI model definitions (measures, relationships, ... — undoable; never security roles or connections)",
  "bi.connector": "feed external data into your BI model as a data connector",
  "ui.dialog": "show you a dialog and receive what you enter",
  "ui.pane": "show you a task pane you can keep open beside the grid while you work, and read what you enter in it",
  "distribution.writeback":
    "fill in the input cells of a subscribed application and send your answers to its publisher (and, if it can sign the application, read and approve everyone else's)",
  // Honest on THREE counts, and the third one used to be wrong. It starts ITSELF
  // (the novel authority); it only does so while the app is open (the honest
  // limit — a user who reads "on a schedule" and pictures a service emailing
  // them at 3am has been misled); and it only survives a restart if the answer
  // to THIS dialog is "Always". The old wording promised "saved in this
  // workbook, so it resumes next time you open it" before the user had chosen
  // anything, which was false for the "Once" button standing right next to it:
  // the JOB is saved in the workbook, but the PERMISSION it needs to fire is
  // not, unless it is remembered. Never state the outcome of a choice the user
  // has not made yet.
  schedule:
    "run on a schedule while Calcula is open, without you starting it (the job is saved in this workbook; it only keeps running after a restart if you answer 'Always')",
  // Says what it CAN do and, in the same breath, the limit that makes it safe —
  // because "read and write files" without the second clause would describe
  // VBA's FileSystemObject, and this is deliberately not that. It cannot reach a
  // file you did not just choose, it is never told where anything on this
  // machine is, and every call opens a picker you drive.
  "file.picker":
    "ask you to pick a file — to save data into, or to open and read. You choose the file in the usual Windows dialog every single time; it can never reach a file you did not just pick, and it is never told where your files are",
  // Three honest clauses, in the order a worried person asks them. What it
  // takes (one shortcut, of a shape that cannot collide with typing or with the
  // keys Calcula needs), what it CANNOT take (anything already in use — and it
  // never sees the keyboard, only its own combination), and how you take it
  // back (it is in the shortcut list, and it disappears when the script stops).
  // "Read your keystrokes" is what a user fears here, so the text must deny it
  // explicitly rather than leave it unmentioned.
  "ui.shortcut":
    "claim a keyboard shortcut of the form Ctrl+Shift+<letter>, so pressing it runs its code. It cannot take a shortcut anything else already uses, it cannot take the keys Calcula needs, and it never sees anything you type — only that its own shortcut was pressed. It appears in your shortcut list and goes away when the script stops",
  // Phrased as a PUSH, because that is what it is: nothing here asks for a cell
  // by address. The host hands an add-in the values so it can decide how to
  // paint them, hands it each edit so it can react, and puts a cell's contents
  // in a field of its form when the form names one. The three clauses are the
  // three real paths (cell styling; the cell-change events; a form's bound
  // field — M4), and the last clause is the honest limit — it is shown what is
  // there, it cannot change it, and it cannot send it anywhere without a
  // separate permission you would also be asked for. A path added here without
  // a clause makes this sentence stale by omission, which is why the honesty
  // test counts them.
  //
  // "EACH TIME THAT FORM OPENS", not "while it is open", and the difference is
  // load-bearing: an add-in's bound field is seeded ONCE, at show
  // (resolveExtensionFormBindings), and there is no live cell watch behind it.
  // The object-script pipeline does re-read on every change; describing this
  // surface with that sentence would have promised a reach the code does not
  // take, which is the same defect as understating one.
  "grid.read":
    "be shown the contents of your cells — the value of every cell on screen while it decides how to style them, the old value, new value and formula of every cell that changes, and the contents of any cell a field of one of its forms is tied to, each time that form opens. It cannot change your cells with this, and it cannot send them anywhere without separately asking you for network or file access",
  // OUTBOUND. The two clauses a person needs before saying yes: WHO it goes out
  // as (you, cryptographically), and that it cannot be recalled. The last clause
  // is the honest limit that makes this grantable — a script cannot become a
  // publisher, only act as one you already are.
  "distribution.publish":
    "publish this workbook to one of your workspaces, signed with YOUR publisher key, where everyone subscribed to that application will receive it. It leaves this machine and cannot be taken back. It can only publish to workspaces you already added, and only if you have published something yourself before — a script cannot create your publisher identity",
  // INBOUND. Deliberately phrased as "somebody else's code arrives", because
  // that is the risk, and then the two bounds that contain it: it cannot reach a
  // workspace you did not add, and it cannot switch the code on.
  "distribution.subscribe":
    "bring somebody else's published applications into this workbook — their sheets, their data and any code they carry — and update the ones you already subscribe to. It can only use workspaces you added yourself, everything it brings in is signature-checked exactly as if you had subscribed by hand, and any code that arrives stays switched off until you approve it (including code that CHANGED in an update)",
};

/** One-line description of a capability id, for transparency UI (extension
 *  manager, audit panels). Single source of truth — reuses the JIT-dialog map. */
export function describeCapability(id: CapabilityId): string {
  return CAP_DESCRIPTION[id] ?? id;
}

/** requestId -> resolver. */
const pendingRequests = new Map<string, (d: CapabilityDecision) => void>();
let requestSeq = 0;

/** scriptId -> set of "cap|origin" keys denied this session (avoid prompt spam). */
const deniedThisSession = new Map<string, Set<string>>();

function denyKey(cap: CapabilityId, origin: string | null): string {
  return `${cap}|${origin ?? "*"}`;
}

export function wasDeniedThisSession(
  scriptId: string,
  cap: CapabilityId,
  origin: string | null,
): boolean {
  return deniedThisSession.get(scriptId)?.has(denyKey(cap, origin)) === true;
}

function rememberDenied(scriptId: string, cap: CapabilityId, origin: string | null): void {
  let s = deniedThisSession.get(scriptId);
  if (!s) {
    s = new Set();
    deniedThisSession.set(scriptId, s);
  }
  s.add(denyKey(cap, origin));
}

/**
 * Prompt the user (JIT) for a capability. Resolves to the decision; a 60s
 * no-answer falls back to "deny". The dialog is rendered by the
 * ScriptableObjects extension, which calls resolveCapabilityRequest.
 *
 * If this script had a persisted "Always" grant that LAPSED because its source
 * changed, the diff is shown FIRST and must be acknowledged before the grant
 * dialog appears — re-consent after an edit is never a blind re-approval, and
 * declining the notice is a deny (remembered for the session like any other).
 */
export async function requestCapabilityGrant(args: {
  scriptId: string;
  scriptName: string;
  capability: CapabilityId;
  origin: string | null;
  /** `<package>@<version>` when the request is raised on the way into a shared
   *  library that holds this capability. Folded into the rendered description so
   *  the user is told WHY they are being asked now. */
  viaLibrary?: string | null;
}): Promise<CapabilityDecision> {
  const lapse = consumeLapsedGrantNotice(args.scriptId);
  if (lapse) {
    // THE ACKNOWLEDGEMENT IS THE POINT. This notice is shown when a script that
    // held a persisted "Allow always" grant has been EDITED since, so the grant
    // lapsed. The docs above promise "declining the notice is a deny".
    //
    // It did not deny. `const proceed = window.confirm(...)` captured the
    // PROMISE the Tauri shim returns; `if (!proceed)` tested `!Promise`, always
    // false. The deny branch was unreachable, so Cancel fell through to the
    // permission dialog exactly like OK — turning "re-consent after an edit is
    // never a blind re-approval" into precisely a blind re-approval, with the
    // diff already consumed and therefore never shown again.
    //
    // The old `typeof window.confirm === "function"` probe made it worse: with
    // no window (or no dialog surface) the notice was skipped ENTIRELY and the
    // request proceeded silently. confirmAsync fails closed instead, so an
    // unshowable notice is a deny.
    const proceed = await confirmAsync(
      `${lapse}\n\n` +
        `It is asking again now. Continue to the permission request?\n` +
        `(Cancel denies it for this session.)`,
      { title: "Permission changed", kind: "warning" },
    );
    if (!proceed) {
      rememberDenied(args.scriptId, args.capability, args.origin);
      return "deny";
    }
  }
  const requestId = `cap-${++requestSeq}`;
  const viaLibrary = args.viaLibrary ?? null;
  const baseDescription = CAP_DESCRIPTION[args.capability] ?? args.capability;
  const payload: CapabilityRequestPayload = {
    requestId,
    scriptId: args.scriptId,
    scriptName: args.scriptName,
    capability: args.capability,
    // The dialog renders this verbatim after `"<script>" wants to `, so the
    // library clause has to read as a continuation of that sentence. It is
    // appended rather than substituted: the user must still be told what the
    // permission DOES, not only who asked for it.
    description: viaLibrary
      ? `${baseDescription} — through the shared library ${viaLibrary}, which it imports and which holds this permission`
      : baseDescription,
    origin: args.origin,
    viaLibrary,
  };
  return new Promise<CapabilityDecision>((resolve) => {
    let settled = false;
    const settle = (d: CapabilityDecision) => {
      if (settled) return;
      settled = true;
      pendingRequests.delete(requestId);
      if (d === "deny") rememberDenied(args.scriptId, args.capability, args.origin);
      resolve(d);
    };
    pendingRequests.set(requestId, settle);
    emitAppEvent("scriptable-objects:capability-request", payload);
    // Safety: if no UI answers (no listener / window closed), fail closed.
    setTimeout(() => settle("deny"), 60_000);
  });
}

/** Called by the ScriptableObjects extension when the JIT dialog is answered. */
export function resolveCapabilityRequest(requestId: string, decision: CapabilityDecision): void {
  pendingRequests.get(requestId)?.(decision);
}

// ============================================================================
// Declared capabilities (Phase 4.2a) — distributed scripts declare the caps
// they need via a source pragma; package consent then GRANTS them into the
// live grant set so the broker sees them. The pragma is the auditable record
// of what a script asked for; the consent dialog renders it; this module makes
// the consented subset (all of it, in 4.2a) live.
//
//   // @capability net.fetch https://api.example.com   (origin optional)
//   // @capability storage
//   // @capability bi.query
//
// Unknown capability ids are ignored. The origin arg is only meaningful for
// net.fetch and is normalized via fetchOriginOf (agreeing with Rust).
// ============================================================================

/** The set of capability ids a script source declares it needs.
 *  Single source of truth: capabilityIds.ts (was duplicated here pre-Wave 3). */
const KNOWN_CAPABILITY_IDS: ReadonlySet<CapabilityId> = CAPABILITY_ID_SET;

export interface DeclaredCapabilities {
  caps: CapabilityId[];
  origins: string[];
}

/**
 * Scan a script source for `// @capability <id> [origin]` pragmas. Collects the
 * (deduped) recognized capability ids; for net.fetch with an origin argument,
 * normalizes the origin via fetchOriginOf and collects it. Unknown ids and
 * malformed origins are ignored.
 */
export function parseDeclaredCapabilities(source: string): DeclaredCapabilities {
  const caps = new Set<CapabilityId>();
  const origins = new Set<string>();
  if (typeof source !== "string") return { caps: [], origins: [] };

  // Match a line-comment pragma: optional leading whitespace, //, then
  // @capability, the cap id, then an optional origin argument.
  const pragma = /^[ \t]*\/\/[ \t]*@capability[ \t]+(\S+)(?:[ \t]+(\S+))?/gm;
  let m: RegExpExecArray | null;
  while ((m = pragma.exec(source)) !== null) {
    const capId = m[1] as CapabilityId;
    if (!KNOWN_CAPABILITY_IDS.has(capId)) continue;
    caps.add(capId);
    if (capId === "net.fetch" && m[2]) {
      const origin = fetchOriginOf(m[2]);
      if (origin) origins.add(origin);
    }
  }

  return { caps: [...caps], origins: [...origins] };
}

/**
 * The consent chokepoint: record a distributed script's CONSENTED capabilities
 * into the live grant set (so buildHandleFromDefinition / the broker see them)
 * and mirror any net.fetch origin to the authoritative Rust store. Must run
 * BEFORE the script is mounted. Origin mirroring is best-effort (the script
 * would JIT-reprompt if Rust lacked the origin).
 */
export async function applyConsentedCapabilities(
  scriptId: string,
  caps: CapabilityId[],
  origins: string[],
): Promise<void> {
  for (const cap of caps) {
    recordCapabilityGrant(scriptId, cap);
  }
  for (const origin of origins) {
    recordCapabilityGrant(scriptId, "net.fetch", origin);
    try {
      await grantNetOrigin(scriptId, origin);
    } catch {
      /* best-effort; Rust re-checks authoritatively and JIT can re-prompt */
    }
  }
}
