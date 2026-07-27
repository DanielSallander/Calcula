//! FILENAME: app/extensions/Table/lib/tableEvents.ts
// PURPOSE: Event constants for the Table extension.
// CONTEXT: The two CROSS-EXTENSION events (created / definitions-updated) are
//          owned by @api — Pivot, Charts and AutoFilter all react to them, and
//          an extension must not depend on another extension's internals (nor
//          hardcode its event strings). They are re-exported here so Table's own
//          call sites stay short and there is exactly one source of truth.
//          TABLE_STATE / TABLE_REQUEST_STATE are Table-internal chatter between
//          its selection handler and its ribbon panel; those stay local.

import { AppEvents } from "@api";

export const TableEvents = {
  /** Emitted after a new table is created. Owned by @api (cross-extension). */
  TABLE_CREATED: AppEvents.TABLE_CREATED,
  /** Emitted when table definitions change (geometry, columns, options,
   *  delete). Owned by @api (cross-extension). */
  TABLE_DEFINITIONS_UPDATED: AppEvents.TABLE_DEFINITIONS_UPDATED,
  /** Table-internal: selection handler broadcasts current table state. */
  TABLE_STATE: "app:table-state",
  /** Table-internal: ribbon panel requests the current table state. */
  TABLE_REQUEST_STATE: "app:table-request-state",
} as const;

export type TableEventType = (typeof TableEvents)[keyof typeof TableEvents];
