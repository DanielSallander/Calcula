# .calp v1.0 Writeback Readiness - Design Document

## Status

Active. Modifies the completed v1.0 implementation to reserve space for v1.1
writeback. No new user-facing functionality. Implementation should be small
and surgical.

## Context

Writeback is a v1.1 capability documented in `calp-writeback.md`. For v1.1
to land cleanly without a format migration or special-case retrofitting,
v1.0 must:

1. Parse and preserve writeback region declarations in `.calp` manifests
2. Prevent edits on cells within writeback regions (frontend guards plus
   backend backstops on paths that bypass frontend guards)
3. Plumb writeback-region awareness through the existing style interceptor
   pipeline as a no-op interceptor, so v1.1's visual treatment is a return
   value change, not a pipeline change
4. Confirm cell identity behavior is correct for writeback regions

None of these add user-visible behavior in v1.0. They prevent v1.1 from
being painful.

## Architecture Alignment

These changes follow the v1.0 architecture as it actually exists:

- The Distribution extension owns subscription state and is the natural
  owner of the writeback index.
- The frontend extension API uses edit guards and range guards registered
  by extensions in `activate()`.
- Cell render styling is delivered via the style interceptor pipeline,
  not via a CellRenderHints struct.
- Mutation paths that bypass frontend guards (notably find-and-replace,
  which lives entirely in the backend) must consult their own backend-side
  view of the writeback index.

The readiness work does not introduce new architectural patterns; it
extends existing ones.

## Changes

### 1. Manifest format extension

The `.calp` manifest schema gains an optional `writeback_regions` field:
writeback_regions: Option<Vec<WritebackRegionDeclaration>>

Where `WritebackRegionDeclaration` is:
WritebackRegionDeclaration {
id: WritebackRegionId,            // UUID v7
selector: RegionSelector,          // (SheetId, row range, col range)
// All other semantic fields are typed as opaque JSON values in v1.0
// and stored/round-tripped without inspection:
mode: serde_json::Value,
schema: serde_json::Value,
visibility: serde_json::Value,
submission_policy: serde_json::Value,
version_binding: serde_json::Value,
lifecycle: serde_json::Value,
aggregation_hint: Option<String>,
#[serde(flatten)]
extra: HashMap<String, serde_json::Value>,
}

In v1.0, only `id` and `selector` are interpreted. The other fields are
parsed as opaque JSON values, stored, and round-tripped on save/republish
without inspection. v1.1 gives them strongly-typed schemas.

`RegionSelector` is positional, not identity-based:
RegionSelector {
sheet_id: SheetId,
row_start: u32,
row_end: u32,        // inclusive
col_start: u32,
col_end: u32,        // inclusive
}

The selector is evaluated at manifest load; the resulting cell-position set
is cached for the lifetime of the loaded workbook in the writeback index.

#### Forward-compatibility hatches

Add `#[serde(flatten)] pub extra: HashMap<String, serde_json::Value>` to:

- `VersionManifest` (the top-level manifest struct)
- `WritebackRegionDeclaration` (already shown above)
- `Subscription` and `OverrideRecord` (any other manifest-adjacent
  persisted struct that v1.1 might extend)

The Phase 9 survey should produce the full list of structs that get this
treatment. The rule: any struct that's persisted to a file or wire format
and the consumer didn't author themselves gets a flatten-extras escape
hatch. Pure in-memory structs reconstructed from other state each session
do not.

Cost is negligible (empty HashMap, serializes to nothing). Benefit is
avoiding silent data loss when v1.1 extends the format.

### 2. Writeback index

A new struct `WritebackIndex` lives in `core/calp/src/writeback.rs`. It is
standalone — not nested inside the override layer, even though they share a
downstream symptom (refusing certain edits). Override-refusal and writeback
are distinct concerns and will diverge in v1.1.

