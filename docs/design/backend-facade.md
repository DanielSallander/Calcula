# Backend Facade & Capability Model (A3)

Design spike for the architecture audit's deepest seam: the Rust backend is a
**feature-monolith with no extension boundary**, reached through an untyped
`invokeBackend(cmd, args)` passthrough.

## Current as of 2026-08-16

Re-audited against source. The **design is intact and shipped**; the counts had drifted and one
resolved-asymmetry paragraph named two symbols that no longer exist.

| Figure | 2026-08-16 | 08-27 | 08-29 | 09-01 | 09-03 | 09-05 | 09-07 | 09-10 | 09-25 | 09-30 | 09-30 (anchor) | 09-30 (M6 seal) | 10-01 (M6 door) | 10-01 (owner B trail) | 10-01 (owner B all-or-nothing) | 10-01 (review of M6b) | Recounted (2026-10-01, M8 command allowlist) | How counted |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Commands in `generate_handler!` | 761 | 773 | 783 | 788 | 787 | 792 | 800 | 806 | 809 | 812 | 813 | 815 | 817 | 819 | 821 | 821 | **822** | bracket-matched parse of `lib.rs`, comments stripped LINE-WISE (all unique) |
| `#[tauri::command]` attributes | 798 | 815 | 822 | 827 | 826 | 831 | 839 | 845 | 849 | 853 | 854 | 856 | 858 | 860 | 862 | 862 | **863** | `#[tauri::command]` occurrences under `app/src-tauri/src` |
| Privileged (denylisted) commands | ~30 | 94 | 100 | 101 | 101 | 101 | 102 | 108 | 107 | 107 | 108 | 109 | 111 | 111 | 111 | 114 | **115** | unique quoted names inside `PRIVILEGED_BACKEND_COMMANDS` (`app/src/api/backendCommands.ts`), comments stripped line-wise |
| Feature-open commands | 667 | 673 | 683 | 687 | 686 | 691 | 698 | 698 | 702 | 705 | 705 | 706 | 706 | 708 | 710 | 707 | **707** | 822 − 115 |
| Typed wrappers in `backend.ts` | ~229 | 327 | 338 | 338 | 338 | 338 | 339 | 339 | 340 | 340 | 340 | 340 | 340 | 340 | 340 | 340 | **340** | exported functions/consts in `backend.ts` (lines starting `export async function` / `export function` / `export const`) |

**Re-run 2026-10-02, at the end of M8 (its docs task): unchanged.** The rest of M8 -- the TypeScript half of the
command allowlist, the promotion code summary (carried by the existing `calp_promotion_impact`), the keyboard into
slicers and timelines, the cell interceptors acting on release, the touch measurement, and the review's fixes --
added no command and moved none to or from the denylist. All five figures re-run together, line-wise
(`count_cmds_m8rE.cjs`, the same method as the column): 822 / 863 / 115 / 707 / 340, every entry a valid unique path,
so no new column. CLAUDE.md read **821** at this re-run and still needs the **822** sentence handed over with the
column; it is the owner's file. A side note for whoever re-runs the comma-split cross-check CLAUDE.md describes: with
fifteen comment lines inside the bracket now carrying commas, that parse no longer lands a fixed few entries off --
it depends on exactly how each chunk is cut -- so only the line-wise figure means anything.

The "Recounted (2026-10-01, M8 command allowlist)" column is plan_M8 S1 (Task A, BUG-0257 phase 5): a button
cell that came with an application may run a Calcula command only when the command is on Rust's
`button_cells::DISTRIBUTABLE_BUTTON_COMMANDS` (empty today, by owner decision), approved under
`button-commands:<application>` and allowed by the working-copy private-sheet rule. ONE new command, DENYLISTED
under `codeExecution` (privileged **115**, feature-open stays **707**):
`scripting::control_action::authorize_button_command` -- the second question the page asks after the button door
answered `command` with an application and the page checked the command's live registration: it compares the
claim with the stored cell, asks the command gate again and writes the always-on run row. A grant door like
`run_control_action` beside it, so a third party may never reach it. All five figures re-run together, line-wise,
with `count_cmds_m8rA1.cjs` (the review-of-M6b parse with the new name checked): 822 / 863 / 115 / 707 / 340, every
entry a valid unique path. CLAUDE.md read **821** at this recount and needs **822**; it is the owner's file, so the
corrected sentence was handed over rather than edited by the agent.

