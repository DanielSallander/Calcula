//! FILENAME: app/src/core/lib/merge/mergeState.ts
// PURPOSE: The question the ribbon's Merge & Center button asks to draw itself
//          pressed: does ANY merged region lie in the selection?
// CONTEXT: Excel shows Merge & Center pressed whenever a merged cell is
//          anywhere in the selection -- the active cell need not be merged --
//          and clicking it then unmerges. One backend read, filtered to the
//          selection's bounding box so the whole merge set never crosses IPC.

import type { Selection } from "../../types";
import { getMergedRegions } from "../tauri-api";
import { boundingBox, regionsTouching, selectionBlocks } from "./mergeGeometry";

export interface SelectionMergeState {
  /** A merged region intersects at least one block of the selection. */
  touchesMerge: boolean;
}

/** Whether any merged region lies in `sel` (false for no selection). */
export async function readSelectionMergeState(sel: Selection | null | undefined): Promise<SelectionMergeState> {
  const blocks = selectionBlocks(sel);
  const box = boundingBox(blocks);
  if (!box) return { touchesMerge: false };
  const regions = await getMergedRegions(box);
  return { touchesMerge: regionsTouching(blocks, regions ?? []).length > 0 };
}
