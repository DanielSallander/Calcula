# .calp Workspace Collaboration — the author side

**Status:** Design, 2026-08-29. Companion to `calp-distribution.md`, which keeps
the SUBSCRIBER side (subscribe / refresh / overrides / writeback) unchanged.
This document covers the AUTHOR side: how one or more developers build, version,
and push a package.

Pre-production: no deployed users, no backward-compatibility obligation.

---

## 1. Why this document exists

`.calp` shipped as a publish/subscribe format: an author publishes a package,
subscribers pull it. That half works. The other half was never designed, and it
shows in the code:

- There is **no update flow**. The Publish dialog is seven blank fields on every
  open; to ship v1.1 the author retypes the registry path, the package name, the
  version, and a comma-separated list of sheet *indices*.
- A `.cala` workbook does **not know what it published**. The only trace is an
  audit line that is off by default.
- Republishing from a workbook that was *pulled* silently destroys the package's
  identity: `pull()` mints fresh sheet ids, so every subscriber's next refresh
  sees every sheet as removed-and-re-added and orphans their overrides.
- Nothing records **why** a version exists. No message, no lineage, no diff.
- Two developers pushing to one package is undefined behaviour: the second push
  succeeds and breaks every subscriber's trust pin at *their* next refresh.

The fix is not more fields on a dialog. It is a different mental model.

## 2. The mental model: a package is an application

Power BI users already have the model we want, so we borrow its shape:

| Power BI | Calcula | Status |
|---|---|---|
| Workspace | **Registry** (SMB share, HTTP host) | exists |
| Report / App | **Package** (named, versioned `.calp`) | exists |
| Dataset | `dataset`-kind package | exists |
| `.pbix` opened locally | **Working copy** — a `.cala` produced by *checkout*, carrying a *workspace link* | NEW |
| Publish from Desktop | **Push** — records base version + change summary | reworked |
| Version history | Package version list (immutable, retained forever) | exists, unsurfaced |
| Deployment-pipeline gates | **Push gates** | NEW |
| "Get the app" | Subscription (pull / refresh / overrides) | exists, unchanged |

### 2.1 The source-of-truth inversion

Today the `.cala` is primary and the `.calp` is an export of it. In the workspace
model **the package is the application**: canonical, versioned, collaborated on.
A developer's `.cala` is a *working copy of a package version*, the way a git
clone is a working copy of a commit.

Everything else follows from that sentence. A working copy knows which package
and which version it came from. A push is a new version of that package, not an
unrelated export that happens to share a name. History is the package's history,
not a folder of files somebody remembered to keep.

What does **not** change: the registry stays a dumb file host (an SMB share with
no server code), and therefore every gate is enforced **client-side**. That is a
deliberate limitation, stated plainly in `calp-distribution.md`, and this design
does not pretend otherwise. Gates protect developers from *accidents* —
overwriting each other, shipping without saying what changed, breaking
subscribers' trust pins. They are not a defence against someone with write
access to the share who is actively malicious; the signature and pin machinery
is what protects the *subscriber* from that.

### 2.2 A package is a decomposed application

The application is not a monolith. It is a tree of addressable **pieces**, the
way a `.pbip` project is a directory of files rather than one opaque `.pbix`:

```
package/
  sheets/{sheet_id}/data.json        <- cells (the grain BELOW the file: one cell)
  sheets/{sheet_id}/styles.json
  sheets/{sheet_id}/metadata.json
  charts/{chart_id}.json
  controls/{sheet_id}/{control_id}.json
  object_scripts/{script_id}.json
  modules/{module_id}.json
  models/{ds}/model.json
  ...
```

Each piece has a **stable identity** (a UUID v7 minted once and carried across
versions) and a **deterministic serialization** (identical content always
produces identical bytes, so a content hash means what it appears to mean).

Three things fall out of decomposition, and all three matter:

1. **Concurrent development composes.** One developer adds a button; another
   edits a formula on a different sheet — or a different cell of the same sheet.
   Those touch disjoint pieces, so both pushes land. Collision is defined per
   piece, not per package.
