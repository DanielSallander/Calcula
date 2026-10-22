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

> **Collected Responses for the author 2026-10-21 (BUG-0553).** The owner
> designated B3:B5, published, sent answers from another workbook, opened
> Collected Responses in the publishing workbook and read "No writeback regions
> in this workbook." Every publisher-side command found a region only through
> the workbook's SUBSCRIPTIONS, and an author's own regions are never
> subscriptions. They now resolve through ONE resolver,
> `calp_collection::collection_for_region` -- see **Collected Responses** below.

> **Your sent values in a new workbook 2026-10-21 (BUG-0554).** The owner asked:
> subscribe in a new workbook, send values, close without saving, subscribe
> again in another new workbook -- will I see what I sent, and how does the
> application know it is me? It did not show them: nothing ever copied sent
> values from the workspace into a workbook that did not already hold them, and
> the reconcile that ran after a subscribe returned early on an empty layer. It
> also copied only the STATE of the newest record onto an older local one, so a
> value sent later from another workbook showed the OLD value as approved. See
> **Showing what you sent** below; who "you" are is in **Who sends an answer
> (identity, phase 1)**.

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

### Who sends an answer (identity, phase 1)

> **2026-10-22, owner decision (open-items 2.am, option (c)), phase 1.** Until
> this change a submitter was a random UUID in
> `%LOCALAPPDATA%\Calcula\subscriber-identity.json`: anybody who could write the
> workspace could file answers -- and approvals -- under anybody's id. That file
> is no longer read (it is safe to delete; nothing deletes it). Defects closed with
> it: BUG-0556 (copyable identity), BUG-0557 (unsigned approvals), BUG-0558 (the
> fold's dedup by event id), BUG-0559 (a planted record shown as yours), BUG-0560
> (substring name matching), BUG-0561 (the signing doors were feature-open).

**Who.** The Windows account the app runs as, read from the operating system
(`app/src-tauri/src/submitter_identity.rs`, `WindowsAccountProvider`): its SID,
its `MACHINE\user` (a local account) or `DOMAIN\user` name -- the
`principalName` -- and its display name. The provider is a seam
(`calp::identity_provider::IdentityProvider`); Microsoft Entra ID is its phase-2 (the owner's numbering: Windows now, Entra later)
implementation and is a documented stub that is NOT selectable
(`EntraProvider`): authorization code + PKCE in the system browser with an
`http://127.0.0.1:{port}` loopback redirect and a checked `state`, the signing
key bound into the id_token through the OIDC nonce. It is not built because
there is no tenant to prove it against.

**The key.** On first use the app mints a 32-byte Ed25519 seed into the Windows
Credential Manager under `Calcula:submitter-key|v1` (DPAPI, per Windows user,
per computer) -- the same store and mint as the approvals key
(`consent_seal.rs`). It never crosses IPC: no command returns it, and
`submitter_identity::seal_outgoing` is the only code that uses it (pinned by a
census test).

**The id.** `win-<SID>-<commitment>`, where the commitment is the first 32 hex
characters of SHA-256 over the public key's lowercase hex
(`calp::identity_provider::submitter_id_for`). The id COMMITS to the key, so
every reader can check, offline and identically, that an answer under an id was
signed by that id's key. Consequences, stated plainly:

- The same Windows user on the same computer is the same sender in every
  workbook and across restarts: a new workbook that subscribes again sees what
  it sent (**Showing what you sent**).
- Another computer is another sender, even for a DOMAIN account (the key is per
  computer). Two computers of one person are two respondents until Entra ID (phase 2)
  can prove they are one person.
- A colleague who signs with their own key while claiming your SID gets a
  DIFFERENT id: they cannot shadow, replace or approve-hijack your answer.

**What is signed.** Every answer, at the one point it leaves the machine
(`submit_region_internal`, `submit_model_writeback`), over a FIXED-ORDER,
length-prefixed payload (`calp::submission_seal::event_payload`) -- not
re-serialised JSON, whose `extra` map has no stable order: the application and
version (a copy into another application or version folder no longer verifies:
no replay), the environment, the event id, region, row, column, cell id, model
key, the value (a number by its exact bits), the three timestamps, the WHOLE
sender identity (id, display name, principal name, provider, scope), the public
key and the ORIGIN -- `interactive` (the user pressed Submit / Submit All),
`immediate` (the region sends on save), `script` (the `distribution.writeback`
gateway). Fields outside the payload (`state`, the review fields, `extra`) are
never trusted: the fold derives the first two and nothing reads the third.

**Approve / reject are signed too** (owner decision). A `ReviewEvent` carries a
`seal` by the publisher's key or an authorised co-publisher's
(`calp::publishers::review_keys`: the verified publisher key plus the
root-signed co-publisher list -- the SAME set `require_publisher_key` lets
review, so a decision is written only where it will count) and a
`targetDigest`: SHA-256 of the exact answer decided, so an approval never
covers a different value later saved under the same submission id. The list's
root is the one THIS COMPUTER trusts -- the key a subscriber PINNED, or the root
an author's DEVELOPER ANCHOR remembers -- never the unsigned version list, which
a share-writer can extend with a planted `0.0.1` naming their own key
(`calp_commands::review_authority`; pinned by
`a_planted_first_version_cannot_buy_a_review_authority`). The reviewer's own
gate (`require_publisher_key`) is rooted THE SAME WAY (`trusted_review_root`),
so a planted first version buys no inbox either
(`a_planted_first_version_does_not_pass_the_publisher_gate`), and
`calp::publishers::root_key_of` verifies the first manifest's signature
before trusting its key. On an author's computer the anchor also carries the
highest co-publisher list revision it has seen: a ROLLED-BACK list (an older,
still validly root-signed one restored to re-authorise a removed co-publisher)
is refused and only the verified key counts
(`a_rolled_back_co_publisher_list_buys_no_review_authority`); a subscriber
keeps no such mark yet (open-items 2.am). A decision a SCRIPT made carries
origin `script` inside its signature (`ReviewSeal.origin`,
`seal_review_with_origin`), and every reader shows its reviewer as "<name> (by
a script)". An unsigned decision, one signed by any other key, and one edited
after signing are IGNORED by every reader. The fold computes the list
(`FoldOutcome::ignored_reviews`); nothing SHOWS it yet -- every publisher read
of a region LOGS how many forged answers and ignored decisions it dropped
(`load_region_collected_rows`), and showing them is open (open-items 2.am).
Before this, anyone who could write `reviews/` could approve their own answers
into an `on_approval` total or a masterData column.

**What every reader does with it** -- the fold (`calp::fold::fold_detailed`),
deterministic across machines because it looks at signatures and the verified
publisher key ONLY, never at anything that depends on the reader (a network
lookup, who owns a file on this share, a pin this computer remembers):

- an answer is SIGNED, SENT BEFORE SIGN-IN (an old-format id with no seal), or
  FORGED (unsigned under a signed id, signed by a key the id does not name,
  edited after signing, or copied from another application / version /
  environment). Forged answers -- grid AND model-keyed -- are removed before
  anything competes (counted in `FoldOutcome::forged`; logged per publisher
  read, not shown yet). In a version whose SIGNED manifest says its answers are
  signed (`VersionManifest.signedAnswers`, written by every publish with
  writeback regions or columns and a minimum app version -- which the app always
  stamps for them) an UNSIGNED answer is forged whatever its id looks like
  (`LocalWorkspace::answers_must_be_signed`: decided from the verified
  manifest, failing closed when it does not verify or names a key the reader's
  authority does not admit), so "sent before sign-in" exists only in versions
  published before answers were signed (BUG-0569);
- the sender FOLDER is not authority: Windows storage treats `WIN-<id>` and
  `win-<id>` as one folder, so a file is read when its id names its folder up
  to ASCII case, and an id whose prefix is any case variant of `win-` /
  `entra-` is held to the seal it can never carry (forged) -- a folder a
  share-writer made in advance in another case can no longer swallow a sender's
  answers (BUG-0564);
- duplicates are collapsed per (SENDER, event id) -- never by event id alone, so
  a file planted in another folder that reuses a real answer's id cannot
  displace it -- and a signed event outranks an unsigned one;
- in a grid slot, if any event is signed only signed events compete;
- the `sender` verdict travels on the record (`WritebackSubmission.sender`,
  never read from disk or IPC; a `sender` key a file smuggles into `extra` is
  stripped) and on every Collected Responses row (`sender`,
  `submitterPrincipal`, `origin`).

**What it proves, and what it does not.** A signature proves that THIS USER'S
CALCULA sent the answer, from the origin it names. It does not prove a person
typed it (a script the user approved can send; the row then says "sent by a
script"). In phase 1 it does NOT prove the NAME: the principal and display name
are the sender's own claim -- bound to their key, so nobody else can change
them, but not checked against a directory. Therefore:

- **One matcher** (`calp::identity_provider::principal_matches`) for expected
  respondents (the roster) and masterData allowed editors: exact and
  case-insensitive on the SIGNED principal, EXACT on the id (a case variant is
  another sender) -- never the display name, never a substring (the old
  fallback let "Al" answer for "Alice" and "Alan"). An answer sent before
  sign-in matches by id only. Both callers go through
  `calp::identity_check::matching_identity` first, so a name the READER has
  disproved never matches (**Who sent it, as THIS reader sees it**).
- **"Mine"** is one predicate (`calp::submission_seal::is_mine`): my id AND
  signed by my key. It decides which records seed my cells as "what you last
  sent" (`own_records_by_region_in`, and again in
  `adopt_own_sent_values_inner`), `own_only` visibility and the
  `own_plus_aggregate` anonymization -- so a record planted under my id is never
  shown as mine (the 2.am row).
- **Master data counts only signed entries.**

**Answers sent before sign-in** (the owner's existing answers under
`01a087b6-...`; owner decision: start fresh): visible everywhere, labelled
"Sent before sign-in (not signed)", never matched by name, never "mine", never
master data -- they still count in an ordinary total, as they did, in the
versions published before answers were signed (in a later version an unsigned
answer is forged, above). A DRAFT typed before sign-in (it carries the old id)
is refused at Submit with "Use Writeback > Discard Drafts and type them again" --
never re-stamped to the current identity, which would let a crafted workbook
seed answers signed as whoever presses Submit All (`foreign_draft_refusal`). A
draft typed on ANOTHER computer is refused in words ("typed as CORP\alice on
another computer, and only that computer can send them. Use Writeback > Discard
Drafts ..."), never with two raw ids. And what is signed is what the OS
reports: `seal_outgoing` replaces a draft's whole sender identity (principal,
display name, scope) with `current_identity()` before signing, so a crafted
workbook carrying this user's id with "CORP\ceo" as the principal signs nothing
but this user's own account (BUG-0576).

**The signing doors are human-UI or broker only.** `calp_submit_region`,
`calp_submit_all_regions`, `calp_save_writeback_draft` (an `immediate` region
sends on save), `bi_writeback_set_value` (a subscribed model column's entry is a
submission), `calp_set_submission_state`, `calp_set_model_submission_state` and
`calp_get_subscriber_identity` (it names the SID and principal) are in
`PRIVILEGED_BACKEND_COMMANDS` (`collaborationTrust`), and so are the three
doors whose drafts or preview carry the same identity --
`calp_get_writeback_layer`, `calp_reconcile_writeback` and
`calp_preview_region_submission` (BUG-0580): a non-trusted extension reaches
none of them. Scripts send only through the consent-gated broker
(`script_writeback`, the `distribution.writeback` capability), signed with
origin `script` -- including a script's `setCellValue` into a claimed cell (the
gateway's cellGuard action), which an `immediate` region sends signed as
`script`, never as typed by the user (BUG-0568).

**Older apps.** An application with writeback regions (or model writeback
columns) names this app as its `minAppVersion` (`stamp_min_app_version`): an
older app would send unsigned answers and unsigned decisions that every current
reader ignores while showing "sent" / "approved" -- a lie, not a loss. The gate
compares semver, and the app is still `0.1.0`: it bites from the first release
that bumps the version.

**Limits, stated plainly** (the threat model):

- Key theft: DPAPI protects the key from other Windows users, not from malware
  running as the user.
- Signatures prove who wrote an answer, not that the history is complete: a
  writer with delete rights can remove someone's newer answers and roll a slot
  back.
- Privacy: SIDs and principals are readable by everyone with workspace read
  access, and `own_only` is not confidential against a colleague who opens the
  raw files. Per-submitter-folder ACLs on a file share (creator-owner full
  control, everyone else read) are the recommended hardening.
- Publisher authority is only as strong as `publisher-key.json`, a plaintext
  file in the profile (moving it into the Credential Manager is open).
- A Windows-account application in a Dropbox / OneDrive folder: every answer is
  still signed, but no answer there can be VERIFIED (below) -- the owner's
  decision is to warn at publish and label the answers, never to refuse.

**Who sent it, as THIS reader sees it (verification, read side, 2026-10-22; BUG-0562).**
After the fold, every reader that shows or counts answers attaches its own
verdict to each one (`WritebackSubmission.identity`, never read from disk or
IPC, stripped from `extra` like `sender`; `calp::identity_check`, the Windows
facts in `app/src-tauri/src/identity_verification.rs`). It is NOT part of the
fold, on purpose: it depends on the reader -- which storage it sees, whose owner
lookups succeed -- and the fold must converge everywhere. The four answers, in
the words the Identity column uses:

- **Verified** -- signed, AND Windows recorded the account the id names as the
  OWNER of the answer's file and of its sender folder, AND no other account can
  change that file. The owner records who CREATED a file, not who last wrote it:
  NTFS and SMB keep it when a file is moved within a volume or overwritten by
  another account, so on a share where users hold the common inherited Modify
  right Mallory could move a file Alice created into his own folder and
  overwrite it with his answer (BUG-0565). So the reader also reads the file's
  DACL (`identity_verification::file_facts`, `others_can_change_from`): any
  allow entry for an account other than the owner, SYSTEM, Administrators and
  the owner placeholders with a right to write, append, delete, change the
  permissions or take ownership -- or a NULL DACL, or an entry it cannot parse --
  makes the answer "Signed, identity not confirmed (other accounts can change
  this answer's file ...)". Deny entries are ignored (they could only make it
  safer), and the folder's own DACL is not read (a writer who may DELETE in the
  folder can remove an answer but not forge a Verified one). What a Verified
  answer proves, then: a process running as that account (or an administrator)
  created the file and nobody else can change it. Per-sender folders
  (creator-owner full control, everyone else read) are what makes verification
  POSSIBLE on a share; with the default inherited Modify right nothing is
  Verified. Several files can hold one answer (a sync client's renamed copy,
  matched by its signature, `LocalWorkspace::submission_files`); a file owned by
  the claimed account wins.
