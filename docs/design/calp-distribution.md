# .calp Distribution System - Design Document

## Status

**Implemented** (May 2026). Pre-production — no deployed users.

All core features from this design are implemented across the `identity`,
`calp`, and `calcula-format` crates, with Tauri commands and a
Distribution extension in the frontend. See `docs/design/calp-implementation-phases.md`
for phase-by-phase status and deferred items.

**July 2026 fidelity + transparency round:** publish/pull were audited
per-object-type, brought to full fidelity, and made loudly transparent about
anything they still cannot carry. See "Full-Fidelity Publish and
Transparency (2026-07)" below.

Backward compatibility with prior in-development formats is a non-goal.
When this design conflicts with existing code or data structures, the
existing code changes. No migration paths, no legacy-format readers,
no compatibility shims.

## Motivation

Distribution is one of Calcula's founding pillars. Excel never had a real
distribution model: sharing a workbook means emailing a copy, and the moment
it leaves your outbox you have lost control of it -- no versioning, no
controlled updates, twelve diverging copies of the truth. The `.calp` system
is Calcula's answer: publish/subscribe report distribution, and -- via
writeback (see `calp-writeback.md`) -- two-way data collection, so a
distributed report also gathers input back from its recipients instead of
relying on email round-trips.

## Overview

Calcula's report distribution model. Replaces the "copy of a workbook" paradigm
with a subscription-based system where `.calp` packages are manifests that
`.cala` workbooks subscribe to.

## Core Model

- **`.calp` package**: A manifest + content bundle published to a registry.
  Declares sheets, formulas, data, named ranges, version, and metadata. Immutable
  once published at a given version.
- **`.cala` workbook**: The user's working file. Contains materialized state
  (current values, formulas, formatting) plus subscription metadata and an
  override layer. Self-contained: opens and works offline.
- **Registry**: A location (SMB share, HTTP endpoint, Azure Blob, etc.) hosting
  `.calp` packages. Corporate-internal is the primary scenario; public registries
  are a thinner variant of the same machinery.

## Identity Model

Stable IDs are minted at creation time. Two distinct kinds of IDs exist:

### Cell-level IDs

A cell receives a cell-level ID automatically when any of the following becomes
true:

- A formula reference targets the cell (minted at parse time of the referencing
  formula)
- A user creates an override on the cell
- The cell contains a formula itself

Plain data cells with no incoming reference, no override, and no formula carry
no ID and are addressed positionally. A million-row CSV import yields a million
ID-less cells until something references one of them. The author never sees
or controls this decision; it is automatic and transparent.

### Reference-site IDs

Every reference site inside every formula receives an ID, unconditionally and
eagerly. This holds even in a standalone `.cala` with no subscriptions, because
any workbook may become a package later. Lazy minting at publish time would
mean rewriting every formula on publish and would prevent overrides from
anchoring to references that existed pre-publish.

The ID is on the range as a semantic unit, not on its endpoints. `A1:A10` is
one reference site with one ID. Extending it to `A1:A20` keeps the same ID
(same site, new bounds). Deleting and rewriting yields a new ID.

Dynamic references (`INDIRECT`, `OFFSET`, `INDEX` with computed targets) get
an ID on the call site itself but cannot offer stable target identity. Overrides
on cells reachable only through dynamic references anchor by `(sheet_id, cell_id)`
directly, bypassing the formula path. Documented limitation: dynamic-target
overrides do not benefit from semantic-aware diff during refresh.

### ID format

UUID v7. 128 bits, globally unique without coordination, time-sortable.
Time-sortability is leveraged for BTreeMap performance, debuggability, and
audit log ordering. Stored internally as `[u8; 16]`. On-disk encoding uses
varint or prefix compression because sheet-ID prefixes repeat heavily.
Never exposed in user-facing UI.

A 64-bit counter is insufficient because two unrelated publishers must be able
to publish packages whose IDs do not collide for any consumer subscribed to both.

### ID survival across structural shifts

Reference-site IDs track intent; the coordinates they resolve to may shift.
The rules:

