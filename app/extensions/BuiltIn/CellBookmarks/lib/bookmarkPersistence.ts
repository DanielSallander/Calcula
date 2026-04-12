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
} from "./bookmarkStore";
import {
  serializeViewBookmarks,
  loadViewBookmarks,
  clearViewBookmarks,
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
 * Save all bookmarks to the virtual file system.
 * Called during BEFORE_SAVE event.
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
