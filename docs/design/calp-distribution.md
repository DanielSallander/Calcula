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

**A pin is one of TWO possible targets, never a place to encode the other.**
An environment subscription carries no pin at all (see below), and
`VersionPin::parse` REFUSES an `env:` / `environment:` / `channel:` prefix by
name, pointing at the parameter instead. A magic prefix inside a pin string is a
convention every parser has to special-case, and this codebase already carried a
dead one: twelve sites skipped trust verification for a `"channel:"` pin nothing
ever produced.

### Environments

An **environment** is a named pointer to an immutable version on the one
development line — `test` at v1.5.0, `prod` at v1.2.0. Promotion moves the
pointer and copies nothing, so what was tested is bit-for-bit what ships. An
application with no environments behaves exactly as it always did. The model, the
gates and the threat model live in `calp-workspace-collaboration.md` §2.5; what
matters on the SUBSCRIBER side is here.

**Target.** A subscription follows either a pin on the line or an environment,
and exactly one. An environment subscription stores `version_pin: ""` and
`environment: Some(name)`; the empty pin is deliberate, because
`VersionPin::parse("")` errs, so any resolver that forgets the environment branch
fails loudly instead of reporting "up to date" forever.

**Default.** A new subscriber is offered the LAST environment — production by
convention, the end of the pipeline being what consumers consume. Subscribing to
the development line on an application that HAS environments requires
`followLine: true`; without it the pull is refused and names the environments on
offer, because the line receives every push the moment it lands.

**Rollback presentation.** A refresh can now go BACKWARDS. The card says
*v1.5.0 → v1.2.0 — rolled back* in amber and adds that cells the subscriber
edited keep their overrides. Without the direction in the words, a subscriber
reads a downgrade as an update and concludes the publisher changed those cells;
what actually happened is that a known-good version was restored, and the
conflicts they are about to resolve are against the OLDER content. The direction
is computed from parsed versions, never string order — `"1.9.0" > "1.10.0"`
lexicographically, and a rollback across a two-digit minor is exactly when the
answer matters most.

**Notices, not re-targeting.** When an application grows a pipeline, existing
line subscriptions are NOT moved. The refresh preview and the Subscriptions pane
say so and offer a one-click switch; the preview's copy is dismissible for that
showing, the pane's is permanent, because only one of the two has somebody
mid-decision in front of it. Switching PULLS NOTHING — it records intent and
re-runs the preview, so a two-word choice in a dropdown never becomes an
unreviewed content change.

**Unresolvable targets block the whole refresh.** An environment that was removed
from the pipeline, or is empty, or whose promotion log does not verify, degrades
ONE row to `unavailable` rather than aborting every other subscription's preview —
and Apply is disabled while any such row exists. A refresh is one gesture over
every subscription in the workbook, so applying while one silently sat out would
leave that report on an old version with nothing on screen having said so.

**Writeback.** Submissions are stored per version, and an environment is a
pointer to a version — so testers filling in test@v1.5.0 and a production
audience later promoted onto v1.5.0 land in the same tree. Every submission
therefore carries an `environment` tag, stamped at the authoritative submit (not
at draft time: drafts persist in the `.cala` and can predate a switch), and every
reader that feeds a number filters on it. Lenient carry-forward follows the
environment's own promotion history rather than semver order, so a rollback does
not make the subscriber's own submissions disappear.

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

#### Refresh means "fetch a newer version". Nothing else. (clarified 2026-09-01)

`compute_preview` and `pull_all_updates` both begin by skipping any subscription
whose resolved version already equals the workspace head
(`core/calp/src/refresh.rs`). A subscriber who edits a subscribed sheet and then
clicks *Refresh Subscriptions* therefore gets "No Updates Available" and no Apply
button — a true sentence answering a question they were not asking.

