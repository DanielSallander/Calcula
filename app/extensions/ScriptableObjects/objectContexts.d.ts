// Auto-generated type declarations for Object Script contexts.
// These types are loaded into Monaco's TypeScript language service
// for IntelliSense in the Code Editor dialog.
//
// To regenerate: keep in sync with app/src/api/scriptableObjects.ts

// ============================================================================
// Base
// ============================================================================

/** Extended API surface available only in "unlocked" access mode. */
declare interface UnlockedAPI {
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
  onEvent(name: string, handler: (detail: unknown) => void): () => void;
  /** Execute a registered command by ID. Args are forwarded to the handler unchanged. */
  executeCommand(commandId: string, args?: unknown): void;
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

/** Base context available to all scriptable objects. */
declare interface BaseObjectContext {
  /** The object type. */
  readonly objectType: string;
  /** The script access level: "restricted" or "unlocked". */
  readonly accessLevel: string;
  /** The current script API version (semver). */
  readonly apiVersion: string;
  /**
   * Expose a custom method that other scripts or extensions can call.
   * The method becomes callable from other scripts via callMethod().
   * Pass { public: true } to allow calls from scripts of a different
   * tier or package; otherwise only same-trust scripts can call it.
   * @returns Cleanup function to unregister.
   */
  expose(name: string, handler: (...args: any[]) => any, options?: { public?: boolean }): () => void;
  /**
   * Call a method exposed by another object's script. Asynchronous: await
   * the result. Cross-tier or cross-package calls require the target to
   * have been exposed with { public: true }.
   * @param targetType The object type (e.g., "slicer", "workbook").
   * @param targetInstanceId The instance ID (null for primitives).
   * @param methodName The method name registered via expose().
   * @param args Arguments to pass.
   * @returns Promise of the return value, or undefined if the method is not found.
   */
  callMethod(targetType: string, targetInstanceId: string | null, methodName: string, ...args: any[]): Promise<any>;
  /** Log to the script console (visible in the Code tab output panel). */
  log(...args: any[]): void;
  /** Show a toast notification to the user. */
  notify(message: string, type?: "info" | "success" | "warning" | "error"): void;
  /**
   * Sandboxed capability surface. Requires the net.fetch capability, granted
   * just-in-time (Allow once / always / Deny) on first use, or via package consent.
   */
  caps: {
    fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string>; text(): string; json(): unknown }>;
  };
  /**
   * Full extension API access (only available in "unlocked" mode).
   * In "restricted" mode, this is null.
   */
  readonly api: UnlockedAPI | null;
}

// ============================================================================
// Primitive Contexts (workbook-scoped)
// ============================================================================

/** Context for Workbook-level scripts. */
declare interface WorkbookContext extends BaseObjectContext {
  /** Called when the workbook is opened. */
  onOpen(handler: () => void): () => void;
  /** Called before the workbook is saved. */
  onBeforeSave(handler: () => void): () => void;
  /** Called after the workbook is saved. */
  onAfterSave(handler: () => void): () => void;
  /** Called before the workbook is closed. */
  onBeforeClose(handler: () => void): () => void;
  /** Called when the active sheet changes. */
  onSheetChange(handler: (detail: { sheetIndex: number; sheetName: string }) => void): () => void;
  /** Called when the theme changes. */
  onThemeChange(handler: () => void): () => void;
  /** Access workbook properties. */
  readonly properties: {
    readonly title: string;
    readonly author: string;
    readonly sheetCount: number;
    getSheetNames(): string[];
  };
}

/** Context for Sheet-level scripts (applies to all sheets). */
declare interface SheetContext extends BaseObjectContext {
  /** Called when any sheet is activated (switched to). */
  onActivate(handler: (detail: { sheetIndex: number; sheetName: string }) => void): () => void;
  /** Called when any sheet is deactivated (switched away from). */
  onDeactivate(handler: (detail: { sheetIndex: number; sheetName: string }) => void): () => void;
  /** Called when the selection changes on any sheet. */
  onSelectionChange(handler: (detail: { sheetIndex: number; row: number; col: number; endRow: number; endCol: number }) => void): () => void;
  /** Called when data changes on any sheet. */
  onDataChange(handler: (detail: { sheetIndex: number; changes: Array<{ row: number; col: number; oldValue?: string; newValue: string }> }) => void): () => void;
  /** Read a cell value from the specified (or active) sheet. */
  getCellValue(row: number, col: number, sheetIndex?: number): Promise<string>;
  /** Write a cell value. */
  setCellValue(row: number, col: number, value: string, sheetIndex?: number): Promise<void>;
}

