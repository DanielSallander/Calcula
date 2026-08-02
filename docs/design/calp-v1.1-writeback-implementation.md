# .calp v1.1 Writeback — Implementation Plan

## Status

Complete. All phases (10-18) implemented and verified. Integration gaps
(persistence, GATHER recalc wiring, refresh region handling, override
refusal, audit events) also closed.

Remaining future work (not blocking):
- GATHER pre-fetch wiring at ~12 secondary evaluator helpers (hot paths covered)
- Remote/networked registry support
- Approval workflows beyond state tracking
- Full regex support in ValueSchema pattern validation (currently substring match)

## Starting Point

Phase 9 landed the following prerequisites:

- `writeback_regions` field on `VersionManifest` (opaque sub-fields,
  round-tripped losslessly)
- `WritebackIndex` in `AppState`, rebuilt on pull/refresh/detach
- Frontend edit/range guards refusing edits on writeback cells
- Backend backstops on 7 mutation paths
- Conditional style interceptor (no-op, registered only when regions exist)
- Forward-compatibility `extra` hatches on 16 persisted structs
- Manifest validation (overlapping/inverted regions rejected at load time)

## Infrastructure Gaps Identified

Before detailing the phases, the survey surfaced three significant gaps
that shape the implementation order:

### 1. IdRegistry is not integrated into AppState

The `IdRegistry` crate exists (`core/identity/src/registry.rs`) with full
cell identity management: mint, lookup, structural shift, rename, merge.
But it is **not wired into AppState** — only `sheet_ids: Vec<SheetId>` is
there today. The deferred `calp_rename_cell_id` and `calp_merge_cell_ids`
commands confirm this.

Writeback needs IdRegistry integration for the "cell received a writeback
submission" auto-mint trigger. This is a prerequisite that benefits the
whole system, not just writeback.

### 2. Formula evaluator is synchronous with no extension point

The Rust evaluator dispatches on a `BuiltinFunction` enum — no dynamic
function table, no callback to TypeScript, no async path. GATHER()
needs:

- A way to register new functions (or extend the enum)
- An async-capable evaluation path (registry data fetches)
- A result cache with explicit invalidation

This is the largest single piece of new infrastructure in v1.1.

### 3. No subscriber identity or per-subscriber storage

LocalRegistry is a pure filesystem adapter with no concept of "who is
reading." Writeback needs:

- Subscriber identity (at minimum a string identifier, ideally tied to
  OS/SSO credentials)
- Per-subscriber submission storage keyed by
  `(package, version, region, submitter)`
- A submission manifest/ledger per package version

## Phasing

The work is split into 8 phases. Each phase produces independently
testable, committable work. Dependencies flow forward — later phases
build on earlier ones but earlier phases are useful alone.

### Phase 10: Strongly-Typed Manifest Fields

**Goal:** Replace the opaque `serde_json::Value` sub-fields on
`WritebackRegionDeclaration` with real Rust types. Everything after this
phase operates on typed data instead of opaque JSON.

**Scope:**

Declare the following enums and structs in `core/calp/src/writeback.rs`:

```
WritebackMode         { PerSubscriber, ListObject }
ValueSchema           { value_type, required, min, max, enum_values, ... }
VisibilityPolicy      { OwnOnly, OwnPlusAggregate, Transparent }
SubmissionPolicy      { Immediate, OnSubmit, OnApproval }
VersionBinding        { Strict, Lenient }
LifecyclePolicy       { Always, UntilDeadline { deadline }, Never, RequiresUnlock }
```

- Each gets `#[serde(rename_all = "camelCase")]`
- The `WritebackRegionDeclaration` fields change from
  `Option<serde_json::Value>` to `Option<WritebackMode>`, etc.
- The `extra` flatten hatch remains for future extensibility
- Add `#[serde(default)]` on each field so manifests with missing
  sub-fields still parse (backward compat with v1.0 opaque format)
- Write serde round-trip tests for every combination

**Files modified:**
- `core/calp/src/writeback.rs` — types and tests
- No other files change; the `VersionManifest` already uses
  `WritebackRegionDeclaration`

**Order of work:**
1. Define enums with serde derives
2. Update `WritebackRegionDeclaration` fields
3. Update test helpers (`make_decl`)
4. Add round-trip tests for each enum variant
5. Verify existing v1.0 round-trip test still passes (opaque JSON
   should deserialize into the typed fields cleanly)

