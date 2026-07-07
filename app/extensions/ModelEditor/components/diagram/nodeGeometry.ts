// FILENAME: app/extensions/ModelEditor/components/diagram/nodeGeometry.ts
// PURPOSE: Shared node geometry for the relationship diagram (kept out of the
//          component files so Fast Refresh only sees component exports there).

import type { ModelTableInfo } from "@api";

export const NODE_WIDTH = 180;
export const HEADER_HEIGHT = 28;
export const ROW_HEIGHT = 20;
const PADDING = 8;

export function getNodeHeight(table: ModelTableInfo): number {
  return HEADER_HEIGHT + Math.max(table.columns.length, 1) * ROW_HEIGHT + PADDING;
}

export function getNodeWidth(): number {
  return NODE_WIDTH;
}
