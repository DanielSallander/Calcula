//! FILENAME: app/src/api/scriptableObjects.ts
// PURPOSE: Scriptable Objects API — types, contexts, and registration for user-scriptable objects.
// CONTEXT: Every object in Calcula (slicers, charts, cells, sheets, etc.) can expose a "Code" tab
//          where users can write TypeScript to extend behavior. This file defines the typed contexts
//          and the runtime manager that executes object scripts.

// ============================================================================
// Access Levels
// ============================================================================

/** Script access level — controls what API surface the script can reach. */
export type ScriptAccessLevel = "restricted" | "unlocked";

// ============================================================================
// Object Script Definition (storage representation)
// ============================================================================

/** Identifies what kind of scriptable object this script belongs to. */
export type ScriptableObjectType =
  // Primitive objects (workbook-scoped, one script per type)
  | "workbook"
  | "sheet"
  | "cell"
  | "row"
  | "column"
  // Component objects (per-instance scripts)
  | "slicer"
  | "chart"
  | "pivot"
  | "button"
  | "textbox"
  | "timeline";

/** Stored script definition for a scriptable object. */
export interface ObjectScriptDefinition {
  /** Unique script ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** The object type this script targets */
  objectType: ScriptableObjectType;
  /** For component objects: the instance ID. Null for primitive objects. */
  instanceId: string | null;
  /** The script source code (TypeScript/JavaScript) */
  source: string;
  /** Access level: restricted (default) or unlocked (full API) */
  accessLevel: ScriptAccessLevel;
  /** Optional description */
  description?: string;
}

// ============================================================================
// Lifecycle Events
// ============================================================================

/** Lifecycle stage for scriptable objects. */
export type ObjectLifecycleStage =
  | "create"
  | "mount"
  | "unmount"
  | "destroy";

/** Base event handler signature. */
export type EventHandler<T = void> = (detail: T) => void | Promise<void>;

/** Cleanup function returned by event subscriptions. */
export type CleanupFn = () => void;

// ============================================================================
// Base Object Context (shared by all object types)
// ============================================================================

/** Base context available to all scriptable objects (restricted mode). */
export interface BaseObjectContext {
  /** The object type */
  readonly objectType: ScriptableObjectType;

  /** The script access level */
  readonly accessLevel: ScriptAccessLevel;

  /**
   * Expose a custom method that other scripts or extensions can call.
   * @param name Method name
   * @param handler The method implementation
   */
  expose(name: string, handler: (...args: unknown[]) => unknown): CleanupFn;

  /**
   * Log to the script console (visible in the Code tab output panel).
   */
  log(...args: unknown[]): void;

  /**
   * Show a toast notification to the user.
   */
  notify(message: string, type?: "info" | "success" | "warning" | "error"): void;
}

// ============================================================================
// Primitive Object Contexts (workbook-scoped)
// ============================================================================

/** Context for Workbook-level scripts. */
export interface WorkbookContext extends BaseObjectContext {
  readonly objectType: "workbook";

  /** Called when the workbook is opened. */
  onOpen(handler: EventHandler): CleanupFn;

  /** Called before the workbook is saved. */
  onBeforeSave(handler: EventHandler): CleanupFn;

  /** Called after the workbook is saved. */
  onAfterSave(handler: EventHandler): CleanupFn;

  /** Called before the workbook is closed. */
  onBeforeClose(handler: EventHandler): CleanupFn;

  /** Called when the active sheet changes. */
  onSheetChange(handler: EventHandler<{ sheetIndex: number; sheetName: string }>): CleanupFn;

  /** Called when the theme changes. */
  onThemeChange(handler: EventHandler): CleanupFn;

  /** Access workbook properties. */
  readonly properties: {
    readonly title: string;
    readonly author: string;
    readonly sheetCount: number;
    getSheetNames(): string[];
  };
}

/** Context for Sheet-level scripts (applies to all sheets). */
export interface SheetContext extends BaseObjectContext {
  readonly objectType: "sheet";

  /** Called when any sheet is activated (switched to). */
  onActivate(handler: EventHandler<{ sheetIndex: number; sheetName: string }>): CleanupFn;

