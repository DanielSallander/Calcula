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
 *  - bi.model     : create/update/delete BI model DEFINITIONS (measures,
 *                   relationships, hierarchies, ...) through the consent-gated
 *                   script_bi_model gateway — undoable, audited, rate-limited;
 *                   RLS roles + connections/credentials stay privileged
 *  - bi.connector : register a script-fed data connector (feeds tables into
 *                   the BI model via the host orchestrator; named distinctly
 *                   from net.fetch so consent says what it means)
 *  - ui.dialog    : interrupt the user with a MODAL question and read the
 *                   answer (alert / confirm / prompt / declarative form). The
 *                   dialog itself is rendered by TRUSTED host code — the script
 *                   supplies only data — so this capability buys attention and
 *                   input, never pixels. Purely frontend (no Rust entry): it
 *                   reaches no backend command.
 *  - distribution.writeback
 *                 : fill in and SEND the input cells of a subscribed .calp
 *                   package — read the workbook's writeback regions and drafts,
 *                   save schema-validated drafts, and submit them to the
 *                   publisher's registry. For a script that can also SIGN the
 *                   package it additionally unlocks the publisher side: reading
 *                   every submitter's answers and approving/rejecting them.
 *                   Rust-enforced authoritatively in script_writeback (grant
 *                   re-check + Ed25519 publisher gate + rate buckets + audit).
 *  - schedule     : run one of the script's OWN exposed methods on a recurring
 *                   schedule that survives reload — the Application.OnTime
 *                   replacement. Jobs persist in the WORKBOOK, so this is the
 *                   only capability whose effects outlive the session that
 *                   consented to it; the consent string therefore says the
 *                   quiet part out loud ("without you starting it"). Bounded
 *                   HONESTLY to "while Calcula is open": there is no headless
 *                   runtime, and the capability must never grow one without a
 *                   new consent decision. Rust-enforced authoritatively in
 *                   script_scheduler, which re-checks the grant at EVERY
 *                   firing (a revoke stops a persisted job at the next tick),
 *                   requires the owning script to be mounted, enforces a 30s
 *                   floor and a per-job no-self-overlap guard, and audits
 *                   every fire.
 *  - file.picker  : ask the USER to pick ONE file — to save text into, or to
 *                   read text from. Named for the MECHANISM, not the reach,
 *                   because the mechanism IS the safety story: the script
 *                   never supplies, sees or stores a path; the host opens a
 *                   native picker, the human chooses the file, and the host
 *                   does the I/O, one file per call. ("file.access" was
 *                   rejected as an id — it reads as ambient filesystem
 *                   access, which is exactly the false impression this
 *                   capability must never create.)
 *                   Purely frontend / host-mediated (same shape as ui.dialog):
 *                   the trusted main thread performs the read/write through
 *                   the already-privileged read_text_file / write_text_file
 *                   commands, so there is NO Rust CapabilityStore entry and it
 *                   is NOT in RUST_MIRRORED_CAPABILITIES. The containment that
 *                   matters is that the worker realm has no Tauri, no fs and
 *                   no path vocabulary at all — it can only ask the host to
 *                   ask the user.
 *  - ui.shortcut  : take over ONE keyboard shortcut so pressing it runs one of
 *                   the script's own exposed methods — the Application.OnKey
 *                   replacement. Named for what the user gets (a shortcut),
 *                   never "keyboard": a script never sees the keyboard, only
 *                   the combination it was granted. Bounded structurally, not
 *                   by promise (app/src/api/keybindings.ts): the combination
 *                   must be Ctrl+Shift+<letter> (so typing, Escape, Tab, the
 *                   arrows, F1-F12 and every Ctrl+<key> the grid and the app
 *                   own are unreachable BY SHAPE, not by blocklist), a
 *                   combination anything else already holds is refused rather
 *                   than overridden, the app wins any later tie, at most 8 per
 *                   script, and the binding is listed in the shortcut list and
 *                   dies with the mount. The handler receives `{ combo }` and
 *                   nothing else — there is no key stream to subscribe to.
 *                   Purely frontend / host-mediated (same shape as ui.dialog
 *                   and file.picker): the keydown listener, the registry and
 *                   the dispatch are all trusted main-thread code, so there is
 *                   NO Rust CapabilityStore entry and it is NOT in
 *                   RUST_MIRRORED_CAPABILITIES.
 */
export const ALL_CAPABILITY_IDS = [
  "net.fetch",
  "bi.query",
  "bi.sql",
  "storage",
  "ui.html",
  "formula.udf",
  "bi.model",
  "bi.connector",
  "ui.dialog",
  "distribution.writeback",
  "schedule",
  "file.picker",
  "ui.shortcut",
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
