//! FILENAME: app/src/api/reportFilters/types.ts
// PURPOSE: The shapes of the report-filter seam (@api/reportFilters): what a
//          filtering family PUBLISHES (a model slicer, a ribbon filter), what a
//          visual SELECTS (a cross-filter selection), how a page says which
//          visual filters which (interactions), and what ONE target reads back
//          (`ResolvedFilters`).
// CONTEXT: P4 (canvas round 2). Replaces @api/pageFilters, whose filters were
//          keyed by sheet INDEX and reached every visual of a page alike. Here
//          every runtime key is a SHEET ID (an index shifts when a sheet moves),
//          and a filter reaches a TARGET: a page, a set of pages, every page, or
//          named visuals; a model slicer's filter and a visual's selection are
//          then put through the page's interactions for that target.
//
//          Everything carries member KEYS (P2 `MemberRef.key`): invariant
//          canonical text, "" for the blank member (ruling Q8). A label is never
//          matched on and never parsed into a key.
//
//          Seams point one way: nothing in this folder imports app/extensions.

/** A floating object on a canvas (the same shape as tauri-api `CanvasObjectRef`). */
export type VisualRef = { kind: "chart" | "pivot" | "slicer"; id: string };

/** How one visual's selection reaches another visual. */
export type InteractionMode = "filter" | "highlight" | "none";

/** One member of a model column, by its invariant KEY (P2 `MemberRef.key`). */
export interface MemberCoord {
  /** "Table.Column", the `biFieldKey` spelling every model consumer uses. */
  field: string;
  key: string;
}

/** A datum's identity: one coordinate per grouping field (rows then columns). */
export type MemberPath = readonly MemberCoord[];

/** Where a published filter applies. Pages are SHEET IDS, never indices. */
export type ReportFilterScope =
  | { kind: "page"; sheetId: string }
  | { kind: "pages"; sheetIds: readonly string[] }
  | { kind: "all" }
  | { kind: "visuals"; targets: readonly VisualRef[] };

/** What a publisher (model slicer, ribbon filter) hands in. Replaces PageFilterInput. */
export interface ReportFilterInput {
  /** The publishing object's id (slicer id / ribbon filter id): identity, ordering. */
  sourceId: string;
  /** The publishing object's name as the user sees it ("Slicer_Region"). */
  sourceName: string;
  /**
   * The canvas object behind it when it has one (a model slicer); null for a
   * ribbon filter. Only a filter with a sourceRef is subject to Edit
   * interactions: a ribbon filter is not on the page and has no pairs.
   */
  sourceRef: VisualRef | null;
  scope: ReportFilterScope;
  /** The model connection; only queries against THIS connection are filtered. */
  connectionId: string;
  /** "Table.Column". */
  field: string;
  /**
   * The member KEYS kept. The blank member is key "" (ruling Q8); "(blank)" in
   * any case is still read as the blank by the backend. [] keeps nothing --
   * "every item" is the ABSENCE of a filter, never a list of every item.
   */
  includedKeys: readonly string[];
  /** 1 ordinary (default), 2..9 pinned. */
  filterLevel?: number;
}

/** A filter as the seam holds it: the input plus who published it. */
export interface ReportFilter extends Readonly<ReportFilterInput> {
  readonly publisher: string;
  readonly filterLevel: number;
}

/** One visual's cross-filter selection (view state: no undo, no dirty, not saved). */
export interface CrossFilterSelection {
  source: VisualRef;
  sourceName: string;
  pageSheetId: string;
  connectionId: string;
  /** The grouping fields, in order; every tuple is aligned to them. */
  fields: readonly string[];
  /** Distinct tuples, each a list of member KEYS aligned to `fields`. */
  tuples: readonly (readonly string[])[];
}

/** A per-column IN filter as a consumer applies it. */
export interface ResolvedFieldFilter {
  field: string;
  includedKeys: readonly string[];
  level: number;
  /** The source's name, for badges and console notes. */
  from: string;
}

/** OR-of-AND over `fields` (a non-rectangular selection). Always level 1. */
export interface ResolvedTupleFilter {
  fields: readonly string[];
  tuples: readonly (readonly string[])[];
  from: string;
}

/** What one target reads: the filters it applies, and what it highlights. */
export interface ResolvedFilters {
  /** Page / ribbon filters plus filter-mode RECTANGULAR selections. */
  filters: ResolvedFieldFilter[];
  /** Filter-mode NON-rectangular selections. */
  tupleFilters: ResolvedTupleFilter[];
  /** The AND of every highlight-mode source; null when none highlights. */
  highlights: { filters: ResolvedFieldFilter[]; tupleFilters: ResolvedTupleFilter[] } | null;
  /** Every source that reached the target, once each (badges, tooltips). */
  sources: Array<{ name: string; ref: VisualRef | null; mode: "filter" | "highlight" }>;
}

/** The visual a resolution is for, and whether it can paint a highlight. */
export interface ResolveTarget {
  ref: VisualRef;
  canHighlight: boolean;
}

export interface ResolveOptions {
  /**
   * "visualSelectionsOnly": ONLY visual cross-filter selections (pivot boxes
   * and slicers take page/ribbon filters through their backend route).
   * Default "all".
   */
  include?: "all" | "visualSelectionsOnly";
}

/** What a change event carries. */
export interface ReportFiltersChange {
  /** Pages whose resolved filters may have moved, per connection. "*" = every page. */
  pages: Array<{ sheetId: string | "*"; connectionId: string }>;
  /** Visual-scoped changes name their targets (a "visuals" scope or an interaction pair). */
  targets: VisualRef[];
}

/** One page's interactions (mirrors `CanvasLayout.interactions`, Rust `CanvasInteractions`). */
export interface PageInteractions {
  /** The mode a VISUAL source gives a target with no explicit pair. Never "none". */
  defaultMode?: "filter" | "highlight";
  pairs: Array<{ source: VisualRef; target: VisualRef; mode: InteractionMode }>;
}
