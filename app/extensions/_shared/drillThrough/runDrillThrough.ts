//! FILENAME: app/extensions/_shared/drillThrough/runDrillThrough.ts
// PURPOSE: RUN a drill-through: from a source visual (a design-query chart or a
//          BI pivot), a definition and the clicked datum, to a new EPHEMERAL
//          sheet holding the result as a table of cells or as one chart.
// CONTEXT: docs/design/model-drillthrough.md 2.4 / 2.7 / 2.8. The steps, in
//          order, each one a decision the spec or its review made:
//
//          0. The source page's sheet id, read synchronously before anything
//             can move an index: the snapshot is consistent with the index the
//             source was recorded under.
//          1. `getSheets()`: whether the ACTIVE sheet is itself ephemeral (a
//             drill from a drill). Only RECORDED here -- nothing is discarded
//             until every check that can still refuse has passed (step 7), so
//             a refused drill never costs the user the page they were reading,
//             nor the definition they had just authored on it.
//          2. The model: `get_connection_bi_model` over the CALLER's bound
//             invoker (`io.invoke`); `_shared` owns no backend channel. A ZERO
//             or unknown connection is TOLD ("Open the model's connection
//             first"), never silently queried.
//          3. The filters, three parts with a rule each:
//             - the CLICKED PATH (`datum.filters`): always baked, in either
//               presentation, whatever field it is on;
//             - a pivot's STANDING filters (`datum.standing`): baked for a
//               table; for a CHART, one on a field that a workbook-wide
//               ("all"-scoped) report filter of the same connection filters is
//               LEFT OUT -- the backend wrote that ribbon filter into the
//               pivot, and it re-applies live on the new page, so a baked copy
//               would intersect with the live one when the filter later moves
//               (whatever keepFilters says: the new page reads it either way);
//             - the PAGE's filters, when the definition keeps them: resolved
//               for the SOURCE visual on its page (`resolveFiltersFor`) while
//               that page still exists. For a chart the workbook-wide ones
//               (`ResolvedFieldFilter.workbookWide`) are left out for the same
//               reason; the table bakes them (static cells). Tuple
//               (non-rectangular) selections have no DSL spelling: not
//               carried, told. An inclusion that keeps nothing refuses the run.
//          4. `@param`s are substituted BEFORE the bake, so the kept chart
//             stores the values it was dry-run with, never `@names`; the baked
//             line quotes its values and brackets its field names, and the
//             scanner skips both, so re-substitution on read is a no-op.
//          5. `bakeDrillFilters` writes ONE `FILTERS:` clause; a refusal is a
//             toast. `compileDesignQuery` turns the text into the request;
//             errors are a toast with the first line.
//          6. Every remaining check, still before anything changes:
//             - Chart: the query is DRY-RUN (`run_design_query`), the chart
//               store must be there, and the spec comes from the Charts seam
//               (`buildDesignQueryChartSpec`: Charts completes ITS OWN default
//               skeleton -- no copy of it lives here) and is VALIDATED there
//               (`validateChartSpec`, the check `createChart` runs), so a
//               definition whose mark or options a ChartSpec refuses never
//               leaves an empty page behind.
//             - Table, when a temporary sheet is to be left: the compiled
//               query is pre-flighted with `run_design_query`, which runs the
//               same engine route `toSheet` computes. RESIDUAL: the 100,000-row
//               cap stays Rust's one constant (`toSheet`), so a table whose
//               query runs but is too large is refused only after the
//               temporary sheet was left.
//          7. Only now does a drill from a drill LEAVE its temporary sheet: the
//             sheets are read AGAIN (the step-1 verdict went stale during the
//             model and dry-run round trips) and, when that sheet is still
//             listed and still temporary, the strip's core command
//             `core.sheet.discardEphemeral { sheetId }` is awaited. It
//             resolves true only once the sheet is gone (awaiting a discard
//             of the same id already in flight) and toasts its own refusal,
//             so a refusal stops the run WITHOUT a second toast. A sheet the
//             user kept meanwhile (a double-click on its tab) is not
//             discarded; one the strip already discarded needs nothing.
//          8. Table: `drill_through { op: "toSheet", presentation: "table" }`
//             computes the view and writes the cells under the definition's
//             name in bold (the Rust side); then the shell switch
//             (`activateSheet(index, { record: false })`: the backend already
//             activated it, this runs the choreography without a macro step)
//             and the "sheets" refresh.
//             Chart: an empty canvas is appended and activated, then ONE
//             design-query chart filling the page (16 px margins) is created
//             through the chart store seam every scripted route shares, from
//             the spec step 6 validated.
//          9. What was not carried -- the source's notices (warnings) and the
//             page's tuple notice (info) -- is TOLD once, only after the sheet
//             landed; a drill that fails tells only its failure.
//
//          EVERY failure is a toast and a `{ ok: false }` answer, never a
//          silent no-op (a refused discard's toast is the strip's own). Pure
//          helpers are exported for the tests.

