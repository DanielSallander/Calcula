//! FILENAME: app/src/api/scriptHost/worker/extensionBootstrap.ts
// PURPOSE: The untrusted realm for a sandboxed DISTRIBUTED extension (Wave 3 /
//          S8-C7 Phase B). One worker per worker-supported extension. Hardens
//          the global scope BEFORE the bundle is imported (no ambient
//          network/storage/DOM/Tauri authority), imports the bundle as a
//          blob-ESM module (so the host never runs the extension on the main
//          thread), reports its manifest, and on `activate` hands the extension
//          the worker-side ExtensionContext. Every privileged effect is an RPC
//          the host's broker checks.
/// <reference lib="webworker" />

import { hardenAmbientGlobals, forwardConsole } from "./workerHardening";
import { buildExtensionContext, type ExtWorkerRuntime } from "./extensionWorkerContext";
import type { HX2W, WX2H, WorkerExtensionManifest } from "../extensionProtocol";

declare const self: DedicatedWorkerGlobalScope;

const intrinsicPostMessage = self.postMessage.bind(self);
const intrinsicFreeze = Object.freeze.bind(Object);
function post(msg: WX2H): void {
  intrinsicPostMessage(msg);
}

// First statements: deny ambient authority + mirror console, before any bundle
// code can exist. Shared with the object-script realm (workerHardening.ts).
hardenAmbientGlobals();
forwardConsole((level, args) => post({ t: "console", level, args }));

interface WorkerExtModule {
  manifest: WorkerExtensionManifest;
  activate: (context: unknown) => unknown;
  deactivate?: () => void;
}

let extModule: WorkerExtModule | null = null;
let runtime: ExtWorkerRuntime | null = null;
let activateTeardown: (() => void) | null = null;

async function importExtension(source: string): Promise<WorkerExtModule> {
  // Blob-ESM import: pre-bundled extension (no external imports). Importing runs
  // the bundle's top-level code IN THE WORKER, where ambient authority is
  // already neutered — nothing user-authored ever runs on the main thread.
  const blob = new Blob([source], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    const mod = (await import(/* @vite-ignore */ url)) as { default?: WorkerExtModule } & WorkerExtModule;
    return (mod.default ?? mod) as WorkerExtModule;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function handleInit(source: string): Promise<void> {
  try {
    extModule = await importExtension(source);
    const m = extModule?.manifest;
    if (!m || typeof extModule.activate !== "function") {
      post({ t: "manifestError", message: "extension bundle must export { manifest, activate }" });
      return;
    }
    post({
      t: "manifest",
      manifest: {
        id: m.id,
        name: m.name,
        version: m.version,
        apiVersion: m.apiVersion,
        capabilities: m.capabilities,
        workerSupport: m.workerSupport,
      },
    });
  } catch (e) {
    post({ t: "manifestError", message: e instanceof Error ? e.message : String(e) });
  }
}

async function handleActivate(): Promise<void> {
  if (!extModule) {
    post({ t: "activated", ok: false, error: "extension not initialized" });
    return;
  }
  try {
    const built = buildExtensionContext(post);
    runtime = built.runtime;
    intrinsicFreeze(built.context);
    const ret = await extModule.activate(built.context);
    // Convention parity with object scripts: a function returned from activate
    // is a teardown (in addition to an optional module.deactivate).
    if (typeof ret === "function") {
      activateTeardown = ret as () => void;
    }
    post({ t: "activated", ok: true });
  } catch (e) {
    post({ t: "activated", ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

function handleDeactivate(): void {
  try {
    activateTeardown?.();
  } catch {
    /* best effort */
  }
  try {
    extModule?.deactivate?.();
  } catch {
    /* best effort */
  }
  runtime?.runDeactivate();
}

self.onmessage = (e: MessageEvent<HX2W>) => {
  const msg = e.data;
  switch (msg.t) {
    case "init":
      void handleInit(msg.source);
      break;
    case "activate":
      // ceiling is display/shim-only here; enforcement is host-side (the broker).
      void handleActivate();
      break;
    case "invokeHandler":
      if (runtime) void runtime.invokeHandler(msg.reqId, msg.handlerId, msg.args);
      break;
    case "appEvent":
      runtime?.dispatchAppEvent(msg.handlerId, msg.payload);
      break;
    case "callResult":
      runtime?.settleCall(msg.callId, msg.ok, msg.value, msg.error);
      break;
    case "deactivate":
      handleDeactivate();
      break;
  }
};

// Keep the teardown symbol referenced for the unused-var lint; the realm dies on
// terminate() regardless.
export { activateTeardown as __teardown };