  /** Called when any sheet is deactivated (switched away from). */
  onDeactivate(handler: EventHandler<{ sheetIndex: number; sheetName: string }>): CleanupFn;

  /** Called when the selection changes on any sheet. */
  onSelectionChange(handler: EventHandler<{
    sheetIndex: number;
    row: number;
    col: number;
    endRow: number;
    endCol: number;
  }>): CleanupFn;

  /** Called when data changes on any sheet. */
  onDataChange(handler: EventHandler<{
    sheetIndex: number;
    changes: Array<{ row: number; col: number; oldValue?: string; newValue: string }>;
  }>): CleanupFn;

  /** Read a cell value from the specified (or active) sheet. */
  getCellValue(row: number, col: number, sheetIndex?: number): string;

  /** Write a cell value. */
  setCellValue(row: number, col: number, value: string, sheetIndex?: number): void;
}

/** Context for Cell-level scripts (applies to all cells). */
export interface CellContext extends BaseObjectContext {
  readonly objectType: "cell";

  /** Called when any cell is edited (value committed). */
  onEdit(handler: EventHandler<{
    row: number;
    col: number;
    sheetIndex: number;
    oldValue?: string;
    newValue: string;
    formula?: string | null;
  }>): CleanupFn;

  /** Called when a cell is selected. */
  onSelect(handler: EventHandler<{
    row: number;
    col: number;
    sheetIndex: number;
  }>): CleanupFn;

  /** Called when editing starts on a cell. */
  onEditStart(handler: EventHandler<{
    row: number;
    col: number;
    sheetIndex: number;
  }>): CleanupFn;

  /** Called when editing ends (commit or cancel). */
  onEditEnd(handler: EventHandler<{
    row: number;
    col: number;
    sheetIndex: number;
    committed: boolean;
  }>): CleanupFn;

  /**
   * Register a custom cell renderer that runs for every visible cell.
   * Return a style override object to modify appearance, or null to use default.
   */
  onRender(handler: (cell: {
    row: number;
    col: number;
    sheetIndex: number;
    value: string;
    formula?: string | null;
  }) => { textColor?: string; backgroundColor?: string; bold?: boolean; italic?: boolean } | null): CleanupFn;
}

/** Context for Row-level scripts (applies to all rows). */
export interface RowContext extends BaseObjectContext {
  readonly objectType: "row";

  /** Called when rows are inserted. */
  onInsert(handler: EventHandler<{ sheetIndex: number; startRow: number; count: number }>): CleanupFn;

  /** Called when rows are deleted. */
  onDelete(handler: EventHandler<{ sheetIndex: number; startRow: number; count: number }>): CleanupFn;

  /** Called when a row height changes. */
  onResize(handler: EventHandler<{ sheetIndex: number; row: number; height: number }>): CleanupFn;
}

/** Context for Column-level scripts (applies to all columns). */
export interface ColumnContext extends BaseObjectContext {
  readonly objectType: "column";

  /** Called when columns are inserted. */
  onInsert(handler: EventHandler<{ sheetIndex: number; startCol: number; count: number }>): CleanupFn;

  /** Called when columns are deleted. */
  onDelete(handler: EventHandler<{ sheetIndex: number; startCol: number; count: number }>): CleanupFn;

  /** Called when a column width changes. */
  onResize(handler: EventHandler<{ sheetIndex: number; col: number; width: number }>): CleanupFn;
}

// ============================================================================
// Component Object Contexts (per-instance)
// ============================================================================

/** Context for Slicer instances. */
export interface SlicerContext extends BaseObjectContext {
  readonly objectType: "slicer";

  /** The slicer instance ID. */
  readonly instanceId: string;

  /** The slicer name. */
  readonly name: string;

  /** Called when slicer selection changes (items are selected/deselected). */
  onSelectionChange(handler: EventHandler<{ selectedItems: string[] }>): CleanupFn;

  /** Called when the slicer's underlying data is refreshed. */
  onDataRefresh(handler: EventHandler<{ items: string[] }>): CleanupFn;

