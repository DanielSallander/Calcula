//! FILENAME: app/src/api/scriptHost/capabilityIds.ts
// PURPOSE: The SINGLE source of truth for the capability vocabulary — the set
//          of ambient-world capabilities any imperative surface (object script,
//          notebook cell, one-off script, distributed extension, UDF) can be
//          granted. Before Wave 3 this list was duplicated in THREE places
//          (allowlist.ts CapabilityId union, capabilities.ts KNOWN_CAPABILITY_IDS,
//          broker.ts VALID_CAPABILITY_IDS); adding a capability meant editing all
//          three or it failed closed in confusing ways. This leaf module — it
//          imports NOTHING from broker/capabilities/allowlist, so it can never
//          form an import cycle — collapses them to one.
//
// CONTRACT (Rust enforcement): a capability whose grant reaches the BACKEND
// (e.g. net.fetch -> script_http_fetch re-checks the origin per call) needs
// authoritative Rust-side enforcement IN ADDITION to this frontend gate. A
// capability that is purely frontend / in-worker (e.g. formula.udf, which only
// invokes JS already mounted in a worker realm) needs NO Rust entry — Rust has
// NO enumerated capability list, only the net.fetch origin store
// (app/src-tauri/src/scripting/capability_store.rs). Do NOT assume adding an id
// here requires a matching Rust enum entry; only net.fetch-style backend-reaching
// capabilities do.

/**
 * Every recognized capability id, in one place.
 *  - net.fetch    : HTTPS egress to granted origins (Rust-enforced per call)
 *  - bi.query     : read-only, MODEL-SCOPED queries against the workbook's BI
 *                   connections (measures/groupBy/filters; no raw SQL)
 *  - bi.sql       : read-only RAW SQL against a BI connection's database — a
 *                   HIGHER-TRUST superset of bi.query (can read any table the
 *                   connection's credentials reach); Rust re-validates read-only
 *  - storage      : per-script 256 KB workbook-local key/value store
 *  - ui.html      : render sandboxed HTML inside the object's shape
 *  - formula.udf  : evaluate a registered user-defined function from a worksheet
 *                   formula (purely frontend/in-worker — NO Rust enforcement; the
 *                   JS impl runs in the owning script's realm through the broker)
 */
export const ALL_CAPABILITY_IDS = [
  "net.fetch",
  "bi.query",
  "bi.sql",
  "storage",
  "ui.html",
  "formula.udf",
] as const;

export type CapabilityId = (typeof ALL_CAPABILITY_IDS)[number];

/**
 * The membership-test set shared by the broker (ceiling filter), the pragma
 * parser, and the consent flow — so an unknown/garbage id from any source can
 * never enter a declared-capability ceiling or grant set.
 */
export const CAPABILITY_ID_SET: ReadonlySet<CapabilityId> = new Set(ALL_CAPABILITY_IDS);

/** Narrowing guard for an untrusted string (manifest field, pragma token, ...). */
export function isCapabilityId(v: unknown): v is CapabilityId {
  return typeof v === "string" && CAPABILITY_ID_SET.has(v as CapabilityId);
}
