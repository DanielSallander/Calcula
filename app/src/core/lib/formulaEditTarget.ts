//! FILENAME: app/src/core/lib/formulaEditTarget.ts
// PURPOSE: External formula edit session seam for the grid AND the formula bar.
// CONTEXT: An extension-owned editor (e.g. a floating grid's cell editor)
// can register itself as the active formula edit target. While the target
// reports that it is expecting a reference, grid clicks that would normally
// insert a reference into the internal editor are routed to the target
// instead (see useMouseSelection/useSpreadsheetSelection).
//
// ONE MODULE OWNS EVERY PIECE OF EXTERNAL-EDIT STATE (2026-09-27,
// docs: scratchpad fr-edit-design.md section 1). It holds:
//   - the PICK slot (`registerExternalFormulaTarget`), which optionally carries
//     the two-view edit SESSION (`ExternalFormulaTarget.session`);
//   - the selection-scoped CELL slot (`publishExternalCellTarget`): an external
//     cell that is "the active cell" with NO edit open (a selected floating-grid
//     cell), which the formula bar shows and edits and the Name Box names;
//   - ONE explicit `parked` state (the session's host sheet is not the one the
//     grid shows), written only by pointModeSheetSwitch.ts;
//   - the Name Box address-resolver slot;
//   - ONE store (one version counter) for all of the above.
//
// THE SESSION LIVES IN EXACTLY ONE PLACE: `getExternalFormulaTarget().session`.
// The cell target never holds a session; its `beginEdit()` creates one, which
// registers itself in the pick slot synchronously. So "the bar's session" and
// "the grid pick's session" are the same object by construction and cannot
// drift.
//
// `resolveFormulaBarSource()` is the ONLY way the shell reads any of it.
//
// NOTE: This is a Core primitive with NO imports. It reads neither the DOM nor
// the grid state. The API layer re-exports it (@api/editing, @api/externalEdit).

// ============================================================================
// Types
// ============================================================================

/**
 * A grid reference routed to an external formula edit session.
 * Coordinates are normalized (start <= end). sheetName is the ACTIVE sheet's
 * name so external targets can always produce a sheet-qualified reference;
 * null only when no sheet name is available.
 */
