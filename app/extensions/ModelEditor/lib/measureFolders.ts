// FILENAME: app/extensions/ModelEditor/lib/measureFolders.ts
// PURPOSE: Turn measures' flat `group` strings into a nested folder tree.
//          A group is a backslash-delimited display-folder path (Power BI /
//          Studio style): "Sales\KPIs\Margins". Intermediate folders exist
//          even when no measure sits directly in them.

import type { ModelMeasureInfo } from "@api";

/** Separator between nested display-folder segments (a single backslash). */
export const FOLDER_SEP = "\\";

export interface FolderNode {
  /** The last path segment (this folder's own name). */
  name: string;
  /** The full backslash-delimited path from the root to this folder. */
  path: string;
  children: FolderNode[];
  /** Measures whose group equals this folder's exact path. */
  measures: ModelMeasureInfo[];
}

/** Split a folder path into its segments, trimming blanks (so "A\\B\\" or
 *  "A\\\\B" collapse cleanly). */
export function splitFolderPath(path: string): string[] {
  return path
    .split(FOLDER_SEP)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Normalise a raw folder string (from a text box) into a canonical path with
 *  single separators and no leading/trailing/empty segments. "" if it is empty. */
export function normalizeFolderPath(raw: string): string {
  return splitFolderPath(raw).join(FOLDER_SEP);
}

/** Every folder path present in `groups`, plus each of their ancestors, sorted
 *  parents-before-children then alphabetically. Used to offer a complete folder
 *  list (including intermediate folders) in pickers. */
export function folderPathsWithAncestors(
  groups: Array<string | null | undefined>,
): string[] {
  const all = new Set<string>();
  for (const g of groups) {
    if (!g) continue;
    const segs = splitFolderPath(g);
    for (let i = 0; i < segs.length; i++) {
      all.add(segs.slice(0, i + 1).join(FOLDER_SEP));
    }
  }
  return Array.from(all).sort(sortByDepthThenName);
}

/** Order that guarantees a folder appears after all of its ancestors. */
export function sortByDepthThenName(a: string, b: string): number {
  const da = splitFolderPath(a).length;
  const db = splitFolderPath(b).length;
  return da - db || a.localeCompare(b);
}

/** Depth (0-based) of a folder path — how far to indent it. */
export function folderDepth(path: string): number {
  return Math.max(0, splitFolderPath(path).length - 1);
}

/**
 * Build the nested folder tree for a set of measures. `extraFolders` are
 * view-only folders the user created this session that may hold no measure yet
 * (their ancestors are materialised too). Returns the root folders and the
 * ungrouped measures.
 */
export function buildFolderTree(
  measures: ModelMeasureInfo[],
  extraFolders: string[],
): { roots: FolderNode[]; ungrouped: ModelMeasureInfo[] } {
  const ungrouped = measures.filter((m) => !m.group);

  const paths = folderPathsWithAncestors([
    ...measures.map((m) => m.group),
    ...extraFolders,
  ]);

  const byPath = new Map<string, FolderNode>();
  const roots: FolderNode[] = [];
  for (const path of paths) {
    const segs = splitFolderPath(path);
    const node: FolderNode = { name: segs[segs.length - 1], path, children: [], measures: [] };
    byPath.set(path, node);
    if (segs.length <= 1) {
      roots.push(node);
    } else {
      const parent = byPath.get(segs.slice(0, -1).join(FOLDER_SEP));
      // Parents sort before children, so the parent is already present.
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
  }

  for (const m of measures) {
    if (!m.group) continue;
    const node = byPath.get(normalizeFolderPath(m.group));
    if (node) node.measures.push(m);
  }

  return { roots, ungrouped };
}