import {
  AppEvents,
  CommandRegistry,
  activateSheet,
  drillKeepsFilters,
  drillThroughDisplayName,
  drillThroughSheetName,
  emitAppEvent,
  getChartStoreService,
  getReportPagesSnapshot,
  getSheets,
  sheetIdAt,
  showToast,
  type DrillFilterSpec,
  type DrillThroughDefinition,
  type DrillThroughToSheetRequest,
  type DrillThroughToSheetResponse,
  type IChartStoreService,
  type SheetsResult,
} from "@api";
import type { MutationRefreshPayload } from "@api/events";
import { getControlValue } from "@api/controlValues";
import {
  getReportFilters,
  resolveFiltersFor,
  type ReportFilter,
  type ResolvedFieldFilter,
  type ResolvedFilters,
} from "@api/reportFilters";
import { compileDesignQuery, type DesignQueryRequest } from "../dsl/pivotLayout/designQuery";
import { substituteControlParams } from "../dsl/pivotLayout/paramSubstitution";
import type { BiPivotModelInfo } from "../components/types";
import { DrillBakeRefusal, bakeDrillFilters, describeDrillFilters, drillMemberLabels } from "./dslFilters";

// ============================================================================
// Shapes
// ============================================================================

/** The visual a drill runs FROM. */
export interface DrillSource {
  /** The @api/reportFilters `VisualRef` kind: what the page's filters resolve for. */
  kind: "chart" | "pivot";
  /** The chart id / pivot id. */
  id: string;
  /** The source's TRUE sheet index (the page its filters are resolved on). */
  sheetIndex: number;
  /** The source object's BI connection (spec 2.2: the definition stores none). */
  connectionId: string;
  /** The source's name as a person knows it, for the sheet name and title fallbacks. */
  name: string;
}

/**
 * The clicked datum as KEY filters, in two parts the run treats differently.
 */
export interface DrillDatum {
  /**
   * The CLICKED PATH: a chart's member path (one spec per coordinate,
   * `includedKeys: [key]`, the label beside it), a pivot cell's path
   * (`pivotContext`'s `filters`). Always baked; the chart title's labels come
   * from here alone. EMPTY for a measure-only datum (a Card / KPI / Gauge, a
   * values-only pivot's total): the drill runs with the other filters only.
   */
  filters: DrillFilterSpec[];
  /**
   * A BI pivot's own STANDING filters (`pivotContext`'s `standing`). Baked for
   * a table; for a chart, one on a field a workbook-wide report filter of the
   * same connection filters is left out (it re-applies live on the new page).
   */
  standing?: DrillFilterSpec[];
  /**
   * What the source could not carry ("the filter on X could not be carried"):
   * told by the runner ONCE, as warnings, after the sheet landed, and written
   * into a table's caption. Never told by the caller as well.
   */
  notices?: string[];
}

/** The caller's BOUND backend invoker (`chartsBackend.invoke`, the Pivot channel's). */
export type DrillInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface DrillIo {
  invoke: DrillInvoke;
}

export type DrillThroughOutcome =
  | { ok: true; sheetIndex: number; sheetId: string; sheetName: string; chartId?: string }
  | { ok: false; reason: string };

