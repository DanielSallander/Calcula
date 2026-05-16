//! FILENAME: app/extensions/Protection/lib/__tests__/protectionStore.deep.test.ts
// PURPOSE: Deep tests for protection store — permissions, multi-sheet, edit guard,
//          password vs no-password, workbook protection, cell-level attributes.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock @api before importing the store
vi.mock("@api", () => ({
  getProtectionStatus: vi.fn(),
  isWorkbookProtected: vi.fn(),
  canEditCell: vi.fn(),
  showDialog: vi.fn(),
  DEFAULT_PROTECTION_OPTIONS: {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: false,
    formatColumns: false,
    formatRows: false,
    insertColumns: false,
    insertRows: false,
    insertHyperlinks: false,
    deleteColumns: false,
    deleteRows: false,
    sort: false,
    useAutoFilter: false,
    usePivotTableReports: false,
    editObjects: false,
    editScenarios: false,
  },
}));

import {
  isCurrentSheetProtected,
  currentSheetHasPassword,
  getSheetOptions,
  isCurrentWorkbookProtected,
  setSheetProtectedState,
  setWorkbookProtectedState,
  resetProtectionState,
  refreshProtectionState,
} from "../../lib/protectionStore";
import {
  getProtectionStatus,
  isWorkbookProtected,
  canEditCell,
} from "@api";

// ============================================================================
// Inline edit guard logic (mirrors editGuardHandler.ts without dialog import)
// ============================================================================

interface EditGuardResult {
  blocked: boolean;
  message: string;
}

async function protectionEditGuard(
  row: number,
  col: number,
  isSheetProtected: () => boolean,
  canEditFn: (r: number, c: number) => Promise<{ canEdit: boolean; reason?: string }>,
): Promise<EditGuardResult | null> {
  if (!isSheetProtected()) return null;
  try {
    const result = await canEditFn(row, col);
    if (!result.canEdit) {
      return {
        blocked: true,
        message:
          result.reason ||
          "The cell or chart you are trying to change is on a protected sheet.",
      };
    }
  } catch {
    // fail-open
  }
  return null;
}

// ============================================================================
// Helpers
// ============================================================================

interface SheetProtectionOptions {
  selectLockedCells: boolean;
  selectUnlockedCells: boolean;
  formatCells: boolean;
  formatColumns: boolean;
  formatRows: boolean;
  insertColumns: boolean;
  insertRows: boolean;
  insertHyperlinks: boolean;
  deleteColumns: boolean;
  deleteRows: boolean;
  sort: boolean;
  useAutoFilter: boolean;
  usePivotTableReports: boolean;
  editObjects: boolean;
  editScenarios: boolean;
}

