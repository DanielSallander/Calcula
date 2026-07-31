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
import { callDeadlineMs, MAX_INFLIGHT_CALLS } from "../protocol";
import type {
  ScriptDialogFormSpec,
  ScriptDialogPromptOptions,
  ScriptDialogTextOptions,
} from "../scriptDialogSpec";
import {
  makeRange,
  rangeFromAddress,
  makeWorkbook,
  type RangeTransport,
  type ScriptCell,
  type ScriptFormat,
  type ScriptRange,
  type WorkbookTransport,
} from "./canonicalModel";

/** Sort criterion accepted by api.sortRange (mirrors @api SortField). */
interface ScriptSortField {
  /** 0-based offset of the sort column FROM THE RANGE START. */
  key: number;
  ascending?: boolean;
  sortOn?: "value" | "cellColor" | "fontColor" | "icon";
  color?: string;
  dataOption?: "normal" | "textAsNumber";
  subField?: string;
  customOrder?: string;
}

interface ScriptSortOptions {
  matchCase?: boolean;
  hasHeaders?: boolean;
  orientation?: "rows" | "columns";
}

interface ScriptFindOptions {
  caseSensitive?: boolean;
  matchEntireCell?: boolean;
  searchFormulas?: boolean;
}

/** One object returned by api.charts() / api.tables() / ... (mirrors the host's
 *  ScriptObjectRef; see scriptHost/objectInventory.ts). */
interface ScriptObjectRef {
  kind: string;
  id: string;
  name: string;
  sheetIndex: number | null;
  range?: string;
  sourceRange?: string;
  refersTo?: string;
  kindDetail?: string;
  fieldName?: string;
  rowCount?: number;
  columnCount?: number;
}

/** Placement options for api.createChart. */
interface ScriptChartOptions {
  name?: string;
  sheetIndex?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/** A pivot layout area, in the Pivot Layout DSL's vocabulary. */
type ScriptPivotArea = "rows" | "columns" | "values" | "filters";

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
  // Per-method deadline. Nearly everything gets CALL_TIMEOUT_MS (30s); the
  // ui.dialog family waits on a PERSON, so a 30s timer here would abandon the
  // call while the user was still reading the modal they were shown.
  const deadline = callDeadlineMs(method);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rt.pending.delete(callId);
      reject(new RpcError({ code: "Timeout", message: `${method} timed out after ${deadline}ms` }));
    }, deadline) as unknown as number;
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

/**
 * Register a REPLYING hook — one whose return value the host AWAITS and acts on
 * (workbook onBeforeSave / onBeforeClose).
 *
 * The handlers still live in `rt.hooks`, so several may be registered and each
 * one's cleanup works as usual; what changes is delivery. Instead of a fire-and-
 * forget `event` message, the host relays a methodCall to `relayName` and the
 * dispatcher below runs the handlers IN ORDER, awaiting each, and returns the
 * FIRST cancelling verdict (short-circuiting the rest — a cancelled save has no
 * reason to keep asking). A handler that throws does not cancel: its error is
 * reported and the next handler runs, so one broken handler cannot make a
 * workbook unsaveable.
 */
