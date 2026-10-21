//! FILENAME: app/src/api/objectBindings/types.ts
// PURPOSE: The types of the @api/objectBindings seam.
// CONTEXT: The WIRE types live in app/src/api/types.ts (the CLAUDE.md naming
//          rule: TS wire interfaces mirror api_types.rs from types.ts) and are
//          only RE-EXPORTED here, so a consumer of @api/objectBindings imports
//          one place. `ObjectBindingsChange` is the seam's own (not on the wire).

export type {
  ObjectBindingKind,
  ObjectBindingRef,
  ResolvedBinding,
  ObjectBindingInfo,
  BindingEditSource,
  ChangedCellRef,
  PageFilterWire,
  TupleFilterWire,
  ObjectFilterOverrideWire,
  PageFilterPageWire,
  BindingFormulaAnalysis,
  BindingModelMeasures,
  ObjectBindingsRequest,
  ObjectBindingsResponse,
  ObjectBindingsChangedPayload,
  TraceBoundObject,
  ObjectBindingPlace,
} from "../types";

import type { ObjectBindingRef } from "../types";

/**
 * What `onBindingsChanged` listeners receive.
 *
 * `objects` names every object whose bindings or resolved values changed.
 * `reload` is true when the binding SET was re-read from the backend (a
 * create, clear, undo, cascade, load or rename somewhere): a listener that
 * caches per object should then treat every object it holds as changed.
 */
export interface ObjectBindingsChange {
  objects: ObjectBindingRef[];
  reload: boolean;
}
