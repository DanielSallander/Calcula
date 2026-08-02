# Scripting System Review — VBA Parity, Models & .calp Coverage

**Date:** 2026-07-31
**Method:** 18-agent adversarial review. Eight readers enumerated every script surface from code
(broker allowlist, QuickJS op registry, MCP tool list, capability vocabulary); five graders scored
the combined surface against the Excel VBA object model; every claimed gap was then adversarially
re-verified against the code (verifiers were instructed to refute each claim). Of 143 deduped gap
claims, the top 48 were verified: **27 confirmed missing, 21 partial, 0 refuted** — no reviewer
claim turned out to be wrong, only incomplete.

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

| Dimension | Grade | Summary |
|---|---|---|
| Security model | ✅ Beyond VBA | Tiers, capabilities, consent, audit; residual: no QuickJS timeout/interrupt |
| Transparency/audit | ✅ Beyond VBA | Taxonomy, code inventory, audit ring; residual: scriptSurfaces drift (§6.2) |
| Event observation | ✅ Competitive+ | 15 typed contexts; onBeforeCommit exceeds VBA |
| Event interception | ❌ Missing | No cancellable BeforeSave/BeforeClose; no sheet-lifecycle events |
| Range/sheet mutation | ❌ Weakest | No formatting, no structural ops, no sort/find/copy-paste from scripts |
| Application/environment | ❌ Weakest | No MsgBox/InputBox (outside shapes), no save/open, no OnKey/OnTime, no printing |
| Object automation | ⚠️ Half | Configure-existing strong (charts/slicers/tables); create/enumerate/delete absent |
| Model automation | ✅ Category lead | 16-kind governed gateway; gaps in §4 |
| .calp/writeback automation | ❌ Zero | No script surface reaches any of the 68 host commands (§5) |
| Scheduling | ❌ Missing | Nothing replaces Application.OnTime |
| IDE/debugging | ⚠️ Partial | Monaco+scaffolds beat VBE authoring; VBE still wins debugging (step/watch) |
| Add-in authoring | ❌ Missing | Third parties cannot build a real add-in at all (§6.1) |

---

## 2. Confirmed high-severity parity gaps

Every item below survived adversarial verification (evidence = file:line at review time).

1. **No user-interaction primitive** (MsgBox/InputBox/UserForm). `notify()` is one-way. Ask-and-branch
   is only expressible for shape/pane-control scripts via `ui.html` + `render.sendMessage/onMessage`
   iframe bridge; workbook/sheet/button/table scripts and QuickJS have no input path at all.
2. **Zero workbook file lifecycle** — scripts cannot save (not even the current workbook), open,
   create, or close. `onBeforeSave/onAfterSave` observe only. No allowlist row, no QuickJS op, no MCP tool.
3. **No persistent formatting from user scripts.** Broker allowlist has zero format methods; QuickJS
   `applyNamedStyle` queues a DeferredAction no frontend handles; `getNamedStyles` hardcodes `[]`.
   Only MCP `apply_formatting` (AI clients) can format. `cell.onRender` overrides are transient render-cache styles.
4. **No structural mutation of sheets** — add/delete/rename/move/copy/hide sheets, row height /
   column width, freeze panes: missing on every surface. Rows/columns/merge ARE reachable via
   `api.executeCommand` (INSERT_ROW etc.) **but grid-bridge commands take no arguments** — they act
   on the ambient user selection, which scripts cannot set.
5. **Display-strings-only data model in the worker realm.** No typed value read (5 vs "5"), no date,
   no error detection, no formula read (`cell?.display` everywhere). A read-then-write round-trip
   silently destroys formulas. QuickJS has `getCellFormula`; the primary surface has nothing.
6. **No Sort, AutoFilter, or Find/Replace from script.** The features exist as extensions with full
   UI; zero script reach (only 3 explicitly scriptSafe commands repo-wide: FlashFill ×1, CellBookmarks ×2).
7. **Per-cell RPC bulk I/O.** `ScriptRange.getValues()` awaits one broker RPC per cell sequentially
   (100×100 = 10,000 RPCs under a 10s read deadline). `updateCellsBatch` covers bulk write
   (unlocked, 100k cells) but `setValues` doesn't use it. namedRange/range mirrors and QuickJS
   `getRange` are the only bulk reads.
8. **No object create/enumerate/delete from user scripts.** Instance pinning means each script sees
   exactly one pre-existing object. `Charts.Add`/`Shapes.AddShape`/`ListObjects.Add` equivalents
   exist only as MCP tools. Object deletion exists on NO surface.