export interface ExternalFormulaReference {
  sheetName: string | null;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** Where the caret goes after a commit: the grid's own Enter/Tab moves. */
export type ExternalEditMove = "down" | "up" | "right" | "left" | null;

/** Which view owns the caret: the owner's in-place editor, or the formula bar. */
export type ExternalEditView = "cell" | "bar";

/**
 * A two-view edit session: ONE edit that the owner's in-place editor and the
 * formula bar both show. Owned by the extension that opened it (the floating
 * grid's cell editor); Core and the shell only drive it through this contract.
 */
export interface ExternalEditSession {
  /** Name Box text of the edited cell ("Float1!A1"). May be a getter (a rename re-derives it). */
  readonly address: string;
  /** TRUE workbook index of the sheet hosting the edited object; fixed for the session. */
  readonly hostSheetIndex: number;
  /** The edited cell in the OWNER's coordinates (FR-local). Only a function builder's context uses it. */
  readonly anchor: { readonly row: number; readonly col: number };
  /** The ONE text of the edit (both views show it). */
  getText(): string;
  /** Caret in getText(): the in-place editor's selectionStart while view === "cell", else the stored caret. */
  getCursor(): number;
  getView(): ExternalEditView;
  /**
   * Bar -> session. No-op (and NO notify) when text and caret are both
   * unchanged. Marks the edit touched when the text changed. NEVER changes the
   * view (only a focus does).
   */
  setText(text: string, cursor: number): void;
  /** Bar caret moved without a text change (onSelect / onFocus). Never notifies. */
  setCursor(cursor: number): void;
  /** The bar took focus: view := "bar". Idempotent; notifies only on a change. */
  adoptBarView(): void;
  /** Give the caret to the in-place view (focus + caret). No-op while parked. */
  focusCellView(): void;
  /**
   * Commit through the owner's own write path. Tears the session down
   * SYNCHRONOUSLY before its first await (so the slot is empty when this
   * returns control). Resolves true when the value was written or there was
   * nothing to write, false when the owner refused (the owner has already told
   * the user).
   */
  commit(move: ExternalEditMove): Promise<boolean>;
  cancel(): void;
  /** Core -> owner, on a parked FLIP only: hide (true) / re-show (false) the in-place view. */
  onParkedChanged(parked: boolean): void;
}

/**
 * An external editor that can receive grid cell references while its formula
 * is expecting one (same "expecting reference" semantics as the internal
 * editor's isFormulaExpectingReference check).
 */
export interface ExternalFormulaTarget {
  /** Whether the target's formula currently expects a reference at the cursor. */
  isExpectingReference(): boolean;
  /** Insert the picked reference into the target's formula at the cursor. */
  insertReference(ref: ExternalFormulaReference): void;
  /**
   * Present when this target is a two-view edit session (a floating grid's
   * cell editor). ABSENT for pick-only targets -- the chart text editor
   * (core/lib/overlayTextEditor.ts) -- which keep exactly the historical
   * behaviour: no sheet-switch survival, no bar mirroring, no liveness gate.
   */
  readonly session?: ExternalEditSession;
}

/**
 * The selected external cell: exists with NO open edit (a floating grid's
 * selected cell). Published by its owner; the formula bar shows `content`, the
 * Name Box shows `address`, and focusing the bar calls `beginEdit`.
 */
export interface ExternalCellTarget {
  /** Name Box text: "Float1!A1", "Float1!A1:B3", "'My Float'!A1". */
  readonly address: string;
  /**
   * Bar text at rest: formula ?? display of the ACTIVE (anchor) cell. null =
   * the read is in flight (the bar shows "" -- never another cell's text).
   */
  readonly content: string | null;
  /** The bar refuses focus when true. */
  readonly readOnly: boolean;
  /**
   * Open (or adopt) an edit session on the active cell WITHOUT taking focus
   * (view "bar"); `seed` replaces the text (fx passes "="). Returns the session
   * (already registered in the pick slot) or null.
   */
  beginEdit(seed?: string): ExternalEditSession | null;
}

/** What the formula bar shows, in precedence order: session > cell > none. */
export type FormulaBarSource =
  | { readonly kind: "session"; readonly session: ExternalEditSession }
  | { readonly kind: "cell"; readonly cell: ExternalCellTarget }
  | { readonly kind: "none" };

/** A Name Box entry an extension recognised as one of its own addresses. */
export interface ExternalAddressResolution {
  /** TRUE index of the sheet hosting the addressed object (the Name Box switches there first). */
  readonly hostSheetIndex: number;
  /** Select the addressed cells. Resolves null on success, or the sentence the Name Box shows. */
  go(): Promise<string | null>;
}

/** Recognise a Name Box entry, or return null (the Name Box then tries its own branches). */
export type ExternalAddressResolver = (text: string) => ExternalAddressResolution | null;

// ============================================================================
// Internal State
// ============================================================================

// Single slot: at most one external formula edit session can be active.
// A later registration replaces an earlier one (last-writer-wins).
let activeTarget: ExternalFormulaTarget | null = null;

/**
 * The sheet the grid shows while the live session is PARKED (its host is not
 * on screen), or null. Explicit on purpose: derived from the grid-state
 * snapshot it would lag a dispatch until the next render, and every hit test
 * in that window would read the wrong answer.
 */
let parkedView: number | null = null;

let cellSlot: { owner: string; target: ExternalCellTarget } | null = null;

let addressResolver: ExternalAddressResolver | null = null;

let version = 0;
const listeners = new Set<() => void>();

// ============================================================================
// Store
// ============================================================================

/** Subscribe to every change of the external-edit state. Returns the unsubscribe. */
export function subscribeExternalEdit(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A number that changes whenever anything in this module changes (useSyncExternalStore snapshot). */
export function getExternalEditVersion(): number {
  return version;
}

/**
 * The owner calls this after any change the shell must show (text typed in the
 * in-place view, a pick, an async initial load, a view change).
 */
export function notifyExternalEditChanged(): void {
  version++;
  // A COPY: a listener that unsubscribes (or subscribes) while being notified
  // must not change who hears this notification.
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error("[formulaEditTarget] listener threw:", err);
    }
  }
}

