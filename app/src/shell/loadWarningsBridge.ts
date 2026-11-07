//! FILENAME: app/src/shell/loadWarningsBridge.ts
// PURPOSE: Show the user what `open_file` had to change or drop while loading a
// workbook, once and without blocking the open.
//
// THE DEFECT THIS CLOSES
// ----------------------
// `open_file` (app/src-tauri/src/persistence.rs) emits `document:load-warnings`
// when a load is not faithful to the file: an AutoFilter section entry that
// could not be read (and so is lost), or -- since round 13 -- sheets whose
// names Excel's rule calls one (`Ärende` beside `ärende`), one of which the
// load renamed (`sheet_names::load_rename_notice`). Nothing listened: the
// backend's comment called the event "telling the FRONTEND too: a log line
// nobody opens is the same silence in a different place", and the frontend
// then never opened it either.
//
// Since round 17 `save_file` emits it too, once an .xlsx export is written,
// when the file could not hold something and left it out (a hyperlink the
// format refuses, a defined name Excel does not allow; section `xlsxExport`)
// -- it used to be a stderr line only. And an .xlsx OPEN says what it could not
// carry (section `xlsxImport`): a formula Calcula cannot read, opened as its
// value, and a table filter it cannot hold (BUG-0740).
//
// One event, one bridge -- the shape of dirtyStateBridge.ts.

import { listenTauriEvent } from "../api/backend";
import { showToast } from "../api/notifications";

/** The Tauri event `open_file` (and `save_file`, for an .xlsx export's
 *  losses) emits. Must match the emits in persistence.rs. */
export const BACKEND_LOAD_WARNINGS_EVENT = "document:load-warnings";

/** Payload of {@link BACKEND_LOAD_WARNINGS_EVENT}. `section` is an id
 *  (`sheetNames`, `autoFilters`, `xlsxExport`, `xlsxImport`) and `message` the ready sentence the user
 *  reads -- worded by the backend in plain words; file names and parser
 *  errors stay in its log (rev13C). The backend emits every warning only once
 *  the open has succeeded. */
export interface BackendLoadWarningsPayload {
  section?: string;
  message?: string;
}

/** The sentence the toast shows, or null when the payload says nothing. */
export function loadWarningText(payload: BackendLoadWarningsPayload | null | undefined): string | null {
  if (!payload) return null;
  if (typeof payload.message === "string" && payload.message.trim() !== "") return payload.message;
  return null;
}

/**
 * Show each load warning as a non-blocking warning toast that stays until the
 * user dismisses it (it reports a change to their document). Resolves to
 * `undefined` when there is no Tauri runtime (test contexts).
 */
export function bridgeLoadWarnings(): Promise<(() => void) | undefined> {
  return listenTauriEvent<BackendLoadWarningsPayload>(BACKEND_LOAD_WARNINGS_EVENT, (payload) => {
    const text = loadWarningText(payload);
    if (text !== null) showToast(text, { variant: "warning", duration: 0 });
  }).catch(() => undefined);
}
