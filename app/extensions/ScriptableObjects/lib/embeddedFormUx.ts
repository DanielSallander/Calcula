//! FILENAME: app/extensions/ScriptableObjects/lib/embeddedFormUx.ts
// PURPOSE: The USER's half of forms embedded on a sheet (M3c): the grid
//          context-menu items that PLACE one, put an orphan back, and remove
//          one. Without these the feature does not exist — nothing a script can
//          call creates a placement, deliberately (see scriptPanes.ts's header),
//          so every embedded surface begins here.
// CONTEXT: Modelled on lib/cellBehaviorUx.ts, which does the same job for cell
//          behaviours: the store is in `@api`, the lifecycle rides the ordinary
//          object-script machinery, and this file is only the gestures.
//
// WHY THE SUBMENU IS REBUILT RATHER THAN COMPUTED. `GridContextMenuItem.label`
// and `.visible` are functions the Shell calls at menu-open time, but
// `.children` is a plain array read as it was registered — so a submenu of "the
// workbook's form scripts" has to be re-registered when that list changes.
// Re-registering under the same id is a REPLACE that logs a warning, so the item
// is unregistered first.

import {
  ObjectScriptManager,
  gridExtensions,
  onAppEvent,
  showToast,
  type GridContextMenuItem,
  type GridMenuContext,
} from "@api";
import { getActiveSheet } from "@api/lib";
import {
  EMBEDDED_FORM_REMOVE_MENU_LABEL,
  EMBEDDED_FORM_RESTORE_MENU_LABEL,
  listEmbeddedFormPlacementsForSheet,
  placeEmbeddedForm,
  removeEmbeddedFormPlacement,
  setEmbeddedFormGeometry,
} from "@api/scriptHost/embeddedFormPlacements";

/** The parent item's id; its children are one per form script. */
const PLACE_ITEM_ID = "scriptableObjects.embedForm.place";
const RESTORE_ITEM_ID = "scriptableObjects.embedForm.restore";
const REMOVE_ITEM_ID = "scriptableObjects.embedForm.remove";
const MENU_GROUP = "cellTypes";