---

### Phase 11: IdRegistry Integration into AppState

**Goal:** Wire the existing `IdRegistry` into `AppState` so that CellIds
are first-class runtime state, not just a persistence artifact.

**Why now:** Writeback's auto-mint trigger in Phase 14 requires
IdRegistry. But IdRegistry integration is also needed by the deferred
`calp_rename_cell_id` / `calp_merge_cell_ids` commands and benefits
formula dependency tracking, override anchoring, and future features.

**Scope:**

- Add `id_registry: Mutex<identity::IdRegistry>` to `AppState`
- Initialize from loaded `.cala` data (persistence already saves/loads
  cell IDs)
- Wire structural shift operations (`insert_rows`, `delete_rows`,
  `insert_columns`, `delete_columns`) to call `IdRegistry::shift_*`
- Unblock `calp_rename_cell_id` and `calp_merge_cell_ids` commands
- Add a `get_cell_id` Tauri command for frontend lookups
- Add a `mint_cell_id` internal helper (not exposed as a command — used
  internally by auto-mint triggers)

**Files modified:**
- `app/src-tauri/src/lib.rs` — `AppState` struct, `create_app_state()`
- `app/src-tauri/src/commands/structure.rs` — wire shift operations
- `app/src-tauri/src/calp_commands.rs` — unblock rename/merge
- `app/src-tauri/src/persistence.rs` — load/save IdRegistry state
- New: `app/src-tauri/src/identity_commands.rs` — Tauri commands

**Tests:**
- Structural shift preserves CellIds across row/column insert/delete
- Rename and merge work through Tauri commands
- Round-trip: save workbook with CellIds, reload, IDs stable

---

### Phase 12: Author UI — Region Designation

**Goal:** Let publishers designate writeback regions in the authoring
workflow. Without this, no writeback packages can be created.

**Scope:**

- New dialog: "Designate Writeback Region" — opened from the Data menu
  or right-click context menu on a selected range
- The dialog lets the author:
  - Confirm the selected range as a writeback region
  - Choose mode (per-subscriber / list-object)
  - Configure value schema (type, required, bounds)
  - Set visibility, submission policy, version binding, lifecycle
  - Provide an aggregation hint
- The designation is stored in a local author-side state
  (`writeback_draft_regions` or similar) until publish
- The publish workflow reads the draft regions and writes them into the
  `VersionManifest.writeback_regions` field
