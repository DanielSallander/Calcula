# Scripting System Review — VBA Parity, Models & .calp Coverage

**Date:** 2026-07-31 (review) · **Closing status: 2026-08-01, after Waves A–I (program closed)**
**Method:** 18-agent adversarial review. Eight readers enumerated every script surface from code
(broker allowlist, QuickJS op registry, MCP tool list, capability vocabulary); five graders scored
the combined surface against the Excel VBA object model; every claimed gap was then adversarially
re-verified against the code (verifiers were instructed to refute each claim). Of 143 deduped gap
claims, the top 48 were verified: **27 confirmed missing, 21 partial, 0 refuted** — no reviewer
claim turned out to be wrong, only incomplete.

## 0. How to read this document

This file started as a REVIEW and is now also the PROGRAM RECORD. Every §7 roadmap item carries one
of three statuses, and nothing else is permitted:

- **SHIPPED** — the capability exists, is reachable from a real surface, and has tests. Where a
  shipped item still has an edge it cannot express, that edge is written out under the item. A
  SHIPPED item with no caveat means there is no known caveat.
- **PARTIAL** — some of the item landed. The line *"Missing:"* under it is the authoritative list of
  what did not, in enough detail to act on without re-deriving it.
- **DEFERRED** — deliberately not built. The reason is stated. "We ran out of time" is a legitimate
  reason and is written as such; it is never dressed up as a design decision.

**Why the statuses are worded this carefully.** This whole program began because the project's own
records said the macro recorder had shipped when it had silently regressed to dead plumbing (§2.14).
The cost of that was not the missing feature — it was that nobody knew it was missing. A status here
is a claim someone will act on six months from now without re-reading the code. If you cannot cite
the file that makes a status true, the status is PARTIAL.

And citing a file is still not enough. On 2026-07-31 the rebuilt macro recorder was marked SHIPPED
with 116 passing unit tests and every file citation correct; on 2026-08-03 the first human to use it
found four bugs in five minutes, none of which any of those tests could have seen (§8, eighth
correction). **A test count is a claim about a component, not about a feature** — if a status cites
tests, it must say which component they cover, and name what was never exercised by a person.

And *that* was still not enough. The four bugs were fixed, the suite went green again, and the same
user ran it a second time and reported the same sentence: nothing happens. **Two of the feature's
three entry points had never worked and no test could tell**, because every test asserted that the
right code was produced and stored and **not one asserted that running it changed a cell** (§8,
ninth correction). If a feature has more than one way to be invoked, the status line must enumerate
them and mark each separately — and at least one assertion must be phrased the way the user would
phrase it: *press this, and the thing on screen changes.*

Statuses below were re-verified against the code on **2026-08-02** (Wave K), not carried over from
wave reports. That pass found eleven false statuses in this file and is recorded as the seventh
correction note in §8; the rule it added is short enough to state here:

> **A claim of ABSENCE decays like any other claim — faster, because nothing in the codebase moves
> when it becomes false.** "Verified absent" without a date and the exact search that produced it is
> not a status either.

**THE AUDIT RULE (broken twice; read this before writing any status).** "Script reach" is not the
`ALLOWLIST` table. A complete enumeration is **five** lists, and a claim derived from fewer is not a
status:

1. `ALLOWLIST` rows (`api/scriptHost/allowlist.ts`);
2. the **aspect switches** — the `case "…"` labels inside `executeSetState` / `executeGetState`
   (`api/scriptHost/host.ts:2986` and `:3270`). These have **no allowlist row by design**; two audits
   in a row grepped only list 1 and wrote "verified absent" for a shipped feature (§2.9, §8);
3. `EXTENSION_BROKER_METHODS` (`api/scriptHost/extensionProtocol.ts:436`) — the strict subset a
   *sandboxed extension* can reach, which is why that surface's ceiling is legitimately shorter;
4. the QuickJS op registry (`core/script-engine/src/ops/`, mirrored in `manifest.rs`);
5. the MCP tool list. **Corrected 2026-08-01 (Wave I):** this document has said
   `app/src-tauri/src/mcp/tools.rs` since the review, and that file holds *implementations*, not the
   tool list. The authoritative enumeration is the `#[tool]`-annotated `async fn`s in
   `app/src-tauri/src/mcp/server.rs` — 37 of them, grep `    async fn `. An auditor following the
   old pointer would have grepped a file that cannot answer the question, which is precisely the
   failure mode this rule exists to prevent.

Wave H added a sixth surface — **script libraries** — whose reach is not a new list but a *derived*
one: `declared(library) INTERSECT declared(consumer)` over list 1. It has its own
`scriptSurfaces.ts` row for exactly that reason.

**A SEVENTH THING THE FIVE LISTS DO NOT COVER, and it is where Wave I found its worst defect.** All
five enumerate what code *calls*. They say nothing about what the host *hands to code it did not ask
for*, and nothing about **which code the host decides to run at all**. Two of the three Wave I
findings live in that blind spot: a `.calp` package's custom-function library was merged into the
workbook's shared UDF sandbox and mounted with no consent prompt, and a package's module script could
be executed by a package-supplied button through `run_script`. Neither has a broker method, so no
amount of list-grepping would have surfaced either. When auditing whether "code that arrives in a
package cannot run without consent" is true, enumerate the **payload kinds a `.calp` carries** and
name the gate for each — the table in §7.19 is that enumeration.

**Wave K searched that seventh dimension deliberately and found two more of its inhabitants**
(§7.20 dimension 5): `workbook.onOpen` and the after-save event handed sandboxed code — including an
add-in with *zero* capabilities — the workbook's **full filesystem path**, at a site three files away
from an explicit refusal to hand out the containing folder for that exact reason; and
`sheet.onDataChange` / `cell.onEdit` pushed cross-sheet cell contents to restricted handles whose
siblings filtered correctly. Neither has a broker method. If you are auditing this dimension, the
question to ask is not "what can this code call" but **"what arrives in its inbox without it asking,
and who decided to start it".**

---

## 1. Verdict

**On the pillars VBA never had, Calcula already exceeds it decisively:** hardened worker realms,
restricted/unlocked tiers, an 8-capability vocabulary with declared ceilings, Rust-side
authoritative re-checks, per-source-hash consent, an always-on audit trail, and a governed
in-product model-mutation gateway (something Power BI users need external Tabular Editor for).
The security/transparency vision is delivered.

**On functional coverage, Calcula scripting is roughly half of VBA — and it is the wrong half
missing.** The system is strong at *observing and reacting* (typed per-object contexts, event
hooks with better instance scoping than VBA, `range.onBeforeCommit` is an interception primitive
VBA never had) and weak at *mutating and constructing*. The archetypal VBA macro — "reformat,
sort, insert summary rows, build a chart, prompt the user, save" — can only be ported for the
value-writing third. A user porting a data-manipulation macro mostly succeeds; one porting an
application-orchestration macro fails at nearly every step.

**Critically, most gaps are wiring gaps, not engine gaps.** The MCP/AI surface already has
`apply_formatting`, `create_chart_from_spec`, `create_table`, `create_pivot`, `create_named_range`
— undoable, audited, tier-gated (`app/src-tauri/src/mcp/tools.rs`). The broker allowlist and
QuickJS op set simply never expose these paths to user scripts. The backend proved the pattern;
user scripting never got it.

### Dimension scorecard

Two columns: the grade at review time (2026-07-31) and the grade now (2026-08-01, after nine waves).
The "now" column is the one to trust; each cell names the code that makes it true.

> **Re-derived again on 2026-08-01 during the Wave I closing pass.** Three cells changed
> (Code reuse / packaging, `.calp`/writeback automation, Security model) and one — Add-in
> authoring — had its long-standing "disclosed but not gated" caveat closed. One cell that did NOT
> change is worth naming: **Security model stays ✅ Beyond VBA, but it stayed there by being fixed,
> not by being right.** Wave I found a `.calp` payload kind that executed with no consent at all
> (§7.19-A). See §7.19 for what each cell's change rests on.

> **Every cell below was re-derived from the code on 2026-08-01**, during the Wave G integration
> pass, by grepping the allowlist / op registry / Rust gates rather than by reading the wave
> reports. That is not a courtesy: §8 already carries a correction note recording that this rule
> was broken once (a wave report was transcribed into a scorecard cell and the cell was wrong).
> Two Wave G report claims did not survive re-derivation and are corrected in place below —
> "unsigned yields zero contributions" (it yields zero *capabilities*; non-formula contributions
> still register, by design) and the sandboxed-extension capability list (three of the ids it
> named were unreachable on that surface).

