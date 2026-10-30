//! FILENAME: app/extensions/Pivot/lib/__tests__/pivotOutputAnnounce.test.ts
// PURPOSE: BUG-0594 -- every pivot-api door that changes what a pivot SHOWS
//          announces it ("pivot:refresh", lib/pivotRegionRefresh.ts) once it has
//          accepted the backend's result, so the region and the Core's cells
//          follow the backend whoever the caller is. The doors used to cache
//          the new view and stop: the region followed only when the CALLER
//          also dispatched "pivot:refresh", and the @api facade route
//          (`pivot.applyFilter` from a script, another extension, a journey),
//          the pivot store service's refresh and a dozen other doors never did.
//
//          Two layers: the doors behind the @api facade, driven through
//          `@api/pivot` over a mocked backend; and a census of pivot-api.ts
//          itself, so a NEW door that returns a pivot view cannot ship silent.
//          Round 3 (revD#1/#2): each door announces EXACTLY once (the
//          announcement is coalesced, a macrotask later), every one of them
//          is registered as an output door (a loop is one announcement), and a
//          door that does not cache its response marks the cached view stale.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";

const view = (rowCount: number) => ({
  pivotId: 3,
  version: rowCount,
  rowCount,
  colCount: 2,
  rowLabelColCount: 1,
  columnHeaderRowCount: 1,
  filterRowCount: 0,
  filterRows: [],
  rowFieldSummaries: [],
  columnFieldSummaries: [],
  rows: [],
  columns: [],
});

vi.mock("@api/backend", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const answer = async () => view(4);
  const out: Record<string, unknown> = { ...actual };
  for (const name of [
    "createPivotTable", "updatePivotFields", "togglePivotGroup", "refreshPivotCache",
    "changePivotDataSource", "updatePivotLayout", "addPivotHierarchy", "removePivotHierarchy",
    "movePivotField", "setPivotAggregation", "setPivotNumberFormat", "applyPivotFilter",
    "clearPivotFilter", "sortPivotField", "setPivotItemVisibility", "setPivotItemExpanded",
    "expandCollapseLevel", "expandCollapseAll", "groupPivotField", "createManualGroup",
    "ungroupPivotField", "createPivotFromBiModel", "updateBiPivotFields", "addCalculatedField",
    "updateCalculatedField", "removeCalculatedField", "addCalculatedItem", "removeCalculatedItem",
  ]) {
    out[name] = answer;
  }
  out.refreshAllPivotTables = async () => [view(4), view(6)];
  out.relocatePivot = async () => undefined;
  out.cancelPivotOperation = async () => undefined;
  out.revertPivotOperation = async () => undefined;
  return out;
});
vi.mock("@api/dialogs", () => ({ confirmAsync: vi.fn(() => Promise.resolve(true)) }));
vi.mock("@api/pivotNotices", () => ({ surfacePivotNotices: vi.fn() }));

import { pivot } from "@api/pivot";
import "../pivot-api";
import { PIVOT_REFRESH_EVENT } from "../pivotRegionRefresh";

let announced = 0;
const onAnnounce = () => {
  announced++;
};

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  window.addEventListener(PIVOT_REFRESH_EVENT, onAnnounce);
});
afterAll(() => {
  window.removeEventListener(PIVOT_REFRESH_EVENT, onAnnounce);
});

/** The doors behind @api/pivot that change a pivot's output, each as a caller would use it. */
const DOORS: Array<[string, () => Promise<unknown>]> = [
  ["applyFilter", () => pivot.applyFilter({ pivotId: 3, fieldIndex: 0, filters: { manualFilter: { selectedItems: ["a"] } } } as never)],
  ["clearFilter", () => pivot.clearFilter({ pivotId: 3, fieldIndex: 0 } as never)],
  ["sortField", () => pivot.sortField({ pivotId: 3, fieldIndex: 0, sortBy: "ascending" } as never)],
  ["setAggregation", () => pivot.setAggregation({ pivotId: 3, valueFieldIndex: 0, aggregation: "sum" } as never)],
  ["setNumberFormat", () => pivot.setNumberFormat({ pivotId: 3, valueFieldIndex: 0, numberFormat: "0" } as never)],
  ["setItemVisibility", () => pivot.setItemVisibility({ pivotId: 3, fieldIndex: 0, itemName: "a", visible: false } as never)],
  ["updateFields", () => pivot.updateFields({ pivotId: 3 } as never)],
  ["updateBiFields", () => pivot.updateBiFields({ pivotId: 3 } as never)],
  ["toggleGroup", () => pivot.toggleGroup({ pivotId: 3 } as never)],
  ["updateLayout", () => pivot.updateLayout({ pivotId: 3 } as never)],
  ["addHierarchy", () => pivot.addHierarchy({ pivotId: 3 } as never)],
  ["removeHierarchy", () => pivot.removeHierarchy({ pivotId: 3 } as never)],
  ["moveField", () => pivot.moveField({ pivotId: 3 } as never)],
  ["setItemExpanded", () => pivot.setItemExpanded({ pivotId: 3 } as never)],
  ["expandCollapseLevel", () => pivot.expandCollapseLevel({ pivotId: 3 } as never)],
  ["expandCollapseAll", () => pivot.expandCollapseAll({ pivotId: 3 } as never)],
  ["groupPivotField", () => pivot.groupPivotField({ pivotId: 3 } as never)],
  ["createManualGroup", () => pivot.createManualGroup({ pivotId: 3 } as never)],
  ["ungroupPivotField", () => pivot.ungroupPivotField({ pivotId: 3 } as never)],
  ["refreshCache", () => pivot.refreshCache(3 as never)],
  ["refreshAll", () => pivot.refreshAll()],
  ["create", () => pivot.create({} as never)],
  ["createFromBiModel", () => pivot.createFromBiModel({} as never)],
];

