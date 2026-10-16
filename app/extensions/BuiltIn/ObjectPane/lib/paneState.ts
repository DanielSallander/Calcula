//! FILENAME: app/extensions/BuiltIn/ObjectPane/lib/paneState.ts
// PURPOSE: What the object pane is showing: which object (by region id), and
//          which tab. The host writes it; the view and the policy read it.
// CONTEXT: The pane's VIEW never gets its subject through the task-pane
//          `data` (a pane's data is frozen at the moment it was opened, the
//          lesson ChartFormatPane's header records): it reads this store and
//          re-reads the LIVE region by id from @api/gridOverlays on every
//          change, so a retarget, a tab switch, a family re-publishing its
//          region and a binding resolving all show without a re-open.
//
//          `open` here is the HOST's intent. The Shell can close the pane on
//          its own (the header's X, Close Task Pane, a `closeTaskPane` from a
//          test), so the host's `state()` also asks the task-pane service
//          whether the pane is still shown (objectPaneHost.ts).

import { OBJECT_PANE_ID, type ObjectPaneState } from "@api/objectPane";
import { getOpenTaskPaneIds, isTaskPaneContainerOpen } from "@api/ui";

export type PaneSubject = ObjectPaneState;

/** The closed subject. */
export const CLOSED_SUBJECT: PaneSubject = Object.freeze({
  open: false,
  regionId: null,
  regionType: null,
  tabId: null,
}) as PaneSubject;

let subject: PaneSubject = CLOSED_SUBJECT;
const listeners = new Set<() => void>();

/** What the host last opened (or CLOSED_SUBJECT). */
export function getPaneSubject(): PaneSubject {
  return subject;
}

/** Replace the subject and tell every listener (a listener that throws is logged). */
export function setPaneSubject(next: PaneSubject): void {
  const same =
    next.open === subject.open &&
    next.regionId === subject.regionId &&
    next.regionType === subject.regionType &&
    next.tabId === subject.tabId;
  subject = next.open ? { ...next } : CLOSED_SUBJECT;
  if (same) return;
  for (const l of Array.from(listeners)) {
    try {
      l();
    } catch (err) {
      console.error("[ObjectPane] a pane-state listener threw:", err);
    }
  }
}

/** Listen for subject changes. Returns the unsubscribe. */
export function subscribePaneSubject(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the Shell is showing the object pane right now (open and the container visible). */
export function isObjectPaneShown(): boolean {
  return isTaskPaneContainerOpen() && getOpenTaskPaneIds().includes(OBJECT_PANE_ID);
}

/** Test hook: closed subject, no listeners. */
export function resetPaneState(): void {
  subject = CLOSED_SUBJECT;
  listeners.clear();
}
