//! FILENAME: app/extensions/EditingOptions/index.ts
// PURPOSE: Editing Options extension - configures editing behavior.
// CONTEXT: Adds "Move After Return" and "Move Direction" settings to the
//          Edit menu, matching Excel's Options > Advanced > Editing Options.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  registerMenuItem,
  IconMoveSelection,
  IconMoveDirection,
  IconArrowDown,
  IconArrowUp,
  IconNext,
  IconPrev,
} from "@api";
import {
  getMoveAfterReturn,
  setMoveAfterReturn,
  getMoveDirection,
  setMoveDirection,
  type MoveDirection,
} from "@api/editingPreferences";

// ============================================================================
// Menu Registration
// ============================================================================

function registerMenuItems(): void {
  // Separator before editing options
  registerMenuItem("edit", {
    id: "edit:editingOptions:separator",
    label: "",
    separator: true,
  });

  // Move After Return toggle
  registerMenuItem("edit", {
    id: "edit:editingOptions:moveAfterReturn",
    label: "Move Selection After Enter",
    icon: IconMoveSelection,
    get checked() { return getMoveAfterReturn(); },
    action: () => {
      setMoveAfterReturn(!getMoveAfterReturn());
    },
  });

  // Move Direction submenu ("none" is not offered as a menu choice)
  const directions: Array<{ label: string; value: Exclude<MoveDirection, "none"> }> = [
    { label: "Down", value: "down" },
    { label: "Right", value: "right" },
    { label: "Up", value: "up" },
    { label: "Left", value: "left" },
  ];

  const directionIcons: Record<Exclude<MoveDirection, "none">, React.ReactNode> = {
    down: IconArrowDown,
    up: IconArrowUp,
    right: IconNext,
    left: IconPrev,
  };

  registerMenuItem("edit", {
    id: "edit:editingOptions:moveDirection",
    label: "Move Direction",
    icon: IconMoveDirection,
    children: directions.map((d) => ({
      id: `edit:editingOptions:moveDirection:${d.value}`,
      label: d.label,
      icon: directionIcons[d.value],
      get checked() { return getMoveDirection() === d.value; },
      action: () => { setMoveDirection(d.value); },
    })),
  });
}

// ============================================================================
// Lifecycle
// ============================================================================

function activate(_context: ExtensionContext): void {
  registerMenuItems();
}

function deactivate(): void {}

// ============================================================================
// Extension Module
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.editing-options",
    name: "Editing Options",
    version: "1.0.0",
    description: "Configures editing behavior: move after return, direction.",
  },
  activate,
  deactivate,
};
export default extension;
