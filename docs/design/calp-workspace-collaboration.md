# .calp Workspace Collaboration — the author side

**Status:** Design, 2026-08-29. Companion to `calp-distribution.md`, which keeps
the SUBSCRIBER side (subscribe / refresh / overrides / writeback) unchanged.
This document covers the AUTHOR side: how one or more developers build, version,
and push an application.

Pre-production: no deployed users, no backward-compatibility obligation.

---

## 1. Why this document exists

`.calp` shipped as a publish/subscribe format: an author publishes an
application, subscribers pull it. That half works. The other half was never
designed, and it shows in the code:

- There is **no update flow**. The Publish dialog is seven blank fields on every
  open; to ship v1.1 the author retypes the workspace path, the application
  name, the version, and a comma-separated list of sheet *indices*.
- A `.cala` workbook does **not know what it published**. The only trace is an
  audit line that is off by default.
- Republishing from a workbook that was *pulled* silently destroys the
  application's identity: `pull()` mints fresh sheet ids, so every subscriber's
  next refresh sees every sheet as removed-and-re-added and orphans their
  overrides.
- Nothing records **why** a version exists. No message, no lineage, no diff.
- Two developers pushing to one application is undefined behaviour: the second
  push succeeds and breaks every subscriber's trust pin at *their* next refresh.

The fix is not more fields on a dialog. It is a different mental model.

## 2. The mental model: what you publish is an application

Power BI users already have the model we want, so we borrow its shape:

| Power BI | Calcula | Status |
|---|---|---|
| Workspace | **Workspace** (SMB share, HTTP host) | exists |
| Report / App | **Application** (named, versioned `.calp`) | exists |
| Dataset | `dataset`-kind application | exists |
| `.pbix` opened locally | **Working copy** — a `.cala` produced by *checkout*, carrying a *working-copy link* | NEW |
| Publish from Desktop | **Push** — records base version + change summary | reworked |
| Version history | Application version list (immutable, retained forever) | exists, unsurfaced |
| Deployment pipeline | **Environments** — named pointers to versions on ONE line; promotion moves a pointer and copies nothing | NEW |
| Publish-time checks | **Push gates** | NEW |
| "Get the app" | Subscription (pull / refresh / overrides) | exists, unchanged |
| `.pbip` pointer file | **`workspace.calcula`** — names the workspace so a file dialog can select it | NEW |

### 2.0 Pointing at a workspace

A workspace IS a directory, but aiming a folder picker at one is awkward: you have
to navigate *into* it and confirm a window that looks empty. So a workspace also
carries a `workspace.calcula` pointer file, the same idea as `.pbip`, and the
normal way to select one is to pick that file.

Both spellings name the same workspace. `strip_workspace_marker`
(`core/calp/src/workspace_id.rs`) reduces the file form to its directory before
anything else happens, and it runs on **both** the scoping path and the opening
path. That is not tidiness — a publisher pin is filed under the scope derived
from the location string, so if the two forms scoped differently, one developer
who browsed to the pointer file and another who typed the folder would pin the
same publisher under two identities, and the second would be told a DIFFERENT key
owns the name. That is the hijack alarm, fired at a colleague. Three tests in
`workspace_id.rs` hold the two forms together, including the case-insensitive and
`file://` spellings, and one pins that only the EXACT marker name is stripped so
a folder merely ending in `.calcula` is never silently retargeted one level up.

The pointer file is written by `LocalWorkspace::write_application_manifest` —
**not** by the publish commands. That is deliberate, and it was not the first
design. There are four ways to put an application into a workspace (the workbook
publish, the model publish, the library publish and the skin pack), the call
originally sat in the workbook publish alone, and the other three therefore
produced workspaces full of applications with no pointer file. Writing the
application manifest is the one thing all four do, and placing an application is
exactly what makes a directory a workspace, so the marker belongs there: a rule
enforced at three call sites out of five is not enforced. `calp_add_workspace`
also writes one, for a workspace added before anything is published into it. It
is never written while merely reading — a workspace on a read-only share has to
stay browsable, so `LocalWorkspace::open` tolerates its absence.

**No dialog offers a folder picker as a FALLBACK.** Because publishing into a
location is what makes it a workspace, every workspace a subscriber or an editor
could reach already has a pointer file — Subscribe and Open-for-editing therefore
offer the file picker alone. The two PUBLISH dialogs each keep a second gesture
("New workspace…") for the one case a file picker cannot serve: you cannot aim it
at a `workspace.calcula` that has not been written yet, and that publish is what
writes it. Both go through the `pickWorkspace` seam
(`app/extensions/Distribution/lib/pickWorkspace.ts`); the model dialog used to
hand-roll its own directory picker, which is how it came to offer a folder
gesture only. The typed field remains everywhere, because an `https://` workspace
is reached by URL and never by a picker at all.

### 2.1 The source-of-truth inversion

Today the `.cala` is primary and the `.calp` is an export of it. In the workspace
model **the `.calp` is the application**: canonical, versioned, collaborated on.
A developer's `.cala` is a *working copy of an application version*, the way a
git clone is a working copy of a commit.

