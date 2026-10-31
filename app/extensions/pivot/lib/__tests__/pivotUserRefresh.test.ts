//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotUserRefresh.test.ts
// PURPOSE: The user's PivotTable Refresh ends copy / cut mode, as Excel's does
//          [LIVE 2026-10-31, clip7/probe-refresh.ps1: PivotTable.RefreshTable
//          with F6 copied -> CutCopyMode 0]; a refused refresh ends nothing,
//          and a bare cache refresh (PivotCache.Refresh -> still xlCopy) is not
//          this door. Round 16 (NEW-pivot-refresh-keeps-clipboard-mode).

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

const h = vi.hoisted(() => ({
  order: [] as string[],
  refuse: null as Error | null,
}));

vi.mock("@api", () => ({
  AppEvents: { DATA_COMMAND_APPLIED: "app:data-command-applied" },
  emitAppEvent: (name: string, detail: unknown) => h.order.push(`${name} ${JSON.stringify(detail)}`),
}));
vi.mock("../pivot-api", () => ({
  refreshPivotCache: vi.fn(async (pivotId: string) => {
    await Promise.resolve();
    if (h.refuse) throw h.refuse;
    h.order.push(`refreshed ${pivotId}`);
    return {};
  }),
}));

import { refreshPivotForUser } from "../pivotUserRefresh";

beforeEach(() => {
  h.order = [];
  h.refuse = null;
});

describe("[LIVE] a PivotTable's Refresh ends the clipboard mode once it landed", () => {
  it("announces DATA_COMMAND_APPLIED { command: 'refresh' } once, after the refresh", async () => {
    const repaints: string[] = [];
    const onRepaint = (): void => {
      repaints.push("pivot:refresh");
    };
    window.addEventListener("pivot:refresh", onRepaint);
    try {
      await refreshPivotForUser("pv-1");
    } finally {
      window.removeEventListener("pivot:refresh", onRepaint);
    }
    expect(h.order, "a refresh left a pending copy pasteable (Excel ends it)").toEqual([
      "refreshed pv-1",
      'app:data-command-applied {"command":"refresh"}',
    ]);
    expect(repaints).toEqual(["pivot:refresh"]);
  });

  it("a refused refresh (not connected) ends nothing and throws what it threw", async () => {
    h.refuse = new Error("Not connected");
    await expect(refreshPivotForUser("pv-1")).rejects.toThrow("Not connected");
    expect(h.order).toEqual([]);
  });

  it("both user doors -- the right-click Refresh and PivotTable Analyze > Refresh -- go through it (source pin)", () => {
    for (const rel of ["../../handlers/pivotContextMenu.ts", "../../components/PivotAnalyzeSections.tsx"]) {
      const src = fs.readFileSync(path.resolve(__dirname, rel), "utf8");
      expect(src, rel).toContain("await refreshPivotForUser(pivotId);");
      expect(src, `${rel} still refreshes the cache by itself`).not.toMatch(/await refreshPivotCache\(pivotId\)/);
    }
  });
});
