//! FILENAME: app/extensions/_shared/formatElapsed.ts
// PURPOSE: `1.4s` / `2m 05s` — the ONE duration format an authoring run is
//          reported in, in every window that reports one.
// CONTEXT: 2026-08-26. It began life inside `AIChat/lib/authorJobs.ts` with
//          three production call sites: the status-bar item, the chat view and
//          the guided screen. The move created the shared RunLog as its first
//          `_shared` consumer, and the editor's diff and history panel import
//          it too — six importing production files (seven call expressions:
//          `ScriptHistoryPanel` calls it twice), measured 2026-08-27. The
//          Object Script Editor is a SEPARATE Tauri window and may not import
//          AIChat's internals, so the only lawful home is `_shared` — and a lib
//          importing a components module for a string formatter would be the
//          wrong layer in the other direction.
//
//          `authorJobs.ts` re-exports it from here rather than editing its
//          existing importers (the three components plus `authorJobs.test.ts`):
//          the move is a MOVE, not a rename, and `authorJobs.test.ts`
//          importing it from `../lib/authorJobs` staying green unedited is
//          what proves that.

/** `1.4s` / `2m 05s` — a duration a person reads at a glance. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
}