/** Where the one chart of a chart presentation sits: the 1280x720 page less 16 px margins. */
export const DRILL_CHART_PLACEMENT = { x: 16, y: 16, width: 1248, height: 688 } as const;

/** The core command the tab strip registers for "discard this temporary sheet" (C7: resolves true once it is gone). */
export const DISCARD_EPHEMERAL_COMMAND = "core.sheet.discardEphemeral";

/** How many schema violations a refused chart spec names in its toast. */
const MAX_VIOLATIONS_TOLD = 3;

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * Whether a resolved page filter came from a WORKBOOK-WIDE publisher (a
 * published filter whose scope kind is "all"): the resolver says so on the
 * filter itself (C8), read from the publication's scope. Never inferred from
 * a name, a field or keys -- a page slicer may share all three with a ribbon
 * filter, and would then be dropped from a chart bake it belongs in.
 */
export function isWorkbookWideFilter(filter: ResolvedFieldFilter): boolean {
  return filter.workbookWide === true;
}

/**
 * The page's resolved field filters as drill specs. For the chart presentation
 * the workbook-wide ones are left out (they re-apply live on the new page);
 * the table presentation bakes them all. A filter that keeps nothing is kept
 * as an EMPTY inclusion so the merge refuses it with its message.
 */
export function pageFiltersToSpecs(
  filters: readonly ResolvedFieldFilter[],
  options: { presentation: "table" | "chart" },
): DrillFilterSpec[] {
  const out: DrillFilterSpec[] = [];
  for (const f of filters) {
    if (options.presentation === "chart" && isWorkbookWideFilter(f)) continue;
    out.push({ field: f.field, includedKeys: [...f.includedKeys] });
  }
  return out;
}

/**
 * The fields (lower-cased: fields match case-insensitively, the compiler's
 * rule) that a workbook-wide ("all"-scoped) published report filter on
 * `connectionId` filters.
 */
export function workbookWideFields(connectionId: string, published: readonly ReportFilter[]): Set<string> {
  const fields = new Set<string>();
  for (const p of published) {
    if (p.scope.kind === "all" && p.connectionId === String(connectionId)) fields.add(p.field.toLowerCase());
  }
  return fields;
}

/**
 * A source's STANDING filters as drill specs. The table bakes them all. For
 * the chart, a standing spec on a field a workbook-wide report filter of the
 * source's connection filters is LEFT OUT: a workbook ribbon filter is written
 * into every pivot of its connection, so the pivot hands it back as a standing
 * filter (a level-1 write as hidden keys, a pin as an IN-list -- which is why
 * the match is on the FIELD and never on keys); it re-applies live on the new
 * page, and a baked copy would intersect with it once the filter moves. The
 * match cannot recover provenance: a filter the pivot's own header put on that
 * same field after the ribbon filter is dropped with it (named in the spec).
 */
export function standingFiltersToSpecs(
  standing: readonly DrillFilterSpec[],
  options: { presentation: "table" | "chart"; connectionId: string; published: readonly ReportFilter[] },
): DrillFilterSpec[] {
  if (options.presentation !== "chart") return [...standing];
  const live = workbookWideFields(options.connectionId, options.published);
  if (live.size === 0) return [...standing];
  return standing.filter((s) => !live.has(s.field.toLowerCase()));
}

/** The notice for a page whose resolved filters hold tuple (non-rectangular) selections. */
export const TUPLE_FILTERS_NOTICE =
  "A selection across several fields on this page has no FILTERS spelling and was not carried into the drill-through.";

/** The notices a resolution produces: tuple selections are told, not carried. */
export function pageFilterNotices(resolved: Pick<ResolvedFilters, "tupleFilters">): string[] {
  return resolved.tupleFilters.length > 0 ? [TUPLE_FILTERS_NOTICE] : [];
}

