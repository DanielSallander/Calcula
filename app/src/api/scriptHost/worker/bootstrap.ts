//! FILENAME: app/src/api/scriptHost/worker/bootstrap.ts
// PURPOSE: The untrusted script realm (sandbox design §3). One worker per
//          mounted script. Hardens the global scope BEFORE any script source
//          arrives, compiles user source via blob-ESM import (nothing
//          user-authored executes at import time), and dispatches the §4
//          protocol. The worker holds NO authority: every privileged call is
//          an RPC the host's broker checks; the CSP pins its network reach.
/// <reference lib="webworker" />

import { MAX_SANDBOX_HIT_RECTS, type H2W, type W2H, type MountSpec, type RenderCellRequest, type RenderDrawTarget, type SandboxHitGeometry } from "../protocol";
import { buildWorkerContext, dispatchEvent as dispatchHookEvent, applyMirror, getRenderer, getExposedHandler, type WorkerRuntime } from "./contextShims";
import { hardenAmbientGlobals, forwardConsole, safeClone } from "./workerHardening";

declare const self: DedicatedWorkerGlobalScope;

// ============================================================================
// 1. Hardening — first statements, before any user source can exist
// ============================================================================

// Capture the few intrinsics the dispatch loop itself needs BEFORE hardening or
// any user source can clobber them.
const intrinsicPostMessage = self.postMessage.bind(self);
const intrinsicFreeze = Object.freeze.bind(Object);

function post(msg: W2H, transfer?: Transferable[]): void {
  if (transfer) {
    intrinsicPostMessage(msg, transfer);
  } else {
    intrinsicPostMessage(msg);
  }
}

// Ambient network/storage authority dies here, and timers are rate-capped —
// shared with the extension realm (workerHardening.ts) so the two can never
// drift. The CSP is the second wall. Console is mirrored to the host.
hardenAmbientGlobals();
forwardConsole((level, args) => post({ t: "console", level, args }));

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
  const hook =
    target.kind === "shape" ? "canvasRenderer"
      : target.kind === "chartMark" ? "markRenderer"
        : "itemRenderer";
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
    let hitGeometry: SandboxHitGeometry | null = null;
    if (target.kind === "shape") {
      // Unchanged user signature: (ctx, bounds). Bounds are local — the
      // host blits inside its own save/translate/clip, so scripts can never
      // paint outside their region.
      (renderer as (c: unknown, b: unknown) => void)(ctx, { x: 0, y: 0, width: w, height: h });
    } else if (target.kind === "chartMark") {
      // Chart mark renderer — signature (ctx, paintContext, bounds). Bounds are
      // LOCAL (origin 0,0, sized to the plot area); the host clips+blits into the
      // chart's plot rectangle, so the mark can only paint its own plot pixels.
      // It MAY return { rects: [...] } hit geometry (local coords) — the host
      // sanitizes it before trusting it. safeClone strips functions/cycles.
      const ret = (renderer as (c: unknown, p: unknown, b: unknown) => unknown)(ctx, target.item, { x: 0, y: 0, width: w, height: h });
      if (ret && typeof ret === "object" && Array.isArray((ret as { rects?: unknown }).rects)) {
        // Cap BEFORE safeClone (structuredClone) + postMessage so a hostile/buggy
        // mark returning a giant array can't force a multi-hundred-MB clone or pin
        // the host scanning it — the host caps OUTPUT, but only after the payload
        // crossed; this caps the INPUT in the sandbox container itself.
        const rects = (ret as { rects: unknown[] }).rects.slice(0, MAX_SANDBOX_HIT_RECTS);
        hitGeometry = safeClone({ rects }) as SandboxHitGeometry;
      }
    } else {
      // Slicer item renderer — unchanged user signature: (item, ctx, bounds).
      (renderer as (i: unknown, c: unknown, b: unknown) => void)(target.item, ctx, { x: 0, y: 0, width: w, height: h });
    }
    const bitmap = canvas.transferToImageBitmap();
    post({ t: "renderDrawResult", reqId, bitmap, hitGeometry }, [bitmap]);
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
