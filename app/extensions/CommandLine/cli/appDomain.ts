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

import type { GenericCommand } from "../../_shared/cli/parse";
import type { CliDomain, CliIo, CliNameSuggestion, WritePreview } from "../../_shared/cli/registry";
import type { AppCliSession } from "./appSession";
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
        nameSuggestions: (s) => s.macros.map((m) => suggestion(m.name, m.id)),
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

    batch: {
      confirmNote: "one undo step; if a step fails, completed edits are kept and undoable",
      async begin(s: AppCliSession): Promise<void> {
        await s.gateway.beginUndoTransaction("Command line run");
      },
      async end(s: AppCliSession): Promise<void> {
        await s.gateway.commitUndoTransaction();
      },
      // A failed step COMMITS what completed as one undo step. Cancelling
      // would discard the undo record without reverting the cells (verified
      // in core/engine/src/undo.rs), stranding the changes un-undoable —
      // which is why cancelUndoTransaction is not even on the gateway.
      async onError(s: AppCliSession): Promise<"rolled-back" | "kept-partial"> {
        await s.gateway.commitUndoTransaction();
        return "kept-partial";
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
          io.print("Nothing to undo.", "info");
          return;
        }
        io.print("Undone.", "info");
      },
      async redo(s: AppCliSession, io: CliIo): Promise<void> {
        const result = await s.gateway.redo();
        if (result?.success === false) {
          io.print("Nothing to redo.", "info");
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
