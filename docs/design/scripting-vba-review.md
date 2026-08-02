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

## ⚠️ SECTIONS 2–7.17 WERE DESTROYED 2026-08-01 22:30 — RECOVERABLE FROM DROPBOX

**What happened.** During the Wave I closing pass, a scripted in-place edit of the §1 scorecard
(`s[:j] + tail`) discarded everything after the last scorecard row instead of splicing. The file went
from 1441 lines to 122. §0, §1 (the whole scorecard) and everything from §7.18 onward were held in
the editing session and are restored below, verbatim, with the Wave I updates applied. **Sections
2 through 7.17 — roughly 985 lines — were not, and are gone from this working copy.**

**Recovery, in order of fidelity.** `docs/` is in `.gitignore` (line 32), so this file has NEVER been
committed and `git` cannot restore it — see the root-cause note below.

1. **Dropbox version history (best — exact bytes).** The file is inside the Dropbox tree
   (`C:\Dropbox\Projekt\Calcula\docs\design\`), so the pre-truncation revision is retained:
   dropbox.com → this file → *Version history* → restore the revision immediately preceding
   2026-08-01 22:30:43. Then re-apply the only edits this pass made to the surviving text: the four
   §1 scorecard cells, the §0 audit-rule additions, and §7.19 below.
2. **`scripting-vba-review.RECOVERED-2026-08-01.md` (fallback, in this folder).** Reconstructed from
   an agent transcript that had read the whole file: a COMPLETE 367-line copy of the document as it
   stood after Wave E. It contains all of §2–§7 in their Wave-E form. What it does NOT contain is the
   per-item status annotations waves F–I added to those sections (the "CLOSED"/"SHIPPED" markers). Use
   it to restore the prose and structure, but treat §8 and §9 of THIS file — not that copy — as the
   authoritative status, because they were re-derived from code after Wave I.

**Root cause worth fixing separately:** `docs/` being gitignored is why a 1400-line design record had
no version control at all. Every "code committed" checkpoint during this program silently excluded it.
Un-ignoring `docs/` (or at least `docs/design/`) would have made this a one-line `git checkout`.

**What was in the lost span**, so the restore can be checked for completeness:

| § | Title (from the file's own table of contents) |
|---|---|
| 2 | Confirmed high-severity parity gaps (incl. §2.2 workbook lifecycle, §2.4, §2.6 AutoFilter, §2.9 pivot field layout — the twice-wrong one, §2.10 onBeforeDoubleClick/RightClick, §2.12 OnKey, §2.13 file export, §2.14 the macro recorder that started this program) |
| 2 (sub) | UDF-specific confirmed gaps (Custom Functions) |
| 3 | Dead / hollow plumbing inventory ("answers wrong is worse than absent") |
| 4 | Calcula Models — script coverage answer (What scripts CAN do / What NO script can do / Governance inconsistency found) |
| 5 | .calp distribution + writeback — script coverage answer |
| 6 | Cross-cutting findings (completeness critic) — incl. §6.1 add-ins, §6.3 grant persistence, §6.5 cross-workbook, §6.6 clipboard/printing refusals |
| 7.1–7.17 | Ranked improvement roadmap items, incl. §7.10 capability grant mirror, §7.12 IDE, §7.14 package manager, §7.15 add-in slice 1, §7.16 grant persistence, §7.17 Wave G integration pass ("what the wave reports got wrong") |

**This notice stays until the restore is done.** Deleting it without restoring the sections would
reproduce, exactly, the failure this document was written to record: a record that reads complete
while the thing it describes is missing.

---

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
from the key fails "gives two consumers with DIFFERENT declared origins two different realms".
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
`base.callImport` broker method; the bearer-token relay cannot provide it. **Fix:** the claim was
corrected in place, with the residual and its real fix written next to it.
**CLOSED 2026-08-01 by Wave I** — `base.callImport` shipped, and the residual with it (§7.19-D).

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
broker ceiling test, and (notably) "survives the RUST pragma parser", which reads
`core/persistence/src/lib.rs` from disk. Restored and re-verified green. Wave H introduced **no new
capability id**, so no consumer needed threading: `ALL_CAPABILITY_IDS` (13) and
`KNOWN_CAPABILITY_IDS` (`[&str; 13]`) still matched exactly.

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

The short, honest list. Everything here is verified absent as of 2026-08-01, not inferred.

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

**Still open**
- **The engine has no evaluation TIME or step budget.** The depth ceiling does not cover it: a
  shallow exponential (`fib` without memoization) or a wide `MAP` over a million cells is slow
  without being deep, and hangs the caller. The QuickJS surfaces have a deadline
  (`core/script-engine/src/limits.rs`) and writeback validators have one; the formula evaluator does
  not, so `api.evaluate` inherits nothing. Scoped in `evaluator.rs:459-472`: a `Cell<u64>` step
  counter checked in `evaluate()` plus an optional `Instant` deadline, wired from the recalc entry
  points — wider than the evaluator, so it needs an owner for `calculation.rs` / `commands/data.rs`.
- **`calp_inspector.rs:66` pins TOFU on every inspection.** `open_verified` calls
  `verify_and_load_manifest_via`, so the read-only Package Inspector squats a pin for any package
  name a browsed registry serves. Same bug class as the library-preview one just closed, on a surface
  Wave I did not own. The clean fix is a pin-policy parameter on
  `core/calp/src/integrity.rs:412`, which would also let `library_commands.rs` delete its
  policy-aware copy. Other preview-shaped call sites worth the same audit: `calp_commands.rs:5368,
  5577, 8034, 9250, 9285`; `bi/writeback_source.rs:161, 212`.
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
