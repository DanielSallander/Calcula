//! FILENAME: app/src/shell/registries/sheetExtensions.ts
// PURPOSE: Extension points for sheet tab customization
// CONTEXT: Allows extensions to extend sheet tab functionality with context menus,
// custom actions, and event handlers.
// NOTE: Moved from core/registry to shell/registries per microkernel architecture.

import { CommandRegistry, CoreCommands } from "@api/commands";
import { promptForSheetName } from "../SheetTabs/renameSheetPrompt";
import { registerSheetCommands, getSheetTabsController } from "../SheetTabs/sheetCommands";
import { installSheetTabColorPicker, openSheetTabColorPicker } from "./sheetTabColorPicker";

// ============================================================================
// Types for Sheet Extensions
// ============================================================================

/** Context passed to sheet-related extension callbacks */
export interface SheetContext {
  /** The sheet being acted upon. `kind` is absent for a worksheet. */
  sheet: { name: string; index: number; kind?: "worksheet" | "canvas" };
  /** TRUE workbook index — what the backend commands take, and a bad cache key */
  index: number;
  /** Stable identity, for anything an extension remembers about this sheet */
  sheetId?: string;
  /** Whether this is the active sheet */
  isActive: boolean;
  /** Total number of sheets */
  totalSheets: number;
}

/** A context menu item for sheet tabs */
export interface SheetContextMenuItem {
  /** Unique identifier */
  id: string;
  /** Display label, or a function of the sheet it is shown for. */
  label: string | ((context: SheetContext) => string);
  /** Optional icon */
  icon?: React.ReactNode;
  /** Whether the item is disabled */
  disabled?: boolean | ((context: SheetContext) => boolean);
  /**
   * Whether the item appears at all. Default: always. See the `@api` mirror for
   * why this is distinct from `disabled`.
   */
  visible?: (context: SheetContext) => boolean;
  /** Whether to show a separator after this item */
  separatorAfter?: boolean;
  /** Click handler */
  onClick: (context: SheetContext) => void | Promise<void>;
}

/**
 * A menu item with every predicate already applied for one specific sheet.
 *
 * The renderer receives THIS, not the registration: a component should never
 * have to know that a label or a disabled flag might be a function, and typing
 * the resolver's output is what stops it having to.
 */
export interface ResolvedSheetContextMenuItem
  extends Omit<SheetContextMenuItem, "label" | "disabled" | "visible"> {
  label: string;
  disabled?: boolean;
}

/** Event types for sheet operations */
export type SheetEventType =
  | "sheet:beforeSwitch"
  | "sheet:afterSwitch"
  | "sheet:beforeAdd"
  | "sheet:afterAdd"
  | "sheet:beforeDelete"
  | "sheet:afterDelete"
  | "sheet:beforeRename"
  | "sheet:afterRename";

/** Payload for sheet events */
export interface SheetEventPayload {
  type: SheetEventType;
  sheetIndex: number;
  sheetName: string;
  /** For switch events */
  previousIndex?: number;
  /** For rename events */
  previousName?: string;
  /** For add events */
  newIndex?: number;
}

/** Sheet event handler */
export type SheetEventHandler = (payload: SheetEventPayload) => void | Promise<void>;

// ============================================================================
// Sheet Extension Registry
// ============================================================================

class SheetExtensionRegistry {
  private contextMenuItems: Map<string, SheetContextMenuItem> = new Map();
  private eventHandlers: Map<SheetEventType, Set<SheetEventHandler>> = new Map();

  // --------------------------------------------------------------------------
  // Context Menu Items
  // --------------------------------------------------------------------------

  /**
   * Register a context menu item for sheet tabs.
   * @param item The menu item to register
   */
  registerContextMenuItem(item: SheetContextMenuItem): void {
    if (this.contextMenuItems.has(item.id)) {
      console.warn(`[SheetExtensions] Context menu item '${item.id}' already registered, replacing`);
    }
    this.contextMenuItems.set(item.id, item);
    console.log(`[SheetExtensions] Registered context menu item: ${item.id}`);
  }

  /**
   * Unregister a context menu item.
   * @param id The item ID to remove
   */
  unregisterContextMenuItem(id: string): void {
    this.contextMenuItems.delete(id);
  }

  /**
   * Get all registered context menu items.
   */
  getContextMenuItems(): SheetContextMenuItem[] {
    return Array.from(this.contextMenuItems.values());
  }

