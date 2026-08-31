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

**August 2026 media round:** embedded pictures became content-addressed
artifacts instead of base64 inside `controls.json`, and the pull path — the
last unvalidated binary route into a subscriber's document — was closed. See
"Binary Media in Applications (2026-08)" below.

**Documentation audit 2026-08-16.** Every substantive claim below was
re-verified against code. Four were stale and are corrected in place, each
marked `CORRECTED 2026-08-16`: the list of categories publish still excludes
(five of the six named items now travel), what happens to an inline image this
build refuses (the cap-violating class is now DROPPED, not left inline — that
was the defect, BUG-0086), "applications MAY be signed" (every application is
signed, and trust is enforced client-side, not by the workspace), and the audit log's
"opt-in, off by default" (writeback egress is now always recorded). The
identity model, formula-storage and refresh/override sections were spot-checked
and hold.

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
with a subscription-based system where `.calp` applications are manifests that
`.cala` workbooks subscribe to.

## Core Model

- **`.calp` application**: A manifest + content bundle published to a workspace.
  Declares sheets, formulas, data, named ranges, version, and metadata. Immutable
  once published at a given version.
- **`.cala` workbook**: The user's working file. Contains materialized state
  (current values, formulas, formatting) plus subscription metadata and an
  override layer. Self-contained: opens and works offline.
- **Workspace**: A location (SMB share, HTTP endpoint, Azure Blob, etc.) hosting
  `.calp` applications. Corporate-internal is the primary scenario; public
  workspaces are a thinner variant of the same machinery.

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
any workbook may become an application later. Lazy minting at publish time would
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
to publish applications whose IDs do not collide for any consumer subscribed to both.

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

IDs persist across publishes: v2 of an application preserves the IDs from v1, so
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

A `.cala` may subscribe to multiple `.calp` applications. Each subscription
contributes sheets and/or named ranges that the workbook composes together.
Cross-application references are allowed; the resulting dependency graph is
declared, not strictly enforced in v1.

### Version pinning grammar

SemVer-style:
- `=2.3.1` - exact pin (default for new subscriptions)
- `>=2.0 <3.0` - range
- `~2.3` - latest patch in 2.3.x
- `^2.3` - latest minor in 2.x
- `latest` - always newest (discouraged but supported)

Major-version bumps signal "overrides may not survive."

### Refresh behavior

On workbook open: never block. If the workspace is unreachable, open with last
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
snapshots to recipients who cannot reach the workspace.

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

- ~~`.calp` applications may be signed; the workspace enforces signing policy.~~
  **CORRECTED 2026-08-16:** both halves are wrong now. Signing is **not
  optional** — `publish()` loads or creates the publisher's Ed25519 keypair and
  always writes a detached `version-manifest.sig` over the raw manifest bytes
  (`core/calp/src/publish.rs:1176`), recording the asserted signer as
  `publisher_key` (`publish.rs:557`). And the policy is enforced by the
  **client**, not the workspace: a workspace is often a dumb static file host
  with no server code at all, so it could not enforce anything. Trust is TOFU
  against a pin store in the user profile, under `PinPolicy`
  (`core/calp/src/integrity.rs:439-458`): `PinOnFirstUse` (reporting `FirstUse`,
  or `FirstUseKnownPublisher` when that key is already trusted from another
  workspace), `PinAcceptingNameConflict` for the case where the user has been
  shown a cross-workspace name conflict and accepted it, `VerifyOnly`, and
  `RequirePinned`, which can only succeed against an existing pin. The same
  machinery covers distributed extensions via signed sidecar manifests verified
  at scan.
- Applications with executable content (formulas reaching external data,
  extensions/macros when those land) prompt the user on first refresh per
  application, similar to first-run extension trust.
- Materialized `.cala` files carry data from upstream. If a user emails a
  `.cala` containing confidential data, the recipient sees it. Documented
  behavior; treat `.cala` confidentiality the same as `.xlsx` today. No DRM.

## Telemetry and Audit

