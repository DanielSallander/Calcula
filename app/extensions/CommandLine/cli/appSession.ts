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
import type { UndoBeginAnswer } from "@api/undoTicket";
import { readUndoBeginAnswer } from "@api/undoTicket";

/** The undo label a multi-write run's batch opens under. */
export const COMMAND_LINE_RUN_LABEL = "Command line run";

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
  /**
   * What the current multi-write run's begin answered. `opened` false when it
   * JOINED a transaction another caller holds open (a script's batch, a
   * gesture landing): that caller commits it, so this run must not --
   * committing would close the other caller's step halfway. When it opened,
   * the commit presents `ticket`, so it closes only that transaction.
   */
  batch: UndoBeginAnswer;
  /** Best-effort re-read of every cache; a failed read keeps the old value. */
  refresh(): Promise<void>;
}

/**
 * The run's own sheet add / rename / delete just ENDED the undo history (Excel
 * parity: a sheet structure change is not undoable), and the run's batch
 * transaction with it. The run is not over: its writes from here on are still
 * ONE step. So a batch this run OPENED begins again under the same label; a
 * begin that opens replaces the spent ticket. One that JOINS -- the operation
 * changed nothing and the run's own transaction is still open, or somebody
 * opened the slot in between -- keeps the record: a ticket the history kept is
 * still good, and a spent one closes nothing. A run that only JOINED another
 * caller's step leaves it to that caller. The twin of the script host's
 * `resumeScriptBatchAfterHistoryEnded`.
 *
 * Found live 2026-09-29 (e2e fixall-calp X6 check 11): `add sheet Y` then two
 * `set cell` lines left two undo steps, and one Ctrl+Z took back only A2.
 * Call only after the sheet operation SUCCEEDED (a refused one ends nothing).
 */
export async function resumeRunBatchAfterHistoryEnded(s: AppCliSession): Promise<void> {
  if (!s.batch.opened) return;
  let answer: UndoBeginAnswer;
  try {
    answer = readUndoBeginAnswer(await s.gateway.beginUndoTransaction(COMMAND_LINE_RUN_LABEL));
  } catch {
    // Best effort: the sheet change itself SUCCEEDED. Unresumed, the run's
    // later writes are steps of their own.
    return;
  }
  if (answer.opened) s.batch = answer;
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
    batch: { opened: false, ticket: null },
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
