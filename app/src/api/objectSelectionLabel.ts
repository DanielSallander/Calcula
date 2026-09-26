//! FILENAME: app/src/api/objectSelectionLabel.ts
// PURPOSE: What the selected floating OBJECT(S) are called, for the Name Box --
//          "Sales by Region", "Slicer_Region", "3 objects" -- published by the
//          one extension that knows (the canvas, from the object-selection set)
//          and read by the shell without importing it.
// CONTEXT: The shape of @api/chartSelection (publish / get / on), which the
//          Name Box already reads for a chart's selection rung. A canvas has no
//          cell cursor, so without a label the Name Box is blank for every
//          object that is not a chart. The chart rung stays chartSelection's:
//          while ONE chart is selected the box shows "Series 1 Point 3" from
//          there, and this label only takes over for a MULTI-selection (a
//          chart's rung does not describe three objects) and for the other
//          families.
//
//          Publishers are keyed by `source`, so one publisher clearing its
//          label cannot erase another's: the newest non-null label wins, and
//          clearing it falls back to the next newest. Listeners are told only
//          when the visible label actually changes.

/** A published label: the text, and how many objects it stands for. */
export interface ObjectLabel {
  text: string;
  /** Number of selected objects the label describes (1 for a single object). */
  count: number;
}

/** What `getObjectLabel` answers: the winning label and who published it. */
export interface ObjectLabelSnapshot extends ObjectLabel {
  /** The publisher, or null when nothing is labelled. */
  source: string | null;
}

/** No label: nothing selected, or nothing with a name. */
export const EMPTY_OBJECT_LABEL: ObjectLabelSnapshot = Object.freeze({ source: null, text: "", count: 0 });

type Listener = (snapshot: ObjectLabelSnapshot) => void;

/** Published labels in publication order (oldest first); the last one wins. */
const published = new Map<string, ObjectLabel>();
let current: ObjectLabelSnapshot = EMPTY_OBJECT_LABEL;
const listeners = new Set<Listener>();

function winner(): ObjectLabelSnapshot {
  let last: ObjectLabelSnapshot = EMPTY_OBJECT_LABEL;
  for (const [source, label] of published) last = { source, text: label.text, count: label.count };
  return last === EMPTY_OBJECT_LABEL ? last : Object.freeze(last);
}

function same(a: ObjectLabelSnapshot, b: ObjectLabelSnapshot): boolean {
  return a.source === b.source && a.text === b.text && a.count === b.count;
}

function normalise(label: ObjectLabel | string | null): ObjectLabel | null {
  if (label === null) return null;
  const text = typeof label === "string" ? label : label.text;
  if (typeof text !== "string" || text.trim() === "") return null;
  const count = typeof label === "string" ? 1 : label.count;
  return { text, count: Number.isFinite(count) && count > 0 ? Math.floor(count) : 1 };
}

/**
 * Publish (or, with `null`, withdraw) `source`'s label. A plain string is a
 * single object's label. An empty text counts as `null`.
 */
export function publishObjectLabel(source: string, label: ObjectLabel | string | null): void {
  const next = normalise(label);
  if (next === null) {
    published.delete(source);
  } else {
    // Re-insert so this source becomes the newest.
    published.delete(source);
    published.set(source, next);
  }
  const snapshot = winner();
  if (same(current, snapshot)) return;
  current = snapshot;
  for (const listener of [...listeners]) {
    try {
      listener(snapshot);
    } catch (err) {
      console.error("[objectSelectionLabel] listener failed:", err);
    }
  }
}

/** The winning label; `EMPTY_OBJECT_LABEL` (text "") when there is none. */
export function getObjectLabel(): ObjectLabelSnapshot {
  return current;
}

/**
 * Subscribe to label changes. Returns the unsubscribe. The snapshot is also
 * available from {@link getObjectLabel}, so this works as the `subscribe` half
 * of a `useSyncExternalStore` pair.
 */
export function onObjectLabelChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Clear every label AND every listener (test teardown). Never call this to
 * withdraw a label -- that is `publishObjectLabel(source, null)`, which tells
 * the readers.
 */
export function resetObjectLabelRegistry(): void {
  published.clear();
  current = EMPTY_OBJECT_LABEL;
  listeners.clear();
}
