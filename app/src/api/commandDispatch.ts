//! FILENAME: app/src/api/commandDispatch.ts
// PURPOSE: ONE door that runs a command by id from WHICHEVER registry holds it.
// CONTEXT: Calcula has two command registries, and a caller that knew only one
//          of them silently did nothing for a command that lives in the other:
//            - CommandRegistry (@api/commands): handlers registered with
//              `context.commands.register` / `CommandRegistry.register`, plus
//              the grid-command bridge behind the CoreCommands ids;
//            - the EXTENSION registry's commands (@api/extensions):
//              CommandDefinition objects registered with
//              `ExtensionRegistry.registerCommand` or an add-in manifest, run
//              with a CommandContext.
//          Space on a legacy style-flag checkbox reached Core's keyboard
//          handler as "checkbox.toggle", which Core does not handle and the
//          Checkbox extension registers with the EXTENSION registry: Core
//          logged "Unknown command" and nothing toggled. The TestRunner's
//          `ctx.executeCommand` went to CommandRegistry only, so its checkbox
//          suite never toggled anything either (wave E, Y9).
//
//          NOT a door for scripts or sandboxed extensions: `api.executeCommand`
//          and `ext.executeCommand` stay on `CommandRegistry.execute` behind
//          `CommandRegistry.isScriptSafe` -- an extension-registry command has
//          never been audited for script use, and this door would hand every
//          one of them to any script.

import { CommandRegistry } from "./commands";
import { ExtensionRegistry, type CommandContext } from "./extensions";
import { getGridStateSnapshot } from "../core/state/GridContext";
import { getCell, updateCell } from "../core/lib/tauri-api";

/** What `executeCommandAnywhere` did. */
export type CommandRunOutcome =
  /** A handler ran (or CommandRegistry's grid bridge answered for the id). */
  | "ran"
  /** The extension registry holds the command, and its `isEnabled` said no. */
  | "disabled"
  /** Neither registry holds the id: nothing ran. */
  | "unregistered";

/**
 * The CommandContext an extension-registry command runs with: the grid's
 * selection NOW, cell read / write through the backend, and a grid refresh.
 */
export function buildCommandContext(): CommandContext {
  return {
    selection: getGridStateSnapshot()?.selection ?? null,
    getCellValue: async (row, col) => (await getCell(row, col))?.display ?? null,
    setCellValue: async (row, col, value) => {
      await updateCell(row, col, value);
    },
    refreshGrid: () => window.dispatchEvent(new CustomEvent("grid:refresh")),
  };
}

/**
 * Run `commandId` from whichever registry holds it: CommandRegistry first (its
 * own handlers, then the grid bridge -- the precedence `CommandRegistry.execute`
 * already has), else the extension registry's command, run with a
 * CommandContext (`buildCommandContext`) -- unless its `isEnabled` refuses.
 *
 * `args` reach a CommandRegistry handler unchanged. An extension-registry
 * command takes a CommandContext, not args; a plain-object `args` is spread
 * onto its context (the context's own members win), so a command that reads
 * named parameters off its context still receives them.
 */
export async function executeCommandAnywhere(commandId: string, args?: unknown): Promise<CommandRunOutcome> {
  if (CommandRegistry.has(commandId)) {
    await CommandRegistry.execute(commandId, args);
    return "ran";
  }
  const command = ExtensionRegistry.getCommand(commandId);
  if (!command) return "unregistered";
  const base = buildCommandContext();
  const context: CommandContext =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? ({ ...(args as Record<string, unknown>), ...base } as CommandContext)
      : base;
  if (command.isEnabled && !command.isEnabled(context)) return "disabled";
  await command.execute(context);
  return "ran";
}