2. **Diffs are meaningful.** "What changed between v1.2 and v1.3" is answerable
   from the signed checksum maps before a single byte of content is parsed.
3. **The package is machine-readable.** A decomposed package is what git can
   diff and what an AI can read and edit — one chart is one file, one script is
   one file. That is a first-class goal, not a side effect: Calcula exists to
   give users back the ability to build their own solution, and an application
   an AI can read is an application its owner can change.

### 2.3 The three roles a `.cala` can hold

Per package, a workbook is exactly one of:

- **Working copy** — holds a `WorkspaceLink` to the package. May push.
- **Subscriber** — holds a `Subscription`. May refresh, may keep local
  overrides, may **never** push to that package.
- **Standalone** — neither. Its first publish makes it a working copy.

A workbook may be a working copy of package A and a subscriber of package B at
the same time; it may never be both for the same package.

This is the rule that closes the identity trap. A subscriber's sheets carry
freshly minted local ids, so a push from a subscribed copy would rewrite the
package's sheet identity and orphan every other subscriber's overrides. Rather
than let that happen silently, the push refuses and points at the right door:
*Open Package for Editing*.

## 3. Invariants

1. **Versions are immutable.** Publishing over an existing version is refused.
2. **Identity continuity flows only through checkout.** Checkout preserves
   package sheet ids verbatim; cell ids and reference-site ids ride inside the
   sheet payloads and survive with them. Every id in v(N+1) either came from a
   checkout of an earlier version or is genuinely new.
3. **Every push records its lineage**: the version it was based on and a
   human-written change summary, both inside the **signed** version manifest, so
   history cannot be quietly rewritten by editing a file on the share.
4. **A push whose base is not the registry head does not silently win.** It
   either merges (disjoint pieces) or is refused (overlapping pieces).
5. **Checkout runs the same trust gates as pull**: Ed25519 signature, TOFU
   status, `min_app_version`, and the full per-artifact checksum walk.

## 4. Push: the outcomes