- Workspace-side: server logs (who pulled what version when). Standard.
- Workbook-side: an audit log in the `.cala` recording subscription events,
  refreshes, and override creation. Policy is set per workspace: a workspace may
  require audit logging for applications it serves. Off by default for
  applications from workspaces that do not require it.

  > **CORRECTED 2026-08-16 — "opt-in / off by default" is no longer true of the
  > whole log.** `AuditEvent::is_always_recorded` (`core/calp/src/audit.rs:108`)
  > carves out two classes that record REGARDLESS of the `enabled` flag: script
  > activity (`ScriptExecuted`, `CapabilityCall`), and **writeback**
  > (`WritebackSubmitted`, `WritebackReviewed`, `WritebackInvalidated`). The
  > reasoning is worth keeping: submitting is the moment a contributor's typed
  > values LEAVE THE MACHINE for a shared workspace, which makes it an egress
  > event much closer to `net.fetch` than to bookkeeping like subscribe/refresh;
  > an approve/reject changes whether someone's answer counts; an invalidation
  > silently discards entered work. Recording those only when a workbook
  > happened to opt in meant the trail was absent exactly when someone needed to
  > reconstruct what they had sent. Distribution bookkeeping
  > (subscribe/refresh/override/publish) does stay opt-in, as written above.
  > Pinned by `writeback_events_record_even_when_disabled` (`audit.rs:250`), and
  > the ring's overflow policy drops opt-in entries before always-recorded ones
  > (`audit.rs:185-207`) so high-volume traffic cannot push the egress trail out.

## Author Workflow

Authors need a fast iteration loop that does not require version-bump-and-publish
per save:

- `--dev` subscription flag: subscription points at a working `.cala` via
  local path or a dev-channel URL, follows HEAD, and refreshes on file change.
- "Publish to test workspace" command separate from production publish.
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

## Application Kinds

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
  application fidelity automatically tracks file fidelity. Core `publish()`
  writes the subset the format supports.
- **No silent drops.** Every publish returns a `PublishReport`
  (included/excluded, each with a count and a reason —
  `app/src-tauri/src/calp_commands.rs:406`), and `calp_publish_preview`
  (`calp_commands.rs:969`) dry-runs the exact same assembly before anything is
  written. Categories still excluded are *reported*, never silently dropped.

  > **CORRECTED 2026-08-16 — the exclusion list below was five-sixths wrong,
  > in the "says it is missing when it has shipped" direction.** A later round
  > (the `Wave A` counters on `PublishResult`) brought most of it into the
  > application: `slicers_published`, `ribbon_filters_published`,
  > `pivot_layouts_published` and `extension_data_published` all exist on the
  > publish result (`core/calp/src/publish.rs:159-166`), extension data is
  > written as its own `extension_data.json` artifact and read back on pull
  > (`publish.rs:1016`, `core/calp/src/pull.rs:698`, pinned by
  > `pull_carries_extension_data`), and document theme travels too
  > (`pull_carries_document_theme`, `pull.rs:2056`). Of the six categories the
  > original sentence named, only **workbook files** is still excluded.
  >
  > The excluded set as actually built (`calp_commands.rs:538-600`) is:
  > `workbookFiles` (subscriber-local by policy), `floatingRanges` (the objects
  > do not distribute yet, though their backing cell-store sheets do travel, so
  > formulas referencing them stay live), `comments` (unless the publisher ticks
  > "Include comments"), `protection` and `workbookProtection` (governance
  > features — but per-cell locked/hidden DO travel, as cell formatting),
  > `gridDefaults` (workbook-wide row height / column width would re-size sheets
  > the subscriber already had), `biRoleSelections` (a publisher's "view as"
  > impersonation must not be re-applied under a subscriber's identity), and
  > `documentProperties`. Each carries its own reason string, which is the
  > property that matters and which the drift above did not damage.
- **Materialization parity.** Pull and refresh now materialize tables, sheet
  presentation state (merges, freeze panes, tab color, visibility,
  gridlines, page setup, notes, hyperlinks), and controls; refresh uses
  reset semantics for publisher-owned sheet state and ledger-scoped
  replacement for tables/charts. Dev-mode subscribe/refresh materializes at
  the same fidelity, so the author preview matches subscriber reality.
- **Controls and the consent model.** Cell-anchored controls
  (buttons/checkboxes) persist in `.cala` (`controls.json`, opaque per-sheet
  payloads like CF/DV) and travel in applications — but their `onSelect` wiring
  is INLINE SCRIPT SOURCE, so it is stripped at pull/refresh/dev
  materialization (`sanitize_distributed_controls`). Distributed buttons arrive
  visually intact but disarmed; publisher interactivity flows through
  consent-gated object scripts only.
- **Provenance ledger + Application Explorer.** `Subscription.objects` records
  every object a pull actually materialized (conflict-skipped items are
  never claimed). The Application Explorer panel resolves the ledger against
  live state for subscribers, and shows authors the publish preview.
- **Model distribution (`dataset` kind).** `calp_publish_model` publishes a
  single BI connection's model as a zero-sheet `dataset` application —
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
  workspaces before this).

