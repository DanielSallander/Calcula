import { describe, it, expect } from "vitest";
import { buildCubeFormula, type CubeFormulaSpec } from "./buildFormula";

const base: CubeFormulaSpec = { func: "CUBEVALUE", connection: "Sales" };

describe("buildCubeFormula", () => {
  it("builds CUBEVALUE with a measure and member filters", () => {
    const f = buildCubeFormula(
      {
        ...base,
        measure: "Revenue",
        members: [{ table: "Geo", column: "Country", value: "Sweden" }],
      },
      ",",
    );
    expect(f).toBe('=CUBEVALUE("Sales","[Revenue]","Geo[Country]=Sweden")');
  });

  it("uses the supplied locale separator", () => {
    const f = buildCubeFormula({ ...base, measure: "Revenue" }, ";");
    expect(f).toBe('=CUBEVALUE("Sales";"[Revenue]")');
  });

  it("single-quotes member values with spaces", () => {
    const f = buildCubeFormula(
      {
        ...base,
        func: "CUBEMEMBER",
        members: [{ table: "Geo", column: "City", value: "New York" }],
      },
      ",",
    );
    expect(f).toBe(`=CUBEMEMBER("Sales","Geo[City]='New York'")`);
  });

  it("builds CUBEMEMBER for a measure with a caption", () => {
    const f = buildCubeFormula(
      { ...base, func: "CUBEMEMBER", measure: "Revenue", caption: "Total" },
      ",",
    );
    expect(f).toBe('=CUBEMEMBER("Sales","[Revenue]","Total")');
  });

  it("builds CUBESET with caption + measure sort", () => {
    const f = buildCubeFormula(
      {
        ...base,
        func: "CUBESET",
        setTable: "Geo",
        setColumn: "Country",
        caption: "Top Countries",
        sortOrder: 2,
        sortBy: "Revenue",
      },
      ",",
    );
    expect(f).toBe('=CUBESET("Sales","Geo[Country]","Top Countries",2,"[Revenue]")');
  });

  it("builds CUBESETCOUNT with no connection arg", () => {
    expect(buildCubeFormula({ ...base, func: "CUBESETCOUNT", setRef: "D1" }, ",")).toBe(
      "=CUBESETCOUNT(D1)",
    );
  });

  it("builds CUBERANKEDMEMBER with a set ref + rank (unquoted)", () => {
    const f = buildCubeFormula(
      { ...base, func: "CUBERANKEDMEMBER", setRef: "D1", rank: 1 },
      ",",
    );
    expect(f).toBe('=CUBERANKEDMEMBER("Sales",D1,1)');
  });

  it("builds CUBEKPIMEMBER value/goal/status", () => {
    const f = buildCubeFormula(
      { ...base, func: "CUBEKPIMEMBER", kpiName: "Revenue KPI", kpiProperty: 3 },
      ",",
    );
    expect(f).toBe('=CUBEKPIMEMBER("Sales","Revenue KPI",3)');
  });

  it("builds CUBEMEMBERPROPERTY", () => {
    const f = buildCubeFormula(
      {
        ...base,
        func: "CUBEMEMBERPROPERTY",
        members: [{ table: "Geo", column: "Country", value: "Sweden" }],
        property: "Region",
      },
      ",",
    );
    expect(f).toBe('=CUBEMEMBERPROPERTY("Sales","Geo[Country]=Sweden","Region")');
  });

  it("returns empty string for an incomplete spec (no connection)", () => {
    expect(buildCubeFormula({ func: "CUBEVALUE", connection: "" }, ",")).toBe("");
    expect(buildCubeFormula({ func: "CUBEVALUE", connection: "Sales" }, ",")).toBe("");
  });
});
