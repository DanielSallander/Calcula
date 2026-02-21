//! FILENAME: app/extensions/Tracing/handlers/formulasMenuBuilder.ts
// PURPOSE: Registers the "Formulas" top-level menu with trace commands.
// CONTEXT: Creates menu items for Trace Precedents, Trace Dependents, and Remove Arrows.

import { registerMenu } from "../../../src/api";
import type { MenuDefinition } from "../../../src/api";
import {
  addPrecedentLevel,
  addDependentLevel,
  removeAllArrows,
} from "../lib/tracingStore";

// ============================================================================
// Constants
// ============================================================================

const FORMULAS_MENU_ID = "formulas";
const FORMULAS_MENU_ORDER = 45; // After Data (~42), before Conditional Formatting (~50)

// ============================================================================
// Public API
// ============================================================================

/**
 * Register the "Formulas" menu in the menu bar.
 */
export function registerFormulasMenu(): void {
  const menu: MenuDefinition = {
    id: FORMULAS_MENU_ID,
    label: "Formulas",
    order: FORMULAS_MENU_ORDER,
    items: [
      {
        id: "formulas:tracePrecedents",
        label: "Trace Precedents",
        action: () => {
          addPrecedentLevel();
        },
      },
      {
        id: "formulas:traceDependents",
        label: "Trace Dependents",
        action: () => {
          addDependentLevel();
        },
      },
      {
        id: "formulas:sep1",
        label: "",
        separator: true,
      },
      {
        id: "formulas:removeArrows",
        label: "Remove Arrows",
        action: () => {
          removeAllArrows();
        },
      },
    ],
  };

  registerMenu(menu);
}