Everything else follows from that sentence. A working copy knows which
application and which version it came from. A push is a new version of that
application, not an unrelated export that happens to share a name. History is
the application's history, not a folder of files somebody remembered to keep.

What does **not** change: the workspace stays a dumb file host (an SMB share with
no server code), and therefore every gate is enforced **client-side**. That is a
deliberate limitation, stated plainly in `calp-distribution.md`, and this design
does not pretend otherwise. Gates protect developers from *accidents* —
overwriting each other, shipping without saying what changed, breaking
subscribers' trust pins. They are not a defence against someone with write
access to the share who is actively malicious; the signature and pin machinery
is what protects the *subscriber* from that.

### 2.2 An application is decomposed

The application is not a monolith. It is a tree of addressable **pieces**, the
way a `.pbip` project is a directory of files rather than one opaque `.pbix`:

```
application/
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
   piece, not per application.
2. **Diffs are meaningful.** "What changed between v1.2 and v1.3" is answerable
   from the signed checksum maps before a single byte of content is parsed.
3. **The application is machine-readable.** A decomposed application is what git
   can diff and what an AI can read and edit — one chart is one file, one script is
   one file. That is a first-class goal, not a side effect: Calcula exists to
   give users back the ability to build their own solution, and an application
   an AI can read is an application its owner can change.

### 2.3 The three roles a `.cala` can hold

Per application, a workbook is exactly one of:

- **Working copy** — holds a `WorkingCopyLink` to the application. May push.
- **Subscriber** — holds a `Subscription`. May refresh, may keep local
  overrides, may **never** push to that application.
- **Standalone** — neither. Its first publish makes it a working copy.

A workbook may be a working copy of application A and a subscriber of
application B at the same time; it may never be both for the same application.

This is the rule that closes the identity trap. A subscriber's sheets carry
freshly minted local ids, so a push from a subscribed copy would rewrite the
application's sheet identity and orphan every other subscriber's overrides.
Rather than let that happen silently, the push refuses and points at the right
door: *Open Application for Editing*.

**The role has to be VISIBLE, not merely enforced.** A working copy and a
subscribed copy look identical on screen and behave oppositely on Push, and for
a while the only surface that said which you held was the Working copy section
of the Application Explorer — a sidebar you had to go and open. A developer
working both sides at once loses track of which window is which, and finds out
from a refusal. So the status bar carries a permanent badge
(`DistributionRoleStatusItem`): *"✎ Working copy: sales-report v1.0.0"*, *"↓
Subscribed: vendor-kpis v2.1.0"*, both when both apply, and nothing at all for a
standalone workbook — a chip on every new file would be noise, and the status bar
is shared space. A stale working copy says so ("behind"), because that is the
push the base-version gate is about to refuse. Clicking opens the Explorer.

The window title would reach further — it is what the taskbar shows when two
instances are open — but the shell owns it (`dirtyStateBridge.ts`) and there is
no `@api` seam for it, so an extension cannot set it without one. That is a
seam worth adding if the badge proves not to be enough, not a rule worth
breaking.

**And PER SHEET, because the answer varies by tab.** The status chip answers
"what is this workbook"; a sheet that came from an application sits beside your
own, looks identical, and behaves oppositely on the one gesture that matters. So
the tab carries the same glyph the chip does, through a new general seam
(`@api/sheetTabDecorations`) rather than the shell reaching into Distribution: any
extension may mark any sheet for any reason.

Two marks, because there are two ways a sheet is not simply yours and they point
in opposite directions:

- `↓` **subscribed** — somebody else's. Refreshed from the workspace, your edits
  become overrides, and it stays OUT of your publishes unless you tick it.
- `✎` **working copy** — the application itself. A push CARRIES this sheet.

Telling a user "not yours" without saying which would be worse than saying
nothing: the two differ precisely on whether Push takes the sheet. The role
travels with the sheet in one snapshot (`calp_get_sheet_provenance` reports
`role`), so the tab, the context menu and the publish dialog cannot disagree.

Two things that seam does differently from the `columnHeaderOverrides` registry it
is otherwise modelled on, both deliberate. **Marks compose**: a sheet can honestly
be subscribed *and* protected, so every non-null provider answers rather than the
first one winning — first-non-null would let whichever extension registered at a
lower priority silently suppress the other. And it **carries a change channel**:
the canvas repaints every frame, so a canvas provider can be a pure pull, but the
tab strip is React and renders once — while extensions activate *after* it mounts
and a pull can land while it is up.

Working-copy sheets were NOT marked at first, and the reason is worth keeping
because it is what changed: while checkout REPLACED the document, essentially
every tab in a working copy came from the application, so a badge on all of them
was noise the status chip already covered. Checkout is now additive (§2.4), so a
working copy holds the application's sheets *and* the author's own, and the mark
earns its place there too — same rule, opposite answer, because the underlying
fact moved.

### 2.4 Checkout ADDS; it does not replace

*Open Application for Editing* used to behave like *File > Open*: it tore the
open document down and rebuilt it from the package. That made looking at an
application cost whatever you had on screen, and it was reported from live
testing twice in two days — first as a hard error ("Sheet index 1 out of range",
because the tab strip kept pointing at sheets the backend no longer had), then as
the complaint underneath it: *"when I open an application for editing it discards
the sheet I am working with."*

Checkout now appends, exactly as a subscribe does. The consequences are all
consequences of that one change:

- **A push carries the application's sheets only.** Publishing "every sheet" was
  a safe default when the document WAS the application; it now sweeps the
  author's unrelated work into somebody else's application. The default selection
  is the working-copy link's `base_sheets`, so a push adds a sheet only when the
  author ticks it (`working_copy_base_sheets`, pinned by
  `a_working_copy_publishes_only_the_applications_sheets_by_default`).
- **The workbook keeps its FILE.** The old checkout cleared the current path
  because it produced a wholly new document; clearing it now would turn the next
  Ctrl+S into a Save As for a file the user never closed.
- **The roles are enforced at the door, not discovered at the push.** A workbook
  holds one role per application and one working-copy link overall, so checkout
  refuses three overlaps by name and states the remedy:
  `CALP_CHECKOUT_ALREADY_OPEN` (you are already this application's working copy),
  `CALP_CHECKOUT_ALREADY_LINKED` (a workbook cannot be the working copy of two
  applications — a push would have no single answer to "which one?"), and
  `CALP_CHECKOUT_IS_SUBSCRIBER` (you subscribe to this application; a subscribed
  copy's sheets carry fresh local ids, and editing them AS the application is the
  identity trap of §2.3 wearing a different hat).

  **Both directions, which is a fix, not a symmetry for its own sake.** §2.3's
  rule reads "one role per application", but only checkout enforced it: nothing
  stopped a developer subscribing to the very application their workbook was the
  working copy of, which put the same sheets in the workbook twice — once theirs
  to push, once somebody's to refresh over. `calp_pull` now refuses that with
  `CALP_PULL_IS_WORKING_COPY` and points at dev subscribe in a new window, which
  is the surface that actually answers "what will a subscriber see". Both gates
  ask through `WorkingCopyLink::targets` / `subscribes_to`, which compare name
  AND workspace — two teams' identically named `sales` on different shares are
  different applications, and a gate that refused across them would be refusing
  for a reason that is not the reason it exists.
- **The user lands on the application.** The backend reports
  `first_sheet_index` — the TRUE state-vector index — rather than letting the
  frontend derive it from the sheet list, which omits object-backed sheets and so
  names the wrong tab as soon as a floating range exists. Subscribe learned this
  the expensive way; checkout inherits the answer instead of the lesson.
- **It is no longer a document-replacing path.** It was listed as the third
  member of `DOCUMENT_REPLACING_PATHS` in the document-store census and had to
  run `reset_document_scoped_stores`; it now belongs with pull and refresh, which
  materialize package content INTO the open document. Tearing the stores down
  would delete the BI connection the materialization had just created.

### 2.5 Environments: one line, named pointers

Before environments, **a push was a release.** The head of the version line is
what every `latest` subscriber's next refresh offers, so the moment a developer
pushed, every end user was offered the unreleased work. There was no way to test
a version before consumers saw it, no way to hold consumers on a known-good one
while development continued, and no way to roll them back without republishing.

An **environment** is a *named pointer to an immutable version on that same
line*. `test` points at v1.5.0; `prod` points at v1.2.0. Promotion moves the
pointer. Nothing is copied, nothing is rebuilt, and what was tested is
bit-for-bit what ships — the artifacts are content-addressed blobs shared at the
workspace root, so a promotion is one signed record and a manifest listing.

```
  Development line (immutable versions, one head)
  v1.2.0 ─ v1.3.0 ─ v1.4.0 ─ v1.5.0  (head — where every push lands)
     ▲                          ▲
   prod                       test        ← environments
