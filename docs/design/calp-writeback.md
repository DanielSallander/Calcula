# .calp Writeback - Design Document

## Status

**Implemented** (v1.1). See `calp-v1.1-writeback-implementation.md` for
phase-by-phase status. This document was originally written ahead of v1.0
to ensure the necessary doors were left open.

> **Documentation audit 2026-08-16.** Re-verified against code. The scope
> decisions, three-layer model, manifest declarations, storage layout, fold
> semantics and the GATHER family all hold. Three things do not, and are marked
> `CORRECTED 2026-08-16` where they appear:
>
> 1. **`list_object` mode was never implemented.** The variant exists in the
>    type and round-trips through the manifest; nothing reads it.
> 2. **The GATHER cache is NOT persisted in the `.cala`.** It is in-memory only,
>    so "offline opening with last known aggregates" does not happen.
> 3. **The v1.0 prerequisite that edits be REFUSED on writeback cells was
>    deliberately reversed in v1.1** — writeback cells are editable, which is
>    the entire point of the feature. The prerequisite was correct for v1.0 and
>    is now historical.
>
> Separately: `GATHER.AT` — the function this document singles out as the
> primitive making tabular consolidation possible — works but is missing from
> the function catalog, so no user can discover it. Filed as **BUG-0095**.

> **Subscriber UX rework 2026-10-21.** The owner's test (subscribe, type 1, 2, 3
> into B3:B5) showed nothing that said whether the values were written back. The
> causes and the new surface are in **UI** below: region ids are now the
> subscriber's LOCAL sheet ids, a single-cell entry saves a draft, the full-cell
> tints are replaced by one "w" frame per region (first a dashed outline, which
> read as the copy marquee) plus a small marker on
> unsent and rejected cells, and a contextual **Writeback** ribbon tab carries
> Submit, Submit All, Discard Drafts and Check Status. A working copy (Open
> Application for Editing) now keeps the application's regions -- checkout used to
> drop them, so the author saw none and the next push would have published the
> application WITHOUT its writeback regions -- and the author sees the frame on
> their own designated regions too.

## Motivation

The v1.0 collaboration system is read-only from the consumer perspective:
subscribers consume published applications and may override locally, but
contributions do not flow back to the publisher or to other subscribers.
Writeback extends the model to support collaborative input: regions of a
published application designated by the publisher as "subscriber-fillable,"
where subscriber input is collected and aggregated.

The motivating scenarios are corporate: budget templates filled in by region,
forecast inputs collected from sales managers, headcount plans submitted by
department heads. The pattern that exists today is "publisher emails a
template, collects filled-in copies by email, manually consolidates."
Writeback replaces that workflow.

Writeback is the second half of Calcula's founding answer to Excel's
distribution problem: distribution out, contributions back, through the
same channel.

## Scope Decisions

### Only Pattern 1 is supported

Two distinct collaborative patterns exist conceptually:

- Pattern 1: Each subscriber owns a slice. No two subscribers edit the same
  semantic value. Conflict-free by construction.
- Pattern 2: Multiple subscribers edit a single shared scalar. Has no clean
  solution without real-time collaboration machinery.

Writeback supports only Pattern 1. Pattern 2 is explicitly out of scope.

Pattern 1 is realized in two flavors:

- **Per-subscriber writeback**: each subscriber's contributions live in a
  private slot keyed by their identity. The cell at A1 in subscriber A's
  workbook and the cell at A1 in subscriber B's workbook are different slots.
- **List-object writeback**: the cell holds a list-object structure, each
  subscriber appends an entry tagged with their identity. Aggregation
  functions roll up across entries.

Both flavors avoid scalar conflicts by construction.

### Push, not pull

Writeback transport is push: subscribers save, contributions flow to the
workspace, the workspace indexes them, other subscribers and the publisher see
current aggregates. Pull is not a configurable alternative.

A separate, deliberate "writeback patch export/import" mechanism exists for
air-gapped or offline subscribers, paralleling the override export feature.
This is a sideline, not the primary flow.

### Writeback regions are publisher-declared

The publisher declares writeback regions in the `.calp` manifest at publish
time. Consumers cannot turn arbitrary cells into writeback cells.

### Writeback regions are positional, not identity-anchored

