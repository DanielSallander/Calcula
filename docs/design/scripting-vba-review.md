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

Statuses below were re-verified against the code on 2026-08-01, not carried over from wave reports.

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
| Security model | ✅ Beyond VBA | ✅ Beyond VBA | QuickJS wall-clock deadline + memory cap (`core/script-engine/src/limits.rs:118,173`). **16-capability** vocabulary (`capabilityIds.ts:192-209`, mirrored `core/persistence/src/lib.rs:1343` as a compile-time-sized `[&str; 16]` that is also `include_str!`-diffed against the TypeScript source). Wave G added `file.picker` and `ui.shortcut`; **Wave I added three**: `grid.read` (the host-PUSH capability — see the Add-in row), `distribution.publish` and `distribution.subscribe`. The engine also gained a real recursion ceiling: `MAX_LAMBDA_DEPTH = 256` at the single choke point every lambda call funnels through (`core/engine/src/evaluator.rs:474,6171`), measured against a 1 MiB thread rather than guessed, and the one nested-`Evaluator` site (`eval_3d_ref`) now inherits the depth instead of resetting the budget. **What did not hold, and had to be fixed:** a `.calp`'s custom-function library ran with no consent at all (§7.19-A) and a package's module script could be executed by a package-supplied button (§7.19-B). Both are closed and both are now the reason §0 carries a seventh audit instruction.
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
14. ~~**Macro recorder regressed to dead plumbing.**~~ **CLOSED 2026-07-31** — rebuilt as the
    `MacroRecorder` extension with bridge-level capture, CommandRegistry capture and
    "save as button script". The orphaned `setCellRecorderHook` is gone, replaced by
    `setGridRecorderHook` with a real caller. See roadmap item 1 in §7 for the shipped scope.

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
| **Mutation of exactly 16 kinds** — measure, calcColumn, relationship, hierarchy, kpi, calcGroup, perspective, culture, scriptFunction, calculatedTable, tableVariable, context, contextColumn, metadata, dateTable, extensionData | `caps.biModel.upsert/delete` → `script_bi_model` gateway: Rust re-checked grant, 30 mutations/min, package-subscribed models rejected, rides `apply_model_edit` (user-undoable, audited, attributed `source:"script"`) |
| Script-fed data sources (`script:*` InMemory connectors, 500k rows/feed, server-side secret injection) | `caps.connector.register/remove` + `caps.fetch` secretHeader |
| Model events (thinned payloads) | `BI_MODEL_CHANGED` / `BI_REFRESH_COMPLETED` via `api.onEvent` (unlocked tier only) |

### What NO script can do (host surface is 76 `bi_model_*` commands)

- **RLS**: create/edit/delete security roles, switch active role ("view as") — excluded by design. ✅ Correct posture.
- **Sources/connections/credentials** — excluded by design. ✅ Correct posture.
- **Storage mode / refresh policies / force table refresh** — no scriptable `RefreshAll` analog (auto-refresh side-channel + own connector feeds only).
- **Model undo/redo/atomic batch** — script mutations land one-by-one on the user's undo stack; the trusted CLI gets one-undo-step batches, scripts don't.
- **Writeback column definition** (`writebackColumn` is not a gateway kind) — see §5.
- **Table/column property edits, table delete/rename** (`update_table/update_column/delete_table`).
- **Diagnostics**: validate/validate_measure, dependency_graph, measure_lineage, test_query — a
  script authoring measures must mutate-and-parse-the-error instead of pre-validating.
- **Notebook/MCP/one-off mutation**: notebook `model.*` is read-only by contract (documented
  anti-goal); `run_script`/MCP `execute_script` construct with `model_provider: None` so even reads throw there.

### Governance inconsistency found (fix regardless of roadmap)

~~**Notebook `model.info` returns the FULL `BiModelInfo` including `security_roles` metadata**~~ —
**CLOSED.** `HostModelProvider::model_info` now runs the same `sanitize_model_info` projection the
worker gateway uses, with the reasoning written into the code and a regression test
(`bi/script_provider.rs:193-215`, `sanitized_model_info_drops_security_roles`). The same `bi.query`
grant no longer means "more" in a notebook cell than in an object script.