A push compares three points: the version the working copy was **authored
against** (its link's base), the registry's current **head**, and the **working
copy** itself. Their diffs against the base give two sets of touched pieces, and
comparing those sets decides what happens.

- **Fast-forward** — base == head. Publish the next version.
- **Merge** — head moved, their changed pieces and yours do not overlap, and
  their changes are of a kind that can be brought into a working copy. The
  developer is shown both change lists ("They changed 1 cell on Summary; you
  changed 1 cell on Dashboard"), and on confirm the intervening changes are
  applied through the ordinary edit pipeline — one undo transaction, a real
  recalculation, the dirty flag, the events — after which the base moves to the
  head and the push is a fast-forward.
- **Conflict** — the same piece changed on both sides. Refused, naming the
  piece: *"Summary!B4 was changed on both sides."* There is no automatic merge
  inside a piece, and no last-writer-wins: silently discarding somebody's work
  is the Excel failure this project exists to end.
- **Cannot apply** — disjoint work, but the intervening change is of a kind this
  build cannot patch into an open workbook. Today that means anything other than
  cell edits: bringing across one chart, or one control, out of a published
  version needs a slice of the pull materializer that is not separately
  addressable yet. The remedy is a conflict's ("open the latest and re-apply"),
  but the *reason* is different and is reported differently — "we cannot do this
  for you yet" is not "you two collided", and conflating them would teach
  developers to distrust the conflict report.

Two safety rules, both of them about not overstating what was checked:

- **A capped diff cannot prove disjointness.** If either side's diff hit a
  budget, its piece set is a floor, and "no overlap found" would mean "none
  found in the part I looked at". The analysis refuses instead.
- **Piece-disjointness is not semantic independence.** Your new formula may
  reference a cell their change rewrote. No piece-level check can see that, so
  the merged result is always recalculated and the merge is disclosed in the
  push summary and the version history. A later refinement can walk the
  dependency graph and warn; recalculating and telling the truth about what was
  merged is the honest answer today.

## 5. Gates

Ordered, and each one either refuses with a specific reason or asks for an
explicit confirmation. The registry-fact gates live in core `publish()` and run
inside a single registry-lock critical section, so check-and-commit is atomic on
a dumb file share — a check performed outside the lock is a TOCTOU window, which
is what the code had.

| Gate | Kind | What it prevents |
|---|---|---|
| Workspace link matches target | refuse | Publishing into a package this workbook is not a working copy of. The remedy is an explicit "publish as a NEW package" choice — never a fallthrough that silently creates one from a typo. |
| Not a subscriber of the target | refuse | The identity trap (§2.3). |
| No pending cancelled recalculation | refuse | Publishing values that are lies. (Existed already.) |
| Change summary present | refuse | A history nobody can read. |
| Push mode: create-new vs update | refuse | Creating a package by mis-typing a name; updating one that does not exist. |
| Base version == head, or a merge was resolved | refuse / confirm | Losing a co-developer's version. |
| New version strictly greater than head | refuse | A version list where "latest" and "highest" disagree. |
| Publisher key continuity | refuse | Breaking every subscriber's trust pin. A legitimate second developer arrives through delegation (§7), not by pushing with a different key. |
| Validation (sheet indices, BI pivot fields, registry writability) | refuse | Broken or unwritable packages. (Existed already.) |
| Diff review, exclusion report, dropdown/macro warnings | confirm | Shipping surprises. |

The backend never takes an "I acknowledge" flag: it cannot verify that a human
read anything. The token it *can* verify is the base version the dialog showed —
which is exactly what the push carries.

## 6. Lifecycle walkthrough

**One developer, adding a button and a formula.**

1. *Distribution ▸ Open Package for Editing…* → pick registry, package,
   version (default: latest). The package materializes into a fresh workbook at
   full subscriber fidelity, keeping its sheet ids. The workbook is now a
   working copy based on v1.2.0.
2. Edit: drop a button on the dashboard, wire it to a macro, add a formula.
3. *Push* → the dialog says "Push to sales-report — package is at v1.2.0, you
   are based on v1.2.0", suggests v1.2.1, shows the changes since v1.2.0, and
   requires a sentence about what changed. Confirm.
4. It is published. Subscribers refresh and see *modified* sheets — same sheet
   ids, overrides intact.

**Two developers, disjoint work.** Alice checks out v1.2.0 and edits
`Summary!B4`. Bob checks out v1.2.0 and edits `Dashboard!D9`. Alice pushes
v1.2.1. Bob pushes: his base is stale, but the two cells are different pieces,
so he is shown both change lists, confirms the merge, and v1.2.2 contains both
edits. Same story if they edit different cells of the *same* sheet — the grain
is the cell, not the file.

**Two developers, disjoint work of different kinds.** Bob adds a button to
`Dashboard` while Alice edits `Summary!B4`. Whoever pushes second is told the
work does not overlap. If Alice pushed first, Bob can merge her cell edit and
push. If Bob pushed first, Alice is told she cannot merge a control yet and
should open the latest version — the work is compatible, the machinery is the
limit, and she is told which.

**Two developers, colliding work.** Both edit `Summary!B4`. The second push is
refused, naming the cell, the other developer, and the version that changed it.

## 7. Multiple developers

**Today's ceiling: one publishing key per package.** A profile holds exactly one
Ed25519 keypair, and it is the identity for *every* package that user publishes
and for writeback review. So "share the team key" is not a small compromise: it
overwrites each developer's personal publishing identity machine-wide, makes a
compromise team-wide, and removes attribution. The supported v1 arrangement is a
release manager — developers hand off working copies, one person pushes.

**The path: root-signed delegation.** A package's root key is the key that
published its first version — immutable, and therefore a usable anchor. The root
signs a `publishers.json` listing authorized delegate keys. A push is allowed
from the root or any listed delegate. Subscribers keep pinning **one** key (the
root) and verify a delegate's version by chain: the version is signed by K, and
K appears in a `publishers.json` signed by the pinned root. TOFU storage and its
UX do not change at all; the trust panel gains one line naming the delegate.

Its honest limit on a dumb file share: removing a delegate is
rollback-vulnerable — someone with write access can restore an older list. A
monotonic revision number plus a client-side high-water mark makes that
*detectable* rather than silent. True revocation means rotating the root, which
is out of scope here.

## 8. What stays as it is

- **Subscribers.** Nothing in the pull/refresh/override/writeback path changes
  its meaning. Refresh gets *more* honest (a real diff instead of a hardcoded
  zero), and that is the extent of it.
- **Dev mode** (`calp_dev_subscribe`) answers a different question — "what will
  a subscriber see" — by materializing a local `.cala` with subscriber
  semantics, fresh ids and all. It is a preview channel, orthogonal to checkout,
  and it is left alone.
- **The registry is not a trust signal.** Presence in a registry means
  published, not reviewed. Gates are a workflow, not a curation claim.

## 9. Known lossy edges when round-tripping through a package

A working copy is a materialized package version, so anything a package
deliberately does not carry does not come back:

- **Publisher exclusions** (e.g. pivot output regions) are holes by design.
  They are an anti-pattern for a package that will be checked out and pushed.
- **Comments** travel only if the base version opted in (`include_comments`).
- **Notebook outputs** are stripped at publish and never return.
- **Scripts arrive Restricted and consent-gated even for their author** — a
  checkout cannot distinguish "my own code" from "somebody's code I am about to
  run", and defaulting to trust would make checkout a code-execution vector.
- **Subscriber-local state** (connection strings, bookmarks, user files) is not
  package content and does not travel in either direction.

## 10. Implementation status

**Built (2026-08-29).**

- **Workflow.** `calp_checkout` opens a package as a working copy with its sheet
  ids preserved, reusing `pull()`'s artifact walk and all three trust gates
  through a `SheetIdMode`. `WorkspaceLink` persists in the `.cala`
  (`user_files/workspace_link.json`) as `Persisted<T>`, is reset by the shared
  document-replacement path, and is what the push gates read. `PushMode` makes
  create-vs-update a decision the caller cannot skip; the registry-fact gates
  moved into core `publish()` under one widened registry lock with a heartbeat,
  closing the check-then-commit race. `base_version` and `change_summary` are in
  the signed manifest. The push dialog reads as a push; the Package Explorer has
  a Workspace section; the Inspector's history table shows lineage.
- **Determinism.** `PublishedSheetMetadata`'s hidden-row/column sets serialize
  ordered, so identical content produces identical bytes. That was not
  cosmetic — it silently defeated blob dedup and would have made every diff
  report changes nobody made.
- **Diff.** `core/calp/src/diff.rs` in three layers (checksum set-difference,
  semantic object resolution, cell walk), with a `MemoryRegistry` so the
  working-copy side is produced by the REAL publish rather than a second
  serializer. Surfaced in the Inspector's Compare view, in the push dialog, and
  in the refresh preview — which now reports a measured `cells_changed` instead
  of the hardcoded zero it used to ask users to confirm.
- **Merge.** `core/calp/src/merge.rs` decides fast-forward / merge / conflict /
  cannot-apply at the piece grain, and `calp_push_merge_apply` brings the
  intervening cell changes in through the ordinary edit pipeline.
- **Delegation.** Root-signed `publishers.json`, chain verification on the
  subscriber side with the TOFU pin unchanged, `trustedDelegate` as its own
  trust state, and co-publisher management in the Workspace section.

**Not built yet.**

- **Per-object artifacts.** Charts, controls, slicers and the rest still travel
  as one grouped file per domain rather than one file per object. The diff's
  path classifier already routes both layouts, so the split is additive — but
  until it lands, a package is less git-diffable and less AI-readable than §2.2
  describes, and blob dedup is coarser than it could be.
- **Object-level merge.** See §4's `cannot apply`.
- **Delegate rollback prevention.** The revision high-water cache described in
  §7 is designed but not implemented; today a rolled-back `publishers.json`
  verifies.

## 11. Related documents

- `calp-distribution.md` — subscriber side, override/refresh semantics.
- `calp-writeback.md` — data collection back from subscribers.
- `docs/spec/calp-format.md` — the on-disk format.
- `script-package-manager.md` — library packages over the same machinery.
