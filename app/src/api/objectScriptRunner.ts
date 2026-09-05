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
//
//          PROVENANCE IS DERIVED HERE, NEVER ASSERTED BY THE CALLER. This
//          function used to hard-code `provenance: "local"` and default
//          `accessLevel` to `"unlocked"`. A `.calp` may ship MODULE SCRIPTS;
//          `core/calp/src/pull.rs` materializes them into the subscriber's
//          workbook with `source_package` stamped, on the stated promise that
//          they "run only on explicit user action, sandboxed". The macro
//          library's Run button IS that explicit user action — and it handed
//          the publisher's code the unlocked tier under the user's own
//          provenance, which also routes capability requests to the LOCAL
//          just-in-time prompt instead of application consent. Two words in an
//          object literal undid the whole distribution trust model.
//
//          So the artifact's stored record decides, and it is resolved from the
//          module store by BOTH identity and content (`resolveArtifactOrigin`
//          below). See scriptOrigin.ts for why an origin is a union and not a
//          string.
//
//          ...AND DERIVING THE ORIGIN IS ONLY HALF OF IT. A stored module has
//          two run routes and the route is chosen by the module's DESCRIPTION —
//          publisher content in the shipped ScriptDef (`macroRunRoute`,
//          app/extensions/MacroRecorder/lib/macroLibrary.ts). The
//          `runtime=notebook` route runs through `run_script`, which calls
//          `require_distributed_module_consent` (app/src-tauri/src/scripting/
//          commands.rs) and refuses a module whose application the user never
//          approved. This route asked for consent NOWHERE. So a publisher wrote
//          `runtime=objectScript` in their own description and their code
//          executed in a real worker realm with no consent in the path.
//
//          RESTRICTED IS NOT CONSENTED. The tier bounds what the code can
//          REACH; consent is the user agreeing to run it AT ALL. Deriving the
//          package origin correctly and then mounting it anyway is a sandbox
//          around code the user never said yes to.
//
//          THE GATE IS NOT CALLED HERE EITHER — IT IS THE MOUNT'S. This file
//          used to make the consent call itself, and so did the macro library,
//          and the button runner, and none of them covered the Object Script
//          Editor's Run/Debug, which mounted a publisher's macro in a real
//          worker realm with no consent in the path. Every round closed the
//          caller it knew about and the next round found another. So the
//          requirement now lives at the boundary where a realm is CREATED:
//          `hostMountScript` (scriptHost/host.ts) will not mount without a
//          `MountAdmission`, and the only way to mint one runs BOTH gates —
//          Script Security, and this application's consent record. A run that
//          is refused therefore rejects out of the mount below, carrying the
//          Rust gate's own words.
//
//          WHAT REMAINS THIS FILE'S JOB is the half the boundary cannot do:
//          deciding WHOSE artifact a loose source string is, from the module
//          store, by identity AND by content (`resolveArtifactOrigin`). That
//          answer becomes the mount's provenance and tier — and it is what makes
//          the boundary's gate fire at all.