9. **Pivot field layout is read-only** (`getFields` mirror + `refresh` only) despite
   `update_pivot_fields` existing backend-side and the Pivot Layout DSL already modeling the shape.
10. **No cancellable Before\* lifecycle.** BEFORE_SAVE/BEFORE_CLOSE are fire-and-forget; the proven
    replying-verdict pattern (`range.onBeforeCommit`, 1.5s deadline, default-allow) was never
    extended to workbook lifecycle.
11. **No OnTime / persistent scheduler.** Worker timers die with the mount; connector
    `refreshEverySecs` has only a renderer-side session-scoped consumer; nothing fires at wall-clock
    times or survives reload.
12. **No keyboard triggers** (OnKey). No hook on any context; sandboxed extension `keyboard`/`keybindings`
    surfaces throw; only full-trust main-thread extensions can bind keys.
13. **General file export/import excluded with NO sanctioned alternative.** No picker-mediated
    write-a-CSV / read-a-config capability; storage cap (256KB private KV) covers none of it.
    Escape valves: `cap.fetch` POST, or an external MCP client.
14. ~~**Macro recorder regressed to dead plumbing.**~~ **CLOSED 2026-07-31** — rebuilt as the
    `MacroRecorder` extension with bridge-level capture, CommandRegistry capture and
    "save as button script". The orphaned `setCellRecorderHook` is gone, replaced by
    `setGridRecorderHook` with a real caller. See roadmap item 1 in §7 for the shipped scope.

### UDF-specific confirmed gaps (Custom Functions)

- **Paste/fill/multi-cell edits never resolve UDFs** → pasted UDF formulas land as `#NAME?` until
  each cell is individually edited (batch bridge never passes `udf_results`; only single-cell
  `updateCell` runs the resolve hook).
- **No volatility control** and asymmetric recalc: hyper-volatile on single-cell edits
  (`collect_udf_calls` re-evaluates all sheets), frozen on F9/paste/fill (`preserved_udf_value`).
- **Values only, never a Range object** (no address/sheet/format metadata reaches a UDF body).
- **No spilled/dynamic-array returns** (`UdfValue::Array` → contained `EvalResult::List`).
- **Cannot return specific error values** (no `CVErr(xlErrNA)` equivalent; `jsToUdfValue` never
  produces `kind:'error'` from a user return).

---

## 3. Dead / hollow plumbing inventory ("answers wrong is worse than absent")

APIs that exist and silently do nothing — worse than absent because they mask the gap:

