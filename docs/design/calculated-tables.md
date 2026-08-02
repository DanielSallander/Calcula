# Calculated Tables

Status: ALL PHASES (0-4) SHIPPED 2026-07-11. Scalar collapse, rename, engine
materialized mode incl. refresh integration, full app surfaces (mode setting,
cascade-confirm dialogs, Materialize button, auto-materialize-on-save), and
Phase 4: `QUERY(DISTINCT t[col], ...)` (materialized-only unique-rows form),
`CALENDAR(YYYY-MM-DD, YYYY-MM-DD)` generated date tables (fixed schema: date,
year, quarter, month, month_name, day, day_of_week; materialized-only, no
host table), and `.calp` snapshot carry — publish embeds each materialized
calculated table's cached batch as an Arrow IPC artifact
(`models/{ds}/calculated_tables/{i}.arrow`, integrity-checksummed), pull
restores it via `Engine::store_calculated_table_snapshot` so subscribers
without source access still see the data. Next: the DAX gap backlog
(ALLSELECTED, LOOKUPVALUE/RELATED, dynamic format strings, TREATAS, ...).
Owners: Model Editor + BI engine
Supersedes: the "Shared Expressions" / model global variables concept

## Summary

The model-level "shared expression" entity (engine term: `GlobalVariable`)
becomes **Calculated Tables** — the Calcula counterpart to Power BI's
calculated tables, with one Calcula-specific twist Power BI cannot express:
a calculated table can be **Dynamic**, i.e. evaluated per query in the live
filter context, instead of frozen at model refresh.

Two decisions drive this redesign:

1. **Scalar shared expressions are removed.** Analysis (2026-07-11) showed a
   scalar shared expression is semantically identical to a measure reference
   (both are static inlining into the evaluated expression tree), while being
   strictly less capable (cannot reference measures or other shared
   expressions). Power BI has no such concept and nobody misses it: measures
   fill the seat completely. Reusable scalars are now defined as (optionally
   hidden — `Measure::is_hidden`) measures. Bonus: the bare-identifier
   namespace shrinks, killing most of the GVAR-name-collision surface.
2. **The remaining table-producing `QUERY(...)` form is a real concept worth
   a real name.** It is our answer to Power BI calculated tables; naming it
   the same thing makes it instantly recognizable to Power BI users.

## The mode setting

Each calculated table has exactly **one** behavioral setting:

**Dynamic — yes (default) / no**

| | Dynamic: yes | Dynamic: no ("materialized") |
|---|---|---|
| Evaluation | Per query, in the live filter context (slicers, RLS role) | At model refresh, over the unfiltered model |
| Existence | Virtual — never a model table | A real `Table` in the model |
| Referenced from measures | `name[column]` (injected as a VAR binding) | `name[column]` like any table |
| Relationships | Forbidden | Allowed (incl. non-equi/range joins) |
| Pivot / field-list source | No | Yes (unless hidden) |
| Hidden from field lists | n/a | Existing table-level `is_hidden` flag |

There is deliberately **no second "add to model" setting**. The design
discussion (2026-07-11) showed the 2x2 of (dynamic, add-to-model) contains an
incoherent quadrant — a relationship targeting a table whose rows depend on
the current query's filter context is circular by construction, since filter
context propagates *through* relationships — and a redundant quadrant:
"materialized but not added to the model" is just a materialized table with
`is_hidden = true`. Materializing implies becoming a model table; visibility
is the existing hidden flag.

## Mode-switch propagation (app contract)

Changing the setting must propagate through every surface where tables
appear. This is a hard requirement, not a nice-to-have:

- **Dynamic -> materialized:** the table appears in the Tables list (with a
  "calculated" badge), the Relationships view, the Lineage graph (as a table
  node), pivot/field lists (subject to hidden flag), and the refresh
  scheduler. No confirmation needed — the change is additive.
- **Materialized -> dynamic:** destructive. All relationships touching the
  table are **removed** (UI confirms first, listing what will be deleted),
  it disappears from the Tables list / Relationships view / field lists, and
  anything that consumed it as a real table (pivots sourced from it, role
  filters targeting it, hierarchies on it, other entities referencing its
  columns outside measure expressions) must either be cleaned up in the same
  confirmed cascade or block the switch with a clear error listing the
  dependents. Measure references (`name[column]`) keep working — they are
  valid in both modes.

## Materialization semantics (engine)

A materialized calculated table is an `InMemory` table whose source is a
**model query** instead of a connector binding.

1. **Evaluation context at refresh:** no slicers, no group axis, evaluated
   over the unfiltered model. Same as Power BI.
2. **RLS:** the snapshot is computed **without** role filters (there is no
   user at refresh time). Role filters may target the materialized table
   directly, and relationship propagation applies to it like any table —
   same posture as Power BI. Must be stated in the security docs (our RLS is
   already documented as advisory).
3. **Refresh ordering:** calculated tables refresh **after** their source
   tables, topologically ordered; calculated-table -> calculated-table
   chains are allowed, cycles rejected at model build (same posture as
   measure-reference cycles). Slots into the existing `RefreshStrategy`
   machinery.