/** The workbook's form scripts, by name. */
function formScripts(): Array<{ id: string; name: string }> {
  return ObjectScriptManager.getAllScripts()
    .filter((s) => s.objectType === "form")
    .map((s) => ({ id: s.id, name: s.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The active sheet, tracked here because the Shell calls `visible` while it is
 * BUILDING the menu and cannot await an IPC round trip for a sheet index.
 */
let activeSheet = 0;

/**
 * The placement ANCHORED at the clicked cell, if any.
 *
 * Deliberately the ANCHOR and not the painted box: the box is pixels the render
 * pass knows and this menu does not, and an item whose visibility depended on
 * geometry this file re-derived would be a second answer to "where is that
 * surface?" — the drift the layer's single box cache exists to avoid. The anchor
 * cell is the one the user placed it on, and it is where they will look for it.
 */
export function embeddedFormAtCell(ctx: GridMenuContext): { id: string; orphaned: boolean } | null {
  if (!ctx.clickedCell) return null;
  const hit = listEmbeddedFormPlacementsForSheet(activeSheet).find(
    (p) => p.anchorRow === ctx.clickedCell!.row && p.anchorCol === ctx.clickedCell!.col,
  );
  return hit ? { id: hit.id, orphaned: hit.orphaned } : null;
}

async function place(scriptId: string, ctx: GridMenuContext): Promise<void> {
  if (!ctx.clickedCell) return;
  const sheetIndex = await getActiveSheet();
  try {
    placeEmbeddedForm({
      scriptId,
      sheetIndex,
      anchorRow: ctx.clickedCell.row,
      anchorCol: ctx.clickedCell.col,
    });
  } catch (e) {
    // The per-sheet bound refuses by name; a toast is the only surface a
    // context-menu gesture has.
    showToast(e instanceof Error ? e.message : String(e), { type: "warning" });
  }
}

/** Build the "Place a Form Here" item for the workbook as it stands. */
function placeItem(): GridContextMenuItem {
  const forms = formScripts();
  return {
    id: PLACE_ITEM_ID,
    label: "Place a Form Here",
    group: MENU_GROUP,
    // Hidden when the workbook has no form script: an empty submenu is a dead
    // end that teaches nothing.
    visible: (ctx) => ctx.clickedCell != null && forms.length > 0 && embeddedFormAtCell(ctx) === null,
    onClick: () => undefined,
    children: forms.map((form) => ({
      id: `${PLACE_ITEM_ID}.${form.id}`,
      label: form.name,
      onClick: (ctx) => void place(form.id, ctx),
    })),
  };
}

/**
 * Wire the embedded-form gestures. Returns a cleanup function.
 *
 * `retry` is the wiring's re-open door (lib/scriptEmbedHost.ts): putting an
 * orphan back is exactly the case where a refusal the host is REMEMBERING has
 * stopped being true, and nothing else in the app knows that has happened.
 */
export function registerEmbeddedFormUx(retry: (placementId: string) => void): () => void {
  const cleanups: Array<() => void> = [];

  const rebuildPlaceItem = (): void => {
    gridExtensions.unregisterContextMenuItem(PLACE_ITEM_ID);
    gridExtensions.registerContextMenuItem(placeItem());
  };
  rebuildPlaceItem();
  // The script registry's own change signal — a form created, renamed or
  // deleted. `children` is a frozen array (see the header), so the item is
  // rebuilt rather than recomputed.
  //
  // THIS ONE SUBSCRIPTION ALSO CARRIES THE WORKBOOK SWAP, and deliberately: this
  // function runs once, at extension activation, and an extension is not
  // re-activated on File ▸ Open. `resetObjectScriptManager()` — which the
  // AFTER_OPEN / AFTER_NEW handlers call before reloading — keeps its
  // subscribers and ANNOUNCES the emptying, so the item is rebuilt empty on the
  // swap and again as the incoming workbook's scripts register. It once cleared
  // the listener set instead, and this menu spent the rest of the session
  // offering the closed workbook's forms. A second trigger here would be a
  // second answer to "what is the workbook's form list?"; the registry is the
  // only one.
  cleanups.push(ObjectScriptManager.onScriptChange(() => rebuildPlaceItem()));
  cleanups.push(() => gridExtensions.unregisterContextMenuItem(PLACE_ITEM_ID));

  // Track the active sheet for the synchronous `visible` predicates.
  void getActiveSheet().then((i) => {
    activeSheet = i;
  });
  cleanups.push(
    onAppEvent("app:sheet-changed", (detail) => {
      const d = (detail ?? {}) as { sheetIndex?: number };
      if (typeof d.sheetIndex === "number") activeSheet = d.sheetIndex;
    }),
  );

  gridExtensions.registerContextMenuItems([
    {
      id: RESTORE_ITEM_ID,
      // THE LABEL IS THE CONSTANT, not a copy of its words. Every orphan
      // sentence QUOTES these two items by name
      // (`EMBEDDED_FORM_ORPHAN_REMEDY`, @api/scriptHost/embeddedFormPlacements),
      // so a label re-worded here alone would leave three surfaces telling the
      // user to look for a menu entry that no longer exists — which is the
      // shape of the defect those sentences were fixed for.
      label: EMBEDDED_FORM_RESTORE_MENU_LABEL,
      group: MENU_GROUP,
      // Only on an ORPHAN, and the sentence says what it does. This is the one
      // action that undoes a deleted anchor, which is why the placement was
      // kept rather than dropped — and, until a drag exists, the only one.
      visible: (ctx) => embeddedFormAtCell(ctx)?.orphaned === true,
      onClick: (ctx) => {
        const hit = embeddedFormAtCell(ctx);
        if (!hit || !ctx.clickedCell) return;
        setEmbeddedFormGeometry(hit.id, {
          sheetIndex: activeSheet,
          anchorRow: ctx.clickedCell.row,
          anchorCol: ctx.clickedCell.col,
        });
        retry(hit.id);
      },
    },
    {
      id: REMOVE_ITEM_ID,
      // Quoted by the orphan sentences too — see the restore item above.
      label: EMBEDDED_FORM_REMOVE_MENU_LABEL,
      group: MENU_GROUP,
      // THE USER-OWNED DISMISS, and the only one: a script cannot close an
      // embedded surface (`pane.close` refuses it). The SCRIPT is untouched —
      // this removes the placement, exactly as removing a cell behaviour leaves
      // its script to the script UI.
      visible: (ctx) => embeddedFormAtCell(ctx) !== null,
      onClick: (ctx) => {
        const hit = embeddedFormAtCell(ctx);
        if (hit) removeEmbeddedFormPlacement(hit.id);
      },
    },
  ]);
  cleanups.push(() => {
    gridExtensions.unregisterContextMenuItem(RESTORE_ITEM_ID);
    gridExtensions.unregisterContextMenuItem(REMOVE_ITEM_ID);
  });

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

/** The ids this module registers — read by the tests, and by nothing else. */
export const EMBEDDED_FORM_MENU_IDS = {
  place: PLACE_ITEM_ID,
  restore: RESTORE_ITEM_ID,
  remove: REMOVE_ITEM_ID,
} as const;

/** TEST-ONLY: the sheet the synchronous `visible` predicates resolve against. */
export function __setEmbeddedFormUxActiveSheetForTests(index: number): void {
  activeSheet = index;
}
