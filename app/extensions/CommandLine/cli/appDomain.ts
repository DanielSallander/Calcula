// FILENAME: app/extensions/CommandLine/cli/appDomain.ts
// PURPOSE: The APP (grid/workbook) domain of the fused Calcula CLI — packages
//          this directory's readers/writers/help behind the shared kernel's
//          CliDomain contract (_shared/cli/registry.ts). Kinds: sheet, cell,
//          range, name, gridtable, pivot, macro, command ("table" belongs to
//          the MODEL domain — kinds are globally unique).
// CONTEXT: The batch strategy is the grid's honest one: a multi-write run is
//          wrapped in ONE undo transaction, and a mid-run error COMMITS the
//          partial as that one undo step. NEVER cancelUndoTransaction here —
//          it discards the undo record WITHOUT reverting the grid
//          (core/engine/src/undo.rs), which would strand the partial edits
//          as un-undoable.

import type { UndoResult } from "@api/lib";
import { readUndoBeginAnswer } from "@api/undoTicket";
import { CliError } from "../../_shared/cli/lex";
import type { GenericCommand } from "../../_shared/cli/parse";
import type { CliDomain, CliIo, CliNameSuggestion, WritePreview } from "../../_shared/cli/registry";
import type { AppCliSession } from "./appSession";
import { COMMAND_LINE_RUN_LABEL } from "./appSession";
import { runAppRead } from "./appReaders";
import {
  APP_CELL_OPTIONS,
  APP_NAME_OPTIONS,
  APP_RANGE_OPTIONS,
  APP_SHEET_OPTIONS,
  previewAppWrite,
  runAppWrite,
} from "./appWriters";
import { appHelpText } from "./appHelp";
import { macroSuggestionDetail } from "./macroProvenance";

/** The verbs the app domain answers as reads (everything else it owns
 *  routes to runWrite — including the navigation-style verbs, whose
 *  previewWrite is null so they never count as writes). */
const APP_READ_VERBS: ReadonlySet<string> = new Set(["ls", "show"]);

function suggestion(name: string, detail?: string): CliNameSuggestion {
  const needsQuotes = /\s/.test(name);
  return {
    label: name,
    insert: needsQuotes ? `"${name.replace(/"/g, '""')}"` : name,
    detail,
  };
}

/** Close the run's batch -- only when its begin OPENED the transaction, and
 *  only that transaction (its ticket). */
async function commitIfOpenedHere(s: AppCliSession): Promise<void> {
  const own = s.batch;
  s.batch = { opened: false, ticket: null };
  if (!own.opened) return;
  if (own.ticket === null) await s.gateway.commitUndoTransaction();
  else await s.gateway.commitUndoTransaction(own.ticket);
}

/**
 * An undo / redo that did not move the history. Two different situations: the
 * backend REFUSED (a gesture's step is still landing -- `refusal` says why,
 * the same sentence Core shows as a toast), which is a failure of this run;
 * or there is simply nothing there to move, which is an ordinary answer.
 */
function reportHistoryNotMoved(result: UndoResult, empty: string, io: CliIo): void {
  const refusal = typeof result.refusal === "string" ? result.refusal.trim() : "";
  if (refusal !== "") throw new CliError(refusal);
  io.print(empty, "info");
}

function commandSuggestions(s: AppCliSession): CliNameSuggestion[] {
  try {
    return s.gateway.listCommands().map((id) => suggestion(id));
  } catch {
    return [];
  }
}

