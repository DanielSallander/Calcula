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

/** Drop entries (workbook close / tests). */
export function clearAudit(): void {
  ring.length = 0;
  nextIndex = 0;
  total = 0;
}