- Preview: a visual badge or shading on designated cells (fills in the
  Phase 9 no-op style interceptor for the author's own workbook)

**UI components (Distribution extension):**
- `DesignateWritebackDialog.tsx` — form for region configuration
- `WriterbackRegionList.tsx` — list view in the overrides/writeback pane
  showing all designated regions with edit/delete actions

**State management:**
- Author-side draft regions stored in `AppState` (not persisted until
  publish). New field:
  `writeback_draft_regions: Mutex<Vec<WritebackRegionDeclaration>>`
- Tauri commands: `calp_add_writeback_region`,
  `calp_remove_writeback_region`, `calp_update_writeback_region`,
  `calp_get_writeback_draft_regions`
- Publish workflow (`publish.rs`) reads draft regions and includes them
  in the `VersionManifest`

**Files modified:**
- `app/src-tauri/src/lib.rs` — new draft regions field
- `app/src-tauri/src/calp_commands.rs` — new CRUD commands, publish
  integration
- `core/calp/src/publish.rs` — accept and write writeback regions
- `app/extensions/Distribution/` — new dialog, pane components, menu
  items
- `app/src/api/distribution.ts` — new API functions

**Tests:**
- Add region, remove region, update region CRUD
- Publish includes writeback regions in manifest
- Subscriber pulls package with writeback regions → index is built
- Author preview styling on designated cells

---

### Phase 13: Subscriber Identity

**Goal:** Establish a subscriber identity that can be attached to
writeback submissions. This is a prerequisite for submission storage.

**Design decision:** Start with a simple local identity model rather
than full SSO/AD integration. The subscriber identity is:

- Derived from the OS username (`USERNAME` / `USER` env var) + a
  machine-generated UUID stored in the Calcula user profile
- Represented as `SubmitterIdentity { display_name: String, id: String }`
- Persisted in the Calcula user profile directory (not per-workbook)
- Included in every submission and in audit log entries

**Scope:**

- New struct `SubmitterIdentity` in `core/calp/src/writeback.rs`
- New module `core/calp/src/identity_provider.rs` — reads/creates the
  local identity file
- Tauri command `calp_get_subscriber_identity` — returns the current
  identity
- Identity is loaded at startup and cached in `AppState`

**Future:** SSO/AD integration replaces the identity provider without
changing the `SubmitterIdentity` struct or submission storage format.

**Files:**
- `core/calp/src/identity_provider.rs` — new module
- `core/calp/src/writeback.rs` — `SubmitterIdentity` struct
- `app/src-tauri/src/lib.rs` — `subscriber_identity` in AppState
- `app/src-tauri/src/calp_commands.rs` — new command

---

### Phase 14: Submission Storage and Writeback Layer

**Goal:** Build the storage layer for writeback contributions and the
runtime writeback layer that sits between upstream content and overrides.

This is the core of v1.1 — after this phase, subscribers can write to
writeback cells, and their contributions are stored.

**Three-layer model (from the design doc):**

1. Upstream package content (immutable, in `.calp`)
2. Consumer overrides (private, in `.cala`)
3. Writeback contributions (shared, in the registry)

**Scope:**

#### Submission storage (registry-side)

Registry directory extension:

```
{registry_root}/{package}/{version}/
  submissions/
    {submitter_id}/
      {region_id}.json    → WritebackSubmission[]
  submission-manifest.json → SubmissionManifest
```

Structs:
```
WritebackSubmission {
  id: SubmissionId,
  region_id: String,
  cell_row: u32,
  cell_col: u32,
  cell_id: Option<CellId>,      // minted on first submission
  submitter: SubmitterIdentity,
  value: SubmissionValue,
  state: SubmissionState,        // Draft | Submitted | Approved | Rejected
  created_at: String,
  updated_at: String,
  submitted_at: Option<String>,
}

SubmissionManifest {
  format_version: u32,
  submissions_by_submitter: HashMap<String, Vec<SubmissionSummary>>,
}
```

Registry operations:
- `save_submission(package, version, submission)` — write to submitter's
  directory
- `load_submissions(package, version, submitter_id)` — read one
  submitter's contributions
- `load_all_submissions(package, version, region_id)` — read all
  submitters' contributions for a region (publisher view)
- `load_submission_manifest(package, version)` — summary across all
  submitters

#### Writeback layer (workbook-side)

New struct `WritebackLayer` in `core/calp/src/writeback.rs`:
```
WritebackLayer {
  format_version: u32,
  drafts: Vec<WritebackSubmission>,   // local drafts not yet submitted
  submitted: Vec<SubmissionSummary>,  // references to registry-side data
}
```

Persisted in `.cala` as `writeback_drafts.json` (only drafts; submitted
data lives in the registry).

#### CellId auto-mint trigger

When a user edits a writeback cell:
1. Check `WritebackIndex::contains(sheet_id, row, col)` → true
2. Check `IdRegistry::cell_id_at(sheet_id, (row, col))` → mint if needed
3. Create a `WritebackSubmission` with state = Draft
4. Store in the local `WritebackLayer`
5. The cell's display value comes from the draft (not from the upstream
   package content)

#### Override interaction

The edit guard from Phase 9 currently refuses ALL edits on writeback
cells. This phase changes the behavior:
- Writeback cells ARE editable, but edits go to the writeback layer
  (not the override layer)
- Override creation on a writeback cell is still refused
- The distinction: "is this a writeback edit or an override attempt?"
  depends on whether the cell is in a writeback region

**Files:**
- `core/calp/src/writeback.rs` — submission types, writeback layer
- `core/calp/src/registry.rs` — submission storage operations
- `app/src-tauri/src/lib.rs` — writeback layer in AppState
- `app/src-tauri/src/calp_commands.rs` — submit, save draft, load
  submissions
- `app/src-tauri/src/commands/data.rs` — update_cell routes writeback
  cells to writeback layer instead of override layer
- `app/extensions/Distribution/index.ts` — edit guard now allows
  writeback edits (routes to writeback layer)
