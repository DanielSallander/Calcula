//! FILENAME: app/src/api/scriptHost/worker/workerHardening.ts
// PURPOSE: The shared, security-critical hardening for EVERY worker realm —
//          object scripts (bootstrap.ts) AND distributed extensions
//          (extensionBootstrap.ts, Wave 3 / S8-C7 Phase B). Centralizing the
//          neutered-globals list + capped timers here means the two realms can
//          never drift apart on what ambient authority they deny. The CSP is the
//          second wall; this is the first.
/// <reference lib="webworker" />

declare const self: DedicatedWorkerGlobalScope;

/**
 * Ambient global names whose authority is removed from every worker realm.
 * Network, storage, and remote-code-loading capabilities die here; the only
 * sanctioned reach is the broker-mediated RPC the host enforces. This list is
 * the single source of truth — a test pins it so neither realm regresses.
 */
export const NEUTERED_GLOBALS: readonly string[] = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "indexedDB",
  "caches",
  "importScripts",
];

const MIN_INTERVAL_MS = 16;
const MAX_LIVE_TIMERS = 32;

function neuter(target: object, name: string): void {
  try {
    Object.defineProperty(target, name, {
      configurable: false,
      get() {
        throw new Error(`${name} is not available (sandboxed worker realm)`);
      },
    });
  } catch {
    // Property not configurable on this platform — delete as a fallback.
    try {
      delete (target as Record<string, unknown>)[name];
    } catch {
      /* best effort */
    }
  }
}

/**
 * Remove ambient network/storage authority and install rate-capped timers.
 * MUST be the first thing a worker bootstrap runs, before any user/extension
 * source is compiled or evaluated.
 */
export function hardenAmbientGlobals(): void {
  for (const name of NEUTERED_GLOBALS) {
    neuter(self, name);
  }
  if (typeof navigator !== "undefined") {
    for (const name of ["sendBeacon", "serviceWorker"]) {
      try {
        neuter(Object.getPrototypeOf(navigator) as object, name);
      } catch {
        /* not present */
      }
    }
  }

  // Rate-capped ambient timers (R8): not a consent capability — per-realm
  // workers mean timers can't jank the host and die with terminate() — but
  // capped so a runaway realm only burns its own worker.
  const intrinsicSetTimeout = self.setTimeout.bind(self);
  const intrinsicSetInterval = self.setInterval.bind(self);
  const intrinsicClearTimeout = self.clearTimeout.bind(self);
  const intrinsicClearInterval = self.clearInterval.bind(self);
  const liveTimers = new Set<number>();

  const cappedSetTimeout = (handler: (...a: unknown[]) => void, timeout?: number, ...args: unknown[]): number => {
    if (liveTimers.size >= MAX_LIVE_TIMERS) {
      throw new Error(`Too many live timers (max ${MAX_LIVE_TIMERS})`);
    }
    const delay = Math.max(MIN_INTERVAL_MS, timeout ?? 0);
    const id = intrinsicSetTimeout(() => {
      liveTimers.delete(id);
      handler(...args);
    }, delay);
    liveTimers.add(id);
    return id;
  };
  const cappedSetInterval = (handler: (...a: unknown[]) => void, timeout?: number, ...args: unknown[]): number => {
    if (liveTimers.size >= MAX_LIVE_TIMERS) {
      throw new Error(`Too many live timers (max ${MAX_LIVE_TIMERS})`);
    }
    const delay = Math.max(MIN_INTERVAL_MS, timeout ?? 0);
    const id = intrinsicSetInterval(handler, delay, ...args);
    liveTimers.add(id);
    return id;
  };

  const g = self as unknown as Record<string, unknown>;
  g.setTimeout = cappedSetTimeout;
  g.setInterval = cappedSetInterval;
  g.clearTimeout = (id: number) => {
    liveTimers.delete(id);
    intrinsicClearTimeout(id);
  };
  g.clearInterval = (id: number) => {
    liveTimers.delete(id);
    intrinsicClearInterval(id);
  };
}

/** Structured-clone a value, degrading to its string form if it can't cross. */
export function safeClone(v: unknown): unknown {
  try {
    return structuredClone(v);
  } catch {
    return String(v);
  }
}

/**
 * Mirror console output to the host (developer console / transparency). The
 * caller supplies how a forwarded line is emitted (each realm has its own
 * protocol envelope).
 */
export function forwardConsole(
  emit: (level: "log" | "warn" | "error", args: unknown[]) => void,
): void {
  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        emit(level, args.map(safeClone));
      } catch {
        /* console must never throw */
      }
    };
  }
}
