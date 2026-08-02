# In-App Model Editor - Design Document

## Status

**Implemented** (July 2026) through ME-8 — full Studio parity, nothing
deferred. Pre-production — no deployed users.
Backward compatibility is a non-goal (see `calp-distribution.md` Status for
the standing rule).

**THE MODEL EDITOR IS THE ONLY MODEL-DESIGNER SURFACE.** Stand-alone
Calcula Studio (`c:\Dropbox\Projekt\Calcula Studio\`) is RETIRED and FROZEN
(2026-07-11): its capability is fully integrated here, it receives no
features and no compile fixes, and its build is expected to break as the
shared engine evolves. All model-authoring work targets
`app/extensions/ModelEditor/` (frontend) and
`app/src-tauri/src/bi/model_editor.rs` (backend commands).

Implemented surface: measures (ME-1), tables/columns + calculated columns
(ME-2), relationships (ME-3), hierarchies/KPIs/security roles/calculation
groups (ME-4), schema import + blank models (ME-5), **calculated tables (engine
term: global variables; QUERY-only — see docs/design/calculated-tables.md),
table variables, script functions (Rhai UDFs), contexts + context columns,
model settings (date-table marking + default lookup resolution), and an
Overview/validation summary (ME-6), plus a Testing Ground query runner with
ephemeral RLS preview and an execution-plan view, and a model-wide Lineage
dependency graph (ME-7)** — all hosted in the standalone editor window. This
closes the Calcula Studio sidebar parity gap for every panel except the SVG
relationship diagram (see Remaining Phases). Remaining phases at the end of
this document.

### ME-6/ME-7 additions (the Studio-parity migration)

- Engine: five copy-on-edit list mutators added to `engine-core::DataModel`
  (`with_contexts`, `with_context_columns`, `with_table_variables`,
  `with_global_variables`, `with_script_functions`) plus `with_date_table` /
  `with_default_lookup_resolution` — mirroring the existing `with_*` family
  (caller-validates contract). No new engine query semantics were needed; the
  model already carried every concept.
- `ModelOverview` now also carries `contexts`, `contextColumns`,
  `tableVariables`, `globalVariables`, `scriptFunctions`, `dateTable`,
  `defaultLookupResolution`, and per-relationship `filterPropagation`
  (previously silently dropped on edit).
- New `MAIN_AND_MODEL_EDITOR`-guarded commands, all through the engine-lock
  `mutate_and_overview` writer: `bi_model_upsert/delete_global_variable`,
  `…_table_variable`, `…_script_function`, `…_context`, `…_context_column`,
  `bi_model_set_date_table`, `bi_model_set_default_lookup_resolution`,
  `bi_model_validate` (read-only), plus the ME-7 read/query surface
  `bi_model_test_query` (+ `bi_model_cancel_query`) and
  `bi_model_dependency_graph`.
- The **context operation** DTO is a flat, `type`-discriminated struct bridged
  to the engine `ContextOp` enum by hand-built variant construction on the way
  in and enum flattening on the way out (a naive serde round-trip cannot
  cross that boundary) — covered by round-trip unit tests over every variant.
- **Testing Ground RLS preview is ephemeral:** the shared engine's sticky
  `active_role`/`user_identity`/`custom_data` are saved before the preview and
  restored afterward under the engine lock, so a preview never leaks into CUBE
  cells or a sibling connection's results.
- Frontend: one section component per capability under
  `extensions/ModelEditor/components/sections/`, all cloning the
  `RolesSection` template; a shared `FilterPredicateList` widget in
  `editorShared.tsx` (reused by Roles, Table Variables and context `Keep`
  ops); the Lineage layered SVG and the Testing Ground query builder are
  read-only sections (they consume `SectionCtx` but never `applyOverview`).

## Motivation

Calcula Studio proved the semantic-model authoring UX, but as a separate
application it recreated the two-tool split the founding vision rejects: a
model lived in a loose `.json` file, was edited elsewhere, and reached
Calcula by hand-carried export. The Model Editor absorbs that capability
into Calcula itself — the analogy is Power Pivot living inside Excel, not
Power Query. A user who hits a modeling wall fixes the model *in the
workbook that uses it*, and distributes it as a signed `dataset` package
(`calp_publish_model`) rather than a file.

Studio remains a standalone power tool during the transition (reference
implementation + advanced workbench) and is retired when the in-app editor
reaches parity. Phase 0a of that convergence already moved Studio's
formatter (`expression_to_formula`) and lineage extraction
(`extract_dependencies`) down into `engine-core`, where the editor consumes
them.

## The Editor Window

The editor is a **standalone Tauri window** (VBA-style), not a sidebar panel
— modeling UI needs the width. It follows the established secondary-window
pattern (chart-spec-editor, object-script-editor):

- `app/modelEditor.html` + `app/src/modelEditorMain.tsx` (Vite input
  `modelEditor`), rendering `ModelEditorApp` from the ModelEditor extension.
- Capability file `app/src-tauri/capabilities/model-editor.json` (event
  permissions only).
- Window label `model-editor`; the opener
  (`extensions/ModelEditor/lib/openModelEditorWindow.ts`) is a hardened
  singleton: re-attaches via `WebviewWindow.getByLabel` after a main-webview
  reload, coalesces concurrent opens through an in-flight promise, and uses
  an EDITOR_READY handshake where the ready signal is authoritative and the
  3s created-fallback can never suppress it.
- Cross-window traffic uses the sanctioned `@api/backend`
  `emitTauriEvent`/`listenTauriEvent` door (raw `@tauri-apps/api/event` is
  lint-banned in extensions). The editor emits `model-editor:model-changed`
  after every successful mutation; the main-window extension bridge converts
  that into the in-app `bi:model-changed` event and a `recalcWithCube()`, so
  CUBE cells and model-aware panes stay current.

### Window security (two independent axes)

1. **Window guards.** Every `bi_model_*` command — including the reads —
   plus `bi_get_connections`/`bi_get_connection` requires
   `MAIN_AND_MODEL_EDITOR` (`["main", "model-editor"]`). Reads are guarded
   because `bi_model_get_overview` returns the full model *including RLS
   role definitions*; the inert chart-spec/object-script windows must not be
   able to exfiltrate it (`script-sandbox-architecture.md` §7).
2. **Capability denylist.** All `bi_model_*` commands are registered under
   `biData` in `PRIVILEGED_BACKEND_COMMANDS`, so a non-trusted extension
   cannot invoke them through the governed `invokeBackend` door. BI reach
   for untrusted code remains exclusively the broker's consent-gated
   `bi.query` capability.

## Editing Architecture

### The model lives where it is used

The editor mutates a connection's **`base_model`** (the engine `DataModel`
kept on every BI connection) in place. Persistence is free: the embedded
model already saves into `.cala` (`capture_local_bi_connections`) and
publishes via `calp_publish_model`. There is no file round-trip and no
parallel definition store — this deliberately rejects Studio's
15-collection `Def` store + rebuild-per-command architecture.

Package-subscribed models are **read-only** in the editor (they reconstruct
from the package on every refresh; edits would silently vanish). The
overview says so rather than erroring.

### Engine primitives: list replacement, caller validates

`engine-core::DataModel` exposes copy-on-edit list-replacement mutators —
`with_measures`, `with_tables`, `with_relationships`,
`with_calculated_columns`, `with_hierarchies`, `with_kpis`,
`with_security_roles`, `with_calculation_groups` — that perform **no
validation**. The host edits the list, then runs `DataModel::validate()`
(a full builder rebuild: name collisions, dangling references, circular
measure refs, relationship column/type checks, hierarchy/KPI/role/group
rules) and surfaces the rich error in its own UI. Presentation metadata
edits use in-place setters (`Table/Column::set_display_name/
set_description/set_hidden`) that — unlike the consuming `with_*` builders —
can also clear values.

### The engine lock is the writer serialization point

Every model writer — Model Editor mutations (`apply_model_edit`), workbook
calculated measures (`bi_set_calculated_measures`), and dataset refresh
(`refresh_embedded_data_sources`) — acquires the shared engine's lock
FIRST, snapshots `base_model` + the calculated-measure overlay under it,
applies the pure edit closure, validates, `set_model`s, and mirrors the new
base onto every `model_key`-sharing connection before releasing. A
concurrent writer can neither interleave between snapshot and install nor
observe a half-applied state. Lock order is engine → connections
(the established order; conflicting connections → engine paths use
`try_lock`).

### DTO round-trips must be lossless (review-earned rule)

The command DTOs carry **every** engine field, even ones the UI does not
edit — otherwise an edit silently resets them. This was the dominant class
of review findings: join operators coerced to equality, `FilterPropagation`
reset, hierarchy `is_optional`/`stopper_value`/`ragged_behavior` dropped,
`Decimal(p, s)` calculated columns coerced to `Float64`, `is_hidden`
dropped on measure edits. All fixed by round-tripping (or explicitly
carrying over) the fields. **Any new entity DTO must be diffed
field-for-field against the engine struct before shipping.**

### Formula text and the parser boundary

The author's original formula text is first-class in the engine
(`Measure::source`, `CalculationItem::source`); display falls back to the
Phase-0a `measure_to_formula` AST rendering for sourceless measures. The
editor standardizes on the **engine parser** (`parse_measure_expression`,
whose `ParseError` carries a UTF-8 byte offset — converted to UTF-16 for
Monaco markers). Consequences:

- Everything the editor authors is engine-parseable by construction.
- A **sourceless** measure whose rendered formula is saved *untouched* keeps
  its original expression (metadata-only edit) — reconstructed text the user
  never wrote is never re-parsed.
- Measures written in Studio's divergent syntax (`->`/TRAVERSE) display but
  cannot be re-edited until the parsers unify (Phase 0b, below).

## Command Surface

All under `app/src-tauri/src/bi/model_editor.rs`, all
`MAIN_AND_MODEL_EDITOR`-guarded, all mutations through the engine-lock
writer path and marking the document dirty:

- `bi_model_get_overview` — tables/columns (physical + calculated),
  relationships, hierarchies, KPIs, roles, calculation groups, measures,
  bound-state per table, editability + reason.
- Measures: `get_measures`, `validate_measure` (positioned errors),
  `upsert_measure`, `delete_measure` (refuses while referenced — including
  by workbook calculated measures), `measure_lineage`
  (`extract_dependencies` + referenced-by).
- `update_table` / `update_column` — presentation metadata.
- `upsert/delete_calc_column`, `upsert/delete_relationship`,
  `upsert/delete_hierarchy`, `upsert/delete_kpi`, `upsert/delete_role`
  (static + dynamic `USERNAME()`/`CUSTOMDATA()` RLS predicates),
  `upsert/delete_calc_group` (`SELECTEDMEASURE()` items).
- `list_source_tables` / `import_tables` — live-connector schema discovery
  (`Connector::list_tables`/`introspect_table`) under the engine lock;
  imported tables are appended, validated, installed, bound
  (`Engine::bind_table`) and the bindings persisted on every model-sharing
  connection.
- `create_blank` — an empty `DataModel` as a **path-less connection**
  (`create_connection_from_json`, synthetic `local:{id}` identity): the
  model is embedded in the workbook from birth; publish it as a `dataset`
  package to distribute.

## Known Limits (v1)

- Model edits are not undoable (consistent with connection operations).
- Table/column *rename* is out of scope — no engine-side AST rewriter for
  the reference ripple; `display_name` editing covers the presentation need.
- Calculation-group and role editing are list-form, not diagrammatic;
  the relationship diagram (Studio has an SVG one) is future work.
- Edits to a shared model are visible to every consumer of that engine
  immediately — which is also the feature.

### ME-8 — "nothing left behind" (the deferred-items round)

All items previously deferred were then completed (verified: engine-core 1061
tests, app 14 tests, tsc + boundaries clean):

- **SVG relationship diagram.** Ported from Studio's `diagram/*` into
  `extensions/ModelEditor/components/diagram/` (adapted to the camelCase `@api`
  types + literal colors). `RelationshipsSection` has a **List/Diagram** toggle;
  the diagram supports auto-layout, node drag (positions persisted per
  connection in `localStorage`, NOT in the model file), column-drag-to-create
  (opens the relationship modal pre-filled), and double-click-edge-to-edit.
- **Parser unification (TRAVERSE).** The engine parser now accepts
  `TRAVERSE(expr, a -> b -> c)` (new `Arrow` token recognized before `-`; a
  relationship-path parser; grammar dispatch + builtin registration). The
  engine already modeled/validated/rendered `Traverse` — only the parse was
  missing — so Studio-authored TRAVERSE measures re-edit in-app. (The bare-
  `ColumnRef`-as-measure-reference convention is still a divergence.)
- **Testing Ground depth.** Added server-side sort, measure-value filters
  (HAVING), TOP-N and RANKX (with the rollup-incompatibility guard) — the
  engine already honored these `QueryRequest` fields. (Lookups, calc-group and
  hierarchy-drill application remain backend-extendable but niche for an
  ad-hoc runner.)
- **Model metadata.** `name/version/author/description` are now `DataModel`
  fields (`with_model_metadata`, `#[serde(skip_serializing_if]` — no format
  bump needed) editable in Settings; they travel with the model on publish.
- **Storage-mode toggle** (`Table::set_storage_mode` + command) editable per
  table; **manual table refresh** (reuses the engine's async `refresh_table`)
  drops the in-memory cache so the next query re-fetches from source.
- **Per-table refresh strategies + incremental refresh** (`Table::
  set_refresh_strategies`/`set_incremental_refresh` + `bi_model_set_table_
  refresh`, editable in the Tables section for InMemory tables): `Interval`,
  `ContainsCurrentDate`, `DailyAfter`, `SourceQuery`, plus an incremental
  `refresh_filter`. The engine already honored these — `query_auto_refresh`
  (which Calcula's CUBE/pivot path uses) evaluates them on each query and
  re-fetches stale tables from source — they simply weren't editable in-app.
- **Monaco richness.** `bi_model_function_catalog` exposes the engine catalog;
  `measureLanguage.ts` now has context-aware completion (functions + tables +
  columns + measures), function hover, and signature help, fed from the model
  overview via `setMeasureLanguageContext`.
- **Undo/redo for model edits.** A per-`model_key` snapshot stack recorded in
  `apply_model_edit` (the single mutation choke point, so *every* mutation is
  undoable); `bi_model_undo/redo/undo_state` reinstall a snapshot on the shared
  engine and mirror it to sibling connections; Undo/Redo buttons in the editor
  top bar.

## Remaining Phases (multi-session, deliberate)

1. **Parser convergence tail.** The bare-`ColumnRef`-as-measure-reference
   convention and deduplicating Studio's divergent `expand_measure_refs`
   remain (TRAVERSE is done).
2. **Editor depth (nice-to-haves):** a diagrammatic calculation-group UX;
   Testing Ground lookups/calc-group/hierarchy-drill; saved test layouts.
3. **Studio retirement assessment** — sidebar parity is reached (including the
   SVG diagram); two frontends over one engine is the standing drift tax this
   migration was built to end.

### Deliberately out of scope for the embedded-model editor

- **A proactive background refresh timer.** Per-table refresh *strategies* and
  incremental refresh ARE supported and now editable (ME-8), but the engine
  evaluates them **lazily on each query** (`query_auto_refresh` re-fetches a
  stale table before running the query) — there is no wall-clock daemon that
  refreshes tables when no query is running. A cache-status dashboard and
  memory-budget tuning UI are also not surfaced. (Manual on-demand refresh,
  the storage-mode toggle, and strategy editing all ship.)