- **Signed, identity not confirmed (cannot be checked here: ...)** -- signed by
  the key its id names, but the owner record says nothing here. A Dropbox /
  OneDrive folder (Dropbox's own `info.json` roots, `%OneDrive%` /
  `%OneDriveCommercial%` / `%OneDriveConsumer%`, or any Windows cloud-files sync
  root): the sync program writes every file as whoever runs it on the READING
  computer. A computer's own (local) account on a network share: the client
  authenticates as a SERVER-side account, so the owner is never the client's SID
  (critique-identity item 8). A local account of ANOTHER computer read on this
  computer's disk (it can only have arrived by copy). FAT/exFAT (no owners). An
  owner of `BUILTIN\Administrators` (`S-1-5-32-544`): anyone elevated writes as
  it -- "written by an administrator account", never a mismatch. An owner lookup
  Windows refuses. A file owned by the claimed account that OTHER accounts may
  change, or in a sender folder another account owns ("other accounts can change
  this answer's file"). Windows is not even ASKED in the first four cases.
- **Not verified: written by CORP\bob** -- signed, the check meant something
  (a domain or Entra-joined account on an NTFS share or disk, or a local account
  of this computer on its own disk), and Windows recorded a DIFFERENT account as
  the writer. This is the forged-name case the signature alone cannot catch: Bob
  mints a key of his own and claims Alice's SID (he gets a different id, so he
  cannot shadow her answer, but he can answer AS her).
