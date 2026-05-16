//! FILENAME: app/extensions/Pivot/lib/pivot-stress.test.ts
// PURPOSE: Stress tests for pivot view store, DSL pipeline, named configs, and cache windowing.
// CONTEXT: Verifies correct behavior under extreme load: many caches, rapid operations,
//          large DSL inputs, and high-volume config storage.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  cachePivotView,
  getCachedPivotView,
  setCachedPivotView,
  deleteCachedPivotView,
  startOperation,
  isCurrentOperation,
  setInflightOperation,
  getInflightOperation,
  markUserCancelled,
  isUserCancelled,
  clearUserCancelled,
  preserveCurrentView,
  restorePreviousView,
  clearPreviousView,
  setLoading,
  clearLoading,
  isLoading,
  getLoadingState,
  isCacheFresh,
  consumeFreshFlag,
  getCellWindowCache,
  ensureCellWindow,
} from "./pivotViewStore";
import {
  saveNamedConfig,
  loadNamedConfigs,
  deleteNamedConfig,
  getNamedConfig,
  extractReferencedFields,
  validateLayoutCompatibility,
} from "./namedConfigs";
import { lex, parse, compile, processDsl } from "../dsl";
import type { CompileContext } from "../dsl";
import type { PivotViewResponse } from "./pivot-api";

// ============================================================================
// Helpers
// ============================================================================

function makeView(version: number, rowCount = 1, windowed = false): PivotViewResponse {
  return {
    version,
    rows: Array.from({ length: rowCount }, (_, i) => ({
      depth: 0,
      label: `Row-${i}`,
      cells: [`${version}-${i}`],
      isExpanded: false,
      isGrandTotal: false,
    })),
    columnHeaders: [["Col"]],
    rowFieldCount: 1,
    totalRowCount: rowCount,
    isWindowed: windowed,
  } as PivotViewResponse;
}

const BASE_ID = 50000;

function cleanupIds(count: number, startId = BASE_ID): void {
  for (let i = 0; i < count; i++) {
    deleteCachedPivotView(startId + i);
    clearUserCancelled(startId + i);
    clearLoading(startId + i);
    clearPreviousView(startId + i);
  }
}

function makeCompileContext(fieldCount: number): CompileContext {
  const sourceFields = [];
  for (let i = 0; i < fieldCount; i++) {
    sourceFields.push({
      name: `Field${i}`,
      index: i,
      isNumeric: i >= fieldCount / 2,
    });
  }
  return { sourceFields };
}

// ============================================================================
// 1. 100 simultaneous pivot caches
// ============================================================================

describe("stress: 100 simultaneous pivot caches", () => {
  const COUNT = 100;

  beforeEach(() => cleanupIds(COUNT));

  it("creates and retrieves 100 independent caches", () => {
    for (let i = 0; i < COUNT; i++) {
      cachePivotView(BASE_ID + i, makeView(i, 5));
    }

    for (let i = 0; i < COUNT; i++) {
      const cached = getCachedPivotView(BASE_ID + i);
      expect(cached).toBeDefined();
      expect(cached!.version).toBe(i);
      expect(cached!.rows).toHaveLength(5);
    }
  });

  it("each cache is independently fresh-flagged", () => {
    for (let i = 0; i < COUNT; i++) {
      cachePivotView(BASE_ID + i, makeView(i));
    }

    // Consume half
    for (let i = 0; i < COUNT / 2; i++) {
      consumeFreshFlag(BASE_ID + i);
    }

    for (let i = 0; i < COUNT; i++) {
      if (i < COUNT / 2) {
        expect(isCacheFresh(BASE_ID + i)).toBe(false);
      } else {
        expect(isCacheFresh(BASE_ID + i)).toBe(true);
      }
    }
  });

  it("loading states are independent across 100 pivots", () => {
    for (let i = 0; i < COUNT; i++) {
      setLoading(BASE_ID + i, `Stage-${i}`, i % 4, 4);
    }

    for (let i = 0; i < COUNT; i++) {
      expect(isLoading(BASE_ID + i)).toBe(true);
      const state = getLoadingState(BASE_ID + i);
      expect(state!.stage).toBe(`Stage-${i}`);
      expect(state!.stageIndex).toBe(i % 4);
    }

    // Clear all
    for (let i = 0; i < COUNT; i++) {
      clearLoading(BASE_ID + i);
    }
    for (let i = 0; i < COUNT; i++) {
      expect(isLoading(BASE_ID + i)).toBe(false);
    }
  });
});

// ============================================================================
// 2. Rapid cache update/delete cycles (1000 operations)
// ============================================================================