/** Context for Cell-level scripts (applies to all cells). */
declare interface CellContext extends BaseObjectContext {
  /** Called when any cell is edited (value committed). */
  onEdit(handler: (detail: { row: number; col: number; sheetIndex: number; oldValue?: string; newValue: string; formula?: string | null }) => void): () => void;
  /** Called when a cell is selected. */
  onSelect(handler: (detail: { row: number; col: number; sheetIndex: number }) => void): () => void;
  /** Called when editing starts on a cell. */
  onEditStart(handler: (detail: { row: number; col: number; sheetIndex: number }) => void): () => void;
  /** Called when editing ends (commit or cancel). */
  onEditEnd(handler: (detail: { row: number; col: number; sheetIndex: number; committed: boolean }) => void): () => void;
  /**
   * Register a custom cell renderer that runs for every visible cell.
   * Return a style override object to modify appearance, or null to use default.
   *
   * MUST be a pure function of its cell argument (value + coordinates):
   * results are cached and re-evaluated only when the cell changes. A
   * renderer reading outside state degrades to stale styling — call
   * render.invalidate() after changing such state to force re-evaluation.
   */
  onRender(handler: (cell: { row: number; col: number; sheetIndex: number; value: string; formula?: string | null }) => { textColor?: string; backgroundColor?: string; bold?: boolean; italic?: boolean } | null): () => void;
  /** Cache controls for onRender. */
  render: {
    /** Clear this script's cached render results and repaint. */
    invalidate(): void;
  };
}

/** Context for Row-level scripts (applies to all rows). */
declare interface RowContext extends BaseObjectContext {
  /** Called when rows are inserted. */
  onInsert(handler: (detail: { sheetIndex: number; startRow: number; count: number }) => void): () => void;
  /** Called when rows are deleted. */
  onDelete(handler: (detail: { sheetIndex: number; startRow: number; count: number }) => void): () => void;
  /** Called when a row height changes. */
  onResize(handler: (detail: { sheetIndex: number; row: number; height: number }) => void): () => void;
}

/** Context for Column-level scripts (applies to all columns). */
declare interface ColumnContext extends BaseObjectContext {
  /** Called when columns are inserted. */
  onInsert(handler: (detail: { sheetIndex: number; startCol: number; count: number }) => void): () => void;
  /** Called when columns are deleted. */
  onDelete(handler: (detail: { sheetIndex: number; startCol: number; count: number }) => void): () => void;
  /** Called when a column width changes. */
  onResize(handler: (detail: { sheetIndex: number; col: number; width: number }) => void): () => void;
}

// ============================================================================
// Component Contexts (per-instance)
// ============================================================================

/** Context for Slicer instances. */
declare interface SlicerContext extends BaseObjectContext {
  /** The slicer instance ID. */
  readonly instanceId: string;
  /** The slicer name. */
  readonly name: string;
  /** Called when slicer selection changes (items are selected/deselected). */
  onSelectionChange(handler: (detail: { selectedItems: string[] }) => void): () => void;
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
    itemRenderer(renderer: (
      item: { text: string; selected: boolean; hasData: boolean; index: number },
      ctx: CanvasRenderingContext2D,
      bounds: { x: number; y: number; width: number; height: number },
    ) => void): () => void;
    /**
     * Set a canvas-style property on the slicer.
     * Supported: backgroundColor, headerBackgroundColor, headerTextColor,
     *            itemBackgroundColor, itemTextColor, selectedBackgroundColor,
     *            selectedTextColor, borderColor, borderRadius, opacity.
     */
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
declare interface ChartContext extends BaseObjectContext {
  /** The chart instance ID. */
  readonly instanceId: string;
  /** Called when the chart's source data changes. */
  onDataChange(handler: () => void): () => void;
  /** Get the chart specification (JSON object). */
  getSpec(): Record<string, unknown>;
  /** Update the chart specification (merge patch). */
  updateSpec(patch: Record<string, unknown>): Promise<void>;
  /** Style customization. */
  style: {
    /** Set a canvas-style property override (stored in chart spec). */
    setProperty(name: string, value: string): void;
  };
}

/** Context for Pivot Table instances. */
declare interface PivotContext extends BaseObjectContext {
  /** The pivot instance ID. */
  readonly instanceId: string;
  /** Called when the pivot is refreshed (recalculated). */
  onRefresh(handler: () => void): () => void;
  /** Get current pivot field configuration. */
  getFields(): { rows: string[]; columns: string[]; values: string[]; filters: string[] };
  /** Refresh the pivot table data. */
  refresh(): Promise<void>;
}

// ============================================================================
// Panel Context (ribbon tabs & sidebar views)
// ============================================================================

/** Context for Panel instances (ribbon tabs and sidebar views). */
declare interface PanelContext extends BaseObjectContext {
  /** The panel ID (matches the PanelDefinition.id used during registration). */
  readonly instanceId: string;
  /** The panel title. */
  readonly title: string;

