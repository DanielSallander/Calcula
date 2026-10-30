//! FILENAME: app/extensions/Sparklines/__tests__/saveAgainstBase.test.ts
// PURPOSE: BUG-0357 / revF#4 item 2 -- a sparkline change made WHILE a
//          structural command runs saves AFTER the command has moved the
//          stored groups. Every save now names the blob it was made against
//          (`save_sparklines`' `base`); the backend refuses a save whose base
//          it no longer holds, and the store merges its change into the moved
//          groups and saves the merge -- never the pre-edit ranges over the
//          moved ones, and never the change thrown away.
// CONTEXT: The extension is ACTIVATED for real (the shared lifecycle harness);
//          the backend is a fake `invokeBackend` that holds the stored blob and
//          applies sparkline_commands.rs' base rule (absent and "[]" / "" are
//          one state; no base = unconditional).

import { describe, it, expect, vi } from "vitest";
import { loadHarness, settle, type Loader } from "../../ModelMenu/__tests__/lifecycleHarness";

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async () => null),
}));

const SPARKLINES: Loader = () => import("..");

/** E{loc0 + 1}:E{loc1 + 1} over A{loc0 + 1}:C{loc1 + 1}, in the backend's own key order. */
function backendGroups(loc0: number, loc1: number, color = "#4472C4"): string {
  // serde_json writes keys sorted: deliberately NOT the frontend's order, so a
  // base the store re-serialised could never match it.
  return JSON.stringify([
    {
      color,
      dataRange: { endCol: 2, endRow: loc1, startCol: 0, startRow: loc0 },
      id: 1,
      lineWidth: 1,
      location: { endCol: 4, endRow: loc1, startCol: 4, startRow: loc0 },
      negativeColor: "#D00000",
      showMarkers: false,
      type: "line",
    },
  ]);
}

const isEmptyBlob = (blob: string | undefined): boolean => blob === undefined || ["", "[]", "null"].includes(blob.trim());

async function activate(initial: string | null) {
  const stored: { groupsJson: string | null } = { groupsJson: initial };
  const saves: Array<{ groupsJson: string; base: string | undefined; accepted: boolean }> = [];
  const invokeBackend = vi.fn(async (command: string, args?: unknown) => {
    if (command === "get_sparklines") {
      return stored.groupsJson === null ? [] : [{ sheetIndex: 0, groupsJson: stored.groupsJson }];
    }
    if (command === "save_sparklines") {
      const { entry, base } = args as { entry: { groupsJson: string }; base?: string };
      const held = stored.groupsJson ?? undefined;
      const matches = base === undefined || held === base || (isEmptyBlob(held) && isEmptyBlob(base));
      saves.push({ groupsJson: entry.groupsJson, base, accepted: matches });
      if (!matches) {
        throw "SPARKLINE_GROUPS_CHANGED: the sparklines of sheet 0 changed in the workbook after this edit was made; the edit was not written over them.";
      }
      stored.groupsJson = entry.groupsJson;
    }
    return null;
  });
  const { ext, context } = await loadHarness(SPARKLINES, { invokeBackend });
  const inertFn = (): unknown => new Proxy(() => () => {}, { get: () => inertFn(), apply: () => () => {} });
  const events = new Proxy({} as Record<string, unknown>, { get: () => inertFn() });
  const wrapped = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => (prop === "events" ? events : (context as Record<string | symbol, unknown>)[prop as string]),
  }) as never;
  await ext.activate(wrapped);
  await settle();
  const store = await import("../store");
  return { ext, stored, saves, store };
}

describe("a sparkline save made against groups the backend has since rewritten (revF#4 item 2)", () => {
  // SABOTAGE: drop `base: persistedJson` from saveToBackend's invoke -- the
  // fake backend then takes the first save unconditionally, as the real one
  // used to (no refusal, no merge), writing the pre-edit range (endRow 4) over
  // the moved one.
  it("is refused, merged into the moved groups, and the merge saved: the moved range AND the change survive", async () => {
    const { ext, stored, saves, store } = await activate(backendGroups(1, 4));
    // An Insert Rows moves the stored groups; the store has not re-read them
    // (its change below is made while the command runs).
    const moved = backendGroups(1, 5);
    stored.groupsJson = moved;

    store.updateSparklineGroup(store.getAllGroups()[0].id, { color: "#000000" });
    await settle();

    expect(saves.map((s) => s.accepted), "one refused save, then the merge").toEqual([false, true]);
    expect(saves[0].base, "the first save names the blob the store LOADED, byte for byte").toBe(backendGroups(1, 4));
    expect(saves[1].base, "the merge is saved against what the backend holds now").toBe(moved);
    const written = JSON.parse(stored.groupsJson!)[0];
    expect(written.location.endRow, "the moved location is kept").toBe(5);
    expect(written.dataRange.endRow, "the moved data range is kept").toBe(5);
    expect(written.color, "the change survives").toBe("#000000");
    expect(store.getAllGroups()[0].location.endRow, "the store shows the merge").toBe(5);
    ext.deactivate?.();
  });

  // SABOTAGE: treat the refusal like any other failure (no merge) -- only the
  // refused save is sent, and the change is lost.
  it("a change the backend refused is not thrown away", async () => {
    const { ext, stored, saves, store } = await activate(backendGroups(1, 4));
    stored.groupsJson = backendGroups(1, 5);
    store.updateSparklineGroup(store.getAllGroups()[0].id, { showMarkers: true });
    await settle();
    expect(saves).toHaveLength(2);
    expect(JSON.parse(stored.groupsJson!)[0].showMarkers).toBe(true);
    ext.deactivate?.();
  });

  it("an accepted save becomes the next save's base; a sheet with none stored saves against \"\"", async () => {
    const { ext, stored, saves, store } = await activate(null);
    store.createSparklineGroup(
      { startRow: 1, startCol: 6, endRow: 4, endCol: 6 },
      { startRow: 1, startCol: 0, endRow: 4, endCol: 2 },
      "column",
    );
    await settle();
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ base: "", accepted: true });
    store.updateSparklineGroup(store.getAllGroups()[0].id, { color: "#123456" });
    await settle();
    expect(saves).toHaveLength(2);
    expect(saves[1].base, "made against the save the backend accepted").toBe(saves[0].groupsJson);
    expect(saves[1].accepted).toBe(true);
    expect(JSON.parse(stored.groupsJson!)[0].color).toBe("#123456");
    ext.deactivate?.();
  });
});
