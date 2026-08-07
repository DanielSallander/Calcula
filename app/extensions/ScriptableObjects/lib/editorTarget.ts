//! FILENAME: app/extensions/ScriptableObjects/lib/editorTarget.ts
// PURPOSE: Carry the identity of the document a NEW Object Script Editor window
//          is being opened for in the window's own URL.
// CONTEXT: The editor learned which document to show from a cross-window event.
//          That made "which macro is selected" a race between three independent
//          things — the editor registering its listeners, the main window's
//          fallback delivery timer, and the editor's own "nothing is selected
//          yet, take the first one" fallback. Under load the third could win,
//          and the window opened on whatever sorted first alphabetically (the
//          reported case: a `-sbfault-` macro selected instead of the `-sb-` one
//          the user double-clicked).
//
//          The identity now travels WITH the window. It is available to the
//          editor's very first render, before any listener, timer or listing —
//          so the initial selection is decided by identity, not by arrival order.
//          The event channel still carries the payload (and still drives
//          navigation of an ALREADY-OPEN window, which no URL can do).
//
//          A FRAGMENT, not a query string: fragments never reach the dev server
//          or Tauri's asset protocol, so the page is served identically either
//          way and only the webview sees the parameter.

/** Fragment key holding the requested document id. */
const DOC_KEY = "doc";

/**
 * The editor URL for a window opened on `documentId`.
 * With no id (a plain "open the editor"), the bare page.
 */
export function editorUrlForDocument(documentId?: string | null): string {
  const base = "/objectScript.html";
  if (!documentId) return base;
  return `${base}#${DOC_KEY}=${encodeURIComponent(documentId)}`;
}

/**
 * The document id this editor window was opened for, or null.
 *
 * Never throws: a malformed fragment yields null, and the editor falls back to
 * the event channel exactly as before.
 */
export function readRequestedDocumentId(hash?: string): string | null {
  const raw =
    hash ?? (typeof window !== "undefined" ? window.location?.hash ?? "" : "");
  if (!raw) return null;
  // Accepts either a bare fragment ("#doc=x", "doc=x") or a whole URL.
  const hashAt = raw.indexOf("#");
  const params = hashAt >= 0 ? raw.slice(hashAt + 1) : raw;
  for (const part of params.split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq) !== DOC_KEY) continue;
    try {
      const value = decodeURIComponent(part.slice(eq + 1));
      return value === "" ? null : value;
    } catch {
      return null;
    }
  }
  return null;
}