| API | Problem |
|---|---|
| 12 of 15 `DeferredAction` variants | SetViewMode, SetZoom, SetReferenceStyle, SetDisplayGridlines/Headings/Zeros, FillDown/Right, ApplyNamedStyle, SetScrollArea, SetIterationSettings, SetSheetVisibility — queued, returned, and dropped (frontend handles only goto/calculate/setStatusBar; `@api` run path omits `deferredActions` entirely) |
| `Calcula.bookmarks` (run_script) | Mutations returned in `bookmarkMutations`; zero dispatchers of the `script:bookmark-mutations` event CellBookmarks listens for; notebooks don't register the ops at all |
| QuickJS extended getters | zoom/viewMode/referenceStyle/gridlines/isDirty/sheetVisibility/workbookProperties initialized to constants, never fed from AppState — `getZoom()` always says 1.0 |
| `get/setWorkbookProperty` | Reads an always-empty clone map; setter mutates the clone with no write-back path (real store `AppState.workbook_properties` untouched) |
| `Application.enableEvents` | Write-only flag with no consumer |
| Notebook AppInfo | `AppInfo::default()` — sv-SE users see wrong separators via `Calcula.application` |
| Notebook writes | Bypass BOTH the undo stack (wholesale grid swap, Ctrl+Z can't revert) AND dependency recalc; formula strings stay literal text (run_script at least diff-replays the active sheet) |
| Formula strings on non-active sheets (run_script/MCP) | Land as literal text (acknowledged RESIDUAL v1) |
| `writebackValidators` | Publisher ships a validator NAME in schema `extra`; no registrant exists anywhere; advisory frontend-only |
| Monaco typings | `objectContexts.d.ts` declares `caps` as fetch+storage only — biQuery/biSql/cube/biModel/connector invisible to IntelliSense |

**Recommendation:** delete or wire each of these. Per project policy (no backward compat), deleting
the unconsumed DeferredActions is cheap and honest; wiring them is listed in §7.

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

**Notebook `model.info` returns the FULL `BiModelInfo` including `security_roles` metadata** (names
+ filter summaries) to any notebook cell holding a bi.query grant, while the worker gateway's
`biModel.info` deliberately whitelists exactly to keep RLS metadata away from sandboxed code
(`script_provider.rs:158` vs `model_editor.rs:5067-5116`). Same nominal capability, different
exposure. Align the notebook provider on the sanitized projection.

Also: **connector scheduled refresh dies with the session** — `refreshEverySecs` is persisted in
extension_data but only a renderer `setInterval` consumes it; no host-side scheduler.

---

## 5. .calp distribution + writeback — script coverage answer

**Coverage is zero.** The host surface is 68 Tauri commands (54 calp_commands.rs + 8 inspector +
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
5. **No lifecycle events for scripts** — `calp:scripts-pulled` is deliberately excluded from
   SCRIPT_SUBSCRIBABLE_APP_EVENTS; no event exists at all (any surface) for submission-received or
   review decisions (publishers poll).
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

1. **Add-in authoring is impossible for third parties.** Trust is binary: only repo-manifest
   extensions are "trusted"; everything scanned from the user's extensions dir is "distributed" and
   refused main-thread activation (`extensionTrust.ts:32-34`), and sandboxed worker extensions
   cannot register formulas, ribbon/menu UI, grid hooks, cell editors, or file formats (all throw).
   A VBA convert who shipped .xlam function libraries — the exact audience the vision names — can
   only produce fixed-arity sandboxed UDFs or fork the app. Needs a deliberate design answer
   (signing? developer mode? richer worker-extension API?). → **ANSWERED (2026-07-31):
   `docs/design/third-party-addin-authoring.md` — richer worker-extension API; main-thread
   escalation rejected. See roadmap item 15.**
2. **Transparency-pillar defect: `scriptSurfaces.ts` understates real reach.** The self-described
   "single source of truth" omits `bi.sql` from object-script capabilities and lists formula-udf as
   `["formula.udf"]` only, while the enforcing allowlist grants `cap.biSql` at restricted tier and
   UDF libraries can declare more. The guard test checks vocabulary membership, not completeness —
   the transparency panels can tell a user scripts *cannot* run raw SQL when they can. Fix + add a
   completeness test against the allowlist.
3. **Consent fatigue / no Trusted-Documents analog.** Default "prompt" re-asks once per SESSION —
   every restart re-prompts before the user's own onOpen scripts mount; notebook grants are
   session-scoped (replay re-prompts); dismissed prompts fail closed; the "enabled" escape has no
   Settings UI despite prompts pointing there. Excel solved this with persistent Trusted Documents;
   Calcula has no per-workbook persistent trust. Most likely single reason a convert calls the
   system nagware — or globally flips to "enabled", defeating the tiering.
4. **QuickJS runtime has no timeout/interrupt/memory cap** — an infinite loop wedges the notebook
   executor thread or `run_script` permanently. VBA at least had Ctrl+Break. Hard prerequisite for
   any scheduler/headless ambition.
5. **No cross-workbook scripting and no personal macro library** (PERSONAL.XLSB analog). All script
   surfaces are workbook-resident; %APPDATA% templates are scaffolds, not runnable macros.
6. **Ungraded-but-missing VBA areas:** window management (FreezePanes/Split/Arrange — zero script
   ops despite app-side support), printing, WorksheetFunction bridge, clipboard, document
   properties (see hollow API in §3), R1C1 formula authoring (reference-style toggle exists but is
   an unconsumed DeferredAction; `getCellFormula` is A1-only and there is no `setCellFormula`).

---

## 7. Ranked improvement roadmap

Ordered by leverage; effort S/M/L.

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
     reported rather than silently dropped. `sortRange` lives in `api/backend.ts`, outside the
     bridge module, so a sort is not yet captured structurally.
2. **Bulk typed range I/O + undo everywhere:** `sheet.readRange/writeRange` broker aspects (one RPC
   per rectangle, typed cells `{value, display, formula?}`), make `setValues` use batching, allow
   undo batching below unlocked tier, and route notebook grid swaps through the run_script
   diff+replay pattern (fixes undo bypass + stale recalc + literal-text formulas). Credibility
   floor for "typed API beats VBA". **M**
3. **Formatting + structural ops for scripts by reusing existing paths:** expose the
   `apply_formatting` command family through the broker (consent-gated), add
   insert/deleteRows/Columns *with arguments* (not selection-ambient), sheet CRUD, row/col sizing,
   merge with range args. Mostly wiring — MCP proved the backend. **M**
4. **Writeback automation capability** (`distribution.writeback`): contributor-side
   listRegions/getDraft/saveDraft/submitRegion routed through the Rust schema-enforcing submit path
   — which also fixes the silent draft-capture bypass — plus publisher-side
   reviewSubmissions/setSubmissionState gated on Ed25519 possession + consent. Closes the "flagship
   workflow less automatable than what it replaces" hole. **L (split M+M)**
5. **Models finishing loop:** read-only gateway analogs for validate/dependency_graph/lineage;
   script-side bi.model batch = one undo step; notebook Phase 3 "Test in notebook"; close the
   notebook `security_roles` info leak (§4). **M**
6. **Distribution lifecycle events + package-aware scripts:** ~~thinned package-updated /
   scripts-pulled events in the subscribable allowlist + a `context.package {name, version,
   provenance}` mirror~~ **SHIPPED (B5)** — `AppEvents.PACKAGE_UPDATED` (thinned to
   `{packageName, version}` for sandboxed subscribers) replaced the untyped `calp:scripts-pulled`
   window event, and `context.package` is seeded from the mount spec (null for local scripts).
   **Submission-received still does not exist as an event on any surface** (publishers poll);
   it is a Wave C item, not fabricated here. **S**
7. **`ui.dialog` capability:** awaitable sandboxed HTML dialog (prompt/confirm/form → returned
   value) for all script types — the iframe + postMessage + consent machinery already exists in
   shape `ui.html`; package it free-standing and modal. **M**
8. **Cancellable Before\* hooks + missing bus events:** ~~generalize the onBeforeCommit
   verdict pattern (deadline, default-allow) to onBeforeSave/onBeforeClose; add
   SHEET_ADDED/DELETED/RENAMED + recalc-completed to the bus and allowlist~~ **SHIPPED (B5)** —
   `core/lib/lifecycleGuards.ts` is the choke point; the save path and the close path await the
   verdict (3s deadline, default-ALLOW, attributed cancellation toast). `onBeforeDoubleClick` /
   `onBeforeRightClick` were checked and do not exist as hooks on any surface. **M**
9. **QuickJS interrupt/timeout/memory budget** (prereq for 10). **S**
10. **Host-side persistent scheduler** under a consented `schedule` capability (persist jobs in the
    workbook; adopt the stored-but-unconsumed connector `refreshEverySecs`). **M**
11. **Sandboxed distributable writeback validators** — ship validator bodies as capability-free
    worker scripts under the existing consent pipeline, enforced on the Rust submit path. **M**
12. **d.ts codegen + TypeScript compile:** generate `objectContexts.d.ts`/`calcula.d.ts` from
    contextShims/allowlist/op-registry with lockstep tests (caps namespace is invisible today);
    esbuild transpile at save so scripts can actually be TS. **S–M**
13. **MCP as automation co-author:** update/delete tools for objects, ModelDataProvider into
    `execute_script`, structured table output, and a consent-gated "draft an object script,
    open unmounted" tool. **M**
14. **Script package manager:** grow the local-file "Marketplace" into a real registry on the
    existing calp signing/TOFU/blob infrastructure + a library-import shim. **L**
    → **DESIGNED: `docs/design/script-package-manager.md`** (2026-07-31). Decision: a library is a
    `.calp` of a new `PackageKind::Library`; imports are *declared* (`// @uses alias pkg@pin`) and
    host-resolved against a workbook lockfile; the shim is a new `base.callImport` over the existing
    `hostCallExposed` relay — **not** `base.callMethod`, whose global `public:true` flag would expose
    library exports to every peer script. Governing rule: a dependency's effective ceiling is
    `declared(lib) ∩ declared(consumer)`, enforced at `buildHandleFromDefinition` →
    `checkPolicy` (`broker.ts:85-127`, `162-177`), which closes the confused-deputy escalation.
    First slice = the import mechanism only (no marketplace UI).
15. **Add-in authoring answer** (§6.1): decide the third-party trust escalation story. **Design first**
    → **DECIDED: `docs/design/third-party-addin-authoring.md`** (2026-07-31). Recommendation: **do
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
16. **Trusted-workbook consent persistence** (§6.3) + Settings UI for Script Security. **S**
17. **UDF fixes:** thread `udf_results` through the batch bridge (paste `#NAME?` bug), volatility
    flag, error-value returns, optional spill. **S–M each**

Independently of the roadmap: **fix or delete the §3 dead-plumbing list** — silent no-op APIs
undermine trust in the whole surface.

---

*Full agent outputs (per-surface API enumerations with file:line evidence, per-dimension VBA
coverage grids, 48 verified gap verdicts) were produced in the 2026-07-31 review session.*