Reported from live testing as *"I subscribed to a sheet, overwrote some values,
clicked refresh subscription, and nothing happened."* The verb they wanted is
`calp_reset_subscription` ("discard my local edits, restore the published
content"), which existed but was reachable only from Distribution > Manage
Subscriptions.

The fix is not to widen refresh — a refresh that undid local edits when no new
version existed would be a different and much more destructive command wearing
the same label. It is to put the other verb where the user already is:

- **On the sheet tab**, beside *Detach* — right-click a subscribed sheet >
  *Reset "&lt;application&gt;" to published…*. The command is per-APPLICATION, so
  the confirm names how many sheets it will touch rather than implying the scope
  is the one tab.
- **In the empty refresh state**, which now says what refresh does and does not
  do, and offers a per-subscription *Reset to published…* button.

#### The preview is per-cell, and Apply is a decision (2026-09-01)

`SubscriptionPreview` carries `conflicts: Vec<ConflictPreviewCell>` — every
conflicted cell with its full three-way triple — plus `unexamined_sheets` for any
artifact that could not be read. `overrides_conflicted` is now `conflicts.len()`.

It used to be `sheets_updated.map(|s| s.override_count).sum()`: every override on
any sheet whose artifact changed, whether or not upstream had touched that
particular cell. On a sheet where the publisher edited one cell and the subscriber
had edited twenty others, the dialog reported twenty conflicts and the apply
created one. **The number was never computed; it was inferred from a proxy.**

Making it real required one shared predicate, because the preview reads workspace
artifacts in `core/calp` and the apply reads a pulled payload in the app crate:

- `overrides::override_value_from_saved` moved from the app crate into
  `core/calp/src/overrides.rs`, and both sides feed it from
  `calcula_format::sheet_data::sheet_data_to_cells` — the same conversion `pull()`
  uses, so they agree **by construction** rather than by two converters that
  happen to match.
- `overrides::classify_rebase` is the decision `rebase` itself now asks:
  `Unchanged` / `AutoCleared` / `Conflict`.
- `compute_preview` takes an `override_positions` map. The apply resolves a cell
  as `id_registry.cell_position(...).unwrap_or(ovr.position)`; the registry is app
  state that `core/calp` cannot see, so the caller snapshots it and hands it over.
  Without it the preview reads the recorded position and, after any structural
  shift, the wrong cell.

`rebase` also stopped counting conflicts it deletes: it incremented for every
changed-upstream cell including the ones `auto_clear_matching` removed two lines
later, so a refresh producing zero conflicted overrides could report "1 conflict
created" — and the preview and the apply could never have been made to agree.

**A capped list is refused, not truncated.** A cell COUNT may honestly be "at
least N"; a list of decisions the user is about to make may not be "some of them".
Any unreadable sheet sets `conflicts_exact: false` and the dialog blocks Apply
rather than silently resolving the rows nobody was shown.

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

### Resolving DURING the refresh (2026-09-01)

Both verbs existed and both worked — `OverrideLayer::accept_upstream` and
`keep_override` — but only from the Overrides pane, *after* a refresh had already
replaced the sheet. The decision was available at the wrong moment: by the time
the user could make it, the thing they were deciding about had happened.

`calp_refresh_apply` now takes `resolutions: Vec<CellResolution>`, keyed
`(sheetId, cellId)` — never a position, because positions move under a refresh and
the layer is id-anchored precisely so an override survives a structural shift.
Each names `keepMine` or `takeTheirs`. **An omitted or empty list is exactly
today's behaviour**: every local value kept, every conflict left flagged. That is
also what the script gateway passes, because a script has no dialog to answer with
— it may take an update, never adjudicate one.

**Where the loop sits is the whole correctness argument.** It must run:

- BELOW `apply_refresh`, because `rebase` is what sets `conflict` and
  `upstream_new`; above it, `keep_override` finds no upstream value and returns
  false.
- ABOVE the `to_overlay` snapshot, which is a **clone** of the surviving overrides
  painted onto the grids some forty lines later. Resolve after the clone and
  `accept_upstream` removes the override from the layer while the clone still
  holds it — so the user picks "take theirs", the dialog agrees, and the grid gets
  "mine". Silently.

`take theirs` writes nothing to the grid: the wholesale replacement already put
pristine upstream content in that cell, so dropping the override IS the operation
and the re-overlay simply skips it. Pinned by
`app/src-tauri/src/refresh_resolution_tests.rs`, whose ordering guard fails with
that exact message when the loop is moved.

The dialog renders each row through `ThreeWayRow`, the component extracted from
the Overrides pane's own conflict row — one markup, two modes (`act` fires now,
`choose` records a pending decision), so the pane and the dialog cannot come to
disagree about which value is "theirs".

Structural conflicts (e.g., upstream deleted a sheet the user has overrides
on) surface as their own category in the conflicts pane. For deleted sheets,
the user explicitly chooses: save the sheet locally (detaching just that sheet
from upstream) or accept the deletion (overrides on that sheet are discarded).

### Per-sheet detach (implemented 2026-08-31)

