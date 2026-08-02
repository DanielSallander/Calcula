# Notebook = Analysis Workbench — identity, model access, structured outputs

**Status:** Phase 1 (1a + 1b) IMPLEMENTED 2026-07-03. Phase 2 (literate notebook)
and Phase 3 (workbench bridges + promotion) IMPLEMENTED 2026-08-01 — see §5.
Phase 4 still planned.

## 1. Identity — the piece of the puzzle the notebook owns

The ScriptNotebook feature predates a clear division of labor and read as
"another place to write JS against the grid," overlapping the object-script
editor. This document fixes its identity: the notebook is Calcula's
**analysis workbench** — the surface where you *interrogate* data (grid AND
Calcula models), keep the reasoning next to the results, and distribute the
whole analysis. Every scripting surface then answers a distinct user question:

| Surface | Question it answers | Mode |
|---|---|---|
| Object scripts | "when X happens, do Y" | reactive automation, event-driven |
| Custom Functions | "give me a new formula" | formula-language extension |
| Model Editor | "define the semantic model" | authoring |
| Pivots / CUBE / slicers | "show model data on the grid" | live consumption |
| **Notebook** | **"let me explore the data and keep the analysis"** | sequential, human-driven, documented |

This is a vision-level differentiator, not parity-chasing: Power BI has no
notebook (users leave for DAX Studio / Tabular Editor); Excel has none; and
Calcula's Model Editor authors measures with **no evaluate surface anywhere**
— the notebook becomes exactly that surface.