// ============================================================================
// Pick slot
// ============================================================================

/**
 * Register an external formula edit target.
 * @returns A cleanup function that unregisters the target. The cleanup is
 * identity-checked: it only clears the slot if this target still occupies it,
 * so a stale cleanup cannot tear down a newer session's registration.
 *
 * A new registration starts UN-parked; the identity-checked clear also clears
 * `parked` WITHOUT calling `onParkedChanged` (the session is gone). Both set and
 * clear notify.
 */
export function registerExternalFormulaTarget(target: ExternalFormulaTarget): () => void {
  activeTarget = target;
  parkedView = null;
  notifyExternalEditChanged();
  return () => {
    if (activeTarget === target) {
      activeTarget = null;
      parkedView = null;
      notifyExternalEditChanged();
    }
  };
}

/**
 * Get the currently registered external formula target, or null when none.
 */
export function getExternalFormulaTarget(): ExternalFormulaTarget | null {
  return activeTarget;
}

// ============================================================================
// Session predicates
// ============================================================================

/** The live two-view session, or null (no target, or a pick-only target). */
export function getExternalEditSession(): ExternalEditSession | null {
  return activeTarget?.session ?? null;
}

/**
 * THE "external edit is live" signal Core reads (the pointer door's keyboard
 * rule, the grid keyboard, the container keydown, commit-before-select, the
 * double-click door). A pick-only target (the chart text editor) is NOT live.
 */
export function isExternalEditLive(): boolean {
  return getExternalEditSession() !== null;
}

/** True while the live session's host sheet is not the one the grid shows. */
export function isExternalSessionParked(): boolean {
  return parkedView !== null && isExternalEditLive();
}

/** The sheet the grid shows while parked; null when not parked. */
export function getParkedViewSheetIndex(): number | null {
  return isExternalSessionParked() ? parkedView : null;
}

function sessionExpectsReference(): boolean {
  try {
    return activeTarget?.isExpectingReference() === true;
  } catch (err) {
    console.error("[formulaEditTarget] isExpectingReference threw:", err);
    return false;
  }
}

/**
 * A tab click is point-mode navigation: a live session AND (it is expecting a
 * reference OR it is parked -- while parked, ANY tab click, including the one
 * back to the host, is navigation, never an ordinary switch).
 */
export function isCrossSheetPointMode(): boolean {
  if (!isExternalEditLive()) return false;
  return isExternalSessionParked() || sessionExpectsReference();
}

/**
 * Primitive snapshot for useSyncExternalStore in SheetTabs: null (no session)
 * or `${hostSheetIndex}:${parked?1:0}:${expecting?1:0}` -- so the tab strip
 * re-renders when those change, not on every keystroke.
 */
export function getCrossSheetPointModeKey(): string | null {
  const session = getExternalEditSession();
  if (!session) return null;
  return `${session.hostSheetIndex}:${isExternalSessionParked() ? 1 : 0}:${sessionExpectsReference() ? 1 : 0}`;
}

/**
 * CORE-INTERNAL: only pointModeSheetSwitch.ts calls it; NOT re-exported through
 * @api. parked := live && viewed !== null && viewed !== session.hostSheetIndex.
 * On a parked FLIP it calls session.onParkedChanged(parked); notifies on any
 * change (including the viewed index).
 */
export function setExternalSessionParked(viewedSheetIndex: number | null): void {
  const session = getExternalEditSession();
  const next =
    session !== null && viewedSheetIndex !== null && viewedSheetIndex !== session.hostSheetIndex
      ? viewedSheetIndex
      : null;
  if (next === parkedView) return;
  const wasParked = parkedView !== null;
  parkedView = next;
  const isParked = next !== null;
  if (session && wasParked !== isParked) {
    try {
      session.onParkedChanged(isParked);
    } catch (err) {
      console.error("[formulaEditTarget] onParkedChanged threw:", err);
    }
  }
  notifyExternalEditChanged();
}

