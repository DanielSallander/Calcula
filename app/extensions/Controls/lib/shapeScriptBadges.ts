//! FILENAME: app/extensions/Controls/lib/shapeScriptBadges.ts
// PURPOSE: Re-read which on-grid shapes carry an object script, from the
//          backend, after an undo or redo of a structural edit -- the backend
//          moved them back, and it holds the list.
// CONTEXT: The script badge (`shapesWithScripts`, Shape/shapeRenderer.ts) is
//          id-keyed side state, and a shape's id IS its anchor cell. A row
//          insert or delete re-keys it here (`migrateShapeInstanceId`) or
//          releases it (`onRemove`) in step with the backend, which moves the
//          script's binding with the control (structure.rs `shift_controls`).
//          The UNDO of that edit moves the control and its script binding back
//          in the backend (the `obj_object_scripts*` restores) and announces
//          STRUCTURAL_UNDO (whose `deltas` say what moved, but not which
//          shapes carry scripts): the store reloaded its controls and the badge
//          set was left as the edit had made it -- the
//          restored shape came back without its badge (BUG-0615#5), and a
//          moved shape's badge stayed on the cell it had vacated. The
//          backend's list of object scripts is the authority; read it.

import { listObjectScripts } from "@api";
import { parseFloatingControlId } from "./floatingStore";
import { replaceShapeScriptMarks } from "../Shape/shapeRenderer";

/** What this module reads of an object script summary (`listObjectScripts`). */
export interface ScriptTarget {
  objectType: string;
  instanceId?: string | null;
}

/**
 * The on-grid shape ids `scripts` attach to. Pane-hosted custom controls are
 * also objectType "shape" but use "pane-<uuid>" ids -- never badged here.
 */
export function scriptedShapeIds(scripts: readonly ScriptTarget[]): string[] {
  const ids: string[] = [];
  for (const script of scripts) {
    if (script.objectType !== "shape" || !script.instanceId) continue;
    if (parseFloatingControlId(script.instanceId) === null) continue;
    ids.push(script.instanceId);
  }
  return ids;
}

/**
 * Make the badge set exactly the backend's scripted shapes. Returns whether it
 * changed (the caller repaints). A failed read leaves the set as it was.
 */
export async function resyncShapeScriptBadges(
  list: () => Promise<ScriptTarget[]> = listObjectScripts,
): Promise<boolean> {
  let scripts: ScriptTarget[];
  try {
    scripts = await list();
  } catch {
    return false;
  }
  return replaceShapeScriptMarks(scriptedShapeIds(scripts));
}
