// FILENAME: app/extensions/CommandLine/cli/appSession.ts
// PURPOSE: The mutable state one app-CLI run (and the panel between runs)
//          threads through readers/writers: the gateway plus best-effort
//          caches of the listable object collections. Caches feed completion
//          (nameSuggestions) and `ls`; WRITERS RE-RESOLVE sheet names through
//          the gateway at execution time — a stale cache must never pick the
//          target of a destructive operation.

import type { NamedRange, SheetInfo } from "@api/lib";
import type { Table } from "@api/backend";
import type { PivotTableInfo } from "@api/pivotTypes";
import type { MacroEntry } from "./macroProvenance";
import type { AppCliGateway } from "./appGateway";

export interface AppCliSession {
  gateway: AppCliGateway;
  /** Cached sheet list (refreshed by refresh() and after sheet writes). */
  sheets: SheetInfo[];
  activeSheetIndex: number;
  names: NamedRange[];
  tables: Table[];
  pivots: PivotTableInfo[];
  /** Module scripts, each carrying the origin derived from its own record —
   *  the cache `ls macros` and completion render, so provenance is present in
   *  the CACHE and cannot be lost between the read and the display. */
  macros: MacroEntry[];
  /** Best-effort re-read of every cache; a failed read keeps the old value. */
  refresh(): Promise<void>;
}

export function createAppCliSession(gateway: AppCliGateway): AppCliSession {
  const session: AppCliSession = {
    gateway,
    sheets: [],
    activeSheetIndex: 0,
    names: [],
    tables: [],
    pivots: [],
    macros: [],
    async refresh(): Promise<void> {
      const [sheets, names, tables, pivots, macros] = await Promise.allSettled([
        gateway.getSheets(),
        gateway.getAllNamedRanges(),
        gateway.getAllTables(),
        gateway.getAllPivotTables(),
        gateway.listMacros(),
      ]);
      if (sheets.status === "fulfilled") {
        session.sheets = sheets.value.sheets;
        session.activeSheetIndex = sheets.value.activeIndex;
      }
      if (names.status === "fulfilled") session.names = names.value;
      if (tables.status === "fulfilled") session.tables = tables.value;
      if (pivots.status === "fulfilled") session.pivots = pivots.value;
      if (macros.status === "fulfilled") session.macros = macros.value;
    },
  };
  return session;
}

/** Cached display name for a sheet index ("#3" when unknown). */
export function sheetNameOf(session: AppCliSession, index: number): string {
  return session.sheets.find((sh) => sh.index === index)?.name ?? `#${index}`;
}