describe("stress: 1000 rapid cache update/delete cycles", () => {
  const PID = BASE_ID + 500;

  beforeEach(() => {
    deleteCachedPivotView(PID);
    clearLoading(PID);
    clearUserCancelled(PID);
  });

  it("1000 alternating cache/set/delete converges correctly", () => {
    for (let i = 0; i < 1000; i++) {
      if (i % 3 === 0) {
        cachePivotView(PID, makeView(i));
      } else if (i % 3 === 1) {
        setCachedPivotView(PID, makeView(i));
      } else {
        deleteCachedPivotView(PID);
      }
    }
    // 999 % 3 === 0, so last op was cachePivotView(999)
    const cached = getCachedPivotView(PID);
    expect(cached).toBeDefined();
    expect(cached!.version).toBe(999);
  });

  it("1000 preserve/restore cycles do not leak", () => {
    cachePivotView(PID, makeView(0));
    for (let i = 1; i <= 1000; i++) {
      preserveCurrentView(PID);
      cachePivotView(PID, makeView(i));
      if (i % 2 === 0) {
        restorePreviousView(PID);
      } else {
        clearPreviousView(PID);
      }
    }
    // After 1000 iterations the cache has some valid state
    const cached = getCachedPivotView(PID);
    expect(cached).toBeDefined();
  });

  it("1000 loading set/clear cycles are clean", () => {
    for (let i = 0; i < 1000; i++) {
      setLoading(PID, `op-${i}`, i % 4, 4);
      if (i % 5 === 0) clearLoading(PID);
    }
    // Last iteration: i=999, 999 % 5 !== 0, so loading is still set
    expect(isLoading(PID)).toBe(true);
    clearLoading(PID);
    expect(isLoading(PID)).toBe(false);
  });
});

// ============================================================================
// 3. Very large DSL (10K+ characters) through full pipeline
// ============================================================================

describe("stress: very large DSL through full pipeline", () => {
  it("lexes and parses a 10K+ character DSL without error", () => {
    // Build a large DSL with many row fields using longer names to exceed 10K chars
    const fields: string[] = [];
    for (let i = 0; i < 500; i++) {
      fields.push(`LongFieldName_Category${i}`);
    }
    const dsl = `ROWS: ${fields.join(", ")}\nVALUES: ${fields.slice(0, 50).map(f => `Sum(${f})`).join(", ")}\nLAYOUT: tabular`;
    expect(dsl.length).toBeGreaterThan(10_000);

    const { tokens, errors: lexErrors } = lex(dsl);
    expect(lexErrors).toHaveLength(0);
    expect(tokens.length).toBeGreaterThan(200);

    const { ast, errors: parseErrors } = parse(tokens);
    expect(parseErrors).toHaveLength(0);
    expect(ast.rows.length).toBe(500);
    expect(ast.values.length).toBe(50);
  });

  it("compiles a large DSL with 200 fields in context", () => {
    const fields: string[] = [];
    for (let i = 0; i < 200; i++) {
      fields.push(`Field${i}`);
    }
    const dsl = `ROWS: ${fields.slice(0, 100).join(", ")}\nVALUES: ${fields.slice(100, 150).map(f => `Sum(${f})`).join(", ")}`;
    const ctx = makeCompileContext(200);

    const result = processDsl(dsl, ctx);
    expect(result.rows).toHaveLength(100);
    expect(result.values).toHaveLength(50);
  });
});

// ============================================================================
// 4. 200 field names in compile context
// ============================================================================

describe("stress: 200 field names in compile context", () => {
  it("resolves all 200 fields correctly", () => {
    const ctx = makeCompileContext(200);
    const rowFields = [];
    for (let i = 0; i < 200; i++) {
      rowFields.push(`Field${i}`);
    }
    const dsl = `ROWS: ${rowFields.join(", ")}`;
    const result = processDsl(dsl, ctx);
    expect(result.rows).toHaveLength(200);
    // Verify first and last
    expect(result.rows[0].name).toBe("Field0");
    expect(result.rows[199].name).toBe("Field199");
  });

  it("validates compatibility against 200 source fields", () => {
    const sourceFields = [];
    for (let i = 0; i < 200; i++) {
      sourceFields.push({ name: `Field${i}`, index: i, isNumeric: false });
    }
    const dsl = `ROWS: Field0, Field99, Field199\nVALUES: Sum(Field50)`;
    const result = validateLayoutCompatibility(dsl, sourceFields);
    expect(result.missingFields).toHaveLength(0);
    expect(result.compatible).toBe(true);
  });

  it("detects missing fields in a large context", () => {
    const sourceFields = [];
    for (let i = 0; i < 100; i++) {
      sourceFields.push({ name: `Field${i}`, index: i, isNumeric: false });
    }
    // Reference Field150 which is not in the source
    const dsl = `ROWS: Field0, Field150`;
    const result = validateLayoutCompatibility(dsl, sourceFields);
    expect(result.compatible).toBe(false);
    expect(result.missingFields).toContain("Field150");
  });
});

