//! FILENAME: app/src/api/scriptHost/errorMap.ts
// PURPOSE: Map a BrokerError (or any thrown value) from a broker-mediated call
//          to the right surface-specific failure. Both C1 (UDF formula calls)
//          and S8 (distributed extensions) route privileged work through the
//          broker; this module gives them ONE shared translation of
//          denial/timeout/validation failures so the semantics are identical
//          across surfaces instead of each caller inventing its own mapping.

import { BrokerError, type RpcErrorCode } from "./broker";

/** Canonical spreadsheet error strings (must match the engine's CellError text). */
export type CellErrorText = "#NAME?" | "#VALUE!" | "#REF!";

/** The broker error code for any thrown value (non-BrokerError -> "HostError"). */
export function brokerErrorCode(e: unknown): RpcErrorCode {
  return e instanceof BrokerError ? e.code : "HostError";
}

/**
 * Map a broker failure to a spreadsheet cell error for formula-callable code
 * (UDFs). An unregistered name never reaches the broker (the engine emits
 * #NAME? directly when the udf closure returns None), so a broker failure here
 * means the function exists but was DENIED / timed out / threw / had bad args:
 * all of those are #VALUE!. UnknownMethod is mapped to #NAME? for completeness
 * (a stale/removed broker method name behaves like an unknown function).
 */
export function brokerErrorToCellError(e: unknown): CellErrorText {
  return brokerErrorCode(e) === "UnknownMethod" ? "#NAME?" : "#VALUE!";
}

/**
 * A short, user-facing reason string for the transparency panel or an
 * extension's activation status. Stable, non-policy-probing wording.
 */
export function brokerErrorReason(e: unknown): string {
  if (e instanceof BrokerError) {
    switch (e.code) {
      case "PermissionDenied":
        return e.capability
          ? `denied: capability '${e.capability}' was not declared (or was revoked)`
          : "denied: insufficient access tier";
      case "CapabilityRequired":
        return `blocked: capability '${e.capability ?? "?"}' not granted`;
      case "ValidationError":
        return `invalid arguments: ${e.message}`;
      case "Timeout":
        return "timed out";
      case "UnknownMethod":
        return "unknown method";
      default:
        return e.message;
    }
  }
  return e instanceof Error ? e.message : String(e);
}