The "10-01 (review of M6b)" column adds NO command: a review of owner decision B's work found the
doors that write its trail classified feature-open, so three existing commands moved to the DENYLIST under
`codeExecution` (privileged **114**, feature-open **707**): `check_distributed_mount_consent` -- since F3 it
opens a run's CELL GRANT and writes the always-on "you started it from ... so it could read and change cells on any
sheet" run row from a page-supplied claim -- and `audit_explicit_run_writes` / `audit_explicit_run_refusal`,
which write what a granted run changed and the refusal of one before it started. The script host and the one-off
runner are their only callers; a third party that could reach them would forge those rows, or spend a live grant
with an empty report so the run's real writes never reached the trail (grant ids are now random as well).
`begin_undo_savepoint` / `roll_back_to_undo_savepoint` stay feature-open beside the undo family they belong to.
All five figures re-run together, line-wise, with `count_cmds_m6bfix.cjs` (the all-or-nothing parse, the
denylist read again): 821 / 862 / 114 / 707 / 340, every entry a valid unique path. CLAUDE.md's generate_handler!
figure is unchanged by this (it counts commands, not the split).

The "10-01 (owner B all-or-nothing)" column is owner decision B's follow-up F9: a run of an
application's macro that a person started with cell access and that fails part-way is UNDONE whole, like the
module runtime. Two commands, both FEATURE-OPEN beside `begin_undo_transaction` / `cancel_undo_transaction`
(privileged stays **111**, feature-open **710**): `undo_commands::begin_undo_savepoint` -- opens the undo
transaction or joins the one a caller holds (a command-line run of several lines), and names the point it is at
(the open transaction's ticket and how many changes it holds) under one stack lock -- and
`undo_commands::roll_back_to_undo_savepoint`, which takes back exactly the changes recorded after that point
through the restore Ctrl+Z uses (`apply_changes`), leaving no undo and no redo step, and refuses (moving nothing)
when the step is no longer open. The script host calls both through `invokeBackend`; no typed wrapper was added.
All five figures re-run together, line-wise, with `count_cmds_m6bB2d.cjs` (the owner-B-trail parse with the two
names added): 821 / 862 / 111 / 710 / 340, every entry a valid unique path. CLAUDE.md read **817** at this
recount and needs **821**; it is the owner's file, so the corrected sentence was handed over rather than edited
by the agent.

The "10-01 (owner B trail)" column is owner decision B's persistent trail (M6b, follow-ups F3,
F15 and F8). Two commands, both FEATURE-OPEN like `audit_button_refusal` (privileged stays **111**, feature-open
**708**): `scripting::explicit_run_audit::audit_explicit_run_writes` -- the page's ONE report of which cells a
run of an application's object-script macro wrote while it held cell access, per sheet with bounds, recorded as
always-on `ScriptExecuted` rows in the module runtime's shape (surface `object-script`); it presents the grant
id the mount gate opened (`check_distributed_mount_consent` gained an `explicitRun` PARAMETER, not a command, and
answers `cellAccess` + `grantId`), and Rust names the application, the macro, the door and the button from that
grant, never from the page; an unknown or already-reported grant records nothing -- and
`scripting::explicit_run_audit::audit_explicit_run_refusal`, the always-on `ApplicationCodeRefused` row (reason
`outsideCellAccess`) for a run the one-off runner refused before it started because the macro also calls methods
outside cell access, reading the application from the module store. Both write only the audit trail and are
main-window only. No typed wrapper was added (the host and the runner call them through `invokeBackend`). All five
figures re-run together, line-wise, with `count_cmds_m6bB2c.cjs` (the M6 door parse with the two names added):
819 / 860 / 111 / 708 / 340, every entry a valid unique path. CLAUDE.md read **817** at this recount and needs
**819**; it is the owner's file, so the corrected sentence was handed over rather than edited by the agent.