/** "Table.Column" of every FILTERS field with NO values: the engine route drops them, so the caption lists them. */
export function valueLessFilterFields(request: DesignQueryRequest): string[] {
  return request.filterFields
    .filter((f) => f.includedItems === undefined && (f.hiddenItems === undefined || f.hiddenItems.length === 0))
    .map((f) => `${f.table}.${f.column}`);
}

/**
 * The caption lines written under the title (a table) -- COMPLETE lines,
 * written verbatim by the backend from row 1: what the result was filtered
 * to, what could not be carried, and the FILTERS fields the engine route does
 * not apply.
 */
export function drillCaption(specs: readonly DrillFilterSpec[], notices: readonly string[], valueLess: readonly string[]): string[] {
  const described = describeDrillFilters(specs);
  const lines = [`Filtered to: ${described || "all members (no filters)"}`];
  for (const n of notices) lines.push(`Not carried: ${n}`);
  if (valueLess.length > 0) {
    lines.push(`FILTERS fields with no values are not applied by a drill-through: ${valueLess.join(", ")}`);
  }
  return lines;
}

/**
 * "<name>: <labels>" -- the chart's title; the name alone when the path has no
 * labelled member. Give it the CLICKED PATH only: a labelled standing or page
 * filter is not what was clicked.
 */
export function drillTitle(def: DrillThroughDefinition, path: readonly DrillFilterSpec[]): string {
  const name = drillThroughDisplayName(def);
  const labels = drillMemberLabels(path);
  return labels ? `${name}: ${labels}` : name;
}

/** The first line of a compile error list, as a toast shows it. */
export function firstCompileErrorLine(errors: ReadonlyArray<{ message: string; location: { line: number } }>): string {
  const first = errors[0];
  return first ? `Line ${first.location.line}: ${first.message}` : "unknown error";
}

/** The sheet id of the ACTIVE sheet when it is temporary (a drill from a drill), else null. */
export function activeTemporarySheetId(result: SheetsResult): string | null {
  const active = result.sheets.find((s) => s.index === result.activeIndex);
  return active?.ephemeral === true && active.sheetId ? active.sheetId : null;
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : String(e);
}

// ============================================================================
// The run
// ============================================================================

function refuse(reason: string): DrillThroughOutcome {
  showToast(reason, { variant: "warning" });
  return { ok: false, reason };
}

function fail(reason: string): DrillThroughOutcome {
  showToast(reason, { variant: "error" });
  return { ok: false, reason };
}

/**
 * Tell what the drill could not carry, ONCE, after its sheet landed: the
 * source's notices as warnings (the severity a degraded pivot notice has),
 * the page's tuple notice as info.
 */
function tellNotCarried(sourceNotices: readonly string[], pageNotices: readonly string[]): void {
  for (const n of sourceNotices) showToast(n, { variant: "warning" });
  for (const n of pageNotices) showToast(n, { variant: "info" });
}

/**
 * Step 7: leave the temporary sheet `sheetId` before the next one is added.
 * Resolves to null when the run may go on, or to the outcome that stops it.
 * The sheets are read AGAIN first: the user may have kept the sheet (a
 * double-click on its tab) or left it (the strip discarded it) while the
 * drill was being checked.
 */
async function leaveTemporarySheet(sheetId: string): Promise<DrillThroughOutcome | null> {
  let now: SheetsResult;
  try {
    now = await getSheets();
  } catch (e) {
    return fail(`Could not leave the temporary sheet before drilling: ${errorText(e)}`);
  }
  const sheet = now.sheets.find((s) => s.sheetId === sheetId);
  // Gone (the strip discarded it when the user left it), or kept: nothing to leave.
  if (!sheet || sheet.ephemeral !== true) return null;

  let gone: unknown;
  let after: SheetsResult;
  try {
    gone = await CommandRegistry.execute(DISCARD_EPHEMERAL_COMMAND, { sheetId });
    after = await getSheets();
  } catch (e) {
    return fail(`Could not leave the temporary sheet before drilling: ${errorText(e)}`);
  }
  const reason = `The temporary sheet "${sheet.name}" was not discarded, so the drill-through did not run.`;
  if (gone !== true) {
    // The command told its own refusal (C7: one toast per refusal), or a
    // refused command said why (`@api/commandRefusals`): a second toast here
    // would say the same thing twice. The run stops before anything is added.
    console.warn(`[drillThrough] ${reason}`);
    return { ok: false, reason };
  }
  if (after.sheets.some((s) => s.sheetId === sheetId)) {
    // The command answered "gone" and the backend still lists the sheet:
    // nobody has told the user anything, so this stop is said here.
    return fail(reason);
  }
  return null;
}

