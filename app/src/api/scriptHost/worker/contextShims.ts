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
import { callDeadlineMs, MAX_INFLIGHT_CALLS, RUN_TARGET_EXPOSED_PREFIX } from "../protocol";
import type {
  ScriptDialogFormSpec,
  ScriptDialogPromptOptions,
  ScriptDialogTextOptions,
} from "../scriptDialogSpec";
import {
  makeRange,
  rangeFromAddress,
  makeWorkbook,
  parseA1Body,
  resolveSheetName,
  sheetRangeTransport,
  splitSheetPrefix,
  type Box,
  type CellPoint,
  type EdgeDirection,
  type FillCount,
  type GoalSeekOutcome,
  type RangeGroupResult,
  type RangeTransport,
  type RegionResult,
  type RemoveDuplicatesCount,
  type ScriptCell,
  type ScriptCellFormat,
  type ScriptFormat,
  type ScriptRange,
  type ScriptValidationRule,
  type SheetFindResult,
  type SpecialCellsAnswer,
  type SpecialCellsKind,
  type TextToColumnsCount,
  type WorkbookTransport,
} from "./canonicalModel";
// Pure CSV helpers (Wave 3, item 9): dependency-free @api module shared with
// the CsvImportExport extension — runs INSIDE the worker, no broker involved.
import {
  scriptParseCsv,
  scriptToCsv,
  type ScriptParseCsvOptions,
  type ScriptParseCsvResult,
  type ScriptToCsvOptions,
} from "../../csvText";

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

/** How a sheet is addressed (Wave 1): a 0-based index or a sheet NAME. Names
 *  resolve HOST-SIDE at execution time against the live sheet list — exact
 *  match first, then case-insensitively if unique — never in this worker, so a
 *  name always means what the workbook means by it when the call lands. */
type SheetRef = number | string;

/** What a cell write accepts (Wave 1): a typed value. Numbers and booleans
 *  land TYPED (42 reads back as the number 42); null CLEARS the cell. */
type ScriptCellValue = string | number | boolean | null;

/** api.sleep's per-call ceiling (Wave 4): the same 30s bound every broker call
 *  carries (protocol.ts CALL_TIMEOUT_MS), stated as a literal because this
 *  module is bundled into the worker and must stay dependency-light. */
const MAX_SLEEP_MS = 30_000;

/** Where addSheet/copySheet place the new sheet (Wave 4): before OR after an
 *  existing sheet (index or name) — naming both is refused. */
interface ScriptSheetPositionShim {
  before?: SheetRef;
  after?: SheetRef;
}

/** The active sheet's page setup, as api.getPageSetup answers it and (any
 *  subset of it) api.setPageSetup accepts. Mirrors the backend PageSetup;
 *  print area / print titles / manual breaks are READ here but WRITTEN through
 *  their own methods (setPrintArea, addPageBreak, ...). */
interface ScriptPageSetupShim {
  paperSize: "letter" | "a4" | "a3" | "legal" | "tabloid";
  orientation: "portrait" | "landscape";
  /** Margins in INCHES. */
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  marginHeader: number;
  marginFooter: number;
  /** Print scale percent (10-400); ignored when fitToWidth/Height are on. */
  scale: number;
  /** Fit-to pages across / down (0 = off). */
  fitToWidth: number;
  fitToHeight: number;
  printGridlines: boolean;
  printHeadings: boolean;
  /** Read-only here: "A1:F20", or "" for the whole sheet (use setPrintArea). */
  printArea: string;
  /** Read-only here: rows repeated at top, "1:2" ("" = none). */
  printTitlesRows: string;
  /** Read-only here: columns repeated at left, "A:B" ("" = none). */
  printTitlesCols: string;
  centerHorizontally: boolean;
  centerVertically: boolean;
  /** Header/footer template ("&L&F&C&P of &N&R&D"). */
  header: string;
  footer: string;
  /** Read-only here: manual break positions (use addPageBreak/removePageBreak). */
  manualRowBreaks: number[];
  manualColBreaks: number[];
}

interface ScriptFindOptions {
  caseSensitive?: boolean;
  matchEntireCell?: boolean;
  searchFormulas?: boolean;
  /** The sheet to search (0-based index or NAME, resolved host-side under the
   *  Wave-1 rules). Omit for the active sheet. */
  sheetIndex?: SheetRef;
  /** Restrict the search to a rectangle: a Box or an A1 spelling ("B2:D10").
   *  Omit to search the whole sheet (Wave 4). */
  range?: Box | string;
}

interface ScriptReplaceOptions {
  caseSensitive?: boolean;
  matchEntireCell?: boolean;
  /** The sheet to replace on (Wave-1 rules). Omit for the active sheet. */
  sheetIndex?: SheetRef;
  /** Restrict the replace to a rectangle: a Box or an A1 spelling. Omit to
   *  replace across the whole sheet (Wave 4). */
  range?: Box | string;
}

/** api.removeDuplicates options. `columns` are 0-based offsets FROM THE RANGE
 *  START (sortRange-style); omitted = every column of the range. */
interface ScriptRemoveDuplicatesOptions {
  columns?: number[];
  hasHeaders?: boolean;
}

/** api.textToColumns options. Each delimiter is ONE character; omitting
 *  `delimiters` splits on commas. `destination` defaults to the source's own
 *  top-left cell. ACTIVE SHEET only (the split writes through the visible
 *  grid), refused otherwise. */
interface ScriptTextToColumnsOptions {
  delimiters?: string[];
  consecutiveAsOne?: boolean;
  destination?: CellPoint;
  sheetIndex?: SheetRef;
}

/** api.goalSeek parameters (VBA Range.GoalSeek). The target cell must hold a
 *  formula; the variable cell must hold a constant. ACTIVE SHEET only. */
interface ScriptGoalSeekParams {
  targetRow: number;
  targetCol: number;
  targetValue: number;
  variableRow: number;
  variableCol: number;
  maxIterations?: number;
  tolerance?: number;
  sheetIndex?: SheetRef;
}

/** api.addHyperlink's link spec (a union on `type`; per-type keys enforced
 *  broker-side with the accepted list). */
interface ScriptHyperlinkSpecShim {
  type: "url" | "email" | "internalReference" | "file";
  target?: string;
  subject?: string;
  sheetName?: string;
  cellReference?: string;
}

interface ScriptHyperlinkOptionsShim {
  displayText?: string;
  tooltip?: string;
}

/** A hyperlink as scripts read it back (mirrors the host's ScriptHyperlink). */
interface ScriptHyperlinkShim {
  row: number;
  col: number;
  sheetIndex: number;
  type: "url" | "email" | "internalReference" | "file";
  target: string;
  displayText: string | null;
  tooltip: string | null;
  sheetName: string | null;
  cellReference: string | null;
}

/** One api.listDataValidations entry: the rectangle + its flat rule. */
interface ScriptValidationRangeInfoShim extends Box {
  rule: ScriptValidationRule;
}

// ---- Selection + navigation (Wave 2) ----