/** The announcement is coalesced and goes out a macrotask later (revD#2). */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
    for (let j = 0; j < 10; j++) await Promise.resolve();
  }
}

describe("BUG-0594: the @api doors announce the output they changed", () => {
  for (const [name, call] of DOORS) {
    it(`pivot.${name}`, async () => {
      announced = 0;
      await call();
      await settle();
      // Exactly once (revD#2): refreshAll changes two pivots and still
      // announces them as ONE event.
      expect(announced, `pivot.${name} changed the pivot's output and announced nothing`).toBeGreaterThanOrEqual(1);
      expect(announced, `pivot.${name} announced one change more than once`).toBe(1);
    });
  }
});

describe("revD#2: the doors behind the facade are OUTPUT DOORS (a loop of them is announced once)", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../pivot-api.ts"), "utf8");
  const registration = src.slice(src.indexOf("registerPivotApi({"));

  it("every door of the DOORS table is registered through asPivotOutputDoor", () => {
    const bare: string[] = [];
    for (const [name] of DOORS) {
      // `name: impl,` or the shorthand `name,`
      const line = registration.split("\n").find((l) => new RegExp(`^\\s*${name}\\s*[:,]`).test(l));
      if (!line || !line.includes("asPivotOutputDoor(")) bare.push(name);
    }
    expect(bare, "these output-changing doors are registered bare: a loop of them announces once per pivot").toEqual([]);
  });
});

describe("census: no door of pivot-api.ts that returns a pivot view is silent", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../pivot-api.ts"), "utf8");

  it("every cachePivotView of a door goes through adoptPivotOutput (cache AND announce)", () => {
    const calls = src.split("\n").filter((l) => /\bcachePivotView\(/.test(l) && !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    expect(calls.map((l) => l.trim())).toEqual(["cachePivotView(pivotId, result);"]);
    const helper = src.slice(src.indexOf("function adoptPivotOutput("), src.indexOf("\n}\n", src.indexOf("function adoptPivotOutput(")));
    // Names the pivot (revD#2: the script host's pivot.onRefresh filters on it).
    expect(helper).toContain("announcePivotOutputChanged(pivotId);");
  });

  it("every exported door returning PivotViewResponse announces (the one read, getPivotView, excepted)", () => {
    const READS = new Set(["getPivotView"]);
    // Every exported function with its return type; the doors are those whose
    // promise is a pivot view (one or many).
    const re = /export async function (\w+)\s*\([\s\S]*?\)\s*:\s*Promise<([^{]*?)>\s*\{/g;
    const silent: string[] = [];
    let doors = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const returns = m[2].trim();
      if (returns !== "PivotViewResponse" && returns !== "PivotViewResponse[]") continue;
      if (READS.has(m[1])) continue;
      doors++;
      const body = src.slice(m.index, src.indexOf("\n}\n", m.index));
      if (!/adoptPivotOutput\(|notePivotOutputChanged\(|announcePivotOutputChanged\(/.test(body)) silent.push(m[1]);
    }
    expect(doors, "the census found no doors: the pattern no longer matches pivot-api.ts").toBeGreaterThan(20);
    expect(silent, "these doors change a pivot's output without announcing it").toEqual([]);
  });

  it("relocatePivot announces too (the output moved; it returns no view)", () => {
    const body = src.slice(src.indexOf("export async function relocatePivot("), src.indexOf("\n}\n", src.indexOf("export async function relocatePivot(")));
    expect(body).toContain("notePivotOutputChanged(pivotId);");
  });

  it("a door that announces without caching its response marks the cached view stale (revD#1)", () => {
    const helper = src.slice(src.indexOf("function notePivotOutputChanged("), src.indexOf("\n}\n", src.indexOf("function notePivotOutputChanged(")));
    expect(helper).toContain("markCachedPivotViewStale(pivotId)");
    expect(helper).toContain("announcePivotOutputChanged(pivotId);");
    // The only bare announcements are the two helpers' own.
    const bare = src.split("\n").filter((l) => /\bannouncePivotOutputChanged\(/.test(l) && !/^\s*(\/\/|\*|import)/.test(l));
    expect(bare.map((l) => l.trim())).toEqual(["announcePivotOutputChanged(pivotId);", "announcePivotOutputChanged(pivotId);"]);
  });
});
