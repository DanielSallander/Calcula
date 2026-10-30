//! FILENAME: app/extensions/ScriptableObjects/lib/followReboundScripts.ts
// PURPOSE: The MAIN window's half of a script re-bind the backend made: when
//          the backend announces that it moved a script to another object
//          instance ("rebound" on workbook:object-scripts-changed), update this
//          window's script registry and re-key the script's live mount to the
//          binding the announcement names.
// CONTEXT: A script is bound by its object's instance id, and the backend
//          moves that binding on several routes (scripting/script_rebind.rs):
//          a named range's rename, a control moving with its cells, to another
//          cell or with its sheet, and the undo / redo of each. Only the script
//          host's own rename route used to re-key a live mount, and only
//          partly; after any other route this window kept the old binding --
//          Edit Script on the renamed name scaffolded a second, empty script
//          (the registry looks scripts up by binding), the mount kept answering
//          under the old address (so a scheduled job that had followed the
//          rename found nothing), and the registry pushed the old binding to
//          the open editor window, whose next save wrote it back (rev4B#2). The
//          registry change reaches the editor through the existing
//          SCRIPTS_CHANGED bridge; the editor also re-reads on the announcement
//          itself.
//
//          SYNCHRONOUSLY, FROM THE PAYLOAD (rev6B#6). The backend moves a
//          script's scheduled jobs in the same step as its binding, so between
//          that step and this window's re-key a due job is called at an address
//          the mount does not answer yet: the run fails, and a one-shot job is
//          removed whatever the outcome. The follower used to read the stored
//          binding back first (`getObjectScript`), which held that window open
//          for a round trip; the announcement now carries the binding
//          (`ObjectScriptsChangedDetail.instanceId`) and the re-key happens in
//          the event handler itself. An announcement without it (an older
//          emitter) still falls back to the read.

import {
  getObjectScript,
  ObjectScriptManager,
  onObjectScriptsChanged,
  type ObjectScriptsChangedDetail,
} from "@api";
import { hostRebindMountedScript } from "@api/scriptHost/host";

/**
 * Bring this window in line with `instanceId`, the binding the backend now
 * stores for `scriptId`: the registry entry and the live mount. Returns true
 * when anything moved. Synchronous: nothing is awaited between the
 * announcement and the re-key.
 */
export function applyReboundBinding(scriptId: string, instanceId: string | null): boolean {
  let moved = false;
  const registered = ObjectScriptManager.getAllScripts().find((s) => s.id === scriptId);
  if (registered && (registered.instanceId ?? null) !== instanceId) {
    ObjectScriptManager.registerScript({ ...registered, instanceId });
    moved = true;
  }
  if (hostRebindMountedScript(scriptId, instanceId)) moved = true;
  return moved;
}

/**
 * Bring this window in line with the binding the backend now stores for
 * `scriptId`, read back first -- for an announcement that does not carry it.
 * Returns true when anything moved. A script the backend no longer has (or
 * that cannot be read) is left alone: this follows a MOVE, and a removal is
 * not one.
 */
export async function followReboundScript(scriptId: string): Promise<boolean> {
  let instanceId: string | null;
  try {
    instanceId = (await getObjectScript(scriptId)).instanceId ?? null;
  } catch {
    return false;
  }
  return applyReboundBinding(scriptId, instanceId);
}

/**
 * Follow ONE announcement: a "rebound" that names its binding is applied at
 * once; one that does not is read back first. Anything else is someone
 * else's (a save, a delete).
 */
export function followReboundAnnouncement(detail: ObjectScriptsChangedDetail): void {
  if (detail.change !== "rebound") return;
  if (detail.instanceId !== undefined) {
    applyReboundBinding(detail.id, detail.instanceId);
    return;
  }
  void followReboundScript(detail.id);
}

/**
 * `script` with the binding the backend STORES for it. `save_object_script`
 * keeps an existing script's stored binding whatever a save sends, so an
 * editor copy read before a rename still carries the old instance id; what
 * this window registers and MOUNTS after a save must be what was stored, or
 * the mount answers under a name the store no longer has. Falls back to
 * `script` as sent when there is no stored record to read.
 */
export async function withStoredBinding<T extends { id: string; instanceId: string | null }>(
  script: T,
): Promise<T> {
  try {
    const stored = await getObjectScript(script.id);
    const instanceId = stored.instanceId ?? null;
    return (script.instanceId ?? null) === instanceId ? script : { ...script, instanceId };
  } catch {
    return script;
  }
}

/** Follow every "rebound" announcement for as long as the returned disposer is not called. */
export function installReboundScriptFollower(): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  try {
    void onObjectScriptsChanged(followReboundAnnouncement)
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {
        /* no event bus (tests, the browser smoke harness): nothing to follow */
      });
  } catch {
    /* no event bus at all here: nothing to follow */
  }
  return () => {
    disposed = true;
    unlisten?.();
  };
}
