// FILENAME: app/extensions/Collaboration/lib/whoAmIStore.ts
// PURPOSE: WHO this computer sends writeback answers as (identity phase 1), read
//          once from Rust and shared by every surface that says it: the
//          subscriber's Writeback tab Status and the Writeback pane.
// CONTEXT: The identity is the Windows account the app runs as, bound to this
//          computer's signing key -- it does not change during a session, so
//          one read serves every mounted copy (a ribbon section can mount up to
//          three times). Read lazily on the first subscriber; a failure is kept
//          as the error it is and never shown as an identity.

import { getSubscriberIdentity, type SubmitterIdentity } from "@api/collaboration";

let identity: SubmitterIdentity | null = null;
let error: string | null = null;
let started = false;
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version++;
  for (const cb of Array.from(listeners)) {
    try {
      cb();
    } catch (err) {
      console.error("[whoAmI] a listener threw:", err);
    }
  }
}

/** Read who this computer sends as (again). Never rejects. */
export async function refreshWhoAmI(): Promise<void> {
  started = true;
  try {
    identity = await getSubscriberIdentity();
    error = null;
  } catch (err) {
    identity = null;
    error = err instanceof Error ? err.message : String(err);
  }
  notify();
}

/** Subscribe (useSyncExternalStore-shaped); the first subscriber starts the read. */
export function subscribeWhoAmI(cb: () => void): () => void {
  listeners.add(cb);
  if (!started) void refreshWhoAmI();
  return () => {
    listeners.delete(cb);
  };
}

export function getWhoAmIVersion(): number {
  return version;
}

/** The identity, or the error that kept it from being read. */
export function getWhoAmI(): { identity: SubmitterIdentity | null; error: string | null } {
  return { identity, error };
}

/** Tests only: forget what was read. */
export function resetWhoAmIForTests(): void {
  identity = null;
  error = null;
  started = false;
  version = 0;
  listeners.clear();
}
