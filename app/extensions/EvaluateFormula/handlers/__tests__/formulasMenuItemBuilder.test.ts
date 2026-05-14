//! FILENAME: app/extensions/EvaluateFormula/handlers/__tests__/formulasMenuItemBuilder.test.ts
// PURPOSE: Tests for the Evaluate Formula menu item builder.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@api", () => ({
  registerMenuItem: vi.fn(),
  DialogExtensions: {
    openDialog: vi.fn(),
  },
  IconEvaluateFormula: "eval-icon",
  IconVisualizeFormula: "viz-icon",
}));

import { registerMenuItem, DialogExtensions } from "@api";
import {
  registerEvaluateFormulaMenuItem,
  setCurrentSelection,
} from "../formulasMenuItemBuilder";

const mockRegister = registerMenuItem as ReturnType<typeof vi.fn>;
const mockOpenDialog = DialogExtensions.openDialog as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  setCurrentSelection(null);
});

// ============================================================================
// registerEvaluateFormulaMenuItem
// ============================================================================

describe("registerEvaluateFormulaMenuItem", () => {
  it("registers a separator and an evaluate formula item", () => {
    registerEvaluateFormulaMenuItem();

    expect(mockRegister).toHaveBeenCalledTimes(2);

    // First call: separator
    const sepCall = mockRegister.mock.calls[0];
    expect(sepCall[0]).toBe("formulas");
    expect(sepCall[1].separator).toBe(true);

    // Second call: the menu item
    const itemCall = mockRegister.mock.calls[1];
    expect(itemCall[0]).toBe("formulas");
    expect(itemCall[1].id).toBe("formulas:evalFormula");
    expect(itemCall[1].label).toBe("Evaluate Formula...");
  });

  it("menu item action opens evaluate-formula dialog with current selection", () => {
    setCurrentSelection({ activeRow: 5, activeCol: 10 });
    registerEvaluateFormulaMenuItem();

    const itemDef = mockRegister.mock.calls[1][1];
    itemDef.action();

    expect(mockOpenDialog).toHaveBeenCalledWith("evaluate-formula", {
      activeRow: 5,
      activeCol: 10,
    });
  });

  it("menu item action defaults to row=0, col=0 when no selection", () => {
    registerEvaluateFormulaMenuItem();

    const itemDef = mockRegister.mock.calls[1][1];
    itemDef.action();

    expect(mockOpenDialog).toHaveBeenCalledWith("evaluate-formula", {
      activeRow: 0,
      activeCol: 0,
    });
  });

  it("registers a Visualize Formula child item", () => {
    registerEvaluateFormulaMenuItem();

    const itemDef = mockRegister.mock.calls[1][1];
    expect(itemDef.children).toHaveLength(1);
    expect(itemDef.children[0].id).toBe("formulas:formulaVisualizer");
    expect(itemDef.children[0].label).toBe("Visualize Formula...");
  });

  it("child action opens formula-visualizer dialog", () => {
    setCurrentSelection({ activeRow: 2, activeCol: 3 });
    registerEvaluateFormulaMenuItem();

    const childDef = mockRegister.mock.calls[1][1].children[0];
    childDef.action();

    expect(mockOpenDialog).toHaveBeenCalledWith("formula-visualizer", {
      activeRow: 2,
      activeCol: 3,
    });
  });
});
