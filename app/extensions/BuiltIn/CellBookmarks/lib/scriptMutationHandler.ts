//! FILENAME: app/extensions/BuiltIn/CellBookmarks/lib/scriptMutationHandler.ts
// PURPOSE: Process bookmark mutations produced by script execution.
// CONTEXT: Scripts run against cloned state, so `Calcula.bookmarks.*` only
//          QUEUES mutations; the host applies them here once the run finishes
//          (dispatched on SCRIPT_BOOKMARK_MUTATIONS_EVENT by @api/workbookScripts).
//          The payload arrives over IPC + an untyped CustomEvent, so it is
//          normalized to the canonical union before anything touches the stores.

import {
  addBookmark,
  removeBookmark,
} from "./bookmarkStore";
import {
  addViewBookmark,
  removeViewBookmark,
  activateViewBookmark,
} from "./viewBookmarkStore";
import type { BookmarkColor } from "./bookmarkTypes";
import type { ViewStateDimensions } from "./viewBookmarkTypes";
import { DEFAULT_VIEW_DIMENSIONS } from "./viewBookmarkTypes";
import { getGridStateSnapshot } from "@api/grid";
import { getSheets } from "@api/lib";
import { normalizeBookmarkMutations } from "@api/workbookScripts";

// ============================================================================
// Mutation Processing
// ============================================================================

const VALID_COLORS = new Set(["blue", "green", "orange", "red", "purple", "yellow"]);

/**
 * View bookmarks currently being activated from a script mutation. Activating a
 * bookmark runs its onActivate script, which can queue another activation — this
 * keeps a self- or mutually-referential pair from recursing forever.
 */
const activatingViewBookmarks = new Set<string>();

function toBookmarkColor(color: string | null): BookmarkColor {
  if (color && VALID_COLORS.has(color)) return color as BookmarkColor;
  return "blue";
}

/**
 * Resolve sheet index + name for a mutation. A script may bookmark a cell on a
 * sheet the user is not looking at, so the name is read from the workbook (once
 * per batch, lazily) instead of assuming the active sheet's.
 */
function createSheetResolver(): (sheetIndex: number) => Promise<{ index: number; name: string }> {
  let namesPromise: Promise<string[]> | null = null;

  return async (sheetIndex: number) => {
    const snapshot = getGridStateSnapshot();
    const activeIndex = snapshot?.sheetContext.activeSheetIndex ?? 0;
    const activeName = snapshot?.sheetContext.activeSheetName ?? "Sheet1";

    // NaN = the script did not name a sheet -> the one in front of the user.
    const index = Number.isInteger(sheetIndex) && sheetIndex >= 0 ? sheetIndex : activeIndex;
    if (index === activeIndex) return { index, name: activeName };

    if (!namesPromise) {
      namesPromise = getSheets()
        .then((result) => result.sheets.map((s) => s.name))
        .catch(() => []);
    }
    const names = await namesPromise;
    return { index, name: names[index] ?? activeName };
  };
}

/**
 * Process a queue of bookmark mutations produced by script execution.
 * Mutations are applied sequentially, in the order the script queued them;
 * a failing mutation is logged and the rest still run.
 */
export async function processBookmarkMutations(raw: unknown): Promise<void> {
  const mutations = normalizeBookmarkMutations(raw);
  if (mutations.length === 0) return;
  const resolveSheet = createSheetResolver();

  for (const mutation of mutations) {
    try {
      switch (mutation.action) {
        case "addCellBookmark": {
          const sheet = await resolveSheet(mutation.sheetIndex);
          addBookmark(mutation.row, mutation.col, sheet.index, sheet.name, {
            label: mutation.label ?? undefined,
            color: toBookmarkColor(mutation.color),
          });
          break;
        }

        case "removeCellBookmark": {
          const sheet = await resolveSheet(mutation.sheetIndex);
          removeBookmark(mutation.row, mutation.col, sheet.index);
          break;
        }

        case "createViewBookmark": {
          let dimensions: ViewStateDimensions = { ...DEFAULT_VIEW_DIMENSIONS };
          if (mutation.dimensionsJson) {
            try {
              dimensions = JSON.parse(mutation.dimensionsJson);
            } catch {
              // Malformed JSON from the script: capture every dimension instead.
            }
          }
          await addViewBookmark({
            label: mutation.label,
            color: toBookmarkColor(mutation.color),
            dimensions,
          });
          break;
        }

        case "deleteViewBookmark": {
          removeViewBookmark(mutation.id);
          break;
        }

        case "activateViewBookmark": {
          if (activatingViewBookmarks.has(mutation.id)) {
            console.warn(
              "[BookmarkMutations] Skipping recursive activation of view bookmark:",
              mutation.id
            );
            break;
          }
          activatingViewBookmarks.add(mutation.id);
          try {
            await activateViewBookmark(mutation.id);
          } finally {
            activatingViewBookmarks.delete(mutation.id);
          }
          break;
        }
      }
    } catch (error) {
      console.error("[BookmarkMutations] Error processing mutation:", mutation, error);
    }
  }
}