The "10-01 (M6 door)" column is BUG-0257 phase 4 in Rust (M6 Task B). Two commands, both
DENYLISTED under `codeExecution` (privileged **111**; feature-open stays **706**):
`scripting::control_action::run_control_action` -- THE BUTTON DOOR: a click names its button (kind and cell,
`deny_unknown_fields`, never code); Rust reads the code from its own store, asks the approval of its exact bytes
(`buttonAction:<sha256>`) or of the application module it runs, applies the working-copy private-sheet rule,
asks Script Security, records every run and refusal of an application's code, and runs it -- and
`controls::adopt_held_button_code` ("Make this my own"), which moves an application's held button code into the
user's own slots after the Properties pane showed it, as one undo step, always audited. No typed wrapper was
added (Task D wires the click). All five figures re-run together, line-wise, with `count_cmds_m6b3.cjs` (the M6
seal parse with the two names added): 817 / 858 / 111 / 706 / 340, every entry a valid unique path. CLAUDE.md
read **813** at this recount and needs **817**; it is the owner's file, so the corrected sentence was handed
over rather than edited by the agent.

The "09-30 (M6 seal)" column is BUG-0257 phase 4's prerequisite (M6 Task A): approvals of
distributed code sealed to this computer (`app/src-tauri/src/consent_seal.rs`). Two commands:
`consent_seal::record_script_consent` -- the approval screen's door, which computes every hash itself and
seals the record with a key held in Windows Credential Manager -- is DENYLISTED under `codeExecution`, because
an approval switches code on (privileged **109**); `consent_seal::list_script_consents` only reads the
verified approvals and stays feature-open (**706**). No typed wrapper was added: `@api/distributedConsent`
calls both through `invokeBackend`, and nothing else spells them (pinned by
`distributedConsentSealedWire.test.ts`). All five figures re-run together, line-wise, with
`count_cmds_m6a.cjs` (the M4 parse with the two names added): 815 / 856 / 109 / 706 / 340, every entry a valid
unique path. CLAUDE.md read **813** at this recount and needs **815**; it is the owner's file, so the corrected
sentence was handed over rather than edited by the agent. M6 planned two more commands (`run_control_action`,
`adopt_held_button_code`, Task B); they landed the next day and the parse was re-run (the M6 door column).