Writeback regions are declared as positional ranges on a sheet
(SheetId + row range + column range). They are not anchored to CellIds at
declaration time, because cells in writeback regions are typically inputs
with no incoming references and therefore have no CellIds under the lazy
minting rules.

In v1.1, when a submission is created for a writeback cell, a CellId is
minted at that point (a new auto-mint trigger: "cell received a writeback
submission") and the submission anchors to it for future structural-shift
tracking. v1.0 does not need this trigger because v1.0 has no submissions.

### Writeback requires authenticated subscribers

The workspace must be able to attribute submissions to identified subscribers.
This typically falls out of corporate SSO/AD authentication. Writeback
applications cannot be published to anonymous public workspaces.

## Three-Layer Model

The full data model after writeback lands has three layers:

1. **Upstream application content** - immutable, versioned, signed. Lives in
   `.calp`.
2. **Consumer overrides** - private to one subscriber's `.cala`. Rebased on
   refresh.
3. **Writeback contributions** - shared via the workspace. Indexed by
   `{package_id, version, region, submitter}`. Bound to a specific application
   version.

Overrides and writeback are deliberately separate systems despite surface
similarity. Key differences:

- Overrides are private; writeback is shared.
- Overrides rebase across versions; writeback is version-bound.
- Overrides apply to any cell; writeback only to designated regions.
- Overrides live in the workbook; writeback lives in the workspace.
- A consumer can override any unlocked cell; a consumer cannot override a
  writeback cell (the cell is theirs to fill, not the publisher's to be
  shadowed).

## Manifest Declarations

The `.calp` manifest declares writeback regions. Each region has:
WritebackRegion {
  id: WritebackRegionId,           // UUID v7
  selector: RegionSelector,         // (SheetId, row range, col range)
  mode: WritebackMode,              // per_subscriber | list_object
  schema: ValueSchema,              // type and validation
  visibility: VisibilityPolicy,
  submission_policy: SubmissionPolicy,
  version_binding: VersionBinding,
  lifecycle: LifecyclePolicy,
  aggregation_hint: Option<String>, // documentation for the publisher's
  // aggregation formula
}
### Mode

- `per_subscriber` - private slot per submitter; publisher aggregates via
  `GATHER()` family of functions
- `list_object` - shared list-object cell; each submitter appends one entry

> **CORRECTED 2026-08-16 — `list_object` was designed but NEVER BUILT, and
> the field it is declared in is dead.** `WritebackMode` exists
> (`core/calp/src/writeback.rs:21`) and `mode` round-trips through the signed
> manifest, but **no production code reads `decl.mode`** — every reference to
> it outside a serde round-trip test is in `writeback.rs`'s or `manifest.rs`'s
> own tests. A region declared `list_object` therefore behaves silently as
> `per_subscriber`. The 2026-06 review recorded this as finding **3D** and
> closed it the honest way, by removing `ListObject` from the Designate
> Writeback dialog (roadmap #14) so an author cannot pick an option that lies;
> full structured multi-column regions were deferred as an L-effort redesign of
> the region model. The design below is retained because that redesign is still
> the intended destination — but nothing today implements it, and a
> hand-written manifest that sets the field gets `per_subscriber` semantics
> with no warning.

### Schema

- Type: number, integer, text, date, boolean, enum
- For enum: list of allowed values
- Required vs optional
- Min/max bounds for numbers
- Regex or length limits for text
- Date range for dates

### Visibility

- `own_only` - subscribers see only their own contribution; publisher sees all
- `own_plus_aggregate` - the publisher sees all; other subscribers see every
  value WITHOUT the submitter's name (GATHER anonymizes identities to
  "Submitter N" -- `apply_gather_governance`, `calp_commands.rs`). It is NOT
  "totals only": an aggregate needs the values, and they flow. The subscriber
  is told exactly that ("The publisher sees your values; other subscribers see
  each value without your name").
- `transparent` - everyone sees everyone's individual contributions
- `role_based` - custom roles defined by publisher (deferred beyond v1.1)

Default: an unset visibility applies NO filter -- it is `transparent`
(`writeback_region_entries` resolves a missing value to
`VisibilityPolicy::Transparent`, and the subscriber's tab says "Everyone
subscribed can see your values"). A publisher who wants less must declare it.

### Submission policy

When does a contribution become visible to others?

- `immediate` - on save: typing IS submitting. The subscriber is told at the
  point of entry ("B3 sent to <application>"), the tab's Status says "values are
  sent as you type", and a send that FAILS keeps the value as an unsent draft
  (`calp_save_writeback_draft` returns `sendError` rather than refusing a
  value it saved; the marker shows it and Submit retries)
- `on_submit` - explicit submit action (separate from save); save without
  submit is private draft
- `on_approval` - submission queued for publisher approval before joining
  aggregate

Default: `on_submit`. Draft state is private to the subscriber.

### Version binding

When publisher releases a new application version:

- `strict` - submissions invalidated, must be redone
- `lenient` - submissions carry forward if region schema is compatible
- `per_region` - publisher decides per region in the new manifest

Default: `lenient`. Schema compatibility check is mechanical (same type,
compatible bounds).

### Lifecycle (re-edit policy)

After a contribution is submitted, can it be edited?

- `always` - re-submission overwrites previous
- `until_deadline` - publisher sets a cutoff timestamp
- `never` - one-shot
- `requires_unlock` - publisher must explicitly unlock for re-edit

Default: `until_deadline` with no deadline set (effectively `always`).
Publisher can set a deadline when authoring.

## Submission Identity and Storage

A writeback contribution is:
  WritebackSubmission {
  id: SubmissionId,
  package_id: PackageId,
  package_version: Version,
  region_id: WritebackRegionId,
  cell_id: CellId,                  // minted on first submission
  submitter: SubmitterIdentity,
  value: SubmissionValue,
  state: SubmissionState,           // draft | submitted | approved | rejected
  created_at: Timestamp,
  updated_at: Timestamp,
  submitted_at: Option<Timestamp>,
  approved_at: Option<Timestamp>,
}
For per-subscriber mode, `(package_id, version, cell_id, submitter)` is
unique as a CURRENT-STATE key: each subscriber has at most one current
contribution per cell per version.

For list-object mode, the same key identifies the entry within the list-object
cell that belongs to that subscriber. Re-submission supersedes the entry.

Submissions live in the workspace, not in subscribers' `.cala` files. The
local `.cala` may cache the subscriber's own draft state for offline editing,
but the canonical store is workspace-side.

### Workspace storage: append-only event log (2026-07-17)

The workspace never rewrites a submission. Physical layout per application
version:

```
{workspace}/{application}/{version}/
  submissions/{submitter_id}/                # ONLY that submitter writes here
    {region}_{row}_{col}_{submission_id}.json    # grid submission event
    {region}_{keyhash16}_{submission_id}.json    # model-keyed (writeback column) event
    _rollup.parquet                              # derived, publisher-written only
  reviews/                                   # ONLY the publisher writes here
    {review_id}.json                             # one ReviewEvent per decision
```

Every submit, re-submit, and publisher decision is a NEW immutable file;
each path has exactly one writer and no path is ever written twice. This is
what makes shared workspaces safe on SMB shares AND cloud-sync folders
(Dropbox/OneDrive) with **no locking anywhere on submission paths**: a sync
client only ever sees new files appear, so lost updates and "conflicted
copy" forks are structurally impossible.

Current state is DERIVED (database-style MVCC) by the deterministic fold in
`calp::fold::fold_submissions`:

- grid slots collapse to the newest `(updated_at, id)` event per
  `(submitter, region, row, col)` — older events remain on disk as history;
- model-keyed events are never collapsed (multi-user collection keeps every
  submission; masterData resolves newest-approved-wins downstream);
- review state comes ONLY from `ReviewEvent`s targeting a submission id —
  the state stored inside a submission file is untrusted, and a review whose
  target was superseded by a re-submit is inert (the slot folds back to
  Submitted: the publisher approved what they saw, not what came later);
- loaders are hygiene-filtered: torn files, conflicted-copy renames, tmp
  debris, and files whose attribution doesn't match their directory are
  skipped, never an error.

## Aggregation: the GATHER Function Family

Writeback introduces formula functions that reach across subscriber boundaries.
These execute against workspace-side data, not local workbook state.

- `GATHER(region_ref)` - returns a list-object of all visible submissions
  for the region (every cell × every submitter)
- `GATHER.AT(region_ref, row, col)` - all visible submitters' values for ONE
  input cell (1-based absolute coordinates). `SUM(GATHER.AT(region, r, c))`
  consolidates a single line item across all contributors — the primitive
  that makes per-line-item / tabular consolidation possible.
- `GATHER.FROM(region_ref, submitter_id [, row, col])` - one submitter's
  value; with the optional `row, col` it returns their value for a specific
  cell (the unambiguous form for multi-cell regions)
- `GATHER.COUNT(region_ref [, row, col])` - count of submissions for the
  region, or for one cell
- `GATHER.SUBMITTERS(region_ref [, row, col])` - submitter display names for
  the region, or for one cell

The publisher uses these in their application formulas to roll up writeback into
visible aggregates: a sum across regional forecasts, a per-line-item total via
`GATHER.AT`, an average of submitted estimates, a count of who has submitted.

> **Coordinate convention:** `row`/`col` are 1-based ABSOLUTE sheet coordinates
> (matching `ROW()`/`COLUMN()` and cell addresses), so
> `GATHER.AT("region", ROW(B2), COLUMN(B2))` targets B2. They are converted to
> the 0-based region/workspace coordinates internally.

> **CORRECTED 2026-08-16 — all five functions exist, but `GATHER.AT` is
> UNDISCOVERABLE.** Verified present in the parser
> (`core/parser/src/ast.rs:1019-1023`), the renderer (`ast.rs:1568-1572`) and
> the evaluator (`core/engine/src/evaluator.rs:1987`, with dedicated tests. The
> function catalog, however — `BuiltinFunction::all_catalog_entries()`,
> documented in its own header as "the **single source of truth** for the
> function catalog" — lists only four of them (`ast.rs:2412-2415`) and omits
> `GATHER.AT`. So the one function this section calls out as "the primitive that
> makes per-line-item / tabular consolidation possible" never appears in
> autocomplete or the Insert Function dialog, and `get_function_template`
> falls through to a bare `=GATHER.AT()` with no argument placeholders while its
> four siblings get generated templates. It works perfectly if you already know
> to type it. Filed as **BUG-0095** (open); the fix is one catalog entry plus
> the enum-vs-catalog exhaustiveness test that does not currently exist.

`GATHER` functions are subject to the region's visibility policy: a
subscriber calling `GATHER` on an `own_only` region sees only their own
submission.

### Evaluation model

Calling `GATHER` is the first formula primitive that reaches outside the
local workbook. The engine needs an async/workspace-aware evaluation path for
these functions specifically.

- Results are cached per evaluation session; the engine does not refetch on
  every formula recompute within a session.
- A "refresh writeback aggregates" command invalidates the cache and refetches.
- ~~Offline: cached values are used; a warning indicator surfaces in the UI.~~
- ~~The cache is part of the local `.cala` to allow offline opening with last
  known aggregates.~~

> **CORRECTED 2026-08-16 — the last two bullets were NEVER BUILT.** The cache is
> `AppState.gather_cache`, typed
> `Mutex<Option<(std::time::Instant, HashMap<String, GatherRegionData>)>>`
> (`app/src-tauri/src/lib.rs:632`) and initialised to `None` at
> `create_app_state` (`lib.rs:808`). An `Instant` is not serialisable and
> nothing writes this map into the archive — it is **in-memory only and starts
> empty on every launch**. There is no "data as of" or staleness indicator
> either; the 2026-06 review proposed one and it was explicitly deferred as
> infra (roadmap #15).
>
> **What actually happens, and why this has not bitten yet.** On a cold open
> `build_gather_data` finds no cache, returns an EMPTY map and queues a
> background rebuild (`app/src-tauri/src/calp_commands.rs:10709-10718`); when
> the worker finishes and the fingerprint changed, every sheet is recalculated
> and repainted. For a **local** workspace — a directory on disk, which is the
> only workspace that can receive submissions at all — that round-trip is fast
> and offline is a non-issue, which is why the missing persistence has stayed
> invisible. The gap is real for an **HTTP** workspace: it is read-only so it
> never holds submissions today, and an unreachable one is put on a 5-minute
> backoff (`GATHER_REGISTRY_BACKOFF`, `calp_commands.rs:10563`) rather than
> paying a 30s connect timeout per artifact per TTL window.
>
> The consequence to keep in view if HTTP workspaces ever accept writeback: for
> the window before the first rebuild lands, and indefinitely while a workspace
> is unreachable, `SUM(GATHER(...))` evaluates over zero submissions and shows
> **0 with no error and no indicator** — a wrong number that looks like a right
> one. Persisting the cache, or surfacing staleness, is what would close that;
> neither exists today.
>
> The first two bullets are accurate: results are cached per session with a
> 2-second TTL (`GATHER_CACHE_TTL`, `calp_commands.rs:10558`) and local
> mutations invalidate eagerly via `invalidate_gather_cache`.

This is the first crack in the "formula evaluation is local and synchronous"
model. Other workspace-aware functions may follow (live data feeds,
cross-application lookups). The async evaluation path must be designed as a
general capability, not a special case for `GATHER`.

## UI

### Grid treatment

> **REWRITTEN 2026-10-21.** The original plan below this note (a background tint
> per state, delivered through the style interceptor) was built and then
> removed: five saturated tints, two of them nearly identical, read as noise and
> glared on the Dark skin, and none of them said "not sent yet".

What a subscriber sees on a sheet that carries writeback regions:

- **One "w" frame per region** (the owner's design, 2026-10-21). A soft SOLID
  1px line round each region on the ACTIVE sheet, broken at the middle of every
  outer cell edge by a tiny "w" (9px). It replaced a dashed outline that read
  as the copy marquee. The line is the grid's cell text colour at 30% alpha and
  the "w" at 55%, so it follows every skin with no literal. No fill: the cells
  keep their gridlines and the publisher's formatting. A "w" is placed only on
  an edge cell wholly on screen along that edge and long enough to hold it;
  only visible rows/columns are walked. It is a grid LAYER under the selection
  (`collaboration:writeback-outline`, `lib/writebackOutline.ts`), frozen-pane
  correct through `@api/gridLayers` `rangeToCanvasRect`, and it is not
  painted on a canvas page.
- **The author sees it too.** The frame also covers the regions this workbook
  itself designated (`calp_get_writeback_draft_regions`, read by the same
  store), in a fresh workbook and in a working copy. Those get no marker and no
  tab: they hold no values.
- **A marker on cells that need attention.** A ~3px disc at the cell's
  top-right, inset to sit just LEFT of the 6px note/comment triangle so both
  stay visible, ringed in the cell's background colour, with a tiny "!" from
  DPR 1.5 up (`lib/writebackDecorations.ts`, an over-selection decoration at
  priority 6):
  - **draft** (typed but not sent -- including a CLEARED cell, which is a
    pending retraction): the WARN tone;
  - **rejected**: the DANGER tone;
  - submitted, approved and empty cells: no marker. "It was sent" is said by the
    tab's Status line, the success toast and the marker disappearing.
- Colours come from the active skin's tone tokens
  (`@api/appearance` `getCanvasToneColors()`), never literals.
- Both painters are registered only while the workbook HAS regions (the frame
  also while it has designated ones), so a workbook without writeback pays
  nothing per frame.

Locked cells (after a deadline, a one-shot region already sent) still have no
look of their own; an edit there is refused by the backend with its message.

**Typing.** A single-cell edit (a keystroke, F2, a double-click, the formula
bar) on a writeback cell is allowed, so the commit guard can coerce the value
by the region's declared type -- numbers in the APP locale (`@api/locale`
`parseNumber`, so sv-SE "1,5" is a number) -- and save it as a draft. Paste
(even of one cell, which would bypass the draft path), fill, drag and every
other bulk operation over a region are refused with: "These cells collect input
for "<application>". Type into them one cell at a time; paste and fill are not
supported for writeback cells." The range guard tells an edit from a paste by
the operation kind Core passes it (`RangeGuardOperation`, `@api/editGuards`).
The Rust backstop (`ensure_writeback_draft_on_sheet`) refuses a write that
skipped the draft path with a matching message that names the cell in A1 form
(`writeback_cell_refusal`). The range refusals for clear, sort, merge and
shift (`claim_refusal`) name the application and the A1 range the same way,
with the region id only in parentheses. **One cell at a time also covers
clearing and Ctrl+Enter:** Delete on a single writeback cell is ENTERED as an
empty edit (Core's `commitGridCellText`, `core/lib/selectionOwner.ts`), so the
commit guard saves the pending retraction; Ctrl+Enter on a single writeback cell
commits through the commit guard (commit and stay), and Ctrl+Enter over a
selection that overlaps a region is refused with the range guard's message --
it used to drop the typed value silently (the batch path skips writeback cells).

**Refresh and Reset keep the subscriber's values.** Writeback cells are not
overrides (the override recorder skips them), so a refresh that replaces a
subscribed sheet with the publisher's content puts every writeback-layer value
back afterwards (`reproject_writeback_layer_onto_grids`, before the refresh's
recalculation; a cell the publisher turned into a formula is left alone), and
Reset to published keeps those cells exactly as it keeps a cell the author
unticked (`calp_reset_subscription`). Before, both blanked the cells while the
Draft / Submitted entries stayed in the layer.

**Region ids are LOCAL.** A pull gives the subscriber's sheets fresh ids, so
the region index maps each declaration's publisher sheet id to the local one
through the subscription ledger (`rebuild_writeback_index_inner`). A region
whose sheet is not (or no longer) attached is left out of the index entirely
-- never reported on "sheet 0". The frontend snapshot
(`lib/writebackStore.ts`) is keyed by that local id and resolves the active
sheet at check time, so inserting, moving or reopening sheets cannot misplace
it. Detaching a sheet (or a whole subscription) drops the unsent drafts of the
regions that leave the index, under the detach's own document change. Which
regions those are is read BEFORE the ledger changes, from the index AND the
signed-declaration mirror (so a deferred or mid-rebuild subscription's regions
are found too); when neither knows the application's regions the entries are
kept and the audit row says why. Both confirms (the sheet tab's Detach and the
Subscriptions pane's Detach all) say how many unsent values will be discarded.

### Submit gesture

When the submission policy is `on_submit` or `on_approval`, typing only saves
a PRIVATE draft in the `.cala`; nothing leaves the machine until Submit.
**What Submit means:** every draft of the region is checked again in Rust
against the signed declaration and the lifecycle, the publisher's custom check
(if any) runs, and the values are written as a new, never-rewritten event under
`{ws}/{app}/{ver}/submissions/{submitter}/`. From then on the publisher can
see them (Collected Responses), and the cells read "submitted" until the
publisher approves or rejects. One bad value refuses the whole batch.

Submit lives in three places, all region-scoped, all ending in a re-read of
the shared snapshot and a grid repaint:

- the contextual **Writeback** ribbon tab (below);
- the cell context menu: **Submit Writeback Values** on a writeback cell (the
  same action as the tab's Submit; greyed with the reason when nothing in the
  region is unsent);
- the Writeback pane's "Review & submit" and "Submit all".

Every submit door shows exactly which values leave the machine first: the tab,
the context menu and the pane's "Submit all" (which goes through the tab's own
`submitAllWriteback`) read `calp_preview_region_submission` and put the
destination application, the workspace, who it is sent as and the values
(`B3 = 1`, numbers in the app locale, up to 12, then a count) into a
`confirmAsync`, which fails closed; the pane's per-region "Review & submit"
shows the same preview inline and sends on "Confirm & send". (Except for an
`immediate` region, which sends as you type -- see Submission policy.)
A region whose publisher check has not been approved yet is stopped BEFORE the
confirm with an explanation, and the pane (where the consent lives) is opened.
After sending: "N values sent to <application>. The publisher can now see
them." -- or the backend's refusal.

### Writeback ribbon tab

A contextual ribbon tab labelled **Writeback** (panel id `writeback-tab`; the
top-level menu keeps the id `writeback`), accent `--tab-accent-writeback`
(#4338ca light, #a5b4fc dark; 4.5:1 on the ribbon frame in every built-in
skin), order 512 -- right of every other contextual tab. Files:
`app/extensions/Collaboration/manifest.ts` (`WritebackPanelDefinition`),
`components/WritebackTabSections.tsx`, `lib/writebackTab.ts` (visibility),
`lib/writebackTabModel.ts` (state and actions).

- **When it shows.** While Core's ACTIVE cell is inside a subscribed writeback
  region on the active sheet -- the Table Design shape: one gate, the hide is
  unconditional, re-derived when the cursor moves, when the active sheet
  changes, whenever the snapshot changes under a cursor that did not move (a
  subscribe bringing the first regions, a detach taking them away), and when a
  selection owner's claim starts or ends. It stands aside while a floating
  grid's cell holds the selection. It never takes the ribbon when it appears.
- **Badge.** The number of unsent values across the workbook; none at zero.
- **Submit** -- *Submit* (the drafts of the region under the cursor; its
  tooltip says how many and to which application) and *Submit All* (every
  region, one confirm listing them). Each is disabled with its reason in the
  tooltip when there is nothing to send.
- **Drafts** -- *Discard Drafts* for the region under the cursor
  (`calp_discard_writeback_drafts`): only DRAFT entries go; each cell returns
  to what the subscriber last SENT (that entry comes back, so the cell reads
  submitted/approved/rejected again) or to blank when nothing was ever sent;
  dependents recalculate in Rust. **Discard is not undoable and ENDS THE UNDO
  HISTORY** (Excel's rule for an action it cannot undo): the writeback layer is
  outside the undo graph, and the step that TYPED the value is still on the
  history, so Ctrl+Z then Ctrl+Y would write the discarded value back with no
  draft behind it. The tab confirms first and says so. It needs the workspace
  (to look up what was last sent): an unreachable workspace, or any version of
  the subscriber's submissions that cannot be read, refuses the discard whole.
  It is recorded in the audit trail (`WritebackInvalidated`, with the cells).
- **Status** -- two lines for the region under the cursor: its state ("<k> not
  sent" in the warn tone, "<k> rejected - fix and submit again", "Sent - waiting
  for the publisher's approval" under `on_approval`, "Sent - the publisher can
  see them" otherwise (a sent value counts at once there), "All approved", or
  "Nothing entered yet" -- with "(k of n filled)" while cells are still empty),
  with "- due <date>" (app locale) when it has a deadline; then who sees the
  input: own_only "Only the publisher sees your values", own_plus_aggregate
  "The publisher sees your values; other subscribers see each value without
  your name", transparent (and unset) "Everyone subscribed can see your values".
- **Responses** -- *Check Status* (one re-read of the shared snapshot -- every
  read reconciles with the workspace first, so it is ONE round-trip; "Status
  updated", or a warning naming why the workspace could not be reached, never a
  claimed update) and *Writeback Pane*.

**Markers.** A draft is a small warn-tone DISC, a rejected value a small
danger-tone SQUARE in the same place beside the note triangle -- different
shapes, so they read apart at 100% scaling and without colour; at high DPI the
disc carries a "!" and the square an "x".

The soak/invariant walk knows the label (`CONTEXTUAL_TAB_RULES.Writeback`,
`app/e2e/invariants/invariants.ts`: the tab may show only while the index holds
a region). The tab adds no task-pane context key, so the cascade census's
selection half does not govern it -- correctly: a writeback region is a
manifest declaration, not an object in the Rust dependency matrix, and its
disappearance reaches the tab through the snapshot, not a delete route.

**Out of scope for this version** (kept deliberately, not forgotten):

- **BI pivot writeback cells.** A model writeback column filled through a BI
  pivot has no draft (it sends on Enter) and no `@api` seam a Collaboration
  tab could ask; giving it a Submit button needs an owner decision first.
- **Cells owned by a floating grid.** The tab follows Core's active cell and
  stands aside while a floating grid holds the selection.
- **A status-bar item** for the region under the cursor.
- **A Ctrl+Enter submit shortcut.** (Ctrl+Enter keeps Excel's meaning, "commit
  and stay"; see Grid treatment.)
- **A hover tooltip on a marked cell** ("Not sent yet" / "Rejected: <reason>").
  There is no cell-hover seam in `@api`; the Status line and the pane say it.
- **A subscriber-side poll** for approve/reject decisions: they arrive on open,
  on a draft save, on Check Status and when the pane refreshes.

### Writeback side pane

A new side pane parallel to the overrides pane:

- Lists all writeback regions in the workbook
- Shows submission state per region (empty / draft / submitted / approved /
  rejected)
- Shows deadlines if set
- Shows visibility settings so subscriber knows who sees their input
- For publishers viewing their own applications: shows aggregate status across
  all submitters (who has submitted, who has not)

### Author UI (publisher)

The author needs an authoring mode to designate writeback regions:

- Select range, mark as writeback
- Configure mode, schema, visibility, policies
- Preview how the region appears to a subscriber

This UI work is substantial and is a major part of the v1.1 development.

## Interaction with Overrides

Override engine behavior at writeback cells:

- Override creation on a writeback cell is **refused**. The cell is the
  subscriber's input, not the publisher's value to override.
- A writeback cell's contents are stored in the writeback layer, not the
  override layer.
- If the publisher changes a writeback region's schema in a new version, and
  an existing submission is incompatible, the subscriber sees a "schema
  changed, please update your submission" prompt - not a conflict in the
  override sense.

This enforcement is in place from v1.0 even though writeback itself is v1.1,
because v1.0 will see manifests declaring writeback regions and must not
allow overrides on them.

## Interaction with Refresh

On refresh:

- New writeback regions appearing in upstream: surface in the writeback pane
  as "new regions awaiting input."
- Removed writeback regions: existing submissions for removed regions are
  marked obsolete; subscriber is notified.
- Modified writeback regions: handled per `version_binding` policy (strict or
  lenient).
- Aggregate values from `GATHER` functions refresh as part of the same
  atomic refresh.

## Audit and Telemetry

Writeback contributions naturally generate audit data: who submitted what
when. This is workspace-side and is required, not opt-in, for writeback
applications. Compliance and operational visibility are the whole point.

Specifically, the workspace retains:

- All submission events (create, update, submit, approve, reject)
- All submitter identities
- Timestamps
- Optionally: the values themselves vs. only metadata, configured per application

Retention policy is set per workspace (corporate IT concern).

## v1.0 Prerequisites

For v1.0 to leave doors open for v1.1 writeback:

1. The `.calp` manifest format reserves a `writeback_regions` field. v1.0
   parsers must accept, validate, and round-trip the field (including
   opaque sub-fields).
2. The edit/range guards registered by the Collaboration extension must refuse
   edits on any cell falling within a declared writeback region, even though
   v1.0 has no other writeback behavior. Backend mutation paths that bypass
   frontend guards (find-and-replace at minimum) must consult the same index.

   > **SUPERSEDED 2026-08-16 by v1.1 Phase 14 — deliberately, not by drift.**
   > The EDIT guard is gone: writeback cells ARE editable (the subscriber fills
   > them). A commit guard took its place (`registerCommitGuard` in
   > `app/extensions/Collaboration/index.ts`): it coerces the typed value by the region's DECLARED
   > `valueType`, runs the publisher's advisory custom validator, saves a draft,
   > and keeps the user in edit mode on rejection rather than displaying a value
   > that was never saved. The RANGE guard survives and still refuses range
   > operations overlapping a writeback region (`context.grid.rangeGuards.register`
   > in the same file; since 2026-10-21 it lets a single-cell EDIT through and
   > refuses paste, fill and every bulk operation -- see **UI**).
   >
   > The backend backstop went much further than "find-and-replace at minimum":
   > seven helpers now exist — `ensure_writeback_draft_before_write`,
   > `…_on_sheets`, `…_before_grid_install`, `ensure_range_unclaimed`,
   > `…_on_sheets`, `ensure_cells_unclaimed`, `…_on_sheet`
   > (`app/src-tauri/src/calp_commands.rs:8694-8964`) — called from **33 sites**
   > across `commands/data.rs`, `commands/search.rs`, `commands/structure.rs`
   > and `merge_commands.rs`. The prerequisite's instinct that find-and-replace
   > was "the known one" and a survey would find others was right by an order of
   > magnitude.
   >
   > One artifact of the reversal stayed user-visible until 2026-10-21: the
   > range guard's message read "Some cells in this range are reserved for
   > input in a future version" -- v1.0 wording that outlived the version it
   > described. It now names the application and says what to do instead
   > (`writebackBulkRefusalMessage`, `lib/writebackGuards.ts`).
3. *(Superseded 2026-10-21: the visual treatment is a grid layer and a cell
   decoration, not the style interceptor -- see **UI**.)* The style interceptor pipeline is the delivery mechanism for any future
   writeback visual treatment. v1.0 registers a writeback-aware interceptor
   with a no-op return for writeback cells; v1.1 fills in the visual.
4. Cell identity (CellId) for writeback cells is not minted in v1.0 because
   no submissions exist to anchor. v1.1 will add a new auto-mint trigger
   ("cell received a writeback submission") at that point.

Captured in detail in `calp-v1.0-writeback-readiness.md`.

## Out of Scope for v1.1

- Pattern 2 (genuine shared scalar editing)
- Role-based visibility beyond the four built-in modes
- Approval workflows beyond simple approve/reject
- Cross-application writeback aggregation (e.g., an application that aggregates
  submissions from another application's writeback)
- Programmatic submission via API (workspace HTTP endpoints for non-Calcula
  clients)

These may come in later versions.