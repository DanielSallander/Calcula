//! FILENAME: app/src/api/filesystem.ts
// PURPOSE: Filesystem operations API for extensions, plus the PICKER-MEDIATED
//          text export/import primitives the script broker builds on (G1).
// CONTEXT: Extensions call these functions instead of importing core/lib/file-api
//          directly. This ensures extensions only depend on the API facade, not
//          Core internals.
//
// THE RULE THIS FILE ENFORCES (Wave G): a script must never get a silent path.
// `exportTextViaPicker` / `importTextViaPicker` are the ONLY sanctioned route
// from sandboxed code to the disk, and they are shaped so that no path string
// can travel in either direction:
//
//   script -> host   : a bare FILE NAME suggestion + the content, nothing else
//   host   -> user   : a native picker; the human chooses the actual location
//   host   -> disk   : the privileged write/read, performed by trusted code
//   host   -> script : the chosen file's NAME (and, for import, its contents)
//
// The full path is deliberately dropped on the way back. It is useless to a
// sandboxed caller (there is no path-taking API to feed it to) and it leaks the
// user's account name and folder layout to any script that also holds net.fetch
// — an exfiltration the "fetch from example.com" consent never covered.

import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { invokeBackend } from "./backend";

export {
  newFile,
  openFile,
  saveFile,
  saveFileAs,
  isFileModified,
  markFileModified,
  updateWindowTitle,
  getCurrentFilePath,
} from "../core/lib/file-api";

// ============================================================================
// Picker-mediated text I/O
// ============================================================================

/** Text encodings a picker-mediated export may be asked for. */
export type PickerTextEncoding = "utf-8" | "utf-8-bom" | "ansi";

export interface ExportTextViaPickerRequest {
  /** Pre-fills the picker's NAME box. Must already be a bare file name — the
   *  caller is responsible for rejecting separators (for script callers the
   *  broker validator `vFileExport` does exactly that, before this is reached). */
  suggestedName: string;
  /** The text to write. */
  content: string;
  /** Row label for the picker's file-type filter. */
  filterName: string;
  /** Extensions offered by that filter, without dots. Empty = all files. */
  filterExtensions: string[];
  /** Defaults to UTF-8. */
  encoding?: PickerTextEncoding;
  /** Native dialog title. */
  title: string;
}

/** The FILE NAME the user chose, or null when they cancelled. Never a path. */
export async function exportTextViaPicker(
  request: ExportTextViaPickerRequest,
): Promise<string | null> {
  const chosen = await saveFileDialog({
    title: request.title,
    defaultPath: request.suggestedName,
    filters: pickerFilters(request.filterName, request.filterExtensions),
  });
  // Cancellation is a normal outcome, not an error: resolve with null.
  if (typeof chosen !== "string" || chosen.length === 0) return null;
  await invokeBackend<void>("write_text_file", {
    path: chosen,
    content: request.content,
    encoding: request.encoding ?? null,
  });
  return fileNameOf(chosen);
}

export interface ExportBinaryViaPickerRequest {
  /** Pre-fills the picker's NAME box. Must ALREADY be a bare file name — the
   *  caller rejects separators before reaching here, exactly as for text. */
  suggestedName: string;
  /** The bytes to write. Produced by trusted host code, never by a script:
   *  the sandboxed caller asks for a document, it does not supply one. */
  bytes: Uint8Array;
  /** Row label for the picker's file-type filter. */
  filterName: string;
  /** Extensions offered by that filter, without dots. Empty = all files. */
  filterExtensions: string[];
  /** Native dialog title. */
  title: string;
}

/**
 * The binary twin of {@link exportTextViaPicker}, for documents the HOST
 * renders (today: a PDF of the printable sheet). Same invariant, unchanged: the
 * caller names a FILE, the user picks the location, the host writes it, and the
 * only thing that comes back is the chosen file's NAME.
 *
 * The `bytes` parameter is deliberately not reachable from a sandbox: every
 * caller passes bytes it produced itself. A script asking to "save a PDF" is
 * asking the host to RENDER one — it never hands over a payload, so this cannot
 * become "write these arbitrary bytes anywhere the user can be talked into".
 */
export async function exportBinaryViaPicker(
  request: ExportBinaryViaPickerRequest,
): Promise<string | null> {
  const chosen = await saveFileDialog({
    title: request.title,
    defaultPath: request.suggestedName,
    filters: pickerFilters(request.filterName, request.filterExtensions),
  });
  if (typeof chosen !== "string" || chosen.length === 0) return null;
  await invokeBackend<void>("write_binary_file", {
    path: chosen,
    data: Array.from(request.bytes),
  });
  return fileNameOf(chosen);
}

export interface ImportTextViaPickerRequest {
  /** Extensions the picker offers, without dots. Empty = all files. */
  filterExtensions: string[];
  /** Row label for that filter. */
  filterName: string;
  /** Native dialog title. */
  title: string;
  /** Refuse (rather than truncate) a file whose text exceeds this length. */
  maxChars: number;
}

/** What a picker-mediated import hands back: the file's NAME and its text. */
export interface ImportedText {
  name: string;
  content: string;
}

/**
 * Open a picker, read the file the user chose, and return its text.
 *
 * Returns null when the user cancelled. THROWS when the chosen file is larger
 * than `maxChars` — refusing is the honest answer, because a silently truncated
 * CSV is corrupt data that looks like good data.
 */
export async function importTextViaPicker(
  request: ImportTextViaPickerRequest,
): Promise<ImportedText | null> {
  const chosen = await openFileDialog({
    title: request.title,
    multiple: false,
    directory: false,
    filters: pickerFilters(request.filterName, request.filterExtensions),
  });
  if (typeof chosen !== "string" || chosen.length === 0) return null;
  const content = await invokeBackend<string>("read_text_file", {
    path: chosen,
    encoding: null,
  });
  if (typeof content !== "string") {
    throw new Error("The selected file could not be read as text.");
  }
  if (content.length > request.maxChars) {
    throw new Error(
      `The selected file holds ${content.length} characters; the limit is ${request.maxChars}.`,
    );
  }
  return { name: fileNameOf(chosen), content };
}

/** Filter rows for a native picker; "All Files" is always offered so the user
 *  is never trapped by a filter a script chose. */
function pickerFilters(
  name: string,
  extensions: string[],
): Array<{ name: string; extensions: string[] }> {
  const all = { name: "All Files", extensions: ["*"] };
  return extensions.length > 0 ? [{ name, extensions }, all] : [all];
}

/** The last segment of a path, on either separator. Exported for the host and
 *  its tests: "never hand back a path" has exactly one implementation. */
export function fileNameOf(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}
