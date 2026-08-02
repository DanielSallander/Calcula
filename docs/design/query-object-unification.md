# Query-Object Unification

Status: **consolidation moves 1–3 SHIPPED (2026-07-22).** Related:
`docs/design/paginated-reports.md`, `functions/pivot/design-view-reference.md`.

## Context

Three object families consume the same design-query system: pivot tables, grid
reports, and design-query charts. The COMPUTE layer was always shared (one DSL in
`_shared/dsl/pivotLayout`, one backend pipeline `compute_design_query_view`), but
the OBJECT layer was fragmenting — each family re-implemented control binding,
refresh triggers, and editor plumbing its own way (charts had no @param support
at all). The Power BI-style end state — one "visual object" with a query binding
and pluggable presentations — is the north star; migrating pivots onto it today
is too risky (interactive state, writeback, calc groups). Instead the SERVICES
layer was unified:

## The three consolidation moves (shipped)

1. **@param substitution is DSL-level, shared.** `paramSubstitution.ts` moved to
   `_shared/dsl/pivotLayout/` (grammar: bare `@Name` unicode idents, quoted
   `@"Any name"`, FILTERS-scoped, quote/comment-aware). `controlHints.ts` builds
   the editor `@`-completion from live controls — used by report AND chart
   editors. Design-query charts now substitute @params before compiling
   (`designQueryChartDataReader`), closing the worst divergence.

2. **One refresh orchestrator.** `_shared/lib/queryObjectRefresh.ts` owns the
   single `@api/controlValues` subscription (transient-skip, 150ms debounce,
   changed-name accumulation), targeting (only objects whose `boundControls`
   reference a changed name, case-insensitive), pass coalescing, and
   per-provider failure isolation. Families register a `QueryObjectProvider`
   (`kind`, `listBindings()`, `refreshObjects(ids, changedNames)`); the
   subscription starts with the first provider and stops with the last.
   Registered providers: `report` (`Reports/lib/reportQueryProvider.ts` —
   re-materialize with `auto: true`, one grid-cell refresh per pass) and `chart`
   (`Charts/lib/chartQueryProvider.ts` — invalidate chart cache + one overlay
   repaint; charts correctly use the repaint-only `app:grid-refresh`).

3. **One filter-binding standard: the @param pull model.** A query object binds a
   pane control / ribbon filter by referencing it in FILTERS (`@Name` /
   `@"Products.Category"`). The pivot ribbon-filter push list
   (`connected_pivots`) remains as pivot legacy; new object families must use
   @params + a provider registration, nothing else.

## North star (future, not now)

A generic query-bound object: `{query, connection, @param bindings,
presentation: pivot | table | chart | …, placement: grid region | overlay}` with
one store, one lifecycle, one `.calp` channel, one undo model. The shared
services above are the seam: converting a family later is a storage migration,
not a semantics change. Candidate first users: the deferred "paginated report"
form, card/KPI visuals. Pivots migrate last, if ever.

## Extension points

- New object family: register a `QueryObjectProvider` + use
  `substituteControlParams`/`extractControlParams` + `buildControlHints` in its
  editor. No new subscription/debounce code.
- Future trigger types (BI data-change refresh, `refreshMode`) belong in the
  orchestrator, not in families.