`calp_detach_sheet` is the per-sheet form of the workbook-wide `calp_detach`, and
it is reachable directly — right-click a subscribed sheet's tab > *Detach from
"&lt;application&gt;"*. It is also the remedy the delete guard names: a subscribed
sheet cannot be deleted while it is still tracked, because the subscription would
be left pointing at a sheet that no longer exists.

Detaching drops the sheet's `SubscribedSheet` entry, records the application sheet
id in `Subscription.detached_sheets` so a later refresh does not re-adopt it, and
discards that sheet's override-layer rows. **The cells are not touched.** The
override layer is a ledger, not a shadow store — an edit on a subscribed sheet
already wrote through to the grid and merely recorded baseline and current
alongside. What detaching discards is the ability to revert to upstream, which is
what detaching means. The subscription row itself is removed only when it owns
nothing else at all (no sheets, no objects, no data-source configs); a library or
dataset subscription legitimately has zero sheets.

A detached sheet becomes ordinary: publishable, deletable, and no longer refreshed.

### Seeing the difference before deciding (2026-09-01)

Three sheet-tab items, all showing the same kind of per-cell comparison, all built
on `calp_diff_working_copy` — which runs the REAL publish assembly into a
`MemoryWorkspace` and diffs that against the published artifact, so the preview
and the act are the same code:

| Right-click a… | Item | What it does |
|---|---|---|
| subscribed sheet | *View changes vs "&lt;app&gt;"…* | read-only |
| subscribed sheet | *Reset "&lt;app&gt;" to published…* | the same view, with the confirm |
| working-copy sheet | *Push changes to "&lt;app&gt;"…* | opens the Publish dialog, which already fetches and shows this diff |

The reset and view entries are ONE dialog with a `mode`. Two dialogs would be two
answers to "what have I changed" and they would drift. **The dialog owns the
confirm** — not a style choice: `ui.dialogs.show()` returns `void`, so a menu item
cannot await a dialog and act on its answer.

**Push opens the existing Publish dialog rather than a smaller one.** That dialog
is already the push surface and already carries the stale-base gate, the merge
outcome, the version bump and the required change summary; a leaner push dialog
would be four second sources of truth about what a push is. The tab item passes a
`focusSheetName` HINT that highlights the row and deliberately does not tick it —
a right-click must not change what leaves the machine.

#### Four ways this preview could have lied, and what stops each

A preview that understates or misdescribes a destructive act is worse than no
preview, because it manufactures confidence. All four were found before any of it
was wired to a user; two were already live in the push preview.

1. **The inverse scope.** An empty `sheetIndices` means "the publish default",
   and for a workbook that SUBSCRIBES that default is every sheet you own *minus*
   the subscribed ones — so the preview would describe sheets the reset does not
   touch and omit every one it does. `calp_diff_working_copy` now refuses with
   `CALP_DIFF_NEEDS_SHEETS` rather than substituting: the scope of a diff shown
   before a destructive act must be visible at the call site. **The guard does not
   test the working-copy link**, because a workbook can be the working copy of X
   *and* a subscriber of Y — a first-class state since checkout became additive,
   and exactly what this feature creates by putting all three items on one menu.
   A `link.is_none()` test sails past for such a workbook and hands it X's sheets
   for a diff of Y.
2. **Sheets the act will not touch.** A DETACHED sheet is gone from the ledger but
   still in the published manifest, so the raw diff calls it `removed` while
   `calp_reset_subscription` skips it. A floating range the subscriber added to a
   subscribed sheet drags its LOCAL backing sheet into the assembly, where it
   reads as `added`. `scope_sheet_ids` filters both out **and recomputes the
   totals** — a filtered list under a carried-over header counts rows the list
   does not show.
3. **Every comment "removed".** The publish assembly writes `comments.json` only
   when `include_comments` is set; against a base published WITH comments the
   working side had none and every comment read as removed. Both previews now
   pass it. *This was live in the push preview*, which called `diffWorkingCopy()`
   with no arguments at all — which also meant unticking a sheet left the panel
   describing a push that still carried it.
4. **Formatting, which the diff cannot honestly itemise.** A reset also restores
   cell formatting, widths, heights, merges and pivot definitions. The engine
   collapses those into per-sheet booleans, and those booleans are **not
   trustworthy at sheet granularity**: every published sheet carries the WHOLE
   workbook style registry (`Sheet::from_grid` takes `styles.all_styles()`), and
   registries only ever append — so `stylesTableChanged` is true between
   essentially any publisher and any subscriber who has ever formatted anything,
   on every sheet. Surfacing it would print a warning against sheets nobody
   touched.

   So the dialog does not surface it, and says the honest thing instead: the cell
   list is complete, formatting and layout are restored too and are not listed,
   and **an empty list does not mean nothing would change**. A sentence that
   always applies beats a flag that is always on.

