//! FILENAME: app/src/api/formulaUdf.ts
// PURPOSE: Evaluation bridge for user-defined formula functions (UDFs) — Wave 3
//          / C1. Registered UDFs (formulaFunctions.ts) used to be autocomplete
//          metadata only: a formula like =MYFN(A1) yielded #NAME?. This module
//          makes them EVALUATE.
//
// WHY A PRE-FETCH: the Rust recalc is synchronous and holds a state lock, so it
// can never call a JS UDF back mid-evaluation. So before the write runs we:
//   1. ask the backend which UDF calls the pending edits will trigger, with
//      their already-evaluated arguments (collect_udf_calls — read-only);
//   2. run each UDF's JS implementation off-thread THROUGH THE TIER BROKER, so
//      the call is tier/capability-checked (formula.udf), R19-ceiling-bounded,
//      and audited exactly like every other privileged script call;
//   3. hand the backend a results table its evaluator's udf_fn serves.
// The loop repeats until no new calls surface (nested UDFs converge), bounded.
//
// EVERY write path, not just single-cell edits. The hook is handed a LIST of
// pending writes, so paste / fill-handle / multi-cell edits (which all route
// through update_cells_batch) get the same pre-fetch. They previously got none,
// which is why a pasted UDF formula landed as #NAME?.
//
// VOLATILITY: by default a UDF cell is resolved only when the edit can actually
// reach it (the backend intersects the UDF-mentioning cells with the edit's
// dependency closure). A function registered with `volatile: true` opts into
// Excel's Application.Volatile behaviour: its cells are resolved AND spliced
// into the backend's recalc order on every edit.
//
// SECURITY: the JS impl runs under a ScriptHandle that must DECLARE and be
// GRANTED the formula.udf capability. Extension-registered UDFs are trusted
// today (extension sandboxing is Stage 2); a future worker-script-defined UDF
// would carry its own restricted handle, so a pulled .calp's UDFs can't run
// without package consent.

import { invokeBackend } from "./backend";
import {
  buildHandleFromDefinition,
  brokerCall,
  BrokerError,
  type ScriptHandle,
} from "./scriptHost/broker";
import { recordCapabilityGrant } from "./scriptHost/capabilities";
import { brokerErrorToCellError } from "./scriptHost/errorMap";
import {
  getCustomFunction,
  getAllCustomFunctions,
  getVolatileCustomFunctionNames,
  asCellErrorSentinel,
  thrownCellErrorLiteral,
  type CustomFunctionDef,
} from "./formulaFunctions";
import { setUdfResolveHook, type UdfPendingEdit } from "../core/lib/tauri-api";

// ============================================================================
// Wire format — mirrors the Rust UdfValue (scripting/udf.rs). Tagged union;
// keep the `kind` strings in lockstep with the serde tags on the Rust enum.
// ============================================================================

export type UdfValue =
  | { kind: "number"; value: number }
  | { kind: "text"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "error"; value: string } // a cell-error string, e.g. "#VALUE!"
  | { kind: "array"; value: UdfValue[] }
  | { kind: "empty" };

/** A UDF call site discovered by the backend, with its evaluated arguments and
 *  a stable key (computed by Rust; used verbatim as the results-table key). */
interface UdfCall {
  key: string;
  name: string;
  args: UdfValue[];
}

/** An active-sheet cell coordinate — mirrors Rust `UdfCellRef`. */
interface UdfCellRef {
  row: number;
  col: number;
}

/** One collect round's answer — mirrors Rust `UdfCollectResult`. */
interface UdfCollectResult {
  calls: UdfCall[];
  volatileCells: UdfCellRef[];
}

// ============================================================================
// Value conversions (UdfValue <-> plain JS the implementation sees/returns)
// ============================================================================

function udfValueToJs(v: UdfValue): unknown {
  switch (v.kind) {
    case "number":
      return v.value;
    case "text":
      return v.value;
    case "boolean":
      return v.value;
    case "error":
      // Pass the error string through; an impl can branch on it if it wants.
      return v.value;
    case "array":
      return v.value.map(udfValueToJs);
    case "empty":
      return null;
  }
}