- **Sent before sign-in (not signed)** -- the old random ids.

The claimed scope and principal are the sender's own signed claim; claiming a
scope only decides whether the owner is LOOKED AT, never makes an answer
Verified without the owner record agreeing. **What the reader proved always
wins over the claim** (`calp::identity_check::matching_identity`,
`answer_matches`, `shown_name`; BUG-0567): a Verified sender is matched -- in
the roster and by a masterData allowlist -- by the name Windows resolves for the
account that CREATED the file (`LookupAccountSidW`), and by NO name when they
claimed a different account; a Not-verified answer (Windows names another
writer) matches by no name at all, whatever the rule, and never edits master
data; and both are LISTED as "<display name> (written by CORP\bob)". The
Collected Responses sender line words an unverified name as the sender's claim
("Signed; the sender says they are CORP\alice", neutral) and only a Verified
one as "Signed by CORP\alice" -- a green "Signed as CORP\alice" above a red
"written by CORP\bob" was how BUG-0562 read.
Lookups are cached per (file, size, modified time) and the storage class per
workspace for the session; a reader on a sync folder pays nothing.
**At any depth** (BUG-0584, found live 2026-10-22): the owner lookup hands
Windows the VERBATIM path (`identity_verification::api_path`: `\\?\C:\...`,
`\\?\UNC\server\share\...`). Calcula is not long-path aware, and an answer's
file sits about 170 characters below its workspace
(`{app}\{version}\submissions\win-<SID>-<32 hex>\<region>_<row>_<col>_<id>.json`),
so with the plain spelling every answer in a workspace deeper than about 90
characters read "cannot be checked here: Windows did not say who wrote the file"
(ERROR_INVALID_NAME) -- the owner's own answers in a `%TEMP%` copy of the
workspace included, and under "count only verified senders" nothing would have
counted. An unreadable owner is now logged with Windows' reason ("identity
check: the writer of answer ... could not be read").

