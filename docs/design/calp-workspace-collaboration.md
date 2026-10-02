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
location is what makes it a workspace, every workspace a subscriber, an editor or
a reviewer could reach already has a pointer file — Subscribe, Open-for-editing
and the Application Inspector therefore offer the file picker alone. The
Inspector was the exception until 2026-09-25: this paragraph listed the dialogs
its author knew about, the Inspector is a separate window, and it kept a raw
folder picker that nobody had decided it should have. The rule is now a scan
(`workspacePickerSeam.test.ts`) that fails on any native open picker in the
extension outside the seam, rather than a list. The Inspector's typed field still
accepts an application or version folder and walks up from it, which is the one
thing its folder picker did that the file picker cannot. The two PUBLISH dialogs each keep a second gesture
("New workspace…") for the one case a file picker cannot serve: you cannot aim it
at a `workspace.calcula` that has not been written yet, and that publish is what
writes it. Both go through the `pickWorkspace` seam
(`app/extensions/Collaboration/lib/pickWorkspace.ts`); the model dialog used to
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
(`CollaborationRoleStatusItem`): *"✎ Working copy: sales-report v1.0.0"*, *"↓
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
(`@api/sheetTabDecorations`) rather than the shell reaching into Collaboration: any
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
- **A push carries the application's CODE only.** The same sweep applies to
  everything workbook-scoped: the author's own scripts, notebooks, names and
  pane controls, and every other subscription's object scripts and custom
  functions, sit beside the application's. §3 invariant 7 (BUG-0261) is the
  filter, and the push report names what it withheld.
- **Nothing is merged by identity.** Two items with one id cannot both be kept,
  and picking one silently made the author's own macro, notebook or name the
  application's at the next push. Checkout refuses such a workbook up front
  (`CALP_CHECKOUT_COLLISION`, §3 invariant 10) and offers to check out into a
  new workbook instead.
- **The application's code does not run beside your own sheets.** An approved
  macro can read every sheet, and what it writes into the application's sheets
  goes out with the next push, so while any sheet outside the working-copy
  link's base sheets holds a cell, the application's macros, object scripts and
  script libraries are refused (`APPLICATION_CODE_BESIDE_PRIVATE_SHEETS`, §3
  invariant 15). The Checkout dialog names those sheets and offers to open the
  same version in a new workbook.
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
legitimately promoted earlier version. This is the limit `publishers.json` had,
and it is detectable with a client-side high-water mark. Since 2026-09-30 the
developer side of `publishers.json` keeps one (the developer anchor, §3 invariant
12); the promotion log does not, and a subscriber keeps no mark for either.

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
6. **What a working copy is made from must be signed by an authorised
   publisher, anchored at the root** (BUG-0262, 2026-09-29). A signature only
   proves the bytes were not changed; a working copy is where the next SIGNED
   push comes from. So `calp::checkout` refuses a version whose signer is not
   the root or a co-publisher the root lists
   (`calp::publishers::authorize_signer`), and so do the push merge (head AND
   base, analyze AND apply) and the push dialog's hold-back, through
   `calp_inspector::open_authorized_content`. The root is the lowest listed
   version PROVED by its own signature, never the head or the predecessor
   (one or two planted versions would vouch for themselves), and it fails
   CLOSED: an unsigned or unverifiable first version refuses rather than
   meaning "nothing to enforce". The Checkout dialog shows the signer, its key
   fingerprint, its authority, "your key" (display only — signed with your key
   is not written by you) and the trust status. Every such refusal -- at
   checkout, the merge and the hold-back -- leaves an always-on
   `AuditEvent::SignerRefused` row naming the door, the version, the signer and
   their key fingerprint (review 2026-09-30). The stale-push banner names the
   head's SIGNER from its verified manifest (`MergeAnalysisResponse.headSigner`),
   never the unsigned listing's `published_by`; and the merge and the hold-back
   re-check each sheet they read against the verified manifest's checksum, so a
   sheet swapped after the verification walk is refused, not written. The two
   residuals this left -- the version LISTING is unsigned, so a share-writer
   could plant a fake *signed* first version; and a ROLLED-BACK
   `publishers.json` (an older list the root really signed, restored with its
   signature) re-authorised a removed co-publisher undetected -- are closed on
   the developer side since 2026-09-30 by the per-machine developer anchor
   (invariant 12), which `authorize_signer` consults BEFORE it judges the
   signer.