  // -- Events --

  /** Called when the panel tab/icon is clicked by the user. */
  onClick(handler: (detail: { placement: string }) => void): () => void;
  /** Called when the panel becomes the active tab or view. */
  onActivate(handler: (detail: { placement: string }) => void): () => void;
  /** Called when the panel loses active state (another tab/view selected). */
  onDeactivate(handler: (detail: { placement: string }) => void): () => void;
  /** Called when the panel is moved between ribbon and sidebar. */
  onPlacementChange(handler: (detail: { oldPlacement: string; newPlacement: string }) => void): () => void;
  /** Called when the panel becomes visible (opened/expanded). */
  onShow(handler: () => void): () => void;
  /** Called when the panel is hidden (closed/collapsed). */
  onHide(handler: () => void): () => void;

  // -- Actions --

  /** Open (activate) this panel programmatically. */
  open(): void;
  /** Close (hide) this panel. For sidebar panels, collapses the side panel. */
  close(): void;
  /** Set a badge on the panel's tab/icon (e.g., notification count). Pass null to clear. */
  setBadge(text: string | null): void;
  /** Move this panel to a different location ("ribbon" or "sidebar"). */
  moveTo(placement: "ribbon" | "sidebar"): void;

  /** Panel properties (read-only). */
  readonly properties: {
    /** Panel ID. */
    readonly panelId: string;
    /** Panel title. */
    readonly title: string;
    /** Current placement: "ribbon" or "sidebar". */
    readonly placement: string;
    /** Whether the panel can be moved between locations. */
    readonly movable: boolean;
  };
}

// ============================================================================
// Shape Context
// ============================================================================

/** A custom property declared by a shape script. */
declare interface DeclaredProperty {
  key: string;
  label: string;
  type: "text" | "color" | "number" | "boolean";
  defaultValue?: string;
}

/** Rendering bounds passed to custom canvas renderers. */
declare interface ShapeRenderBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Context for Shape control instances. */
declare interface ShapeContext extends BaseObjectContext {
  /** Unique instance ID (e.g., "control-0-195-2"). */
  readonly instanceId: string;
  /** Shape type identifier (e.g., "rectangle", "snipSingleCorner"). */
  readonly shapeType: string;

  /** Called when the shape is clicked. */
  onClick(handler: (detail: { x: number; y: number }) => void): () => void;
  /** Called when the shape is resized. */
  onResize(handler: (detail: { width: number; height: number }) => void): () => void;
  /** Called when a property value changes. */
  onPropertyChange(handler: (detail: { key: string; oldValue: string; newValue: string }) => void): () => void;

  /** Get the current resolved value of a shape property. */
  getProperty(key: string): string;
  /** Set a shape property value. */
  setProperty(key: string, value: string): Promise<void>;

  /** Read a cell value by reference (e.g., "A1", "B5"). Returns the display value. */
  getCellValue(cellRef: string): Promise<string>;
  /** Called when any cell value changes. Use to re-render when source data updates. */
  onCellChange(handler: (detail: { changes: Array<{ row: number; col: number; newValue: string }> }) => void): () => void;

  /** Rendering methods. */
  render: {
    /** Replace canvas rendering with an interactive HTML iframe overlay. */
    setHtmlContent(html: string): void;
    /** Send a message to the shape's HTML iframe. Inside the iframe, listen via `window.addEventListener('shape-message', (e) => { e.detail.type, e.detail.data })`. */
    sendMessage(type: string, data?: unknown): void;
    /** Listen for messages sent from the shape's HTML iframe via `calcula.sendMessage(type, data)`. */
    onMessage(handler: (detail: { type: string; data: unknown }) => void): () => void;
    /** Provide a custom canvas render function (replaces default shape path rendering). */
    canvasRenderer(renderer: (ctx: CanvasRenderingContext2D, bounds: ShapeRenderBounds) => void): () => void;
    /** Declare custom properties that appear in the Properties pane. */
    declareProperties(props: DeclaredProperty[]): void;
  };
}