| Dimension | Was | Now | What changed, and what still isn't there |
|---|---|---|---|
| Code reuse / packaging | ❌ Missing | ✅ Competitive | **New dimension, added by Wave H; the "half" was closed by Wave I.** VBA's answer was "copy the module into every workbook, or reference another .xls and inherit its whole trust". Calcula's is a real package manager: `// @uses <alias> <package>@<pin>` resolves against a **signed** .calp registry through the *existing* trust root (Ed25519 + TOFU, no second signer, no second key store), pins into a workbook lockfile (`.calcula/script-deps.json`) that **mount never re-resolves against the registry**, caches the exact bytes content-addressed and re-hashes them on every read. Each library runs in its **own** worker realm at `declared(library) INTERSECT declared(consumer)`, chained one level narrower for a library's own dependency. **What made it "half" is gone: authority is now caller identity, not a bearer token.** `base.callImport` (`allowlist.ts:83`) takes an ALIAS and nothing else; the host resolves it in `scriptImports` — a map keyed by the CALLING handle's mount id that only the linker writes (`host.ts:1210`) — and then caps the call against the caller's OWN grants at CALL time, per-origin for `net.fetch` (`host.ts:1315`). The realm's entry point moved into a host-only namespace `callExposed` refuses before it even looks up the target (`broker.ts:401`), which closes the same-trust hole `public: false` could not. The 128-bit token is deleted, and so is §7.18-C's residual: an ungranted-but-declared consumer is now JIT-prompted on first use through the library, with the library named in the prompt (`viaLibrary`). Also closed: `kind: "library"` is now a publishable package kind, so the manager is complete on the authoring side too.
| Security model | ✅ Beyond VBA | ✅ Beyond VBA | QuickJS wall-clock deadline + memory cap (`core/script-engine/src/limits.rs:118,173`). **16-capability** vocabulary (`capabilityIds.ts:192-209`, mirrored `core/persistence/src/lib.rs:1343` as a compile-time-sized `[&str; 16]` that is also `include_str!`-diffed against the TypeScript source). Wave G added `file.picker` and `ui.shortcut`; **Wave I added three**: `grid.read` (the host-PUSH capability — see the Add-in row), `distribution.publish` and `distribution.subscribe`. The engine also gained a real recursion ceiling: `MAX_LAMBDA_DEPTH = 256` at the single choke point every lambda call funnels through (`core/engine/src/evaluator.rs:474,6171`), measured against a 1 MiB thread rather than guessed, and the one nested-`Evaluator` site (`eval_3d_ref`) now inherits the depth instead of resetting the budget. **Wave K closed the last wedge:** the evaluator itself now carries a deterministic WORK budget plus a user-reachable cancellation (`core/engine/src/budget.rs`, `app/src-tauri/src/eval_budget.rs`), so a shallow exponential or a million-cell array formula becomes `#LIMIT!` in one cell instead of hanging the application — measured at under the noise floor of the benchmark machine (§8). **What did not hold, and had to be fixed:** a `.calp`'s custom-function library ran with no consent at all (§7.19-A) and a package's module script could be executed by a package-supplied button (§7.19-B). Both are closed and both are now the reason §0 carries a seventh audit instruction.
| Transparency/audit | ✅ Beyond VBA | ✅ Beyond VBA | §6.2 drift closed: `scriptSurfaces.ts` now has a two-directional completeness guard against the allowlist (`scriptSurfaces.test.ts` "no surface understates"/"overstates"). Scheduled jobs are listed and cancellable per workbook. **The named residual is closed:** the interpreter's reach is now DERIVED — `core/script-engine/src/manifest.rs` boots a real QuickJS runtime, enumerates the registered surface, diffs it against `OP_MANIFEST` in both directions, and proves `model.*` throws without a provider; `api/codeInventory.ts` mirrors it and `api/__tests__/interpreterReachDrift.test.ts` reads the Rust source. It is also SHOWN: the "Code in This File" panel no longer prints "Grid-only" for a notebook that can be granted `bi.query`/`bi.sql` on request. **Wave H closed three more holes:** the three script-held states that had no reader (keybindings, private clipboards, the submission watch) are joined and *revocable* in the panel (`codeInventory.ts:1030` `getScriptHeldState`); add-in installs are audited machine-side (`extension_audit.rs`); and **imported libraries are now code units** (`codeInventory.ts`, surface `script-library`) — third-party code that no script's source contains, but whose bytes live in the workbook, was previously invisible to the one panel whose job is "what code is in this file". |
| Event observation | ✅ Competitive+ | ✅ Competitive+ | Unchanged, plus sheet-collection and recalculation-completed events. |
| Event interception | ❌ Missing | ✅ Competitive | `core/lib/lifecycleGuards.ts`: onBeforeSave/onBeforeClose reply with a verdict (3s deadline, default-ALLOW). Missing: onBeforeDoubleClick / onBeforeRightClick exist on no surface. |
| Range/sheet mutation | ❌ Weakest | ✅ Competitive | Formatting, bulk typed I/O, row/col insert+delete, sheet add/delete/rename/visibility, row height / column width, freeze panes, merge, `api.sortRange`, `api.findAll`/`replaceAll`. **Wave G closed the whole "missing" list:** `api.moveSheet`/`api.copySheet` (`allowlist.ts:158,160`), `api.splitPanes` (`:147`), six `api.autoFilter*` rows (`:186-198`) through the feature-neutral `@api/autoFilterService` seam, and `api.copyRange`/`api.pasteRange` (`:249,251`) over a **script-private** buffer. The OS clipboard is refused, not gated — see §6.6. **Nothing named here is still missing.** |
| Application/environment | ❌ Weakest | ✅ Competitive | `ui.dialog` (alert/confirm/prompt/form); `schedule` replaces `Application.OnTime`. **Wave G closed the rest:** `api.workbookSave`/`SaveAs`/`IsDirty`/`FileName` (`allowlist.ts:274-280`) delegating to the SAME `core/lib/file-api` Ctrl+S calls, so the Before-Save veto, the `.xlsx` loss-report consent and the dirty/title broadcasts are the originals; `cap.shortcutBind/Unbind/List` for OnKey (`:529-544`); `cap.filePrintPdf` (`:492`); `cap.fileExportText`/`ImportText` (`:471,475`); and `api.evaluate`/`evaluateAll` as the WorksheetFunction bridge (`:216`, backed by the new `evaluate_formula_typed` command). **Deliberately absent, not deferred: workbook open/close/new** — Calcula holds one document, so each would replace or discard the workbook the user is looking at, and a picker click means "open this file", not "let this running script read it". Pinned by test. |
| Object automation | ⚠️ Half | ✅ Competitive | `api.createChart/createTable/createPivot/createNamedRange`, matching `delete*`, `api.listObjects`. **Missing: pivot FIELD layout is still read-only from scripts** (`update_pivot_fields` exists backend-side; no broker row, no QuickJS op) — see §2.9. |
| Model automation | ✅ Category lead | ✅ Category lead | Plus `cap.biModelValidate`, `cap.biModelLineage`, `cap.biModelBatch` (one undo step), and the notebook `security_roles` leak closed (`bi/script_provider.rs:198-207` uses the same `sanitize_model_info` as the worker gateway). |
| .calp/writeback automation | ❌ Zero | ✅ Competitive | `distribution.writeback` ships 7 methods (listRegions/getLayer/saveDraft/preview/submit/listSubmissions/review), Rust-enforced with an Ed25519 publisher gate, plus the poll-backed submission-received event. **Wave I closed the missing half: publish / pull / subscribe / refresh are now scriptable**, as TWO capabilities behind ONE Rust gateway (`scripting/distribution_gateway.rs`) — `distribution.publish` (outbound: your name on content other people run) and `distribution.subscribe` (inbound: other people's code in front of you), never one grant, because one consent sentence could then only describe the union. Four bounds make it grantable: **(1)** every `cap.pkg*` row is `tier: "unlocked"` while `calp::pull` forces every pulled object script to Restricted — so a package can never pull further packages or publish itself, structurally, and no prompt can grant it; **(2)** `require_configured_registry` (`:441`) refuses any location the user did not add, dev subscriptions excluded (`:409`); **(3)** `require_publish_identity` (`:486`) uses `load_existing`, never `load_or_create`, so a script can act as a publisher you already are but can never MINT the identity others TOFU-pin; **(4)** the gateway dispatches into the same `calp_*` commands the dialogs call, with a source-level guard that fails if it ever reimplements signature/TOFU/integrity/min_app_version. Eleven verbs are dispatchable and thirteen are refused as recorded decisions (detach, resetSubscription, the override family, devSubscribe/devRefresh, add/removeRegistry, the data-source family, exportPackageHtml).
| Scheduling | ❌ Missing | ✅ Competitive | **The loop closes end to end as of 2026-08-01.** The `schedule` capability is Rust-authoritative (re-checked at registration and at every firing), jobs persist in the .cala against a source hash, local-script grants persist per workbook + script + source hash (§7.16) and are restored at mount BEFORE the mount spec is built (`host.ts:357`), and `grant_script_capability` now accepts `schedule` — it validates through `capability_store::is_grantable` instead of a private list that had drifted (§7.10). Pinned by a cross-language drift guard (`api/__tests__/crossLayerConstantDrift.test.ts` "capability grant mirror"). **Remaining: `has_scheduled_jobs()` warns only in the xlsx save-loss report; no headless runtime, which the consent string now says out loud.** |
| IDE/debugging | ⚠️ Partial | ✅ Competitive | `objectContexts.d.ts` is generated with a lockstep test and the `caps` namespace is visible to IntelliSense. **Wave H closed both blockers.** (a) A **real step debugger**: source-to-source yield points (`worker/debugInstrument.ts`), an in-realm pause machine (`worker/debugRuntime.ts`), host-side sessions (`host.ts:884-978`) and F5/F9/F10/F11 + locals + call stack in both editors. Breakpoints persist in the `.cala` and re-anchor on edits. (b) **TypeScript authoring**: `api/scriptTranspile.ts` compiles at save and the *emitted JavaScript is the stored artifact*, so there is still exactly one text that is hashed, consented, shown and distributed. **Two honest limits, both surfaced in the UI, not hidden:** a breakpoint in a *synchronous* function cannot suspend (no `SharedArrayBuffer`/`Atomics.wait` in this webview, and blocking the worker would kill the port that carries "resume") — it captures a variable snapshot and continues, drawn as a hollow gutter dot; and TypeScript is an authoring mode, not a storage format — annotations do not round-trip (JSDoc types do). |
| Add-in authoring | ❌ Missing | ⚠️ Half | A sandboxed worker extension contributes worksheet functions, ribbon buttons, keyboard shortcuts, cell styling and file importers, each bounded by a manifest-declared CONTRIBUTION ceiling that consent enumerates before the bundle is imported. `mayActivateOnMainThread` still returns true only for `"trusted"` (`extensionTrust.ts:45`) — the sandbox grew, the trust boundary did not. **G0 shipped the on-ramp**: `core/calcula-sign` signs through `calp::signing` (one publisher identity shared with `.calp`), `install_extension` previews publisher/capabilities/contributions before copying anything and pins only on confirmation, and the signature covers the BUNDLE via a signed `codeHash`. **The integration pass then found that the trust decision itself was fail-open in two places and rewrote it** (§7.17): it is now one shared function (`extension_install.rs::decide_extension_trust`) that both the launch-time scan and the installer call, `codeHash` is **mandatory** rather than enforced-when-present, and an unreadable pin store no longer reads as `verified`. **Correction to the G0 report:** an unsigned sidecar yields zero *capabilities*, not zero *contributions* — commands, menus, ribbon and cell styling still register (`ExtensionManager.ts:703-708`, by design: a contribution can only narrow, and its job is disclosure). Worksheet functions are the exception and are genuinely signature-gated, because they additionally need `formula.udf`. **Wave H closed the two residuals** (§7.18): the launch-time scan **no longer pins at all** — first contact now reports the new `notInstalled` status, which is absent from `trust_grants_capabilities`, so a hand-copied add-in loads with an *empty* ceiling and cannot squat the pin for an id it does not own (`extension_install.rs:98,121,227`; `lib.rs:3634`); and installs/removals/pins are now recorded in a machine-scoped append-only trail (`extension_audit.rs`), surfaced in the transparency panel and explicitly labelled as *not* part of the workbook. **Wave I closed the last one that mattered: the `cellStyle` contributor is now GATED, not merely disclosed.** `grid.read` (`capabilityIds.ts:206`) is the vocabulary's first host-PUSH capability — it governs what the host HANDS an add-in, not what the add-in calls, which is why no allowlist row exists for it and why five-list grepping could not have found the hole. It gates BOTH readers: the `cellStyle` contribution (`extensionProtocol.ts:129`, re-checked inside the render-cache resolver at `extensionWorkerHost.ts:1164`, which returns `null` — base styling — rather than a stripped batch that would read as an empty workbook) and the **second, undisclosed** one nobody had counted, an event subscription to `cell-values-changed` / `edit-ended`, which is not a contribution and so never appeared in a sidecar or a consent prompt (`extensionWorkerHost.ts:772`, redacting per DELIVERY so a revoke bites the next event). Without the capability a subscriber still learns WHERE a change happened and gets an explicit `redacted: "grid.read"` marker, so absence can never be misread as "nothing changed". Because the gate is the DECLARED ceiling, which is zeroed for unsigned/tampered sidecars, signature coverage now extends to "may you see the user's data". Missing: panels/task panes/custom cell editors, deferred with reasons. |
---

## 2. Confirmed high-severity parity gaps

Every item below survived adversarial verification (evidence = file:line at review time).
Each now carries its closing status, re-checked against the code on 2026-08-01.

1. ~~**No user-interaction primitive**~~ — **CLOSED.** The `ui.dialog` capability ships
   `cap.dialogAlert/dialogConfirm/dialogPrompt/dialogForm` on the object-script AND extension-worker
   surfaces (`allowlist.ts`, `extensionProtocol.ts`). The dialog is rendered by TRUSTED host code
   from a declarative spec (max 32 fields), so the capability buys attention and input, never pixels.
2. ~~**Zero workbook file lifecycle**~~ — **CLOSED, with one half refused by design.**
   `api.workbookSave` / `workbookSaveAs` / `workbookIsDirty` / `workbookFileName`
   (`allowlist.ts:274-280`, unlocked tier, no capability — this is reach over the document the
   script already lives in). `save()` does **not** re-implement saving: it calls the same
   `core/lib/file-api` `saveFile()` Ctrl+S calls, so the Before-Save veto, the `BEFORE_SAVE`/
   `AFTER_SAVE` broadcasts, the window title and the `.xlsx` lossy-save consent are the originals.
   Two host-side guards: one save per script per 5s, and a save is **refused while a Before-Save
   verdict is being collected** (`host.ts:248-264`) — without that, an `onBeforeSave` handler
   calling `save()` re-enters `checkLifecycleGuards` forever.

   **`open` / `close` / `new` are REFUSED, not deferred.** Calcula holds one document, so each
   would replace or discard the workbook the user is looking at (`fileOpen()` does not even prompt
   on unsaved changes before reloading the window). "Open" is the worse one: a picker click means
   *"open this file"* to the user, not *"let this running script read this file"*, so it would not
   be honest consent for what followed. The rule shipped is: **a script may PERSIST the document it
   lives in; it may never replace or discard it.** The legitimate need behind `open` is
   `cap.fileImportText`, whose consent text says exactly what happens.
3. ~~**No persistent formatting from user scripts**~~ — **CLOSED.** `sheet.setRangeFormat` /
   `sheet.clearRangeFormat` at restricted tier (own sheet, cell-count clamped) and
   `api.setRangeFormat` / `api.clearRangeFormat` at unlocked tier. `applyNamedStyle` is no longer a
   dropped DeferredAction — see §3.
4. **No structural mutation of sheets** — **MOSTLY CLOSED.** Shipped WITH ARGUMENTS (not
   selection-ambient): `api.insertRows/insertColumns/deleteRows/deleteColumns`, `api.addSheet`,
   `api.deleteSheet`, `api.renameSheet`, `api.setActiveSheet`, `api.setSheetVisibility`,
   `api.setRowHeight`, `api.setColumnWidth`, `api.freezePanes`, `api.mergeCells`/`unmergeCells`.
   **Move sheet, copy sheet and split panes closed in Wave G** (`allowlist.ts:147,158,160`).
   `api.moveSheet` checks the live sheet list first because `move_sheet` **clamps** an out-of-range
   index silently, which would leave a script believing a sheet moved where it did not;
   `api.copySheet` resolves the new sheet by **diffing the sheet list before/after** rather than by
   arithmetic on "inserted after its source"; `api.splitPanes` goes through `@api/grid.splitWindow`
   (the orchestrator that also emits `SPLIT_CHANGED`) rather than `set_split_window`, which would
   persist a split nothing on screen honoured.
5. ~~**Display-strings-only data model**~~ — **CLOSED.** `sheet.getCellData` / `api.getCellData` read
   one cell "with its type and formula"; `getRangeValues` returns values, types and formulas for a
   block. A read-then-write round-trip no longer destroys formulas.
6. ~~**No Sort, AutoFilter, or Find/Replace from script**~~ — **CLOSED.** `api.sortRange`,
   `api.findAll`, `api.replaceAll`, and six `api.autoFilter*` rows (`allowlist.ts:186-198`,
   unlocked, no capability — filtering decides which rows are *shown* and changes no value).

   The routing decision is the substance: the backend commands were already in `@api/backend.ts`,
   so the broker *could* have called them directly — and that would have been the bug. The
   AutoFilter extension caches the filter's range and sends column indexes **relative to that
   cached `start_col`**, and its store is the only thing that pushes the hidden-row set into Core
   and re-syncs the chevron overlay. So the work goes through a new feature-neutral seam,
   `@api/autoFilterService.ts` (IoC, same shape as `printService.ts`); with the extension disabled
   the rows **refuse loudly** rather than filtering somewhere the user cannot see. Table ownership
   stays Rust-derived — nothing on this path reads, writes or infers `Table.autoFilterId`.
7. ~~**Per-cell RPC bulk I/O**~~ — **CLOSED.** `sheet.getRangeValues`/`setRangeValues` and
   `api.getRangeValues` move a whole rectangle in one RPC under a `maxCells` limit;
   `api.updateCellsBatch` covers 100k-cell writes; `api.beginBatch/commitBatch/cancelBatch` make a
   multi-call sequence one undo step.
8. ~~**No object create/enumerate/delete**~~ — **CLOSED.** `api.createChart`, `api.createTable`,
   `api.createPivot`, `api.createNamedRange`, the matching `api.delete*`, and `api.listObjects`
   (bounded by `MAX_OBJECT_LIST`).
9. ~~**Pivot field layout is read-only**~~ — **CLOSED.** Re-verified 2026-08-01 (twice — see the
   §8 correction notes): `pivot.addField` / `moveField` / `removeField` / `setAggregation` /
   `setLayout` ship end to end — shim `contextShims.ts:992`, host executor `host.ts:2661`, validator
   `validators.ts:786`, typings `objectContexts.d.ts:2917`, using the shared Pivot Layout DSL
   vocabulary. **Why two audits called this missing:** pivot layout dispatches as an ASPECT of
   `object.setState` (like `chart.updateSpec` and `slicer.setSelectedItems`), so it correctly has no
   allowlist row of its own. Grepping the allowlist for "pivot" finds nothing and the feature is
   fully reachable. Aspect-dispatched reach must be audited at `executeSetState`, not in ALLOWLIST.
10. ~~**No cancellable Before\* lifecycle**~~ — **CLOSED.** `core/lib/lifecycleGuards.ts` is the choke
    point; save and close await a verdict (3s deadline, default-ALLOW, attributed cancellation
    toast). Not extended to double-click/right-click, which exist as hooks on no surface.
11. ~~**No OnTime / persistent scheduler**~~ — **CLOSED (fully, 2026-08-01).** The `schedule`
    capability persists jobs in the workbook and re-checks the grant at every firing; a local
    script's "Always allow" grant persists per workbook + script + source hash and is restored at
    mount (§7.16); and `grant_script_capability` accepts `schedule` again now that it validates
    through the store's own vocabulary rather than a private copy (§7.10). The consent string was
    corrected in the same pass: it used to promise "saved in this workbook, so it resumes next time
    you open it" *before* the user had chosen between Once and Always, which was false for Once.
    It now says the job is saved and that it keeps running after a restart only if the answer is
    "Always" (`api/scriptHost/capabilities.ts` `CAP_DESCRIPTION.schedule`).
12. ~~**No keyboard triggers (OnKey)**~~ — **CLOSED, deliberately narrow.** `cap.shortcutBind` /
    `Unbind` / `List` behind a consented `ui.shortcut` capability (`allowlist.ts:529-544`). A script
    binds **one** combination to a method it already published with `context.expose(...)`, and the
    keystroke calls it through `hostCallExposed` — the same door a scheduled job uses — so a key
    can never reach anything an ordinary call could not.

    It does **not** install a key listener: the app's single keydown listener
    (`api/keybindings.ts`) stays the only one. The five rules that make it safe live there, not at
    the call site: (1) the shape is an **allowlist**, `Ctrl+Shift+<letter>` only — a blocklist of
    "keys the app needs" cannot be complete, because the grid owns Escape/Tab/arrows/F-keys and
    *every unmodified printable character*, none of which are in the keybinding registry, and
    because **Ctrl+Alt is AltGr on European layouts** (on sv-SE, `Ctrl+Alt+2` types `@`);
    (2) 14 `Ctrl+Shift` letters are reserved **by name**, independently of the registry, so a user
    who remapped one has not thereby offered it to a script; (3) an already-bound combination is
    refused, never overridden, and the dispatcher lets a **non-script binding win any later tie**
    (`keybindings.ts:962`) rather than leaving it to registration order; (4) bindings are never
    persisted, never user-remappable, and swept at unmount; (5) the handler receives `{combo}` and
    nothing else — no DOM event, no key, no target — so there is no key stream to subscribe to, and
    `context` is host-forced to `not-editing` so it cannot fire while somebody is typing.

    Sandboxed extensions are deliberately **absent** from `EXTENSION_BROKER_METHODS` for this
    family: their keyboard path is the declarative `keybinding` contribution, held to the same
    `scriptComboRefusal` rule (`extensionWorkerHost.ts:846`). One surface, one policy.
13. ~~**General file export/import excluded with NO sanctioned alternative**~~ — **CLOSED.**
    `cap.fileExportText` / `cap.fileImportText` behind the new `file.picker` capability
    (`allowlist.ts:471-478`), reachable from object scripts *and* sandboxed extensions.

    The construction is the opposite of `FileSystemObject`: the script hands over a bare **file
    name** and **content**, the host opens a native picker, the **human** chooses the file, and the
    host performs the already-privileged I/O. **No path string travels in either direction** —
    `fileName()`, `saveAs()` and `exportText()` return only the chosen *name*, because a path is
    useless to a sandboxed caller and `C:\Users\<real name>\Consulting\ClientX` handed to a script
    that also holds `net.fetch` is an exfiltration the fetch consent never covered. The suggested
    name is validated **verbatim, before any trim** against an explicit character array rather than
    a regex class (`validators.ts:1609-1651`) — `\` and `/` inside a class are exactly the two
    characters an escaping slip silently drops. 8M-char cap both ways; an oversized import is
    **refused, never truncated**, because a half-read CSV is corrupt data that looks like good data.
    The capability is named `file.picker`, not `file.access`, because the id has to name the
    mechanism — the mechanism *is* the safety story.
14. ~~**Macro recorder regressed to dead plumbing.**~~ **CLOSED 2026-08-03** (first claimed closed
    2026-07-31; that claim was wrong — see below) — rebuilt as the `MacroRecorder` extension with
    bridge-level capture, CommandRegistry capture, "save as button script", auto-save into a
    workbook module and a Developer ▸ Macros… library. The orphaned `setCellRecorderHook` is gone,
    replaced by `setGridRecorderHook` with a real caller.

    **The 2026-07-31 closure was premature, and the way it failed is the whole lesson of this
    document.** The rebuild shipped with 116 passing unit tests and was marked SHIPPED. The first
    time a human ran it, four bugs appeared in the first five minutes — none of them reachable by
    the tests that existed, because every one of those tests exercised `generateMacroSource`, a
    PURE function, and all four bugs were in the wiring around it. See roadmap item 1 in §7 for the
    corrected scope and §8's eighth correction for the testing-strategy conclusion.

    **The first re-closure was premature too.** On the SECOND human run the same user reported the
    same sentence — *"When I click 'Run' in 'Macros' menu nothing happens. Also nothing happens when
    I click the button that I created along with it."* Of the three entry points (notebook, Run,
    button) only the notebook had ever worked. **Run** was `disabled` but inline-styled to look
    enabled, guarding a stored module that declared a function and ended in a *comment* instead of
    calling it — in a runtime (`run_script`, globals `Calcula.*`) that has no `api` binding anyway.
    **The button** ran perfectly and was invisible: `api.setCellValue` / `api.updateCellsBatch` were
    the only cell-writing broker handlers that never dispatched `grid:refresh`, the sole event that
    makes the canvas re-fetch. Both are now fixed and share **one** execution path
    (`runObjectScriptOnce`, an `@api` primitive that mounts the source in a real worker realm and
    awaits `setup`), and the closure is backed by an e2e spec that **ran against the live app** and
    asserts the cleared values come back from Run *and* from a real canvas click on the button
    (`app/e2e/tests/macro-recorder-journey.spec.ts`). See §8's **ninth** correction.

### UDF-specific confirmed gaps (Custom Functions)

- ~~**Paste/fill/multi-cell edits never resolve UDFs**~~ — **CLOSED.** `udf_results` is threaded
  through the batch bridge (`commands/data.rs:791,857,2162,2258`), so pasted UDF formulas resolve.
- ~~**No volatility control**~~ — **CLOSED.** The library schema carries a per-function `volatile`
  flag (`customFunctions.ts:33,167`).
- **Values only, never a Range object** — **STILL MISSING.** No address/sheet/format metadata
  reaches a UDF body.
- ~~**No spilled/dynamic-array returns**~~ — **CLOSED.** `UdfValue::Array` spills like a native
  dynamic array (flat array down a column, array-of-arrays as rows × cols); the apply paths run the
  spill machinery on the raw result (`scripting/udf.rs:92-111`).
- ~~**Cannot return specific error values**~~ — **CLOSED.** `cellError("#N/A")` is the documented
  return form (`customFunctions.ts:27`).

---

## 3. Dead / hollow plumbing inventory ("answers wrong is worse than absent")

APIs that exist and silently do nothing — worse than absent because they mask the gap.
Status re-verified 2026-08-01.

| API | Problem | Status |
|---|---|---|
| 12 of 15 `DeferredAction` variants | Queued, returned, and dropped | **WIRED.** All 19 variants now have a dispatcher arm in `api/workbookScripts.ts` (21 `case` labels incl. the bookmark family) |
| `Calcula.bookmarks` (run_script) | No dispatcher for `script:bookmark-mutations` | **WIRED.** `addCellBookmark`/`removeCellBookmark`/`createViewBookmark`/`deleteViewBookmark`/`activateViewBookmark` are dispatched |
| QuickJS extended getters | zoom/viewMode/referenceStyle/gridlines/isDirty/sheetVisibility initialized to constants | **WIRED.** `build_host_state` + `apply_view_state` feed real state per cell run (`scripting/notebook_executor.rs:44-76`) |
| `get/setWorkbookProperty` | Read an always-empty clone; setter had no write-back | **WIRED.** Backed by `AppState.workbook_properties` with `get_workbook_properties`/`set_workbook_properties` commands |
| `Application.enableEvents` | Write-only flag with no consumer | **DELETED 2026-08-01**, not wired — see the note below the table. |
| Notebook AppInfo | `AppInfo::default()` — wrong separators for sv-SE | **WIRED.** `build_app_info(&state)` is read per cell run; `AppInfo::default()` survives only as the no-AppHandle unit-test fallback |
| Notebook writes | Bypassed undo AND recalc; formulas stayed literal text | **WIRED.** One undo transaction + active-sheet diff replay (`scripting/notebook_commands.rs:214-218`) |
| Formula strings on non-active sheets (run_script/MCP) | Land as literal text | **STILL OPEN** (acknowledged RESIDUAL v1) |
| `writebackValidators` | Name-only metadata; no registrant anywhere | **WIRED.** The body is read from the Ed25519 + TOFU-verified manifest and evaluated in the embedded QuickJS realm on the Rust submit path, behind per-package consent (`calp_commands.rs:6038,6247`) |
| Monaco typings | `caps` declared as fetch+storage only | **WIRED.** `objectContexts.d.ts` is generated (`app/scripts/scriptTypings/`) with a lockstep test; `caps.dialog`, `caps.schedule`, `caps.writeback`, `caps.fetch`, `caps.storage` are all declared |

**Nothing in this table is hollow any more.** `Application.enableEvents` was **deleted** on
2026-08-01 rather than wired, and the reason matters more than the removal: it could not be made
real, and not for want of plumbing. **This surface has no event delivery to suppress.** QuickJS cell
writes are applied by the host and announced with a bare `grid:refresh`; they never travel the
`cellEvents` bus that object-script `onDataChange` / `range.onChange` handlers listen on. There was
never a storm for the flag to prevent, so "making it real" would have meant inventing the events
first and then suppressing them.

Removed end to end (`core/script-engine` `types.rs`/`lib.rs`/`notebook.rs`/`manifest.rs`/
`ops/application.rs`, `app/src-tauri/src/scripting` `types.rs`/`commands.rs`/
`notebook_commands.rs`, `@api/workbookScripts.ts`, `ScriptNotebook/types.ts` + fixtures,
`_shared/lib/calcula.d.ts`), with a 9-file sweep test asserting the identifier is gone
(`applicationParity.test.ts`). Both removal sites carry a do-not-re-add note naming the real guard:
re-entrancy is already prevented **structurally** by `recordScriptWrite` / `isOwnScriptWrite` in
`host.ts` — a guard that cannot be forgotten, cannot be left switched off by a script that faulted
halfway through, and does not need the author to know it exists. `screenUpdating` stays: it has a
consumer.

Verified 2026-08-01: `enableEvents` / `enable_events` appears nowhere in `app/` or `core/` outside
the test that keeps it gone.

---

## 4. Calcula Models — script coverage answer

**Substantially covered for read + governed definition-mutation; deliberately and correctly
excluded for admin; with a few real holes.** This is the strongest scripting story in the product
and a genuine category lead over Power BI.

### What scripts CAN do

| Capability | Surfaces |
|---|---|
| Structured query (`biQuery`), read-only SQL (`biSql`), CUBE helpers (`cube.*`) | object scripts, distributed extensions, UDF bodies (bi.query only via shipped dialog), notebook (`model.*`), MCP (6 read-only BI tools) |
| Sanitized model info (no roles/sources) | `caps.biModel.info` |
| **Mutation of exactly 17 kinds** — measure, calcColumn, relationship, hierarchy, kpi, calcGroup, perspective, culture, scriptFunction, calculatedTable, tableVariable, context, contextColumn, **writebackColumn**, metadata, dateTable, extensionData | `caps.biModel.upsert/delete` → `script_bi_model` gateway: Rust re-checked grant, 30 mutations/min, package-subscribed models rejected, rides `apply_model_edit` (user-undoable, audited, attributed `source:"script"`) |
| **Read-only diagnostics** — `validate`, `validateMeasure`, `dependencyGraph`, `measureLineage`, `testQuery` | `cap.biModelValidate` / `cap.biModelLineage` (`BI_MODEL_LINEAGE_ACTIONS`, `validators.ts`) |
| **Atomic multi-mutation** — a run of upserts/deletes landing as ONE undo step | `cap.biModelBatch` |
| Script-fed data sources (`script:*` InMemory connectors, 500k rows/feed, server-side secret injection) | `caps.connector.register/remove` + `caps.fetch` secretHeader |
| Model events (thinned payloads) | `BI_MODEL_CHANGED` / `BI_REFRESH_COMPLETED` via `api.onEvent` (unlocked tier only) |

### What NO script can do (host surface is 76 `bi_model_*` commands)

- **RLS**: create/edit/delete security roles, switch active role ("view as") — excluded by design. ✅ Correct posture.
- **Sources/connections/credentials** — excluded by design. ✅ Correct posture.
- **Storage mode / refresh policies / force table refresh** — no scriptable `RefreshAll` analog (auto-refresh side-channel + own connector feeds only).
- **Table/column property edits, table delete/rename** (`update_table/update_column/delete_table`).
- **RLS role authoring and "view as"**, **sources/connections/credentials** — as above, by design.
- **Notebook/one-off mutation**: notebook `model.*` is read-only by contract (a documented
  anti-goal, not a gap); the one-off / `run_script` surface builds its session with
  `model_provider: None`, so even a read throws there.
  **CORRECTED 2026-08-02 — MCP is NOT in that sentence.** This bullet used to read
  "`run_script`/MCP `execute_script` construct with `model_provider: None` so even reads throw
  there", and that was false for MCP for the whole life of the document: `mcp/tools.rs`
  `run_script_with_model` builds `NotebookSession::new(Some(HostModelProvider), …)` with a host-set
  `bi.query` grant, so agent-authored `execute_script` code **can read the BI model**
  (`model.query` / `model.info` / `model.value`; `model.sql` throws, because `bi.sql` is not in the
  grant). §7.13 of this same document already said so, so the document contradicted itself. The
  reach is bounded — `check_mcp_access` at the script tier, `bi.query` only, `model_info`
  sanitized, row-level security still applied — but it is reach, and it is *not* consent-gated,
  because this surface has no prompt. See the seventh correction note in §8, and §7.20.

Three former entries have been REMOVED from this list rather than edited, because they shipped and
the paragraph below already retracted them: writeback-column definition (`writebackColumn` **is** a
gateway kind), model diagnostics (`cap.biModelValidate` / `cap.biModelLineage`), and atomic batch
(`cap.biModelBatch`). Leaving a retraction in a trailing paragraph while the bullets above still
assert the gap is how a reader ends up rebuilding something that exists.

### Governance inconsistency found (fix regardless of roadmap)

~~**Notebook `model.info` returns the FULL `BiModelInfo` including `security_roles` metadata**~~ —
**CLOSED.** `HostModelProvider::model_info` now runs the same `sanitize_model_info` projection the
worker gateway uses, with the reasoning written into the code and a regression test
(`bi/script_provider.rs:193-215`, `sanitized_model_info_drops_security_roles`). The same `bi.query`
grant no longer means "more" in a notebook cell than in an object script.

~~Also: **connector scheduled refresh dies with the session**~~ — **CLOSED.** The connector's
`refreshEverySecs` is now adopted by the persistent scheduler as a `surface: "connector"` job
(`api/scriptConnectors.ts:157`), so the two schedulers agree on one 30s floor instead of two.

**Still open in §4 (re-derived from source 2026-08-02):** storage mode / refresh policies / force
table refresh (no scriptable `RefreshAll`), and table/column property edits + table delete/rename.
That is the whole list. Notebook `model.*` staying read-only is a documented anti-goal, not a gap.
Model diagnostics, atomic batch and `writebackColumn` are all SHIPPED and have been removed from the
bullets above — `BI_MODEL_SCRIPTABLE_KINDS` (`app/src/api/scriptHost/validators.ts`) carries
seventeen kinds including `writebackColumn`, mirroring `GATEWAY_MUTABLE_KINDS` in
`app/src-tauri/src/bi/model_editor.rs`.

---

## 5. .calp distribution + writeback — script coverage answer

> **CLOSING STATUS (rewritten 2026-08-02): "zero" became "all eight".** The
> `distribution.writeback` capability ships the COLLECTION loop on both sides —
> `cap.writebackListRegions`, `getLayer`, `saveDraft`, `preview`, `submit` for contributors, and
> `listSubmissions`, `review` for publishers (gated on Ed25519 possession), Rust-enforced in
> `scripting/writeback_gateway.rs` with grant re-check, rate buckets and audit. **Every one of the
> eight numbered items below is now CLOSED.** Items 1, 2, 3, 7 and 8 closed with that capability;
> item 5 closed in Wave G (see the note below); **items 4 and 6 closed in Wave I.**
>
> **CORRECTION (2026-08-02).** The paragraph this replaces said, under a "re-verified 2026-08-01"
> stamp, that "there is still no publish/pull/subscribe/refresh operation on any script surface and
> no package-identity read". Both halves were false when written:
>
> - **Item 4 — distribution automation SHIPS.** `app/src-tauri/src/scripting/distribution_gateway.rs`
>   implements the scripted publish / pull / subscribe / refresh actions, reached through eleven
>   `cap.pkg*` ALLOWLIST rows (`app/src/api/scriptHost/allowlist.ts`), Rust-gated with grant
>   re-check, rate limiting and server-side audit. It is unlocked-tier only, so a script that
>   *arrived in a package* still cannot drive distribution — which is the correct posture, not an
>   absence.
> - **Item 6 — package identity IS readable.** `context.package` is populated at
>   `app/src/api/scriptHost/host.ts` and surfaced to sandboxed code by
>   `app/src/api/scriptHost/worker/contextShims.ts`, so a script shipped in a `.calp` can ask its
>   own package and version.
>
> This is the recorded process failure #1 in its purest form: the re-verification grepped the
> ALLOWLIST for the words "publish" and "subscribe" and found nothing, because the rows are named
> `cap.pkgPublish` / `cap.pkgSubscribe`, and because the *gateway* — the thing that would have
> answered the question — is Rust and was never opened. See the seventh correction note in §8.
>
> The original numbered text is kept below because it explains WHY each hole mattered. It is
> REVIEW-TIME text: read every item with its closing verdict attached, not as current status.
>
> **Item 5 — the submission-received event — CLOSED, and it is a poll wearing an event, on
> purpose.** A true push does not exist and was not faked: a subscriber submits by *appending to a
> registry on disk from their own machine*, so the publisher's process is not in that path, and the
> registry is an append-only event log Rust folds on read — no change feed, no sequence cursor, no
> per-region "latest" marker an OS file watch could target. What shipped instead is a watcher with
> all three properties that make a poll acceptable, each tested:
>
> 1. **Demand-driven.** `acquireSubmissionWatch()` is refcounted; at zero holders the timer is
>    cleared, which is the default state of every workbook. Three holders exist — a script's
>    `api.onEvent` subscription, a sandboxed extension's, and the Responses pane while open — and
>    each releases on teardown, so an unmounted or faulted script cannot leave a timer running.
> 2. **Bounded.** One pass per 60s, sequential, never overlapping, one IPC per **publisher-owned**
>    region. A region that fails the Ed25519 publisher gate is recorded and never read again this
>    session, so a subscriber-only workbook settles at one region-list call per interval and *zero*
>    inbox reads. Only that permanent refusal disables a region; a transient I/O failure is retried.
> 3. **Disclosed.** `getSubmissionWatchStatus()` reports refcount, interval, watched and skipped
>    regions, last pass time, exact call count and last error.
>
> Three honesty rules hold in the announcement itself: the **first pass primes silently** (and so
> does the first sighting of a new region), because "this submission exists" is not "this submission
> just arrived" and a script starting on a full inbox must not be told the history is new; only
> `state === "submitted"` counts, so a publisher's own approve/reject is never reported back to them
> as an incoming answer; and the payload crossing into a sandbox is thinned to `{regionId, count}` —
> **submitter identity and cell coordinates are both dropped, because in a per-subscriber writeback
> region the cell IS the identity.** The answers stay behind `calp_load_region_submissions`, which
> re-proves publisher-key possession in Rust on every call.
>
> Residual: up to one interval of latency (stated on the authoring surface as "expect a delay of up
> to a minute, not an instant"), and nothing is noticed while Calcula is closed. The
> "`getSubmissionWatchStatus()` has no UI consumer" clause that used to end this paragraph is
> STRUCK (2026-08-02): `api/codeInventory.ts` imports and calls it to report the watcher as held
> state, which is what the transparency panel renders. The disclosure is something the user can
> read.

> **REVIEW-TIME TEXT BELOW — the two paragraphs that followed are struck, not edited.** They read:
> "The broker allowlist, the QuickJS op modules, the 21 MCP tools, the 3 scriptSafe commands, the
> Model Editor CLI verb set, and the 8-capability vocabulary contain **no publish, pull, subscribe,
> submit, draft, review, or registry operation**. Script reach is three indirect paths…" and "The
> vision's flagship workflow — two-way data collection replacing emailed workbooks — is currently
> **less automatable than the VBA workflow it replaces**." Both were true at review time and are
> false now. The allowlist carries `cap.writeback*` (7 rows) and `cap.pkg*` (11 rows); the
> capability vocabulary is no longer eight; `scripting/writeback_gateway.rs` and
> `scripting/distribution_gateway.rs` are the Rust gates behind them. The flagship workflow is now
> *more* automatable than the VBA workflow it replaces, and — unlike VBA — every step of it is
> capability-gated, rate-limited and audited.

The host surface is 70 Tauri commands plus the trusted `@api/distribution` layer. Re-counted
2026-08-02 by `grep -c '^#\[tauri::command\]'` rather than carried forward: `calp_commands.rs` 56
(it was cited as 54 and had already drifted before `calp_get_writeback_rebuild_skips` was added),
`calp_inspector.rs` 8, `calp_registry.rs` 3, `bi::writeback` 3.

The eight items below are the review-time finding. **All eight are closed**; each carries its
verdict inline.

1. ~~**Contributors cannot script the collection loop**~~ — **CLOSED by `distribution.writeback`.**
   `cap.writebackListRegions` / `GetLayer` / `SaveDraft` / `Preview` / `Submit`.
2. ~~**Worse: silent bypass.**~~ — **CLOSED in Wave C, and a SECOND instance of the same bypass
   closed 2026-08-02.** Review-time text: "An unlocked script's `api.setCellValue` into a writeback
   region skips draft capture entirely (the capture lives in a commit guard run only by the
   interactive editor) — no schema check, no validator, grid diverges from the writeback layer
   until reconcile."
   Wave C routed the script write through the same validated draft path a keystroke takes. The
   residual, found by this review's cross-wave pass and fixed on 2026-08-02: the QuickJS apply path
   (`scripting/commands.rs`, `apply_script_modified_grids_core`) installed **non-active** sheets
   wholesale — `app_grids[i] = prepared` — and consulted the writeback index for none of them, so
   `setCellValue(row, col, value, sheetIndex)` aimed at any sheet that was not on screen landed in
   a claimed cell with no draft behind it. Reachable from `run_script`, from the scheduler, and
   from the MCP `execute_script` tool. The guard's own contract comment asserted that "no grid
   write path can land a value in a claimed cell without a validated draft behind it" and did not
   name this path, which is why it survived: **the assertion was maintained by hand, and the hand
   missed a caller.** It now refuses the whole apply pre-mutation, atomically.
3. ~~**Publishers cannot script review**~~ — **CLOSED by `distribution.writeback`.**
   `cap.writebackListSubmissions` / `cap.writebackReview`, still gated on Ed25519 possession
   re-proved in Rust on every call, so the capability buys automation and not authority.
4. ~~**No publish/pull/refresh automation**~~ — **CLOSED in Wave I.** `scripting/distribution_gateway.rs`
   + eleven `cap.pkg*` ALLOWLIST rows give unlocked scripts publish / pull / subscribe / refresh,
   with a Rust grant re-check, rate limiting and server-side audit. Hardened again 2026-08-02: a
   scripted `Pull` now runs under `PinPolicy::RequirePinned`, so automation can *use* a publisher
   this computer already trusts but can never CREATE a trust-on-first-use pin — the pin decision
   stays at a commit point with a human behind it.
5. ~~**No lifecycle events for scripts**~~ — **CLOSED for submission-received** (see the boxed note
   above); `calp:scripts-pulled` remains deliberately excluded from SCRIPT_SUBSCRIBABLE_APP_EVENTS,
   and **review decisions still have no event** — deliberately, since a publisher's own click is
   not news to the publisher.
6. ~~**Distributed scripts get no package-awareness**~~ — **CLOSED in Wave I.** `context.package`
   (`scriptHost/host.ts`, handed across the sandbox boundary by `worker/contextShims.ts`) reports
   the script's own package and version, so a publisher-built collection experience can adapt to
   the package it shipped in.
7. ~~**Writeback validators cannot be distributed as code**~~ — **CLOSED in Wave C** (roadmap item
   11). The validator body travels in the package and runs sandboxed server-side, seeing only the
   row, column and value of each answer it checks.
8. ~~**Writeback columns are not a bi.model gateway kind**~~ — **CLOSED.** `writebackColumn` is one
   of the seventeen kinds in `BI_MODEL_SCRIPTABLE_KINDS` / `GATEWAY_MUTABLE_KINDS` (§4).

Scripts *arriving in* packages are well governed (Ed25519+TOFU, forced-restricted tier,
manifest-derived ceiling, per-source-hash consent, inert module scripts/notebooks) — the inbound
half of the story is done; the outbound/automation half doesn't exist.

---

## 6. Cross-cutting findings (completeness critic)

1. ~~**Add-in authoring is impossible for third parties.**~~ — **LARGELY CLOSED (2026-08-01, slice
   1 shipped).** Trust is still binary and `mayActivateOnMainThread` is unchanged — that was the
   point. What changed is the sandbox: a worker extension now registers **worksheet functions**
   (`ctx.formulas.registerFunction`, host-relayed exactly like `customFunctions.ts`), ribbon
   buttons, keyboard shortcuts, cell styling (via the `renderCache` SWR path) and file-format
   importers, in addition to the commands and menu items it already had. All of it is DECLARATIVE:
   a descriptor crosses, trusted host code renders/registers it — no component, no markup, no
   closure. A VBA convert can now ship the `.xlam` shape; see `docs/examples/addin-tax-tools/`,
   which CI activates against the real sandboxed context.
   **Two things the design did not have and the code needed:** (a) a **contribution ceiling** in the
   sidecar manifest (`contributes: {formulas, commands, menuItems, ribbonButtons, keybindings,
   cellStyles, fileFormats}`) — read WITHOUT importing the bundle, so consent enumerates every
   function an add-in will install before its code runs, and a registration outside it is refused
   loudly (toast + manager row + audit entry); (b) **`EXTENSION_BROKER_METHODS` was never enforced** —
   it existed with a comment claiming the broker rejected anything absent from it while nothing read
   it, leaving `executeExtensionImpl`'s `default:` arm as the only (accidental) barrier between a
   sandboxed extension and restricted-tier object-script rows like `sheet.setCellValue`. Now gated
   in `handleBrokerCall` before capability prompting, with a source-derived test.
   **Hardened at integration (2026-08-01):** the ceiling pins the *id* a contribution registers
   under, not what it renders or claims, and five holes lived in that gap — menu-label
   impersonation, file-format takeover by priority, shortcut hijack, unbounded refusal toasts, and
   an undisclosed whole-grid read behind `cellStyle`. All closed; itemised in roadmap item 15.
   **CLOSED for real (G0, 2026-08-01): the on-ramp exists.** The two blockers above are gone.
   (a) **Signing tool** — `core/calcula-sign`, a workspace binary that holds a publisher keypair,
   stamps `publisherKey` into a sidecar and writes `<base>.manifest.sig`. It owns no crypto: keys,
   signing, verification and the TOFU store are `calp::signing`, the SAME code path and the SAME
   `%LOCALAPPDATA%\Calcula\publisher-key.json` that `.calp` publishing uses — one publisher
   identity, one trust root, no second CA. (b) **Install command** — one Tauri command,
   `install_extension` (`app/src-tauri/src/extension_install.rs`), serving both a preview and the
   install; the trusted Extensions panel gained **Install add-in…**, which shows publisher identity
   (and whether it is first contact or a known key), declared capabilities, and every declared
   contribution by name, all read from the sidecar WITHOUT importing the bundle. The preview pass
   copies nothing and pins nothing; the pin is written only on the confirmed install, and a
   publisher CHANGE requires a second, separately-worded decision.
   **(c) A third gap nobody had named: the signature did not cover the code.** The detached
   signature was over the manifest bytes only, so an attacker with write access to
   `%APPDATA%\com.calcula.app\extensions\` could swap the program file of an already-trusted add-in
   and the app would still report Signed, still honour the ceiling, and still hand the swapped code
   `formula.udf`. `calcula-sign` now writes the bundle's SHA-256 into the manifest as `codeHash`
   before signing, and `verify_extension_manifest` re-checks it on EVERY scan (not only at install),
   collapsing a mismatch to `invalid` — which is the status that zeroes the ceiling. Regression:
   `scan_reports_invalid_when_installed_code_is_swapped_after_trust`.
   **Still open:** task panes / panels / custom cell editors / synchronous grid hooks remain
   deferred with reasons; `codeHash` is enforced-when-present rather than mandatory at scan; and the
   scan still pins TOFU silently for a bundle that bypassed the installer (nothing is *granted* by
   that pin, but it can be squatted). See roadmap item 15 and
   `docs/design/third-party-addin-authoring.md` §6–§7.
2. ~~**Transparency-pillar defect: `scriptSurfaces.ts` understates real reach.**~~ — **CLOSED.** The
   taxonomy now carries `bi.sql` on the object-script row and the UDF library's whole reach on the
   formula-udf row, and — the durable part — the guard is two-directional:
   `scriptSurfaceCapabilitiesAreComplete()` derives the broker-gated set from the ALLOWLIST itself
   and fails on any understatement, with a companion test for overstatement
   (`scriptSurfaces.ts:377-390`, `__tests__/scriptSurfaces.test.ts`). A new `cap.*` row in the
   allowlist now fails the build until the taxonomy is updated.
3. **Consent fatigue / no Trusted-Documents analog.** — **PARTIALLY CLOSED.** Per-workbook
   persistent trust exists (`api/scriptSecurity.ts`, localStorage keyed by workbook identity + source
   hashes, so changed code re-prompts), notebook capability grants are persisted and re-mirrored into
   the Rust store on open (`rehydrateNotebookCapabilityGrants`), and Settings ▸ Script Security is a
   real page with a level picker, a per-workbook trust list and revoke.
   **CLOSED 2026-08-01 — object-script JIT grants persist too.** `maybeRequestCapabilityGrant` used
   to record an "always" decision into the live grant set and nothing else (`host.ts` carried a
   "persistence lands in Phase 4.2" note). It now calls `persistAlwaysGrant`, which writes a
   source-hash-bound `ScriptCapabilityGrant` into the same per-workbook record, and `mountWorker`
   awaits `restoreAndSyncGrants` to re-establish it — through the ordinary grant commands, so Rust
   still validates and still enforces. Editing the script withdraws the grant and the next prompt
   opens with a diff. See §7.16 for the full property list; the backend line that used to block
   `schedule` specifically is fixed (§7.10).
   **The JIT dialog's own text was wrong in two places and was rewritten
   (`ScriptableObjects/components/CapabilityRequestDialog.tsx`).** It claimed the script "cannot
   read or write your cells or files unless you separately grant it" — false for an object script,
   whose `sheet.getCellValue` / `sheet.setCellValue` rows carry no capability at all
   (`scriptHost/allowlist.ts:71-72`) — and it offered "Allow always … remember this for this
   script" without saying for how long, where, or under what conditions it lapses. It now states
   the real scope: this workbook, this computer, never inside the file, withdrawn automatically if
   the code changes, revocable in Settings, and session-only for a workbook that has never been
   saved (which is what an unsaved workbook actually gets — `persistScriptCapabilityGrant` returns
   false with no path to bind to).
4. ~~**QuickJS runtime has no timeout/interrupt/memory cap**~~ — **CLOSED.**
   `core/script-engine/src/limits.rs` arms a re-armable wall-clock deadline through QuickJS's
   interrupt handler (`:118,136`) and sets a runtime memory limit (`:173`), with an
   `allocation_bomb_hits_the_memory_limit` test. This was the stated hard prerequisite for the
   scheduler and it landed before it.
5. **No cross-workbook scripting and no personal macro library** (PERSONAL.XLSB analog) — **STILL
   MISSING.** All script surfaces are workbook-resident; %APPDATA% templates are scaffolds, not
   runnable macros. Deliberately untouched by this program: a personal macro library is a
   cross-document ambient-code store, which is a new consent question, not a wiring job.
6. ~~**Ungraded-but-missing VBA areas**~~ — **CLOSED, with two deliberate refusals.**
   `api.freezePanes` ships; document properties are wired (§3); the reference-style DeferredAction
   is dispatched. Wave G added the rest:

   - **Split windows** — `api.splitPanes` (`allowlist.ts:147`). *Arrange* windows remains absent
     (Calcula has one document window).
   - **WorksheetFunction bridge** — `api.evaluate` / `api.evaluateAll` (`:216`, unlocked, class
     `read`, **no capability**: an expression reaches exactly what `api.getRangeValues` reaches, so a
     capability here would be theatre). Backed by a new `evaluate_formula_typed` command over the
     live grid returning the engine's own typing. `evaluateScoped` was the wrong door — it binds
     *names*, not cells, so `SUM(A1:A10)` answered `#REF!`. Two absences are **enforced in the
     command, not promised**: the UDF hook is not installed (a UDF body is another script's JS;
     resolving one from inside a lock-held evaluation re-enters that realm through a door nobody
     consented to) and pivot/control sources are not wired. Both are stated on the authoring
     surface, because a bridge that quietly answers differently from the same formula in a cell is
     worse than one that says where it stops.
   - **R1C1 authoring** — `api.getCellFormula`/`setCellFormula` (unlocked) and the `sheet.*` pair
     (restricted, clamped), over the existing `convert_formula_style`. **The style is the caller's
     argument, never the user's View setting** — a script's meaning must not change because somebody
     ticked View ▸ R1C1 — and the conversion base is the target cell's own coordinates.
   - **Clipboard** — `api.copyRange` / `api.pasteRange` over a **script-private, host-side buffer**,
     swept at unmount *and* at workbook reset (it holds a copy of the user's data, so a remounted
     successor must not inherit one it never filled).

   **The two refusals, both structural rather than gated:**

   - **Reading the OS clipboard is refused.** What a person last copied is arbitrary — a password
     out of a manager, a bank number, a line from a chat window — has nothing to do with this
     workbook, cannot be scoped, cannot be honestly consented to, and cannot be audited after the
     fact. **Writing it is refused too**, the half usually forgotten: it destroys what the user has
     in hand and is a channel *out* of Calcula into every other application, an exfiltration no
     "this script may read your cells" consent ever covered. Verified 2026-08-01: no
     `navigator.clipboard`, `plugin-clipboard-manager`, `readText`/`writeText` or
     `getInternalClipboard` anywhere on the script path.
   - **Sending to a real printer is refused.** `cap.filePrintPdf` renders a PDF through the same
     `generatePdf(getPrintData())` the File menu uses and opens the same picker; but `executePrint()`
     opens a pop-up, writes HTML into it and calls `window.print()` on a 500ms timer — it needs a
     window, can be silently blocked, and reports nothing back. A call that may do nothing and can
     never say so is exactly the kind of API this program has twice shipped by accident, so the
     refusal is recorded in `app/src/api/printService.ts` with the evidence rather than faked.

   `cap.filePrintPdf` reuses `file.picker` and is strictly **narrower** than `cap.fileExportText`:
   the script supplies no bytes at all, only a bare `.pdf` name. The document is rendered **before**
   the picker opens, so "Print extension disabled" is a clear refusal rather than a dialog that ends
   in an empty file.

   Also absent on evidence rather than by omission: **`mode: "formats"`** for paste.
   `set_cell_style` acts only `if let Some(cell) = grid.get_cell(...)` and there is no batched style
   write, so a formats-only paste would report success while doing nothing for every blank
   destination cell. A test reads that Rust source so the absence stays justified rather than
   merely remembered.

---

## 7. Ranked improvement roadmap

Ordered by leverage; effort S/M/L. **Every item carries a status re-verified against the code on
2026-08-02.** Summary: **23 SHIPPED, 2 PARTIAL, 0 DEFERRED** over 25 items.

**This table was regenerated on 2026-08-02, not patched.** The previous version summarised "11
SHIPPED, 4 PARTIAL, 2 DEFERRED" while listing seventeen rows — it had been left behind by items
18-25 entirely, four of its statuses (5, 6, 12, 14) contradicted the item bodies below it, and row
15 read `SLICE 1 SHIPPED`, a fourth status that exists nowhere else in this document and therefore
sorts and counts as nothing. Only three statuses are legal here: **SHIPPED**, **PARTIAL**,
**DEFERRED**. A row is PARTIAL only if its own body names what is still missing.

| # | Item | Status |
|---|---|---|
| 1 | Macro recorder | SHIPPED — all THREE entry points (notebook / Run / button) now verified; Run and button were still dead after the first human round and were fixed in the second, proven by a live-app e2e spec (§8 ninth correction) |
| 2 | Bulk typed range I/O + undo everywhere | SHIPPED |
| 3 | Formatting + structural ops | SHIPPED |
| 4 | Writeback automation capability | SHIPPED |
| 5 | Models finishing loop | SHIPPED |
| 6 | Distribution lifecycle events + package-aware scripts | SHIPPED |
| 7 | `ui.dialog` capability | SHIPPED |
| 8 | Cancellable Before\* hooks + bus events | SHIPPED |
| 9 | QuickJS interrupt/timeout/memory budget | SHIPPED |
| 10 | Host-side persistent scheduler | PARTIAL — no xlsx-save warning that saving disarms every job |
| 11 | Sandboxed distributable writeback validators | SHIPPED |
| 12 | d.ts codegen + TypeScript compile | SHIPPED |
| 13 | MCP as automation co-author | SHIPPED |
| 14 | Script package manager | SHIPPED |
| 15 | Add-in authoring answer | PARTIAL — slice 1 only; export/panels/dev-mode deferred with reasons |
| 16 | Trusted-workbook consent persistence + Settings UI | SHIPPED |
| 17 | UDF fixes | SHIPPED |
| 18 | Wave G — parity tail + add-in on-ramp | SHIPPED |
| 19 | Adversarial integration pass (§7.17) | SHIPPED |
| 20 | Real step-through debugging | SHIPPED |
| 21 | TypeScript authoring | SHIPPED |
| 22 | Script package manager implementation (§7.14) | SHIPPED |
| 23 | Notebook Phase 2+3 (§7.5) | SHIPPED |
| 24 | Security residuals | SHIPPED |
| 25 | Closing integration pass (§7.18) | SHIPPED |

Row 10 stays PARTIAL although §2.11 records the same subject as **CLOSED (fully)**. That is not a
contradiction and is deliberately not reconciled away: §2 grades the *VBA parity gap* ("no OnTime /
persistent scheduler"), which is closed; this row grades the *roadmap item*, which retains the small
residual named in its body. Where the two ever disagree about a fact rather than a scope, §2 and
this table are both wrong until someone re-derives from code.

1. ~~**Resurrect the macro recorder**~~ **SHIPPED (codegen 2026-07-31; the feature around it
   2026-08-03; single-source LINK model + run-at-cursor + edit-in-editor 2026-08-04 — see the tenth
   entry in §8)** — as its own extension, `app/extensions/MacroRecorder/`, registered in
   `extensions/manifest.ts` after ScriptNotebook (whose Developer menu it contributes to). A recorded
   macro now lives ONCE in the module store; a button carries a `macroRef` id and LINKS to it (runs the
   current macro via `@api/macroRunService`), never a copied body — so editing the macro is reflected
   on every linking button with no re-save. Deleting a linked macro warns by button anchor; an orphaned
   click and a subscriber missing the macro both fail LOUD (`notFound` toast), never silent.

   > **Read this before trusting the bullets below.** On 2026-07-31 this item was marked SHIPPED on
   > the strength of 116 passing unit tests. On **2026-08-03 a human used it for the first time and
   > it failed in four separate ways within one session** — and *not one* of the four was a codegen
   > defect. The generated source was correct: correctly batched, undo-wrapped, with a working
   > `setup(button)` wrapper. Every failure was in the wiring that surrounds the generator:
   >
   > 1. **"Save as Button Script" created no button.** It wrote `set_control_metadata` with
   >    `properties.label`; the Controls extension renders a caption from `text`. It also skipped
   >    the geometry, the `fill`/`color`/`borderColor`/`fontSize`/`embedded`/`pinToGrid`/`onSelect`/
   >    `tooltip` defaults, the floating-control store registration and the overlay region sync. The
   >    backend accepted the write and returned success. Nothing was drawn. **Fixed** by a
   >    feature-neutral IoC seam, `@api/buttonControlService.ts`
   >    (`ButtonControlProvider` = `createButton` / `removeButton`), which the **Controls** extension
   >    registers into at activation and which the recorder calls — the same shape as
   >    `autoFilterService.ts` and `printService.ts`. `Controls.insertButton()`'s body became one
   >    `createButtonControlAt()` used by BOTH the ribbon and the seam, so there is one recipe and it
   >    cannot drift. The caller takes `instanceId` **from the returned handle** rather than
   >    re-deriving `control-<sheet>-<row>-<col>`, which is how a button and its script end up on
   >    different keys.
   > 2. **A debugged script said "Running" forever.** There was no hang. `DebugSessionState.status`
   >    had no terminal state, and it was set to `"running"` on `debugReady` — a message that means
   >    *instrumentation succeeded*, not *code is executing*. An event-driven script (everything the
   >    recorder emits) finishes `setup` and then sits idle, so the badge never changed again. **The
   >    UI was lying, and the fix was to make it tell the truth**: the realm now reports execution
   >    start/end (`debugActivity`), and the statuses are `starting · running · paused · waiting ·
   >    finished · failed · detached`. A second, real defect was found in the same area:
   >    `isPromotableCallbackArg` required the literal receiver `context`, so in
   >    `function setup(button) { button.onClick(...) }` — the exact shape the recorder emits — **no**
   >    handler was promotable and every breakpoint inside a recorded macro silently degraded to a
   >    snapshot-only dot. Promotion now follows `setup`'s actual first parameter. And because an
   >    idle event-driven script has no entry point a debugger can "run", each trigger now has a
   >    **Fire** button (`hostDebugFireTrigger`) that goes out through the same `{t:"event"}` door
   >    the production forwarder uses.
   > 3. **"Stop Recording" stayed in the menu after recording stopped.** `IMenuAPI` had no way to
   >    change an item: `registerMenuItem` is idempotent-by-merge and only folds in children, so
   >    re-registering with a new label was silently ignored. **Fixed** by adding the missing
   >    capability rather than working around it — `MenuRegistry.updateMenuItem` (patches the dynamic
   >    record *and* the live item, so it survives a menu re-registration), exposed as
   >    `IMenuAPI.updateItem`/`unregisterItem`. The recorder now registers **one** item whose label
   >    is derived from `subscribeToRecorder`, so every end path resets it; both items are
   >    unregistered on deactivate (they leaked before), and a workbook swap ends the session.
   > 4. **Choosing "Close" destroyed the recording.** The review dialog was a save prompt, so the
   >    only way to keep a recording was to bind it to a button; anything else and the work was gone.
   >    Excel never asks — a recorded macro always lands in a module. **Fixed:** `finishRecording()`
   >    now reserves a name, generates the source with that final name, and writes it to a workbook
   >    module script **before the dialog opens** (`lib/macroLibrary.ts`), marking the file modified
   >    so it cannot vanish with a "clean" close. The dialog says where it went; Close is safe. The
   >    listing surface did not exist, so it was built: **Developer ▸ Macros…**
   >    (`components/MacroLibraryDialog.tsx`) lists every module with its runtime and offers
   >    Run / Add Button / Save / Delete. Rust's `delete_script` was restored for it — it had been
   >    deleted as caller-less, and now has a real caller.
   >
   > **The lesson is in §8's eighth correction, and it is the one worth carrying forward:** 116
   > green tests on a pure function were evidence about the pure function and about nothing else.
   - **Capture moved to the IPC bridge, not the command layer.** The old `setCellRecorderHook`
     is replaced by `setGridRecorderHook` / `RecordedGridEvent` in `core/lib/tauri-api.ts`
     (re-exported from `@api/lib`): 20 structural event kinds — cell writes (with the batch
     path's `invariant` flag), `applyFormatting`, border presets, clears, fills, row/column
     insert+delete, merge/unmerge, row height / column width, freeze panes, `replaceAll`, and
     sheet activate/add/delete/rename. The UI commands act on the ambient selection; these
     arrive with explicit coordinates, which is what a replayable macro needs.
   - **Slice 2 done.** `CommandRegistry.execute` reports `before/after/failed/unhandled` through
     `setCommandRecorderHook` (`@api/commands`). Commands whose effects reach the bridge (every
     `core.*`) are not recorded — the bridge event is strictly better — and any OTHER command is
     recorded while its internal bridge writes are suppressed, so nothing replays twice.
     Ctrl+Z during a recording pops the last recorded action instead of being recorded.
   - **Two explicit codegen targets**, never implied: `objectScript` (async `context.api`
     UnlockedAPI — values, formatting, structure, sheets, merge, freeze, find/replace,
     `executeCommand`) and `notebook` (synchronous QuickJS `Calcula.*` — values, sheet switches,
     `fillDown`/`fillRight`). Consecutive cell writes merge into ONE `updateCellsBatch`
     (chunked) or one array + loop; anything a target cannot express is emitted as a
     `// NOT REPLAYABLE` comment AND reported in the result's `unsupported` list and the header.
     Invariant decimals are re-spelled with the recording locale's separator.
   - **Where a recording LIVES (2026-08-03).** Stopping a recording writes it to a workbook module
     script immediately — `lib/macroLibrary.ts`, ids `macro-<slug>` (never the reserved
     `__calcula_` prefix, which Rust hides from `list_scripts` and refuses to delete), with a
     `runtime=objectScript|notebook` marker in the module `description` so the library knows which
     interpreter the source was written for. `@api/workbookScripts` gained
     `saveWorkbookScript`/`deleteWorkbookScript`, both of which call `markFileModified()`:
     `save_script` does not dirty the document, so without it an auto-saved macro would disappear
     with a "clean" workbook close. The review dialog is no longer a save prompt.
   - **The loop is closed:** "Save as Button Script" creates a button control at a chosen cell
     **through the `@api/buttonControlService` seam Controls owns**, saves an unlocked
     `objectType: "button"` script bound to the `instanceId` the seam returns, and mounts it — one
     click replays the macro. `onSelect` is deliberately left empty on that path: a run-mode click
     fires BOTH the inline `onSelect` (QuickJS, `Calcula.*`) and `button:clicked` (forwarded to the
     mounted object script), and a recorded object-script macro can only run in the second, so
     setting both would run it twice. Notebook-target macros take the opposite route
     (`saveAsInlineButton`, `onSelect` only). "Add as Notebook Cell" appends a cell via an
     `@api/lib` event channel (siblings never import each other). A status-bar indicator with
     Pause/Stop/Discard makes a running recording unmissable; Ctrl+Shift+R toggles.
   - Tests: the codegen tests (`extensions/MacroRecorder/__tests__/`) pin the pure generator across
     batching, sheet switches, quoting/escaping, locale-sensitive values, command capture, wrappers
     and JS-syntax validity. **They are not evidence that the feature works** — see the box above.
     The 2026-08-03 pass added the tests that could have caught the four field bugs: the seam's
     register/require/reset contract, a `seamWiring` test asserting Controls actually registers a
     provider and that `createButtonControlAt` is the single factory, the menu-label state machine,
     the auto-save-before-dialog ordering, and the macro library dialog.
   - **ENTRY-POINT STATUS (2026-08-03, second human run).** A macro has three ways to execute and
     for two rounds only one of them was ever verified. Each is now listed separately, which is the
     rule §8's ninth correction adds:

     | Entry point | Status | Verified by |
     |---|---|---|
     | Add as Notebook Cell | WORKS | unit + human (round 1) |
     | Developer ▸ Macros… ▸ **Run** | **FIXED round 2** — was a `disabled` button styled to look enabled, over a module that ended in a comment instead of a call | `macro-recorder-journey.spec.ts` step 5, **run against the live app** |
     | **Clicking the created button** | **FIXED round 2** — ran correctly but never dispatched `grid:refresh`, so the canvas kept drawing stale values | same spec, step 7, **run against the live app** |

     Both fixed paths now execute through **one** primitive, `runObjectScriptOnce`
     (`app/src/api/objectScriptRunner.ts`): mount the source in a real worker realm, await
     `setup(context)`, unmount. The mount *is* the run, so Script Security, the unlocked tier, the
     broker allowlist and the audit ring all apply unchanged, and Run cannot diverge from the
     button. The stored module is a single artifact whose `setup` branches on whether the context
     has `onClick`. All ten cell-writing broker methods end in a grid refresh, coalesced per frame
     (`scriptWriteRefresh.test.ts` is a source-level drift guard so a new cell writer without a
     refresh fails there rather than in a bug report).
   - **Known gaps:** fills cannot be expressed on the objectScript target (no fill in
     UnlockedAPI) and formatting/structure cannot be expressed on the notebook target — both are
     reported rather than silently dropped. ~~`sortRange` lives in `api/backend.ts`, outside the
     bridge module, so a sort is not yet captured structurally.~~ **Closed:** `sortRange` and
     `removeDuplicates` now record through `recordGridEvent` from `api/backend.ts`, gated on
     success (`sort_range` reports a refused sort as `success: false` rather than rejecting, so
     unconditional recording would bake a no-op into the macro) and with the field array copied so
     the Sorting dialog's reused criteria object cannot retroactively rewrite a recorded action.
     `removeDuplicates` has no script API on either runtime, so it is REPORTED as unsupported
     rather than emitted.
2. **Bulk typed range I/O + undo everywhere** — **SHIPPED.** `sheet.getRangeValues` /
   `sheet.setRangeValues` and `api.getRangeValues` move a whole rectangle in one RPC under a
   `maxCells` clamp, carrying values, types AND formulas; `api.getCellData` reads one cell with its
   type and formula; `api.beginBatch`/`commitBatch`/`cancelBatch` give sub-unlocked scripts one undo
   step; notebook grid swaps now run through a diff+replay inside one undo transaction
   (`scripting/notebook_commands.rs:214-218`), which fixed the undo bypass, the stale recalc and the
   literal-text formulas together.
3. **Formatting + structural ops for scripts by reusing existing paths** — **SHIPPED.**
   `sheet.setRangeFormat`/`clearRangeFormat` (restricted, own sheet) and
   `api.setRangeFormat`/`clearRangeFormat` (unlocked); `api.insertRows/insertColumns/deleteRows/
   deleteColumns` **with arguments**, not selection-ambient; `api.addSheet/deleteSheet/renameSheet/
   setActiveSheet/setSheetVisibility`; `api.setRowHeight/setColumnWidth`; `api.freezePanes`;
   `api.mergeCells/unmergeCells`. Move/copy sheet and split panes were not part of this item and
   were closed later in Wave G (§2.4).
4. **Writeback automation capability** (`distribution.writeback`) — **SHIPPED.** Seven methods on
   both the object-script and extension-worker surfaces: `writebackListRegions`, `writebackGetLayer`,
   `writebackSaveDraft`, `writebackPreview`, `writebackSubmit` (contributor) and
   `writebackListSubmissions`, `writebackReview` (publisher, gated on Ed25519 possession). Enforced
   in `scripting/writeback_gateway.rs` with grant re-check, rate buckets and audit. The silent
   draft-capture bypass is closed by `scriptHost/writebackWriteGuard.ts`, which every script write
   target passes first (`host.ts:2195`).
5. **Models finishing loop** — **SHIPPED.** `cap.biModelValidate`, `cap.biModelLineage`,
   `cap.biModelBatch` (script mutations as one undo step), and the notebook `security_roles` info
   leak closed with a regression test (§4).
   **Both "Missing" bullets are DELETED as false (2026-08-02), not downgraded:**
   - `dependency_graph` was said to have "no `cap.biModel*` allowlist row". It does not need one:
     it is an ACTION of `cap.biModelLineage`. `BI_MODEL_LINEAGE_ACTIONS`
     (`app/src/api/scriptHost/validators.ts`) is `{ dependencyGraph, measureLineage, dependents }`.
     This is dimension (b) of the enumeration rule stated in §0 — reach that is dispatched as an
     action/aspect and therefore carries no allowlist row of its own — being missed by an audit
     that only read dimension (a).
   - Notebook Phase 3 "was not started" — it shipped as roadmap item 23.
6. **Distribution lifecycle events + package-aware scripts** — **SHIPPED.**
   `AppEvents.PACKAGE_UPDATED` (thinned to `{packageName, version}` for sandboxed subscribers)
   replaced the untyped `calp:scripts-pulled` window event; `context.package` is seeded from the
   mount spec (null for local scripts); and **submission-received EXISTS** as
   `AppEvents.WRITEBACK_SUBMISSION_RECEIVED` (`app/src/api/events.ts`), script-subscribable via
   `SCRIPT_SUBSCRIBABLE_APP_EVENTS` and thinned to `{regionId, count}` on the way into a sandbox.
   **CORRECTION (2026-08-02).** The "Missing" paragraph deleted here read: "submission-received
   still does not exist as an event on ANY surface — verified 2026-08-01, there is no
   `SUBMISSION_RECEIVED` symbol in the repo. Publishers poll." The verification was a grep for the
   bare symbol `SUBMISSION_RECEIVED`; the symbol is **prefixed**, so the grep missed a shipped
   subsystem and the document then asserted its absence under a verification stamp. Textbook
   process failure #1. See the seventh correction note in §8.
   Residual, and it is a caveat rather than a gap: the event is delivered by the refcounted
   submission-watch poller described in the §5 box, so it carries up to one interval (60 s) of
   latency and notices nothing while Calcula is closed. Review decisions still have no event, by
   design — a publisher's own click is not news to the publisher.
7. **`ui.dialog` capability** — **SHIPPED.** `cap.dialogAlert`, `cap.dialogConfirm`,
   `cap.dialogPrompt`, `cap.dialogForm` on the object-script and extension-worker surfaces, driven by
   a declarative spec (`scriptDialogSpec.ts`, `MAX_DIALOG_FIELDS`) that TRUSTED host code renders —
   so the capability buys attention and input, never pixels. A dismissal cap
   (`MAX_CONSECUTIVE_DISMISSALS`) stops a script from pinning the user in a prompt loop.
8. **Cancellable Before\* hooks + missing bus events** — **SHIPPED.** `core/lib/lifecycleGuards.ts`
   is the choke point; save and close await the verdict (3s deadline, default-ALLOW, attributed
   cancellation toast). `SHEET_ADDED`/`SHEET_DELETED`/`SHEET_RENAMED` and
   `RECALCULATION_COMPLETED` are in `SCRIPT_SUBSCRIBABLE_APP_EVENTS`. `onBeforeDoubleClick` /
   `onBeforeRightClick` do not exist as hooks on any surface (out of scope for this item).
9. **QuickJS interrupt/timeout/memory budget** — **SHIPPED.** `core/script-engine/src/limits.rs`:
   a re-armable wall-clock deadline driven by QuickJS's interrupt handler (`:118,136`) plus
   `rt.set_memory_limit` (`:173`), with an `allocation_bomb_hits_the_memory_limit` test. Landed
   before item 10, as the review required.
10. **Host-side persistent scheduler** under a consented `schedule` capability — **PARTIAL, and the
    caveat is the important part of this entry.**

    **Shipped.** `app/src-tauri/src/scripting/scheduler.rs` owns the registry and every gate: a 30s
    interval floor, a 64-job-per-workbook cap, a per-job no-self-overlap guard, a 10-minute watchdog
    that force-releases a run whose renderer never reported back, and a `schedule` grant re-check at
    EVERY firing (`:408`) rather than only at registration. `list` is deliberately ungated for the
    trusted UI so the user can always see and stop what runs in their own workbook. Jobs persist in
    the .cala (`core/calcula-format/src/features/scheduled_jobs.rs`, format-version chain link 2) and
    are reconciled against a SHA-256 of each script's source on load, so an edited or deleted script
    disarms its jobs instead of silently redirecting the timer at code nobody approved. The
    connector `refreshEverySecs` scheduler was folded into this one, on the same floor. Every job is
    listed in the "Code in This File" panel with owner, target, cadence, last/next run and per-row
    pause/cancel, and Settings ▸ Script Security shows a live count. The renderer's tick pump is
    started after a workbook's scripts load and stopped when the workbook goes away
    (`extensions/ScriptableObjects/index.ts`; pinned by `api/__tests__/schedulerLifecycle.test.ts`,
    because the first version of this feature persisted correctly and never ticked).

    **The grant-persistence half is now CLOSED (2026-08-01).** The consent text promises the job is
    "saved in this workbook, so it resumes next time you open it"; that was only conditionally true
    because firing needs a live `schedule` grant in the Rust `CapabilityStore`, which is in-memory
    and starts empty every launch, and a local script's JIT grants were session-only. An "Allow
    always" decision for a LOCAL script is now persisted per workbook + script + SOURCE HASH
    (`api/scriptSecurity.ts` `ScriptCapabilityGrant` / `persistScriptCapabilityGrant`) and
    re-established at mount, BEFORE the mount spec is built, by
    `restoreAndSyncGrants` (`api/scriptHost/capabilities.ts`), which `mountWorker` now awaits
    (`api/scriptHost/host.ts:346-364`). The restore is an INPUT to the grant flow, not a bypass: it
    replays through the same `grant_script_capability` / `grant_script_net_origin` commands a fresh
    consent uses, so Rust re-validates every id and remains the authority. A source edit lapses the
    grant, deletes it, and arms a DIFF that the next JIT prompt shows before asking again; a
    capability or net.fetch origin the script never held is never restored. Covered by
    `api/__tests__/scriptCapabilityGrants.test.ts` (24 tests), including "a RESTORED scheduled job
    needs no prompt".

    **The last blocking line is fixed (2026-08-01), and the loop is closed end to end.** It was a
    pre-existing defect the persistence work uncovered: `grant_script_capability` validated against a
    PRIVATE allowlist inside `scripting/writeback_gateway.rs` that listed five ids and **omitted
    `schedule`**, while `RUST_MIRRORED_CAPABILITIES` (`api/scriptHost/capabilities.ts`) mirrored
    `schedule` and `script_scheduler` gated registration AND every firing on
    `cap_store.is_granted(script_id, "schedule")` (`scheduler.rs:778`, `:935`). The mirror
    hard-errored with `InvalidCapability`, the store could never hold a `schedule` grant, and the
    scheduler was unreachable for object scripts — independently of persistence, and *while looking
    implemented from every other angle*. The vocabulary now has exactly one home, the store that
    holds the grants (`scripting/capability_store.rs:69` `GRANTABLE_CAPABILITIES`, `:80`
    `is_grantable`, which includes `schedule`), and `grant_script_capability` calls it instead of
    keeping a copy. Three guards, because a copy is how this happened:
    `schedule_is_grantable_or_the_scheduler_is_unreachable` (Rust),
    `grantable_capability_list_is_closed` (Rust, now asserting through `is_grantable`), and a
    cross-language drift test that reads `capability_store.rs` from TypeScript and fails if anything
    in `RUST_MIRRORED_CAPABILITIES` is not accepted there, or if `writeback_gateway.rs` ever declares
    its own list again (`api/__tests__/crossLayerConstantDrift.test.ts`, "capability grant mirror" —
    negative-tested by deleting `"schedule"` and confirming the failure names the file to edit).

    The full restored-job path, re-derived from code: Rust restores the schedule during `open_file`
    and disarms any job whose owning script's source hash changed (`scheduler.rs`) → the script
    mounts and `mountWorker` **awaits** `restoreAndSyncGrants` before the mount spec is built
    (`api/scriptHost/host.ts:346-364`), which replays the persisted `schedule` grant through
    `grant_script_capability` → the renderer's tick pump starts only after the workbook's scripts
    have loaded (`extensions/ScriptableObjects/index.ts:317`) → `script_scheduler` "due" re-checks
    the live grant on every firing. No step is asserted; each is a call site above.

    Remaining gap, smaller: `has_scheduled_jobs()` warns in the xlsx save-loss report, but there is
    no equivalent warning anywhere else that saving to xlsx disarms every job. **This single bullet
    is the whole reason row 10 reads PARTIAL.**

    **Three corrections from the 2026-08-02 pass**, all in the same direction — a gate that failed
    or reported in the permissive direction:
    - A script **paused in the step debugger** still had its scheduled jobs fired. The renderer's
      tick pump called `callExposedMethod` with no pause check, so the invocation queued behind the
      pause and the job's own no-self-overlap guard was satisfied by a run that was not running.
      `scheduler.ts` `tick()` now skips a paused script and reports `complete { ok: false }` so
      Rust releases the overlap slot; a one-execution race remains and is documented at the site.
    - A **poisoned `security_level` mutex** read as `"prompt"`. The scheduler therefore stayed armed
      after a panic in exactly the state where nothing can be trusted to answer. It now reads as
      `"disabled"`, with the direction named in a comment.
    - **`cap.scheduleCancel` recorded nothing when it removed nothing.** Because the method is in
      the broker's `SERVER_AUDITED_METHODS` set, the frontend deliberately writes no row for it, and
      the Rust gate guarded its `record_capability_call` on `removed == true` — so a script probing
      for job ids it does not own, or cancelling another script's job, was audited **nowhere**. That
      is precisely the traffic an audit trail exists to show. It now records both outcomes.
11. **Sandboxed distributable writeback validators** — **SHIPPED.** The validator body is read from
    the SAME Ed25519 + TOFU-verified manifest as the rest of the package and evaluated in the
    embedded Rust QuickJS realm on the submit path, behind per-package consent that is keyed on the
    validator's source hash and fails closed on every uncertainty (`calp_commands.rs:6038,6205,6247`).
12. **d.ts codegen + TypeScript compile** — **PARTIAL.** Shipped: `objectContexts.d.ts` is generated
    by `app/scripts/scriptTypings/generateObjectContexts.ts` from the real context shims, with a
    lockstep test (`ScriptableObjects/__tests__/objectContextsTypings.test.ts`) that fails when the
    generator and the checked-in file drift, and `app/scripts/**` is now inside `tsconfig.check.json`
    so the generator itself is type-checked. The `caps` namespace IS visible to IntelliSense —
    `caps.dialog`, `caps.schedule`, `caps.writeback`, `caps.fetch`, `caps.storage` are all declared.
    **SHIPPED as of Wave H — see items 20 and 21.** The "Missing: the esbuild transpile-at-save.
    Scripts are still JavaScript; the `.d.ts` describes a language the editor cannot compile.
    Authors get completion and hover, not type ERRORS." paragraph that stood here was already false
    when this section was last stamped: `app/src/api/scriptTranspile.ts` ships, and item 21 of this
    very list says so. A status line that contradicts an item twelve rows below it in the same
    document is not a status. (Seventh correction note, §8.)
13. **MCP as automation co-author** — **SHIPPED.** `mcp/objects.rs` carries update/delete for chart,
    named range, table and pivot plus sheet list/add/rename/delete/move; `mcp/tools.rs:1142` installs
    `HostModelProvider` into `execute_script`, so the MCP script surface can read the model; and
    `mcp/drafts.rs` is the consent-gated "draft an object script, open unmounted" tool — with the
    important property that drafts live in a process-local store that the mount path never reads, so
    an AI-authored script cannot become code that runs on next open without a human saving it.
14. **Script package manager** — **SHIPPED in Wave H (see item 22).**
    **CORRECTION (2026-08-02).** This item read: "**DEFERRED (designed, not built).** Verified
    2026-08-01: no `@uses` pragma parser and no `base.callImport` exist anywhere in the repo, so
    nothing from the design has been implemented." Every clause of that verification was false.
    `app/src/api/scriptLibraries/` ships ten modules including `usesPragma.ts` (the pragma parser),
    `linker.ts`, `registry.ts`, `lockfile.ts` and `ceiling.ts`; `base.callImport` is an ALLOWLIST
    row in `app/src/api/scriptHost/allowlist.ts`. Item 22 of this same list records the wave that
    built it. A reader who trusted this row would have rebuilt a shipped subsystem — the most
    expensive failure mode a status document has. See the seventh correction note in §8.
    The design paragraph below is retained as the **pre-Wave-H plan**, because the shipped
    implementation follows it and the reasoning (especially why `base.callImport` and not
    `base.callMethod`) is the load-bearing part.
    → **DESIGNED (pre-Wave-H plan): `docs/design/script-package-manager.md`** (2026-07-31). Decision: a library is a
    `.calp` of a new `PackageKind::Library`; imports are *declared* (`// @uses alias pkg@pin`) and
    host-resolved against a workbook lockfile; the shim is a new `base.callImport` over the existing
    `hostCallExposed` relay — **not** `base.callMethod`, whose global `public:true` flag would expose
    library exports to every peer script. Governing rule: a dependency's effective ceiling is
    `declared(lib) ∩ declared(consumer)`, enforced at `buildHandleFromDefinition` →
    `checkPolicy` (`broker.ts:85-127`, `162-177`), which closes the confused-deputy escalation.
    First slice = the import mechanism only (no marketplace UI).
15. **Add-in authoring answer** (§6.1) — **SLICE 1 SHIPPED (2026-08-01).** The decision below stands
    and was implemented without moving the trust boundary: `mayActivateOnMainThread` still returns
    true only for `"trusted"`, and `ExtensionTrust` is still a two-member union. The sandbox grew
    instead.
    **What landed** (`extensionProtocol.ts`, `worker/extensionWorkerContext.ts`,
    `extensionWorkerHost.ts`, `extensionTrust.ts`, `ExtensionManager.ts`,
    `extensions/ExtensionsManager/`):
    - `ctx.formulas.registerFunction(name, {params, description, volatile}, impl)` — the impl stays
      in the worker; the host registers a real UDF whose `implementation` is
      `invokeWorkerHandler(...)`, so every evaluation is brokered under `formula.udf` by
      `formulaUdf.ts`. Enforcement is at REGISTRATION (an add-in that may not contribute a function
      never gets one into the catalog or IntelliSense), name shape is validated, and a COLLISION is
      a loud refusal — first registration wins, never a silent rename or overwrite, because the
      formula namespace must stay flat for Excel portability.
    - `ctx.ui.ribbon.registerButton`, `ctx.keybindings.register`, `ctx.grid.cellStyles.register`
      (+ `.invalidate()`), `ctx.fileFormats.registerImporter`; commands and menu items finished and
      ceiling-gated. The **Add-ins** ribbon tab is painted by the trusted `ExtensionsManager`
      built-in from the descriptors — host-owned chrome, extension-owned content.
    - A **contribution ceiling** in the sidecar manifest, honored from the authoritative (signed
      when present) manifest, surfaced in the consent prompt AND in the Extensions panel, with every
      refusal reported. Capabilities stay zeroed for an unsigned sidecar, so worksheet functions
      remain effectively signature-gated; contributions are not zeroed, because they grant nothing —
      they only narrow. Rationale in `extensionTrust.ts` `computeContributionCeiling`.
    - **Security fix found while building:** `EXTENSION_BROKER_METHODS` was declared but never
      consulted. See §6.1.

    **Integration review of the new surfaces (2026-08-01) — five holes found and closed.** The
    contribution ceiling pins the *id* a registration uses; it does not pin the label it renders,
    the shortcut it claims, or the file extension it answers for. Each of these was reachable by an
    add-in that declared a perfectly innocuous ceiling, and none of them needed a capability:
    1. **Menu-item impersonation.** A declared `"file/refresh"` could render as `"Save As…"` in the
       real File menu. Every other surface in the file carried host-drawn attribution (formula
       category, keybinding category, importer name, ribbon group heading); the menu did not, and a
       menu is where a user is most likely to read a row as first-party. Labels are now suffixed
       with the extension's authoritative name and stripped of control/bidi characters so the
       suffix cannot be rewritten from inside (`extensionWorkerHost.ts`, `echoSafe`).
    2. **File-format takeover.** `findImporter` picks the highest-priority registration for an
       extension, and `priority` arrived from the sandbox — so `extensions: ["csv"], priority: 9999`
       would have silently replaced the built-in CSV importer for every CSV the user opens, with a
       handler free to return whatever cells it liked. The manifest declares only the format *id*,
       so consent could not have warned about it. A claimed extension is now refused BY NAME (the
       same rule the flat formula namespace already had), and an add-in importer registers at a
       fixed negative priority so it can never outrank a built-in that registers later.
    3. **Shortcut hijack.** A keybinding could claim any combo; the dispatcher's
       "first registered wins" tiebreak happened to protect built-ins, which is a load-order
       accident, not a policy — and the consent prompt shows only the binding's opaque id, never the
       keys. An add-in may now only claim a combination nothing else uses; a conflict is a loud
       refusal (`findConflicts`).
    4. **Refusal-notice flooding.** Refusals were loud by design and unbounded by omission: a
       `register` loop produced one toast per attempt, each echoing an extension-supplied string —
       an attacker-authored notification channel dressed as a security warning. Refusals past
       `MAX_VISIBLE_REFUSALS` are still counted, still audited and still refused; only the toast and
       the manager row stop, with one final row saying so.
    5. **Undisclosed cell reads.** A `cellStyle` contributor is handed each cell's DISPLAYED VALUE —
       that is the use case ("highlight negatives") — so "adds cell styling" hid a whole-grid read
       with no capability behind it. This is now stated in the consent prompt as a reach sentence,
       driven by `CONTRIBUTION_REACH_NOTE` so a kind added later cannot ship a reach the prompt
       forgot, and repeated in the label the transparency panel prints. The generic
       "Custom code can read and change your data" line it replaced was both vaguer and, for an
       extension with no capabilities, wrong in the other direction.
    **Deferred with reasons** (not "not yet"): file-format EXPORT (its `ExportContext` carries live
    workbook-reading functions = ambient authority with no capability behind it), task panes /
    panels / custom cell editors (need a live component; §4.6's `ExtensionPanelHost` is the path),
    synchronous grid hooks (permanent non-goals in that form), developer mode (O2, nothing depends
    on it).
    ~~**Binding constraint for slice 2:** there is no first-party tool to sign a sidecar manifest, so
    the headline capability — worksheet functions — is out of reach for a real third party until one
    exists.~~ — **RESOLVED (G0, 2026-08-01).**

    **G0 — the on-ramp (2026-08-01).** Three things shipped; the third was not on the list.
    - **`core/calcula-sign`** — a workspace binary with four verbs (`key show`, `key init`, `sign`,
      `verify`). It owns no crypto: `calp::signing` supplies the keypair, the detached Ed25519
      signature and the TOFU store, out of the same `%LOCALAPPDATA%\Calcula` profile `.calp`
      publishing uses, so an author has ONE publisher identity and the app has ONE trust root. The
      layout is resolved by NAME (`<base>.manifest.json` → `<base>.js`; `extension.manifest.json` →
      `index.js`), never by probing the folder — which bytes a signature covers must not depend on
      what else is lying around. `sign` refuses a manifest that could never run (no id, bad id
      charset, no version, `workerSupport` ≠ true), refuses to mint an identity implicitly, rewrites
      the manifest canonically, re-reads it from disk, signs those exact bytes, and self-checks
      before reporting success. The private key is never printed, never an argument, never copied
      into the add-in folder.
    - **`install_extension`** (one Tauri command; the handler budget allowed exactly one). `confirm:
      false` is a pure preview: it verifies the signature, checks the code hash, reads the TOFU pin,
      and returns publisher key + trust status + declared capabilities (and whether they will be
      honoured) + every declared contribution BY NAME + the exact files that will be written —
      all read from the sidecar without importing the bundle. **It copies nothing and pins nothing**
      (asserted by test: a pin written before the user decided is exactly the failure the feature
      exists to fix). `confirm: true` re-derives everything from disk (never trusting the preview
      the renderer hands back), refuses a missing sidecar, a non-sandboxable bundle, a broken
      signature, a signed manifest with no `codeHash`, and a `codeHash` mismatch; a **publisher
      change** additionally requires `acceptPublisherChange`, which the UI sets only from its own
      separately-worded checkbox. Only then does it copy three files and pin the key. Destination is
      always `app_data/extensions`; the source path comes from a native folder picker the user drove
      and is only ever read.
    - **The signature now covers the CODE.** This was the real defect under the missing tool: the
      detached signature was over the manifest bytes alone, so an attacker with write access to
      `%APPDATA%\com.calcula.app\extensions\` could swap the program file of an add-in the user had
      already trusted and the app would still say **Signed**, still honour the declared ceiling, and
      still hand the swapped code `formula.udf` — a function running against the user's data on
      every recalculation. `calcula-sign` writes the bundle's SHA-256 into the manifest as `codeHash`
      before signing; `verify_extension_manifest` re-checks it on EVERY scan and collapses a mismatch
      to `invalid`. Install-time-only checking would have missed the actual threat.
    **G0 residuals** (all named in `third-party-addin-authoring.md` §7.7): `codeHash` is
    enforced-when-present rather than mandatory at scan (closing it is a four-fixture test-data
    change in `ext_manifest_tests`); the scan still pins TOFU silently for a bundle that never went
    through the installer, which grants nothing but allows pin-squatting on an id you do not own;
    installs are not audited (the workbook audit log is the wrong scope for a machine-scoped event);
    archives are not an install source; there is no update feed.
    → **DECIDED: `docs/design/third-party-addin-authoring.md`** (2026-07-31; §6 records what
    shipped). Recommendation: **do
    not escalate third-party code onto the main thread.** Grow the worker-extension API instead,
    exploiting the opaque-origin `srcdoc` iframe realm the extension host is not using
    (`CustomControlHost.tsx:847-850`) — host-owned chrome, extension-owned content. Signed-publisher
    main-thread escalation is rejected (a signature proves *who*, not *what*, and main-thread code
    bypasses the ceiling, broker and audit ring entirely); signature stays what it is today, a gate
    on the *capability ceiling*. Developer mode is adopted as a session-only authoring affordance,
    not a distribution channel. First slice = worker-extension formula functions
    (`ctx.formulas.registerFunction`), reusing the exact pattern `customFunctions.ts:157-172`
    already ships — gated on a declared `formula.udf` ceiling, so an unsigned extension cannot
    register worksheet functions.
16. **Trusted-workbook consent persistence** (§6.3) + Settings UI for Script Security — **SHIPPED,
    and as of 2026-08-01 COMPLETE — the object-script half that item 10 depended on has landed.**
    `api/scriptSecurity.ts` keeps a per-workbook trust record in localStorage keyed by workbook
    identity plus SOURCE HASHES, so changed code re-prompts rather than inheriting trust; notebook
    capability grants persist and are re-mirrored into the Rust `CapabilityStore` on open
    (`rehydrateNotebookCapabilityGrants`); Settings ▸ Script Security is a real page with a level
    picker, the per-workbook trust list, per-notebook grant revoke, revoke-all, and a read-only
    view of the workbook's scheduled jobs.

    **The object-script half (F1).** One `WorkbookTrustRecord` now carries three decisions that
    never imply one another: `runTrust` (may this workbook's code EXECUTE — still grants zero
    capabilities), `notebookGrants` (not hash-bound, deliberately — a notebook is edited between
    every run), and the new `scriptGrants` — an "Always allow in this workbook" decision for one
    worker-realm LOCAL script, bound to the SHA-256 of the source the user approved, per capability
    and per net.fetch origin. `mountWorker` awaits `restoreAndSyncGrants` before building the mount
    spec, so the capability list the worker realm receives is the one it actually has, and the Rust
    store knows before the first tick. Properties, each with a test in
    `api/__tests__/scriptCapabilityGrants.test.ts`: an edit LAPSES the grant, deletes it, and arms a
    diff the next prompt must show; only the exact ids/origins recorded are restored, so any
    escalation re-prompts; nothing is restored above the R19 declared ceiling; run-trust still
    grants nothing; distributed code never persists here (it keeps per-package consent inside the
    workbook); revoke is per capability and per script from Settings ▸ Script Security and drops the
    live + Rust grant, not just the next launch; and a `createVirtualFile` tripwire proves no byte
    of it can ride inside a .cala or .calp to another machine.

    **Honest-consent note — now DONE.** The JIT dialog already offered "Allow once / Allow always";
    "always" previously meant "until you quit", so persistence made the existing wording true rather
    than false. The dialog body has since been rewritten to name the scope out loud (this workbook,
    this computer, never in the file, withdrawn if the code changes, revocable in Settings,
    session-only when the workbook has never been saved), and to DELETE a sentence that was simply
    untrue — "the script … cannot read or write your cells" — for the surface the dialog most often
    serves. See §6.3.

    **Tamper-hardening of the store (integration review).** The persisted record is untrusted input
    on read, not merely on use: capability ids are filtered against the recognized vocabulary in
    `readTrustFile` (`api/scriptSecurity.ts`), which matters most for NOTEBOOK grants — those have no
    declared ceiling in front of them, so `rehydrateNotebookCapabilityGrants` would otherwise hand a
    tampered id straight to `grant_script_capability`. Rust's own allowlist is what makes the attack
    pointless; this is the layer that makes it unattemptable. Covered by
    `api/__tests__/scriptCapabilityGrants.test.ts` ("the trust store is untrusted input").
17. **UDF fixes** — **SHIPPED.** `udf_results` is threaded through the batch bridge (the paste
    `#NAME?` bug), the library schema carries a per-function `volatile` flag, `cellError("#N/A")`
    returns a real error value, and array returns spill like a native dynamic array (flat array down
    a column, array-of-arrays as rows × cols). The remaining UDF gap is unchanged and was never part
    of this item: a UDF body still receives values, never a Range object.

18. **Wave G — the parity tail + the add-in on-ramp** — **SHIPPED 2026-08-01.** Five stages, then an
    adversarial integration pass. Closed §2.2 (workbook save/saveAs, `open`/`close`/`new` refused),
    §2.4 (move/copy sheet, split panes), §2.6 (AutoFilter through a new feature-neutral controller
    seam), §2.12 (`ui.shortcut`), §2.13 (`file.picker`), §5.5 (submission-received, poll-backed and
    disclosed), §6.6 (WorksheetFunction bridge, R1C1 authoring, script-private clipboard, PDF
    export) and the last §3 entry (`Application.enableEvents`, deleted). Two new capability ids —
    `file.picker`, `ui.shortcut` — threaded through every consumer (`capabilityIds.ts`,
    `CAP_DESCRIPTION`, the seven typed consent maps, `scriptSurfaces.ts`, `core/persistence`
    `KNOWN_CAPABILITY_IDS`, and the deliberate *negative* assertions in `capability_store.rs` for
    both, since neither has a Rust gate) and confirmed by deliberately breaking the guards (§7.17).

19. **Adversarial integration pass** — **SHIPPED 2026-08-01.** Findings and fixes in §7.17 below.

20. **Real step-through debugging (§7.12 half 1)** — **SHIPPED 2026-08-01 (Wave H).** Replaces the
    old "breakpoint" that injected `context.log` calls — which was not a debugger, and worse, meant
    the *instrumented* text reached `registerScript`, so the stored/hashed/distributed artifact was
    not the author's source. Now: `worker/debugInstrument.ts` inserts yield points, the realm pauses
    for real in `worker/debugRuntime.ts`, and the host owns the session (`host.ts:884-978`).
    **The wedge audit is the load-bearing part**, because a debugger that can make a workbook
    unsaveable is worse than no debugger:
    - `onBeforeSave` / `onBeforeClose` (3s, default-ALLOW): a paused script is **skipped outright**
      before the relay (`host.ts:4263`), so a breakpoint can never block a save or a close.
    - `onBeforeCommit` (1.5s, default-ALLOW): likewise (`host.ts:4127`).
    - Cell/bitmap renders: the worker **refuses to suspend inside a renderer at all**
      (`bootstrap.ts:179,210` bracket both entry points with `beginNoPause`); a hit degrades to a
      snapshot.
    - The 10s **mount** deadline is the one clock that is *suspended* while paused and re-armed on
      resume (`host.ts:997,1002`) — otherwise a breakpoint in `setup` would kill its own session.
    - `stop` always resumes first and only then remounts from the original source
      (`host.ts:930` before `:936`), so the debugger can never leave a script suspended.
    **Reach:** a debug mount is the *only* place `MountSpec.debug` is set (`host.ts:626`), and a
    session is built from the host's own mount table. Nothing was added to `ALLOWLIST`, to the
    aspect switches, to `EXTENSION_BROKER_METHODS`, to the QuickJS ops or to the MCP tools — all
    five enumerated, not one. Values are stringified **inside** the realm; only `{name,type,value}`
    strings cross. Residual, stated: inside an active session the realm holds a `__calculaDbg`
    global its own code could call, which lets it pause *itself* — forfeiting its own veto rather
    than gaining one, and endable with Stop. It does not exist on a normal mount.
    **Amended 2026-08-06 (twelfth entry, §8):** a debug mount may now be **inert** —
    `MountSpec.debug.autoInvokeSetup: false` makes the wrapper tail skip `setup(context)`, so
    entering the debugger executes nothing and the user starts the script with Run / run-at-cursor /
    Fire. That flag is `false` in exactly one place — the synthetic module-macro mount the host
    builds for a recorded macro, whose `setup` *is* the macro rather than a registration step. Every
    object script keeps `autoInvokeSetup: true`, because its `setup` is what registers `onClick` and
    a mount that skipped it would have nothing to debug.

21. **TypeScript authoring (§7.12 half 2)** — **SHIPPED 2026-08-01 (Wave H).**
    `api/scriptTranspile.ts` compiles at save; **the emitted JavaScript becomes `script.source`**, so
    "the code you consented to" and "the code that ran" remain the same string by construction rather
    than by a check (consent hashing at `scriptSecurity.ts:600/863/925` is untouched). Valid
    JavaScript is returned **byte-identical**, so re-saving an unchanged script cannot churn its hash
    and lapse its grant. A failed compile **blocks the save** — the old branch that stored
    un-runnable text "so the user doesn't lose edits" is gone. `removeComments:false` is load-bearing:
    dropping a `// @capability` line would silently narrow the backend-derived ceiling. JSX is
    rejected (TypeScript parses `.js` with the JSX variant, so it was previously a "clean JavaScript
    parse" that could never be imported). Also fixed here: CustomFunctions had been switching
    `noSemanticValidation`/`noSyntaxValidation` on the **shared** Monaco JavaScript defaults at import
    time — which is the actual reason object-script authors had typings but no type-checking.

22. **Script package manager (§7.14, previously DEFERRED)** — **SHIPPED 2026-08-01 (Wave H)**, with
    one stated limit. See the new **Code reuse / packaging** scorecard row for the security shape.
    Two pre-existing bugs were found and closed on the way: (a) the Custom Functions library mounted
    at the *fixed* id `"__custom_functions__"`, local+restricted — the same trust class as every user
    script — so `callExposed`'s `sameTrust` branch made `{public:false}` a no-op between them and any
    script could drive any UDF's `bi.query`/`net.fetch`; the instance id is now 128-bit random per
    install. (b) sibling UDF calls were impossible and now work (`await fns.OTHER(x)`).
    **The placebo it replaced mattered:** the old "Script Marketplace" dialog installed
    `.calcula-template` files with no signature check and no consent.

23. **Notebook Phase 2+3 (§7.5)** — **SHIPPED 2026-08-01 (Wave H).** Markdown cells, "Test in
    notebook" from the Model Editor, and promote-a-cell-to-an-object-script. The design decision
    worth recording is the one that was *refused*: the obvious implementation was a
    `model.validateMeasure` QuickJS op, which would have put a read behind `bi.model` — a strictly
    stronger grant whose `upsert` path takes `script_id` from the caller. Instead the **trusted**
    Model Editor runs the validation itself and ships *text* into a notebook cell, adding **zero**
    ops, zero provider methods and zero capabilities to the notebook surface. Markdown is enforced
    **server-side** (`notebook_commands.rs:142,183`, inside the single run funnel, before the security
    gate), so prose can never reach QuickJS even if a frontend forgets. Promotion lands the script
    **unmounted**, with capabilities derived from actual `model.*` use and re-derived authoritatively
    in Rust at save (`object_script_commands.rs:283`).

24. **Security residuals** — **SHIPPED 2026-08-01 (Wave H).** Scan-time TOFU no longer pins (the
    §7.17 residual); add-in installs are audited machine-side; the three script-held states got a
    reader *and* a revoke; and a user keybinding that shadows a script shortcut now says so
    (`keybindings.ts:561`) without ever refusing — it is the user's keyboard.

25. **Closing integration pass** — **SHIPPED 2026-08-01.** Findings and fixes in §7.18 below.

### 7.17 Integration pass — what the wave reports got wrong

Five stage reports were verified against the code rather than trusted. Four claims did not survive.

**A. The add-in trust decision was fail-open in two places (HIGH).** The launch-time scan
(`lib.rs::verify_extension_manifest`) and the installer (`extension_install.rs::inspect`) computed
trust *independently*, and they had drifted — in the same direction:

  - **An unreadable pin store read as `verified`.** `load_trusted_publishers` returns `Ok(empty)`
    for a store that does not exist (a real "never seen anybody") but `Err` for one that exists and
    cannot be parsed. The scan's `Err` arm returned `"verified"` outright and the installer's
    treated it as "no pin" → `firstUse`. So an attacker who can write the user's profile directory —
    the *same* attacker the `codeHash` work already assumes can write `%APPDATA%/…/extensions` —
    could corrupt one small JSON file and have a **publisher-key substitution report as trusted**,
    with the full declared ceiling honoured and no re-prompt. That is the one thing TOFU exists to
    prevent.
  - **`codeHash` was enforced-when-present.** Only `Mismatch` collapsed trust; `NotDeclared` and
    `BundleUnreadable` passed. A signed-but-hash-less add-in that was hand-copied past the installer
    got `firstUse`/`verified` at every launch — full ceiling including `formula.udf` — with its
    program file authenticated by nothing.

  **Fix:** one shared `decide_extension_trust()` that both paths call, and two new statuses that
  fail closed — `codeUnverified` (the signature covers the description but not the code) and
  `trustUnavailable` (we cannot read our own pin record, so we cannot say whether the publisher
  changed). Neither is in `trust_grants_capabilities`, both are refused at install, and neither
  pins. Presentation rows were added to **both** UI maps, because an unlabelled security badge
  renders as an empty box, which reads as benign. `installTrustChain.test.ts` now reads the status
  vocabulary and the trusted-set **out of the Rust source** instead of a hand-copied array — the
  copied array would have gone on asserting that the old five were complete.

**B. Three capabilities were consent-visible but unreachable for sandboxed extensions (MEDIUM).**
`computeExtensionCeiling` filtered a manifest's declaration only against "is this a real capability
id", so `ui.html`, `bi.connector` and `ui.shortcut` — none of which have any method in
`EXTENSION_BROKER_METHODS` — reached the ceiling, the grant set, and from there the consent prompt's
*"Capabilities it can use:"* line. This is the mirror image of the four silent-strip incidents: it
grants nothing, so it is not an escalation, but it is a **false consent string**, and overstating is
not a safe direction to be wrong in — it teaches the user the list is approximate, and the next list
they wave through is the one that mattered. **Fix:** `extensionReachableCapabilities()`, derived from
`EXTENSION_BROKER_METHODS` ∩ capability-bearing ALLOWLIST rows, **plus**
`CONTRIBUTION_REQUIRED_CAPABILITY` (deriving from methods alone would have silently stripped
`formula.udf` and with it every add-in worksheet function). Dropped ids are reported, not swallowed.
`enforceableCapabilities()` now derives this surface too, so the taxonomy audit catches the class
automatically rather than by inspection.

**C. A private Ed25519 signing key was sitting in the working tree (MEDIUM).** G0's report asked for
`docs/examples/sign-extension.mjs` to be deleted and it was still there, together with the
`publisher.key` it generates — a real PKCS8 private key in a `docs/examples/` folder users are
invited to copy and zip, protected only by a `.gitignore` line. The tool also minted a **second
trust root** unrelated to the `.calp` publisher identity and wrote no `codeHash`. **Fix:** the
signer, the key and the signature it produced are deleted; all three example READMEs now document
`calcula-sign`, and the examples ship unsigned on purpose (a committed signature is bound to one
machine's key and breaks on any edit, which only teaches people to ignore a red badge).

**D. Two scorecard/report claims were overstated.** "Unsigned yields zero contributions" — it yields
zero *capabilities*; non-formula contributions still register by design. And the `ui.shortcut`
Settings row said **"Extension"** in the Source column for a script binding, offered a **Delete**
button that was hidden and an **Edit** button that was a no-op (`setUserKeybinding` refuses script
bindings). Fixed: the column reads "Script", Edit is hidden, and Delete became **Revoke**, wired to
`revokeScriptKeybinding` — the one binding a user did not create was the only one they could not
take back from that page.

**Also closed in this pass** (open cross-file requests from the wave reports): `install_extension`
added to `PRIVILEGED_BACKEND_COMMANDS.extensionManagement`; `assert!(!is_grantable("file.picker"))`
and `…("ui.shortcut")` added beside the existing frontend-only negative assertions in
`capability_store.rs`; and the four `ext_manifest_tests` fixtures given real bundles + hashes so
they exercise the states they are named for rather than the `notDeclared` path.

**Drift guards were verified by breaking them.** Removing `"file.picker"` from
`core/persistence/src/lib.rs::KNOWN_CAPABILITY_IDS` produced three independent failures: a Rust
**compile error** (the array is length-typed), the `known_capability_ids_mirror_the_typescript_source_of_truth`
runtime assertion with a diagnosis naming the silent-strip consequence, and the TS-side test that
reads `lib.rs` from disk. Restored and re-verified green.

### 7.18 Closing integration pass (Wave H) — what the reports got wrong

Five stage reports were verified against the code rather than trusted. Three claims did not survive,
and one of the failures was a real capability escape.

**A. Realm sharing laundered `net.fetch` ORIGINS across consumers (HIGH — fixed).** The libraries
report said "a library must not be able to name a host its importer did not disclose", and
`intersectCeiling`/`intersectOrigins` really did compute the right narrowed set. But the **realm
sharing key did not contain it**: `realmKey` was `package@version | tier | capabilities` and nothing
else, while the origin set was computed *inside* the `if (!realm)` branch. So the FIRST consumer to
mount a realm fixed its origin allowlist for every later sharer. Consumer A declaring
`https://a.example` and consumer B declaring `https://b.example` shared one realm; whichever mounted
first won, and the other either reached a host it never declared (a real escape, since `net.fetch`
origins are enforced authoritatively in Rust against the *realm's* granted set) or silently lost its
own. **Fix:** the key now includes the resolved origin set (`linker.ts::realmKey`), so ceiling-equal
but origin-different consumers get separate realms. Mutation-verified: deleting the `net:` segment
from the key fails `"gives two consumers with DIFFERENT declared origins two different realms"`.
The general lesson is written into the file's SECURITY note (4): *every axis of the ceiling must be
in the sharing key, not just the capability set.*

**B. Transitive dependencies were installed, consented and locked — and could not run (HIGH for
honesty; fail-closed).** `resolveClosure` walks `// @uses` transitively, `applyInstall` consents and
locks every node, `checkUpdates` reports `newDependencies`, and `chainCeiling` existed with a test.
But **`chainCeiling` had no production caller**: `mountRealm` compiled a library realm from its
modules alone and never linked *its* imports, so a dependency's `imports.x` was a `ReferenceError`
inside the sandbox. Fail-closed, therefore not an escalation — but a whole documented feature that
did not work, which is the exact failure mode §0 exists to stop. **Fix:** `mountRealm` now resolves
the locked package's own `uses` first, at `chainCeiling(declared(dep), effective(parent))` with
origins intersected against the **parent's** resolved set (never the root consumer's — that would
re-widen what the parent gave up), refcounts the dependency realm against the *parent realm's*
scriptId so releasing the last consumer cascades, and refuses a cycle in a hand-edited lockfile
instead of recursing. Four new tests, including the laundering shape (consumer declares
`net.fetch`+`bi.query`, middle declares only `bi.query`, leaf declares both again → leaf gets
`bi.query` only) and an end-to-end chained call across two realm boundaries.

**C. "A library can never widen its consumer" was stated one notch stronger than the code.**
`ceiling.ts` said the honest fix is for the consumer "to declare `net.fetch` and **be consented for
it**". The rule intersects **declared ceilings**, not **grants**: the library realm's grant comes
from the *library's* own install consent, capped by the intersection. So a consumer that declares
`net.fetch` but has never been JIT-prompted for it can still cause egress through a library the user
approved for `net.fetch` at install time. Nothing is granted that the user did not approve — they
approved it for that library, by name, with its source shown — but the consumer's own just-in-time
prompt is bypassed on that path. Closing it needs per-call caller identity at the target, i.e. the
`base.callImport` broker method; the bearer-token relay cannot provide it. **Fix:** the claim is
corrected in place, with the residual and its real fix written next to it.

**D. Two shipped features were not reachable from the UI that owns them.** The step debugger's
main-window bridge (`installObjectScriptDebugBridge`) was never installed, so F5/F9/F10/F11 worked in
the in-window dialog and **silently did nothing** in the standalone editor window; and the library
manager was still reachable only as "Script Marketplace…", the name of the placebo it replaced. Both
wired/renamed in `ScriptableObjects/index.ts`.

**E. Imported libraries were invisible to the code inventory.** A library is third-party code that no
script's source contains, whose bytes live in the workbook (`.calcula/script-libs/<sha256>.js`) and
which executes in its own realm — and `getWorkbookCodeUnits()` did not list it. That is the single
worst place for a transparency hole: a dependency nobody typed is the most likely home for hostile
code. **Fix:** a `script-library` surface in the taxonomy (with its own honest `gate` string) and a
join in `codeInventory.ts` showing the module's **declared** ceiling next to the live realm's
**intersected** grants — the gap between them *is* the narrowing, so both are shown rather than one
being picked. A module whose cached source fails its hash is rendered *with the failure*, never
dropped. Adding the surface immediately failed `codeInventory.ts`'s compile-time exhaustiveness
guard, which is what that guard is for.

**Drift guards were verified by breaking them.** Removing `"ui.shortcut"` from
`capabilityIds.ts::ALL_CAPABILITY_IDS` produced **10 failures across 3 files** — the taxonomy
vocabulary check, the allowlist-derived completeness guard, the extension-ceiling derivation, the
broker ceiling test, and (notably) `"survives the RUST pragma parser"`, which reads
`core/persistence/src/lib.rs` from disk. Restored and re-verified green. Wave H introduced **no new
capability id**, so no consumer needed threading: `ALL_CAPABILITY_IDS` (13) and
`KNOWN_CAPABILITY_IDS` (`[&str; 13]`) still match exactly.

---

### 7.19 Wave I closing pass — the payload kinds nobody had counted

Wave I integrated four Wave-I stage reports (a Rust-only track, plus a three-stage broker chain:
`base.callImport`, `grid.read`, scripted distribution) and then attacked the result. **Every stage
claim that was re-derived survived** — for the first time in this program the reports were accurate
about what they had built. The defects Wave I found were in the space *between* the stages: what a
`.calp` package can deliver that nobody had enumerated as code.

#### The enumeration that should have existed from the start

"Code arriving in a package cannot run without explicit consent" is a claim about **payload kinds**,
not about broker methods. Here is the complete walk — one row per thing a `.calp` can carry, with the
gate for each. Rows in **bold** were the holes.

| Payload kind | Where it lands on pull | Consent gate |
|---|---|---|
| Object scripts | `SavedObjectScript`, forced `Restricted` + `Distributed` regardless of what the package said (`core/calp/src/pull.rs:518`) | `distributedConsent`, keyed by package + SHA-256 of source; a changed script re-prompts with a diff |
| **Custom-function (JS UDF) library** | merged PER FUNCTION into the workbook's ONE reserved library record (`calp_commands.rs:1068`), then `custom-functions:refresh` mounts it live | **WAS NONE — §7.19-A** |
| **Module scripts** | `WorkbookScript`, inert data, no provenance/tier stamping | **inert only until something ran them — §7.19-B** |
| Notebooks | inert; execution metadata stripped defensively at pull, not just at publish | none needed; run only on explicit user action, which is floor-gated |
| Chart-transform library | reserved module id `__calcula_chart_transforms__` | `Charts/lib/distributedLibraryGate.ts`, same shared store, namespaced key |
| Chart-mark library | reserved module id `__calcula_chart_marks__` | same gate |
| Writeback validators | declared in the signed schema, run in Rust QuickJS at submit | `validator_consented` (`calp_commands.rs:6207`), fails closed on every uncertainty |
| Connector scripts | registered by an object script holding `bi.connector` | inherits the object-script gate; there is no other door |
| Model overlay | DAX measures into the WORKBOOK layer (`BusinessIntelligence/lib/modelOverlayDistribution.ts`) | **DECISION, not a gap:** DAX is declarative and evaluates in the Rust BI engine with no host reach, no capability and no I/O. Gated like a conditional format, not like a script |
| Generic custom objects | opaque JSON to a registered `DistributableObjectProvider` | **DECISION:** the payload is data; `materialize()` is trusted first-party extension code. A package cannot smuggle behaviour past the provider that chose what to do with the data |
| Data sources, pivots, CF/DV, controls, slicers, theme, tables, sheets | declarative state | data — no execution |

Three of the four reserved-library surfaces had the gate. The fourth did not, and nothing in five
lists of broker methods could ever have said so.

**A. A `.calp`'s formula functions ran with NO consent, inheriting the subscriber's grants (HIGH —
fixed).** A package ships a custom-function library. `merge_custom_function_library`
(`calp_commands.rs:1068`) merges it, per function, into the subscriber's own reserved record, stamps
`sourcePackage` + `sourceDigest`, and emits `custom-functions:refresh`; the CustomFunctions extension
bridges that event to `loadAndInstallCustomFunctions()`, which mounted **everything in the record**.
So the publisher's JavaScript mounted on pull, on refresh and on every subsequent open, and ran
whenever a cell used it — and the package ships the cells too. Three consent strings the user had
just read said the opposite: `cap.pkgPull`'s "the code stays switched off until you say yes",
`cap.pkgRefreshApply`'s "any script whose code changed is switched off again until you re-approve
it", and `distribution.subscribe`'s "any code that arrives stays switched off until you approve it
(including code that CHANGED in an update)". **Those sentences were false when written.**

The second half is worse than the first. The merged record shares the SUBSCRIBER'S script id and
therefore the subscriber's live grants, and the merge deliberately does not union capabilities — so a
subscriber who had granted their own functions `bi.query` was, unasked, running a stranger's code
with it. A textbook confused deputy, in the one part of the system whose entire purpose is refusing
them.

**Fix** (`api/customFunctions.ts:353-460`), shaped exactly like the chart-library gate it should have
been built beside:

- the filter lives in `doInstall` (`:463`) — the single choke point every install path funnels
  through (startup, `AFTER_OPEN`, the backend refresh event, and the authoring dialog's Save) — so it
  is fail-closed by construction rather than by whoever remembers to call it;
- consent is **per package**, over that package's functions only, in the shared
  `@api/distributedConsent` store under a namespaced key `custom-functions:<pkg>` (`:353`) that
  cannot collide with the object-script record for the same `.calp`;
- the consent source (`:376`) carries one `// @capability <id>` pragma per capability **the shared
  realm holds**, so the store's own expansion check fires: a package approved while the sandbox was
  inert re-prompts the day the subscriber widens it. This is the clause that makes the prompt's reach
  claim true rather than true-at-the-time;
- the prompt (`CustomFunctions/components/DistributedFunctionsConsentDialog.tsx`) says what approving
  really hands the code — *these functions share this workbook's one Custom Functions sandbox* — and
  what blocking costs (`#NAME?`); it is queued per package, reset per workbook, and never re-asked
  for a package the user blocked this session;
- a purely local library takes an identity fast path and never reads the consent store, so nothing
  changed for the scripts that existed before this gate.

13 tests (`api/__tests__/customFunctionConsent.test.ts`) drive the REAL store over an in-memory VFS:
withholding, an all-package library mounting nothing, a changed body re-prompting, an added function
re-prompting, **widening the sandbox re-prompting every package in it**, and one package's approval
never covering another's. Mutation-verified: replacing the capability pragmas with `""` fails 3 of
them.

**B. A package's module script could be run by a package-supplied button (MEDIUM — fixed).**
`run_script` is handed raw source and gates only on the global Script Security floor plus this
workbook's trust record — and per-workbook trust is computed over LOCAL code only, so a distributed
module never lapses it and never appears in it. Meanwhile both button paths
(`Controls/Button/interceptors.ts:171`, `CellTypes/types/button.ts:120`) resolve a workbook script by
name and hand its source straight to `run_script`, and a `.calp` carries pane controls. So a report
the user trusted for their OWN scripts would execute a stranger's module the moment they clicked its
button.

The design already said this should not work: `core/calp/src/pull.rs:88` records that pane-control
payloads carry no inline code "by design (D6) — custom-control / button scripts travel separately as
consent-gated `object_scripts`". **Fix:** `require_distributed_module_consent`
(`scripting/commands.rs:333`, called at `:976`) — Rust-authoritative, because the renderer builds the
call and is assumed hostile. It reads the same consent store the object-script and validator gates
read; a source that matches a package-owned module with no covering record is refused with
`DISTRIBUTED_SCRIPT_NOT_CONSENTED` and an error naming the sanctioned alternative. A LOCAL script
with the same source still runs, so "copy it to your own script and edit it" — the documented way to
adapt distributed content — is untouched. 6 tests, including consent not surviving the publisher
changing the body, and one package's consent never covering another's module.

**C. Two smaller trust-boundary leaks in the new distribution gateway (fixed).**

- *A dev subscription laundered an arbitrary local path into the script-reachable registry set.*
  `configured_registries` walked every subscription, and a dev subscription's `registry_url` is
  `file://<path-to-a-.cala-file>` — the one subscription shape with no signature, no publisher key
  and no TOFU pin, and the shape the gateway's own `Action` doc calls "human-only, permanently". Not
  exploitable today (a `.cala` file is not a registry directory), which is exactly why it was worth
  closing before it became so. Fixed at `distribution_gateway.rs:409`, pinned by a test that asserts
  against the same `calp::dev_mode::is_dev_subscription` predicate the production code uses.
- *The HTTP registry transport did not validate path components.* `LocalRegistry` runs every
  package/version/artifact component through `calp::registry::validate_component` before joining it
  into a path; `HttpRegistry` built its URLs by concatenation, and a URL parser RESOLVES `..` — so a
  package name of `../..` addressed a location outside the registry the user configured. Bounded (the
  authority is fixed by `base_url` and redirects are disabled, so it is not SSRF), but "only
  registries you configured" is the rule the entire gateway rests on, and a rule enforced on one
  transport and not the other is not enforced. Fixed at `calp_registry.rs:112-140`; 3 tests, one of
  which proves the refusal happens before any egress.

**D. What the stage reports got RIGHT, re-derived rather than trusted.** All four were accurate.
Spot-checked against code: `base.callImport` really does derive authority from caller identity — the
consumer passes an alias and nothing else (`allowlist.ts:83`), resolution is
`scriptImports.get(handle.scriptId)?.get(alias)` against a table only the linker writes
(`host.ts:1210`), the realm's entry point sits behind `HOST_ONLY_EXPOSED_PREFIX` which `callExposed`
refuses *before* the lookup (`broker.ts:401`, so a refusal is not a probe), and the caller's own
grants cap the call at CALL time with a per-origin check for `net.fetch` (`host.ts:1315`). §7.18-C's
residual is genuinely gone. `grid.read` really does fail closed rather than open — a refused
`cellStyle` contributor installs no interceptor at all, so the paint path never even collects the
cells, and the resolver's belt-and-braces re-check returns `null` (base styling) rather than a
stripped batch that would read to the add-in as an empty workbook. The distribution gateway really is
Rust-authoritative on all four of its bounds, and its source-level drift guard really does fail if it
starts reimplementing verification. The LAMBDA depth ceiling really is at the single choke point
every lambda call funnels through, restored (not decremented) so it cannot drift.

**E. One hardening the reports did not claim.** `eval_3d_ref` (`core/engine/src/evaluator.rs:1163`)
is the one place evaluation continues inside a **fresh** `Evaluator`, which starts at
`lambda_depth = 0` — a full budget handed out while the outer evaluator's frames are still on the
stack. Not reachable today (the parser only ever puts a bare reference there, via
`parse_reference_only`), so this is hardening rather than a fix; the nested evaluator now inherits the
depth, so the ceiling stays a ceiling if that ever changes instead of quietly becoming per-evaluator.

**F. One declaration gap closed.** `PRIVILEGED_BACKEND_COMMANDS` (`api/backendCommands.ts`) — the
declared "never for a non-trusted extension" denylist — did not list `calp_add_registry` /
`calp_remove_registry` / `calp_dev_subscribe` / `calp_dev_refresh` / `calp_import_overrides` /
`calp_detach`. Editing the configured-registry set is the decision that gives the gateway's
signature, TOFU and integrity checks their meaning; an extension that could add a registry would then
pull from it *legitimately*, through a gate that had already been satisfied. Added as a new
`distributionTrust` capability group. Declaration-only today (third-party extensions get no raw
backend access), which is exactly why it had to be fixed before the governed door lands.

**Drift guards verified by breaking them.** `"distribution.subscribe"` → `"distribution.subscribeX"`
in `core/persistence/src/lib.rs::KNOWN_CAPABILITY_IDS` fails
`known_capability_ids_mirror_the_typescript_source_of_truth`, and the failure **names the file to
edit** (`app/src/api/scriptHost/capabilityIds.ts`) and the fix ("add the id … rather than deleting
this assertion"). Restored and re-verified green. `ALL_CAPABILITY_IDS` (16) and
`KNOWN_CAPABILITY_IDS` (`[&str; 16]`) match exactly.

**Consent-string honesty audit.** Every literal string for the three new ids was read, in all eight
typed `Record<CapabilityId, string>` maps, against what the code actually does — reach AND duration.
`grid.read`'s "be shown … the value of every cell on screen while it decides how to style them, and
the old value, new value and formula of every cell that changes" matches both readers, and its "it
cannot change your cells with this" matches `EXTENSION_BROKER_METHODS` (no `sheet.*` row on that
surface). `distribution.publish`'s "only if you have published something yourself before — a script
cannot create your publisher identity" matches `load_existing`. `distribution.subscribe`'s "any code
that arrives stays switched off until you approve it" is now true; **before §7.19-A it was false**,
and that is the second false consent string this program has shipped. `SubscribeDialog`'s phrasing
for the two distribution ids — "a script that arrived in a package cannot actually do this — Calcula
refuses it — but it asked" — matches the structural bound (every `cap.pkg*` row is unlocked-tier;
pulled scripts are forced restricted) rather than merely promising it.

**Duration claims.** Checked separately from reach, because a true sentence about *what* can still
lie about *how long*. `ui.shortcut`'s "it disappears when the script stops" holds (the binding is
released at unmount). `schedule`'s "while Calcula is open" holds (no headless runtime exists, and
§8 keeps that as a deferral rather than a gap). `distribution.subscribe`'s "including code that
CHANGED in an update" is a duration claim as much as a reach one — consent is keyed by source hash on
every one of the five gated payload kinds, so it survives a refresh. The new custom-function prompt
adds the only duration sentence Wave I wrote: "you are asked again if the publisher changes this code,
or if you later widen what the Custom Functions sandbox is allowed to do" — both halves are enforced
by the consent source, and both have a test.

---

### 7.20 Wave K closing pass — the seven dimensions no wave verifier owned

Every wave in this program ran its own adversarial verifier, and between them they found about
twenty real holes. What none of them could find is a defect that only exists **between** waves, or
one that lives in the *reporting* rather than in the code. Wave K was scoped to exactly those seven
dimensions, one per reviewer, deliberately excluding "look for another broker hole" as finished work.

**1. Cross-wave invariant erosion** — an invariant Wave *n* established, and Wave *n+k* quietly
stopped honouring.

- **The writeback draft gate had a second door.** Wave C established "no grid write path can land a
  value in a claimed cell without a validated draft behind it", and wrote that sentence into a
  contract comment enumerating the paths. Wave A's QuickJS apply path installs **non-active** sheets
  wholesale, consulted the index for none of them, and was not in the enumeration — so
  `setCellValue(r, c, v, sheetIndex)` aimed off-screen bypassed the schema, the validator and the
  draft entirely, reachable from `run_script`, the scheduler and the MCP `execute_script` tool.
  Fixed pre-mutation and atomically; the contract comment now names the path. **The lesson is the
  comment**: a hand-maintained enumeration of callers is a list, and §0 already says what happens to
  those.
- **`grid.read` delivery checked the manifest ceiling, not the live grant**, under a comment reading
  "FAIL CLOSED" and another promising "a revoke bites the next event". `revokeCapability` mutates
  the grant set; `declaredCapabilities` is frozen at registration. A revoke provably changed
  nothing at either door. Both now check `handle.grants`.
- Three smaller ones: `SERVER_AUDITED_METHODS` was never extended past its eight pre-Wave-C entries,
  so ~24 methods with Rust-side audit gates were being double-recorded; a scripted `cap.pkgPull`
  could mint a trust-on-first-use pin with no human at the commit point (the sibling
  `RefreshApply` action had reasoned about this and used `RequirePinned`; `Pull` had not); and the
  scheduler fired jobs belonging to a script paused in the step debugger.

**2. Program record versus code** — see the seventh correction note in §8. Eleven false statements in
this document, all asserting the absence of shipped code.

**3. Drift-guard efficacy** — guards that pass without testing anything.

The `mcp-tool` surface profile in `core/script-engine/src/manifest.rs` declared
`model_provider: false`. Every mirror inherited that: `codeInventory.ts` listed its reach without
`model` under a comment reading "grid-only by construction, not by assertion", and
`scriptSurfaces.ts`'s containment string said "grid-only — no model provider". The interpreter-reach
drift test asserted the mirrors matched the profile — which they did, all four of them agreeing on
the same false value. `mcp/tools.rs` injects a `HostModelProvider` with a `bi.query` grant.

Note what was and was not wrong: **the reach is properly gated** (`check_mcp_access` at the script
tier, `bi.query` only, `model_info` sanitized, row-level security applied). The defect was the
**disclosure** — the transparency panel made a false reach claim about the one surface driven by an
AI rather than by a person. The profile is corrected, `SurfaceProfile` gained a `granted` list so the
derivation stops overstating (`model.sql` is excluded because `bi.sql` is not granted), and the
root fix is a new source-level guard that resolves each profile's declared entry point to a real file
and diffs `HostModelProvider::new` against `model_provider`. A guard that compares four hand-written
mirrors to each other is a consistency check, not a verification.

**4. Consent-text honesty** — what the dialogs promise versus what the code enforces.

The script consent dialog said scripts "cannot read or write arbitrary cells". The entire `sheet.*`
family is `tier: "restricted"` — every consenting user was told the opposite of the truth about the
most basic reach there is. The install dialog promised that every declared capability "is asked for
separately the first time it is used"; `grid.read` and `formula.udf` are auto-granted at
registration with no prompt, so the user was waiting for a question that never comes. `storage` was
described as "store data on this device" when the store is inside the workbook file and travels with
it to anyone the file is sent to — the reassurance pointed at the wrong risk, in the wrong
direction. All corrected, with tests that derive the premise from the allowlist and from the
auto-grant call sites rather than pinning a string.

One finding was **corrected during triage rather than implemented as written**: the allowlist
promised `sheet.*` calls are "clamped to the bound sheet", while the code clamps to the ACTIVE sheet.
The plan called for making the code match the promise. It cannot: `sheet` is a *primitive* object
type, workbook-scoped, one script per type — `ObjectScriptDefinition.instanceId` is null for it by
design, so there is no bound sheet to clamp to. The text was corrected to "the sheet currently
shown" everywhere instead, and a test now fails on any surface that says "bound sheet" again. This
is worth recording as the shape it is: **the fix that makes the promise true is not always available,
and shipping it anyway would have meant inventing a binding that the object model does not have.**

**5. What the host HANDS code, and WHICH code it runs** — dimension (g), where Wave I's worst defects
lived.

`workbook.onOpen` and the after-save event forwarded their raw detail, which carries the **full
filesystem path**. `host.ts` already refuses to hand out the containing folder, with the reasoning
written at the refusal: `C:\Users\<real name>\Consulting\ClientX` handed to a script that also holds
`net.fetch` is an exfiltration the fetch consent never covered. The event path had no such branch, so
an add-in with **zero capabilities** received the path anyway. Now thinned to `{ fileName }` on both
the event route and the lifecycle-guard route (they are different code paths, and only one of them
passes through the event thinner). Separately, `cell.onEdit` and `sheet.onDataChange` pushed
cross-sheet cell contents to restricted handles, while their siblings `range.onChange` and
`namedRange.onChange` filtered by sheet correctly.

**6. Features with no production caller** — the failure that started this program, repeating.

`mcp/drafts.rs` emits `mcp:script-draft` and tells the AI agent the draft "is queued for the user to
review in the Object Script Editor". **Nothing in the frontend listened to that event**, and no UI
listed drafts. The agent was told something false, and therefore so was the user. This is the macro
recorder's exact shape — plumbing with no caller, reported as shipped. Now wired: the draft opens
the editor in an explicit "AI draft — not saved, not mounted" mode whose Save runs the ordinary
consent path. Four affordances that would have persisted or run unreviewed AI code by a side door
(auto-save-on-switch, access-level toggle, template auto-apply, the debug toolbar) are disabled in
that mode.

Two reviewer claims in this dimension were **refuted** and must not be acted on: the `api.onEvent`
and `object.declareProperties` allowlist rows are not dead. They are named, reasoned exemptions in
the coverage guard — `api.onEvent` **is** the consent text the transparency policy table renders for
`events.subscribe`, and `object.declareProperties` is the allowlist face of an aspect-dispatched op.
Deleting them would delete user-facing consent text and break a designed dispatch path.

**7. Fail-closed discipline and hot-path cost.**

- **Trust evaluation failed OPEN.** `evaluateWorkbookTrust` caught any error from the code inventory,
  substituted an empty code list, concluded the workbook contains nothing that could have changed,
  and auto-granted. A gate whose entire purpose is change detection cannot treat "I could not look"
  as "nothing to see". It now lapses and prompts, and the lapse is not cached, so a transient
  backend timeout does not stick for the session.
- **A corrupt user file inherited the PREVIOUS workbook's state.** Four `.cala` sub-files
  (`subscriptions.json`, `overrides.json`, `audit_log.json`, `writeback_drafts.json`) used a
  `if let Some(bytes) { if let Ok(v) { assign } } else { reset }` shape in which a
  *present-but-unparseable* file takes neither branch. Opening workbook B after workbook A left B
  running A's subscription list — which drives GATHER, refresh, the writeback index and live
  registry I/O against packages B never subscribed to. Restructured as a `match` in which every arm
  must produce a value, so the compiler enforces what review did not.
- **GATHER did blocking, signature-verifying registry I/O inside every cell edit**, behind a 2-second
  TTL and a 30-second HTTP timeout — one keystroke could block the UI for half a minute, and again
  two seconds later. Now served from cache with a background refresh and per-registry failure
  backoff; workbook open likewise defers HTTP registries to a worker (with a supersession ticket, so
  a rebuild that finishes after the user opened a different workbook installs nothing).

**One finding came from outside the seven dimensions and is worth its own line.**
`core/pivot-engine/benches/pivot_calculations.rs` had **24 compile errors** — it still passed the
integer `1` where `PivotId` became an `EntityId` newtype. It was invisible because benches are
outside `cargo check` and `cargo test`, and the CI bench gate named one crate explicitly
(`-p engine`) instead of the workspace. Fixed, and the gate widened to `--workspace --benches`. The
bench is the only coverage of the 1M-row cache-build → calculate → view path the project's
performance story rests on, so it was updated rather than deleted.

**What this pass deliberately did NOT do.** Three confirmed-dead items were left in place as churn
with no user consequence: the `ext.log` broker row, three unused `@api` exports, and two unused
`AppEvents` constants (one of which is pinned by an API-surface-stability test, so removing it costs
a test edit to buy nothing). They are recorded here so the next reader knows they were seen and
priced, not missed.

---

## 8. What is still open after nine waves

The short, honest list. Everything here is verified absent as of 2026-08-02, not inferred.

> **Twelfth entry (2026-08-06, FOURTH human use of the macro recorder) — a debug mount now executes
> NOTHING, and the reason this took a fourth report is that the tenth correction had already found
> the bug and written it down as "a known cosmetic".**
>
> The user opened a recorded macro in the Object Script Editor and pressed Debug. It paused at
> line 6 — *and the grid already held every value the macro writes.* They had stepped nothing.
>
> **Root cause.** A module macro is opened and debugged under the synthetic **unlocked `workbook`**
> definition the tenth entry introduced, so that what you step through is byte-for-byte what a
> button runs. Under that definition `context.onClick` does not exist, so the recorder's generated
> `setup` falls through its click branch to its last line, `return macroNNNN(context.api)`.
> **Mounting the macro therefore RUNS the macro** — and `bootstrap.ts` invoked `setup(context)` on
> every mount, debug mounts included (the wrapper tail was an unconditional
> `return typeof setup === "function" ? setup(context) : undefined;`).
>
> **It was worse than reported: two executions before the user touched anything, three if they
> pressed Run.** `hostStartModuleScriptDebugSession` did a plain `hostMountScript` first (macro runs
> once) and *then* opened the session, which remounts instrumented (macro runs again). The plain
> pre-mount is gone; there is exactly ONE mount now.
>
> **The fix — `DebugSpec.autoInvokeSetup`.** A mount carries a flag saying whether its wrapper tail
> calls the entry point. False produces an **inert** module: the body still runs — that is what
> declares the functions and executes the run-target registrations appended after it — but `setup`
> is not invoked. Entering the debugger prepares the realm, installs the run-targets, and stops.
> Run / run-at-cursor / Fire is what starts it. **That is VBA's contract**, and it is the only
> arrangement in which stepping can show effects *land*.
>
> **The scope of `false` is the whole safety argument, so it is stated exactly.** It is set in ONE
> place: the branch of `hostStartModuleScriptDebugSession` where the HOST ITSELF built the synthetic
> module-macro definition. It is never inferred from the source, and never from "is this a debug
> mount". `hostStartDebugSession` — every real object script, i.e. every button — reads
> `!transientDebugMounts.has(scriptId)`, the debugger's own mount-ownership marker, so it stays
> `true`: an object script's `setup` IS its registration step, and a debug mount that skipped it
> would come up with no `onClick`, an empty Fire list and nothing to debug at all. Pinned by a test
> named for the property: *a button script's onClick is STILL registered under the debugger*. The
> flag also lives on the SESSION, not the mount, so Save & Apply and a re-pressed Debug cannot
> quietly un-inert a session mid-flight.
>
> **`setup` becomes a run-target — but only on an inert mount.** It was previously excluded because
> "the mount already invokes it"; that reason disappears when the mount does not, and for a recorded
> macro whose entire body is reached through `setup` it is the only runnable thing there is. It is
> registered with `entryPoint: true` so it receives the whole `context`, not `context.api` —
> otherwise the generated `if (!context.api)` guard would report the script as restricted.
>
> **Two further bugs found while proving the first.** (1) The instrumenter emits a yield point before
> every top-level statement **including `function foo(…)` declarations** (`pausableLines: [1,2,5,6]`
> for a macro module), so `pauseOnEntry` — which the toolbar arms whenever the gutter is empty —
> would still have stopped the *inert* mount at line 1 and announced "Paused — line 1" for a mount
> that executed nothing. A new `DebugController.beginInert()/endInert()` region silences reporting
> outright; it is deliberately NOT `beginNoPause`, which merely *degrades* a pause to a snapshot.
> `pauseOnEntry` survives the region, so the first stop lands on the first statement the **user**
> starts. (2) `hostStartDebugSession` on an already-mounted transient macro rebuilt the session with
> `autoInvokeSetup: true`, silently un-inerting it — fixed by making the transient marker the
> authority.
>
> **No silent success and no silent failure.** An inert mount with zero run-targets is reported
> `status: "failed"` with the reason ("no top-level function declaration was found…"), NOT
> `"finished"` — which would claim the script completed something. The badge reads
> `"Nothing to run"`; the panel prints the reason; `runAtCursor` returns it to the editor console.
> While an inert session has run nothing, the badge reads **"Ready — nothing has run yet"** and the
> panel says *"Prepared — nothing has run yet … press Run (F5)"*, reverting to the ordinary wording
> once `lastActivity` exists. A session that says "Waiting for a trigger" after running the whole
> macro was the previous lie; both halves are now named.
>
> **Why this belongs in §8 and not just in a changelog.** The tenth correction FOUND this. It wrote,
> in this document, that the double-run "stands as a known cosmetic … end state identical for the
> idempotent writes a recorder emits". That sentence is now struck through where it appears. The
> reasoning error is worth more than the bug: it judged a debugger by the END STATE of the program
> instead of by whether the user can watch the program reach it. A debugger that runs the code before
> you step it is not cosmetically wrong, it is *not a debugger* — and the idempotence that made the
> end state identical is a property of RECORDED macros only, so any hand-authored non-idempotent
> macro double-applied. **The rule this adds: "the end state is the same" is never a reason to
> downgrade a finding about a tool whose entire purpose is the path to that end state.**
>
> **Proven by driving the live app.** `app/e2e/tests/macro-debug-inert.spec.ts` records a real macro
> through the recorder UI and presses Debug, then samples the target cell repeatedly (a single
> `toBe("")` would pass on its first read and miss an async mount-time `setup`). The macro's body is
> a **counter**, not a constant write — one execution reads `"1"`, a mount-time run plus a user run
> reads `"2"`. A constant-writing macro cannot tell those apart, **which is exactly how the original
> double-run got dismissed as cosmetic in the first place.** The spec was negative-controlled by
> restoring the bug (`startDebugSessionOn(…, true)`): tests 1, 2 and 5 fail, test 5 reading `"2"`,
> and the object-script test correctly stays green — the detector is real and it is scoped.
>
> **Verification (2026-08-06):** `npm run check-types` clean · `npm run lint:boundaries` clean ·
> `npm run check:script-typings` `[OK] 39 interfaces verified, 545 members probed` (unchanged) ·
> `npx vitest run` **104,605 passed / 0 failed across 662 files** (baseline 104,564 / 660: +41 tests,
> +2 files — `worker/__tests__/debugWrapper.test.ts` and `worker/__tests__/runTargetHandler.test.ts`,
> plus additions to the debug-session, debug-runtime, debug-reach, debug-panel and debugger contract
> suites) · `cargo check` clean in both `app/src-tauri` and `core`. **No Rust was changed** — the
> debug session lives entirely in the TS script host — so the Rust suites were not re-run and their
> baselines (app-lib 837, core 1,143) stand unmoved. E2E against a live `cargo tauri dev` over
> WebView2 CDP: **12/12** — the 4 new `macro-debug-inert` tests plus the 8 existing macro tests
> (`macro-editor-inventory` 4, `macro-link-model` 3, `macro-recorder-journey` 1), no regression.
>
> **What still needs a human (most-likely-wrong first):** an object script's FIRST F5 with an empty
> gutter stops on a `function setup(button) {` *declaration* line rather than on the first executable
> statement — the instrumenter puts a yield point in front of declarations too (the same property
> `beginInert()` had to suppress on the macro path). It is honest (that mount really is executing)
> but it is a poor first stop, and it is untouched here. Also: the macro trigger list now shows an
> extra `setup()` **Run** row, which is correct on an inert mount but is new UI nobody has lived
> with; and no visual baseline covers the editor window, so the new "Ready — nothing has run yet"
> badge is unphotographed.

> **Eleventh entry (2026-08-05, THIRD human use of the macro recorder) — a module macro was
> first-class in the workbook and a second-class visitor in the editor. Two user-reported symptoms,
> one root cause; fixing it uncovered a mount leak nobody had reported.**
>
> The tenth entry made the macro single-source and link-not-copy. The same human then kept using it
> and reported two things: *"I have two recorded macros and I see them both in the Macros menu, but
> when going to the Object Script Editor by clicking on any of them I only see one at a time in the
> drop down menu"*, and *"Cannot debug a script that is not mounted — apply it first. If I just run it
> first it works, and then I can debug it, but I cannot debug it from start."*
>
> **One root cause under both.** The editor treated a module macro as a transient visitor handed in
> over the `OPEN_WITH_MODULE_MACRO` channel rather than as a member of the workbook's script
> inventory. It held ONE `macroDoc` state slot and rendered exactly one option from it; the rest of
> the dropdown came from `loadAllObjectScripts()` — the OBJECT-script store, which module macros are
> not in. So opening a second macro REPLACED the first, and the editor never enumerated macros at all.
> The debugger inherited the same assumption: a session was built from a caller-supplied mount, and a
> macro has no standing mount by design (buttons run it transiently per click).
>
> **The inventory (bug A).** `@api/workbookScripts` gained `listWorkbookScriptRecords()` — the full
> record per module, with a per-record `loadError` instead of one unreadable module making the other
> nine invisible — plus `parseModuleScriptRuntime()` (the `runtime=` marker is a SHARED convention:
> the recorder writes it, every listing reads it, so one regex) and a `WORKBOOK_SCRIPTS_CHANGED_EVENT`
> emitted from inside `saveWorkbookScript`/`deleteWorkbookScript` so no caller can forget to announce.
> The editor now holds `macroDocs[]` with a per-document buffer (switching keeps each one's unsaved
> edits; a refresh arriving mid-typing stashes the live buffer before merging), renders them in a
> `Macros / modules` optgroup, and follows the workbook live. **This did NOT become a macro seam:**
> the door is the generic module store in `@api`, which the Macros library now delegates to as well —
> `MacroRecorder/lib/macroLibrary.ts` keeps only the macro-specific routing. ScriptableObjects imports
> zero MacroRecorder files, and the reverse holds too; both reach only `@api/*`.
>
> **Cold debug (bug B) — and the report was half wrong, which mattered.** `hostStartMacroDebugSession`
> already existed and run-at-cursor passed it a mount; the *Debug button* did not — `useDebugSession`
> called the bare `hostStartDebugSession`, which throws when the id is not mounted. It is now
> `hostStartModuleScriptDebugSession(scriptId, …)`: **the caller supplies an id, never a body.** The
> host loads the record through `get_script` and builds the synthetic unlocked `workbook` definition
> itself, so what you step through is byte-for-byte what a button runs. The cross-window bridge command
> lost its `mount` payload for a `fromModuleStore` boolean — the editor window can now *name* a module
> but cannot *define* one, closing a source-injection door into an unlocked-tier mount (pinned by a
> test asserting no source ever appears on the bridge).
>
> **"Run first, then debug works" was the symptom of a LEAK, and that is why it is recorded here.** It
> was not the Macros ▸ Run path — that mounts under a unique `__calcula_macro_*` id and unmounts in a
> `finally`, so it could never have satisfied the mount check. It was the editor's own Run: it opened
> a session, and the session left a mount behind. `hostStartMacroDebugSession` added the id to
> `transientDebugMounts`, then `hostStartDebugSession` remounted instrumented via `mountWorker` →
> `hostUnmountScript`, **which deleted the transient marker mid-flight**. By the time the session was
> open the mount was no longer marked debugger-owned, so Stop took the `else` branch and *remounted*
> the macro instead of tearing it down. Every macro ever debugged or run-at-cursor left a permanently
> mounted, unlocked `workbook` realm that nothing revoked — and pressing Debug afterwards "worked"
> precisely because of that leak. Fixed at the root in `mountWorker`: a REMOUNT preserves transient
> ownership, only a real unmount clears it. Cleanup now also runs on a failed session open, on editor
> teardown, and on extension teardown.
>
> **A fourth bug, same area, the `window.confirm` pattern for the THIRD time.**
> `@api/workbookScripts`'s Script Security "prompt" gate did `const ok = window.confirm(...)` — under
> Tauri that returns a **Promise**, so the gate tested an object, was always truthy, and **Cancel
> granted session approval anyway**. Awaited now; the gate fails closed. This is the same defect the
> tenth entry fixed in the delete-warning and `RecordingIndicator`. It keeps shipping, and the project
> rule against it exists because of exactly this recurrence.
>
> **Transparency follow-through.** A debugger-owned mount is a real unlocked whole-workbook realm that
> the workbook itself does not keep. `hostTransientDebugMountIds()` now feeds a `debugger` tag in the
> script transparency panel — previously that accessor had no production caller at all, which made an
> unlocked mount indistinguishable in that list from a script the user installed.
>
> **What was proven by driving the live app.** `app/e2e/tests/macro-editor-inventory.spec.ts` (4
> journeys) ran against a real `tauri dev` build over WebView2 CDP — real recorder, real Macros dialog,
> real separate editor window, real worker realms, real backend module store — and passed 8/8 across
> all three macro specs. Decisive assertions: both macros present in the `Macros / modules` optgroup
> **simultaneously**, switching between them showing each one's own body (`51511` vs `62622`) and back
> again; Debug from a genuinely cold macro (asserted unmounted, no session, not in the transient list
> beforehand) opening with **no "not mounted" text anywhere**, then Stop returning the host to zero
> transient mounts, twice; and run-at-cursor with **three** top-level functions — the case the tenth
> entry explicitly left uncovered — writing only the cursor's function's cell, and refusing a
> two-argument function by name with no wrong-arity call.
>
> **Two more real bugs surfaced only by execution.** (1) **Cold run-at-cursor fired into the remount
> gap and silently did nothing.** `waitForDebugSettled` treated *anything but `starting`* as settled,
> and an instrumented remount unmounts the plain realm first, broadcasting **`detached`**. Run fired
> into that gap, the host's refusal came back as a state broadcast that the next broadcast wiped off
> the panel, and the user saw `Running x()…` and nothing happened — while running the macro once by any
> other route "fixed" it, because the second Run found an open session and skipped the wait. Now an
> explicit `SETTLED_DEBUG_STATUSES` (`waiting`/`finished`/`paused`/`failed`), an early exit on an error
> broadcast, and a **look-before-firing** check against the mirrored trigger list returning a new
> `notReady` outcome instead of a lie. (2) **An unlocked realm survived closing the editor window:**
> `beforeunload` **never runs in WebView2** when Tauri closes the window — measured with a probe, not
> assumed — so the transient-mount release never fired. The close is now announced from
> `tauri://destroyed` **in the window that survives**.
>
> **Verification (2026-08-05):** `npm run check-types` clean · `npm run lint:boundaries` clean ·
> `npm run check:script-typings` `[OK] 39 interfaces verified, 545 members probed` (unchanged) ·
> `npx vitest run` **104,570 passed / 0 failed across 661 files** (baseline 104,543 / 659: +27 tests,
> +2 files — the editor-inventory suite, the debug-session and debugger contract tests, and the
> transparency-tag test, each verified to FAIL without its fix) · `cargo check` clean in both
> `app/src-tauri` and `core`. **No Rust was changed**, so the Rust suites were not re-run and their
> baselines (app-lib 837, core 1,143) stand unmoved.
>
> **What still needs a human (most-likely-wrong first):** a REAL publish→subscribe of a workbook whose
> button links a macro (still only the local orphan equivalent has run); undo after a run-at-cursor;
> and the `debugger` tag in the transparency panel observed in the live app rather than in jsdom.

> **Tenth entry (2026-08-04, the single-source model) — NOT a correction of a false claim; a
> deliberate redesign the user chose after the ninth correction made both entry points execute.**
>
> The ninth correction got Run and the button to both *execute*, but left the model DUPLICATIVE: the
> recorded macro lived in the module store AND "Save as Button" wrote a SECOND object script holding a
> **copy** of the body, keyed by the button's `instanceId`. Two artifacts that can drift — edit the
> macro and the button keeps running yesterday's copy. Asked to choose, the user picked the VBA mental
> model: **ONE canonical macro; a button LINKS to it, it does not copy it.** This entry records the
> build of that decision, not a claim that failed re-derivation.
>
> **The link mechanism (settled, single path).** A macro lives ONCE as a module script (`macro-<slug>`).
> A button that runs it carries a single 12-byte `macroRef` control property = that module id — no body
> anywhere. On a click, `Controls.runFloatingButtonClick` reads `macroRef` **first** and runs the
> CURRENT macro through a new feature-neutral seam `@api/macroRunService` (`MacroRunProvider.runMacroByRef`,
> the same IoC shape as `buttonControlService`/`autoFilterService`); the Macro Recorder registers the
> provider and resolves the id through the EXISTING `runMacroModule` run path. Because the module is
> loaded at click time, editing the macro is reflected on every linking button with zero re-save — the
> link-not-copy guarantee falls out for free. A button with no `macroRef` (a pre-existing copy-model
> button) falls through to the old mounted-object-script path untouched, so nothing that worked breaks.
>
> **Run-at-cursor (VBA F5).** The Object Script Editor gained a **Run** button and F5: when paused F5
> continues, otherwise it runs the top-level function the cursor is in — resolved by a pure
> `enclosingTopLevelFunction(source, line)` helper, fired through the SAME `hostCallExposed`/Fire door
> the trigger rows already used (no second execution channel). Top-level functions are auto-exposed as
> host-only run-targets on **debug mounts only**, arity-bound (`0→fn()`, `1→fn(context.api)`, `>1→` a
> clear refusal, never a wrong-arity call). Cursor in `setup`/whitespace falls back to the sole macro
> function; zero-or-ambiguous speaks in the console rather than guessing.
>
> **Navigation.** Double-clicking a macro row, and an explicit "Edit in Object Script Editor" button,
> both open the macro in the editor through a second seam `@api/scriptEditorService`
> (`ScriptEditorProvider.openMacroInEditor`, provider registered by ScriptableObjects). The editor
> opens it in a new `moduleMacro` doc-kind that loads via `getWorkbookScript`, edits under a synthetic
> **unlocked `workbook`** object-script definition (so `context.api` is non-null, byte-for-byte the
> shape `runMacroModule` uses), and — critically — routes Save to `saveWorkbookScript` (the MODULE
> store), NOT `saveObjectScript`. So the thing edited and the thing every button runs are the one
> record.
>
> **Deletion + orphans (the recurring silence, closed again at a new layer).** Deleting a macro ≥1
> button links now warns, enumerating each linking button by sheet + A1 anchor
> (`list_controls_referencing_macro`, a backend scan of the control store). Deletion still proceeds if
> confirmed (the user may re-point), so orphans are expected and handled at click: `runMacroByRef`
> returns a first-class `notFound`, and the click surfaces a loud toast naming the missing id — never a
> silent no-op. A NEW `reason:"orphanMacro"` in `diagnoseButtonClick` keeps the wording in the one
> tested place.
>
> **Distribution (loud-failure slice; deferral named).** `macroRef` is a plain control property, so it
> and the linked module both already travel in a default `.calp` publish. The real work is the
> publish-time guard `macro_reference_warnings`: if a publisher narrows the module set and drops a
> linked macro, publish (and preview) emit a warning naming the button's anchor and the missing macro.
> A subscriber missing the macro hits the identical local orphan path — the click toasts `notFound`, no
> silent dead button. **Explicitly deferred:** auto-*pruning* the published module set to exactly the
> macros a button needs. The non-negotiable — a missing macro is LOUD at both publish and click — is met.
>
> **What was proven by driving the live app (not a green number).** Following the ninth correction's
> own rule, `app/e2e/tests/macro-link-model.spec.ts` ran against a real `cargo tauri dev` build over
> WebView2 CDP and passed. The decisive assertion is in the user's own words: record a macro writing
> `B16=17171`, add a linking button, **edit the macro to write `28282`** and Save, clear the cell,
> **click the same button → the cell shows `28282`, asserted NOT `17171`.** That is link-not-copy,
> proven, not argued. It also proved: double-click opens the editor on the macro; the editor's Run
> executed the macro into the grid (not idling at "Waiting for a trigger"); deleting a linked macro
> raised the anchor-named warning and Cancel actually cancelled; the orphaned click toasted instead of
> no-op'ing. **Two real bugs surfaced only by execution and were fixed:** (1) the delete "warning" was
> toothless because `window.confirm` under Tauri returns a `Promise` and the code tested `!Promise`
> (always false) — it deleted regardless of Cancel; the same latent bug in `RecordingIndicator`'s
> Discard was fixed too. (2) A cold editor lost its open payload to a fixed-timer race; an
> `EDITOR_READY` handshake now gates delivery, hardening all three open channels (script/draft/macro).
>
> **What the E2E could NOT cover (confirm by hand — most-likely-wrong first):** distribution across a
> REAL publish→subscribe (only the local orphan equivalent and the two Rust warning tests ran);
> run-at-cursor with **two** top-level functions in a live worker realm hitting a breakpoint in the
> cursor's function (jsdom can't run the worker); cross-sheet button→macro links; and undo after a
> run-at-cursor. ~~The double-run flagged by Track A stands as a known cosmetic: a recorded
> single-function macro under the synthetic `workbook` mount runs once at `setup` and again on F5 (end
> state identical for the idempotent writes a recorder emits); left on `workbook` per the settled
> design.~~ **WRONG — see the twelfth entry at the top of this section.** The double-run was a
> real defect downgraded to "cosmetic" by reasoning about the END STATE of an idempotent write
> instead of about what a debugger is for. It was also undercounted: entering the debugger ran the
> macro TWICE before the user touched anything (a plain mount plus the instrumented remount), and
> pressing Run made it three. The user's next report was the exact consequence: *paused at line 6
> with every value the macro writes already in the grid.*

> **Ninth correction (2026-08-03, SECOND human use of the macro recorder) — the fix for the eighth
> correction was declared complete while two of the feature's three entry points still did nothing.**
>
> The eighth correction, directly below, ends with "something has to be exercised by a human before
> SHIPPED". That rule was followed: a human ran it, four bugs were fixed, the suite went green, and
> item 14 was closed a second time. **The same human ran it again and reported the same sentence:**
> *"When I click 'Run' in 'Macros' menu nothing happens. Also nothing happens when I click the button
> that I created along with it."* Of the three ways to execute a recorded macro — send it to a
> notebook, press Run, click the button — **only the notebook worked.** The two the user actually
> reached for were both dead, for two entirely unrelated reasons:
>
> 1. **Run was disabled and styled to look enabled.** The auto-saved module held the object-script
>    flavour, whose stored source *declared* `async function macro1426(api)` and then ended in a
>    **comment** suggesting someone call it. Nothing invoked it, and the module store executes
>    through `run_script` — the Rust QuickJS runtime, whose global is `Calcula.*` and which has no
>    `api` binding at all — so even appending a call would have thrown. The previous round noticed
>    the symptom and "fixed" it by setting `disabled` on the Run button. But `styles.btnPrimary`
>    sets `background`, `color`, `border` and `cursor:"pointer"` as **inline** styles, which
>    override the UA `button:disabled` appearance in every property that would have greyed it out.
>    The control rendered byte-identically to an enabled primary button, with a pointer cursor, and
>    fired no event. **Disabling a control is not a fix for a control that cannot work; it is the
>    same silence with an extra step.**
> 2. **The button ran correctly and the screen never showed it.** `api.setCellValue` and
>    `api.updateCellsBatch` — the only two write ops a recorded macro emits — were the only
>    cell-writing broker handlers in the entire script host that skipped the refresh choreography
>    (`afterCellDataChange` → `refreshGridData()` → the window `grid:refresh` event that is the ONLY
>    thing making `GridCanvas` re-fetch cell data; `app:grid-refresh` merely repaints the cache).
>    The macro ran, the backend updated, the .cala dirtied, and the canvas kept drawing the old
>    values. Aggravating it: a recorded macro replays the exact writes the user had just typed into
>    those exact cells, so even a manual refresh looked like nothing had happened.
>
> **Why the suite could not see either one, stated exactly: every test asserted that the right code
> was produced and stored; not one asserted that running it changed a cell.** The eighth correction
> diagnosed "tests of a pure function say nothing about the feature" and the response was to add
> tests around the *wiring* — codegen shape, store round-trip, seam registration, menu labels. Those
> are still assertions about **artifacts at rest**: the string is correct, the module is saved, the
> provider is registered. The one assertion nobody wrote was the user's actual sentence — *press
> this, and a cell changes.* A test suite can be exhaustive about what a feature **produces** and
> still be completely silent about whether it **executes**. The e2e test that nominally covered the
> button (`button-onclick.spec.ts`) asserted its result with `invoke("get_cell")` — evidence about
> the **backend**, which was never the broken part; it passed throughout, while the screen stayed
> stale. That is §8's own "evidence about the wrong component", one layer up.
>
> **What now works, and how it is known.** Both entry points execute through **one** code path. The
> two object-script wrappers collapsed into a single stored artifact whose `setup(context)` asks the
> context what it is — `context.onClick` present → run on click; absent → `return macro(context.api)`
> immediately — so Run and the button cannot drift apart. Run routes on the stored runtime marker:
> `Calcula.*` modules to `run_script`, `api.*` modules to `runObjectScriptOnce`, a new `@api`
> primitive that mounts the source in a real worker realm, awaits `setup`, and unmounts (the mount
> *is* the run: `hostMountScript` resolves only after `setup` is awaited, and rejects with the
> script's own error). All ten cell-writing broker methods now end in a grid refresh, coalesced to
> one per animation frame so a 10k-write loop cannot flood the canvas.
>
> **This one was verified by driving the real application, not by a green number.** A new e2e spec,
> `app/e2e/tests/macro-recorder-journey.spec.ts`, **was written and RAN against a live
> `cargo tauri dev` build over WebView2 CDP** — nine steps: record, three cell edits (one a
> formula), auto-save, find it in the library, **Run and assert the cleared values come BACK**, add
> a button, **click the button on the real canvas and assert the values come back again**, Design
> Mode ON → the click selects and says so, Design Mode OFF → it runs again. On its **first** run it
> failed at step 6 and found a further real bug: `mountedScriptHasHook` keyed forwarders by the bare
> hook name, so `Controls`' query for `"button.onClick"` always returned `false` and every
> **successful** macro-button click popped a toast accusing the script of never registering a click
> handler — a diagnosis added in this very round to explain silence had started slandering working
> code. Fixed, and the spec passes all nine steps.
>
> **The rules this adds.**
> - **A feature's test suite must contain at least one assertion in the user's own words.** Not
>   "the generated source contains `updateCellsBatch`" and not "`invoke('get_cell')` returns 42",
>   but *press the thing the user presses, then read the thing the user reads.* Everything else is
>   evidence about a component.
> - **Never disable a control as a substitute for making it work.** A disabled control is only
>   honest if it is *visibly* disabled and says why; inline styles routinely defeat the UA disabled
>   appearance, so "I set `disabled`" is not the same claim as "the user can tell". If the refusal
>   cannot be seen and read, the control is still silent.
> - **A stored artifact must be runnable by the runtime it is stored in.** Saving object-script
>   source into the module store — a store whose executor has no `api` binding — produced a file
>   that could only ever fail. Whatever generates an artifact owns the question "which interpreter
>   will be handed this, and does that interpreter have these globals?"
> - **"Fixed" for a multi-entry-point feature means every entry point.** Three ways to run a macro
>   shipped as "the macro recorder works" with one of the three verified. Enumerate the entry points
>   in the status line and mark each one separately.
> - **The second report of the same sentence outranks any test count.** When a user repeats a
>   complaint verbatim after a fix, the correct first move is to reproduce their exact path, not to
>   re-read the code that was just changed.

> **Eighth correction (2026-08-03, first human use of the macro recorder) — 116 passing unit tests
> on a pure codegen function said nothing at all about whether the feature worked.**
>
> Every earlier correction in this sequence is about a *claim* that did not survive re-derivation
> against source. This one is different, and it is worse, because the claim was checked: roadmap
> item 1 was marked SHIPPED on 2026-07-31 backed by **116 green unit tests**, and the code those
> tests covered was genuinely correct. Then a person opened the app, recorded a macro, and hit
> **four bugs in one session**:
>
> 1. "Save as Button Script" produced no button at all (wrong property name, missing geometry and
>    defaults, no floating-store registration — and the backend returned success anyway).
> 2. A debugged script showed "Running" forever with nothing executing (the status was set on
>    *instrumentation ready* and had no terminal state; the UI was lying, there was no hang).
> 3. "Stop Recording" stayed in the menu after recording stopped (`IMenuAPI` had no way to change a
>    registered item's label; re-registering was silently ignored).
> 4. Choosing "Close" in the review dialog destroyed the recording (there was no module to save
>    into, and no surface that would have listed one).
>
> **Not one of the four was a codegen defect, and not one was reachable by any test that existed.**
> The 116 tests all exercised `generateMacroSource`, a pure function: actions in, string out. They
> pinned batching, escaping, locale separators, wrapper shapes and JS syntax validity, and they were
> right about every one of those things. What they could not observe is that the string was handed
> to a control-metadata write with the wrong property name, that the dialog offering to save it had
> no store behind it, that the menu describing the session could not be updated, and that the
> debugger's status field was a different fact from the one it displayed.
>
> **The mechanism.** A pure function is the easiest thing in a feature to test and the least likely
> thing in it to be wrong. Testing it heavily produces a large, green, entirely honest number that
> is *evidence about the wrong component*, and the number is persuasive in exact proportion to how
> irrelevant it is. Three of the four bugs were **seams between two owners** (recorder ↔ Controls,
> recorder ↔ the menu registry, host ↔ realm) and the fourth was a **missing destination** — and a
> unit test of one side of a seam cannot see the other side. This is the same failure §0 already
> names as "dead plumbing", arriving through a new door: not code with no caller, but code whose
> only caller is a test.
>
> **The rules this adds.**
> - **A test count is a claim about a component, not about a feature.** Any status line citing test
>   counts must name *which* component they cover. "116 unit tests" and "the feature works" are two
>   different assertions and this document conflated them.
> - **Every seam needs a test that asserts the OTHER side registers into it.** The fix here ships
>   one (`seamWiring.test.ts` reads `Controls/index.ts` and asserts it registers a provider and that
>   there is exactly one button factory). It is a crude test and it would have caught bug 1.
> - **A status field that is displayed is part of the contract.** Bug 2 was not a hang, a race or a
>   deadlock; it was a string that had never been given a value meaning "done". Any state machine
>   rendered to a user needs its terminal states enumerated in the type, not implied.
> - **"Where does the output go?" is a design question, not a UX polish item.** Bug 4 existed
>   because a feature that produces an artifact shipped without a place to put it. If a feature
>   creates something, the review before SHIPPED must name the store it lands in and the surface
>   that lists it — or say out loud that it is ephemeral.
> - **Something has to be exercised by a human before SHIPPED.** No amount of test discipline in
>   this program found any of these four. Five minutes of use found all four. Where a GUI cannot be
>   driven in the loop, the status line must say which parts were verified only by unit test and
>   which are unverified — and the unverified list must be handed to whoever *can* click.

> **Seventh correction (2026-08-02, Wave K closing pass) — the document was wrong about itself, in
> the one direction that costs the most.**
>
> Every earlier note in this sequence records a *wave report* that did not survive re-derivation.
> This one records **this document**. A dedicated reviewer re-derived every status claim in it
> against source and found **eleven false statements**, all of the same shape and all in the same
> direction: a "verified", "re-verified" or "still missing" claim asserting the ABSENCE of something
> that had already shipped. In order of what they would have cost a reader:
>
> 1. **§7.14 — "no `@uses` pragma parser and no `base.callImport` exist anywhere in the repo."**
>    `app/src/api/scriptLibraries/` ships ten modules including `usesPragma.ts`, and
>    `base.callImport` is an ALLOWLIST row. A reader acting on this row would have rebuilt a shipped
>    subsystem from the design paragraph printed directly beneath it.
> 2. **§5 box — "no publish/pull/subscribe/refresh operation on any script surface and no
>    package-identity read."** `scripting/distribution_gateway.rs`, eleven `cap.pkg*` rows and
>    `context.package` all ship. The claim was stamped "re-verified 2026-08-01".
> 3. **§4 — "`run_script`/MCP `execute_script` construct with `model_provider: None` so even reads
>    throw there."** False for MCP: `mcp/tools.rs` injects a `HostModelProvider` with a `bi.query`
>    grant. §7.13, in this same document, said so correctly — so the document contradicted itself,
>    and the *understating* half is the one a security reader would have believed.
> 4. **§7.6 — "there is no `SUBMISSION_RECEIVED` symbol in the repo."** The symbol is
>    `WRITEBACK_SUBMISSION_RECEIVED`. The verification was a grep for an unprefixed name.
> 5. **§7.5** — two "Missing" bullets, both shipped: `dependencyGraph` is an action of
>    `cap.biModelLineage` (it carries no allowlist row **by design** — dimension (b) of §0's
>    enumeration rule), and Notebook Phase 3 is roadmap item 23.
> 6. **§7.12 — "Scripts are still JavaScript."** `app/src/api/scriptTranspile.ts` ships and item 21
>    of the same list says so.
> 7. **§4 — "exactly 16 kinds"** and a separate bullet asserting "`writebackColumn` is not a gateway
>    kind". `BI_MODEL_SCRIPTABLE_KINDS` has seventeen, including `writebackColumn`.
> 8. **§7 summary table** — seventeen rows for a twenty-five-item list, four statuses contradicting
>    their own item bodies, and a row reading `SLICE 1 SHIPPED`: a fourth status in a
>    three-status vocabulary, which counts as nothing and sorts as nothing.
> 9. **§7.3** — "remain missing (§2.4)" for move/copy sheet and split panes, closed in Wave G.
> 10. **§5 residual** — "`getSubmissionWatchStatus()` still has no UI consumer", with a dangling
>     `(§8)` pointer to an entry that no longer existed. `api/codeInventory.ts` calls it.
> 11. **Footer** — suite totals from before Waves J and K.
>
> **The mechanism, and why it is the same one §0 already names.** Nine of the eleven were produced
> by grepping ONE list — usually `ALLOWLIST`, once a bare unprefixed symbol — and reporting the miss
> as an absence. §0's enumeration rule exists for exactly this, and the rule was not applied *to the
> document itself*: every wave verified its own wave, and nobody re-derived the standing text.
> Note that finding 3 above is a case where the document held both the true and the false statement
> simultaneously, ~370 lines apart, which no amount of grep discipline catches — only re-derivation
> does.
>
> **The rule this adds.** "A status nobody re-derived from code is not a status" already covered
> this. What it did not say, and now does: **a claim of ABSENCE is a claim, and it decays exactly
> like a claim of presence — faster, because nothing in the codebase moves when it becomes false.**
> A shipped feature at least has code that can be read. A "verified absent" line has nothing to
> contradict it but a fresh search. Every such line in this document now carries the date and the
> exact search that produced it, so the next reader can tell a fact from a stale one.

> **Sixth correction (2026-08-02, Wave J verification pass) — the THIRD instance of one bug class,
> and what now makes a fourth impossible.**
>
> "A passive operation creates a TOFU pin" has now been found and fixed **three times, in three
> unrelated subsystems**: Wave H (extension scanning pinned on every launch), Wave I (library
> resolution pinned on preview), Wave J (`.calp` inspection — plus workbook open, refresh, reset,
> writeback submit and *every GATHER recalculation*). Three times is not three bugs; it is one
> design defect. The shared verification function could pin, and pinning was the DEFAULT behaviour
> of merely looking, so every new caller inherited the bug by writing no code at all.
>
> **What makes a fourth instance impossible is a type, not a review.**
> `calp::integrity::verify_and_load_manifest_via` takes a required `PinPolicy` — no `Default`, no
> `Option`, no wildcard match arm — so a caller who does not decide does not compile, and the
> variants are named after the user's decision (`PinOnFirstUse` / `VerifyOnly` / `RequirePinned`)
> rather than after the calling subsystem, which is what let "preview" and "install" drift apart in
> Wave I. Already-trusted callers use `load_pinned_manifest_via`, which returns the manifest with no
> status at all, because ten sites had been binding the trust answer as `_` and continuing.
> Source-level guards fail the build if `PinPolicy` gains a default, if `integrity.rs` gains a second
> pin write, or if a passive/already-trusted module calls the policy-taking verifier directly.
>
> **The two defects this pass found by attacking the fix rather than reading it** are both recorded
> in the closed list below, and both are the *same* lesson at one remove: hardening the primary path
> leaves the bypasses. The org-skin **cache** was a user-writable file applied as `"verified"` with
> no check, which walked straight around the `RequirePinned` gate that had just been added three
> lines above it; and an **unknown** trust status still rendered as the reassuring nothing at the
> point of use, downstream of a map that was genuinely exhaustive. §0's rule generalizes: a status
> nobody re-derived from code is not a status — *and a gate nobody tried to walk around is not a
> gate.*

> **Fifth correction (2026-08-01, Wave I closing pass).** For the first time, **no stage report claim
> failed re-derivation** — all four Wave I reports were accurate about what they had built, including
> their "verified absent" claims, all of which enumerated the five lists. The failures were somewhere
> new: the five lists enumerate what code CALLS, and two of the three defects were about what the
> host HANDS code, or WHICH code the host runs. A `.calp`'s custom-function library mounted with no
> consent at all (§7.19-A) — making three shipped consent strings false — and a package's module
> script could be executed by a package-supplied button (§7.19-B). §0 now carries a seventh
> instruction because of it: when checking "code in a package cannot run unconsented", enumerate the
> PAYLOAD KINDS, not the method lists.

> **Fourth correction (2026-08-01, Wave H closing pass).** The rule held again, and again it cost
> something: three of five Wave H report claims changed when re-derived (§7.18-A, B, C), one of them
> a real capability escape and one a documented feature that could not run. Two more shipped features
> turned out to be unreachable from the UI that owns them (§7.18-D). **What did NOT go wrong that
> time is worth recording too:** every Wave H report enumerated all five reach lists rather than
> grepping `ALLOWLIST`, and every "verified absent" claim in them survived re-derivation. The §0 rule
> was followed; the failures were elsewhere.

> **Third correction (2026-08-01, Wave G integration pass).** This section's own rule — *"a status
> nobody re-derived from code is not a status"* — was applied to all five Wave G stage reports, and
> four claims changed when it was. Two were overstatements in the reports (unsigned add-ins yield
> zero *capabilities*, not zero *contributions*; the sandboxed-extension capability list named three
> ids that surface cannot reach), and two were real fail-open defects the reports did not know about
> (the add-in trust decision, §7.17-A).

> **Second correction (2026-08-01, integration pass).** Wave F's three agent reports each claimed a
> status this section then had to re-derive. Two survived unchanged; three did not: (a) the
> `schedule` mirror defect was FIXED, not open; (b) add-in slice 1 shipped with five
> impersonation/takeover holes still live in the new surfaces, since closed (§7.15); (c) the
> transparency residual was closed in the DATA layer but the panel still printed "Grid-only" for a
> notebook that can be granted BI reach — closed in the UI too.

> **Correction (2026-08-01, same day):** this list originally carried three entries — pivot field
> layout, the `dependency_graph` gateway analog, and non-active-sheet formula parsing — that had in
> fact SHIPPED (`host.ts` `pivot.addField`, `validators.ts` `dependencyGraph`, `commands.rs`
> `parse_script_formula_writes`). They were carried over from the review's §2 rather than re-checked,
> under a heading claiming they had been. Removed. The lesson is the one this whole document exists
> to record: a status nobody re-derived from code is not a status.

**Closed by Wave I**
- ~~**No publish / pull / subscribe / refresh op on any script surface** (§5.5 item 4).~~ —
  **CLOSED.** `distribution.publish` + `distribution.subscribe`, eleven verbs behind one Rust
  gateway, with thirteen further verbs refused as recorded decisions. See the `.calp` scorecard row
  and §7.19.
- ~~**A library import cannot be authorized by CALLER IDENTITY** (§7.18-C).~~ — **CLOSED.**
  `base.callImport`; the 128-bit bearer token is deleted.
- ~~**A library's grant is capped by its consumer's DECLARED ceiling, not by its consumer's GRANTS**
  (§7.18-C).~~ — **CLOSED.** The cap is applied at CALL time against the caller's live grants, and an
  ungranted-but-declared consumer is JIT-prompted with the library named in the prompt.
- ~~**No `.calp` publish path emits `kind: "library"`.**~~ — **CLOSED.** It is a publishable kind,
  and a library publishes ZERO sheets on an empty selection — without that, shipping a function
  library would have uploaded the author's entire workbook to a shared registry.
- ~~**A `cellStyle` contributor reads workbook data with no capability behind it.**~~ — **CLOSED**
  as `grid.read`, which turned out to gate a *second*, undisclosed reader as well (event
  subscriptions to `cell-values-changed` / `edit-ended`, which are not contributions and so never
  appeared in a sidecar or a consent prompt).
- ~~**The engine has no evaluation DEPTH limit.**~~ — **CLOSED.** `MAX_LAMBDA_DEPTH = 256` at the one
  choke point every lambda call funnels through, measured against a 1 MiB thread rather than guessed.
- ~~**Library resolution pins TOFU on PREVIEW, not on install.**~~ — **CLOSED.** Preview verifies and
  never writes the pin store; only `applyInstall` pins, atomically for a whole batch, against an
  install-time identity expectation that travels with the request and is enforced in Rust.
- ~~**The install plan rendered the new `notInstalled` trust status as "verified".**~~ — **CLOSED,
  and it was a false security statement in the UI.** The badge was a ternary
  (`firstUse ? "first use" : "verified"`) inside an unconditionally GREEN pill, so the status Wave I's
  preview/install split introduced — *authentic signature, publisher never trusted by this machine* —
  fell through to **"verified"**. Replaced by a `trustBadge` table with one row per status, an
  unknown-status row that degrades to CAUTION rather than to safe, and
  `ScriptableObjects/__tests__/libraryTrustBadge.test.ts`, which reads `LIBRARY_TRUST_STATUSES` out of
  the Rust source and fails if any status lacks a row, if anything but `verified` uses the word
  "verified", or if the badge and `library_trust_is_pinned` disagree about what "trusted" means.
  Mutation-verified: renaming the `notInstalled` case fails 2 of the 4.
- ~~**`calp_inspector.rs:66` pins TOFU on every inspection.**~~ — **CLOSED (Wave J), and the
  audit found it was 11 call sites rather than the 5 listed here, including two nobody had
  flagged: `core/calp/src/pull.rs:239` reached from refresh/reset, and `core/calp/src/skin_pack.rs`
  reached from the org-skin pull at APP LAUNCH.** The highest-severity site was not the inspector
  at all but `calp_commands.rs::rebuild_writeback_index`, reached from **workbook open**: opening a
  `.cala` that arrived by email pinned a publisher key for every `(package, registry)` pair the
  *file* named, with no user gesture whatsoever.

  Fixed structurally rather than per-call-site, as this entry proposed:
  `calp::integrity::verify_and_load_manifest_via` now takes a **required** `PinPolicy` with no
  `Default` and no `Option`, so a caller that does not think about pinning does not compile. The
  variants name the DECISION, not the caller — `PinOnFirstUse` (the user just chose to trust:
  Subscribe / Install / admin policy), `VerifyOnly` (authenticate and report; writes nothing, ever),
  `RequirePinned` (must run against an existing pin; first contact is `PublisherNotPinned`).
  `library_commands.rs` deleted its policy-aware copy and imports the shared enum, so there is one
  vocabulary instead of three. A sibling entry point, `load_pinned_manifest_via`, returns the
  manifest **alone**: the ten already-trusted writeback/GATHER sites used to write
  `let Ok((_, m))` and carry on, and a site that cannot obtain a status cannot ignore one.
  Subscribe (`calp_pull`) is now the single `.calp` commit point.

  Honest first contact reached the UI with it: `TrustStatus::NotPinned` / `SkinTrust::NotPinned`,
  and the `Verified | FirstUse => Verified` collapse that rendered a first-contact squat as a green
  "verified" badge in the Appearance panel is gone.
- ~~**The org-skin CACHE was an unauthenticated way around the pull's pin gate.**~~ — **CLOSED
  (Wave J verification pass).** Found while attacking the fix above rather than in either report.
  `managed_policy.rs::resolve_skin` step 2 read `%LOCALAPPDATA%\Calcula\skins-cache\<pkg>.json` —
  a **user-writable** path — parsed it, applied it, and returned the literal string `"verified"`
  with no check of any kind. Hardening `try_remote_pull` to `RequirePinned` therefore secured only
  step 1: dropping a plain JSON file into that directory took over the machine's branding under a
  green badge, and because `refresh: "manual"` skips the pull whenever a cache file exists, it could
  do so without the genuine registry ever being consulted. The cache now stores the publisher's
  proof alongside the payload (`<pkg>.json` + `<pkg>.manifest.json` + `<pkg>.manifest.sig`) and
  `calp::skin_pack::verify_cached_skin` re-establishes the whole chain offline against the
  **administrator's** `publisherKey` from admin-only `%PROGRAMDATA%`: signature over the manifest
  bytes, then the payload's SHA-256 against the digest those authenticated bytes name. A cache that
  fails is deleted rather than ignored, and a payload without its proof is not a cache hit at all,
  so it can no longer suppress the pull.
- ~~**An unrecognised trust status rendered as the reassuring nothing.**~~ — **CLOSED (Wave J
  verification pass).** The third variant of the failure mode Wave I hit twice, and the subtlest:
  `SubscriptionManagerPane`'s `TRUST_NOTICE` map *is* exhaustive, and the bug was at the point of
  USE. `verified` is deliberately `null` (the expected case adds no noise) and an unknown status is
  `undefined`; `if (!notice) return null` merged them, so a status the backend gained and the
  frontend had not yet learned rendered exactly like the safe case. `undefined` and `null` are now
  distinguished, with the unknown branch rendering a danger notice.

- ~~**A TOFU pin was keyed by PACKAGE NAME ALONE, so first contact owned the name machine-wide.**~~
  — **CLOSED (Wave K).** The residual left at the end of the Wave J pin-policy work, and the last
  fail-open shape in the `.calp` trust root. `pin_publisher` wrote a flat `packageName ->
  publisherKeyHex` map, which had two consequences and neither was cosmetic. **Squat:** a package
  `acme.finance` served once from `\evil\share` wrote the pin that the GENUINE `acme.finance`
  would later be measured against, so the real publisher's first legitimate release reported
  `publisherChanged` — the accusation pointed at the victim. **Collision:** three namespaces shared
  that one map (report packages, script libraries, registry-published skins), so an administrator's
  `%PROGRAMDATA%` pre-pin silently overwrote a user's pin for the same name.

  The fix is a **key shape** plus a **cross-scope check**, and it needed both. A pin is now
  `(namespace, registry scope, name)`, built only by `PinKey::calp(&RegistryScope, name)` or
  `PinKey::extension(id)` — there is no public constructor taking raw strings, so a call site cannot
  invent a scope, and the `"ext:" + id` string convention is gone. `RegistryScope`
  (`core/calp/src/registry_id.rs`) derives a normalized id from the location string **the user
  configured** — never from the transport, because `managed_policy`'s pre-pin has no transport, an
  HTTP transport's self-report is server-influenced, and the string used to OPEN a registry must be
  the string used to SCOPE it. `calp_registry::open_registry_scoped` hands back the transport and the
  scope together and `open_registry` is private, so the two cannot drift apart.

  Registry scoping ALONE would have traded a loud false alarm for a quiet true miss: a hostile
  registry serving a familiar name would become an ordinary silent first use. So every first contact
  also asks *"is this name pinned in another scope, and to which key?"*. Same key elsewhere →
  `FirstUseKnownPublisher` (a migration, a mirror, or one location spelled two ways). Different key
  elsewhere → `NotPinnedNameConflict` passively, and `CalpError::PublisherNameConflict` from a plain
  `PinOnFirstUse` — an **error**, not a status, because an error cannot be bound as `_` and carried
  on. Only `PinPolicy::PinAcceptingNameConflict`, reachable solely from a UI that displayed both
  registries and both key fingerprints and got a second, differently-worded confirmation, can write
  that pin, and it reports `FirstUseAcceptedNameConflict` so the audit trail never calls it an
  ordinary first use.

  **That cross-check is also what makes an imperfect canonicalizer safe.** `canonicalize` resolves
  junctions, `subst` drives and relative paths, but it fails for a registry that does not exist yet
  or a UNC server that is offline, and it cannot always merge a mapped drive with its target. Each
  of those would be a new scope — and lands in the *same-key* branch, i.e. one redundant pin row and
  a reassuring notice. Never a false hijack alarm, and never a silent accept of a different key.

  **Extension pins stay machine-global, by decision** (`PinKey::extension`, no scope). There is no
  registry; the only candidate scope is the source FOLDER, which is the attacker's own choice, so
  scoping by it would give a bundle dropped in `Downloads` a pristine scope and a free `firstUse` on
  an id it does not own — re-opening the squat Wave H closed — and it cannot be recorded honestly
  anyway because the installer copies the files. `installTrustChain.test.ts` now fails if a
  scope-derived status appears in `EXTENSION_TRUST_STATUSES`, so this is not re-litigated by
  accident. Managed skins gain no namespace of their own: a registry skin IS a `.calp` package, and
  the admin pre-pin writes the exact key the pull reads (`managed_policy` no longer carries its own
  `file://` stripper; `the_prepin_scope_matches_the_scope_the_pull_reads` is the test that catches a
  second canonicalizer).

  Surfaced everywhere the vocabulary already went — six `TrustStatus` variants with one Rust
  wire-string map (`calp_inspector::trust_status_str`; `calp_commands` delegates rather than keeping
  a second copy), rows in `OverviewSection`, `SubscribeDialog`, `SubscriptionManagerPane`,
  `AppearancePage` and `ScriptMarketplace`, and one net-new surface: a **Trusted publishers** section
  in the transparency panel, which is the only place an ACCEPTED name conflict stays visible after
  the dialog is gone.

  **Why this key and not another** (so the next reader does not re-litigate it). *Name-only* refuses
  a cross-registry key substitution but hands the first contact with a name ownership of it on the
  whole machine — the bug. *Registry-scoped alone* removes the squat and the false alarm but makes a
  hostile registry serving a familiar name an ordinary silent first use — the inverse of the
  `NotPinned` / `notInstalled` / `TRUST_UNAVAILABLE` philosophy this codebase has committed to three
  times. The *hybrid* — scoped key plus a mandatory cross-scope name check — is the only one of the
  three with no silent branch, and the check costs one map scan. The scope is derived from the
  location string the user configured because it must be computable offline, before any transport
  exists (the admin pre-pin has none), and because a server-influenced identity is not an identity
  worth pinning to. Origin-only for HTTP is refused: GitHub Pages and S3 routinely serve
  administratively separate registries from one host, and merging them would re-create the very
  substitution name-only keying got right.

  **Two defects found by the adversarial verification pass, both fixed.**
  1. **The `file://` split-view came back through the app crate.** `core` really does have one
     stripper, but ten app-crate sites ran their own `strip_prefix("file://")` on a subscription's
     `registry_url` *before* calling `open_registry_scoped`, handing the scope derivation a
     different string than `pull` had scoped the pin with: `file:///C:/reg` became `/C:/reg` and
     scoped as `\c:\reg`, and `file://server/share` became a path relative to the process working
     directory. The pin was written under one identity and read under another, so `RequirePinned`
     answered `PublisherNotPinned` and writeback, GATHER, model writeback, refresh grouping and
     package HTML export silently went inert for those subscriptions. A pin that is never consulted
     is not a pin, and this failed in the direction that produces no message at all. All ten now
     pass the location through unchanged (or use `calp::registry_id::strip_file_scheme` where a real
     filesystem path is genuinely wanted), and
     `tofu_pin_policy_guard_tests::nothing_pre_strips_the_file_scheme_before_deriving_a_scope`
     fails if a local stripper reappears in any of the eight trust-bearing files.
     `registry_id::a_locally_pre_stripped_file_url_scopes_to_a_different_registry` pins the
     divergence numerically so the shortcut cannot look harmless.
  2. **The cross-scope conflict check could be dodged by re-casing the package name.** The scan
     compared names byte-for-byte, so a hostile registry serving `ACME.Finance` at a user who
     already trusted `acme.finance` produced a plain amber `NotPinned` instead of the red
     two-registries-one-name warning — and on a local (case-insensitive) filesystem registry those
     are frequently the same package. The scan is now `eq_ignore_ascii_case`; `PinKey` lookups stay
     exact, so the loosening can only ADD a warning and can never satisfy a pin it did not create
     (`a_recased_package_name_cannot_dodge_the_cross_registry_conflict` asserts both halves).

  **One over-trust gap closed in the same pass.** `applyInstall` derives `acceptNameConflict` from
  the reviewed plan, but the Script Marketplace's confirm button still said plain **"Install"**, so
  one ordinary click accepted a cross-registry name conflict — including one carried by a
  *transitive* dependency the user never named, whose only warning was a badge partway down a
  capability list. The plan now states the conflict as an aggregate naming the packages, and the
  button becomes "Trust these publishers anyway", matching `SubscribeDialog` and
  `install_extension`'s `acceptPublisherChange`. Guarded by `libraryTrustBadge.test.ts`.

**Still open**
- **Existing `.calp` pins were DISCARDED, so every current subscription re-prompts once.** The v1
  store recorded only a package name, and there is no honest way to infer which registry a pin
  belonged to: the available sources (`registries.json`, subscriptions inside `.cala` files) have no
  package linkage, and a wrong guess would BIND A PIN TO A REGISTRY IT DOES NOT BELONG TO — the
  silent-accept outcome the whole change exists to remove, most likely to be wrong in exactly the
  multi-registry case that motivated it. Extension pins migrate losslessly (`ext:<id>` is the same
  key with the same meaning); everything else is written to
  `trusted-publishers.v1.discarded.json` for the user to audit and nothing reads it. Consequence, by
  design: a subscription reports `notPinned` and its writeback/GATHER stays inert until the user
  re-subscribes — the same user-visible behaviour the entry below already names, reached once more
  at upgrade. Managed installs self-heal (`resolve_effective_policy` re-writes its pre-pin at every
  launch). Deliberately NOT given an upgrade-specific trust status: a state meaning "you upgraded
  once in August 2026" ages badly and would need a row in every presentation map forever.
- ~~**The engine has no evaluation TIME or step budget.**~~ — **CLOSED.** The evaluator was the last
  way to wedge the application; it now has a work ceiling AND a user-reachable stop.

  **Fuel, not a clock.** `core/engine/src/budget.rs` charges a deterministic `EvalBudget`
  (`DEFAULT_CELL_FUEL = 64_000_000`), armed per TOP-LEVEL evaluation, and exhaustion produces the new
  `CellError::Limit` / `#LIMIT!`. Deterministic was a correctness requirement, not a taste: a
  wall-clock budget would make a CELL VALUE a function of machine speed, so the same workbook would
  compute differently on CI and on a laptop and the soak/regression oracles — which compare recalc
  results across runs — would go nondeterministic by construction. So **deterministic work produces
  values; wall-clock produces buttons.** A clock exists on exactly one surface (`api.evaluate` and
  siblings, 5 s, matching `ScriptLimits::DEFAULT_ONE_OFF_TIMEOUT_MS`) because those results cross IPC
  and never enter a cell. `e2e/oracles/calculationBudget.ts` fails the soak run if any generated
  workbook ever produces `#LIMIT!`, and is deliberately not suppressible via the known-issues ledger.

  **Charged in units of WORK, not AST nodes** — `=SUMPRODUCT(A:A,B:B)` is three nodes and a million
  multiplications, so range materialization, array generation and internally-iterating builtins
  pre-charge their element count BEFORE allocating. Bulk pre-charging is also what makes it free: the
  inner loops pay nothing per element, and an over-budget `MMULT` fails in microseconds instead of
  grinding through 8e9 multiply-adds first. Per-formula (not per-pass) scoping is what keeps the
  three motivating cases right: one pathological cell becomes `#LIMIT!` while every other cell
  recalculates, a legitimate 100k-cell recalc completes, and iterative calculation is untouched
  because 32,767 deliberate iterations are 32,767 cheap evaluations rather than one long one.

  **Cancellation is the Ctrl+Break half, and it was a THREADING change.** `calculate_now` /
  `calculate_sheet` became `#[tauri::command(async)]`: a synchronous command runs on the WebView2 UI
  thread, so an `AtomicBool` behind a frozen webview is not cancellation. The `CancelToken` is checked
  on the SAME amortized boundary as the fuel counter (`POLL_INTERVAL = 65_536`), so it costs nothing
  extra. The host checks the token BEFORE writing each result — a formula aborted mid-flight must not
  land a bogus `#LIMIT!` in a cell the user only wanted to STOP.

  **A cancelled pass does not leave silent staleness.** The un-recalculated remainder is recorded
  (`AppState.pending_recalc`), shown as "Calculate", resumed by the next F9, **persisted into the
  `.cala`** (`pending_recalc.json`, `PENDING_RECALC_MIN_FORMAT_VERSION = 3` — it takes a link in the
  stamp chain precisely because a reader that silently DROPPED it would turn a knowingly-stale
  workbook into one that claims to be calculated), and hard-refused by `.calp` publish.

  **Two adversarial findings closed during integration, both on the axis fuel cannot see.**
  (1) String growth: `&` doubles a string in ONE node and ONE charge, so
  `=LET(a,REPT("x",1024), b,a&a, c,b&b, ...)` reached a terabyte in ~90 charges against an allowance
  of 64,000,000 — six orders of magnitude short of noticing, and the process was gone before any
  charge could be examined. `MAX_TEXT_LEN` now guards `&`, CONCAT/CONCATENATE and TEXTJOIN (whose
  length check ran AFTER the join that would have done the damage). (2) Error laundering:
  `EvalResult::as_text` rendered errors as RUST VARIANT NAMES, so `=LEN(1/0)` answered 4 and a
  budget-stopped formula came back as the plausible number 5. There is now one authority —
  `CellError::as_literal` / `from_literal` — shared by display, the UDF wire format and persistence,
  which also fixed a real data-loss bug: `SavedCellValue::to_value` had been mapping EVERY saved
  error to `#VALUE!`, so `#DIV/0!`, `#N/A`, `#REF!`, `#CIRCULAR!` and `#BLOCKED!` all came back wrong
  from a save/reload round trip.

  **Measured, not asserted.** `core/engine/benches/grid_engine.rs` group `budget` runs each workload
  twice over identical input — `Evaluator::unmetered` (the meter disabled through its OWN
  `BudgetPolicy`, charges still compiled in and executed) against `Evaluator::new` as shipped — under
  `profile.bench`. Median of three rounds on a Snapdragon X Elite (12 cores, Dropbox and Defender
  running, so the noise floor is ~0.5-1%):

  | workload | metered vs unmetered | threshold |
  |---|---|---|
  | 100k x `=A1*B1+C1-D1/E1` (worst case for a per-node counter) | −0.50% | ≤3% |
  | 100k-formula mixed recalc (arithmetic / SUM / IF / VLOOKUP) | −0.08% | <1% |
  | `=SUMPRODUCT(A1:A1000000,B1:B1000000)` | +0.08% | <0.5% |
  | `=SUM(A:A)` over 1M rows | −0.22% | <0.5% |
  | 10k VLOOKUP over 100k rows under a lookup pass | +0.20% | <1% |
  | recursive-LAMBDA `fib(24)` | −0.05% | <2% |

  Every case is inside its threshold and **no case shows a resolvable regression** — several medians
  are negative, which means the true cost sits below this machine's noise floor rather than that the
  meter is free. Calibration, reported rather than gated: burning the whole `DEFAULT_CELL_FUEL`
  takes **3.53 s** under `profile.bench` (~18M charges/s), which is the "a few seconds of felt work"
  the constant claims; `consumed` stops at 64,000,020, i.e. tight against the allowance.
  Collateral damage is pinned by its own test — `=SUM(MAP(A1:A500000, LAMBDA(x,x*2)))` and a
  1M-element SUMPRODUCT complete exactly, each using under half the allowance.

  Wiring: 18 `Evaluator` construction sites and 22 consumer entry points, declared once per surface
  by an ambient governor (`app/src-tauri/src/eval_budget.rs`) that can only TIGHTEN — the engine
  installs the ceiling unconditionally in `Evaluator::base`, so a site nobody remembered still gets
  `DEFAULT_CELL_FUEL` and the worst case of a missed site is a missing Cancel button, never a wedge.
  No production code anywhere names `unmetered`. Suites: core workspace 1,136 (engine 466), app-lib 812, vitest 104,248.
- **A workbook that names an unpinned subscription shows inert writeback and empty GATHER**
  until the recipient subscribes themselves. This is the *intended* fail-closed consequence of the
  Wave J fix above, not a defect, and the Subscriptions pane names it with a "not trusted on this
  computer — use Data → Subscribe to Package" notice. Listed here because it is a real user-visible
  behaviour change that support will hear about, and because the affordance is a notice rather than
  an in-place "subscribe now" action.
- **The org-skin trust root is the administrator's `publisherKey`, so a policy that omits it gets
  no skin at all.** Correct (nothing else can vouch for the key), surfaced as `policyError` rather
  than a silent nothing — but it means an existing managed install that relied on the old
  pin-whatever-the-registry-serves behaviour must add `publisherKey` to `policy.json`.
- **A scripted publish does not collect frontend-provider custom objects.** The caller may not supply
  them and the providers live in the renderer. Disclosed, not dropped silently: every scripted
  publish response carries `SCRIPT_PUBLISH_PAYLOAD_NOTE` in `warnings`.
- **Sandboxed extensions have no door to the `cap.pkg*` family** (deliberate v1 decision, test-pinned).
  An extension's code lives outside the per-file code inventory, and chaining "un-inventoried add-in"
  → "pulls more third-party content" is not a risk worth taking yet. Reopening it means adding
  `cap.pkg*` rows to `EXTENSION_BROKER_METHODS` and re-deriving the extension-worker taxonomy row.
- **A package's module scripts cannot be consented at all** — they can only be refused (§7.19-B).
  The gate is correct and fail-closed, but there is no path to "yes" for a publisher who legitimately
  wants a helper module behind a button. The sanctioned shape is an object script, which is why this
  is a documented limit rather than a defect; making modules consentable means adding them to the
  ScriptableObjects consent view, which is a change to a mature security flow.
- **`onBeforeDoubleClick` / `onBeforeRightClick`** exist on no surface (§2.10) — re-verified absent
  across all five lists (zero occurrences of either identifier anywhere in `app/` or `core/`).
- **A UDF body still receives values, never a Range object.**
- **Picker-mediated import caps size *after* the read.** There is no stat-before-read command, so a
  user who picks a 2 GB file causes a memory spike before the refusal. Only the user can trigger it
  (the script cannot name the file), so it is a self-inflicted hang, not a script capability.
- **`LibraryUpdateStatus.publisherKeyChanged` is effectively unreachable**: a real key change makes
  the backend *error*, so `checkUpdates` records `status.error` and never compares keys. Decide
  whether to keep it as a belt-and-braces field or surface the error as a first-class status.

**Deliberately deferred (not defects)**
- **Cross-workbook scripting / personal macro library** (§6.5) — a new consent question, not wiring.
- **Headless / wake-from-closed scheduling** — explicitly out of scope for the `schedule` capability.
  The consent string says "while Calcula is open" and the code must never quietly grow past it.
- **Task panes / panels / custom cell editors** — need a host-rendered component surface
  (`ExtensionPanelHost`), and **file-format export** needs a data-only export contract or a
  capability that names whole-workbook read.
- **OS clipboard read and write**, and **sending to a real printer** — refusals with reasons (§6.6),
  not gaps.
- **`open` / `close` / `new` workbook from a script** — refused by design: Calcula holds one
  document, and a picker click means "open this file", not "let this running script read it".

**Transparency residual — CLOSED**
- ~~The `codeInventory` "reach" claim for grid-only surfaces is ASSERTED, not verified against the
  interpreter.~~ It is now derived: `core/script-engine/src/manifest.rs` enumerates the real QuickJS
  surface and diffs it against `OP_MANIFEST` both ways,
  `without_a_model_provider_every_model_op_throws` proves the "grid-only" claim behaviourally rather
  than asserting it, `api/codeInventory.ts` mirrors the result, and
  `api/__tests__/interpreterReachDrift.test.ts` reads the Rust source so the mirror cannot drift.
  **Reopened and re-closed 2026-08-02 (§7.20 dimension 3), and the re-closing is the interesting
  part.** The derivation above was real, but it read a hand-asserted `model_provider` flag, and that
  flag was FALSE for `mcp-tool` while `mcp/tools.rs` injected a provider — so all four mirrors agreed
  perfectly on a lie and every guard passed. Two things changed: `SurfaceProfile` gained a `granted`
  list so `surface_ops()` filters on the real grant (`model.sql` is now correctly excluded from
  `mcp-tool`, which holds `bi.query` only), and a new source-level guard resolves each profile's
  declared `entry_point` to a real file and diffs `HostModelProvider::new` against the flag. Only
  three surfaces are grid-only; `mcp-tool` is not one of them.
- Related hardening in the same area: the writeback-validator harness deletes **every** host global
  the interpreter registers. `ROOTS_LEFT_UNDELETED` is now empty and the test fails if it ever needs
  an entry again.

---

## 9. Closing statement — where Calcula exceeds VBA, and where it still trails

Written plainly, because the point of this document is that someone can act on it without re-reading
the code.

### Where Calcula now EXCEEDS VBA

1. **Containment.** VBA runs with the user's full machine authority — filesystem, network, COM,
   shell — and there is no smaller setting. Every Calcula script runs in a hardened worker realm or
   an isolated Rust QuickJS interpreter with no DOM, no Tauri and no ambient network; every
   privileged call is broker-mediated against a **declared ceiling** the script cannot widen, and the
   ones that reach the backend are re-checked authoritatively in Rust. "Enable macros" was a single
   yes/no over unlimited power; Calcula's equivalent is **16** named capabilities, each consented for
   a named script, each revocable.
2. **Transparency.** VBA code hides inside a binary workbook, and the honest answer to "what is in
   this file?" required a third-party tool. Calcula's "Code in This File" panel enumerates every
   executable unit across ten surfaces — including code the user never typed: distributed package
   scripts and imported libraries — each with its ceiling, its live grants, its residence and its
   full source. The Rust-QuickJS surfaces' reach is *derived from the interpreter's own op registry*,
   not asserted in a comment.
3. **Auditability.** VBA had none. Calcula has a per-workbook audit trail spanning every script
   surface (grid mutations recorded always-on, capability calls persisted authoritatively
   server-side for the backend-reaching ones), plus a machine-scoped add-in install trail.
4. **Interception primitives VBA never had.** `range.onBeforeCommit` (a per-range veto on a cell
   edit) has no VBA analog. `onBeforeSave`/`onBeforeClose` verdicts are bounded and default-ALLOW, so
   a script cannot hold a user's document hostage — which `Workbook_BeforeSave` absolutely can.
5. **Distribution and reuse.** VBA's answer to "share this code" was "email the workbook"; its answer
   to "reuse this code" was "copy the module, or reference another file and inherit its whole trust".
   Calcula has signed `.calp` packages with per-source-hash consent on **every** code-bearing payload
   kind, and a signed, version-pinned, ceiling-intersecting package manager for libraries whose call
   authority is caller identity rather than possession of a token.
6. **Model automation.** Scriptable semantic-model authoring (measures, contexts, lineage, batched
   one-undo-step edits) is something neither VBA nor Power BI offers in-product.
7. **Scheduling with a revocable grant.** `Application.OnTime` was ungoverned; `schedule` is
   Rust-re-checked **on every firing**, so a revoke stops a job already persisted in the file.
8. **A publish/subscribe loop a script can drive without becoming a propagation vector.** A script
   can pull, refresh and publish — and a script that ARRIVED in a package can do none of it, because
   every `cap.pkg*` row is unlocked-tier and `calp::pull` forces pulled scripts to restricted. The
   bound is structural; no consent prompt can grant past it. VBA's equivalent — a macro that writes
   another macro into another workbook — was the mechanism of every macro virus ever written.
9. **A bounded evaluator, and a Ctrl+Break that is better than Ctrl+Break.** This used to be a
   TRAILS entry: nothing bounded a shallow exponential (`fib(35)` as a naive recursive LAMBDA) or a
   very wide array formula, and VBA at least had Ctrl+Break. Both halves are now closed, and the
   second one improves on the original. The budget is a DETERMINISTIC fuel counter, so a runaway
   formula stops at the same place on every machine and becomes `#LIMIT!` in the one offending cell
   while the rest of the workbook recalculates normally — where VBA's Ctrl+Break stopped everything
   and told you nothing about where. Cancellation is a real button rather than a keyboard poll,
   which required moving recalculation off the UI thread; a flag behind a frozen webview would not
   have been cancellation at all. And a cancelled pass does not quietly leave a half-calculated
   document: the un-recalculated remainder is recorded, shown as "Calculate", resumed by the next
   F9, carried into the saved file, and refused by `.calp` publish. VBA's answer to "you stopped
   half way" was silence.

### Where Calcula still TRAILS VBA

1. **The UI object model.** VBA can build UserForms, custom task panes and command bars. Calcula
   scripts get a declarative dialog spec painted by trusted host code, and sandboxed extensions get
   no component surface at all. This is a deliberate trade (pixels are authority), but it is a real
   capability VBA has and Calcula does not.
2. **The machine.** No filesystem, no shell, no COM, no arbitrary process. `file.picker` is a
   *human* choosing one file. A VBA macro that post-processes a folder of exports has no Calcula
   port, and by design never will.
3. **Cross-workbook work.** VBA's `Workbooks.Open` and a personal macro workbook make multi-file
   automation routine. Calcula holds one document and refuses `open`/`close`/`new` from a script;
   there is no personal macro library. §6.5.
4. **Two event hooks.** `onBeforeDoubleClick` / `onBeforeRightClick` exist on no surface.
5. **Range objects in UDFs.** A Calcula UDF receives values; a VBA UDF receives a `Range` and can ask
   it about addresses, formats and formulas.
6. **Headless execution.** VBA can be driven by an external host with Excel invisible. Calcula's
   `schedule` runs only while Calcula is open, and the consent string says so.

**The one-line verdict.** Calcula's scripting is now *functionally comparable* to VBA for everything
that happens inside one spreadsheet — reading, writing, formatting, structuring, charting, pivoting,
filtering, modelling, scheduling, prompting, packaging, publishing and debugging — and *categorically
better* on containment, transparency, audit, consent and distribution. It remains behind on
everything that reaches **outside** the one open document: the machine, other workbooks, custom UI
surfaces, and headless operation. Three of those four are refusals with reasons rather than gaps;
custom UI surfaces are the one genuinely unfinished frontier.

**And one closing note this program earned the hard way.** Nine waves in, the defect that mattered
most was not a missing feature or a weak check — it was a payload kind nobody had listed. Every
enumeration in this document is a list of things somebody thought to write down. The gates were
right on four of five reserved-library surfaces; the fifth was missed because no list contained it.
When the next wave asks "is this property true?", the useful question is not "does the check exist?"
but "what is the complete set of things the check must cover, and where is that set written down?"

---

## 10. Wave K — the review of the program itself (2026-08-02)

**Why it ran.** Every one of the nine implementation waves shipped with its own adversarial verifier,
and between them those verifiers found about twenty real holes — an unconsented `.calp`
custom-function library, a signature that did not cover the signed code, an unreadable pin store
reading as `verified`, library realms laundering `net.fetch` origins, a user-writable cache returning
the literal string `"verified"`, unbounded text growth reaching a terabyte in ninety fuel charges.
That work is finished, and re-running it would only repeat it. But **each verifier checked its own
wave in isolation**, so three whole classes of defect had no owner: something Wave *n* established
and Wave *n+k* quietly stopped honouring; something true of the code but false in this document; and
something wrong with the *guards themselves*.

**What it checked — seven dimensions, one reviewer each.** Cross-wave invariant erosion · program
record versus code · drift-guard efficacy (guards that pass without testing anything) · consent-text
honesty (what the dialogs promise versus what the code enforces) · what the host HANDS code and
WHICH code it decides to run · features with no production caller · fail-closed discipline and
hot-path cost. Findings and evidence are in §7.20; the eleven false statements about this document
are the seventh correction note in §8.

**What it found, in one line each.**

| Class | The finding that mattered most |
|---|---|
| Invariant erosion | The QuickJS apply path wrote to **non-active sheets** with no writeback-draft check — the Wave C invariant's own contract comment listed the paths and this one was not on it |
| Guard efficacy | Four mirrors agreed perfectly that the MCP surface is grid-only; it injects a BI model provider. Every guard passed |
| Consent honesty | "Scripts cannot read or write arbitrary cells" — the whole `sheet.*` family is `restricted` |
| What the host hands | An add-in with **zero capabilities** received the workbook's full filesystem path |
| No production caller | `mcp:script-draft` had no listener; the AI was told the draft was "queued for review" and nothing rendered it |
| Fail-closed | Trust evaluation caught an inventory error, substituted an empty code list, and **auto-granted** |
| Fail-closed | A present-but-unparseable `.cala` sub-file made the new workbook inherit the **previous** one's subscriptions |
| Hot path | GATHER did blocking, signature-verifying, 30-second-timeout registry I/O **inside every cell edit** |
| Outside the seven | `core/pivot-engine`'s benchmark had 24 compile errors, invisible because CI's bench gate named one crate instead of the workspace |

**What was fixed.** All of the above, plus the smaller ones in §7.20, plus the eleven document
statuses. Each fix carries a test that was verified to FAIL without it, and the two root causes were
fixed as mechanisms rather than instances: the writeback guard now runs from the shared pre-mutation
path instead of relying on a hand-kept list of callers; `SurfaceProfile` gained a `granted` list and
a source-level guard that resolves each profile's entry point to a real file and diffs
`HostModelProvider::new` against the declared flag; the four corrupt-file sites were restructured as
`match` arms so the compiler enforces what review did not; and the CI bench gate is now
`--workspace --benches`.

**What was deliberately left, and why.**

- **Three confirmed-dead items** — the `ext.log` broker row, three unused `@api` exports, two unused
  `AppEvents` constants. Confirmed dead, zero user consequence, and one of them is pinned by an
  API-surface-stability test, so removal costs a test edit to buy nothing. Priced, not missed.
- **Two allowlist rows a reviewer called dead were REFUTED**, and must stay: `api.onEvent` is the
  consent text the transparency policy table renders for `events.subscribe`, and
  `object.declareProperties` is the allowlist face of an aspect-dispatched op. Both are named,
  reasoned exemptions in the coverage guard. Deleting them would delete user-facing consent text.
- **The "bound sheet" clamp was reworded rather than implemented**, because it cannot be
  implemented: `sheet` is a primitive object type with a null `instanceId` by design, so there is no
  bound sheet to clamp to. Inventing one to make a sentence true would have been worse than fixing
  the sentence.
- **The pin store is still read once per subscription, not once per rebuild.** Caching it across a
  multi-second registry walk would mean a pin written mid-walk is not seen, and both loops are now
  off the interactive path, so the optimisation buys latency that no longer matters at the cost of a
  staleness window in a security check.
- **A wall-clock edit-latency benchmark was not written.** It would need a genuinely unreachable host
  and a 30-second CI timeout. The deterministic structural equivalent shipped instead — a test
  proving `build_gather_data` serves from cache past its TTL and therefore cannot reach the I/O path
  at all. This substitution is recorded rather than presented as the benchmark.

**The one thing this pass would tell the next one.** Six of the seven dimensions found real defects,
but the two that found the *worst* ones were the two that were not about code at all: "what does the
host hand code that it never asked for", and "is the document telling the truth". A program that
audits only what code calls will keep shipping both. The gates in this system are, on the evidence
of nine waves, largely correct — what fails is the enumeration of what the gates must cover, and the
record of what is already done.

---

*Full agent outputs (per-surface API enumerations with file:line evidence, per-dimension VBA coverage
grids, 48 verified gap verdicts) were produced in the 2026-07-31 review session. Closing statuses were
re-verified against the code on 2026-08-02, most recently during the Wave K pass (§7.20, §10), which
audited the seven dimensions no wave verifier owned — including this document, in which it found
eleven false "verified absent" claims (seventh correction note, §8).*

*Verification behind this revision (Wave K, all run 2026-08-02, exit code 0 for every command):
`npm run check-types` clean · `npm run lint:boundaries` clean · `npm run check:script-typings`
`[OK] 39 interfaces verified, 545 members probed` · `npx vitest run` **104,339 passed / 0 failed
across 640 files** · `cargo check --workspace --benches` clean in `core` and `cargo check --lib
--tests` clean in `app/src-tauri` (pre-existing warnings only) · `cargo test --workspace` in `core`
**1,143 passed / 0 failed** across 21 test binaries, of which the `engine` evaluator suite is **466
passed / 0 failed** · app-lib Rust suite **837 passed / 0 failed** (built with `cargo test --lib
--no-run`, `fix-test-manifest.ps1`, then run directly) · `cargo check -p pivot-engine --benches`
clean, which it had not been for an unknown number of weeks.*

*Counts against the previous revision's recorded baselines — a DROP is treated here as suspicious as
a failure, so both directions are accounted for: core 1,136 → **1,143** (+7: three new
`script-engine`/`calp` guard tests from this pass, plus a four-test gap that predates it and is
reported rather than explained away); app-lib 812 → **837** (+25, all new tests from this pass, each
verified to fail without its fix); vitest 104,248 / 631 files → **104,339 / 640 files** (+91 tests,
+9 files); `engine` 466 → **466**, unchanged, as expected for a pass that did not touch the
evaluator; script typings 39 / 545 → **39 / 545**, unchanged, confirming the regenerated
`objectContexts.d.ts` matches its template.*

*One drift guard was deliberately broken to prove it still bites — the one this pass found passing
vacuously. Setting `model_provider: false` back on the `mcp-tool` row of
`core/script-engine/src/manifest.rs` fails three Rust tests in `manifest.rs` and three TypeScript
tests in `api/__tests__/interpreterReachDrift.test.ts`, and the messages name the fix rather than
the symptom: "app/src-tauri/src/mcp/tools.rs … CONSTRUCTS a HostModelProvider, but SURFACE_PROFILES
records model_provider: false for 'mcp-tool' … the user is told the surface cannot reach their BI
model while it can. Set model_provider: true (and give it a truthful `granted` list), or remove the
injection." Restored and re-verified green.*
