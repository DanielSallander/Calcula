//! FILENAME: app/src/api/objectBindings/index.ts
// PURPOSE: The feature-neutral seam for OBJECT PROPERTY BINDINGS
//          (`@api/objectBindings`): a property of a chart, control, slicer,
//          timeline, pivot, floating range or canvas page whose value is a
//          formula -- grid cells, names, `[Measure]` refs of the page's model
//          under its slicers, literal CUBE functions.
// CONTEXT: D-BIND (docs/design/canvas-sheets.md §15). Rust owns the store
//          (`bindings.json`, .cala v10), the bindable-path catalog, evaluation
//          and every gate (`app/src-tauri/src/object_bindings/`). This seam:
//            * caches the bindings and their resolved values so a family reads
//              them SYNCHRONOUSLY at paint time (`getResolved`,
//              `overlayResolved`) and repaints on `onBindingsChanged`;
//            * is the trigger that tells Rust to re-evaluate (bridge.ts);
//            * mirrors @api/pageFilters to Rust (the page's slicers filter
//              `[Measure]` refs);
//            * holds the catalog mirror (catalog.ts) and the per-kind registry
//              of what the UI offers to bind (registry.ts).
//
//          Families must not emit GRID_REFRESH from `onBindingsChanged`: they
//          invalidate their own caches and call `requestOverlayRedraw()` (the
//          feedback-loop rule, bridge.ts header).
//
//          Imported as `@api/objectBindings` (a subpath, the @api/pageFilters
//          precedent); not part of the `@api` barrel. Imports nothing from
//          app/extensions.

export type { ObjectBindingsChange } from "./types";
export type {
  ObjectBindingKind,
  ObjectBindingRef,
  ResolvedBinding,
  ObjectBindingInfo,
  BindingEditSource,
  ChangedCellRef,
  PageFilterWire,
  PageFilterPageWire,
  BindingFormulaAnalysis,
  BindingModelMeasures,
  ObjectBindingsRequest,
  ObjectBindingsResponse,
  ObjectBindingsChangedPayload,
  TraceBoundObject,
  ObjectBindingPlace,
} from "./types";

export {
  OBJECT_BINDING_KINDS,
  OBJECT_BINDING_KIND_LABELS,
  BINDABLE_PATHS,
  CONTAINER_ROOT_POINTER,
  MAX_BINDING_PATH_CHARS,
  MAX_BINDING_PATH_SEGMENTS,
  MAX_BINDING_PATH_SEGMENT_CHARS,
  isObjectBindingKind,
  isBindablePath,
  matchBindablePath,
  isNeverBindableControlKey,
  neverBindableControlReason,
  pointerSegments,
  parsePointer,
  escapePointerSegment,
  unescapePointerSegment,
  rowsOf,
  isTextValueType,
  pageButtonPointer,
  pageOverridesRefusal,
  PAGE_OVERRIDE_IDENTITY_FIELDS,
} from "./catalog";
export type { BindableValueType, BindablePathSpec } from "./catalog";

export {
  listBindings,
  getBinding,
  getResolved,
  getResolvedForObject,
  setBinding,
  clearBinding,
  setLiteral,
  analyzeBindingFormula,
  getObjectJson,
  listBindingMeasures,
  locateBoundObjects,
} from "./ops";

export { onBindingsChanged } from "./cache";
export { overlayResolved } from "./overlay";
export { BindingRefusal } from "./transport";

export {
  registerBindableProperties,
  getBindableProperties,
  getBindablePropertiesRegistration,
  bindingRefForRegion,
  bindingRefForInstance,
} from "./registry";
export type { BindablePropertyDescriptor, BindablePropertiesRegistration } from "./registry";

export {
  BACKEND_OBJECT_BINDINGS_EVENT,
  installObjectBindingsBridge,
  reevaluateAfterNameChange,
} from "./bridge";
