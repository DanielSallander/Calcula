//! FILENAME: app/src/api/scriptHost/worker/bootstrap.ts
// PURPOSE: The untrusted script realm (sandbox design §3). One worker per
//          mounted script. Hardens the global scope BEFORE any script source
//          arrives, compiles user source via blob-ESM import (nothing
//          user-authored executes at import time), and dispatches the §4
//          protocol. The worker holds NO authority: every privileged call is
//          an RPC the host's broker checks; the CSP pins its network reach.
/// <reference lib="webworker" />

import type { H2W, W2H, MountSpec, RenderCellRequest, RenderDrawTarget } from "../protocol";
import { buildWorkerContext, dispatchEvent as dispatchHookEvent, applyMirror, getRenderer, getExposedHandler, type WorkerRuntime } from "./contextShims";

declare const self: DedicatedWorkerGlobalScope;

// ============================================================================
// 1. Hardening — first statements, before any user source can exist
// ============================================================================

// Capture intrinsics into closures so user code can't clobber what the
// runtime itself depends on.
const intrinsicPostMessage = self.postMessage.bind(self);
const intrinsicSetTimeout = self.setTimeout.bind(self);
const intrinsicClearTimeout = self.clearTimeout.bind(self);
const intrinsicClearInterval = self.clearInterval.bind(self);
const intrinsicFreeze = Object.freeze.bind(Object);

function neuter(target: object, name: string): void {
  try {
    Object.defineProperty(target, name, {
      configurable: false,
      get() {
        throw new Error(`${name} is not available to scripts (sandboxed realm)`);
      },
    });
  } catch {
    // Property not configurable on this platform — delete as fallback.
    try {
      delete (target as Record<string, unknown>)[name];
    } catch {
      /* best effort */
    }
  }
}

// Ambient network/storage authority dies here. The CSP is the second wall.
neuter(self, "fetch");
neuter(self, "XMLHttpRequest");
neuter(self, "WebSocket");
neuter(self, "EventSource");
neuter(self, "indexedDB");
neuter(self, "caches");
neuter(self, "importScripts");
if (typeof navigator !== "undefined") {
  try {
    neuter(Object.getPrototypeOf(navigator) as object, "sendBeacon");
  } catch {
    /* not present */
  }
  try {
    neuter(Object.getPrototypeOf(navigator) as object, "serviceWorker");
  } catch {
    /* not present */
  }
}

// Rate-capped ambient timers (R8): not a consent capability — per-script
// workers mean timers can't jank the host and die with terminate() — but
// capped so a runaway script only burns its own realm.
const MIN_INTERVAL_MS = 16;
const MAX_LIVE_TIMERS = 32;
const liveTimers = new Set<number>();

function cappedSetTimeout(handler: (...a: unknown[]) => void, timeout?: number, ...args: unknown[]): number {
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
}

function cappedSetInterval(handler: (...a: unknown[]) => void, timeout?: number, ...args: unknown[]): number {
  if (liveTimers.size >= MAX_LIVE_TIMERS) {
    throw new Error(`Too many live timers (max ${MAX_LIVE_TIMERS})`);
  }
  const delay = Math.max(MIN_INTERVAL_MS, timeout ?? 0);
  const id = self.setInterval(handler, delay, ...args);
  liveTimers.add(id);
  return id;
}

(self as unknown as Record<string, unknown>).setTimeout = cappedSetTimeout;
(self as unknown as Record<string, unknown>).setInterval = cappedSetInterval;
(self as unknown as Record<string, unknown>).clearTimeout = (id: number) => {
  liveTimers.delete(id);
  intrinsicClearTimeout(id);
};
(self as unknown as Record<string, unknown>).clearInterval = (id: number) => {
  liveTimers.delete(id);
  intrinsicClearInterval(id);
};

// Forward console output to the host (script editor console).
for (const level of ["log", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    try {
      post({ t: "console", level, args: args.map(safeClone) });
    } catch {
      /* console must never throw */
    }
  };
}

function safeClone(v: unknown): unknown {
  try {
    return structuredClone(v);
  } catch {
    return String(v);
  }
}

function post(msg: W2H, transfer?: Transferable[]): void {
  if (transfer) {
    intrinsicPostMessage(msg, transfer);
  } else {
    intrinsicPostMessage(msg);
  }
}

// ============================================================================
// 2. Compilation — blob-ESM import (R2): import-time executes NOTHING
//    user-authored; all user code lives inside the exported function body.
// ============================================================================

type SetupFn = (context: unknown) => unknown;

