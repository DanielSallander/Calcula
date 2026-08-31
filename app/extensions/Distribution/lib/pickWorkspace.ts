// FILENAME: app/extensions/Distribution/lib/pickWorkspace.ts
// PURPOSE: The one place that knows how a user POINTS AT a workspace.
// CONTEXT: A workspace is a directory, but aiming a folder picker at one is
//          awkward — you have to navigate INTO it and confirm an empty-looking
//          window. So a workspace also carries a `workspace.calcula` pointer
//          file (the .pbip idea), and the normal way to select one is to pick
//          that file. The backend accepts either spelling and collapses them to
//          the same workspace AND the same publisher-pin scope
//          (`strip_workspace_marker`, core/calp/src/workspace_id.rs), so which
//          one the user picked never splits one workspace into two identities.
//
//          The folder picker exists for the ONE case a file picker cannot
//          serve: creating a workspace, where the pointer file does not exist
//          to be selected yet and this publish is what writes it. It is NOT a
//          fallback for workspaces that lack the marker — there are none,
//          because `LocalWorkspace::write_application_manifest` writes the
//          pointer file, and every route that puts an application into a
//          workspace makes that write. So Subscribe and Open-for-editing offer
//          the file picker alone, and only the two PUBLISH dialogs get a folder
//          gesture. That claim was false when it was first written: the marker
//          was written by the workbook publish command alone, so publishing a
//          MODEL or a skin pack produced a workspace this picker could not see.

import { open as openNativeDialog } from "@tauri-apps/plugin-dialog";

/** The pointer file that names a workspace. Mirrors `WORKSPACE_MARKER_FILE`. */
export const WORKSPACE_MARKER_FILE = "workspace.calcula";

/**
 * Pick an EXISTING workspace by its `workspace.calcula` pointer file.
 *
 * Returns a location the backend accepts, or `null` if the user cancelled.
 *
 * The dialog filter is by EXTENSION, so it also shows any other `.calcula`
 * file. The backend's reduction is deliberately strict — it strips only the
 * exact marker name, so that a folder merely ending in `.calcula` is never
 * silently retargeted one level up — which means a differently-named file
 * would reach it as a location and be treated as a directory that happens to
 * exist, failing later with a confusing read error. So the narrowing happens
 * HERE, where the picker knows what was chosen: the marker is passed through,
 * anything else is reduced to the folder that contains it. Both spellings are
 * valid workspace locations and both scope to the same pin identity.
 */
export async function pickWorkspaceFile(
  title = "Select Workspace",
): Promise<string | null> {
  try {
    const selected = await openNativeDialog({
      multiple: false,
      title,
      filters: [{ name: "Calcula workspace", extensions: ["calcula"] }],
    });
    if (typeof selected !== "string") return null;
    const cut = Math.max(selected.lastIndexOf("\\"), selected.lastIndexOf("/"));
    if (cut < 0) return selected;
    const base = selected.slice(cut + 1);
    if (base.toLowerCase() === WORKSPACE_MARKER_FILE) return selected;
    return selected.slice(0, cut);
  } catch {
    return null; // user cancelled
  }
}

/**
 * Pick a DIRECTORY to use as a workspace — for publishing into a folder that
 * has no pointer file yet.
 */
export async function pickWorkspaceFolder(
  title = "Select Workspace Folder",
): Promise<string | null> {
  try {
    const selected = await openNativeDialog({
      directory: true,
      multiple: false,
      title,
    });
    return typeof selected === "string" ? selected : null;
  } catch {
    return null; // user cancelled
  }
}
