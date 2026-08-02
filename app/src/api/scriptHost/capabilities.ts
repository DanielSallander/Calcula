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
import { invokeBackend } from "../backend";
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
 * Record a grant in the live set. The caller is responsible for mirroring a
 * net.fetch origin to the Rust store (grantNetOrigin) and persisting an
 * "always" grant (Phase 4.2).
 */
export function recordCapabilityGrant(
  scriptId: string,
  cap: CapabilityId,
  origin?: string,
): void {
  const s = ensureState(scriptId);
  s.caps.add(cap);
  if (origin) s.origins.add(origin);
}

/** Forget a script's session grants (workbook reset). Per-script Rust state is
 *  cleared via revokeBackendCapabilities on unmount. */
export function revokeScriptGrants(scriptId: string): void {
  grantState.delete(scriptId);
  deniedThisSession.delete(scriptId);
  lapsedGrantNotices.delete(scriptId);
}

export function resetAllGrants(): void {
  grantState.clear();
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
 */
export async function revokeCapability(scriptId: string, cap: CapabilityId): Promise<void> {
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
  /** `handle.origin`: "local" for workbook-authored code, the package name for
   *  distributed code (which never JIT-prompts and never persists here). */
  origin: string;
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
  if (target.origin === "local") {
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
  /** `handle.origin`; anything but "local" is ignored (package consent path). */
  origin: string;
  capability: CapabilityId;
  netOrigin?: string | null;
}): Promise<void> {
  if (args.origin !== "local") return;
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
  storage: "store data on this device",
  "ui.html": "render custom HTML UI",
  "formula.udf": "evaluate worksheet formulas (user-defined functions)",
  "bi.model": "modify your BI model definitions (measures, relationships, ... — undoable; never security roles or connections)",
  "bi.connector": "feed external data into your BI model as a data connector",
  "ui.dialog": "show you a dialog and receive what you enter",
  "distribution.writeback":
    "fill in the input cells of a subscribed package and send your answers to its publisher (and, if it can sign the package, read and approve everyone else's)",
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
  // paint them, and hands it each edit so it can react. The two clauses are the
  // two real paths (cell styling; the cell-change events), and the last clause
  // is the honest limit — it is shown what is there, it cannot change it, and
  // it cannot send it anywhere without a separate permission you would also be
  // asked for.
  "grid.read":
    "be shown the contents of your cells — the value of every cell on screen while it decides how to style them, and the old value, new value and formula of every cell that changes. It cannot change your cells with this, and it cannot send them anywhere without separately asking you for network or file access",
  // OUTBOUND. The two clauses a person needs before saying yes: WHO it goes out
  // as (you, cryptographically), and that it cannot be recalled. The last clause
  // is the honest limit that makes this grantable — a script cannot become a
  // publisher, only act as one you already are.
  "distribution.publish":
    "publish this workbook to one of your package registries, signed with YOUR publisher key, where everyone subscribed to that package will receive it. It leaves this machine and cannot be taken back. It can only publish to registries you already added, and only if you have published something yourself before — a script cannot create your publisher identity",
  // INBOUND. Deliberately phrased as "somebody else's code arrives", because
  // that is the risk, and then the two bounds that contain it: it cannot reach a
  // registry you did not add, and it cannot switch the code on.
  "distribution.subscribe":
    "bring somebody else's published packages into this workbook — their sheets, their data and any code they carry — and update the ones you already subscribe to. It can only use registries you added yourself, everything it brings in is signature-checked exactly as if you had subscribed by hand, and any code that arrives stays switched off until you approve it (including code that CHANGED in an update)",
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
export function requestCapabilityGrant(args: {
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
  if (lapse && typeof window !== "undefined" && typeof window.confirm === "function") {
    const proceed = window.confirm(
      `${lapse}\n\n` +
        `It is asking again now. Continue to the permission request?\n` +
        `(Cancel denies it for this session.)`,
    );
    if (!proceed) {
      rememberDenied(args.scriptId, args.capability, args.origin);
      return Promise.resolve("deny");
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