  /** Called when the slicer is moved or resized. */
  onResize(handler: EventHandler<{ x: number; y: number; width: number; height: number }>): CleanupFn;

  /** Get the currently selected items. */
  getSelectedItems(): string[];

  /** Set the selected items programmatically. */
  setSelectedItems(items: string[]): void;

  /** Clear all selections. */
  clearSelection(): void;

  /** Select all items. */
  selectAll(): void;

  /** Style customization namespace. */
  style: {
    /** Override the item renderer for custom appearance. */
    itemRenderer(renderer: (item: {
      text: string;
      selected: boolean;
      hasData: boolean;
      index: number;
    }, ctx: CanvasRenderingContext2D, bounds: { x: number; y: number; width: number; height: number }) => void): CleanupFn;

    /** Set a CSS property on the slicer container. */
    setProperty(name: string, value: string): void;
  };

  /** Slicer properties (read-only). */
  readonly properties: {
    readonly fieldName: string;
    readonly sourceType: string;
    readonly columns: number;
  };
}

/** Context for Chart instances. */
export interface ChartContext extends BaseObjectContext {
  readonly objectType: "chart";

  /** The chart instance ID. */
  readonly instanceId: string;

  /** Called when the chart's source data changes. */
  onDataChange(handler: EventHandler): CleanupFn;

  /** Called when the chart is clicked. */
  onClick(handler: EventHandler<{ x: number; y: number }>): CleanupFn;

  /** Called when the chart is moved or resized. */
  onResize(handler: EventHandler<{ x: number; y: number; width: number; height: number }>): CleanupFn;

  /** Get the chart specification (opaque JSON). */
  getSpec(): Record<string, unknown>;

  /** Update the chart specification. */
  updateSpec(patch: Record<string, unknown>): void;

  /** Style customization. */
  style: {
    setProperty(name: string, value: string): void;
  };
}

/** Context for Pivot Table instances. */
export interface PivotContext extends BaseObjectContext {
  readonly objectType: "pivot";

  /** The pivot instance ID. */
  readonly instanceId: string;

  /** Called when the pivot is refreshed (recalculated). */
  onRefresh(handler: EventHandler): CleanupFn;

  /** Called when pivot field layout changes. */
  onLayoutChange(handler: EventHandler<{
    rows: string[];
    columns: string[];
    values: string[];
    filters: string[];
  }>): CleanupFn;

  /** Called when the pivot is moved or resized. */
  onResize(handler: EventHandler<{ x: number; y: number; width: number; height: number }>): CleanupFn;

  /** Get current pivot field configuration. */
  getFields(): { rows: string[]; columns: string[]; values: string[]; filters: string[] };

  /** Refresh the pivot table data. */
  refresh(): void;
}

// ============================================================================
// Context Type Map (for generic access)
// ============================================================================

/** Maps object types to their context interfaces. */
export interface ObjectContextMap {
  workbook: WorkbookContext;
  sheet: SheetContext;
  cell: CellContext;
  row: RowContext;
  column: ColumnContext;
  slicer: SlicerContext;
  chart: ChartContext;
  pivot: PivotContext;
  button: BaseObjectContext;
  textbox: BaseObjectContext;
  timeline: BaseObjectContext;
}

// ============================================================================
// Script Setup Function Signature
// ============================================================================

/** The function signature that all object scripts must export as default. */
export type ObjectScriptSetup<T extends ScriptableObjectType = ScriptableObjectType> =
  (context: ObjectContextMap[T]) => void | CleanupFn | Promise<void | CleanupFn>;

// ============================================================================
// Object Script Manager API (exposed to extensions)
// ============================================================================

/** API for managing object scripts — used by the ScriptableObjects extension. */
export interface IObjectScriptAPI {
  /**
   * Register a script for a scriptable object.
   * For primitives: objectType is used, instanceId is null.
   * For components: objectType + instanceId identify the specific instance.
   */
  registerScript(definition: ObjectScriptDefinition): void;

  /** Remove a script by ID. */
  removeScript(scriptId: string): void;

  /** Get the script for an object (primitive by type, component by instanceId). */
  getScript(objectType: ScriptableObjectType, instanceId?: string | null): ObjectScriptDefinition | null;

