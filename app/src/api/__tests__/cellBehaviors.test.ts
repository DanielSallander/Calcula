//! FILENAME: app/src/api/__tests__/cellBehaviors.test.ts
// PURPOSE: Unit tests for the cell-behavior binding index: spatial lookup
//          (single-cell fast path + range bbox scan), sheet separation, and
//          listing. Dispatch/forwarding is covered end-to-end in
//          app/e2e/tests/cell-behaviors.spec.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => []),
}));

import {
  getCellBehaviorAt,
  getCellBehaviorById,
  listCellBehaviors,
  hasCellBehaviors,
  __resetCellBehaviorsForTests,
  __seedCellBehaviorForTests,
  type CellBehaviorBinding,
} from "../cellBehaviors";

function binding(
  id: string,
  sheetIndex: number,
  startRow: number,
  startCol: number,
  endRow = startRow,
  endCol = startCol,
  overrides: Partial<CellBehaviorBinding> = {}
): CellBehaviorBinding {
  return {
    id,
    scriptId: `script-${id}`,
    sheetIndex,
    startRow,
    startCol,
    endRow,
    endCol,
    claimClick: true,
    enabled: true,
    orphaned: false,
    ...overrides,
  };
}

beforeEach(() => {
  __resetCellBehaviorsForTests();
});

describe("cellBehaviors index", () => {
  it("resolves single-cell targets via the fast path", () => {
    __seedCellBehaviorForTests(binding("a", 0, 5, 2));
    expect(getCellBehaviorAt(5, 2, 0)?.id).toBe("a");
    expect(getCellBehaviorAt(5, 3, 0)).toBeNull();
    expect(getCellBehaviorAt(2, 5, 0)).toBeNull();
  });

  it("resolves range targets via bbox scan", () => {
    __seedCellBehaviorForTests(binding("r", 0, 2, 1, 4, 3));
    expect(getCellBehaviorAt(2, 1, 0)?.id).toBe("r");
    expect(getCellBehaviorAt(4, 3, 0)?.id).toBe("r");
    expect(getCellBehaviorAt(3, 2, 0)?.id).toBe("r");
    expect(getCellBehaviorAt(5, 2, 0)).toBeNull();
    expect(getCellBehaviorAt(3, 4, 0)).toBeNull();
  });

  it("keeps sheets separate", () => {
    __seedCellBehaviorForTests(binding("s1", 1, 0, 0));
    expect(getCellBehaviorAt(0, 0, 1)?.id).toBe("s1");
    expect(getCellBehaviorAt(0, 0, 0)).toBeNull();
    // hasCellBehaviors reflects the ACTIVE sheet (0 by default in tests).
    expect(hasCellBehaviors()).toBe(false);
  });

  it("lists bindings sorted by id and resolves by id", () => {
    __seedCellBehaviorForTests(binding("b", 0, 0, 0));
    __seedCellBehaviorForTests(binding("a", 0, 1, 1));
    expect(listCellBehaviors().map((b) => b.id)).toEqual(["a", "b"]);
    expect(getCellBehaviorById("b")?.startRow).toBe(0);
    expect(getCellBehaviorById("zz")).toBeNull();
  });

  it("preserves binding metadata through the index", () => {
    __seedCellBehaviorForTests(binding("m", 0, 3, 3, 3, 3, { claimClick: false, orphaned: true }));
    const b = getCellBehaviorAt(3, 3, 0);
    expect(b?.claimClick).toBe(false);
    expect(b?.orphaned).toBe(true);
  });
});