7. **A push carries only this application's content, and says what it left
   behind** (BUG-0261, 2026-09-29). Checkout is additive (§2.4), so a working
   copy holds the author's own content AND whatever its other subscriptions
   brought in, beside the application's; everything a push carries is signed
   under the pusher's key and core publish scrubs provenance. One filter,
   `calp_push_scope::withhold_content_not_in_application`, called from the one
   assembly publish, the preview, the working-copy and subscriber diffs and the
   push merge share, keeps THIS application's content -- stamped with its name
   (the workbook holds this workspace's application of that name -- as its
   working copy, or, for a subscriber's "view changes" diff, as a subscription;
   a real push from a subscriber is refused before assembly -- and no OTHER
   subscription's ledger claims it), or the author's own unstamped content that
   the base version already carried (the working-copy link's record; a
   standalone workbook's first publish has none, ships the author's own, and
   that push becomes the record) -- plus the author's own LOCAL object scripts,
   which ship with their host. A link records EVERY list (one
   `calp::WorkingCopyContent`), so an empty list means "the application has
   none" and an application with no scripts still keeps the author's private
   module home. A link from before the record existed gets NO fallback (it used
   to publish everything): the filter reads its missing lists as empty, and a
   real push from it is refused, with the remedy (`CALP_PUSH_LINK_UNRECORDED`,
   `calp_commands::unrecorded_link_refusal`). It withholds the rest:
   - **object scripts** stamped with another application, or claimed by a
     subscription (a same-named application on another share stamps the same
     name), any object script whose pane control stays behind, and the
     author's LOCAL object script bound to a control, chart, slicer or timeline
     on a sheet the push does not carry (review 2026-09-30: additive checkout
     leaves the author's private sheets beside the application, and their
     scripts shipped host-less, signed under the author's key);
   - the **Custom Functions library**, per function: another application's
     functions, and the author's own functions the base did not carry
     (`WorkingCopyLink::base_custom_function_names`, an `Option` like the pane
     list). Checkout records the functions its per-function merge STAMPED, not
     the incoming names, because the merge keeps the author's function when the
     names collide and recording the name would ship the author's as the
     application's. What ships leaves provenance-clean (no
     `sourcePackage`/`sourceDigest`); a library the application never had stays
     behind whole, named function by function;
   - **module scripts and notebooks** stamped with another application (always,
     even on a first publish), and the author's own ones the base version did
     not carry;
   - **pane controls** a subscription claims, and the author's own ones the base
     did not carry (`WorkingCopyLink::base_pane_control_ids` -- an `Option`, so
     "the application has none" is not read as "not recorded");
   - workbook-scoped **names** the base did not carry.
   Every withheld item travels BY NAME in `PublishReport.withheld` and the
   Publish dialog shows it from the preview it runs on open -- before, the
   private items reached only the log, a silent drop to the person pushing. The
   limits: a stamp is a NAME, so per-function Custom Functions provenance cannot
   tell two same-named applications on different shares apart (the library is
   one merged record with no per-function ledger); a new pane control or custom
   function authored in a working copy stays behind -- named -- until the push
   dialog can add it (a new module, notebook or name CAN be added since
   2026-09-30, with its code on screen: invariant 13); a
   custom function whose NAME collides with one of the author's own still costs
   the application that function on the next push (visible in the push
   preview's diff, and the author's function is named as withheld), because
   checkout's collision refusal (invariant 10) exempts the Custom Functions
   library, whose record id is shared by design; and a LOCAL object script
   whose binding the filter cannot resolve to a host (an id that names no
   known control, chart, slicer or timeline) still ships, as before.
8. **A working copy HOLDS its application's button code, and a push publishes
   it back only when the signed base carries those exact bytes** (BUG-0257,
   2026-09-30). A button control's code is its `onSelect` (inline source) and
   `macroRef` (a macro id). Subscribe and refresh used to STRIP both (since
   phase 3 they keep a link to a macro the pull applied, held -- invariant 14
   -- and since phase 4 static inline code, held -- invariant 16); a dev pull
   still strips both. Checkout used to strip them too, so every untouched push published
   the application's buttons without their code. Now checkout's admission --
   the one step that varies by mode (`held_button_code::admit_wiring`; image
   migration, the 64 KiB clamp and the 32 MB budget run on every door, and the
   clamp's count is returned in the checkout response) -- MOVES each non-empty
   slot into `heldOnSelect` / `heldMacroRef`, which NO click reads, stamped by
   Rust with `heldFrom` = (workspace scope id, application, version) and stored
   `static` (the package's value type is kept in the stamp). A held key a
   package carries is discarded first, on every door. The push releases the
   compartment on the publish CARRIER only (`release_for_push`, in the one
   assembly publish, the preview and the diffs share): a held slot goes back
   live when the link targets this application, the stamp names it and this
   workspace at a version the working copy is based on, the sheet is a base
   sheet, the live slot is absent, AND sha256(valueType, value) is among the
   executable values of the SIGNED base's `controls.json` (read through the
   authorised reader, its checksum re-verified). Anything else refuses the push
   and names the button (`CALP_PUSH_HELD_CODE_UNVERIFIED`): a working copy is a
   `.cala`, and a crafted one can carry any held bytes with any stamp. Held keys
   never reach `controls.json`; the live store is never re-armed. LIVE code the
   signed base does not have -- the author's own, or bytes a file brought in --
   goes out only when the push request acknowledges each piece by hash
   (`acknowledgedButtonCode`, `CALP_PUSH_BUTTON_CODE_UNREVIEWED`); the push
   dialog shows it WITH the code and asks for a tick per piece (the review
   follows the sheets ticked, and a push refused over button code fetches it
   again), and the push preview's diff shows button code before/after per cell.
   A push that is NOT of the working copy's application (a publish as a new
   application, a scripted publish) restores nothing and refuses nothing: the
   held code is listed as withheld (`ButtonCodeRelease.withheld`) and the
   buttons go out without it. Both push refusals leave an always-on
   `AuditEvent::ButtonCodeRefused` row naming the cells
   (`held_button_code::refuse_push_on_button_code`), and a scripted publish can
   never acknowledge code (pinned by the gateway's census). The signed base is
   opened ONCE per assembly for both channels (`SignedBase`; signature and
   signer checked, each artifact read re-verified against its checksum). Nothing
   writes a held key: the property door refuses it by name, the metadata door
   (paste, duplicate, insert) strips it, a script is refused it
   (`SCRIPT_REFUSED_SHAPE_PROPERTY_KEYS`), and a MOVE (`move_control`, which the
   floating/in-cell toggle uses) carries it -- and re-keys the button's
   object-script bindings with it, undoably. The author replaces held code only
   through the Properties pane's "Replace the application's code", which shows
   it first; their first real code write then releases the whole compartment as
   one undoable step, and a "" write to an absent slot of a held button is a
   no-op (the blur-commit that used to erase it). "Remove the application's
   code", shown and confirmed the same way, discards it as one undoable step
   (the `replaceHeld` flag on `set_control_property`) -- without it an
   application button's action could not be removed at all. The code is visible
   where it lives: the Properties pane (read-only, saying whether it runs --
   "Runs when clicked, after you approve the application's code." -- or why it
   never runs here), Code in This File (each held inline action with its
   approval state since phase 4; "links <application>'s macro, runs after
   approval" for a held link), the approval screen (every button action's code
   and every cell it sits in), and the delete-a-macro warning. Held INLINE code
   runs since phase 4, after the approval of its exact bytes, through the Rust
   button door (invariant 16), and a held macro LINK since phase 3 (invariant
   14) -- both only while none of the developer's own sheets sit beside the
   application (invariant 15). "Make this my own" moves held code into the
   author's own slot (invariant 18). The limits: a button whose code
   a colleague changed in a later version refuses the
   push after a merge until the author re-opens or replaces it; and no `.cala`
   format change -- an older build ignores the held keys, which loses code but
   misreads nothing.
9. **A button CELL from an application runs only a macro that application
   brought into the workbook, or a command from Calcula's list after its own
   approval** (BUG-0260, 2026-09-30; the command list is M8's, 2026-10-01). A
   `calcula.button` cell carries its action in its cell-type params (`{kind:
   "script", scriptId, functionName?}` or `{kind: "command", commandId}`), and
   those travel as the `cellType` custom object. They used to materialize byte
   for byte on every door, and a click resolves the script id against EVERY
   module in the workbook -- so an application's button naming `macro-report`
   ran the subscriber's, or at a checkout the developer's, own `macro-report`,
   unlocked, with a call of the publisher's choosing appended; a command action
   fired any extension command on one click. Now every door that brings an
   application in -- subscribe, refresh AND checkout (a dev pull carries no cell
   types) -- runs `button_cells::admit_button_cells`: Rust stamps every button
   cell `fromApplication` = (workspace scope id, application, version), a
   package's own `fromApplication` / `heldAction` discarded first. A script
   action is kept only when its id is among the modules THIS pull actually
   applied for the application -- `materialize_distributed_scripts`' applied
   list, which the pull door and the refresh door now run BEFORE the cell types
   (lock order media -> controls -> script maps -> cell types, never nested,
   pinned by a census) -- never the incoming list, because an id the pull
   SKIPPED on a collision is exactly the id that names somebody else's macro.
   A command action is kept, live and stamped, on every door, checkout
   included, only when it is on Calcula's list
   (`button_cells::DISTRIBUTABLE_BUTTON_COMMANDS` -- EMPTY by owner decision, so
   today no command from an application is kept). Every other action (a macro
   the pull did not apply, a command not on that list -- named as such -- or a
   kind this build does not know) is REMOVED on a subscribe or refresh and named in the response
   (`buttonActionsRemoved`, shown by the Subscribe and Refresh dialogs), and
   HELD at a checkout in `heldAction`, which no click reads (`buttonActionsHeld`,
   shown by the Checkout dialog). The push releases the carrier's cell types in
   the one assembly (`release_cell_buttons_for_push`): the stamp never ships, and
   a held action goes back only by the same judge as a held control
   (`judge_held`) against the button-cell actions of the SIGNED base, so an
   untouched push republishes the `cellType` payload byte for byte and anything
   else refuses the push naming the cell (`CALP_PUSH_HELD_CODE_UNVERIFIED`). A
   LIVE action the signed base does not carry -- a new button, or one re-pointed
   at another macro -- is unreviewed and needs the same acknowledgement by hash
   as a button control's new code, with the action on screen; the version diff
   names the cell and shows the action before/after (`diff.rs`, the
   `customObject` arm for button-cell payloads); Code in This File lists held
   cell actions and the delete-a-macro warning names button cells, live and
   held (review 2026-09-30).
   The click is a second, independent layer, in Rust since phase 4: the button
   door (`run_control_action` -> `plan_cell_action`,
   `app/src-tauri/src/scripting/control_action.rs`) refuses a stamped button
   whose module did not come with that application, before any call could be
   composed, and records each such refusal itself as an always-on
   `ButtonCodeRefused` row (through `audit_button_refusal_core`, which reads the
   application from the cell's own stamp, never from the page; the page's
   `audit_button_refusal` -- renamed from `audit_button_cell_refusal` when phase
   3 gave button controls the same row -- now records only refusals the page
   itself makes). A stamped COMMAND runs only when three things hold, each
   asked by its own side: it is on the list; its LIVE registration opts in
   (`distributableTrigger` on the registered command object, which must not be
   shadowed -- stacked over another, re-registered after being taken back, or
   flagged without being frozen at registration -- and must be enabled); and the
   person approved it under its OWN key, `button-commands:<application>`, never
   the application's bare record (which would also open its object scripts).
   The door asks the list, the approval and the private-sheet rule
   (`application_code_gate::button_command_gate`; refusals are always-on
   `ApplicationCodeRefused` rows, surface `buttonCommand`, reasons
   `notAllowlisted`, `notConsented`, `privateSheets`, `stateUnavailable`) and
   records no run; the page then checks the live registration (its own
   refusals recorded through `audit_button_refusal`) and asks
   `authorize_button_command`, which compares the claim with the stored cell
   (`triggerMismatch`), asks the gate again and writes the always-on
   `ApplicationCodeRun` row; only then does the command run. The approval
   screen lists command buttons by application, naming the ones that will not
   run, and Code in This File lists them with their state. Adding a command to
   the list is a Rust edit (`button_cells.rs` and the test that pins the list
   empty, together; a drift test holds the list and the flagged registrations
   equal). Nothing but the
   admission writes a held action: the cell-type write doors refuse
   `heldAction` by name, and the script door (`range.setCellType`, which fell
   through `vSetState`'s `return true`) refuses `heldAction`,
   `fromApplication`, and any `action` on a button cell -- a script may not arm a
   button. The limits: a subscriber's "view changes" diff shows a removed action
   as a change the reset would not undo (the reset re-admits); and a cut/paste of
   a button cell does not exist today, so whether one carries the stamp is
   decided when it does (the stamp only narrows, so it may).
10. **A checkout never merges an application item into one of the workbook's
    own that has the same identity** (BUG-0264, 2026-09-30). Checkout is
    additive (§2.4), and for module scripts (macros), notebooks and defined
    names it used to decide silently on every id both sides use: the
    materializer KEPT the workbook's item and dropped the application's, while
    the working-copy link recorded the id -- taken from the incoming lists -- as
    the application's. The next push's filter (invariant 7) keeps by id, so the
    author's own `RATE`, pointing at a sheet the application does not contain,
    or their private `macro-report`, shipped signed as the application's; and
    the application's own copy was gone from the new version besides. Which of
    two same-id items is "the application's" is not knowable once one is
    dropped, so `calp_checkout` now REFUSES before its `DocumentEffect`
    (`checkout_collisions::refuse_checkout_collisions`, after the role gates):
    `CALP_CHECKOUT_COLLISION` names every colliding item, whose it is (yours,
    or another application's -- by its stamp, or by the subscription whose
    ledger claims it), what opening it here would have done, and the remedy.
    The Open for Editing dialog offers that remedy as a button, **Check out into
    a new workbook** -- it replaces the open workbook the way File > New does,
    asking first when there are unsaved changes (fail closed) -- and the other
    remedy is to rename or remove the workbook's own item. Not a collision: the
    Custom Functions library record (its id is the same in every workbook and it
    merges per function; see invariant 7 for what a per-function name clash
    still costs), and an item stamped with THIS application's name that no
    subscription claims (a leftover of an earlier copy, which the checkout
    replaces). A refusal is a lever -- an application can ship a module id that
    matches a predictable local one (`macro-<slug>`) and block every developer
    who owns it -- so every refusal is written to the audit trail with the
    colliding ids (`AuditEvent::CheckoutRefused`, always recorded, shown as
    "Checkout refused" in the audit viewer). The limits: the gate reads the
    workbook before the materializer writes, so an item created in that window
    by another command is still preserve-local'd (the pre-fix behaviour, for
    that one item); and object scripts and pane controls, whose ids are
    EntityIds, are not checked.
11. **A slicer's computed properties travel with it** (BUG-0263, 2026-09-30;
    owner decision: to subscribers as well as through a working copy). Every
    door used to empty them (`sanitize_distributed_slicers`, on the on-grid
    controls' precedent), so an untouched push republished every slicer without
    them. A computed property is a FORMULA that sets one of twelve clamped
    presentation attributes of its own slicer, run by the cell evaluator with
    less reach than a cell formula (no file reader, no pivot lookup, no
    user-defined functions); cell formulas already travel in every pulled sheet,
    and `controls.rs` classes a formula property as evaluated, not executed. So
    subscribe, refresh and checkout all install them live, through the installer
    `.cala` load uses (properties and the dependency index as one act). They
    name sheets by NAME, so a collision rename reaches them on the way in
    (`SheetRenames::rename_slicer_formulas`, part of `rename_pull`) and the push
    puts the published names back (`restore_published_sheet_references`); an
    untouched push republishes `slicers.json` byte for byte, and the version
    diff compares their formulas spelling-blind (`comparable_rule_payload`'s
    `slicer` arm), so a round trip that re-spells `=data!a1` as `=Data!A1` is
    not a change.
12. **This machine remembers who created each application it develops** (the
    developer anchor, 2026-09-30 -- the piece of BUG-0257's hardening phase that
    had to land before phase 3). Invariant 6 PROVES the root by its own
    signature but FINDS it through the unsigned version listing, and nothing
    remembered the co-publisher list's `revision`. `core/calp/src/developer_anchor.rs`
    keeps `developer-anchors.json` in the profile directory -- its own file,
    never a TOFU pin (a developer opening an application agreed to receive
    nothing; the three pin-store censuses are unchanged, which is the proof) --
    with one record per (workspace scope, application): the root key, its name
    and first version, the highest `publishers.json` revision seen, when, and by
    which act. `publishers::authorize_signer` takes a REQUIRED `AnchorGate` and
    asks `anchor_root` before it judges the signer. A root that contradicts the
    remembered one is refused, naming both fingerprints
    (`CalpError::DeveloperAnchorContradicted`, on the wire
    `CALP_ANCHOR_CONTRADICTED remembered=<fp> claimed=<fp>: ...`); the name is
    matched ignoring case, which can only refuse, never grant. A list revision
    below the mark is refused (`PublisherListRolledBack`,
    `CALP_PUBLISHER_LIST_ROLLED_BACK: ...`); a higher one raises the mark under
    either policy, because a monotonic raise is not a trust decision and nobody
    can forge a higher revision the root signed. Only an act of the user records
    first contact (`AnchorPolicy::RecordOnFirstContact`, no `Default`): opening
    for editing, a push, publishing a new application (recorded only when the
    root is this profile's key -- otherwise the push answers with a warning and
    records nothing) and the creator editing the co-publisher list. The merge,
    the hold-back and the signed base a push compares against only check
    (`CheckOnly`). A push checks before assembly and before its
    `DocumentEffect` (`calp_commands::anchor_push_target`), and every refusal,
    at any door, leaves an always-on `SignerRefused` row (reasons
    `anchorContradicted` / `publisherListRolledBack`). The creator's repair is
    never locked out: editing the co-publisher list proves the root WITHOUT
    reading the list, writes revision max(served, mark) + 1
    (`calp_publishers::next_list_revision`) and reports a served rollback as a
    notice instead of refusing. Reads fail CLOSED -- an unreadable store or an
    unknown `formatVersion` refuses every developer door -- and writes go
    through a process-wide lock and a temp-file rename. The remedy for a
    genuinely re-created application is **Forget the remembered creator...**
    (the Checkout dialog offers it for a contradiction only, never for a
    rollback; Code in This File lists every anchor with the same button),
    behind an awaited `confirmAsync` that fails closed, through
    `calp_forget_developer_anchor` (main window only, denylisted under
    `collaborationTrust`, one always-on `DeveloperAnchorForgotten` row per
    record). The limits: first contact is trust-on-first-use, so a machine whose
    first sight of an application is a planted root remembers that root; moving
    a workspace (a new scope) anchors afresh; the SUBSCRIBER side keeps no
    revision mark (`integrity::delegate_is_authorized`); push gate 5
    (`publish::resolve_authorized_keys`) still reads the root from the unsigned
    listing and falls back to the head's signer -- on a machine that remembers
    the root, the anchor check that runs before it has already refused a
    contradicting one. A checkout records first contact only once it is
    ADMITTED (BUG-0266, fixed 2026-09-30): core `prepare_checkout` reads and
    checks with the anchor asked `CheckOnly`, the host's role, reserved-id and
    collision gates run over what it read, and `PendingCheckout::admit` --
    before the `DocumentEffect`, re-asked under the store lock, recording the
    root the signer was JUDGED against -- is the one step that remembers. A
    checkout any gate refuses remembers nothing, so a planted root the signer
    check caught no longer poisons the memory meant to catch it.
13. **A push can ADD the author's own new macros, notebooks and names, and
    refuses a button whose macro it does not publish** (the two prerequisites
    of BUG-0257 phase 3, 2026-09-30). Invariant 7 withholds what the base
    version did not carry, so a macro written in a working copy stayed behind
    -- and a button linking it went out dead, with only a warning
    (`macro_reference_warnings`, now gone). Each own, includable item -- a
    module, a notebook or a workbook name; never another application's, never
    the Custom Functions record, never a reserved `__calcula_` id -- carries
    `includable`, the exact text that is hashed (`code`: a module's source, a
    notebook's cell sources as a JSON array, a name's `refers_to`) and its
    sha256 (`contentHash`), all computed in Rust; a name that points at a sheet
    the push does not publish says so (`detail`, found by the parser, not by
    text matching). The push dialog's **Include in application** tick is
    disabled until **Show code** has put that code on screen, and it remembers
    the hash it showed; the request carries `includeInApplication: [{kind, id,
    hash}]`, and the filter keeps an own item only on a kind + id + hash match
    (`calp_push_scope::IncludedItem`). A ticked item whose code changed since it
    was shown refuses the push before anything is written
    (`CALP_PUSH_INCLUDED_CHANGED`, always-on `ButtonCodeRefused` reason
    `includedChanged`). What a push added is named in its report and recorded
    by the link, so the next push keeps it without a tick. The scripted publish
    can never include (the collaboration gateway's census, and its TypeScript
    twin). Then every button on a sheet the push publishes -- a control's live
    `macroRef`, a button cell's script action -- must run a macro the push
    ships, AFTER the filter and the inclusions; otherwise the push is refused
    naming each button, its macro and a remedy that works: tick *Include in
    application* for your own macro, unlink the button from another
    application's, restore or unlink a missing one
    (`CALP_PUSH_BUTTON_MACRO_NOT_SHIPPED`,
    `held_button_code::refuse_push_on_unshipped_macros`, always-on
    `ButtonCodeRefused` reason `unshippedMacro`). The preview lists the same
    links with their remedies and never refuses, and the dialog offers the
    include tick in place; core publish no longer warns, because it is not the
    gate. The limit: pane controls and custom functions are not includable yet.
14. **A button linked to its application's macro runs it after the
    application's approval -- and runs nothing else** (BUG-0257 phase 3,
    2026-09-30). ADMISSION: subscribe and refresh now land the application's
    modules BEFORE its controls (one lock at a time, a census over both doors),
    and `held_button_code::admit_wiring` takes `DistributedWiring::LinkLanded`: a
    `macroRef` naming a module THIS pull applied -- the applied list, never the
    incoming one, because an id skipped on a collision names somebody else's
    macro -- moves into `heldMacroRef` with Rust's `heldFrom` stamp; any other
    link is removed and named (`buttonLinksRemoved` on the pull and refresh
    responses, shown by the Subscribe and Refresh dialogs). Inline `onSelect`
    was still removed here (since phase 4 static inline code is held as well,
    invariant 16); a checkout still holds every link (invariant 8);
    a dev pull, which brings no modules, still strips. THE CLICK: since phase 4
    every click asks the Rust button door first, which answers `link` for a
    control's macro link; then one rule for floating and in-cell buttons alike
    (`app/extensions/Controls/lib/applicationMacroLink.ts`
    `runButtonMacroLink`; the in-cell path used to ignore `macroRef`) -- and
    since owner decision B a person's click hands that route a one-time pass, so
    an approved macro written as an object script may change cells for that one
    run (`wave3-scripting-security.md` §11). The
    author's own live link runs as before; a held link runs only through
    `runMacroByRef(ref, {requirePackage: <the stamp's application>, trigger})`,
    which refuses -- before anything runs -- a module whose `sourcePackage` is
    not exactly that application (an empty one refuses too); a stamp that
    cannot be read refuses. THE GATE, in Rust
    (`app/src-tauri/src/scripting/application_code_gate.rs`), on the two doors
    every run of application code passes, `run_script` and
    `check_distributed_mount_consent`: the existing hash-keyed approval,
    unchanged (a changed macro asks again); then the private-sheet rule
    (invariant 15); then the button the click claims (`trigger`), verified
    against the control or cell-type store -- the button at that cell must link
    exactly this code under this application's stamp, or be the author's own
    live link (`APPLICATION_CODE_TRIGGER_MISMATCH`). The TRAIL: at `run_script`
    every run of an application's code is an always-on `ApplicationCodeRun` row
    and every refusal an `ApplicationCodeRefused` row (`notConsented` /
    `privateSheets` / `triggerMismatch`), naming the application, the macro
    and, when storage backs the click, the button; at the mount door the same
    holds when a button asked, and a standing mount with no button records only
    a private-sheet refusal (a row per chart or function mount on every load
    would drown the trail). A refusal the page makes -- a stamp it cannot read,
    a macro from elsewhere -- is recorded through `audit_button_refusal` with
    `kind: "control"`, which reads the application from storage, never from the
    page. THE APPROVAL SCREEN lists under each macro the buttons that run it
    (cell and caption, this application's buttons only:
    `app/extensions/ScriptableObjects/lib/consentMacroButtons.ts`). The limits:
    the trigger is a claim the renderer makes -- it can only narrow what runs,
    and a hostile renderer can OMIT it (the run is still gated and audited,
    without the button) -- since phase 4 inline code and button cells go
    through the Rust button door, which reads the button from its own store, but
    a LINK keeps this page route (the door answers `link`), so for links the
    claim stays a claim; stamps and
    `requirePackage` compare application NAMES, so two same-named applications
    from different workspaces are not told apart at the click; approvals still
    travel inside the `.cala`, but since phase 4 one counts only on the
    computer that sealed it (invariant 17); because a refresh now lands modules first, its "Subscriptions
    changed while the refresh was running" bail returns with modules applied;
    and a subscriber's "view changes" diff shows a held link as button code
    removed (the release has no target there).
15. **In a working copy, an application's code runs only when none of the
    developer's own sheets sit beside it** (BUG-0257 phase 3, 2026-09-30).
    Checkout is additive (§2.4), and code from an application can read every
    sheet: an approved macro -- a colleague's, or one a merge brought in -- could
    copy a private sheet into an application sheet, and the developer's next
    push would sign it and ship it. So in a workbook holding a working-copy
    link, code that came with an application is refused while any sheet outside
    the link's base sheets holds a cell (`APPLICATION_CODE_BESIDE_PRIVATE_SHEETS`,
    naming up to three of them, `application_code_gate::private_sheet_refusal`).
    It gates the module runtime (macros) and the `object-script` and `lib`
    (script library) mount surfaces (`PRIVATE_SHEET_RULE_SURFACES`), whose code
    can write the grid; every other
    consent surface is listed exempt with its reason, and a census makes a new
    surface choose. A blank sheet does not count -- every new workbook starts
    with one, and the remedy IS a new workbook. The Checkout dialog says so up
    front (`CheckoutResponse.privateSheets`) and offers **Open it in a new
    workbook**, which reopens the same version there (asking first when the open
    workbook has unsaved changes; fail closed). The limit, strict by design: a
    sheet the developer added and has not pushed yet counts as their own until
    it is pushed or removed.
16. **A button's own code travels held, and runs only after its exact bytes
    are approved, through a Rust door** (BUG-0257 phase 4, 2026-10-01).
    ADMISSION: subscribe and refresh no longer strip a button control's inline
    `onSelect`. `held_button_code::admit_wiring` (the `LinkLanded` arm) HOLDS
    static code in `heldOnSelect`, stamped by Rust with the application and
    version, exactly as a checkout holds it; a formula-typed `onSelect` is
    removed and named (Calcula does not run a formula as button code); a dev
    pull still strips both slots. The responses count it
    (`inlineButtonCodeHeld`, `inlineButtonCodeRemoved`) and the Subscribe and
    Refresh dialogs say so. THE APPROVAL: the item is `buttonAction:<sha256 of
    the exact bytes>` in the application's own record, beside its macros and
    object scripts; the approval screen shows every button action's code
    verbatim with every cell it sits in, and an application whose only code is
    button code still prompts; Code in This File shows each one's state
    (approved on this computer, waiting, approved only elsewhere, never runs and
    why). THE DOOR: every click -- a floating button, an in-cell button control,
    a button cell -- goes through `run_control_action`
    (`app/src-tauri/src/scripting/control_action.rs`). The page names the
    BUTTON (its kind, sheet and cell), never code. Rust reads the code from its
    own store, asks the approval of those exact bytes, the private-sheet rule
    (invariant 15) and Script Security, records every run and every refusal on
    the always-on trail (rows naming the application, the button and the door),
    and runs it in the interpreter. A held `Name()` call reaches only its own
    application's modules, never a local module of the same name; a macro
    written as an object script and called by name is refused by name (link it
    instead); a macro LINK keeps the phase-3 page route (the door answers
    `link`, invariant 14). The page composes nothing, and who may call the door
    at all is pinned by a census (only the three button gestures). THE
    BACKSTOP: held code run from anywhere but its button -- an ad-hoc
    `run_script`, a notebook cell of the user's own, a floor-only mount, an AI
    or MCP script -- is refused and recorded
    (`APPLICATION_CODE_OUTSIDE_ITS_BUTTON`): an exact match at any length; inside
    a longer program only held code of at least 40 characters over at least two
    lines; never code one of the user's own modules also carries. The reserved
    `buttonAction:` prefix is refused as a module, notebook or object-script id,
    and an approval record that holds only button code never opens the
    object-script mount floor. A working copy gets the same approval, behind the
    private-sheet rule. The limits: the backstop matches bytes (a short snippet
    inside a longer program is left to the door); approval keys are application
    NAMES, not workspaces (invariant 14); and a refused click says the approval
    screen comes back at the next open or update -- there is no "ask me again
    now".
17. **An approval counts only on the computer that made it** (M6,
    2026-09-30; owner: "yes, before phase 4"). An approval is a record in the
    workbook's user file `.calcula/script-consent.json`, and that file travels
    inside the `.cala` with the code it approves -- so a workbook handed over
    could carry its own pre-approval. Each record now carries `keyId` and
    `seal`, an HMAC-SHA256 over its canonical bytes (the application, each code
    id and hash, the grants, the time) under a 32-byte key that exists only on
    this computer: Windows Credential Manager, `Calcula:consent-seal`, per
    Windows user -- never in a workbook, never in a file the page can read
    (`app/src-tauri/src/consent_seal.rs`). Every Rust gate reads the VERIFIED
    view: records this computer sealed whose every field still matches. The
    rest are reported as ignored -- unsealed, another computer, altered, key
    unavailable -- and count for nothing, so a copy opened on another computer
    asks once there, and that computer's record is written BESIDE the first.
    Only `record_script_consent` (the approval screen, main window only) writes,
    computing every hash from the code itself (a page-supplied hash, time or
    seal is refused), and the virtual-file doors refuse to create or rename the
    consent file (deleting it, which only removes approvals, stays allowed).
    Every approval made before this asked again once. Code in This File lists
    the approvals the workbook carried from elsewhere, by application and
    reason, never by key. The limits: it protects against a HANDED-OVER file,
    not a compromised renderer, which can call the writer as the approval
    screen does; a record is bound to the computer, not the workbook, so
    someone holding a workbook this computer saved can copy its records into
    another `.cala` -- re-using the user's own earlier approval of those exact
    bytes under that application name, never forging a new one; and there is
    no "reset approvals on this computer" yet.
18. **"Make this my own" is the one way an application's button code becomes
    yours** (M6, 2026-10-01). In the Properties pane, for a button CONTROL whose
    code is held (a button CELL keeps "give it an action of your own"); since
    2026-10-02 (owner question 8) also on the button's right-click menu -- a
    floating button's own object menu, and Core's cell menu for an IN-CELL
    button control (known ahead of the right-click,
    `app/extensions/Controls/lib/heldEmbeddedButtons.ts`) -- which runs the
    pane's flow and its confirm step for step (`makeHeldButtonCodeOwnAt`,
    `app/extensions/Controls/lib/controlContextMenu.ts`). The
    confirm SHOWS the held code and says what follows: it becomes your code and
    a click runs it without the application's approval; a macro it links or
    calls stays the application's and still needs that approval; in a working
    copy the next push publishes it as yours (and asks for a review if it
    differs from the signed version); in a subscribed workbook the
    application's next update puts its own button back. On Yes,
    `adopt_held_button_code` MOVES the held slots into the live ones -- never a
    copy -- as one undo step, only while the code is exactly what the confirm
    showed (otherwise refused: "changed after it was shown"), only for a
    button, and, for a held link, only when it names a macro of the stamp's
    application, which keeps the confirm's sentence true. Every adoption is an
    always-on `ButtonCodeAdopted` row (the application, version, cell, caption
    and what moved, by hash). Ctrl+Z puts the held code and its stamp back, and
    the open pane follows (BUG-0272).
