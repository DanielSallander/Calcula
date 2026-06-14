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

import type { CapabilityId } from "./allowlist";
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
}

export function resetAllGrants(): void {
  grantState.clear();
  deniedThisSession.clear();
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
  if (cap === "net.fetch") {
    s.origins.clear();
    await revokeBackendCapabilities(scriptId);
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
}

/** Human-facing capability descriptions for the JIT dialog. */
const CAP_DESCRIPTION: Record<CapabilityId, string> = {
  "net.fetch": "fetch data from the web",
  "bi.query": "run read-only BI queries",
  storage: "store data on this device",
  "ui.html": "render custom HTML UI",
};

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
 */
export function requestCapabilityGrant(args: {
  scriptId: string;
  scriptName: string;
  capability: CapabilityId;
  origin: string | null;
}): Promise<CapabilityDecision> {
  const requestId = `cap-${++requestSeq}`;
  const payload: CapabilityRequestPayload = {
    requestId,
    scriptId: args.scriptId,
    scriptName: args.scriptName,
    capability: args.capability,
    description: CAP_DESCRIPTION[args.capability] ?? args.capability,
    origin: args.origin,
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

/** The set of capability ids a script source declares it needs. */
const KNOWN_CAPABILITY_IDS: ReadonlySet<CapabilityId> = new Set<CapabilityId>([
  "net.fetch",
  "bi.query",
  "storage",
  "ui.html",
]);

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
