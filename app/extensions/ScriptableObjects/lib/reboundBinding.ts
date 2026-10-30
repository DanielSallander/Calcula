//! FILENAME: app/extensions/ScriptableObjects/lib/reboundBinding.ts
// PURPOSE: The Object Script Editor's re-read of a binding the BACKEND moved
//          (a named-range script following its name through a rename, its undo
//          or its redo -- the "rebound" change of workbook:object-scripts-changed).
// CONTEXT: The editor saved `{ ...activeScript, source }`, and `activeScript`
//          still carried the instance id it read when the window opened, so a
//          save after a rename wrote the OLD name back and orphaned the script
//          again (rev4B#2). The backend now keeps the stored binding on a save
//          (`save_object_script_core`); this keeps the editor's own copy -- what
//          its list shows, what a template stamps onto, what it hands the main
//          window to mount -- in line with it.
//
//          ONLY THE BINDING IS MERGED. The list is never replaced or shortened
//          here: the author's buffer and unsaved edits live beside it, and a
//          wholesale re-read that dropped or replaced an entry could lose them.

import type { ObjectScriptDefinition } from "@api/scriptableObjects";

/**
 * `scripts` with the script `id` re-bound to `instanceId`. The SAME array when
 * nothing changes (React bails out of the re-render), and every other entry
 * and every other field of the moved one exactly as it was.
 */
export function mergeReboundBinding(
  scripts: ObjectScriptDefinition[],
  id: string,
  instanceId: string | null,
): ObjectScriptDefinition[] {
  const at = scripts.findIndex((s) => s.id === id);
  if (at < 0 || (scripts[at].instanceId ?? null) === instanceId) return scripts;
  const next = scripts.slice();
  next[at] = { ...scripts[at], instanceId };
  return next;
}
