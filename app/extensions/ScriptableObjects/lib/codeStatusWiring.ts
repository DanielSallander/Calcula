//! FILENAME: app/extensions/ScriptableObjects/lib/codeStatusWiring.ts
// PURPOSE: The production reads and signals behind the status bar's
//          code-and-scripts indicator (lib/codeStatus.ts holds the logic).
// CONTEXT: The reads are the SAME @api functions the Code in This File panel
//          calls, so the indicator and the panel count the same things -- but
//          LISTENING for failures (`onFailure`), because the tolerant reads turn
//          a population that could not be listed into an empty one, and a
//          summary that took that at face value would say "No code in this
//          file". One walk of the workbook's controls and cell types
//          (readButtonListing) serves all three button listings, instead of
//          each walking every sheet on its own.
//
//          The signals are every event that announces a change to the code in
//          the file: object scripts loaded or saved (from any window), modules
//          and macros saved (from any window), a script mounted or unmounted, a
//          pull, a control change. A notebook edit and a custom-function edit
//          announce nothing; the source's full read every fourth poll (60 s),
//          the user coming back to the window, and the fresh read the indicator
//          asks for each time it is opened catch those.

import {
  AppEvents,
  ObjectScriptManager,
  countAuditRefusals,
  getWorkbookCodeUnits,
  onAppEvent,
  onAudit,
  onObjectScriptsChanged,
  onWorkbookScriptsChanged,
  summarizeCodeInventory,
} from "@api";
import type { CodeUnit } from "@api";
import {
  getScriptHeldState,
  getWorkbookScheduledJobs,
  summarizeScheduledJobs,
  summarizeScriptHeldState,
} from "@api/codeInventory";
import {
  listApplicationCellCommands,
  listHeldButtonCode,
  readButtonListing,
  type ButtonListing,
} from "@api/heldButtonCode";
import type { CodeStatusFileRead, CodeStatusInventory, CodeStatusReaders, CodeStatusSignals } from "./codeStatus";

/** The indicator's roll-up of an inventory: the panel's own summary, trimmed. */
export function summarizeForStatus(units: CodeUnit[]): CodeStatusInventory {
  const { total, local, distributed, libraries, beyondGrid, mounted } = summarizeCodeInventory(units);
  return { total, local, distributed, libraries, beyondGrid, mounted };
}

/** A count, or null when the listing failed (said, never read as zero). */
async function countOrNull(list: Promise<unknown[]>): Promise<number | null> {
  try {
    return (await list).length;
  } catch (e) {
    console.warn("[CodeStatus] button listing unavailable:", e);
    return null;
  }
}

/** Run `read`, rejecting when it reported any failure through `onFailure`. */
async function strictly<T>(read: (onFailure: (what: string) => void) => Promise<T>): Promise<T> {
  const failures: string[] = [];
  const value = await read((what) => failures.push(what));
  if (failures.length > 0) throw new Error(`could not read ${failures.join(", ")}`);
  return value;
}

export const productionCodeStatusReaders: CodeStatusReaders = {
  async readFile(): Promise<CodeStatusFileRead> {
    const gaps: string[] = [];
    // One walk for all three button listings. If the walk itself fails, each
    // listing walks on its own, so a failure is reported by the listing it hits.
    let listing: ButtonListing | undefined;
    try {
      listing = await readButtonListing();
    } catch (e) {
      console.warn("[CodeStatus] workbook walk unavailable:", e);
      listing = undefined;
    }
    const units = await getWorkbookCodeUnits({
      onFailure: (what) => gaps.push(what),
      buttonListing: listing,
    });
    const [heldButtons, commandButtons] = await Promise.all([
      countOrNull(listHeldButtonCode(listing)),
      countOrNull(listApplicationCellCommands(listing)),
    ]);
    return {
      units,
      inventory: summarizeForStatus(units),
      gaps: [...new Set(gaps)],
      heldButtons,
      commandButtons,
    };
  },

  // `units` is the last inventory: the owner join reuses it rather than
  // re-reading the file (owners only NAME rows; the counts do not need them).
  readJobs: (units: CodeUnit[]) =>
    strictly(async (onFailure) => summarizeScheduledJobs(await getWorkbookScheduledJobs(units, { onFailure }))),

  readHeld: (units: CodeUnit[]) =>
    strictly(async (onFailure) => summarizeScriptHeldState(await getScriptHeldState(units, { onFailure }))),

  refusalsSoFar: () => countAuditRefusals(),
};

/** The extension's own event name, passed in (it lives in its index.ts). */
export interface CodeStatusEventNames {
  scriptsLoaded: string;
}

/** Subscribe to a Tauri event whose unlisten arrives asynchronously; a stop
 *  that comes first still unlistens. */
function tauriSubscription(listen: () => Promise<() => void>): () => void {
  let stopped = false;
  let unlisten: (() => void) | null = null;
  void listen()
    .then((u) => {
      if (stopped) u();
      else unlisten = u;
    })
    .catch(() => {
      /* no event bus (tests, browser smoke); the polls still catch it */
    });
  return () => {
    stopped = true;
    unlisten?.();
  };
}

export function productionCodeStatusSignals(events: CodeStatusEventNames): CodeStatusSignals {
  return {
    onDocumentReplaced(cb) {
      const offs = [onAppEvent(AppEvents.AFTER_OPEN, cb), onAppEvent(AppEvents.AFTER_NEW, cb)];
      return () => offs.forEach((off) => off());
    },

    onCodeMayHaveChanged(cb) {
      const offs: Array<() => void> = [
        // Object scripts loaded for a document.
        onAppEvent(events.scriptsLoaded, cb),
        // A script registered, removed, mounted or unmounted (consent and
        // revocation mount and unmount; mounted scripts are "running now").
        ObjectScriptManager.onScriptChange(cb),
        // A pull, a refresh or a push brought an application's code.
        onAppEvent(AppEvents.PACKAGE_UPDATED, cb),
        // Controls changed (undo/redo, a delete cascade, a backend refresh): a
        // button's code may have come or gone with them.
        onAppEvent(AppEvents.CONTROLS_CHANGED, cb),
        // Object scripts saved or deleted, AFTER the backend write -- from this
        // window or the standalone editor's.
        tauriSubscription(() => onObjectScriptsChanged(() => cb())),
        // Macros and modules: the two write doors in @api/workbookScripts.
        tauriSubscription(() => onWorkbookScriptsChanged(() => cb())),
      ];
      return () => offs.forEach((off) => off());
    },

    onUserReturned(cb) {
      // Coming back to the window is the moment a stale number would be read.
      if (typeof window === "undefined") return () => undefined;
      window.addEventListener("focus", cb);
      return () => window.removeEventListener("focus", cb);
    },

    onAudit(cb) {
      return onAudit(cb);
    },
  };
}