- `core/calp/src/identity_provider.rs` — identity for submissions

**Tests:**
- Write to writeback cell → creates draft in writeback layer
- Write to non-writeback cell → normal behavior
- Override on writeback cell → still refused
- CellId auto-minted on first submission
- Draft round-trips through save/load
- Registry submission storage write/read
- Submission manifest aggregates correctly

---

### Phase 15: Submit Gesture and Side Pane

**Goal:** Add the UI for the writeback lifecycle: viewing regions,
submitting drafts, seeing submission state.

**Scope:**

#### Submit gesture

- "Submit" command: advances a draft to Submitted state
- Available via:
  - Button in the writeback side pane
  - Right-click context menu on writeback cells
  - Keyboard shortcut (configurable)
- Region-scoped: submitting region X does not submit region Y
- "Submit All Drafts" bulk action

#### Writeback side pane

New task pane parallel to the Overrides pane:
- Lists all writeback regions in the workbook
- Shows per-region state: Empty / Draft / Submitted / Approved / Rejected
- Shows deadlines (from lifecycle policy)
- Shows visibility settings
- For publishers viewing their own packages: aggregate submission status

#### Submission to registry

When a draft is submitted:
1. Change state from Draft to Submitted
2. Write to registry via `save_submission()`
3. Update local writeback layer to reference registry copy
4. Record in audit log

**Files:**
- `app/extensions/Distribution/components/WritebackPane.tsx` — new pane
- `app/extensions/Distribution/components/SubmitDialog.tsx` — optional
  confirmation dialog
- `app/extensions/Distribution/index.ts` — register pane, menu items,
  context menu actions
- `app/src/api/distribution.ts` — new API functions
- `app/src-tauri/src/calp_commands.rs` — submit commands

---

### Phase 16: GATHER Functions and Async Evaluation

**Goal:** Implement the GATHER() formula family that aggregates
writeback submissions across subscribers.

This is the most architecturally significant phase — it introduces the
first async formula evaluation path and the first formula that reaches
outside the local workbook.

**Scope:**

#### GATHER function family

- `GATHER(region_ref)` — returns all visible submissions for a region
- `GATHER.FROM(region_ref, submitter_id)` — one submitter's value
- `GATHER.COUNT(region_ref)` — count of submissions
- `GATHER.FROMS(region_ref)` — list of submitter identities

#### Evaluation model

Two-phase approach to avoid refactoring the entire evaluator to async:

1. **Pre-fetch phase** (async, before evaluation): Scan the formula AST
   for GATHER() calls. Fetch the required submission data from the
   registry. Cache in a `GatherCache` struct.
2. **Evaluate phase** (sync, existing pipeline): GATHER() functions
   read from the pre-populated `GatherCache` via a new closure on
   the `Evaluator`. No async needed inside the evaluator itself.

```
GatherCache {
  // Keyed by (package, version, region_id)
  data: HashMap<(String, String, String), Vec<WritebackSubmission>>,
  fetched_at: String,
}
```

The cache is:
- Per evaluation session (not per cell)
- Persisted in `.cala` for offline opening with last-known values
- Invalidated by a "Refresh Writeback Aggregates" command

#### Visibility enforcement

GATHER() results are filtered by the region's visibility policy:
- `OwnOnly`: subscriber sees only their own submission
- `OwnPlusAggregate`: subscriber sees own + aggregated rollup
- `Transparent`: everyone sees everything

The subscriber identity from Phase 13 determines filtering.

#### Engine integration

- Add `GATHER` variants to `BuiltinFunction` enum in
  `core/engine/src/functions.rs`
- Add evaluation implementations in the evaluator's function dispatch
- The pre-fetch/cache pattern avoids making the evaluator async

**Files:**
- `core/engine/src/functions.rs` — new enum variants
- `core/engine/src/evaluator.rs` — evaluation implementations, new
  `gather_cache` field on Evaluator
- `core/calp/src/writeback.rs` — `GatherCache` struct
- `app/src-tauri/src/formula.rs` — pre-fetch logic
- `app/src-tauri/src/calculation.rs` — pre-fetch on recalculate
- `app/src-tauri/src/calp_commands.rs` — refresh aggregates command

