//! FILENAME: app/src/core/lib/fileNames.ts
// PURPOSE: The ONE implementation of "reduce a filesystem path to its last
//          segment" — the reduction that keeps a user's folder layout out of
//          sandboxed code.
// CONTEXT: A leaf module on purpose. `api/filesystem.ts` re-exports it as
//          `fileNameOf` (its historical home) and the script host's event
//          thinning (`api/scriptHost/allowlist.ts`) imports it directly; a leaf
//          means the thinning path does not have to pull the Tauri dialog
//          plugin into its module graph just to drop a directory.
//
// WHY IT MATTERS: "C:\Users\<real name>\Consulting\ClientX\Q4 bid.cala" handed
// to a script that also holds net.fetch is an exfiltration the fetch consent
// never covered — and a sandboxed caller has no path-taking API to feed it to
// anyway, so the directory buys it nothing.

/** The last segment of a path, on either separator. */
export function fileNameOf(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}
