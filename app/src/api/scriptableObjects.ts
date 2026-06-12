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
  | "shape"
  // UI objects (per-instance scripts, keyed by panel ID)
  | "panel";

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
   * @param options Pass { public: true } to allow calls from scripts of a
   *                different tier or package (defaults to same-trust only).
   */
  expose(name: string, handler: (...args: unknown[]) => unknown, options?: { public?: boolean }): CleanupFn;

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
   * Cross-tier or cross-package calls require the target to have been
   * exposed with `{ public: true }`.
   * @param targetType The object type (e.g., "slicer", "workbook").
   * @param targetInstanceId The instance ID (null for primitives).
   * @param methodName The method name registered via expose().
   * @param args Arguments to pass.
   * @returns Promise of the return value, or undefined if the method is not found.
   */
  callMethod(targetType: string, targetInstanceId: string | null, methodName: string, ...args: unknown[]): Promise<unknown>;

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
  /** Execute a registered command by ID. Args are forwarded to the handler unchanged. */
  executeCommand(commandId: string, args?: unknown): void;

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

// Exposed methods live in the broker's host registry (scriptHost/broker.ts),
// which carries owner identity and the public flag for cross-tier policy.
// The host-side helpers below remain for trusted (extension/test) callers.

import {
  brokerCall,
  brokerCallSync,
  BrokerError,
  buildHandleFromDefinition,
  callExposed,
  clearExposed,
  hostCallExposed,
  listExposed,
  registerExposed,
  registerMountedHandle,
  scriptEmitEventName,
  scriptSubscribeEventName,
  type ScriptHandle,
} from "./scriptHost/broker";
import {
  hostMountScript,
  hostUnmountScript,
  hostResetAll,
  workerRealmAvailable,
} from "./scriptHost/host";

/**
 * Call an exposed method on another script from TRUSTED host code
 * (extensions, tests). Host callers are not subject to the cross-tier
 * public:true policy — that policy governs script-to-script calls.
 * @returns The return value of the method, or undefined if not found.
 */
export function callExposedMethod(
  targetType: string,
  targetInstanceId: string | null,
  methodName: string,
  ...args: unknown[]
): unknown {
  return hostCallExposed(targetType, targetInstanceId, methodName, args);
}

/** List all exposed methods (for debugging/inspection). */
export function listExposedMethods(): Array<{ objectType: string; instanceId: string | null; methodName: string }> {
  return listExposed().map((m) => ({
    objectType: m.objectType,
    instanceId: m.instanceId,
    methodName: m.methodName,
  }));
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

  /** Get current pivot field configuration. */
  getFields(): { rows: string[]; columns: string[]; values: string[]; filters: string[] };

  /** Refresh the pivot table data. */
  refresh(): Promise<void>;
}

// ============================================================================
// Panel Context (ribbon tabs & sidebar views)
// ============================================================================

/** Context for Panel instances (ribbon tabs and sidebar views). */
export interface PanelContext extends BaseObjectContext {
  readonly objectType: "panel";

  /** The panel ID (matches the PanelDefinition.id used during registration). */
  readonly instanceId: string;

  /** The panel title. */
  readonly title: string;

  /** Called when the panel tab/icon is clicked by the user. */
  onClick(handler: EventHandler<{ placement: string }>): CleanupFn;

  /** Called when the panel becomes the active tab or view. */
  onActivate(handler: EventHandler<{ placement: string }>): CleanupFn;

  /** Called when the panel loses active state (another tab/view selected). */
  onDeactivate(handler: EventHandler<{ placement: string }>): CleanupFn;

  /** Called when the panel is moved between ribbon and sidebar. */
  onPlacementChange(handler: EventHandler<{ oldPlacement: string; newPlacement: string }>): CleanupFn;

  /** Called when the panel becomes visible (opened/expanded). */
  onShow(handler: EventHandler): CleanupFn;

  /** Called when the panel is hidden (closed/collapsed). */
  onHide(handler: EventHandler): CleanupFn;

  // -- Actions --

  /** Open (activate) this panel programmatically. */
  open(): void;

  /** Close (hide) this panel. For sidebar panels, collapses the side panel. */
  close(): void;

  /**
   * Set a badge on the panel's tab/icon (e.g., notification count).
   * Pass null or empty string to clear the badge.
   */
  setBadge(text: string | null): void;

  /**
   * Move this panel to a different location.
   * @param placement "ribbon" or "sidebar"
   */
  moveTo(placement: "ribbon" | "sidebar"): void;

