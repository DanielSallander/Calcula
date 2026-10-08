//! FILENAME: app/extensions/Charts/lib/__tests__/tileCues.test.ts
// PURPOSE: The Insights cue host respects ChartMarkMeta.furniture (contract
//          4.2): a title-only tile (Card, KPI, ...) shows no insight cues. A
//          ring is drawn around a DATUM'S BAR or POINT; a card has no such
//          shape, so a ring would be painted on the hit rect of the whole card
//          and read as a claim about a value that is not there.

import { describe, it, expect } from "vitest";
import { cuesShownOn } from "../tileCues";
import "../../rendering/chartDispatch";

const CUES = [{ cueId: "f#0" }, { cueId: "f#1" }];

describe("cuesShownOn", () => {
  it("a full-furniture chart shows its cues", () => {
    expect(cuesShownOn("bar", CUES)).toBe(CUES);
    expect(cuesShownOn("pie", CUES)).toBe(CUES);
  });

  it("a title-only tile shows none", () => {
    for (const mark of ["card", "multiRowCard", "kpi", "gauge"]) {
      expect(cuesShownOn(mark, CUES), mark).toEqual([]);
    }
  });

  it("an unknown mark keeps its cues (a mark we cannot see is not refused)", () => {
    expect(cuesShownOn("some.custom.mark", CUES)).toBe(CUES);
  });
});
