//! FILENAME: app/extensions/Animation/lib/animationStore.ts
// PURPOSE: The workbook's saved AnimationSpecs. Held in memory for the panel to
//          read, persisted through the A5 generic per-extension tier
//          (getExtensionData/setExtensionData) keyed by the extension id, and
//          round-tripped with the .cala workbook.
// UNDO: write-through uses setExtensionDataUndoable so create/edit/delete of a
//       saved animation lands on the undo stack with a meaningful label. Undo/redo
//       restores the prior blob in the backend and fires "animation:refresh"
//       (via the shell objects-domain fan-out), which the extension re-syncs to.
//
// THE IN-MEMORY LIST IS NOT REACHABLE WITHOUT THE WRITE-THROUGH.
// -------------------------------------------------------------
// What is SAVED is the extension-data blob; what the panel reads is this
// module's list. They used to be a plain `let animations` plus a `persist()`
// that every mutator had to remember to call -- the same store/mirror shape that
// silently dropped grid reports at save (see app/src-tauri/src/report.rs). Both
// mutators happened to be correct; nothing made the third one correct.
//
// So the list now lives in a `#private` field with exactly three doors, and
// `#animations` is inaccessible outside the class body -- not by convention, by
// the language:
//   * `mutate()`         -- changes the workbook's animations AND writes through.
//                           The only door that can leave the two disagreeing is
//                           the one that cannot: it does both or neither.
//   * `adopt()`          -- installs a list that CAME FROM the workbook (load) or
//                           that the backend has already cleared (File > New).
//                           Deliberately does not persist; the name says so.
//   * `current`          -- read-only, and typed `readonly AnimationSpec[]` so a
//                           caller cannot `push` onto the store's own array.
import { getExtensionData, setExtensionDataUndoable } from "@api/extensionData";
import type { AnimationSpec } from "../types";

const EXTENSION_ID = "calcula.animation";

interface PersistShape {
  animations: AnimationSpec[];
}

let idSeq = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) {
    try {
      l();
    } catch (e) {
      console.error("[Animation] store listener error", e);
    }
  }
}

class AnimationStore {
  #animations: readonly AnimationSpec[] = [];

  /** The saved animations, as of now. Read-only by type. */
  get current(): readonly AnimationSpec[] {
    return this.#animations;
  }

  /**
   * Change the workbook's animations and write the change through, as one step.
   *
   * `next` returns the replacement list, or the list it was handed to say
   * "nothing changed" -- which notifies nobody and persists nothing, preserving
   * the no-op semantics a delete of an absent id has always had.
   */
  async mutate(
    description: string,
    next: (current: readonly AnimationSpec[]) => readonly AnimationSpec[],
  ): Promise<void> {
    const replacement = next(this.#animations);
    if (replacement === this.#animations) return;
    this.#animations = replacement;
    notify();
    const payload: PersistShape = { animations: [...replacement] };
    await setExtensionDataUndoable(EXTENSION_ID, payload, description);
  }

  /**
   * Install a list WITHOUT persisting it. The two callers are the two cases
   * where persisting would be wrong, not forgotten: `loadAnimations` (the list
   * just came out of the workbook) and `resetAnimations` (File > New, where the
   * backend has already cleared extension_data -- persisting here would write an
   * undo entry into a brand-new document).
   */
  adopt(specs: readonly AnimationSpec[]): void {
    this.#animations = specs;
    notify();
  }
}

const store = new AnimationStore();

/** Subscribe to store changes (returns an unsubscribe fn). */
export function subscribeAnimations(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** All saved specs, optionally filtered to one sheet. */
export function listAnimations(sheetIndex?: number): AnimationSpec[] {
  return sheetIndex === undefined
    ? [...store.current]
    : store.current.filter((a) => a.sheetIndex === sheetIndex);
}

export function getAnimation(id: string): AnimationSpec | undefined {
  return store.current.find((a) => a.id === id);
}

/** A unique id for a new spec (no crypto dependency needed). */
export function newAnimationId(): string {
  idSeq += 1;
  return `anim-${Date.now().toString(36)}-${idSeq}`;
}

/** Create or update a spec, then write-through to persistence (undoable). */
export async function upsertAnimation(spec: AnimationSpec): Promise<void> {
  const exists = store.current.some((a) => a.id === spec.id);
  const description = exists ? `Edit animation "${spec.name}"` : `Create animation "${spec.name}"`;
  await store.mutate(description, (current) =>
    exists ? current.map((a) => (a.id === spec.id ? spec : a)) : [...current, spec],
  );
}

/** Delete a spec by id, then write-through to persistence (undoable). */
export async function deleteAnimation(id: string): Promise<void> {
  const target = store.current.find((a) => a.id === id);
  await store.mutate(`Delete animation${target ? ` "${target.name}"` : ""}`, (current) => {
    const next = current.filter((a) => a.id !== id);
    // Same reference back = nothing to notify, nothing to persist.
    return next.length === current.length ? current : next;
  });
}

/** Load specs from the workbook (call in activate() and on AFTER_OPEN). */
export async function loadAnimations(): Promise<void> {
  let loaded: AnimationSpec[] = [];
  try {
    const data = await getExtensionData<PersistShape>(EXTENSION_ID);
    loaded = Array.isArray(data?.animations) ? data!.animations : [];
  } catch (e) {
    console.error("[Animation] load failed", e);
    loaded = [];
  }
  store.adopt(loaded);
}

/** Clear the in-memory store without persisting (call on AFTER_NEW). */
export function resetAnimations(): void {
  store.adopt([]);
}