async function compileSource(source: string): Promise<SetupFn> {
  // Cosmetic cleanup only (imports/exports won't resolve in a blob module).
  const cleaned = source
    .replace(/^\s*import\s+.*$/gm, "// [import removed]")
    .replace(/^\s*export\s+default\s+/gm, "");

  const wrapped =
    `export default function(context) { ${cleaned}\n` +
    `; return typeof setup === "function" ? setup(context) : undefined; }`;

  const blob = new Blob([wrapped], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    const mod = (await import(/* @vite-ignore */ url)) as { default: SetupFn };
    return mod.default;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ============================================================================
// 3. Dispatch
// ============================================================================

let runtime: WorkerRuntime | null = null;
let teardownFn: (() => void) | null = null;

async function handleMount(spec: MountSpec): Promise<void> {
  try {
    if (spec.protocolVersion !== 1) {
      post({ t: "mounted", ok: false, error: `Protocol version mismatch: host ${spec.protocolVersion}, worker 1` });
      return;
    }
    const setup = await compileSource(spec.source);
    const { context, rt } = buildWorkerContext(spec, post);
    runtime = rt;
    intrinsicFreeze(context);
    const teardown = await setup(context);
    if (typeof teardown === "function") {
      teardownFn = teardown as () => void;
    }
    post({ t: "mounted", ok: true });
  } catch (err) {
    post({
      t: "mounted",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleValidate(source: string): Promise<void> {
  try {
    await compileSource(source); // syntax errors surface; nothing executes
    post({ t: "validated", valid: true });
  } catch (err) {
    post({ t: "validated", valid: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function handleRenderCells(reqId: number, cells: RenderCellRequest[]): void {
  const renderer = runtime ? getRenderer(runtime, "onRender") : null;
  if (!renderer) {
    post({ t: "renderCellsResult", reqId, styles: cells.map(() => null) });
    return;
  }
  const styles = cells.map((cell) => {
    try {
      const result = (renderer as (p: unknown) => unknown)({
        row: cell.row,
        col: cell.col,
        sheetIndex: cell.sheetIndex,
        value: cell.value,
        formula: null,
      });
      if (result && typeof result === "object") {
        return safeClone(result) as Record<string, unknown>;
      }
      return null;
    } catch (err) {
      post({ t: "error", hook: "onRender", message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
      return null;
    }
  });
  post({ t: "renderCellsResult", reqId, styles });
}

function handleRenderDraw(reqId: number, target: RenderDrawTarget, w: number, h: number, dpr: number): void {
  const hook = target.kind === "shape" ? "canvasRenderer" : "itemRenderer";
  const renderer = runtime ? getRenderer(runtime, hook) : null;
  if (!renderer || typeof OffscreenCanvas === "undefined") {
    post({ t: "renderDrawResult", reqId, bitmap: null });
    return;
  }
  try {
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(w * dpr)), Math.max(1, Math.round(h * dpr)));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      post({ t: "renderDrawResult", reqId, bitmap: null });
      return;
    }
    ctx.scale(dpr, dpr);
    if (target.kind === "shape") {
      // Unchanged user signature: (ctx, bounds). Bounds are local — the
      // host blits inside its own save/translate/clip, so scripts can never
      // paint outside their region.
      (renderer as (c: unknown, b: unknown) => void)(ctx, { x: 0, y: 0, width: w, height: h });
    } else {
      // Slicer item renderer — unchanged user signature: (item, ctx, bounds).
      (renderer as (i: unknown, c: unknown, b: unknown) => void)(target.item, ctx, { x: 0, y: 0, width: w, height: h });
    }
    const bitmap = canvas.transferToImageBitmap();
    post({ t: "renderDrawResult", reqId, bitmap }, [bitmap]);
  } catch (err) {
    post({ t: "error", hook, message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    post({ t: "renderDrawResult", reqId, bitmap: null });
  }
}

async function handleMethodCall(callId: number, methodName: string, args: unknown[]): Promise<void> {
  const handler = runtime ? getExposedHandler(runtime, methodName) : undefined;
  if (!handler) {
    post({ t: "methodResult", callId, ok: false, error: { code: "UnknownMethod", message: `Method not found: ${methodName}` } });
    return;
  }
  try {
    const value = await handler(...args);
    post({ t: "methodResult", callId, ok: true, value: safeClone(value) });
  } catch (err) {
    post({
      t: "methodResult",
      callId,
      ok: false,
      error: { code: "HostError", message: err instanceof Error ? err.message : String(err) },
    });
  }
}

self.onmessage = (e: MessageEvent<H2W>) => {
  const msg = e.data;
  switch (msg.t) {
    case "mount":
      void handleMount(msg.spec);
      break;
    case "validate":
      void handleValidate(msg.source);
      break;
    case "event":
      if (runtime) {
        dispatchHookEvent(runtime, msg.hook, msg.payload, post);
      }
      break;
    case "mirror":
      if (runtime) {
        applyMirror(runtime, msg.path, msg.value);
      }
      break;
    case "renderCells":
      handleRenderCells(msg.reqId, msg.cells);
      break;
    case "renderDraw":
      handleRenderDraw(msg.reqId, msg.target, msg.w, msg.h, msg.dpr);
      break;
    case "callResult":
      if (runtime) {
        runtime.settleCall(msg.callId, msg.ok, msg.value, msg.error);
      }
      break;
    case "methodCall":
      void handleMethodCall(msg.callId, msg.methodName, msg.args);
      break;
    case "ping":
      post({ t: "pong", seq: msg.seq });
      break;
  }
};

// teardown on terminate() is implicit (the whole realm dies); the export
// below keeps the symbol referenced for the unused-var lint.
export { teardownFn as __teardown };