// ============================================================================
// 5. Operation queue with 50 rapid startOperation calls
// ============================================================================

describe("stress: 50 rapid startOperation calls", () => {
  const PID = BASE_ID + 600;

  beforeEach(() => cleanupIds(1, PID));

  it("each startOperation returns a strictly increasing sequence", () => {
    const seqs: number[] = [];
    for (let i = 0; i < 50; i++) {
      seqs.push(startOperation(PID));
    }
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it("only the last of 50 operations is current", () => {
    const seqs: number[] = [];
    for (let i = 0; i < 50; i++) {
      seqs.push(startOperation(PID));
    }
    for (let i = 0; i < 49; i++) {
      expect(isCurrentOperation(PID, seqs[i])).toBe(false);
    }
    expect(isCurrentOperation(PID, seqs[49])).toBe(true);
  });

  it("50 setInflightOperation calls with resolved promises", async () => {
    for (let i = 0; i < 50; i++) {
      const p = Promise.resolve(i);
      setInflightOperation(PID, p);
    }
    // Wait for microtask queue
    await new Promise(r => setTimeout(r, 10));
    // After all promises resolved, inflight should be cleared
    expect(getInflightOperation(PID)).toBeUndefined();
  });

  it("user cancellation flags are independent per pivot across 50 pivots", () => {
    for (let i = 0; i < 50; i++) {
      markUserCancelled(BASE_ID + i);
    }
    for (let i = 0; i < 50; i++) {
      expect(isUserCancelled(BASE_ID + i)).toBe(true);
    }
    // Clear odd ones
    for (let i = 1; i < 50; i += 2) {
      clearUserCancelled(BASE_ID + i);
    }
    for (let i = 0; i < 50; i++) {
      expect(isUserCancelled(BASE_ID + i)).toBe(i % 2 === 0);
    }
    // Cleanup
    for (let i = 0; i < 50; i++) clearUserCancelled(BASE_ID + i);
  });
});

// ============================================================================
// 6. Memory: create/delete 500 caches, verify cleanup
// ============================================================================

describe("stress: create/delete 500 caches for cleanup", () => {
  const COUNT = 500;

  it("all 500 caches are properly deleted", () => {
    for (let i = 0; i < COUNT; i++) {
      cachePivotView(BASE_ID + i, makeView(i, 3));
      setLoading(BASE_ID + i, "loading");
      markUserCancelled(BASE_ID + i);
      preserveCurrentView(BASE_ID + i);
    }

    // Verify all exist
    for (let i = 0; i < COUNT; i++) {
      expect(getCachedPivotView(BASE_ID + i)).toBeDefined();
      expect(isLoading(BASE_ID + i)).toBe(true);
      expect(isUserCancelled(BASE_ID + i)).toBe(true);
    }

    // Delete all
    for (let i = 0; i < COUNT; i++) {
      deleteCachedPivotView(BASE_ID + i);
      clearLoading(BASE_ID + i);
      clearUserCancelled(BASE_ID + i);
    }

    // Verify all gone
    for (let i = 0; i < COUNT; i++) {
      expect(getCachedPivotView(BASE_ID + i)).toBeUndefined();
      expect(isLoading(BASE_ID + i)).toBe(false);
      expect(isUserCancelled(BASE_ID + i)).toBe(false);
    }
  });

  it("create-delete-create cycle for 500 IDs does not leave ghosts", () => {
    // Create with version=0
    for (let i = 0; i < COUNT; i++) {
      cachePivotView(BASE_ID + i, makeView(0));
    }
    // Delete all
    for (let i = 0; i < COUNT; i++) {
      deleteCachedPivotView(BASE_ID + i);
    }
    // Re-create with version=1
    for (let i = 0; i < COUNT; i++) {
      cachePivotView(BASE_ID + i, makeView(1));
    }
    // Verify all are version=1 (no ghost version=0)
    for (let i = 0; i < COUNT; i++) {
      expect(getCachedPivotView(BASE_ID + i)!.version).toBe(1);
    }
    // Cleanup
    cleanupIds(COUNT);
  });
});

// ============================================================================
// 7. Named config storage with 100 configs
// ============================================================================

describe("stress: named config storage with 100 configs", () => {
  const store: Record<string, string> = {};

  beforeEach(() => {
    // Mock localStorage for Node/Vitest environment
    for (const key of Object.keys(store)) delete store[key];
    globalThis.localStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { for (const k of Object.keys(store)) delete store[k]; },
      get length() { return Object.keys(store).length; },
      key: (i: number) => Object.keys(store)[i] ?? null,
    } as Storage;
  });

  it("saves and retrieves 100 named configs", () => {
    for (let i = 0; i < 100; i++) {
      saveNamedConfig({
        name: `StressConfig${i}`,
        dslText: `ROWS: Field${i}\nVALUES: Value${i}.sum`,
        description: `Config number ${i}`,
      });
    }

    const all = loadNamedConfigs();
    const stressConfigs = all.filter(c => c.name.startsWith("StressConfig"));
    expect(stressConfigs.length).toBe(100);

    for (let i = 0; i < 100; i++) {
      const config = getNamedConfig(`StressConfig${i}`);
      expect(config).toBeDefined();
      expect(config!.dslText).toContain(`Field${i}`);
    }
  });

  it("updates all 100 configs without duplication", () => {
    for (let i = 0; i < 100; i++) {
      saveNamedConfig({
        name: `StressConfig${i}`,
        dslText: `ROWS: OrigField${i}`,
      });
    }

    // Update all
    for (let i = 0; i < 100; i++) {
      saveNamedConfig({
        name: `StressConfig${i}`,
        dslText: `ROWS: UpdatedField${i}`,
      });
    }

    const all = loadNamedConfigs();
    const stressConfigs = all.filter(c => c.name.startsWith("StressConfig"));
    expect(stressConfigs.length).toBe(100);

    for (let i = 0; i < 100; i++) {
      const config = getNamedConfig(`StressConfig${i}`);
      expect(config!.dslText).toContain("UpdatedField");
    }
  });

  it("deletes all 100 configs cleanly", () => {
    for (let i = 0; i < 100; i++) {
      saveNamedConfig({
        name: `StressConfig${i}`,
        dslText: `ROWS: Field${i}`,
      });
    }

    for (let i = 0; i < 100; i++) {
      deleteNamedConfig(`StressConfig${i}`);
    }

    for (let i = 0; i < 100; i++) {
      expect(getNamedConfig(`StressConfig${i}`)).toBeUndefined();
    }
  });
});

// ============================================================================
// 8. Cache windowing with overlapping windows
// ============================================================================

describe("stress: cache windowing with overlapping windows", () => {
  const PID = BASE_ID + 700;

  beforeEach(() => {
    deleteCachedPivotView(PID);
  });

  it("seeds windowed cache and retrieves rows correctly", () => {
    const view = makeView(1, 100, true);
    (view as any).windowStartRow = 0;
    cachePivotView(PID, view);

    const cache = getCellWindowCache(PID);
    expect(cache).toBeDefined();
    // First 100 rows should be cached
    for (let i = 0; i < 100; i++) {
      expect(cache!.hasRow(i)).toBe(true);
    }
    expect(cache!.hasRow(100)).toBe(false);
  });

  it("handles overlapping window fetches via ensureCellWindow", () => {
    const view = makeView(1, 0, true);
    (view as any).windowStartRow = 0;
    cachePivotView(PID, view);

    const cache = getCellWindowCache(PID);
    expect(cache).toBeDefined();

    let fetchCount = 0;
    const mockFetch = async (_pid: number, startRow: number, rowCount: number) => {
      fetchCount++;
      const rows = Array.from({ length: rowCount }, (_, i) => ({
        depth: 0,
        label: `Row-${startRow + i}`,
        cells: [`cell-${startRow + i}`],
        isExpanded: false,
        isGrandTotal: false,
      }));
      return { version: 1, startRow, rows };
    };

    // Request overlapping ranges
    const loaded: number[] = [];
    ensureCellWindow(PID, 1, 0, 50, mockFetch, () => loaded.push(1));
    ensureCellWindow(PID, 1, 25, 50, mockFetch, () => loaded.push(2));
    // Both hit the same window boundary (0), second should not re-fetch
    expect(fetchCount).toBe(1);
  });

  it("invalidation clears all cached rows", () => {
    const view = makeView(1, 50, true);
    (view as any).windowStartRow = 0;
    cachePivotView(PID, view);

    const cache = getCellWindowCache(PID);
    expect(cache!.hasRow(0)).toBe(true);

    // Re-cache invalidates
    const view2 = makeView(2, 10, true);
    (view2 as any).windowStartRow = 0;
    cachePivotView(PID, view2);

    const cache2 = getCellWindowCache(PID);
    // Old rows beyond 10 should be gone since invalidate clears all
    expect(cache2!.hasRow(0)).toBe(true);
    expect(cache2!.hasRow(49)).toBe(false);
  });
});