function jsToUdfValue(x: unknown): UdfValue {
  if (x === null || x === undefined) return { kind: "empty" };
  if (typeof x === "number") {
    // The engine has no #NUM! error variant; a non-finite result surfaces as
    // #VALUE! (what udf_to_eval would resolve it to anyway).
    return Number.isFinite(x)
      ? { kind: "number", value: x }
      : { kind: "error", value: "#VALUE!" };
  }
  if (typeof x === "boolean") return { kind: "boolean", value: x };
  // An explicit cell-error return (VBA's CVErr): the sentinel OBJECT, checked
  // before the string/array/object branches. A plain string "#N/A" stays TEXT —
  // a UDF that formats error codes must be able to return one as text.
  const errorLiteral = asCellErrorSentinel(x);
  if (errorLiteral !== null) return { kind: "error", value: errorLiteral };
  if (typeof x === "string") return { kind: "text", value: x };
  // An array return SPILLS (udf_to_eval builds an engine Array, not a List):
  // [1,2,3] fills three rows, [[1,2],[3,4]] fills a 2x2 block.
  if (Array.isArray(x)) return { kind: "array", value: x.map(jsToUdfValue) };
  // Objects/functions/symbols can't be a cell value; stringify defensively.
  try {
    return { kind: "text", value: JSON.stringify(x) ?? "" };
  } catch {
    return { kind: "error", value: "#VALUE!" };
  }
}

// ============================================================================
// Broker-mediated execution of a single UDF
// ============================================================================

/** One trusted handle per registered UDF, memoized. Extension UDFs are trusted
 *  (Stage 2 sandboxes distributed extensions); the handle still routes every
 *  invocation through the broker so the audit ring + R19 ceiling apply. */
const udfHandles = new Map<string, ScriptHandle>();

function handleForUdf(def: CustomFunctionDef): ScriptHandle {
  const id = `udf:${def.name}`;
  let handle = udfHandles.get(id);
  if (!handle) {
    // Grant formula.udf into the live set the handle references, and declare it
    // in the ceiling, so checkPolicy admits the call.
    recordCapabilityGrant(id, "formula.udf");
    handle = buildHandleFromDefinition({
      id,
      name: `UDF ${def.name}`,
      objectType: "formula",
      instanceId: null,
      accessLevel: "restricted",
      declaredCapabilities: ["formula.udf"],
    });
    udfHandles.set(id, handle);
  }
  return handle;
}

/** Run one UDF call through the broker, returning the result as a UdfValue.
 *  Refused code maps to #BLOCKED! (the user must see the code was refused, not a
 *  stale number); other denial/timeout/throw maps to #VALUE!/#NAME?. */
async function resolveUdfCall(call: UdfCall): Promise<UdfValue> {
  const def = getCustomFunction(call.name);
  if (!def) return { kind: "error", value: "#NAME?" };

  const handle = handleForUdf(def);
  const jsArgs = call.args.map(udfValueToJs);
  try {
    const result = await brokerCall(
      handle,
      "formula.udf.invoke",
      [call.name, call.args],
      async () => {
        // Arg-count contract (mirrors executeCustomFunction).
        if (jsArgs.length < def.minArgs) {
          throw new BrokerError(
            "ValidationError",
            `${def.name} requires at least ${def.minArgs} argument(s)`,
          );
        }
        if (def.maxArgs >= 0 && jsArgs.length > def.maxArgs) {
          throw new BrokerError(
            "ValidationError",
            `${def.name} accepts at most ${def.maxArgs} argument(s)`,
          );
        }
        // The impl may be sync or async; await normalizes both.
        return await def.implementation(...jsArgs);
      },
    );
    return jsToUdfValue(result);
  } catch (e) {
    // An author-thrown cell error is a RESULT, not a failure: honour it before
    // the broker's denial/timeout mapping. (A sandboxed body cannot return an
    // object across a rejection, so `throw new Error("#N/A")` is its only way
    // to signal a specific error from inside a catch block.)
    const thrown = thrownCellErrorLiteral(e);
    if (thrown !== null) return { kind: "error", value: thrown };
    return { kind: "error", value: brokerErrorToCellError(e) };
  }
}

/**
 * Resolve `calls` with bounded parallelism, preserving input order.
 *
 * A paste can surface thousands of distinct call sites at once; firing them all
 * as one Promise.all would queue thousands of concurrent worker round-trips
 * against a single sandbox realm and push individual calls past the host's
 * 30s method-call timeout purely through queueing. A small window keeps every
 * call's own deadline meaningful.
 */
const MAX_CONCURRENT_UDF_CALLS = 16;

async function resolveCallsBounded(calls: UdfCall[]): Promise<UdfValue[]> {
  const out: UdfValue[] = new Array(calls.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= calls.length) return;
      out[i] = await resolveUdfCall(calls[i]);
    }
  };
  const lanes = Math.min(MAX_CONCURRENT_UDF_CALLS, calls.length);
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  return out;
}