#### Per-cell selection: sound on reset, not on push (2026-09-01)

The reset diff's rows carry checkboxes. Untick one and that cell keeps your
value while the rest of the sheet is restored. **An exclusion set, never an
inclusion set** — the rows are a bounded sample (50 changed cells per sheet), so
a changed cell may have no row at all; storing what was opted OUT of means every
unseen cell keeps the default and an untouched dialog resets exactly what a
whole-sheet reset always did. The list says, per sheet, how many changes it could
not show.

Four things came with it, each a data-integrity condition rather than polish:

1. **The override ledger follows the cells, not the sheet.** Reset used to clear
   every override on the reset sheets. On a KEPT cell that is wrong in the
   direction that loses work: the grid holds the subscriber's value and the
   ledger records what upstream had, so dropping it leaves a local edit with
   nothing to say it is one — invisible in the Overrides pane, and republished as
   the publisher's own content by the next person who checks the application out.
2. **The recalculation moved into the Rust command.** A whole-sheet reset
   installed a coherent published sheet; a partial one installs a MIXTURE, and a
   formula reading across that boundary holds a number computed from neither
   state. The frontend does call `calculateNow`, but inside a try/catch that logs
   and continues.
3. **A spill origin cannot be half-kept** (`CALP_RESET_SPILL_CELL`). Keeping the
   author's formula while the published extents install leaves the array's shape
   and its formula disagreeing. Refused by name rather than resolved either way.
4. **The checkboxes cover cell values and formulas only.** Formatting, widths,
   heights, merges and pivot definitions stay wholesale, and the dialog says so.

**The push side does NOT get per-cell checkboxes, and the reason is structural.**
Unticking a cell at publish time ships a formula whose inputs did not ship, and
nothing on any receiving machine ever repairs it: neither `materialize_pull_result`
(pull and checkout) nor `open_file` evaluates a cell. Worse, the corruption is
invisible in the very list the checkboxes would sit on — `cells_equal` hides
formula cells whose formula did not change, so `C2 = A1*2` is never a row while
its stale value still travels. Unticking one input silently corrupts an unbounded
set of cells the author was never shown.

The repo had already ruled on this shape: `calp_publish` hard-refuses a workbook
carrying a cancelled recalculation, because *"every subscriber pulls cells that
look authoritative and are silently stale … a data-correctness bug in the
distribution story, not a UI nicety."* A per-cell publish filter manufactures
that state deliberately.

The owner's chosen semantics — publish without the change, keep it locally — are
sound only if the published artifact is RECALCULATED without those cells. See
`docs/design/open-items.md` §2.aa for what that costs and why it is not a
contained change.

#### Sheet names: a local rename does not travel, and two sheets may not share one (2026-09-01)

Two defects, one cause: **nothing on the publish path compared sheet names to
anything.** `publish()` bounds-checked each index and copied `sheet.name` into
the manifest.

**A local collision rename leaked upstream, on the DEFAULT push.** Checkout is
additive, so pulling an application's `Sheet1` into a workbook that already has
one renames the *incoming* sheet to `Sheet1 (2)` — a collision in that one
author's workbook and nowhere else. `assemble_publish_workbook` names sheets from
the live `state.sheet_names`, and the default selection is exactly `base_sheets`,
so a push with nothing changed renamed that sheet **for every subscriber**, with
no tick and no author action.

Names are the formula reference key. Cross-sheet references inside a package are
stored as raw TEXT and resolved by a **first-match case-insensitive name lookup**
(`calculation.rs`, `lib.rs::normalize_cross_sheet_refs`), so a renamed sheet
re-points every `=Sheet1!A1` in the package at whatever the subscriber happens to
call `Sheet1` — no `#REF!`, no warning, and `restamp_sheet_casing` then cements
the new spelling. It was also self-erasing: `record_push` overwrites
`base_sheets` from the live names, so after one leaked push the drift is no
longer detectable offline.

**An application sheet now publishes under the name the LINK records**, taken
from `base_sheets` in `assemble_publish_workbook` — the one door the publish, the
dry-run preview and the working-copy diff all go through, so all three agree.

