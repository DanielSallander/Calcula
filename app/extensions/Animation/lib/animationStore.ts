//! FILENAME: app/extensions/Animation/lib/animationStore.ts
// PURPOSE: In-memory store of saved AnimationSpecs, persisted through the A5
//          generic per-extension tier (getExtensionData/setExtensionData), keyed
//          by the extension id. Round-trips with the .cala workbook. Mutations
//          notify subscribers (the panel) and write-through to persistence.
// NOTE: Writes are NOT yet undoable — the A5 tier has no undo integration. A
//       dedicated undoable command (Slice 2b) will wrap these; until then,
//       create/edit/delete of a saved animation is not on the undo stack.
import { getExtensionData, setExtensionData } from "@api/extensionData";
import type { AnimationSpec } from "../types";

const EXTENSION_ID = "calcula.animation";

interface PersistShape {
  animations: AnimationSpec[];
}

let animations: AnimationSpec[] = [];
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

/** Subscribe to store changes (returns an unsubscribe fn). */
export function subscribeAnimations(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** All saved specs, optionally filtered to one sheet. */
export function listAnimations(sheetIndex?: number): AnimationSpec[] {
  return sheetIndex === undefined ? [...animations] : animations.filter((a) => a.sheetIndex === sheetIndex);
}

export function getAnimation(id: string): AnimationSpec | undefined {
  return animations.find((a) => a.id === id);
}

/** A unique id for a new spec (no crypto dependency needed). */
export function newAnimationId(): string {
  idSeq += 1;
  return `anim-${Date.now().toString(36)}-${idSeq}`;
}

async function persist(): Promise<void> {
  const payload: PersistShape = { animations };
  await setExtensionData(EXTENSION_ID, payload);
}

/** Create or update a spec, then write-through to persistence. */
export async function upsertAnimation(spec: AnimationSpec): Promise<void> {
  const i = animations.findIndex((a) => a.id === spec.id);
  if (i >= 0) animations[i] = spec;
  else animations.push(spec);
  notify();
  await persist();
}

/** Delete a spec by id, then write-through to persistence. */
export async function deleteAnimation(id: string): Promise<void> {
  const before = animations.length;
  animations = animations.filter((a) => a.id !== id);
  if (animations.length !== before) {
    notify();
    await persist();
  }
}

/** Load specs from the workbook (call in activate() and on AFTER_OPEN). */
export async function loadAnimations(): Promise<void> {
  try {
    const data = await getExtensionData<PersistShape>(EXTENSION_ID);
    animations = Array.isArray(data?.animations) ? data!.animations : [];
  } catch (e) {
    console.error("[Animation] load failed", e);
    animations = [];
  }
  notify();
}

/** Clear the in-memory store without persisting (call on AFTER_NEW). */
export function resetAnimations(): void {
  animations = [];
  notify();
}