import {
  hostIsMounted,
  hostMountScript,
  hostUnmountScript,
  workerRealmAvailable,
} from "./scriptHost/host";
import { parseDeclaredCapabilities } from "./scriptHost/capabilities";
import {
  LOCAL_ORIGIN,
  accessLevelForOrigin,
  isLocalOrigin,
  mountProvenanceForOrigin,
  scriptOriginForStoredRecord,
  type MountOrigin,
} from "./scriptHost/scriptOrigin";
import { cancelUndoTransaction, getUndoState } from "./lib";
import { getWorkbookScript, listWorkbookScripts } from "./workbookScripts";
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
   * The stored module this run IS, when it is one.
   *
   * Identity, not content: a distributed macro whose source the user has edited
   * in a textarea but not saved is still the publisher's artifact, and the
   * stored record is what says so. Supplying it is how a run gets the STRICTER
   * of the two answers — see `resolveArtifactOrigin`.
   */
  scriptId?: string | null;
  /**
   * The object shape `context` takes. Defaults to "workbook", which is the
   * right answer for a free-standing run: it carries `context.api` at the
   * unlocked tier and has no per-instance identity to fake.
   */
  objectType?: ScriptableObjectType;
  /** Instance id for per-instance object types. Null for the primitives. */
  instanceId?: string | null;
  /**
   * The tier to run at IF the artifact is LOCAL. "unlocked" (the effective
   * default for local code) is what makes `context.api` non-null.
   *
   * It is not a claim about provenance and it cannot raise a distributed
   * artifact: a module carrying a source package runs `restricted`, whatever
   * is passed here. Passing "unlocked" EXPLICITLY for such a module is refused
   * outright — see the run body for why that is louder than a downgrade.
   */
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
 * A refusal for the one thing this module may never guess at: whose code this
 * is. One sentence, one shape, whatever part of the store went dark — the caller
 * (and the macro library's error surface) needs to say the same thing every
 * time, and the run must not proceed.
 */
function provenanceUnreadable(subject: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(
    `This script was not run: ${subject} could not be read, so there is no way to ` +
      "tell whether this code is yours or arrived inside an application. " +
      message,
  );
}

/**
 * The trust origin of the artifact this run is about to execute, read out of
 * the workbook's module store.
 *
 * TWO KEYS, AND THE STRICTER ANSWER WINS, because each closes the other's
 * evasion:
 *
 *  * BY IDENTITY (`scriptId`). The record the caller says it is running. This is
 *    what catches an EDITED distributed macro: the macro library's Run sends the
 *    textarea's current text, which no longer matches anything stored, while the
 *    record it came from is still the publisher's.
 *  * BY CONTENT (exact source match). This is what catches a caller that simply
 *    OMITS the id — the source is what actually executes, so it cannot lie. It
 *    mirrors `distributed_module_refusal` (app/src-tauri/src/scripting/commands.rs),
 *    including its escape hatch: a LOCAL record holding this exact source
 *    authorises it as local, so copying a distributed module into your own
 *    script — the documented way to adapt distributed content — keeps working.
 *
 * IDENTITY IS TRIED FIRST, AND USUALLY ENDS IT. Resolving by content means
 * downloading every module's source, and both callers (Developer ▸ Macros ▸ Run
 * and every click of a macro-linked button) go through here — a workbook with a
 * hundred modules paid a hundred `get_script` round trips per click to answer a
 * question one of them had already answered. So the named record is fetched on
 * its own first, and the scan runs only when that record cannot settle it:
 *
 *  * it says PACKAGE                       -> done, and it is the strict answer;
 *  * it says LOCAL and holds this EXACT
 *    source                                -> done: identity and content agree,
 *                                             and a local record with this source
 *                                             is the escape hatch's own answer;
 *  * it says LOCAL and the text has been
 *    EDITED, or there is no such record    -> scan, because the source being run
 *                                             may still be some other record's,
 *                                             and that record may be a
 *                                             publisher's.
 *
 * FAILS CLOSED — WHICH IS WHAT THIS PARAGRAPH USED TO ONLY CLAIM. If the listing
 * fails, the origin is unknown. If the NAMED record fails to load, the origin is
 * unknown. If the content scan cannot read some record, then a record that might
 * hold this very source is unaccounted for, and the origin is unknown. An
 * unknown origin is not permission to assume the user's own, so every one of
 * those is a refusal — the previous version read a per-record failure as an
 * empty source and a null package, i.e. as "a local script that isn't this one",
 * which is the one direction that grants.
 */
/**
 * What `resolveArtifactOrigin` settles: the trust origin, and — for a
 * distributed artifact — the `{ id, source }` pair the application's consent
 * record lists for it, so the mount can name it to the Rust gate.
 *
 * The SOURCE named is the one about to RUN, not the stored one. For a record
 * resolved by identity that is the caller's text, which the gate hashes: an
 * edited distributed macro therefore fails the artifact check ("its code has
 * changed since it was approved") instead of riding on the application floor —
 * the module gate cannot catch that case, because an edited body matches no
 * stored module and it answers "not a stored module, allow". For a record
 * resolved by content the two are equal by construction. A local artifact
 * names nothing: it is never asked.
 */
interface ResolvedArtifact {
  origin: MountOrigin;
  artifact: { id: string; source: string } | null;
}

async function resolveArtifactOrigin(options: {
  scriptId?: string | null;
  source: string;
}): Promise<ResolvedArtifact> {
  let summaries: Awaited<ReturnType<typeof listWorkbookScripts>>;
  try {
    // id + name only: no source travels, so this stays one small round trip
    // however many modules the workbook holds.
    summaries = await listWorkbookScripts();
  } catch (err) {
    throw provenanceUnreadable("the workbook's script modules", err);
  }

  const wanted =
    typeof options.scriptId === "string" && options.scriptId.trim() !== ""
      ? options.scriptId
      : null;
  // The listing is what distinguishes "no such module" (fall through to the
  // scan) from "the module is there and would not load" (a refusal): `get_script`
  // reports both as a plain error string and cannot tell them apart.
  if (wanted !== null && summaries.some((s) => s.id === wanted)) {
    let record: Awaited<ReturnType<typeof getWorkbookScript>>;
    try {
      record = await getWorkbookScript(wanted);
    } catch (err) {
      throw provenanceUnreadable(`the stored module "${wanted}"`, err);
    }
    const origin = scriptOriginForStoredRecord(record);
    if (origin.kind === "package") {
      return { origin, artifact: { id: wanted, source: options.source } };
    }
    if (record.source === options.source) return { origin: LOCAL_ORIGIN, artifact: null };
  }

  // THE CONTENT SCAN. Every module's source, compared to what is about to run.
  let firstPackage: ResolvedArtifact | null = null;
  let unreadable: Error | null = null;
  for (const summary of summaries) {
    let record: Awaited<ReturnType<typeof getWorkbookScript>>;
    try {
      record = await getWorkbookScript(summary.id);
    } catch (err) {
      // Remember it and keep going: a later record may still give a definite
      // answer, and a definite answer beats a refusal. If none does, this
      // throws below rather than defaulting to the user's own.
      if (!unreadable) unreadable = provenanceUnreadable(`the stored module "${summary.id}"`, err);
      continue;
    }
    if (record.source !== options.source) continue;
    const origin = scriptOriginForStoredRecord(record);
    // A subscriber-authored record with this exact source authorises it
    // outright — the documented way to adapt distributed content.
    if (isLocalOrigin(origin)) return { origin: LOCAL_ORIGIN, artifact: null };
    if (!firstPackage) {
      firstPackage = { origin, artifact: { id: summary.id, source: record.source } };
    }
  }
  if (firstPackage) return firstPackage;
  if (unreadable) throw unreadable;

  // Not a stored artifact at all (freshly generated source, a test harness):
  // there is no package behind it, so it is the user's own.
  return { origin: LOCAL_ORIGIN, artifact: null };
}

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
    scriptId = null,
    objectType = "workbook",
    instanceId = null,
    idPrefix = "run-once",
  } = options;

  if (!workerRealmAvailable()) {
    throw new Error(
      "Scripts cannot run in this environment: the worker realm (Web Worker) is unavailable.",
    );
  }

  // The artifact decides, not the caller. Resolved BEFORE anything is mounted,
  // and before the run id is minted, so a refusal costs nothing.
  const { origin, artifact } = await resolveArtifactOrigin({ scriptId, source });
  // REFUSE A CONTRADICTION, DERIVE AN ABSENCE. A caller that says nothing about
  // the tier gets the artifact's own answer (unlocked for local, restricted for
  // distributed). A caller that EXPLICITLY asks for "unlocked" on a distributed
  // artifact believes it is about to hand a publisher the full cross-sheet
  // surface, and downgrading that silently would leave the belief — and the
  // code that rests on it — intact and wrong. The macro library derives its
  // request from the same record, so this fires only on a genuine caller bug.
  if (origin.kind === "package" && options.accessLevel === "unlocked") {
    throw new Error(
      `"${name}" arrived inside the application "${origin.name}", so it cannot be run ` +
        "at the unlocked tier. Distributed code runs restricted and receives " +
        "capabilities only through that application's consent record, never through " +
        "the local just-in-time prompt. The caller asked for \"unlocked\" — that is a " +
        "bug in the caller, not something this run may quietly downgrade.",
    );
  }
  const accessLevel: ScriptAccessLevel = accessLevelForOrigin(
    origin,
    options.accessLevel ?? "unlocked",
  );
  // NOTE: there is no consent call here, and its absence is the design. The
  // derived origin travels into the mount below as `provenance`/`packageName`,
  // and `hostMountScript` refuses to create a realm for a distributed
  // definition whose application the user has not approved. A second call from
  // here would be a second implementation of the same decision — which is how
  // the run routes came to differ in the first place.

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
      // Derived from the stored record, one spelling of "distributed"
      // (mountProvenanceForOrigin). `buildHandleFromDefinition` turns this into
      // the handle's `origin`, which is what decides the JIT-prompt path, the
      // persisted-grant store and the R7 same-origin trust predicate — so a
      // hard-coded "local" here was not cosmetic, it was all four gates.
      ...mountProvenanceForOrigin(origin),
      // The R19 ceiling from the source's own `// @capability` pragmas —
      // exactly what a SAVED local script's definition carries. Declaring
      // grants nothing: it only makes the JIT consent prompt possible
      // (local provenance), and the Rust gates re-check the grant on every
      // call. Without this a recorded macro that edits the BI model was
      // denied WITHOUT a prompt: the run-once mount had an empty ceiling,
      // so `maybeRequestCapabilityGrant` never asked and the broker refused
      // `cap.biModel*` as undeclared. Found by the record→replay E2E.
      //
      // For a DISTRIBUTED artifact the pragmas are the publisher's own text, so
      // they still only describe a ceiling; the grant itself comes from the
      // application's consent record, and `buildHandleFromDefinition` withholds
      // the automatic local `ui.html` grant from a package origin.
      declaredCapabilities: parseDeclaredCapabilities(source).caps,
      // A module a `.calp` shipped is recorded under the application's BARE key
      // alongside its object scripts (one grant covers both kinds), and the
      // artifact is the stored module `resolveArtifactOrigin` settled on — with
      // the source about to run, so an edited publisher macro is refused at the
      // hash rather than admitted on the application floor. A local artifact
      // names none; the gate never asks about it.
      consentSurface: "object-script",
      consentArtifacts: artifact ? [artifact] : undefined,
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