**Renames are therefore out of push entirely** (owner decision, 2026-09-01). A
deliberate rename does not travel either, and that is the point rather than a
casualty: renaming a sheet subscribers hold formulas against is a breaking
change, and push is the wrong gesture for it. Until a reviewable workspace-side
rename exists, a working copy's tab name is local. A pivot's `destination_sheet`
records the local tab, so it is rewritten through the same map — otherwise the
retention check drops every pivot on a restored sheet.

**And two sheets in one version may no longer share a name**
(`CalpError::DuplicateSheetName`, refused in `core/calp/src/publish.rs` so every
route is covered including the scripted gateway). A workbook cannot hold a
duplicate, but a published version could: `VersionManifest.sheets` is a plain
`Vec` keyed by nothing and `sheet_indices` was never deduped at any layer, so
even the same index twice signed and published cleanly. The refusal is
case-insensitive, and separates the two cases — a genuine collision names the
sheet to rename; a repeated index says the selection is wrong.

Note the interaction: restoring published names is what *creates* the collision
the refusal catches. Tick both your own `Sheet1` and the application's, and the
application's is restored to `Sheet1` — at which point the version would carry
two. That is the correct place to stop, and the message names which one to rename.

**A third defect fell out of the same code.** The pivot-retention set compared
names case-SENSITIVELY while every other sheet-name comparison in the product is
`eq_ignore_ascii_case`, so a pivot whose `destination_sheet` was recorded as
`data` against a tab spelled `Data` was silently dropped from the application.
Both halves of that comparison are now lowercased.

#### The link records CONTENT, not just sheets (2026-09-02)

Additive checkout leaves the author's own scripts, notebooks and named ranges
beside the application's, and two publish paths read "not specified" as "all from
the workbook":

- `publish()` treats an absent `module_scripts` / `notebooks` list as everything
  in the carrier, so **a push wrote every private module script and notebook into
  the shared workspace**, checksummed and Ed25519-signed under the author's key,
  disclosed only as a bare count in the report. A personal module holding an API
  token is exactly the shape of thing a personal workbook contains.
- A pull is ADDITIVE for named ranges, so an application whose `RATE` collides
  with the author's is silently dropped at checkout — and the author's `RATE`,
  pointing at a sheet of theirs the package does not contain, then shipped **as
  the application's**. Every subscriber's next refresh took that definition.

`WorkingCopyLink` now records `base_script_ids`, `base_notebook_ids` and
`base_named_range_keys` — the same job `base_sheets` does, for content that has
no tick list. `assemble_publish_workbook` filters against them when the link
targets the application being published, and logs what it withheld. `record_push`
updates them from what actually shipped, so a script added to the application by
one push belongs to it from the next.

An EMPTY record means a link written before these fields existed, and the filter
falls back to the old behaviour rather than publishing nothing — silently
dropping the application's own scripts is the opposite failure and just as quiet.
Sheet-scoped names are never filtered: they ride with their sheet, and the sheet
selection already decides that.

#### Three facts the diff had collapsed into one (2026-09-02)

Hiding derived values made `walk_cells` returning zero mean something new, and
three consumers were still reading the old meaning:

1. **A sheet of pure formulas vanished from the diff and was reported as a
   packaging bug.** Zero authored changes was classified `Outcome::Spurious` —
   "same content, different bytes" — so no `SheetDiffSummary` was created and the
   sheet was counted into the determinism figure the UI renders as *"that is a
   packaging bug, not a change you made"*. It now re-reads with
   `count_all_cell_differences`: zero there too is a genuine determinism
   regression; non-zero is a real change reported with zero authored cells.
2. **The refresh preview counted the wrong thing.** It asks "what will land on my
   screen", and nothing on the receiving side recalculates — so it now counts
   every difference. Editing one input that recomputes 500 formula cells said
   "1 cell(s) changed" before 501 of them moved.
3. **One side over the parse budget fabricated a whole-sheet diff and marked it
   exact.** The guard only fired when BOTH sides failed to load, so a 9 MB base
   sheet past the 8 MiB cap diffed against a small working copy reported "20 cells
   added, 0 removed" with `countsExact: true` — the author was shown an addition
   and would have published a deletion of ~100,000 cells.

And a `FastForward` verdict with nothing unmergeable — newly reachable, because a
version whose changes are all derived now touches no pieces — rendered *"this
version cannot bring across ."* with an empty join. It gets its own branch.

#### Per-cell push hold-back: re-enabled on a scoped undo (2026-09-02)