export function createAppDomain(): CliDomain<AppCliSession> {
  return {
    id: "app",
    label: "spreadsheet",
    kinds: [
      {
        kind: "sheet",
        listable: true,
        options: APP_SHEET_OPTIONS,
        nameSuggestions: (s) => s.sheets.map((sh) => suggestion(sh.name, `sheet ${sh.index}`)),
      },
      { kind: "cell", options: APP_CELL_OPTIONS },
      { kind: "range", options: APP_RANGE_OPTIONS },
      {
        kind: "name",
        listable: true,
        options: APP_NAME_OPTIONS,
        nameSuggestions: (s) => s.names.map((n) => suggestion(n.name, n.refersTo)),
      },
      {
        kind: "gridtable",
        aliases: ["gtable"],
        listable: true,
        nameSuggestions: (s) => s.tables.map((t) => suggestion(t.name, `sheet ${t.sheetIndex}`)),
      },
      {
        kind: "pivot",
        listable: true,
        nameSuggestions: (s) => s.pivots.map((p) => suggestion(p.name, p.destination)),
      },
      {
        kind: "macro",
        listable: true,
        // The detail carries the origin whenever it is NOT the user's own code,
        // so completion — the surface that offers a macro name before the user
        // has typed `ls` — cannot present a publisher's module unmarked.
        nameSuggestions: (s) => s.macros.map((m) => suggestion(m.name, macroSuggestionDetail(m))),
      },
      {
        kind: "command",
        listable: true,
        nameSuggestions: (s) => commandSuggestions(s),
      },
    ],
    verbs: [
      { verb: "goto", kindless: true },
      { verb: "sort", kindless: true },
      { verb: "run", kindless: true },
      { verb: "command", kindless: true },
      { verb: "recalc", kindless: true },
    ],
    readVerbs: APP_READ_VERBS,
    strictOptions: true,

    async runRead(cmd: GenericCommand, s: AppCliSession, io: CliIo): Promise<void> {
      await runAppRead(cmd, s, io);
    },

    previewWrite(cmd: GenericCommand, s: AppCliSession): WritePreview | null {
      return previewAppWrite(cmd, s);
    },

    async runWrite(cmd: GenericCommand, s: AppCliSession, io: CliIo): Promise<void> {
      await runAppWrite(cmd, s, io);
    },

    isWritable(): boolean {
      return true;
    },

    // The begin answers whether it OPENED the backend's one transaction. A run
    // whose begin only JOINED one another caller holds open (a script's
    // batch, a gesture landing) leaves the commit to that caller: its edits
    // are part of that caller's step, and committing here would close the
    // other caller's step halfway.
    batch: {
      // Not a promise of a step of its OWN: the begin JOINS one a script's
      // batch or a gesture already holds open, and then the run is part of
      // that caller's step (it commits it, or drops its record).
      confirmNote:
        "one undo step, or part of the one a script or gesture already holds open; if a step fails, completed edits are kept",
      async begin(s: AppCliSession): Promise<void> {
        s.batch = readUndoBeginAnswer(await s.gateway.beginUndoTransaction(COMMAND_LINE_RUN_LABEL));
      },
      async end(s: AppCliSession): Promise<void> {
        await commitIfOpenedHere(s);
      },
      // A failed step COMMITS what completed as one undo step. Cancelling
      // would discard the undo record without reverting the cells (verified
      // in core/engine/src/undo.rs), stranding the changes un-undoable —
      // which is why cancelUndoTransaction is not even on the gateway.
      async onError(s: AppCliSession): Promise<"rolled-back" | "kept-partial" | "joined"> {
        // A run that JOINED committed nothing of its own: its edits went into
        // the other caller's step, and "run 'undo'" would take back an older,
        // unrelated one.
        const joined = !s.batch.opened;
        await commitIfOpenedHere(s);
        return joined ? "joined" : "kept-partial";
      },
    },

    // A REFUSAL IS NOT A SUCCESS. `undo`/`redo` are `-> UndoResult`, not
    // `-> Result`: an empty stack RETURNS `{ success: false }` rather than
    // rejecting, so awaiting the call and printing unconditionally told the
    // user "Undone." when nothing had been undone. The result is read here
    // because this is the only layer that knows how to say so.
    undoRedo: {
      async undo(s: AppCliSession, io: CliIo): Promise<void> {
        const result = await s.gateway.undo();
        if (result?.success === false) {
          reportHistoryNotMoved(result, "Nothing to undo.", io);
          return;
        }
        io.print("Undone.", "info");
      },
      async redo(s: AppCliSession, io: CliIo): Promise<void> {
        const result = await s.gateway.redo();
        if (result?.success === false) {
          reportHistoryNotMoved(result, "Nothing to redo.", io);
          return;
        }
        io.print("Redone.", "info");
      },
    },

    helpText(topic: string[]): string | null {
      return appHelpText(topic);
    },
  };
}
