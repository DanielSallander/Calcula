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
//     grid shows), written only by pointModeSheetSwitch.ts -- the VIEWED sheet
//     held by identity too (its stable id, else its name), so it is followed
//     when the sheets are renumbered under a parked edit;
//   - the live session's HOST by IDENTITY (`host`: its stable id, else its
//     name): parking, the return to the host and the tab strip's "is this the
//     host's tab" decide by it, because the sheets are renumbered -- and can be
//     renamed -- under an open edit. The owner hands its host's stable id over
//     with the session (`ExternalEditSession.hostSheetId`), so it is known from
//     the first moment, never only after a trip away;
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
  /**
   * TRUE workbook index of the sheet hosting the edited object WHEN THE EDIT
   * OPENED; the owner never changes it. Core does not act on it after that:
   * a temporary sheet's discard, a delete, a move or a copy -- the strip's, an
   * MCP tool's or a script's -- renumbers the sheets under an open edit, so
   * Core follows the host by IDENTITY (`getExternalSessionHostIndex`,
   * `isExternalSessionHostSheet`; reviews TSHELL4-DISCARD-LANDS-UNDER-OPEN-EDIT,
   * F3-strip-uses-owner-host-index).
   */
  readonly hostSheetIndex: number;
  /**
   * The STABLE id of the sheet hosting the edited object, when the owner knows
   * it (a floating range's `hostSheetId`); absent or "" when it does not (an
   * older backend). Core seeds the host's identity with it at registration, so
   * "is this sheet the host" is decided by the id from the moment the edit
   * opens -- never by `hostSheetIndex` until a first trip away taught Core
   * better: a renumbering before that trip left the opening index naming
   * another sheet (review FR-RESYNC-COMMITS-ON-RENUMBER).
   */
  readonly hostSheetId?: string;
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
   * Insert already-built, SHEET-QUALIFIED formula text at the cursor: what a
   * pick produces that is not a cell range -- a whole column or row picked
   * from a header ("Sheet1!C:C", "Sheet1!3:5", "Sheet1!1:1048576" from the
   * select-all corner) or a GETPIVOTDATA call built for a pivot cell (E2).
   * Optional: a target without it receives cell ranges only, and a header
   * pick inserts nothing into it (a GETPIVOTDATA pick falls back to the plain
   * cell reference).
   */
  insertText?(text: string): void;
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
   * The cell is a NON-ANCHOR cell of a spill (Excel's "ghost"): `content` is
   * the anchor's formula, and the bar shows it GREYED, exactly as it greys a
   * grid spill cell (FormulaInput's `isSpillRef`). The owner also sets
   * `readOnly` -- the formula lives in the anchor, not here. Absent = false.
   */
  readonly spillGhost?: boolean;
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

/** A sheet as Core holds it for the live session: its TRUE index NOW, and -- when known -- its name and STABLE id. */
interface SessionSheet {
  index: number;
  name?: string;
  sheetId?: string;
}

/**
 * The sheet the grid shows while the live session is PARKED (its host is not
 * on screen), or null. Explicit on purpose: derived from the grid-state
 * snapshot it would lag a dispatch until the next render, and every hit test
 * in that window would read the wrong answer.
 *
 * Held by IDENTITY as well as by index (review FR-RESYNC-COMMITS-ON-RENUMBER):
 * a temporary sheet's discard, a script's or an MCP tool's delete, move or copy
 * renumbers the VIEWED sheet under a parked edit exactly as it renumbers the
 * host, and a bare index then named whichever sheet slid into it. Every such
 * door moves the grid by dispatching the sheet's context with its stable id,
 * and pointModeSheetSwitch.ts re-decides the park for the sheet the grid shows
 * then (`followShownSheetForExternalSession`): the view at its index NOW, or
 * un-parked when the grid is back on the host.
 */
let parkedView: SessionSheet | null = null;

/**
 * The live session's HOST by IDENTITY: its STABLE sheet id (the owner's own,
 * else the one the grid's context carried), its sheet NAME, and the TRUE index
 * Core last found it at. The owner's `session.hostSheetIndex` is the index the host had when the
 * edit opened, and code that never heard of the edit renumbers the sheets
 * underneath it (a temporary sheet's discard, a delete, a move, a copy -- MCP
 * and scripts included, which tell the tab strip nothing), and can rename the
 * host. Parking, the return to the host and the strip's host-tab decision
 * compare the id first, then the name (TSHELL4-DISCARD-LANDS-UNDER-OPEN-EDIT,
 * F1-rename-refuses-entry, F3-strip-uses-owner-host-index).
 *
 * SEEDED at registration with the owner's own `session.hostSheetId` (review
 * FR-RESYNC-COMMITS-ON-RENUMBER): the id is the identity every decision
 * compares first, so it must not wait for a trip away -- a renumbering before
 * the first trip, an MCP delete above the host say, left the index fallback
 * naming another sheet. The NAME is learned by pointModeSheetSwitch.ts on the
 * session's first trip AWAY from its host (an un-parked session's host is the
 * sheet the grid shows), and both are re-found -- by id, else by name -- in
 * every switch's fresh sheet list and every sheet the grid is moved to, which
 * also follows a rename. With neither (an owner that names no id, before its
 * first trip) every decision falls back to the owner's index, the old rule.
 * Cleared with the slot.
 */
let host: { index: number; name: string | null; sheetId?: string } | null = null;

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
 * A new registration starts UN-parked, its host identity seeded with nothing
 * but the stable id its session names (`session.hostSheetId`, at the owner's
 * opening index), or with nothing at all; the identity-checked clear also
 * clears `parked` (WITHOUT calling `onParkedChanged` -- the session is gone)
 * and the host identity. Both set and clear notify.
 */
export function registerExternalFormulaTarget(target: ExternalFormulaTarget): () => void {
  activeTarget = target;
  parkedView = null;
  host = seededHost(target.session);
  notifyExternalEditChanged();
  return () => {
    if (activeTarget === target) {
      activeTarget = null;
      parkedView = null;
      host = null;
      notifyExternalEditChanged();
    }
  };
}

/**
 * The host identity a new session starts with: the stable id the OWNER named
 * (`session.hostSheetId`) at the owner's opening index, its name not yet known;
 * null for a pick-only target or a session that names no id.
 */
function seededHost(session: ExternalEditSession | undefined): typeof host {
  const sheetId = session?.hostSheetId;
  if (!session || typeof sheetId !== "string" || sheetId === "") return null;
  return { index: session.hostSheetIndex, name: null, sheetId };
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

/** The sheet the grid shows while parked -- its index NOW; null when not parked. */
export function getParkedViewSheetIndex(): number | null {
  return isExternalSessionParked() && parkedView !== null ? parkedView.index : null;
}

/**
 * The live session's host sheet's TRUE index as Core last found it BY
 * IDENTITY (`host`), else the owner's `hostSheetIndex`; null with no live
 * session. Core acts on THIS, never on the owner's index: that one is fixed
 * when the edit opens, and the sheets are renumbered under an open edit. It is
 * refreshed only by a point-mode switch's fresh list and by the sheet the grid
 * is moved to (pointModeSheetSwitch.ts `followShownSheetForExternalSession`),
 * so a caller deciding "is this sheet the host" asks
 * `isExternalSessionHostSheet` instead, which compares the sheet's identity
 * and so cannot go stale.
 */
export function getExternalSessionHostIndex(): number | null {
  const session = getExternalEditSession();
  if (!session) return null;
  return host?.index ?? session.hostSheetIndex;
}

/** The live session's host sheet's NAME as Core last found it; null before Core learned it, or with no live session. */
export function getExternalSessionHostName(): string | null {
  return getExternalEditSession() !== null ? host?.name ?? null : null;
}

/** The live session's host sheet's STABLE id -- the owner's own from registration, else once Core learned it (null before that, with no id, or with no live session). */
export function getExternalSessionHostSheetId(): string | null {
  return getExternalEditSession() !== null ? host?.sheetId ?? null : null;
}

/**
 * CORE-INTERNAL (pointModeSheetSwitch.ts; NOT re-exported through @api): the
 * live session's host IS the sheet `name` -- with stable id `sheetId` when the
 * caller knows it -- at TRUE index `index` now. Ignored with no live session,
 * with no name, and when it names ANOTHER stable id than the host already
 * has (the id is the host's identity -- the owner's own, from registration --
 * and a note naming another id is about another sheet). A host learned with an
 * id keeps it when a later note carries none. Notifies when it changed (the
 * tab strip's point-mode key carries the host's index).
 */
export function noteExternalSessionHost(index: number, name: string, sheetId?: string): void {
  if (getExternalEditSession() === null || name === "") return;
  const given = sheetId !== undefined && sheetId !== "" ? sheetId : undefined;
  if (given !== undefined && host?.sheetId !== undefined && given !== host.sheetId) return;
  const id = given ?? host?.sheetId;
  if (host !== null && host.index === index && host.name === name && host.sheetId === id) return;
  host = id !== undefined ? { index, name, sheetId: id } : { index, name };
  notifyExternalEditChanged();
}

/**
 * Whether `sheet` -- a tab of a sheet list, as it stands NOW -- IS the live
 * session's host: by stable id when both Core's host and the sheet carry one,
 * else by name once Core learned the host's name, else by index (the host's as
 * Core last found it, else the owner's). False with no live session.
 *
 * The tab strip asks THIS at event time -- the one rule that brings a parked
 * canvas-hosted edit back, and the source-tab marker -- never the owner's
 * opening `hostSheetIndex`: after a renumbering under a parked edit, a click on
 * the host's own tab was ignored (review F3-strip-uses-owner-host-index).
 */
export function isExternalSessionHostSheet(sheet: { index: number; name: string; sheetId?: string }): boolean {
  const session = getExternalEditSession();
  if (!session) return false;
  return viewIsHost(session, sheet.index, sheet.name, sheet.sheetId);
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
 * or `${hostIndex}:${parked?1:0}:${expecting?1:0}` -- the host's index as Core
 * last found it (getExternalSessionHostIndex) -- so the tab strip re-renders
 * when those change, not on every keystroke.
 */
export function getCrossSheetPointModeKey(): string | null {
  const session = getExternalEditSession();
  if (!session) return null;
  return `${host?.index ?? session.hostSheetIndex}:${isExternalSessionParked() ? 1 : 0}:${sessionExpectsReference() ? 1 : 0}`;
}

/**
 * Whether the viewed sheet IS the live session's host (see
 * setExternalSessionParked): by stable id when both are known, else by name
 * when both are known, else by index.
 */
function viewIsHost(
  session: ExternalEditSession,
  viewedIndex: number,
  viewedName: string | undefined,
  viewedSheetId?: string,
): boolean {
  if (host?.sheetId !== undefined && viewedSheetId !== undefined && viewedSheetId !== "") {
    return viewedSheetId === host.sheetId;
  }
  if (host !== null && host.name !== null && viewedName !== undefined && viewedName !== "") {
    return sameSheetName(viewedName, host.name);
  }
  return viewedIndex === (host?.index ?? session.hostSheetIndex);
}

/** The sheet as Core holds it: its index, and its name and id only when they say something. */
function sessionSheetOf(index: number, name: string | undefined, sheetId: string | undefined): SessionSheet {
  return {
    index,
    ...(name !== undefined && name !== "" ? { name } : {}),
    ...(sheetId !== undefined && sheetId !== "" ? { sheetId } : {}),
  };
}

function sameSessionSheet(a: SessionSheet | null, b: SessionSheet | null): boolean {
  if (a === null || b === null) return a === b;
  return a.index === b.index && a.name === b.name && a.sheetId === b.sheetId;
}

/**
 * CORE-INTERNAL: only pointModeSheetSwitch.ts calls it; NOT re-exported through
 * @api. parked := live && viewed !== null && the viewed sheet is not the host.
 * "Is the host" is decided by IDENTITY when the viewed sheet's and the host's
 * are known (`host`, above) -- the stable id first, then the name: the host's
 * INDEX goes stale the moment a sheet before it is discarded, deleted, moved or
 * copied, and a trip to the sheet that slid into that index then UN-parked the
 * edit on a foreign sheet, while the trip back to the host parked it there; and
 * a rename of the host changes its name, never its id. Without either it is
 * the index (the host's as Core last found it, else the owner's).
 * The viewed sheet is KEPT by identity (its name and stable id, when given):
 * a call naming the same sheet at the same index changes nothing (and does not
 * notify) -- the shown-sheet follower re-announces the view after every render.
 * On a parked FLIP it calls session.onParkedChanged(parked); notifies on any
 * change (the viewed index, name or id included).
 */
export function setExternalSessionParked(
  viewedSheetIndex: number | null,
  viewedSheetName?: string,
  viewedSheetId?: string,
): void {
  const session = getExternalEditSession();
  const next =
    session !== null &&
    viewedSheetIndex !== null &&
    !viewIsHost(session, viewedSheetIndex, viewedSheetName, viewedSheetId)
      ? sessionSheetOf(viewedSheetIndex, viewedSheetName, viewedSheetId)
      : null;
  if (sameSessionSheet(next, parkedView)) return;
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
  return (
    a.address === b.address &&
    a.content === b.content &&
    a.readOnly === b.readOnly &&
    (a.spillGhost === true) === (b.spillGhost === true)
  );
}

/**
 * Single slot, last writer wins. `null` withdraws ONLY when `owner` still holds
 * the slot (identity by owner key -- a stale withdraw cannot remove a newer
 * publisher). There is no fallback to an older publication: a withdrawn WRITE
 * target is gone. Notifies only when owner/address/content/readOnly/spillGhost changed;
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
// Reference text handed to an external target
// ============================================================================

/**
 * True when `name` may stand in a formula WITHOUT apostrophes -- the backend
 * lexer reads it as ONE plain identifier. Rule for rule the backend's own
 * `is_bare_sheet_name` (core/engine/src/ast_render.rs), which its
 * render-then-parse test pins for every reference shape:
 *   - an ASCII letter or `_` first (a leading digit lexes as a number);
 *   - then ASCII letters, digits and `_`, and a `.` only when one of those
 *     follows it (a trailing dot is the trim-reference operator);
 *   - never `TRUE` / `FALSE` in any case (they lex as BOOLEAN literals).
 * A reference-SHAPED name (`A1`, `Sheet1`) is bare: the `!` after it is what
 * tells the lexer it is a sheet.
 */
export function isBareSheetName(name: string): boolean {
  if (!/^[A-Za-z_]/.test(name)) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    if (/[A-Za-z0-9_]/.test(c)) continue;
    if (c === "." && i + 1 < name.length && /[A-Za-z0-9_]/.test(name[i + 1])) continue;
    return false;
  }
  const upper = name.toUpperCase();
  return upper !== "TRUE" && upper !== "FALSE";
}

/**
 * A sheet (or floating-range) name as a formula must spell it before `!`:
 * bare when {@link isBareSheetName}, otherwise apostrophe-quoted with an
 * inner `'` doubled. The ONE rule the text handed to an external edit is
 * built with -- Core's header and GETPIVOTDATA picks (useSpreadsheetSelection)
 * and a floating grid's own cell picks and addresses (@api/externalEdit) --
 * so the two halves of one edit cannot quote the same sheet differently.
 * Core's display helper `formatSheetName` (gridRenderer/references/
 * conversion.ts) quotes only whitespace, ' ! [ ] and a leading digit, and
 * produced `Q1-2026!C:C`, which the parser rejects.
 */
export function quoteSheetNameForFormula(name: string): string {
  return isBareSheetName(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

// ============================================================================
// Sheet identity
// ============================================================================

/**
 * Whether two sheet names name the SAME sheet: equal ignoring ASCII case, the
 * workbook's own uniqueness rule (the backend's `ensure_sheet_name_is_free`,
 * app/src-tauri/src/sheet_names.rs, compares with `eq_ignore_ascii_case`), so
 * no two sheets of one workbook ever answer true. An empty name names nothing.
 *
 * An open edit follows its sheet by its STABLE id first and by THIS when an
 * id is missing, never by an index: a temporary sheet's discard, a delete, a
 * move or a copy renumbers every sheet after it while the edit is open
 * (TSHELL4-DISCARD-LANDS-UNDER-OPEN-EDIT), and a rename changes the name but
 * not the id (F1-rename-refuses-entry). Core's own cell edit
 * (core/lib/editSheetIdentity.ts) and an external session's host (`host`,
 * above) both decide that way.
 */
export function sameSheetName(a: string, b: string): boolean {
  if (a === "" || b === "" || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    // ASCII letters only ('A'..'Z' is 65..90): what eq_ignore_ascii_case folds.
    if (x >= 65 && x <= 90) x += 32;
    if (y >= 65 && y <= 90) y += 32;
    if (x !== y) return false;
  }
  return true;
}

// ============================================================================
// Tests only (not re-exported through @api)
// ============================================================================

/** Resets every slot, parked, resolver and version, then notifies. Does NOT drop listeners. */
export function __resetExternalEditForTests(): void {
  activeTarget = null;
  parkedView = null;
  host = null;
  cellSlot = null;
  addressResolver = null;
  version = 0;
  notifyExternalEditChanged();
}
