# Customizable Pivot Drill-Through Behavior

**Status:** Design — approved to build layered (declarative first, script hook second)
**Date:** 2026-06-19
**Related:** `wave3-scripting-security.md`, `vision-gap-review.md`, the BI-engine adoption work (secured drillthrough)

## 1. Summary

Today, double-clicking a data/total cell in a pivot opens a new sheet with the
detail rows behind it (for a BI-backed pivot, the engine's RLS-enforced
`query_rows` fact rows + related dimension attributes). The behavior is fixed.

This feature makes the drill-through behavior **configurable per pivot**, in
three escalating modes, and — critically — **packages that configuration into
`.calp`** so a subscriber gets the publisher's custom drill experience:
sandboxed, consented, audited, signed.

This is the project vision in one feature. A publisher builds a bespoke drill
(custom columns, a custom query, or a script that fetches/enriches/formats
detail), distributes it, and every subscriber gets exactly that behavior —
something Excel can't do safely and Power BI can't do at all. It is mostly
**composition of existing machinery**, not new infrastructure.

## 2. Current state (what we build on)

- **Backend:** `drill_through_to_sheet` (async) and `build_bi_detail_request`
  in `app/src-tauri/src/pivot/commands.rs`. The latter builds a
  `bi_engine::DetailRequest` (fact table, equality filters from the drilled
  cell's `group_path`, dimension attributes) and the command runs
  `engine.query_rows`, writing results to a new sheet.
- **Trigger:** the Pivot double-click interceptor in
  `app/extensions/Pivot/index.ts` calls `drillThroughToSheet` for `Data`/total
  cells.
- **Request type:** `DrillThroughRequest { pivotId, groupPath, maxRecords }`
  (`app/src-tauri/src/pivot/types.rs`).
- **Persistence/distribution:** pivot config persists in `SavedBiPivotMetadata`
  (`pivot/types.rs:1508`), which is captured into `.calp` packages.
- **Scripting:** Buttons already prove "object event → sandboxed script":
  `executeButtonAction` in `app/extensions/Controls/Button/interceptors.ts`
  runs the button's `onSelect` via `runWorkbookScript(source, name)`
  (imported from `@api`/workbookScripts). Scripts run in per-script hardened Worker
  realms; the tier broker mediates all privileged calls behind a typed
  capability set (`app/src/api/scriptHost/capabilityIds.ts`):
  `net.fetch`, `bi.query`, `bi.sql`, `storage`, `ui.html`, `formula.udf`.
  Capabilities have a declared **ceiling** and a consented **grant** (subset).
- **Consent/audit/signing for `.calp` scripts:** `ScriptableObjects` consent
  store + `ScriptConsentDialog` gate scripts arriving in a package; an audit
  ring records runs; Ed25519/TOFU signs packages; the transparency panel /
  "Code in This File" inspector enumerates the script surface.

## 3. The three modes

A pivot's drill behavior is one of:

| Mode | What it is | New code at drill time? | Consent on subscribe? |
|---|---|---|---|
| **`builtin`** (default) | Today's secured drillthrough | no | no |
| **`query`** (declarative override) | Publisher-chosen detail columns / dimension attributes / order / row cap / extra filters | no — it's *config* fed into `DetailRequest` | **no** (data, not code; uses the `bi.query` the pivot already runs) |
| **`script`** (`onDrillThrough` hook) | A sandboxed TS function, same realm as `Button.onSelect` | yes | **yes** — capability grant + per-package consent |

### Why no separate "script + query combination" mode

Rather than enumerate `script`, `query`, `scriptThenQuery`, `queryThenScript`,
the **script mode's context exposes a query primitive**
(`ctx.bi.detail(override)` / `ctx.bi.query(request)`, broker-mediated and
capability-gated). Then:

- "run a query and alter the columns" = the `query` mode (no code).
- "script + query combo" = a `script` that calls `ctx.bi.detail()` and
  post-processes the rows.

One powerful primitive, no enum explosion.

## 4. The `onDrillThrough` contract (script mode)

The script is an event handler that receives a **drill context** and returns
rows the host writes to the DrillThrough sheet (the default, capability-minimal
contract).

```ts
// Conceptual shape — refined during Layer 2.
interface DrillContext {
  /** The drilled cell as resolved dimension -> value pairs (empty for a grand total). */
  readonly cell: ReadonlyArray<{ table: string; column: string; value: string }>;
  /** The pivot's fact (detail) table. */
  readonly factTable: string;
  /** The measure of the drilled value cell, if applicable. */
  readonly measure?: string;
  /** Host-suggested row cap. */
  readonly maxRecords: number;

  /** Broker-mediated, capability-gated query primitives (bi.query / bi.sql). */
  readonly bi: {
    detail(override?: DrillQueryOverride): Promise<DrillRows>;  // DetailRequest under the hood
    query(request: BiQueryRequest): Promise<DrillRows>;         // aggregate query
    // sql(text): Promise<DrillRows>  // ONLY if bi.sql granted (higher trust)
  };
}

type DrillRows = { columns: string[]; rows: Array<Array<string | number | null>> };

// The handler. Default contract: return rows; the host writes the sheet.
async function onDrillThrough(ctx: DrillContext): Promise<DrillRows | void>;
```

- **Default output contract:** the handler **returns rows**; the host writes the
  DrillThrough sheet. This needs *no* grid-write capability — consistent UX,
  minimal trust.
- **Custom output (deferred):** a script that declares a `ui`/grid capability
  could write a styled report / charts itself. Out of scope for Layer 2 v1.

### `DrillQueryOverride` (shared by `query` mode and `ctx.bi.detail`)

```ts
interface DrillQueryOverride {
  /** Detail-table columns to return; empty/undefined = all. */
  columns?: string[];
  /** Dimension attributes to attach (table+column). */
  dimensionColumns?: Array<{ table: string; column: string }>;
  /** ORDER BY (detail-table columns only). */
  orderBy?: Array<{ table: string; column: string; descending?: boolean }>;
  /** Row cap override. */
  limit?: number;
  /** Extra filters ANDed with the cell-derived ones. */
  filters?: Array<{ column: string; operator: string; value: string }>;
}
```

This maps directly onto the engine's `DetailRequest` builder
(`with_columns` / `with_dimension_columns` / `with_order_by` / `with_filters` /
`limit`) — Layer 1 is a thin extension of the existing `build_bi_detail_request`.

## 5. Persistence & `.calp` packaging

Add the behavior to the pivot's saved metadata. New field on
`SavedBiPivotMetadata` (and its runtime `BiPivotMetadata`):

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub drill_through: Option<DrillThroughBehavior>,
```

```rust
#[serde(rename_all = "camelCase")]
pub struct DrillThroughBehavior {
    pub kind: DrillThroughKind,                  // Builtin | Query | Script
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<DrillQueryOverride>,       // for Query (and as script default)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script_id: Option<String>,               // for Script: id into the package script surface
}
```

- `#[serde(default)]` → older pivots load as `None` (builtin). Additive, no
  format break (project has no back-compat constraint anyway).
- The behavior travels in `.calp` automatically (it's part of the captured pivot
  metadata). The **script body** lives in the package's existing script surface
  (the same place object/module scripts live) referenced by `script_id`, so it
  inherits signing + consent + audit with no new packaging path.

## 6. Security model (the part that must be right)

The threat: a pivot from a stranger's `.calp` carries an `onDrillThrough`
script. Requirements, all satisfied by existing Wave-3 machinery:

1. **User-initiated only.** The script runs **only on an explicit double-click**,
   never on package open/refresh. (Opening a package is already inert.)
2. **Consent on subscribe, before first run.** A packaged drill script is gated
   by the `ScriptableObjects` consent store + `ScriptConsentDialog` exactly like
   any other packaged script. No consent → the drill **falls back to `builtin`**
   (never silently runs, never breaks).
3. **Declared-capability ceiling + grant.** The script declares capabilities
   (floor: `bi.query`; `bi.sql` and `net.fetch` are higher-trust opt-ins). The
   tier broker enforces the ceiling; the subscriber grants a subset. A call to a
   non-granted capability fails closed (`#BLOCKED!`-style), surfaced to the user.
4. **Audit every run.** Each drill-script execution writes to the audit ring,
   queryable in the transparency panel.
5. **Signed.** The package (and the script surface) is Ed25519/TOFU-signed and
   verified at scan; an unsigned/altered drill script is flagged.
6. **Transparency / discoverability.** A pivot with a custom drill behavior shows
   a **badge/indicator** (mirroring the object-script badges) so the user knows a
   double-click runs code, and the drill script appears in the "Code in This
   File" inspector and the script-surface taxonomy.
7. **Fail-safe everywhere.** Consent denied, capability missing, script error, or
   timeout → fall back to `builtin` (or no-op with a toast), exactly as the
   dimension-attribute fallback already degrades. The drill never breaks the pivot.

**The `query` (declarative) mode bears none of this** — it executes no code and
introduces no capability beyond the `bi.query` the pivot already uses. It is
ordinary pivot config and needs no consent. This is the safety + UX reason to
ship it first and as the broad default for "I just want different drill columns".

## 7. Authoring UX

A **"Drill-through behavior…"** entry on the pivot (context menu + Pivot editor):

- A mode toggle: **Built-in / Custom query / Script**.
- **Custom query:** a form — pick detail columns, dimension attributes (from the
  model's related tables), sort, row cap. No code.
- **Script:** Monaco editor scaffolded with the `onDrillThrough(ctx)` signature
  and a typed `DrillContext` (reuse the `ScriptableObjects` Monaco + scaffold +
  `.d.ts` story). A declared-capabilities picker.
- Live indicator that the pivot has a non-default drill, with a link to inspect.

## 8. Layered build plan

**Layer 1 — declarative `query` override (no code, no consent).**
1. Types: `DrillThroughBehavior` / `DrillThroughKind` / `DrillQueryOverride`
   (Rust `pivot/types.rs` + TS `pivot-api.ts`), field on `(Saved)BiPivotMetadata`.
2. Backend: `build_bi_detail_request` honors the override (columns, dimension
   columns, order_by, limit, extra filters), merged with the cell-derived filters.
   A command to set/clear a pivot's drill behavior.
3. Frontend: "Drill-through behavior…" dialog (Built-in / Custom query); persists
   via the new command; travels in `.calp` (verify capture round-trip).
4. Gate: app `cargo check` + `check-types`; a calp publish→pull round-trip test
   that asserts the behavior survives.

**Layer 2 — `script` hook (`onDrillThrough`).**
1. The `DrillContext` + `ctx.bi.detail/query` broker surface (capability-gated),
   added to the script-surface taxonomy.
2. Dispatch: on a `script`-mode drill, run the pivot's drill script via the
   sandbox (model on `executeButtonAction` / `runScript`), passing `ctx`,
   collect returned rows, host writes the sheet.
3. Consent/audit/badge wiring (reuse `ScriptableObjects` machinery); fallback to
   `builtin` on consent-denied / error / missing capability.
4. Authoring: Monaco scaffold + capabilities picker; transparency-panel surfacing.
5. Gate: builds + a consent-required-before-run test + a fallback test.

## 9. Open decisions (flag for sign-off)

1. **Script output contract** — *return rows* (recommended; capability-minimal,
   consistent UX) vs *script writes the sheet* (needs grid capability; powerful;
   defer).
2. **Capability ceiling for drill scripts** — floor `bi.query`; allow `bi.sql`?
   allow `net.fetch` in a drill (enrich detail from an external API)? Recommend:
   `bi.query` floor, `bi.sql` opt-in, `net.fetch` opt-in but loudly flagged.
3. **Trigger generality** — name the hook `onDrillThrough` but build the dispatch
   so other pivot events (right-click "Actions") can join later. Recommend yes.
4. **Where the script body lives** — reuse the existing package script surface
   referenced by `script_id` (recommended) vs inline source on the pivot.

## 10. Out of scope (future)

- Script-authored custom output (styled reports, charts) behind a `ui`/grid
  capability.
- Drill behavior on **grid-backed** (non-BI) pivots beyond the built-in source
  read.
- Non-pivot drill hooks (charts, slicers).
- Multiple named drill actions per pivot (a menu of drills).
