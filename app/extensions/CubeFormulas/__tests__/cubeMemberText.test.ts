//! FILENAME: app/extensions/CubeFormulas/__tests__/cubeMemberText.test.ts
// PURPOSE: The CUBE builder's member list SHOWS each member's app-locale label
//          and INSERTS its invariant KEY into the formula (P2 S7): a de-DE date
//          member shown as "15.01.2024" writes "2024-01-15", which is what the
//          CUBE routing matches; the blank member (key "", which a formula
//          cannot name) writes "(Blank)", the blank's own spelling the routing
//          reads back as the blank key.

import { describe, it, expect } from "vitest";
import { cubeMemberText } from "../components/CubeFormulaBuilderPanel";

describe("cubeMemberText: what a picked member inserts", () => {
  it("the KEY, never the label the list shows", () => {
    expect(cubeMemberText({ key: "2024-01-15", label: "15.01.2024" })).toBe("2024-01-15");
    expect(cubeMemberText({ key: "1234.5", label: "1234,5" })).toBe("1234.5");
    expect(cubeMemberText({ key: "East", label: "East" })).toBe("East");
  });

  it("the blank member inserts its (Blank) spelling", () => {
    expect(cubeMemberText({ key: "", label: "(Blank)" })).toBe("(Blank)");
  });
});