- Insert that pushes a range down: `=SUM(A1:A10)` becomes `=SUM(A2:A11)`,
  reference-site ID unchanged.
- Insert inside the range: range expands, ID unchanged.
- Delete inside the range: range shrinks, ID unchanged.
- Delete that destroys the entire range: ID retained but marked broken,
  formula becomes `=SUM(#REF!)`. Any override anchored to the ID surfaces as
  a structural conflict on next refresh.
- Insert/delete entirely outside: no change.

For cell-level IDs: the override anchors to the ID, not the coordinate. Inserts
above the cell shift its address but the ID stays with the cell.

This is the heart of why the identity model exists. Coordinate-anchored overrides
scramble on every upstream row insert, which is the failure mode that makes
existing spreadsheet versioning tools unusable.

### ID persistence across publishes

IDs persist across publishes: v2 of a package preserves the IDs from v1, so
consumer overrides rebase cleanly. A deleted-and-recreated cell is a new cell
with a new ID; overrides on the old ID do not follow.

### Rename and merge

Internal API exists from Phase 1: `IdRegistry::rename(old, new)` atomically
rewrites all references, `IdRegistry::merge(survivor, absorbed)` consolidates
two IDs into one (used when upstream merges cells; consumer overrides on
either ID consolidate onto the survivor). Author-facing UI for invoking these
ships in Phase 6.

## Formula Storage

Formulas are stored as ASTs internally. String form exists only at the I/O
boundary: rendered from AST for display in the formula bar and grid; parsed
back to AST on commit. IDs live as metadata on AST nodes and are never visible
to the user.

This is required for stable reference-site identity. Maintaining IDs across
edits requires structural awareness of the formula; string-level diffing is
not sufficient. Sidecar storage of IDs alongside string formulas is rejected
because it creates two sources of truth and still requires parsing the string
to align metadata.

### Edit alignment

When the user commits an edited formula:

1. Parse the new string into an AST without IDs.
2. Structurally align the new AST against the previous AST: nodes that match
   by position and content inherit the previous IDs; unmatched nodes mint new
   IDs.
3. Heavy refactors (rewriting most of a formula) reset most IDs. This is
   correct behavior: a substantially rewritten formula expresses different
   intent and should be treated as new references.

### Pipeline impact

This change touches the formula parser, the evaluator, the dependency graph,
the renderer, and persistence. It is the largest single piece of work in
Phase 1.

## Dependency Graph

The dependency graph is keyed by stable identity. Every vertex is
`(sheet_id, cell_id)`. Cross-sheet support is built in from Phase 1; there is
no coordinate-keyed or single-sheet intermediate stage.

Plain data cells do not appear in the dep graph. By definition, if a cell is
in the graph it is either a formula or a reference target, and therefore has
a cell_id.

Coordinate-to-ID resolution happens only at the boundary: when a formula
string is parsed into an AST, or when the renderer asks where a given cell is
positioned right now. The internal graph never operates on coordinates.

## Subscription Behavior

A `.cala` may subscribe to multiple `.calp` packages. Each subscription
contributes sheets and/or named ranges that the workbook composes together.
Cross-package references are allowed; the registry tracks the resulting
dependency graph (declared, not strictly enforced in v1).

### Version pinning grammar

SemVer-style:
- `=2.3.1` - exact pin (default for new subscriptions)
- `>=2.0 <3.0` - range
- `~2.3` - latest patch in 2.3.x
- `^2.3` - latest minor in 2.x
- `latest` - always newest (discouraged but supported)

Major-version bumps signal "overrides may not survive."

### Refresh behavior

On workbook open: never block. If the registry is unreachable, open with last
known state. If reachable and updates are available, show a non-modal banner
with a one-click refresh.

Refresh is atomic across all subscriptions in a workbook: all-or-nothing. If
any subscription fails mid-pull, the entire refresh rolls back and the user
sees an error.

Before applying a refresh, show a refresh preview: cells changed, sheets added
or removed, named ranges added or removed, and which existing overrides will
become conflicts. The user confirms before the pull is applied.

