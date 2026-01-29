//! FILENAME: app/src/api/commands.ts
// PURPOSE: Central registry of Command IDs.
// CONTEXT: Extensions use these IDs to link Menu Items to Actions.

// Standard Command IDs (The "Well-Known" commands)
export const CoreCommands = {
  // Clipboard
  CUT: 'core.clipboard.cut',
  COPY: 'core.clipboard.copy',
  PASTE: 'core.clipboard.paste',

  // Edit
  UNDO: 'core.edit.undo',
  REDO: 'core.edit.redo',
  FIND: 'core.edit.find',
  REPLACE: 'core.edit.replace',

  // Grid
  MERGE_CELLS: 'core.grid.merge',
  UNMERGE_CELLS: 'core.grid.unmerge',
  FREEZE_PANES: 'core.grid.freeze',
} as const;

// Interface for the Command Registry (Implementation will be in Core/Shell)
export interface ICommandRegistry {
  execute(commandId: string, args?: unknown): Promise<void>;
  register(commandId: string, handler: (args?: unknown) => void): void;
}