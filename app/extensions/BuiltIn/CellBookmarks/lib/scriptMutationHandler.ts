//! FILENAME: app/extensions/BuiltIn/CellBookmarks/lib/scriptMutationHandler.ts
// PURPOSE: Process bookmark mutations produced by script execution.
// CONTEXT: Scripts queue bookmark mutations during execution. After the script
//          completes, these mutations are dispatched to the CellBookmarks
//          extension via a CustomEvent or Tauri event.

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

// ============================================================================
// Types
// ============================================================================

interface ScriptBookmarkMutation {
  action: string;
  row?: number;
  col?: number;
  sheetIndex?: number;
  label?: string;
  color?: string;
  id?: string;
  dimensionsJson?: string;
}

// ============================================================================
// Mutation Processing
// ============================================================================

const VALID_COLORS = new Set(["blue", "green", "orange", "red", "purple", "yellow"]);

function toBookmarkColor(color?: string): BookmarkColor {
  if (color && VALID_COLORS.has(color)) return color as BookmarkColor;
  return "blue";
}

/**
 * Process an array of bookmark mutations produced by script execution.
 * Mutations are applied sequentially in order.
 */
export async function processBookmarkMutations(
  mutations: ScriptBookmarkMutation[]
): Promise<void> {
  for (const mutation of mutations) {
    try {
      switch (mutation.action) {
        case "addCellBookmark": {
          if (mutation.row === undefined || mutation.col === undefined) break;
          const state = getGridStateSnapshot();
          const si = mutation.sheetIndex ?? state?.sheetContext.activeSheetIndex ?? 0;
          const sheetName = state?.sheetContext.activeSheetName ?? "Sheet1";
          addBookmark(mutation.row, mutation.col, si, sheetName, {
            label: mutation.label,
            color: toBookmarkColor(mutation.color),
          });
          break;
        }

        case "removeCellBookmark": {
          if (mutation.row === undefined || mutation.col === undefined) break;
          const state2 = getGridStateSnapshot();
          const si2 = mutation.sheetIndex ?? state2?.sheetContext.activeSheetIndex ?? 0;
          removeBookmark(mutation.row, mutation.col, si2);
          break;
        }

        case "createViewBookmark": {
          if (!mutation.label) break;
          let dimensions: ViewStateDimensions = { ...DEFAULT_VIEW_DIMENSIONS };
          if (mutation.dimensionsJson) {
            try {
              dimensions = JSON.parse(mutation.dimensionsJson);
            } catch {
              // Use defaults
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
          if (mutation.id) {
            removeViewBookmark(mutation.id);
          }
          break;
        }

        case "activateViewBookmark": {
          if (mutation.id) {
            await activateViewBookmark(mutation.id);
          }
          break;
        }

        default:
          console.warn("[BookmarkMutations] Unknown action:", mutation.action);
      }
    } catch (error) {
      console.error("[BookmarkMutations] Error processing mutation:", mutation, error);
    }
  }
}