  /** Panel properties (read-only). */
  readonly properties: {
    readonly panelId: string;
    readonly title: string;
    readonly placement: string;
    readonly movable: boolean;
  };
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

  // -- Cell Data Binding --

  /** Read a cell value by reference (e.g., "A1", "B5"). Returns the display value. */
  getCellValue(cellRef: string): Promise<string>;
  /** Called when any cell value changes. Use to re-render when source data updates. */
  onCellChange(handler: EventHandler<{ changes: Array<{ row: number; col: number; newValue: string }> }>): CleanupFn;

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
  panel: PanelContext;
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

      if (useWorkerRealm()) {
        // Worker realm (sandbox Phase 3): the script executes in its own
        // Worker with no ambient authority; every privileged call comes
        // back as an RPC through the broker. Unmount = terminate.
        await hostMountScript({
          id: definition.id,
          name: definition.name,
          objectType: definition.objectType,
          instanceId: definition.instanceId,
          source: definition.source,
          accessLevel: definition.accessLevel,
          provenance: definition.provenance,
          packageName: definition.packageName,
          apiVersion: SCRIPT_API_VERSION,
        });
        mounted.cleanupFns.push(() => hostUnmountScript(definition.id));
        mountedScripts.set(scriptId, mounted);
        return;
      }

      // Legacy main-thread path (test environments + dual-run soak A/B).
      // Host-side identity for the broker: tier/origin/grants from the
      // authoritative definition, registered for the transparency panel.
      const handle = buildScriptHandle(definition);
      mounted.cleanupFns.push(registerMountedHandle(handle));

