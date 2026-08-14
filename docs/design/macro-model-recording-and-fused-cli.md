# Macro Recorder → Model Reach + Fused App CLI

Status: Feature 1 BUILT 2026-08-13; Feature 2 BUILT 2026-08-13 (see the two
"as built" sections). Decisions confirmed by the owner: model recording ships
first; main-window CLI shortcut is Ctrl+Shift+P; runs mixing model writes and
grid writes are refused at plan time.

## Feature 2 — as built (deviations from the plan below)

The kernel shipped as planned in `app/extensions/_shared/cli/` (lex + format
moved verbatim; glob split out of resolve; parse parameterized by a
`CliVocabulary`; `registry.ts` `CliDomain`/`CliBatchStrategy` contracts;
`engine.ts` with kind-driven dispatch, the single-write-domain rule and
per-domain batch strategies; `optionSchema.ts`). The model CLI migrated as a
THIN WRAPPER: `ModelEditor/cli/execute.ts` keeps its public surface
(createSession/planRun/executeRun) but runs the shared engine with
`modelDomain.ts`; `parse.ts` keeps the typed Verb/Kind unions as a narrowing
layer built from the SAME `MODEL_VOCABULARY_CONTRIBUTION` the domain hands the
engine (no drift possible); lex/format/resolve became re-export shims.
`cli.test.ts` (25) and `referenceDocs.test.ts` pass UNMODIFIED. Kernel tests:
`_shared/cli/__tests__/kernel.test.ts` (16, two-domain fixture — dispatch,
kind-uniqueness build error, mixed-write refusal, rollback vs commit-partial
messaging, read-only never batches).

Deliberate deviations:

1. `help`/`clear` are engine-level; undo/redo route to the window's default
   domain and must run alone (kernel-enforced, same rule as before). In the
   main window that means MODEL undo/redo are not reachable from the CLI
   (grid undo owns the verb there) — use the Model Editor for model undo.

## Follow-ups — closed 2026-08-14

- **Model-domain strict options (DONE).** `ModelEditor/cli/modelOptions.ts` is
  the audited kind×verb option schema (78 entries, derived from writers.ts
  code, pinned by a matrix test in `modelOptions.test.ts`); `strictOptions`
  is ON for the model domain (unknown `key=` errors name the valid keys;
  reads stay lenient — the audit proved ls/show/validate consume none). The
  OPTION_KEYS completion mirror is DELETED — completion derives from the same
  table via `modelOptionSpecsFor(verb, kind)`. Audit findings (reported, not
  changed): `set writeback name=` / `set source name=` are undocumented
  rename/display side-channels; the old mirror suggested `connstr` on
  add/set source (only `connect` reads it) and name=/ops= on
  `set relationship` (only add/rename read them).
- **Panel unification (DONE).** `_shared/cli/components/CliPanel.tsx` is THE
  panel (Monaco prompt/script modes, history, confirm card, saved scripts,
  resize — generalized verbatim from the Model Editor's proven design behind
  a `CliPanelDriver`), and `_shared/cli/language.ts` is THE Monaco language
  machinery (register-once per language id, swappable completion context;
  `engineCompletionContext(engine)` derives names + per-verb option keys
  generically from kind specs). Both windows are thin wrappers now:
  `ModelEditor/components/CommandPanel.tsx` (keeps `calcula.modelEditor.cli.*`
  storage keys and the per-run-session semantics) and
  `CommandLine/components/AppCliPanel.tsx` (`calcula.app.cli.*`).
- **Model domain in the main window (DONE).** `_shared/cli/domainProviders.ts`
  is the cross-extension seam: the ModelEditor registers a "model" provider at
  activation (targets = BI connections; a binding = model domain + a live
  session over `biModelGetOverview`); the main-window panel shows a "Model:"
  picker when a provider exists, mounts the binding beside the app domain
  (one engine, kind-driven dispatch, mixed-write refusal live), rebinds on
  `bi:model-changed` for the bound connection so the overview never goes
  stale, and model-object completion works through the kind specs'
  `nameSuggestions` (shared `modelCompletion.ts`, one copy for both windows).