The "09-30 (anchor)" column is the developer anchor (BUG-0257 programme, M4 Task A):
`calp_commands::calp_forget_developer_anchor` -- forget what this machine remembers about who created an
application it develops -- made **813**. It lowers the one guard a share-writer cannot forge against a planted
first version, so it is DENYLISTED under `collaborationTrust` (privileged **108**; feature-open stays **705**).
All four figures re-run together, line-wise, the same afternoon -- and re-run again at the end of M4 (after the
push's include and dead-link gates, phase 3's run gate, and `button_cells::audit_button_cell_refusal` RENAMED
`audit_button_refusal`, net zero): 813 / 854 / 108 / 705 / 340, unchanged, every entry a valid unique path.
CLAUDE.md read **812** at that recount (the 2026-09-30 column's figure) and needs 813. It is the owner's file,
so the corrected sentence was handed over rather than edited by the agent; until it lands, the two
"independent" counts disagree by one, in the stale direction.

The 2026-09-30 column is the BUG-0257 programme. The tree already registered **810** before it (one
command landed from other work after the 09-25 recount), then `controls::move_control` (the
floating/in-cell toggle's MOVE, which keeps a working copy's held button code) made 811, and
`button_cells::audit_button_cell_refusal` (the always-on audit row for a click's refusal of an
application's button-cell action; renamed `audit_button_refusal` in M4, when button controls got the same
row) made **812** -- feature-open, like `audit_record_capability`: it
writes only an audit row, and it reads the application from the cell's own stamp, never from the
caller. The "Remove the application's code" step is an optional `replaceHeld` flag on the existing
`set_control_property`, not a new command. All four figures re-run together, line-wise, on
2026-09-30; CLAUDE.md still quoted 809 at that date and needs the same figure.

The 2026-09-25 column is the canvas-sheet programme: `sheets::set_canvas_layout` (the canvas page's
layout, gated `editObjects`) and `controls::set_control_geometry` (one undo step for a batch of
control moves). The committed tree before `set_control_geometry` already registered 808, so the 09-10
figure was one behind by the time the canvas work began. The privileged count reads **107** on BOTH the
committed tree and the working tree with the parse named in the row; the 09-10 column's 108 does not
reproduce and no entry was removed by this work -- recount before trusting either figure.

The 2026-09-10 column is the on-board runtime (2.AI.10 Step 3): six `ai_builtin_*` commands, all
six denylisted under a new `localRuntime` capability — a child process on the user's machine and a
gigabyte download are not things a third-party door may reach — so the feature-open count did not
move. Both counts re-run together, line-wise, the same afternoon.
| Vitest at the time of the DONE claim | 102k | ~107,155 / 808 files | *not re-measured* | 109,188 / 906 files | 109,429 / 901 files | current suite |

**The 2026-08-27 recount is the point of the row, not the numbers.** CLAUDE.md and this file
are supposed to be two INDEPENDENT counts of the same thing, which only works if both are
re-run together. Four of the five re-measured figures had drifted since 2026-08-16 while both
documents kept quoting the old ones: the command count was **769** at the parent commit — stale
by 8 before the four `script_authoring` commands in this change took it to 773 — and the
denylist had grown from 94 to 100 with nobody updating either page. A figure nothing enforces
goes stale silently; the AppState census in `document_effect.rs` is the shape that does not,
and it is the shape any of these would need to stop drifting for good.

**And then the PARSE turned out to be wrong, which is worse than drift.** The 2026-08-31 and
2026-08-29 recounts reported 787 and 789 from a script that split the `generate_handler!`
bracket on commas and stripped `//` per *chunk*. Four of the doc comments inside that bracket
contain a comma ("…so it stays reachable while X, but not Y"), so each of those swallowed the
command name that followed it into a comment fragment AND left four more fragments standing as
entries — net **+4, in the direction that flatters the number**. The line-wise parse in the
"How counted" column above gives **785**, every entry a valid path, none duplicated. A count
whose method is not written down is not reproducible, so the method is now in the table.

CLAUDE.md said 783 through all of this. It was closer than either "recount" — not because it
was maintained, but because two errors in opposite directions cancelled. That is exactly the
failure the AppState census in `document_effect.rs` does not have: it re-derives the number at
build time and fails the build when it moves. Any of these rows would need that shape to stop
drifting for good; until then, **re-run the parse, and record how you ran it.**

The 2026-09-01 column is a real +2 on top of the corrected 783: the subscribed-sheet work added
`calp_detach_sheet` and `calp_get_sheet_provenance`. Both pages were re-parsed together after
that change, which is the whole discipline — a number updated on one of two "independent" pages
is a number that has stopped being independently checked.

Also corrected below: the `is_bi_granted` / `grant_script_bi` paragraph (those symbols were
**deleted** and generalized — the control was strengthened, not dropped), and the "third-party
extensions cannot call `invokeBackend` at all" finding, which is pre-A3 history that the same
document then contradicts three paragraphs later. **Nothing described here is unbuilt** except
the item explicitly marked "Resolved (not built)", which is a deliberate design decision.

## The reality (verified 2026-06-27; counts refreshed 2026-08-16, recounted 2026-08-27 — see the table above)

- `app/src-tauri` registers **569** (now **773**) `#[tauri::command]`s in one crate, including
  feature-specific modules (`chart_commands`, `conditional_formatting`,
  `data_validation`, `autofilter`, `grouping`, `pivot/`, `bi/`, …). There is no
  Rust-side IoC / plugin surface — a feature that needs backend logic adds a
  command directly. So "even built-in features are extensions / the grid is the
  kernel" is a **frontend-only** reality (now noted in `ARCHITECTURE.md`).
- The frontend door is `app/src/api/backend.ts` → `invokeBackend<T>(cmd, args) =
  invoke<T>(...)` — a zero-gating passthrough. ~229 (now **338**) typed wrappers
  exist, but raw `invokeBackend("string")` is also used: **44 extension files call
  ~90 distinct commands by raw string across ~112 sites.** *(That last figure is
  dated 2026-06-27 and describes the problem this document went on to fix. **As of
  2026-08-16 it is zero** — `invokeBackend(` appears in no extension file outside
  tests and the dev-only TestRunner harness, and the lint ban in step 3 keeps it
  there.)*

### Who can reach the backend

| Caller | How it reaches the backend | Trust |
|---|---|---|
| Built-in extension | Compiled into the host bundle; imports `@api/backend` directly | trusted (kernel-adjacent) |
| Runtime 3rd-party extension | Blob-ESM `import()`; **no** `@api` global / import map — gets only the injected `ExtensionContext`, which exposes **no** raw backend access | untrusted |
| Object scripts / notebooks | Tier broker ALLOWLIST (already capability-gated) | per tier |

**Key finding (as of 2026-06-27 — superseded by step 2 below, which this same
document records as DONE):** third-party extensions are *already* constrained —
they cannot call `invokeBackend` at all. **Today they can**, through the governed
door: `ExtensionContext.invokeBackend` is injected per-extension and scoped by
trust, so a distributed extension reaches feature-open commands and is refused the
100 privileged ones. Read this paragraph as the starting position, not the current
one. So the untyped passthrough was, at the time, a **built-in
(trusted) typing/maintainability** concern, not an open third-party hole. But the
architecture has **no declared capability boundary** for backend commands, so the
moment the `ExtensionContext` gains backend access (a real product need —
third-party features want data), there is nothing to scope it.

## Design: a governed, capability-scoped backend door

Mirror the script broker's "ALLOWLIST as data" pattern:

1. **Capability data (this slice).** `app/src/api/backendCommands.ts` declares the
   privileged command set — the "VBA-escape" surface (code execution, host
   filesystem, OS credentials, extension management, MCP server) plus the
   broker-routed **BI data** reads (`biData`: `bi_query`, `bi_get_connections`) —
   grouped by capability, with `assertExtensionMayInvoke(cmd, { trusted })`. A
   drift-guard test (`backendCommands.test.ts`) parses `generate_handler!` and
   asserts every privileged name still exists, so the registry can't go stale.
   Everything not listed is "feature-open" (the danger is concentrated in ~30 —
   now **100** — commands, so a denylist of the dangerous beats an allowlist of the
   safe 540 — now **673**). The ratio moved, the argument did not: the privileged
   set is still an order of magnitude smaller than the open set, which is what
   makes a denylist the maintainable choice.

2. **Governed `ExtensionContext.invokeBackend` (DONE).** A *scoped* backend
   accessor is now part of the `ExtensionContext` the loader injects
   (`contract.ts`). `ExtensionManager.activateExtension` wires it via
   `createScopedInvokeBackend(trust === "trusted", invokeBackend)`
   (`backendCommands.ts`), so it runs `assertExtensionMayInvoke` with the
   extension's already-classified trust before the raw `invoke`. Built-ins pass
   everything; a third-party is denied privileged commands (and, later, gated per
   its declared-capability manifest — `computeExtensionCeiling` is not yet
   consulted). Gate failure surfaces as a rejected promise, never a sync throw.
   The trust-less *base* context exposes a refusing stub, so backend access only
   exists on the per-extension (trust-scoped) context. This is the one place
   backend access enters an extension — so it is the one place to gate.

3. **Migrate built-ins off raw `invokeBackend("string")` (DONE).** All ~124 raw
   call sites across 24 files / 13 extensions were re-routed:
   - **Channel.** `createBackendChannel(label)` (`backendCommands.ts`) is a
     deferred door for code that runs outside the `ExtensionContext` — lib-api
     wrappers, zustand stores, React components. The extension binds it once in
     `activate()` (`<x>Backend.set(ctx.invokeBackend)`); the module's functions
     call `<x>Backend.invoke(cmd, args)`, flowing through the same gated door.
     Each feature extension owns one channel module (`lib/<x>Backend.ts`).
   - **Import-swap.** Cross-feature pivot/table reads that already had typed
     wrappers (`getPivotHierarchies`, `getAllTables`, `applyPivotFilter`, …) were
     swapped to those wrappers.
   - **Ban.** `eslint.boundaries.js` forbids the raw `invokeBackend` import from
     `@api/backend` in extensions (folded into the FACADE block via
     `no-restricted-imports` `paths`/`importNames`; typed wrappers stay allowed).
     A later patterns-only relax-block keeps tests + the dev-only TestRunner
     harness exempt (they mock/reach the raw door legitimately) while preserving
     the core/shell Facade patterns for them. `npm run lint:boundaries` is clean.
   Note: channel modules import `createBackendChannel` from the leaf
   `@api/backendCommands`, NOT the `@api` barrel — the barrel's size triggers a
   circular-init `TypeError` at module load.

4. **Backend extension surface (long-term, optional).** A true Rust plugin model
   (third-party backend code) is out of scope; the practical answer is richer
   *capability APIs* (like `net.fetch` / `bi.query`) exposed through the broker,
   not arbitrary command registration.

## Layering: the backend gate vs the broker (why the ceiling lives at the broker)

There are two capability vocabularies, enforced at two layers — deliberately
NOT merged:

- **Backend gate** (`assertExtensionMayInvoke`, this module): a coarse DENYLIST
  over the raw backend door. Vocabulary = `PrivilegedCapability` (codeExecution,
  hostFilesystem, credentials, extensionManagement, mcpServer, biData). Decision
  is binary by trust: trusted built-ins pass; non-trusted code may never call a
  privileged command directly.
- **Broker** (`scriptHost/broker.ts` `checkPolicy`): enforces the per-manifest
  `CapabilityId` ceiling **per call**, plus a runtime **JIT consent grant** — the declared
  ceiling is the *maximum*, the grant is the *actual* permission. The vocabulary
  was the six ids `net.fetch` / `bi.query` / `bi.sql` / `storage` / `ui.html` /
  `formula.udf` when this was written; it is now **16**, single-sourced in
  `ALL_CAPABILITY_IDS` (`app/src/api/scriptHost/capabilityIds.ts`) and never
  re-typed elsewhere — so read the id list from there, not from this document.

A reviewer might expect the per-manifest ceiling to be threaded into the backend
gate. It must NOT be: the ceiling is *declared*, not *granted*, so allowing a
capability-backed command on declaration alone would bypass the broker's per-call
consent (and, for fetch, the Rust per-call origin re-check). The correct posture
is that every capability-backed backend command (`script_http_fetch`,
`script_bi_sql`, `bi_query`, `bi_get_connections`) is reachable by non-trusted
code **only through the broker** — so they all sit in the backend denylist, and
the ceiling is enforced once, at the broker. Adding `biData` (this slice) closed
the last gap: `bi_query`/`bi_get_connections` were feature-open at the backend,
so a future distributed extension reaching `ctx.invokeBackend` directly could
have read BI data without the broker's capability+consent gate.

**Asymmetry (RESOLVED, A3.4-S2 — mechanism GENERALIZED 2026-08; symbol names below
are superseded):** `script_http_fetch` re-checks the granted origin in Rust per
call; `bi_query` / `script_bi_sql` previously relied on the TS broker only. They
now also re-check an authoritative per-script grant in Rust. A broker-routed
(sandboxed) call carries a `script_id` and must have been granted; a trusted
main-window direct call (built-in feature) carries none and passes.

> **Do not grep for `CapabilityStore.is_bi_granted` or a `grant_script_bi` command
> — both were deleted, and their absence does NOT mean the re-check was removed.**
> The BI-only pair was replaced by a generic one, which is strictly stronger:
> - The store method is now `CapabilityStore::is_granted(script_id, capability)`
>   (`app/src-tauri/src/.../capability_store.rs:168`).
> - The grant mirror is now `grant_script_capability`
>   (`app/src-tauri/src/scripting/writeback_gateway.rs`), validating against ONE
>   allowlist covering every mirrored id. Its predecessor's id check "hard-rejected
>   everything outside `bi.*`", which is why it had to go. Quoting
>   `net_commands.rs:123-128`: *"There is deliberately no second grant door."*
> - `RUST_MIRRORED_CAPABILITIES` (`app/src/api/scriptHost/capabilities.ts:153-168`)
>   now covers **8** ids: `bi.query`, `bi.sql`, `bi.model`, `bi.connector`,
>   `distribution.writeback`, `schedule`, `distribution.publish`,
>   `distribution.subscribe`.
>
> So the asymmetry this section closed for BI is now closed for every mirrored
> capability, through a single door rather than one door per feature.

## The other backend boundary: `DocumentEffect` (added to this doc 2026-08-16)

This document predates the backend's **strongest** internal boundary and did not mention it.
Where `assertExtensionMayInvoke` governs *who may call* a command, `DocumentEffect` governs
*what a command must admit it did*. Both are compiler-enforced rather than review-enforced, for
the same reason: the census in `document_effect.rs`'s own header found **256 of the then-746**
Tauri commands mutating saved state without setting the dirty flag.

- `FileState::is_modified` is **private** (`app/src-tauri/src/persistence.rs`) and
  `app/src-tauri/src/document_effect.rs` is its **sole writer**. That one flag gates both the
  close-without-saving prompt and AutoRecover, so a command that mutates without setting it
  loses the user's work twice over, silently.
- Persisted backend state is `Persisted<T>`, never a bare `Mutex<T>`: `read()` is free,
  `write(&effect)` demands a `DocumentEffect`. **59** `AppState` fields are converted
  (of 104 pub fields), `grids` / `grid` among them. Declare any NEW persisted store
  `Persisted<T>` from the start.
- Exactly one arm per mutating command: `DocumentEffect::mutates(&FileState)`
  (`document_effect.rs:437`, dirties **at construction**, so possession is proof);
  `DocumentEffect::transient(&TransientScope)` (`:444`, the preview/simulation exemption —
  constructible only by presenting a restore registry that already holds the token, which is why
  Animation qualifies and `scenario_show` structurally cannot); and
  `DocumentEffect::deliberately_clean(CleanReason::…)` (`:450`) over a **closed** enum (`:287`),
  so the whole audit is one `rg deliberately_clean`.
- Gated commands use `lock_pending()` then `.authorize(&effect)` to keep the gate and the
  mutation in one critical section — Tauri dispatches on a thread pool, so a `read()`, drop,
  `write()` sequence is a TOCTOU window in every protection-checked command.

The relationship to this document's model: the capability denylist decides whether a caller may
reach the backend at all; `DocumentEffect` decides what happens to the document once it does.
Neither substitutes for the other.

## Status

- **Done:** (1) capability data + enforcement primitive + drift-guard test
  (`backendCommands.ts`, `backendCommands.test.ts`); architecture reality
  documented here and in `ARCHITECTURE.md`. (2) The governed
  `ExtensionContext.invokeBackend` door — `createScopedInvokeBackend` factory +
  contract member + ExtensionManager wiring + base-context refusing stub, covered
  by door-factory unit tests. (3) Migration of all ~124 raw call sites onto the
  channel / typed wrappers + the `eslint.boundaries.js` ban forbidding the raw
  `@api/backend` `invokeBackend` import in extensions (FACADE block, with a
  tests/TestRunner relax-block). Verified: canonical typecheck
  (`tsc -p tsconfig.check.json`) clean, full vitest green (102k tests at the time;
  **~107,155 across 808 files** as of 2026-08-16),
  `lint:boundaries` clean, and the ban proven to fire on the raw import while
  allowing typed wrappers.
  (4) Closed the model-scoped BI direct-path gap by adding the `biData` group
  (`bi_query`, `bi_get_connections`) to the denylist, and documented the
  gate-vs-broker layering above.
- **Resolved (not built):** threading `computeExtensionCeiling` into the backend
  gate. Analysis (see "Layering" above) showed the per-manifest ceiling belongs
  at the broker (declared ≠ granted; the broker has per-call consent + Rust
  re-check), and the backend gate is correctly a coarse broker-only denylist.
- **A3.4 (backend extension surface — done):** the design spike concluded a
  literal Rust plugin loader is the wrong answer (compile-time commands + the
  security floor); the genuine surface is harden-the-mediated-path + internal IoC
  + document. Shipped: **S1** a fail-closed drift guard (a new dangerous-looking
  command must be denylisted or explicitly acknowledged, not silently
  feature-open); **S2** the Rust-side BI capability re-check above; **S3** a
  data-driven backend undo/restore registry (`undo_commands.rs`) replacing the
  hardcoded `apply_custom_restore` match + the fragile `kind.starts_with(...)`
  deferral + the fixed change-flag mapping with a `kind → {restore_fn,
  change_class, defer}` table (built-ins self-register; behavior-preserving, with
  a unit test asserting `defer` still equals the legacy prefix result for every
  kind); **S4** this doc + `ARCHITECTURE.md` now state the backend-is-the-trusted-
  kernel boundary as a deliberate, defended decision.
- **Next (long-term, optional):** richer broker capabilities on demand (the
  item-4 template) when a concrete third-party backend need arises. (The audit
  trail is now unified: QuickJS grid mutations + capability calls all persist to
  one per-workbook log — `net.fetch`/`bi.query`/`bi.sql` record authoritatively
  in their Rust gates via `net_commands::record_capability_call`, and the
  remaining caps + broker-policy denials write through from the broker ring via
  the `audit_record_capability` command. See `audit.rs`,
  `scripting/commands.rs::record_script_grid_mutation`, and the dedup in
  `broker.ts`.)