**The application's identity rule** -- "Writeback: count only answers from
verified senders", a checkbox in the Publish / Push dialog
(`PublishParams.requireVerifiedIdentity`), written into the SIGNED version
manifest (`VersionManifest.identityPolicy.requireVerified`) so a share-writer
cannot switch it off. Default OFF for Windows-account applications (owner
decision): every answer then counts, each labelled. The dialog starts from the
rule the VERIFIED base version carries (`PublishPreviewResponse.baseRequiresVerified`)
and sends a choice ONLY when the author moved the box (`identityRuleToSend`); a
push that sends none keeps the base's rule, read from the verified base, and is
REFUSED (`CALP_PUSH_IDENTITY_RULE_UNKNOWN`) when that cannot be read -- never a
silent switch. (Until BUG-0566 the dialog always sent the box, unticked until
the preview reported the base -- and the preview swallowed a failed read -- so
a push could switch a base's rule off in silence; the preview now SAYS when it
cannot read the base's rule.) The push preview's diff carries
the base's rule (`carry_base_identity_rule`), so it never reports a change the
dialog has not made; a real change between two versions is the manifest line
`identityPolicy: count every answer -> count only verified senders`. An
application that sets it names this app as its `minAppVersion` (an older app
would ignore it and count everything -- a lie).

**Where it is enforced -- in Rust, never the renderer** (`calp::identity_check::admit`
after `identity_verification::attest`; a verdict nobody attached is "not
checked", which the rule does not count -- fail closed):

- GATHER totals (`rebuild_gather_cache` -> `apply_gather_governance`, which now
  takes the rule and applies it first);
- the BI tables -- the subscriber's (through the same governance) and the
  author's (`load_region_current_submissions`), and a subscribed model writeback
  column's values (`bi/writeback.rs`);
- the respondent roster (`region_response_status_core`: only counted answers
  respond; `notCounted` names the senders left out, `requireVerified` says the
  rule is on);
- scripts (`script_writeback` `listSubmissions`: counted rows only, each with its
  `identity`; a model column's list through `model_writeback_identity_policy`,
  which fails closed to "verified only" when the manifest cannot be read).

The publisher's inbox (`load_region_collected_rows`) and the CSV / Parquet
exports SHOW every row with its verdict, `identityLabel` and `counted`
(CSV columns `identity,writtenBy,counted`; Parquet columns `identity`,
`written_by`, `counted` -- the writer Windows recorded beside the sender's
claimed name, so a file that leaves the app never presents a claim as proof).
The header totals of Collected Responses count only counted rows under the
rule (`senderLabel.headerRows`, BUG-0574). The
census `every_counting_reader_attests_the_answers_it_reads`
(`identity_surface_tests.rs`) names every app reader of folded answers that
neither attests nor is listed with a reason. Seeding "what you last sent" stays
on `is_mine` (my id AND my key's signature) whatever the rule -- it never
depends on verification, so a user's own answers are never hidden on storage
that cannot verify them (`own_only` and the anonymization use the same
predicate).

**Who you are, on screen.** The subscriber's Writeback tab Status says "You are
signed in as Salle (Windows account)" with the account on the second row
("Danne\Salle, this computer's own account"), and the Writeback pane says the
same (`lib/whoAmIStore.ts`, one read of `calp_get_subscriber_identity`). Each
Collected Responses row has an Identity line ("Identity: Not verified: written
by CORP\bob -- not counted"), the summary counts what is not counted, and the
roster chip names the senders left out. The Application Inspector's writeback
section counts the verdicts per region and in total, and says when the
workspace is a sync folder. Publishing writeback regions into a sync folder (or
a FAT drive, or a workspace whose storage Calcula cannot identify -- an HTTP
workspace, an unreadable volume) WARNS in the preview and in the publish result
(`writeback_storage_warning`); it is never refused. The warnings and the
checkbox say what a share needs for verification: DOMAIN accounts and
per-sender folders only that sender can change (BUG-0575). The wiring of the
warning into both results is pinned structurally
(`the_storage_warning_is_wired_into_publish_and_its_preview`: both commands
need a Tauri window).

**Phase 2 -- Microsoft Entra ID sign-in** (owner, 2026-10-22: LATER, not built;
there is no tenant to prove it against). The provider seam is
`calp::identity_provider::IdentityProvider` with the non-selectable
`EntraProvider` stub; `submitter_identity::active_provider` is the one place
that will choose it from an application's signed policy. Recommended when it is
built: an ORGANISATION-REGISTERED app (each organisation's IT registers it and
puts the client id and tenant in `%PROGRAMDATA%\Calcula\policy.json` or the
Publish dialog -- no Microsoft publisher verification needed); authorization
code + PKCE in the system browser with an `http://127.0.0.1:{port}` loopback
redirect and a checked `state`, single use, closed on success, error or a
5-minute timeout; the signing key bound into the id_token through the OIDC
nonce; the id `entra-<tid>-<oid>-<key>`; the publisher verifies the token
against Microsoft's JWKS and caches an attestation. An Entra answer is then
Verified on ANY storage, Dropbox and OneDrive included.

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

- every answer is checked first: signed by the key its sender id names, sent
  before sign-in, or FORGED -- and a forged one never competes (**Who sends an
  answer**);
- grid slots collapse to the newest `(updated_at, id)` event per
  `(environment, submitter, region, row, col)`, a signed event outranking an
  unsigned one — older events remain on disk as history;
- model-keyed events are never collapsed (multi-user collection keeps every
  submission; masterData resolves newest-approved-wins downstream);
- review state comes ONLY from `ReviewEvent`s SIGNED by the publisher or an
  authorised co-publisher, naming the submission's id, sender and digest —
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

- **One frame per region** (the owner's design, refined twice on 2026-10-21:
  a dashed outline read as the copy marquee; then a tiny "w" on every outer
  cell edge became ONE edit icon -- a pen over an open square -- per edge). A
  soft SOLID 1px line round each region on the ACTIVE sheet, broken once per
  edge by a 12px edit icon at the middle of the edge's VISIBLE length (so a
  tall region scrolled half off still shows one). The line is the grid's cell
  text colour at 45% alpha and the icon at 70%, so it follows every skin with
  no literal. No fill: the cells keep their gridlines and the publisher's
  formatting. An edge too short for the icon (a single 20px row's sides) keeps
  a plain line. One rectangle per region per frame, whatever its size. It is a
  grid LAYER under the selection (`collaboration:writeback-outline`,
  `lib/writebackOutline.ts`, `drawEditIcon`), frozen-pane correct through
  `@api/gridLayers` `rangeToCanvasRect`, and it is not painted on a canvas
  page.
- **The author sees it too.** The frame also covers the regions this workbook
  itself designated (`calp_get_writeback_draft_regions`, read by the same
  store), in a fresh workbook and in a working copy. Those get no marker (they
  hold no values) and the PUBLISHER's version of the Writeback tab (below).
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

**Two roles, one tab** (2026-10-21). The same tab -- id, label, accent and
place -- carries the SUBSCRIBER's commands in a subscribed region (everything
below) and the PUBLISHER's in a region this workbook designated itself, in a
fresh workbook or a working copy (`WritebackPublisherPanelDefinition`,
`components/WritebackPublisherTabSections.tsx`):

- **Region:** Edit Region (the Designate dialog in edit mode) and Remove Region
  (`confirmAsync` first; the cells stay, collection stops from the next
  publish/push, responses already collected stay in the workspace).
- **Status:** what the region takes and when values arrive ("B3:B5: numbers,
  sent when the subscriber submits"), and who sees them, in the publisher's
  words.
- **Responses:** *Collect From* (2026-10-22: which streams -- the development
  line, each environment -- the workbook's own regions collect from; a
  stay-open menu of check rows; see **Which streams the publisher collects**
  below), Collected Responses (the publisher dashboard; see **Collected
  Responses** below) and Writeback Pane -- one row of three heroes.
- No badge: a publisher has nothing to send. A subscribed region wins if both
  could apply, which cannot happen (a working copy cannot subscribe to its own
  application). Moving the cursor between the two kinds swaps the section list.

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

### Collected Responses (the publisher dashboard)

The publisher's inbox, roster, approve/reject, CSV/Parquet export and Parquet
rollup switch for one region at a time
(`app/extensions/Collaboration/components/PublisherDashboardPane.tsx`). Opened
from Writeback > Collected Responses or the Writeback tab's Responses section.

**Which regions it lists** -- `calp_list_collection_regions`
(`app/src-tauri/src/calp_collection.rs`), never the subscriber index
(`calp_get_writeback_regions`, which holds only SUBSCRIBED regions -- the
defect behind BUG-0553):

1. This workbook's OWN designated regions (`writeback_draft_regions`), first,
   labelled "Sheet!B3:B5" -- the author's role.
2. Then the regions the working copy NO LONGER designates (Writeback > Remove
   Region, or a push without them) that a published version of the linked
   application still declares: a `prod` still pointing at an older version
   keeps collecting answers for them, so they stay listed and reviewable --
   `designated: false`, with a `note` saying so -- resolved from the
   declaration instead of the draft. Only one that resolves is listed.
3. Then the regions of applications it subscribes to -- a publisher reviewing
   from a subscriber workbook, as before.

**How an author's region reaches its answers.** A workbook that published (the
first publish of a standalone workbook) or was opened for editing (checkout)
carries a `WorkingCopyLink` naming the workspace and the application, and the
region id survives both routes (a publish ships the draft ids; checkout restores
the manifest's regions as drafts with the same ids). The region is read from the
NEWEST version of that application whose signed manifest declares the id -- the
head, not the link's base, because a co-publisher's later push moves subscribers
onto a newer version and carry-forward only looks down. The candidate is chosen
from each version's UNSIGNED manifest (trusted for nothing) and only the
candidate is verified, through the DEVELOPER door's authorised reader
(`calp_inspector::open_authorized_content`: signed by an authorised publisher,
anchored at the application's root, checked against this computer's developer
anchor under `CheckOnly`), NOT the subscriber's TOFU pin -- an author who never
subscribed to their own application has no pin, and only Subscribe/Install may
write one. A candidate that fails verification is never skipped in silence: the
next older one that verifies is read and the row's `note` names the newer
version whose answers are not shown; when none verifies the row is
`unreachable` with every reason. Then the same publisher gate every dashboard
command has always run, against the `publisher_key` of THAT VERIFIED manifest
(`require_publisher_key`: this computer holds the key, or a co-publisher's) --
never a key re-read unverified from the share (the subscriber route likewise
carries its pinned manifest's key).

**One resolver for every command, and for the listing.** `resolve_collection`
(the role, the version, the verified key, a TYPED refusal) and
`publisher_collection` (plus the gate) serve the inbox
(`calp_load_region_submissions`), review (`calp_set_submission_state`), both
exports, the rollup get/set, the roster (`calp_region_response_status`), the
script gateway's publisher gate (`require_region_publisher`) and the submission
watch (`doSubmissionPass` in `app/src/api/collaboration.ts`, which polls only
`ready` rows of the same list -- so "submission received" now fires for an
author's region too). Their version walk is ONE helper,
`calp_collection::collected_versions` (`stream_versions`, then the
carry-forward compatibility rule; three hand-copied walks before). The
SUBSCRIBER-only paths -- submit, the one-shot lifecycle check, the layer, the
preview -- keep `owning_subscription_for_region`: a submission is always a
subscriber's act.

**Streams.** Which streams every read collects is ONE choice per workbook, not
the pane's (2026-10-22): a subscribed region reads the stream its
subscription follows (unchanged); an author's region reads the streams chosen
in **Writeback > Collect From** (next subsection; default: the pipeline's LAST
environment, every stream when the application has none). The inbox, the
roster and both exports take NO stream argument; one row per
(stream, person, cell) -- the same person answering in `test` and `prod` is
two rows, each labelled whenever more than one stream can appear. The pane's
former stream picker is gone; it shows the same Collect From control as the
tab (author rows) or the fixed "in <stream> (this workbook's stream)" chip
(subscribed rows). Approve/Reject send the ROW's own stream, which must be a
collected one.

**A review decides on the record its id names.** One version can hold a
`test` and a `prod` record for the same person and cell (the fold keeps one
slot per environment, submitter and cell). With the submission id (the pane
always sends it), the id names the record: the collection's OWN version set is
searched -- the very set the list was built from -- and newest-wins is checked
within the record's own stream ("superseded" if a newer one arrived there; a
named stream that is not the record's, or one this workbook does not collect,
is refused). Without an id (a script names no stream) a cell answered in more
than one COLLECTED stream is REFUSED, naming the streams, instead of deciding
on whichever came first. The
audit row names the stream of the record actually decided, and the cell in A1.
A version whose submissions cannot be read is never "no submission": the
review says it could not read, and the inbox fails with the reason when no
version could be read (a partial failure is logged and the rest shown).
Values are shown in the APP locale ("1,5" under sv-SE); the CSV export stays
invariant for the programs that read it.

**A region that cannot be read yet says why** (the row's `status` and
`detail`), instead of an empty inbox under an error:

| `status` | When | What the pane says |
|---|---|---|
| `ready` | resolved, and this computer is a publisher | the inbox |
| `notPublished` | a designated region in a workbook with no link (never published, never opened for editing) | publish first (Collaboration > Publish Application), or open the published application for editing |
| `notInPushedVersion` | the linked application declares the region in no version | "B3:B5 was designated after the last push of '<app>' (v<head>). Push the application ..." |
| `notPublisher` | this computer holds no key that may read its answers | the publisher gate's own refusal |
| `unreachable` | the workspace or every candidate version could not be read or was refused | the error, per version |

The listing and every command decide through the same functions
(`AuthorWalk::resolve`, then `authorize`) and the same typed refusal
(`CollectionRefusal`), so the pane cannot call a region ready that the commands
then refuse, or give a different sentence for it; nothing classifies by
matching message text. A ready row may carry a `note` (a region no longer
designated here; newer versions whose answers could not be verified).

An empty workbook reads "This workbook has no writeback regions. Designate one
(Writeback > Designate Writeback Region) and publish to start collecting." A
region list that could not be READ says "Could not read this workbook's
writeback regions: ..." instead -- never the empty-workbook sentence, which told
a workbook with regions it had none. Writeback > Collected Responses opens the
pane on the region the cursor is in.

The submission watch reports an `unreachable` row as its `lastError` (and
lists it again next pass) rather than silently not watching it.

**Who am I, across workbooks.** A submission is filed under this COMPUTER's
sender id -- the Windows account bound to this computer's signing key
(`win-<SID>-<key commitment>`), not the workbook's -- so a new workbook that
subscribes to the same application on the same computer is the same sender, and
its cells show what that sender last SIGNED (**Showing what you sent**). Across
computers it is another sender (phase 1; see **Who sends an answer**). Every row
says who sent it: "Signed by CORP\alice" when the reader verified it, otherwise
"Signed; the sender says they are CORP\alice" (with ", sent by a script" or ",
sent on save" when that is how it left), or "Sent before sign-in (not signed)".
Below it, the **Identity** line: this computer's verdict ("Verified: written by
CORP\alice (Windows account)", "Signed, identity not confirmed
(cannot be checked here: ...)", "Not verified: written by CORP\bob", "Sent before
sign-in") and "-- not counted" when the application counts only verified senders
(**Who sent it, as THIS reader sees it**). The summary counts the answers not
counted, a strip says the rule is on, and the roster names the senders it left
out. Pinned by `app/src-tauri/src/identity_surface_tests.rs` and
`publisherDashboard.test.tsx`, and live by steps 10-11 of
`app/e2e/journeys/writeback-subscriber.spec.ts` (9/9, 2026-10-22, on a temp copy
of the workspace): every answer sent is in this machine's `win-<SID>-...`
folder, names the account `whoami` reports and verifies with node's own Ed25519
over a copy of `event_payload`; the Writeback tab's Status reads "You are signed
in as Salle (Windows account)" over "Danne\Salle, this computer's own account";
Collected Responses reads each "Identity: Verified: written by Danne\Salle
(Windows account)". In a further COPY: an answer validly signed by another key
and claiming a neighbour account reads "Not verified: written by Danne\Salle";
one of the subscriber's own answers with its name and value edited in place is
forged -- listed nowhere, and a new subscription takes back only B3 = 1 and B4 = 2
(never the edited 777); an UNSIGNED "rejected" decision dropped into `reviews/`
changes nothing on either side, while the publisher's real approval (the same
file shape plus a seal) reaches the subscriber. Each assertion was failed once
by a live sabotage (the who-line without the account; `api_path` plain;
an owner mismatch read as unconfirmed; the fold keeping forged answers -- the
new workbook then seeds B5 = 777; `check_review` accepting an unsigned
decision -- B3 then arrives "rejected").

Pinned by `app/src-tauri/src/calp_collection_tests.rs`,
`app/extensions/Collaboration/lib/__tests__/publisherDashboard.test.tsx` and
`app/src/api/__tests__/submissionWatch.test.ts` ("whose regions the watch
reads"), and live by step 8 (Collected Responses in the working copy) of
`app/e2e/journeys/writeback-subscriber.spec.ts` (run live 2026-10-22: 8/8, then
9/9 with the identity steps).

#### Which streams the publisher collects (Writeback > Collect From)

Owner decision 2026-10-22. One choice per APPLICATION, held in the workbook's
working-copy link (`WorkingCopyLink.collect_streams`, saved in
`working_copy_link.json`), read by everything that reads the workbook's own
regions: Collected Responses, both exports, the roster, review, the submission
watch, scripts and the author's BI writeback tables.

- **The default (no choice):** the LAST environment of the pipeline -- `prod`,
  as a rule. With no environments: every stream (which is then just the
  development line, as before). Test answers never reach a production read or
  model table merely because nobody chose. The default is the last environment
  whose pointer is AUTHORISED (`calp_collection::default_environment`, the one
  helper the reads, the summary and the menu share); when the pipeline's latest
  change was signed by a key the application does not authorise (every entry is
  then marked) there is NO default -- a share-writer's self-signed Pipeline
  record must not retarget the inbox, exactly as a subscriber refuses it
  (BUG-0570). If the pipeline cannot be read, or has no authorised default, the
  region is `unreachable` with "Could not find the last environment of '<app>',
  which is what this workbook collects by default: ... Choose the streams to
  collect in Writeback > Collect From." -- never a silent fall-back to every
  stream. An explicit choice still works then.
- **All streams:** every stream, including environments defined later.
- **A set:** exactly those streams (`""` = the development line). An
  environment defined LATER arrives unticked, hinted "not collected", listed in
  `notCollected` (the hero's badge reads "!", the pane says "Not collected:
  staging. Tick it in Writeback > Collect From ..."). An environment removed
  from the pipeline while chosen stays listed (kind `removed`, "not in the
  pipeline") and its answers stay readable until it is unticked; a tag only
  answers still carry is offered too, so narrowing "All streams" never drops it
  in silence.
- **Refused:** an empty set ("Choose at least one stream to collect from."; the
  last ticked row is disabled), a name no environment may carry, a name that is
  neither defined, stored nor carried by any answer, an unlinked workbook, an
  unreachable workspace, and any computer that does not hold the application's
  publisher key (or an authorised co-publisher's) -- the same proof as reading
  the answers; the gate is the newest version that verifies through the
  developer door. A refusal leaves the workbook clean.
- **A change** dirties the workbook (it is saved with it), is AUDITED whether
  or not auditing is on (`AuditEvent::CollectionStreamsChanged`, always
  recorded: it changes what model tables report; "Collect From changed" in the
  audit viewer), and rebuilds the author's BI tables. Setting the stored choice
  again changes nothing.
- **Checkout** of the SAME application (same package, same workspace by the
  pin-scope rule) keeps the choice; another application starts from the
  default; File > New clears it with the link.
- **Restore** is lenient: a value of the wrong shape reads as no choice (the
  link survives -- failing it would reopen the workbook as standalone), and an
  emptied or misspelled set reads as the default, with a warning in the log.

**Which versions a set of streams reads.** "All streams": the read version and
every older one. A SET: the union of each stream's own carry-forward
(`carry_forward_versions`: an environment's HELD versions, never the semver
rule; a log that does not verify carries nothing forward), clipped at the read
version for the author. So a record tagged `prod` in a version prod never ran is
NOT collected under `{prod}` -- the design's "one walk filtered by tag" was not
equivalent and was rejected. Then, for every role, the carry-forward
COMPATIBILITY rule GATHER uses (`carries_forward_from`: not `Strict`, same cells
by `preserves_cell_meaning_of`, compatible schema), against each older version's
VERIFIED declaration (developer door for an author, the pin for a subscriber):
until BUG-0555 the publisher reads carried every older version's answers
forward with no check, so a region that moved filed last quarter's answers
against the wrong rows. **Each environment stream from its own version**
(BUG-0563): when an environment's authorised pointer names a version OLDER than
the read version (the development line is ahead of prod), that stream's
answers are carried forward from THAT version (`RegionCollection::stream_bases`)
and judged against ITS verified declaration -- exactly as a prod subscriber's
GATHER judges them -- so an unpromoted head that moved the region or made it
`Strict` no longer drops every prod answer from the default view, the roster,
the exports, review and the BI table. `CollectedVersions::filter_for` tells
every reader which streams it reads from each version.

**The control.** `components/CollectFromMenuButton.tsx` over ONE store
(`lib/collectStreamsStore.ts`) over the one Rust choice: a hero in the publisher
Writeback tab (`writeback-tab-collect-from`) and a 28px button in Collected
Responses (`publisher-dashboard-collect-from`). `MenuButton
closeOnSelect={false}` with `menuitemcheckbox` rows: "All streams", "Default:
the last environment (<name>)" (only when another choice is held), then
Development line, each environment in pipeline order (hint: version, "no version
yet", "pointer not authorised", "the default", "not collected"), then removed
names. A click is a TOGGLE computed inside the store's write chain from the
view as it stands when the request runs (`toggleCollectStream`), so two quick
ticks in the open menu never lose the first (BUG-0571); a refusal shows the
Rust sentence. The command is `calp_collection_streams` (op `get` / `set`;
`#[tauri::command(async)]` because it reads the workspace, so a slow share never
freezes the window); it is read on activation, on open/new, when the workbook's
regions change, when the application's environments change (a publish -- the
FIRST one creates the link -- a pipeline edit, a promotion:
`COLLECT_STREAMS_REFRESH_EVENTS`, BUG-0572) and when the menu opens -- never on
a cursor move. A read that FAILS is said ("Could not read which streams this
workbook collects: ...", a "!" badge, "may be out of date" over a stale view)
and leaves the trigger clickable as the retry -- never "publish first"
(BUG-0582). A Set reads the stream tags once and re-uses its walk for the
returned view.

**The submission watch re-baselines on the DATA.** Each listed region carries
its resolved `collecting`; the watch keeps it per region and treats a changed
value as first seen (nothing announced), and never announces a row whose stream
the pass's own listing did not collect. So a newly ticked stream's history is
never announced as "received", whatever changed the choice (the menu, the pane,
a reopened file, a checkout) -- including a change while a pass is in flight.

**Scripts** read exactly the chosen streams (`ListSubmissions` and
`SetSubmissionState` take no stream; a review by id outside the choice is
refused) and have NO action to change them: the choice changes what model tables
report, so it stays the publisher's, behind the publisher key.

**BI writeback tables for the author's own regions** (closes open-items 2.am
item 7). `collect_writeback_datasets` adds an AUTHOR pass before the
subscription loop: every author row Collected Responses lists as `ready` (past
the publisher gate) becomes a PUBLISHER dataset built from the SAME rows the
pane shows (`load_region_current_submissions` with the choice), with an
`environment` column after `region_id` (the stream; empty = the development
line). Subscribed regions' tables keep their schema, so tables imported before
this change still refresh -- also when the region is BOTH designated here and
subscribed (a publisher who subscribes to their own application): the
subscription's view is still built, as a SHADOW dataset never offered for
import, and served under `{region}#subscription` to any bound table without an
`environment` column (`writeback_source::served_key`; BUG-0573). The author
pass walks the workspace ONCE for all own regions
(`calp_collection::ready_author_collections`, nothing of the subscriber half),
`bi_list_writeback_tables` is `#[tauri::command(async)]`, and a rebuild records
what it served so the 60-second poll does not rebuild the same rows again
(BUG-0583). The import list names the streams each table
collects (`WritebackTableInfo.streams`) and the collection's caveat (`note`).
Fresh against answers from OTHER computers: a publisher read that sees an author
region's rows change rebuilds the datasets at once (`note_author_rows_seen`),
and while some open model carries writeback tables a background thread re-reads
the datasets every 60 s and rebuilds only when they changed. A push, a first
publish, a checkout and a Collect From change rebuild them too.

**A table a measure can name** (BUG-0585, found live 2026-10-22). An imported
writeback table's MODEL name is letters, digits and `_` only
(`writeback_source::model_table_name`: `WB_writeback_test_Sheet1_2_B3_B5`, deduped
`_2`, `_3`; no `.`, which reads as `schema.table`), and the readable
"WB writeback-test Sheet1 (2)!B3:B5" is its DISPLAY name. The measure language
names a table only as a bare identifier and has no quoting, so the readable name
-- which the model's validator accepts -- could be imported but never referenced:
no measure, hence no pivot value, no `bi_query` ("at least one measure is
required"), no CUBE formula and no value list could read the table.

**Deliberately NOT filtered by the choice:** the Parquet rollup
(`submissions/_rollup.parquet` is the workspace's shared per-version record,
read by other tools and people; it already has an `environment` column), the
Application Inspector's response activity (every environment of one version),
and model writeback COLUMNS (`bi/writeback.rs`; subscriber-only, one stream --
a column keeps one value per key, so several streams need their own decision;
open-items).

**Format.** No `.cala` version link and no feature id: the field rides in the
`working_copy_link.json` user file. An older build ignores it (keeping it
through the link's `extra`), shows every stream with each row labelled, and has
no author BI tables at all -- visible, not a lie. The choice and the author BI
tables shipped in ONE change; a build with the tables but without the choice
would be the lie case. Pinned by
`a_collect_from_choice_never_raises_the_format_version`. `.calp` is untouched:
user files never reach a package.

**IPC types.** `CollectionStreamsView` / `StreamChoice` / `CollectionStreamsRequest`
live beside their command in `calp_collection.rs` and are mirrored in
`@api/collaboration`, like every `calp_*` type -- a documented exception to
"all Tauri API types in api_types.rs / types.ts". The request is a struct with a
unit-variant `op` and a `choice` of `"all"` or `{"only": [...]}`: no struct
variants.

Pinned by `calp_collection_tests.rs` (the default, every read filtered, review
refusals, new/removed environments, the setter's refusals, dirty and audit,
another computer, held-version carry-forward, BUG-0555, the author dataset and
its freshness, the merge slot), `working_copy.rs` / `audit.rs` /
`persistence.rs` / `zip_io.rs` unit tests, `calp_environments_tests.rs`
(structural), `collectStreamsModel.test.ts`, `collectFromMenu.test.tsx`,
`publisherDashboard.test.tsx` and `submissionWatch.test.ts`, each with a
sabotage proved 2026-10-22, and live by
`app/e2e/journeys/writeback-collect-streams.spec.ts` (5/5, 2026-10-22, on a temp copy of
the workspace; live sabotages fail steps 2 and 3). Steps 2-3 also build a MODEL
on the author's table (blank model, Import > Writeback data, a `SUM` measure
over `value_number`) and read it through `bi_query` grouped by `environment`:
`{prod: 60}` by default, `{prod: 60, test: 6}` after test is ticked (live
sabotage: `refresh_writeback_sources` skipped keeps `{prod: 60}` although the
listing says 6 rows).

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

## Showing what you sent (reconcile)

Every read of the subscriber's writeback state reconciles with the workspace
first (`calp_reconcile_writeback`; the Collaboration extension's
`refreshWriteback` runs it after open, File > New, subscribe, refresh,
environment switch, detach and a landed deferred index rebuild). The body is
`adopt_own_sent_values_inner` (`app/src-tauri/src/calp_commands.rs`). For every
region of the index (subscribed regions only; an author's own designated
regions are not in it) it reads THIS subscriber's current record per cell --
`own_sent_records_by_region`: ONE pass per reconcile, every subscription
resolved, its workspace opened and its pinned manifest verified ONCE, every
version read ONCE (`own_records_by_region_in`), newest across the version the
subscription follows and the versions it carries forward from, filtered to its
environment. An HTTP workspace (which holds no submissions) and a
development-mode subscription are never opened, so a reconcile never blocks on
a network timeout for nothing -- and per cell:

| The workbook holds | Result |
|---|---|
| an unsent draft | nothing changes: what you typed last wins |
| a draft with the workspace record's OWN id and value | it WAS sent (a submit keeps the draft's id; every edit mints a new one -- the workbook was saved before the submit and closed without saving after): it takes the record's state, so it no longer reads as unsent |
| nothing | the sent record goes into the layer and the cell shows its value |
| the same submission | only its review state, reason and reviewer are copied (the return leg) |
| a different sent submission | the workspace's current one replaces it WHOLE (value, id, state); the undo history ends |

- A record the CURRENT declaration refuses is never shown: a cell outside the
  region, a value its type check rejects (carried forward from a version whose
  type changed), a model-keyed record.
- A cell the publisher made a FORMULA keeps the formula; the layer entry stays
  (the rule `reproject_writeback_layer_onto_grids` follows on refresh).
- If some version could not be read, the answer is marked incomplete (read
  once, never retried in the same pass): it may fill a blank cell but never
  replaces a sent value, since the unreadable version may be where that value
  lives. A region whose workspace cannot be reached at all is skipped (offline
  is normal) -- but REPORTED: `calp_reconcile_writeback` returns a
  `WritebackReconcileReport` (the layer, `cellsWritten`, `undoHistoryEnded`,
  `replacedCells`, `unreadable`), and the store keeps the unreadable reasons as
  the reconcile error, so Check Status says it could not reach the workspace
  instead of "Status updated".
- A replace that ends the undo history is never silent: the store shows "B3
  now shows the newer value you sent from another workbook. Undo history was
  cleared."
- The commit guard's re-read after saving a draft is LOCAL
  (`refreshWritebackLocal`: the index and the layer, no workspace read); every
  other refresh reconciles.
- A submit stamps the LOCAL entry with its stream too (only the clone sent to
  the workspace was stamped), so every sent entry in the layer knows which
  stream it belongs to.
- The audit row says the values were "recorded in the workspace under your
  submitter id" -- the id is self-asserted and unverified (open-items 2.am),
  so the row does not claim "you" sent them.
- Nothing to take leaves the document CLEAN (this runs on every open). When
  something changes, the effect is built under the layer's pending lock, the
  grid is written in phase A (the cell's style is kept), dependents recalculate
  in phase B, every value shown is an always-recorded `writeback_restored`
  audit row, and the command emits the backend `grid:refresh` so the canvas
  re-reads the cells.

Open owner questions (`open-items.md`): whether a workbook should follow a
NEWER value sent from elsewhere (implemented: yes) or keep its own and flag
the difference; whether values carried forward from an older version should
fill a newer one (implemented: yes, if the current type check accepts them);
and whether an environment switch should clear sent entries the new
environment has no record for (not implemented: where it HAS a record, that
record replaces the old entry; where it has none, the old entry stays).

Pinned by the BUG-0554 tests in `app/src-tauri/src/writeback_local_sheet_tests.rs`
and `app/extensions/Collaboration/lib/__tests__/writebackStore.test.ts`, and live
by step 6 of `app/e2e/journeys/writeback-subscriber.spec.ts` (2026-10-22; a live
sabotage of `adopt_own_sent_values_inner` fails it). Since identity phase 1 only
answers THIS account's key signed are taken back: step 11 of the same journey
plants an edited copy of the subscriber's own answer in a copy of the workspace,
and a new subscription never seeds it.

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