Unticking a change in the push diff means *publish without this, keep it
locally*. It is implemented as: roll the cell back to its base value in the LIVE
document, publish, then undo. Rolling back at serialization time instead would be
simpler and is wrong — nothing on the receiving side ever recalculates, so a
formula whose inputs did not ship would show a number that was never true, and
invisibly, because the diff hides formula cells whose formula did not change.

It shipped DISABLED because the un-revert was a bare `undo()` — a blind
`pop_undo()` taking no token — while the dialog is deliberately non-modal and a
publish takes seconds. `calp_publish` records nothing on the undo stack itself,
but three things can land an entry during it: the author's own edit, an MCP tool
(genuinely concurrent — sync Tauri commands share the main thread, but MCP runs
off it), and the six `async` pivot/report commands. The bare undo then reversed
*that* and left the held-back cells rolled back for good — the author's value
gone from their own workbook, the dialog reporting success, a save persisting the
base value. AutoRecover does not help: it snapshots LIVE state, and the undo
stack is never serialized.

**The id is CLAIMED, not observed.** The first cut of the fix read the top of the
stack before and after the write and took the difference — which is a second
critical section and therefore the same defect one layer down: an entry landing
in that gap is adopted as the caller's own, and the un-revert then reverses a
stranger's write *confidently*, which is worse than the bare undo it replaced.
So `calp_hold_back_cells` opens the undo transaction itself, and
`commit_transaction()` — which stamps the id — hands it back. Nothing is
observed, so nothing can be adopted.

That required fixing an asymmetry in the pipeline underneath:
`begin_transaction` is a no-op while a transaction is open, so
`apply_script_modified_grids_core` used to COMMIT a caller's transaction as
though it were its own. `update_cells_batch` had always checked for that; this
had not, which is what made a wrapping caller impossible to write.

`undo` now takes an optional `expected_seq`, and checks it in the SAME critical
section as the pop — deciding under one lock and popping under another is the
race one layer up. On a mismatch it undoes nothing and returns a sentence, and
the two cases get different sentences because they have different remedies:
an entry still in the history can be reached by undoing past what sits above it
(*"press Ctrl+Z 3 times"*), one the cap has evicted cannot be reached at all.
`Transaction::seq` and `undo_seqs()` already existed for exactly this — their
doc says "a caller that wants to return to a remembered point has to remember an
ID, not a count" — and this is their first production consumer.

**Residual, stated rather than hidden:** when the guard refuses, the author's
held-back values are still rolled back and reaching them costs N+1 undo steps,
which also reverses the intervening change. That is recoverable and it is said
out loud; the alternative was reversing somebody else's work in silence.

#### Four things a refresh knew and did not say (2026-09-02)

**The preview's auto-clear count was a hardcoded `0`** — the same fabricated
number this file had already removed from `overridesConflicted`. A subscriber who
had typed 150 before the publisher did was told the refresh would discard none of
their recorded edits; the apply then returned 1. `collect_conflicts` was already
calling `classify_rebase` and throwing the `AutoCleared` verdict away. It now
returns it, plus a layer-wide sweep for overrides whose current value equals
their own baseline — `auto_clear_matching` deletes those on ANY refresh,
including on a subscription with no update at all, so they belong to the refresh
rather than to any one row.

**Nothing pinned the apply to the version the preview described.** The dialog
computes its preview once, on mount, and is deliberately non-modal so the user
can inspect sheets while deciding — and the two halves resolve the version pin
independently. A subscriber reading `base=100 / mine=999 / theirs=150` while the
publisher pushes a version where that cell is `7` clicked "take theirs" and got
`7`: their own value discarded for one the dialog never displayed, under a strip
saying the decision is not undoable. The dialog now echoes back what it showed
(`previewedVersions`) and `pull_all_updates` refuses with `CALP_REFRESH_MOVED` if
the workspace has moved either way — a version that is not the one shown, or an
update that appeared after the preview said there was none. Pulling the stale
previewed version instead would be the same lie pointed the other way: "refresh"
means "bring me the current one". An omitted list means the caller showed the
user nothing (the script gateway); an EMPTY list means "the preview found no
update", which is a claim the gate checks.

**A resolution could act on a cell the refresh never reached.** `accept_upstream`
is `remove_override`, which succeeds for any override present. If the new version
DROPS a sheet, its cells are absent from the payload, `rebase` skips every
override on it and the re-overlay skips it too — so "take theirs" deleted the
ledger entry while the grid, never re-materialized for that sheet, went on
showing the subscriber's own value: a local edit with nothing left to say it is
one. `KeepMine` was already inert there; `TakeTheirs` is now symmetric.

