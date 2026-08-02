# .calp Writeback - Design Document

## Status

**Implemented** (v1.1). See `calp-v1.1-writeback-implementation.md` for
phase-by-phase status. This document was originally written ahead of v1.0
to ensure the necessary doors were left open.

## Motivation

The v1.0 distribution system is read-only from the consumer perspective:
subscribers consume published packages and may override locally, but
contributions do not flow back to the publisher or to other subscribers.
Writeback extends the model to support collaborative input: regions of a
published package designated by the publisher as "subscriber-fillable,"
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
registry, the registry indexes them, other subscribers and the publisher see
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

The registry must be able to attribute submissions to identified subscribers.
This typically falls out of corporate SSO/AD authentication. Writeback
packages cannot be published to anonymous public registries.

## Three-Layer Model

The full data model after writeback lands has three layers:

1. **Upstream package content** - immutable, versioned, signed. Lives in
   `.calp`.
2. **Consumer overrides** - private to one subscriber's `.cala`. Rebased on
   refresh.
3. **Writeback contributions** - shared via the registry. Indexed by
   `{package_id, version, region, submitter}`. Bound to a specific package
   version.

Overrides and writeback are deliberately separate systems despite surface
similarity. Key differences:

- Overrides are private; writeback is shared.
- Overrides rebase across versions; writeback is version-bound.
- Overrides apply to any cell; writeback only to designated regions.
- Overrides live in the workbook; writeback lives in the registry.
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

### Schema

- Type: number, integer, text, date, boolean, enum
- For enum: list of allowed values
- Required vs optional
- Min/max bounds for numbers
- Regex or length limits for text
- Date range for dates

### Visibility

- `own_only` - subscribers see only their own contribution; publisher sees all
- `own_plus_aggregate` - subscribers see their own + the aggregated rollup;
  publisher sees all
- `transparent` - everyone sees everyone's individual contributions
- `role_based` - custom roles defined by publisher (deferred beyond v1.1)

Default: `own_plus_aggregate`.

### Submission policy

When does a contribution become visible to others?

- `immediate` - on save
- `on_submit` - explicit submit action (separate from save); save without
  submit is private draft
- `on_approval` - submission queued for publisher approval before joining
  aggregate

Default: `on_submit`. Draft state is private to the subscriber.

### Version binding

When publisher releases a new package version:

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

Submissions live in the registry, not in subscribers' `.cala` files. The
local `.cala` may cache the subscriber's own draft state for offline editing,
but the canonical store is registry-side.

### Registry storage: append-only event log (2026-07-17)

The registry never rewrites a submission. Physical layout per package
version:

```
{registry}/{package}/{version}/
  submissions/{submitter_id}/                # ONLY that submitter writes here
    {region}_{row}_{col}_{submission_id}.json    # grid submission event
    {region}_{keyhash16}_{submission_id}.json    # model-keyed (writeback column) event
    _rollup.parquet                              # derived, publisher-written only
  reviews/                                   # ONLY the publisher writes here
    {review_id}.json                             # one ReviewEvent per decision
```

Every submit, re-submit, and publisher decision is a NEW immutable file;
each path has exactly one writer and no path is ever written twice. This is
what makes shared registries safe on SMB shares AND cloud-sync folders
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
These execute against registry-side data, not local workbook state.

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

The publisher uses these in their package formulas to roll up writeback into
visible aggregates: a sum across regional forecasts, a per-line-item total via
`GATHER.AT`, an average of submitted estimates, a count of who has submitted.

> **Coordinate convention:** `row`/`col` are 1-based ABSOLUTE sheet coordinates
> (matching `ROW()`/`COLUMN()` and cell addresses), so
> `GATHER.AT("region", ROW(B2), COLUMN(B2))` targets B2. They are converted to
> the 0-based region/registry coordinates internally.

`GATHER` functions are subject to the region's visibility policy: a
subscriber calling `GATHER` on an `own_only` region sees only their own
submission.

### Evaluation model

Calling `GATHER` is the first formula primitive that reaches outside the
local workbook. The engine needs an async/registry-aware evaluation path for
these functions specifically.

- Results are cached per evaluation session; the engine does not refetch on
  every formula recompute within a session.
- A "refresh writeback aggregates" command invalidates the cache and refetches.
- Offline: cached values are used; a warning indicator surfaces in the UI.
- The cache is part of the local `.cala` to allow offline opening with last
  known aggregates.

This is the first crack in the "formula evaluation is local and synchronous"
model. Other registry-aware functions may follow (live data feeds, cross-package
lookups). The async evaluation path must be designed as a general capability,
not a special case for `GATHER`.

## UI

### Grid treatment

Writeback cells are visually distinct from regular cells and from overrides:

- Regular cell: no decoration
- Overridden cell: left-edge stripe (existing v1.0)
- Conflicted cell: distinct color (existing v1.0)
- Writeback cell, empty: subtle "fillable" background tint
- Writeback cell, draft: tinted background + draft indicator
- Writeback cell, submitted: tinted background + submitted indicator
- Writeback cell, locked (post-deadline or post-submit when not allowed):
  read-only treatment with explanatory tooltip

The visual treatment is delivered through the existing style interceptor
pipeline, registered by the Distribution extension. In v1.0 the interceptor
is registered with a no-op return for writeback cells; v1.1 fills in the
visual.

### Submit gesture

When submission policy is `on_submit` or `on_approval`, a "Submit" command is
required to advance a draft to submitted state. This lives:

- As a button in the writeback side pane
- As a right-click action on writeback cells
- Possibly as a Ctrl+Enter shortcut on the cell

The command is region-scoped: submitting region X does not submit region Y.
A "Submit all drafts" affordance exists for bulk completion.

### Writeback side pane

A new side pane parallel to the overrides pane:

- Lists all writeback regions in the workbook
- Shows submission state per region (empty / draft / submitted / approved /
  rejected)
- Shows deadlines if set
- Shows visibility settings so subscriber knows who sees their input
- For publishers viewing their own packages: shows aggregate status across
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
when. This is registry-side and is required, not opt-in, for writeback
packages. Compliance and operational visibility are the whole point.

Specifically, the registry retains:

- All submission events (create, update, submit, approve, reject)
- All submitter identities
- Timestamps
- Optionally: the values themselves vs. only metadata, configured per package

Retention policy is set per registry (corporate IT concern).

## v1.0 Prerequisites

For v1.0 to leave doors open for v1.1 writeback:

1. The `.calp` manifest format reserves a `writeback_regions` field. v1.0
   parsers must accept, validate, and round-trip the field (including
   opaque sub-fields).
2. The edit/range guards registered by the Distribution extension must refuse
   edits on any cell falling within a declared writeback region, even though
   v1.0 has no other writeback behavior. Backend mutation paths that bypass
   frontend guards (find-and-replace at minimum) must consult the same index.
3. The style interceptor pipeline is the delivery mechanism for any future
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
- Cross-package writeback aggregation (e.g., a package that aggregates
  submissions from another package's writeback)
- Programmatic submission via API (registry HTTP endpoints for non-Calcula
  clients)

These may come in later versions.