      // Build the context for this object type
      const context = buildObjectContext(definition, handle, mounted.cleanupFns);

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

// Active sheet index tracked for event payloads: CELL_VALUES_CHANGED carries
// no sheet index, and UI edits always target the active sheet, so the active
// index at event time identifies the edited sheet.
let activeSheetIndexForEvents = 0;
onAppEvent(AppEvents.SHEET_CHANGED, (detail) => {
  const d = detail as { sheetIndex?: number } | undefined;
  if (d && typeof d.sheetIndex === "number") {
    activeSheetIndexForEvents = d.sheetIndex;
  }
});

// Each cell onRender registration needs its own interceptor slot — a fixed id
// would let two cell scripts silently clobber each other's renderer.
let cellRendererSeq = 0;

let _backendModule: typeof import("./backend") | null = null;
async function getBackend() {
  if (!_backendModule) {
    _backendModule = await import("./backend");
  }
  return _backendModule;
}

/**
 * Build the host-side identity for a script. Tier/origin/grants come from
 * the authoritative definition — never from anything the script supplies.
 * (Single source of truth lives in the broker; both mount paths use it.)
 */
function buildScriptHandle(definition: ObjectScriptDefinition): ScriptHandle {
  return buildHandleFromDefinition(definition);
}

/**
 * Whether scripts execute in their own worker realms (the Phase 3 default)
 * or on the main thread (the legacy path, kept for the dual-run soak —
 * set localStorage "calcula.scriptWorker" = "0" to A/B against it; the
 * legacy path is deleted when the soak gate passes). Test environments
 * (jsdom) have no Worker and use the legacy path automatically.
 */
function useWorkerRealm(): boolean {
  if (!workerRealmAvailable()) {
    return false;
  }
  try {
    return window.localStorage.getItem("calcula.scriptWorker") !== "0";
  } catch {
    return true;
  }
}

/**
 * Build the unlocked API — full extension-level access to cells, sheets,
 * events, commands. Only constructed when accessLevel === "unlocked".
 * Every method routes through the tier broker (policy + audit).
 */
function buildUnlockedAPI(handle: ScriptHandle, cleanupFns: CleanupFn[]): UnlockedAPI {
  return {
    getCellValue(row: number, col: number): Promise<string> {
      return brokerCall(handle, "api.getCellValue", [row, col], async () => {
        const lib = await getLib();
        const cell = await lib.getCell(row, col);
        return cell?.display ?? "";
      });
    },
    setCellValue(row: number, col: number, value: string): Promise<void> {
      return brokerCall(handle, "api.setCellValue", [row, col, value], async () => {
        const lib = await getLib();
        await lib.updateCell(row, col, value);
      });
    },
    updateCellsBatch(updates: Array<{ row: number; col: number; value: string }>): Promise<void> {
      return brokerCall(handle, "api.updateCellsBatch", [updates], async () => {
        const lib = await getLib();
        await lib.updateCellsBatch(updates.map((u) => ({ row: u.row, col: u.col, value: u.value })));
      });
    },
    getSheetNames(): Promise<string[]> {
      return brokerCall(handle, "api.getSheetNames", [], async () => {
        const lib = await getLib();
        const result = await lib.getSheets();
        return result.sheets.map((s: { name: string }) => s.name);
      });
    },
    getActiveSheet(): Promise<number> {
      return brokerCall(handle, "api.getActiveSheet", [], async () => {
        const lib = await getLib();
        return lib.getActiveSheet();
      });
    },
    setActiveSheet(index: number): Promise<void> {
      return brokerCall(handle, "api.setActiveSheet", [index], async () => {
        const lib = await getLib();
        await lib.setActiveSheet(index);
      });
    },
    emitEvent(name: string, detail?: unknown): void {
      // Force-namespaced userscript:* — scripts can never forge internal
      // control events (symmetric with onEvent, so custom names still work).
      brokerCallSync(handle, "api.emitEvent", [name], () => {
        emitAppEvent(scriptEmitEventName(name), detail);
      });
    },
    onEvent(name: string, handler: (detail: unknown) => void): CleanupFn {
      return brokerCallSync(handle, "api.onEvent", [name], () => {
        const unsub = onAppEvent(scriptSubscribeEventName(name), handler);
        cleanupFns.push(unsub);
        return unsub;
      });
    },
    executeCommand(commandId: string, args?: unknown): void {
      brokerCall(handle, "api.executeCommand", [commandId], async () => {
        const mod = await import("./commands");
        if (!mod.CommandRegistry.isScriptSafe(commandId)) {
          throw new BrokerError(
            "PermissionDenied",
            `Command '${commandId}' is not flagged scriptSafe; scripts may only run commands their extension has audited for script use`,
          );
        }
        await mod.CommandRegistry.execute(commandId, args);
      }).catch((e) => {
        console.warn(`[Script:${handle.scriptName}] executeCommand failed:`, e);
        emitAppEvent("objectscript:console", {
          scriptId: handle.scriptId,
          level: "warn",
          args: [`executeCommand('${commandId}') failed: ${e instanceof Error ? e.message : e}`],
        });
      });
    },

    beginBatch(description: string): Promise<void> {
      return brokerCall(handle, "api.beginBatch", [description], async () => {
        const lib = await getLib();
        await lib.beginUndoTransaction(description);
      });
    },
    commitBatch(): Promise<void> {
      return brokerCall(handle, "api.commitBatch", [], async () => {
        const lib = await getLib();
        await lib.commitUndoTransaction();
      });
    },
    cancelBatch(): Promise<void> {
      return brokerCall(handle, "api.cancelBatch", [], async () => {
        const lib = await getLib();
        await lib.cancelUndoTransaction();
      });
    },
  };
}

/**
 * Build the appropriate context object for a script definition.
 * Each context type gets its own set of lifecycle hooks and API surface.
 */
function buildObjectContext(
  definition: ObjectScriptDefinition,
  handle: ScriptHandle,
  cleanupFns: CleanupFn[],
): BaseObjectContext {
  // Build unlocked API if access level permits
  const unlockedApi: UnlockedAPI | null = definition.accessLevel === "unlocked"
    ? buildUnlockedAPI(handle, cleanupFns)
    : null;

  // Base context (shared by all types). Every sanctioned call routes through
  // the tier broker so policy is enforced and audited in one place.
  const base: BaseObjectContext = {
    objectType: definition.objectType,
    accessLevel: definition.accessLevel,
    apiVersion: SCRIPT_API_VERSION,

    expose(name: string, handler: (...args: unknown[]) => unknown, options?: { public?: boolean }): CleanupFn {
      return brokerCallSync(handle, "base.expose", [name, handler, options], () => {
        const cleanup = registerExposed(handle, name, handler, options?.public === true);
        cleanupFns.push(cleanup);
        return cleanup;
      });
    },

    callMethod(targetType: string, targetInstanceId: string | null, methodName: string, ...args: unknown[]): Promise<unknown> {
      return brokerCall(handle, "base.callMethod", [targetType, targetInstanceId, methodName], () =>
        callExposed(handle, targetType, targetInstanceId, methodName, args),
      );
    },

    log(...args: unknown[]): void {
      brokerCallSync(handle, "base.log", args, () => {
        console.log(`[Script:${definition.name}]`, ...args);
        emitAppEvent("objectscript:console", {
          scriptId: definition.id,
          level: "log",
          args,
        });
      });
    },

    notify(message: string, type?: "info" | "success" | "warning" | "error"): void {
      brokerCallSync(handle, "base.notify", [message, type], () => {
        showToast(message, { type: type || "info" });
      });
    },

    api: unlockedApi,
  };

  // Build type-specific context
  switch (definition.objectType) {
    case "workbook":
      return buildWorkbookContext(base, cleanupFns);
    case "sheet":
      return buildSheetContext(base, handle, cleanupFns);
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
    case "panel":
      return buildPanelContext(base, definition, cleanupFns);
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

function buildSheetContext(base: BaseObjectContext, handle: ScriptHandle, cleanupFns: CleanupFn[]): SheetContext {
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
        if (!sel) return;
        const row = sel.row ?? sel.startRow;
        const col = sel.col ?? sel.startCol;
        handler({
          sheetIndex: sel.sheetIndex ?? 0,
          row,
          col,
          endRow: sel.endRow ?? row,
          endCol: sel.endCol ?? col,
        });
      });
      cleanupFns.push(unsub);
      return unsub;
    },
    onDataChange(handler) {
      return tracked(cleanupFns, onAppEvent(AppEvents.CELL_VALUES_CHANGED, (detail) => {
        const d = detail as { changes: Array<{ row: number; col: number; oldValue?: string; newValue: string }> };
        handler({ sheetIndex: activeSheetIndexForEvents, changes: d.changes });
      }));
    },