**A named-LAMBDA call was a permanent conflict.** Persistence writes the RAW
formula (`Cell::formula_string_raw`, so the resolved `__INVOKE__("Name", lambda,
…)` marker round-trips into an AST evaluation can use), while the override
baseline is recorded from the LIVE cell through `formula_string()`, which
collapses it. A cell holding `=Double(5)` therefore had a baseline that could
never equal its upstream: every refresh re-reported it as changed on both sides
even when the publisher had not touched it, the dialog showed the internal marker
to the user as "theirs", and one click on "Take all theirs" discarded the
subscriber's edit for a cell nobody had edited. In the other direction a
subscriber who typed the publisher's exact formula never auto-cleared. One
choke point, `override_value_from_saved`, now brings the stored text to the same
spelling through `engine::ast_render::collapse_formula_text` — a substring test
for a reserved name no user formula can contain, so it costs nothing anywhere
else. This is the error-literal hazard the same function's header already warned
about, one field over, and live.

#### Undo of a reset restored the cells and not the ownership (2026-09-02)

A spilled `2` and a typed `2` are the same bytes, so who owns which cells is not
recoverable from the grid at any price — which is why the extent is persisted
rather than recomputed (`spill_restore.rs`). `apply_calp_reset_restore` rebuilt
the grid and swapped the override layer and touched neither spill map, so after
Ctrl+Z the PUBLISHER's extents were still installed over the subscriber's
restored cells:

```text
published   B1 "=SEQUENCE(4)"  ->  B2:B4 = 2 3 4, owned by B1
subscriber  B1 = 7             ->  B2:B4 erased, claims released
reset                          ->  published grid + published claims back
Ctrl+Z                         ->  B1 = 7 again, claims STILL the publisher's
```

Three visibly empty cells that refused every edit, `check_spill_protection`
naming a formula the workbook no longer contained, for the rest of the session.
Nothing repaired it: the restored origin is a literal, and the post-restore
cascade only walks formulas. The snapshot now carries the claims and the restore
swaps them (`swap_sheet_spill_claims`, symmetric so undo/redo ping-pongs). The
function's EXEMPT entry in the spill census read "reports its sheet; apply_changes
cascades" — true of cells, false of ownership, and exactly the kind of exemption
that has to be argued; it is gone, and the swap is classified as maintenance.

#### The landing sheet was decided before it could be known (2026-09-02)

`materialize_pull_result` chose which sheet to activate inside the grid-lock
scope — thirty lines BEFORE `materialize_pulled_sheet_state`, the only code that
extends `sheet_visibility` for the appended sheets. Every probed index was past
the end of that vector, `is_user_sheet` reads a missing slot as `unwrap_or(true)`,
so `find` returned `base_index` unconditionally and the filter the comment
described could not skip anything. Moved after the materialization, and widened
to LANDABLE rather than merely user-owned: `activate_sheet` refuses an object
sheet AND a hidden one, and an application may legitimately begin with a hidden
sheet (`PublishedSheetMetadata` carries visibility, the pull restores it
verbatim). Naming one meant `setActiveSheet` came back "Sheet 'Raw' is hidden and
cannot be activated", which both call sites swallow into a `console.warn` — the
dialog closed, the tabs appeared, and the user was left on their own sheet with
nothing said.

#### Provenance is a question about a sheet, not about a position (2026-09-02)

`subscribedSheets.ts` held two maps from one snapshot: one keyed by `sheetId` for
the tab badge, one keyed by workbook INDEX for the four tab menu items. Its
refresh triggers are open / new / package-updated — none of which a drag, a
delete or a copy raises. Drag the subscribed tab and every menu item pointed one
sheet over: `Detach from "vendor-kpis"` offered on a sheet that had never touched
an application (and refused by the backend, after the confirm), while the sheet
still wearing the badge showed none of the three items the badge advertises. The
justification comment reasoned about the id-keyed provider and was accurate about
it.

The fix is not a fourth event. `SheetContext` now carries `sheetId`, the index map
is gone, and every consumer asks the question the badge asks — so the answer
cannot go stale, and a test proves it by reordering with no refresh at all.