**Anti-goals (what keeps it from competing):** no event hooks (object
scripts' turf), no UDF registration (Custom Functions' turf), no model
*mutation* (Model Editor's turf), and no `net.fetch`/`storage`/`ui.html` —
only the read-only `bi.query`/`bi.sql` family ever reaches a notebook cell.

## 2. What shipped in Phase 1

### 2a. Executor thread + structured outputs

- **Dedicated executor thread** (`app/src-tauri/src/scripting/notebook_executor.rs`):
  one lazily-spawned OS thread owns the persistent `NotebookSession`
  (rquickjs is `!Send`); async Tauri commands exchange jobs over
  `std::sync::mpsc` + tokio oneshot replies. This DELETED the old
  `SendableSession` `unsafe impl Send/Sync` (the session never crosses a
  thread again) and unfroze the UI during long cells (commands were
  previously sync on the main thread). `notebook_exec_lock`
  (tokio `Mutex<()>`) serializes whole orchestrations (run / run-all /
  rewind / run-from / reset) at the command layer; `run_cell_internal` is
  three-phase so no std `MutexGuard` lives across an await.
- **Structured output items** (`ScriptOutputItem` in
  `core/script-engine/src/types.rs`): `Text {text}` |
  `Table {columns, rows, truncated, totalRows}` (serde camelCase, `kind`
  tag). `console.log`/`Calcula.log` push Text; **`display.table(...)`**
  (`core/script-engine/src/display.rs`, JS glue + hidden native sink) pushes
  Table items; a cell's last expression auto-renders as a table when it is
  `{columns, rows}`-shaped (strict detection: all columns strings, all rows
  arrays — `display::detect_table_shape`). String-only surfaces (run_script,
  MCP execute_script) flatten via `ScriptOutputItem::to_text()`.
- **Caps:** 200 rows per live Table item, 100 table items per run,
  50 persisted rows per table in `.cala`
  (`app/src-tauri/src/persistence.rs::output_item_to_saved`), 50,000 rows
  entering JS from one model query. Every cap re-flags `truncated` and
  preserves `totalRows` so footers report the original size.
- **Persistence mirrors** (project pattern, one per layer):
  `script_engine::ScriptOutputItem` ↔ `persistence::SavedNotebookOutputItem`
  ↔ `calcula_format::features::notebooks::NotebookOutputItemDef`. The calp
  publish/pull **strip of execution metadata is unchanged** (forged-output
  defense in `core/calp/src/pull.rs` still holds — tests updated to the new
  types).
- **Frontend:** `NotebookOutputItem` TS mirror; shared
  `app/extensions/_shared/components/ResultTable.tsx` (sticky header,
  numeric right-align, show-more paging, truncation footer);
  `CellOutput.tsx` renders items and gives table outputs **Copy CSV** and
  **Send to grid** (at selection / on new sheet) via `@api`
  (`useGridState` + `updateCellsBatch` with `invariant: true`, `addSheet`).

### 2b. Read-only `model.*` API + governance convergence

- **Crate-boundary injection:** `core/script-engine/src/model_provider.rs`
  defines `ModelDataProvider` (connections / model_info / query / sql /
  cube_value / cube_members / cube_kpi) + `ModelQuerySpec`/`ModelTable`.
  The engine stays policy-free; the app injects
  `bi/script_provider.rs::HostModelProvider` when the executor creates the
  session (a `ProviderSeed {AppHandle, tokio Handle}` crosses the thread;
  the `Rc<dyn ModelDataProvider>` is built on the executor thread).
- **JS surface** (`core/script-engine/src/ops/model.rs`, glue-installed
  `model` global; hidden `__calcula_model_*` native sinks):
  `model.connections()`, `model.info(conn)` — both are **sanitized whitelist
  projections**, not raw host DTOs: `info` runs the worker-realm gateway's own
  `sanitized_model_info`, so no security/RLS roles (names, per-table filter
  predicates, dynamic-identity markers) and no connection targets (`sources`,
  per-table `sourceId`) reach script code —
  `model.query(conn, {measures, groupBy?, filters?})`,
  `model.sql(conn, "SELECT …")`, plus CUBE parity
  `model.value/members/kpi`. Results are `{columns, rows, rowCount,
  totalRows, truncated}` + `.objects()` and `.toGrid(row, col, {headers?,
  sheet?})` — `.toGrid` writes through the **cloned ScriptContext grids**
  (audited, undoable, rewindable like any notebook mutation; the
  `bi_insert_result` locked-region path is deliberately not exposed here —
  it fights checkpoint/rewind; Phase 4 adds it as a UI action instead).
  Wire shapes match the worker realm's `capabilities.biQuery`, so snippets
  port across surfaces. `conn` accepts a connection name or id
  (`conn_id_by_name`, same as `cube.*`).
- **No new query path:** the provider funnels through gate-free cores
  extracted from the existing script commands —
  `bi_query_core` (RLS `apply_connection_role` inside the engine lock,
  auto-refresh, cache save) and `bi_sql_core` (`validate_readonly_sql`,
  auto-connect, 100k cap) in `app/src-tauri/src/bi/commands.rs` — and the
  existing `script_cube_*` helpers. RLS and read-only validation hold by
  construction. `bi_query`/`script_bi_sql` commands now call the same cores.
- **Sync/async bridge:** provider methods run on the executor thread (a
  plain OS thread) and drive the async internals via
  `Handle::block_on(tokio::time::timeout(60s, …))` — a hung source times
  out instead of wedging the notebook; the UI thread is never involved.
- **Governance (the C3 change):** the documented "notebooks have no
  capabilities because there is no ambient surface" rationale is RETIRED
  (see the 2026-07 update note in `script-sandbox-architecture.md`).
  Notebook cells now hold exactly the read-only pair:
  - Grants live in the existing in-memory Rust `CapabilityStore`, keyed by
    the surface id `notebook:{id}` — session-scoped, one consent per
    notebook per capability per session; `grant_script_bi` mirrors grants
    (main-window-guarded).
  - Every provider call re-checks the grant **server-side** and records an
    always-on `CapabilityCall` audit entry (success AND denial) via
    `record_capability_call` — same redaction policy as the worker gates
    (connection + measure list / 60-char SQL prefix, never full SQL).
  - A consent miss surfaces as a JS error carrying the sentinel
    `BI_CONSENT_REQUIRED capability=… surface=notebook:{id}`; the frontend
    (`useNotebookStore`) prompts (JIT, mirroring the SCRIPT_PROMPT_REQUIRED
    pattern), grants via `grant_script_bi`, and retries the run once.
    Batch paths (run-all / rewind / run-from) handle the sentinel on the
    last response the same way.
  - `check_script_security` still gates the whole surface, unchanged.
  - Sensitive connection fields (connection strings, servers, database
    names, model paths) are whitelisted OUT of `model.connections()`.
- **Containment story now:** worst case = mutate the grid (undoable) +
  read granted model data (consented, audited). Still no network /
  filesystem / Tauri reach. `scriptSurfaces.ts` row updated.
- **Rewind semantics:** query results are NOT part of grid checkpoints;
  rewind replay re-executes model calls (fresh data, re-audited). This is
  deliberate — deterministic replay of external data is out of scope.
- **IntelliSense:** `model`/`display` namespaces documented in
  `_shared/lib/calcula.d.ts` (notebook Monaco), drift-guarded by
  `calculaDtsCoverage.test.ts`.

## 3. Planned next phases

- **Phase 2 — literate notebook:** DONE, see §5.1.
- **Phase 3 — workbench bridges:** DONE, see §5.2–§5.4.
- **Phase 4 — distributed analysis polish:** provenance banner + "Make a
  copy" for `sourcePackage` notebooks; `InspectedNotebook.requestedCapabilities`
  listed in the subscribe dialog; distributed grants mirrored through
  `@api/distributedConsent` (SHA-256 of joined sources) then
  `grant_script_bi` on open; "Insert as connected region" on
  provenance-tagged table outputs via `biInsertResult`.

**Cut (judged):** reactive cell DAG (fights shared-scope replay; stale-cell
marking answers staleness honestly), scheduling (no headless runtime),
parameterized notebooks (edit a distributed copy instead), dedicated SQL
cell kind (a `model.sql(...)` JS cell is equal power; `kind` union stays
open), inline chart outputs (send-to-grid + normal charts meanwhile),
folder/id rename, separate notebook window (notebook_* commands are
main-window-guarded by design).

## 4. Verification

- `cargo test -p script-engine` (display caps/shape detection, canonical
  model), app-crate `notebook_executor` tests (session persistence across
  cells via the executor, reset, structured table output end-to-end),
  `calp` pull tests (forged-output strip with the new item types).
- Windows note: app-crate test exes need `app/src-tauri/fix-test-manifest.ps1`
  after `cargo test --no-run` (cargo test binaries lack tauri-build's
  manifest, bind comctl32 v5, and die at load on the v6-only
  TaskDialogIndirect import — 0xc0000139). Idempotent; see the script header.
- Vitest: ScriptNotebook suites (store/workflows/state-machine/concurrent +
  d.ts coverage incl. `model`/`display`), @api suites.
- Manual E2E (once a model connection exists): consent prompt on first
  `model.*` call → allow → query renders as table → Send to grid → undo
  restores; `model.sql` prompts separately for bi.sql; audit viewer shows
  Scripts + Capabilities entries; RLS role filters notebook queries; rewind
  replays queries fresh; concurrent Model Editor edit + querying cell both
  complete (engine-lock wait); long cell leaves the UI responsive.

## 5. What shipped in Phases 2–3 (2026-08-01)

### 5.1 Literate notebook — text cells

A cell's KIND is carried **in its source**: a first line of `//!markdown` makes
it prose. There is no new persisted field, and that is the deliberate choice —
the notebook record has three mirrored layers
(`scripting::types::NotebookCell` ↔ `persistence::SavedNotebookCell` ↔
`calcula_format::features::notebooks::NotebookCellDef`), so a `kind` field would
have meant a format bump and a migration for something the bytes can already
say. The marker is a JS line comment, so an older reader sees a commented cell
that does nothing rather than a corrupt one.

The rule is enforced on BOTH sides of the IPC boundary and the two
implementations are kept in lockstep by mirrored test tables:

- `ScriptNotebook/lib/cellKind.ts` — `cellKindOf` / `markdownBodyOf` /
  `withMarkdownMarker`; the UI hides run/rewind/run-from on a text cell and
  `useNotebookStore.runCell` returns early for one.
- `notebook_commands.rs::is_markdown_source` — **authoritative**.
  `run_cell_internal` is the single funnel for run / run-all / rewind /
  run-from, and it returns an inert success for a text cell *before* the
  script-security gate and before any checkpoint is taken. Prose therefore
  never reaches QuickJS (it is not valid JavaScript), never consumes an
  execution index, and a "prompt"/"disabled" Script Security setting does not
  make a literate notebook unreadable — there is nothing being executed to gate.

Rendering is `ScriptNotebook/components/MarkdownView.tsx`: markdown → React
elements, **no `innerHTML` anywhere**, link targets restricted to
`http(s)`/`mailto`. A distributed `.calp` notebook whose prose contains
`<script>` or a `javascript:` href renders as literal text. (The design note
suggested extracting FileExplorer's `MarkdownView` into `_shared`; that file is
outside this change's ownership — see §5.6.)

Affordances: `+ Code` / `+ Text` / `Model query…` in the notebook toolbar; a
text cell opens in edit mode when empty and renders on blur, double-click to
re-edit.

### 5.2 "Test in notebook" — the measure-evaluate bridge

`ModelEditor/lib/notebookBridge.ts` + a button in the measure modal, the
measures list, and the context modal.

What it does: calls the **read-only** diagnostic
(`bi_model_validate_measure` / `bi_model_validate_context` — the same commands
behind the modals' "Validate"), then emits a cross-window Tauri event carrying
**text**: a markdown cell (the draft expression, the verdict, and what will be
evaluated) plus a code cell containing a runnable `model.query(...)`.

What it does NOT do: touch `bi_model_upsert_*`, `bi_model_delete_*`, or the
batch commands. A test in `notebookBridge.test.ts` asserts the upsert mocks are
never called on either path.

**Honesty about what "evaluate" can mean here.** The engine's
`validate_measure_text` *compiles* a candidate against the live model; it does
not execute one, and there is no ad-hoc measure evaluation anywhere in the
engine (`QueryRequest` names measures, it cannot carry a definition). So an
unsaved draft genuinely has no number, and the scaffold says exactly that rather
than implying it ran the draft. What it evaluates instead:

- for an edit: the **saved** definition, to diff against the draft;
- the measures the draft references (`[Name]` refs intersected with the live
  model's measure list), so the parts can be checked before the whole;
- for a context: the measures that apply it today.

Handing over a scaffold grants nothing. The code cell's first `model.*` call
still meets the notebook's own per-capability consent prompt and is audited like
any other. The "Test in notebook" button on the measures list stays enabled on
package-subscribed (read-only) models, because the whole path is read-only.

### 5.3 Promotion — notebook snippet to object script

`ScriptNotebook/lib/promoteToObjectScript.ts`. The notebook keeps its
"no automation" anti-goal; a prototype graduates by becoming an object script.
Three properties, each with a test:

1. **Lands unmounted.** `promoteCellToObjectScript` calls `saveObjectScript`
   then `ObjectScriptManager.registerScript`, and never `mountScript`. The
   script appears in the Object Scripts pane as *Inactive*; the user starts it.
2. **Mounting still runs nothing.** The analysis body goes inside
   `workbook.expose("<method>", …)`, not into `setup()`. Mounting registers a
   callable method; the analysis runs when the method is called.
3. **Capabilities are derived, never blanket.** `planPromotion` scans the
   snippet: `model.sql` → `bi.sql`, the rest of `model.*` → `bi.query`, nothing
   else. `model.info` is deliberately NOT ported — object-script model metadata
   is gated on the stronger `bi.model`, and promoting must not widen a
   prototype's reach, so the shim throws and a porting note explains why. Grid
   writes are reported as an access-level decision; promotion is always
   `restricted`. The emitted `// @capability` pragmas are only a proposal: the
   backend re-derives the authoritative ceiling from the saved source
   (`object_script_commands.rs::save_object_script` →
   `parse_declared_capabilities`).

Consent: the notebook shows the derived capability set and the exact wording of
what happens ("saved INACTIVE… runs only when the exposed method is called —
never on workbook open") before anything is written; the normal script-security
gate and JIT capability prompts apply when the script is later started and run.

A `model` shim is emitted (only when the snippet used `model.*`) mapping to
`context.caps.biQuery` / `biSql` / `cube.*` / `listBiConnections` — the wire
shapes are identical by design. The one real difference is announced in the
generated source: worker-realm calls are ASYNC, so calls the cell made bare need
`await`.

### 5.4 Discoverability

- Notebook entry added to the **Data** menu (`data:notebook`, order 70). The
  Developer menu CONTAINER stays registered — AIChat and Controls inject into it.
- `Model query…` toolbar template (`lib/cellTemplates.ts`) — plain text; it
  grants nothing.

### 5.5 Anti-goals re-verified after this change

The notebook's reach is exactly the QuickJS op set installed in
`NotebookSession::new` (notebook.rs:129-136): `register_calcula_api` (cells,
sheets, utility, worksheet_props, extended, canonical_model, application),
`register_console`, `register_display`, `register_model_ops`. **This change adds
no op**, and touches neither `ops/model.rs` nor `model_provider.rs` nor
`script_provider.rs`.

- *No event hooks* — no op in `core/script-engine/src/ops/` registers a handler
  (a grep for `"on[A-Z]` over the op modules is empty). Nothing was added.
- *No UDF registration* — no `registerFunction`-style op exists; `formula.udf`
  is a worker-realm capability with no QuickJS sink.
- *No model mutation* — `ModelDataProvider` has exactly seven methods
  (`connections`, `model_info`, `query`, `sql`, `cube_value`, `cube_members`,
  `cube_kpi`), all reads; `HostModelProvider` implements only those; the seven
  `__calcula_model_*` sinks are the whole JS surface. The Model Editor bridge
  runs entirely in TRUSTED editor UI and reaches only the read diagnostics.
- *Only `bi.query` / `bi.sql`* — `check_cap` in `script_provider.rs` is called
  with those two ids and no others (lines 163, 199, 223, 268, 291, 314, 338).
  No `net.fetch` / `storage` / `ui.html` string appears anywhere in the notebook
  op modules.
- *The new cross-window channel is not script-reachable* — sandboxed code's only
  emit doors are `api.emitEvent` / `ext.emitEvent`, which emit DOM app events
  auto-namespaced `userscript:*` (`host.ts scriptEmitEventName`). No allowlist
  row, no aspect of `executeSetState`/`executeGetState`, no
  `EXTENSION_BROKER_METHODS` entry and no MCP tool emits a raw Tauri event or
  mentions `notebook`. The payload is re-validated and capped on arrival
  (`normalizeScaffoldRequest`) and only ever becomes cell TEXT — it is not
  executed on arrival.

### 5.6 CROSS-FILE REQUESTS (not done — outside this change's ownership)

1. `app/src/api/notebookBackend.ts`: promote the scaffold channel to a real
   `@api` door — `NOTEBOOK_SCAFFOLD_EVENT` + `requestNotebookScaffold(request)`
   + the `NotebookScaffoldRequest` type — so the contract stops being a string
   literal mirrored in `ScriptNotebook/lib/notebookScaffold.ts` and
   `ModelEditor/lib/notebookBridge.ts`.
2. `app/extensions/_shared/components/Markdown.tsx`: extract the safe markdown
   renderer (FileExplorer has one, this change added a second in
   ScriptNotebook). Both should be one component.
3. `app/src/shell/ActivityBar/useActivityBarStore.ts`: `MAX_WIDTH` 480 → ~760.
   A literate notebook with tables needs the room.
4. `app/extensions/BusinessIntelligence` (Connections pane): "Explore in
   notebook" — it can emit the same scaffold event once (1) lands.
5. `app/extensions/ScriptableObjects/index.ts`: local object scripts auto-mount
   on workbook LOAD (`loadAndMountScripts`). A promoted script lands unmounted
   in the session that created it, and its body sits in `expose` so a later
   auto-mount runs nothing — but "never auto-mount" would be stated more
   directly by a persisted `enabled` flag on `ObjectScriptDefinition` that the
   promotion path sets to false.
