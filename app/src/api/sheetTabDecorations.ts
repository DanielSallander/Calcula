//! FILENAME: app/src/api/sheetTabDecorations.ts
// PURPOSE: Let an extension MARK a sheet in the tab strip — a small glyph beside
//          the name saying, without being opened, that this sheet is not an
//          ordinary one you created.
// CONTEXT: The tab strip had exactly one extension seam
//          (`sheetExtensions.registerContextMenuItem`) and it is a MENU: nothing
//          you can see without right-clicking. A sheet pulled from a `.calp`
//          application looks identical to a sheet you typed, and it behaves
//          oppositely — it is refreshed from the workspace, your edits on it
//          become overrides, and it is somebody else's content to publish. The
//          developer testing both sides of a subscription had no way to tell the
//          tabs apart.
//
//          A PRIMITIVE, not a `.calp` hook: any extension may mark any sheet for
//          any reason. Protection could mark a locked sheet tomorrow without
//          touching this file.
//
// TWO DELIBERATE DIFFERENCES from `columnHeaderOverrides`, which is otherwise the
// right shape:
//
//   1. MARKS COMPOSE, THEY DO NOT REPLACE. A header override answers "what text
//      goes in this one slot" — exactly one winner, so first-non-null is correct
//      there. A sheet can honestly be BOTH subscribed and protected, so
//      first-non-null would let whichever provider registered at a lower priority
//      silently suppress the other. Every non-null answer renders.
//
//   2. IT CARRIES A CHANGE CHANNEL. The canvas repaints every frame, so a canvas
//      provider can be a pure pull. The tab strip is React: it renders once. A
//      provider registered after the strip mounted — which is every extension,
//      since extensions activate after mount — or whose ANSWER changed (a pull
//      landed, a subscription was detached) must be able to say so. Same shape as
//      `objectScriptBadge`'s presence channel.

// ============================================================================
// Types
// ============================================================================

/** The sheet a provider is being asked about. */
export interface SheetTabTarget {
  /**
   * The TRUE state-vector index, as `SheetInfo.index` carries it — NOT the
   * position in the rendered strip. Object-backed sheets are absent from the
   * list but still occupy indices.
   */
  index: number;
  /** Current display name. Renames change it; never key identity on it. */
  name: string;
  /**
   * The workbook's stable sheet uuid. THE ONLY SAFE KEY: indices shift on
   * insert/delete/move and names shift on rename, and a mark on the wrong tab is
   * worse than no mark. Absent when the backend did not supply one — a provider
   * that cannot identify the sheet must return `null`, not guess.
   */
  sheetId?: string;
}

/** One mark rendered inside a sheet tab, beside the name. */
export interface SheetTabDecoration {
  /**
   * ONE short glyph. Not a label: the strip is ~28px high, tabs are horizontally
   * scarce, and the name owns the space. The glyph must carry the meaning on its
   * own — colour is redundancy, never the message, so the mark survives a
   * colour-blind reader and the high-contrast theme.
   */
  glyph: string;
  /** CSS foreground colour. Default: the tab's own secondary text colour. */
  color?: string;
  /** CSS pill background. Omit for a bare glyph. */
  background?: string;
  /**
   * WHY the mark is there, in a sentence. Appended to the tab's title and used
   * as the glyph's aria-label. A mark whose reason you cannot discover is a
   * puzzle, not information.
   */
  tooltip?: string;
}

export interface SheetTabDecorationRegistration {
  /** Stable id — dedupes re-registration and is emitted as a DOM data attribute. */
  id: string;
  /** Lower is rendered first (leftmost). Default 0. */
  priority?: number;
  /** Must be O(1) per sheet: called for every visible tab on every render. */
  provider: (sheet: SheetTabTarget) => SheetTabDecoration | null;
}

/**
 * How many glyphs one tab renders. Past this the name starts losing the strip,
 * and a tab whose name you cannot read has stopped being a tab. Every mark's
 * TOOLTIP still reaches the title, so nothing is lost silently.
 */
export const MAX_SHEET_TAB_DECORATION_GLYPHS = 2;

// ============================================================================
// Registry
// ============================================================================

const registrations: SheetTabDecorationRegistration[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) {
    try {
      l();
    } catch (error) {
      console.error("[SheetTabDecorations] listener threw:", error);
    }
  }
}

/**
 * Register a sheet-tab decoration provider.
 *
 * Registering NOTIFIES: extensions activate after the strip has mounted, so a
 * mark that only appeared after the next unrelated re-render would be a mark the
 * user cannot trust.
 *
 * @returns Cleanup, which also notifies.
 */
export function registerSheetTabDecorationProvider(
  registration: SheetTabDecorationRegistration,
): () => void {
  const existing = registrations.findIndex((r) => r.id === registration.id);
  if (existing >= 0) registrations.splice(existing, 1);
  registrations.push(registration);
  registrations.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  notify();
  return () => {
    const i = registrations.indexOf(registration);
    if (i >= 0) {
      registrations.splice(i, 1);
      notify();
    }
  };
}

/** Fast flag: lets a consumer skip the walk entirely when nothing marks anything. */
export function hasSheetTabDecorations(): boolean {
  return registrations.length > 0;
}

/**
 * EVERY mark for a sheet, in priority order — not first-non-null; see the header.
 * A throwing provider is logged and skipped: one extension's bug must not blank
 * another extension's mark.
 */
export function getSheetTabDecorations(
  sheet: SheetTabTarget,
): Array<SheetTabDecoration & { id: string }> {
  if (registrations.length === 0) return [];
  const out: Array<SheetTabDecoration & { id: string }> = [];
  for (const r of registrations) {
    try {
      const d = r.provider(sheet);
      if (d) out.push({ ...d, id: r.id });
    } catch (error) {
      console.error(`[SheetTabDecorations] provider "${r.id}" threw:`, error);
    }
  }
  return out;
}

/**
 * Tell the strip that a provider's ANSWER changed — a pull landed, a sheet was
 * detached — without the registration itself changing.
 */
export function invalidateSheetTabDecorations(): void {
  notify();
}

/**
 * Subscribe to registration or answer changes.
 * @returns Cleanup.
 */
export function onSheetTabDecorationsChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** TEST ONLY: drop every provider and listener. */
export function __resetSheetTabDecorationsForTests(): void {
  registrations.length = 0;
  listeners.clear();
}