  /** Get all registered object scripts. */
  getAllScripts(): ObjectScriptDefinition[];

  /** Execute a specific object script (mounts its lifecycle). */
  mountScript(scriptId: string): Promise<void>;

  /** Unmount a running script. */
  unmountScript(scriptId: string): void;

  /** Check if a script is currently mounted (running). */
  isScriptMounted(scriptId: string): boolean;

  /** Subscribe to script changes (add/remove/update). */
  onScriptChange(callback: () => void): CleanupFn;
}

// ============================================================================
// Object Script Manager (singleton — manages all object scripts)
// ============================================================================

type ScriptChangeListener = () => void;

interface MountedScript {
  definition: ObjectScriptDefinition;
  cleanupFns: CleanupFn[];
  teardown?: CleanupFn;
}

const registeredScripts = new Map<string, ObjectScriptDefinition>();
const mountedScripts = new Map<string, MountedScript>();
const changeListeners = new Set<ScriptChangeListener>();

function notifyChange(): void {
  for (const listener of changeListeners) {
    try { listener(); } catch { /* ignore */ }
  }
}

/** Get the lookup key for a script — primitives use objectType, components use instanceId. */
function getLookupKey(objectType: ScriptableObjectType, instanceId?: string | null): string {
  if (instanceId) return `component:${objectType}:${instanceId}`;
  return `primitive:${objectType}`;
}

export const ObjectScriptManager: IObjectScriptAPI = {
  registerScript(definition: ObjectScriptDefinition): void {
    registeredScripts.set(definition.id, definition);
    notifyChange();
  },

  removeScript(scriptId: string): void {
    // Unmount if running
    if (mountedScripts.has(scriptId)) {
      ObjectScriptManager.unmountScript(scriptId);
    }
    registeredScripts.delete(scriptId);
    notifyChange();
  },

  getScript(objectType: ScriptableObjectType, instanceId?: string | null): ObjectScriptDefinition | null {
    const key = getLookupKey(objectType, instanceId);
    for (const script of registeredScripts.values()) {
      const scriptKey = getLookupKey(script.objectType, script.instanceId);
      if (scriptKey === key) return script;
    }
    return null;
  },

  getAllScripts(): ObjectScriptDefinition[] {
    return Array.from(registeredScripts.values());
  },

  async mountScript(scriptId: string): Promise<void> {
    const definition = registeredScripts.get(scriptId);
    if (!definition) {
      console.warn(`[ObjectScriptManager] Script not found: ${scriptId}`);
      return;
    }

    // Already mounted? Unmount first.
    if (mountedScripts.has(scriptId)) {
      ObjectScriptManager.unmountScript(scriptId);
    }

    const mounted: MountedScript = {
      definition,
      cleanupFns: [],
    };

    try {
      // Build the context for this object type
      const context = buildObjectContext(definition, mounted.cleanupFns);

      // Execute the script in a sandboxed function
      const setupFn = compileObjectScript(definition.source, definition.objectType);
      const teardown = await setupFn(context);
      if (typeof teardown === "function") {
        mounted.teardown = teardown;
      }

      mountedScripts.set(scriptId, mounted);
    } catch (error) {
      console.error(`[ObjectScriptManager] Failed to mount script "${definition.name}":`, error);
      // Clean up any handlers that were registered before the error
      for (const fn of mounted.cleanupFns) {
        try { fn(); } catch { /* ignore */ }
      }
    }
  },

  unmountScript(scriptId: string): void {
    const mounted = mountedScripts.get(scriptId);
    if (!mounted) return;

    // Call the teardown function if provided
    if (mounted.teardown) {
      try { mounted.teardown(); } catch (e) {
        console.error(`[ObjectScriptManager] Teardown error for "${mounted.definition.name}":`, e);
      }
    }

    // Clean up all registered handlers (reverse order)
    for (let i = mounted.cleanupFns.length - 1; i >= 0; i--) {
      try { mounted.cleanupFns[i](); } catch { /* ignore */ }
    }

    mountedScripts.delete(scriptId);
  },

  isScriptMounted(scriptId: string): boolean {
    return mountedScripts.has(scriptId);
  },

  onScriptChange(callback: ScriptChangeListener): CleanupFn {
    changeListeners.add(callback);
    return () => changeListeners.delete(callback);
  },
};

