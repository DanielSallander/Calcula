// FILENAME: app/extensions/ModelEditor/lib/diagramPositions.ts
// PURPOSE: Remember where the user dragged each table in the diagram's Free
//          layout, per connection.
// CONTEXT: Free is a layout mode the user picks DELIBERATELY, and until now it
//          forgot everything the moment you looked at anything else — the
//          section is conditionally rendered, so a glance at Measures unmounted
//          it and threw the arrangement away. Arranging fourteen tables by hand
//          and losing it on the next click is worse than not offering the mode.
//
//          THIS DOES NOT REVERSE THE AUTO-LAYOUT DECISION. `layoutEngine.ts`
//          replaced manual drag as the DEFAULT positioning mechanism, and that
//          stands: Auto, Radial and Layered remain pure functions of the model
//          and store nothing, so the same model always draws the same shape.
//          What is stored here is only what the user explicitly dragged, only
//          in the mode named for dragging.
//
//          KEYED BY CONNECTION, and pruned to the tables the model still has —
//          a stored position for a dropped table would otherwise sit in the
//          file forever, and a same-named table in a different model would
//          inherit a position from a layout nobody drew.

export interface Position {
  x: number;
  y: number;
}

const PREFIX = "calcula.modelEditor.diagramPositions.";

/** Cap on stored tables, so a pathological model cannot fill localStorage.
 *  Well past any hand-arranged diagram; a model bigger than this is one nobody
 *  is positioning by hand anyway. */
const MAX_TABLES = 500;

function keyFor(connectionId: string): string {
  return `${PREFIX}${connectionId}`;
}

/**
 * Read the stored arrangement, keeping only tables the model still has.
 *
 * Every failure mode returns `null` rather than throwing: localStorage is
 * unavailable in a private window, the value may be from an older shape, and a
 * diagram that refuses to render because it could not read a cosmetic
 * preference would be a much worse bug than one that forgets a layout.
 */
export function loadDiagramPositions(
  connectionId: string,
  knownTables: readonly string[],
): Record<string, Position> | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(keyFor(connectionId));
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const known = new Set(knownTables);
  const out: Record<string, Position> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!known.has(name)) continue; // pruned: the model no longer has it
    if (typeof value !== "object" || value === null) continue;
    const { x, y } = value as Record<string, unknown>;
    // A NaN or an Infinity here would place a node nowhere and take the whole
    // canvas measurement with it, so the shape is checked rather than trusted.
    if (typeof x !== "number" || typeof y !== "number") continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out[name] = { x, y };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Store the arrangement, or clear it when there is nothing to remember. */
export function saveDiagramPositions(
  connectionId: string,
  positions: Record<string, Position> | null,
): void {
  try {
    if (!positions || Object.keys(positions).length === 0) {
      localStorage.removeItem(keyFor(connectionId));
      return;
    }
    const entries = Object.entries(positions).slice(0, MAX_TABLES);
    localStorage.setItem(keyFor(connectionId), JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // A layout we cannot store is a layout the user re-drags. Nothing here is
    // worth failing a render over.
  }
}

/** Forget one connection's arrangement — the "reset layout" action. */
export function clearDiagramPositions(connectionId: string): void {
  saveDiagramPositions(connectionId, null);
}

// ---------------------------------------------------------------------------
// Which view and which layout you were last in
// ---------------------------------------------------------------------------
//
// WITHOUT THIS, PERSISTING POSITIONS IS INVISIBLE. The section is conditionally
// rendered, so leaving Relationships and coming back remounts it in List view
// with layout "auto" — and a remembered Free arrangement is only read when you
// are IN Free. Storing the positions and not the mode means the user drags
// fourteen tables, comes back, sees the computed layout, and concludes nothing
// was saved.
//
// Kept in the same module as the positions because they are one preference in
// three parts: where you were looking, how it was arranged, and where things
// were. Splitting them across files is how two of the three end up persisted.

export interface DiagramView {
  /** "list" or "diagram". */
  view: string;
  /** "auto" | "radial" | "layered" | "free". */
  layoutMode: string;
}

const VIEW_PREFIX = "calcula.modelEditor.diagramView.";

export function loadDiagramView(connectionId: string): DiagramView | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(`${VIEW_PREFIX}${connectionId}`);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { view, layoutMode } = parsed as Record<string, unknown>;
    // Validate against the CLOSED sets rather than accepting any string: a
    // stored value from an older shape would otherwise reach the component as a
    // layout mode nothing renders.
    if (view !== "list" && view !== "diagram") return null;
    if (!["auto", "radial", "layered", "free"].includes(String(layoutMode))) return null;
    return { view, layoutMode: String(layoutMode) };
  } catch {
    return null;
  }
}

export function saveDiagramView(connectionId: string, value: DiagramView): void {
  try {
    localStorage.setItem(`${VIEW_PREFIX}${connectionId}`, JSON.stringify(value));
  } catch {
    /* a preference we cannot store is one the user re-picks */
  }
}