/** One rectangular area of a selection, normalized (start <= end per axis). */
interface ScriptSelectionArea {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** What api.getSelection() returns (mirrors the host's ScriptSelectionSnapshot;
 *  null when nothing is selected). */
interface ScriptSelection extends ScriptSelectionArea {
  /** The sheet the selection lives on (0-based). */
  sheetIndex: number;
  /** The active cell — the one a keystroke would land in. */
  activeRow: number;
  activeCol: number;
  /** EVERY selected area: the primary rectangle first, then each Ctrl+Click
   *  area. Always at least one entry. */
  areas: ScriptSelectionArea[];
}

/** api.select options. `scroll` defaults to true (Application.Goto scrolls);
 *  `ranges` adds Ctrl+Click-style extra areas. */
interface ScriptSelectOptions {
  /** 0-based sheet index or sheet name (resolved host-side, Wave-1 rules). */
  sheetIndex?: SheetRef;
  scroll?: boolean;
  ranges?: ScriptSelectionArea[];
}

/** api.clearRange options. Default applyTo: "all". */
interface ScriptClearOptions {
  applyTo?: "all" | "contents" | "formats";
}

/** api.fillRange options (Wave 3, item 10). The rectangle is SOURCE + TARGET
 *  together: the band of `sourceSize` (default 1) rows/columns at the edge
 *  `direction` starts from seeds the rest. */
interface ScriptFillOptions {
  direction?: "down" | "up" | "right" | "left";
  /** "copy" (default): tile the band, shifting formulas — Excel FillDown.
   *  "series": the drag handle's series/date/custom-list inference. */
  type?: "copy" | "series";
  sourceSize?: number;
}

/** One sheet as api.getSheets() lists it (mirrors the host executor's shape —
 *  the visibility/tabColor that getSheetNames discards). */
interface ScriptSheetInfo {
  index: number;
  name: string;
  visibility: "visible" | "hidden" | "veryHidden";
  tabColor: string | null;
}

/** How one column of an AutoFilter is currently filtered (read back). */
interface ScriptAutoFilterColumn {
  /** 0-based offset FROM THE FILTER'S FIRST COLUMN. */
  columnIndex: number;
  filterOn: string;
  values: string[];
  criterion1: string | null;
  criterion2: string | null;
  operator: "and" | "or" | null;
  filterOutBlanks: boolean;
}

/** The column filter on the active sheet (mirrors @api AutoFilterSnapshot). */
interface ScriptAutoFilter {
  id: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  enabled: boolean;
  isDataFiltered: boolean;
  /** One entry per column of the range, in range order; null = unfiltered. */
  columns: Array<ScriptAutoFilterColumn | null>;
  /** Absolute row indices the filter is currently hiding. */
  hiddenRows: number[];
}

/** What may be asked of one column: pick values, or write a rule. */
type ScriptAutoFilterCriteria =
  | { kind: "values"; values: string[]; includeBlanks?: boolean }
  | { kind: "custom"; criterion1: string; criterion2?: string; operator?: "and" | "or" };

/** Distinct values in one filtered column. */
interface ScriptAutoFilterValues {
  values: Array<{ value: string; count: number }>;
  hasBlanks: boolean;
}

/** api.evaluate options. `sheetIndex` is the sheet UNQUALIFIED references
 *  resolve against (defaults to the active one); "Sheet2!A1" always works. */
interface ScriptEvaluateOptions {
  /** 0-based sheet index or sheet name. */
  sheetIndex?: SheetRef;
}

/** One evaluated expression — the same value/display/type triple a typed cell
 *  read carries, minus the coordinates and the formula. */
interface ScriptEvaluatedValue {
  value: number | string | boolean | null;
  display: string;
  type: "number" | "text" | "boolean" | "empty" | "error";
}

/** Formula read/write options. `style` is the notation the CALLER is speaking —
 *  never the user's View setting, so a script's meaning cannot change because
 *  somebody ticked a checkbox. */
interface ScriptFormulaOptions {
  style?: "A1" | "R1C1";
  /** 0-based sheet index or sheet name. */
  sheetIndex?: SheetRef;
}

/** What copy/paste answer with, so a caller can size its own layout. */
interface ScriptClipboardSize {
  rows: number;
  cols: number;
}

/** PasteSpecial options. "formats" is deliberately not a mode — see the host
 *  executor: there is no batch style write, and the per-cell one silently does
 *  nothing on a destination cell that does not exist yet. */
interface ScriptPasteOptions {
  mode?: "all" | "values" | "formulas";
  transpose?: boolean;
  skipBlanks?: boolean;
  /** 0-based sheet index or sheet name (must resolve to the active sheet). */
  sheetIndex?: SheetRef;
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
  /** 0-based sheet index or sheet name. */
  sheetIndex?: SheetRef;
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

/**
 * Host event → registered handlers. Handler errors go to the host as script
 * errors.
 *
 * Every handler is INVOKED SYNCHRONOUSLY, in registration order, exactly as
 * before — the returned promise only settles afterwards, once every handler
 * that returned a thenable has settled. Two things depend on that:
 *
 *  - the debugger can say when an execution genuinely ENDS (bootstrap.ts wraps
 *    this call in an activity report), instead of guessing from the dispatch;
 *  - an ASYNC handler that rejects is now reported like a synchronous throw.
 *    It previously escaped the try/catch entirely and became an unhandled
 *    rejection — silent on a production mount, which is the one direction an
 *    error must never travel.
 */
export function dispatchEvent(
  rt: WorkerRuntime,
  hook: string,
  payload: unknown,
  post: Post,
): Promise<void> | void {
  const handlers = rt.hooks.get(hook);
  if (!handlers) return;
  const report = (err: unknown): void => {
    post({
      t: "error",
      hook,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  };
  let pending: Array<Promise<void>> | null = null;
  for (const handler of [...handlers]) {
    let result: unknown;
    try {
      result = handler(payload);
    } catch (err) {
      report(err);
      continue;
    }
    if (result && typeof (result as { then?: unknown }).then === "function") {
      (pending ??= []).push(
        Promise.resolve(result).then(
          () => undefined,
          (err: unknown) => report(err),
        ),
      );
    }
  }
  if (!pending) return;
  return Promise.all(pending).then(() => undefined);
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

/**
 * Register a RUN-AT-CURSOR run-target (VBA F5), used ONLY on a debug mount.
 *
 * A top-level function like `function doThing(api) { ... }` lives in the wrapper
 * closure and is unreachable from any host message once the module resolves —
 * exactly the wall `setup` sits behind. This exposes it through the SAME door
 * `context.expose` uses (`rt.exposed` + a `base.expose` relay), under the
 * host-only run-target prefix so no script can reach it (`callExposed` refuses
 * the whole `HOST_ONLY_EXPOSED_PREFIX` namespace; only `hostCallExposed` gets
 * in). The thunk is ARITY-BOUND against the live `fn.length`, closing over the
 * live `context`:
 *   - `fn.length === 0` -> `fn()`
 *   - `fn.length === 1` -> `fn(context.api)`   (the conventional `fn(api)` macro)
 *   - `fn.length  >  1` -> a clear throw, never a wrong-arity call.
 *
 * `options.entryPoint` marks the script's own `setup`, which is registered as a
 * run-target ONLY on an inert debug mount (one that did not call it). Its single
 * parameter is the WHOLE `context`, not `context.api` — handing it `context.api`
 * would run the entry point with a `context` that has no `api`, `notify` or
 * `onClick`, and a recorded macro's first line (`if (!context.api)`) would then
 * report the script as restricted instead of running it.
 */
export function registerRunTargetHandler(
  rt: WorkerRuntime,
  displayName: string,
  fn: (...args: unknown[]) => unknown,
  context: { api?: unknown },
  options: { entryPoint?: boolean } = {},
): void {
  const exposedName = `${RUN_TARGET_EXPOSED_PREFIX}${displayName}`;
  const thunk = async (): Promise<unknown> => {
    if (fn.length === 0) return await fn();
    if (fn.length === 1) return await fn(options.entryPoint === true ? context : context.api);
    throw new Error(
      `Run can only start a function that takes no arguments or a single \`api\` argument; ` +
        `\`${displayName}\` takes ${fn.length} — call it from setup() instead.`,
    );
  };
  rt.exposed.set(exposedName, thunk);
  // Mirrors context.expose: register the relay host-side so the debugger can
  // list and invoke it, WITHOUT making it script-callable (host-only prefix).
  callFire(rt, "base.expose", [exposedName, false]);
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

    /**
     * Call an export of a shared library this script declared with `// @uses`.
     *
     * The ADDRESS is deliberately absent from this signature. Unlike callMethod,
     * the script cannot say which realm it wants — it says only which of ITS OWN
     * aliases it means, and the host resolves that against the import table it
     * built for this script's id. There is no token, handle or instance id to
     * hold, and therefore none to leak or be handed one: authority here is
     * identity, not possession. Scripts normally reach this through the
     * generated `imports.<alias>.<export>(...)` binding rather than by name.
     */
    callImport(alias: string, methodName: string, args: unknown[]): Promise<unknown> {
      return call(rt, "base.callImport", [alias, methodName, Array.isArray(args) ? args : []]);
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

/** What api.workbook.save() / saveAs() resolve to. `saved: false` is the
 *  cancelled case (a Before-Save veto or a dismissed picker) — not an error. */
interface ScriptSaveResultShim {
  saved: boolean;
  /** The file NAME written to; null when nothing was saved. Never a path. */
  name: string | null;
}

/** caps.file.exportText options (file.picker). Nothing here names a location:
 *  the two label fields only change words on the picker's file-type row, and
 *  `encoding` only changes how the text is encoded once the user has chosen. */
interface ScriptFileExportOptions {
  /** e.g. "text/csv" — used to label the picker's file-type row. */
  mimeType?: string;
  /** "utf-8" (default), "utf-8-bom" (what Excel wants for accented CSV), "ansi". */
  encoding?: "utf-8" | "utf-8-bom" | "ansi";
  /** Overrides the file-type row's label ("Quarterly report"). */
  description?: string;
}

/** caps.file.importText options (file.picker). `extensions` filters what the
 *  picker OFFERS; it does not restrict what the user may ultimately choose. */
interface ScriptFileImportOptions {
  /** Extensions without dots, e.g. ["csv", "txt"]. */
  extensions?: string[];
  /** Overrides the file-type row's label. */
  description?: string;
}

/** What caps.file.importText hands back. `name` is the FILE NAME the user saw
 *  in the picker — never the folder it came from. */
interface ScriptImportedFile {
  name: string;
  content: string;
}

/** caps.shortcut.bind options (ui.shortcut). There is nothing here that widens
 *  the reach: a label is what the user reads in their shortcut list. */
interface ScriptShortcutOptions {
  /** What the shortcut list should call this ("Refresh all figures"). */
  label?: string;
}

/** One live shortcut this script holds. `handler` is the exposed method the
 *  keys call — the reason the binding is readable months later. */
interface ScriptShortcutBinding {
  id: string;
  combo: string;
  scriptId: string;
  scriptName: string;
  handler: string;
  label: string;
}

/** caps.publish.package spec (distribution.publish).
 *
 *  NOTE WHAT IS NOT HERE, because each absence is enforced twice (validator +
 *  Rust gateway) rather than merely undocumented:
 *   - `publishedBy`    : the byline comes from the identity that SIGNS.
 *   - `customObjects`  : package payload is Calcula's to collect.
 *   - `includeComments`: shipping internal discussion is a human's decision. */
interface ScriptPublishSpec {
  /** One of the registries `caps.packages.listRegistries()` returned. */
  registry: string;
  packageName: string;
  /** Semver, e.g. "1.4.0" — `caps.publish.nextVersion` suggests one. */
  version: string;
  /** "report" (default) | "template" | "dataset" | "library" | a custom kind. */
  kind?: string;
  /** Sheets to ship. Omit for the kind's default: every sheet for a report,
   *  and NO sheets for a library (whose payload is its module scripts). */
  sheetIndices?: number[];
}

/** caps.publish.model spec (distribution.publish). Schema only — the model's
 *  data and credentials never travel. */
interface ScriptPublishModelSpec {
  registry: string;
  packageName: string;
  version: string;
  /** Which BI connection's model to publish. */
  connectionId: string;
}

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
    once(at: number | Date, handlerName: string, options?: { label?: string }): Promise<unknown>;
    list(): Promise<unknown[]>;
    cancel(jobId: string): Promise<boolean>;
  };
  dialog: {
    alert(message: string, options?: ScriptDialogTextOptions): Promise<void>;
    confirm(message: string, options?: ScriptDialogTextOptions): Promise<boolean>;
    prompt(message: string, options?: ScriptDialogPromptOptions): Promise<string | null>;
    form(spec: ScriptDialogFormSpec): Promise<Record<string, unknown> | null>;
  };
  file: {
    exportText(
      suggestedName: string,
      content: string,
      options?: ScriptFileExportOptions,
    ): Promise<string | null>;
    importText(options?: ScriptFileImportOptions): Promise<ScriptImportedFile | null>;
    exportPdf(suggestedName?: string): Promise<string | null>;
  };
  shortcut: {
    bind(
      combo: string,
      handlerName: string,
      options?: ScriptShortcutOptions,
    ): Promise<ScriptShortcutBinding>;
    unbind(combo: string): Promise<boolean>;
    list(): Promise<ScriptShortcutBinding[]>;
  };
  packages: {
    listRegistries(): Promise<unknown[]>;
    listSubscriptions(): Promise<unknown>;
    browse(registry: string): Promise<unknown[]>;
    inspect(registry: string, packageName: string, versionPin: string): Promise<unknown>;
    pull(registry: string, packageName: string, versionPin: string): Promise<unknown>;
    refreshPreview(): Promise<unknown>;
    refreshApply(): Promise<unknown>;
  };
  publish: {
    preview(sheetIndices?: number[]): Promise<unknown>;
    nextVersion(registry: string, packageName: string, bump: string): Promise<string>;
    package(spec: ScriptPublishSpec): Promise<unknown>;
    model(spec: ScriptPublishModelSpec): Promise<unknown>;
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
      /** Run `handlerName` ONCE at `at` (a Date or epoch ms) — VBA's one-shot
       *  Application.OnTime. At least 5 seconds from now; persisted like every
       *  schedule (a reload before it is due does not lose it), fires only if
       *  Calcula is open then, and removes itself after firing. For a plain
       *  in-session pause, use api.sleep instead. */
      async once(at: number | Date, handlerName: string, options?: { label?: string }) {
        const atMs = at instanceof Date ? at.getTime() : at;
        return call(rt, "cap.scheduleOnce", [atMs, handlerName, options]);
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
    // User-chosen file export / import (the file.picker capability). This shim
    // has no authority of its own and — just as importantly — no vocabulary for
    // one: there is no path parameter to pass, no directory to remember and no
    // handle to reuse. Every call opens a picker the USER drives, so "which
    // file" is answered by a human, once, per call.
    //
    // Both wait on a person, so their deadline is the long one (class "file" in
    // the allowlist -> METHOD_DEADLINES_MS). Cancelling resolves null; it never
    // rejects and never hangs.
    file: {
      /** Save `content` to a file the user picks. Resolves to the chosen file
       *  NAME, or null if they cancelled. */
      async exportText(
        suggestedName: string,
        content: string,
        options?: ScriptFileExportOptions,
      ) {
        return (await call(rt, "cap.fileExportText", [
          suggestedName,
          content,
          options,
        ])) as string | null;
      },
      /** Read a file the user picks. Resolves to { name, content }, or null if
       *  they cancelled. Rejects if the chosen file is too big to hand over —
       *  never silently truncated. */
      async importText(options?: ScriptFileImportOptions) {
        return (await call(rt, "cap.fileImportText", [options])) as ScriptImportedFile | null;
      },
      /**
       * Save the sheet you would PRINT as a PDF, to a file the user picks.
       * Resolves to the chosen file NAME, or null if they cancelled.
       *
       * The script supplies a name and nothing else — no bytes, no page setup,
       * no range. Calcula renders the document from the workbook's own print
       * settings (print area, print titles, page breaks, headers and footers),
       * exactly as File > Export to PDF does. Rejects when no print provider is
       * available, rather than writing an empty file.
       */
      async exportPdf(suggestedName?: string) {
        return (await call(rt, "cap.filePrintPdf", [suggestedName])) as string | null;
      },
    },
    // One keyboard shortcut, bound to one method this script already published
    // with context.expose (the `ui.shortcut` capability) — the replacement for
    // VBA's Application.OnKey.
    //
    // NOTE WHAT IS NOT HERE, because it is the point: there is no `onKey`, no
    // key stream, no listener over the keyboard. A script gets exactly the
    // combinations it asked for and was granted, one call each, and its handler
    // is told `{ combo }` — not which key, not what else was typed, not where
    // the focus was. A keyboard hook that could observe anything beyond its own
    // shortcut would be a keylogger with a nicer name, so that shape does not
    // exist to be misused.
    //
    // `bind` REJECTS rather than quietly failing: a combination Calcula needs,
    // one that anything else already holds, or a ninth shortcut all come back
    // as errors with the reason in plain words. Nothing is ever overridden.
    shortcut: {
      /** Bind `combo` (Ctrl+Shift+<letter>) to the exposed method `handlerName`. */
      async bind(combo: string, handlerName: string, options?: ScriptShortcutOptions) {
        return (await call(rt, "cap.shortcutBind", [
          combo,
          handlerName,
          options,
        ])) as ScriptShortcutBinding;
      },
      /** Give one shortcut back. Resolves false if this script did not hold it. */
      async unbind(combo: string) {
        return (await call(rt, "cap.shortcutUnbind", [combo])) as boolean;
      },
      /** The shortcuts this script currently holds. */
      async list() {
        return (await call(rt, "cap.shortcutList", [])) as ScriptShortcutBinding[];
      },
    },
    // INBOUND .calp distribution (the `distribution.subscribe` capability):
    // bring somebody else's published content into this workbook.
    //
    // TWO THINGS THIS SHIM CANNOT DO, and they are the reasons it exists in this
    // shape rather than as "subscribe(anything)":
    //  * it cannot name a registry the user has not already added — every method
    //    that takes one is refused in Rust against the machine's saved
    //    registries and this workbook's subscriptions, so the script's job is to
    //    CHOOSE from `listRegistries()`, not to invent a location; and
    //  * it cannot switch pulled code on. A pulled object script arrives
    //    restricted and unmounted; the user still answers the consent prompt.
    //    `refreshApply` is the same: a package script whose SOURCE changed is
    //    switched off again until the user re-approves it, so a script can never
    //    update itself into running new code.
    packages: {
      /** The registries set up on this machine. The only locations the other
       *  methods will accept. */
      async listRegistries() {
        return (await call(rt, "cap.pkgListRegistries", [])) as unknown[];
      },
      /** The packages this workbook subscribes to, and the version of each. */
      async listSubscriptions() {
        return call(rt, "cap.pkgListSubscriptions", []);
      },
      /** The packages available in one of your registries. */
      async browse(registry: string) {
        return (await call(rt, "cap.pkgBrowse", [registry])) as unknown[];
      },
      /** Look inside a package version — sheets, data sources, every script it
       *  carries and the capabilities each declares — WITHOUT taking it. */
      async inspect(registry: string, packageName: string, versionPin: string) {
        return call(rt, "cap.pkgInspect", [registry, packageName, versionPin]);
      },
      /** Subscribe to a package and materialize it. Verified exactly as an
       *  interactive subscribe is: Ed25519 signature, publisher trust pin,
       *  per-artifact checksums, minimum app version. */
      async pull(registry: string, packageName: string, versionPin: string) {
        return call(rt, "cap.pkgPull", [registry, packageName, versionPin]);
      },
      /** What updating every subscription would change — without changing it. */
      async refreshPreview() {
        return call(rt, "cap.pkgRefreshPreview", []);
      },
      /** Update every subscription to its publisher's newest matching version. */
      async refreshApply() {
        return call(rt, "cap.pkgRefreshApply", []);
      },
    },
    // OUTBOUND .calp distribution (the `distribution.publish` capability):
    // push this workbook to a registry, signed with the USER'S publisher key,
    // where everyone subscribed will receive it.
    //
    // Deliberately a DIFFERENT capability from `packages` above. Publishing puts
    // the user's name on content other people will run; pulling puts other
    // people's content in front of the user. A build script that publishes a
    // nightly report has no business pulling, and a dashboard that refreshes has
    // no business publishing.
    //
    // Holding the capability is NOT enough to publish: this machine must already
    // have a publisher identity (a script must never mint the key other people
    // pin as "you"), and for a package name that already exists in the registry
    // it must be THAT package's key. `publishedBy` is not settable — the byline
    // comes from the identity that signs.
    publish: {
      /** What publishing would ship and what it would leave behind. Sends
       *  nothing. Omit `sheetIndices` to preview every sheet. */
      async preview(sheetIndices?: number[]) {
        return call(rt, "cap.pkgPublishPreview", [sheetIndices]);
      },
      /** The next version number for one of your packages ("major" | "minor" |
       *  "patch"). */
      async nextVersion(registry: string, packageName: string, bump: string) {
        return (await call(rt, "cap.pkgNextVersion", [registry, packageName, bump])) as string;
      },
      /** Publish this workbook as a new version of `packageName`. Leaves the
       *  machine; cannot be taken back. */
      async package(spec: ScriptPublishSpec) {
        return call(rt, "cap.pkgPublish", [spec]);
      },
      /** Publish ONE BI model as a model-only package (schema only — no data
       *  and no credentials travel). */
      async model(spec: ScriptPublishModelSpec) {
        return call(rt, "cap.pkgPublishModel", [spec]);
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

/** The chart.setGeometry patch (mirrors the host's ChartPlacement + a named
 *  sheet — resolved host-side by the Wave-1 rules). */
interface ScriptChartGeometryShim {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  name?: string;
  sheetIndex?: SheetRef;
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
    // ---- Geometry + spec sugar (Wave 4) ----
    // setGeometry is PLACEMENT (position/size/name/sheet — the chart store's
    // path, not the spec's); the three sugars below are ordinary updateSpec
    // patches, so the Charts extension's schema validator stays the single
    // gate they pass through.
    setGeometry: (patch: ScriptChartGeometryShim) =>
      objSet(rt, "chart", id, "chart.setGeometry", [patch]),
    setTitle: (title: string | null) => objSet(rt, "chart", id, "chart.updateSpec", [{ title }]),
    setType: (mark: string) => objSet(rt, "chart", id, "chart.updateSpec", [{ mark }]),
    setSourceRange: (range: string) => objSet(rt, "chart", id, "chart.updateSpec", [{ data: range }]),
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
    /** The table's DATA BODY as a grid-absolute, sheet-bound ScriptRange —
     *  unlike range()/cell(), which are TABLE-RELATIVE and body-clamped. */
    toRange: (): Promise<ScriptRange> => tableToRange(rt, id),
    // ---- Structure (Wave 4): the ListObject management family ----
    rename: (newName: string) => objSet(rt, "table", id, "table.rename", [newName]),
    resize: (startRow: number, startCol: number, endRow: number, endCol: number) =>
      objSet(rt, "table", id, "table.resize", [startRow, startCol, endRow, endCol]),
    addColumn: (name: string, position?: number) =>
      objSet(rt, "table", id, "table.addColumn", [name, position]),
    removeColumn: (name: string) => objSet(rt, "table", id, "table.removeColumn", [name]),
    renameColumn: (oldName: string, newName: string) =>
      objSet(rt, "table", id, "table.renameColumn", [oldName, newName]),
    setTotalsRow: (show: boolean) => objSet(rt, "table", id, "table.setTotalsRow", [show]),
    setTotalsFunction: (column: string, fn: string, customFormula?: string) =>
      objSet(rt, "table", id, "table.setTotalsFunction", [column, fn, customFormula]),
    setStyle: (style: string | { styleName?: string; styleOptions?: Record<string, boolean> }) =>
      objSet(rt, "table", id, "table.setStyle", [style]),
    convertToRange: () => objSet(rt, "table", id, "table.convertToRange", []),
    insertRow: (position?: number) => objSet(rt, "table", id, "table.insertRow", [position]),
    deleteRow: (position: number) => objSet(rt, "table", id, "table.deleteRow", [position]),
    // Structure READS: the twins of the management aspects.
    getColumns: () => objGet(rt, "table", id, "table.getColumns", []),
    getStyle: () => objGet(rt, "table", id, "table.getStyle", []),
    getTotals: () => objGet(rt, "table", id, "table.getTotals", []),
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
    // ---- Data aspects (Wave 3 item 4): filters / visibility / sort / format ----
    getFieldInfo: (field: string) => objGet(rt, "pivot", id, "pivot.getFieldInfo", [field]),
    setFilter: (field: string, values: string[] | null) =>
      objSet(rt, "pivot", id, "pivot.setFilter", [field, values]),
    clearFilter: (field: string) => objSet(rt, "pivot", id, "pivot.clearFilter", [field]),
    setItemVisibility: (field: string, item: string, visible: boolean) =>
      objSet(rt, "pivot", id, "pivot.setItemVisibility", [field, item, visible]),
    sortField: (field: string, direction: "asc" | "desc") =>
      objSet(rt, "pivot", id, "pivot.sortField", [field, direction]),
    setNumberFormat: (valueField: string, format: string) =>
      objSet(rt, "pivot", id, "pivot.setNumberFormat", [valueField, format]),
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

/** The namedRange.update patch (tri-state scope: absent = keep, null =
 *  workbook, a sheet ref = that sheet). */
interface ScriptNamedRangeUpdateShim {
  refersTo?: string;
  newName?: string;
  comment?: string;
  sheetIndex?: SheetRef | null;
}

function makeNamedRangeHandle(rt: WorkerRuntime, name: string): Record<string, unknown> {
  // NAME-KEYED IDENTITY: every aspect addresses the range by its NAME, so a
  // successful rename must re-key the handle or every later call would target
  // a name that no longer exists. `currentName` is the one closure variable
  // all methods read; update() re-points it from the host's answer (the same
  // idiom ScriptSheet.rename uses).
  let currentName = name;
  const handle: Record<string, unknown> = {
    get name() { return currentName; },
    getValues: () => objGet(rt, "namedRange", currentName, "namedRange.getValues", []),
    setValues: (values: string[][]) =>
      objSet(rt, "namedRange", currentName, "namedRange.setValues", [values]),
    /** The name's grid rectangle as a sheet-bound ScriptRange. */
    toRange: (): Promise<ScriptRange> => namedRangeToRange(rt, currentName),
    // ---- Definition edit (Wave 4) ----
    update: async (patch: ScriptNamedRangeUpdateShim) => {
      const result = (await objSet(rt, "namedRange", currentName, "namedRange.update", [patch])) as
        { name: string };
      currentName = result.name;
      return result;
    },
    setRefersTo: (refersTo: string) =>
      objSet(rt, "namedRange", currentName, "namedRange.update", [{ refersTo }]),
    rename: async (newName: string) => {
      const result = (await objSet(rt, "namedRange", currentName, "namedRange.update", [{ newName }])) as
        { name: string };
      currentName = result.name;
      return result;
    },
    delete: () => call(rt, "api.deleteNamedRange", [currentName]),
  };
  return handle;
}

// ---- Top-level A1 / named-range / table range entry (Wave 1) ----

/**
 * Cross-sheet transport for the canonical Workbook navigation and for every
 * sheet-bound range this module builds. readCell/writeCell go through
 * sheet.getCellValue/setCellValue WITH a sheetIndex — the host permits that
 * cross-sheet reach only for the unlocked tier, which is the only tier these
 * builders run for. No new aspect / no new privileged surface.
 */
function makeWorkbookTransport(rt: WorkerRuntime): WorkbookTransport {
  return {
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
    // Format read-back (Wave 3): range.getFormats()/getFormat() on any sheet
    // the navigation reached.
    readFormats: (sheetIndex, sr, sc, er, ec) =>
      call(rt, "api.getRangeFormat", [sr, sc, er, ec, sheetIndex]) as Promise<ScriptCellFormat[][]>,
    // Named-style sugar (Wave 4): range.applyStyle("Good"). The host refuses a
    // non-active sheet (the backend command is active-sheet-only).
    applyNamedStyle: (sheetIndex, sr, sc, er, ec, name) =>
      call(rt, "api.applyNamedStyle", [name, sr, sc, er, ec, sheetIndex]) as Promise<void>,
    // Navigation reads + selection (Wave 2): the Range.End/CurrentRegion/
    // UsedRange discovery rows, and the range.select() sugar over api.select.
    rangeEdge: (sheetIndex, row, col, direction) =>
      call(rt, "api.getRangeEdge", [row, col, direction, sheetIndex]) as Promise<CellPoint>,
    currentRegion: (sheetIndex, row, col) =>
      call(rt, "api.getCurrentRegion", [row, col, sheetIndex]) as Promise<RegionResult>,
    usedRange: (sheet) => call(rt, "api.getUsedRange", [sheet]) as Promise<RegionResult>,
    selectRange: (sheetIndex, sr, sc, er, ec, scroll) =>
      call(rt, "api.select", [sr, sc, er, ec, { sheetIndex, scroll }]) as Promise<void>,
    // The rich sheet facet (Wave 2): thin delegates over the flat rows. Sheet
    // identity crosses as a REF (the facet passes its NAME), resolved
    // host-side per call under the Wave-1 rules.
    getSheetInfos: () => call(rt, "api.getSheets", []) as Promise<ScriptSheetInfo[]>,
    renameSheet: (sheet, newName) =>
      call(rt, "api.renameSheet", [sheet, newName]) as Promise<void>,
    deleteSheet: (sheet) => call(rt, "api.deleteSheet", [sheet]) as Promise<void>,
    setSheetVisibility: (sheet, visibility) =>
      call(rt, "api.setSheetVisibility", [sheet, visibility]) as Promise<void>,
    moveSheet: (sheet, toIndex) =>
      call(rt, "api.moveSheet", [sheet, toIndex]) as Promise<void>,
    copySheet: (sheet, newName) =>
      call(rt, "api.copySheet", [sheet, newName]) as Promise<{ index: number; name: string }>,
    setTabColor: (sheet, color) =>
      call(rt, "api.setTabColor", [sheet, color]) as Promise<void>,
    // Wave 3: sheet-addressable structural + data ops, so the rich sheet facet
    // and the sheet-bound ranges drive their own sheet without activating it.
    insertRows: (sheet, startRow, count) =>
      call(rt, "api.insertRows", [startRow, count, sheet]) as Promise<void>,
    deleteRows: (sheet, startRow, count) =>
      call(rt, "api.deleteRows", [startRow, count, sheet]) as Promise<void>,
    insertColumns: (sheet, startCol, count) =>
      call(rt, "api.insertColumns", [startCol, count, sheet]) as Promise<void>,
    deleteColumns: (sheet, startCol, count) =>
      call(rt, "api.deleteColumns", [startCol, count, sheet]) as Promise<void>,
    mergeCells: (sheet, sr, sc, er, ec) =>
      call(rt, "api.mergeCells", [sr, sc, er, ec, sheet]) as Promise<void>,
    unmergeCells: (sheet, row, col) =>
      call(rt, "api.unmergeCells", [row, col, sheet]) as Promise<void>,
    sortRange: (sheet, sr, sc, er, ec, fields, options) =>
      call(rt, "api.sortRange", [sr, sc, er, ec, fields, options, sheet]) as Promise<number>,
    clearRange: (sheet, sr, sc, er, ec, options) =>
      call(rt, "api.clearRange", [sr, sc, er, ec, options, sheet]) as Promise<{ count: number }>,
    findAll: (sheet, query, options) =>
      call(rt, "api.findAll", [query, { ...(options ?? {}), sheetIndex: sheet }]) as
        Promise<SheetFindResult>,
    replaceAll: (sheet, search, replacement, options) =>
      call(rt, "api.replaceAll", [search, replacement, { ...(options ?? {}), sheetIndex: sheet }]) as
        Promise<{ replacementCount: number }>,
    // Validation sugar (range.setValidation()/validation()): null = clear.
    setValidation: (sheetIndex, sr, sc, er, ec, rule) =>
      (rule === null
        ? call(rt, "api.clearDataValidation", [
            { startRow: sr, startCol: sc, endRow: er, endCol: ec }, sheetIndex,
          ])
        : call(rt, "api.setDataValidation", [sr, sc, er, ec, rule, sheetIndex])) as Promise<void>,
    readValidation: (sheetIndex, row, col) =>
      call(rt, "api.getDataValidation", [row, col, sheetIndex]) as
        Promise<ScriptValidationRule | null>,
    // Wave 3 (items 10/11): fill + auto-fit. The host resolves the sheet ref
    // and REFUSES a non-active sheet (the machineries are active-sheet-only),
    // so these delegates stay honest instead of silently retargeting.
    fillRange: (sheetIndex, sr, sc, er, ec, options) =>
      call(rt, "api.fillRange", [sr, sc, er, ec, options, sheetIndex]) as Promise<FillCount>,
    autoFitColumns: (sheet, startCol, endCol) =>
      call(rt, "api.autoFitColumns", [startCol, endCol, sheet]) as Promise<FillCount>,
    autoFitRows: (sheet, startRow, endRow) =>
      call(rt, "api.autoFitRows", [startRow, endRow, sheet]) as Promise<FillCount>,
    // Wave 4 (RANGE-OPS): the range-scoped rows. The rectangle rides in the
    // find/replace OPTIONS (the flat rows take it there); the rest are
    // rectangle-first rows.
    findInRange: (sheet, sr, sc, er, ec, query, options) =>
      call(rt, "api.findAll", [query, {
        ...(options ?? {}),
        sheetIndex: sheet,
        range: { startRow: sr, startCol: sc, endRow: er, endCol: ec },
      }]) as Promise<SheetFindResult>,
    replaceInRange: (sheet, sr, sc, er, ec, search, replacement, options) =>
      call(rt, "api.replaceAll", [search, replacement, {
        ...(options ?? {}),
        sheetIndex: sheet,
        range: { startRow: sr, startCol: sc, endRow: er, endCol: ec },
      }]) as Promise<{ replacementCount: number }>,
    removeDuplicates: (sheet, sr, sc, er, ec, options) =>
      call(rt, "api.removeDuplicates", [sr, sc, er, ec, options, sheet]) as
        Promise<RemoveDuplicatesCount>,
    textToColumns: (sheet, sr, sc, er, ec, options) =>
      call(rt, "api.textToColumns", [sr, sc, er, ec, { ...(options ?? {}), sheetIndex: sheet }]) as
        Promise<TextToColumnsCount>,
    specialCells: (sheet, sr, sc, er, ec, kind) =>
      call(rt, "api.getSpecialCells", [sr, sc, er, ec, kind, sheet]) as
        Promise<SpecialCellsAnswer>,
    goalSeek: (sheet, targetRow, targetCol, targetValue, variableRow, variableCol) =>
      call(rt, "api.goalSeek", [{
        targetRow, targetCol, targetValue, variableRow, variableCol, sheetIndex: sheet,
      }]) as Promise<GoalSeekOutcome>,
    // Wave 4 (SHEETS): outline grouping sugar for range.group()/ungroup().
    // The host asserts the ACTIVE sheet and refuses when the Grouping
    // extension is disabled — the delegate stays honest either way.
    groupRows: (sheet, startRow, endRow) =>
      call(rt, "api.groupRows", [startRow, endRow, sheet]) as Promise<RangeGroupResult>,
    ungroupRows: (sheet, startRow, endRow) =>
      call(rt, "api.ungroupRows", [startRow, endRow, sheet]) as Promise<RangeGroupResult>,
  };
}

/**
 * The own-sheet (`sheet.*`) transport with an explicit sheet NAME carried on
 * every call. Nothing is resolved in the worker: the host resolves the name
 * per call and clamps it by tier — a restricted script is refused for any
 * sheet that is not the active one (RESTRICTED_SHEET_CLAMP_MESSAGE); an
 * unlocked sheet script gets real cross-sheet reach. This is how
 * `sheet.range("Data!A1")` stopped being a silent write to the wrong sheet.
 */
function namedSheetTransport(rt: WorkerRuntime, sheetName: string): RangeTransport {
  return {
    readCell: (row, col) =>
      call(rt, "sheet.getCellValue", [row, col, sheetName]) as Promise<string>,
    writeCell: (row, col, value) =>
      call(rt, "sheet.setCellValue", [row, col, value, sheetName]) as Promise<void>,
    readRange: (sr, sc, er, ec) =>
      call(rt, "sheet.getRangeValues", [sr, sc, er, ec, sheetName]) as Promise<ScriptCell[][]>,
    writeCells: (sr, sc, values) =>
      call(rt, "sheet.setRangeValues", [sr, sc, values, sheetName]) as Promise<void>,
    formatRange: (sr, sc, er, ec, format) =>
      call(rt, "sheet.setRangeFormat", [sr, sc, er, ec, format, sheetName]) as Promise<void>,
    clearFormatRange: (sr, sc, er, ec) =>
      call(rt, "sheet.clearRangeFormat", [sr, sc, er, ec, sheetName]) as Promise<void>,
    readFormats: (sr, sc, er, ec) =>
      call(rt, "sheet.getRangeFormat", [sr, sc, er, ec, sheetName]) as Promise<ScriptCellFormat[][]>,
    // Named-style sugar (Wave 4): unlocked-tier reach (api.* row); the host
    // additionally refuses a non-active sheet.
    applyNamedStyle: (sr, sc, er, ec, name) =>
      call(rt, "api.applyNamedStyle", [name, sr, sc, er, ec, sheetName]) as Promise<void>,
  };
}

/** Object names for an error message: `"Sales", "Costs"` (or "(none)"). */
function objectNamesForError(refs: ScriptObjectRef[]): string {
  if (refs.length === 0) return "(none)";
  return refs.map((r) => `"${r.name}"`).join(", ");
}

/** Find an inventory object by name: exact match first, then a UNIQUE
 *  case-insensitive match — the same rule sheet names resolve by. Null when
 *  nothing (or more than one thing) matches. */
function findObjectByName(refs: ScriptObjectRef[], name: string): ScriptObjectRef | null {
  const exact = refs.find((r) => r.name === name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  const ci = refs.filter((r) => r.name.toLowerCase() === lower);
  return ci.length === 1 ? ci[0] : null;
}

/**
 * A named range's grid rectangle as a sheet-bound ScriptRange, parsed from its
 * refersTo formula ("=Sheet1!$A$1:$B$10"). Sheet resolution mirrors the
 * backend's resolve_named_range_coords: the formula's sheet prefix, else the
 * name's scope sheet, else sheet 0.
 */
async function namedRangeRefToRange(
  wbt: WorkbookTransport,
  ref: ScriptObjectRef,
): Promise<ScriptRange> {
  const refersTo = (ref.refersTo ?? "").trim().replace(/^=/, "");
  const { sheetName, rest } = splitSheetPrefix(refersTo);
  let box: Box;
  try {
    box = parseA1Body(rest);
  } catch {
    throw new Error(
      `Named range "${ref.name}" refers to "${ref.refersTo ?? ""}", which is not a ` +
        `rectangular range this API can address.`,
    );
  }
  const sheetIndex =
    sheetName !== null
      ? resolveSheetName(await wbt.getSheetNames(), sheetName)
      : ref.sheetIndex ?? 0;
  return makeRange(sheetRangeTransport(wbt, sheetIndex), box);
}

/**
 * A table's DATA BODY as a grid-absolute, sheet-bound ScriptRange: the stored
 * rectangle minus its header row (`rowCount` is the inventory's data-row
 * count, so the header-row count is derivable without a second call). This is
 * the Excel meaning of a bare table name — headers excluded.
 */
function tableRefToRange(wbt: WorkbookTransport, ref: ScriptObjectRef): ScriptRange {
  if (!ref.range || ref.sheetIndex === null || ref.sheetIndex === undefined) {
    throw new Error(`Table "${ref.name || ref.id}" has no resolvable range.`);
  }
  const full = parseA1Body(ref.range);
  const span = full.endRow - full.startRow + 1;
  const dataRows = ref.rowCount ?? span;
  const headerRows = Math.min(Math.max(span - dataRows, 0), span - 1);
  return makeRange(sheetRangeTransport(wbt, ref.sheetIndex), {
    startRow: full.startRow + headerRows,
    startCol: full.startCol,
    endRow: full.endRow,
    endCol: full.endCol,
  });
}

/** namedRange(name).toRange(): resolve the name through the object inventory. */
async function namedRangeToRange(rt: WorkerRuntime, name: string): Promise<ScriptRange> {
  const refs = (await call(rt, "api.listObjects", ["namedRange"])) as ScriptObjectRef[];
  const ref = findObjectByName(refs, name);
  if (!ref) {
    throw new Error(
      `No named range called "${name}". Named ranges in this workbook: ${objectNamesForError(refs)}`,
    );
  }
  return namedRangeRefToRange(makeWorkbookTransport(rt), ref);
}

/** table(id).toRange(): resolve the table id through the object inventory. */
async function tableToRange(rt: WorkerRuntime, id: string): Promise<ScriptRange> {
  const refs = (await call(rt, "api.listObjects", ["table"])) as ScriptObjectRef[];
  const ref = refs.find((r) => r.id === id);
  if (!ref) throw new Error(`No table with id "${id}".`);
  return tableRefToRange(makeWorkbookTransport(rt), ref);
}

/**
 * api.range(address) — the top-level range entry (VBA's Range("...")).
 * Resolution order, decided worker-side but enforced host-side per call:
 *  1. an address with a "Sheet!" prefix (bare or 'quoted') is ALWAYS an
 *     address — the prefix resolves exact-then-unique-case-insensitive, and an
 *     unknown name throws listing the workbook's sheets;
 *  2. a plain A1 address binds to the ACTIVE sheet ("A1" is the cell A1,
 *     never a named range — A1-parse wins);
 *  3. a named range (exact name, then unique case-insensitive);
 *  4. a table name — its DATA BODY, headers excluded.
 */
async function resolveTopLevelRange(rt: WorkerRuntime, address: string): Promise<ScriptRange> {
  const wbt = makeWorkbookTransport(rt);
  const { sheetName, rest } = splitSheetPrefix(address);
  if (sheetName !== null) {
    const idx = resolveSheetName(await wbt.getSheetNames(), sheetName);
    return makeRange(sheetRangeTransport(wbt, idx), parseA1Body(rest));
  }
  let box: Box | null = null;
  try {
    box = parseA1Body(address);
  } catch {
    box = null;
  }
  if (box !== null) {
    const [names, active] = await Promise.all([wbt.getSheetNames(), wbt.getActiveSheet()]);
    const idx = active >= 0 && active < names.length ? active : 0;
    return makeRange(sheetRangeTransport(wbt, idx), box);
  }
  // Not an address: named ranges first (Excel precedence), then tables.
  const [namedRanges, tables] = await Promise.all([
    call(rt, "api.listObjects", ["namedRange"]) as Promise<ScriptObjectRef[]>,
    call(rt, "api.listObjects", ["table"]) as Promise<ScriptObjectRef[]>,
  ]);
  const named = findObjectByName(namedRanges, address);
  if (named) return namedRangeRefToRange(wbt, named);
  const table = findObjectByName(tables, address);
  if (table) return tableRefToRange(wbt, table);
  throw new Error(
    `"${address}" is not an A1 address, a named range, or a table in this workbook. ` +
      `Named ranges: ${objectNamesForError(namedRanges)}; tables: ${objectNamesForError(tables)}`,
  );
}

// ---- Conditional formatting (Wave 3 item 3): A1-or-numbers range args ----

/** One CF range, numeric and inclusive (the broker/backend shape). */
interface ScriptCFRangeBox {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** What a script may pass wherever a CF range is expected: an A1 spelling
 *  ("B2:D10") or the numeric box. A1 resolves WORKER-side (Wave-1 style), so
 *  the broker only ever sees numbers. */
type ScriptCFRangeInput = string | ScriptCFRangeBox;

interface ScriptCFSpecInput {
  rule: Record<string, unknown>;
  format: Record<string, unknown>;
  ranges: ScriptCFRangeInput[];
  stopIfTrue?: boolean;
}

interface ScriptCFPatchInput {
  rule?: Record<string, unknown>;
  format?: Record<string, unknown>;
  ranges?: ScriptCFRangeInput[];
  stopIfTrue?: boolean;
  enabled?: boolean;
}

/**
 * Resolve one A1-or-numbers CF range worker-side. A "Sheet!" prefix is REFUSED
 * rather than silently dropped: the CF backend is ACTIVE-SHEET scoped, so an
 * address naming another sheet would otherwise land somewhere the author did
 * not say. Non-string, non-conforming input passes through untouched so the
 * BROKER's validator produces the canonical error message.
 */
function resolveCFRange(input: unknown): unknown {
  if (typeof input !== "string") return input;
  const { sheetName, rest } = splitSheetPrefix(input);
  if (sheetName !== null) {
    throw new Error(
      `Conditional formats are active-sheet scoped: drop the "${sheetName}!" prefix ` +
        `and call api.setActiveSheet(${JSON.stringify(sheetName)}) first`,
    );
  }
  return parseA1Body(rest);
}

function resolveCFRanges(ranges: unknown): unknown {
  return Array.isArray(ranges) ? ranges.map(resolveCFRange) : ranges;
}

function resolveCFSpec(spec: ScriptCFSpecInput): unknown {
  if (typeof spec !== "object" || spec === null) return spec;
  const out: Record<string, unknown> = { ...spec };
  if ("ranges" in out) out.ranges = resolveCFRanges(out.ranges);
  return out;
}

// ---- The APPLICATION cluster (Wave 4): view/window state shapes ----

/** The View settings api.getViewOption / setViewOption address by name. */
type ScriptViewOptionNameShim = "gridlines" | "headings" | "zeros" | "formulas" | "viewMode";

/** The three view modes Core renders. */
type ScriptViewModeShim = "normal" | "pageLayout" | "pageBreakPreview";

/** What api.getPanes answers: both halves of View ▸ Window in one read. */
interface ScriptPanesShim {
  freezeRow: number | null;
  freezeCol: number | null;
  splitRow: number | null;
  splitCol: number | null;
}

/** One named cell style as api.listNamedStyles / createNamedStyle report it. */
interface ScriptNamedStyleShim {
  name: string;
  builtIn: boolean;
  category: string;
}

/** What api.getThemePalette answers: the document theme's 12 slot colors
 *  resolved to hex, plus its font pair. */
interface ScriptThemePaletteShim {
  name: string;
  colors: Record<string, string>;
  fonts: { heading: string; body: string };
}

// ---- Unlocked API shim ----

function buildUnlockedShim(rt: WorkerRuntime): Record<string, unknown> {
  const workbookTransport = makeWorkbookTransport(rt);
  return {
    getCellValue: (row: number, col: number) => call(rt, "api.getCellValue", [row, col]),
    // The optional sheet ref (index or NAME) must be FORWARDED, not dropped:
    // this arrow's arity used to be 3, so `api.setCellValue(r, c, v, "Sheet2")`
    // silently wrote the ACTIVE sheet (caught live by vba-idioms-wave1.spec.ts).
    setCellValue: (row: number, col: number, value: ScriptCellValue, sheet?: SheetRef) =>
      call(rt, "api.setCellValue", [row, col, value, sheet]),
    updateCellsBatch: (updates: unknown[]) => call(rt, "api.updateCellsBatch", [updates]),
    // Typed reads: value + type + formula, so a read/modify/write round-trip
    // cannot silently replace a formula with its display text.
    getCellData: (row: number, col: number, sheet?: SheetRef) =>
      call(rt, "api.getCellData", [row, col, sheet]),
    getRangeValues: (startRow: number, startCol: number, endRow: number, endCol: number, sheet?: SheetRef) =>
      call(rt, "api.getRangeValues", [startRow, startCol, endRow, endCol, sheet]),
    getSheetNames: () => call(rt, "api.getSheetNames", []),
    getActiveSheet: () => call(rt, "api.getActiveSheet", []),
    setActiveSheet: (sheet: SheetRef) => call(rt, "api.setActiveSheet", [sheet]),
    // Top-level range entry (VBA Range("...")): "Data!A1:B5", "'My Sheet'!A1",
    // plain A1 on the active sheet, a named range, or a table's data body.
    // A1-parse wins over names; see resolveTopLevelRange for the order.
    range: (address: string): Promise<ScriptRange> => resolveTopLevelRange(rt, address),
    // Canonical Workbook -> Sheet -> Range navigation (C3 step 3), plus the
    // FILE LIFECYCLE (G1) of the document this script lives in.
    //
    // The lifecycle members are spread onto the navigation facet rather than
    // built into makeWorkbook(): navigation is a pure transport-driven model
    // shared with extensions, while save/saveAs are broker calls with their own
    // policy rows, rate limit and consent text. Keeping them here means the
    // canonical model gains no notion of files at all.
    //
    // There is no open(), close() or new(): Calcula holds ONE document, so each
    // of those would replace or discard the workbook the user is looking at, and
    // a picker click meaning "open this file" is not consent for "let this
    // running script read this file". See the allowlist comment on
    // api.workbookSave.
    workbook: {
      ...makeWorkbook(workbookTransport),
      /** Save back to the file this workbook came from. Rejects if it has never
       *  been saved (use saveAs), if this script saved less than 5 seconds ago,
       *  or if called from inside an onBeforeSave handler. Resolves
       *  `{ saved: false, name: null }` when a Before-Save handler vetoed. */
      save: () => call(rt, "api.workbookSave", []) as Promise<ScriptSaveResultShim>,
      /** Ask the user where to save a copy. Resolves `{ saved: false }` if they
       *  cancel the picker (or decline the .xlsx loss report). */
      saveAs: () => call(rt, "api.workbookSaveAs", []) as Promise<ScriptSaveResultShim>,
      /** Whether this workbook has unsaved changes. */
      isDirty: () => call(rt, "api.workbookIsDirty", []) as Promise<boolean>,
      /** This workbook's file NAME (never its folder); null if never saved. */
      fileName: () => call(rt, "api.workbookFileName", []) as Promise<string | null>,
    },
    emitEvent: (name: string, detail?: unknown) => callFire(rt, "api.emitEvent", [name, detail]),
    onEvent(name: string, handler: (detail: unknown) => void): CleanupFn {
      const cleanup = registerHook(rt, `event:${name}`, handler);
      callFire(rt, "events.subscribe", [name]);
      return cleanup;
    },
    executeCommand: (commandId: string, args?: unknown) => callFire(rt, "api.executeCommand", [commandId, args]),
    // { deferRepaint: true } pauses screen repaints for the LIFE OF THE BATCH
    // (the honest ScreenUpdating): one refresh fires at commit/cancel, and the
    // host unfreezes on fault/unmount too — a dead script cannot pin a frozen
    // canvas.
    beginBatch: (description: string, options?: { deferRepaint?: boolean }) =>
      call(rt, "api.beginBatch", [description, options]),
    commitBatch: () => call(rt, "api.commitBatch", []),
    cancelBatch: () => call(rt, "api.cancelBatch", []),

    // ---- the APPLICATION cluster (Wave 4) ----
    /** Show a message in the status bar (VBA's Application.StatusBar); null
     *  restores "Ready". Cleared automatically when this script stops. */
    setStatusBar: (text: string | null) =>
      call(rt, "api.setStatusBar", [text]) as Promise<void>,
    /** Run a recorded macro by display name or module id (VBA's
     *  Application.Run). Resolves with the macro's name; rejects when it does
     *  not exist, fails, or is already running (re-entrancy is refused). */
    runMacro: (name: string) => call(rt, "api.runMacro", [name]) as Promise<{ name: string }>,
    /** The Windows user name (VBA's Application.UserName) — the same display
     *  name Calcula attaches to writeback submissions. */
    userName: () => call(rt, "api.userName", []) as Promise<string>,
    /** Read one View setting: the four booleans, or the view mode word. */
    getViewOption: (name: ScriptViewOptionNameShim) =>
      call(rt, "api.getViewOption", [name]) as Promise<boolean | ScriptViewModeShim>,
    /** Change one View setting — the same mechanism as the View menu. */
    setViewOption: (name: ScriptViewOptionNameShim, value: boolean | ScriptViewModeShim) =>
      call(rt, "api.setViewOption", [name, value]) as Promise<void>,
    /** The zoom level, in PERCENT (100 = 100%). */
    getZoom: () => call(rt, "api.getZoom", []) as Promise<number>,
    /** Zoom the grid, in PERCENT (10-400). */
    setZoom: (percent: number) => call(rt, "api.setZoom", [percent]) as Promise<void>,
    /** The frozen rows/columns and window split currently in effect — the read
     *  half of freezePanes/splitPanes. */
    getPanes: () => call(rt, "api.getPanes", []) as Promise<ScriptPanesShim>,
    /**
     * Pause this script for `ms` milliseconds (VBA's Application.Wait, without
     * the frozen UI — the app keeps running; only YOUR code waits).
     *
     * WORKER-LOCAL: no broker call, nothing to consent to, and the pause dies
     * with the script — it is IN-SESSION ONLY. Anything that must survive a
     * reload (or fire while this script is not running) is caps.schedule's
     * business, which persists in the workbook. Bounded to 30s per call (the
     * same ceiling every broker call has) so a stray sleep(1e9) cannot park a
     * handler forever; the timer counts against the worker's shared timer cap.
     */
    sleep: (ms: number): Promise<void> => {
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
        return Promise.reject(
          new Error("sleep(ms): ms must be a non-negative finite number of milliseconds"),
        );
      }
      const bounded = Math.min(ms, MAX_SLEEP_MS);
      return new Promise((resolve) => setTimeout(resolve, bounded));
    },

    // ---- Formatting (B2) ----
    setRangeFormat: (
      startRow: number, startCol: number, endRow: number, endCol: number,
      format: ScriptFormat, sheet?: SheetRef,
    ) => call(rt, "api.setRangeFormat", [startRow, startCol, endRow, endCol, format, sheet]),
    clearRangeFormat: (
      startRow: number, startCol: number, endRow: number, endCol: number, sheet?: SheetRef,
    ) => call(rt, "api.clearRangeFormat", [startRow, startCol, endRow, endCol, sheet]),
    // ---- Format read-back (Wave 3, item 1) ----
    getRangeFormat: (
      startRow: number, startCol: number, endRow: number, endCol: number, sheet?: SheetRef,
    ) => call(rt, "api.getRangeFormat", [startRow, startCol, endRow, endCol, sheet]) as
      Promise<ScriptCellFormat[][]>,
    getCellFormat: (row: number, col: number, sheet?: SheetRef) =>
      call(rt, "api.getCellFormat", [row, col, sheet]) as Promise<ScriptCellFormat>,

    // ---- Named cell styles + theme palette (Wave 4) ----
    /** The workbook's named cell styles — built-in ("Good", "Heading 1", ...)
     *  and custom — with each one's category. */
    listNamedStyles: () =>
      call(rt, "api.listNamedStyles", []) as Promise<ScriptNamedStyleShim[]>,
    /** Apply a named style to a block of cells (one undo step). ACTIVE sheet
     *  only — the sheet ref is refused if it names another sheet. */
    applyNamedStyle: (
      name: string, startRow: number, startCol: number, endRow: number, endCol: number,
      sheet?: SheetRef,
    ) => call(rt, "api.applyNamedStyle", [name, startRow, startCol, endRow, endCol, sheet]) as
      Promise<void>,
    /** Create a custom named style from a format description (the same
     *  vocabulary setRangeFormat takes, minus the range-edge border keys and
     *  the protection attributes). */
    createNamedStyle: (name: string, format: ScriptFormat) =>
      call(rt, "api.createNamedStyle", [name, format]) as Promise<ScriptNamedStyleShim>,
    /** Delete a CUSTOM named style (built-ins are refused; already-styled
     *  cells keep their look). */
    deleteNamedStyle: (name: string) =>
      call(rt, "api.deleteNamedStyle", [name]) as Promise<void>,
    /** The document theme: its 12 named colors resolved to hex, and the
     *  heading/body font pair. */
    getThemePalette: () =>
      call(rt, "api.getThemePalette", []) as Promise<ScriptThemePaletteShim>,

    // ---- Calculation control (Wave 3, item 7) ----
    getCalculationMode: () =>
      call(rt, "api.getCalculationMode", []) as Promise<"automatic" | "manual">,
    /**
     * If your script sets "manual" and then stops for any reason (unmount, a
     * fault, being stopped mid-session, workbook swap), the host restores
     * "automatic" — a dead script can never leave the workbook uncalculating.
     */
    setCalculationMode: (mode: "automatic" | "manual") =>
      call(rt, "api.setCalculationMode", [mode]) as Promise<"automatic" | "manual">,
    recalculate: (options?: { full?: boolean }) =>
      call(rt, "api.recalculate", [options]) as Promise<{ cellsUpdated: number }>,

    // ---- Sheet protection (Wave 3, item 8) ----
    protectSheet: (
      options?: Record<string, unknown>, sheet?: SheetRef,
    ) => call(rt, "api.protectSheet", [options, sheet]) as
      Promise<{ protected: true; hasPassword: boolean }>,
    unprotectSheet: (password?: string, sheet?: SheetRef) =>
      call(rt, "api.unprotectSheet", [password, sheet]) as Promise<boolean>,
    getProtectionStatus: (sheet?: SheetRef) =>
      call(rt, "api.getProtectionStatus", [sheet]) as Promise<{
        protected: boolean;
        hasPassword: boolean;
        options: Record<string, boolean>;
      }>,

    // ---- Structure (B2) ----
    insertRows: (startRow: number, count: number, sheet?: SheetRef) =>
      call(rt, "api.insertRows", [startRow, count, sheet]),
    deleteRows: (startRow: number, count: number, sheet?: SheetRef) =>
      call(rt, "api.deleteRows", [startRow, count, sheet]),
    insertColumns: (startCol: number, count: number, sheet?: SheetRef) =>
      call(rt, "api.insertColumns", [startCol, count, sheet]),
    deleteColumns: (startCol: number, count: number, sheet?: SheetRef) =>
      call(rt, "api.deleteColumns", [startCol, count, sheet]),
    mergeCells: (
      startRow: number, startCol: number, endRow: number, endCol: number, sheet?: SheetRef,
    ) => call(rt, "api.mergeCells", [startRow, startCol, endRow, endCol, sheet]),
    unmergeCells: (row: number, col: number, sheet?: SheetRef) =>
      call(rt, "api.unmergeCells", [row, col, sheet]),
    setRowHeight: (row: number, height: number, sheet?: SheetRef) =>
      call(rt, "api.setRowHeight", [row, height, sheet]),
    setColumnWidth: (col: number, width: number, sheet?: SheetRef) =>
      call(rt, "api.setColumnWidth", [col, width, sheet]),
    // ---- Auto-fit (Wave 3, item 11): the double-click best-fit, scripted.
    //      ACTIVE SHEET only (measurement is canvas metrics over the rendered
    //      sheet) — a sheet ref naming another sheet is refused host-side.
    autoFitColumns: (startCol: number, endCol: number, sheet?: SheetRef) =>
      call(rt, "api.autoFitColumns", [startCol, endCol, sheet]) as Promise<FillCount>,
    autoFitRows: (startRow: number, endRow: number, sheet?: SheetRef) =>
      call(rt, "api.autoFitRows", [startRow, endRow, sheet]) as Promise<FillCount>,
    freezePanes: (freezeRow: number | null, freezeCol: number | null) =>
      call(rt, "api.freezePanes", [freezeRow, freezeCol]),
    /** The other half of View ▸ Window (G4): scrollable panes, not frozen ones. */
    splitPanes: (splitRow: number | null, splitCol: number | null) =>
      call(rt, "api.splitPanes", [splitRow, splitCol]),

    // ---- Page setup + print layout (Wave 4) ----
    // VBA's Worksheet.PageSetup, ACTIVE SHEET only (the backend it drives is);
    // a sheet ref naming another sheet is refused host-side, never redirected.
    // Printing itself stays where it was: caps.file.exportPdf and the user's
    // own File menu.
    /** The active sheet's full page setup, as the Page Setup dialog shows it. */
    getPageSetup: (sheet?: SheetRef) =>
      call(rt, "api.getPageSetup", [sheet]) as Promise<ScriptPageSetupShim>,
    /** Patch the active sheet's page setup — only the properties named change
     *  (setRangeFormat's partial-write contract, applied to the page). */
    setPageSetup: (patch: Partial<ScriptPageSetupShim>, sheet?: SheetRef) =>
      call(rt, "api.setPageSetup", [patch, sheet]) as Promise<void>,
    /** Set which rectangle the active sheet prints; resolves to its A1 form. */
    setPrintArea: (
      startRow: number, startCol: number, endRow: number, endCol: number, sheet?: SheetRef,
    ) => call(rt, "api.setPrintArea", [startRow, startCol, endRow, endCol, sheet]) as
      Promise<{ area: string }>,
    /** Remove the active sheet's print area (the whole sheet prints again). */
    clearPrintArea: (sheet?: SheetRef) =>
      call(rt, "api.clearPrintArea", [sheet]) as Promise<void>,
    /** Insert a manual page break ABOVE a row / LEFT of a column (index >= 1). */
    addPageBreak: (kind: "row" | "col", index: number, sheet?: SheetRef) =>
      call(rt, "api.addPageBreak", [kind, index, sheet]) as Promise<void>,
    /** Remove a manual page break. */
    removePageBreak: (kind: "row" | "col", index: number, sheet?: SheetRef) =>
      call(rt, "api.removePageBreak", [kind, index, sheet]) as Promise<void>,
    /** Remove every manual page break on the active sheet. */
    resetPageBreaks: (sheet?: SheetRef) =>
      call(rt, "api.resetPageBreaks", [sheet]) as Promise<void>,

    // ---- Outline grouping (Wave 4) ----
    // Excel's Data ▸ Group/Ungroup, ACTIVE SHEET only, driven through the
    // Grouping feature so the outline bar and hidden rows stay in step —
    // with the feature disabled these REJECT rather than grouping invisibly.
    // Spans are 0-based and INCLUSIVE.
    groupRows: (startRow: number, endRow: number, sheet?: SheetRef) =>
      call(rt, "api.groupRows", [startRow, endRow, sheet]) as Promise<RangeGroupResult>,
    ungroupRows: (startRow: number, endRow: number, sheet?: SheetRef) =>
      call(rt, "api.ungroupRows", [startRow, endRow, sheet]) as Promise<RangeGroupResult>,
    groupColumns: (startCol: number, endCol: number, sheet?: SheetRef) =>
      call(rt, "api.groupColumns", [startCol, endCol, sheet]) as Promise<RangeGroupResult>,
    ungroupColumns: (startCol: number, endCol: number, sheet?: SheetRef) =>
      call(rt, "api.ungroupColumns", [startCol, endCol, sheet]) as Promise<RangeGroupResult>,
    /** Collapse/expand to an outline depth — the little 1/2/3 buttons. Pass
     *  null to leave an axis alone. */
    showOutlineLevel: (rowLevel: number | null, colLevel: number | null) =>
      call(rt, "api.showOutlineLevel", [rowLevel, colLevel]) as Promise<RangeGroupResult>,

    // ---- Sheet CRUD (B2; positioning Wave 4) ----
    /** Add a sheet (and make it active). `position` places it before/after an
     *  existing sheet (VBA's Add Before:=/After:=); omitted = at the end. */
    addSheet: (name?: string, position?: ScriptSheetPositionShim) =>
      call(rt, "api.addSheet", [name, position]),
    deleteSheet: (sheet: SheetRef) => call(rt, "api.deleteSheet", [sheet]),
    renameSheet: (sheet: SheetRef, newName: string) => call(rt, "api.renameSheet", [sheet, newName]),
    setSheetVisibility: (sheet: SheetRef, visibility: "visible" | "hidden" | "veryHidden") =>
      call(rt, "api.setSheetVisibility", [sheet, visibility]),
    // ---- Sheet move / copy (G4; positioning Wave 4) ----
    // Both RENUMBER other sheets, so any index a script is holding is stale
    // afterwards. That is stated on the authoring surface rather than papered
    // over — there is no stable sheet handle to hand back instead.
    moveSheet: (fromSheet: SheetRef, toIndex: number) =>
      call(rt, "api.moveSheet", [fromSheet, toIndex]),
    /** Duplicate a sheet. `position` places the copy before/after an existing
     *  sheet; omitted = immediately after its source. */
    copySheet: (sourceSheet: SheetRef, newName?: string, position?: ScriptSheetPositionShim) =>
      call(rt, "api.copySheet", [sourceSheet, newName, position]) as
        Promise<{ index: number; name: string }>,

    // ---- Sort + find/replace (B2) ----
    sortRange: (
      startRow: number, startCol: number, endRow: number, endCol: number,
      fields: ScriptSortField[], options?: ScriptSortOptions, sheet?: SheetRef,
    ) => call(rt, "api.sortRange", [startRow, startCol, endRow, endCol, fields, options, sheet]),
    // ---- Range ops (Wave 4, RANGE-OPS cluster) ----
    /** Remove duplicate rows from a rectangle (Data ▸ Remove Duplicates):
     *  a row whose key columns repeat an earlier row is deleted and the
     *  survivors close up — one undo step. `options.columns` are offsets from
     *  the range start; omitted = every column. ACTIVE SHEET only. */
    removeDuplicates: (
      startRow: number, startCol: number, endRow: number, endCol: number,
      options?: ScriptRemoveDuplicatesOptions, sheet?: SheetRef,
    ) => call(rt, "api.removeDuplicates", [startRow, startCol, endRow, endCol, options, sheet]) as
      Promise<RemoveDuplicatesCount>,
    /** Split ONE COLUMN of text into columns by delimiters (Data ▸ Text to
     *  Columns), writing at `options.destination` (default: in place). ACTIVE
     *  SHEET only, refused otherwise. */
    textToColumns: (
      startRow: number, startCol: number, endRow: number, endCol: number,
      options?: ScriptTextToColumnsOptions,
    ) => call(rt, "api.textToColumns", [startRow, startCol, endRow, endCol, options]) as
      Promise<TextToColumnsCount>,
    /** Goal Seek (single-variable solver): drive the variable cell until the
     *  target formula cell evaluates to `targetValue`. ACTIVE SHEET only. */
    goalSeek: (params: ScriptGoalSeekParams) =>
      call(rt, "api.goalSeek", [params]) as Promise<GoalSeekOutcome>,
    // ---- the WorksheetFunction bridge (G4) ----
    // `evaluate` answers ONE expression, `evaluateAll` a batch in one round
    // trip; both go through the same broker method, so there is one policy row
    // and one consent line for the pair.
    async evaluate(expression: string, options?: ScriptEvaluateOptions) {
      const [result] = (await call(rt, "api.evaluate", [
        [expression],
        options,
      ])) as ScriptEvaluatedValue[];
      return result;
    },
    evaluateAll: (expressions: string[], options?: ScriptEvaluateOptions) =>
      call(rt, "api.evaluate", [expressions, options]) as Promise<ScriptEvaluatedValue[]>,

    // ---- explicit formula read/write, A1 or R1C1 (G4) ----
    getCellFormula: (row: number, col: number, options?: ScriptFormulaOptions) =>
      call(rt, "api.getCellFormula", [row, col, options]) as Promise<string | null>,
    setCellFormula: (
      row: number, col: number, formula: string | null, options?: ScriptFormulaOptions,
    ) => call(rt, "api.setCellFormula", [row, col, formula, options]) as Promise<void>,

    // ---- copy / paste / paste special (G4) ----
    // The clipboard behind these is THIS SCRIPT'S OWN: host-side, per script,
    // gone when the script stops. It is not the Windows clipboard and not the
    // one your Ctrl+V reads — a script can neither see what you copied nor take
    // it away from you.
    copyRange: (
      startRow: number, startCol: number, endRow: number, endCol: number, sheet?: SheetRef,
    ) => call(rt, "api.copyRange", [startRow, startCol, endRow, endCol, sheet]) as
      Promise<ScriptClipboardSize>,
    paste: (row: number, col: number, options?: ScriptPasteOptions) =>
      call(rt, "api.pasteRange", [row, col, options]) as Promise<ScriptClipboardSize>,
    /** `paste` with an explicit mode — the PasteSpecial spelling. */
    pasteSpecial: (row: number, col: number, options: ScriptPasteOptions) =>
      call(rt, "api.pasteRange", [row, col, options]) as Promise<ScriptClipboardSize>,

    // ---- fill / AutoFill (Wave 3, item 10) ----
    // The fill-handle's own machinery (same series inference, same formula
    // shifting, same merge replication). The rectangle is SOURCE + TARGET
    // together: the band of `sourceSize` (default 1) rows/columns at the edge
    // the fill starts from seeds the rest — Excel's FillDown shape. ACTIVE
    // SHEET only, refused otherwise.
    fillRange: (
      startRow: number, startCol: number, endRow: number, endCol: number,
      options?: ScriptFillOptions, sheet?: SheetRef,
    ) => call(rt, "api.fillRange", [startRow, startCol, endRow, endCol, options, sheet]) as
      Promise<FillCount>,

    // ---- pure text helpers (Wave 3, item 9) ----
    // Worker-LOCAL compute: no broker row, no round trip, nothing to consent
    // to — parsing a string a script already holds discloses nothing new.
    // Semantics are pinned to the Rust QuickJS twin (Calcula.text in
    // core/script-engine/src/ops/text.rs) by shared fixtures. Async only for
    // surface uniformity (every api.* member answers with a Promise); the
    // work itself never leaves the worker.
    text: {
      parseCsv: async (content: string, options?: ScriptParseCsvOptions): Promise<ScriptParseCsvResult> =>
        scriptParseCsv(content, options),
      toCsv: async (
        rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>,
        options?: ScriptToCsvOptions,
      ): Promise<string> => scriptToCsv(rows, options),
    },

    // ---- column filtering / AutoFilter (G4) ----
    // Grouped under `api.filter.*` because six flat methods called
    // autoFilterSomething would crowd the surface, and because the grouping is
    // exactly one thing: the filter on the ACTIVE SHEET. Column indexes are
    // RELATIVE to the filter's first column, the same way the backend and the
    // dropdown address them.
    filter: {
      get: () => call(rt, "api.autoFilterGet", []) as Promise<ScriptAutoFilter | null>,
      listValues: (columnIndex: number) =>
        call(rt, "api.autoFilterListValues", [columnIndex]) as Promise<ScriptAutoFilterValues>,
      apply: (startRow: number, startCol: number, endRow: number, endCol: number) =>
        call(rt, "api.autoFilterApply", [startRow, startCol, endRow, endCol]) as
          Promise<ScriptAutoFilter>,
      setColumn: (columnIndex: number, criteria: ScriptAutoFilterCriteria) =>
        call(rt, "api.autoFilterSetColumn", [columnIndex, criteria]) as Promise<ScriptAutoFilter>,
      clear: (columnIndex?: number | null) =>
        call(rt, "api.autoFilterClear", [columnIndex ?? null]) as Promise<ScriptAutoFilter>,
      remove: () => call(rt, "api.autoFilterRemove", []) as Promise<void>,
    },

    // ---- Selection + navigation (Wave 2) ----
    // VBA's Selection / ActiveCell / Range.Select / Application.Goto.
    /** The raw selection snapshot: coordinates + every area; null when nothing
     *  is selected. */
    getSelection: () => call(rt, "api.getSelection", []) as Promise<ScriptSelection | null>,
    /** The primary selected area as a live ScriptRange (offset/resize/
     *  setValues/format all work), bound to the selection's own sheet. */
    async selection(): Promise<ScriptRange | null> {
      const sel = (await call(rt, "api.getSelection", [])) as ScriptSelection | null;
      if (!sel) return null;
      return makeRange(sheetRangeTransport(workbookTransport, sel.sheetIndex), {
        startRow: sel.startRow,
        startCol: sel.startCol,
        endRow: sel.endRow,
        endCol: sel.endCol,
      });
    },
    /** The active cell as a single-cell ScriptRange (VBA's ActiveCell). */
    async activeCell(): Promise<ScriptRange | null> {
      const sel = (await call(rt, "api.getSelection", [])) as ScriptSelection | null;
      if (!sel) return null;
      return makeRange(sheetRangeTransport(workbookTransport, sel.sheetIndex), {
        startRow: sel.activeRow,
        startCol: sel.activeCol,
        endRow: sel.activeRow,
        endCol: sel.activeCol,
      });
    },
    /**
     * Select cells. Polymorphic:
     *   select(startRow, startCol, endRow?, endCol?, options?)  — numbers
     *   select("A1:B5", options?) / select("Data!A1", options?) — an address
     * The STRING form resolves worker-side to numbers (+ a sheet ref carried in
     * options), so the broker only ever sees the numeric shape; the sheet name
     * itself still resolves host-side against the live list (Wave 1 rules).
     */
    select(
      target: number | string,
      startColOrOptions?: number | ScriptSelectOptions,
      endRow?: number | ScriptSelectOptions,
      endCol?: number,
      options?: ScriptSelectOptions,
    ): Promise<void> {
      if (typeof target === "string") {
        const opts = startColOrOptions as ScriptSelectOptions | undefined;
        if (opts !== undefined && (typeof opts !== "object" || opts === null || Array.isArray(opts))) {
          throw new Error("select(address, options?): options must be an object");
        }
        const { sheetName, rest } = splitSheetPrefix(target);
        const box = parseA1Body(rest);
        const merged: ScriptSelectOptions = { ...(opts ?? {}) };
        // An explicit "Sheet!" prefix IS the sheet — it wins over options.
        if (sheetName !== null) merged.sheetIndex = sheetName;
        return call(rt, "api.select", [
          box.startRow, box.startCol, box.endRow, box.endCol, merged,
        ]) as Promise<void>;
      }
      // Numeric form. select(r, c, { ... }) is accepted as a convenience:
      // an object in the endRow slot is the options bag.
      if (typeof endRow === "object" && endRow !== null) {
        return call(rt, "api.select", [
          target, startColOrOptions, undefined, undefined, endRow,
        ]) as Promise<void>;
      }
      return call(rt, "api.select", [
        target, startColOrOptions, endRow, endCol, options,
      ]) as Promise<void>;
    },
    /** Scroll a cell into view WITHOUT changing the selection. */
    scrollTo: (row: number, col: number, sheet?: SheetRef) =>
      call(rt, "api.scrollTo", [row, col, sheet]) as Promise<void>,
    /** Clear a rectangle: everything (default), contents only, or formats only
     *  — one undo step, on any sheet (Wave-1 rules; Wave 3 closed the
     *  active-sheet residual). */
    clearRange: (
      startRow: number, startCol: number, endRow: number, endCol: number,
      options?: ScriptClearOptions, sheet?: SheetRef,
    ) => call(rt, "api.clearRange", [startRow, startCol, endRow, endCol, options, sheet]) as
      Promise<{ count: number }>,
    /** Every sheet with its visibility and tab colour (getSheetNames keeps
     *  only the names). */
    getSheets: () => call(rt, "api.getSheets", []) as Promise<ScriptSheetInfo[]>,
    /** Change (or remove, with null) a sheet's tab colour. */
    setTabColor: (sheet: SheetRef, color: string | null) =>
      call(rt, "api.setTabColor", [sheet, color]) as Promise<void>,
    // ---- Range discovery (Wave 2): Range.End / CurrentRegion / UsedRange ----
    /** Where Ctrl+Arrow would land from (row, col) — a pure read, nothing moves. */
    getRangeEdge: (row: number, col: number, direction: EdgeDirection, sheet?: SheetRef) =>
      call(rt, "api.getRangeEdge", [row, col, direction, sheet]) as Promise<CellPoint>,
    /** The contiguous data block around (row, col) — what Ctrl+A would select. */
    getCurrentRegion: (row: number, col: number, sheet?: SheetRef) =>
      call(rt, "api.getCurrentRegion", [row, col, sheet]) as Promise<RegionResult>,
    /** The bounding box of everything stored on a sheet. */
    getUsedRange: (sheet?: SheetRef) =>
      call(rt, "api.getUsedRange", [sheet]) as Promise<RegionResult>,
    /** The cells of one class inside a rectangle — Excel's Go To Special
     *  (Range.SpecialCells). "visible" answers what survives AutoFilter /
     *  advanced-filter / outline hiding, which is the "copy visible cells
     *  after filtering" primitive (Wave 4). */
    getSpecialCells: (
      startRow: number, startCol: number, endRow: number, endCol: number,
      kind: SpecialCellsKind, sheet?: SheetRef,
    ) => call(rt, "api.getSpecialCells", [startRow, startCol, endRow, endCol, kind, sheet]) as
      Promise<SpecialCellsAnswer>,

    findAll: (query: string, options?: ScriptFindOptions) =>
      call(rt, "api.findAll", [query, options]),
    replaceAll: (
      search: string, replacement: string,
      options?: ScriptReplaceOptions,
    ) => call(rt, "api.replaceAll", [search, replacement, options]),

    // ---- Data validation (Wave 3, item 5) ----
    /** Set a data-validation rule on a rectangle (any sheet — Wave-1 rules). */
    setDataValidation: (
      startRow: number, startCol: number, endRow: number, endCol: number,
      rule: ScriptValidationRule, sheet?: SheetRef,
    ) => call(rt, "api.setDataValidation", [startRow, startCol, endRow, endCol, rule, sheet]) as
      Promise<void>,
    /** Remove the data-validation rules from a rectangle. */
    clearDataValidation: (range: Box, sheet?: SheetRef) =>
      call(rt, "api.clearDataValidation", [range, sheet]) as Promise<void>,
    /** The rule on one cell, in setDataValidation's shape; null when none. */
    getDataValidation: (row: number, col: number, sheet?: SheetRef) =>
      call(rt, "api.getDataValidation", [row, col, sheet]) as
        Promise<ScriptValidationRule | null>,
    /** Every rule on a sheet, with the rectangle each one covers. */
    listDataValidations: (sheet?: SheetRef) =>
      call(rt, "api.listDataValidations", [sheet]) as Promise<ScriptValidationRangeInfoShim[]>,

    // ---- Hyperlinks (Wave 3, item 6) ----
    // Attach / read / remove only — there is deliberately NO follow: internal
    // navigation is api.select / api.scrollTo, and opening an external target
    // is the user's click, never a script's.
    /** Attach a hyperlink to a cell; resolves to the link as stored. */
    addHyperlink: (
      row: number, col: number, link: ScriptHyperlinkSpecShim,
      options?: ScriptHyperlinkOptionsShim, sheet?: SheetRef,
    ) => call(rt, "api.addHyperlink", [row, col, link, options, sheet]) as
      Promise<ScriptHyperlinkShim>,
    /** Remove the hyperlink from a cell. Resolves false when there was none
     *  (the cell is in the state you asked for); real refusals reject. */
    removeHyperlink: (row: number, col: number, sheet?: SheetRef) =>
      call(rt, "api.removeHyperlink", [row, col, sheet]) as Promise<boolean>,
    /** The hyperlink on one cell; null when it has none. */
    getHyperlink: (row: number, col: number, sheet?: SheetRef) =>
      call(rt, "api.getHyperlink", [row, col, sheet]) as Promise<ScriptHyperlinkShim | null>,
    /** Every hyperlink on a sheet. */
    listHyperlinks: (sheet?: SheetRef) =>
      call(rt, "api.listHyperlinks", [sheet]) as Promise<ScriptHyperlinkShim[]>,

    // ---- Notes + comments (Wave 4) ----
    // Notes are the one-text-per-cell kind (VBA Range.NoteText); comments are
    // the threaded kind. The notes backend addresses THE ACTIVE SHEET — a
    // named other sheet is refused with the fix spelled out. listComments
    // alone is sheet-addressable.
    /** Set, replace or (with null) remove the note on a cell. Resolves to the
     *  note's id, or null after a removal. */
    setNote: (row: number, col: number, text: string | null, sheet?: SheetRef) =>
      call(rt, "api.setNote", [row, col, text, sheet]) as Promise<{ id: string } | null>,
    /** The note text on one cell; null when it has none. */
    getNote: (row: number, col: number, sheet?: SheetRef) =>
      call(rt, "api.getNote", [row, col, sheet]) as Promise<string | null>,
    /** Every note on the active sheet. */
    listNotes: (sheet?: SheetRef) =>
      call(rt, "api.listNotes", [sheet]) as
        Promise<Array<{ row: number; col: number; text: string; author: string }>>,
    /** Start a threaded comment on a cell; resolves to the thread's id. */
    addComment: (row: number, col: number, text: string) =>
      call(rt, "api.addComment", [row, col, text]) as Promise<{ id: string }>,
    /** Reply to a comment thread; resolves to the reply's id. */
    replyToComment: (commentId: string, text: string) =>
      call(rt, "api.replyToComment", [commentId, text]) as Promise<{ id: string }>,
    /** Mark a thread resolved (default) or reopen it with `false`. */
    resolveComment: (commentId: string, resolved?: boolean) =>
      call(rt, "api.resolveComment", [commentId, resolved]) as Promise<void>,
    /** Delete a comment thread and all its replies. */
    deleteComment: (commentId: string) =>
      call(rt, "api.deleteComment", [commentId]) as Promise<void>,
    /** The comment threads on a sheet, optionally only inside a rectangle. */
    listComments: (
      range?: { startRow: number; startCol: number; endRow: number; endCol: number } | null,
      sheet?: SheetRef,
    ) =>
      call(rt, "api.listComments", [range, sheet]) as Promise<Array<{
        id: string; row: number; col: number; text: string; author: string;
        resolved: boolean; replies: Array<{ id: string; text: string; author: string }>;
      }>>,

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
      options?: { sheetIndex?: SheetRef | null; comment?: string },
    ) => call(rt, "api.createNamedRange", [name, refersTo, options]),
    deleteNamedRange: (name: string) => call(rt, "api.deleteNamedRange", [name]),
    createPivot: (
      sourceRange: string, destinationCell: string,
      fields: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => call(rt, "api.createPivot", [sourceRange, destinationCell, fields, options]),
    deletePivot: (pivotId: string) => call(rt, "api.deletePivot", [pivotId]),

    // ---- Conditional formatting CRUD (Wave 3 item 3) ----
    // Ranges are A1-or-numbers: "B2:D10" resolves worker-side to the numeric
    // box, so the broker (and its validator) sees one shape. ACTIVE SHEET only
    // today — the optional sheet arg is a flagged slot the host refuses unless
    // it names the active sheet.
    listConditionalFormats: (sheet?: SheetRef) =>
      call(rt, "api.listConditionalFormats", [sheet]),
    addConditionalFormat: (spec: ScriptCFSpecInput) =>
      call(rt, "api.addConditionalFormat", [resolveCFSpec(spec)]),
    updateConditionalFormat: (ruleId: number, patch: ScriptCFPatchInput) =>
      call(rt, "api.updateConditionalFormat", [ruleId, resolveCFSpec(patch as ScriptCFSpecInput)]),
    deleteConditionalFormat: (ruleId: number) =>
      call(rt, "api.deleteConditionalFormat", [ruleId]),
    clearConditionalFormats: (range?: ScriptCFRangeInput | null, sheet?: SheetRef) =>
      call(rt, "api.clearConditionalFormats", [
        range === undefined || range === null ? null : resolveCFRange(range),
        sheet,
      ]) as Promise<{ count: number }>,

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
        // Cancellable like save/close (Wave 4): asked before Print AND before
        // Export-to-PDF (a PDF is a print), including a script's own PDF.
        onBeforePrint: (h: (payload: unknown) => unknown) =>
          registerReplyingHook(rt, "onBeforePrint", "__workbook_onBeforePrint", h),
        onSheetChange: (h: Handler) => registerHook(rt, "onSheetChange", h),
        // Sheet COLLECTION hooks (Wave 4): the workbook mirror is pushed
        // before delivery, so properties.sheetCount/getSheetNames() read the
        // post-change truth inside the handler.
        onSheetAdd: (h: Handler) => registerHook(rt, "onSheetAdd", h),
        onSheetDelete: (h: Handler) => registerHook(rt, "onSheetDelete", h),
        onSheetRename: (h: Handler) => registerHook(rt, "onSheetRename", h),
        onThemeChange: (h: Handler) => registerHook(rt, "onThemeChange", h),
        properties: {
          get title() { return mirror(rt, "workbook.title", ""); },
          get author() { return mirror(rt, "workbook.author", ""); },
          get sheetCount() { return mirror(rt, "workbook.sheetCount", 0); },
          getSheetNames() { return [...mirror<string[]>(rt, "workbook.sheetNames", [])]; },
        },
      };

    case "sheet": {
      // Canonical-model facet (C3 step 3): a Range/Cell over the sheet on
      // screen, backed by the same restricted broker aspects the flat
      // getCellValue/setCellValue use — pure sugar, no new privileged surface.
      // No sheetIndex is ever passed, so reads/writes resolve to the ACTIVE
      // sheet (see RESTRICTED_SHEET_CLAMP_MESSAGE in host.ts: there is no
      // per-script sheet binding to clamp to, and the tier's real guarantee is
      // "never a sheet the user is not looking at").
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
        // Own-sheet format read-back (Wave 3), same clamp again.
        readFormats: (sr: number, sc: number, er: number, ec: number) =>
          call(rt, "sheet.getRangeFormat", [sr, sc, er, ec]) as Promise<ScriptCellFormat[][]>,
      };
      return {
        ...base,
        onActivate: (h: Handler) => registerHook(rt, "onActivate", h),
        onDeactivate: (h: Handler) => registerHook(rt, "onDeactivate", h),
        onSelectionChange: (h: Handler) => registerHook(rt, "onSelectionChange", h),
        onDataChange: (h: Handler) => registerHook(rt, "onDataChange", h),
        // Cancellable CLICK hooks (Wave 4): REPLYING hooks on the
        // onBeforeCommit machinery. Return false / "cancel" / { cancel: true }
        // to stop what the click would do — edit mode for a double-click, the
        // context menu for a right-click. 1.5s default-ALLOW deadline; the
        // payload is { row, col, address }, always on the ACTIVE sheet (the
        // only sheet a click can land on).
        onBeforeDoubleClick: (h: (payload: unknown) => unknown) =>
          registerReplyingHook(rt, "onBeforeDoubleClick", "__sheet_onBeforeDoubleClick", h),
        onBeforeRightClick: (h: (payload: unknown) => unknown) =>
          registerReplyingHook(rt, "onBeforeRightClick", "__sheet_onBeforeRightClick", h),
        getCellValue: (row: number, col: number, sheet?: SheetRef) =>
          call(rt, "sheet.getCellValue", [row, col, sheet]),
        setCellValue: (row: number, col: number, value: ScriptCellValue, sheet?: SheetRef) =>
          call(rt, "sheet.setCellValue", [row, col, value, sheet]),
        getCellData: (row: number, col: number, sheet?: SheetRef) =>
          call(rt, "sheet.getCellData", [row, col, sheet]),
        // Explicit formula read/write on THIS sheet, A1 or R1C1 (G4). Clamped
        // exactly like getCellValue/setCellValue above: naming another sheet is
        // unlocked-tier reach and is refused, not silently redirected.
        getCellFormula: (row: number, col: number, options?: ScriptFormulaOptions) =>
          call(rt, "sheet.getCellFormula", [row, col, options]) as Promise<string | null>,
        setCellFormula: (
          row: number, col: number, formula: string | null, options?: ScriptFormulaOptions,
        ) => call(rt, "sheet.setCellFormula", [row, col, formula, options]) as Promise<void>,
        setRangeFormat: (
          startRow: number, startCol: number, endRow: number, endCol: number,
          format: ScriptFormat, sheet?: SheetRef,
        ) => call(rt, "sheet.setRangeFormat", [startRow, startCol, endRow, endCol, format, sheet]),
        clearRangeFormat: (
          startRow: number, startCol: number, endRow: number, endCol: number, sheet?: SheetRef,
        ) => call(rt, "sheet.clearRangeFormat", [startRow, startCol, endRow, endCol, sheet]),
        // Format read-back on THIS sheet (Wave 3), clamped like the rows above.
        getRangeFormat: (
          startRow: number, startCol: number, endRow: number, endCol: number, sheet?: SheetRef,
        ) => call(rt, "sheet.getRangeFormat", [startRow, startCol, endRow, endCol, sheet]) as
          Promise<ScriptCellFormat[][]>,
        getCellFormat: (row: number, col: number, sheet?: SheetRef) =>
          call(rt, "sheet.getCellFormat", [row, col, sheet]) as Promise<ScriptCellFormat>,
        // A "Sheet!" prefix is never silently dropped (it used to be — writing
        // to whatever sheet was active). The NAME is passed through as the
        // sheet argument on every call, so enforcement stays host-side: a
        // restricted script is refused for any sheet that is not the active
        // one; for an unlocked sheet script the prefix is real cross-sheet
        // reach — the same tier rule the flat getCellValue/setCellValue obey.
        range: (address: string): ScriptRange => {
          const { sheetName, rest } = splitSheetPrefix(address);
          if (sheetName === null) return rangeFromAddress(sheetTransport, address);
          return makeRange(namedSheetTransport(rt, sheetName), parseA1Body(rest));
        },
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
        // Geometry + spec sugar (Wave 4): the same aspects the api.chart(id)
        // handle sends — setGeometry is placement, the sugars are updateSpec
        // patches through the extension's single schema validator.
        setGeometry: (patch: ScriptChartGeometryShim) => setState(rt, "chart.setGeometry", [patch]),
        setTitle: (title: string | null) => setState(rt, "chart.updateSpec", [{ title }]),
        setType: (mark: string) => setState(rt, "chart.updateSpec", [{ mark }]),
        setSourceRange: (range: string) => setState(rt, "chart.updateSpec", [{ data: range }]),
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
        // ---- Data aspects (Wave 3 item 4) ----
        // Report filters, item visibility, sort and value number format — the
        // same aspects api.pivot(id) exposes, on THIS pivot. getFieldInfo is
        // the read twin (current filters + item visibility) so a macro can
        // read-modify-write instead of guessing.
        getFieldInfo: (field: string) => getState(rt, "pivot.getFieldInfo", [field]),
        setFilter: (field: string, values: string[] | null) =>
          setState(rt, "pivot.setFilter", [field, values]),
        clearFilter: (field: string) => setState(rt, "pivot.clearFilter", [field]),
        setItemVisibility: (field: string, item: string, visible: boolean) =>
          setState(rt, "pivot.setItemVisibility", [field, item, visible]),
        sortField: (field: string, direction: "asc" | "desc") =>
          setState(rt, "pivot.sortField", [field, direction]),
        setNumberFormat: (valueField: string, format: string) =>
          setState(rt, "pivot.setNumberFormat", [valueField, format]),
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
        // ---- Structure (Wave 4): the same aspects api.table(id) sends,
        // pinned to THIS table by the mount. ----
        rename: (newName: string) => setState(rt, "table.rename", [newName]),
        resize: (startRow: number, startCol: number, endRow: number, endCol: number) =>
          setState(rt, "table.resize", [startRow, startCol, endRow, endCol]),
        addColumn: (name: string, position?: number) =>
          setState(rt, "table.addColumn", [name, position]),
        removeColumn: (name: string) => setState(rt, "table.removeColumn", [name]),
        renameColumn: (oldName: string, newName: string) =>
          setState(rt, "table.renameColumn", [oldName, newName]),
        setTotalsRow: (show: boolean) => setState(rt, "table.setTotalsRow", [show]),
        setTotalsFunction: (column: string, fn: string, customFormula?: string) =>
          setState(rt, "table.setTotalsFunction", [column, fn, customFormula]),
        setStyle: (style: string | { styleName?: string; styleOptions?: Record<string, boolean> }) =>
          setState(rt, "table.setStyle", [style]),
        convertToRange: () => setState(rt, "table.convertToRange", []),
        insertRow: (position?: number) => setState(rt, "table.insertRow", [position]),
        deleteRow: (position: number) => setState(rt, "table.deleteRow", [position]),
        getColumns: () => getState(rt, "table.getColumns", []),
        getStyle: () => getState(rt, "table.getStyle", []),
        getTotals: () => getState(rt, "table.getTotals", []),
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
        // ---- Definition edit (Wave 4). A rename is safe from the OWN
        // context too: the host re-keys this mount at the new name, so later
        // own-object calls keep resolving. ----
        update: (patch: ScriptNamedRangeUpdateShim) => setState(rt, "namedRange.update", [patch]),
        setRefersTo: (refersTo: string) => setState(rt, "namedRange.update", [{ refersTo }]),
        rename: (newName: string) => setState(rt, "namedRange.update", [{ newName }]),
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
