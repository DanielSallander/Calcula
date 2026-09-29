//! FILENAME: app/src/api/commandRefusals.ts
// PURPOSE: The command-refusal registry ("not this command, right now") -- in a
//          module of its own so BOTH doors that run a command can ask it: the
//          keyboard dispatcher (`@api/keybindings`) and `CommandRegistry.execute`
//          (the ribbon, the menus, the Quick Access Toolbar, the command line,
//          scripts' executeCommand).
// CONTEXT: The registry lived in keybindings.ts and only the KEYBOARD asked it,
//          so Undo pressed on the ribbon or the Edit menu while a slicer click
//          was still landing reached the backend -- whose own refusal it could
//          overtake: the undo IPC arrived before the gesture's start, and the
//          step before the click came off (found live 2026-09-29, e2e
//          fixall-edit W15). keybindings.ts imports commands.ts, so commands.ts
//          could not import the registry from there without a cycle.

/** A refusal of one or more commands, asked when one of them is about to run. */
export interface CommandRefusal {
  /** The command ids it may refuse (exact). */
  commandIds: readonly string[];
  /**
   * A sentence refuses the command (the user is shown it, once); null lets it
   * run. Asked every time, never cached. A throw counts as null: a broken
   * extension must not be able to take a command away from the app by failing.
   */
  refuse: (commandId: string) => string | null;
}

const commandRefusals = new Set<CommandRefusal>();

/** Add a refusal; returns the cleanup. (`@api/keybindings` wraps this to also
 *  install its key listener.) */
export function addCommandRefusal(refusal: CommandRefusal): () => void {
  commandRefusals.add(refusal);
  return () => {
    commandRefusals.delete(refusal);
  };
}

/** The sentence refusing this command right now, or null. */
export function commandRefusalFor(commandId: string): string | null {
  for (const refusal of commandRefusals) {
    if (!refusal.commandIds.includes(commandId)) continue;
    let sentence: string | null = null;
    try {
      sentence = refusal.refuse(commandId);
    } catch (err) {
      console.error(`[CommandRefusals] a refusal of '${commandId}' threw; treating it as no refusal:`, err);
      sentence = null;
    }
    if (typeof sentence === "string" && sentence.trim() !== "") return sentence;
  }
  return null;
}
