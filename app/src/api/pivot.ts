//! FILENAME: app/src/api/pivot.ts
// PURPOSE: Pivot Table API Facade for extensions.
// CONTEXT: The cross-extension entry point for pivot operations. The contract
//   types live in ./pivotTypes; the implementation is provided by the Pivot
//   extension via registerPivotApi (IoC). This facade imports NO extension —
//   it is a feature-agnostic contract (No First-Class Citizens).

import {
  savePivotLayout as backendSavePivotLayout,
  getPivotLayouts as backendGetPivotLayouts,
  deletePivotLayout as backendDeletePivotLayout,
} from './backend';
import type { PivotApi } from './pivotTypes';

// Re-export the full pivot contract (all types + the PivotApi shape) so
// extensions can import them from @api/pivot.
export type * from './pivotTypes';

// Layout persistence is backend-backed (not extension-backed) — kept here.
export type {
  SavePivotLayoutRequest,
  PivotLayoutResponse,
} from './backend';
export const savePivotLayout = backendSavePivotLayout;
export const getPivotLayouts = backendGetPivotLayouts;
export const deletePivotLayout = backendDeletePivotLayout;

// ---------------------------------------------------------------------------
// Inversion of Control: the Pivot extension registers its implementation at
// load; consumers (including the Pivot UI) use the `pivot` proxy below.
// ---------------------------------------------------------------------------

let registered: PivotApi | null = null;

/**
 * Provide the Pivot implementation. Called once by the Pivot extension when it
 * loads (before any runtime pivot.* call). Inverts the dependency so the API
 * facade never imports the Pivot extension.
 */
export function registerPivotApi(impl: PivotApi): void {
  registered = impl;
}

/**
 * Pivot Table API Facade. Delegates to the implementation the Pivot extension
 * registered. Throws a clear error if accessed before the Pivot extension has
 * loaded (which should not happen in normal startup ordering).
 */
export const pivot: PivotApi = new Proxy({} as PivotApi, {
  get(_target, prop) {
    if (!registered) {
      throw new Error(
        `@api/pivot: the Pivot extension is not loaded (accessed "${String(prop)}").`,
      );
    }
    const value = registered[prop as keyof PivotApi];
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(registered)
      : value;
  },
});