Shape:
pub struct WritebackIndex {
// Per sheet: list of positional ranges that are writeback-designated.
// Lookup is "is (row, col) on sheet X covered by any range?"
regions_by_sheet: HashMap<SheetId, Vec<PositionalRange>>,
}
impl WritebackIndex {
pub fn contains(&self, sheet_id: SheetId, row: u32, col: u32) -> bool;
pub fn regions_overlapping(&self, sheet_id: SheetId, rng: PositionalRange)
-> Vec<&PositionalRange>;
// Built from a slice of WritebackRegionDeclaration at manifest load.
pub fn from_declarations(decls: &[WritebackRegionDeclaration]) -> Self;
}

Storage: `AppState` gains `Mutex<WritebackIndex>`. The index is rebuilt on
subscription pull, subscription refresh, and subscription removal.

The frontend obtains a snapshot of the index via a new Tauri command
(`get_writeback_index` or similar) and caches it for fast guard evaluation.
The cache is invalidated on subscription state-change events that the
Distribution extension already listens to.

Reasoning over alternatives: putting the index inside `OverrideLayer`
conflates two separate concerns; passing the data per-call (as v1.0
`is_locked` does) doesn't scale to whole-sheet writeback regions and runs
on every edit; a standalone index module is the clean shape.

### 3. Frontend edit and range guards

The Distribution extension registers an `editGuard` and a `rangeGuard` in
its `activate()`. Both consult the cached writeback index snapshot and
refuse edits on cells covered by any region.

Coverage of frontend guards:

- Direct cell edit
- Paste (single-cell and range)
- Fill-down and fill-series
- Drag-to-fill
- Cut/move (where the destination is a writeback cell)
- Range operations (clear, delete contents)

When a guard fires, the UX is:

- Single-cell edit: the edit is refused; a brief inline message or toast
  explains "This cell is reserved for input in a future version."
- Range operation with some writeback cells and some non-writeback cells:
  the operation completes for non-writeback cells, writeback cells are
  skipped, and a notification appears: "N cells in writeback regions were
  skipped because they're not editable in this version." This is the
  pattern that should also apply to find-and-replace (see below).

Refusing the whole operation when any cell in a range is writeback is too
heavy and will frustrate users. Partial success with explicit reporting is
the right balance.

### 4. Backend backstop for find-and-replace

Find-and-replace lives in the backend and bypasses frontend guards. The
backend `replace_all` and `replace_single` commands consult the
`WritebackIndex` in `AppState` before applying replacements.

Behavior on hit: skip the writeback cell, continue with the rest of the
operation, return a result that includes the count of skipped cells. The
frontend surfaces this in the standard partial-success notification.

The survey for Phase 9 should enumerate every backend mutation entry point
and confirm whether each one routes through code paths that frontend guards
have already vetted (in which case no backend check needed) or whether it
mutates cells without that vetting (in which case a backend writeback check
is needed). Find-and-replace is the known one; the survey should look for
others.

Likely additional candidates to inspect: programmatic API entry points
exposed to extensions, clipboard paste through certain backend paths,
undo/redo if it doesn't replay through guards, batch import operations.

### 5. Style interceptor for writeback cells

The Distribution extension registers a style interceptor when at least one
subscription with writeback regions is active. The interceptor:

- Receives cell coordinates
- Consults the cached writeback index snapshot
- Returns `None` (no style override) for non-writeback cells
- Returns `None` for writeback cells in v1.0 (no visual)
- In v1.1, returns the writeback visual treatment

Registration is conditional: if no active subscription has writeback
regions, the interceptor is not registered at all. This keeps the
per-cell render cost at zero for the common case.

No changes to the style interceptor pipeline itself. The work is purely
in registering and authoring the Distribution extension's interceptor.

### 6. Cell identity behavior

No code change required. Confirm via test:

- Cells in writeback regions are not auto-minted CellIds in v1.0 (no
  trigger applies: they're not formula targets, not overridden, not
  formula content).
- *If* a cell in a writeback region happens to get a CellId for an
  unrelated reason (e.g., a formula elsewhere references it), the ID is
  stable across reloads and survives structural shifts — the same
  guarantees as any other identified cell.
