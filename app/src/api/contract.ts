//! FILENAME: app/src/api/contract.ts
// PURPOSE: Defines the ExtensionModule interface and ExtensionContext.
// CONTEXT: Every extension must default-export an object satisfying ExtensionModule.
//          The ExtensionContext is the DI container passed to activate().

import type { ICommandRegistry } from "./commands";
import type {
  MenuDefinition,
  MenuItemDefinition,
  TaskPaneViewDefinition,
  TaskPaneContextKey,
  DialogDefinition,
  OverlayDefinition,
  AnchorRect,
  StatusBarItemDefinition,
  ActivityViewDefinition,
} from "./uiTypes";
import type {
  CellDecorationFn,
  CellDecorationRegistration,
} from "./cellDecorations";
import type {
  StyleInterceptorFn,
} from "./styleInterceptors";
import type {
  OverlayRegistration,
} from "./gridOverlays";
import type { AppEventName } from "./events";
import type { IKeyboardAPI } from "./keyboard";
import type { ISettingsAPI } from "./settings";
import type { ICellEditorAPI } from "./cellEditors";
import type { IFileFormatAPI } from "./fileFormats";
import type { CustomFunctionDef } from "./formulaFunctions";

// ============================================================================
// Sub-API Interfaces (Services available through ExtensionContext)
// ============================================================================

/** Menu registration and management */
export interface IMenuAPI {
  register(definition: MenuDefinition): void;
  registerItem(menuId: string, item: MenuItemDefinition): void;
  getAll(): MenuDefinition[];
  subscribe(callback: () => void): () => void;
  notifyChanged(): void;
}

/** Task pane registration and management */
export interface ITaskPaneAPI {
  register(definition: TaskPaneViewDefinition): void;
  unregister(viewId: string): void;
  open(viewId: string, data?: Record<string, unknown>): void;
  close(viewId: string): void;
  getView(viewId: string): TaskPaneViewDefinition | undefined;
  showContainer(): void;
  hideContainer(): void;
  isContainerOpen(): boolean;
  addContextKey(key: TaskPaneContextKey): void;
  removeContextKey(key: TaskPaneContextKey): void;
  getManuallyClosed(): string[];
  markManuallyClosed(viewId: string): void;
  clearManuallyClosed(viewId: string): void;
}

/** Dialog registration and management */
export interface IDialogAPI {
  register(definition: DialogDefinition): void;
  unregister(dialogId: string): void;
  show(dialogId: string, data?: Record<string, unknown>): void;
  hide(dialogId: string): void;
}

/** Overlay registration and management */
export interface IOverlayAPI {
  register(definition: OverlayDefinition): void;
  unregister(overlayId: string): void;
  show(overlayId: string, options?: { data?: Record<string, unknown>; anchorRect?: AnchorRect }): void;
  hide(overlayId: string): void;
  hideAll(): void;
}

/** Status bar item registration */
export interface IStatusBarAPI {
  register(definition: StatusBarItemDefinition): void;
  unregister(itemId: string): void;
}

/** Activity bar (left sidebar) view registration */
export interface IActivityBarAPI {
  register(definition: ActivityViewDefinition): void;
  unregister(viewId: string): void;
  open(viewId: string, data?: Record<string, unknown>): void;
  close(): void;
  toggle(viewId?: string): void;
}

/** Application event system */
export interface IEventAPI {
  emit<T = unknown>(eventName: AppEventName | string, detail?: T): void;
  on<T = unknown>(eventName: AppEventName | string, callback: (detail: T) => void): () => void;
}

/** Cell decoration registration */
export interface ICellDecorationAPI {
  register(id: string, renderFn: CellDecorationFn, priority?: number): CellDecorationRegistration;
  unregister(id: string): void;
}

/** Style interceptor registration */
export interface IStyleInterceptorAPI {
  register(id: string, interceptorFn: StyleInterceptorFn, priority?: number): () => void;
  unregister(id: string): void;
  markRangeDirty(sheetIndex: number, startRow: number, startCol: number, endRow: number, endCol: number): void;
  markSheetDirty(sheetIndex: number): void;
}

