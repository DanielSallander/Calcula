# .calp Implementation Phases

## Status

**All 8 phases implemented** (May 2026). Pre-production — no deployed users.

Deferred items:
- HTTP registry adapter (Phase 2 scope, local-filesystem only for now)
- Author-facing rename/merge UI (stubs in place, pending full IdRegistry
  integration into AppState)
- Full dep graph migration from coordinate keys to (SheetId, CellId) keys
  (IdentityGraph exists alongside the coordinate graph)
- Signing infrastructure (manifest supports it, no implementation yet)

See `docs/guide/distribution.md` for user-facing documentation and
`docs/spec/calp-format.md` for the on-disk format specification.

## Sequencing

Phases are ordered by dependency; later phases assume earlier ones land first.
All phases are v1.0 scope.

## Phase 1: Identity Foundation

- UUID v7 generator and `IdRegistry` type
- Audit existing numeric ID counters (tables, table columns, named ranges,
  pivot tables, anything else); replace with UUID v7
- Cell-level ID auto-mint rules (incoming reference, override, formula content)
- Reference-site ID minting on all formula parses
- Formula storage migration to AST as canonical form
- AST <--> string rendering and parsing at the I/O boundary
- Structural alignment algorithm for preserving IDs across formula edits
- `IdRegistry::rename` and `IdRegistry::merge` internal APIs (UI deferred to
  Phase 6)
- Dependency graph rekeyed by `(sheet_id, cell_id)`, cross-sheet from day one
- ID survival rules across row/column insert/delete
- TestRunner coverage for: ID minting, edit-time alignment, structural shifts,
  cross-sheet refs, rename/merge

## Phase 2: .calp Format and Registry Plumbing

- `.calp` file format (manifest + content layout, on-disk)
- Local-filesystem registry adapter
- HTTP registry adapter
- Publish command
- Pull command (no override layer yet; raw subscribe-and-materialize)
- Version pinning grammar and resolution

## Phase 3: Override Layer

- Override data structure in `.cala`
- Override creation on edit of upstream cells
- Override rebasing on refresh
- Auto-clear of overrides that match upstream after refresh
- `locked-no-override` enforcement
- Override export/import format (serializable independently of workbook)

## Phase 4: Refresh and Conflict Resolution

- Atomic refresh across multiple subscriptions
- Refresh preview computation
- Conflict detection
- Conflict resolution actions (accept upstream, keep override, see both)
- Deleted-sheet-with-overrides flow (save locally vs. accept deletion)

## Phase 5: UI

- Overrides pane (three views: overrides, conflicts, pending refresh)
- Grid badges for override and conflict states
- Refresh banner (non-modal, one-click)
- Refresh preview dialog
- Conflict resolution UI
- Detach-from-upstream command

## Phase 6: Author Workflow

- `--dev` subscription mode (local path / dev channel, follows HEAD)
- Test registry / dev channel publishing
- Production publish flow (version bump, sign, upload)
- Author-facing UI for `IdRegistry::rename` and `IdRegistry::merge`
- Signing infrastructure (if registry policy requires)

## Phase 7: Cross-Package and Telemetry

- Cross-package references
- Registry-side dependency tracking
- Opt-in audit log in `.cala`
- Package kind declarations (`template`, `dataset`, `report`) and kind-specific
  refresh defaults

## Phase 8: Integration and Polish

- `.xlsx` import minting fresh IDs
- End-to-end TestRunner suites covering full author --> consumer --> override
  --> refresh cycles
- Performance work on large workbooks with many subscriptions
- ID storage compression on disk (varint or prefix encoding)