// ============================================================================
// Script Compilation (sandboxed execution)
// ============================================================================

/**
 * Compile a user script source into a callable setup function.
 * The script is wrapped in a function that receives the context object.
 * This provides basic sandboxing — the script cannot access module system or imports.
 */
function compileObjectScript(
  source: string,
  _objectType: ScriptableObjectType,
): ObjectScriptSetup {
  try {
    // Wrap the source in a function body.
    // The script should define a `setup` function or directly use the `context` parameter.
    // We support two styles:
    //   1. export default function setup(ctx) { ... }   (scaffold style — we extract the function)
    //   2. Direct code that uses `context` as a global  (simple style)

    // Strip any import/export statements (they won't work in this sandbox)
    const cleanedSource = source
      .replace(/^\s*import\s+.*$/gm, "// [import removed]")
      .replace(/^\s*export\s+default\s+/gm, "");

    // Try to find a named setup function
    const setupMatch = cleanedSource.match(/function\s+setup\s*\(/);
    let wrappedSource: string;

    if (setupMatch) {
      // The source defines a `setup(context)` function — call it
      wrappedSource = `
        ${cleanedSource}
        return setup(context);
      `;
    } else {
      // Treat the entire source as the body of a setup function
      wrappedSource = cleanedSource;
    }

    // Create the sandboxed function
    // eslint-disable-next-line no-new-func
    const factory = new Function("context", wrappedSource);
    return (context) => factory(context);
  } catch (error) {
    console.error("[ObjectScriptManager] Script compilation error:", error);
    throw error;
  }
}

// ============================================================================
// Context Builders
// ============================================================================

import { emitAppEvent, onAppEvent, AppEvents } from "./events";
import { ExtensionRegistry } from "./extensionRegistry";
import { showToast } from "./notifications";
import { registerStyleInterceptor } from "./styleInterceptors";

/**
 * Build the appropriate context object for a script definition.
 * Each context type gets its own set of lifecycle hooks and API surface.
 */
function buildObjectContext(
  definition: ObjectScriptDefinition,
  cleanupFns: CleanupFn[],
): BaseObjectContext {
  const exposedMethods = new Map<string, (...args: unknown[]) => unknown>();

  // Base context (shared by all types)
  const base: BaseObjectContext = {
    objectType: definition.objectType,
    accessLevel: definition.accessLevel,

    expose(name: string, handler: (...args: unknown[]) => unknown): CleanupFn {
      exposedMethods.set(name, handler);
      return () => exposedMethods.delete(name);
    },

    log(...args: unknown[]): void {
      console.log(`[Script:${definition.name}]`, ...args);
      emitAppEvent("objectscript:console", {
        scriptId: definition.id,
        level: "log",
        args,
      });
    },

    notify(message: string, type?: "info" | "success" | "warning" | "error"): void {
      showToast(message, { type: type || "info" });
    },
  };

  // Build type-specific context
  switch (definition.objectType) {
    case "workbook":
      return buildWorkbookContext(base, cleanupFns);
    case "sheet":
      return buildSheetContext(base, cleanupFns);
    case "cell":
      return buildCellContext(base, cleanupFns);
    case "row":
      return buildRowContext(base, cleanupFns);
    case "column":
      return buildColumnContext(base, cleanupFns);
    case "slicer":
      return buildSlicerContext(base, definition, cleanupFns);
    case "chart":
      return buildChartContext(base, definition, cleanupFns);
    case "pivot":
      return buildPivotContext(base, definition, cleanupFns);
    default:
      return base;
  }
}

// Helper to track cleanup from event subscriptions
function tracked(cleanupFns: CleanupFn[], unsub: CleanupFn): CleanupFn {
  cleanupFns.push(unsub);
  return unsub;
}

// ---- Workbook Context ----

function buildWorkbookContext(base: BaseObjectContext, cleanupFns: CleanupFn[]): WorkbookContext {
  return {
    ...base,
    objectType: "workbook" as const,

    onOpen(handler) {
      return tracked(cleanupFns, onAppEvent(AppEvents.AFTER_OPEN, handler));
    },
    onBeforeSave(handler) {
      return tracked(cleanupFns, onAppEvent(AppEvents.BEFORE_SAVE, handler));
    },
    onAfterSave(handler) {
      return tracked(cleanupFns, onAppEvent(AppEvents.AFTER_SAVE, handler));
    },
    onBeforeClose(handler) {
      return tracked(cleanupFns, onAppEvent(AppEvents.BEFORE_CLOSE, handler));
    },
    onSheetChange(handler) {
      return tracked(cleanupFns, onAppEvent(AppEvents.SHEET_CHANGED, handler));
    },
    onThemeChange(handler) {
      return tracked(cleanupFns, onAppEvent(AppEvents.THEME_CHANGED, handler));
    },

    properties: {
      get title() { return ""; /* TODO: wire to actual workbook properties */ },
      get author() { return ""; },
      get sheetCount() { return 0; },
      getSheetNames() { return []; },
    },
  };
}

// ---- Sheet Context ----

function buildSheetContext(base: BaseObjectContext, cleanupFns: CleanupFn[]): SheetContext {
  return {
    ...base,
    objectType: "sheet" as const,

    onActivate(handler) {
      return tracked(cleanupFns, onAppEvent(AppEvents.SHEET_CHANGED, (detail) => {
        handler(detail as { sheetIndex: number; sheetName: string });
      }));
    },
    onDeactivate(handler) {
      // Emit on sheet change with the *previous* sheet info
      let lastSheet = { sheetIndex: -1, sheetName: "" };
      return tracked(cleanupFns, onAppEvent(AppEvents.SHEET_CHANGED, (detail) => {
        const d = detail as { sheetIndex: number; sheetName: string };
        if (lastSheet.sheetIndex >= 0) {
          handler(lastSheet);
        }
        lastSheet = { sheetIndex: d.sheetIndex, sheetName: d.sheetName };
      }));
    },
    onSelectionChange(handler) {
      const unsub = ExtensionRegistry.onSelectionChange((sel) => {
        handler({
          sheetIndex: sel.sheetIndex ?? 0,
          row: sel.row,
          col: sel.col,
          endRow: sel.endRow ?? sel.row,
          endCol: sel.endCol ?? sel.col,
        });
      });
      cleanupFns.push(unsub);
      return unsub;
    },
    onDataChange(handler) {
      return tracked(cleanupFns, onAppEvent(AppEvents.CELL_VALUES_CHANGED, (detail) => {
        const d = detail as { changes: Array<{ row: number; col: number; oldValue?: string; newValue: string }> };
        handler({ sheetIndex: 0, changes: d.changes });
      }));
    },

    getCellValue(_row, _col, _sheetIndex?) {
      // TODO: wire to backend getCellValue
      return "";
    },
    setCellValue(_row, _col, _value, _sheetIndex?) {
      // TODO: wire to backend setCellValue
    },
  };
}

// ---- Cell Context ----

function buildCellContext(base: BaseObjectContext, cleanupFns: CleanupFn[]): CellContext {
  return {
    ...base,
    objectType: "cell" as const,

    onEdit(handler) {
      return tracked(cleanupFns, onAppEvent(AppEvents.CELL_VALUES_CHANGED, (detail) => {
        const d = detail as { changes: Array<{ row: number; col: number; oldValue?: string; newValue: string; formula?: string | null }> };
        for (const change of d.changes) {
          handler({
            row: change.row,
            col: change.col,
            sheetIndex: 0,
            oldValue: change.oldValue,
            newValue: change.newValue,
            formula: change.formula,
          });
        }
      }));
    },
    onSelect(handler) {
      const unsub = ExtensionRegistry.onSelectionChange((sel) => {
        handler({ row: sel.row, col: sel.col, sheetIndex: sel.sheetIndex ?? 0 });
      });
      cleanupFns.push(unsub);
      return unsub;
    },
    onEditStart(handler) {
      return tracked(cleanupFns, onAppEvent(AppEvents.EDIT_STARTED, (detail) => {
        const d = detail as { row: number; col: number; sheetIndex?: number };
        handler({ row: d.row, col: d.col, sheetIndex: d.sheetIndex ?? 0 });
      }));
    },
    onEditEnd(handler) {
      return tracked(cleanupFns, onAppEvent(AppEvents.EDIT_ENDED, (detail) => {
        const d = detail as { row: number; col: number; sheetIndex?: number; committed?: boolean };
        handler({ row: d.row, col: d.col, sheetIndex: d.sheetIndex ?? 0, committed: d.committed ?? true });
      }));
    },
    onRender(handler) {
      // Register as a style interceptor so it runs during rendering
      const unsub = registerStyleInterceptor(
        `objectscript-cell-renderer`,
        (cellValue, _baseStyle, coords) => {
          const result = handler({
            row: coords.row,
            col: coords.col,
            sheetIndex: coords.sheetIndex ?? 0,
            value: cellValue,
            formula: null,
          });
          if (result) {
            return {
              ...(result.textColor && { textColor: result.textColor }),
              ...(result.backgroundColor && { backgroundColor: result.backgroundColor }),
              ...(result.bold !== undefined && { bold: result.bold }),
              ...(result.italic !== undefined && { italic: result.italic }),
            };
          }
          return null;
        },
        1000, // Low priority — runs after other interceptors
      );
      cleanupFns.push(unsub);
      return unsub;
    },
  };
}

// ---- Row Context ----

function buildRowContext(base: BaseObjectContext, cleanupFns: CleanupFn[]): RowContext {
  return {
    ...base,
    objectType: "row" as const,

    onInsert(handler) {
      return tracked(cleanupFns, onAppEvent(AppEvents.ROWS_INSERTED, (detail) => {
        handler(detail as { sheetIndex: number; startRow: number; count: number });
      }));
    },
    onDelete(handler) {
      return tracked(cleanupFns, onAppEvent(AppEvents.ROWS_DELETED, (detail) => {
        handler(detail as { sheetIndex: number; startRow: number; count: number });
      }));
    },
    onResize(handler) {
      // TODO: wire to row resize events when available
      void handler;
      return () => {};
    },
  };
}

// ---- Column Context ----

function buildColumnContext(base: BaseObjectContext, cleanupFns: CleanupFn[]): ColumnContext {
  return {
    ...base,
    objectType: "column" as const,

    onInsert(handler) {
      return tracked(cleanupFns, onAppEvent(AppEvents.COLUMNS_INSERTED, (detail) => {
        handler(detail as { sheetIndex: number; startCol: number; count: number });
      }));
    },
    onDelete(handler) {
      return tracked(cleanupFns, onAppEvent(AppEvents.COLUMNS_DELETED, (detail) => {
        handler(detail as { sheetIndex: number; startCol: number; count: number });
      }));
    },
    onResize(handler) {
      // TODO: wire to column resize events when available
      void handler;
      return () => {};
    },
  };
}

// ---- Slicer Context ----

function buildSlicerContext(
  base: BaseObjectContext,
  definition: ObjectScriptDefinition,
  cleanupFns: CleanupFn[],
): SlicerContext {
  const instanceId = definition.instanceId || "";

  return {
    ...base,
    objectType: "slicer" as const,
    instanceId,
    name: definition.name,

    onSelectionChange(handler) {
      return tracked(cleanupFns, onAppEvent("slicer:selectionChanged", (detail) => {
        const d = detail as { slicerId: string; selectedItems: string[] };
        if (String(d.slicerId) === instanceId) {
          handler({ selectedItems: d.selectedItems });
        }
      }));
    },
    onDataRefresh(handler) {
      return tracked(cleanupFns, onAppEvent("slicer:dataRefreshed", (detail) => {
        const d = detail as { slicerId: string; items: string[] };
        if (String(d.slicerId) === instanceId) {
          handler({ items: d.items });
        }
      }));
    },
    onResize(handler) {
      return tracked(cleanupFns, onAppEvent("slicer:resized", (detail) => {
        const d = detail as { slicerId: string; x: number; y: number; width: number; height: number };
        if (String(d.slicerId) === instanceId) {
          handler({ x: d.x, y: d.y, width: d.width, height: d.height });
        }
      }));
    },

    getSelectedItems() {
      // TODO: wire to slicer store
      return [];
    },
    setSelectedItems(_items) {
      // TODO: wire to slicer store
    },
    clearSelection() {
      // TODO: wire to slicer store
    },
    selectAll() {
      // TODO: wire to slicer store
    },

    style: {
      itemRenderer(_renderer) {
        // TODO: wire custom renderer into slicer rendering pipeline
        return () => {};
      },
      setProperty(_name, _value) {
        // TODO: wire to slicer DOM element styling
      },
    },

    properties: {
      get fieldName() { return ""; },
      get sourceType() { return ""; },
      get columns() { return 1; },
    },
  };
}

// ---- Chart Context ----

function buildChartContext(
  base: BaseObjectContext,
  definition: ObjectScriptDefinition,
  cleanupFns: CleanupFn[],
): ChartContext {
  const instanceId = definition.instanceId || "";

  return {
    ...base,
    objectType: "chart" as const,
    instanceId,

    onDataChange(handler) {
      return tracked(cleanupFns, onAppEvent(AppEvents.DATA_CHANGED, handler));
    },
    onClick(handler) {
      return tracked(cleanupFns, onAppEvent("chart:clicked", (detail) => {
        const d = detail as { chartId: string; x: number; y: number };
        if (String(d.chartId) === instanceId) {
          handler({ x: d.x, y: d.y });
        }
      }));
    },
    onResize(handler) {
      return tracked(cleanupFns, onAppEvent("chart:resized", (detail) => {
        const d = detail as { chartId: string; x: number; y: number; width: number; height: number };
        if (String(d.chartId) === instanceId) {
          handler({ x: d.x, y: d.y, width: d.width, height: d.height });
        }
      }));
    },

    getSpec() {
      // TODO: wire to chart store
      return {};
    },
    updateSpec(_patch) {
      // TODO: wire to chart store
    },

    style: {
      setProperty(_name, _value) {
        // TODO: wire to chart DOM element
      },
    },
  };
}

// ---- Pivot Context ----

function buildPivotContext(
  base: BaseObjectContext,
  definition: ObjectScriptDefinition,
  cleanupFns: CleanupFn[],
): PivotContext {
  const instanceId = definition.instanceId || "";

  return {
    ...base,
    objectType: "pivot" as const,
    instanceId,

    onRefresh(handler) {
      return tracked(cleanupFns, onAppEvent("pivot:refreshed", (detail) => {
        const d = detail as { pivotId: string };
        if (String(d.pivotId) === instanceId) {
          handler();
        }
      }));
    },
    onLayoutChange(handler) {
      return tracked(cleanupFns, onAppEvent("pivot:layoutChanged", (detail) => {
        const d = detail as { pivotId: string; rows: string[]; columns: string[]; values: string[]; filters: string[] };
        if (String(d.pivotId) === instanceId) {
          handler({ rows: d.rows, columns: d.columns, values: d.values, filters: d.filters });
        }
      }));
    },
    onResize(handler) {
      return tracked(cleanupFns, onAppEvent("pivot:resized", (detail) => {
        const d = detail as { pivotId: string; x: number; y: number; width: number; height: number };
        if (String(d.pivotId) === instanceId) {
          handler({ x: d.x, y: d.y, width: d.width, height: d.height });
        }
      }));
    },

    getFields() {
      // TODO: wire to pivot state
      return { rows: [], columns: [], values: [], filters: [] };
    },
    refresh() {
      // TODO: wire to pivot refresh
    },
  };
}

// ============================================================================
// Reset (for testing / workbook close)
// ============================================================================

/** Unmount all scripts and clear all registrations. */
export function resetObjectScriptManager(): void {
  for (const scriptId of mountedScripts.keys()) {
    ObjectScriptManager.unmountScript(scriptId);
  }
  registeredScripts.clear();
  mountedScripts.clear();
  changeListeners.clear();
}