### Detach

An explicit "detach from upstream" command strips the subscription manifest
from the `.cala`. The workbook becomes a standalone file with no upstream
link. Used for archival ("FY24 close, frozen") and for sending one-off
snapshots to recipients who cannot reach the registry.

## Override Layer

Overrides are stored in the `.cala` as a first-class structured layer, not as
overwritten values. Each override records:

- Target cell ID (or `(sheet_id, position)` if the cell has no ID at override
  creation time, in which case an ID is minted at that moment per the cell-level
  ID rules)
- Baseline value or formula at the time the override was created
- Current override value or formula
- Timestamp
- Author (if multi-user context applies)

### Override semantics

- Editing any cell originating from upstream creates an override.
- Editing a formula is an override of the same kind as editing a value;
  it rebases on refresh.
- Overrides anchor to cell IDs and follow structural shifts (publisher inserts
  a row above; the override moves with its cell).
- The publisher may mark cells or whole sheets as `locked-no-override` when
  overriding would compromise correctness (e.g., the calculation core of a
  financial model).
- An override that becomes identical to upstream after a refresh auto-clears
  back to normal state.

### Override export

Overrides are serializable independently of the workbook. A user can export
their override set as a patch artifact and apply it to another `.cala`
subscribed to the same upstream. The format is designed for this from Phase 3
onward.

## Conflict Resolution

A conflict is an override on a cell that upstream has also changed since the
override was made. Three resolution actions per conflict:

- Accept upstream (discards override)
- Keep override (override rebased onto new upstream baseline)
- See both (opens a side-by-side view)

Structural conflicts (e.g., upstream deleted a sheet the user has overrides
on) surface as their own category in the conflicts pane. For deleted sheets,
the user explicitly chooses: save the sheet locally (detaching just that sheet
from upstream) or accept the deletion (overrides on that sheet are discarded).

## UI: Overrides Pane

A side pane with three views (filterable or tabbed - implementation choice):

1. Overrides - all cells diverged from upstream. Grouped by sheet. Shows cell,
   upstream value, current value, timestamp. Right-click actions:
   revert-to-upstream, promote-to-upstream (UI affordance reserved; mechanism
   deferred).
2. Conflicts - the subset of overrides where upstream also changed. Visually
   distinct treatment in the pane and the grid.
3. Pending refresh changes - preview of what a refresh would apply, including
   which current overrides would become conflicts.

### Grid badges

- Overridden cell: subtle indicator (left-edge stripe or small corner mark)
- Conflicted cell: louder indicator (distinct color)
- Cell that returned to matching upstream: auto-clears

## Security and Trust

- `.calp` packages may be signed; the registry enforces signing policy.
- Packages with executable content (formulas reaching external data,
  extensions/macros when those land) prompt the user on first refresh per
  package, similar to first-run extension trust.
- Materialized `.cala` files carry data from upstream. If a user emails a
  `.cala` containing confidential data, the recipient sees it. Documented
  behavior; treat `.cala` confidentiality the same as `.xlsx` today. No DRM.

## Telemetry and Audit

- Registry-side: server logs (who pulled what version when). Standard.
- Workbook-side: opt-in audit log in the `.cala` recording subscription
  events, refreshes, and override creation. Policy is set per registry: a
  registry may require audit logging for packages it serves. Off by default
  for packages from registries that do not require it.

## Author Workflow

Authors need a fast iteration loop that does not require version-bump-and-publish
per save:

- `--dev` subscription flag: subscription points at a working `.cala` via
  local path or a dev-channel URL, follows HEAD, and refreshes on file change.
- "Publish to test registry" command separate from production publish.
- Production publish bumps a version, signs (if configured), and uploads.

## Identity Migration of Existing Numeric IDs

Existing in-code counters (`SavedTable::id`, `SavedTableColumn::id`, named
ranges, pivot tables, and any others) are replaced with UUID v7 in Phase 1.
Because there are no production `.cala` files, no migration path is required:
the numeric ID fields are removed or repurposed as display indices, and all
code referencing them is updated to use the new UUID fields directly.

