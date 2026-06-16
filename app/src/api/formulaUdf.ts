//! FILENAME: app/src/api/formulaUdf.ts
// PURPOSE: Evaluation bridge for user-defined formula functions (UDFs) — Wave 3
//          / C1. Registered UDFs (formulaFunctions.ts) used to be autocomplete
//          metadata only: a formula like =MYFN(A1) yielded #NAME?. This module
//          makes them EVALUATE.
//
// WHY A PRE-FETCH: the Rust recalc is synchronous and holds a state lock, so it
// can never call a JS UDF back mid-evaluation. So before update_cell runs we:
//   1. ask the backend which UDF calls the edit will trigger, with their
//      already-evaluated arguments (collect_udf_calls — read-only, no commit);
//   2. run each UDF's JS implementation off-thread THROUGH THE TIER BROKER, so
//      the call is tier/capability-checked (formula.udf), R19-ceiling-bounded,
//      and audited exactly like every other privileged script call;
//   3. hand the backend a results table its evaluator's udf_fn serves.
// The loop repeats until no new calls surface (nested UDFs converge), bounded.
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
  type CustomFunctionDef,
} from "./formulaFunctions";
import { setUdfResolveHook } from "../core/lib/tauri-api";

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
  if (typeof x === "string") return { kind: "text", value: x };
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
    return { kind: "error", value: brokerErrorToCellError(e) };
  }
}

// ============================================================================
// Collect -> resolve -> table orchestration (the resolve hook)
// ============================================================================

/** Bound on the discovery loop (nested UDFs converge in a few rounds; this
 *  caps a pathological chain rather than constraining real use). */
const MAX_ROUNDS = 8;

/**
 * Resolve every UDF the given single-cell edit will trigger and return the
 * pre-fetched results table (key -> UdfValue), or undefined when there is
 * nothing to resolve (no UDFs registered, or none reached). Installed as the
 * Core updateCell hook.
 */
export async function resolveUdfsForEdit(
  row: number,
  col: number,
  value: string,
): Promise<Record<string, UdfValue> | undefined> {
  const names = getAllCustomFunctions().map((d) => d.name);
  if (names.length === 0) return undefined; // fast path: no UDFs in the workbook

  const known: Record<string, UdfValue> = {};
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let calls: UdfCall[];
    try {
      calls = await invokeBackend<UdfCall[]>("collect_udf_calls", {
        row,
        col,
        value,
        udfNames: names,
        known,
      });
    } catch (e) {
      console.warn("[udf] collect_udf_calls failed; UDFs will show #NAME?", e);
      break;
    }
    const fresh = calls.filter((c) => !(c.key in known));
    if (fresh.length === 0) break;
    const resolved = await Promise.all(fresh.map((c) => resolveUdfCall(c)));
    fresh.forEach((c, i) => {
      known[c.key] = resolved[i];
    });
  }

  return Object.keys(known).length > 0 ? known : undefined;
}

// ============================================================================
// Install / uninstall (Inversion of Control into Core)
// ============================================================================

let installed = false;

/** Wire UDF evaluation into Core's updateCell path. Idempotent; call once at
 *  startup (e.g. from the FormulaAutocomplete extension's activate). */
export function installUdfEvaluation(): void {
  if (installed) return;
  installed = true;
  setUdfResolveHook((row, col, value) => resolveUdfsForEdit(row, col, value));
}

/** Remove the hook (tests / teardown). */
export function uninstallUdfEvaluation(): void {
  installed = false;
  setUdfResolveHook(null);
}

// Exposed for unit tests of the conversion layer.
export const __test = { udfValueToJs, jsToUdfValue, resolveUdfCall };