function makeOpts(overrides: Partial<SheetProtectionOptions> = {}): SheetProtectionOptions {
  return {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: false,
    formatColumns: false,
    formatRows: false,
    insertColumns: false,
    insertRows: false,
    insertHyperlinks: false,
    deleteColumns: false,
    deleteRows: false,
    sort: false,
    useAutoFilter: false,
    usePivotTableReports: false,
    editObjects: false,
    editScenarios: false,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("sheet protection with specific permissions", () => {
  beforeEach(() => {
    resetProtectionState();
    vi.clearAllMocks();
  });

  it("allows selectLockedCells when enabled", () => {
    setSheetProtectedState(true, false, makeOpts({ selectLockedCells: true }));
    expect(getSheetOptions().selectLockedCells).toBe(true);
  });

  it("disallows selectLockedCells when disabled", () => {
    setSheetProtectedState(true, false, makeOpts({ selectLockedCells: false }));
    expect(getSheetOptions().selectLockedCells).toBe(false);
  });

  it("allows formatCells when enabled", () => {
    setSheetProtectedState(true, true, makeOpts({ formatCells: true }));
    expect(getSheetOptions().formatCells).toBe(true);
  });

  it("allows insertRows when enabled", () => {
    setSheetProtectedState(true, false, makeOpts({ insertRows: true }));
    expect(getSheetOptions().insertRows).toBe(true);
  });

  it("allows deleteColumns when enabled", () => {
    setSheetProtectedState(true, false, makeOpts({ deleteColumns: true }));
    expect(getSheetOptions().deleteColumns).toBe(true);
  });

  it("allows sort when enabled", () => {
    setSheetProtectedState(true, false, makeOpts({ sort: true }));
    expect(getSheetOptions().sort).toBe(true);
  });

  it("allows useAutoFilter when enabled", () => {
    setSheetProtectedState(true, false, makeOpts({ useAutoFilter: true }));
    expect(getSheetOptions().useAutoFilter).toBe(true);
  });

  it("allows multiple permissions simultaneously", () => {
    setSheetProtectedState(
      true,
      true,
      makeOpts({ formatCells: true, sort: true, insertRows: true, deleteRows: true }),
    );
    const opts = getSheetOptions();
    expect(opts.formatCells).toBe(true);
    expect(opts.sort).toBe(true);
    expect(opts.insertRows).toBe(true);
    expect(opts.deleteRows).toBe(true);
    // Others remain false
    expect(opts.formatColumns).toBe(false);
    expect(opts.insertColumns).toBe(false);
  });

  it("editObjects and editScenarios default to false", () => {
    setSheetProtectedState(true, false, makeOpts());
    expect(getSheetOptions().editObjects).toBe(false);
    expect(getSheetOptions().editScenarios).toBe(false);
  });
});

describe("protection with password vs without", () => {
  beforeEach(() => {
    resetProtectionState();
  });

  it("protected without password", () => {
    setSheetProtectedState(true, false, makeOpts());
    expect(isCurrentSheetProtected()).toBe(true);
    expect(currentSheetHasPassword()).toBe(false);
  });

  it("protected with password", () => {
    setSheetProtectedState(true, true, makeOpts());
    expect(isCurrentSheetProtected()).toBe(true);
    expect(currentSheetHasPassword()).toBe(true);
  });

  it("unprotecting clears password flag", () => {
    setSheetProtectedState(true, true, makeOpts());
    setSheetProtectedState(false, false, makeOpts());
    expect(currentSheetHasPassword()).toBe(false);
  });
});

describe("workbook protection (structure)", () => {
  beforeEach(() => {
    resetProtectionState();
  });

  it("workbook protection is independent of sheet protection", () => {
    setSheetProtectedState(true, true, makeOpts());
    setWorkbookProtectedState(false);
    expect(isCurrentSheetProtected()).toBe(true);
    expect(isCurrentWorkbookProtected()).toBe(false);
  });

  it("both can be protected simultaneously", () => {
    setSheetProtectedState(true, false, makeOpts());
    setWorkbookProtectedState(true);
    expect(isCurrentSheetProtected()).toBe(true);
    expect(isCurrentWorkbookProtected()).toBe(true);
  });

  it("reset clears both", () => {
    setSheetProtectedState(true, true, makeOpts());
    setWorkbookProtectedState(true);
    resetProtectionState();
    expect(isCurrentSheetProtected()).toBe(false);
    expect(isCurrentWorkbookProtected()).toBe(false);
  });
});

describe("simulated multi-sheet protection", () => {
  beforeEach(() => {
    resetProtectionState();
  });

  // The store tracks one "current" sheet. Simulating sheet switching by
  // calling setSheetProtectedState with different states.

  it("switching to protected sheet updates state", () => {
    // Sheet 0: unprotected
    setSheetProtectedState(false, false, makeOpts());
    expect(isCurrentSheetProtected()).toBe(false);

    // Switch to Sheet 1: protected with restrictive options
    setSheetProtectedState(true, true, makeOpts({ formatCells: false, sort: false }));
    expect(isCurrentSheetProtected()).toBe(true);
    expect(getSheetOptions().formatCells).toBe(false);
  });

  it("switching back to unprotected sheet clears protection", () => {
    setSheetProtectedState(true, true, makeOpts({ sort: true }));
    expect(getSheetOptions().sort).toBe(true);

    // Switch to unprotected sheet
    setSheetProtectedState(false, false, makeOpts());
    expect(isCurrentSheetProtected()).toBe(false);
  });

  it("each switch fully replaces options", () => {
    setSheetProtectedState(true, false, makeOpts({ formatCells: true }));
    expect(getSheetOptions().formatCells).toBe(true);

    // Switch sheet: formatCells now false, sort now true
    setSheetProtectedState(true, false, makeOpts({ formatCells: false, sort: true }));
    expect(getSheetOptions().formatCells).toBe(false);
    expect(getSheetOptions().sort).toBe(true);
  });
});

describe("refreshProtectionState — advanced scenarios", () => {
  beforeEach(() => {
    resetProtectionState();
    vi.clearAllMocks();
  });

  it("updates all permission fields from backend", async () => {
    vi.mocked(getProtectionStatus).mockResolvedValue({
      isProtected: true,
      hasPassword: false,
      options: makeOpts({
        formatCells: true,
        formatColumns: true,
        formatRows: true,
        insertRows: true,
        deleteRows: true,
        sort: true,
      }),
    });
    vi.mocked(isWorkbookProtected).mockResolvedValue(false);

    await refreshProtectionState();

    const opts = getSheetOptions();
    expect(opts.formatCells).toBe(true);
    expect(opts.formatColumns).toBe(true);
    expect(opts.formatRows).toBe(true);
    expect(opts.insertRows).toBe(true);
    expect(opts.deleteRows).toBe(true);
    expect(opts.sort).toBe(true);
    expect(opts.insertColumns).toBe(false);
  });

  it("both APIs failing leaves state at defaults", async () => {
    vi.mocked(getProtectionStatus).mockRejectedValue(new Error("fail"));
    vi.mocked(isWorkbookProtected).mockRejectedValue(new Error("fail"));

    await refreshProtectionState();

    expect(isCurrentSheetProtected()).toBe(false);
    expect(isCurrentWorkbookProtected()).toBe(false);
  });

  it("successive refreshes update state correctly", async () => {
    // First: protected
    vi.mocked(getProtectionStatus).mockResolvedValue({
      isProtected: true,
      hasPassword: true,
      options: makeOpts({ sort: true }),
    });
    vi.mocked(isWorkbookProtected).mockResolvedValue(true);
    await refreshProtectionState();
    expect(isCurrentSheetProtected()).toBe(true);
    expect(getSheetOptions().sort).toBe(true);

    // Second: unprotected
    vi.mocked(getProtectionStatus).mockResolvedValue({
      isProtected: false,
      hasPassword: false,
      options: makeOpts(),
    });
    vi.mocked(isWorkbookProtected).mockResolvedValue(false);
    await refreshProtectionState();
    expect(isCurrentSheetProtected()).toBe(false);
    expect(getSheetOptions().sort).toBe(false);
  });
});

describe("edit guard interaction with protection", () => {
  it("allows editing when sheet is not protected", async () => {
    const result = await protectionEditGuard(
      0,
      0,
      () => false,
      async () => ({ canEdit: true }),
    );
    expect(result).toBeNull();
  });

  it("blocks editing locked cell on protected sheet", async () => {
    const result = await protectionEditGuard(
      5,
      3,
      () => true,
      async () => ({ canEdit: false, reason: "Cell is locked" }),
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
    expect(result!.message).toBe("Cell is locked");
  });

  it("allows editing unlocked cell on protected sheet", async () => {
    const result = await protectionEditGuard(
      5,
      3,
      () => true,
      async () => ({ canEdit: true }),
    );
    expect(result).toBeNull();
  });

  it("uses default message when reason is empty", async () => {
    const result = await protectionEditGuard(
      0,
      0,
      () => true,
      async () => ({ canEdit: false }),
    );
    expect(result!.blocked).toBe(true);
    expect(result!.message).toContain("protected sheet");
  });

  it("fail-open on canEditCell error", async () => {
    const result = await protectionEditGuard(
      0,
      0,
      () => true,
      async () => {
        throw new Error("backend down");
      },
    );
    expect(result).toBeNull();
  });
});

describe("cell-level lock/hidden attributes", () => {
  // These are conceptual tests for how locked/hidden flags interact with protection.
  // The actual cell attributes live in the backend; here we test the decision logic.

  interface CellProtectionAttrs {
    locked: boolean;
    hidden: boolean;
  }

  function canEdit(
    isSheetProtected: boolean,
    cell: CellProtectionAttrs,
  ): boolean {
    if (!isSheetProtected) return true;
    return !cell.locked;
  }

  function isFormulaVisible(
    isSheetProtected: boolean,
    cell: CellProtectionAttrs,
  ): boolean {
    if (!isSheetProtected) return true;
    return !cell.hidden;
  }

  it("locked cell is editable when sheet is unprotected", () => {
    expect(canEdit(false, { locked: true, hidden: false })).toBe(true);
  });

  it("locked cell is not editable when sheet is protected", () => {
    expect(canEdit(true, { locked: true, hidden: false })).toBe(false);
  });

  it("unlocked cell is editable even when sheet is protected", () => {
    expect(canEdit(true, { locked: false, hidden: false })).toBe(true);
  });

  it("hidden cell formula visible when sheet is unprotected", () => {
    expect(isFormulaVisible(false, { locked: true, hidden: true })).toBe(true);
  });

  it("hidden cell formula hidden when sheet is protected", () => {
    expect(isFormulaVisible(true, { locked: true, hidden: true })).toBe(false);
  });

  it("non-hidden cell formula always visible", () => {
    expect(isFormulaVisible(true, { locked: true, hidden: false })).toBe(true);
  });
});
