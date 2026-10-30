//! FILENAME: app/extensions/Sparklines/__tests__/structuralEditReload.test.ts
// PURPOSE: BUG-0357 -- after a structural edit the sparkline store re-reads the
//          groups the backend moved (chart_range_shift.rs, inside the edit's
//          own undo step) and never saves its stale copy over them; and a
//          sparkline change made just before the edit survives it (revF#3):
//          it is saved at the end of its own task, ahead of the edit, and one
//          still pending when the edit is announced is merged by group id.
// CONTEXT: The extension is ACTIVATED for real (the shared lifecycle harness);
//          the backend is a fake `invokeBackend` holding the stored groups.

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

/** E{loc0 + 1}:E{loc1 + 1} over A{loc0 + 1}:C{loc1 + 1}. */
function groups(loc0: number, loc1: number): string {
  return JSON.stringify([
    {
      id: 1,
      location: { startRow: loc0, startCol: 4, endRow: loc1, endCol: 4 },
      dataRange: { startRow: loc0, startCol: 0, endRow: loc1, endCol: 2 },
      type: "line",
      color: "#4472C4",
      negativeColor: "#D00000",
      showMarkers: false,
      lineWidth: 1,
    },
  ]);
}

async function activate() {
  const stored = { sheetIndex: 0, groupsJson: groups(1, 4) };
  const saves: string[] = [];
  const invokeBackend = vi.fn(async (command: string, args?: unknown) => {
    if (command === "get_sparklines") return [{ ...stored }];
    if (command === "save_sparklines") {
      const entry = (args as { entry: { groupsJson: string } }).entry;
      saves.push(entry.groupsJson);
      stored.groupsJson = entry.groupsJson;
    }
    return null;
  });
  const { ext, context } = await loadHarness(SPARKLINES, { invokeBackend });
  const subscribers = new Map<string, Array<(detail: unknown) => void>>();
  const inertFn = (): unknown => new Proxy(() => () => {}, { get: () => inertFn(), apply: () => () => {} });
  const events = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) =>
      prop === "on"
        ? (name: string, cb: (detail: unknown) => void) => {
            subscribers.set(name, [...(subscribers.get(name) ?? []), cb]);
            return () => subscribers.set(name, (subscribers.get(name) ?? []).filter((x) => x !== cb));
          }
        : inertFn(),
  });
  const wrapped = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => (prop === "events" ? events : (context as Record<string | symbol, unknown>)[prop as string]),
  }) as never;
  await ext.activate(wrapped);
  await settle();
  const store = await import("../store");
  const fire = async (name: string, detail?: unknown) => {
    for (const cb of subscribers.get(name) ?? []) cb(detail);
    await settle();
  };
  return { ext, stored, saves, store, fire };
}

describe("sparklines re-read the ranges a structural edit moved (BUG-0357)", () => {
  it("an inserted row: the store reads the moved group from the backend", async () => {
    const { ext, stored, store, fire } = await activate();
    expect(store.getAllGroups()[0].location.endRow).toBe(4);
    stored.groupsJson = groups(1, 5);
    await fire("app:rows-inserted", { startRow: 2, count: 1 });
    expect(store.getAllGroups()[0].location.endRow).toBe(5);
    expect(store.getAllGroups()[0].dataRange.endRow).toBe(5);
    expect(store.hasSparkline(5, 4), "the cell index follows the reload").toBe(true);
    ext.deactivate?.();
  });

  it("a change made BEFORE the structural edit is in the backend first, so the edit moves it", async () => {
    const { ext, stored, saves, store, fire } = await activate();
    // Insert > Sparklines (here a recolour), then at once Insert Rows: the save
    // goes out at the end of the action's task -- ahead of the structural
    // command -- instead of 300 ms later.
    store.updateSparklineGroup(store.getAllGroups()[0].id, { color: "#000000" });
    await settle();
    expect(saves, "the change was saved before the next action").toHaveLength(1);
    expect(JSON.parse(saves[0])[0].color).toBe("#000000");
    // insert_rows moves the SAVED groups.
    const moved = JSON.parse(groups(1, 5));
    moved[0].color = "#000000";
    stored.groupsJson = JSON.stringify(moved);
    await fire("app:rows-inserted", { startRow: 2, count: 1 });
    expect(store.getAllGroups()[0].location.endRow).toBe(5);
    expect(store.getAllGroups()[0].color, "the change survives the edit").toBe("#000000");
    expect(saves, "nothing stale was written after the edit").toHaveLength(1);
    ext.deactivate?.();
  });

  it("a group created just before the edit is moved with the others, never lost (revF#3)", async () => {
    const { ext, stored, saves, store, fire } = await activate();
    store.createSparklineGroup(
      { startRow: 1, startCol: 6, endRow: 4, endCol: 6 },
      { startRow: 1, startCol: 0, endRow: 4, endCol: 2 },
      "column",
    );
    await settle();
    expect(saves, "the new group was saved before the next action").toHaveLength(1);
    const sent = JSON.parse(saves[0]) as Array<{ id: number; location: { endRow: number } }>;
    expect(sent.map((g) => g.id)).toEqual([1, 2]);
    // The backend moved both groups the save sent.
    const movedGroups = sent.map((g) => ({ ...g, location: { ...g.location, endRow: 5 } }));
    stored.groupsJson = JSON.stringify(movedGroups);
    await fire("app:rows-inserted", { startRow: 2, count: 1 });
    expect(store.getAllGroups().map((g) => [g.id, g.location.endRow])).toEqual([[1, 5], [2, 5]]);
    ext.deactivate?.();
  });

  it("a change still PENDING when the edit is announced is merged by group id -- never dropped, never written over the moved groups", async () => {
    const { ext, stored, saves, store, fire } = await activate();
    // A change and the announcement in the same task: the save has not gone out.
    store.updateSparklineGroup(store.getAllGroups()[0].id, { color: "#000000" });
    stored.groupsJson = groups(1, 5);
    await fire("app:structural-undo", { description: "Insert Cells" });
    expect(saves, "one save: the merge").toHaveLength(1);
    const written = JSON.parse(saves[0])[0];
    expect(written.location.endRow, "the moved location").toBe(5);
    expect(written.dataRange.endRow, "the moved data").toBe(5);
    expect(written.color, "the pending recolour").toBe("#000000");
    expect(store.getAllGroups()[0].location.endRow).toBe(5);
    expect(store.getAllGroups()[0].color).toBe("#000000");
    ext.deactivate?.();
  });
});
