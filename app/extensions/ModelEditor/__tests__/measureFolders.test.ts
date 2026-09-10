// FILENAME: app/extensions/ModelEditor/__tests__/measureFolders.test.ts
// PURPOSE: `buildFolderTree` must place every measure it is given exactly once.
// CONTEXT: THE INVARIANT IS CONSERVATION, NOT SHAPE. This helper is what turns
//          a flat list of measures into the Measures tab's folder tree and now
//          also Strategy's measures grid — and in Strategy a measure row
//          carries a confirmation decision and a `data-strategy-path` hook,
//          while the header count ("N of M unconfirmed") is computed from the
//          model independently. So a measure the tree quietly drops is not a
//          cosmetic loss: it is a row that vanishes while the counter above it
//          still counts it, and a decision that can never be made.
//
//          It DID drop them. `ungrouped` was `measures.filter((m) => !m.group)`
//          — a truthiness test — so a group of "\" or " " counted as grouped.
//          But `splitFolderPath` trims and drops blank segments, so no folder
//          was ever created for it, and the placement loop looked up the empty
//          path, found nothing, and pushed the measure nowhere. Neither bucket.
//
//          The tests therefore assert the CONSERVATION LAW over every input,
//          rather than checking the two spellings that happen to be known
//          today. A future separator change that reintroduces the hole fails
//          here even if nobody thinks to add a case for it.

import { describe, expect, it } from "vitest";
import type { ModelMeasureInfo } from "@api";
import { buildFolderTree, folderDepth, normalizeFolderPath } from "../lib/measureFolders";
import type { FolderNode } from "../lib/measureFolders";

function m(name: string, group: string | null): ModelMeasureInfo {
  return { name, group } as ModelMeasureInfo;
}

/** Every measure the tree holds, folders and ungrouped alike. */
function placed(roots: FolderNode[], ungrouped: ModelMeasureInfo[]): string[] {
  const out = ungrouped.map((x) => x.name);
  const walk = (n: FolderNode): void => {
    out.push(...n.measures.map((x) => x.name));
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

describe("buildFolderTree conserves measures", () => {
  // Every spelling of a group that has ever been observed or is one keystroke
  // away, including the two that used to fall through the floor.
  const GROUPS: Array<string | null> = [
    null,
    "",
    " ",
    "\\",
    "\\\\",
    " \\ ",
    "Sales",
    " Sales ",
    "Sales\\KPIs",
    "Sales\\KPIs\\Margins",
    "Sales\\",
    "\\Sales",
    "Sales\\\\KPIs",
  ];

  it("places every measure exactly once, whatever its group is spelled like", () => {
    const measures = GROUPS.map((g, i) => m(`M${i}`, g));
    const { roots, ungrouped } = buildFolderTree(measures, []);
    const got = placed(roots, ungrouped).sort();
    expect(got).toEqual(measures.map((x) => x.name).sort());
    // ...and exactly once: a measure in two folders would satisfy the set
    // comparison above while rendering two rows with the same
    // `data-strategy-path`, which is its own defect.
    expect(new Set(got).size).toBe(got.length);
  });

  it("treats a group that normalises to nothing as UNGROUPED, not as a lost row", () => {
    // The specific regression. Each of these is non-empty (so the old
    // truthiness test called it grouped) and yields no path segments (so no
    // folder was ever created to hold it).
    for (const g of [" ", "\\", "\\\\", " \\ "]) {
      const { roots, ungrouped } = buildFolderTree([m("Orphaned", g)], []);
      expect(normalizeFolderPath(g), `"${g}" should normalise to nothing`).toBe("");
      expect(ungrouped.map((x) => x.name), `group ${JSON.stringify(g)}`).toEqual(["Orphaned"]);
      expect(placed(roots, ungrouped)).toEqual(["Orphaned"]);
    }
  });

  it("still nests, so the conservation test is not passing over a flattened tree", () => {
    // Guards the guard: conservation alone is satisfied by a helper that gave
    // up on folders entirely and returned everything as ungrouped.
    const { roots, ungrouped } = buildFolderTree(
      [m("A", "Sales"), m("B", "Sales\\KPIs"), m("C", "Sales\\KPIs\\Margins"), m("D", null)],
      [],
    );
    expect(ungrouped.map((x) => x.name)).toEqual(["D"]);
    expect(roots).toHaveLength(1);
    expect(roots[0].path).toBe("Sales");
    expect(roots[0].measures.map((x) => x.name)).toEqual(["A"]);
    expect(roots[0].children[0].path).toBe("Sales\\KPIs");
    expect(roots[0].children[0].children[0].path).toBe("Sales\\KPIs\\Margins");
    expect(folderDepth("Sales\\KPIs\\Margins")).toBe(2);
  });

  it("materialises an intermediate folder nobody put a measure in", () => {
    // "Sales" exists only as an ancestor here. A tree that skipped it would
    // render "KPIs" at the root and lose where it belongs.
    const { roots } = buildFolderTree([m("A", "Sales\\KPIs")], []);
    expect(roots.map((r) => r.path)).toEqual(["Sales"]);
    expect(roots[0].measures).toEqual([]);
    expect(roots[0].children.map((c) => c.path)).toEqual(["Sales\\KPIs"]);
  });
});