19. **A promotion shows first what CODE it changes for that environment's
    subscribers** (BUG-0257 phase 5, M8, 2026-10-01). The Promote window used
    to show the whole version diff, where a changed macro sat among cell edits,
    and nothing at all on a FIRST promotion. `calp_promotion_impact` now also
    carries a code summary (`core/calp/src/code_summary.rs`), which the dialog
    shows before the cell diff, on a first promotion too: every macro, object
    script (with any capability it gains, from the SIGNED manifest's ceiling),
    notebook (its cells' sources), custom function, button control's code,
    button cell's action, writeback validator and script under a reserved id
    that differs between the version the environment holds and the target --
    each with what it means for those subscribers: asks for approval again;
    runs after approval (a link, or code whose exact approval is already part
    of the version they hold, so a moved button asks nobody); stops running;
    removed on arrival (by the subscriber's admission); never runs; refuses
    the version (a reserved id, or a code file that cannot be read -- the
    dialog says which); blocks submits (a writeback validator). "Asks for
    approval again" means what the gates mean: an approval is keyed by the hash
    of the code, so new or changed code needs a new approval before it runs,
    and removing one custom function re-asks for the rest (one approval covers
    the set). The summary reads the way a subscriber's pull reads --
    manifest-driven, code only, the target through the AUTHORISED reader (its
    signer must be one the application's proved root authorises, so the
    preview never shows code the promotion would refuse) and the environment's
    current version through the VERIFIED one, each artifact checked against
    its signed checksum, no sheet read. A version that carries two entries
    under one id shows the one subscribers actually receive (the materializer's
    rule) and lists the other as `<id>#duplicate-<n>`, never run; a button's
    own code counts as hidden behind its macro link only when that link
    survives the subscriber's admission. A read that fails is said beside the
    writeback report ("Code: the comparison failed: ..."), never shown as "no
    code changes", and a promotion log that cannot be read is not mistaken for
    a first promotion. The confirm names the code in the promote and the
    rollback sentences alike. It is a prediction from the two versions: it
    cannot see a subscriber's own id collisions, local copies or an earlier
    Deny, and its sentences say so. The writeback report beside it reads both
    versions' signed manifests through the same verified reader (2026-10-02;
    it read the unsigned copies before), in the preview and in the promote's
    receipt alike, and a version it cannot read that way is said ("... is not
    known: v1.1.0 cannot be read (...)"), never read as one that declares no
    region. The PUSH preview shows the same summary first too (2026-10-02,
    owner question 14), because a push is where a developer decides what code
    goes out under their key: the push dialog asks `calp_diff_working_copy`
    for it (`codeSummary`), and `calp_diff::push_code_summary` compares the
    signed base -- the one the cell diff already opens through the VERIFIED
    reader, each code artifact held to its signed checksum again when the
    summary reads it -- with the push's own in-memory publish, the very side
    the cell diff compares, judged against the same button-command list. Its
    rows and sentences are the Promote dialog's (one component, one table),
    said about the development line, which receives a push the moment it
    lands; a failed comparison is said there as well. The limit: the
    Inspector's Compare does not show the summary yet. The version diff's own
    "gains / loses <capability>" note now fires: since BUG-0274 (fixed
    2026-10-02) it reads both versions' signed manifests through the same
    helper this summary uses (`PublishedObjectScript::capability_ceiling`).

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
| Developer anchor: the root this machine remembers, and a co-publisher list no older than it has seen | refuse | A planted first version or a rolled-back list deciding who may push (§3 invariant 12). Host side, before assembly and before any write. |
| Included items unchanged since shown; every published button's macro ships | refuse | Code going out under your key that you did not see, and buttons that cannot work (§3 invariant 13). Host side, after assembly, before core publish. |
| Validation (sheet indices, BI pivot fields, workspace writability) | refuse | Broken or unwritable applications. (Existed already.) |
| Diff review, exclusion report, dropdown warnings | confirm | Shipping surprises. (Macro-link warnings became the refusal above on 2026-09-30.) |

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

1. *Collaboration ▸ Open Application for Editing…* → pick workspace,
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
yet, says subscribers will receive v1.5.0 in full. Above anything else it lists
the CODE test's subscribers will receive -- on this first promotion all of it, as
new -- and that they will be asked to approve it (§3 invariant 19), and the
confirm names that code again. A confirms. Tester T
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
rollback-vulnerable — someone with write access can restore an older list along
with its still-valid signature. The list carries a monotonic `revision`, and
since 2026-09-30 every DEVELOPER door remembers the highest one this machine
has seen, beside the root it remembers (the developer anchor, §3 invariant 12),
and refuses a lower one -- which matters twice over, because since BUG-0262 the
same list also decides who may be checked out, merged and restored at push. So
on a machine that saw the removal, the rollback is DETECTED and refused. It is
not detected on a machine that never saw the newer list (it cannot know the
list existed), nor on the SUBSCRIBER side, whose TOFU delegate path keeps no
mark (`integrity::delegate_is_authorized`). The creator's own list edit writes
max(served, mark) + 1, so a served rollback cannot lock the creator out of the
repair. True revocation means rotating the root, which is out of scope here.

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
  run" (signed with your key is not written by you: a merge or a co-publisher's
  push puts other people's code in a version you signed, invariant 6), and
  defaulting to trust would make checkout a code-execution vector. What a
  checkout CAN do is keep the application's code apart from yours, and it now
  does so in four ways: the application's button code goes into a HELD
  compartment on the button, never into your own slots (invariant 8); a button
  cell's action is kept, held or removed by the same rule (invariant 9); an
  application macro, notebook or name whose id your workbook already uses is
  REFUSED rather than silently merged into yours -- check the application out
  into a new workbook instead, which the dialog offers (invariant 10); and the
  application's code does not run at all while your own sheets sit beside it
  (invariant 15).
- **Button code is held, not lost** (BUG-0257, §3 invariants 8 and 14): a
  working copy keeps its application's `onSelect` / `macroRef` in the held
  compartment, and an untouched push republishes it byte for byte. A held macro
  LINK runs after the application's approval, and since phase 4 so does held
  INLINE code, after the approval of its exact bytes (invariant 16) -- both
  unless your own sheets sit beside them (invariant 15). "Make this my own"
  makes a button's held code yours (invariant 18).
- **Control property values over 64 KiB are cleared** on every door into a
  workbook, a checkout included -- every door runs the same file checks -- and
  the Checkout dialog says how many it cleared. A push then publishes the
  control without them.
- **Slicer computed properties are no longer lost** (BUG-0263, invariant 11):
  checkout used to strip them, so every untouched push republished the
  application's slicers without them. They travel now, to a working copy and
  back byte for byte, and to subscribers.
- **A button cell's action is kept, held or removed** (BUG-0260, §3 invariant
  9): kept when it runs a macro the application brought in (or a command on
  Calcula's list, which is empty today), held (inert, and republished
  unchanged) at a checkout otherwise, removed with a notice on a subscribe or
  refresh.
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

**Built (2026-09-30, M4: the developer anchor and phase 3 of BUG-0257).**

Each piece was written test-first, and every guard was proved by a sabotage that
turned its test red; the live journeys are listed as pending below.

- **The developer anchor** (§3 invariant 12). `core/calp/src/developer_anchor.rs`,
  `authorize_signer`'s required gate, the push's `anchor_push_target`, the
  creator's list edit at max(served, mark) + 1, **Forget the remembered
  creator...** in the Checkout dialog and Code in This File. One new Tauri
  command (`calp_forget_developer_anchor`, denylisted), 813 in all.
- **Include in application, and dead macro links refused** (invariant 13).
  `calp_push_scope::IncludedItem` and Rust-computed hashes; `IncludeControl` in
  the push dialog (tick disabled until the code is shown);
  `UnshippedMacroLinks`; the refusals `CALP_PUSH_INCLUDED_CHANGED` and
  `CALP_PUSH_BUTTON_MACRO_NOT_SHIPPED`, both before core publish and before any
  `DocumentEffect`.
- **Macro-linked buttons run after approval** (invariant 14). Modules land before
  controls on the subscribe and refresh doors; `DistributedWiring::LinkLanded`;
  `runButtonMacroLink` as the one click rule; `runMacroByRef`'s
  `requirePackage`; the `trigger` wire (`run_script`'s `request.trigger`, the
  mount consent's `trigger`); `scripting/application_code_gate.rs` with the
  always-on `ApplicationCodeRun` / `ApplicationCodeRefused` rows; "Buttons that
  run this macro" on the approval screen; `audit_button_cell_refusal` renamed
  `audit_button_refusal` (control or cell).
- **The working-copy private-sheet rule** (invariant 15), with the Checkout
  dialog's notice and **Open it in a new workbook**.
- **Live proof pending.** `app/e2e/journeys/owner-followups.spec.ts`'s BUG-0257
  journey changed its expectation (the held macro-linked button now RUNS after
  approval) and has not been run since; the M4 journeys (a subscriber's button
  runs its application's macro after approval and the audit viewer shows the
  run; the confused deputy; the private-sheet refusal and its new-workbook
  remedy; including a macro written in a working copy; a planted root refused
  by the anchor, then Forget) are not written yet.

**M4 review fixes (2026-09-30).** Each proved by a sabotage that turned its test
red (core, app lib and vitest), restored byte-identical.

- **The anchor's identity is the folder's.** An application name is compared by
  `developer_anchor::application_identity` -- case folded over all of Unicode,
  Win32's trailing dots and spaces dropped -- so renaming the folder to
  `fÖrsäljning` or `sales.` no longer turns a contradiction into first contact
  (still refuse-only: a `Matches` needs the exact name). The store's
  read-modify-write holds an OS lock on `developer-anchors.lock` as well as the
  process mutex, so two Calcula processes cannot lose each other's records.
- **The push checks, and records only after it landed.** `anchor_push_target`
  asks `CheckOnly` and requires the PROVED root to authorise this computer's key
  (`NotAuthorizedPublisher`, a `SignerRefused` row with reason
  `pusherNotAuthorized`); `anchor_after_push` records first contact after core
  publish accepted the version, for an update as for a new application.
- **A rolled-back co-publisher list is never the base of the creator's next
  edit.** The listing checks the anchor (`CheckOnly`) and reports such a list
  apart (`rolledBack`), never as `coPublishers`; a change on top of it is
  refused unless the request names that served revision
  (`acknowledgedRolledBackRevision`), which the editor sends only after a
  confirmation naming whom the older list re-adds.
- **Promotion is a developer door.** `calp_promote` asks `promotion_gate` before
  it signs: the anchor (`CheckOnly`), the promoter's key and the target
  version's signer, all under the proved root, and hands core the version it
  judged; `you_may_promote` reads the same root.
- **Another application's workbook name is never includable** -- the name filter
  asks the subscription ledger first, as the pane-control filter does.
- **A script never receives the push report's code.** The collaboration gateway
  strips `code`, `contentHash` and `detail` from every `withheld` /
  `addedToApplication` item of a scripted preview or publish.
- **The mount door's trail is true.** An explicit run is asked `runCheck` before
  Script Security (every refusal recorded, no run row) and `runAdmitted` after
  it (the run row, with or without a button); a standing mount records only
  what it did before.
- **The private-sheet rule holds while code runs.** A realm the gate marks
  `recheckWhileRunning` asks `standing` before every broker call and every
  event (in arrival order, one round trip per batch); a refusal ends the realm
  (`application_code_refused`, `stoppedWhileRunning`), and only a new, fully
  gated mount brings it back. An approved notebook cell of an application meets
  the same rule and trail (`notebook_run_gate`).
- **A click's refusal names the button's own sheet** (`audit_button_refusal`
  takes `sheetIndex`), and a failure to record it is said, not logged.
- **"Include in application" ticks belong to one push**: reset on every show of
  the push dialog, and a tick the latest answer no longer offers is dropped.
- **BUG-0266 fixed** (same day): a checkout is prepared, gated, then
  admitted, and only admission records the developer anchor (invariant 12).
  Its test is no longer ignored and proves the genuine application opens on the
  refused machine once the plant is gone.

**Built (2026-09-30/10-01, M6 and M6b: phase 4 of BUG-0257, and owner decision B).**

Each piece was written test-first and every guard proved by a sabotage that
turned its test red, restored byte for byte.

- **Approvals sealed to this computer** (§3 invariant 17).
  `app/src-tauri/src/consent_seal.rs`; two new commands,
  `record_script_consent` (denylisted) and `list_script_consents`.
- **The Rust button door** (invariant 16). `scripting/control_action.rs`
  (`run_control_action`, denylisted): the one button rule, ported to Rust as
  pure planners over the store; every click of a floating button, an in-cell
  button control and a button cell goes through it, and the page-composed
  routes are deleted. The backstop and the reserved `buttonAction:` prefix in
  `application_code_gate.rs`.
- **Inline code held on subscribe and refresh** (invariant 16), with the
  counts on the wire and in the dialogs, the approval screen listing every
  button action's code and every cell it sits in, and Code in This File's
  approval states.
- **Make this my own** (invariant 18). `controls::adopt_held_button_code`
  (denylisted) and the Properties pane's confirm; on a button control's
  right-click menu too since 2026-10-02 (a floating button's object menu, an
  in-cell one's cell menu), through the same flow.
- **Owner decision B rides on the same doors.** A person's click, the Macros
  dialog and the command line's `run` give an APPROVED application macro cell
  access for that one run, co-decided by Rust, recorded per cell and undone
  whole if it stops part-way; a run a script starts never gets it
  (`wave3-scripting-security.md` §11). The run rows of the module runtime, the
  mount gate and the button door now say who started the run (`startedBy`) and
  from which `door`; a granted object-script run's row adds `cellAccess` and
  `grantId`, and its `script_executed` rows (one per sheet it changed) carry
  `completed`, `rolledBack` and `othersUndone`.
- Commands: 817 after the door, 821 after owner decision B's trail and
  savepoint doors.
- **Live:** `owner-followups.spec.ts` BUG-0257 passed in E2E run 10b and
  `calp-macro-buttons.spec.ts` M4-1..M4-7 in run 10 (2026-10-01), before M8
  changed the click, so both run again; plan_M6's own journey,
  `calp-inline-buttons.spec.ts`, was written short on 2026-10-02 (owner
  question 30) -- the confused deputy by name (M6-2), a handed-over file and
  another computer's approval (M6-3) and the backstop (M6-7) -- type-checked
  and not yet run live; what is still unit-proven only (M6-6, M6-8) is listed
  in `open-items.md` §2.af (M6 follow-ups (k)).

**Built (2026-10-01, M8: the rest of phase 5).**

- **The button-command allowlist** (§3 invariant 9). `button_cells.rs`
  `DISTRIBUTABLE_BUTTON_COMMANDS` (empty by owner decision) and the
  `button-commands:<application>` approval key; the door's command gate
  (`application_code_gate::button_command_gate`); one new command,
  `authorize_button_command` (denylisted), 822 in all; the page's live
  registration check (`distributableTrigger`, the registry's shadow check);
  the approval screen's command section and Code in This File's.
- **The promotion code summary** (invariant 19). `core/calp/src/code_summary.rs`
  and `DiffSide::PublishedChecked` (a read checked against the signed
  checksums), carried by `calp_promotion_impact` (no new command); the Promote
  dialog's code section and confirm. Since 2026-10-02 the push preview shows
  the same section first, base -> this push (`calp_diff::push_code_summary`,
  carried by `calp_diff_working_copy` when asked; no new command).
- An application name holding ':' is refused before any consent key is formed,
  so no approval kind can pose as another.
- **Live proof pending:** `calp-button-commands.spec.ts` and
  `promotion-code-summary.spec.ts` are written and type-checked, not run.

**Not built yet.**

- **Per-object artifacts.** Charts, controls, slicers and the rest still travel
  as one grouped file per domain rather than one file per object. The diff's
  path classifier already routes both layouts, so the split is additive — but
  until it lands, an application is less git-diffable and less AI-readable than
  §2.2 describes, and blob dedup is coarser than it could be.
- **Object-level merge.** See §4's `cannot apply`.
- **Delegate rollback prevention, subscriber side.** The revision high-water
  mark described in §7 is built for DEVELOPER doors (the developer anchor, §3
  invariant 12); a subscriber's refresh still accepts a rolled-back
  `publishers.json` (`integrity::delegate_is_authorized` keeps no mark), and so
  does push gate 5 (`publish::resolve_authorized_keys`, which also still reads
  the root from the unsigned listing).
- **What phases 4 and 5 left.** Macro LINKS still run through the page route
  with a renderer-claimed trigger; approvals are keyed by application NAME, not
  by workspace; no command is on the button-command list yet (owner decision);
  the code summary is shown by the Promote dialog and the push preview, not yet
  by the Inspector's Compare; there is no "ask me again now" after Block and no
  "reset approvals on this computer". The live list is in `open-items.md`
  §2.af.

## 11. Related documents

- `calp-distribution.md` — subscriber side, override/refresh semantics.
- `calp-writeback.md` — data collection back from subscribers.
- `docs/spec/calp-format.md` — the on-disk format.
- `script-package-manager.md` — library packages over the same machinery.