~~Also: **connector scheduled refresh dies with the session**~~ — **CLOSED.** The connector's
`refreshEverySecs` is now adopted by the persistent scheduler as a `surface: "connector"` job
(`api/scriptConnectors.ts:157`), so the two schedulers agree on one 30s floor instead of two.

**Still open in §4:** storage mode / refresh policies / force table refresh (no scriptable
`RefreshAll`), table/column property edits and table delete/rename, writeback column definition as a
gateway kind, and notebook `model.*` remaining read-only by contract (a documented anti-goal, not a
gap). Model diagnostics are no longer in this list — `cap.biModelValidate` and `cap.biModelLineage`
ship, and script mutations can now be batched into one undo step with `cap.biModelBatch`.

---

## 5. .calp distribution + writeback — script coverage answer

> **CLOSING STATUS (2026-08-01): "zero" became "half".** The `distribution.writeback` capability
> ships the COLLECTION loop on both sides — `cap.writebackListRegions`, `getLayer`, `saveDraft`,
> `preview`, `submit` for contributors, and `listSubmissions`, `review` for publishers (gated on
> Ed25519 possession), Rust-enforced in `scripting/writeback_gateway.rs` with grant re-check, rate
> buckets and audit. Numbered items 1, 2, 3, 7 and 8 below are CLOSED. **Item 5 closed in Wave G**
> (see below). **Items 4 and 6 are not:** re-verified 2026-08-01, there is still no
> publish/pull/subscribe/refresh operation on any script surface and no package-identity read. The
> original text is kept below because it explains WHY each hole mattered; read it with those
> verdicts applied.
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
> to a minute, not an instant"), nothing is noticed while Calcula is closed, and
> `getSubmissionWatchStatus()` still has **no UI consumer** — the disclosure exists as an API, not
> yet as something the user can read (§8).

The host surface is 68 Tauri commands (54 calp_commands.rs + 8 inspector +
3 registry + 3 bi_writeback) plus the trusted `@api/distribution` layer. The broker allowlist, the
QuickJS op modules, the 21 MCP tools, the 3 scriptSafe commands, the Model Editor CLI verb set,
and the 8-capability vocabulary contain **no publish, pull, subscribe, submit, draft, review, or
registry operation**. Script reach is three indirect paths: `bi.query` over writeback datasets IF
the user manually imported them as model tables, reading cells that GATHER aggregates into, and
the thinned `BI_REFRESH_COMPLETED`/`BI_MODEL_CHANGED` events.

The vision's flagship workflow — two-way data collection replacing emailed workbooks — is currently
**less automatable than the VBA workflow it replaces**:

1. **Contributors cannot script the collection loop** — no draft/save/submit API on any surface.
2. **Worse: silent bypass.** An unlocked script's `api.setCellValue` into a writeback region skips
   draft capture entirely (the capture lives in a commit guard run only by the interactive editor)
   — no schema check, no validator, grid diverges from the writeback layer until reconcile.
   Neither a usable automation path nor cleanly blocked. **This is a defect, not just a gap.**
3. **Publishers cannot script review** — auto-approve-in-policy / notify-on-reject loops (trivial
   VBA macros) are impossible; `calp_set_submission_state` is trusted-UI + Ed25519 only.
4. **No publish/pull/refresh automation** — no scheduled or CI-style publishing; the CLI has zero
   distribution verbs.
5. ~~**No lifecycle events for scripts**~~ — **CLOSED for submission-received** (see the boxed note
   above); `calp:scripts-pulled` remains deliberately excluded from SCRIPT_SUBSCRIBABLE_APP_EVENTS,
   and **review decisions still have no event** — deliberately, since a publisher's own click is
   not news to the publisher.
6. **Distributed scripts get no package-awareness** — a script shipped in a .calp cannot ask its
   package/version, so publisher-built interactive collection experiences can't be package-adaptive.
7. **Writeback validators cannot be distributed as code** (name-only metadata; sandbox already
   solved distributed-code trust for object scripts, validators never got it).
