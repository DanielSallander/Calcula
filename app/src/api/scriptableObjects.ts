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
  | "timeline"
  | "shape";

/** Where a script came from — local (user-created) or distributed (from a .calp package). */
export type ScriptProvenance = "local" | "distributed";

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
  /** Where the script came from. Distributed scripts are read-only. */
  provenance?: ScriptProvenance;
  /** For distributed scripts: the package name it came from. */
  packageName?: string;
  /** Minimum required API version (semver). Checked on mount. */
  requiredApiVersion?: string;
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

  /**
   * Call a method exposed by another object's script.
   * @param targetType The object type (e.g., "slicer", "workbook").
   * @param targetInstanceId The instance ID (null for primitives).
   * @param methodName The method name registered via expose().
   * @param args Arguments to pass.
   * @returns The return value, or undefined if the method is not found.
   */
  callMethod(targetType: string, targetInstanceId: string | null, methodName: string, ...args: unknown[]): unknown;

  /** The current script API version. Scripts can check this for compatibility. */
  readonly apiVersion: string;

  /**
   * Full extension API access (only available in "unlocked" mode).
   * In "restricted" mode, this is null.
   */
  readonly api: UnlockedAPI | null;
}

/** Extended API surface available only in "unlocked" access mode. */
export interface UnlockedAPI {
  /** Read a cell value by row/col (active sheet). */
  getCellValue(row: number, col: number): Promise<string>;
  /** Write a cell value by row/col (active sheet). */
  setCellValue(row: number, col: number, value: string): Promise<void>;
  /** Batch-update multiple cells. */
  updateCellsBatch(updates: Array<{ row: number; col: number; value: string }>): Promise<void>;
  /** Get all sheet names. */
  getSheetNames(): Promise<string[]>;
  /** Get the active sheet index. */
  getActiveSheet(): Promise<number>;
  /** Set the active sheet. */
  setActiveSheet(index: number): Promise<void>;
  /** Emit a custom event on the global event bus. */
  emitEvent(name: string, detail?: unknown): void;
  /** Listen for a global event. Returns unsubscribe function. */
  onEvent(name: string, handler: (detail: unknown) => void): CleanupFn;
  /** Execute a registered command by ID. */
  executeCommand(commandId: string, ...args: unknown[]): void;

  // ---- Batch Transaction Support ----

  /**
   * Begin an undo transaction. All cell changes until commitBatch() are
   * grouped as a single undo entry.
   * @param description Human-readable description shown in the Undo menu.
   */
  beginBatch(description: string): Promise<void>;
  /** Commit the current batch, finalizing it as a single undo entry. */
  commitBatch(): Promise<void>;
  /** Cancel the current batch, discarding all changes since beginBatch(). */
  cancelBatch(): Promise<void>;
}

// ============================================================================
// Inter-Script Communication
// ============================================================================

/**
 * Global registry of methods exposed by object scripts.
 * Keyed by "{objectType}:{instanceId}:{methodName}" for components,
 * or "{objectType}:::{methodName}" for primitives.
 */
const globalExposedMethods = new Map<string, (...args: unknown[]) => unknown>();

function exposedMethodKey(objectType: string, instanceId: string | null, methodName: string): string {
  return `${objectType}:${instanceId || ""}:${methodName}`;
}

/** Register a method in the global exposed methods registry. */
function registerExposedMethod(
  objectType: string,
  instanceId: string | null,
  methodName: string,
  handler: (...args: unknown[]) => unknown,
): CleanupFn {
  const key = exposedMethodKey(objectType, instanceId, methodName);
  globalExposedMethods.set(key, handler);
  return () => globalExposedMethods.delete(key);
}

/**
 * Call an exposed method on another script.
 * @param targetType The object type of the target script.
 * @param targetInstanceId The instance ID (null for primitives).
 * @param methodName The method name registered via expose().
 * @param args Arguments to pass to the method.
 * @returns The return value of the method, or undefined if not found.
 */
export function callExposedMethod(
  targetType: string,
  targetInstanceId: string | null,
  methodName: string,
  ...args: unknown[]
): unknown {
  const key = exposedMethodKey(targetType, targetInstanceId, methodName);
  const handler = globalExposedMethods.get(key);
  if (!handler) {
    console.warn(`[ObjectScriptManager] Method not found: ${key}`);
    return undefined;
  }
  return handler(...args);
}