```

**No environments by default.** An application that defines none behaves exactly
as it always did: one line, one head, `latest` resolves to it.

#### The decisions, and why

**One shared development line, not per-developer branches.** The diagram this
design started from had a Dev environment per developer. They collapse into one
line fed by N working copies: a developer's working copy *is* their personal dev
environment, and a push lands on the line through the existing gates (base
version, merge, conflict). Promotion has to be a pointer move, and a pointer move
needs linear history — the merge machinery only works inside a live workbook,
because it recalculates through the edit pipeline, and a headless
version-to-version merge needs the state-agnostic evaluator judged too large in
`open-items.md` §2.aa. "Draft" pushes off the line are a follow-on, not v1.

**Promotion is linear.** Environment N+1 takes environment N's *current*
version; the first environment takes any version on the line, defaulting to the
head. No skipping. A promotion that is not linear is refused by name
(`PromotionNotLinear`) and says what would be allowed.

**A rollback is the same command.** Moving a pointer to a version that
environment *previously held* — read from the signed log, never "any older
version" — is a rollback. Same gates, same signature, same log entry. Only the
presentation differs, and it differs loudly: the confirm says **OLDER**, the
subscriber's refresh card says *rolled back* in amber, and the version list a
rollback offers contains only versions that environment has actually run.
Offering "any older version" would be offering an untested promotion wearing a
rollback's clothes.

**Subscribers subscribe to an environment**, defaulting to the LAST one —
production by convention. An environment subscription follows the pointer
exactly: its `version_pin` is `""`, so any resolver that forgets the environment
branch fails loudly (`InvalidVersion`) instead of reporting "up to date" forever.

**Subscribing to the LINE on an application that has environments is an explicit
choice** (`followLine: true`), refused otherwise. The line receives every push
the moment it lands, which is exactly the accident environments exist to
prevent. The dialog offers it under *Advanced*, with the consequence spelled out.

**An application that grows a pipeline does not silently re-target its existing
subscribers.** Moving somebody's subscription because their publisher added
environments would change what they receive without their asking. The refresh
preview and the Subscriptions pane say *"follows the development line — switch
to prod?"* with a one-click switch, and *Not now* is a real answer.

**No rename in v1.** The name *is* the identity — subscriptions record it as a
string and there is no id behind it — so a rename would silently strand every
subscriber of the old name with no error anywhere. The pipeline editor offers
add, remove and reorder; a removed environment strands its subscribers *by name,
loudly*, and their next refresh names it and blocks Apply until they pick
another.

**Promotion is human-only in v1.** It is a trust decision, like adding a
workspace, so the script gateway does not expose it. A script *can* name an
environment when it subscribes, and gets the same "say what you mean" rule the
dialog does.

#### What is stored, and what is trusted

| Location | Content | Trust | Role |
|---|---|---|---|
| `{application}/promotions.json` | `PromotionLog`, each record Ed25519-signed by its promoter | per-record | **Authority.** `resolve_environment` folds this. |
| `calp-manifest.json` → `environments`, `promotionSequence` | ordered pipeline + current pointer per environment | unsigned | Cheap listing for browsing; written SECOND, self-corrects. |
| `.cala` → `Subscription.environment` | which environment this subscriber follows | local | Subscriber intent. |

**Per-record signatures, not a whole-file signature**, for the reason
`publishers::write_signed` is root-only: a whole-file signer would be vouching
for every earlier promoter's record. `package_name` and a dense `sequence` sit
INSIDE the signed bytes, so a record cannot be transplanted between applications
or re-ordered, and the signed struct carries **no `extra` flatten** — an unknown
field fails the signature rather than creating a split view.

#### Threat model, stated plainly

**The anchor is the subscriber's TOFU pin, not the workspace.** This is the one
thing an earlier draft of this section got wrong, and the correction is worth
the space. `publishers::root_key_of` derives an application's root from the
*lowest* entry of the **unsigned** `calp-manifest.json` version list, and reads
that version's manifest with no signature check. Anyone who can write to the
share can therefore plant a `0.0.1` naming their own key, sign their own
`publishers.json` and `promotions.json` under it, and point `prod` at any
version they like. TOFU did not catch it: TOFU checks the signature on the
version finally *pulled*, never the pointer that chose it, and the retarget only
ever names versions the real publisher signed.

So resolution takes an explicit anchor. `environments::PromotionTrust` has two
arms: `Workspace`, for a publisher acting on an application they can already
write, and `Pinned { scope, profile_dir }`, which builds the authorised set from
the key this machine pinned plus the delegates that pinned root vouches for — the
chain `integrity::delegate_is_authorized` already walks. **Every path that
decides what a subscriber receives passes `Pinned`**: `pull`,
`pull_all_updates` and `compute_preview`.

The honest limit: on a FIRST subscribe there is no pin yet, so the anchor falls
back to the workspace's own account. That is TOFU's existing first-use window one
level up — the same moment the version's signing key is accepted on sight and
pinned — and it is what makes the attack need a subscriber who is *already*
following the application. Every refresh after the first is anchored.

A share-writer **can** still replay an older signed log, rolling prod back to a
legitimately promoted earlier version. This is the same limit `publishers.json`
already documents, and it is detectable with a client-side high-water mark, which
v1 does not build.

**Removing a delegate revokes what they can still decide, not the history.**
Authorisation is checked per LOAD-BEARING record — the one whose effect survives
into the current state, which `Environment.sequence` already names — rather than
for every record in the log. An environment whose current pointer was set by a
since-removed delegate comes back MARKED (`unauthorizedPointer`): the Explorer
lists it and says so, `resolve_environment` refuses it so no subscriber follows
it, and any current publisher promoting into it again clears the mark.

Checking the whole log instead — which is what shipped first — made one
departure fatal: every environment vanished, every environment subscriber was
stranded, and `promote` and `set_pipeline` could not run either, because they
load the log before their own gates. The remedy this document asserted was
unreachable. Integrity failures (a bad signature, a sequence gap, a borrowed
package name) remain fatal for the whole log, because they say the file has been
edited and no part of it can be believed.

#### Writeback across environments

Submissions are stored under the version they were made against, and an
environment is a pointer to a version — so testers filling in test@v1.5.0 and a
production audience later promoted onto v1.5.0 land in the same tree. Every
`WritebackSubmission` therefore carries an `environment` tag, stamped at the one
point where a value leaves the machine (the authoritative submit, not the draft —
drafts persist in the `.cala` and can predate a switch), and every reader that
feeds a number filters on it through `calp::writeback::visible_in`.

**Carry-forward follows the environment's own history, not semver order.** A
rollback makes an environment's current pointer *lower* than a version it ran
last week; under a "strictly older" rule the subscriber's own submissions against
that newer version would stop counting the moment their environment was rolled
back, and re-appear if it were rolled forward again. A line subscription keeps
the semver rule it always had.

## 3. Invariants

1. **Versions are immutable.** Publishing over an existing version is refused.
2. **Identity continuity flows only through checkout.** Checkout preserves the
   published sheet ids (`package_sheet_id` on the wire) verbatim; cell ids and
   reference-site ids ride inside the sheet payloads and survive with them.
   Every id in v(N+1) either came from a
   checkout of an earlier version or is genuinely new.
3. **Every push records its lineage**: the version it was based on and a
   human-written change summary, both inside the **signed** version manifest, so
   history cannot be quietly rewritten by editing a file on the share.
4. **A push whose base is not the workspace head does not silently win.** It
   either merges (disjoint pieces) or is refused (overlapping pieces).
5. **Checkout runs the same trust gates as pull**: Ed25519 signature, TOFU
   status, `min_app_version`, and the full per-artifact checksum walk.

## 4. Push: the outcomes

A push compares three points: the version the working copy was **authored
against** (its link's base), the workspace's current **head**, and the **working
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
  addressable yet. The remedy is the same as a conflict's — open the latest
  version and re-apply your change — but the *reason* is different and is
  reported differently: "we cannot do this for you yet" is not "you two
  collided", and conflating them would teach developers to distrust the conflict
  report.

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
explicit confirmation. The workspace-fact gates live in core `publish()` and run
inside a single workspace-lock critical section, so check-and-commit is atomic on
a dumb file share — a check performed outside the lock is a TOCTOU window, which
is what the code had.

| Gate | Kind | What it prevents |
|---|---|---|
| Working-copy link matches target | refuse | Publishing into an application this workbook is not a working copy of. The remedy is an explicit "publish as a NEW application" choice — never a fallthrough that silently creates one from a typo. |
| Not a subscriber of the target | refuse | The identity trap (§2.3). |
| No pending cancelled recalculation | refuse | Publishing values that are lies. (Existed already.) |
| Change summary present | refuse | A history nobody can read. |
| Push mode: create-new vs update | refuse | Creating an application by mis-typing a name; updating one that does not exist. |
| Base version == head, or a merge was resolved | refuse / confirm | Losing a co-developer's version. |
| New version strictly greater than head | refuse | A version list where "latest" and "highest" disagree. |
| Publisher key continuity | refuse | Breaking every subscriber's trust pin. A legitimate second developer arrives through delegation (§7), not by pushing with a different key. |
| Validation (sheet indices, BI pivot fields, workspace writability) | refuse | Broken or unwritable applications. (Existed already.) |
| Diff review, exclusion report, dropdown/macro warnings | confirm | Shipping surprises. |

The backend never takes an "I acknowledge" flag: it cannot verify that a human
read anything. The token it *can* verify is the base version the dialog showed —
which is exactly what the push carries.

### 5.1 Promotion gates

Same shape, same lock, one difference at the top: **an empty authorised-key set
is a REFUSAL here**, where the push gate treats it as "no delegation configured,
root only". A promotion nobody can be shown to have authorised is worth less than
no promotion.

| Gate | Kind | What it prevents |
|---|---|---|
| Workspace is writable | refuse | A promotion that appears to succeed against an HTTP mirror. |
| Signing identity exists (`load_existing`, never `load_or_create`) | refuse | A promotion minting a publisher identity as a side effect. |
| Promoter's key is root or a listed delegate | refuse | Anyone with share write access retargeting `prod`. |
| Promotion log verifies, every record, no gaps | refuse | A tampered or truncated history read as a shorter legitimate one. |
| Environment exists in the pipeline | refuse | Promoting into a name nobody defined. |
| `expectedCurrent` matches the pointer the dialog showed | refuse | Promoting over a colleague's promotion that landed between render and click. |
| Target version exists, is signed, and its signer is authorised | refuse | Pointing an environment at something that was never legitimately published. |
| Not already there | refuse | A log full of no-ops. |
| Linear: the previous environment's version, or one this environment held | refuse | Skipping the pipeline, or "rolling back" to something untested. |
| Log written BEFORE the manifest listing | ordering | A listing that claims a promotion the signed log does not carry. |

Pipeline edits take an `expectedSequence` for the same reason a push takes a base
version: the workspace lock serialises two admins' writes but cannot see that the
second one's *read* was stale.

## 6. Lifecycle walkthrough

**One developer, adding a button and a formula.**

1. *Distribution ▸ Open Application for Editing…* → pick workspace,
   application, version (default: latest). The application materializes into a
   fresh workbook at full subscriber fidelity, keeping its sheet ids. The
   workbook is now a working copy based on v1.2.0.
2. Edit: drop a button on the dashboard, wire it to a macro, add a formula.
3. *Push* → the dialog says "Push to sales-report — application is at v1.2.0, you
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

### 6.1 Dev → Test → Prod, end to end

**Setting up.** `sales` has been pushed a few times and everyone subscribes to
whatever was pushed last. Developer A opens it for editing, opens the Application
Explorer's *Environments* section — *Development line — v1.4.0 (head)* and
nothing else — and clicks *Set up pipeline…*, taking the *test → prod* preset.
Nothing changes for subscribers yet: their next refresh preview says *"sales"
follows the development line, but the application now has environments (test,
prod). Switch to prod?* User X clicks *Not now*.

**Push.** A adds a button and a formula and pushes v1.5.0 — the same dialog as
before — and lands with *"Pushed sales v1.5.0 to the development line: 3 sheets.
test has nothing yet, prod has nothing yet — promote from the Application
Explorer."* No environment is chosen at push. A push is a push; deciding who
receives it is a separate, signed, attributed act, and keeping the two gestures in
two places is what stops "I saved my work" from meaning "I shipped to
production".

**Promote to test.** A clicks *Promote to test*. The window shows *test:
(nothing) → v1.5.0 (from the development line)* and, because test holds nothing
yet, says subscribers will receive v1.5.0 in full. A confirms. Tester T
subscribes: the dialog offers *test — v1.5.0 / prod — nothing promoted yet* with
prod pre-selected as the last environment; T picks test. T's status bar reads
*↓ Subscribed: sales (test) v1.5.0*.

**Fix and re-test.** T finds a wrong formula. A pushes v1.5.1 and promotes test
again — this time the window shows the one-cell diff test subscribers will see,
because test already held v1.5.0. T refreshes: *sales (test): v1.5.0 → v1.5.1*.

**Promote to prod.** On the test row A clicks *Promote → prod*: *prod: (nothing)
→ v1.5.1 (from test)*, signed with A's key and attributed in the Explorer, the
Inspector and the promotion log. Co-publisher B could have done it; a subscriber
could not.

**The end user.** X switches to prod from the Subscriptions pane, refreshes, and
sees *sales (prod): v1.4.0 → v1.5.1* — one card, the cell count, the conflicts if
any. X never saw v1.5.0. Testers' writeback submissions against test never reach
prod's aggregates: every submission is tagged with the environment it was made
in, and every reader that feeds a number filters on it.

**Rollback.** v1.5.1 breaks a sheet nobody tested. Prod has only ever held
v1.5.1, so *Roll back…* on prod offers nothing: the picker lists versions this
environment has actually run, and a version it never ran would be an untested
promotion wearing a rollback's clothes. The rollback happens one step up the
pipeline. A opens *Roll back…* on **test**, which has held both, and takes
v1.5.0. Then, on the test row, *Promote → prod*.

That second step moves prod BACKWARDS, and the window says so: the warning
follows the direction of the move, not the button that opened it, so promoting
a rolled-back test into a newer prod reads *Roll back sales prod* and confirms
*from v1.5.1 to v1.5.0 — an OLDER version*. X's next preview: *sales (prod):
v1.5.1 → v1.5.0 — rolled back*, in amber, overrides kept. Nothing was copied, no
version was deleted, the line still ends at v1.5.1, and the fix, when it lands as
v1.5.2, walks the same path: line → test → prod.

The linear rule is what makes this the only route, and it is worth stating
plainly: prod may take **what test currently holds**, or **a version prod itself
has held**. It may never reach past test for a version of its own choosing.

## 7. Multiple developers

**Today's ceiling: one publishing key per application.** A profile holds exactly
one Ed25519 keypair, and it is the identity for *every* application that user
publishes and for writeback review. So "share the team key" is not a small
compromise: it overwrites each developer's personal publishing identity
machine-wide, makes a
compromise team-wide, and removes attribution. The supported v1 arrangement is a
release manager — developers hand off working copies, one person pushes.

**The path: root-signed delegation.** An application's root key is the key that
published its first version — immutable, and therefore a usable anchor. The root
signs a `publishers.json` listing authorized delegate keys. A push is allowed
from the root or any listed delegate. Subscribers keep pinning **one** key (the
root) and verify a delegate's version by chain: the version is signed by K, and
K appears in a `publishers.json` signed by the pinned root. TOFU storage and its
UX do not change at all; the trust panel gains one line naming the delegate.

**Promotion rights are push rights.** A promotion is answered by exactly the
authorised-key set a push is — root, or a delegate in the root-signed
`publishers.json`. There is no separate promoter list and no per-environment
permission in v1: anyone the application trusts to publish a version is trusted
to decide who receives it, and every promotion is signed and attributed either
way. Per-environment permissions ("only Alice may promote to prod") are a v2
question, and `open-items.md` carries a row for it.

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
- **The workspace is not a trust signal.** Presence in a workspace means
  published, not reviewed. Gates are a workflow, not a curation claim.
- **Existing subscriptions.** An application that grows a pipeline does not
  re-target anybody. A line subscription keeps following the line until its owner
  chooses otherwise; the refresh preview and Subscriptions pane offer the switch
  and accept a refusal. The one thing that DOES change is honesty: both surfaces
  now say that following the line means receiving every push the moment it lands.

## 9. Known lossy edges when round-tripping through an application

A working copy is a materialized application version, so anything an application
deliberately does not carry does not come back:

- **Publisher exclusions** (e.g. pivot output regions) are holes by design.
  They are an anti-pattern for an application that will be checked out and pushed.
- **Comments** travel only if the base version opted in (`include_comments`).
- **Notebook outputs** are stripped at publish and never return.
- **Scripts arrive Restricted and consent-gated even for their author** — a
  checkout cannot distinguish "my own code" from "somebody's code I am about to
  run", and defaulting to trust would make checkout a code-execution vector.
- **Subscriber-local state** (connection strings, bookmarks, user files) is not
  application content and does not travel in either direction.

## 10. Implementation status

**Built (2026-08-29).**

- **Workflow.** `calp_checkout` ADDS an application's sheets to the open workbook
  with their sheet ids preserved (§2.4), reusing `pull()`'s artifact walk and all
  three trust gates through a `SheetIdMode`. `WorkingCopyLink` persists in the
  `.cala` (`user_files/working_copy_link.json`) as `Persisted<T>`, is reset by the
  shared document-replacement path, and is what the push gates read. `PushMode` makes
  create-vs-update a decision the caller cannot skip; the workspace-fact gates
  moved into core `publish()` under one widened workspace lock with a heartbeat,
  closing the check-then-commit race. `base_version` and `change_summary` are in
  the signed manifest. The push dialog reads as a push; the Application Explorer
  has a Working copy section; the Inspector's history table shows lineage.
- **Determinism.** `PublishedSheetMetadata`'s hidden-row/column sets serialize
  ordered, so identical content produces identical bytes. That was not
  cosmetic — it silently defeated blob dedup and would have made every diff
  report changes nobody made.
- **Diff.** `core/calp/src/diff.rs` in three layers (checksum set-difference,
  semantic object resolution, cell walk), with a `MemoryWorkspace` so the
  working-copy side is produced by the REAL publish rather than a second
  serializer. Surfaced in the Inspector's Compare view, in the push dialog, and
  in the refresh preview — which now reports a measured `cells_changed` instead
  of the hardcoded zero it used to ask users to confirm.
- **Merge.** `core/calp/src/merge.rs` decides fast-forward / merge / conflict /
  cannot-apply at the piece grain, and `calp_push_merge_apply` brings the
  intervening cell changes in through the ordinary edit pipeline.
- **Delegation.** Root-signed `publishers.json`, chain verification on the
  subscriber side with the TOFU pin unchanged, `trustedDelegate` as its own
  trust state, and co-publisher management in the Working copy section.

**Built (2026-08-31).**

- **Vocabulary.** The domain nouns are Power BI's throughout: Rust and TypeScript
  type names, the eight Tauri commands that carried the old noun, every
  user-visible string, and the docs. `package` and `registry` survive only where
  they are a CONTRACT — serde fields, on-disk filenames, the `caps.packages`
  script namespace, and the `"package-inspector"` window label. §2 is the map of
  which is which.
- **The workspace pointer file.** `workspace.calcula`, §2.0. Selecting a
  workspace is a file dialog now, and the file and its directory are one pin
  scope by construction.

**Built (2026-09-05).**

- **Environments** (§2.5). `core/calp/src/environments.rs` holds the model: a
  signed append-only `promotions.json` is the authority, the manifest listing is a
  cheap unverified mirror written second, and `resolve_environment` folds the log
  against the push gate's authorised-key set and fails closed.
  `SubscriptionTarget` makes "pin or environment" one interpretation nothing else
  parses — the `PushMode` precedent — and `VersionPin::parse` now REFUSES an
  `env:` or `channel:` prefix by name, so the dead magic-prefix convention cannot
  be reintroduced from a frontend string.
- **The dead `channel` fossil is gone.** `Subscription.channel` was documented as
  exactly dev/test/staging/prod and was 100% dead: written as `""` or `"dev"`,
  never read, with `AuditEvent::ChannelChanged` never emitted and twelve
  `version_pin.starts_with("channel:")` skip sites nothing ever produced. Deleted
  rather than reused — a magic pin prefix that opts a subscription out of trust
  verification is a trap this design must not inherit — and a census beside the
  other crate-walking guards keeps it deleted.
- **Publisher UI.** An Environments section in the Application Explorer, a
  promote/rollback window that shows the cell diff subscribers of THAT
  environment will experience (from the target's own pointer, not the source's),
  and a pipeline editor with no rename control and a reason on screen for its
  absence.
- **Subscriber UI.** An environment picker in Subscribe with the pin controls
  moved under *Advanced*, rollback cards in amber, per-subscription switching,
  and a refresh that BLOCKS on an environment that no longer resolves rather than
  applying the others around it.
- **Writeback across environments.** Every `WritebackSubmission` carries an
  `environment` tag stamped at the authoritative submit; every reader that feeds
  a number filters through `calp::writeback::visible_in`; carry-forward follows
  the environment's own promotion history rather than semver order. The rollup
  Parquet gained an `environment` column rather than splitting into per-environment
  files, because its path is a contract a database points at.

**Adversarial review and its fixes (2026-09-06).**

Twelve lens finders raised 116 findings over the changed files; each survivor
faced three independent refuters on separate lenses (does the code do this, can
the scenario be built, is it a defect or a deliberate decision) and lived only if
at most one refuted it. 96 confirmed, 25 refuted. Everything confirmed is fixed;
what the fixes changed about the DESIGN is recorded above rather than only here.

- **The trust anchor moved to the TOFU pin** (§2.5 threat model). Resolution now
  takes an explicit `PromotionTrust`; every path that decides what a subscriber
  receives passes `Pinned`.
- **Delegate removal no longer bricks the pipeline.** Authorisation is checked
  per load-bearing record, so an affected environment is marked and refused
  rather than the whole log being invalidated — and the documented remedy
  (re-promote) now runs, with a test that performs it.
- **`HttpWorkspace::read_application_artifact` exists.** It inherited the trait
  default `Ok(None)`, so over HTTP every application had no environments and no
  delegates: the follow-line gate could not fire and delegate-signed versions
  could not verify.
- **Two writeback readers carried forward by semver**, not by the environment's
  held versions: `rebuild_gather_cache` (so a rollback silently dropped that
  environment's own submissions from every `=GATHER()` total while the dashboard
  still counted them) and `reconcile_writeback_layer_internal`.
- **The submission fold keyed grid slots without the environment**, so one person
  answering the same cell in test and in prod lost the older answer before any
  reader's filter could see it.
- **An upstream-removed sheet is tombstoned with its identity** and re-adopted in
  place on roll-forward, instead of sharing the reason-less list with user
  detach — which froze the tab forever and stripped its publish exclusion.
- **`cap.pkgBrowse` and `cap.pkgInspect` were dead** since the vocabulary rename:
  they sent action names `Action::parse` does not accept, and were refused before
  the audited capability check so the denial was not even recorded. A drift guard
  now asserts every action string the host sends is one the gateway parses.
- **Promote/rollback presentation follows the DIRECTION of the move**, not the
  button that opened the window; §6.1's walkthrough was also narrating a
  promotion the linear gate refuses.
- **Six source-text guards were green under their own named sabotage** and are
  now argument- and expression-precise; the follow-line gate had no test at all.
  Verified by running each sabotage.

**Second review, scoped to those fixes (2026-09-06).**

The fixes above added the trust anchor, the load-bearing authorisation check, the
tombstone and the timestamp arbitration, and none of that had faced a pass. A
second review scoped to the fix diff confirmed 48 findings, **44 of them
introduced by the fixes** — a worse ratio than the code they repaired, which is
the argument for reviewing a large fix diff as its own change.

- **The pin is not the root key.** `integrity.rs` pins whatever signed the FIRST
  version this machine pulled, which on a co-published application is routinely a
  DELEGATE. The `Pinned` arm asked `publishers::load_verified` to check a
  root-signed list against a delegate's key, got `PublisherListInvalid`, and
  propagated it — every environment refresh permanently broken for exactly the
  delegated deployment the feature exists to serve. `authorized_from_pin` now
  accepts the pin as either root or delegate. A refuter reproduced this live.
- **`promote` folded without marking**, so a legitimate publisher promoting from
  an unvouched SOURCE laundered that pointer onward.
- **A de-authorised pipeline editor marked everything, unrecoverably**, and the
  remedy the code and the UI both name did not exist: `EnvironmentAlreadyAt`
  refused re-promoting the version an environment already holds, which is the
  only repair available when there is nothing newer on the line. The no-op gate
  now exempts an unvouched pointer, and the Explorer carries a **Re-promote**
  button — previously the row offered no reachable control at all.
- **Promotion history was rendered as verified.** A record's signature proves it
  was not edited; it says nothing about whether the signer may promote. Entries
  now carry `authorized` and unauthorised ones are named in the table.
- **The anchor was applied unevenly.** Review, the stranded-subscription
  pre-check, the environment switch and the follow-line gate still resolved
  against the workspace's own account, so they answered a different question than
  the pull. A source-text guard now pins all six call sites.
- **Tombstone re-adoption was core-only** — the app-layer materializer still
  appended a second grid and desynced the ledger.
- **Cross-version arbitration compared timestamps as raw strings** while the
  crate's own `fold::cmp_timestamps` parses them, so
  `2026-01-01T10:00:00+02:00` (08:00Z) sorted after `2026-01-01T09:00:00Z`.

**Not built yet.**

- **Per-object artifacts.** Charts, controls, slicers and the rest still travel
  as one grouped file per domain rather than one file per object. The diff's
  path classifier already routes both layouts, so the split is additive — but
  until it lands, an application is less git-diffable and less AI-readable than
  §2.2 describes, and blob dedup is coarser than it could be.
- **Object-level merge.** See §4's `cannot apply`.
- **Delegate rollback prevention.** The revision high-water cache described in
  §7 is designed but not implemented; today a rolled-back `publishers.json`
  verifies.

## 11. Related documents

- `calp-distribution.md` — subscriber side, override/refresh semantics.
- `calp-writeback.md` — data collection back from subscribers.
- `docs/spec/calp-format.md` — the on-disk format.
- `script-package-manager.md` — library packages over the same machinery.
