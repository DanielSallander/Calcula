//! FILENAME: app/src/api/objectScriptRunner.ts
// PURPOSE: Run object-script source ONCE, to completion, in a real hardened
//          worker realm — then tear the realm down again.
// CONTEXT: Calcula has two script vocabularies and, until now, only one way to
//          reach each of them:
//
//            `Calcula.*`  -> run_script (the Rust QuickJS module runtime).
//                            One call, runs, returns a result. Easy.
//            `context.api` -> exists ONLY inside a MOUNTED object script.
//                            Reaching it meant owning a real object to hang the
//                            script off — a button, a shape, a sheet.
//
//          That asymmetry is what made "Run" in the macro library a lie: a
//          recorded macro written for `context.api` had no execution path at all
//          unless the user first created a button. The runtime existed; nothing
//          could invoke it on demand.
//
//          THE MOUNT *IS* THE RUN. `hostMountScript` resolves only after the
//          worker's `setup(context)` has been awaited (worker/bootstrap.ts
//          `handleMount` -> `trackActivity("setup", ...)`), and REJECTS with the
//          script's own error when setup throws. So "mount, await, unmount" is a
//          complete, synchronous-looking one-shot execution with a real result —
//          no new runtime, no new privilege, and every existing guarantee
//          intact: Script Security gates the mount, the tier decides whether
//          `context.api` is non-null, the broker allowlist gates every call, and
//          the audit ring records it like any other object script.
//
//          WHY IT IS AN @api PRIMITIVE AND NOT A MACRO-RECORDER HELPER. "Execute
//          this script source once" is a Bridge on the Decision Matrix: the
//          macro library needs it, a future "Run Script" command needs it, and a
//          test harness needs it. Putting it in the extension would mean the
//          extension reaching into the script host, which the Facade Rule
//          forbids for good reason.

import {
  hostIsMounted,
  hostMountScript,
  hostUnmountScript,
  workerRealmAvailable,
} from "./scriptHost/host";
import { cancelUndoTransaction, getUndoState } from "./lib";
import { SCRIPT_API_VERSION, type ScriptAccessLevel, type ScriptableObjectType } from "./scriptableObjects";

/** What to run, and as what. */
export interface RunObjectScriptOnceOptions {
  /**
   * A name for the run — shown in the Script Security prompt, the audit ring
   * and any error message. Use something the user will recognise.
   */
  name: string;
  /** Object-script source. Must define `setup(context)`; that is the entry point. */
  source: string;
  /**
   * The object shape `context` takes. Defaults to "workbook", which is the
   * right answer for a free-standing run: it carries `context.api` at the
   * unlocked tier and has no per-instance identity to fake.
   */
  objectType?: ScriptableObjectType;
  /** Instance id for per-instance object types. Null for the primitives. */
  instanceId?: string | null;
  /** Tier. "unlocked" is required for `context.api` to be non-null. */
  accessLevel?: ScriptAccessLevel;
  /**
   * Id prefix for the transient mount. The suffix is always unique, so a run
   * can never collide with a script the user actually owns — nor appear in the
   * Object Scripts pane, which lists REGISTERED scripts and this one never is.
   */
  idPrefix?: string;
}

let runSeq = 0;

/**
 * Mount `source` in its own worker realm, wait for `setup(context)` to finish,
 * and unmount.
 *
 * Resolves when the script finished. REJECTS with the script's own error when
 * `setup` threw, with the Script-Security error when the mount was refused, and
 * with a plain explanation when this environment has no Worker at all — never
 * silently, and never with a "success" the script did not earn.
 *
 * The unmount runs in a `finally`, so a throwing script cannot leak its realm.
 */
export async function runObjectScriptOnce(
  options: RunObjectScriptOnceOptions,
): Promise<void> {
  const {
    name,
    source,
    objectType = "workbook",
    instanceId = null,
    accessLevel = "unlocked",
    idPrefix = "run-once",
  } = options;

  if (!workerRealmAvailable()) {
    throw new Error(
      "Scripts cannot run in this environment: the worker realm (Web Worker) is unavailable.",
    );
  }

  runSeq += 1;
  const id = `__calcula_${idPrefix}_${Date.now().toString(36)}_${runSeq}`;

  // A recorded macro's body is `beginBatch -> writes -> commitBatch`. If it is
  // killed between the two — the 10-second mount deadline, a throw the script
  // did not catch — the backend is left with an OPEN undo transaction, and
  // every subsequent edit the user makes accumulates into a group that is never
  // committed: their next Ctrl+Z does nothing, silently and permanently. The
  // `finally` below closes it (discarding the group, not the writes, which is
  // what `cancel_transaction` does). Remembering the state beforehand is what
  // distinguishes "this run opened it" from "it was already open".
  let transactionWasOpen = false;
  try {
    transactionWasOpen = (await getUndoState()).transactionOpen;
  } catch {
    // No backend (tests, teardown): nothing to leak either.
  }

  try {
    await hostMountScript({
      id,
      name,
      objectType,
      instanceId,
      source,
      accessLevel,
      provenance: "local",
      apiVersion: SCRIPT_API_VERSION,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The mount deadline is phrased for a MOUNT ("Script mount timed out"),
    // which is meaningless to someone who pressed Run. Here the mount IS the
    // run, so say what actually happened and what the limit is.
    if (/mount timed out/i.test(message)) {
      throw new Error(
        `"${name}" was still running after 10 seconds and was stopped. ` +
          "Whatever it had already written stays in the sheet, but it has no " +
          "single undo step — check the cells it touched. Split long work into " +
          "smaller steps.",
      );
    }
    throw err;
  } finally {
    if (hostIsMounted(id)) hostUnmountScript(id);
    if (!transactionWasOpen) {
      try {
        if ((await getUndoState()).transactionOpen) {
          await cancelUndoTransaction();
        }
      } catch (cleanupError) {
        console.error(
          "[objectScriptRunner] could not close the undo transaction the run left open:",
          cleanupError,
        );
      }
    }
  }
}
