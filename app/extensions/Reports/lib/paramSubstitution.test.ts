//! FILENAME: app/extensions/Reports/lib/paramSubstitution.test.ts
import { describe, it, expect } from "vitest";
import type { ControlValue } from "@api/controlValues";
import { substituteControlParams, hasControlParams } from "./paramSubstitution";

function resolver(map: Record<string, ControlValue | undefined>) {
  return (name: string) => map[name];
}

describe("substituteControlParams", () => {
  it("substitutes a text control into a single-value filter", () => {
    const out = substituteControlParams("FILTERS: dim_product.style = @Style", resolver({ Style: { kind: "text", value: "W" } }));
    expect(out).toBe('FILTERS: dim_product.style = ("W")');
  });

  it("substitutes a textList control into a value list", () => {
    const out = substituteControlParams("FILTERS: x = @Sel", resolver({ Sel: { kind: "textList", value: ["A", "B"] } }));
    expect(out).toBe('FILTERS: x = ("A", "B")');
  });

  it("formats numbers and booleans", () => {
    expect(substituteControlParams("FILTERS: n = @N", resolver({ N: { kind: "number", value: 5 } }))).toBe('FILTERS: n = ("5")');
    expect(substituteControlParams("FILTERS: b = @B", resolver({ B: { kind: "boolean", value: true } }))).toBe('FILTERS: b = ("TRUE")');
  });

  it("drops a FILTERS line when the control is unset (show all)", () => {
    const dsl = "ROWS: a\nFILTERS: x = @Missing\nVALUES: [M]";
    expect(substituteControlParams(dsl, resolver({}))).toBe("ROWS: a\nVALUES: [M]");
  });

  it("drops a FILTERS line for an empty textList or (All)", () => {
    expect(substituteControlParams("FILTERS: x = @S", resolver({ S: { kind: "textList", value: [] } }))).toBe("");
    expect(substituteControlParams("FILTERS: x = @S", resolver({ S: { kind: "text", value: "(All)" } }))).toBe("");
  });

  it("leaves lines without params unchanged", () => {
    const dsl = "ROWS: a\nVALUES: [M]";
    expect(substituteControlParams(dsl, resolver({}))).toBe(dsl);
  });

  it("hasControlParams detects @tokens", () => {
    expect(hasControlParams("FILTERS: x = @A")).toBe(true);
    expect(hasControlParams("ROWS: a")).toBe(false);
  });
});
