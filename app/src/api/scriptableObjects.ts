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
  | "table"
  | "namedRange"
  // UI objects (per-instance scripts, keyed by panel ID)
  | "panel";

/** Where a script came from — local (user-created) or distributed (from a .calp package). */
export type ScriptProvenance = "local" | "distributed";

import type { CapabilityId } from "./scriptHost/allowlist";

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
  /**
   * The authoritative declared-capability ceiling (R19). For local scripts the
   * backend derives this from the source `// @capability` pragmas; for
   * distributed scripts it comes from the package manifest at pull time. The
   * broker rejects any capability not in this set (PermissionDenied) before the
   * grant check, so a distributed script's source can never widen its ceiling.
   */
  declaredCapabilities?: CapabilityId[];
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
  clearExposed,
  hostCallExposed,
  listExposed,
} from "./scriptHost/broker";
import {
  hostMountScript,
  hostUnmountScript,
  hostResetAll,
} from "./scriptHost/host";
import { emitAppEvent } from "./events";

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

/** Context for Button control instances — the canonical "click a button, run
 *  your code" surface (the #1 VBA entry point). The handler can read/write the
 *  grid via `api` (unlocked scripts), `notify`, call exposed methods, etc. */
export interface ButtonContext extends BaseObjectContext {
  readonly objectType: "button";
  /** Unique instance ID (e.g., "control-0-5-10"). */
  readonly instanceId: string;

  /** Called when the button is clicked (run mode). */
  onClick(handler: EventHandler<{ x: number; y: number }>): CleanupFn;
}

/** Context for Table (ListObject) instances — the most-automated VBA object.
 *  The instanceId is the table's EntityId. Cell reads/writes resolve through
 *  the table's grid coordinates (host-side) so they recalc and are undoable. */
export interface TableContext extends BaseObjectContext {
  readonly objectType: "table";
  /** The table instance ID (the table's EntityId string). */
  readonly instanceId: string;
  /** The table name. */
  readonly name: string;

  /** Called when any cell inside the table's range changes. */
  onDataChange(handler: EventHandler<{ changes: Array<{ row: number; col: number; newValue: string }> }>): CleanupFn;

  /** Get the table's column header names (sync, seeded from the mount snapshot). */
  getHeaders(): string[];
  /** Get the number of data rows in the table (sync, seeded). */
  getRowCount(): number;

  /** Read a table cell by 0-based data row + 0-based column index (async). */
  getCellValue(row: number, colIndex: number): Promise<string>;
  /** Write a table cell by 0-based data row + 0-based column index (async, undoable). */
  setCellValue(row: number, colIndex: number, value: string): Promise<void>;
  /** Append a new data row to the table (async, undoable). */
  addRow(): Promise<void>;

  /** Table properties (read-only, mirror-backed). */
  readonly properties: {
    readonly name: string;
    readonly sheetIndex: number;
    readonly rowCount: number;
  };
}

/** Context for Named Range instances — the Excel `Name` object. The instanceId
 *  is the name string. Reads are seeded/refreshed from the resolved range;
 *  writes resolve to grid coordinates host-side (recalc + undoable). */
export interface NamedRangeContext extends BaseObjectContext {
  readonly objectType: "namedRange";
  /** The named range instance ID (the name string). */
  readonly instanceId: string;
  /** The name. */
  readonly name: string;

  /** Called when any cell inside the resolved range changes. */
  onChange(handler: EventHandler<{ changes: Array<{ row: number; col: number; newValue: string }> }>): CleanupFn;

  /** Get the resolved A1 address (e.g., "Sheet1!A1:B10"). Sync, seeded. */
  getAddress(): string;
  /** Get the range's values as a 2D array of display strings. Sync, seeded + refreshed on change. */
  getValues(): string[][];
  /** Write a 2D array of values into the range (async, undoable). */
  setValues(values: string[][]): Promise<void>;

  /** Named range properties (read-only, mirror-backed). */
  readonly properties: {
    readonly refersTo: string;
    readonly scope: string;
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
  button: ButtonContext;
  textbox: BaseObjectContext;
  timeline: BaseObjectContext;
  shape: ShapeContext;
  table: TableContext;
  namedRange: NamedRangeContext;
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
        declaredCapabilities: definition.declaredCapabilities,
        apiVersion: SCRIPT_API_VERSION,
      });
      mounted.cleanupFns.push(() => hostUnmountScript(definition.id));
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
