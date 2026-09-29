//! FILENAME: app/extensions/Grouping/__tests__/dataMenuItemsLifecycle.test.ts
// PURPOSE: X18 (wave D). The five Data-menu contributors -- Goal Seek, What-If
//          Data Table, Solver (Data > What-If Analysis) and Grouping, Subtotals
//          (Data > Outline) -- take back their OWN items on deactivate, and
//          never the parent submenu they share with each other.
// CONTEXT: None of them took anything back: their menu items outlived the
//          extension, so a disabled Solver still offered Data > What-If
//          Analysis > Solver... (and ran the torn-down dialog door). Wave C made
//          unregisterItem accept a child id at any depth and drop a parent the
//          removal leaves empty; this is the census of the callers.

import { describe, it, expect, vi } from "vitest";
import { loadHarness, doorsUnder, settle, type Loader } from "../../ModelMenu/__tests__/lifecycleHarness";

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async () => null),
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}));

const GOAL_SEEK: Loader = () => import("../../GoalSeek");
const DATA_TABLES: Loader = () => import("../../DataTables");
const SOLVER: Loader = () => import("../../Solver");
const GROUPING: Loader = () => import("..");
const SUBTOTALS: Loader = () => import("../../Subtotals");

describe("X18: a Data-menu contributor's items live exactly as long as it does", () => {
  const CASES: [string, Loader, string][] = [
    ["Goal Seek", GOAL_SEEK, "data/data:whatIf"],
    ["What-If Data Table", DATA_TABLES, "data/data:whatIf"],
    ["Solver", SOLVER, "data/data:whatIf"],
    ["Grouping", GROUPING, "data/data:outline"],
    ["Subtotals", SUBTOTALS, "data/data:outline"],
  ];
  for (const [name, loader, parent] of CASES) {
    it(`${name}: deactivate removes every door activate added, and nothing else`, async () => {
      const { ext, context, doors } = await loadHarness(loader);
      const before = doors();
      await ext.activate(context);
      await settle();
      const added = doors().filter((d) => !before.includes(d));
      expect(added, `${name} added no ${parent} item -- the census has nothing to check`).toContain(parent);
      await ext.deactivate?.();
      await settle();
      expect(doors(), `${name} left these after deactivate (it added ${JSON.stringify(added)})`).toEqual(before);
    }, 30_000);
  }
});

describe("X18: a SHARED submenu keeps the other contributors' items", () => {
  it("What-If Analysis: each of Goal Seek, Data Table and Solver takes back only its own child", async () => {
    const { ext: goalSeek, companions, context, doors } = await loadHarness(GOAL_SEEK, {
      companions: [DATA_TABLES, SOLVER],
    });
    const [dataTables, solver] = companions;
    for (const ext of [goalSeek, dataTables, solver]) await ext.activate(context);
    const whatIf = () => doorsUnder(doors(), "data/data:whatIf:");
    expect(whatIf(), "positive control: all three items are there").toEqual([
      "data/data:whatIf:dataTable",
      "data/data:whatIf:goalSeek",
      "data/data:whatIf:solver",
    ]);

    await solver.deactivate?.();
    expect(whatIf(), "Solver's deactivate").toEqual(["data/data:whatIf:dataTable", "data/data:whatIf:goalSeek"]);
    expect(doors()).toContain("data/data:whatIf");

    await goalSeek.deactivate?.();
    expect(whatIf(), "Goal Seek's deactivate").toEqual(["data/data:whatIf:dataTable"]);
    expect(doors(), "the shared submenu went while Data Table still has an item in it").toContain(
      "data/data:whatIf",
    );

    // Coming back adds its item once, beside the one that stayed.
    await solver.activate(context);
    expect(whatIf()).toEqual(["data/data:whatIf:dataTable", "data/data:whatIf:solver"]);

    await dataTables.deactivate?.();
    await solver.deactivate?.();
    expect(doorsUnder(doors(), "data/data:whatIf"), "the last one out takes the empty submenu").toEqual([]);
  }, 30_000);

  it("Outline: Grouping and Subtotals each take back only their own items", async () => {
    const { ext: grouping, companions, context, doors } = await loadHarness(GROUPING, {
      companions: [SUBTOTALS],
    });
    const [subtotals] = companions;
    await grouping.activate(context);
    await subtotals.activate(context);
    await settle();
    const outline = () => doorsUnder(doors(), "data/data:outline:");
    const groupingOwn = outline().filter((d) => d !== "data/data:outline:subtotals");
    expect(outline(), "positive control: Subtotals' item is there").toContain("data/data:outline:subtotals");
    expect(groupingOwn.length, "positive control: Grouping's items are there").toBeGreaterThan(5);

    await grouping.deactivate?.();
    await settle();
    expect(outline(), "Grouping's deactivate took Subtotals' item, or left its own").toEqual([
      "data/data:outline:subtotals",
    ]);

    await grouping.activate(context);
    await settle();
    expect(outline(), "Grouping came back").toEqual([...groupingOwn, "data/data:outline:subtotals"].sort());

    await subtotals.deactivate?.();
    expect(outline(), "Subtotals' deactivate took Grouping's items, or left its own").toEqual(groupingOwn);

    await grouping.deactivate?.();
    await settle();
    expect(doorsUnder(doors(), "data/data:outline"), "the last one out takes the empty submenu").toEqual([]);
  }, 30_000);
});