- v1.1 will add a new auto-mint trigger for writeback cells: "cell
  received a writeback submission." That's a v1.1 change, not v1.0.

The TestRunner suite for Phase 9 includes a test that covers the second
bullet specifically: a writeback-region cell that gets an ID via cross-
reference behaves identically to a non-writeback cell with an ID.

## Implementation Plan

A single phase, Phase 9, in continuation of the existing phase numbering.

### Phase 9: Writeback Readiness

Order of work:

1. Extend manifest schema with `writeback_regions` field; add forward-
   compatibility `extra` flatten hatches to identified persisted structs.
2. Implement `WritebackRegionDeclaration` parsing (full struct, opaque
   sub-fields, extras).
3. Implement `RegionSelector` and `PositionalRange`.
4. Build `WritebackIndex` struct in `core/calp/src/writeback.rs`; wire
   into `AppState`; rebuild on subscription state changes.
5. Tauri command exposing index snapshot to frontend.
6. Distribution extension: cache management for index snapshot;
   invalidation on subscription events.
7. Distribution extension: register `editGuard` and `rangeGuard`.
8. Distribution extension: register conditional style interceptor with
   no-op return.
9. Backend backstop: writeback check in `replace_all` and `replace_single`;
   audit any other backend mutation entry points surfaced by the survey
   and add checks where needed.
10. Notification handling for partial-success operations (use existing
    pattern if present; minimal new UI if not).
11. TestRunner suites covering everything below.

### TestRunner suites

- Manifest with `writeback_regions` round-trips losslessly through
  save/load, including opaque sub-fields and unknown extras.
- Manifest without `writeback_regions` loads normally.
- Direct edit on a writeback cell is refused with the correct error.
- Paste, fill-down, drag-fill, cut, clear, delete-contents on writeback
  cells are refused; mixed-range operations partially succeed and report
  skip count correctly.
- Find-and-replace skips writeback cells and reports skip count.
- The style interceptor is registered when a writeback-bearing
  subscription is active; not registered otherwise.
- The style interceptor returns `None` for all cells in v1.0 (no visual
  change yet).
- Subscription refresh rebuilds the writeback index correctly.
- Subscription removal clears the writeback index (and unregisters the
  interceptor if no other writeback-bearing subscriptions remain).
- Cell identity stability for a writeback-region cell that gets a CellId
  via cross-reference.

## What This Change Is Not

- It is not writeback. No submission storage, no aggregation, no UI for
  submitting, no `GATHER` functions.
- It is not a partial v1.1. v1.1 still has substantial work: registry-side
  storage, `GATHER` functions, async evaluation, author UI, submit
  gestures, side pane.
- It is not a format version bump. Manifests with no `writeback_regions`
  field are valid. Manifests with the field are also valid. v1.0 consumers
  ignore the field's semantic content beyond the guards and the index.

## Rationale

Capturing these changes now, while v1.0 is fresh, avoids three classes of
v1.1 pain:

1. **Format silent data loss.** Without the `writeback_regions` field and
   the `extra` flatten hatches, v1.0 round-tripping a v1.1 manifest would
   strip fields the v1.0 parser doesn't know about. Adding the hatches
   now is the difference between v1.1 being a semantic upgrade and v1.1
   being a format upgrade.

2. **Override entanglement.** Without the guard, a v1.0 user could create
   overrides on cells the publisher intends to be writeback. v1.1 would
   inherit ambiguous semantics: is the override the user's writeback
   submission, or a private override? Refusing edits on writeback cells
   from day one keeps the layers clean.

3. **Render pipeline retrofitting.** Without the conditional style
   interceptor registration, v1.1's grid badge work would mean either
   introducing a new render concept or special-casing writeback in the
   render core. Registering a no-op interceptor now means v1.1 changes
   exactly one return value.

The total surface area of this change is small. The cost of skipping it
and retrofitting later is significantly larger.
