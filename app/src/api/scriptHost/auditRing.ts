//! FILENAME: app/src/api/scriptHost/auditRing.ts
// PURPOSE: Ring buffer of broker-mediated script calls (design §5: every
//          call appends {ts, scriptId, method, class, ok}; the transparency
//          panel renders the tail). One place to see everything that touched
//          the workbook from the script path.

import type { MethodClass } from "./allowlist";

export interface AuditEntry {
  /** Epoch millis. */
  ts: number;
  scriptId: string;
  /** Script display name at call time (ids are opaque in the panel). */
  scriptName: string;
  method: string;
  class: MethodClass;
  ok: boolean;
  /** Denial/error code when ok=false (PermissionDenied, ValidationError, ...). */
  error?: string;
  /**
   * A one-line summary of the call's arguments, for rows whose policy declares
   * one (`MethodPolicy.auditDetail`): shape only -- a ref, a count -- never data
   * the script read or wrote.
   */
  detail?: string;
}

const RING_CAPACITY = 2000;

const ring: AuditEntry[] = [];
let nextIndex = 0;
let total = 0;

type AuditListener = (entry: AuditEntry) => void;
const listeners = new Set<AuditListener>();

export function appendAudit(entry: AuditEntry): void {
  if (ring.length < RING_CAPACITY) {
    ring.push(entry);
  } else {
    ring[nextIndex] = entry;
    nextIndex = (nextIndex + 1) % RING_CAPACITY;
  }
  total++;
  for (const l of listeners) {
    try {
      l(entry);
    } catch {
      // listeners must never break the call path
    }
  }
}

/** Most-recent-last snapshot of the ring. */
export function getAuditTail(limit = RING_CAPACITY): AuditEntry[] {
  const ordered = ring.length < RING_CAPACITY
    ? [...ring]
    : [...ring.slice(nextIndex), ...ring.slice(0, nextIndex)];
  return limit >= ordered.length ? ordered : ordered.slice(ordered.length - limit);
}

/** Total calls ever audited (including those rotated out of the ring). */
export function getAuditTotal(): number {
  return total;
}

export function onAudit(listener: AuditListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ============================================================================
// Refusal vs failure
// ============================================================================

/**
 * The codes an `ok: false` row carries when the SANDBOX SAID NO: a method the
 * script's tier may not call or a capability it does not hold
 * (PermissionDenied, CapabilityRequired -- also Rust's own gates, whose
 * `"PermissionDenied: ..."` / `"RateLimited: ..."` refusals broker.ts records
 * under their code), a grant the user revoked (Revoked), and the pane
 * registry's refusals of a reveal without a user gesture or a flood
 * (NoGesture, RateLimited). A summary that counts refusals -- the status bar's
 * code-and-scripts indicator -- counts exactly these.
 */
export const AUDIT_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "PermissionDenied",
  "CapabilityRequired",
  "Revoked",
  "NoGesture",
  "RateLimited",
]);

/**
 * The codes of a call that FAILED without being refused: the script's own
 * mistake (ValidationError, UnknownMethod) or the host's (HostError, Timeout).
 * Counting these as refusals would cry wolf every time a script passes a bad
 * argument. Every code anything writes must be in exactly one of the two sets
 * (auditCodeCensus.test.ts reads the sources and fails on one in neither).
 */
export const AUDIT_FAILURE_CODES: ReadonlySet<string> = new Set([
  "ValidationError",
  "UnknownMethod",
  "HostError",
  "Timeout",
]);

/** Whether an audit row records the sandbox refusing a script. */
export function isAuditRefusal(entry: Pick<AuditEntry, "ok" | "error">): boolean {
  return !entry.ok && entry.error !== undefined && AUDIT_REFUSAL_CODES.has(entry.error);
}

/** How many rows in the ring are refusals (the tail kept, not every call ever). */
export function countAuditRefusals(): number {
  let n = 0;
  for (const entry of ring) if (isAuditRefusal(entry)) n += 1;
  return n;
}

/** Drop entries (workbook close / tests). */
export function clearAudit(): void {
  ring.length = 0;
  nextIndex = 0;
  total = 0;
}