8. **Writeback columns are not a bi.model gateway kind** — a script can build a whole model but not
   its data-collection schema.

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
2026-08-01.** Summary: **11 SHIPPED, 4 PARTIAL, 2 DEFERRED.**

| # | Item | Status |
|---|---|---|
| 1 | Macro recorder | SHIPPED |
| 2 | Bulk typed range I/O + undo everywhere | SHIPPED |
| 3 | Formatting + structural ops | SHIPPED |
| 4 | Writeback automation capability | SHIPPED |
| 5 | Models finishing loop | PARTIAL |
| 6 | Distribution lifecycle events + package-aware scripts | PARTIAL |
| 7 | `ui.dialog` capability | SHIPPED |
| 8 | Cancellable Before\* hooks + bus events | SHIPPED |
| 9 | QuickJS interrupt/timeout/memory budget | SHIPPED |
| 10 | Host-side persistent scheduler | PARTIAL |
| 11 | Sandboxed distributable writeback validators | SHIPPED |
| 12 | d.ts codegen + TypeScript compile | PARTIAL |
| 13 | MCP as automation co-author | SHIPPED |
| 14 | Script package manager | DEFERRED (designed) |
| 15 | Add-in authoring answer | SLICE 1 SHIPPED |
| 16 | Trusted-workbook consent persistence + Settings UI | SHIPPED |
| 17 | UDF fixes | SHIPPED |

1. ~~**Resurrect the macro recorder**~~ **SHIPPED (2026-07-31)** — as its own extension,
   `app/extensions/MacroRecorder/`, registered in `extensions/manifest.ts` after ScriptNotebook
   (whose Developer menu it contributes to).
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
   - **The loop is closed:** "Save as Button Script" creates a button control at a chosen cell,
     saves an unlocked `objectType: "button"` script bound to the anchor-derived
     `control-<sheet>-<row>-<col>` id, and mounts it — one click replays the macro. "Add as
     Notebook Cell" appends a cell via an `@api/lib` event channel (siblings never import each
     other). A status-bar indicator with Pause/Stop/Discard makes a running recording
     unmissable; Ctrl+Shift+R toggles.
   - Tests: 111 unit tests (`extensions/MacroRecorder/__tests__/`) — the generator is a pure
     function and is pinned across batching, sheet switches, quoting/escaping, locale-sensitive
     values, command capture, wrappers and JS-syntax validity.
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
   remain missing (§2.4).
4. **Writeback automation capability** (`distribution.writeback`) — **SHIPPED.** Seven methods on
   both the object-script and extension-worker surfaces: `writebackListRegions`, `writebackGetLayer`,
   `writebackSaveDraft`, `writebackPreview`, `writebackSubmit` (contributor) and
   `writebackListSubmissions`, `writebackReview` (publisher, gated on Ed25519 possession). Enforced
   in `scripting/writeback_gateway.rs` with grant re-check, rate buckets and audit. The silent
   draft-capture bypass is closed by `scriptHost/writebackWriteGuard.ts`, which every script write
   target passes first (`host.ts:2195`).
5. **Models finishing loop** — **PARTIAL.** Shipped: `cap.biModelValidate`, `cap.biModelLineage`,
   `cap.biModelBatch` (script mutations as one undo step), and the notebook `security_roles` info
   leak closed with a regression test (§4).
   **Missing:** a read-only gateway analog for `dependency_graph` — `bi_model_dependency_graph`
   exists as a host command (`bi/model_editor.rs:1075`) and even has a sanitizer
   (`sanitized_dependency_graph`, `:5542`), but no `cap.biModel*` allowlist row reaches it, so a
   script can validate a measure and trace its lineage but cannot see the graph. Notebook Phase 3
   ("Test in notebook") was not started.
