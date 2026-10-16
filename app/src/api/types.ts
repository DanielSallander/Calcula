//! FILENAME: app/src/api/types.ts
// PURPOSE: Public type exports for extensions.
// CONTEXT: Extensions should import types from here instead of core internals.

// Re-export types that extensions are allowed to use
export type {
  // Selection and viewport
  Selection,
  SelectionType,
  Viewport,
  ClipboardMode,

  // Grid configuration
  GridConfig,
  FreezeConfig,
  DimensionOverrides,

  // Editing state
  EditingCell,

  // Cell data
  CellData,
  RichTextRun,
  StyleData,
  StyleDataMap,
  DimensionData,
  DefaultDimensions,

  // Formatting
  FormattingOptions,
  FormattingResult,
  TextRotation,
  AccountingLayout,

  // Functions
  FunctionInfo,

  // Formula references
  FormulaReference,

  // Merged cells
  MergedRegion,

  // Fill / Pattern
  FillData,
  FillParam,
  PatternType,
  GradientDirection,

  // Underline
  UnderlineStyle,

  // View mode
  ViewMode,
  SheetSurface,

  // Sorting
  SortRangeResult,

  // Used range (bounding box of stored cells)
  UsedRangeResult,

  // Computed Properties
  ComputedPropertyTargetType,
  ComputedPropertyData,
  ComputedPropertyResult,
} from "../core/types";

// Re-export default config and utility functions
export {
  DEFAULT_FREEZE_CONFIG,
  DEFAULT_GRID_CONFIG,
  columnToLetter,
  letterToColumn,
  isFormulaExpectingReference,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_DEFAULT,
  ZOOM_STEP,
  ZOOM_PRESETS,
} from "../core/types";

export type {
  IStyleOverride,
  CellCoords,
  BaseStyleInfo,
  StyleInterceptorFn,
} from "./styleInterceptors";

// ============================================================================
// Object property bindings (object_bindings command)
// ============================================================================
//
// The TS mirror of the wire types in app/src-tauri/src/api_types.rs (section
// "Object property bindings"). Rust is the authority; these interfaces mirror
// its structs field for field (serde camelCase). `@api/objectBindings`
// re-exports them, so its consumers import one place while the wire mirror
// stays where the CLAUDE.md naming rule puts it.
//
// A BINDING is an overlay row in ONE workbook store (`bindings.json`, .cala
// v10): a property of an object, addressed by a JSON Pointer into the object's
// AI-visible JSON, whose value is a formula. The literal stays in the object's
// own record.

/** The kinds of object a property binding can belong to (Rust `ObjectBindingKind`). */
export type ObjectBindingKind =
  | "chart"
  | "control"
  | "slicer"
  | "timelineSlicer"
  | "pivot"
  | "floatingRange"
  | "canvasPage";

/**
 * The object a binding belongs to: its kind and its STABLE id (chart / slicer /
 * timeline / pivot / floating-range EntityId, control `uid`, canvas page
 * SheetId) -- never an index, a name or an anchor cell.
 */
export interface ObjectBindingRef {
  kind: ObjectBindingKind;
  id: string;
}

/** The current value of one binding. TRANSIENT: never saved, never undone. */
export interface ResolvedBinding {
  object: ObjectBindingRef;
  path: string;
  /** Typed per the catalog row (number, string, boolean); null on error/pending. */
  value: unknown;
  /** What a text slot shows ("#REF!", "(Refused)", "(model not connected)" on error). */
  display: string;
  /** A full sentence when the binding cannot produce a value of its type. */
  error: string | null;
  /** True while a measure this binding reads has not been fetched yet. */
  pending: boolean;
}

/** One binding as the frontend, scripts and AI see it. */
export interface ObjectBindingInfo {
  object: ObjectBindingRef;
  path: string;
  /** As stored: INVARIANT (en-US `,` separators, `.` decimals). */
  formula: string;
  /** `formula` localised with the workbook locale: what user-facing editors show. */
  displayFormula: string;
  model: string | null;
  resolved: ResolvedBinding | null;
}

/** Who asked for a binding edit (renderer-supplied: a label, never a boundary). */
export type BindingEditSource =
  | { kind: "user" }
  | { kind: "script"; scriptId: string; unlocked: boolean }
  | { kind: "ai"; tool: string };

/** A cell the frontend saw change (the `CellsChanged` trigger). */
export interface ChangedCellRef {
  sheetIndex: number;
  row: number;
  col: number;
}

