//! FILENAME: app/src/api/scriptHost/worker/contextShims.ts
// PURPOSE: The typed per-objectType context surface scripts code against,
//          rebuilt over RPC (sandbox design §3/§9). Signatures mirror the
//          legacy main-thread builders exactly; the transport is the only
//          change. Sync getters (workbook.properties, slicer
//          getSelectedItems, shape getProperty, chart getSpec, pivot
//          getFields, panel.properties) read worker-local MIRRORS seeded by
//          MountSpec.snapshot and updated by host `mirror` pushes. Tier and
//          capability shaping here is COSMETIC — enforcement is host-side.

import type { MountSpec, W2H, RpcErrorShape } from "../protocol";
import { CALL_TIMEOUT_MS, MAX_INFLIGHT_CALLS } from "../protocol";

type Post = (msg: W2H, transfer?: Transferable[]) => void;
type Handler = (payload: unknown) => void;
type CleanupFn = () => void;

// ============================================================================
// Runtime
// ============================================================================

export interface WorkerRuntime {
  spec: MountSpec;
  post: Post;
  nextCallId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>;
  hooks: Map<string, Handler[]>;
  registeredHooks: Set<string>;
  renderers: Map<string, unknown>;
  exposed: Map<string, (...args: unknown[]) => unknown>;
  mirrors: Map<string, unknown>;
  settleCall(callId: number, ok: boolean, value?: unknown, error?: RpcErrorShape): void;
}

class RpcError extends Error {
  code: string;
  capability?: string;
  constructor(shape: RpcErrorShape) {
    super(shape.message);
    this.name = "RpcError";
    this.code = shape.code;
    this.capability = shape.detail?.capability;
  }
}

function call(rt: WorkerRuntime, method: string, args: unknown[]): Promise<unknown> {
  if (rt.pending.size >= MAX_INFLIGHT_CALLS) {
    return Promise.reject(
      new RpcError({ code: "HostError", message: `rpc-saturated: more than ${MAX_INFLIGHT_CALLS} calls in flight` }),
    );
  }
  const callId = rt.nextCallId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rt.pending.delete(callId);
      reject(new RpcError({ code: "Timeout", message: `${method} timed out after ${CALL_TIMEOUT_MS}ms` }));
    }, CALL_TIMEOUT_MS) as unknown as number;
    rt.pending.set(callId, { resolve, reject, timer });
    rt.post({ t: "call", callId, method, args });
  });
}

/** Fire-and-forget call (log/notify/emit): failures surface on the console only. */
function callFire(rt: WorkerRuntime, method: string, args: unknown[]): void {
  void call(rt, method, args).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn(`[script] ${method} failed:`, e instanceof Error ? e.message : e);
  });
}

function registerHook(rt: WorkerRuntime, hook: string, handler: Handler): CleanupFn {
  let handlers = rt.hooks.get(hook);
  if (!handlers) {
    handlers = [];
    rt.hooks.set(hook, handlers);
  }
  handlers.push(handler);
  if (!rt.registeredHooks.has(hook)) {
    rt.registeredHooks.add(hook);
    rt.post({ t: "hookRegistered", hook });
  }
  return () => {
    const list = rt.hooks.get(hook);
    if (list) {
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    }
  };
}

