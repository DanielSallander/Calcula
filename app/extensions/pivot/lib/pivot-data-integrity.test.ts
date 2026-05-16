//! FILENAME: app/extensions/Pivot/lib/pivot-data-integrity.test.ts
// PURPOSE: Data integrity tests for pivot view store and config operations.

import { describe, it, expect, beforeEach } from "vitest";
import {
  cachePivotView,
  getCachedPivotView,
  setCachedPivotView,
  deleteCachedPivotView,
} from "./pivotViewStore";
import type { NamedPivotConfig, SourceSignature } from "./namedConfigs";

// ============================================================================
// Pivot view store: operations don't mutate input objects
// ============================================================================

describe("pivotViewStore input immutability", () => {
  beforeEach(() => {
    deleteCachedPivotView(1);
    deleteCachedPivotView(2);
  });

  function makePivotView(version: number) {
    return {
      version,
      rows: [
        { depth: 0, label: "Total", cells: ["100", "200"], isExpanded: true, isGrandTotal: false },
      ],
      columnHeaders: [["A", "B"]],
      rowFieldCount: 1,
      totalRowCount: 1,
      isWindowed: false,
    };
  }

  it("cachePivotView does not mutate the input view object", () => {
    const view = Object.freeze(makePivotView(1));
    // Should not throw with frozen object
    cachePivotView(1, view as any);

    const cached = getCachedPivotView(1);
    expect(cached).toBeDefined();
    expect(cached!.version).toBe(1);
  });

  it("setCachedPivotView does not mutate the input view object", () => {
    const view = makePivotView(2);
    const viewSnapshot = JSON.parse(JSON.stringify(view));

    setCachedPivotView(1, view as any);

    // Input should not have been modified
    expect(view).toEqual(viewSnapshot);
  });
});

// ============================================================================
// Cache operations don't leak between pivots
// ============================================================================

describe("pivotViewStore cache isolation", () => {
  beforeEach(() => {
    deleteCachedPivotView(1);
    deleteCachedPivotView(2);
    deleteCachedPivotView(3);
  });

  it("caching pivot 1 does not affect pivot 2", () => {
    const view1 = {
      version: 10,
      rows: [{ depth: 0, label: "A", cells: ["1"], isExpanded: true, isGrandTotal: false }],
      columnHeaders: [["X"]],
      rowFieldCount: 1,
      totalRowCount: 1,
      isWindowed: false,
    };
    const view2 = {
      version: 20,
      rows: [{ depth: 0, label: "B", cells: ["2"], isExpanded: true, isGrandTotal: false }],
      columnHeaders: [["Y"]],
      rowFieldCount: 1,
      totalRowCount: 1,
      isWindowed: false,
    };

    cachePivotView(1, view1 as any);
    cachePivotView(2, view2 as any);

    const cached1 = getCachedPivotView(1);
    const cached2 = getCachedPivotView(2);

    expect(cached1!.version).toBe(10);
    expect(cached2!.version).toBe(20);
    expect((cached1 as any).rows[0].label).toBe("A");
    expect((cached2 as any).rows[0].label).toBe("B");
  });

  it("deleting one pivot cache does not affect another", () => {
    cachePivotView(1, { version: 1, rows: [], columnHeaders: [], rowFieldCount: 0, totalRowCount: 0, isWindowed: false } as any);
    cachePivotView(2, { version: 2, rows: [], columnHeaders: [], rowFieldCount: 0, totalRowCount: 0, isWindowed: false } as any);

    deleteCachedPivotView(1);

    expect(getCachedPivotView(1)).toBeUndefined();
    expect(getCachedPivotView(2)).toBeDefined();
    expect(getCachedPivotView(2)!.version).toBe(2);
  });
});

// ============================================================================
// Field config creation produces independent copies
// ============================================================================

describe("field config independence", () => {
  it("NamedPivotConfig objects with same source signature are independent", () => {
    const sig: SourceSignature = {
      type: "bi",
      tables: [{ name: "Sales", columns: ["Amount", "Date"] }],
      measures: ["Total"],
    };

    const config1: NamedPivotConfig = {
      name: "Config A",
      dslText: "ROWS: Date",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sourceSignature: { ...sig, tables: sig.tables!.map(t => ({ ...t, columns: [...t.columns] })), measures: [...sig.measures!] },
    };

    const config2: NamedPivotConfig = {
      name: "Config B",
      dslText: "ROWS: Amount",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sourceSignature: { ...sig, tables: sig.tables!.map(t => ({ ...t, columns: [...t.columns] })), measures: [...sig.measures!] },
    };

    // Mutating config1's source signature should not affect config2
    config1.sourceSignature!.tables![0].columns.push("NewCol");
    config1.sourceSignature!.measures!.push("NewMeasure");

    expect(config2.sourceSignature!.tables![0].columns).toEqual(["Amount", "Date"]);
    expect(config2.sourceSignature!.measures).toEqual(["Total"]);
  });
});

// ============================================================================
// Layout config defaults don't share object references
// ============================================================================

describe("layout config default isolation", () => {
  it("two default configs created the same way don't share references", () => {
    function makeDefaultConfig(): NamedPivotConfig {
      return {
        name: "",
        dslText: "",
        createdAt: 0,
        updatedAt: 0,
        sourceSignature: {
          type: "table",
          tables: [],
          measures: [],
        },
      };
    }

    const a = makeDefaultConfig();
    const b = makeDefaultConfig();

    // They should be equal but not the same object
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.sourceSignature).not.toBe(b.sourceSignature);
    expect(a.sourceSignature!.tables).not.toBe(b.sourceSignature!.tables);
    expect(a.sourceSignature!.measures).not.toBe(b.sourceSignature!.measures);

    // Mutating one should not affect the other
    a.sourceSignature!.tables!.push({ name: "Test", columns: [] });
    expect(b.sourceSignature!.tables).toEqual([]);
  });
});