## Binary Media in Applications (2026-08)

Pictures used to travel as base64 data URLs inside the `controls.json`
artifact. They now travel as their own content-addressed artifacts. The change
is small in the format and large in what it fixes, and the interesting half is
what happens to applications that were already published and already signed.

### Media artifacts

A picture's bytes are published at `media/{sha256}` — one raw artifact per
distinct image — and the control property holds a `media:<sha256>` handle
instead of the image. Only media that the PUBLISHED sheets actually reference
travels; `publish.rs` walks each published sheet's controls with
`calcula_format::media::visit_media_refs` and writes exactly the blobs it
finds, so a picture on an unpublished sheet does not leak into the application.

**This is what makes the content-addressed blob store work.**
`commit_artifacts_as_blobs` keys on each ARTIFACT's SHA-256, and a media
artifact's content IS the image, so the blob key is literally the media hash:
the same corporate logo is one blob across every version of every application
that carries it. Inline, the blob key was the SHA of the whole `controls.json`, so
editing one caption minted a fresh multi-megabyte blob on every release. The
dedup was already there; inlining defeated it.

The integrity walk needed no change: `verify_version_artifacts_via` recurses
into every directory except `submissions/` and `reviews/`, so `media/` entries
are hashed and LISTED in the signed manifest automatically — which they must
be, because that same walk rejects unlisted artifacts.

Pulled blobs are re-validated host-side and re-keyed from their own bytes
(`media::admit_foreign_media`). A signed manifest proves the publisher sent
these bytes; it does not prove they are a picture. A correctly-signed
decompression bomb is refused by the same gate as any other file.

Dev-mode pulls carry media too (`DevPullResult.media`). A dev pull exists to
show an author what a subscriber will get, and without the bytes every picture
in the preview painted "Image Unavailable".

### The legacy-application contract: read tolerance, write strictness

Applications published before media artifacts existed carry whole images base64'd
inside `controls.json`, and that artifact is covered by the detached manifest
signature. **A subscriber cannot re-sign someone else's application.** Two
consequences follow and they pull in opposite directions:

- Refusing the legacy shape would break every existing subscription to fix
  nothing. The pull path must READ it. Non-negotiable.
- But whatever it reads is written into the SUBSCRIBER's own document and saved
  verbatim into their own `controls.json`. Reading it unchecked propagates the
  original defect one hop further.

The resolution is to migrate at the application boundary:
`media::admit_distributed_controls` sanitizes AND migrates — decode,
re-validate through `calcula_format::media::inspect_media` (magic bytes, 8 MiB
byte cap, both pixel caps, PNG/JPEG/GIF/WebP allowlist), file under the content
hash, rewrite the property to a handle. All three distributed materialization
sites — first pull, refresh, dev pull — call it instead of the old
`sanitize_distributed_controls`. It runs AFTER signature verification, on the
way into the subscriber's document, so the application as published is untouched
and its signature unaffected.

> **CORRECTED 2026-08-16 — the paragraph below stated the exact posture that
> turned out to be the hole (BUG-0086), and stated it as a virtue.** "Refused
> for a policy reason" and "refused for exceeding a cap" are not one class, and
> treating them as one is what left a decompression bomb renderable. The
> corrected rule is immediately below; the original text follows it, struck
> through, because its *reasoning about policy refusals* is still right and is
> still the reason half the rule exists.