/** Grid overlay registration */
export interface IGridOverlayAPI {
  register(registration: OverlayRegistration): () => void;
}

/** Edit guard registration */
export interface IEditGuardAPI {
  register(guard: (row: number, col: number) => boolean | string): () => void;
}

/** Range guard registration (blocks drag/move/copy onto protected ranges) */
export interface IRangeGuardAPI {
  register(guard: (startRow: number, startCol: number, endRow: number, endCol: number) => { blocked: boolean; message?: string } | null): () => void;
}

/** Custom worksheet function registration */
export interface IFormulasAPI {
  /**
   * Register a custom worksheet function.
   * @param def The function definition including name, metadata, and implementation.
   * @returns An unregister function that removes the custom function.
   */
  registerFunction(def: CustomFunctionDef): () => void;
}

/** Cell click interceptor registration */
export interface ICellClickAPI {
  registerClickInterceptor(handler: (row: number, col: number, event: MouseEvent) => boolean | Promise<boolean>): () => void;
  registerDoubleClickInterceptor(handler: (row: number, col: number, event: MouseEvent) => boolean): () => void;
}

/** Toast notifications */
export interface INotificationAPI {
  showToast(message: string, options?: { type?: "info" | "success" | "warning" | "error"; duration?: number }): void;
}

// ============================================================================
// Extension Context (Dependency Injection Container)
// ============================================================================

/**
 * The "API" object we pass to extensions.
 * This acts as a Dependency Injection container — every service an extension
 * might need is discoverable from this single object.
 *
 * Extensions can also import free functions directly from `src/api` —
 * both access paths call the same underlying implementation.
 */
export interface ExtensionContext {
  /** Command registry for registering and executing commands */
  commands: ICommandRegistry;

  /** UI registration services */
  ui: {
    menus: IMenuAPI;
    taskPanes: ITaskPaneAPI;
    dialogs: IDialogAPI;
    overlays: IOverlayAPI;
    statusBar: IStatusBarAPI;
    activityBar: IActivityBarAPI;
    notifications: INotificationAPI;
  };

  /** Application event bus */
  events: IEventAPI;

  /** Keyboard shortcut registration */
  keyboard: IKeyboardAPI;

  /** Extension settings/preferences */
  settings: ISettingsAPI;

  /** Custom cell editor registration */
  cellEditors: ICellEditorAPI;

  /** File format importers/exporters */
  fileFormats: IFileFormatAPI;

  /** Custom worksheet function registration */
  formulas: IFormulasAPI;

  /** Grid rendering hooks */
  grid: {
    decorations: ICellDecorationAPI;
    styleInterceptors: IStyleInterceptorAPI;
    overlays: IGridOverlayAPI;
    editGuards: IEditGuardAPI;
    rangeGuards: IRangeGuardAPI;
    cellClicks: ICellClickAPI;
  };
}

// ============================================================================
// Extension Manifest (Metadata)
// ============================================================================

export interface ExtensionManifest {
  /** Unique identifier for the extension */
  id: string;
  /** Human-readable name */
  name: string;
  /** Semantic version string */
  version: string;
  /** Required API version (semver range, e.g. "^1.0.0"). Checked on activation. */
  apiVersion?: string;
  /** Events that trigger activation (future use) */
  activationEvents?: string[];
  /** Optional description */
  description?: string;
}

// ============================================================================
// Extension Module Interface
// ============================================================================

/**
 * Every extension file must default-export an object satisfying this interface.
 */
export interface ExtensionModule {
  /** Extension metadata */
  manifest: ExtensionManifest;
  /** Called when the extension is activated */
  activate: (context: ExtensionContext) => void | Promise<void>;
  /** Called when the extension is deactivated (optional) */
  deactivate?: () => void;
}