Audit of existing numeric IDs is a Phase 1 task.

## `.xlsx` Migration

Imported `.xlsx` files get fresh IDs minted on import. Round-tripping
`.xlsx` --> `.cala` --> `.xlsx` does not preserve identity across the
round-trip. Documented; not a supported workflow for identity-dependent
features.

## Package Kinds

A `.calp` declares its kind in its manifest:

- `template` - structure and formulas, no/minimal data. Refresh changes
  structure and formulas; data is consumer-supplied.
- `dataset` - data only (e.g., a published dataset of reference values).
  Refresh changes data; structure is stable.
- `report` - structure, formulas, and data together. Default.

Kind affects refresh defaults and override semantics but not the underlying
data model.

## Full-Fidelity Publish and Transparency (2026-07)

An adversarial per-object audit of the publish/pull pipeline found the
original implementation dropped or one-way-carried many object types
(tables were published but never materialized on subscribe; sheet
presentation metadata was carried but dropped; controls were not even
persisted in `.cala`). The fixes changed the architecture, not just the
instances:

- **One collector.** `build_workbook_snapshot` (a drifted parallel of the
  save path) was deleted; `calp_publish` builds its carrier through the SAME
  `build_workbook_for_save_with_slicers` collector as `.cala` save, so
  package fidelity automatically tracks file fidelity. Core `publish()`
  writes the subset the format supports.
- **No silent drops.** Every publish returns a `PublishReport`
  (included/excluded, each with a count and a reason), and
  `calp_publish_preview` dry-runs the exact same assembly before anything is
  written. Categories still excluded (slicers, ribbon filters, saved pivot
  layouts, document theme, extension data, workbook files, and the
  not-yet-persisted features) are *reported*, never silently dropped.
- **Materialization parity.** Pull and refresh now materialize tables, sheet
  presentation state (merges, freeze panes, tab color, visibility,
  gridlines, page setup, notes, hyperlinks), and controls; refresh uses
  reset semantics for publisher-owned sheet state and ledger-scoped
  replacement for tables/charts. Dev-mode subscribe/refresh materializes at
  the same fidelity, so the author preview matches subscriber reality.
- **Controls and the consent model.** Cell-anchored controls
  (buttons/checkboxes) persist in `.cala` (`controls.json`, opaque per-sheet
  payloads like CF/DV) and travel in packages — but their `onSelect` wiring
  is INLINE SCRIPT SOURCE, so it is stripped at pull/refresh/dev
  materialization (`sanitize_distributed_controls`). Packaged buttons arrive
  visually intact but disarmed; publisher interactivity flows through
  consent-gated object scripts only.
- **Provenance ledger + Package Explorer.** `Subscription.objects` records
  every object a pull actually materialized (conflict-skipped items are
  never claimed). The Package Explorer panel resolves the ledger against
  live state for subscribers, and shows authors the publish preview.
- **Model distribution (`dataset` kind).** `calp_publish_model` publishes a
  single BI connection's model as a zero-sheet `dataset` package —
  credential-free schema, signed, versioned, min-app-gated — replacing loose
  `.json` file hand-off. Subscribing materializes a live connection;
  refreshing a dataset subscription swaps the engine onto the new model
  (`refresh_embedded_data_sources`). Connections can also be created from
  inline model JSON with a synthetic `local:{id}` identity — the model file
  is interchange, not identity. Models are authored in-app via the Model
  Editor window (`docs/design/model-editor.md`).
- **Integrity hardening.** `verify_version_artifacts_via` rejects unlisted
  loose artifacts (blocking post-publish file injection past the dir-first
  `read_artifact`), and pivot-definition discovery enumerates the SIGNED
  manifest's checksum keys instead of a directory walk (which returns
  nothing after blob dedup — pivots were silently never pulled from real
  registries before this).

## Open Items Deferred Beyond v1

- Promote-override-to-upstream mechanism (UI reserved; flow undefined)
- Public registry discovery and trust model
- Multi-user concurrent editing of a `.cala` (single-user assumed in v1)