A refused payload takes one of **two** paths, decided in one place —
`judge_inline_image` (`app/src-tauri/src/media.rs:300`), which returns
`Admit` / `LeaveInline` / `Drop`:

- **Refused on POLICY** (an SVG, a BMP, an unknown format, a malformed header):
  **left inline, not dropped.** It keeps rendering from its data URL under the
  existing CSP `data:` allowance while the write door stays shut. Deleting it
  would silently destroy a picture the subscriber can see, which is a worse
  outcome than carrying a payload that can no longer spread.
- **Refused because DECODING IT IS THE HARM** (over the 8 MiB byte cap, over
  `MAX_MEDIA_DIMENSION`, or over `MAX_MEDIA_PIXELS` — `MediaError::is_decode_hazard`,
  `core/calcula-format/src/media.rs:188`): **the property is CLEARED.** Leaving
  one of these inline was the whole defect. `inspect_media` refused it entry to
  the media store and the payload stayed in the control property regardless, so
  the WebView — which has no such caps — decoded it anyway. A 30,000 x 30,000
  single-colour PNG is a few KB of `controls.json` and 3.6 GB of RGBA in the
  renderer, which is why the size cap alone never closed this: a bomb is SMALL.
  Cleared, not deleted: the control keeps its identity, geometry and every other
  property and paints an honest "No Image" placeholder, because removing the
  control would silently change the sheet's layout.

The two outcomes are counted separately and on purpose — `MediaMigration.refused`
vs `MediaMigration.dropped` (`media.rs:261-279`) — so "we tolerated this" and "we
destroyed this" can never be read off one number. The same verdict function
governs the write door: `is_hazardous_inline_image` (`media.rs:348`) refuses the
HAZARD class only, so a policy-refused SVG still round-trips through a property
write unharmed rather than being destroyed by an edit to some unrelated property
of the same control.

~~A payload this build refuses (an SVG, or one over a cap) is **left inline, not
dropped**: it keeps rendering from its data URL under the existing CSP `data:`
allowance while the write door stays shut. Deleting it would silently destroy a
picture the subscriber can see, which is a worse outcome than carrying a
payload that can no longer spread.~~

**What a subscriber sees: the same picture.** No consent prompt, no re-pull, no
"application invalid". What changed is invisible and in their favour — the image
is content-addressed, so the same logo across five applications is one blob, and their
saved workbook holds a 70-character handle where it held a multi-megabyte
string.

### The hole this closed, and the general caution

Pulled controls are materialized by `materialize_saved_controls`, which writes
STRAIGHT into `ControlStorage`. It is not a `set_control_metadata` call, so the
64 KiB property bound never saw it, and neither did any format or size check.
**A legacy pull was therefore the last surviving route by which unvalidated
binary entered a document**, and the claim that "every route converges on the
two control commands" was wrong about exactly this one.

The general form is worth recording, because it will recur: a
*materialize*-shaped code path — one that reconstructs persisted state directly
into a store rather than replaying the commands that would have created it —
bypasses every gate that lives at the command layer. Publish/pull, `.cala`
load, undo restore and application refresh are all this shape. When a validation
rule is added to a command, ask which materializers reach the same store, and
put the rule where they converge (here: one Rust function,
`calcula_format::media::inspect_media`, called by all four doors) rather than
at each command.

## Open Items Deferred Beyond v1

- Promote-override-to-upstream mechanism (UI reserved; flow undefined)
- Public workspace discovery and trust model
- Multi-user concurrent editing of a `.cala` (single-user assumed in v1)
- **No artifact size cap exists at all.** Still true, and still open:
  `core/calp/src/pull.rs` bounds no artifact by size, so a hostile or merely
  careless application can carry an arbitrarily large `data.json`. Media is the one
  exception, capped at 8 MiB per image by `inspect_media`.
  *(CORRECTED 2026-08-16: the sentence that used to follow — "a legacy inline
  payload that this build refuses is left inline and is therefore unbounded" —
  no longer holds. A payload refused for exceeding a cap is now cleared, not
  left inline; see "The legacy-application contract" above. Only POLICY-refused
  payloads stay inline, and those already passed the byte cap. The general
  artifact gap is unaffected by that fix, which is why this item stays open.)*