**Tests:**
- GATHER() with no submissions → empty result
- GATHER() with submissions from multiple submitters
- GATHER.COUNT returns correct count
- Visibility filtering: OwnOnly, OwnPlusAggregate, Transparent
- Cache invalidation on refresh
- Offline: cached values used when registry unavailable

---

### Phase 17: Refresh Integration and Version Binding

**Goal:** Handle writeback regions across package version changes.

**Scope:**

When publisher releases a new package version:
- New writeback regions appearing → surface in writeback pane
- Removed writeback regions → existing submissions marked obsolete,
  subscriber notified
- Modified writeback regions → handled per version binding policy:
  - `Strict`: submissions invalidated, must be redone
  - `Lenient`: submissions carry forward if schema compatible
- Schema compatibility check: same type, compatible bounds
- GATHER() aggregates refresh as part of the atomic refresh

**Files:**
- `core/calp/src/refresh.rs` — writeback-aware refresh logic
- `core/calp/src/writeback.rs` — schema compatibility check
- `app/src-tauri/src/calp_commands.rs` — refresh_apply updates
- `app/extensions/Distribution/` — UI for new/removed/modified regions

---

### Phase 18: Grid Visual Treatment and Polish

**Goal:** Fill in the Phase 9 no-op style interceptor with actual
writeback visual treatments, and polish the overall experience.

**Scope:**

#### Visual treatments (style interceptor)

- Writeback cell, empty: subtle "fillable" background tint
- Writeback cell, draft: tinted background + draft indicator
- Writeback cell, submitted: tinted background + submitted indicator
- Writeback cell, locked (post-deadline / non-editable): read-only
  treatment with explanatory tooltip

The interceptor already runs per-cell for subscriptions with writeback
regions. This phase changes the return value from `null` to the
appropriate style override based on the cell's writeback state.

#### Cell decoration

- Left-edge or corner badge distinguishing writeback from override
  visual treatments
- Tooltip on hover explaining the writeback state

#### Status bar integration

- When cursor is on a writeback cell: status bar shows region name,
  submission state, deadline

#### Audit integration

- Submission events recorded in audit log:
  Submit, Approve, Reject, SchemaChanged

**Files:**
- `app/extensions/Distribution/index.ts` — style interceptor return
  values, cell decoration registration
- `app/extensions/Distribution/lib/writebackStore.ts` — extend with
  per-cell state lookup (draft/submitted/approved)
- Status bar and tooltip integration

---

## Dependency Graph

```
Phase 10 (Typed fields) ──────────────┐
                                      ├──→ Phase 12 (Author UI)
Phase 11 (IdRegistry) ───────────────┤
                                      ├──→ Phase 14 (Submission storage)
Phase 13 (Subscriber identity) ──────┘         │
                                               ├──→ Phase 15 (Submit UI)
                                               │
                                               ├──→ Phase 16 (GATHER)
                                               │
                                               ├──→ Phase 17 (Refresh)
                                               │
                                               └──→ Phase 18 (Visuals)
```

Phases 10, 11, and 13 can proceed in parallel — they are independent.
Phase 12 depends on 10 (needs typed fields for the author dialog).
Phase 14 depends on 11 (IdRegistry) and 13 (subscriber identity).
Phases 15-18 depend on 14 (submission storage exists).
Phases 15, 16, 17, 18 can proceed in parallel once 14 lands.

## Risks and Open Questions

### R1: Evaluator pre-fetch vs. async refactor

The pre-fetch approach (scan AST, fetch data, then evaluate synchronously)
avoids a major refactor of the evaluator. The risk is formulas that
dynamically compute region references — e.g.,
`GATHER(INDIRECT("region-" & A1))`. Pre-fetch can't handle these
because the region reference isn't known until evaluation time.

**Proposed resolution:** v1.1 requires GATHER() region references to
be static (literal strings or named ranges). Dynamic references are a
v1.2 enhancement that may require the async evaluator refactor.

### R2: Registry concurrency — RESOLVED (2026-07-17, append-only event log)

Multiple subscribers may submit concurrently to the same registry — including
registries on SMB shares and cloud-sync folders (Dropbox/OneDrive), where file
locks break sync clients and concurrent rewrites of one path fork "conflicted
copy" files.

**Resolution shipped (NOT the flock proposal — locking is explicitly
rejected on submission paths):** the registry stores writeback as an
append-only event log with MVCC-style derived state:

