//! FILENAME: app/extensions/Tracing/handlers/formulasMenuBuilder.ts
// PURPOSE: Registers the "Formulas" top-level menu with trace commands.
// CONTEXT: Creates menu items for Trace Precedents, Trace Dependents, and Remove Arrows.

import type { ExtensionContext } from "@api/contract";
import {
  IconTracePrecedents,
  IconTraceDependents,
  IconRemoveArrows,
  emitAppEvent,
  AppEvents,
} from "@api";
import type { MenuDefinition } from "@api";
import {
  addPrecedentLevel,
  addDependentLevel,
  removeAllArrows,
} from "../lib/tracingStore";
import { getGridStateSnapshot } from "@api/grid";

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
export function registerFormulasMenu(context: ExtensionContext): void {
  const menu: MenuDefinition = {
    id: FORMULAS_MENU_ID,
    label: "Formulas",
    order: FORMULAS_MENU_ORDER,
    items: [
      {
        id: "formulas:tracePrecedents",
        label: "Trace Precedents",
        icon: IconTracePrecedents,
        action: () => {
          addPrecedentLevel();
        },
      },
      {
        id: "formulas:traceDependents",
        label: "Trace Dependents",
        icon: IconTraceDependents,
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
        icon: IconRemoveArrows,
        action: () => {
          removeAllArrows();
        },
      },
      {
        id: "formulas:sep2",
        label: "",
        separator: true,
      },
      {
        id: "formulas:showFormulas",
        label: "Show Formulas",
        shortcut: "Ctrl+`",
        action: () => {
          const state = getGridStateSnapshot();
          const newValue = state ? !state.showFormulas : true;
          emitAppEvent(AppEvents.SHOW_FORMULAS_TOGGLED, { showFormulas: newValue });
          emitAppEvent(AppEvents.GRID_REFRESH);
        },
      },
    ],
  };

  context.ui.menus.register(menu);
}
