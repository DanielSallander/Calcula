//! FILENAME: app/src/core/lib/__tests__/structuralDeleteCascadeAnnouncement.test.ts
// PURPOSE: BUG-0054, frontend half — a row/column delete can remove a pivot
//          outright in the backend (fully-covered region) and cascade the
//          slicers/ribbon-filter targets bound to it. Each of those stores is
//          cached by its own extension, so the route must ANNOUNCE, or a dead
//          slicer keeps painting and eating clicks (the §3bn wedge, one route
//          over from the ones cascadeAnnouncementCensus walks).
//
//          Source-scan by the same standard as that census: the claim is about
//          what the shipped route DOES, and a mocked invoke() cannot prove the
//          announcement survives an edit to the real file.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const src = fs.readFileSync(
  path.resolve(__dirname, "../tauri-api.ts"),
  "utf8"
);

function bodyOf(name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  expect(start, `${name} has moved or been renamed`).toBeGreaterThan(-1);
  // A function body ends where the next top-level declaration begins — good
  // enough for a route file that declares one export after another.
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\n(?:export |function )/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("structural deletes announce the pivot-death cascade (BUG-0054)", () => {
  for (const route of ["deleteRows", "deleteColumns"]) {
    it(`${route} reaches the cascade announcement on BOTH branches`, () => {
      const body = bodyOf(route);
      const calls = body.match(/announceStructuralDeleteCascade\(\)/g) ?? [];
      expect(
        calls.length,
        `${route} must announce after the active-sheet invoke AND after the ` +
          `off-sheet invoke — a script deleting rows on a non-active sheet ` +
          `kills a pivot there just as dead`
      ).toBeGreaterThanOrEqual(2);
    });
  }

  it("the announcement names the domains the backend cascade touches", () => {
    const start = src.indexOf("function announceStructuralDeleteCascade");
    expect(start, "the helper has moved or been renamed").toBeGreaterThan(-1);
    const body = src.slice(start, start + 600);
    for (const domain of ["slicer", "pivot", "ribbonFilter"]) {
      expect(
        body.includes(`"${domain}"`),
        `the cascade announcement must name "${domain}" — the backend's ` +
          `collect_doomed_pivots path deletes/rebinds objects in that store`
      ).toBe(true);
    }
    expect(body).toContain("MUTATION_REFRESH");
  });

  it("inserts do NOT announce it — an insert cannot kill a pivot", () => {
    for (const route of ["insertRows", "insertColumns"]) {
      const body = bodyOf(route);
      expect(
        body.includes("announceStructuralDeleteCascade"),
        `${route} must not pay the refresh for a cascade that cannot happen`
      ).toBe(false);
    }
  });
});