4. **Schema inference:** QUERY output already has named, typed columns
   (aggregate aliases + BY columns) — these become the `Table`'s `Column`s,
   which is exactly what relationships need.
5. **Persistence:** new table-source kind (model-query) + `format_version`
   bump — with the explicit stamp at BOTH write sites (`.cala` save and
   `.calp` publish; the model is persisted via serde and never auto-stamps).
   `.calp`: decide whether packages carry the snapshot data or recompute on
   pull (lean: carry data, like pivot caches, so subscribers without source
   access still see the table).
6. **QUERY expressiveness fast-follow:** dimension-building scenarios
   (distinct-values tables, date/calendar tables — Power BI's
   `CALENDAR`/`DISTINCT`) will be the first materialization targets users
   try, and QUERY today only does aggregate-BY grouping. Scoped as a
   fast-follow, not a v1 blocker.

## Phased plan

- **Phase 0 — scalar collapse (engine + app):** remove scalar support from
  `GlobalVariable` / `parse_global`; validation rejects non-QUERY
  expressions with guidance ("define a hidden measure instead"); remove the
  scalar expansion path; existing scalar globals in dev models are
  hand-migrated (pre-production, no compat shims per project policy).
- **Phase 1 — rename (strings-only):** "Shared Expressions" -> "Calculated
  Tables" across Model Editor UI, Tauri + engine user-facing messages, docs.
  Code identifiers (`GlobalVariable`, serde keys, command names) unchanged
  until Phase 2 forces struct changes anyway.
- **Phase 2 — materialized mode (engine):** the six points above. SHIPPED
  2026-07-11: `GlobalVariable.dynamic` (serde default true) + derived-table
  synthesis (`Table.is_calculated`, reconciled idempotently in
  `DataModelBuilder::build` and `DataModel::with_global_variables`, now
  fallible), schema inference (`infer_calculated_table_columns`),
  `Engine::materialize_calculated_table(s)` (overlay-measure execution via
  `plan_and_execute`, no RLS, result cast/renamed to the declared schema,
  stored through `store_refreshed_table`), `refresh_stale` integration
  (dependency-ordered, re-materializes when a source refreshed or cache
  missing), `refresh_table` routing, planner accepts source-less calculated
  tables (cache-served), format v15 + host stamp at both write sites.
- **Phase 3 — app surfaces + propagation:** SHIPPED 2026-07-11. Mode setting
  in the Calculated Tables tab (Dynamic checkbox + dynamic/materialized
  badge); auto-appearance in Tables/Relationships/Lineage/field lists (free —
  the derived table is a real model table in the overview); the CONFIRMED
  destructive cascade for materialized -> dynamic / rename / delete:
  `bi_model_calculated_table_dependents` lists what is bound to the derived
  table (relationships, hierarchies, role filters, table variables), the UI
  confirms, and `cascade: true` on upsert/delete strips them in the same
  edit (without cascade the engine still fails closed); an explicit
  "Materialize" row button + auto-materialize after saving a materialized
  calculated table (`bi_model_materialize_calculated_table`), in addition to
  the automatic cache-warm / refresh_stale path.
- **Phase 4 — fast-follows:** SHIPPED 2026-07-11.
  - `QUERY(DISTINCT t[col], ...)`: aggregate-less `Query` (empty aggregate
    list — serde-compatible, no format bump). Materialized-only: measure/VAR
    validation rejects it with guidance; materialization injects a hidden
    COUNTROWS overlay measure and drops its column at conform.
  - `CALENDAR(start, end)`: a `GlobalVariable.calendar: Option<CalendarSpec>`
    (v15 history amended, same-day) with a placeholder Query AST; fixed
    7-column schema; rows generated directly at materialization (Hinnant
    civil-date math, ~200-year span cap); no host table; forced materialized.
  - `.calp` snapshot carry: `PublishDataSource.calculated_table_snapshots`
    (Arrow IPC stream bytes) -> `models/{ds}/calculated_tables/{i}.arrow`
    artifacts + `PackageDataSource.calculated_table_snapshots` manifest refs
    -> `PulledDataSource` resolves paths -> pull restores via
    `Engine::store_calculated_table_snapshot` (fails closed for
    non-calculated tables). Publish warns when a materialized table has no
    cached data to snapshot.
  - Then return to the DAX gap list (ALLSELECTED, LOOKUPVALUE/RELATED,
    dynamic format strings, TREATAS, field parameters, ISFILTERED, PATH,
    DETAILROWS, OLS/perspectives).

## Cross-component touchpoints

- Engine (`model-engine-lib/crates/engine-core/src/`): `model/global_variable.rs`,
  `compute/expression/globals.rs`, `compute/parser/mod.rs::parse_global`,
  `model/schema/builder.rs` validation, refresh machinery, format version.
- App (`Calcula`): `extensions/ModelEditor` (GlobalsSection -> calculated
  tables tab, Tables/Relationships/Lineage sections), `src-tauri/src/bi/
  model_editor.rs` commands, `.cala`/`.calp` write sites for the format
  stamp.
- Studio is transitional (being folded into the Model Editor) and only needs
  to keep compiling.
