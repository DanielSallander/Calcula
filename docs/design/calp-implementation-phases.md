# .calp Implementation Phases

## Status

**All 8 phases implemented** (May 2026). Pre-production — no deployed users.

> **Deferred list re-verified against code 2026-08-16.** Three of the four items
> below had SHIPPED and the list still called them missing. The corrected state
> is recorded inline; the original wording is kept struck through so the
> sequencing rationale below still reads against the plan it was written for.

Deferred items:
- ~~HTTP workspace adapter (Phase 2 scope, local-filesystem only for now)~~
  **BUILT (read-only).** `HttpWorkspace` (`app/src-tauri/src/calp_registry.rs:93`)
  implements `WorkspaceTransport` over `reqwest::blocking`, so any static file
  host (S3, nginx, GitHub Pages) is a workspace with no server code. It lives in
  the app crate deliberately, so `core/calp` stays free of an HTTP client —
  which is why `core/calp/src/transport.rs` still describes itself as
  local-only. Routing is by URL scheme through the single choke point
  `open_workspace_scoped` (`calp_registry.rs:49`). **Still genuinely absent:**
  writes. Publish, submission save and the publish lock all error on an HTTP
  workspace ("HTTP registries are read-only", `calp_registry.rs:207`), so
  writeback collection remains local-workspace-only, and redirects are disabled
  to keep a hostile workspace from turning a GET into an SSRF primitive.
- ~~Author-facing rename/merge UI (stubs in place, pending full IdRegistry
  integration into AppState)~~ **The blocker is gone; only the UI is still
  missing.** `IdRegistry` is in `AppState` (`app/src-tauri/src/lib.rs:616`), and
  `calp_rename_cell_id` / `calp_merge_cell_ids` are real commands, not stubs
  (`app/src-tauri/src/calp_commands.rs:6144` and `:6171`), each window-guarded
  and each dirtying the document only when it actually merged. `renameCellId` /
  `mergeCellIds` are exposed on the facade (`app/src/api/distribution.ts:776`,
  `:789`). Nothing in `app/extensions/` calls either one, so the remaining work
  is exactly the author-facing surface and nothing underneath it.
- Full dep graph migration from coordinate keys to (SheetId, CellId) keys —
  **still deferred, and further from done than "alongside" suggests.**
  `IdentityGraph` (`core/engine/src/identity_graph.rs:45`) has NO production
  consumer at all: every reference to it outside its own file is one of its own
  unit tests. The coordinate graph is not merely still present, it is the only
  one in service.
- ~~Signing infrastructure (manifest supports it, no implementation yet)~~
  **BUILT, and it is not optional.** Every publish loads or creates an Ed25519
  publisher keypair and writes a detached `version-manifest.sig` over the raw
  manifest bytes (`core/calp/src/publish.rs:1176`), stamping the asserted
  `publisher_key` into the manifest (`publish.rs:557`). Trust is TOFU and
  enforced CLIENT-side, not by the workspace: `PinPolicy` is
  `PinOnFirstUse` / `PinAcceptingNameConflict` / `VerifyOnly` / `RequirePinned`
  (`core/calp/src/integrity.rs:439-458`) against a pin store in the user
  profile, and cross-workspace name conflicts are surfaced rather than
  silently accepted. See "Security and Trust" in `calp-distribution.md`.

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

## Phase 2: .calp Format and Workspace Plumbing

- `.calp` file format (manifest + content layout, on-disk)
- Local-filesystem workspace adapter
- HTTP workspace adapter
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
- Test workspace / dev channel publishing
- Production publish flow (version bump, sign, upload)
- Author-facing UI for `IdRegistry::rename` and `IdRegistry::merge`
- Signing infrastructure (if workspace policy requires)

## Phase 7: Cross-Application and Telemetry

- Cross-application references
- Workspace-side dependency tracking
- Opt-in audit log in `.cala`
- Application kind declarations (`template`, `dataset`, `report`) and kind-specific
  refresh defaults

## Phase 8: Integration and Polish

- `.xlsx` import minting fresh IDs
- End-to-end TestRunner suites covering full author --> consumer --> override
  --> refresh cycles
- Performance work on large workbooks with many subscriptions
- ID storage compression on disk (varint or prefix encoding)