  /**
   * Get context menu items filtered by context (respecting disabled state).
   */
  getContextMenuItemsForContext(context: SheetContext): ResolvedSheetContextMenuItem[] {
    return this.getContextMenuItems()
      // `visible` first: an item that does not apply to THIS sheet is dropped,
      // not greyed. A predicate that throws hides the item rather than taking
      // the whole menu down with it.
      .filter((item) => {
        if (!item.visible) return true;
        try {
          return item.visible(context);
        } catch (error) {
          console.error(`[SheetExtensions] visible() threw for "${item.id}":`, error);
          return false;
        }
      })
      .map((item) => ({
        ...item,
        // Resolved here so the renderer never has to know a label can be dynamic
        // — an item whose label names the application it would detach from
        // cannot be a constant.
        label: typeof item.label === "function" ? item.label(context) : item.label,
        disabled:
          typeof item.disabled === "function"
            ? item.disabled(context)
            : item.disabled,
      }));
  }

  // --------------------------------------------------------------------------
  // Event Handlers
  // --------------------------------------------------------------------------

  /**
   * Subscribe to sheet events.
   * @param eventType The event type to subscribe to
   * @param handler The handler function
   * @returns Unsubscribe function
   */
  on(eventType: SheetEventType, handler: SheetEventHandler): () => void {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, new Set());
    }
    this.eventHandlers.get(eventType)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.eventHandlers.get(eventType)?.delete(handler);
    };
  }

  /**
   * Emit a sheet event to all subscribers.
   * @param payload The event payload
   */
  async emit(payload: SheetEventPayload): Promise<void> {
    const handlers = this.eventHandlers.get(payload.type);
    if (!handlers || handlers.size === 0) return;

    console.log(`[SheetExtensions] Emitting ${payload.type}`, payload);

    for (const handler of handlers) {
      try {
        await handler(payload);
      } catch (error) {
        console.error(`[SheetExtensions] Error in ${payload.type} handler:`, error);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Utility
  // --------------------------------------------------------------------------

  /**
   * Clear all registered extensions (useful for testing).
   */
  clear(): void {
    this.contextMenuItems.clear();
    this.eventHandlers.clear();
  }
}

// Singleton instance
export const sheetExtensions = new SheetExtensionRegistry();

// ============================================================================
// Built-in Context Menu Items (Core functionality)
// ============================================================================

/**
 * Whether hiding the right-clicked sheet would leave the workbook with no
 * VISIBLE sheet -- Excel greys Hide Sheet then. `totalSheets` counts hidden
 * and veryHidden sheets too (it is the strip's whole list), so it cannot
 * answer this: with Sheet2 hidden, Sheet1's menu offered Hide Sheet and the
 * backend refused it. The strip's snapshot knows each sheet's visibility; with
 * no strip seated (nothing to act through anyway) the workbook's count is the
 * fallback.
 */
function isLastVisibleSheet(context: SheetContext): boolean {
  const snapshot = getSheetTabsController()?.snapshot();
  if (!snapshot) return context.totalSheets <= 1;
  return !snapshot.sheets.some((s) => s.index !== context.index && s.visibility === "visible");
}

/** The right-clicked sheet's current tab colour, from the strip's snapshot. */
function currentTabColor(context: SheetContext): string | null {
  const sheet = getSheetTabsController()?.snapshot().sheets.find((s) => s.index === context.index);
  return sheet?.tabColor ? sheet.tabColor : null;
}

/** Register the default/core context menu items */
export function registerCoreSheetContextMenu(): void {
  // The core.sheet.* commands (Excel's Home > Cells sheet doors and Shift+F11)
  // and the Move or Copy dialog. They act through the tab strip's own
  // handlers, which the strip seats when it mounts (SheetTabs/sheetCommands.ts).
  registerSheetCommands();
  // Tab Color's palette (sheetTabColorPicker.tsx): a shell component the frame
  // mounts, opened by the menu row below.
  installSheetTabColorPicker();

  // Rename -- the ONE rename prompt (SheetTabs/renameSheetPrompt.ts), shared
  // with the tab double-click and core.sheet.rename.
  sheetExtensions.registerContextMenuItem({
    id: "core:rename",
    label: "Rename",
    onClick: async (context) => {
      const newName = await promptForSheetName(context.sheet.name);
      if (newName !== null) {
        window.dispatchEvent(new CustomEvent("sheet:requestRename", {
          detail: { index: context.index, newName },
        }));
      }
    },
  });

  // Delete
  sheetExtensions.registerContextMenuItem({
    id: "core:delete",
    label: "Delete",
    disabled: (context) => context.totalSheets <= 1,
    separatorAfter: true,
    onClick: async (context) => {
      if (context.totalSheets <= 1) return;
      window.dispatchEvent(new CustomEvent("sheet:requestDelete", {
        detail: { index: context.index },
      }));
    },
  });

  // Insert -- the COMMAND, for the right-clicked sheet: Excel inserts the new
  // worksheet BEFORE it, exactly as Home > Insert > Insert Sheet and Shift+F11
  // do. This item used to dispatch `sheet:requestAdd`, which APPENDED the sheet
  // at the end, so "Insert Sheet" landed in two places depending on the door;
  // the command's refusals (a structure lock) now cover the tab menu too.
  sheetExtensions.registerContextMenuItem({
    id: "core:insertSheet",
    label: "Insert Sheet",
    onClick: async (context) => {
      await CommandRegistry.execute(CoreCommands.SHEET_INSERT, { index: context.index });
    },
  });

  // Insert a CANVAS sheet. A CORE item on purpose: the registry has no ordering
  // key, so only an item registered here lands next to "Insert Sheet". It runs
  // the same COMMAND as every other sheet insert -- a canvas, appended at the
  // end as it always was -- so the command's refusals cover it, and the Canvas
  // tab's New Page goes through the same public door.
  sheetExtensions.registerContextMenuItem({
    id: "core:insertCanvas",
    label: "Insert Canvas",
    onClick: async () => {
      await CommandRegistry.execute(CoreCommands.SHEET_INSERT, { kind: "canvas", atEnd: true });
    },
  });

  // Move or Copy... (Excel's tab menu has it): the dialog the Home tab's
  // Format > Move or Copy Sheet... opens, for the right-clicked sheet.
  sheetExtensions.registerContextMenuItem({
    id: "core:moveOrCopy",
    label: "Move or Copy...",
    onClick: async (context) => {
      await CommandRegistry.execute(CoreCommands.SHEET_MOVE_OR_COPY, { index: context.index });
    },
  });

  // Duplicate (Copy). Hidden for a CANVAS: copying a sheet clones its grid and
  // view state but none of the objects a canvas consists of, so the backend
  // refuses it rather than hand back an empty page presented as a copy.
  sheetExtensions.registerContextMenuItem({
    id: "core:copySheet",
    label: "Duplicate Sheet",
    visible: (context) => context.sheet.kind !== "canvas",
    separatorAfter: true,
    onClick: async (context) => {
      window.dispatchEvent(new CustomEvent("sheet:requestCopy", {
        detail: { index: context.index },
      }));
    },
  });

  // Move Left
  sheetExtensions.registerContextMenuItem({
    id: "core:moveLeft",
    label: "Move Left",
    disabled: (context) => context.index === 0,
    onClick: async (context) => {
      if (context.index > 0) {
        window.dispatchEvent(new CustomEvent("sheet:requestMove", {
          detail: { fromIndex: context.index, toIndex: context.index - 1 },
        }));
      }
    },
  });

  // Move Right
  sheetExtensions.registerContextMenuItem({
    id: "core:moveRight",
    label: "Move Right",
    disabled: (context) => context.index === context.totalSheets - 1,
    separatorAfter: true,
    onClick: async (context) => {
      if (context.index < context.totalSheets - 1) {
        window.dispatchEvent(new CustomEvent("sheet:requestMove", {
          detail: { fromIndex: context.index, toIndex: context.index + 1 },
        }));
      }
    },
  });

  // Hide -- greyed for the last VISIBLE sheet (Excel), not the last sheet.
  sheetExtensions.registerContextMenuItem({
    id: "core:hideSheet",
    label: "Hide Sheet",
    disabled: (context) => isLastVisibleSheet(context),
    onClick: async (context) => {
      window.dispatchEvent(new CustomEvent("sheet:requestHide", {
        detail: { index: context.index },
      }));
    },
  });

  // Unhide
  sheetExtensions.registerContextMenuItem({
    id: "core:unhideSheet",
    label: "Unhide Sheet...",
    separatorAfter: true,
    onClick: async () => {
      window.dispatchEvent(new CustomEvent("sheet:requestUnhide", { detail: {} }));
    },
  });

  // Tab Color -- Excel's palette dropping from the tab (Theme Colors, Standard
  // Colors, No Color, More Colors...), running core.sheet.setTabColor for THIS
  // sheet: the same command the Home tab's Format > Tab Color runs. It was a
  // numbered text prompt with eight colours of its own and a raw window event.
  sheetExtensions.registerContextMenuItem({
    id: "core:tabColor",
    label: "Tab Color",
    onClick: (context) => {
      openSheetTabColorPicker(context.index, currentTabColor(context));
    },
  });
}