`SheetTabs` had the mirror-image defect underneath it: `getSheets()` omits
object-backed sheets while keeping true indices, so `sheets[i].index === i` holds
only while every object sheet sits at the tail — which a `.calp` pull, a
drill-through sheet and a report-pages sheet all break by appending past it.
Eleven sites subscripted the list with a true index. Three were the context menu.
The other eight were worse and nobody had named them: `result.sheets[result.activeIndex]`
broadcasts `SHEET_CHANGED` and the Redux active sheet with one sheet's index and
another's NAME, and the shift-click 3D reference built `Sheet1:Detail!` out of two
positional lookups. One `sheetAt(list, index)` resolver, and a guard asserting the
file contains no `sheets[...]` subscript at all.

#### A cached result is not an edit (2026-09-01)

`cells_equal` compared every field of a cell entry, including `v`, `t`, `e` and
`sp` — all of which are DERIVED for a cell that carries a formula. Reported from
live testing: change one hard-coded number in a checked-out application, push,
and the diff claimed two cells changed — the number, and the `=C2*2` beside it
whose formula was identical on both sides. The second row was the first row's
consequence, listed as if it were a second decision. On a real sheet one edited
input produces a column of them, inflating the count the push dialog is gated on.

Subscribers and co-developers both recalculate on load, so:

- **Same non-empty formula on both sides ⇒ compare only the rich-text runs**, the
  one thing a person can author on a formula cell. A cell that GAINS or LOSES a
  formula still differs (`f` differs), and a LITERAL is compared in full, because
  for a literal `v` *is* the authored content.
- **Cells inside an unchanged spill extent are skipped.** A spilled cell is
  written as a value-only entry with no `f`, so it is indistinguishable from a
  literal on its own — but the origin's `f` + `sp` names the rectangle its result
  occupies, and everything inside is the engine's answer. Strict on purpose: the
  skip needs the origin present on both sides with the same formula AND the same
  extent, so a spill that moved, grew or shrank is compared normally.

`count_sheet_data_changes` and `walk_cells` apply both rules identically — they
are the counted and the itemised view of one question, read by the refresh
preview and the diff dialog respectively.

#### "Was this sheet in the base version?" is an identity question (2026-09-01)

The publish dialog marked a row "(new — not in v&lt;base&gt;)" by comparing NAMES
against `WorkingCopyLink::base_sheets`. Those names are recorded at CHECKOUT,
before `resolve_sheet_name_collisions` runs — and additive checkout makes that
collision ordinary: pull an application's `Sheet1` into a workbook that already
has one and the application's sheet becomes `Sheet1 (2)`.

Reported from live testing, and the failure is symmetrical: the application's own
sheet was marked new, while the author's unrelated `Sheet1` was silently counted
as part of the application. `PublishPreviewSheet` now carries `sheet_id` and the
dialog compares that. A working copy's sheet ids ARE the application's, so they
line up directly — that preservation is what checkout is for.

Note the default SELECTION was already correct: it comes from
`working_copy_base_sheets`, which is id-keyed. Only the marker was name-matched,
which is why the wrong sheets were labelled while the right ones stayed ticked.

### Subscribed sheets and publishing

A sheet materialized by a subscription is its publisher's content. It is therefore
**excluded from a publish by default** and disclosed under "Stays behind", naming
the application it came from. The author may still tick one deliberately, and that
gets its own "Will publish" line saying plainly that they are republishing another
publisher's content under their name.

This was not true until 2026-08-31: nothing on the publish path consulted the
subscription ledger, so publishing application B from a workbook subscribed to
application A shipped A's sheets inside B, counted as the author's own. The one
gate that existed refused only when the target NAME equalled a subscribed name —
it never compared workspaces, so two teams each publishing `sales` to their own
share collided, and it had no test.

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

This section described a `--dev` flag, a dev-channel URL and a "Publish to test
workspace" command. None of the three was ever built, and the shape they were
sketching arrived differently. What exists:

- **Working copy.** *Distribution ▸ Open Application for Editing* materializes an
  application into a workbook keeping its sheet ids, and *Push* publishes the
  next version through the base-version / merge / conflict gates. That is the
  iteration loop; see `calp-workspace-collaboration.md`.
- **Dev mode** (`calp_dev_subscribe`) answers the other question — *what will a
  subscriber see* — by materializing a local `.cala` with subscriber semantics and
  fresh ids. It is a preview, not a channel, and it is the only thing `--dev` ever
  meant.
- **Test before production is an ENVIRONMENT, not a second workspace.** "Publish
  to test workspace" would have meant two copies of the artifacts, two version
  lines, and a promotion that rebuilds rather than re-points — so what was tested
  would not be what ships. A push lands on the one line; promotion moves a named
  pointer.

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