- **Live E2E record→replay spec (DONE)** —
  `app/e2e/journeys/macro-model-recording.spec.ts`: arm via the real Developer
  menu → grid edit + `bi_model_upsert_measure` + a role edit → stop → assert
  the stored source (one `caps.biModel.upsert`, the pragma, NOT REPLAYABLE for
  the role with no role name, the unarmed edit absent) → delete the measure →
  Run from the macro library → approve the bi.model JIT consent → the measure
  is back. Writing this spec found a REAL replay gap before the first run:
  `runObjectScriptOnce` mounted with an EMPTY declared-capability ceiling
  (nothing parsed the source's pragmas on the run-once path), so
  `maybeRequestCapabilityGrant` never prompted and the broker denied
  `cap.biModel*` as undeclared — a recorded model macro could never replay.
  Fixed in `objectScriptRunner.ts` (ceiling = `parseDeclaredCapabilities(source)
  .caps`, local provenance, consent still required, Rust still re-checks);
  pinned by two tests in `objectScriptRunner.test.ts`.

Known limitation: the run-once mount's 10-second deadline keeps ticking while
the JIT consent dialog is open, so a user who ponders the bi.model prompt for
longer than that gets the "was still running after 10 seconds" error and must
run the macro again (the grant flow itself is unharmed). Pausing the deadline
during consent is future work in the mount machinery.

## Feature 1 — as built (deviations from the plan below)

Implemented per the plan, with two deliberate improvements:

1. **The gateway payload is built in RUST, not mapped in TypeScript.** The capture
   (`app/src-tauri/src/bi/macro_capture.rs`) constructs the exact JSON object the
   `script_bi_model` dispatch arms consume, in the same crate as those
   `gateway_field` reads — so there is NO per-kind TS mapping table to drift.
   Codegen embeds the payload verbatim (`JSON.stringify`), and a Rust test pins
   that every `GATEWAY_MUTABLE_KINDS` member has a builder arm.
2. **Batch markers never enter the recorded-action vocabulary.** `macro:model-batch`
   begin/end/cancel are session-internal: cancel DROPS the rolled-back edits from
   the recording; codegen independently wraps ≥2 consecutive model edits per
   connection in `batchBegin/End/Cancel` for atomic replay. There is no
   `RecordedModelBatchEvent` in the `RecordedEvent` union.

Also as built: role/source captures carry neither payload NOR name (role names are
privileged per `sanitized_model_info`); multi-domain diffs accept only the two
documented fan-outs (writebackColumn, calculatedTable) — stricter than the
lifecycle event's priority list, because a partial replay would silently drop work;
grid Ctrl+Z pops the last GRID action and Model Editor Undo the last MODEL action
(type-filtered, index-preserving redo). The fills and remove-duplicates codegen
fixes shipped with it (`api.fillRange` / `api.removeDuplicates` are emitted now).

## Context

Two strategic questions, both answered **yes**:

1. **Should macro recording reach into the Calcula model?** Yes. Scripts can
   *already mutate* the model via the sandboxed `bi.model` gateway (17 kinds,
   `script_bi_model`) — the replay half exists; only the recording half is missing.
   Today a model edit is invisible to the recorder in three independent ways (wrong
   window, wrong dispatch path, no event kind). Closing this is on-vision: it exceeds
   Excel VBA (which never scripted the data model well) while keeping the security
   story — recorded macros that touch the model declare `bi.model` and go through
   normal consent/audit on replay.
2. **A fused app-wide CLI?** Yes. The Model Editor CLI is ~60% generic
   infrastructure (lexer with the `=`-tail rule, two-phase plan→confirm→execute,
   panel UI, Monaco language machinery, reference pane) and ~40% model-specific verb
   tables. Extract the kernel to `app/extensions/_shared/cli/` (precedent: the pivot
   DSL lives in `_shared`), make verbs/kinds a per-domain registry, and add a new
   grid/app domain in the main window. One CLI, two domains, per-window default.

Verified load-bearing facts:

- All model mutations reach `emit_model_changed`
  (`app/src-tauri/src/bi/model_editor.rs:588`) with `(before, after, source,
  script_id)` — 6 call sites cover edits, undo/redo, script-batch rollback, and both
  imports. `apply_model_edit` alone would miss imports; `emit_model_changed` misses
  nothing.
- Grid `cancel_transaction` (`core/engine/src/undo.rs:157`) is NOT a rollback — it
  drops the undo record, stranding applied changes as un-undoable. CLI error paths
  must **commit partials**, never cancel.
- Capability pragma is `// @capability bi.model` (singular), parsed by
  `parseDeclaredCapabilities` (`app/src/api/scriptHost/capabilities.ts:620`); JIT
  consent + authoritative Rust re-check already gate replay with zero new machinery.

---

## Feature 1 — Record model mutations in the macro recorder

**Hook placement (decided):** one Rust hook inside `emit_model_changed`, armed-only,
emitting a NEW Tauri event `macro:model-edit` targeted at the main window
(`emit_to("main", …)`). Rejected: instrumenting ~74 `biModel*` frontend wrappers
(two window realms, misses Rust-internal paths); extending `bi:model-changed` (it is
metadata-only *by security design* — never put formulas on the app-wide event
stream).

**Payload strategy:** Rust captures `{connectionId, kind, action, name,
originalName?, object?, replayable, reason?}` where `object` is the changed object's
post-state picked from `serde_json::to_value(build_overview(after, ...))` (deletes
pick from `before`). The DTO → `ScriptBiModelApi.upsert` payload mapping lives in
TypeScript codegen as a per-kind declarative table (pure, vitest-testable). Filter
`source == "script"` / `script_id.is_some()` → no capture (kills double-record).
Kinds outside `GATEWAY_MUTABLE_KINDS` (roles, sources, table rename/delete, storage,
refresh, imports, bulk) → name-only, `replayable: false` with reason — **never widen
`GATEWAY_MUTABLE_KINDS` or ship role/source definitions in the event**.

### Work items (ordered)

1. **Rust capture + arming** — `app/src-tauri/src/bi/model_editor.rs` (optionally
   new `bi/macro_capture.rs`): `MODEL_RECORDING_ARMED: AtomicBool`;
   `macro_model_recording_set_armed` command (window-guarded MAIN; register in
   `generate_handler!` — watch the /STACK headroom gotcha); capture fn inside
   `emit_model_changed` (pure `Option<RecordedModelEditPayload>` + thin emitting
   wrapper so unit tests need no AppHandle); rename-aware diff (refactor
   `changed_domain`'s list diff at `:475` to also return the removed name); precise
   diffs for `dateTable`/metadata scalars; instrument `bi_model_batch_begin/end/cancel`
   (`:5098-5148`) → `macro:model-batch` begin/end/cancel events; undo/redo call sites
   emit undo/redo markers.
2. **@api plumbing** — `app/src/api/backend.ts`: `setModelRecordingArmed(armed)` +
   event-name constants. Do NOT bridge payloads onto the app event bus.
3. **Vocabulary** — `app/extensions/MacroRecorder/lib/types.ts`:
   `RecordedModelEditEvent` (kind "modelEdit": connectionId, connectionName?,
   modelKind, action upsert|delete, name, originalName?, object?, replayable,
   reason?) + `RecordedModelBatchEvent`; extend `RecordedEvent` union.
4. **Session** — `app/extensions/MacroRecorder/lib/actionRecorder.ts`: arm/disarm in
   install/uninstallHooks; subscribe via `listenTauriEvent`; drop when not recording
   or `commandDepth > 0`; cache connection names for comments; undo marker pops last
   action iff it's a model event (documented heuristic, same class as the grid one).
5. **Codegen** — `app/extensions/MacroRecorder/lib/actionCodegen.ts`:
   - objectScript target: emit `caps.biModel.upsert/delete/batchBegin/batchEnd`
     calls; per-kind DTO→payload mapping table (17 kinds; renames:
     `isHidden`→`hidden`, culture `locale`→`originalLocale`/`locale`,
     `writebackColumn id`→`originalId`; delete payload shapes per kind;
     `calculatedTable` delete records `cascade: false` + comment).
   - Scaffold: when model actions present, macro becomes
     `async function name(api, caps)` with setup passing
     `(context.api, context.caps)`; emit `// @capability bi.model` header.
     Model-free recordings stay byte-identical.
   - notebook target: ALL model actions → NOT REPLAYABLE ("the notebook model
     surface is read-only").
   - **Fix in passing** two stale claims: fills (`:499-502` — `api.fillRange`
     exists, `allowlist.ts:604`) and remove-duplicates (`:618-630` —
     `api.removeDuplicates` exists, `allowlist.ts:450`).
6. **Cross-window indicator** — boolean-only `macro:recording-armed-changed` event;
   Model Editor window shows a minimal "Recording macro" pill.
7. **Docs/drift** — `docs/design/scripting-vba-review.md:828` stale "20 structural
   event kinds" (now 24 + model events); add an entry-point status table per the
   §7.20 discipline.

**connectionId (v1):** record concrete id; connection *name* as comment only. Replay
elsewhere fails loudly ("Connection not found"). No name resolution in v1.

### Tests (entry-point-live discipline — the recorder shipped dead entry points once)

- Rust unit: armed user edit → correct payload per kind; rename → originalName;
  delete; role/source → `replayable:false`, no object; import → not replayable;
  `SCRIPT_MUTATION_ATTRIBUTION` scope → NO capture; disarmed → no capture; undo/redo
  markers.
- Codegen unit: per-kind mapping; batch trio; privileged → NOT REPLAYABLE; notebook
  → all NOT REPLAYABLE; pragma + `caps` threading only when model actions present;
  byte-stability of model-free macros; fills/remove-duplicates now emitted.
- Mirror/drift: codegen mapping keys == `BI_MODEL_SCRIPTABLE_KINDS`
  (`validators.ts:3136`) == Rust `GATEWAY_MUTABLE_KINDS` (`model_editor.rs:5445`);
  generated payloads pass broker validators.
- Replay integration: generated source through `runObjectScriptOnce` with `bi.model`
  granted → gateway receives recorded payload.
- Live e2e: arm → real `bi_model_upsert_measure` → stop → save → run macro → measure
  exists.

### Open questions (v1 answers assumed)

1. `calculatedTable` delete cascade choice is invisible to the diff → record
   `cascade: false` + comment.
2. Connect/credential gestures produce no model diff → silent omission; document
   "connect before running the macro".
3. Model undo of a non-last recorded action stays heuristic (pop-last-if-model).
4. Pausing recording keeps Rust armed; session handler drops events (less plumbing).

---

## Feature 2 — Fused CLI (shared kernel + app domain)

**Architecture:** kernel in `app/extensions/_shared/cli/` (`lex.ts` + `format.ts`
move verbatim; `parse.ts` parameterized by a `CliVocabulary`; `registry.ts` with
`CliDomain`/`CliKindSpec`/`CliOptionSpec`/`CliBatchStrategy` interfaces; `engine.ts`
generalizing planRun/executeRun; `optionSchema.ts` — one table drives validation +
completion + help, killing the current triplication; `glob.ts` from the generic half
of `resolve.ts`; `language.ts` Monaco "calcula-cli"; shared `CliPanel.tsx` +
`CliReferencePane.tsx`). ModelEditor keeps owning its domain
(`cli/modelDomain.ts` wraps existing readers/writers/gateway/help/docs). New
`app/extensions/CommandLine/` extension hosts the app domain + main-window panel.

**Dispatch:** kind-driven with globally unique kinds (build-time uniqueness
assertion) + per-window default domain. Model editor window: Ctrl+` (existing raw
listener — that window has no Shell/keybinding registry; extend it to also accept
Ctrl+Shift+P). Main window: **Ctrl+Shift+P** via the keybinding registry
(`context.keybindings.register`, user-remappable), View-menu item, panel as a
`position:fixed` bottom strip via `context.ui.dialogs` (WatchWindow precedent — no
shell surgery). Kind collision: app domain registers `gridtable` (alias `table` only
in windows without the model domain).

**Atomicity (honest, per domain):** model domain unchanged (batch = one undo step,
true rollback). App domain: `beginUndoTransaction("CLI run: …")` /
`commitUndoTransaction`; on mid-run error **commit the partial** and print "the K
completed edits were kept as ONE undo step — run 'undo' to revert" (never
`cancelUndoTransaction` — verified not a rollback). Mixed model+grid writes in one
run → plan-time `CliError` (reads may mix). Confirm card renders the owning domain's
`confirmNote`.

**V1 app verb set** (every row backed by a verified typed @api export):
`ls sheets|gridtables|names|pivots|macros|commands`, `show sheet|name|range`,
`goto` (A1 / range / Sheet2!A1 / named), `set cell A1 = <tail-verbatim-as-cell-input>`,
`set range A1:B9 format=…` (audited `FormattingOptions` subset),
`set sheet hidden=|tab=`, `add|rename|delete sheet`, `add|rename|delete name`
(`=`-tail = refersTo), `delete range what=contents|formats|all`,
`sort … by= order= headers=`, `run <macro>` (via `macroRunService`),
`command <registry-id> [= json]` escape hatch, `undo`/`redo` (grid stack), `recalc`.
Dropped from v1: charts, filters, freeze/split, protection, move/copy sheet — all
fit the registry later without grammar changes.

**Trust (restated consciously):** the CLI is trusted UI, same privilege as a menu
click. Kept unreachable from sandboxed scripts: engine never exported via `@api`,
`commandLine.toggle` not `scriptSafe`, panel is the only entry point.

### Migration steps (model CLI green + `lint:boundaries` clean at every step)

1. Move `lex.ts`/`format.ts` verbatim; split `resolve.ts` into generic `glob.ts` +
   model matchers; update ~8 import sites.
2. Parameterize the parser (vocabulary passed in; model side re-exports typed
   `Verb`/`Kind` + narrows via `asModelCommand` so writers/readers keep exhaustive
   switches). Every existing parse test stays byte-for-byte.
3. Introduce `registry.ts` + `engine.ts`; wrap existing model code as
   `modelDomain.ts`; model batch maps to batchCancel → "rolled-back".
   `cli.test.ts` assertions pass unmodified.
4. Generalize Monaco language + panel + reference pane; **model editor keeps exact
   localStorage keys** (`calcula.modelEditor.cli.*`) via `storagePrefix`;
   `OPTION_KEYS` moves into the domain as specs (completion-only for model — strict
   validation is a follow-up audit; app domain is strict from day one).
5. Build the app domain (mock-gateway test pattern mirrored from `cli.test.ts`);
   session caches sheets/names/tables/macros snapshots for completion.
6. Host in main window: `app/extensions/CommandLine/index.ts` — command,
   Ctrl+Shift+P keybinding, View-menu item, bottom strip; `calcula.app.cli.*`
   storage keys.
7. App reference docs; generalize `referenceDocs.test.ts` into a per-domain harness
   (link integrity + kind coverage) run for both domains; window-appropriate
   shortcut wording per domain.
8. Cleanup: dead re-exports, boundaries check (kernel must never import a domain).

**Saved scripts/history:** localStorage per window in v1 (existing model keys
untouched; new app keys). Workbook persistence: future work.

**Macro-recorder relationship:** no coupling in v1. `run <macro>` invokes recorded
macros; `command`-verb dispatches are already recordable via
`setCommandRecorderHook`. Protect the future "record as CLI script" target only by
keeping `Command` trivially serializable (opts is a Map — add a
`commandToText`/`optsToJSON` helper contract later; don't let `Command` grow
closures or live references).

### Risks

- Parser parameterization is highest-risk: kind-detection lookahead
  (`parse.ts:249`), plural special cases (`hierarchies`, `global`→`calctable`,
  pseudo-kind `sql`), `rename … to …` connective must transfer verbatim — mitigated
  by byte-for-byte test preservation.
- Type widening (`verb`/`kind` → `string`) kills switch exhaustiveness → narrow at
  the domain boundary with `asModelCommand`.
- Monaco completion context staleness → keep the "set context on every overview
  install" path (`CommandPanel.tsx:142`).
- localStorage key drift loses users' history/saved scripts → keys pinned in step 4.
- Verify at implementation: whether add/delete/rename sheet record grid undo entries
  (evidence ambiguous) — until confirmed, `delete sheet` always confirms and
  structure ops claim nothing about undo. Also audit which `FormattingOptions`
  fields are safe behind `set range`.

---

## Verification

**Feature 1:** `cargo test` (model_editor capture tests) from `app/src-tauri`;
`npx vitest` for codegen/session/mirror tests in `app/`; then live loop in
`tauri dev`: start recording (Ctrl+Shift+R) → open Model Editor → add a measure + a
grid edit → stop → generated source shows interleaved `api.*` and `caps.biModel.*`
calls with `// @capability bi.model` → run the macro on a fresh sheet → JIT consent
prompt for bi.model → measure exists + audit ring shows the gateway calls. Also
record a role edit → NOT REPLAYABLE comment, and confirm running a script during
recording records nothing model-side.

**Feature 2:** existing `cli.test.ts` + `referenceDocs.test.ts` green unmodified;
new kernel/app-domain vitest suites; `npm run lint:boundaries`; live: Ctrl+Shift+P
opens the main-window CLI, `add sheet Test` / `set cell A1 = =SUM(1,2)` /
`goto Test!A1` work with one-undo-step multi-write runs; Model Editor CLI unchanged
(Ctrl+`, history preserved); a run mixing `add measure` + `set cell` errors at plan
time.

**Commit points:** Feature 1 as one feature commit; Feature 2 as ~8 stepwise commits
per the migration order.