// ============================================================================
// Collect -> resolve -> table orchestration (the resolve hook)
// ============================================================================

/** Bound on the discovery loop (nested UDFs converge in a few rounds; this
 *  caps a pathological chain rather than constraining real use). */
const MAX_ROUNDS = 8;

/** Above this many distinct call sites in one write we log once — a paste that
 *  big is a real cost the user should be able to see in the console, not a
 *  silent stall. We still resolve them all: dropping any would corrupt cells. */
const LARGE_PASS_WARN_THRESHOLD = 500;

/** The resolver's answer for one write. */
export interface UdfResolution {
  /** Pre-fetched results table: stable call key -> value. */
  results: Record<string, UdfValue>;
  /** Active-sheet cells calling a VOLATILE UDF; the backend splices these into
   *  its recalc order so they actually recompute. */
  volatileCells: UdfCellRef[];
}

/**
 * Resolve every UDF the given pending writes will trigger.
 *
 * Returns the pre-fetched results table plus the volatile cells, or undefined
 * when there is nothing to resolve (no UDFs registered, or none reached).
 * Installed as the Core write hook and used by BOTH `updateCell` and
 * `updateCellsBatch` — paste/fill/multi-cell edits carry many pending writes
 * and used to get no pre-fetch at all.
 */
export async function resolveUdfsForEdits(
  edits: UdfPendingEdit[],
): Promise<UdfResolution | undefined> {
  const names = getAllCustomFunctions().map((d) => d.name);
  if (names.length === 0) return undefined; // fast path: no UDFs in the workbook
  if (edits.length === 0) return undefined;
  const volatileNames = getVolatileCustomFunctionNames();

  const known: Record<string, UdfValue> = {};
  // Keyed dedup across rounds; the backend reports the same volatile cells each
  // round, and a cell is identified by its coordinate.
  const volatileByKey = new Map<string, UdfCellRef>();
  let totalCalls = 0;
  let warned = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let collected: UdfCollectResult;
    try {
      collected = await invokeBackend<UdfCollectResult>("collect_udf_calls", {
        edits,
        udfNames: names,
        volatileUdfNames: volatileNames,
        known,
      });
    } catch (e) {
      console.warn("[udf] collect_udf_calls failed; UDFs will show #NAME?", e);
      break;
    }
    for (const cell of collected.volatileCells) {
      volatileByKey.set(`${cell.row}:${cell.col}`, cell);
    }
    const fresh = collected.calls.filter((c) => !(c.key in known));
    if (fresh.length === 0) break;
    totalCalls += fresh.length;
    if (!warned && totalCalls > LARGE_PASS_WARN_THRESHOLD) {
      warned = true;
      console.warn(
        `[udf] resolving ${totalCalls}+ custom-function calls for ${edits.length} pending cell(s); this write will take a while`,
      );
    }
    const resolved = await resolveCallsBounded(fresh);
    fresh.forEach((c, i) => {
      known[c.key] = resolved[i];
    });
  }

  const volatileCells = Array.from(volatileByKey.values());
  if (Object.keys(known).length === 0 && volatileCells.length === 0) {
    return undefined;
  }
  return { results: known, volatileCells };
}

/**
 * Single-cell convenience wrapper over `resolveUdfsForEdits` (the shape the
 * @api facade has always exported).
 */
export async function resolveUdfsForEdit(
  row: number,
  col: number,
  value: string,
): Promise<Record<string, UdfValue> | undefined> {
  const resolution = await resolveUdfsForEdits([{ row, col, value }]);
  if (!resolution || Object.keys(resolution.results).length === 0) return undefined;
  return resolution.results;
}

// ============================================================================
// Install / uninstall (Inversion of Control into Core)
// ============================================================================

let installed = false;

/** Wire UDF evaluation into Core's write paths (single-cell AND batch).
 *  Idempotent; call once at startup (e.g. from the FormulaAutocomplete
 *  extension's activate). */
export function installUdfEvaluation(): void {
  if (installed) return;
  installed = true;
  setUdfResolveHook(async (edits) => {
    const resolution = await resolveUdfsForEdits(edits);
    if (!resolution) return undefined;
    return { results: resolution.results, volatileCells: resolution.volatileCells };
  });
}

/** Remove the hook (tests / teardown). */
export function uninstallUdfEvaluation(): void {
  installed = false;
  setUdfResolveHook(null);
}

// Exposed for unit tests of the conversion layer.
export const __test = { udfValueToJs, jsToUdfValue, resolveUdfCall, resolveCallsBounded };
