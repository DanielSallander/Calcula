//! FILENAME: app/src/api/selectionOwner.ts
// PURPOSE: The extension-facing "selection owner" seam: an extension whose
//          object can hold the selection INSTEAD of Core's grid claims it, and
//          every door that acts on Core's selection refuses -- with one toast --
//          while it does.
// CONTEXT: BUG-0185. With a floating grid's cell selected on a worksheet,
//          Core's selection stays on a cell hidden under the floating grid, and
//          the ribbon's and menus' formatting doors wrote to THAT cell. The
//          store and the door's question live in Core
//          (core/lib/selectionOwner.ts) so Core's own doors -- the grid
//          commands and the grid keyboard's format keys -- ask the same one;
//          this module re-exports it and wires the refusal to the toast.
//
// USE, as an OWNER (feature-neutral: Core never learns what the object is):
//
//     const release = registerSelectionOwner({
//       id: "myFeature",
//       label: "my object's cells",
//       ownsSelection: () => mySelectionIsOnScreen(),
//       refusal: (action) => `${action} is not available for my object yet.`,
//       // Optional: true while a character typed now lands in the owner's OWN
//       // cell (its own type-to-edit takes it). Absent or false: nothing of
//       // the owner's takes typing, and a Ctrl+Alt character (sv-SE AltGr+9)
//       // is read as the shortcut it collides with, not as typing (W17).
//       receivesTyping: () => myCellIsSelected(),
//     });
//
// USE, as a DOOR that writes to Core's selection:
//
//     if (refuseIfSelectionOwned("Bold")) return;   // refused and announced
//
// Refusing is the door's job, not the owner's: an owner cannot enumerate the
// doors (it would be a copied list that drifts), and a door that asks costs
// one call.
//
// A door of a KIND an owner may let through asks as that kind, and the owner
// declares the kinds it admits -- a KIND, never a list of doors:
//
//     if (refuseIfSelectionOwned("Insert Shape", "objectInsert")) return;
//     registerSelectionOwner({ ..., admits: ["objectInsert"] });
//
// "objectInsert" is a door that adds a new floating object at Core's active
// cell (Insert Shape / Button / Image); the generic "an object is selected"
// claim admits it, as Excel inserts while a shape is selected.
//
// USE, as a SURFACE that follows Core's selection (a contextual ribbon tab):
//
//     const off = onSelectionOwnershipChanged(() => resyncMyTab());
//
// and ask isSelectionOwned() wherever the surface decides to show itself: it
// stands aside while the claim lasts and comes back when it ends (W22).

import { showToast } from "./notifications";
import {
  registerSelectionOwner as registerCoreSelectionOwner,
  isSelectionOwned,
  setSelectionRefusalAnnouncer,
  type SelectionOwner,
} from "../core/lib/selectionOwner";
import { onObjectSelectionChanged } from "./objectSelection";
import { ExtensionRegistry } from "./extensions";
import { onAppEvent, AppEvents } from "./events";

export {
  getSelectionOwner,
  isSelectionOwned,
  selectionRefusalFor,
  refuseIfSelectionOwned,
  defaultSelectionRefusal,
} from "../core/lib/selectionOwner";
export type { SelectionOwner, SelectionDoorKind } from "../core/lib/selectionOwner";

// One sentence per refused action, as a toast (not a modal: the user did
// nothing wrong, the selection simply is not the sheet's).
setSelectionRefusalAnnouncer((message) => {
  showToast(message, { variant: "info" });
});

// ============================================================================
// The claim STARTING and ENDING (W22)
// ============================================================================
//
// The claim is a predicate asked at the moment of use, never a stored flag
// (core/lib/selectionOwner.ts), so nothing announced it: a surface that
// FOLLOWS Core's selection -- the Table Design and Sparkline Design tabs --
// re-derived itself only when Core's selection moved, and stayed up for a
// table cell hidden under a floating grid whose own cell held the selection.
//
// What can change the answer, and is heard here (all feature-neutral):
//   - an object selection changing (@api/objectSelection -- a floating grid
//     announces its select / deselect there; a press on it IS the claim);
//   - Core's selection moving (the press that ends the claim);
//   - the active sheet changing (an owner claims on ITS sheet only);
//   - an owner registering or unregistering;
//   - an owner saying so itself: notifySelectionOwnershipChanged().
// Each is only a PROMPT to re-ask. The answer is read once per microtask (the
// owner's own listeners for the same event have settled by then), and the
// listeners hear only a real change of it.

const ownershipListeners = new Set<(owned: boolean) => void>();
let lastOwned = false;
let checkQueued = false;
let sourceCleanups: (() => void)[] = [];

function reaskOwnership(): void {
  checkQueued = false;
  if (ownershipListeners.size === 0) return;
  const owned = isSelectionOwned();
  if (owned === lastOwned) return;
  lastOwned = owned;
  // A COPY: a listener may unsubscribe (or subscribe) while being told.
  for (const listener of [...ownershipListeners]) {
    try {
      listener(owned);
    } catch (err) {
      console.error("[selectionOwner] ownership listener threw:", err);
    }
  }
}

/**
 * Prompt the ownership listeners to re-ask whether the selection is owned.
 * An owner that announces its select / deselect through @api/objectSelection
 * needs nothing more; one that does not calls this when its claim may have
 * started or ended. Cheap: coalesced to one question per microtask, and silent
 * when the answer did not change.
 */
export function notifySelectionOwnershipChanged(): void {
  if (checkQueued || ownershipListeners.size === 0) return;
  checkQueued = true;
  queueMicrotask(reaskOwnership);
}

function listenForOwnershipPrompts(): void {
  const prompt = (): void => notifySelectionOwnershipChanged();
  const sources: (() => () => void)[] = [
    () => onObjectSelectionChanged(prompt),
    () => ExtensionRegistry.onSelectionChange(prompt),
    () => onAppEvent(AppEvents.SHEET_CHANGED, prompt),
  ];
  for (const subscribe of sources) {
    try {
      sourceCleanups.push(subscribe());
    } catch (err) {
      // A source missing (a unit test's module double) must not take the
      // others -- or the subscriber's activation -- with it.
      console.warn("[selectionOwner] an ownership prompt source is unavailable:", err);
    }
  }
}

/**
 * Hear the selection owner's claim START (`true`) or END (`false`). Only a
 * real change is announced; the current answer is isSelectionOwned(). Returns
 * the unsubscribe.
 */
export function onSelectionOwnershipChanged(listener: (owned: boolean) => void): () => void {
  if (ownershipListeners.size === 0) {
    lastOwned = isSelectionOwned();
    listenForOwnershipPrompts();
  }
  ownershipListeners.add(listener);
  return () => {
    if (!ownershipListeners.delete(listener)) return;
    if (ownershipListeners.size === 0) {
      for (const cleanup of sourceCleanups) {
        try {
          cleanup();
        } catch (err) {
          console.error("[selectionOwner] ownership prompt cleanup threw:", err);
        }
      }
      sourceCleanups = [];
      checkQueued = false;
    }
  };
}

/**
 * Register an owner (core/lib/selectionOwner.ts registerSelectionOwner): the
 * same store, plus the prompt -- an owner arriving or leaving can change the
 * answer by itself.
 */
export function registerSelectionOwner(owner: SelectionOwner): () => void {
  const release = registerCoreSelectionOwner(owner);
  notifySelectionOwnershipChanged();
  return () => {
    release();
    notifySelectionOwnershipChanged();
  };
}