// ============================================================================
// Cell slot
// ============================================================================

function sameCellData(a: ExternalCellTarget, b: ExternalCellTarget): boolean {
  return a.address === b.address && a.content === b.content && a.readOnly === b.readOnly;
}

/**
 * Single slot, last writer wins. `null` withdraws ONLY when `owner` still holds
 * the slot (identity by owner key -- a stale withdraw cannot remove a newer
 * publisher). There is no fallback to an older publication: a withdrawn WRITE
 * target is gone. Notifies only when owner/address/content/readOnly changed;
 * the stored object is always replaced, so handlers read live state.
 */
export function publishExternalCellTarget(owner: string, target: ExternalCellTarget | null): void {
  if (target === null) {
    if (cellSlot === null || cellSlot.owner !== owner) return;
    cellSlot = null;
    notifyExternalEditChanged();
    return;
  }
  const previous = cellSlot;
  cellSlot = { owner, target };
  if (previous && previous.owner === owner && sameCellData(previous.target, target)) return;
  notifyExternalEditChanged();
}

/** The published selected external cell, or null. */
export function getExternalCellTarget(): ExternalCellTarget | null {
  return cellSlot?.target ?? null;
}

// ============================================================================
// The read path for the shell
// ============================================================================

const NO_SOURCE: FormulaBarSource = Object.freeze({ kind: "none" as const });

/**
 * session > cell > none. Returns a NEW object for session/cell: never use it as
 * a useSyncExternalStore snapshot (use the version, or the primitive getters).
 * "A Core edit wins" is applied by the caller, which has Core `editing`.
 */
export function resolveFormulaBarSource(): FormulaBarSource {
  const session = getExternalEditSession();
  if (session) return { kind: "session", session };
  const cell = getExternalCellTarget();
  if (cell) return { kind: "cell", cell };
  return NO_SOURCE;
}

/** session?.address ?? cell?.address ?? null (primitive; safe as a uSES snapshot). */
export function getExternalNameBoxAddress(): string | null {
  const session = getExternalEditSession();
  if (session) return session.address;
  return getExternalCellTarget()?.address ?? null;
}

// ============================================================================
// Name Box resolver slot
// ============================================================================

/** Single slot, last writer wins, identity-checked cleanup. Registering does not notify. */
export function registerExternalAddressResolver(resolver: ExternalAddressResolver): () => void {
  addressResolver = resolver;
  return () => {
    if (addressResolver === resolver) addressResolver = null;
  };
}

/**
 * Ask the registered resolver whether `text` is one of its addresses. Null when
 * no resolver is registered, when it declines, or when it throws (logged) --
 * the Name Box then falls through to its own branches.
 */
export function resolveExternalAddress(text: string): ExternalAddressResolution | null {
  if (!addressResolver) return null;
  try {
    return addressResolver(text);
  } catch (err) {
    console.error("[formulaEditTarget] address resolver threw:", err);
    return null;
  }
}

// ============================================================================
// DOM contract
// ============================================================================

/**
 * Whether `el` is the formula bar's editor. InlineEditor.tsx and FormulaInput.tsx
 * already agree on the attribute; this is the one place the selector is spelled.
 */
export function isFormulaBarElement(el: unknown): boolean {
  const candidate = el as { getAttribute?: (name: string) => string | null } | null | undefined;
  return typeof candidate?.getAttribute === "function" && candidate.getAttribute("data-formula-bar") === "true";
}

// ============================================================================
// Tests only (not re-exported through @api)
// ============================================================================

/** Resets every slot, parked, resolver and version, then notifies. Does NOT drop listeners. */
export function __resetExternalEditForTests(): void {
  activeTarget = null;
  parkedView = null;
  cellSlot = null;
  addressResolver = null;
  version = 0;
  notifyExternalEditChanged();
}