/** One page filter mirrored from `@api/pageFilters` to Rust. */
export interface PageFilterWire {
  field: string;
  includedItems: string[];
  filterLevel: number;
}

/** Every page filter of one (page, connection), mirrored to Rust. */
export interface PageFilterPageWire {
  sheetIndex: number;
  connectionId: string;
  filters: PageFilterWire[];
}

/** What a binding formula reads and how it would be stored. */
export interface BindingFormulaAnalysis {
  /** The formula as it would be stored (invariant, sheet-qualified, canonical sheet case). */
  normalized: string;
  /** `normalized` localised for display. */
  displayNormalized: string;
  /** Sheet INDICES the formula reads cells on (after normalisation). */
  sheets: number[];
  usesNames: boolean;
  /** `Table[Col]` (a table name present). */
  usesTableRefs: boolean;
  /** INDIRECT / OFFSET-with-text / GET.CONTROLVALUE / GETPIVOTDATA. */
  usesIndirect: boolean;
  usesCube: boolean;
  /** Table-less `[Name]` refs: measures of the binding's model. */
  measureRefs: string[];
  /** The model key it would bind to. */
  model: string | null;
  /** Refusal sentence (parse, ambiguity, unknown measure...). */
  error: string | null;
  /** A sentence shown beside an ACCEPTED formula whose unqualified reference
   *  was pointed at a fallback sheet (an object on a canvas page). */
  warning: string | null;
}

/** The measures of one model a binding on a page could read. */
export interface BindingModelMeasures {
  modelKey: string;
  connectionId: string;
  name: string;
  measures: string[];
  isDefault: boolean;
}

/** The ONE `object_bindings` command's request (Rust `ObjectBindingsRequest`, tagged by `op`). */
export type ObjectBindingsRequest =
  | { op: "list"; object: ObjectBindingRef | null }
  | {
      op: "set";
      object: ObjectBindingRef;
      path: string;
      formula: string;
      model: string | null;
      /** false/absent = `formula` is in the user's locale; true = already invariant. */
      invariant: boolean | null;
      source: BindingEditSource | null;
    }
  | { op: "clear"; object: ObjectBindingRef; path: string; source: BindingEditSource | null }
  | { op: "setLiteral"; object: ObjectBindingRef; path: string; value: unknown; source: BindingEditSource | null }
  | { op: "resolveAll" }
  | { op: "cellsChanged"; cells: ChangedCellRef[] | null }
  | { op: "setPageFilters"; pages: PageFilterPageWire[] }
  | { op: "refreshMeasures"; sheetIndex: number | null }
  | { op: "analyze"; object: ObjectBindingRef; formula: string; invariant: boolean | null; model?: string | null }
  | { op: "objectJson"; object: ObjectBindingRef }
  | { op: "measures"; object: ObjectBindingRef }
  /** Where each object is and what a person calls it; a missing object is left out. */
  | { op: "locate"; objects: ObjectBindingRef[] };

/** The `object_bindings` command's answer (Rust `ObjectBindingsResponse`, tagged by `kind`). */
export type ObjectBindingsResponse =
  | { kind: "bindings"; bindings: ObjectBindingInfo[] }
  | { kind: "binding"; binding: ObjectBindingInfo }
  | { kind: "cleared"; removed: boolean }
  /** MutationDomain wire names the frontend must refresh. */
  | { kind: "literalSet"; domains: string[] }
  | { kind: "resolved"; values: ResolvedBinding[] }
  | { kind: "ack" }
  | { kind: "analysis"; analysis: BindingFormulaAnalysis }
  | { kind: "objectJson"; json: unknown }
  | { kind: "measures"; models: BindingModelMeasures[] }
  | { kind: "located"; places: ObjectBindingPlace[] };

/** Where a bound object is (Rust `ObjectBindingPlace`): its sheet and the name a person recognises it by. */
export interface ObjectBindingPlace {
  object: ObjectBindingRef;
  name: string;
  sheetIndex: number;
  sheetName: string;
}

/** Payload of the ONE Tauri event `object-bindings:changed`. */
export interface ObjectBindingsChangedPayload {
  /** Resolved values that CHANGED (diffed against the runtime cache). */
  values: ResolvedBinding[];
  /** True when the binding SET changed: the seam re-lists. */
  reload: boolean;
}

/** A bound object whose binding reads a traced cell (`TraceResult.boundObjects`). */
export interface TraceBoundObject {
  object: ObjectBindingRef;
  path: string;
  formula: string;
}