6. **Distribution lifecycle events + package-aware scripts** — **PARTIAL.** Shipped:
   `AppEvents.PACKAGE_UPDATED` (thinned to `{packageName, version}` for sandboxed subscribers,
   `allowlist.ts:379-388`) replaced the untyped `calp:scripts-pulled` window event, and
   `context.package` is seeded from the mount spec (null for local scripts).
   **Missing: submission-received still does not exist as an event on ANY surface** — verified
   2026-08-01, there is no `SUBMISSION_RECEIVED` symbol in the repo. Publishers poll. This was
   scoped as a Wave C item and was not built; it is the missing half of "the flagship workflow
   should be automatable end to end".
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
    no equivalent warning anywhere else that saving to xlsx disarms every job.
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
    **Missing: the esbuild transpile-at-save.** Scripts are still JavaScript; the `.d.ts` describes a
    language the editor cannot compile. Authors get completion and hover, not type ERRORS.
13. **MCP as automation co-author** — **SHIPPED.** `mcp/objects.rs` carries update/delete for chart,
    named range, table and pivot plus sheet list/add/rename/delete/move; `mcp/tools.rs:1142` installs
    `HostModelProvider` into `execute_script`, so the MCP script surface can read the model; and
    `mcp/drafts.rs` is the consent-gated "draft an object script, open unmounted" tool — with the
    important property that drafts live in a process-local store that the mount path never reads, so
    an AI-authored script cannot become code that runs on next open without a human saving it.
14. **Script package manager** — **DEFERRED (designed, not built).** Verified 2026-08-01: no `@uses`
    pragma parser and no `base.callImport` exist anywhere in the repo, so nothing from the design has
    been implemented. Deferred on effort (**L**) and because every other item in this program either
    closed a security hole or a stated parity gap, while this one adds a distribution channel that
    nothing currently depends on. The design below is intact and remains the plan.
    → **DESIGNED: `docs/design/script-package-manager.md`** (2026-07-31). Decision: a library is a
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

## 8. What is still open after nine waves

The short, honest list. Everything here is verified absent as of 2026-08-02, not inferred.

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

**Still open**
- **The engine has no evaluation TIME or step budget.** The depth ceiling does not cover it: a
  shallow exponential (`fib` without memoization) or a wide `MAP` over a million cells is slow
  without being deep, and hangs the caller. The QuickJS surfaces have a deadline
  (`core/script-engine/src/limits.rs`) and writeback validators have one; the formula evaluator does
  not, so `api.evaluate` inherits nothing. Scoped in `evaluator.rs:459-472`: a `Cell<u64>` step
  counter checked in `evaluate()` plus an optional `Instant` deadline, wired from the recalc entry
  points — wider than the evaluator, so it needs an owner for `calculation.rs` / `commands/data.rs`.
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
- **No package-identity read for a distributed script** — with one nuance: a script that subscribes
  to `PACKAGE_UPDATED` does receive `{packageName, version}`. So identity is reachable *when an
  update happens*, never on demand.
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
6. **Unbounded evaluation.** A recursive LAMBDA is now bounded by depth, but nothing bounds a
   *shallow exponential* or a very wide array formula: the evaluator has no time or step budget. VBA
   at least had Ctrl+Break.
7. **Headless execution.** VBA can be driven by an external host with Excel invisible. Calcula's
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

*Full agent outputs (per-surface API enumerations with file:line evidence, per-dimension VBA coverage
grids, 48 verified gap verdicts) were produced in the 2026-07-31 review session. Closing statuses were
re-verified against the code on 2026-08-01, most recently during the Wave I closing pass (§7.19),
which walked every `.calp` payload kind rather than every method list — and found two kinds that
executed unconsented.*

*Verification behind this revision: `npm run check-types` clean · `npm run lint:boundaries` clean ·
`npm run check:script-typings` `[OK] typings are current` · `npx vitest run` **104,182 passed / 0
failed (627 files)** · `cargo check` clean in both `app/src-tauri` and `core` · app-lib Rust suite
**766 passed / 0 failed** · `core` `engine` **413 passed / 0 failed** (the full evaluator suite, run
because the LAMBDA depth ceiling and the `eval_3d_ref` inheritance touch it) · `core` `persistence` +
`calp` + `script-engine` + `parser` **446 passed / 0 failed**.*