/** List all exposed methods (for debugging/inspection). */
export function listExposedMethods(): Array<{ objectType: string; instanceId: string | null; methodName: string }> {
  const result: Array<{ objectType: string; instanceId: string | null; methodName: string }> = [];
  for (const key of globalExposedMethods.keys()) {
    const parts = key.split(":");
    result.push({
      objectType: parts[0],
      instanceId: parts[1] || null,
      methodName: parts.slice(2).join(":"),
    });
  }
  return result;
}

// ============================================================================
// Script API Versioning
// ============================================================================

/**
 * Current version of the object script context API.
 * Follows semantic versioning. Scripts can declare a minimum required version.
 */
export const SCRIPT_API_VERSION = "1.0.0";

/** Parse a semver string into [major, minor, patch]. */
function parseSemVer(v: string): [number, number, number] {
  const parts = v.split(".").map(Number);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/** Check if an API version is compatible (same major, >= minor.patch). */
export function isApiVersionCompatible(required: string): boolean {
  const [reqMajor, reqMinor, reqPatch] = parseSemVer(required);
  const [curMajor, curMinor, curPatch] = parseSemVer(SCRIPT_API_VERSION);
  if (reqMajor !== curMajor) return false;
  if (reqMinor > curMinor) return false;
  if (reqMinor === curMinor && reqPatch > curPatch) return false;
  return true;
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
  getCellValue(row: number, col: number, sheetIndex?: number): Promise<string>;

  /** Write a cell value. */
  setCellValue(row: number, col: number, value: string, sheetIndex?: number): Promise<void>;
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
  setSelectedItems(items: string[]): Promise<void>;

  /** Clear all selections. */
  clearSelection(): Promise<void>;

  /** Select all items. */
  selectAll(): Promise<void>;

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
  updateSpec(patch: Record<string, unknown>): Promise<void>;

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
  refresh(): Promise<void>;
}

// ============================================================================
// Shape Context
// ============================================================================

/** A custom property declared by a shape script via render.declareProperties(). */
export interface DeclaredProperty {
  /** Property key for storage */
  key: string;
  /** Display label in the Properties pane */
  label: string;
  /** Input type */
  type: "text" | "color" | "number" | "boolean";
  /** Default value */
  defaultValue?: string;
}

/** Rendering bounds passed to custom canvas renderers. */
export interface ShapeRenderBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Context for Shape control instances. */
export interface ShapeContext extends BaseObjectContext {
  readonly objectType: "shape";
  /** Unique instance ID (e.g., "control-0-195-2") */
  readonly instanceId: string;
  /** Shape type identifier (e.g., "rectangle", "snipSingleCorner") */
  readonly shapeType: string;

  // -- Events --

  /** Called when the shape is clicked. */
  onClick(handler: EventHandler<{ x: number; y: number }>): CleanupFn;
  /** Called when the shape is resized. */
  onResize(handler: EventHandler<{ width: number; height: number }>): CleanupFn;
  /** Called when a property changes. */
  onPropertyChange(handler: EventHandler<{ key: string; oldValue: string; newValue: string }>): CleanupFn;

  // -- Property Access --

  /** Get the current resolved value of a shape property. */
  getProperty(key: string): string;
  /** Set a shape property value. */
  setProperty(key: string, value: string): Promise<void>;

  // -- Rendering --

  render: {
    /** Replace canvas rendering with an interactive HTML iframe overlay. */
    setHtmlContent(html: string): void;
    /** Send a message to the shape's HTML iframe. Use `window.addEventListener('shape-message', ...)` inside the iframe to receive. */
    sendMessage(type: string, data?: unknown): void;
    /** Listen for messages from the shape's HTML iframe. Inside the iframe, call `calcula.sendMessage(type, data)` to send. */
    onMessage(handler: EventHandler<{ type: string; data: unknown }>): CleanupFn;
    /** Provide a custom canvas render function (replaces default shape path rendering). */
    canvasRenderer(renderer: (ctx: CanvasRenderingContext2D, bounds: ShapeRenderBounds) => void): CleanupFn;
    /** Declare custom properties that appear in the Properties pane. */
    declareProperties(props: DeclaredProperty[]): void;
  };
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
  shape: ShapeContext;
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
      // Check API version compatibility
      if (definition.requiredApiVersion && !isApiVersionCompatible(definition.requiredApiVersion)) {
        throw new Error(
          `Script "${definition.name}" requires API version ${definition.requiredApiVersion} ` +
          `but the current version is ${SCRIPT_API_VERSION}. ` +
          `Please update Calcula to run this script.`
        );
      }

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
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      console.error(`[ObjectScriptManager] Failed to mount script "${definition.name}":`, error);
      emitAppEvent("objectscript:error", {
        scriptId: definition.id,
        scriptName: definition.name,
        error: errorMsg,
        stack: errorStack,
      });
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
import { getSlicerStoreService, getChartStoreService, getPivotStoreService } from "./componentStoreRegistry";

// Lazy imports for backend APIs (avoid circular deps at module load)
let _libModule: typeof import("./lib") | null = null;
async function getLib() {
  if (!_libModule) {
    _libModule = await import("./lib");
  }
  return _libModule;
}

let _backendModule: typeof import("./backend") | null = null;
async function getBackend() {
  if (!_backendModule) {
    _backendModule = await import("./backend");
  }
  return _backendModule;
}

/**
 * Build the unlocked API — full extension-level access to cells, sheets, events, commands.
 * Only constructed when accessLevel === "unlocked".
 */
function buildUnlockedAPI(cleanupFns: CleanupFn[]): UnlockedAPI {
  return {
    async getCellValue(row: number, col: number): Promise<string> {
      const lib = await getLib();
      const cell = await lib.getCell(row, col);
      return cell?.display ?? "";
    },
    async setCellValue(row: number, col: number, value: string): Promise<void> {
      const lib = await getLib();
      await lib.updateCell(row, col, value);
    },
    async updateCellsBatch(updates: Array<{ row: number; col: number; value: string }>): Promise<void> {
      const lib = await getLib();
      await lib.updateCellsBatch(updates.map((u) => ({ row: u.row, col: u.col, value: u.value })));
    },
    async getSheetNames(): Promise<string[]> {
      const lib = await getLib();
      const result = await lib.getSheets();
      return result.sheets.map((s: { name: string }) => s.name);
    },
    async getActiveSheet(): Promise<number> {
      const lib = await getLib();
      return lib.getActiveSheet();
    },
    async setActiveSheet(index: number): Promise<void> {
      const lib = await getLib();
      await lib.setActiveSheet(index);
    },
    emitEvent(name: string, detail?: unknown): void {
      emitAppEvent(name, detail);
    },
    onEvent(name: string, handler: (detail: unknown) => void): CleanupFn {
      const unsub = onAppEvent(name, handler);
      cleanupFns.push(unsub);
      return unsub;
    },
    executeCommand(commandId: string, ...args: unknown[]): void {
      import("./commands").then((mod) => {
        mod.CommandRegistry.execute(commandId, ...args);
      });
    },

    async beginBatch(description: string): Promise<void> {
      const lib = await getLib();
      await lib.beginUndoTransaction(description);
    },
    async commitBatch(): Promise<void> {
      const lib = await getLib();
      await lib.commitUndoTransaction();
    },
    async cancelBatch(): Promise<void> {
      const lib = await getLib();
      await lib.cancelUndoTransaction();
    },
  };
}

/**
 * Build the appropriate context object for a script definition.
 * Each context type gets its own set of lifecycle hooks and API surface.
 */
function buildObjectContext(
  definition: ObjectScriptDefinition,
  cleanupFns: CleanupFn[],
): BaseObjectContext {
  // Build unlocked API if access level permits
  const unlockedApi: UnlockedAPI | null = definition.accessLevel === "unlocked"
    ? buildUnlockedAPI(cleanupFns)
    : null;

  // Base context (shared by all types)
  const base: BaseObjectContext = {
    objectType: definition.objectType,
    accessLevel: definition.accessLevel,
    apiVersion: SCRIPT_API_VERSION,

    expose(name: string, handler: (...args: unknown[]) => unknown): CleanupFn {
      // Register in both local and global registries
      const globalCleanup = registerExposedMethod(
        definition.objectType,
        definition.instanceId,
        name,
        handler,
      );
      cleanupFns.push(globalCleanup);
      return globalCleanup;
    },

    callMethod(targetType: string, targetInstanceId: string | null, methodName: string, ...args: unknown[]): unknown {
      return callExposedMethod(targetType, targetInstanceId, methodName, ...args);
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

    api: unlockedApi,
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
    case "shape":
      return buildShapeContext(base, definition, cleanupFns);
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
  // Cache workbook properties (refreshed on open/save)
  let cachedProps: { title: string; author: string } = { title: "", author: "" };
  let cachedSheets: { count: number; names: string[] } = { count: 0, names: [] };

  // Load properties eagerly
  (async () => {
    try {
      const backend = await getBackend();
      const props = await backend.getWorkbookProperties();
      cachedProps = { title: props.title, author: props.author };
    } catch { /* ignore on startup */ }
    try {
      const lib = await getLib();
      const sheetsResult = await lib.getSheets();
      cachedSheets = {
        count: sheetsResult.sheets.length,
        names: sheetsResult.sheets.map((s: { name: string }) => s.name),
      };
    } catch { /* ignore */ }
  })();

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
      // Also refresh cached sheet data on sheet change
      const unsub = onAppEvent(AppEvents.SHEET_CHANGED, async (detail) => {
        try {
          const lib = await getLib();
          const sheetsResult = await lib.getSheets();
          cachedSheets = {
            count: sheetsResult.sheets.length,
            names: sheetsResult.sheets.map((s: { name: string }) => s.name),
          };
        } catch { /* ignore */ }
        handler(detail as { sheetIndex: number; sheetName: string });
      });
      return tracked(cleanupFns, unsub);
    },
    onThemeChange(handler) {
      return tracked(cleanupFns, onAppEvent(AppEvents.THEME_CHANGED, handler));
    },

    properties: {
      get title() { return cachedProps.title; },
      get author() { return cachedProps.author; },
      get sheetCount() { return cachedSheets.count; },
      getSheetNames() { return [...cachedSheets.names]; },
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

    async getCellValue(row, col, _sheetIndex?) {
      try {
        const lib = await getLib();
        const cellData = await lib.getCell(row, col);
        return cellData?.display ?? "";
      } catch {
        return "";
      }
    },
    async setCellValue(row, col, value, _sheetIndex?) {
      try {
        const lib = await getLib();
        await lib.updateCell(row, col, value);
      } catch (e) {
        console.error("[SheetContext] setCellValue failed:", e);
      }
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
      return tracked(cleanupFns, onAppEvent(AppEvents.ROW_RESIZED, (detail) => {
        handler(detail as { sheetIndex: number; row: number; height: number });
      }));
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
      return tracked(cleanupFns, onAppEvent(AppEvents.COLUMN_RESIZED, (detail) => {
        handler(detail as { sheetIndex: number; col: number; width: number });
      }));
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
      const store = getSlicerStoreService();
      if (store) {
        return store.getSelectedItems(Number(instanceId));
      }
      return [];
    },
    async setSelectedItems(items) {
      const store = getSlicerStoreService();
      if (store) {
        await store.setSelectedItems(Number(instanceId), items);
      }
    },
    async clearSelection() {
      const store = getSlicerStoreService();
      if (store) {
        await store.setSelectedItems(Number(instanceId), null);
      }
    },
    async selectAll() {
      const store = getSlicerStoreService();
      if (store) {
        await store.setSelectedItems(Number(instanceId), null);
      }
    },

    style: {
      itemRenderer(renderer) {
        const store = getSlicerStoreService();
        if (store) {
          const unsub = store.setItemRenderer(Number(instanceId), renderer);
          cleanupFns.push(unsub);
          return unsub;
        }
        return () => {};
      },
      setProperty(name, value) {
        const store = getSlicerStoreService();
        if (store) {
          store.setStyleProperty(Number(instanceId), name, value);
        }
      },
    },

    properties: {
      get fieldName() {
        const store = getSlicerStoreService();
        const slicer = store?.getSlicerById(Number(instanceId));
        return slicer?.fieldName ?? "";
      },
      get sourceType() {
        const store = getSlicerStoreService();
        const slicer = store?.getSlicerById(Number(instanceId));
        return slicer?.sourceType ?? "";
      },
      get columns() {
        const store = getSlicerStoreService();
        const slicer = store?.getSlicerById(Number(instanceId));
        return slicer?.columns ?? 1;
      },
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
      const store = getChartStoreService();
      if (store) {
        const chart = store.getChartById(Number(instanceId));
        if (chart) {
          try {
            return JSON.parse(chart.specJson);
          } catch { /* ignore parse errors */ }
        }
      }
      return {};
    },
    async updateSpec(patch) {
      const store = getChartStoreService();
      if (store) {
        store.updateChartSpec(Number(instanceId), patch);
      }
    },

    style: {
      setProperty(name, value) {
        const store = getChartStoreService();
        if (store) {
          store.setStyleProperty(Number(instanceId), name, value);
        }
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
      const store = getPivotStoreService();
      if (store) {
        return store.getPivotFields(Number(instanceId));
      }
      return { rows: [], columns: [], values: [], filters: [] };
    },
    async refresh() {
      const store = getPivotStoreService();
      if (store) {
        await store.refreshPivot(Number(instanceId));
      }
    },
  };
}

// ---- Shape Context ----

function buildShapeContext(
  base: BaseObjectContext,
  definition: ObjectScriptDefinition,
  cleanupFns: CleanupFn[],
): ShapeContext {
  const instanceId = definition.instanceId || "";

  // Cache for resolved properties
  const propertyCache = new Map<string, string>();

  // Eagerly fetch resolved properties from backend (same pattern as buildWorkbookContext)
  (async () => {
    try {
      // Parse instanceId: "control-{sheet}-{row}-{col}"
      const parts = instanceId.replace("control-", "").split("-");
      if (parts.length < 3) return;
      const sheetIndex = parseInt(parts[0], 10);
      const row = parseInt(parts[1], 10);
      const col = parseInt(parts[2], 10);
      if (isNaN(sheetIndex) || isNaN(row) || isNaN(col)) return;

      const { invokeBackend } = await import("./backend");
      const resolved = await invokeBackend<Record<string, string>>(
        "resolve_control_properties",
        { sheetIndex, row, col },
      );
      if (resolved) {
        for (const [key, value] of Object.entries(resolved)) {
          propertyCache.set(key, value);
        }
      }
    } catch {
      // Ignore errors during eager load — properties will be empty until set
    }
  })();

  return {
    ...base,
    objectType: "shape" as const,
    instanceId,

    get shapeType(): string {
      return propertyCache.get("shapeType") || "rectangle";
    },

    // -- Events --

    onClick(handler) {
      return tracked(cleanupFns, onAppEvent("shape:clicked", (detail) => {
        const d = detail as { instanceId: string; x: number; y: number };
        if (d.instanceId === instanceId) {
          handler({ x: d.x, y: d.y });
        }
      }));
    },

    onResize(handler) {
      return tracked(cleanupFns, onAppEvent("shape:resized", (detail) => {
        const d = detail as { instanceId: string; width: number; height: number };
        if (d.instanceId === instanceId) {
          handler({ width: d.width, height: d.height });
        }
      }));
    },

    onPropertyChange(handler) {
      return tracked(cleanupFns, onAppEvent("shape:propertyChanged", (detail) => {
        const d = detail as { instanceId: string; key: string; oldValue: string; newValue: string };
        if (d.instanceId === instanceId) {
          // Update local cache
          propertyCache.set(d.key, d.newValue);
          handler({ key: d.key, oldValue: d.oldValue, newValue: d.newValue });
        }
      }));
    },

    // -- Property Access --

    getProperty(key: string): string {
      return propertyCache.get(key) || "";
    },

    async setProperty(key: string, value: string): Promise<void> {
      const oldValue = propertyCache.get(key) || "";
      propertyCache.set(key, value);
      emitAppEvent("shape:setProperty", { instanceId, key, value, oldValue });
    },

    // -- Rendering --

    render: {
      setHtmlContent(html: string): void {
        emitAppEvent("shape:setHtmlContent", { instanceId, html });
      },

      sendMessage(type: string, data?: unknown): void {
        emitAppEvent("shape:sendMessage", { instanceId, type, data });
      },

      onMessage(handler: EventHandler<{ type: string; data: unknown }>): CleanupFn {
        return tracked(cleanupFns, onAppEvent("shape:htmlMessage", (detail) => {
          const d = detail as { instanceId: string; type: string; data: unknown };
          if (d.instanceId === instanceId) {
            handler({ type: d.type, data: d.data });
          }
        }));
      },

      canvasRenderer(renderer: (ctx: CanvasRenderingContext2D, bounds: ShapeRenderBounds) => void): CleanupFn {
        emitAppEvent("shape:setCanvasRenderer", { instanceId, renderer });
        const cleanup = () => {
          emitAppEvent("shape:removeCanvasRenderer", { instanceId });
        };
        cleanupFns.push(cleanup);
        return cleanup;
      },

      declareProperties(props: DeclaredProperty[]): void {
        emitAppEvent("shape:declareProperties", { instanceId, props });
      },
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
  globalExposedMethods.clear();
}
