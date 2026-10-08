//! FILENAME: app/extensions/Charts/components/__tests__/chartTypeNames.test.ts
// PURPOSE: ONE name per chart type. There were three lists — the band's
//          catalog (components/chartTypeCatalog.ts), the dialog's picker
//          (tabs/DesignTab.tsx) and the renderer's registry labels
//          (rendering/chartDispatch.ts) — and they disagreed on the trap that
//          matters most: our "bar" mark draws VERTICAL bars, which Excel and
//          Power BI call a COLUMN chart, and the dialog called it "Bar Chart"
//          while the band called it "Column". The dialog now reads the
//          catalog; this file holds the registry to it, both directions.

import { describe, it, expect } from "vitest";
import { CHART_TYPES } from "../chartTypeCatalog";
import { getChartMark, listChartMarks } from "../../rendering/markRegistry";
import "../../rendering/chartDispatch";

const BUILTINS = listChartMarks().filter((m) => getChartMark(m)?.meta.builtin === true);

describe("chart type names", () => {
  it("every built-in mark is in the catalog, and every catalog entry is a built-in mark", () => {
    expect([...BUILTINS].sort()).toEqual(CHART_TYPES.map((t) => t.value as string).sort());
  });

  it("the registry's label for each mark IS the catalog's", () => {
    for (const t of CHART_TYPES) {
      expect(getChartMark(t.value)?.meta.label, t.value).toBe(t.label);
    }
  });

  it("the Column/Bar trap: 'bar' is Column, 'horizontalBar' is Bar", () => {
    expect(getChartMark("bar")?.meta.label).toBe("Column");
    expect(getChartMark("horizontalBar")?.meta.label).toBe("Bar");
  });
});