function registerReplyingHook(
  rt: WorkerRuntime,
  hook: string,
  relayName: string,
  handler: (payload: unknown) => unknown,
): CleanupFn {
  const cleanup = registerHook(rt, hook, handler as Handler);
  if (!rt.exposed.has(relayName)) {
    rt.exposed.set(relayName, async (payload: unknown) => {
      for (const h of [...(rt.hooks.get(hook) ?? [])]) {
        let verdict: unknown;
        try {
          verdict = await (h as (p: unknown) => unknown)(payload);
        } catch (err) {
          rt.post({
            t: "error",
            hook,
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
          continue;
        }
        if (verdict === false || verdict === "cancel") return { cancel: true };
        if (verdict && typeof verdict === "object" && (verdict as { cancel?: unknown }).cancel === true) {
          return verdict;
        }
      }
      return null;
    });
  }
  return cleanup;
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
  // Frozen so a script cannot rewrite its own provenance and hand the mutated
  // object to another script through callMethod. Null for local scripts.
  const packageInfo = spec.packageInfo
    ? Object.freeze({
        name: spec.packageInfo.name,
        version: spec.packageInfo.version,
        provenance: spec.packageInfo.provenance,
      })
    : null;

  return {
    objectType: spec.objectType,
    accessLevel: spec.tier,
    apiVersion: spec.apiVersion,
    /** Which .calp package (and version) this script shipped in; null locally. */
    package: packageInfo,

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

// Writeback shapes (mirror api/distribution.ts; defined inline so the worker
// bundle never imports the Tauri backend).

/** One value a script fills into a subscribed package's input cell. */
type WritebackSubmissionValueShim =
  | { type: "number"; value: number }
  | { type: "text"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "empty" };

/** Which publisher-side submission store an action addresses: a grid writeback
 *  region, or a BI model writeback column. Exactly one key. */
type WritebackTargetShim = { regionId: string } | { writebackId: string };

/** A publisher's approve/reject/reset decision. */
type WritebackReviewShim =
  | {
      regionId: string;
      submitterId: string;
      cellRow: number;
      cellCol: number;
      newState: "approved" | "rejected" | "submitted";
      reason?: string;
      submissionId?: string;
    }
  | {
      writebackId: string;
      submissionId: string;
      newState: "approved" | "rejected" | "submitted";
      reason?: string;
    };

/** Connector-secret header injection spec (bi.connector; resolved server-side). */
interface SecretHeaderShim {
  sourceId: string;
  slot: string;
  header: string;
  format?: string;
}

/** context.caps.* — thin RPC wrappers that add no authority of their own. */
function buildCapsShim(rt: WorkerRuntime): {
  fetch: (
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      secretHeader?: SecretHeaderShim;
    },
  ) => Promise<CapsFetchResponse>;
  storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
  };
  biQuery(connectionId: string, request: BiQueryRequestShim): Promise<BiQueryResultShim>;
  biSql(connectionId: string, sql: string): Promise<BiQueryResultShim>;
  listBiConnections(): Promise<BiConnectionSummary[]>;
  cube: {
    value(connection: string, ...members: string[]): Promise<number | null>;
    kpi(connection: string, kpi: string, property: number): Promise<number | null>;
    members(connection: string, level: string): Promise<string[]>;
  };
  biModel: {
    info(connectionId: string): Promise<unknown>;
    upsert(connectionId: string, kind: string, payload: Record<string, unknown>): Promise<unknown>;
    delete(connectionId: string, kind: string, payload: Record<string, unknown>): Promise<unknown>;
    validateMeasure(connectionId: string, name: string, formula: string, originalName?: string): Promise<unknown>;
    validateContext(connectionId: string, name: string, expression: string, originalName?: string): Promise<unknown>;
    validateModel(connectionId: string): Promise<unknown>;
    dependencyGraph(connectionId: string): Promise<unknown>;
    measureLineage(connectionId: string, name: string): Promise<unknown>;
    dependents(connectionId: string, kind: string, name: string, table?: string): Promise<unknown>;
    batchBegin(connectionId: string): Promise<unknown>;
    batchEnd(connectionId: string): Promise<unknown>;
    batchCancel(connectionId: string): Promise<unknown>;
  };
  writeback: {
    listRegions(): Promise<unknown[]>;
    getLayer(): Promise<unknown>;
    saveDraft(regionId: string, sheetId: string, row: number, col: number, value: WritebackSubmissionValueShim): Promise<unknown>;
    submitRegion(regionId: string): Promise<number>;
    previewSubmission(regionId: string): Promise<unknown>;
    listSubmissions(target: WritebackTargetShim): Promise<unknown[]>;
    setSubmissionState(decision: WritebackReviewShim): Promise<void>;
  };
  connector: {
    register(connectionId: string, def: Record<string, unknown>): Promise<unknown>;
    remove(connectionId: string, sourceId: string): Promise<void>;
  };
  schedule: {
    every(
      intervalSecs: number,
      handlerName: string,
      options?: { label?: string },
    ): Promise<unknown>;
    at(timeOfDay: string, handlerName: string, options?: { label?: string }): Promise<unknown>;
    list(): Promise<unknown[]>;
    cancel(jobId: string): Promise<boolean>;
  };
  dialog: {
    alert(message: string, options?: ScriptDialogTextOptions): Promise<void>;
    confirm(message: string, options?: ScriptDialogTextOptions): Promise<boolean>;
    prompt(message: string, options?: ScriptDialogPromptOptions): Promise<string | null>;
    form(spec: ScriptDialogFormSpec): Promise<Record<string, unknown> | null>;
  };
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
    cube: {
      async value(connection: string, ...members: string[]) {
        return (await call(rt, "cap.cubeValue", [connection, members])) as number | null;
      },
      async kpi(connection: string, kpi: string, property: number) {
        return (await call(rt, "cap.cubeKpi", [connection, kpi, property])) as number | null;
      },
      async members(connection: string, level: string) {
        return (await call(rt, "cap.cubeMembers", [connection, level])) as string[];
      },
    },
    // Governed model definitions (the bi.model capability): a sanitized read
    // plus undoable, audited mutation over the Rust script_bi_model gateway.
    biModel: {
      async info(connectionId: string) {
        return call(rt, "cap.biModelInfo", [connectionId]);
      },
      async upsert(connectionId: string, kind: string, payload: Record<string, unknown>) {
        return call(rt, "cap.biModelUpsert", [connectionId, kind, payload]);
      },
      async delete(connectionId: string, kind: string, payload: Record<string, unknown>) {
        return call(rt, "cap.biModelDelete", [connectionId, kind, payload]);
      },
      // Read-only diagnostics. Ask BEFORE you edit: a validate call costs a
      // token from a separate 120/min budget, so it can still answer after the
      // mutation budget is spent. Privileged detail (roles, sources, hosts) is
      // stripped from every answer AND from every error message.
      async validateMeasure(connectionId: string, name: string, formula: string, originalName?: string) {
        return call(rt, "cap.biModelValidate", [
          connectionId,
          "validateMeasure",
          { name, formula, originalName: originalName ?? null },
        ]);
      },
      async validateContext(connectionId: string, name: string, expression: string, originalName?: string) {
        return call(rt, "cap.biModelValidate", [
          connectionId,
          "validateContext",
          { name, expression, originalName: originalName ?? null },
        ]);
      },
      async validateModel(connectionId: string) {
        return call(rt, "cap.biModelValidate", [connectionId, "validateModel", {}]);
      },
      async dependencyGraph(connectionId: string) {
        return call(rt, "cap.biModelLineage", [connectionId, "dependencyGraph", {}]);
      },
      async measureLineage(connectionId: string, name: string) {
        return call(rt, "cap.biModelLineage", [connectionId, "measureLineage", { name }]);
      },
      // Impact check before a delete. Security roles bound to the object are
      // reported as a COUNT (privilegedDependents), never by name.
      async dependents(connectionId: string, kind: string, name: string, table?: string) {
        return call(rt, "cap.biModelLineage", [
          connectionId,
          "dependents",
          { kind, name, table: table ?? null },
        ]);
      },
      // Atomicity, not budget: batchBegin costs a mutation token and every edit
      // inside still costs one. Only the script that opened a batch may close
      // it, and an abandoned batch is rolled back on a deadline.
      async batchBegin(connectionId: string) {
        return call(rt, "cap.biModelBatch", [connectionId, "batchBegin"]);
      },
      async batchEnd(connectionId: string) {
        return call(rt, "cap.biModelBatch", [connectionId, "batchEnd"]);
      },
      async batchCancel(connectionId: string) {
        return call(rt, "cap.biModelBatch", [connectionId, "batchCancel"]);
      },
    },
    // The .calp collection loop (the distribution.writeback capability): fill in
    // a subscribed package's input cells and send them. The first five methods
    // are the SUBSCRIBER side (your own answers). The last two are the
    // PUBLISHER side — they read everybody's submitted data and decide its fate
    // — and Rust refuses them unless this workbook can SIGN the package, so
    // holding the capability is not enough.
    writeback: {
      async listRegions() {
        return (await call(rt, "cap.writebackListRegions", [])) as unknown[];
      },
      async getLayer() {
        return call(rt, "cap.writebackGetLayer", []);
      },
      async saveDraft(
        regionId: string,
        sheetId: string,
        row: number,
        col: number,
        value: WritebackSubmissionValueShim,
      ) {
        return call(rt, "cap.writebackSaveDraft", [regionId, sheetId, row, col, value]);
      },
      async submitRegion(regionId: string) {
        return (await call(rt, "cap.writebackSubmit", [regionId])) as number;
      },
      async previewSubmission(regionId: string) {
        return call(rt, "cap.writebackPreview", [regionId]);
      },
      async listSubmissions(target: WritebackTargetShim) {
        return (await call(rt, "cap.writebackListSubmissions", [target])) as unknown[];
      },
      async setSubmissionState(decision: WritebackReviewShim) {
        await call(rt, "cap.writebackReview", [decision]);
      },
    },
    // Script-fed data connector (the bi.connector capability). The script also
    // exposes `fetchTable` (context.expose) — the trusted host calls it per
    // declared table and hands the rows to the volume-capped Rust gate.
    connector: {
      async register(connectionId: string, def: Record<string, unknown>) {
        return call(rt, "cap.connectorRegister", [connectionId, def]);
      },
      async remove(connectionId: string, sourceId: string) {
        await call(rt, "cap.connectorRemove", [connectionId, sourceId]);
      },
    },
    // Persistent recurring jobs (the `schedule` capability) — the replacement
    // for VBA's Application.OnTime. `handlerName` must be a method this script
    // already published with context.expose(...): a schedule is a standing
    // permission to call ONE named entry point, not a stored closure, which is
    // what makes it reviewable in the transparency panel after a reload.
    //
    // The jobs persist in the WORKBOOK and resume next time it is opened —
    // while Calcula is open. There is no headless runtime; a script that needs
    // work done at 3am with the app closed cannot get it from here, and should
    // not pretend otherwise to the user.
    schedule: {
      /** Run `handlerName` every `intervalSecs` (minimum 30). */
      async every(intervalSecs: number, handlerName: string, options?: { label?: string }) {
        return call(rt, "cap.scheduleEvery", [intervalSecs, handlerName, options]);
      },
      /** Run `handlerName` daily at a LOCAL "HH:MM" (e.g. "06:30"). */
      async at(timeOfDay: string, handlerName: string, options?: { label?: string }) {
        return call(rt, "cap.scheduleAt", [timeOfDay, handlerName, options]);
      },
      /** This script's own scheduled jobs. */
      async list() {
        return (await call(rt, "cap.scheduleList", [])) as unknown[];
      },
      /** Cancel one of this script's own jobs. */
      async cancel(jobId: string) {
        return (await call(rt, "cap.scheduleCancel", [jobId])) as boolean;
      },
    },
    // Modal question + declarative form (the ui.dialog capability). These are
    // the only shims that await a HUMAN, so their RPC deadline is the long one
    // (protocol.ts METHOD_DEADLINES_MS). Dismissal is never an error: confirm
    // resolves false, prompt and form resolve null, so `if (!answer) return;`
    // is the whole cancel path a script has to write.
    dialog: {
      async alert(message: string, options?: ScriptDialogTextOptions) {
        await call(rt, "cap.dialogAlert", [message, options]);
      },
      async confirm(message: string, options?: ScriptDialogTextOptions) {
        return (await call(rt, "cap.dialogConfirm", [message, options])) as boolean;
      },
      async prompt(message: string, options?: ScriptDialogPromptOptions) {
        return (await call(rt, "cap.dialogPrompt", [message, options])) as string | null;
      },
      async form(spec: ScriptDialogFormSpec) {
        return (await call(rt, "cap.dialogForm", [spec])) as Record<string, unknown> | null;
      },
    },
  };
}

// ---- Cross-instance object handles (B3) ----
//
// A script is pinned to ONE object at mount, and `object.setState` can only ever
// name that instance. These handles are the UNLOCKED-tier escape hatch: they
// carry an explicit target id to api.objectSetState / api.objectGetState, which
// dispatch through the very SAME host aspect executors the own-object door uses.
// Nothing here adds authority — the tier check on those two allowlist rows is
// what makes a target id sayable at all, and a restricted script never gets this
// shim built.

/** Mutate another object's state through the shared aspect executors. */
function objSet(
  rt: WorkerRuntime,
  objectType: string,
  id: string,
  aspect: string,
  args: unknown[],
): Promise<unknown> {
  return call(rt, "api.objectSetState", [objectType, id, aspect, args]);
}

/** Read another object's state through the shared aspect executors. */
function objGet(
  rt: WorkerRuntime,
  objectType: string,
  id: string,
  aspect: string,
  args: unknown[],
): Promise<unknown> {
  return call(rt, "api.objectGetState", [objectType, id, aspect, args]);
}

function makeChartHandle(rt: WorkerRuntime, id: string): Record<string, unknown> {
  return {
    id,
    // Cross-instance reads are ASYNC (a foreign chart has no worker-local
    // mirror — only the script's own object gets pushed one).
    getSpec: () => objGet(rt, "chart", id, "chart.getSpec", []),
    updateSpec: (patch: Record<string, unknown>) => objSet(rt, "chart", id, "chart.updateSpec", [patch]),
    replaceSpec: (fullSpec: Record<string, unknown>) => objSet(rt, "chart", id, "chart.replaceSpec", [fullSpec]),
    setStyleProperty: (name: string, value: unknown) =>
      objSet(rt, "chart", id, "chart.setStyleProperty", [name, value]),
    delete: () => call(rt, "api.deleteChart", [id]),
  };
}

function makeTableHandle(rt: WorkerRuntime, id: string): Record<string, unknown> {
  // The same TABLE-RELATIVE transport the own-object table context uses, so
  // `api.table(id).range("A1:C5")` behaves exactly like `table.range("A1:C5")`
  // inside that table's own script. Host-side every coordinate still resolves
  // through tableCellCoord, so it cannot escape the table body.
  const transport: RangeTransport = {
    readCell: (row, col) => objGet(rt, "table", id, "table.getCellValue", [row, col]) as Promise<string>,
    writeCell: (row, col, value) =>
      objSet(rt, "table", id, "table.setCellValue", [row, col, value]) as Promise<void>,
    readRange: (sr, sc, er, ec) =>
      objGet(rt, "table", id, "table.getRangeData", [sr, sc, er, ec]) as Promise<ScriptCell[][]>,
    writeCells: (sr, sc, values) =>
      objSet(rt, "table", id, "table.setRangeValues", [sr, sc, values]) as Promise<void>,
    formatRange: (sr, sc, er, ec, format) =>
      objSet(rt, "table", id, "table.setRangeFormat", [sr, sc, er, ec, format]) as Promise<void>,
    clearFormatRange: (sr, sc, er, ec) =>
      objSet(rt, "table", id, "table.clearRangeFormat", [sr, sc, er, ec]) as Promise<void>,
  };
  return {
    id,
    getCellValue: (row: number, colIndex: number) =>
      objGet(rt, "table", id, "table.getCellValue", [row, colIndex]),
    setCellValue: (row: number, colIndex: number, value: string) =>
      objSet(rt, "table", id, "table.setCellValue", [row, colIndex, value]),
    addRow: () => objSet(rt, "table", id, "table.addRow", []),
    range: (address: string): ScriptRange => rangeFromAddress(transport, address),
    cell: (row: number, colIndex: number): ScriptRange =>
      makeRange(transport, { startRow: row, startCol: colIndex, endRow: row, endCol: colIndex }),
    delete: () => call(rt, "api.deleteTable", [id]),
  };
}

function makePivotHandle(rt: WorkerRuntime, id: string): Record<string, unknown> {
  return {
    id,
    getFields: () => objGet(rt, "pivot", id, "pivot.getFields", []),
    refresh: () => objSet(rt, "pivot", id, "pivot.refresh", []),
    addField: (field: string, area: ScriptPivotArea, position?: number, aggregation?: string) =>
      objSet(rt, "pivot", id, "pivot.addField", [field, area, position, aggregation]),
    moveField: (field: string, area: ScriptPivotArea, position?: number) =>
      objSet(rt, "pivot", id, "pivot.moveField", [field, area, position]),
    removeField: (field: string, area?: ScriptPivotArea) =>
      objSet(rt, "pivot", id, "pivot.removeField", [field, area]),
    setAggregation: (field: string, aggregation: string) =>
      objSet(rt, "pivot", id, "pivot.setAggregation", [field, aggregation]),
    setLayout: (directives: string[]) => objSet(rt, "pivot", id, "pivot.setLayout", [directives]),
    delete: () => call(rt, "api.deletePivot", [id]),
  };
}

function makeSlicerHandle(rt: WorkerRuntime, id: string): Record<string, unknown> {
  return {
    id,
    getSelectedItems: () => objGet(rt, "slicer", id, "slicer.getSelectedItems", []),
    setSelectedItems: (items: string[] | null) =>
      objSet(rt, "slicer", id, "slicer.setSelectedItems", [items]),
    clearSelection: () => objSet(rt, "slicer", id, "slicer.setSelectedItems", [[]]),
    selectAll: () => objSet(rt, "slicer", id, "slicer.setSelectedItems", [null]),
    setStyleProperty: (name: string, value: unknown) =>
      objSet(rt, "slicer", id, "slicer.setStyleProperty", [name, value]),
  };
}

function makeShapeHandle(rt: WorkerRuntime, id: string): Record<string, unknown> {
  return {
    id,
    setProperty: (key: string, value: string) => objSet(rt, "shape", id, "shape.setProperty", [key, value]),
    getCellValue: (cellRef: string) => objGet(rt, "shape", id, "shape.cellValue", [cellRef]),
    sendMessage: (type: string, data?: unknown) =>
      objSet(rt, "shape", id, "shape.sendMessage", [type, data]),
  };
}

function makeNamedRangeHandle(rt: WorkerRuntime, name: string): Record<string, unknown> {
  return {
    name,
    getValues: () => objGet(rt, "namedRange", name, "namedRange.getValues", []),
    setValues: (values: string[][]) => objSet(rt, "namedRange", name, "namedRange.setValues", [values]),
    delete: () => call(rt, "api.deleteNamedRange", [name]),
  };
}

// ---- Unlocked API shim ----

function buildUnlockedShim(rt: WorkerRuntime): Record<string, unknown> {
  // Cross-sheet transport for the canonical Workbook navigation. readCell/
  // writeCell go through sheet.getCellValue/setCellValue WITH a sheetIndex — the
  // host permits that cross-sheet reach only for the unlocked tier, which is
  // exactly when this shim is built. No new aspect / no new privileged surface.
  const workbookTransport: WorkbookTransport = {
    getSheetNames: () => call(rt, "api.getSheetNames", []) as Promise<string[]>,
    getActiveSheet: () => call(rt, "api.getActiveSheet", []) as Promise<number>,
    setActiveSheet: (index) => call(rt, "api.setActiveSheet", [index]) as Promise<void>,
    readCell: (sheetIndex, row, col) =>
      call(rt, "sheet.getCellValue", [row, col, sheetIndex]) as Promise<string>,
    writeCell: (sheetIndex, row, col, value) =>
      call(rt, "sheet.setCellValue", [row, col, value, sheetIndex]) as Promise<void>,
    // Bulk paths: one RPC per rectangle instead of one per cell (B1).
    readRange: (sheetIndex, sr, sc, er, ec) =>
      call(rt, "api.getRangeValues", [sr, sc, er, ec, sheetIndex]) as Promise<ScriptCell[][]>,
    writeCells: (sheetIndex, sr, sc, values) =>
      call(rt, "sheet.setRangeValues", [sr, sc, values, sheetIndex]) as Promise<void>,
    // Formatting (B2): sheet-scoped, so it works on any sheet the navigation
    // reached — no active-sheet dance.
    formatRange: (sheetIndex, sr, sc, er, ec, format) =>
      call(rt, "api.setRangeFormat", [sr, sc, er, ec, format, sheetIndex]) as Promise<void>,
    clearFormatRange: (sheetIndex, sr, sc, er, ec) =>
      call(rt, "api.clearRangeFormat", [sr, sc, er, ec, sheetIndex]) as Promise<void>,
  };
  return {
    getCellValue: (row: number, col: number) => call(rt, "api.getCellValue", [row, col]),
    setCellValue: (row: number, col: number, value: string) => call(rt, "api.setCellValue", [row, col, value]),
    updateCellsBatch: (updates: unknown[]) => call(rt, "api.updateCellsBatch", [updates]),
    // Typed reads: value + type + formula, so a read/modify/write round-trip
    // cannot silently replace a formula with its display text.
    getCellData: (row: number, col: number, sheetIndex?: number) =>
      call(rt, "api.getCellData", [row, col, sheetIndex]),
    getRangeValues: (startRow: number, startCol: number, endRow: number, endCol: number, sheetIndex?: number) =>
      call(rt, "api.getRangeValues", [startRow, startCol, endRow, endCol, sheetIndex]),
    getSheetNames: () => call(rt, "api.getSheetNames", []),
    getActiveSheet: () => call(rt, "api.getActiveSheet", []),
    setActiveSheet: (index: number) => call(rt, "api.setActiveSheet", [index]),
    // Canonical Workbook -> Sheet -> Range navigation (C3 step 3).
    workbook: makeWorkbook(workbookTransport),
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

    // ---- Formatting (B2) ----
    setRangeFormat: (
      startRow: number, startCol: number, endRow: number, endCol: number,
      format: ScriptFormat, sheetIndex?: number,
    ) => call(rt, "api.setRangeFormat", [startRow, startCol, endRow, endCol, format, sheetIndex]),
    clearRangeFormat: (
      startRow: number, startCol: number, endRow: number, endCol: number, sheetIndex?: number,
    ) => call(rt, "api.clearRangeFormat", [startRow, startCol, endRow, endCol, sheetIndex]),

    // ---- Structure (B2) ----
    insertRows: (startRow: number, count: number, sheetIndex?: number) =>
      call(rt, "api.insertRows", [startRow, count, sheetIndex]),
    deleteRows: (startRow: number, count: number, sheetIndex?: number) =>
      call(rt, "api.deleteRows", [startRow, count, sheetIndex]),
    insertColumns: (startCol: number, count: number, sheetIndex?: number) =>
      call(rt, "api.insertColumns", [startCol, count, sheetIndex]),
    deleteColumns: (startCol: number, count: number, sheetIndex?: number) =>
      call(rt, "api.deleteColumns", [startCol, count, sheetIndex]),
    mergeCells: (
      startRow: number, startCol: number, endRow: number, endCol: number, sheetIndex?: number,
    ) => call(rt, "api.mergeCells", [startRow, startCol, endRow, endCol, sheetIndex]),
    unmergeCells: (row: number, col: number, sheetIndex?: number) =>
      call(rt, "api.unmergeCells", [row, col, sheetIndex]),
    setRowHeight: (row: number, height: number, sheetIndex?: number) =>
      call(rt, "api.setRowHeight", [row, height, sheetIndex]),
    setColumnWidth: (col: number, width: number, sheetIndex?: number) =>
      call(rt, "api.setColumnWidth", [col, width, sheetIndex]),
    freezePanes: (freezeRow: number | null, freezeCol: number | null) =>
      call(rt, "api.freezePanes", [freezeRow, freezeCol]),

    // ---- Sheet CRUD (B2) ----
    addSheet: (name?: string) => call(rt, "api.addSheet", [name]),
    deleteSheet: (index: number) => call(rt, "api.deleteSheet", [index]),
    renameSheet: (index: number, newName: string) => call(rt, "api.renameSheet", [index, newName]),
    setSheetVisibility: (index: number, visibility: "visible" | "hidden" | "veryHidden") =>
      call(rt, "api.setSheetVisibility", [index, visibility]),

    // ---- Sort + find/replace (B2) ----
    sortRange: (
      startRow: number, startCol: number, endRow: number, endCol: number,
      fields: ScriptSortField[], options?: ScriptSortOptions, sheetIndex?: number,
    ) => call(rt, "api.sortRange", [startRow, startCol, endRow, endCol, fields, options, sheetIndex]),
    findAll: (query: string, options?: ScriptFindOptions) =>
      call(rt, "api.findAll", [query, options]),
    replaceAll: (
      search: string, replacement: string,
      options?: { caseSensitive?: boolean; matchEntireCell?: boolean },
    ) => call(rt, "api.replaceAll", [search, replacement, options]),

    // ---- Workbook objects: enumerate (B3) ----
    // One broker method (api.listObjects) behind six named readers, so the
    // consent text a user reads is one line while the script surface stays
    // discoverable.
    charts: () => call(rt, "api.listObjects", ["chart"]) as Promise<ScriptObjectRef[]>,
    tables: () => call(rt, "api.listObjects", ["table"]) as Promise<ScriptObjectRef[]>,
    pivots: () => call(rt, "api.listObjects", ["pivot"]) as Promise<ScriptObjectRef[]>,
    namedRanges: () => call(rt, "api.listObjects", ["namedRange"]) as Promise<ScriptObjectRef[]>,
    slicers: () => call(rt, "api.listObjects", ["slicer"]) as Promise<ScriptObjectRef[]>,
    shapes: () => call(rt, "api.listObjects", ["shape"]) as Promise<ScriptObjectRef[]>,

    // ---- Workbook objects: create / delete (B3) ----
    createChart: (spec: Record<string, unknown>, options?: ScriptChartOptions) =>
      call(rt, "api.createChart", [spec, options]),
    deleteChart: (chartId: string) => call(rt, "api.deleteChart", [chartId]),
    createTable: (
      startRow: number, startCol: number, endRow: number, endCol: number,
      options?: { name?: string; hasHeaders?: boolean },
    ) => call(rt, "api.createTable", [startRow, startCol, endRow, endCol, options]),
    deleteTable: (tableId: string) => call(rt, "api.deleteTable", [tableId]),
    createNamedRange: (
      name: string, refersTo: string,
      options?: { sheetIndex?: number | null; comment?: string },
    ) => call(rt, "api.createNamedRange", [name, refersTo, options]),
    deleteNamedRange: (name: string) => call(rt, "api.deleteNamedRange", [name]),
    createPivot: (
      sourceRange: string, destinationCell: string,
      fields: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => call(rt, "api.createPivot", [sourceRange, destinationCell, fields, options]),
    deletePivot: (pivotId: string) => call(rt, "api.deletePivot", [pivotId]),

    // ---- Workbook objects: address ANOTHER instance (B3) ----
    chart: (chartId: string) => makeChartHandle(rt, chartId),
    table: (tableId: string) => makeTableHandle(rt, tableId),
    pivot: (pivotId: string) => makePivotHandle(rt, pivotId),
    slicer: (slicerId: string) => makeSlicerHandle(rt, slicerId),
    shape: (shapeId: string) => makeShapeHandle(rt, shapeId),
    namedRange: (name: string) => makeNamedRangeHandle(rt, name),
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
        // Cancellable: return false / "cancel" / { cancel: true, reason } to
        // stop the save or the close. Answer within the host's deadline —
        // a verdict that arrives late is ignored and the operation proceeds.
        onBeforeSave: (h: (payload: unknown) => unknown) =>
          registerReplyingHook(rt, "onBeforeSave", "__workbook_onBeforeSave", h),
        onAfterSave: (h: Handler) => registerHook(rt, "onAfterSave", h),
        onBeforeClose: (h: (payload: unknown) => unknown) =>
          registerReplyingHook(rt, "onBeforeClose", "__workbook_onBeforeClose", h),
        onSheetChange: (h: Handler) => registerHook(rt, "onSheetChange", h),
        onThemeChange: (h: Handler) => registerHook(rt, "onThemeChange", h),
        properties: {
          get title() { return mirror(rt, "workbook.title", ""); },
          get author() { return mirror(rt, "workbook.author", ""); },
          get sheetCount() { return mirror(rt, "workbook.sheetCount", 0); },
          getSheetNames() { return [...mirror<string[]>(rt, "workbook.sheetNames", [])]; },
        },
      };

    case "sheet": {
      // Canonical-model facet (C3 step 3): a Range/Cell over THIS sheet, backed
      // by the same restricted, own-sheet broker aspects the flat getCellValue/
      // setCellValue use — pure sugar, no new privileged surface. Bound to the
      // own sheet (no sheetIndex passed), so reads/writes stay clamped to it.
      const sheetTransport: RangeTransport = {
        readCell: (row: number, col: number) =>
          call(rt, "sheet.getCellValue", [row, col]) as Promise<string>,
        writeCell: (row: number, col: number, value: string) =>
          call(rt, "sheet.setCellValue", [row, col, value]) as Promise<void>,
        // Bulk own-sheet I/O (B1): one RPC per rectangle, typed reads, and a
        // block write that lands as a single undo step.
        readRange: (sr: number, sc: number, er: number, ec: number) =>
          call(rt, "sheet.getRangeValues", [sr, sc, er, ec]) as Promise<ScriptCell[][]>,
        writeCells: (sr: number, sc: number, values: Array<Array<string | undefined>>) =>
          call(rt, "sheet.setRangeValues", [sr, sc, values]) as Promise<void>,
        // Own-sheet formatting (B2), same clamp as the value paths above.
        formatRange: (sr: number, sc: number, er: number, ec: number, format: ScriptFormat) =>
          call(rt, "sheet.setRangeFormat", [sr, sc, er, ec, format]) as Promise<void>,
        clearFormatRange: (sr: number, sc: number, er: number, ec: number) =>
          call(rt, "sheet.clearRangeFormat", [sr, sc, er, ec]) as Promise<void>,
      };
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
        getCellData: (row: number, col: number, sheetIndex?: number) =>
          call(rt, "sheet.getCellData", [row, col, sheetIndex]),
        setRangeFormat: (
          startRow: number, startCol: number, endRow: number, endCol: number,
          format: ScriptFormat, sheetIndex?: number,
        ) => call(rt, "sheet.setRangeFormat", [startRow, startCol, endRow, endCol, format, sheetIndex]),
        clearRangeFormat: (
          startRow: number, startCol: number, endRow: number, endCol: number, sheetIndex?: number,
        ) => call(rt, "sheet.clearRangeFormat", [startRow, startCol, endRow, endCol, sheetIndex]),
        range: (address: string): ScriptRange =>
          rangeFromAddress(sheetTransport, address),
        cell: (row: number, col: number): ScriptRange =>
          makeRange(sheetTransport, {
            startRow: row,
            startCol: col,
            endRow: row,
            endCol: col,
          }),
      };
    }

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
        replaceSpec: (fullSpec: unknown) => setState(rt, "chart.replaceSpec", [fullSpec]),
        style: {
          setProperty: (name: string, value: unknown) => setStateFire(rt, "chart.setStyleProperty", [name, value]),
        },
      };

    case "pivot":
      return {
        ...base,
        instanceId,
        onRefresh: (h: Handler) => registerHook(rt, "onRefresh", h),
        onDrillThrough: (h: Handler) => registerHook(rt, "onDrillThrough", h),
        getFields: () =>
          mirror(rt, "pivot.fields", { rows: [], columns: [], values: [], filters: [] }),
        refresh: () => setState(rt, "pivot.refresh", []),
        // ---- Layout mutation (B3) ----
        // The vocabulary is the Pivot Layout DSL's: areas are rows/columns/
        // values/filters, aggregations are sum/count/average/min/max/
        // countnumbers/stddev/stddevp/var/varp/product, and setLayout takes the
        // LAYOUT clause's directives ("compact", "values-on-rows", ...).
        addField: (field: string, area: ScriptPivotArea, position?: number, aggregation?: string) =>
          setState(rt, "pivot.addField", [field, area, position, aggregation]),
        moveField: (field: string, area: ScriptPivotArea, position?: number) =>
          setState(rt, "pivot.moveField", [field, area, position]),
        removeField: (field: string, area?: ScriptPivotArea) =>
          setState(rt, "pivot.removeField", [field, area]),
        setAggregation: (field: string, aggregation: string) =>
          setState(rt, "pivot.setAggregation", [field, aggregation]),
        setLayout: (directives: string[]) => setState(rt, "pivot.setLayout", [directives]),
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

    case "button":
      return {
        ...base,
        instanceId,
        onClick: (h: Handler) => registerHook(rt, "onClick", h),
      };

    case "table": {
      // Canonical-model facet (C3 polish): a Range over the table's data body in
      // TABLE-RELATIVE coordinates (row 0 = first data row, col 0 = first table
      // column), backed by the same own-object table.getCellValue/setCellValue
      // aspects the flat methods use — pure sugar, no new privileged surface.
      const tableTransport: RangeTransport = {
        readCell: (row: number, col: number) =>
          getState(rt, "table.getCellValue", [row, col]) as Promise<string>,
        writeCell: (row: number, col: number, value: string) =>
          setState(rt, "table.setCellValue", [row, col, value]) as Promise<void>,
        // Bulk own-object aspects (B1) — still table-relative, still clamped to
        // the table body host-side.
        readRange: (sr: number, sc: number, er: number, ec: number) =>
          getState(rt, "table.getRangeData", [sr, sc, er, ec]) as Promise<ScriptCell[][]>,
        writeCells: (sr: number, sc: number, values: Array<Array<string | undefined>>) =>
          setState(rt, "table.setRangeValues", [sr, sc, values]) as Promise<void>,
        // Own-object formatting (B2): table-relative, clamped to the body.
        formatRange: (sr: number, sc: number, er: number, ec: number, format: ScriptFormat) =>
          setState(rt, "table.setRangeFormat", [sr, sc, er, ec, format]) as Promise<void>,
        clearFormatRange: (sr: number, sc: number, er: number, ec: number) =>
          setState(rt, "table.clearRangeFormat", [sr, sc, er, ec]) as Promise<void>,
      };
      return {
        ...base,
        instanceId,
        name: spec.scriptName,
        onDataChange: (h: Handler) => registerHook(rt, "onDataChange", h),
        getHeaders: () => [...mirror<string[]>(rt, "table.headers", [])],
        getRowCount: () => mirror(rt, "table.rowCount", 0),
        getCellValue: (row: number, colIndex: number) => getState(rt, "table.getCellValue", [row, colIndex]),
        setCellValue: (row: number, colIndex: number, value: string) =>
          setState(rt, "table.setCellValue", [row, colIndex, value]),
        addRow: () => setState(rt, "table.addRow", []),
        range: (address: string): ScriptRange =>
          rangeFromAddress(tableTransport, address),
        cell: (row: number, colIndex: number): ScriptRange =>
          makeRange(tableTransport, {
            startRow: row,
            startCol: colIndex,
            endRow: row,
            endCol: colIndex,
          }),
        properties: {
          get name() { return mirror(rt, "table.name", ""); },
          get sheetIndex() { return mirror(rt, "table.sheetIndex", 0); },
          get rowCount() { return mirror(rt, "table.rowCount", 0); },
        },
      };
    }

    case "namedRange":
      return {
        ...base,
        instanceId,
        name: spec.scriptName,
        onChange: (h: Handler) => registerHook(rt, "onChange", h),
        getAddress: () => mirror(rt, "namedRange.address", ""),
        getValues: () => mirror<string[][]>(rt, "namedRange.values", []),
        setValues: (values: string[][]) => setState(rt, "namedRange.setValues", [values]),
        properties: {
          get refersTo() { return mirror(rt, "namedRange.refersTo", ""); },
          get scope() { return mirror(rt, "namedRange.scope", "workbook"); },
        },
      };

    case "range":
      // A cell-behavior binding (granular bricks phase 2): grid gestures reach
      // the script asynchronously; writes go through host-side aspects clamped
      // to the binding's target.
      return {
        ...base,
        instanceId,
        onClick: (h: Handler) => registerHook(rt, "onClick", h),
        onDoubleClick: (h: Handler) => registerHook(rt, "onDoubleClick", h),
        onChange: (h: Handler) => registerHook(rt, "onChange", h),
        // onBeforeCommit is a REPLYING hook: the host awaits the handler's
        // verdict (via the methodCall channel) under a hard deadline, so it
        // registers as an internal exposed method rather than an event hook.
        onBeforeCommit: (h: (payload: unknown) => unknown): CleanupFn => {
          rt.exposed.set("__range_onBeforeCommit", h as (...args: unknown[]) => unknown);
          if (!rt.registeredHooks.has("onBeforeCommit")) {
            rt.registeredHooks.add("onBeforeCommit");
            rt.post({ t: "hookRegistered", hook: "onBeforeCommit" });
          }
          return () => {
            rt.exposed.delete("__range_onBeforeCommit");
          };
        },
        getAddress: () => mirror(rt, "range.address", ""),
        getValues: () => mirror<string[][]>(rt, "range.values", []),
        setValues: (values: string[][]) => setState(rt, "range.setValues", [values]),
        setCellType: (typeId: string, params?: Record<string, unknown>) =>
          setState(rt, "range.setCellType", [typeId, params ?? {}]),
        clearCellType: () => setState(rt, "range.clearCellType", []),
      };

    case "timeline":
      return {
        ...base,
        instanceId,
        name: spec.scriptName,
        onChange: (h: Handler) => registerHook(rt, "onChange", h),
        getRange: () => ({
          start: mirror<string | null>(rt, "timeline.selectionStart", null),
          end: mirror<string | null>(rt, "timeline.selectionEnd", null),
        }),
        setRange: (start: string | null, end: string | null) =>
          setState(rt, "timeline.setSelection", [start ?? null, end ?? null]),
        clearSelection: () => setState(rt, "timeline.setSelection", [null, null]),
        properties: {
          get fieldName() { return mirror(rt, "timeline.fieldName", ""); },
          get level() { return mirror(rt, "timeline.level", ""); },
          get sourceType() { return mirror(rt, "timeline.sourceType", ""); },
        },
      };

    case "chartMark":
      // A sandboxed custom chart mark (B8.D): the script registers a markRenderer
      // that paints the plot area into a worker OffscreenCanvas. The host blits
      // the returned bitmap into the chart's clipped plot rect — the mark never
      // touches the real canvas/DOM and needs no capability (paint-only).
      return {
        ...base,
        instanceId,
        render: {
          markRenderer(renderer: unknown): CleanupFn {
            rt.renderers.set("markRenderer", renderer);
            rt.post({ t: "hookRegistered", hook: "markRenderer" });
            return () => {
              rt.renderers.delete("markRenderer");
              callFire(rt, "render.invalidate", []);
            };
          },
          invalidate: () => callFire(rt, "render.invalidate", []),
        },
      };

    default:
      // textbox / future types: base surface only.
      return base;
  }
}