- Every submission (submit, re-submit) is a NEW immutable file
  `submissions/{submitter}/{region}_{row}_{col}_{submission_id}.json`
  (model-keyed: `{region}_{keyhash16}_{id}.json`). Nothing is ever rewritten.
- Every publisher decision is a NEW immutable `reviews/{review_id}.json`
  ReviewEvent targeting one submission id. Publisher and submitters never
  write under the same path, and no path is ever written twice by anyone —
  so lost updates and sync conflicted-copies are structurally impossible.
- Current state is derived by a deterministic fold (`calp::fold`): grid slots
  collapse to the newest `(updated_at, id)` event; model events all remain
  records; review state is derived from review events only (stored state in a
  submission file is untrusted). A review whose target was superseded by a
  re-submit is inert — the slot folds back to Submitted ("approve what you
  saw"); the dashboard passes the reviewed submission id so a stale decision
  errors ("superseded") instead of deciding blind.
- Loaders are hygiene-filtered and skip (never error on) torn files,
  conflicted-copy renames, tmp debris, and files whose attribution doesn't
  match their directory.

The only mutable-file writes left are publisher-only: the package-manifest
read-modify-write (guarded by the existing `.calp-lock` publish lock, now also
around the rollup toggle) and the derived `_rollup.parquet` (regenerated
publisher-side only; self-healing). For future networked registries, the
append-only event log maps directly to POSTs — the server needs no locking
either.

### R3: Submission size and performance

A budget template with 1000 cells × 50 subscribers = 50,000 submissions
per version. Loading all of them for GATHER() aggregation could be
slow.

**Proposed resolution:** The submission manifest provides summary data
(counts, sums) without loading individual submissions. GATHER()
uses summary data when possible. Full submission loading is lazy and
cached.

### R4: Offline editing

Subscribers may edit writeback cells offline. Drafts are stored locally.
Submission requires registry access.

**Proposed resolution:** Drafts are first-class local state, persisted
in `.cala`. The submit gesture checks registry reachability and queues
if offline. Conflict resolution on reconnect follows the same pattern
as override rebasing.

### R5: IdRegistry integration scope

IdRegistry integration (Phase 11) is useful well beyond writeback. The
risk is scope creep — wanting to wire it into formula dependency
tracking, override anchoring, etc. while building Phase 11.

**Proposed resolution:** Phase 11 scope is strictly: add to AppState,
wire structural shifts, unblock rename/merge commands, add get/mint
commands. Other integrations happen in their own phases.

### R6: Schema validation at edit time

When a subscriber types into a writeback cell, the value should be
validated against the region's `ValueSchema` (type, bounds, enum).
This is a new validation path separate from Data Validation.

**Proposed resolution:** Implement as a commit guard that checks the
schema before accepting the edit. Reuses the guard infrastructure but
with writeback-specific validation logic. Part of Phase 14.

## Test Plan Overview

Each phase has its own test section above. Cross-cutting integration
tests that span multiple phases:

- **End-to-end publish-pull-write-submit-aggregate:** Publisher creates
  writeback package → subscriber pulls → subscriber fills cells →
  subscriber submits → publisher sees aggregated data via GATHER()
- **Multi-subscriber:** Two subscribers pull same package, each fills
  their slice, both submit, publisher sees both contributions
- **Version upgrade with writeback carry-forward:** Publisher releases
  v1.1 with lenient binding, subscriber's v1.0 submissions carry forward
- **Offline draft, online submit:** Subscriber edits offline, saves
  `.cala`, reconnects, submits successfully
- **Schema validation rejection:** Subscriber enters a value violating
  the region's schema → rejected at edit time with clear message

## What This Plan Is Not

- It is not a timeline. Phase sizes vary enormously — Phase 14 and
  Phase 16 are each larger than all of Phase 9.
- It does not cover networked/remote registries. All registry operations
  are local filesystem. Remote registry support is a separate project.
- It does not cover approval workflows beyond simple state transitions.
  The `OnApproval` submission policy stores the state; the approval UI
  and workflow engine are future work.
- It does not cover Pattern 2 (shared scalar editing) or cross-package
  writeback aggregation. These are explicitly out of scope per the
  design doc.