/**
 * Run `def` from `source` for `datum`. Resolves to what happened; every
 * failure has already been shown as a toast when the promise resolves.
 */
export async function runDrillThrough(
  source: DrillSource,
  def: DrillThroughDefinition,
  datum: DrillDatum,
  io: DrillIo,
): Promise<DrillThroughOutcome> {
  const presentation = def.presentation;
  const connectionId = String(source.connectionId ?? "");
  if (presentation?.kind !== "table" && presentation?.kind !== "chart") {
    // A definition from a load that only WARNS on a schema violation can
    // carry a kind this version does not know: refused, never guessed at.
    const kind = String((presentation as { kind?: unknown } | undefined)?.kind);
    return fail(`The drill-through's presentation "${kind}" is not one this version can show.`);
  }

  // 0. The page id, before anything can shift an index.
  const pageSheetId = sheetIdAt(getReportPagesSnapshot(), source.sheetIndex);

  // 1. A drill from a drill? Recorded only: nothing is discarded yet.
  let temporaryId: string | null;
  try {
    temporaryId = activeTemporarySheetId(await getSheets());
  } catch (e) {
    return fail(`Could not read the workbook's sheets before drilling: ${errorText(e)}`);
  }

  // 2. The model.
  if (!connectionId || connectionId === "0") {
    return refuse("Open the model's connection first.");
  }
  let model: BiPivotModelInfo | null;
  try {
    model = await io.invoke<BiPivotModelInfo | null>("get_connection_bi_model", { connectionId });
  } catch (e) {
    return fail(`Could not read the model: ${errorText(e)}`);
  }
  if (!model) {
    return refuse("Open the model's connection first.");
  }

  // 3. The filters: the clicked path, the source's standing filters, the
  //    page's (when kept) -- resolved while the source page still exists.
  const path = datum.filters;
  const specs: DrillFilterSpec[] = [
    ...path,
    ...standingFiltersToSpecs(datum.standing ?? [], {
      presentation: presentation.kind,
      connectionId,
      published: getReportFilters(),
    }),
  ];
  const sourceNotices = [...(datum.notices ?? [])];
  let pageNotices: string[] = [];
  if (drillKeepsFilters(def) && pageSheetId) {
    const resolved = resolveFiltersFor(pageSheetId, { ref: { kind: source.kind, id: source.id }, canHighlight: false }, connectionId);
    specs.push(...pageFiltersToSpecs(resolved.filters, { presentation: presentation.kind }));
    pageNotices = pageFilterNotices(resolved);
  }

  // 4 + 5. Substitute, bake, compile.
  let baked: string;
  try {
    baked = bakeDrillFilters(substituteControlParams(def.dslText, getControlValue), specs);
  } catch (e) {
    if (e instanceof DrillBakeRefusal) return refuse(e.message);
    return fail(`Could not write the drill-through's filters: ${errorText(e)}`);
  }
  const compiled = compileDesignQuery(baked, connectionId, model);
  if (!compiled.request) {
    return fail(`The drill-through query has errors. ${firstCompileErrorLine(compiled.errors)}`);
  }
  const request = compiled.request;

  // 6. Every check that is left, before anything changes.
  let chart: { store: IChartStoreService; spec: Record<string, unknown> } | null = null;
  if (presentation.kind === "chart") {
    try {
      await io.invoke<unknown>("run_design_query", { request });
    } catch (e) {
      return fail(`The drill-through query failed: ${errorText(e)}`);
    }
    const store = getChartStoreService();
    if (!store) {
      return fail("Charts are unavailable (the Charts extension is not loaded), so a chart drill-through cannot be shown.");
    }
    let spec: Record<string, unknown>;
    let violations: string[];
    try {
      spec = store.buildDesignQueryChartSpec({
        dslText: baked,
        connectionId,
        mark: presentation.mark,
        ...(presentation.markOptions ? { markOptions: presentation.markOptions } : {}),
        title: drillTitle(def, path),
      });
      violations = store.validateChartSpec(spec);
    } catch (e) {
      return fail(`The drill-through's chart could not be prepared: ${errorText(e)}`);
    }
    if (violations.length > 0) {
      return fail(`The drill-through's chart settings are not valid: ${violations.slice(0, MAX_VIOLATIONS_TOLD).join("; ")}`);
    }
    chart = { store, spec };
  } else if (temporaryId) {
    // A table leaves a temporary sheet only once its query is known to run.
    try {
      await io.invoke<unknown>("run_design_query", { request });
    } catch (e) {
      return fail(`The drill-through query failed: ${errorText(e)}`);
    }
  }

  // 7. Only now: a drill from a drill leaves its temporary sheet.
  if (temporaryId) {
    const stopped = await leaveTemporarySheet(temporaryId);
    if (stopped) return stopped;
  }

  const name = drillThroughSheetName(def, source.name);
  const title = (def.name ?? "").trim();
  const caption = drillCaption(specs, [...sourceNotices, ...pageNotices], valueLessFilterFields(request));
  const refreshSheets = (): void =>
    emitAppEvent<MutationRefreshPayload>(AppEvents.MUTATION_REFRESH, { domains: ["sheets"], source: "commit" });

  // 8. The result sheet.
  if (!chart) {
    let landed: DrillThroughToSheetResponse;
    try {
      const req: DrillThroughToSheetRequest = {
        op: "toSheet",
        name,
        presentation: "table",
        query: request,
        caption,
        ...(title ? { title } : {}),
      };
      landed = await io.invoke<DrillThroughToSheetResponse>("drill_through", { request: req });
    } catch (e) {
      return fail(`The drill-through could not be run: ${errorText(e)}`);
    }
    try {
      await activateSheet(landed.sheetIndex, { record: false });
    } catch (e) {
      return fail(`The drill-through sheet "${landed.sheetName}" was added but could not be shown: ${errorText(e)}`);
    }
    refreshSheets();
    // 9. Told once, now that the sheet has landed.
    tellNotCarried(sourceNotices, pageNotices);
    return { ok: true, sheetIndex: landed.sheetIndex, sheetId: landed.sheetId, sheetName: landed.sheetName };
  }

  let landed: DrillThroughToSheetResponse;
  try {
    const req: DrillThroughToSheetRequest = {
      op: "toSheet",
      name,
      presentation: "chart",
      caption,
      ...(title ? { title } : {}),
    };
    landed = await io.invoke<DrillThroughToSheetResponse>("drill_through", { request: req });
  } catch (e) {
    return fail(`The drill-through could not be run: ${errorText(e)}`);
  }
  try {
    await activateSheet(landed.sheetIndex, { record: false });
  } catch (e) {
    return fail(`The drill-through page "${landed.sheetName}" was added but could not be shown: ${errorText(e)}`);
  }
  refreshSheets();
  let chartId: string;
  try {
    chartId = chart.store.createChart(chart.spec, { sheetIndex: landed.sheetIndex, ...DRILL_CHART_PLACEMENT, name });
  } catch (e) {
    // The spec was validated through the same seam in step 6, so this is an
    // unexpected failure. The empty page is left to the strip: it is active
    // and temporary, so leaving it discards it (the strip's snapshot may not
    // list it yet, so a discard by id from here would only be refused).
    return fail(`The drill-through page "${landed.sheetName}" was added but its chart could not be created: ${errorText(e)}`);
  }
  // 9. Told once, now that the chart has landed.
  tellNotCarried(sourceNotices, pageNotices);
  return { ok: true, sheetIndex: landed.sheetIndex, sheetId: landed.sheetId, sheetName: landed.sheetName, chartId };
}