    async getCellValue(row, col, sheetIndex?) {
      try {
        return await brokerCall(handle, "sheet.getCellValue", [row, col, sheetIndex], async () => {
          const lib = await getLib();
          if (sheetIndex !== undefined) {
            const active = await lib.getActiveSheet();
            if (sheetIndex !== active) {
              // R16 clamp: restricted sheet scripts can only touch their own
              // (active) sheet; cross-sheet reach is unlocked-tier territory.
              if (handle.tier !== "unlocked") {
                throw new BrokerError(
                  "PermissionDenied",
                  "Restricted sheet scripts can only access their own sheet",
                );
              }
              const results = await lib.getWatchCells([[sheetIndex, row, col]]);
              return results[0]?.display ?? "";
            }
          }
          const cellData = await lib.getCell(row, col);
          return cellData?.display ?? "";
        });
      } catch (e) {
        if (e instanceof BrokerError) throw e;
        return "";
      }
    },
    async setCellValue(row, col, value, sheetIndex?) {
      try {
        await brokerCall(handle, "sheet.setCellValue", [row, col, value, sheetIndex], async () => {
          const lib = await getLib();
          if (sheetIndex !== undefined) {
            const active = await lib.getActiveSheet();
            if (sheetIndex !== active) {
              if (handle.tier !== "unlocked") {
                throw new BrokerError(
                  "PermissionDenied",
                  "Restricted sheet scripts can only access their own sheet",
                );
              }
              // update_cell_on_sheets handles non-active sheets; the active
              // sheet goes through the regular update path below.
              await lib.updateCellOnSheets([sheetIndex], row, col, value);
              return;
            }
          }
          await lib.updateCell(row, col, value);
        });
        return;
      } catch (e) {
        if (e instanceof BrokerError) throw e;
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
            sheetIndex: activeSheetIndexForEvents,
            oldValue: change.oldValue,
            newValue: change.newValue,
            formula: change.formula,
          });
        }
      }));
    },
    onSelect(handler) {
      const unsub = ExtensionRegistry.onSelectionChange((sel) => {
        if (!sel) return;
        handler({ row: sel.row ?? sel.startRow, col: sel.col ?? sel.startCol, sheetIndex: sel.sheetIndex ?? 0 });
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
        `objectscript-cell-renderer-${++cellRendererSeq}`,
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
    getSelectedItems() {
      const store = getSlicerStoreService();
      if (store) {
        return store.getSelectedItems(instanceId);
      }
      return [];
    },
    async setSelectedItems(items) {
      const store = getSlicerStoreService();
      if (store) {
        await store.setSelectedItems(instanceId, items);
      }
    },
    async clearSelection() {
      const store = getSlicerStoreService();
      if (store) {
        // Empty set = nothing selected (filter excludes all items).
        // selectAll passes null = no filter (all items). The two are distinct.
        await store.setSelectedItems(instanceId, []);
      }
    },
    async selectAll() {
      const store = getSlicerStoreService();
      if (store) {
        await store.setSelectedItems(instanceId, null);
      }
    },

    style: {
      itemRenderer(renderer) {
        const store = getSlicerStoreService();
        if (store) {
          const unsub = store.setItemRenderer(instanceId, renderer);
          cleanupFns.push(unsub);
          return unsub;
        }
        return () => {};
      },
      setProperty(name, value) {
        const store = getSlicerStoreService();
        if (store) {
          store.setStyleProperty(instanceId, name, value);
        }
      },
    },

    properties: {
      get fieldName() {
        const store = getSlicerStoreService();
        const slicer = store?.getSlicerById(instanceId);
        return slicer?.fieldName ?? "";
      },
      get sourceType() {
        const store = getSlicerStoreService();
        const slicer = store?.getSlicerById(instanceId);
        return slicer?.sourceType ?? "";
      },
      get columns() {
        const store = getSlicerStoreService();
        const slicer = store?.getSlicerById(instanceId);
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
      // Resolve the chart's source range from its spec so cell edits outside
      // the range don't fire. String sources (A1 refs / named ranges) cannot
      // be resolved here and fall back to any-change behavior.
      const getSourceRange = () => {
        const store = getChartStoreService();
        const chart = store?.getChartById(instanceId);
        if (!chart) return null;
        try {
          const spec = JSON.parse(chart.specJson) as { data?: unknown };
          const d = spec.data as
            | { sheetIndex?: number; startRow?: number; startCol?: number; endRow?: number; endCol?: number }
            | string
            | undefined;
          if (
            d && typeof d === "object" &&
            typeof d.startRow === "number" && typeof d.endRow === "number" &&
            typeof d.startCol === "number" && typeof d.endCol === "number"
          ) {
            return d as { sheetIndex?: number; startRow: number; startCol: number; endRow: number; endCol: number };
          }
        } catch { /* unparseable spec — fall back to any-change */ }
        return null;
      };
      const unsubCells = onAppEvent(AppEvents.CELL_VALUES_CHANGED, (detail) => {
        const range = getSourceRange();
        if (range) {
          if (range.sheetIndex !== undefined && range.sheetIndex !== activeSheetIndexForEvents) return;
          const d = detail as { changes?: Array<{ row: number; col: number }> };
          const hit = d.changes?.some(
            (c) =>
              c.row >= range.startRow && c.row <= range.endRow &&
              c.col >= range.startCol && c.col <= range.endCol,
          );
          if (!hit) return;
        }
        handler(undefined);
      });
      cleanupFns.push(unsubCells);
      // Bulk operations (sort, import, recalc) signal through DATA_CHANGED
      // without per-cell coordinates — always forward those.
      const unsubBulk = onAppEvent(AppEvents.DATA_CHANGED, handler);
      cleanupFns.push(unsubBulk);
      return () => {
        unsubCells();
        unsubBulk();
      };
    },
    getSpec() {
      const store = getChartStoreService();
      if (store) {
        const chart = store.getChartById(instanceId);
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
        store.updateChartSpec(instanceId, patch);
      }
    },

    style: {
      setProperty(name, value) {
        const store = getChartStoreService();
        if (store) {
          store.setStyleProperty(instanceId, name, value);
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
      // "pivot:refresh" is the live refresh signal (FilterPane, Slicer bridge,
      // Pivot menus, undo/redo). Most emitters dispatch it without a detail
      // payload (refresh-all); when a pivotId is present, filter on it.
      return tracked(cleanupFns, onAppEvent("pivot:refresh", (detail) => {
        const d = detail as { pivotId?: string } | undefined;
        if (d?.pivotId !== undefined && String(d.pivotId) !== instanceId) {
          return;
        }
        handler();
      }));
    },

    getFields() {
      const store = getPivotStoreService();
      if (store) {
        return store.getPivotFields(instanceId);
      }
      return { rows: [], columns: [], values: [], filters: [] };
    },
    async refresh() {
      const store = getPivotStoreService();
      if (store) {
        await store.refreshPivot(instanceId);
      }
    },
  };
}

// ---- Shape Context ----

/**
 * Parse a cell reference like "A1" or "AB123" into {row, col} (0-based).
 * Returns null if the reference is invalid.
 */
function parseCellRef(ref: string): { row: number; col: number } | null {
  const trimmed = ref.trim().toUpperCase();
  const match = trimmed.match(/^([A-Z]{1,3})(\d+)$/);
  if (!match) return null;
  const letters = match[1];
  const rowNum = parseInt(match[2], 10);
  if (isNaN(rowNum) || rowNum < 1) return null;
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return { row: rowNum - 1, col: col - 1 };
}

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

    // -- Cell Data Binding --

    async getCellValue(cellRef: string): Promise<string> {
      const parsed = parseCellRef(cellRef);
      if (!parsed) return "";
      try {
        const lib = await getLib();
        const cell = await lib.getCell(parsed.row, parsed.col);
        return cell?.display ?? "";
      } catch {
        return "";
      }
    },

    onCellChange(handler) {
      return tracked(cleanupFns, onAppEvent(AppEvents.CELL_VALUES_CHANGED, (detail) => {
        const d = detail as { changes: Array<{ row: number; col: number; newValue: string }> };
        handler({ changes: d.changes });
      }));
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

// ---- Panel Context ----

function buildPanelContext(
  base: BaseObjectContext,
  definition: ObjectScriptDefinition,
  cleanupFns: CleanupFn[],
): PanelContext {
  const instanceId = definition.instanceId || "";

  // Cache placement info, updated via events
  let cachedPlacement = "unknown";
  let cachedMovable = true;

  // Listen for placement metadata broadcast (emitted by shell on registration and change)
  const placementUnsub = onAppEvent("panel:metadata", (detail) => {
    const d = detail as { panelId: string; placement: string; movable: boolean };
    if (d.panelId === instanceId) {
      cachedPlacement = d.placement;
      cachedMovable = d.movable;
    }
  });
  cleanupFns.push(placementUnsub);

  // Also update on placement change events
  const changeUnsub = onAppEvent("panel:placementChanged", (detail) => {
    const d = detail as { panelId: string; newPlacement: string };
    if (d.panelId === instanceId) {
      cachedPlacement = d.newPlacement;
    }
  });
  cleanupFns.push(changeUnsub);

  return {
    ...base,
    objectType: "panel" as const,
    instanceId,
    title: definition.name,

    onClick(handler) {
      return tracked(cleanupFns, onAppEvent("panel:clicked", (detail) => {
        const d = detail as { panelId: string; placement: string };
        if (d.panelId === instanceId) {
          handler({ placement: d.placement });
        }
      }));
    },

    onActivate(handler) {
      return tracked(cleanupFns, onAppEvent("panel:activated", (detail) => {
        const d = detail as { panelId: string; placement: string };
        if (d.panelId === instanceId) {
          handler({ placement: d.placement });
        }
      }));
    },

    onDeactivate(handler) {
      return tracked(cleanupFns, onAppEvent("panel:deactivated", (detail) => {
        const d = detail as { panelId: string; placement: string };
        if (d.panelId === instanceId) {
          handler({ placement: d.placement });
        }
      }));
    },

    onPlacementChange(handler) {
      return tracked(cleanupFns, onAppEvent("panel:placementChanged", (detail) => {
        const d = detail as { panelId: string; oldPlacement: string; newPlacement: string };
        if (d.panelId === instanceId) {
          handler({ oldPlacement: d.oldPlacement, newPlacement: d.newPlacement });
        }
      }));
    },

    onShow(handler) {
      return tracked(cleanupFns, onAppEvent("panel:shown", (detail) => {
        const d = detail as { panelId: string };
        if (d.panelId === instanceId) {
          handler();
        }
      }));
    },

    onHide(handler) {
      return tracked(cleanupFns, onAppEvent("panel:hidden", (detail) => {
        const d = detail as { panelId: string };
        if (d.panelId === instanceId) {
          handler();
        }
      }));
    },

    // -- Actions --

    open() {
      emitAppEvent("panel:open", { panelId: instanceId });
    },

    close() {
      emitAppEvent("panel:close", { panelId: instanceId });
    },

    setBadge(text: string | null) {
      emitAppEvent("panel:setBadge", { panelId: instanceId, text: text || "" });
    },

    moveTo(placement: "ribbon" | "sidebar") {
      emitAppEvent("panel:moveTo", { panelId: instanceId, placement });
    },

    properties: {
      get panelId() { return instanceId; },
      get title() { return definition.name; },
      get placement() { return cachedPlacement; },
      get movable() { return cachedMovable; },
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
  clearExposed();
  hostResetAll();
}