/** Host event → registered handlers. Handler errors go to the host as script errors. */
export function dispatchEvent(rt: WorkerRuntime, hook: string, payload: unknown, post: Post): void {
  const handlers = rt.hooks.get(hook);
  if (!handlers) return;
  for (const handler of [...handlers]) {
    try {
      handler(payload);
    } catch (err) {
      post({
        t: "error",
        hook,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }
}

export function applyMirror(rt: WorkerRuntime, path: string, value: unknown): void {
  rt.mirrors.set(path, value);
}

export function getRenderer(rt: WorkerRuntime, name: string): unknown {
  return rt.renderers.get(name) ?? null;
}

export function getExposedHandler(rt: WorkerRuntime, name: string): ((...args: unknown[]) => unknown) | undefined {
  return rt.exposed.get(name);
}

function mirror<T>(rt: WorkerRuntime, path: string, fallback: T): T {
  const v = rt.mirrors.get(path);
  return v === undefined ? fallback : (v as T);
}

// ============================================================================
// Context construction
// ============================================================================

export function buildWorkerContext(spec: MountSpec, post: Post): { context: Record<string, unknown>; rt: WorkerRuntime } {
  const rt: WorkerRuntime = {
    spec,
    post,
    nextCallId: 1,
    pending: new Map(),
    hooks: new Map(),
    registeredHooks: new Set(),
    renderers: new Map(),
    exposed: new Map(),
    mirrors: new Map(),
    settleCall(callId, ok, value, error) {
      const entry = rt.pending.get(callId);
      if (!entry) return;
      rt.pending.delete(callId);
      clearTimeout(entry.timer);
      if (ok) {
        entry.resolve(value);
      } else {
        entry.reject(new RpcError(error ?? { code: "HostError", message: "unknown host error" }));
      }
    },
  };

  // Seed mirrors from the mount snapshot.
  if (spec.snapshot.properties) {
    for (const [path, value] of Object.entries(spec.snapshot.properties)) {
      rt.mirrors.set(path, value);
    }
  }
  if (spec.snapshot.selection !== undefined) {
    rt.mirrors.set("slicer.selection", spec.snapshot.selection);
  }

  const base = buildBase(rt);
  const typed = buildTyped(rt, base);
  return { context: typed, rt };
}

// ---- Base (all scripts) ----

function buildBase(rt: WorkerRuntime): Record<string, unknown> {
  const { spec } = rt;
  return {
    objectType: spec.objectType,
    accessLevel: spec.tier,
    apiVersion: spec.apiVersion,

    expose(name: string, handler: (...args: unknown[]) => unknown, options?: { public?: boolean }): CleanupFn {
      rt.exposed.set(name, handler);
      callFire(rt, "base.expose", [name, options?.public === true]);
      return () => {
        rt.exposed.delete(name);
        callFire(rt, "base.unexpose", [name]);
      };
    },

    callMethod(targetType: string, targetInstanceId: string | null, methodName: string, ...args: unknown[]): Promise<unknown> {
      return call(rt, "base.callMethod", [targetType, targetInstanceId, methodName, args]);
    },

    log(...args: unknown[]): void {
      callFire(rt, "base.log", args);
    },

    notify(message: string, type?: string): void {
      callFire(rt, "base.notify", [message, type]);
    },

    api: spec.tier === "unlocked" ? buildUnlockedShim(rt) : null,

    // Capabilities are orthogonal to tier — exposed to every script; the broker
    // enforces the grant (and Rust re-checks net.fetch authoritatively). An
    // ungranted call rejects with CapabilityRequired, or — for a local script —
    // triggers a JIT grant prompt before the call lands.
    caps: buildCapsShim(rt),
  };
}

// ---- Capabilities (all scripts; broker + Rust enforce the grant) ----

interface CapsFetchResponse {
  status: number;
  headers: Record<string, string>;
  text(): string;
  json(): unknown;
}

// Structured BI query shapes (mirror backend.ts; defined inline so the worker
// bundle never imports the Tauri backend).
interface BiColumnRef {
  table: string;
  column: string;
}
interface BiFilter {
  column: string;
  table: string;
  operator: string;
  value: string;
}
interface BiQueryRequestShim {
  measures: string[];
  groupBy: BiColumnRef[];
  filters: BiFilter[];
}
interface BiQueryResultShim {
  columns: string[];
  rows: (string | null)[][];
  rowCount: number;
}
interface BiConnectionSummary {
  id: string;
  name: string;
  connectionType?: string;
  isConnected?: boolean;
  tableCount?: number;
  measureCount?: number;
}

/** context.caps.* — thin RPC wrappers that add no authority of their own. */
function buildCapsShim(rt: WorkerRuntime): {
  fetch: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<CapsFetchResponse>;
  storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
  };
  biQuery(connectionId: string, request: BiQueryRequestShim): Promise<BiQueryResultShim>;
  biSql(connectionId: string, sql: string): Promise<BiQueryResultShim>;
  listBiConnections(): Promise<BiConnectionSummary[]>;
} {
  return {
    async fetch(url, init) {
      const raw = (await call(rt, "cap.fetch", [url, init])) as {
        status: number;
        headers: Record<string, string>;
        body: string;
      };
      return {
        status: raw.status,
        headers: raw.headers,
        text: () => raw.body,
        json: () => JSON.parse(raw.body),
      };
    },
    storage: {
      async get(key: string): Promise<string | null> {
        return (await call(rt, "cap.storageGet", [key])) as string | null;
      },
      async set(key: string, value: string): Promise<void> {
        await call(rt, "cap.storageSet", [key, value]);
      },
    },
    async biQuery(connectionId, request) {
      return (await call(rt, "cap.biQuery", [connectionId, request])) as BiQueryResultShim;
    },
    async biSql(connectionId, sql) {
      return (await call(rt, "cap.biSql", [connectionId, sql])) as BiQueryResultShim;
    },
    async listBiConnections() {
      return (await call(rt, "cap.biListConnections", [])) as BiConnectionSummary[];
    },
  };
}

// ---- Unlocked API shim ----

function buildUnlockedShim(rt: WorkerRuntime): Record<string, unknown> {
  return {
    getCellValue: (row: number, col: number) => call(rt, "api.getCellValue", [row, col]),
    setCellValue: (row: number, col: number, value: string) => call(rt, "api.setCellValue", [row, col, value]),
    updateCellsBatch: (updates: unknown[]) => call(rt, "api.updateCellsBatch", [updates]),
    getSheetNames: () => call(rt, "api.getSheetNames", []),
    getActiveSheet: () => call(rt, "api.getActiveSheet", []),
    setActiveSheet: (index: number) => call(rt, "api.setActiveSheet", [index]),
    emitEvent: (name: string, detail?: unknown) => callFire(rt, "api.emitEvent", [name, detail]),
    onEvent(name: string, handler: (detail: unknown) => void): CleanupFn {
      const cleanup = registerHook(rt, `event:${name}`, handler);
      callFire(rt, "events.subscribe", [name]);
      return cleanup;
    },
    executeCommand: (commandId: string, args?: unknown) => callFire(rt, "api.executeCommand", [commandId, args]),
    beginBatch: (description: string) => call(rt, "api.beginBatch", [description]),
    commitBatch: () => call(rt, "api.commitBatch", []),
    cancelBatch: () => call(rt, "api.cancelBatch", []),
  };
}

// ---- Own-object helpers ----

/** Own-object mutation: aspect dispatched host-side on the mount-pinned instance. */
function setState(rt: WorkerRuntime, aspect: string, args: unknown[]): Promise<unknown> {
  return call(rt, "object.setState", [aspect, args]);
}

function setStateFire(rt: WorkerRuntime, aspect: string, args: unknown[]): void {
  callFire(rt, "object.setState", [aspect, args]);
}

function getState(rt: WorkerRuntime, aspect: string, args: unknown[]): Promise<unknown> {
  return call(rt, "object.getState", [aspect, args]);
}

// ---- Typed contexts ----

function buildTyped(rt: WorkerRuntime, base: Record<string, unknown>): Record<string, unknown> {
  const { spec } = rt;
  const instanceId = spec.instanceId || "";

  switch (spec.objectType) {
    case "workbook":
      return {
        ...base,
        onOpen: (h: Handler) => registerHook(rt, "onOpen", h),
        onBeforeSave: (h: Handler) => registerHook(rt, "onBeforeSave", h),
        onAfterSave: (h: Handler) => registerHook(rt, "onAfterSave", h),
        onBeforeClose: (h: Handler) => registerHook(rt, "onBeforeClose", h),
        onSheetChange: (h: Handler) => registerHook(rt, "onSheetChange", h),
        onThemeChange: (h: Handler) => registerHook(rt, "onThemeChange", h),
        properties: {
          get title() { return mirror(rt, "workbook.title", ""); },
          get author() { return mirror(rt, "workbook.author", ""); },
          get sheetCount() { return mirror(rt, "workbook.sheetCount", 0); },
          getSheetNames() { return [...mirror<string[]>(rt, "workbook.sheetNames", [])]; },
        },
      };

    case "sheet":
      return {
        ...base,
        onActivate: (h: Handler) => registerHook(rt, "onActivate", h),
        onDeactivate: (h: Handler) => registerHook(rt, "onDeactivate", h),
        onSelectionChange: (h: Handler) => registerHook(rt, "onSelectionChange", h),
        onDataChange: (h: Handler) => registerHook(rt, "onDataChange", h),
        getCellValue: (row: number, col: number, sheetIndex?: number) =>
          call(rt, "sheet.getCellValue", [row, col, sheetIndex]),
        setCellValue: (row: number, col: number, value: string, sheetIndex?: number) =>
          call(rt, "sheet.setCellValue", [row, col, value, sheetIndex]),
      };

    case "cell":
      return {
        ...base,
        // The host batches one message per CELL_VALUES_CHANGED; legacy
        // semantics call the handler once per change — fan out here.
        onEdit: (h: Handler) =>
          registerHook(rt, "onEdit", (payload) => {
            const d = payload as { changes?: unknown[] };
            for (const change of d.changes ?? []) {
              h(change);
            }
          }),
        onSelect: (h: Handler) => registerHook(rt, "onSelect", h),
        onEditStart: (h: Handler) => registerHook(rt, "onEditStart", h),
        onEditEnd: (h: Handler) => registerHook(rt, "onEditEnd", h),
        onRender(handler: unknown): CleanupFn {
          // Runs in THIS realm on host renderCells batches. Must be a pure
          // function of its payload — results are cached host-side (SWR).
          rt.renderers.set("onRender", handler);
          rt.post({ t: "hookRegistered", hook: "onRender" });
          return () => {
            rt.renderers.delete("onRender");
          };
        },
        render: {
          invalidate: () => callFire(rt, "render.invalidate", []),
        },
      };

    case "row":
      return {
        ...base,
        onInsert: (h: Handler) => registerHook(rt, "onInsert", h),
        onDelete: (h: Handler) => registerHook(rt, "onDelete", h),
        onResize: (h: Handler) => registerHook(rt, "onResize", h),
      };

    case "column":
      return {
        ...base,
        onInsert: (h: Handler) => registerHook(rt, "onInsert", h),
        onDelete: (h: Handler) => registerHook(rt, "onDelete", h),
        onResize: (h: Handler) => registerHook(rt, "onResize", h),
      };

    case "slicer":
      return {
        ...base,
        instanceId,
        name: spec.scriptName,
        onSelectionChange: (h: Handler) => registerHook(rt, "onSelectionChange", h),
        getSelectedItems: () => [...mirror<string[]>(rt, "slicer.selection", [])],
        setSelectedItems: (items: string[] | null) => setState(rt, "slicer.setSelectedItems", [items]),
        clearSelection: () => setState(rt, "slicer.setSelectedItems", [[]]),
        selectAll: () => setState(rt, "slicer.setSelectedItems", [null]),
        style: {
          itemRenderer(renderer: unknown): CleanupFn {
            rt.renderers.set("itemRenderer", renderer);
            rt.post({ t: "hookRegistered", hook: "itemRenderer" });
            return () => {
              rt.renderers.delete("itemRenderer");
            };
          },
          setProperty: (name: string, value: unknown) => setStateFire(rt, "slicer.setStyleProperty", [name, value]),
          invalidate: () => callFire(rt, "render.invalidate", []),
        },
        properties: {
          get fieldName() { return mirror(rt, "slicer.fieldName", ""); },
          get sourceType() { return mirror(rt, "slicer.sourceType", ""); },
          get columns() { return mirror(rt, "slicer.columns", 1); },
        },
      };

    case "chart":
      return {
        ...base,
        instanceId,
        onDataChange: (h: Handler) => registerHook(rt, "onDataChange", h),
        getSpec: () => mirror<Record<string, unknown>>(rt, "chart.spec", {}),
        updateSpec: (patch: unknown) => setState(rt, "chart.updateSpec", [patch]),
        style: {
          setProperty: (name: string, value: unknown) => setStateFire(rt, "chart.setStyleProperty", [name, value]),
        },
      };

    case "pivot":
      return {
        ...base,
        instanceId,
        onRefresh: (h: Handler) => registerHook(rt, "onRefresh", h),
        getFields: () =>
          mirror(rt, "pivot.fields", { rows: [], columns: [], values: [], filters: [] }),
        refresh: () => setState(rt, "pivot.refresh", []),
      };

    case "shape":
      return {
        ...base,
        instanceId,
        get shapeType() {
          return mirror<Record<string, string>>(rt, "shape.properties", {})["shapeType"] || "rectangle";
        },
        onClick: (h: Handler) => registerHook(rt, "onClick", h),
        onResize: (h: Handler) => registerHook(rt, "onResize", h),
        onPropertyChange(h: Handler): CleanupFn {
          return registerHook(rt, "onPropertyChange", (payload) => {
            // Keep the mirror current before the handler observes it.
            const d = payload as { key: string; newValue: string };
            const props = { ...mirror<Record<string, string>>(rt, "shape.properties", {}) };
            props[d.key] = d.newValue;
            rt.mirrors.set("shape.properties", props);
            h(payload);
          });
        },
        getProperty(key: string): string {
          return mirror<Record<string, string>>(rt, "shape.properties", {})[key] || "";
        },
        async setProperty(key: string, value: string): Promise<void> {
          const props = { ...mirror<Record<string, string>>(rt, "shape.properties", {}) };
          props[key] = value;
          rt.mirrors.set("shape.properties", props);
          await setState(rt, "shape.setProperty", [key, value]);
        },
        getCellValue: (cellRef: string) => getState(rt, "shape.cellValue", [cellRef]),
        onCellChange: (h: Handler) => registerHook(rt, "onCellChange", h),
        declareProperties: (props: unknown) => setStateFire(rt, "shape.declareProperties", [props]),
        render: {
          setHtmlContent: (html: string) => callFire(rt, "render.setHtml", [html]),
          sendMessage: (type: string, data?: unknown) => setStateFire(rt, "shape.sendMessage", [type, data]),
          onMessage: (h: Handler) => registerHook(rt, "onMessage", h),
          canvasRenderer(renderer: unknown): CleanupFn {
            rt.renderers.set("canvasRenderer", renderer);
            rt.post({ t: "hookRegistered", hook: "canvasRenderer" });
            return () => {
              rt.renderers.delete("canvasRenderer");
              callFire(rt, "render.invalidate", []);
            };
          },
          invalidate: () => callFire(rt, "render.invalidate", []),
        },
      };

    case "panel":
      return {
        ...base,
        instanceId,
        title: spec.scriptName,
        onClick: (h: Handler) => registerHook(rt, "onClick", h),
        onActivate: (h: Handler) => registerHook(rt, "onActivate", h),
        onDeactivate: (h: Handler) => registerHook(rt, "onDeactivate", h),
        onPlacementChange: (h: Handler) => registerHook(rt, "onPlacementChange", h),
        onShow: (h: Handler) => registerHook(rt, "onShow", h),
        onHide: (h: Handler) => registerHook(rt, "onHide", h),
        open: () => setStateFire(rt, "panel.open", []),
        close: () => setStateFire(rt, "panel.close", []),
        setBadge: (text: string | null) => setStateFire(rt, "panel.setBadge", [text]),
        moveTo: (placement: string) => setStateFire(rt, "panel.moveTo", [placement]),
        properties: {
          get panelId() { return instanceId; },
          get title() { return rt.spec.scriptName; },
          get placement() { return mirror(rt, "panel.placement", "unknown"); },
          get movable() { return mirror(rt, "panel.movable", true); },
        },
      };

    default:
      // button / timeline / future types: base surface only.
      return base;
  }
}
