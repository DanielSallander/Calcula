//! FILENAME: app/extensions/ScriptableObjects/lib/lineDiff.ts
// PURPOSE: A tiny, dependency-free line diff (LCS) so the consent prompt can show
//          exactly how a distributed script CHANGED since the user last approved
//          it — review the change, not a blind re-approval (T3). Deliberately not
//          Monaco: a consent gate must always render, even if the editor's worker
//          loader is unavailable.

export type DiffRowType = "same" | "add" | "del";

export interface DiffRow {
  type: DiffRowType;
  text: string;
}

/**
 * Line-level diff of `oldText` -> `newText` via longest-common-subsequence.
 * Returns rows in display order: `same` (unchanged), `del` (in old only),
 * `add` (in new only). O(n*m) — fine for script-sized inputs.
 */
export function lineDiff(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;

  // dp[i][j] = LCS length of a[i..] and b[j..].
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "del", text: a[i] });
      i++;
    } else {
      rows.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) rows.push({ type: "del", text: a[i++] });
  while (j < m) rows.push({ type: "add", text: b[j++] });
  return rows;
}

/** Count of changed (add/del) rows — for a quick "N lines changed" summary. */
export function changedLineCount(rows: DiffRow[]): number {
  return rows.filter((r) => r.type !== "same").length;
}
