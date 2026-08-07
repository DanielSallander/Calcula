//! FILENAME: app/extensions/BuiltIn/CellBookmarks/lib/bookmarkPersistence.ts
// PURPOSE: Persistence layer for cell and view bookmarks.
// CONTEXT: Uses the virtual file system (user_files) to store bookmarks as JSON
//          inside the .cala archive. Hooked into BEFORE_SAVE and AFTER_OPEN events.

import { readVirtualFile, createVirtualFile } from "@api/backend";
import type { Bookmark } from "./bookmarkTypes";
import type { ViewBookmark } from "./viewBookmarkTypes";
import {
  getAllBookmarks,
  removeAllBookmarks,
  onChange as onCellBookmarkChange,
} from "./bookmarkStore";
import {
  serializeViewBookmarks,
  loadViewBookmarks,
  clearViewBookmarks,
  onViewBookmarkChange,
} from "./viewBookmarkStore";

// ============================================================================
// Constants
// ============================================================================

const BOOKMARKS_FILE = ".calcula/bookmarks.json";

// ============================================================================
// Serialization format
// ============================================================================

interface BookmarksData {
  version: 1;
  cellBookmarks: Bookmark[];
  viewBookmarks: ViewBookmark[];
}

// ============================================================================
// Save
// ============================================================================

/**
 * Write the current bookmark state into the virtual file.
 *
 * WRITE-THROUGH, NOT A SAVE HOOK. This used to be called only from a
 * `BEFORE_SAVE` listener. That listener is `async`, and the event dispatcher does not
 * await its handlers, so `save_file` could serialize `user_files` BEFORE this promise
 * resolved -- the newest bookmarks were written to the archive one save late, or lost
 * entirely if the user never saved again. There is no ordering fix available from the
 * listener side, because the race is between two independent async chains.
 *
 * So bookmarks are now written through on EVERY mutation (see
 * {@link startBookmarkWriteThrough}). By the time any save runs, the virtual file is
 * already current and there is nothing left to flush -- the race cannot occur.
 * `createVirtualFile` is itself a dirty-marking command, so a bookmark edit also makes
 * the close prompt and AutoRecover see the workbook as modified.
 */
export async function saveBookmarks(): Promise<void> {
  const cellBookmarks = getAllBookmarks();
  const viewBookmarks = serializeViewBookmarks();

  // Only write if there are bookmarks to save
  if (cellBookmarks.length === 0 && viewBookmarks.length === 0) {
    // Clean up the file if it exists but we have no bookmarks
    try {
      await createVirtualFile(BOOKMARKS_FILE, "");
    } catch {
      // File might not exist, that's fine
    }
    return;
  }

  const data: BookmarksData = {
    version: 1,
    cellBookmarks,
    viewBookmarks,
  };

  await createVirtualFile(BOOKMARKS_FILE, JSON.stringify(data, null, 2));
}

// ============================================================================
// Load
// ============================================================================

/**
 * We need access to the cell bookmark store's internal add function.
 * Import it dynamically to hydrate cell bookmarks from saved data.
 */
import { addBookmark as addCellBookmark } from "./bookmarkStore";

/**
 * Load bookmarks from the virtual file system.
 * Called during AFTER_OPEN event.
 */
export async function loadBookmarks(): Promise<void> {
  // Suppress write-through for the whole hydration: `removeAllBookmarks()` and each
  // `addCellBookmark()` below fire change notifications, and persisting those would
  // write a half-restored file back over the good one (and dirty a freshly opened
  // workbook, which is exactly the spurious-prompt failure the census warns about).
  writeThroughSuspended = true;
  try {
    await loadBookmarksInner();
  } finally {
    writeThroughSuspended = false;
  }
}

async function loadBookmarksInner(): Promise<void> {
  // Clear existing bookmarks first
  removeAllBookmarks();
  clearViewBookmarks();

  try {
    const content = await readVirtualFile(BOOKMARKS_FILE);
    if (!content || content.trim() === "") return;

    const data: BookmarksData = JSON.parse(content);
    if (data.version !== 1) {
      console.warn("[BookmarkPersistence] Unknown bookmark data version:", data.version);
      return;
    }

    // Restore cell bookmarks
    if (data.cellBookmarks && Array.isArray(data.cellBookmarks)) {
      for (const bm of data.cellBookmarks) {
        addCellBookmark(bm.row, bm.col, bm.sheetIndex, bm.sheetName, {
          label: bm.label,
          color: bm.color,
        });
      }
    }

    // Restore view bookmarks
    if (data.viewBookmarks && Array.isArray(data.viewBookmarks)) {
      loadViewBookmarks(data.viewBookmarks);
    }

    console.log(
      `[BookmarkPersistence] Loaded ${data.cellBookmarks?.length ?? 0} cell bookmark(s), ` +
      `${data.viewBookmarks?.length ?? 0} view bookmark(s)`
    );
  } catch (error) {
    // File doesn't exist or is invalid — that's fine for new workbooks
    console.debug("[BookmarkPersistence] No bookmarks file found or parse error:", error);
  }
}

// ============================================================================
// Write-through
// ============================================================================

/** True while `loadBookmarks` is hydrating, so restore traffic is not written back. */
let writeThroughSuspended = false;

/** In-flight write, so concurrent mutations serialize instead of interleaving. */
let inFlight: Promise<void> | null = null;
/** A mutation arrived while a write was in flight; re-run once it settles. */
let rewriteQueued = false;

/**
 * Persist immediately, coalescing bursts without ever leaving the file stale.
 *
 * Deliberately NOT debounced by a timer. A timer would reintroduce the very window this
 * change exists to remove: a save landing inside the debounce delay would archive the
 * previous state. Instead a mutation arriving mid-write sets `rewriteQueued`, so the
 * last write always reflects the final state and the chain settles one write later.
 */
function scheduleWriteThrough(): void {
  if (writeThroughSuspended) return;
  if (inFlight) {
    rewriteQueued = true;
    return;
  }
  inFlight = saveBookmarks()
    .catch((error) => {
      console.error("[BookmarkPersistence] Write-through failed:", error);
    })
    .finally(() => {
      inFlight = null;
      if (rewriteQueued) {
        rewriteQueued = false;
        scheduleWriteThrough();
      }
    });
}

/**
 * Subscribe to both bookmark stores and persist on every mutation.
 *
 * Returns a cleanup function that unsubscribes. Call once at extension activation.
 */
export function startBookmarkWriteThrough(): () => void {
  const offCell = onCellBookmarkChange(scheduleWriteThrough);
  const offView = onViewBookmarkChange(scheduleWriteThrough);
  return () => {
    offCell();
    offView();
  };
}

/**
 * Await any in-flight write. Test-only seam: production correctness does not depend on
 * anyone calling this, which is the whole point of write-through.
 */
export async function flushBookmarkWrites(): Promise<void> {
  while (inFlight) {
    await inFlight;
  }
}
